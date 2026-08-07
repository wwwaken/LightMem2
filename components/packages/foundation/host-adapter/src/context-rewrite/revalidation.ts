import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextMutationOperation,
  type ContextMutationPlan,
  type ContextRewriteValidation,
  type ModelContextSnapshot,
} from "./contracts.js";

export type ContextMutationRevalidationParams<
  TAdapterMetadata = never,
  TAdapterReplacementItem = never,
> = {
  snapshot: ModelContextSnapshot<TAdapterMetadata>;
  plan: ContextMutationPlan<TAdapterReplacementItem>;
};

function uniqueOperationIds<TAdapterReplacementItem>(
  plan: ContextMutationPlan<TAdapterReplacementItem>,
): string[] {
  return [...new Set(plan.operations.map((operation) => operation.id))];
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || !value.trim();
}

function operationReason(
  operation: ContextMutationOperation<unknown>,
  reason: string,
): string {
  const operationId = typeof operation.id === "string"
    ? operation.id.trim()
    : "";
  return `operation:${operationId || "<empty>"}:${reason}`;
}

function targetFingerprintsMatch(
  operation: ContextMutationOperation<unknown>,
  currentItems: Map<string, { fingerprint: string }>,
): "missing" | "scope_mismatch" | "changed" | "matched" {
  const fingerprints = operation.targetItemFingerprints;
  if (!fingerprints) return "missing";

  const expectedIds = Object.keys(fingerprints);
  const targetIds = new Set(operation.targetItemIds);
  if (
    expectedIds.length !== targetIds.size
    || expectedIds.some((targetId) => !targetIds.has(targetId))
  ) {
    return "scope_mismatch";
  }

  for (const targetId of targetIds) {
    const expected = fingerprints[targetId];
    if (typeof expected !== "string" || !expected.trim()) return "missing";
    if (currentItems.get(targetId)?.fingerprint !== expected.trim()) {
      return "changed";
    }
  }
  return "matched";
}

/**
 * Performs shared structural revalidation against the current snapshot. Host
 * backends must still validate task ownership, protocol closure, and mutation
 * semantics before applying an operation.
 */
export function revalidateContextMutationPlan<
  TAdapterMetadata = never,
  TAdapterReplacementItem = never,
>(
  params: ContextMutationRevalidationParams<
    TAdapterMetadata,
    TAdapterReplacementItem
  >,
): ContextRewriteValidation {
  const { snapshot, plan } = params;
  const reasons: string[] = [];
  const operationIds = uniqueOperationIds(plan);

  if (isBlank(plan.planId)) reasons.push("plan_id_empty");
  if (isBlank(plan.hostId)) reasons.push("plan_host_id_empty");
  if (isBlank(snapshot.hostId)) reasons.push("snapshot_host_id_empty");
  if (isBlank(plan.sessionId)) reasons.push("plan_session_id_empty");
  if (isBlank(snapshot.sessionId)) reasons.push("snapshot_session_id_empty");
  if (isBlank(plan.baseRevision)) reasons.push("plan_base_revision_empty");
  if (isBlank(snapshot.revision)) reasons.push("snapshot_revision_empty");
  if (
    plan.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
  ) {
    reasons.push("plan_schema_version_mismatch");
  }
  if (
    snapshot.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
  ) {
    reasons.push("snapshot_schema_version_mismatch");
  }
  if (plan.hostId !== snapshot.hostId) reasons.push("host_id_mismatch");
  if (plan.sessionId !== snapshot.sessionId) reasons.push("session_id_mismatch");
  const revisionMismatch = plan.baseRevision !== snapshot.revision;
  if (revisionMismatch) reasons.push("revision_mismatch");

  const fatalReasons = new Set([
    "plan_id_empty",
    "plan_host_id_empty",
    "snapshot_host_id_empty",
    "plan_session_id_empty",
    "snapshot_session_id_empty",
    "plan_base_revision_empty",
    "snapshot_revision_empty",
    "plan_schema_version_mismatch",
    "snapshot_schema_version_mismatch",
    "host_id_mismatch",
    "session_id_mismatch",
  ]);
  if (reasons.some((reason) => fatalReasons.has(reason))) {
    return {
      valid: false,
      applicableOperationIds: [],
      deferredOperationIds: operationIds,
      reasons,
    };
  }

  const itemsByStableId = new Map<
    string,
    Array<{ fingerprint: string }>
  >();
  for (const item of snapshot.items) {
    itemsByStableId.set(item.stableId, [
      ...(itemsByStableId.get(item.stableId) ?? []),
      { fingerprint: item.fingerprint },
    ]);
  }

  const operationIdCounts = new Map<string, number>();
  for (const operation of plan.operations) {
    operationIdCounts.set(
      operation.id,
      (operationIdCounts.get(operation.id) ?? 0) + 1,
    );
  }

  const applicableOperationIds: string[] = [];
  const deferredOperationIds: string[] = [];
  for (const operation of plan.operations) {
    if (applicableOperationIds.includes(operation.id)
      || deferredOperationIds.includes(operation.id)) {
      continue;
    }
    if (typeof operation.id !== "string" || !operation.id.trim()) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "id_empty"));
      continue;
    }
    if ((operationIdCounts.get(operation.id) ?? 0) > 1) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "duplicate_id"));
      continue;
    }
    if (
      operation.targetItemIds.length === 0
      || operation.targetItemIds.some(
        (targetItemId) =>
          typeof targetItemId !== "string" || !targetItemId.trim(),
      )
    ) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "targets_empty"));
      continue;
    }
    if (new Set(operation.targetItemIds).size !== operation.targetItemIds.length) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "targets_duplicate"));
      continue;
    }

    const targetCounts = operation.targetItemIds.map(
      (targetItemId) => itemsByStableId.get(targetItemId)?.length ?? 0,
    );
    if (targetCounts.some((count) => count === 0)) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "target_missing"));
      continue;
    }
    if (targetCounts.some((count) => count > 1)) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "target_ambiguous"));
      continue;
    }
    if (revisionMismatch || operation.targetItemFingerprints !== undefined) {
      const currentItems = new Map(
        operation.targetItemIds.map((targetItemId) => [
          targetItemId,
          itemsByStableId.get(targetItemId)![0]!,
        ]),
      );
      const fingerprintMatch = targetFingerprintsMatch(
        operation,
        currentItems,
      );
      if (fingerprintMatch !== "matched") {
        deferredOperationIds.push(operation.id);
        reasons.push(operationReason(
          operation,
          fingerprintMatch === "missing"
            ? "target_fingerprint_missing"
            : fingerprintMatch === "scope_mismatch"
              ? "target_fingerprint_scope_mismatch"
              : "target_changed",
        ));
        continue;
      }
    }
    if (
      operation.targetItemIds.some(
        (targetItemId) => !itemsByStableId.get(targetItemId)?.[0]?.fingerprint,
      )
    ) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "target_fingerprint_invalid"));
      continue;
    }
    applicableOperationIds.push(operation.id);
  }

  return {
    valid: true,
    applicableOperationIds,
    deferredOperationIds,
    reasons,
  };
}
