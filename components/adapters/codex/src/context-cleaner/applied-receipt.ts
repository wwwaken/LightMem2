import type {
  ContextCleanAppliedReceipt,
  ContextCleanPreparedExecution,
} from "@lightrsi/cleaner";
import type { ContextRewriteResult } from "@lightrsi/host-adapter";

import type { CodexSharedBackendDetails } from "../context-rewrite/backend.js";
import type {
  CodexRebaseEpoch,
  CodexRebaseRequestResult,
} from "../context-rewrite/types.js";

export type CodexCleanerAppliedReceiptInput = {
  execution: ContextCleanPreparedExecution;
  epoch: CodexRebaseEpoch;
};

export type CodexCleanerAppliedReceiptBuildResult =
  | { receipt: ContextCleanAppliedReceipt; reasons: [] }
  | { receipt?: undefined; reasons: string[] };

function uniqueNonBlankStrings(values: readonly string[]): boolean {
  return values.length > 0
    && values.every((value) => value.trim().length > 0)
    && new Set(values).size === values.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value) => right.includes(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function appliedTokenSavings(
  execution: ContextCleanPreparedExecution,
): number | null | undefined {
  if (execution.scheduledReceipt.tokenCountMode === "chars_only") return null;
  const savedTokens = execution.scheduledReceipt.estimatedSavedTokens;
  return savedTokens !== null && nonNegativeInteger(savedTokens)
    ? savedTokens
    : undefined;
}

/**
 * Builds an applied receipt only from the frozen Cleaner execution and the
 * durable successful rebase epoch. This is also safe to use after a crash,
 * because the plan id commits the exact operation and item scope.
 */
export function buildCodexCleanerAppliedReceipt(
  params: CodexCleanerAppliedReceiptInput,
): CodexCleanerAppliedReceiptBuildResult {
  const { execution, epoch } = params;
  const operationIds = execution.mutationPlan.operations.map((operation) => operation.id);
  const itemIds = execution.mutationPlan.operations.flatMap(
    (operation) => operation.targetItemIds,
  );
  if (execution.scheduledReceipt.status !== "scheduled"
    || execution.mutationPlan.sourceModuleId !== "cleaner_manual"
    || execution.cleanPlanId !== execution.scheduledReceipt.planId
    || execution.hostId !== "codex"
    || execution.sessionId !== execution.scheduledReceipt.sessionId
    || execution.baseRevision !== execution.mutationPlan.baseRevision
    || !uniqueNonBlankStrings(operationIds)
    || !uniqueNonBlankStrings(itemIds)) {
    return { reasons: ["cleaner_receipt_execution_invalid"] };
  }
  if (epoch.status !== "committed"
    || epoch.sessionId !== execution.sessionId
    || epoch.planId !== execution.mutationPlan.planId
    || epoch.oldRevision !== execution.baseRevision
    || !epoch.newResponseId?.trim()
    || !epoch.newRevision?.trim()
    || !epoch.accounting
    || !validTimestamp(epoch.updatedAt)
    || !nonNegativeInteger(epoch.accounting.actuallyRemovedChars)
    || !nonNegativeInteger(epoch.accounting.actuallyRemovedTokens)
    || epoch.accounting.fallbackExtraRequestCount !== 0) {
    return { reasons: ["cleaner_receipt_epoch_invalid"] };
  }
  const appliedSavedTokens = appliedTokenSavings(execution);
  if (appliedSavedTokens === undefined) {
    return { reasons: ["cleaner_receipt_token_accounting_invalid"] };
  }
  return {
    receipt: {
      ...execution.scheduledReceipt,
      status: "applied",
      deferredTaskIds: [],
      fallbackUsed: false,
      reasons: [],
      updatedAt: epoch.updatedAt,
      appliedSavedTokens,
      appliedSavedChars: epoch.accounting.actuallyRemovedChars,
      evidence: {
        previousRevision: epoch.oldRevision,
        nextRevision: epoch.newRevision,
        operationIds,
        itemIds,
        eventIds: [`codex-rebase-epoch:${epoch.epochId}`],
        providerResponseId: epoch.newResponseId,
      },
    },
    reasons: [],
  };
}

/** Validates that a just-prepared rewrite fully matches the committed epoch. */
export function buildCodexCleanerAppliedReceiptFromRewrite(params: {
  execution: ContextCleanPreparedExecution;
  rewriteResult: ContextRewriteResult<CodexSharedBackendDetails>;
  rebaseRequest: CodexRebaseRequestResult;
  epoch: CodexRebaseEpoch;
}): CodexCleanerAppliedReceiptBuildResult {
  const base = buildCodexCleanerAppliedReceipt(params);
  if (!base.receipt) return base;

  const operationIds = params.execution.mutationPlan.operations.map((operation) => operation.id);
  const itemIds = params.execution.mutationPlan.operations.flatMap(
    (operation) => operation.targetItemIds,
  );
  const { rewriteResult, rebaseRequest, epoch } = params;
  const accountingMatches = JSON.stringify(rebaseRequest.accounting)
    === JSON.stringify(epoch.accounting);
  if (!rewriteResult.applied
    || !rewriteResult.changed
    || rewriteResult.fallbackUsed
    || rewriteResult.details?.rebasePrepared !== true
    || rewriteResult.planId !== params.execution.mutationPlan.planId
    || rewriteResult.previousRevision !== rebaseRequest.oldRevision
    || rewriteResult.nextRevision !== rebaseRequest.rebaseRevision
    || rewriteResult.previousRevision !== epoch.oldRevision
    || rewriteResult.nextRevision !== epoch.newRevision
    || rewriteResult.deferredOperationIds.length !== 0
    || !sameStringSet(rewriteResult.appliedOperationIds, operationIds)
    || !sameStringSet(rewriteResult.removedItemIds, itemIds)
    || rewriteResult.savedChars !== epoch.accounting?.actuallyRemovedChars
    || JSON.stringify(rewriteResult.details.accounting) !== JSON.stringify(rebaseRequest.accounting)
    || !accountingMatches) {
    return { reasons: ["cleaner_receipt_rewrite_evidence_invalid"] };
  }
  return base;
}
