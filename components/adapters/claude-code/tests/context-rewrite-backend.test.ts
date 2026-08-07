import test from "node:test";
import assert from "node:assert/strict";

import { claudeContextRewriteBackend } from "../src/context-rewrite/backend.js";

const SCHEMA = 1;

function sampleRequest() {
  return {
    sessionId: "s1",
    revision: "rev-1",
    messages: [
      { role: "user", content: "read config.json" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "call-1", name: "Read", input: { path: "config.json" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "body" }] },
    ],
  } as any;
}

async function snapshotFor() {
  return claudeContextRewriteBackend.readSnapshot({
    sessionId: "s1",
    request: sampleRequest(),
  });
}

function planWith(targetItemIds: string[], fingerprints?: Record<string, string>) {
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
        type: "remove",
        targetItemIds,
        targetItemFingerprints: fingerprints,
        rationale: "test",
        estimatedSavedChars: 10,
      },
    ],
    createdAt: new Date(0).toISOString(),
  } as any;
}

test("backend declares request_overlay mode and claude-code host", () => {
  assert.equal(claudeContextRewriteBackend.hostId, "claude-code");
  assert.equal(claudeContextRewriteBackend.mode, "request_overlay");
});

test("readSnapshot returns a snapshot over the current messages", async () => {
  const snap = await snapshotFor();
  assert.equal(snap.hostId, "claude-code");
  assert.equal(snap.sessionId, "s1");
  assert.ok(snap.items.length > 0);
});

test("validate defers the plan when baseRevision does not match", async () => {
  const snap = await snapshotFor();
  const plan = planWith([snap.items[0].stableId]);
  plan.baseRevision = "different-rev";
  const result = await claudeContextRewriteBackend.validate({ snapshot: snap, plan });
  assert.equal(result.valid, false);
  assert.deepEqual(result.applicableOperationIds, []);
  assert.ok(result.deferredOperationIds.includes("op-1"));
});

test("validate marks an operation applicable when targets exist", async () => {
  const snap = await snapshotFor();
  const target = snap.items[0].stableId;
  const result = await claudeContextRewriteBackend.validate({
    snapshot: snap,
    plan: planWith([target]),
  });
  assert.equal(result.valid, true);
  assert.ok(result.applicableOperationIds.includes("op-1"));
});

test("validate defers when a target item id is missing", async () => {
  const snap = await snapshotFor();
  const result = await claudeContextRewriteBackend.validate({
    snapshot: snap,
    plan: planWith(["s1:99:0"]),
  });
  assert.ok(result.deferredOperationIds.includes("op-1"));
  assert.ok(!result.applicableOperationIds.includes("op-1"));
});

test("validate defers when a target fingerprint has drifted", async () => {
  const snap = await snapshotFor();
  const target = snap.items[0].stableId;
  const result = await claudeContextRewriteBackend.validate({
    snapshot: snap,
    plan: planWith([target], { [target]: "wrong-fingerprint" }),
  });
  assert.ok(result.deferredOperationIds.includes("op-1"));
});

test("apply skeleton returns the request unchanged and reports not applied", async () => {
  const snap = await snapshotFor();
  const target = snap.items[0].stableId;
  const request = sampleRequest();
  const { request: out, result } = await claudeContextRewriteBackend.apply({
    snapshot: snap,
    plan: planWith([target]),
    request,
  });
  assert.equal(out, request);
  assert.equal(result.applied, false);
  assert.equal(result.changed, false);
});
