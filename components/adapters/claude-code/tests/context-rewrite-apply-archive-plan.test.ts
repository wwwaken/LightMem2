import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";
import { applyArchivePlan } from "../src/context-rewrite/archive.js";

const SESSION = "sess-apply-archive";

function messages(bigBody: string) {
  return [
    { role: "user", content: [{ type: "text", text: "read the file" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: bigBody }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "KEEP current turn" }] },
  ];
}

function setup(bigBody: string) {
  const msgs = messages(bigBody);
  const snapshot = buildClaudeContextSnapshot({
    sessionId: SESSION, revision: "rev-1", messages: msgs as any,
  });
  const toolResultItem = snapshot.items.find((i) => i.kind === "tool_result")!;
  const plan = {
    schemaVersion: snapshot.schemaVersion, planId: "plan-1", hostId: "claude-code",
    sourceModuleId: "test", sessionId: SESSION, baseRevision: snapshot.revision,
    createdAt: new Date(0).toISOString(),
    operations: [{
      id: "op-1", kind: "replace",
      targetItemIds: [toolResultItem.stableId],
      targetItemFingerprints: { [toolResultItem.stableId]: toolResultItem.fingerprint },
    }],
  } as any;
  const request = { sessionId: SESSION, revision: snapshot.revision, messages: msgs } as any;
  return { snapshot, plan, request, toolResultId: toolResultItem.stableId };
}

test("on archive success, records archiveRef and keeps the item targeted", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-apply-archive-"));
  const big = "EVICT_ME_" + "x".repeat(4000);
  const { snapshot, plan, request, toolResultId } = setup(big);

  await applyArchivePlan({
    stateDir, sessionId: SESSION, snapshot, plan, request,
    archiveFn: async () => ({ archiveRef: "archive://claude/deadbeefdeadbeef" }),
  });

  const op = plan.operations[0];
  // archiveRef recorded, item still scheduled for eviction
  assert.deepEqual(op.archiveRefs, ["archive://claude/deadbeefdeadbeef"]);
  assert.ok(op.targetItemIds.includes(toolResultId));
});

test("on archive FAILURE, the item is dropped from targets (bypass) and no ref recorded", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-apply-archive-fail-"));
  const big = "EVICT_ME_" + "x".repeat(4000);
  const { snapshot, plan, request, toolResultId } = setup(big);

  await applyArchivePlan({
    stateDir, sessionId: SESSION, snapshot, plan, request,
    archiveFn: async () => { throw new Error("archive write failed"); },
  });

  const op = plan.operations[0];
  // the tool_result must NOT be evicted (bypass) — dropped from targets
  assert.equal(op.targetItemIds.includes(toolResultId), false);
  // and no archiveRef recorded for a failed archive
  assert.ok(!op.archiveRefs || op.archiveRefs.length === 0);
});
