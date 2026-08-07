import type {
  ContextMutationOperation,
  ContextMutationPlan,
  ContextRewriteValidation,
  ModelContextSnapshot,
} from "./contracts.js";

export type ContextProtocolClosureValidationParams<
  TAdapterMetadata = never,
  TAdapterReplacementItem = never,
> = {
  snapshot: ModelContextSnapshot<TAdapterMetadata>;
  plan: ContextMutationPlan<TAdapterReplacementItem>;
  activeTaskIds: readonly string[];
  evictableTaskIds: readonly string[];
  /** Restricts validation when structural revalidation already deferred operations. */
  candidateOperationIds?: readonly string[];
};

type ProtocolGroup = {
  callItemIds: string[];
  resultItemIds: string[];
  callTaskIds: string[][];
  resultTaskIds: string[][];
  taskIds: Set<string>;
};

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim()),
  )];
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

function operationIds<TAdapterReplacementItem>(
  plan: ContextMutationPlan<TAdapterReplacementItem>,
): string[] {
  return [...new Set(plan.operations.map((operation) => operation.id))];
}

/**
 * Validates protocol closure using adapter-normalized context items. Anthropic
 * tool_use/tool_result and Responses function/custom calls all map to the
 * shared tool_call/tool_result kinds before reaching this boundary.
 */
export function validateContextMutationProtocolClosure<
  TAdapterMetadata = never,
  TAdapterReplacementItem = never,
