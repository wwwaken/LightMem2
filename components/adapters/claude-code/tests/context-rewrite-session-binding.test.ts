import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostGatewayForwarder } from "@lightrsi/host-adapter";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";
import { lookupRealSessionId } from "../src/context-rewrite/session-map.js";

async function reserveUnusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function okForwarder(): HostGatewayForwarder {
  return {
    async requestRaw() {
      throw new Error("requestRaw not used in test");
    },
    async request() {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          id: "msg_bind_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };
}

async function sendSynthRequest(baseUrl: string, synthId: string, turn: number): Promise<number> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-session-id": synthId,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: `hello ${turn}` }] },
      ],
      max_tokens: 64,
    }),
  });
  return response.status;
}

test("gateway binds a synthetic session id to the real hook session and persists it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-session-binding-"));
  const stateDir = join(dir, "state");
  const proxyPort = await reserveUnusedPort();
  const synthId = "claude-synth-binding-test";

  // Simulate a hook having observed a real Claude Code session: this writes the
  // "latest" session ref that resolveObservedClaudeSessionId reads.
  await upsertClaudeCodeSessionSnapshot(stateDir, "claude-real-42", {
    lastHookEvent: "SessionStart",
    workspaceHint: "/repo/demo",
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({ stateDir, proxyPort }),
    logger: createConsoleLogger(false),
    forwarder: okForwarder(),
  });

  try {
    // A synthetic-session request should be resolved to the real hook session
    // and that binding should be persisted.
    assert.equal(await sendSynthRequest(runtime.baseUrl, synthId, 0), 200);
    assert.equal(await lookupRealSessionId(stateDir, synthId), "claude-real-42");

    // Even if a newer real session becomes "latest", the existing binding must
    // stay anchored to the first real id (stable anchor across turns).
    await upsertClaudeCodeSessionSnapshot(stateDir, "claude-real-99", {
      lastHookEvent: "SessionStart",
      workspaceHint: "/repo/demo",
    });
    assert.equal(await sendSynthRequest(runtime.baseUrl, synthId, 1), 200);
    assert.equal(await lookupRealSessionId(stateDir, synthId), "claude-real-42");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
