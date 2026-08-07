import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  revalidateContextMutationPlan,
  type ContextMutationPlan,
  type ModelContextSnapshot,
} from "../src/index.js";

const snapshot: ModelContextSnapshot = {
  schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  hostId: "test-host",
  sessionId: "session-1",
  revision: "ctxrev-current",
  items: [
    {
      stableId: "item-1",
      kind: "user",
      fingerprint: "fp-1",
      chars: 10,
    },
    {
      stableId: "item-2",
      kind: "assistant",
      fingerprint: "fp-2",
      chars: 20,
    },
  ],
};

function createPlan(
  operations: ContextMutationPlan["operations"],
  overrides: Partial<ContextMutationPlan> = {},
): ContextMutationPlan {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId: "plan-1",
    hostId: snapshot.hostId,
    sessionId: snapshot.sessionId,
    baseRevision: snapshot.revision,
    sourceModuleId: "eviction",
    operations,
    createdAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function removeOperation(id: string, targetItemIds: string[]) {
  const fingerprints = Object.fromEntries(
    targetItemIds.flatMap((targetItemId) => {
      const item = snapshot.items.find(
        (candidate) => candidate.stableId === targetItemId,
      );
      return item ? [[targetItemId, item.fingerprint]] : [];
    }),
  );
  return {
    id,
    type: "remove" as const,
    targetItemIds,
    targetItemFingerprints: fingerprints,
    rationale: "evicted task",
    estimatedSavedChars: 10,
  };
}

test("matching revision applies operations whose targets exist", () => {
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan([removeOperation("op-1", ["item-1"])]),
  });

  assert.deepEqual(validation, {
    valid: true,
    applicableOperationIds: ["op-1"],
    deferredOperationIds: [],
    reasons: [],
  });
});

test("matching revision rejects malformed persisted fingerprint claims", () => {
  const operation = removeOperation("op-1", ["item-1"]);
  operation.targetItemFingerprints = {
    "item-1": "wrong-fingerprint",
  };
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan([operation]),
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-1"]);
  assert.deepEqual(validation.reasons, ["operation:op-1:target_changed"]);
});

