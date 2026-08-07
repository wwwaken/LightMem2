import { createHash } from "node:crypto";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextMutationOperation,
  type ContextMutationPlan,
  type ModelContextSnapshot,
} from "@lightmem2/host-adapter";
import type { SessionTaskRegistry } from "@lightmem2/history";

import type { EvictionBlock, EvictionDecision, EvictionInstruction } from "./types.js";

const EVICTION_PLAN_ID_VERSION = 1 as const;

export type EvictionContextMutationPlanParams<TAdapterMetadata = never> = {
  decision: EvictionDecision;
  registry: SessionTaskRegistry;
  snapshot: ModelContextSnapshot<TAdapterMetadata>;
  /** Maps history message/segment IDs to their normalized context stable IDs. */
  stableItemIdsByMessageId?: Readonly<Record<string, readonly string[]>>;
  createdAt: string;
  sourcePresetId?: string;
};

export type EvictionContextMutationPlanResult = {
  plan?: ContextMutationPlan;
  deferredBlockIds: string[];
  reasons: string[];
};

function uniqueNonEmptyStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function digestId(prefix: string, value: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  return `${prefix}-v${EVICTION_PLAN_ID_VERSION}-${digest}`;
}

function instructionTaskIds(
  instruction: EvictionInstruction,
  block: EvictionBlock,
  registry: SessionTaskRegistry,
): string[] {
  const direct = Array.isArray(instruction.parameters?.taskIds)
    ? uniqueNonEmptyStrings(instruction.parameters.taskIds)
    : [];
  if (direct.length > 0) return direct;

  return uniqueNonEmptyStrings([
    ...(registry.blockToTaskIds[block.id] ?? []),
    ...block.messageIds.flatMap(
      (messageId) => registry.blockToTaskIds[messageId] ?? [],
    ),
  ]);
}

function resolveTargetItemIds(
  block: EvictionBlock,
  stableItemIdsByMessageId: Readonly<Record<string, readonly string[]>> | undefined,
  itemsByStableId: ReadonlyMap<string, { fingerprint: string }>,
): string[] | undefined {
  const targetItemIds: string[] = [];
  for (const messageId of uniqueNonEmptyStrings(block.messageIds)) {
    const mappedIds = stableItemIdsByMessageId?.[messageId];
    const candidates = mappedIds === undefined
      ? [messageId]
      : uniqueNonEmptyStrings(mappedIds);
    if (
      candidates.length === 0
      || candidates.some((stableId) => !itemsByStableId.has(stableId))
    ) {
      return undefined;
    }
    targetItemIds.push(...candidates);
  }
  const uniqueTargetItemIds = uniqueNonEmptyStrings(targetItemIds);
  return uniqueTargetItemIds.length > 0 ? uniqueTargetItemIds : undefined;
}

function operationForInstruction(params: {
  instruction: EvictionInstruction;
  block: EvictionBlock;
  taskIds: string[];
  targetItemIds: string[];
  snapshot: ModelContextSnapshot<unknown>;
}): ContextMutationOperation {
  const targetItemFingerprints = Object.fromEntries(
    params.targetItemIds.map((stableId) => [
      stableId,
      params.snapshot.items.find((item) => item.stableId === stableId)!.fingerprint,
    ]),
  );
  const rationale = params.instruction.rationale.trim();
  const id = digestId("ctxop", {
    baseRevision: params.snapshot.revision,
    blockId: params.block.id,
    estimatedSavedChars: params.instruction.estimatedSavedChars,
    rationale,
    sessionId: params.snapshot.sessionId,
    targetItemFingerprints,
    targetItemIds: params.targetItemIds,
    taskIds: params.taskIds,
  });
  return {
    id,
    type: "remove",
    targetItemIds: params.targetItemIds,
    targetItemFingerprints,
    taskIds: params.taskIds,
    rationale,
    estimatedSavedChars: params.instruction.estimatedSavedChars,
  };
}

export function buildContextMutationPlanFromEviction<
  TAdapterMetadata = never,