>(
  params: ContextProtocolClosureValidationParams<
    TAdapterMetadata,
    TAdapterReplacementItem
  >,
): ContextRewriteValidation {
  const { snapshot, plan } = params;
  const candidates = new Set(
    params.candidateOperationIds ?? operationIds(plan),
  );
  const activeTaskIds = new Set(uniqueNonEmpty(params.activeTaskIds));
  const evictableTaskIds = new Set(uniqueNonEmpty(params.evictableTaskIds));
  const itemsByStableId = new Map<string, typeof snapshot.items>();
  for (const item of snapshot.items) {
    itemsByStableId.set(item.stableId, [
      ...(itemsByStableId.get(item.stableId) ?? []),
      item,
    ]);
  }
  const protocolGroups = new Map<string, ProtocolGroup>();
  const protocolItemsWithoutCallId = new Set<string>();
  const protocolTasksWithoutCallId = new Set<string>();

  for (const item of snapshot.items) {
    if (item.kind !== "tool_call" && item.kind !== "tool_result") continue;
    const callId = typeof item.callId === "string" ? item.callId.trim() : "";
    if (!callId) {
      protocolItemsWithoutCallId.add(item.stableId);
      for (const taskId of uniqueNonEmpty(item.taskIds)) {
        protocolTasksWithoutCallId.add(taskId);
      }
      continue;
    }
    const group = protocolGroups.get(callId) ?? {
      callItemIds: [],
      resultItemIds: [],
      callTaskIds: [],
      resultTaskIds: [],
      taskIds: new Set<string>(),
    };
    const taskIds = uniqueNonEmpty(item.taskIds);
    if (item.kind === "tool_call") {
      group.callItemIds.push(item.stableId);
      group.callTaskIds.push(taskIds);
    } else {
      group.resultItemIds.push(item.stableId);
      group.resultTaskIds.push(taskIds);
    }
    for (const taskId of taskIds) group.taskIds.add(taskId);
    protocolGroups.set(callId, group);
  }

  const applicableOperationIds: string[] = [];
  const deferredOperationIds: string[] = [];
  const reasons: string[] = [];
  const operationIdCounts = new Map<string, number>();
  for (const operation of plan.operations) {
    operationIdCounts.set(
      operation.id,
      (operationIdCounts.get(operation.id) ?? 0) + 1,
    );
  }
  const malformedCandidateIds = new Set<string>();
  for (const candidateId of candidates) {
    const operationCount = operationIdCounts.get(candidateId) ?? 0;
    if (operationCount !== 1) {
      malformedCandidateIds.add(candidateId);
      deferredOperationIds.push(candidateId);
      reasons.push(operationCount === 0
        ? `candidate:${candidateId || "<empty>"}:missing`
        : `operation:${candidateId || "<empty>"}:duplicate_id`);
    }
  }

  for (const operation of plan.operations) {
    if (!candidates.has(operation.id)
      || applicableOperationIds.includes(operation.id)
      || malformedCandidateIds.has(operation.id)
      || deferredOperationIds.includes(operation.id)) {
      continue;
    }

    if (operationIdCounts.get(operation.id) !== 1) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "duplicate_id"));
      continue;
    }
    if (operation.targetItemIds.length === 0) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "targets_empty"));
      continue;
    }
    if (new Set(operation.targetItemIds).size !== operation.targetItemIds.length) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "targets_duplicate"));
      continue;
    }

    const targetItemIds = new Set(operation.targetItemIds);
    if ([...targetItemIds].some((targetItemId) => !itemsByStableId.has(targetItemId))) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "target_missing"));
      continue;
    }
    if ([...targetItemIds].some(
      (targetItemId) => itemsByStableId.get(targetItemId)!.length !== 1,
    )) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, "target_ambiguous"));
      continue;
    }

    const operationTaskIds = new Set(uniqueNonEmpty(operation.taskIds));
    for (const targetItemId of targetItemIds) {
      for (const taskId of uniqueNonEmpty(
        itemsByStableId.get(targetItemId)![0]!.taskIds,
      )) {
        operationTaskIds.add(taskId);
      }
    }

    let reason: string | undefined;
    const crossesActiveAndEvictableTasks = [...operationTaskIds].some(
      (taskId) => activeTaskIds.has(taskId),
    ) && [...operationTaskIds].some(
      (taskId) => evictableTaskIds.has(taskId),
    );
    if (crossesActiveAndEvictableTasks) {
      reason = "active_evictable_task_overlap";
    } else if ([...operationTaskIds].some((taskId) => activeTaskIds.has(taskId))) {
      reason = "active_task_targeted";
    }

    const targetsProtocolItemWithoutCallId = [...targetItemIds].some(
      (targetItemId) => protocolItemsWithoutCallId.has(targetItemId),
    );
    if (!reason && targetsProtocolItemWithoutCallId) {
      reason = "protocol_call_id_missing";
    }
    if (!reason && [...operationTaskIds].some(
      (taskId) => protocolTasksWithoutCallId.has(taskId),
    )) {
      reason = "unresolved_protocol_call";
    }

    for (const group of protocolGroups.values()) {
      if (reason) break;
      const groupItemIds = [...group.callItemIds, ...group.resultItemIds];
      const targetsGroup = groupItemIds.some((itemId) => targetItemIds.has(itemId));
      const operationOwnsUnresolvedTask = [...group.taskIds].some(
        (taskId) => operationTaskIds.has(taskId),
      );
      const groupIsComplete = group.callItemIds.length === 1
        && group.resultItemIds.length === 1;
      const callTaskIds = group.callTaskIds[0] ?? [];
      const resultTaskIds = group.resultTaskIds[0] ?? [];
      const protocolTasksMatch = groupIsComplete
        && callTaskIds.length === resultTaskIds.length
        && callTaskIds.every((taskId) => resultTaskIds.includes(taskId));

      if (groupIsComplete && !protocolTasksMatch
        && (targetsGroup || operationOwnsUnresolvedTask)) {
        reason = "protocol_task_mismatch";
        break;
      }
      if (!groupIsComplete && (targetsGroup || operationOwnsUnresolvedTask)) {
        reason = "unresolved_protocol_call";
        break;
      }
      if (groupIsComplete && targetsGroup
        && groupItemIds.some((itemId) => !targetItemIds.has(itemId))) {
        reason = "protocol_pair_partial";
      }
    }

    if (reason) {
      deferredOperationIds.push(operation.id);
      reasons.push(operationReason(operation, reason));
    } else {
      applicableOperationIds.push(operation.id);
    }
  }

  return {
    valid: true,
    applicableOperationIds,
    deferredOperationIds,
    reasons,
  };
}
