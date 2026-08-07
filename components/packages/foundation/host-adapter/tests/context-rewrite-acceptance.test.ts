import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  MockUpstreamRecorder,
  createAcceptanceSentinels,
  createTemporaryAcceptanceEnvironment,
  formatAcceptanceSummary,
  inspectToolClosure,
  runAcceptanceHarness,
  runRestartAcceptanceScenario,
  type AcceptanceHostRuntime,
  type AcceptancePhase,
  type CapturedRequest,
} from "../src/testing/context-rewrite-acceptance.js";

const TEST_UUID = "11111111-2222-4333-8444-555555555555";

function capturedRequest(params: {
  phase: AcceptancePhase;
  sequence: number;
  body: unknown;
  status?: number;
}): CapturedRequest {
  return {
    phase: params.phase,
    sequence: params.sequence,
    method: "POST",
    path: "/v1/responses",
    body: params.body,
    rawBody: JSON.stringify(params.body),
    contentType: "application/json",
    responseStatus: params.status ?? 200,
  };
}

test("creates random or deterministic acceptance sentinels", () => {
  const deterministic = createAcceptanceSentinels(TEST_UUID);
  assert.equal(deterministic.uuid, TEST_UUID);
  assert.equal(deterministic.evict, `EVICT_ME_${TEST_UUID}`);
  assert.equal(deterministic.keep, `KEEP_ME_${TEST_UUID}`);
  assert.match(createAcceptanceSentinels().uuid, /^[0-9a-f-]{36}$/);
  assert.throws(() => createAcceptanceSentinels("invalid"), /Invalid acceptance sentinel UUID/);
});

test("checks Responses, Anthropic, and Chat Completions tool closure", () => {
  assert.equal(inspectToolClosure({
    input: [
      { type: "function_call", call_id: "function-1" },
      { type: "function_call_output", call_id: "function-1" },
      { type: "custom_tool_call", call_id: "custom-1" },
      { type: "custom_tool_call_output", call_id: "custom-1" },
    ],
  }).complete, true);

  assert.equal(inspectToolClosure({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "anthropic-1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "anthropic-1" }] },
      { role: "assistant", tool_calls: [{ id: "chat-1", type: "function" }] },
      { role: "tool", tool_call_id: "chat-1", content: "done" },
    ],
  }).complete, true);
});

test("rejects missing call ids, orphaned calls, and duplicate outputs", () => {
  const missingCallId = inspectToolClosure({
    input: [
      { type: "function_call", call_id: "call-1" },
      { type: "function_call_output", id: "call-1" },
    ],
  });
  assert.equal(missingCallId.complete, false);
  assert.deepEqual(missingCallId.missingOutputs, ["responses:function_call:call-1"]);
  assert.deepEqual(missingCallId.invalidItems, ["responses.input[1].call_id"]);

  const duplicate = inspectToolClosure({
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "tool-1" }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tool-1" },
        { type: "tool_result", tool_use_id: "tool-1" },
      ] },
    ],
  });
  assert.equal(duplicate.complete, false);
  assert.deepEqual(duplicate.duplicateOutputs, ["anthropic:tool-1"]);
});

test("rejects tool protocol items attached to invalid message roles", () => {
  const anthropic = inspectToolClosure({
    messages: [
      { role: "user", content: [{ type: "tool_use", id: "tool-1" }] },
      { role: "assistant", content: [{ type: "tool_result", tool_use_id: "tool-1" }] },
    ],
  });
  assert.equal(anthropic.complete, false);
  assert.deepEqual(anthropic.invalidItems, [
    "messages[0].content[0].role",
    "messages[1].content[0].role",
  ]);

  const chat = inspectToolClosure({
    messages: [
      { role: "user", tool_calls: [{ id: "chat-1", type: "function" }] },
      { role: "assistant", tool_call_id: "chat-1", content: "done" },
    ],
  });
  assert.equal(chat.complete, false);
  assert.deepEqual(chat.invalidItems, [
    "messages[0].tool_calls[0].role",
    "messages[1].role",
  ]);
});