>(
  params: EvictionContextMutationPlanParams<TAdapterMetadata>,
): EvictionContextMutationPlanResult {
  if (!params.decision.enabled) {
    return { deferredBlockIds: [], reasons: ["eviction_disabled"] };
  }
  if (params.decision.instructions.length === 0) {
    return { deferredBlockIds: [], reasons: ["no_eviction_instructions"] };
  }

  const itemsByStableId = new Map(
    params.snapshot.items.map((item) => [item.stableId, item]),
  );
  const blocksById = new Map<string, EvictionBlock[]>();
  for (const block of params.decision.blocks) {
    const normalizedId = block.id.trim();
    if (!normalizedId) continue;
    blocksById.set(normalizedId, [
      ...(blocksById.get(normalizedId) ?? []),
      block,
    ]);
  }

  const evictableTaskIds = new Set(
    uniqueNonEmptyStrings(params.registry.evictableTaskIds),
  );
  const claimedTargetItemIds = new Set<string>();
  const deferredBlockIds: string[] = [];
  const reasons: string[] = [];
  const operations: ContextMutationOperation[] = [];

  const defer = (blockId: string, reason: string): void => {
    if (!deferredBlockIds.includes(blockId)) deferredBlockIds.push(blockId);
    reasons.push(`block:${blockId || "<empty>"}:${reason}`);
  };

  for (const instruction of params.decision.instructions) {
    const blockId = instruction.blockId.trim();
    const matchingBlocks = blocksById.get(blockId) ?? [];
    if (matchingBlocks.length !== 1) {
      defer(blockId, matchingBlocks.length === 0 ? "missing" : "ambiguous");
      continue;
    }
    const block = matchingBlocks[0]!;
    const taskIds = instructionTaskIds(instruction, block, params.registry);
    if (taskIds.length === 0) {
      defer(blockId, "task_ids_missing");
      continue;
    }
    if (!taskIds.some((taskId) => evictableTaskIds.has(taskId))) {
      defer(blockId, "task_not_evictable");
      continue;
    }

    const targetItemIds = resolveTargetItemIds(
      block,
      params.stableItemIdsByMessageId,
      itemsByStableId,
    );
    if (!targetItemIds) {
      defer(blockId, "target_unresolved");
      continue;
    }
    if (targetItemIds.some((stableId) => claimedTargetItemIds.has(stableId))) {
      defer(blockId, "target_overlap");
      continue;
    }

    const operation = operationForInstruction({
      instruction,
      block,
      taskIds,
      targetItemIds,
      snapshot: params.snapshot,
    });
    operations.push(operation);
    for (const stableId of targetItemIds) claimedTargetItemIds.add(stableId);
  }

  if (operations.length === 0) {
    return { deferredBlockIds, reasons };
  }

  const createdAt = params.createdAt.trim();
  if (!createdAt) throw new TypeError("createdAt must not be empty");
  const planId = digestId("ctxplan", {
    baseRevision: params.snapshot.revision,
    hostId: params.snapshot.hostId,
    operationIds: operations.map((operation) => operation.id),
    sessionId: params.snapshot.sessionId,
    sourceModuleId: "eviction",
    sourcePresetId: params.sourcePresetId?.trim() || null,
  });
  return {
    plan: {
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      planId,
      hostId: params.snapshot.hostId,
      sessionId: params.snapshot.sessionId,
      baseRevision: params.snapshot.revision,
      sourceModuleId: "eviction",
      ...(params.sourcePresetId?.trim()
        ? { sourcePresetId: params.sourcePresetId.trim() }
        : {}),
      operations,
      createdAt,
    },
    deferredBlockIds,
    reasons,
  };
}

// One evicted block, described independently of any host adapter. The caller
// (a host adapter) resolves each segment to a concrete message/block location
// and passes it in, so this module stays in the features layer and never
// depends on an adapter package.
export type EvictionPlanSelection = {
  segmentIds: string[];
  chars: number;
  rationale?: string;
};

