import {
  mapTaskUpdatesToRegistryPatch,
  type TaskStateEstimator,
} from "@lightmem2/eviction";
import {
  applySessionTaskRegistryPatch,
  type DeltaView,
  type SessionTaskRegistry,
} from "@lightmem2/history";

export type UpdateRegistryResult = {
  registry: SessionTaskRegistry;
  changed: boolean;
  note?: "base_version_mismatch" | "no_updates" | "estimator_failed";
};

/**
 * Drive one registry update from a DeltaView: ask the estimator for semantic
 * task updates, guard on baseVersion, map the updates to a registry patch via
 * the shared mapper, and apply it. The estimator is injected so tests can use a
 * fake (no live LLM); a real caller passes createApiTaskStateEstimator(...).
 *
 * Fail-open: any estimator error returns the registry unchanged with
 * note="estimator_failed" — it must never throw into the request path. The
 * caller is responsible for persisting the returned registry with
 * expectedVersion and abandoning on a version conflict.
 */
export async function updateRegistryFromDelta(params: {
  registry: SessionTaskRegistry;
  delta: DeltaView;
  estimator: TaskStateEstimator;
}): Promise<UpdateRegistryResult> {
  const { registry, delta, estimator } = params;
  let output;
  try {
    output = await estimator.estimate({ registry, delta });
  } catch {
    return { registry, changed: false, note: "estimator_failed" };
  }

  // baseVersion guard: the estimator reasoned against a specific registry
  // version; if the registry moved on, abandon this update rather than apply
  // stale reasoning.
  if (output.baseVersion !== registry.version) {
    return { registry, changed: false, note: "base_version_mismatch" };
  }
  if (!output.taskUpdates || output.taskUpdates.length === 0) {
    return { registry, changed: false, note: "no_updates" };
  }

  const { patch } = mapTaskUpdatesToRegistryPatch({
    registry,
    updates: output.taskUpdates,
    coveredTurnAbsIds: delta.coveredTurnAbsIds,
    toTurnSeqInclusive: delta.toTurnSeqInclusive,
  });
  const nextRegistry = applySessionTaskRegistryPatch(registry, patch);
  return { registry: nextRegistry, changed: true };
}
