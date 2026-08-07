import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  validateContextMutationProtocolClosure,
  type ContextItemRef,
  type ContextMutationPlan,
  type ModelContextSnapshot,
} from "../src/index.js";

function item(
  stableId: string,
  kind: ContextItemRef["kind"],
  options: Pick<ContextItemRef, "callId" | "taskIds"> = {},
): ContextItemRef {
  return {
    stableId,
    kind,
    fingerprint: `fp-${stableId}`,
    chars: 10,
    ...options,
  };
}

function snapshot(items: ContextItemRef[]): ModelContextSnapshot {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    hostId: "test-host",
    sessionId: "session-1",
    revision: "ctxrev-current",
    items,
  };
}

function plan(
  operations: ContextMutationPlan["operations"],
): ContextMutationPlan {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId: "plan-1",
    hostId: "test-host",
    sessionId: "session-1",
    baseRevision: "ctxrev-current",
    sourceModuleId: "eviction",
    operations,
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}

function remove(
  id: string,
  targetItemIds: string[],
  taskIds: string[] = ["evictable-task"],
): ContextMutationPlan["operations"][number] {
  return {
    id,
    type: "remove",
    targetItemIds,
    taskIds,
    rationale: "evicted task",
    estimatedSavedChars: 10,
  };
}

test("accepts complete normalized pairs for all required host protocols", () => {
  const protocols = [
    "anthropic-tool-use",
    "responses-function-call",
    "responses-custom-tool-call",
  ];
  const items = protocols.flatMap((protocol) => [
    item(`${protocol}-call`, "tool_call", {
      callId: protocol,
      taskIds: ["evictable-task"],
    }),
    item(`${protocol}-result`, "tool_result", {
      callId: protocol,
      taskIds: ["evictable-task"],
    }),
  ]);
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot(items),
    plan: plan(protocols.map((protocol) => remove(
      `remove-${protocol}`,
      [`${protocol}-call`, `${protocol}-result`],
    ))),
    activeTaskIds: ["active-task"],
    evictableTaskIds: ["evictable-task"],
  });

  assert.deepEqual(validation, {
    valid: true,
    applicableOperationIds: protocols.map((protocol) => `remove-${protocol}`),
    deferredOperationIds: [],
    reasons: [],
  });
});

test("defers an operation that removes only one side of a pair", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("call", "tool_call", { callId: "call-1", taskIds: ["evictable-task"] }),
      item("result", "tool_result", { callId: "call-1", taskIds: ["evictable-task"] }),
    ]),
    plan: plan([remove("remove-call", ["call"])]),
    activeTaskIds: [],
    evictableTaskIds: ["evictable-task"],
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["remove-call"]);
  assert.deepEqual(validation.reasons, [
    "operation:remove-call:protocol_pair_partial",
  ]);
});

test("defers every operation owned by an unresolved call task", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("call", "tool_call", { callId: "call-1", taskIds: ["evictable-task"] }),
      item("message", "assistant", { taskIds: ["evictable-task"] }),
      item("other", "user", { taskIds: ["other-task"] }),
    ]),
    plan: plan([
      remove("remove-message", ["message"]),
      remove("remove-other", ["other"], ["other-task"]),
    ]),
    activeTaskIds: [],
    evictableTaskIds: ["evictable-task", "other-task"],
  });

  assert.deepEqual(validation.applicableOperationIds, ["remove-other"]);
  assert.deepEqual(validation.deferredOperationIds, ["remove-message"]);
  assert.deepEqual(validation.reasons, [
    "operation:remove-message:unresolved_protocol_call",
  ]);
});

test("defers tasks with orphaned or duplicate protocol items", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("orphan-result", "tool_result", {
        callId: "orphan-call",
        taskIds: ["orphan-task"],
      }),
      item("orphan-message", "assistant", { taskIds: ["orphan-task"] }),
      item("duplicate-call-1", "tool_call", {
        callId: "duplicate-call",
        taskIds: ["duplicate-task"],
      }),
      item("duplicate-call-2", "tool_call", {
        callId: "duplicate-call",
        taskIds: ["duplicate-task"],
      }),
      item("duplicate-result", "tool_result", {
        callId: "duplicate-call",
        taskIds: ["duplicate-task"],
      }),
      item("duplicate-message", "assistant", { taskIds: ["duplicate-task"] }),
      item("unrelated-message", "user", { taskIds: ["unrelated-task"] }),
    ]),
    plan: plan([
      remove("remove-orphan-task", ["orphan-message"], ["orphan-task"]),
      remove("remove-duplicate-task", ["duplicate-message"], ["duplicate-task"]),
      remove("remove-unrelated-task", ["unrelated-message"], ["unrelated-task"]),
    ]),
    activeTaskIds: [],
    evictableTaskIds: ["orphan-task", "duplicate-task", "unrelated-task"],
  });

  assert.deepEqual(validation.applicableOperationIds, ["remove-unrelated-task"]);
  assert.deepEqual(validation.deferredOperationIds, [
    "remove-orphan-task",
    "remove-duplicate-task",
  ]);
  assert.deepEqual(validation.reasons, [
    "operation:remove-orphan-task:unresolved_protocol_call",
    "operation:remove-duplicate-task:unresolved_protocol_call",
  ]);
});

