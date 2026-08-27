import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeContextCleanRecommendations,
  buildContextCleanRecommendationProviderInput,
  createApiContextCleanRecommendationProvider,
  type ContextCleanRecommendationProvider,
  type ContextCleanTaskBreakdown,
} from "../src/index.js";

function task(overrides: Partial<ContextCleanTaskBreakdown> = {}): ContextCleanTaskBreakdown {
  return {
    taskId: "task-a", label: "Task A", description: "Inspect task A", summary: "Task A summary",
    lifecycleState: "completed", itemIds: ["item-a"], itemDigests: { "item-a": "digest-a" },
    tokenCount: 50, charCount: 200, tokenPercent: 25, recommendation: "keep",
    reasonCodes: [], selectable: true, ...overrides,
  };
}

function outputFor(tasks: ContextCleanTaskBreakdown[], overrides: Record<string, unknown> = {}): unknown {
  return { tasks: tasks.map((item) => ({ taskId: item.taskId, label: `Label ${item.taskId}`,
    description: `Description ${item.taskId}`, summary: `Summary ${item.taskId}`,
    recommendation: "clean", reasonCodes: ["completed_and_cold"], confidence: 0.9,
    ...overrides })) };
}

function provider(output: unknown): ContextCleanRecommendationProvider {
  return { async recommend() { return { output }; } };
}

test("applies strict model recommendations without changing accounting or target identity", async () => {
  const original = task();
  const result = await analyzeContextCleanRecommendations({ tasks: [original], provider: provider(outputFor([original])) });
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.tasks[0]?.recommendation, "clean");
  assert.equal(result.confidenceByTaskId[original.taskId], 0.9);
  assert.deepEqual(result.tasks[0]?.itemIds, original.itemIds);
  assert.deepEqual(result.tasks[0]?.itemDigests, original.itemDigests);
  assert.equal(result.tasks[0]?.tokenCount, original.tokenCount);
});

test("deterministic protection overrides model clean recommendations", async () => {
  const tasks = [
    task({ taskId: "active", lifecycleState: "active", selectable: false }),
    task({ taskId: "unresolved", lifecycleState: "unresolved", selectable: false }),
    task({ taskId: "not-selectable", selectable: false }),
  ];
  const result = await analyzeContextCleanRecommendations({ tasks, provider: provider(outputFor(tasks)) });
  assert.deepEqual(result.tasks.map((item) => item.recommendation), ["protected", "protected", "protected"]);
  assert.ok(result.tasks.every((item) => item.reasonCodes.includes("deterministic_protection")));
});

test("a previous model-only protected recommendation does not become a deterministic lock", async () => {
  const original = task({ recommendation: "protected", selectable: true, lifecycleState: "completed" });
  const result = await analyzeContextCleanRecommendations({ tasks: [original], provider: provider(outputFor([original])) });
  assert.equal(result.tasks[0]?.recommendation, "clean");
});

test("provider input contains bounded task evidence and no raw target data or secrets", () => {
  const input = buildContextCleanRecommendationProviderInput({
    tasks: [task({ description: "Bearer secret-token", summary: "sk-abcdefghijklmnop" })],
    evidenceByTaskId: { "task-a": { completionEvidence: ["Delivered sk-1234567890"], recallCount: 2 } },
  });
  const serialized = JSON.stringify(input);
  assert.equal(serialized.includes("itemIds"), false);
  assert.equal(serialized.includes("itemDigests"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("sk-1234567890"), false);
  assert.match(input.tasks[0]?.digest ?? "", /^[a-f0-9]{64}$/);
});

test("provider input limits evidence count and length", () => {
  const input = buildContextCleanRecommendationProviderInput({
    tasks: [task()],
    evidenceByTaskId: {
      "task-a": {
        completionEvidence: Array.from({ length: 10 }, (_, index) => `${index}-${"x".repeat(300)}`),
      },
    },
  });
  const evidence = input.tasks[0]?.evidence.completionEvidence ?? [];
  assert.equal(evidence.length, 8);
  assert.ok(evidence.every((item) => item.length <= 240));
});

test("missing provider preserves breakdown and safely falls back", async () => {
  const tasks = [task(), task({ taskId: "active", lifecycleState: "active", selectable: false })];
  const result = await analyzeContextCleanRecommendations({ tasks });
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.reasons, ["recommendation_provider_unavailable"]);
  assert.deepEqual(result.tasks.map((item) => item.recommendation), ["keep", "protected"]);
  assert.deepEqual(result.tasks.map((item) => item.tokenCount), tasks.map((item) => item.tokenCount));
});

