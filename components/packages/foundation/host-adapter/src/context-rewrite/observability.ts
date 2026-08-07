import { createHash } from "node:crypto";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ModelContextRewriteMode,
} from "./contracts.js";
import { appendEventTrace } from "../state/trace-store.js";

export const CONTEXT_REWRITE_EVENT_NAMES = [
  "context_rewrite_planned",
  "context_rewrite_validated",
  "context_rewrite_applied",
  "context_rewrite_deferred",
  "context_rewrite_failed",
  "context_rewrite_bypassed",
] as const;

export type ContextRewriteEventName =
  typeof CONTEXT_REWRITE_EVENT_NAMES[number];

export type ContextRewriteContentSummary = {
  digest: string;
  chars: number;
};

export type ContextRewriteEventInput = {
  stage: ContextRewriteEventName;
  hostId: string;
  sessionId: string;
  at?: string;
  planId?: string;
  mode?: ModelContextRewriteMode;
  previousRevision?: string;
  nextRevision?: string;
  operationIds?: readonly string[];
  applicableOperationIds?: readonly string[];
  deferredOperationIds?: readonly string[];
  itemIds?: readonly string[];
  taskIds?: readonly string[];
  reasonCodes?: readonly string[];
  errorCategory?: string;
  estimatedSavedChars?: number;
  savedChars?: number;
  fallbackUsed?: boolean;
  /** Transient content is summarized and never copied into the event. */
  contentSamples?: readonly string[];
};

export type ContextRewriteEvent = {
  schemaVersion: typeof MODEL_CONTEXT_REWRITE_SCHEMA_VERSION;
  stage: ContextRewriteEventName;
  hostId: string;
  sessionId: string;
  at: string;
  planId?: string;
  mode?: ModelContextRewriteMode;
  previousRevision?: string;
  nextRevision?: string;
  operationIds?: string[];
  applicableOperationIds?: string[];
  deferredOperationIds?: string[];
  itemIds?: string[];
  taskIds?: string[];
  reasonCodes?: string[];
  errorCategory?: string;
  estimatedSavedChars?: number;
  savedChars?: number;
  fallbackUsed?: boolean;
  contentSummaries?: ContextRewriteContentSummary[];
};

const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,159}$/i;
const SENSITIVE_VALUE_PATTERNS = [
  /\bsk-(?:proj-)?[a-z0-9_-]{16,}\b/i,
  /\bgh[pousr]_[a-z0-9_]{16,}\b/i,
  /\bgithub_pat_[a-z0-9_]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[a-z0-9._~+/=-]{16,}\b/i,
  /\b(?:api[_-]?key|access[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s,;]{16,}/i,
];
const CONTEXT_REWRITE_EVENT_NAME_SET = new Set<string>(
  CONTEXT_REWRITE_EVENT_NAMES,
);
const CONTEXT_REWRITE_MODE_SET = new Set<ModelContextRewriteMode>([
  "canonical",
  "request_overlay",
  "response_chain_rebase",
  "none",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredId(value: unknown, name: string): string {
  const normalized = safeIdentifier(value);
  if (!normalized) throw new TypeError(`${name} must not be empty`);
  return normalized;
}

function eventName(value: string): ContextRewriteEventName {
  if (CONTEXT_REWRITE_EVENT_NAME_SET.has(value)) {
    return value as ContextRewriteEventName;
  }
  throw new TypeError("unsupported context rewrite event name");
}

function rewriteMode(
  value: ModelContextRewriteMode | undefined,
): ModelContextRewriteMode | undefined {
  if (value === undefined) return undefined;
  if (CONTEXT_REWRITE_MODE_SET.has(value)) return value;
  throw new TypeError("unsupported context rewrite mode");
}

function eventTimestamp(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("at must be a valid timestamp");
  }
  const parsed = new Date(value.trim());
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("at must be a valid timestamp");
  }
  return parsed.toISOString();
}

function optionalId(value: unknown): string | undefined {
  const normalized = safeIdentifier(value);
  return normalized || undefined;
}

function uniqueIds(values: readonly string[] | undefined): string[] | undefined {
  const entries = Array.isArray(values) ? values : [];
  const result = [...new Set(
    entries
      .filter((value): value is string => typeof value === "string")
      .map(safeIdentifier)
      .filter(Boolean),
  )];
  return result.length > 0 ? result : undefined;
}

function containsSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function safeIdentifier(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized) return "";
  if (SAFE_CODE_PATTERN.test(normalized) && !containsSensitiveValue(normalized)) {
    return normalized;
  }
  return `redacted:sha256:${sha256(normalized).slice(0, 24)}`;
}

