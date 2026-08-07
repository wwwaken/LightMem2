import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

type GoldenItem = {
  id: string;
  kind: string;
  role?: string;
  content?: string;
  tool_name?: string;
  tool_call_id?: string;
  arguments?: Record<string, unknown>;
  result?: string;
};

type GoldenTask = {
  id: string;
  status: "active" | "completed" | "unresolved";
  current?: boolean;
  items: GoldenItem[];
};

type ToolPair = {
  tool_call_id: string;
  action: "evict" | "keep";
  call_item_id: string;
  result_item_id: string;
};

type GoldenExpected = {
  evict_task_ids: string[];
  keep_task_ids: string[];
  evict_item_ids: string[];
  keep_item_ids: string[];
  current_task_id?: string;
  tool_pairs?: ToolPair[];
};

type GoldenFixture = {
  schema: string;
  id: string;
  description: string;
  tasks: GoldenTask[];
  expected: GoldenExpected;
};

const fixtureDirectory = path.join(__dirname, "fixtures");

const fixtureFiles = [
  "active-turn.json",
  "completed-task.json",
  "tool-closure.json",
  "unresolved-task.json",
];

const forbiddenFixtureContent = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/i,
  /[A-Za-z]:\\\\/,
  /\/(?:Users|home|root|mnt|disk(?:_[^/]+)?)\//i,
];

function readFixture(fileName: string): GoldenFixture {
  const file = path.join(fixtureDirectory, fileName);
  return JSON.parse(fs.readFileSync(file, "utf8")) as GoldenFixture;
}

function assertUnique(values: string[], label: string): void {
  assert.equal(
    new Set(values).size,
    values.length,
    `${label} must contain unique ids`,
  );
}

function assertDisjoint(
  left: string[],
  right: string[],
  label: string,
): void {
  const rightSet = new Set(right);
  const overlap = left.filter((value) => rightSet.has(value));

  assert.deepEqual(overlap, [], `${label} must not overlap`);
}

function assertSameMembers(
  actual: string[],
  expected: string[],
  label: string,
): void {
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    `${label} must classify every id exactly once`,
  );
}

function decisionFor(
  id: string,
  evictedIds: string[],
  keptIds: string[],
  label: string,
): "evict" | "keep" {
  const evicted = evictedIds.includes(id);
  const kept = keptIds.includes(id);
  assert.notEqual(evicted, kept, `${label} must have exactly one decision`);
  return evicted ? "evict" : "keep";
}

function assertToolClosure(
  fixture: GoldenFixture,
  items: GoldenItem[],
  itemTaskIds: Map<string, string>,
): void {
  const discovered = new Map<string, { calls: GoldenItem[]; results: GoldenItem[] }>();
  for (const item of items) {
    if (item.kind !== "tool_call" && item.kind !== "tool_result") continue;
    assert.ok(item.tool_call_id, `${fixture.id} ${item.id} must have a tool_call_id`);
    const pair = discovered.get(item.tool_call_id) ?? { calls: [], results: [] };
    (item.kind === "tool_call" ? pair.calls : pair.results).push(item);
    discovered.set(item.tool_call_id, pair);
  }

  const declaredPairs = fixture.expected.tool_pairs ?? [];
  assertUnique(
    declaredPairs.map((pair) => pair.tool_call_id),
    `${fixture.id} declared tool pairs`,
  );
  assertSameMembers(
    declaredPairs.map((pair) => pair.tool_call_id),
    [...discovered.keys()],
    `${fixture.id} tool pair declarations`,
  );

  for (const [toolCallId, discoveredPair] of discovered) {
    assert.equal(discoveredPair.calls.length, 1, `${fixture.id} ${toolCallId} must have one call`);
    assert.equal(discoveredPair.results.length, 1, `${fixture.id} ${toolCallId} must have one result`);
    const call = discoveredPair.calls[0];
    const result = discoveredPair.results[0];
    assert.equal(call.tool_name, result.tool_name, `${fixture.id} ${toolCallId} tool names must match`);
    assert.equal(
      itemTaskIds.get(call.id),
      itemTaskIds.get(result.id),
      `${fixture.id} ${toolCallId} call and result must belong to the same task`,
    );

    const callDecision = decisionFor(
      call.id,
      fixture.expected.evict_item_ids,
      fixture.expected.keep_item_ids,
      `${fixture.id} ${call.id}`,
    );
    const resultDecision = decisionFor(
      result.id,
      fixture.expected.evict_item_ids,
      fixture.expected.keep_item_ids,
      `${fixture.id} ${result.id}`,
    );
    assert.equal(callDecision, resultDecision, `${fixture.id} ${toolCallId} must remain closed`);

    const declared = declaredPairs.find((pair) => pair.tool_call_id === toolCallId);
    assert.ok(declared, `${fixture.id} ${toolCallId} must be declared`);
    assert.equal(declared.call_item_id, call.id);
    assert.equal(declared.result_item_id, result.id);
    assert.equal(declared.action, callDecision);
  }
}

