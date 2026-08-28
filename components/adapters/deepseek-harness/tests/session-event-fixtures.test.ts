import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

type FixtureAction = "evict" | "keep";
type TaskState = "completed" | "unresolved" | "current";
type ToolPairStatus = "closed" | "orphan_result" | "duplicate_call";

type FixtureEvent = {
  seq: number;
  type: string;
  data?: unknown;
  ignorable?: boolean;
  surfaceOp?: unknown;
  sourceEventSeqs?: number[];
};

type ExpectedItem = {
  itemId: string;
  sourceEventSeq: number;
  kind: string;
  taskId: string;
  taskState: TaskState;
  action: FixtureAction;
  current: boolean;
};

type ExpectedToolPair = {
  callId: string;
  callItemIds: string[];
  resultItemIds: string[];
  status: ToolPairStatus;
  action: "evict" | "keep" | "defer";
};

type SessionEventFixture = {
  id: string;
  description: string;
  sessionId: string;
  currentTurn: number;
  events: FixtureEvent[];
  effectiveEventSeqs: number[];
  persistenceRecords?: unknown[];
  expected: {
    items: ExpectedItem[];
    toolPairs: ExpectedToolPair[];
    damagedPersistenceRecordIndexes: number[];
  };
};

type FixtureFile = {
  schema: string;
  cases: SessionEventFixture[];
};

type JsonObject = Record<string, unknown>;

type DiscoveredToolPair = {
  callItemIds: string[];
  resultItemIds: string[];
};

const fixturePath = new URL("./fixtures/session-events.json", import.meta.url);

const forbiddenFixtureContent = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{16,}/i,
  /[A-Za-z]:\\\\/,
  /\/(?:Users|home|root|mnt|disk(?:_[^/]+)?)\//i,
];

const evictSentinel =
  /EVICT_ME_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const keepSentinel =
  /KEEP_ME_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