test("revision mismatch keeps relocatable operations applicable", () => {
  const validation = revalidateContextMutationPlan({
    snapshot: {
      ...snapshot,
      revision: "ctxrev-appended",
      items: [
        ...snapshot.items,
        {
          stableId: "item-3",
          kind: "user",
          fingerprint: "fp-3",
          chars: 5,
        },
      ],
    },
    plan: createPlan([removeOperation("op-1", ["item-1"])]),
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.applicableOperationIds, ["op-1"]);
  assert.deepEqual(validation.deferredOperationIds, []);
  assert.deepEqual(validation.reasons, ["revision_mismatch"]);
});

test("revision mismatch defers a target whose content fingerprint changed", () => {
  const validation = revalidateContextMutationPlan({
    snapshot: {
      ...snapshot,
      revision: "ctxrev-changed",
      items: [
        { ...snapshot.items[0]!, fingerprint: "fp-1-changed" },
        snapshot.items[1]!,
      ],
    },
    plan: createPlan([removeOperation("op-1", ["item-1"])]),
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-1"]);
  assert.deepEqual(validation.reasons, [
    "revision_mismatch",
    "operation:op-1:target_changed",
  ]);
});

test("revision mismatch requires persisted target fingerprints", () => {
  const {
    targetItemFingerprints: _targetItemFingerprints,
    ...operation
  } = removeOperation("op-1", ["item-1"]);
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan([operation], { baseRevision: "ctxrev-stale" }),
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-1"]);
  assert.deepEqual(validation.reasons, [
    "revision_mismatch",
    "operation:op-1:target_fingerprint_missing",
  ]);
});

test("revision mismatch rejects fingerprint claims outside target scope", () => {
  const operation = removeOperation("op-1", ["item-1"]);
  operation.targetItemFingerprints["item-2"] = "fp-2";
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan([operation], { baseRevision: "ctxrev-stale" }),
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-1"]);
  assert.deepEqual(validation.reasons, [
    "revision_mismatch",
    "operation:op-1:target_fingerprint_scope_mismatch",
  ]);
});

test("missing targets defer only operations that cannot be relocated", () => {
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan(
      [
        removeOperation("op-applicable", ["item-1"]),
        removeOperation("op-missing", ["item-missing"]),
        removeOperation("op-atomic", ["item-2", "item-missing"]),
      ],
      { baseRevision: "ctxrev-stale" },
    ),
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.applicableOperationIds, ["op-applicable"]);
  assert.deepEqual(validation.deferredOperationIds, ["op-missing", "op-atomic"]);
  assert.deepEqual(validation.reasons, [
    "revision_mismatch",
    "operation:op-missing:target_missing",
    "operation:op-atomic:target_missing",
  ]);
});

test("a fully deferred revalidation remains a safe no-op", () => {
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan(
      [removeOperation("op-missing", ["item-missing"])],
      { baseRevision: "ctxrev-stale" },
    ),
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-missing"]);
});

test("ambiguous stable IDs cannot be relocated", () => {
  const validation = revalidateContextMutationPlan({
    snapshot: { ...snapshot, items: [...snapshot.items, snapshot.items[0]!] },
    plan: createPlan([removeOperation("op-1", ["item-1"])]),
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-1"]);
  assert.deepEqual(validation.reasons, ["operation:op-1:target_ambiguous"]);
});

test("duplicate operation IDs and empty targets are deferred", () => {
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan([
      removeOperation("op-duplicate", ["item-1"]),
      removeOperation("op-duplicate", ["item-2"]),
      removeOperation("op-empty", []),
    ]),
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-duplicate", "op-empty"]);
  assert.deepEqual(validation.reasons, [
    "operation:op-duplicate:duplicate_id",
    "operation:op-empty:targets_empty",
  ]);
});

test("empty operation IDs and duplicate targets are deferred", () => {
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan([
      removeOperation("", ["item-1"]),
      removeOperation("op-duplicate-target", ["item-2", "item-2"]),
    ]),
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(
    validation.deferredOperationIds,
    ["", "op-duplicate-target"],
  );
  assert.deepEqual(validation.reasons, [
    "operation:<empty>:id_empty",
    "operation:op-duplicate-target:targets_duplicate",
  ]);
});

test("schema mismatch invalidates and defers the whole plan", () => {
  const validation = revalidateContextMutationPlan({
    snapshot: {
      ...snapshot,
      schemaVersion: 99 as typeof snapshot.schemaVersion,
    },
    plan: createPlan(
      [removeOperation("op-1", ["item-1"])],
      {
        schemaVersion: 99 as ContextMutationPlan["schemaVersion"],
      },
    ),
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-1"]);
  assert.deepEqual(validation.reasons, [
    "plan_schema_version_mismatch",
    "snapshot_schema_version_mismatch",
  ]);
});

test("empty plan and snapshot envelope fields invalidate revalidation", () => {
  const validation = revalidateContextMutationPlan({
    snapshot: {
      ...snapshot,
      hostId: "",
      sessionId: "",
      revision: "",
    },
    plan: createPlan(
      [removeOperation("op-1", ["item-1"])],
      {
        planId: "",
        hostId: "",
        sessionId: "",
        baseRevision: "",
      },
    ),
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.deferredOperationIds, ["op-1"]);
  assert.deepEqual(validation.reasons, [
    "plan_id_empty",
    "plan_host_id_empty",
    "snapshot_host_id_empty",
    "plan_session_id_empty",
    "snapshot_session_id_empty",
    "plan_base_revision_empty",
    "snapshot_revision_empty",
  ]);
});

test("host or session mismatch invalidates and defers the whole plan", () => {
  const operations = [
    removeOperation("op-1", ["item-1"]),
    removeOperation("op-2", ["item-2"]),
  ];
  const validation = revalidateContextMutationPlan({
    snapshot,
    plan: createPlan(operations, {
      hostId: "other-host",
      sessionId: "other-session",
      baseRevision: "ctxrev-stale",
    }),
  });

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["op-1", "op-2"]);
  assert.deepEqual(validation.reasons, [
    "host_id_mismatch",
    "session_id_mismatch",
    "revision_mismatch",
  ]);
});
