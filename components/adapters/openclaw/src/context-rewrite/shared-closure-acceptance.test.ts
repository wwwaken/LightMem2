import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  validateContextMutationProtocolClosure,
  type ContextItemRef,
  type ContextMutationPlan,
  type ModelContextSnapshot,
} from "@lightmem2/host-adapter";

import {
  createOpenClawReferenceBackend,
  type OpenClawReferenceBackendMetadata,
} from "./reference-backend.js";

const sessionId = "gua-06-closure-session";
const taskId = "task-completed";
const operationId = "operation-1";

function createSnapshot(
  includeResult = true,
): ModelContextSnapshot<OpenClawReferenceBackendMetadata> {
  const messages: Record<string, unknown>[] = [
    {
      messageId: "call-item",
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "lookup",
            arguments: "{}",
          },
        },
      ],
      details: {
        contextSafe: {
          taskIds: [taskId],
        },
      },
    },
  ];

  const items: ContextItemRef[] = [
    {
      stableId: "call-item",
      kind: "tool_call",
      role: "assistant",
      callId: "call-1",
      taskIds: [taskId],
      fingerprint: "call-fingerprint",
      chars: 12,
    },
  ];

  if (includeResult) {
    messages.push({
      messageId: "result-item",
      role: "tool",
      tool_call_id: "call-1",
      content: "lookup result",
      details: {
        contextSafe: {
          taskIds: [taskId],
        },
      },
    });

    items.push({
      stableId: "result-item",
      kind: "tool_result",
      role: "tool",
      callId: "call-1",
      taskIds: [taskId],
      fingerprint: "result-fingerprint",
      chars: 13,
    });
  }

  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    hostId: "openclaw",
    sessionId,
    revision: includeResult
      ? "revision-complete"
      : "revision-unresolved",
    items,
    adapterMetadata: {
      canonicalState: {
        version: 1,
        sessionId,
        messages,
        seenMessageIds: messages.map(
          (message) => String(message.messageId),
        ),
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
    },
  };
}

function createPlan(
  snapshot: ModelContextSnapshot<OpenClawReferenceBackendMetadata>,
  targetItemIds: string[],
): ContextMutationPlan {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId: "gua-06-closure-plan",
    hostId: "openclaw",
    sessionId,
    baseRevision: snapshot.revision,
    sourceModuleId: "eviction",
    operations: [
      {
        id: operationId,
        type: "remove",
        targetItemIds,
        taskIds: [taskId],
        rationale: "validate protocol closure consistency",
        estimatedSavedChars: 25,
      },
    ],
    createdAt: "2026-08-05T00:00:00.000Z",
  };
}

async function assertClosureDecisionMatches(
  snapshot: ModelContextSnapshot<OpenClawReferenceBackendMetadata>,
  plan: ContextMutationPlan,
): Promise<void> {
  const referenceValidation =
    await createOpenClawReferenceBackend().validate({
      snapshot,
      plan,
    });

  const sharedValidation =
    validateContextMutationProtocolClosure({
      snapshot,
      plan,
      activeTaskIds: [],
      evictableTaskIds: [taskId],
    });

  assert.deepEqual(
    {
      applicableOperationIds:
        sharedValidation.applicableOperationIds,
      deferredOperationIds:
        sharedValidation.deferredOperationIds,
    },
    {
      applicableOperationIds:
        referenceValidation.applicableOperationIds,
      deferredOperationIds:
        referenceValidation.deferredOperationIds,
    },
  );
}

test(
  "GUA-06 shared closure agrees with OpenClaw for a complete tool pair",
  async () => {
    const snapshot = createSnapshot();
    const plan = createPlan(snapshot, [
      "call-item",
      "result-item",
    ]);

    await assertClosureDecisionMatches(snapshot, plan);

    const validation =
      validateContextMutationProtocolClosure({
        snapshot,
        plan,
        activeTaskIds: [],
        evictableTaskIds: [taskId],
      });

    assert.deepEqual(
      validation.applicableOperationIds,
      [operationId],
    );
    assert.deepEqual(validation.deferredOperationIds, []);
  },
);

test(
  "GUA-06 shared closure agrees with OpenClaw when a tool pair is split",
  async () => {
    const snapshot = createSnapshot();
    const plan = createPlan(snapshot, ["call-item"]);

    await assertClosureDecisionMatches(snapshot, plan);

    const validation =
      validateContextMutationProtocolClosure({
        snapshot,
        plan,
        activeTaskIds: [],
        evictableTaskIds: [taskId],
      });

    assert.deepEqual(validation.applicableOperationIds, []);
    assert.deepEqual(
      validation.deferredOperationIds,
      [operationId],
    );
  },
);

test(
  "GUA-06 shared closure agrees with OpenClaw for an unresolved call",
  async () => {
    const snapshot = createSnapshot(false);
    const plan = createPlan(snapshot, ["call-item"]);

    await assertClosureDecisionMatches(snapshot, plan);

    const validation =
      validateContextMutationProtocolClosure({
        snapshot,
        plan,
        activeTaskIds: [],
        evictableTaskIds: [taskId],
      });

    assert.deepEqual(validation.applicableOperationIds, []);
    assert.deepEqual(
      validation.deferredOperationIds,
      [operationId],
    );
  },
);
