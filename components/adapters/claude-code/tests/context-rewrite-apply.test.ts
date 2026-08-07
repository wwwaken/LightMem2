import test from "node:test";
import assert from "node:assert/strict";

import { claudeContextRewriteBackend } from "../src/context-rewrite/backend.js";

const SCHEMA = 1;

function sampleRequest() {
  return {
    sessionId: "s1",
    revision: "rev-1",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "old assistant note that can be evicted" },
          { type: "tool_use", id: "call-1", name: "Read", input: { path: "a.txt" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "big old file body ".repeat(50) }] },
      { role: "user", content: "current question, must be kept" },
    ],
  } as any;
}

async function snap() {
  return claudeContextRewriteBackend.readSnapshot({ sessionId: "s1", request: sampleRequest() });
}

function plan(targetItemIds: string[], fingerprints?: Record<string, string>) {
  return {
    schemaVersion: SCHEMA,
    planId: "plan-1",
    hostId: "claude-code",
    sessionId: "s1",
    baseRevision: "rev-1",
    sourceModuleId: "test",
    operations: [
      { id: "op-1", type: "replace", targetItemIds, targetItemFingerprints: fingerprints, rationale: "t", estimatedSavedChars: 5 },
    ],
    createdAt: new Date(0).toISOString(),
  } as any;
}

test("apply rewrites a tool_result but keeps its tool_use_id (closure intact)", async () => {
  const s = await snap();
  // find the tool_result item id
  const trItem = s.items.find((i) => i.kind === "tool_result")!;
  const req = sampleRequest();
  const { request: out, result } = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([trItem.stableId], { [trItem.stableId]: trItem.fingerprint }),
    request: req,
  });
  assert.equal(result.applied, true);
  assert.equal(result.changed, true);
  assert.ok(result.savedChars > 0);
  // the tool_result block still exists with the same tool_use_id
  const trMsg = (out.messages as any[]).find((m) =>
    Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
  );
  const trBlock = trMsg.content.find((b: any) => b.type === "tool_result");
  assert.equal(trBlock.tool_use_id, "call-1");
  assert.match(trBlock.content, /evicted/);
});

test("apply never rewrites the current user message", async () => {
  const s = await snap();
  // last user message is index 2 (string content). Its item id:
  const currentItem = s.items[s.items.length - 1];
  const req = sampleRequest();
  const { request: out, result } = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([currentItem.stableId], { [currentItem.stableId]: currentItem.fingerprint }),
    request: req,
  });
  // op targeted the current turn → nothing removed
  assert.equal(result.changed, false);
  assert.equal((out.messages as any[])[2].content, "current question, must be kept");
});

test("apply does not mutate the original request object", async () => {
  const s = await snap();
  const trItem = s.items.find((i) => i.kind === "tool_result")!;
  const req = sampleRequest();
  const before = JSON.stringify(req);
  await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([trItem.stableId], { [trItem.stableId]: trItem.fingerprint }),
    request: req,
  });
  assert.equal(JSON.stringify(req), before, "original request must be untouched");
});

test("apply leaves tool_use blocks alone to preserve the pair", async () => {
  const s = await snap();
  const toolUseItem = s.items.find((i) => i.kind === "tool_call")!;
  const req = sampleRequest();
  const { request: out, result } = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([toolUseItem.stableId], { [toolUseItem.stableId]: toolUseItem.fingerprint }),
    request: req,
  });
  // tool_use is skipped → op did not touch anything → deferred, unchanged
  assert.equal(result.changed, false);
  const tu = (out.messages as any[])[0].content.find((b: any) => b.type === "tool_use");
  assert.equal(tu.id, "call-1");
});

test("apply preserves is_error when replacing an error tool result", async () => {
  const req = sampleRequest();
  (req.messages[1] as any).content[0].text = "old assistant note";
  (req.messages[1] as any).content[0].is_error = true;
  const s = await claudeContextRewriteBackend.readSnapshot({ sessionId: "s1", request: req });
  const trItem = s.items.find((i) => i.kind === "tool_result" && i.callId === "call-1")!;
  const { request: out, result } = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([trItem.stableId], { [trItem.stableId]: trItem.fingerprint }),
    request: req,
  });

  assert.equal(result.changed, true);
  const toolResult = (out.messages as any[])[1].content.find((block: any) => block.type === "tool_result");
  assert.equal(toolResult.is_error, true);
});

test("apply rewrites an old string message but protects assistant prefill after the current turn", async () => {
  const req = {
    sessionId: "s1",
    revision: "rev-1",
    messages: [
      { role: "assistant", content: "old assistant text" },
      { role: "user", content: "current question" },
      { role: "assistant", content: "prefill" },
    ],
  } as any;
  const s = await claudeContextRewriteBackend.readSnapshot({ sessionId: "s1", request: req });
  const oldItem = s.items[0]!;
  const prefillItem = s.items[2]!;
  const oldResult = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([oldItem.stableId], { [oldItem.stableId]: oldItem.fingerprint }),
    request: req,
  });
  assert.equal(oldResult.result.changed, true);
  assert.equal((oldResult.request.messages as any[])[0].content, "[evicted: earlier content removed]");

  const prefillResult = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([prefillItem.stableId], { [prefillItem.stableId]: prefillItem.fingerprint }),
    request: req,
  });
  assert.equal(prefillResult.result.changed, false);
  assert.equal((prefillResult.request.messages as any[])[2].content, "prefill");
});

test("apply defers unsupported image blocks instead of converting them to text", async () => {
  const req = {
    sessionId: "s1",
    revision: "rev-1",
    messages: [
      { role: "assistant", content: [{ type: "image", source: { type: "base64", data: "opaque" } }] },
      { role: "user", content: "current" },
    ],
  } as any;
  const s = await claudeContextRewriteBackend.readSnapshot({ sessionId: "s1", request: req });
  const image = s.items[0]!;
  const result = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([image.stableId], { [image.stableId]: image.fingerprint }),
    request: req,
  });
  assert.equal(result.result.changed, false);
  assert.deepEqual((result.request.messages as any[])[0].content[0], req.messages[0].content[0]);
});

test("apply defers an orphaned tool result", async () => {
  const req = {
    sessionId: "s1",
    revision: "rev-1",
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "missing-call", content: "body" }] },
      { role: "user", content: "current" },
    ],
  } as any;
  const s = await claudeContextRewriteBackend.readSnapshot({ sessionId: "s1", request: req });
  const result = await claudeContextRewriteBackend.apply({
    snapshot: s,
    plan: plan([s.items[0]!.stableId], { [s.items[0]!.stableId]: s.items[0]!.fingerprint }),
    request: req,
  });
  assert.equal(result.result.changed, false);
  assert.match(result.result.deferredOperationIds.join(","), /op-1/);
});