export type SegmentLocation = {
  messageIndex: number;
  blockIndex: number;
};

function overlayStableId(sessionId: string, loc: SegmentLocation): string {
  return `${sessionId}:${loc.messageIndex}:${loc.blockIndex}`;
}

function planId(sessionId: string, revision: string, operationIds: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({
      operationIds: [...operationIds].sort(),
      revision,
      sessionId,
    }))
    .digest("hex")
    .slice(0, 24);
}

// Turn signal-driven eviction selections into a shared ContextMutationPlan the
// overlay backend can validate and apply. Each selection becomes one replace
// operation whose targets are the overlay stable ids, carrying the snapshot
// fingerprints so the backend can prove the targets survived revision drift.
export function buildContextMutationPlan(params: {
  hostId: string;
  sessionId: string;
  snapshot: ModelContextSnapshot;
  selections: EvictionPlanSelection[];
  segmentLocations: Map<string, SegmentLocation>;
  sourceModuleId?: string;
  createdAt?: string;
}): ContextMutationPlan {
  if (params.snapshot.schemaVersion !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
    || !params.hostId.trim()
    || !params.sessionId.trim()
    || !params.snapshot.hostId.trim()
    || !params.snapshot.sessionId.trim()
    || params.snapshot.hostId !== params.hostId
    || params.snapshot.sessionId !== params.sessionId
    || !params.snapshot.revision.trim()) {
    throw new TypeError("context mutation plan requires a matching non-empty snapshot identity");
  }
  if (new Set(params.snapshot.items.map((item) => item.stableId)).size !== params.snapshot.items.length) {
    throw new TypeError("context mutation plan requires unique snapshot item ids");
  }

  const fingerprintById = new Map(
    params.snapshot.items.map((item) => [item.stableId, item.fingerprint]),
  );

  const operations: ContextMutationOperation[] = [];
  const claimedTargetItemIds = new Set<string>();
  params.selections.forEach((selection) => {
    const targetItemIds: string[] = [];

    for (const segmentId of uniqueNonEmptyStrings(selection.segmentIds)) {
      const loc = params.segmentLocations.get(segmentId);
      if (!loc) continue;
      if (!Number.isInteger(loc.messageIndex) || loc.messageIndex < 0
        || !Number.isInteger(loc.blockIndex) || loc.blockIndex < 0) continue;
      const stableId = overlayStableId(params.sessionId, loc);
      const fingerprint = fingerprintById.get(stableId);
      // Only target items that actually exist in the snapshot.
      if (fingerprint === undefined) continue;
      if (claimedTargetItemIds.has(stableId)) continue;
      targetItemIds.push(stableId);
      claimedTargetItemIds.add(stableId);
    }

    if (targetItemIds.length === 0) return;

    const targetItemFingerprints = Object.fromEntries(
      targetItemIds.map((stableId) => [stableId, fingerprintById.get(stableId)!]),
    );
    const estimatedSavedChars = typeof selection.chars === "number"
      && Number.isFinite(selection.chars)
      && selection.chars >= 0
      ? selection.chars
      : 0;
    const rationale = typeof selection.rationale === "string" && selection.rationale.trim()
      ? selection.rationale.trim()
      : "signal-driven eviction";

    operations.push({
      id: digestId("ctxop", {
        baseRevision: params.snapshot.revision,
        rationale,
        sessionId: params.sessionId,
        targetItemFingerprints,
        targetItemIds,
      }),
      type: "replace",
      targetItemIds,
      targetItemFingerprints,
      rationale,
      estimatedSavedChars,
    });
  });

  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId: planId(
      params.sessionId,
      params.snapshot.revision,
      operations.map((operation) => operation.id),
    ),
    hostId: params.hostId,
    sessionId: params.sessionId,
    baseRevision: params.snapshot.revision,
    sourceModuleId: params.sourceModuleId ?? "eviction",
    operations,
    createdAt: params.createdAt ?? new Date(0).toISOString(),
  };
}
