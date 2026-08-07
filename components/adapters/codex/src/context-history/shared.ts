import { createHash } from "node:crypto";
import type { CodexJournalStatus, JsonObject } from "./types.js";

export function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

export function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function normalizeStatus(status: unknown, fallback: CodexJournalStatus): CodexJournalStatus {
  return status === "pending" || status === "completed" || status === "failed" || status === "incomplete"
    ? status
    : fallback;
}

export function normalizeObservedAt(value: string | undefined): string {
  const observedAt = value ?? new Date().toISOString();
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== observedAt) {
    throw new TypeError("Codex context-history observedAt must be a canonical ISO timestamp");
  }
  return observedAt;
}

export function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  const object = asJsonObject(value);
  if (!object) return value;

  const output: JsonObject = {};
  for (const [key, child] of Object.entries(object)) {
    if (/^(authorization|headers?|api[-_]?key)$/i.test(key)) continue;
    output[key] = sanitizeValue(child);
  }
  return output;
}
