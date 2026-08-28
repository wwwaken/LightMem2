import { createHash } from "node:crypto";

import {
  createApiJsonModelClient,
  type JsonModelClient,
  type JsonModelUsage,
  type TaskStateEstimatorApiConfig,
} from "@lightrsi/eviction";
import type {
  ContextCleanRecommendation,
  ContextCleanTaskBreakdown,
} from "./contracts.js";

const MAX_LABEL_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_SUMMARY_CHARS = 600;
const MAX_EVIDENCE_CHARS = 240;
const MAX_EVIDENCE_ITEMS = 8;

export type ContextCleanTaskEvidence = {
  completionEvidence?: string[];
  unresolvedIssues?: string[];
  recallCount?: number;
  turnsSinceLastRecall?: number;
  supersededByTaskIds?: string[];
  futureReuseSignals?: string[];
};

export type ContextCleanRecommendationProviderTask = {
  taskId: string;
  digest: string;
  label: string;
  description: string;
  summary: string;
  lifecycleState: ContextCleanTaskBreakdown["lifecycleState"];
  tokenCount: number | null;
  charCount: number;
  tokenPercent: number | null;
  selectable: boolean;
  evidence: ContextCleanTaskEvidence;
};

export type ContextCleanRecommendationProviderInput = {
  tasks: ContextCleanRecommendationProviderTask[];
};

export type ContextCleanRecommendationProviderResponse = {
  output: unknown;
  usage?: JsonModelUsage;
};

export type ContextCleanRecommendationProvider = {
  recommend(
    input: ContextCleanRecommendationProviderInput,
  ): Promise<ContextCleanRecommendationProviderResponse>;
};

export type ContextCleanRecommendationResult = {
  tasks: ContextCleanTaskBreakdown[];
  confidenceByTaskId: Record<string, number>;
  fallbackUsed: boolean;
  reasons: string[];
  usage?: JsonModelUsage;
};

type ModelRecommendation = {
  taskId: string;
  label: string;
  description: string;
  summary: string;
  recommendation: ContextCleanRecommendation;
  reasonCodes: string[];
  confidence: number;
};

function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function sanitizeText(value: string, maxChars: number): string {
  const normalized = redactSecrets(value).replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : normalized.slice(0, maxChars);
}

function sanitizeList(values: string[] | undefined): string[] {
  return (values ?? [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((value) => sanitizeText(value, MAX_EVIDENCE_CHARS));
}

function sanitizeEvidence(value: ContextCleanTaskEvidence | undefined): ContextCleanTaskEvidence {
  const count = (candidate: unknown): number | undefined =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate : undefined;
  return {
    completionEvidence: sanitizeList(value?.completionEvidence),
    unresolvedIssues: sanitizeList(value?.unresolvedIssues),
    ...(count(value?.recallCount) !== undefined ? { recallCount: count(value?.recallCount) } : {}),
    ...(count(value?.turnsSinceLastRecall) !== undefined
      ? { turnsSinceLastRecall: count(value?.turnsSinceLastRecall) } : {}),
    supersededByTaskIds: sanitizeList(value?.supersededByTaskIds),
    futureReuseSignals: sanitizeList(value?.futureReuseSignals),
  };
}

function taskDigest(task: ContextCleanTaskBreakdown): string {
  const canonical = Object.entries(task.itemDigests)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, digest]) => digest)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function buildContextCleanRecommendationProviderInput(params: {
  tasks: ContextCleanTaskBreakdown[];
  evidenceByTaskId?: Record<string, ContextCleanTaskEvidence>;
}): ContextCleanRecommendationProviderInput {
  return {
    tasks: params.tasks.map((task) => ({
      taskId: task.taskId,
      digest: taskDigest(task),
      label: sanitizeText(task.label, MAX_LABEL_CHARS),
      description: sanitizeText(task.description, MAX_DESCRIPTION_CHARS),
      summary: sanitizeText(task.summary, MAX_SUMMARY_CHARS),
      lifecycleState: task.lifecycleState,
      tokenCount: task.tokenCount,
      charCount: task.charCount,
      tokenPercent: task.tokenPercent,
      selectable: task.selectable,
      evidence: sanitizeEvidence(params.evidenceByTaskId?.[task.taskId]),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseModelOutput(value: unknown, expectedTaskIds: string[]): ModelRecommendation[] | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown; } catch { return undefined; }
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["tasks"]) || !Array.isArray(parsed.tasks)) {
    return undefined;
  }
  const results: ModelRecommendation[] = [];
  for (const candidate of parsed.tasks) {
    if (!isRecord(candidate)
      || !hasExactKeys(candidate, [
        "taskId", "label", "description", "summary", "recommendation", "reasonCodes", "confidence",
      ])
      || typeof candidate.taskId !== "string" || !candidate.taskId.trim()
      || typeof candidate.label !== "string" || !candidate.label.trim()
      || candidate.label.length > MAX_LABEL_CHARS
      || typeof candidate.description !== "string" || !candidate.description.trim()
      || /[\r\n]/.test(candidate.description) || candidate.description.length > MAX_DESCRIPTION_CHARS
      || typeof candidate.summary !== "string" || !candidate.summary.trim()
      || candidate.summary.length > MAX_SUMMARY_CHARS
      || !["clean", "keep", "protected"].includes(String(candidate.recommendation))
      || !Array.isArray(candidate.reasonCodes)
      || candidate.reasonCodes.some((reason) =>
        typeof reason !== "string" || !/^[a-z0-9_:-]{1,64}$/.test(reason))
      || new Set(candidate.reasonCodes).size !== candidate.reasonCodes.length
      || typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence)
      || candidate.confidence < 0 || candidate.confidence > 1) return undefined;
    results.push({
      taskId: candidate.taskId.trim(),
      label: sanitizeText(candidate.label, MAX_LABEL_CHARS),
      description: sanitizeText(candidate.description, MAX_DESCRIPTION_CHARS),
      summary: sanitizeText(candidate.summary, MAX_SUMMARY_CHARS),
      recommendation: candidate.recommendation as ContextCleanRecommendation,
      reasonCodes: [...candidate.reasonCodes] as string[],
      confidence: candidate.confidence,
    });
  }
  const actualIds = results.map((result) => result.taskId);
  if (new Set(actualIds).size !== actualIds.length
    || actualIds.length !== expectedTaskIds.length
    || actualIds.some((taskId) => !expectedTaskIds.includes(taskId))) return undefined;
  return results;
}