test("malformed, missing, duplicate, unknown, multiline, and invalid-confidence outputs fail closed", async () => {
  const tasks = [task(), task({ taskId: "task-b" })];
  const invalidOutputs = [
    "not-json",
    { tasks: [] },
    { tasks: [outputFor([tasks[0]!]) as never] },
    outputFor(tasks, { taskId: "unknown" }),
    outputFor(tasks, { description: "two\nlines" }),
    outputFor(tasks, { confidence: 2 }),
    { ...(outputFor(tasks) as Record<string, unknown>), futureField: true },
    outputFor(tasks, { futureField: true }),
  ];
  for (const output of invalidOutputs) {
    const result = await analyzeContextCleanRecommendations({ tasks, provider: provider(output) });
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(result.reasons, ["recommendation_output_invalid"]);
    assert.deepEqual(result.tasks.map((item) => item.recommendation), ["keep", "keep"]);
  }
});

test("an unknown task ID fails closed even when output IDs are unique", async () => {
  const tasks = [task(), task({ taskId: "task-b" })];
  const output = outputFor(tasks) as { tasks: Array<Record<string, unknown>> };
  output.tasks[0] = { ...output.tasks[0], taskId: "unknown" };
  const result = await analyzeContextCleanRecommendations({ tasks, provider: provider(output) });
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.reasons, ["recommendation_output_invalid"]);
  assert.deepEqual(result.tasks.map((item) => item.recommendation), ["keep", "keep"]);
});

test("malformed output fallback preserves provider usage", async () => {
  const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15, costUsd: 0.001 };
  const malformed: ContextCleanRecommendationProvider = {
    async recommend() { return { output: "not-json", usage }; },
  };
  const result = await analyzeContextCleanRecommendations({ tasks: [task()], provider: malformed });
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.usage, usage);
});

test("classifies timeout, 429, 5xx, and network provider failures", async () => {
  for (const [error, reason] of [
    [new Error("AbortError: request aborted"), "recommendation_provider_timeout"],
    [new Error("chat_completions_failed:429:busy"), "recommendation_provider_rate_limited"],
    [new Error("responses_api_failed:503:down"), "recommendation_provider_server_error"],
    [new TypeError("fetch failed"), "recommendation_provider_failed"],
  ] as const) {
    const failing: ContextCleanRecommendationProvider = { async recommend() { throw error; } };
    const result = await analyzeContextCleanRecommendations({ tasks: [task()], provider: failing });
    assert.deepEqual(result.reasons, [reason]);
  }
});

test("incomplete estimator config is lazy and falls back as provider unavailable", async () => {
  let apiProvider: ContextCleanRecommendationProvider | undefined;
  assert.doesNotThrow(() => {
    apiProvider = createApiContextCleanRecommendationProvider({
      baseUrl: "", apiKey: "", model: "",
    });
  });
  const result = await analyzeContextCleanRecommendations({ tasks: [task()], provider: apiProvider });
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.reasons, ["recommendation_provider_unavailable"]);
  assert.equal(result.tasks[0]?.recommendation, "keep");
});

test("API provider reuses estimator config and JSON client without exposing credentials", async () => {
  let capturedConfig: unknown;
  let capturedPayload = "";
  const apiProvider = createApiContextCleanRecommendationProvider(
    { baseUrl: "https://example.test/v1", apiKey: "sk-secret-value", model: "model-a" },
    (config) => {
      capturedConfig = config;
      return { async request(request) {
        capturedPayload = request.userPayload;
        return { text: JSON.stringify(outputFor([task()])) };
      } };
    },
  );
  await apiProvider.recommend(buildContextCleanRecommendationProviderInput({ tasks: [task()] }));
  assert.deepEqual(capturedConfig, {
    baseUrl: "https://example.test/v1", apiKey: "sk-secret-value", model: "model-a",
  });
  assert.equal(capturedPayload.includes("sk-secret-value"), false);
});
