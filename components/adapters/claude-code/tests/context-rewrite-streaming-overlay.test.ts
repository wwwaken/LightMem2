import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { type HostGatewayForwarder } from "@lightrsi/host-adapter";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";

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

// Verifies gap 5: the overlay applies to the STREAMING path too. The overlay
// rewrites the shared payload/envelope before the stream/non-stream branch, so
// requestStream must receive the evicted (stubbed) tool_result exactly like the
// non-streaming path does.
test("gateway overlay applies on the streaming path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightrsi-claude-stream-overlay-"));
  const proxyPort = await reserveUnusedPort();
  const seenStreamPayloads: Array<Record<string, unknown>> = [];
  const forwarder: HostGatewayForwarder = {
    async requestRaw() {
      throw new Error("requestRaw not used in test");
    },
    async request() {
      throw new Error("non-stream path should not be used in this test");
    },
    async requestStream(params) {
      seenStreamPayloads.push(params.payload as Record<string, unknown>);
      const sse =
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_1","type":"message","role":"assistant","content":[],"usage":{"input_tokens":20,"output_tokens":0}}}\n\n` +
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        stream: Readable.from([Buffer.from(sse, "utf8")]),
      };
    },
  };
  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      modules: { stabilizer: false, reduction: false, eviction: true },
      eviction: { enabled: true, minBlockChars: 256 },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });
  try {
    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-stream-overlay-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: true,
        messages: [
          { role: "user", content: [{ type: "text", text: "read the file" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_stream_1", name: "Read", input: { file_path: "/repo/large.txt" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_stream_1", content: "EVICT_ME_" + "x".repeat(5000) }],
          },
          { role: "assistant", content: [{ type: "text", text: "previous task complete" }] },
          { role: "user", content: [{ type: "text", text: "KEEP_ME_current_user_turn" }] },
        ],
        max_tokens: 256,
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    assert.equal(seenStreamPayloads.length, 1);
    const messages = seenStreamPayloads[0]?.messages as Array<Record<string, unknown>>;
    const toolResult = (messages[2]?.content as Array<Record<string, unknown>>)[0];
    const activeUser = (messages.at(-1)?.content as Array<Record<string, unknown>>)[0];
    assert.equal(toolResult?.type, "tool_result");
    assert.equal(toolResult?.tool_use_id, "toolu_stream_1");
    assert.match(String(toolResult?.content), /^\[(evicted:|Tool payload trimmed)/);
    assert.equal(activeUser?.text, "KEEP_ME_current_user_turn");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});