function assertUnique<T>(values: readonly T[], label: string): void {
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

function readFixtures(): SessionEventFixture[] {
  const raw = readFileSync(fixturePath, "utf8");

  for (const pattern of forbiddenFixtureContent) {
    assert.doesNotMatch(raw, pattern, "DSH fixtures must remain sanitized");
  }

  const parsed = JSON.parse(raw) as FixtureFile;
  assert.equal(
    parsed.schema,
    "lightrsi.dsh-session-event-fixtures/v1",
    "unsupported DSH fixture schema",
  );
  assert.ok(Array.isArray(parsed.cases), "DSH fixture cases must be an array");

  return parsed.cases;
}

function turnByEventSeq(fixture: SessionEventFixture): Map<number, number> {
  const result = new Map<number, number>();
  let activeTurn = 0;

  for (const event of fixture.events) {
    const data = isObject(event.data) ? event.data : {};

    if (event.type === "turn/start" && typeof data.turn === "number") {
      activeTurn = data.turn;
    }

    const directTurn =
      typeof data.turn === "number" ? data.turn : activeTurn;

    result.set(event.seq, directTurn);
  }

  return result;
}

function resultCallId(event: FixtureEvent): string {
  const data = isObject(event.data) ? event.data : {};
  const message = isObject(data.message) ? data.message : {};
  const source = isObject(message.source) ? message.source : {};

  if (typeof source.callId === "string" && source.callId.length > 0) {
    return source.callId;
  }

  const content = Array.isArray(message.content) ? message.content : [];

  for (const blockValue of content) {
    if (!isObject(blockValue)) continue;

    if (
      blockValue.type === "tool-result" &&
      typeof blockValue.toolCallId === "string"
    ) {
      return blockValue.toolCallId;
    }
  }

  throw new Error(`${fixtureLabel(event)} tool result is missing callId`);
}

function fixtureLabel(event: FixtureEvent): string {
  return `event ${event.seq} (${event.type})`;
}

function discoverToolPairs(
  fixture: SessionEventFixture,
  itemsBySeq: Map<number, ExpectedItem>,
): Map<string, DiscoveredToolPair> {
  const discovered = new Map<string, DiscoveredToolPair>();
  const effective = new Set(fixture.effectiveEventSeqs);

  for (const event of fixture.events) {
    if (!effective.has(event.seq)) continue;
    if (event.type !== "tool/call" && event.type !== "tool/result") continue;

    const item = itemsBySeq.get(event.seq);
    assert.ok(item, `${fixture.id} ${fixtureLabel(event)} has no expected item`);

    let callId: string;

    if (event.type === "tool/call") {
      const data = isObject(event.data) ? event.data : {};
      assert.equal(
        typeof data.callId,
        "string",
        `${fixture.id} ${fixtureLabel(event)} must have callId`,
      );
      callId = data.callId as string;
    } else {
      callId = resultCallId(event);
    }

    const pair = discovered.get(callId) ?? {
      callItemIds: [],
      resultItemIds: [],
    };

    if (event.type === "tool/call") {
      pair.callItemIds.push(item.itemId);
    } else {
      pair.resultItemIds.push(item.itemId);
    }

    discovered.set(callId, pair);
  }

  return discovered;
}

function validateToolPairs(
  fixture: SessionEventFixture,
  itemsById: Map<string, ExpectedItem>,
  itemsBySeq: Map<number, ExpectedItem>,
): void {
  const discovered = discoverToolPairs(fixture, itemsBySeq);
  const declared = fixture.expected.toolPairs;

  assertUnique(
    declared.map((pair) => pair.callId),
    `${fixture.id} declared tool pair ids`,
  );

  assert.deepEqual(
    sortedStrings(declared.map((pair) => pair.callId)),
    sortedStrings([...discovered.keys()]),
    `${fixture.id} tool pair declarations must cover every discovered callId`,
  );

  for (const expectedPair of declared) {
    const actual = discovered.get(expectedPair.callId);
    assert.ok(
      actual,
      `${fixture.id} tool pair ${expectedPair.callId} was not discovered`,
    );

    assert.deepEqual(
      sortedStrings(expectedPair.callItemIds),
      sortedStrings(actual.callItemIds),
      `${fixture.id} ${expectedPair.callId} call items`,
    );

    assert.deepEqual(
      sortedStrings(expectedPair.resultItemIds),
      sortedStrings(actual.resultItemIds),
      `${fixture.id} ${expectedPair.callId} result items`,
    );

    const affectedItemIds = [
      ...actual.callItemIds,
      ...actual.resultItemIds,
    ];

    if (expectedPair.status === "closed") {
      assert.equal(
        actual.callItemIds.length,
        1,
        `${fixture.id} ${expectedPair.callId} must have one call`,
      );
      assert.equal(
        actual.resultItemIds.length,
        1,
        `${fixture.id} ${expectedPair.callId} must have one result`,
      );
      assert.notEqual(
        expectedPair.action,
        "defer",
        `${fixture.id} closed pair must declare evict or keep`,
      );

      for (const itemId of affectedItemIds) {
        const item = itemsById.get(itemId);
        assert.ok(item, `${fixture.id} ${itemId} is missing`);
        assert.equal(
          item.action,
          expectedPair.action,
          `${fixture.id} ${expectedPair.callId} must remain closed`,
        );
      }
    } else if (expectedPair.status === "orphan_result") {
      assert.equal(
        actual.callItemIds.length,
        0,
        `${fixture.id} ${expectedPair.callId} must have no call`,
      );
      assert.equal(
        actual.resultItemIds.length,
        1,
        `${fixture.id} ${expectedPair.callId} must have one orphan result`,
      );
      assert.equal(expectedPair.action, "defer");

      for (const itemId of affectedItemIds) {
        assert.equal(itemsById.get(itemId)?.action, "keep");
      }
    } else {
      assert.ok(
        actual.callItemIds.length > 1,
        `${fixture.id} ${expectedPair.callId} must contain duplicate calls`,
      );
      assert.equal(expectedPair.action, "defer");

      for (const itemId of affectedItemIds) {
        assert.equal(itemsById.get(itemId)?.action, "keep");
      }
    }
  }
}

function isValidPersistenceRecord(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (!Number.isInteger(value.seq)) return false;
  if (typeof value.type !== "string" || value.type.length === 0) return false;
  if (!isObject(value.data)) return false;
  return true;
}

function validatePersistenceRecords(fixture: SessionEventFixture): void {
  const records = fixture.persistenceRecords ?? [];
  const damagedIndexes: number[] = [];

  records.forEach((record, index) => {
    if (!isValidPersistenceRecord(record)) {
      damagedIndexes.push(index);
    }
  });

  assert.deepEqual(
    damagedIndexes,
    fixture.expected.damagedPersistenceRecordIndexes,
    `${fixture.id} damaged persistence records`,
  );
}

function validateReplacements(
  fixture: SessionEventFixture,
  eventsBySeq: Map<number, FixtureEvent>,
): void {
  const effective = new Set(fixture.effectiveEventSeqs);

  for (const event of fixture.events) {
    if (!isObject(event.surfaceOp) || event.surfaceOp.op !== "replace") {
      continue;
    }

    const start = event.surfaceOp.start;
    const end = event.surfaceOp.end;

    assert.equal(
      typeof start,
      "number",
      `${fixture.id} replacement start must be a number`,
    );
    assert.equal(
      typeof end,
      "number",
      `${fixture.id} replacement end must be a number`,
    );

    assert.ok(eventsBySeq.has(start as number));
    assert.ok(eventsBySeq.has(end as number));
    assert.ok(
      effective.has(event.seq),
      `${fixture.id} replacement event must be effective`,
    );
    assert.ok(
      !effective.has(start as number),
      `${fixture.id} replacement start must be shadowed`,
    );
    assert.ok(
      !effective.has(end as number),
      `${fixture.id} replacement end must be shadowed`,
    );

    const sources = event.sourceEventSeqs ?? [];
    assert.ok(
      sources.includes(start as number),
      `${fixture.id} replacement must cite start`,
    );
    assert.ok(
      sources.includes(end as number),
      `${fixture.id} replacement must cite end`,
    );
  }
}

function validateFixture(fixture: SessionEventFixture): void {
  assert.ok(fixture.id.trim(), "fixture id is required");
  assert.ok(fixture.description.trim(), `${fixture.id} description is required`);
  assert.ok(fixture.sessionId.trim(), `${fixture.id} session id is required`);
  assert.ok(Number.isInteger(fixture.currentTurn));

  const serialized = JSON.stringify(fixture);
  for (const pattern of forbiddenFixtureContent) {
    assert.doesNotMatch(
      serialized,
      pattern,
      `${fixture.id} contains sensitive fixture content`,
    );
  }

  const eventSeqs = fixture.events.map((event) => event.seq);
  assertUnique(eventSeqs, `${fixture.id} event seqs`);
  assert.deepEqual(
    eventSeqs,
    sortedNumbers(eventSeqs),
    `${fixture.id} events must be ordered by seq`,
  );

  eventSeqs.forEach((seq, index) => {
    if (index === 0) return;
    assert.equal(
      seq,
      eventSeqs[index - 1]! + 1,
      `${fixture.id} committed event seqs must be contiguous`,
    );
  });

  const eventsBySeq = new Map(
    fixture.events.map((event) => [event.seq, event]),
  );

  assertUnique(
    fixture.effectiveEventSeqs,
    `${fixture.id} effective event seqs`,
  );

  for (const seq of fixture.effectiveEventSeqs) {
    assert.ok(
      eventsBySeq.has(seq),
      `${fixture.id} effective event ${seq} must exist`,
    );
  }

  const items = fixture.expected.items;
  assertUnique(
    items.map((item) => item.itemId),
    `${fixture.id} expected item ids`,
  );
  assertUnique(
    items.map((item) => item.sourceEventSeq),
    `${fixture.id} expected source event seqs`,
  );

  assert.deepEqual(
    sortedNumbers(items.map((item) => item.sourceEventSeq)),
    sortedNumbers(fixture.effectiveEventSeqs),
    `${fixture.id} must classify every effective event exactly once`,
  );

  const itemsById = new Map(items.map((item) => [item.itemId, item]));
  const itemsBySeq = new Map(
    items.map((item) => [item.sourceEventSeq, item]),
  );
  const eventTurns = turnByEventSeq(fixture);

  for (const item of items) {
    assert.ok(item.itemId.trim(), `${fixture.id} item id is required`);
    assert.ok(item.taskId.trim(), `${fixture.id} task id is required`);
    assert.ok(eventsBySeq.has(item.sourceEventSeq));

    assert.ok(
      item.action === "evict" || item.action === "keep",
      `${fixture.id} ${item.itemId} has invalid action`,
    );

    assert.ok(
      item.taskState === "completed" ||
        item.taskState === "unresolved" ||
        item.taskState === "current",
      `${fixture.id} ${item.itemId} has invalid task state`,
    );

    const itemTurn = eventTurns.get(item.sourceEventSeq);
    const shouldBeCurrent = itemTurn === fixture.currentTurn;

    assert.equal(
      item.current,
      shouldBeCurrent,
      `${fixture.id} ${item.itemId} current marker must match current turn`,
    );

    assert.equal(
      item.taskState === "current",
      item.current,
      `${fixture.id} ${item.itemId} current task state is inconsistent`,
    );

    if (item.current || item.taskState === "unresolved") {
      assert.equal(
        item.action,
        "keep",
        `${fixture.id} protected item ${item.itemId} cannot be evicted`,
      );
    }

    const sourceEvent = eventsBySeq.get(item.sourceEventSeq);
    assert.ok(sourceEvent);
    const sourceText = JSON.stringify(sourceEvent);

    if (item.action === "evict") {
      assert.match(
        sourceText,
        evictSentinel,
        `${fixture.id} ${item.itemId} must use an EVICT_ME UUID sentinel`,
      );
    } else {
      assert.match(
        sourceText,
        keepSentinel,
        `${fixture.id} ${item.itemId} must use a KEEP_ME UUID sentinel`,
      );
    }
  }

  validateToolPairs(fixture, itemsById, itemsBySeq);
  validatePersistenceRecords(fixture);
  validateReplacements(fixture, eventsBySeq);
}

describe("DSH native session event fixtures", () => {
  it("are sanitized and cover the complete G1 matrix", () => {
    const fixtures = readFixtures();

    assert.deepEqual(
      fixtures.map((fixture) => fixture.id),
      [
        "lifecycle-and-tool-safety",
        "compaction-replacement-and-unknown-event",
        "damaged-persistence-record",
      ],
    );

    assertUnique(
      fixtures.map((fixture) => fixture.id),
      "fixture case ids",
    );

    for (const fixture of fixtures) {
      validateFixture(fixture);
    }

    const items = fixtures.flatMap((fixture) => fixture.expected.items);
    const toolPairs = fixtures.flatMap(
      (fixture) => fixture.expected.toolPairs,
    );

    assert.ok(
      items.some(
        (item) =>
          item.taskState === "completed" && item.action === "evict",
      ),
      "completed task coverage is required",
    );
    assert.ok(
      items.some(
        (item) =>
          item.taskState === "unresolved" && item.action === "keep",
      ),
      "unresolved task coverage is required",
    );
    assert.ok(
      items.some(
        (item) => item.taskState === "current" && item.action === "keep",
      ),
      "current task coverage is required",
    );
    assert.ok(
      toolPairs.some((pair) => pair.status === "closed"),
      "closed tool pair coverage is required",
    );
    assert.ok(
      toolPairs.some((pair) => pair.status === "orphan_result"),
      "orphan tool result coverage is required",
    );
    assert.ok(
      toolPairs.some((pair) => pair.status === "duplicate_call"),
      "duplicate tool call coverage is required",
    );
    assert.ok(
      fixtures.some((fixture) =>
        fixture.events.some(
          (event) =>
            isObject(event.surfaceOp) &&
            event.surfaceOp.op === "replace",
        ),
      ),
      "compaction replacement coverage is required",
    );
    assert.ok(
      fixtures.some((fixture) =>
        fixture.events.some(
          (event) =>
            event.ignorable === true &&
            event.type.startsWith("plugin/"),
        ),
      ),
      "unknown ignorable plugin event coverage is required",
    );
    assert.ok(
      fixtures.some(
        (fixture) =>
          fixture.expected.damagedPersistenceRecordIndexes.length > 0,
      ),
      "damaged persistence coverage is required",
    );
  });

  it("rejects a missing item classification", () => {
    const fixture = structuredClone(readFixtures()[0]!);
    fixture.expected.items.pop();

    assert.throws(
      () => validateFixture(fixture),
      /classify every effective event exactly once/,
    );
  });

  it("rejects a mismatched current marker", () => {
    const fixture = structuredClone(readFixtures()[0]!);
    const currentItem = fixture.expected.items.find(
      (item) => item.current,
    );
    assert.ok(currentItem);
    currentItem.current = false;

    assert.throws(
      () => validateFixture(fixture),
      /current marker must match current turn/,
    );
  });

  it("rejects an omitted tool pair declaration", () => {
    const fixture = structuredClone(readFixtures()[0]!);
    fixture.expected.toolPairs = [];

    assert.throws(
      () => validateFixture(fixture),
      /tool pair declarations must cover every discovered callId/,
    );
  });

  it("rejects duplicate expected item ids", () => {
    const fixture = structuredClone(readFixtures()[0]!);
    const firstItem = fixture.expected.items[0];
    const secondItem = fixture.expected.items[1];
    assert.ok(firstItem);
    assert.ok(secondItem);
    secondItem.itemId = firstItem.itemId;

    assert.throws(
      () => validateFixture(fixture),
      /expected item ids must be unique/,
    );
  });

  it("rejects sensitive fixture content", () => {
    const fixture = structuredClone(readFixtures()[0]!);
    fixture.description =
      "synthetic fixture sk-1234567890abcdefghijklmnop";

    assert.throws(
      () => validateFixture(fixture),
      /contains sensitive fixture content/,
    );
  });
});
