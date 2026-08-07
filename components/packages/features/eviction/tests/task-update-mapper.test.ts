import assert from "node:assert/strict";
import test from "node:test";
import { createEmptySessionTaskRegistry } from "@lightmem2/history";
import { mapTaskUpdatesToRegistryPatch } from "../src/task-update-mapper.js";

const SESSION = "sess-mapper";

function emptyRegistry() {
  return createEmptySessionTaskRegistry(SESSION);
}

test("first-create: an active task update produces an upsert + active bucket", () => {
  const { patch, transitions, rejectedUpdates } = mapTaskUpdatesToRegistryPatch({
    registry: emptyRegistry(),
    updates: [
      {
        taskId: "task-a",
        title: "Task A",
        objective: "do the thing",
        lifecycle: "active",
        coveredTurnAbsIds: [`${SESSION}:t1`],
      } as any,
    ],
    coveredTurnAbsIds: [`${SESSION}:t1`],
    toTurnSeqInclusive: 1,
  });
  assert.equal(rejectedUpdates.length, 0);
  assert.ok(patch.upsertTasks?.["task-a"]);
  assert.equal(patch.upsertTasks!["task-a"]!.lifecycle, "active");
  assert.deepEqual(patch.activeTaskIds, ["task-a"]);
  assert.equal(patch.lastProcessedTurnSeq, 1);
  assert.equal(transitions.length, 1);
});

test("state-update: merges span + evidence with an existing task", () => {
  const registry = emptyRegistry();
  registry.tasks["task-a"] = {
    taskId: "task-a",
    title: "Task A",
    objective: "do the thing",
    lifecycle: "active",
    completionEvidence: [],
    unresolvedQuestions: [],
    span: {
      firstTurnAbsId: `${SESSION}:t1`,
      lastTurnAbsId: `${SESSION}:t1`,
      supportingTurnAbsIds: [`${SESSION}:t1`],
      lastEstimatorTurnAbsId: `${SESSION}:t1`,
    },
  } as any;
  const { patch } = mapTaskUpdatesToRegistryPatch({
    registry,
    updates: [
      { taskId: "task-a", objective: "do the thing", lifecycle: "active", coveredTurnAbsIds: [`${SESSION}:t2`] } as any,
    ],
    coveredTurnAbsIds: [`${SESSION}:t2`],
    toTurnSeqInclusive: 2,
  });
  const task = patch.upsertTasks!["task-a"]!;
  assert.deepEqual(task.span.supportingTurnAbsIds, [`${SESSION}:t1`, `${SESSION}:t2`]);
  assert.equal(task.span.firstTurnAbsId, `${SESSION}:t1`);
  assert.equal(task.span.lastTurnAbsId, `${SESSION}:t2`);
});

test("missing-completion-evidence: completed without evidence is rejected", () => {
  const { patch, rejectedUpdates } = mapTaskUpdatesToRegistryPatch({
    registry: emptyRegistry(),
    updates: [
      { taskId: "task-b", objective: "x", lifecycle: "completed", coveredTurnAbsIds: [`${SESSION}:t1`] } as any,
    ],
    coveredTurnAbsIds: [`${SESSION}:t1`],
    toTurnSeqInclusive: 1,
  });
  assert.equal(rejectedUpdates.length, 1);
  assert.equal(rejectedUpdates[0]!.reason, "completed_requires_completion_evidence");
  assert.equal(patch.upsertTasks?.["task-b"], undefined);
});

test("completed with evidence is accepted and bucketed as completed", () => {
  const { patch, rejectedUpdates } = mapTaskUpdatesToRegistryPatch({
    registry: emptyRegistry(),
    updates: [
      {
        taskId: "task-c", objective: "x", lifecycle: "completed",
        completionEvidence: ["did it in turn 1"],
        coveredTurnAbsIds: [`${SESSION}:t1`],
      } as any,
    ],
    coveredTurnAbsIds: [`${SESSION}:t1`],
    toTurnSeqInclusive: 1,
  });
  assert.equal(rejectedUpdates.length, 0);
  assert.deepEqual(patch.completedTaskIds, ["task-c"]);
});

test("unresolved-task: evictable with unresolved questions is rejected", () => {
  const { rejectedUpdates } = mapTaskUpdatesToRegistryPatch({
    registry: emptyRegistry(),
    updates: [
      {
        taskId: "task-d", objective: "x", lifecycle: "evictable",
        completionEvidence: ["done"],
        unresolvedQuestions: ["but what about X?"],
        coveredTurnAbsIds: [`${SESSION}:t1`],
      } as any,
    ],
    coveredTurnAbsIds: [`${SESSION}:t1`],
    toTurnSeqInclusive: 1,
  });
  assert.equal(rejectedUpdates.length, 1);
  assert.equal(rejectedUpdates[0]!.reason, "evictable_forbidden_with_unresolved_questions");
});

test("version-conflict: caller checks baseVersion (mapper does not) — mapper stays pure", () => {
  // The mapper never reads/writes version; the caller compares
  // output.baseVersion === registry.version. Here we just assert the mapper
  // ignores version entirely and always produces a patch.
  const registry = emptyRegistry();
  registry.version = 5;
  const { patch } = mapTaskUpdatesToRegistryPatch({
    registry,
    updates: [
      { taskId: "task-e", objective: "x", lifecycle: "active", coveredTurnAbsIds: [`${SESSION}:t1`] } as any,
    ],
    coveredTurnAbsIds: [`${SESSION}:t1`],
    toTurnSeqInclusive: 1,
  });
  assert.ok(patch.upsertTasks?.["task-e"]);
  assert.equal((patch as any).baseVersion, undefined); // baseVersion not in patch
});
