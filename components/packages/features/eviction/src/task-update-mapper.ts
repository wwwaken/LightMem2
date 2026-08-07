import type {
  SessionTaskRegistry,
  SessionTaskRegistryPatch,
  TaskLifecycle,
  TaskState,
} from "@lightmem2/history";
import type { SemanticTaskUpdate, TaskStateTransition } from "./types.js";

export type RejectedTaskUpdate = {
  taskId: string;
  from?: TaskLifecycle;
  to: TaskLifecycle;
  reason: string;
};

export type MapTaskUpdatesResult = {
  patch: SessionTaskRegistryPatch;
  transitions: TaskStateTransition[];
  rejectedUpdates: RejectedTaskUpdate[];
};

function uniqueStrings(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function titleFromTaskId(taskId: string): string {
  return taskId.replace(/[-_]+/g, " ").trim() || taskId;
}

function lifecycleBucketIds(tasks: Record<string, TaskState>, lifecycle: TaskLifecycle): string[] {
  return Object.values(tasks)
    .filter((task) => task.lifecycle === lifecycle)
    .map((task) => task.taskId);
}

function hasCompletionEvidence(task: Pick<TaskState, "completionEvidence"> | undefined): boolean {
  return (task?.completionEvidence?.length ?? 0) > 0;
}

/**
 * Generic mapping from estimator SemanticTaskUpdate[] to a SessionTaskRegistryPatch,
 * shared by TokenPilot and the Claude adapter. It merges each update against the
 * existing task in the registry, enforces the BASE evidence rules (completed and
 * evictable require completion evidence; evictable forbidden while unresolved
 * questions remain), and buckets the resulting tasks by lifecycle.
 *
 * This is the neutral core only. Preset-specific lifecycle policy — coupled vs
 * decoupled normalization, the active→evictable gate, completed→evictable
 * collapse, FIFO promotion — is NOT here; callers apply that around this mapper.
 * baseVersion is not handled here either: the caller checks
 * output.baseVersion === registry.version before applying the patch.
 */
export function mapTaskUpdatesToRegistryPatch(params: {
  registry: SessionTaskRegistry;
  updates: SemanticTaskUpdate[];
  coveredTurnAbsIds: string[];
  toTurnSeqInclusive: number;
}): MapTaskUpdatesResult {
  const { registry, updates, toTurnSeqInclusive } = params;
  const upsertTasks: Record<string, TaskState> = {};
  const upsertTurnToTaskIds: Record<string, string[]> = {};
  const transitions: TaskStateTransition[] = [];
  const rejectedUpdates: RejectedTaskUpdate[] = [];

  for (const update of updates) {
    const taskId = String(update.taskId ?? "").trim();
    const previous = registry.tasks[taskId];
    const objective =
      typeof update.objective === "string" && update.objective.trim().length > 0
        ? update.objective.trim()
        : previous?.objective ?? "";
    const covered = uniqueStrings(update.coveredTurnAbsIds ?? []);
    if (!taskId || !objective) continue;
    if (covered.length === 0 && !previous) continue;

    const supportingTurnAbsIds = uniqueStrings([
      ...(previous?.span.supportingTurnAbsIds ?? []),
      ...covered,
    ]);
    if (supportingTurnAbsIds.length === 0) continue;

    const firstTurnAbsId = previous?.span.firstTurnAbsId ?? supportingTurnAbsIds[0]!;
    const lastTurnAbsId = supportingTurnAbsIds[supportingTurnAbsIds.length - 1]!;
    const mergedCompletionEvidence = uniqueStrings([
      ...(previous?.completionEvidence ?? []),
      ...(update.completionEvidence ?? []),
    ]);
    const mergedUnresolvedQuestions = uniqueStrings(
      update.unresolvedQuestions ?? previous?.unresolvedQuestions ?? [],
    );
    const fromLifecycle = previous?.lifecycle;
    const toLifecycle = update.lifecycle;
    const fromHasCompletionEvidence = hasCompletionEvidence(previous);
    const toHasCompletionEvidence = mergedCompletionEvidence.length > 0;

    // Base evidence rules (preset-neutral).
    if (toLifecycle === "completed" && !toHasCompletionEvidence) {
      rejectedUpdates.push({
        taskId,
        ...(fromLifecycle ? { from: fromLifecycle } : {}),
        to: toLifecycle,
        reason: "completed_requires_completion_evidence",
      });
      continue;
    }
    if (toLifecycle === "evictable") {
      if (!fromHasCompletionEvidence && !toHasCompletionEvidence) {
        rejectedUpdates.push({
          taskId,
          ...(fromLifecycle ? { from: fromLifecycle } : {}),
          to: toLifecycle,
          reason: "evictable_requires_completion_evidence",
        });
        continue;
      }
      if (mergedUnresolvedQuestions.length > 0) {
        rejectedUpdates.push({
          taskId,
          ...(fromLifecycle ? { from: fromLifecycle } : {}),
          to: toLifecycle,
          reason: "evictable_forbidden_with_unresolved_questions",
        });
        continue;
      }
    }

    const task: TaskState = {
      taskId,
      title:
        typeof update.title === "string" && update.title.trim().length > 0
          ? update.title.trim()
          : previous?.title ?? titleFromTaskId(taskId),
      objective,
      lifecycle: update.lifecycle,
      ...(typeof update.currentSubgoal === "string" && update.currentSubgoal.trim().length > 0
        ? { currentSubgoal: update.currentSubgoal.trim() }
        : previous?.currentSubgoal
          ? { currentSubgoal: previous.currentSubgoal }
          : {}),
      ...(typeof update.evictableReason === "string" && update.evictableReason.trim().length > 0
        ? { evictableReason: update.evictableReason.trim() }
        : previous?.evictableReason
          ? { evictableReason: previous.evictableReason }
          : {}),
      completionEvidence: mergedCompletionEvidence,
      unresolvedQuestions: mergedUnresolvedQuestions,
      span: {
        firstTurnAbsId,
        lastTurnAbsId,
        supportingTurnAbsIds,
        lastEstimatorTurnAbsId:
          covered[covered.length - 1] ??
          previous?.span.lastEstimatorTurnAbsId ??
          lastTurnAbsId,
      },
    };
    upsertTasks[taskId] = task;
    for (const turnAbsId of covered) {
      const existing = upsertTurnToTaskIds[turnAbsId] ?? registry.turnToTaskIds[turnAbsId] ?? [];
      upsertTurnToTaskIds[turnAbsId] = uniqueStrings([...existing, taskId]);
    }
    transitions.push({
      taskId,
      ...(previous ? { from: previous.lifecycle } : {}),
      to: update.lifecycle,
      rationale:
        covered.length > 0
          ? `task update applied from covered turns: ${covered.join(", ")}`
          : `lifecycle-only task update applied for ${taskId}`,
    });
  }

  const nextTasks = { ...registry.tasks, ...upsertTasks };
  return {
    patch: {
      upsertTasks,
      upsertTurnToTaskIds,
      activeTaskIds: lifecycleBucketIds(nextTasks, "active"),
      completedTaskIds: lifecycleBucketIds(nextTasks, "completed"),
      evictableTaskIds: lifecycleBucketIds(nextTasks, "evictable"),
      lastProcessedTurnSeq: toTurnSeqInclusive,
    },
    transitions,
    rejectedUpdates,
  };
}
