import test from "node:test";
import assert from "node:assert/strict";

import { claudeContextRewriteBackend } from "../src/context-rewrite/backend.js";

const SCHEMA = 1;

function historyWith(toolBody: string) {
  return {
    sessionId: "s1",
    revision: "rev-1",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Read", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: toolBody }] },
      { role: "user", content: "current question kept" },
    ],
  } as any;
}

const BIG = "file body ".repeat(80);

async function snapFor(req: any) {
  return claudeContextRewriteBackend.readSnapshot({ sessionId: "s1", request: req });
}

function planFor(itemId: string, fingerprint?: string) {
  return {
    schemaVersion: SCHEMA,
    planId: "plan-1",
    hostId: "claude-code",
    sessionId: "s1",
    baseRevision: "rev-1",
    sourceModuleId: "test",
    operations: [
      {
        id: "op-1",
        type: "replace",
        targetItemIds: [itemId],
        targetItemFingerprints: fingerprint ? { [itemId]: fingerprint } : undefined,
        rationale: "t",
        estimatedSavedChars: 10,
      },
    ],
    createdAt: new Date(0).toISOString(),
  } as any;
}

test("replaying the same plan on resent history removes the same item", async () => {
  const first = historyWith(BIG);
  const snap = await snapFor(first);
  const tr = snap.items.find((i) => i.kind === "tool_result")!;
  const plan = planFor(tr.stableId, tr.fingerprint);

  const r1 = await claudeContextRewriteBackend.apply({ snapshot: snap, plan, request: first });

  // Second request: Claude resends the identical history. Same plan, fresh snapshot.
  const second = historyWith(BIG);
  const snap2 = await snapFor(second);
  const r2 = await claudeContextRewriteBackend.apply({ snapshot: snap2, plan, request: second });

  assert.deepEqual(r1.result.removedItemIds, r2.result.removedItemIds);
  assert.equal(r1.result.savedChars, r2.result.savedChars);
  assert.equal(r2.result.applied, true);
});

test("saved chars are not double counted across replays", async () => {
  const req = historyWith(BIG);
  const snap = await snapFor(req);
  const tr = snap.items.find((i) => i.kind === "tool_result")!;
  const plan = planFor(tr.stableId, tr.fingerprint);

  const once = (await claudeContextRewriteBackend.apply({ snapshot: snap, plan, request: req })).result.savedChars;
  const twice = (await claudeContextRewriteBackend.apply({ snapshot: snap, plan, request: req })).result.savedChars;

  // Each apply reports the saving for that request only; it does not accumulate.
  assert.equal(once, twice);
});

test("plan defers when the target content changed (fingerprint drift), never fuzzy-deletes", async () => {
  const original = historyWith(BIG);
  const snap = await snapFor(original);
  const tr = snap.items.find((i) => i.kind === "tool_result")!;
  const plan = planFor(tr.stableId, tr.fingerprint);

  // The tool_result content is different now; same position, different fingerprint.
  const changed = historyWith("a completely different body " + BIG);
  const snap2 = await snapFor(changed);
  const r = await claudeContextRewriteBackend.apply({ snapshot: snap2, plan, request: changed });

  assert.equal(r.result.changed, false);
  assert.ok(r.result.deferredOperationIds.includes("op-1"));
});
