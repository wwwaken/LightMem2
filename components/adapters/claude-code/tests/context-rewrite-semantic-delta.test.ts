import assert from "node:assert/strict";
import test from "node:test";
import { buildDeltaViewFromRawSemanticSnapshot } from "@lightmem2/history";
import {
  buildRawSemanticTurnRecord,
  buildRawSemanticSnapshot,
} from "../src/context-rewrite/semantic-mapping.js";

const SESSION = "sess-delta";

function turn(turnSeq: number, messages: unknown[]) {
  return buildRawSemanticTurnRecord({ sessionId: SESSION, turnSeq, messages });
}

test("assembles a snapshot from multiple turns in order", () => {
  const t1 = turn(1, [{ role: "user", content: "first" }]);
  const t2 = turn(2, [{ role: "user", content: "second" }]);
  const snapshot = buildRawSemanticSnapshot({ sessionId: SESSION, turns: [t2, t1] });
  assert.equal(snapshot.sessionId, SESSION);
  assert.equal(snapshot.lastTurnSeq, 2);
  assert.equal(snapshot.messages.length, 2);
  // sorted by turnSeq regardless of input order
  assert.equal(snapshot.messages[0]!.text, "first");
  assert.equal(snapshot.messages[1]!.text, "second");
});

test("builds a delta view covering only turns after the given point", () => {
  const t1 = turn(1, [{ role: "user", content: "old turn" }]);
  const t2 = turn(2, [
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "body" }] },
  ]);
  const snapshot = buildRawSemanticSnapshot({ sessionId: SESSION, turns: [t1, t2] });

  // delta from turn 1 (exclusive) → only turn 2's records appear
  const delta = buildDeltaViewFromRawSemanticSnapshot(snapshot, { fromTurnSeqExclusive: 1 });
  assert.equal(delta.fromTurnSeqExclusive, 1);
  assert.equal(delta.toTurnSeqInclusive, 2);
  assert.equal(delta.messages.every((m) => m.anchor.turnSeq === 2), true);
  assert.equal(delta.toolCalls.length, 1);
  assert.equal(delta.toolResults.length, 1);
  assert.ok(delta.coveredTurnAbsIds.includes(`${SESSION}:t2`));
  assert.equal(delta.coveredTurnAbsIds.includes(`${SESSION}:t1`), false);
});

test("a full delta from turn 0 covers all turns", () => {
  const t1 = turn(1, [{ role: "user", content: "a" }]);
  const t2 = turn(2, [{ role: "user", content: "b" }]);
  const snapshot = buildRawSemanticSnapshot({ sessionId: SESSION, turns: [t1, t2] });
  const delta = buildDeltaViewFromRawSemanticSnapshot(snapshot, { fromTurnSeqExclusive: 0 });
  assert.equal(delta.messages.length, 2);
});
