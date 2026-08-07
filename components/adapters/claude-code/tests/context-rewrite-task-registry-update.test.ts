import assert from "node:assert/strict";
import test from "node:test";
import { createEmptySessionTaskRegistry } from "@lightmem2/history";
import type { DeltaView } from "@lightmem2/history";
import type { TaskStateEstimator } from "@lightmem2/eviction";
import { updateRegistryFromDelta } from "../src/context-rewrite/task-registry-update.js";

const SESSION = "sess-reg-update";

function delta(): DeltaView {
  return {
    fromTurnSeqExclusive: 0,
    toTurnSeqInclusive: 1,
    coveredTurnAbsIds: [`${SESSION}:t1`],
    messages: [],
    toolCalls: [],
    toolResults: [],
    filesRead: [],
    filesWritten: [],
  };
}

// A fake estimator that returns a fixed output — no live LLM call.
function fakeEstimator(output: unknown): TaskStateEstimator {
  return { estimate: () => output as any };
}

test("applies estimator task updates to the registry", async () => {
  const registry = createEmptySessionTaskRegistry(SESSION);
  const result = await updateRegistryFromDelta({
    registry,
    delta: delta(),
    estimator: fakeEstimator({
      baseVersion: registry.version,
      taskUpdates: [
        { taskId: "task-a", objective: "do X", lifecycle: "active", coveredTurnAbsIds: [`${SESSION}:t1`] },
      ],
    }),
  });
  assert.equal(result.changed, true);
  assert.ok(result.registry.tasks["task-a"]);
  assert.deepEqual(result.registry.activeTaskIds, ["task-a"]);
});

test("abandons the update when baseVersion does not match the registry", async () => {
  const registry = createEmptySessionTaskRegistry(SESSION);
  registry.version = 3;
  const result = await updateRegistryFromDelta({
    registry,
    delta: delta(),
    estimator: fakeEstimator({
      baseVersion: 1, // stale
      taskUpdates: [{ taskId: "task-a", objective: "x", lifecycle: "active", coveredTurnAbsIds: [`${SESSION}:t1`] }],
    }),
  });
  assert.equal(result.changed, false);
  assert.equal(result.note, "base_version_mismatch");
  assert.equal(result.registry.tasks["task-a"], undefined);
});

test("fails open when the estimator throws — registry unchanged, never rethrows", async () => {
  const registry = createEmptySessionTaskRegistry(SESSION);
  const result = await updateRegistryFromDelta({
    registry,
    delta: delta(),
    estimator: { estimate: () => { throw new Error("LLM timeout"); } },
  });
  assert.equal(result.changed, false);
  assert.equal(result.note, "estimator_failed");
  assert.equal(result.registry, registry); // same object, untouched
});

test("no-ops when the estimator returns no updates", async () => {
  const registry = createEmptySessionTaskRegistry(SESSION);
  const result = await updateRegistryFromDelta({
    registry,
    delta: delta(),
    estimator: fakeEstimator({ baseVersion: registry.version, taskUpdates: [] }),
  });
  assert.equal(result.changed, false);
  assert.equal(result.note, "no_updates");
});