test("captures raw requests through a real mock upstream", async () => {
  const upstream = new MockUpstreamRecorder();
  upstream.enqueueResponses([{ status: 418, body: { error: "expected" } }]);
  await upstream.start();
  try {
    const body = { input: [{ type: "message", content: "raw-request" }] };
    const response = await fetch(`${upstream.url}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer must-not-be-recorded",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 418);
    const [captured] = upstream.requests();
    assert.deepEqual(captured.body, body);
    assert.equal(captured.rawBody, JSON.stringify(body));
    assert.equal(captured.responseStatus, 418);
    assert.equal("authorization" in captured, false);
  } finally {
    await upstream.close();
  }
});

test("uses the final successful fallback request and does not report rewrite success", () => {
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const rewritten = { input: [sentinels.keep] };
  const original = { input: [sentinels.keep, sentinels.evict] };
  const summary = runAcceptanceHarness({
    sentinels,
    requests: [
      capturedRequest({ phase: "before_restart", sequence: 1, body: rewritten }),
      capturedRequest({ phase: "after_restart", sequence: 2, body: rewritten, status: 400 }),
      capturedRequest({ phase: "after_restart", sequence: 3, body: original }),
    ],
    originalRequests: {
      before_restart: original,
      after_restart: original,
    },
  });

  assert.equal(summary.passed, false);
  assert.equal(summary.fallbackCount, 1);
  assert.equal(summary.fallbackSucceeded, true);
  assert.equal(summary.phases[1].evictFound, true);
  assert.equal(summary.phases[1].passed, false);
});

test("does not reuse an earlier success when the final upstream attempt fails", () => {
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const original = { input: [sentinels.keep, sentinels.evict] };
  const rewritten = { input: [sentinels.keep] };
  const summary = runAcceptanceHarness({
    sentinels,
    requests: [
      capturedRequest({ phase: "before_restart", sequence: 1, body: rewritten }),
      capturedRequest({ phase: "before_restart", sequence: 2, body: rewritten, status: 500 }),
      capturedRequest({ phase: "after_restart", sequence: 3, body: rewritten }),
    ],
    originalRequests: { before_restart: original, after_restart: original },
  });
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.phases[0].toolClosure.invalidItems, ["no_successful_upstream_request"]);
});

test("rejects a phase when an earlier successful request kept eviction content", () => {
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const original = { input: [sentinels.keep, sentinels.evict] };
  const rewritten = { input: [sentinels.keep] };
  const summary = runAcceptanceHarness({
    sentinels,
    requests: [
      capturedRequest({ phase: "before_restart", sequence: 1, body: original }),
      capturedRequest({ phase: "before_restart", sequence: 2, body: rewritten }),
      capturedRequest({ phase: "after_restart", sequence: 3, body: rewritten }),
    ],
    originalRequests: { before_restart: original, after_restart: original },
  });

  assert.equal(summary.passed, false);
  assert.deepEqual(
    summary.phases[0].unsafeSuccessfulRequestSequences,
    [1],
  );
});

test("does not count a non-original recovery retry as fallback", () => {
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const original = { input: [sentinels.keep, sentinels.evict] };
  const rewritten = { input: [sentinels.keep] };
  const retriedRewrite = { input: [sentinels.keep], prompt_cache_retention: null };
  const summary = runAcceptanceHarness({
    sentinels,
    requests: [
      capturedRequest({ phase: "before_restart", sequence: 1, body: rewritten, status: 400 }),
      capturedRequest({ phase: "before_restart", sequence: 2, body: retriedRewrite }),
      capturedRequest({ phase: "after_restart", sequence: 3, body: rewritten }),
    ],
    originalRequests: { before_restart: original, after_restart: original },
  });
  assert.equal(summary.passed, true);
  assert.equal(summary.fallbackCount, 0);
  assert.equal(summary.fallbackSucceeded, false);
});

test("derives saved characters from original and captured request bodies", () => {
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const original = { input: [sentinels.keep, sentinels.evict] };
  const rewritten = { input: [sentinels.keep] };
  const requests = [
    capturedRequest({ phase: "before_restart", sequence: 1, body: rewritten }),
    capturedRequest({ phase: "after_restart", sequence: 2, body: rewritten }),
  ];
  const expectedPerPhase = JSON.stringify(original).length - JSON.stringify(rewritten).length;
  const summary = runAcceptanceHarness({
    sentinels,
    requests,
    originalRequests: { before_restart: original, after_restart: original },
  });
  assert.equal(summary.passed, true);
  assert.equal(summary.savedCharacters, expectedPerPhase * 2);
  assert.equal(
    formatAcceptanceSummary(summary),
    `status=PASS request_count=2 saved_characters=${expectedPerPhase * 2} fallback_count=0 fallback_succeeded=no`,
  );
});

test("runs two distinct host lifetimes against one persistent state directory", async () => {
  const starts: Array<{ phase: AcceptancePhase; stateDir: string }> = [];
  const closes: AcceptancePhase[] = [];
  const summary = await runRestartAcceptanceScenario({
    sentinels: createAcceptanceSentinels(TEST_UUID),
    async startHost(context): Promise<AcceptanceHostRuntime> {
      starts.push({ phase: context.phase, stateDir: context.stateDir });
      const markerPath = path.join(context.stateDir, "restart-marker.json");
      if (context.phase === "before_restart") {
        fs.writeFileSync(markerPath, JSON.stringify({ persisted: true }));
      } else {
        assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, "utf8")), { persisted: true });
      }
      return {
        async sendAcceptanceTurn({ phase, sentinels }) {
          const original = { input: [sentinels.keep, sentinels.evict] };
          const rewritten = {
            input: [
              sentinels.keep,
              { type: "function_call", call_id: `${phase}-call` },
              { type: "function_call_output", call_id: `${phase}-call` },
            ],
          };
          const response = await fetch(`${context.upstreamUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(rewritten),
          });
          assert.equal(response.ok, true);
          return original;
        },
        async close() {
          closes.push(context.phase);
        },
      };
    },
  });

  assert.equal(summary.passed, true);
  assert.deepEqual(starts.map((entry) => entry.phase), ["before_restart", "after_restart"]);
  assert.equal(starts[0].stateDir, starts[1].stateDir);
  assert.deepEqual(closes, ["before_restart", "after_restart"]);
});

