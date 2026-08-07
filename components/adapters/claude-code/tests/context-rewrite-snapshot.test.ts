import test from "node:test";
import assert from "node:assert/strict";

import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";

function sampleMessages() {
  return [
    { role: "user", content: "read config.json" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading it now" },
        { type: "tool_use", id: "call-1", name: "Read", input: { path: "config.json" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call-1", content: "file body here" },
      ],
    },
  ] as any;
}

test("snapshot carries host id, session, revision and schema version", () => {
  const snap = buildClaudeContextSnapshot({
    sessionId: "s1",
    revision: "rev-1",
    messages: sampleMessages(),
  });
  assert.equal(snap.hostId, "claude-code");
  assert.equal(snap.sessionId, "s1");
  assert.equal(snap.revision, "rev-1");
  assert.ok(snap.schemaVersion);
});

test("each content block becomes one item ref with a stable id and fingerprint", () => {
  const snap = buildClaudeContextSnapshot({
    sessionId: "s1",
    revision: "rev-1",
    messages: sampleMessages(),
  });
  // user string (1) + assistant text + tool_use (2) + tool_result (1) = 4 items
  assert.equal(snap.items.length, 4);
  for (const item of snap.items) {
    assert.ok(item.stableId, "item needs a stable id");
    assert.ok(item.fingerprint, "item needs a fingerprint");
    assert.ok(item.chars >= 0);
  }
});

test("kinds are mapped from role and block type", () => {
  const snap = buildClaudeContextSnapshot({
    sessionId: "s1",
    revision: "rev-1",
    messages: sampleMessages(),
  });
  const kinds = snap.items.map((i) => i.kind);
  assert.ok(kinds.includes("user"));
  assert.ok(kinds.includes("assistant"));
  assert.ok(kinds.includes("tool_call"));
  assert.ok(kinds.includes("tool_result"));
});

test("tool_call and tool_result carry their call id", () => {
  const snap = buildClaudeContextSnapshot({
    sessionId: "s1",
    revision: "rev-1",
    messages: sampleMessages(),
  });
  const toolCall = snap.items.find((i) => i.kind === "tool_call");
  const toolResult = snap.items.find((i) => i.kind === "tool_result");
  assert.equal(toolCall?.callId, "call-1");
  assert.equal(toolResult?.callId, "call-1");
});

test("stable ids are identical across resends of the same history", () => {
  const first = buildClaudeContextSnapshot({ sessionId: "s1", revision: "r", messages: sampleMessages() });
  const second = buildClaudeContextSnapshot({ sessionId: "s1", revision: "r", messages: sampleMessages() });
  assert.deepEqual(
    first.items.map((i) => i.stableId),
    second.items.map((i) => i.stableId),
  );
  assert.deepEqual(
    first.items.map((i) => i.fingerprint),
    second.items.map((i) => i.fingerprint),
  );
});
