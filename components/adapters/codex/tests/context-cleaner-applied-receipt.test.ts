import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  type ContextCleanPreparedExecution,
} from "@lightrsi/cleaner";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextRewriteResult,
} from "@lightrsi/host-adapter";

import {
  buildCodexCleanerAppliedReceipt,
  buildCodexCleanerAppliedReceiptFromRewrite,
} from "../src/context-cleaner/applied-receipt.js";
import type { CodexSharedBackendDetails } from "../src/context-rewrite/backend.js";
import {
  CODEX_REBASE_EPOCH_SCHEMA,
  type CodexRebaseAccounting,
  type CodexRebaseEpoch,
  type CodexRebaseRequestResult,
} from "../src/context-rewrite/types.js";

const accounting: CodexRebaseAccounting = {
  plannedSavedChars: 100,
  plannedSavedTokens: 99,
  actuallyRemovedChars: 80,
  actuallyRemovedTokens: 17,
  rebaseReplayCostChars: 0,
  rebaseReplayCostTokens: 0,
  subsequentSavedCharsPerTurn: 80,
  subsequentSavedTokensPerTurn: 17,
  estimatorCostChars: 0,
  estimatorCostTokens: 0,
  fallbackExtraRequestCount: 0,
  cacheColdMissCount: 0,
};

function execution(): ContextCleanPreparedExecution {
  return {
    cleanPlanId: "clean-plan",
    hostId: "codex",
    sessionId: "session-a",
    baseRevision: "revision-a",
    selectedTasks: [
      { taskId: "task-a", itemIds: ["item-a"], itemDigests: { "item-a": "digest-a" } },
      { taskId: "task-b", itemIds: ["item-b"], itemDigests: { "item-b": "digest-b" } },
    ],
    mutationPlan: {
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      planId: "mutation-plan",
      hostId: "codex",
      sessionId: "session-a",
      baseRevision: "revision-a",
      sourceModuleId: "cleaner_manual",
      createdAt: "2026-08-28T00:00:00.000Z",
      operations: [
        { id: "operation-a", type: "remove", targetItemIds: ["item-a"], rationale: "clean", estimatedSavedChars: 40 },
        { id: "operation-b", type: "remove", targetItemIds: ["item-b"], rationale: "clean", estimatedSavedChars: 40 },
      ],
    },
    scheduledReceipt: {
      schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
      planId: "clean-plan",
      hostId: "codex",
      sessionId: "session-a",
      status: "scheduled",
      selectedTaskIds: ["task-a", "task-b"],
      estimatedSavedTokens: 99,
      estimatedSavedChars: 100,
      tokenCountMode: "exact",
      deferredTaskIds: [],
      reasons: [],
      fallbackUsed: false,
      updatedAt: "2026-08-28T00:00:01.000Z",
    },
  };
}

function epoch(): CodexRebaseEpoch {
  return {
    schema: CODEX_REBASE_EPOCH_SCHEMA,
    epochId: "epoch-a",
    sessionId: "session-a",
    planId: "mutation-plan",
    oldPreviousResponseId: "response-old",
    newResponseId: "response-new",
    oldRevision: "revision-a",
    newRevision: "revision-b",
    status: "committed",
    accounting,
    createdAt: "2026-08-28T00:00:02.000Z",
    updatedAt: "2026-08-28T00:00:03.000Z",
  };
}

test("applied receipt records committed token savings instead of the scheduled estimate", () => {
  const result = buildCodexCleanerAppliedReceipt({ execution: execution(), epoch: epoch() });
  assert.ok(result.receipt);
  assert.equal(result.receipt.appliedSavedTokens, accounting.actuallyRemovedTokens);
  assert.notEqual(result.receipt.appliedSavedTokens, execution().scheduledReceipt.estimatedSavedTokens);
});

test("rewrite evidence rejects duplicated operation or item IDs", () => {
  const prepared = execution();
  const committedEpoch = epoch();
  const request: CodexRebaseRequestResult = {
    payload: {},
    oldRevision: committedEpoch.oldRevision,
    rebaseRevision: committedEpoch.newRevision!,
    accounting,
  };
  const valid: ContextRewriteResult<CodexSharedBackendDetails> = {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    mode: "response_chain_rebase",
    planId: prepared.mutationPlan.planId,
    applied: true,
    changed: true,
    previousRevision: committedEpoch.oldRevision,
    nextRevision: committedEpoch.newRevision!,
    appliedOperationIds: ["operation-a", "operation-b"],
    deferredOperationIds: [],
    removedItemIds: ["item-a", "item-b"],
    savedChars: accounting.actuallyRemovedChars,
    fallbackUsed: false,
    details: { rebasePrepared: true, accounting },
  };

  const duplicateOperation = buildCodexCleanerAppliedReceiptFromRewrite({
    execution: prepared,
    rebaseRequest: request,
    epoch: committedEpoch,
    rewriteResult: { ...valid, appliedOperationIds: ["operation-a", "operation-a"] },
  });
  assert.deepEqual(duplicateOperation.reasons, ["cleaner_receipt_rewrite_evidence_invalid"]);

  const duplicateItem = buildCodexCleanerAppliedReceiptFromRewrite({
    execution: prepared,
    rebaseRequest: request,
    epoch: committedEpoch,
    rewriteResult: { ...valid, removedItemIds: ["item-a", "item-a"] },
  });
  assert.deepEqual(duplicateItem.reasons, ["cleaner_receipt_rewrite_evidence_invalid"]);
});
