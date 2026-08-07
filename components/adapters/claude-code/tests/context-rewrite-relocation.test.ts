import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";
import { relocateContextMutationPlan } from "../src/context-rewrite/backend.js";

const SESSION = "sess-reloc";

function snapshotOf(revision: string, messages: unknown[]) {
  return buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision,
    messages: messages as any,
  });
}

function toolUse(id: string) {
  return { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: {} }] };
}
function toolResult(id: string, content: string) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] };
}
function userText(text: string) {
  return { role: "user", content: text };
}

// Build a plan whose single op targets the tool_result item (the large one),
// carrying that item's fingerprint so relocation can re-anchor it.
function planForToolResult(snapshot: ReturnType<typeof snapshotOf>) {
  const item = snapshot.items.find((i) => i.kind === "tool_result");
  assert.ok(item, "snapshot must contain a tool_result item");
  return {
    schemaVersion: snapshot.schemaVersion,
    planId: "plan-reloc-1",
    hostId: "claude-code",
    sourceModuleId: "test",
    sessionId: SESSION,
    baseRevision: snapshot.revision,
    createdAt: new Date(0).toISOString(),
    operations: [
      {
        id: "op-1",
        kind: "replace",
        targetItemIds: [item!.stableId],
        targetItemFingerprints: { [item!.stableId]: item!.fingerprint },
      },
    ],
  } as any;
}

test("relocates an operation to the new stableId when a later turn shifts positions", () => {
  const big = "TOOL_OUTPUT_".repeat(500);
  const snapV1 = snapshotOf("rev-1", [
    toolUse("toolu_1"),
    toolResult("toolu_1", big),
    userText("first question"),
  ]);
  const plan = planForToolResult(snapV1);
  const oldTargetId = plan.operations[0].targetItemIds[0];

  // Turn 2: prepend a new earlier message so the same tool_result shifts index.
  const snapV2 = snapshotOf("rev-2", [
    userText("a brand new earlier turn"),
    toolUse("toolu_1"),
    toolResult("toolu_1", big),
    userText("first question"),
    userText("second question"),
  ]);

  const { plan: relocated, relocated: didRelocate } = relocateContextMutationPlan({
    snapshot: snapV2,
    plan,
  });

  assert.equal(didRelocate, true);
  assert.equal(relocated.baseRevision, "rev-2");
  assert.equal(relocated.operations.length, 1);

  const relocatedOp = relocated.operations[0];
  assert.ok(relocatedOp, "there must be one relocated operation");
  const newTargetId = relocatedOp!.targetItemIds[0]!;
  // The id must have changed (position shifted) but point at the same content.
  assert.notEqual(newTargetId, oldTargetId);
  const movedItem = snapV2.items.find((i) => i.stableId === newTargetId);
  assert.ok(movedItem, "relocated target must exist in the new snapshot");
  assert.equal(movedItem!.kind, "tool_result");
  const fps = relocatedOp!.targetItemFingerprints ?? {};
  assert.equal(fps[newTargetId] ?? "", movedItem!.fingerprint);
});

test("defers an operation when the same fingerprint matches multiple items", () => {
  // Two identical assistant TEXT blocks fingerprint the same (kind+content, no
  // callId), so the fingerprint is ambiguous across items.
  const dup = "IDENTICAL_ASSISTANT_TEXT_".repeat(300);
  const assistantText = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

  const snapV1 = snapshotOf("rev-1", [
    assistantText(dup),
    userText("q"),
  ]);
  // Target that single text item.
  const item = snapV1.items.find((i) => i.kind === "assistant");
  assert.ok(item, "snapshot must contain an assistant text item");
  const plan = {
    schemaVersion: snapV1.schemaVersion,
    planId: "plan-reloc-dup",
    hostId: "claude-code",
    sourceModuleId: "test",
    sessionId: SESSION,
    baseRevision: snapV1.revision,
    createdAt: new Date(0).toISOString(),
    operations: [
      {
        id: "op-1",
        kind: "replace",
        targetItemIds: [item!.stableId],
        targetItemFingerprints: { [item!.stableId]: item!.fingerprint },
      },
    ],
  } as any;

  // Turn 2 now has the SAME text twice → the fingerprint matches two items.
  const snapV2 = snapshotOf("rev-2", [
    assistantText(dup),
    assistantText(dup),
    userText("q"),
  ]);

  const { plan: relocated, relocated: didRelocate } = relocateContextMutationPlan({
    snapshot: snapV2,
    plan,
  });

  assert.equal(didRelocate, false);
  assert.equal(relocated.operations.length, 0);
});

test("defers an operation when the targeted content is gone", () => {
  const gone = "SOON_TO_VANISH_".repeat(300);
  const snapV1 = snapshotOf("rev-1", [
    toolUse("toolu_1"),
    toolResult("toolu_1", gone),
    userText("q"),
  ]);
  const plan = planForToolResult(snapV1);

  const snapV2 = snapshotOf("rev-2", [
    userText("completely different history"),
    userText("q"),
  ]);

  const { plan: relocated, relocated: didRelocate } = relocateContextMutationPlan({
    snapshot: snapV2,
    plan,
  });

  assert.equal(didRelocate, false);
  assert.equal(relocated.operations.length, 0);
});
