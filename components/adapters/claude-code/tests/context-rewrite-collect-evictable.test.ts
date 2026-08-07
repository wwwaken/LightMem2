import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";
import { collectEvictableToolResults } from "../src/context-rewrite/backend.js";

const SESSION = "sess-collect";

function messages(bigBody: string) {
  return [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: bigBody }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "KEEP current turn" }] },
  ];
}

function snapshotAndPlan(bigBody: string) {
  const msgs = messages(bigBody);
  const snapshot = buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision: "rev-1",
    messages: msgs as any,
  });
  const toolResultItem = snapshot.items.find((i) => i.kind === "tool_result");
  assert.ok(toolResultItem);
  const plan = {
    schemaVersion: snapshot.schemaVersion,
    planId: "plan-1",
    hostId: "claude-code",
    sourceModuleId: "test",
    sessionId: SESSION,
    baseRevision: snapshot.revision,
    createdAt: new Date(0).toISOString(),
    operations: [
      {
        id: "op-1",
        kind: "replace",
        targetItemIds: [toolResultItem!.stableId],
        targetItemFingerprints: { [toolResultItem!.stableId]: toolResultItem!.fingerprint },
      },
    ],
  } as any;
  const request = { sessionId: SESSION, revision: snapshot.revision, messages: msgs } as any;
  return { snapshot, plan, request };
}

test("collects the tool_result to be evicted with its original text", () => {
  const big = "EVICT_ME_" + "x".repeat(4000);
  const { snapshot, plan, request } = snapshotAndPlan(big);
  const collected = collectEvictableToolResults({
    snapshot, plan, request, applicableOperationIds: ["op-1"],
  });
  assert.equal(collected.length, 1);
  assert.equal(collected[0]!.toolUseId, "toolu_1");
  assert.equal(collected[0]!.originalText, big);
  assert.equal(collected[0]!.opId, "op-1");
});

test("collects nothing when the op is not applicable", () => {
  const big = "EVICT_ME_" + "x".repeat(4000);
  const { snapshot, plan, request } = snapshotAndPlan(big);
  const collected = collectEvictableToolResults({
    snapshot, plan, request, applicableOperationIds: [],
  });
  assert.equal(collected.length, 0);
});

test("never collects the protected current user turn", () => {
  // Build a plan that (wrongly) targets the last user turn; collect must skip it.
  const big = "EVICT_ME_" + "x".repeat(4000);
  const msgs = messages(big);
  const snapshot = buildClaudeContextSnapshot({
    sessionId: SESSION, revision: "rev-1", messages: msgs as any,
  });
  // Fabricate an op targeting the final user text turn (msgIdx 4).
  const plan = {
    schemaVersion: snapshot.schemaVersion, planId: "plan-x", hostId: "claude-code",
    sourceModuleId: "test", sessionId: SESSION, baseRevision: snapshot.revision,
    createdAt: new Date(0).toISOString(),
    operations: [{
      id: "op-bad", kind: "replace",
      targetItemIds: [`${SESSION}:4:0`],
      targetItemFingerprints: {},
    }],
  } as any;
  const request = { sessionId: SESSION, revision: snapshot.revision, messages: msgs } as any;
  const collected = collectEvictableToolResults({
    snapshot, plan, request, applicableOperationIds: ["op-bad"],
  });
  assert.equal(collected.length, 0);
});