function safeCode(value: unknown): string {
  return safeIdentifier(value);
}

function safeCodes(values: readonly string[] | undefined): string[] | undefined {
  const entries = Array.isArray(values) ? values : [];
  const result = [...new Set(
    entries
      .filter((value): value is string => typeof value === "string")
      .map(safeCode)
      .filter(Boolean),
  )];
  return result.length > 0 ? result : undefined;
}

function nonNegativeCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function summarizeContextRewriteContent(
  content: string,
): ContextRewriteContentSummary {
  return {
    digest: `sha256:${sha256(content)}`,
    chars: content.length,
  };
}

/**
 * Creates a whitelist-only trace event. Deferral is a normal lifecycle state;
 * callers should use failed only for an actual rewrite or persistence error.
 */
export function createContextRewriteEvent(
  input: ContextRewriteEventInput,
): ContextRewriteEvent {
  const planId = optionalId(input.planId);
  const mode = rewriteMode(input.mode);
  const previousRevision = optionalId(input.previousRevision);
  const nextRevision = optionalId(input.nextRevision);
  const operationIds = uniqueIds(input.operationIds);
  const applicableOperationIds = uniqueIds(input.applicableOperationIds);
  const deferredOperationIds = uniqueIds(input.deferredOperationIds);
  const itemIds = uniqueIds(input.itemIds);
  const taskIds = uniqueIds(input.taskIds);
  const reasonCodes = safeCodes(input.reasonCodes);
  const errorCategory = input.errorCategory
    ? safeCode(input.errorCategory)
    : undefined;
  const estimatedSavedChars = nonNegativeCount(input.estimatedSavedChars);
  const savedChars = nonNegativeCount(input.savedChars);
  const contentSamples = Array.isArray(input.contentSamples)
    ? input.contentSamples
    : [];
  const contentSummaries = contentSamples
    .filter((content): content is string => typeof content === "string")
    .map(summarizeContextRewriteContent);

  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    stage: eventName(input.stage),
    hostId: requiredId(input.hostId, "hostId"),
    sessionId: requiredId(input.sessionId, "sessionId"),
    at: eventTimestamp(input.at),
    ...(planId ? { planId } : {}),
    ...(mode ? { mode } : {}),
    ...(previousRevision ? { previousRevision } : {}),
    ...(nextRevision ? { nextRevision } : {}),
    ...(operationIds ? { operationIds } : {}),
    ...(applicableOperationIds ? { applicableOperationIds } : {}),
    ...(deferredOperationIds ? { deferredOperationIds } : {}),
    ...(itemIds ? { itemIds } : {}),
    ...(taskIds ? { taskIds } : {}),
    ...(reasonCodes ? { reasonCodes } : {}),
    ...(errorCategory ? { errorCategory } : {}),
    ...(estimatedSavedChars !== undefined ? { estimatedSavedChars } : {}),
    ...(savedChars !== undefined ? { savedChars } : {}),
    ...(typeof input.fallbackUsed === "boolean"
      ? { fallbackUsed: input.fallbackUsed }
      : {}),
    ...(contentSummaries && contentSummaries.length > 0
      ? { contentSummaries }
      : {}),
  };
}

export async function appendContextRewriteEvent(
  stateDir: string,
  input: ContextRewriteEventInput,
): Promise<ContextRewriteEvent> {
  const event = createContextRewriteEvent(input);
  await appendEventTrace(stateDir, { ...event });
  return event;
}