function protectedByDeterministicPolicy(task: ContextCleanTaskBreakdown): boolean {
  return !task.selectable
    || task.lifecycleState === "active"
    || task.lifecycleState === "unresolved";
}

function fallbackTasks(tasks: ContextCleanTaskBreakdown[]): ContextCleanTaskBreakdown[] {
  return tasks.map((task) => {
    const protectedTask = protectedByDeterministicPolicy(task);
    return {
      ...task,
      recommendation: protectedTask ? "protected" : "keep",
      reasonCodes: [protectedTask ? "recommendation_fallback_protected" : "recommendation_fallback_keep"],
    };
  });
}

function fallbackReason(error: unknown): string {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  if (/requires baseUrl, apiKey, and model/i.test(message)) {
    return "recommendation_provider_unavailable";
  }
  if (/AbortError|aborted|timeout/i.test(message)) return "recommendation_provider_timeout";
  if (/:429(?:\D|$)/.test(message)) return "recommendation_provider_rate_limited";
  if (/:(?:5\d\d)(?:\D|$)/.test(message)) return "recommendation_provider_server_error";
  return "recommendation_provider_failed";
}

export async function analyzeContextCleanRecommendations(params: {
  tasks: ContextCleanTaskBreakdown[];
  evidenceByTaskId?: Record<string, ContextCleanTaskEvidence>;
  provider?: ContextCleanRecommendationProvider;
}): Promise<ContextCleanRecommendationResult> {
  if (!params.provider) {
    return { tasks: fallbackTasks(params.tasks), confidenceByTaskId: {}, fallbackUsed: true,
      reasons: ["recommendation_provider_unavailable"] };
  }
  let response: ContextCleanRecommendationProviderResponse;
  try {
    response = await params.provider.recommend(buildContextCleanRecommendationProviderInput(params));
  } catch (error) {
    return { tasks: fallbackTasks(params.tasks), confidenceByTaskId: {}, fallbackUsed: true,
      reasons: [fallbackReason(error)] };
  }
  const recommendations = parseModelOutput(response.output, params.tasks.map((task) => task.taskId));
  if (!recommendations) {
    return { tasks: fallbackTasks(params.tasks), confidenceByTaskId: {}, fallbackUsed: true,
      reasons: ["recommendation_output_invalid"], ...(response.usage ? { usage: response.usage } : {}) };
  }
  const byTaskId = new Map(recommendations.map((recommendation) => [recommendation.taskId, recommendation]));
  const confidenceByTaskId: Record<string, number> = {};
  const tasks = params.tasks.map((task) => {
    const recommendation = byTaskId.get(task.taskId)!;
    confidenceByTaskId[task.taskId] = recommendation.confidence;
    if (protectedByDeterministicPolicy(task)) {
      return { ...task, label: recommendation.label, description: recommendation.description,
        summary: recommendation.summary, recommendation: "protected" as const,
        reasonCodes: [...recommendation.reasonCodes, "deterministic_protection"] };
    }
    return { ...task, label: recommendation.label, description: recommendation.description,
      summary: recommendation.summary, recommendation: recommendation.recommendation,
      reasonCodes: recommendation.reasonCodes };
  });
  return { tasks, confidenceByTaskId, fallbackUsed: false, reasons: [],
    ...(response.usage ? { usage: response.usage } : {}) };
}

const RECOMMENDATION_SYSTEM_PROMPT = [
  "You recommend whether completed task context should be cleaned from an agent session.",
  "Return only JSON: {\"tasks\":[{\"taskId\":string,\"label\":string,\"description\":string,\"summary\":string,\"recommendation\":\"clean\"|\"keep\"|\"protected\",\"reasonCodes\":string[],\"confidence\":number}]}",
  "Return exactly one result for every input task and never invent task IDs.",
  "description must be one short line. confidence must be between 0 and 1.",
  "Consider completion evidence, unresolved issues, recall count, recency, supersession, and future reuse signals.",
  "Never infer token counts. Never choose item IDs or raw text ranges.",
].join(" ");

export function createApiContextCleanRecommendationProvider(
  config: TaskStateEstimatorApiConfig,
  createClient: (config: TaskStateEstimatorApiConfig) => JsonModelClient = createApiJsonModelClient,
): ContextCleanRecommendationProvider {
  let client: JsonModelClient | undefined;
  return {
    async recommend(input) {
      client ??= createClient(config);
      const response = await client.request({
        systemPrompt: RECOMMENDATION_SYSTEM_PROMPT,
        userPayload: JSON.stringify(input),
      });
      return { output: response.text, usage: response.usage };
    },
  };
}
