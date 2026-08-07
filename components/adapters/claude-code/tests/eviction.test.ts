import assert from "node:assert/strict";
import test from "node:test";

import { analyzeClaudeEviction, applyClaudeEviction } from "../src/eviction.js";

const big = "X".repeat(5000);

function sampleMessages() {
  return [
    { role: "user", content: "read config.json" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "config.json" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: big, is_error: false },
        { type: "text", text: "historical annotation" },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "c2", name: "Read", input: { file_path: "config.json" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: big }] },
  ];
}

test("eviction analysis is disabled when the module is off", () => {
  const result = analyzeClaudeEviction({
    sessionId: "s1",
    model: "claude-sonnet-4",
    messages: sampleMessages(),
    config: { enabled: false },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.evictedBlockIds, []);
  assert.equal(result.savedChars, 0);
});

test("signal-driven eviction selects only closed historical tool results", () => {
  const result = analyzeClaudeEviction({
    sessionId: "s1",
    model: "claude-sonnet-4",
    messages: sampleMessages(),
    config: { enabled: true, minBlockChars: 256 },
  });
  assert.equal(result.enabled, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.evictedBlockIds, ["history-block:anthropic-tool-result:c1"]);
  assert.ok(result.savedChars > 0);
  assert.deepEqual(result.selections[0]?.reasons, ["LARGE_BLOCK"]);
});

test("small blocks and ordinary messages are not eviction candidates", () => {
  const messages = [
    { role: "user", content: "old " + "A".repeat(5000) },
    { role: "assistant", content: [{ type: "text", text: "acknowledged" }] },
    { role: "user", content: "current " + "B".repeat(5000) },
  ];
  const result = analyzeClaudeEviction({
    sessionId: "s1",
    model: "claude-sonnet-4",
    messages,
    config: { enabled: true, minBlockChars: 256 },
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.evictedBlockIds, []);
});

test("apply preserves Anthropic tool closure and non-target content blocks", () => {
  const payload = { messages: sampleMessages() };
  const originalCurrentMessage = structuredClone(payload.messages.at(-1));
  const summary = applyClaudeEviction({
    payload,
    sessionId: "s1",
    model: "claude-sonnet-4",
    config: { enabled: true, minBlockChars: 256 },
  });

  assert.equal(summary.enabled, true);
  assert.equal(summary.changed, true);
  assert.equal(summary.evictedMessageCount, 1);
  assert.equal(summary.evictedToolResultCount, 1);
  assert.ok(summary.savedChars > 0);

  const toolUse = (payload.messages[1].content as Array<Record<string, unknown>>)[0];
  const historicalBlocks = payload.messages[2].content as Array<Record<string, unknown>>;
  const toolResult = historicalBlocks[0];
  assert.deepEqual(toolUse, {
    type: "tool_use",
    id: "c1",
    name: "Read",
    input: { file_path: "config.json" },
  });
  assert.equal(toolResult.type, "tool_result");
  assert.equal(toolResult.tool_use_id, "c1");
  assert.equal(toolResult.is_error, false);
  assert.match(String(toolResult.content), /^\[evicted:/);
  assert.deepEqual(historicalBlocks[1], { type: "text", text: "historical annotation" });
  assert.deepEqual(payload.messages.at(-1), originalCurrentMessage);
});

test("does not rewrite orphaned, duplicate, or active tool results", () => {
  const payload = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "duplicate", name: "Read", input: { file_path: "a" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "duplicate", content: big }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "duplicate", content: big }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: big }] },
    ],
  };
  const original = structuredClone(payload.messages);
  const summary = applyClaudeEviction({
    payload,
    sessionId: "s1",
    model: "claude-sonnet-4",
    config: { enabled: true, minBlockChars: 256 },
  });
  assert.equal(summary.changed, false);
  assert.deepEqual(payload.messages, original);
});

test("does not rewrite the active tool result when assistant prefill follows it", () => {
  const payload = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "active-call", name: "Read", input: { file_path: "active.txt" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "active-call", content: big }],
      },
      { role: "assistant", content: [{ type: "text", text: "prefill" }] },
    ],
  };
  const original = structuredClone(payload.messages);

  const summary = applyClaudeEviction({
    payload,
    sessionId: "s1",
    model: "claude-sonnet-4",
    config: { enabled: true, minBlockChars: 256 },
  });

  assert.equal(summary.changed, false);
  assert.deepEqual(payload.messages, original);
});