test("uses isolated config paths and does not inherit secrets", () => {
  process.env.LIGHTMEM2_ACCEPTANCE_TEST_SECRET = "must-not-propagate";
  const environment = createTemporaryAcceptanceEnvironment("lightmem2-acceptance-test-");
  try {
    assert.equal(environment.env.LIGHTMEM2_ACCEPTANCE_TEST_SECRET, undefined);
    assert.equal(environment.env.HOME, environment.homeDir);
    assert.equal(environment.env.OPENCLAW_STATE_DIR, environment.openClawStateDir);
    assert.equal(
      (environment.env.CODEX_CONFIG_PATH ?? "").startsWith(
        `${environment.rootDir}${path.sep}`,
      ),
      true,
    );
    assert.equal(
      (environment.env.CLAUDE_CODE_SETTINGS_PATH ?? "").startsWith(
        `${environment.rootDir}${path.sep}`,
      ),
      true,
    );
    assert.equal(fs.existsSync(environment.stateDir), true);
    assert.equal(fs.existsSync(environment.codexHomeDir), true);
    assert.equal(fs.existsSync(environment.claudeHomeDir), true);
  } finally {
    delete process.env.LIGHTMEM2_ACCEPTANCE_TEST_SECRET;
    environment.cleanup();
  }
  assert.equal(fs.existsSync(environment.rootDir), false);
});
