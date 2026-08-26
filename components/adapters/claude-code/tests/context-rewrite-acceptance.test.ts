import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createAcceptanceSentinels,
  createTemporaryAcceptanceEnvironment,
  inspectToolClosure,
  MockUpstreamRecorder,
  reserveUnusedPort,
  runRestartAcceptanceScenario,
  contextMutationPlanSessionRoot,
  contextMutationPlanStatusDir,
  type AcceptanceHostRuntime,
  type AcceptanceSentinels,
  type HostGatewayForwarder,
} from "@lightrsi/host-adapter";

import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";

const TEST_UUID = "123e4567-e89b-42d3-a456-426614174000";

function createClaudeForwarder(upstreamUrl: string): HostGatewayForwarder {
  return {
    async requestRaw() {
      throw new Error("requestRaw not used in test");
    },
    async request({ payload }) {
      const response = await fetch(`${upstreamUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        text: await response.text(),
      };
    },
    async requestStream() {
      throw new Error("Claude GUA-06 acceptance uses the non-streaming path");
    },
  };
}

function createClaudeAcceptancePayload(sentinels: AcceptanceSentinels): Record<string, unknown> {
  return {
    model: "claude-sonnet-4-6",
    stream: false,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "read the synthetic fixture" }],
      },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_gua06_1",
          name: "Read",
          input: { file_path: "/synthetic/fixture.txt" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_gua06_1",
          content: `${sentinels.evict}\n${"x".repeat(5_000)}`,
        }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "synthetic task complete" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: sentinels.keep }],
      },
    ],
    max_tokens: 256,
  };
}

test("GUA-06 accepts Claude request eviction across five requests and a process restart", async () => {
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const summary = await runRestartAcceptanceScenario({
    sentinels,
    async startHost(context): Promise<AcceptanceHostRuntime> {
      if (context.phase === "after_restart") {
        const persistedTrace = fs.readFileSync(
          path.join(context.stateDir, "event-trace.jsonl"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(
          persistedTrace.filter(
            (entry) => entry.stage === "gateway_before_call",
          ).length,
          3,
        );

        // Persistence: the plan store must have written the active/applied plan
        // to disk before the restart, so the post-restart runtime replays it
        // rather than recomputing (doc §13.2 restart acceptance / §7.3).
        const planStoreRoot = contextMutationPlanSessionRoot(
          context.stateDir,
          "sess-gua06-claude",
        );
        assert.equal(fs.existsSync(planStoreRoot), true);
      }
      const runtime = await startClaudeCodeGatewayRuntime({
        config: normalizeTokenPilotClaudeCodeConfig({
          stateDir: context.stateDir,
          proxyPort: await reserveUnusedPort(),
          modules: { stabilizer: false, reduction: false, eviction: true },
          eviction: { enabled: true, minBlockChars: 256 },
        }),
        logger: createConsoleLogger(false),
        forwarder: createClaudeForwarder(context.upstreamUrl),
      });
      return {
        async sendAcceptanceTurn({ phase, sentinels: phaseSentinels }) {
          const payload = createClaudeAcceptancePayload(phaseSentinels);
          const requestCount = phase === "before_restart" ? 3 : 2;
          for (let attempt = 0; attempt < requestCount; attempt += 1) {
            const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-session-id": "sess-gua06-claude",
              },
              body: JSON.stringify(payload),
            });
            assert.equal(response.status, 200);
            await response.text();
          }
          return payload;
        },
        close: () => runtime.close(),
      };
    },
  });

  assert.equal(summary.passed, true);
  assert.equal(summary.requestCount, 5);
  assert.deepEqual(
    summary.phases.map((phase) => phase.requestCount),
    [3, 2],
  );
  assert.equal(summary.phases.every((phase) => phase.keepFound), true);
  assert.equal(summary.phases.every((phase) => !phase.evictFound), true);
  assert.equal(summary.phases.every((phase) => phase.toolClosure.complete), true);
  assert.equal(
    summary.phases.every(
      (phase) => phase.unsafeSuccessfulRequestSequences.length === 0,
    ),
    true,
  );
  assert.ok(summary.savedCharacters > 0);
});

test("GUA-06 independently accepts Claude rewrite failure bypass", async () => {
  const environment = createTemporaryAcceptanceEnvironment("lightrsi-gua06-claude-bypass-");
  const upstream = new MockUpstreamRecorder();
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const payload = createClaudeAcceptancePayload(sentinels);
  let runtime: Awaited<ReturnType<typeof startClaudeCodeGatewayRuntime>> | undefined;

  try {
    await upstream.start();
    runtime = await startClaudeCodeGatewayRuntime({
      config: normalizeTokenPilotClaudeCodeConfig({
        stateDir: environment.stateDir,
        proxyPort: await reserveUnusedPort(),
        modules: { stabilizer: false, reduction: false, eviction: true },
        eviction: { enabled: true, minBlockChars: 256 },
      }),
      logger: createConsoleLogger(false),
      forwarder: createClaudeForwarder(upstream.url),
      dependencies: {
        cloneRequestPayload() {
          throw new Error("synthetic GUA-06 rewrite failure");
        },
      },
    });

    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-gua06-claude-bypass",
      },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    await response.text();

    const requests = upstream.requests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].rawBody.includes(sentinels.evict), true);
    assert.equal(requests[0].rawBody.includes(sentinels.keep), true);
    assert.equal(requests[0].rawBody.includes("[evicted:"), false);
    assert.equal(inspectToolClosure(requests[0].body).complete, true);

    const trace = fs.readFileSync(
      path.join(environment.stateDir, "event-trace.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const beforeCall = trace.find((entry) => entry.stage === "gateway_before_call");
    assert.equal(beforeCall?.evictionApplied, false);
    assert.equal(beforeCall?.evictionBypassReason, "analysis_or_apply_error");
    // CLA-06 isolation: the bypass trace records only the error CLASS, never the
    // raw exception text — the injected error message must not leak anywhere.
    const rawTrace = fs.readFileSync(
      path.join(environment.stateDir, "event-trace.jsonl"),
      "utf8",
    );
    assert.equal(rawTrace.includes("synthetic GUA-06"), false);
  } finally {
    await runtime?.close();
    await upstream.close();
    environment.cleanup();
  }
});

test("GUA-06 bypasses Claude rewrite when the persisted plan store is corrupt", async () => {
  const environment = createTemporaryAcceptanceEnvironment("lightrsi-gua06-claude-plan-store-");
  const upstream = new MockUpstreamRecorder();
  const sentinels = createAcceptanceSentinels(TEST_UUID);
  const payload = createClaudeAcceptancePayload(sentinels);
  const sessionId = "sess-gua06-claude-plan-store";
  let runtime: Awaited<ReturnType<typeof startClaudeCodeGatewayRuntime>> | undefined;

  try {
    const activeDir = contextMutationPlanStatusDir(environment.stateDir, sessionId, "active");
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, "corrupt-plan.json"), "{ not json", "utf8");
    await upstream.start();
    runtime = await startClaudeCodeGatewayRuntime({
      config: normalizeTokenPilotClaudeCodeConfig({
        stateDir: environment.stateDir,
        proxyPort: await reserveUnusedPort(),
        modules: { stabilizer: false, reduction: false, eviction: true },
        eviction: { enabled: true, minBlockChars: 256 },
      }),
      logger: createConsoleLogger(false),
      forwarder: createClaudeForwarder(upstream.url),
    });

    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": sessionId,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200);
    await response.text();

    const requests = upstream.requests();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].rawBody.includes(sentinels.evict), true);
    assert.equal(requests[0].rawBody.includes("[evicted:"), false);
    const trace = fs.readFileSync(
      path.join(environment.stateDir, "event-trace.jsonl"),
      "utf8",
    );
    assert.match(trace, /analysis_or_apply_error/);
  } finally {
    await runtime?.close();
    await upstream.close();
    environment.cleanup();
  }
});
