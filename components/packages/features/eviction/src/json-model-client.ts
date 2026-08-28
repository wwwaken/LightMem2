import type { TaskStateEstimatorApiConfig, TaskStateEstimatorOutput } from "./types.js";

export type JsonModelUsage = NonNullable<TaskStateEstimatorOutput["usage"]>;
export type JsonModelRequest = { systemPrompt: string; userPayload: string };
export type JsonModelResponse = { text: string; usage?: JsonModelUsage };
export type JsonModelClient = {
  request(input: JsonModelRequest): Promise<JsonModelResponse>;
};

function extractResponsesText(payload: any): string {
  const texts: string[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === "string" && part.text.trim()) texts.push(part.text.trim());
    }
  }
  if (texts.length > 0) return texts.join("\n");
  return typeof payload?.output_text === "string" ? payload.output_text.trim() : "";
}

function extractChatText(payload: any): string {
  const content = Array.isArray(payload?.choices) ? payload.choices[0]?.message?.content : undefined;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => typeof part?.text === "string" ? part.text.trim() : "")
    .filter(Boolean)
    .join("\n");
}

function finiteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function extractUsage(payload: any): JsonModelUsage | undefined {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = finiteNumber(
    usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens,
  ) ?? 0;
  const outputTokens = finiteNumber(
    usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens,
  ) ?? 0;
  const totalTokens = finiteNumber(usage.total_tokens ?? usage.totalTokens)
    ?? inputTokens + outputTokens;
  const costUsd = finiteNumber(
    usage.cost_usd ?? usage.costUsd ?? usage.total_cost ?? usage.totalCost ?? payload?.cost_usd,
  );
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: Math.max(0, totalTokens),
    ...(costUsd !== undefined ? { costUsd: Math.max(0, costUsd) } : {}),
  };
}

/** OpenAI-compatible JSON client shared by estimator-backed feature analyzers. */
export function createApiJsonModelClient(
  config: Pick<TaskStateEstimatorApiConfig, "baseUrl" | "apiKey" | "model" | "requestTimeoutMs">,
): JsonModelClient {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("json model client requires baseUrl, apiKey, and model");
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const requestTimeoutMs = Math.max(1_000, config.requestTimeoutMs ?? 60_000);

  return {
    async request(input): Promise<JsonModelResponse> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        try {
          const response = await fetch(`${baseUrl}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
            signal: controller.signal,
            body: JSON.stringify({
              model: config.model,
              input: [
                { role: "system", content: [{ type: "input_text", text: input.systemPrompt }] },
                { role: "user", content: [{ type: "input_text", text: input.userPayload }] },
              ],
              text: { format: { type: "json_object" } },
            }),
          });
          if (!response.ok) {
            throw new Error(`responses_api_failed:${response.status}:${await response.text()}`);
          }
          const payload = await response.json();
          return { text: extractResponsesText(payload), usage: extractUsage(payload) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("responses_api_failed:")) throw error;
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
          signal: controller.signal,
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: input.systemPrompt },
              { role: "user", content: input.userPayload },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
          }),
        });
        if (!response.ok) {
          throw new Error(`chat_completions_failed:${response.status}:${await response.text()}`);
        }
        const payload = await response.json();
        return { text: extractChatText(payload), usage: extractUsage(payload) };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