test("defers an operation spanning active and evictable tasks", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("active", "user", { taskIds: ["active-task"] }),
      item("evictable", "assistant", { taskIds: ["evictable-task"] }),
    ]),
    plan: plan([remove(
      "remove-mixed",
      ["active", "evictable"],
      ["active-task", "evictable-task"],
    )]),
    activeTaskIds: ["active-task"],
    evictableTaskIds: ["evictable-task"],
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["remove-mixed"]);
  assert.deepEqual(validation.reasons, [
    "operation:remove-mixed:active_evictable_task_overlap",
  ]);
});

test("defers targeted protocol items without a call id", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("call", "tool_call", { taskIds: ["evictable-task"] }),
    ]),
    plan: plan([remove("remove-call", ["call"])]),
    activeTaskIds: [],
    evictableTaskIds: ["evictable-task"],
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["remove-call"]);
  assert.deepEqual(validation.reasons, [
    "operation:remove-call:protocol_call_id_missing",
  ]);
});

test("validates only candidates that survived structural revalidation", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("call", "tool_call", { callId: "call-1", taskIds: ["evictable-task"] }),
      item("result", "tool_result", { callId: "call-1", taskIds: ["evictable-task"] }),
      item("message", "user", { taskIds: ["evictable-task"] }),
    ]),
    plan: plan([
      remove("already-deferred", ["call"]),
      remove("candidate", ["message"]),
    ]),
    activeTaskIds: [],
    evictableTaskIds: ["evictable-task"],
    candidateOperationIds: ["candidate"],
  });

  assert.deepEqual(validation, {
    valid: true,
    applicableOperationIds: ["candidate"],
    deferredOperationIds: [],
    reasons: [],
  });
});

test("defers active-only task targets", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("active-message", "assistant", { taskIds: ["active-task"] }),
    ]),
    plan: plan([remove("remove-active", ["active-message"], ["active-task"])]),
    activeTaskIds: ["active-task"],
    evictableTaskIds: [],
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["remove-active"]);
  assert.deepEqual(validation.reasons, [
    "operation:remove-active:active_task_targeted",
  ]);
});

test("rejects duplicate operation ids, missing targets, and ambiguous item ids", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("duplicate", "assistant", { taskIds: ["evictable-task"] }),
      item("duplicate", "user", { taskIds: ["evictable-task"] }),
    ]),
    plan: plan([
      remove("duplicate-op", ["duplicate"]),
      remove("duplicate-op", ["missing"]),
      remove("ambiguous-op", ["duplicate"]),
      remove("missing-op", ["missing"]),
    ]),
    activeTaskIds: [],
    evictableTaskIds: ["evictable-task"],
  });

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, [
    "duplicate-op",
    "ambiguous-op",
    "missing-op",
  ]);
  assert.deepEqual(validation.reasons, [
    "operation:duplicate-op:duplicate_id",
    "operation:ambiguous-op:target_ambiguous",
    "operation:missing-op:target_missing",
  ]);
});

test("rejects an explicitly unknown candidate operation", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("message", "assistant", { taskIds: ["evictable-task"] }),
    ]),
    plan: plan([remove("known", ["message"])]),
    activeTaskIds: [],
    evictableTaskIds: ["evictable-task"],
    candidateOperationIds: ["unknown"],
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["unknown"]);
  assert.deepEqual(validation.reasons, [
    "candidate:unknown:missing",
  ]);
});

test("rejects a tool pair whose call and result belong to different tasks", () => {
  const validation = validateContextMutationProtocolClosure({
    snapshot: snapshot([
      item("call", "tool_call", { callId: "call-1", taskIds: ["task-a"] }),
      item("result", "tool_result", { callId: "call-1", taskIds: ["task-b"] }),
      item("message", "assistant", { taskIds: ["task-a"] }),
    ]),
    plan: plan([remove("remove-message", ["message"], ["task-a"])]),
    activeTaskIds: [],
    evictableTaskIds: ["task-a", "task-b"],
  });

  assert.deepEqual(validation.applicableOperationIds, []);
  assert.deepEqual(validation.deferredOperationIds, ["remove-message"]);
  assert.deepEqual(validation.reasons, [
    "operation:remove-message:protocol_task_mismatch",
  ]);
});