function assertValidFixture(fixture: GoldenFixture): void {
  assert.equal(fixture.schema, "lightmem2.context-rewrite-golden/v1");
  assert.ok(fixture.description.length > 0);
  assert.ok(fixture.tasks.length > 0);

  const taskIds = fixture.tasks.map((task) => task.id);
  const items = fixture.tasks.flatMap((task) => task.items);
  const itemIds = items.map((item) => item.id);
  const itemTaskIds = new Map(
    fixture.tasks.flatMap((task) => task.items.map((item) => [item.id, task.id] as const)),
  );

  assertUnique(taskIds, `${fixture.id} task ids`);
  assertUnique(itemIds, `${fixture.id} item ids`);
  assertUnique(fixture.expected.evict_task_ids, `${fixture.id} evicted task ids`);
  assertUnique(fixture.expected.keep_task_ids, `${fixture.id} kept task ids`);
  assertUnique(fixture.expected.evict_item_ids, `${fixture.id} evicted item ids`);
  assertUnique(fixture.expected.keep_item_ids, `${fixture.id} kept item ids`);

  assertDisjoint(
    fixture.expected.evict_task_ids,
    fixture.expected.keep_task_ids,
    `${fixture.id} task decisions`,
  );
  assertDisjoint(
    fixture.expected.evict_item_ids,
    fixture.expected.keep_item_ids,
    `${fixture.id} item decisions`,
  );
  assertSameMembers(
    [...fixture.expected.evict_task_ids, ...fixture.expected.keep_task_ids],
    taskIds,
    `${fixture.id} task decisions`,
  );
  assertSameMembers(
    [...fixture.expected.evict_item_ids, ...fixture.expected.keep_item_ids],
    itemIds,
    `${fixture.id} item decisions`,
  );

  const currentTasks = fixture.tasks.filter((task) => task.current === true);
  assert.ok(currentTasks.length <= 1, `${fixture.id} must have at most one current task`);
  assert.equal(
    fixture.expected.current_task_id,
    currentTasks[0]?.id,
    `${fixture.id} current_task_id must match the task marked current`,
  );

  for (const task of fixture.tasks) {
    assert.ok(
      ["active", "completed", "unresolved"].includes(task.status),
      `${fixture.id} ${task.id} has an unsupported status`,
    );
    const decision = decisionFor(
      task.id,
      fixture.expected.evict_task_ids,
      fixture.expected.keep_task_ids,
      `${fixture.id} ${task.id}`,
    );
    if (task.status === "active" || task.status === "unresolved" || task.current === true) {
      assert.equal(decision, "keep", `${fixture.id} ${task.id} is not safe to evict`);
      for (const item of task.items) {
        assert.equal(
          decisionFor(
            item.id,
            fixture.expected.evict_item_ids,
            fixture.expected.keep_item_ids,
            `${fixture.id} ${item.id}`,
          ),
          "keep",
          `${fixture.id} ${task.id} items are not safe to evict`,
        );
      }
    }
  }

  assertToolClosure(fixture, items, itemTaskIds);

  const serialized = JSON.stringify(fixture);
  for (const pattern of forbiddenFixtureContent) {
    assert.doesNotMatch(serialized, pattern, `${fixture.id} contains sensitive fixture content`);
  }
}

test("cross-host golden fixtures define valid logical rewrite targets", () => {
  const fixtures = fixtureFiles.map(readFixture);

  assert.deepEqual(
    fixtures.map((fixture) => fixture.id).sort(),
    [
      "active-turn",
      "completed-task",
      "tool-closure",
      "unresolved-task",
    ],
  );

  for (const fixture of fixtures) {
    assertValidFixture(fixture);
  }
});

test("cross-host golden validation rejects incomplete decisions", () => {
  const fixture = structuredClone(readFixture("completed-task.json"));
  fixture.expected.keep_item_ids = [];
  assert.throws(() => assertValidFixture(fixture), /classify every id exactly once/);
});

test("cross-host golden validation rejects unsafe current task decisions", () => {
  const fixture = structuredClone(readFixture("active-turn.json"));
  fixture.expected.current_task_id = "task-old-completed-001";
  assert.throws(() => assertValidFixture(fixture), /must match the task marked current/);
});

test("cross-host golden validation rejects evicted items from active tasks", () => {
  const fixture = structuredClone(readFixture("active-turn.json"));
  fixture.expected.keep_item_ids = fixture.expected.keep_item_ids.filter(
    (itemId) => itemId !== "item-current-user-001",
  );
  fixture.expected.evict_item_ids.push("item-current-user-001");
  assert.throws(() => assertValidFixture(fixture), /items are not safe to evict/);
});

test("cross-host golden validation requires every discovered tool pair", () => {
  const fixture = structuredClone(readFixture("tool-closure.json"));
  fixture.expected.tool_pairs = fixture.expected.tool_pairs?.slice(1);
  assert.throws(() => assertValidFixture(fixture), /classify every id exactly once/);
});

test("cross-host golden validation rejects machine-specific paths", () => {
  const fixture = structuredClone(readFixture("completed-task.json"));
  fixture.tasks[0].items[0].content = "/disk_20T/private/session.jsonl";
  assert.throws(() => assertValidFixture(fixture), /sensitive fixture content/);
});
