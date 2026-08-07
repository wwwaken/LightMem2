import assert from "node:assert/strict";
import test from "node:test";
import { buildRawSemanticTurnRecord } from "../src/context-rewrite/semantic-mapping.js";

const SESSION = "sess-sem";

test("maps user/assistant text into message records", () => {
  const record = buildRawSemanticTurnRecord({
    sessionId: SESSION,
    turnSeq: 3,
    messages: [
      { role: "user", content: "read the config" },
      { role: "assistant", content: [{ type: "text", text: "on it" }] },
    ],
  });
  assert.equal(record.sessionId, SESSION);
  assert.equal(record.turnSeq, 3);
  assert.equal(record.turnAbsId, `${SESSION}:t3`);
  assert.equal(record.messages.length, 2);
  assert.deepEqual(record.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(record.messages[0]!.text, "read the config");
});

test("maps tool_use into a tool call record with file effects", () => {
  const record = buildRawSemanticTurnRecord({
    sessionId: SESSION,
    turnSeq: 1,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/a.ts" } }],
      },
    ],
  });
  assert.equal(record.toolCalls.length, 1);
  const call = record.toolCalls[0]!;
  assert.equal(call.toolCallId, "toolu_1");
  assert.equal(call.toolName, "Read");
  assert.deepEqual(call.filesRead, ["/repo/a.ts"]);
  assert.equal(call.filesWritten, undefined);
  assert.ok(call.argumentsText?.includes("/repo/a.ts"));
});

test("maps a Write tool_use to filesWritten", () => {
  const record = buildRawSemanticTurnRecord({
    sessionId: SESSION,
    turnSeq: 1,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "/repo/out.ts" } }] },
    ],
  });
  assert.deepEqual(record.toolCalls[0]!.filesWritten, ["/repo/out.ts"]);
});

test("maps tool_result and resolves its toolName from the paired tool_use", () => {
  const big = "FILE BODY ".repeat(50);
  const record = buildRawSemanticTurnRecord({
    sessionId: SESSION,
    turnSeq: 2,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big }] },
    ],
  });
  assert.equal(record.toolResults.length, 1);
  const result = record.toolResults[0]!;
  assert.equal(result.toolCallId, "toolu_1");
  assert.equal(result.toolName, "Read");
  assert.equal(result.status, "success");
  assert.equal(result.fullText, big);
  assert.ok(result.summary.length <= 201); // truncated summary
});

test("maps an is_error tool_result to error status", () => {
  const record = buildRawSemanticTurnRecord({
    sessionId: SESSION,
    turnSeq: 1,
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "boom", is_error: true }] },
    ],
  });
  assert.equal(record.toolResults[0]!.status, "error");
});

test("skips empty text blocks", () => {
  const record = buildRawSemanticTurnRecord({
    sessionId: SESSION,
    turnSeq: 1,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "   " }] },
    ],
  });
  assert.equal(record.messages.length, 0);
});
