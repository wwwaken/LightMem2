import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDshDeltaView,
  buildDshRawSemanticSnapshot,
  computeDshSnapshotRevision,
} from "../src/session-codec.js";
import type { DshLogEvent, DshSurfaceDescriptor } from "../src/types.js";

/**
 * Inline fixture. NOTE: the authoritative fixture source for R2/R3 is 观祥's G1
 * (DSH-native SessionEvent fixtures + reverse validator). These inline events
 * are a minimal local stand-in so the codec is testable before G1 lands; the
 * seam is here, and G1 replaces this fixture without touching the codec.
 */
const SESSION = "sess-dsh-1";

function fixtureEvents(): DshLogEvent[] {
  return [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    { seq: 2, type: "user/message", data: { role: "user", content: [{ type: "text", text: "add a health check" }], source: { kind: "user" } } },
    { seq: 3, type: "step/start", data: { turn: 1, step: 0 } },
    { seq: 4, type: "assistant/message", data: { turn: 1, step: 0, message: { role: "assistant", content: [{ type: "reasoning", text: "internal plan" }, { type: "text", text: "I'll add it." }] } } },
    { seq: 5, type: "tool/call", data: { turn: 1, step: 0, callId: "call_a", name: "fs_write", arguments: '{"path":"health.ts"}' } },
    { seq: 6, type: "tool/result", data: { turn: 1, step: 0, message: { role: "user", content: [{ type: "tool-result", toolCallId: "call_a", content: [{ type: "text", text: "written 42 bytes" }] }], source: { kind: "tool", callId: "call_a" } } } },
    { seq: 7, type: "todo/write", data: { todos: [] } },
    { seq: 8, type: "request/header", data: { header: {}, reason: "x" } },
    { seq: 9, type: "turn/end", data: { turn: 1 } },
    { seq: 10, type: "turn/start", data: { turn: 2 } },
    { seq: 11, type: "user/message", data: { role: "user", content: [{ type: "text", text: "now write a test" }], source: { kind: "user" } } },
  ];
}

describe("buildDshRawSemanticSnapshot", () => {
  it("maps user/assistant/tool events, excludes reasoning from visible text", () => {
    const snap = buildDshRawSemanticSnapshot(SESSION, fixtureEvents());

    assert.deepEqual(
      snap.messages.map((m) => [m.role, m.text]),
      [["user", "add a health check"], ["assistant", "I'll add it."], ["user", "now write a test"]],
    );
    assert.equal(snap.toolCalls.length, 1);
    assert.equal(snap.toolCalls[0].toolCallId, "call_a");
    assert.equal(snap.toolCalls[0].toolName, "fs_write");
    assert.equal(snap.toolResults.length, 1);
    assert.equal(snap.toolResults[0].toolCallId, "call_a");
    assert.equal(snap.toolResults[0].toolName, "fs_write");
    assert.equal(snap.toolResults[0].status, "success");
    assert.equal(snap.toolResults[0].fullText, "written 42 bytes");
    assert.equal(snap.lastTurnSeq, 2);
  });

  it("tolerates log-only / unknown events without dropping the snapshot", () => {
    const withJunk: DshLogEvent[] = [
      ...fixtureEvents(),
      { seq: 12, type: "some/plugin-event", data: { anything: true } },
      { seq: 13, type: "assistant/chunk", data: { turn: 2, step: 0, chunk: {} } },
    ];
    const snap = buildDshRawSemanticSnapshot(SESSION, withJunk);
    assert.equal(snap.messages.length, 3);
  });

  it("is deterministic across replay: identical events -> identical snapshot", () => {
    const a = buildDshRawSemanticSnapshot(SESSION, fixtureEvents());
    const b = buildDshRawSemanticSnapshot(SESSION, fixtureEvents());
    assert.deepEqual(b, a);
    assert.equal(a.messages[2].anchor.turnAbsId, `${SESSION}:t2`);
  });

  it("excludes shadowed surface messages while retaining their visible tool pair", () => {
    const snap = buildDshRawSemanticSnapshot(SESSION, fixtureEvents(), {
      surfaceEventSeqs: [4, 6, 11],
    });
    assert.deepEqual(snap.messages.map((message) => message.text), ["I'll add it.", "now write a test"]);
    assert.deepEqual(snap.toolCalls.map((call) => call.toolCallId), ["call_a"]);
    assert.deepEqual(snap.toolResults.map((result) => result.toolCallId), ["call_a"]);
  });
});

describe("buildDshDeltaView", () => {
  it("windows records by turnSeq (exclusive .. inclusive)", () => {
    const snap = buildDshRawSemanticSnapshot(SESSION, fixtureEvents());
    const delta = buildDshDeltaView(snap, { fromTurnSeqExclusive: 1 });
    assert.deepEqual(delta.messages.map((m) => m.text), ["now write a test"]);
    assert.equal(delta.toTurnSeqInclusive, 2);
  });
});

describe("computeDshSnapshotRevision", () => {
  const surface: DshSurfaceDescriptor = {
    sessionId: SESSION,
    lastEventSeq: 11,
    surfaceReplaceGeneration: 0,
    orderedSurfaceNodeSeqs: [2, 4, 5, 6, 11],
  };

  it("is stable for identical surface (replay/restart safe)", () => {
    assert.equal(
      computeDshSnapshotRevision(surface),
      computeDshSnapshotRevision({ ...surface, orderedSurfaceNodeSeqs: [2, 4, 5, 6, 11] }),
    );
  });

  it("changes when the surface changes (new event or a replace)", () => {
    const base = computeDshSnapshotRevision(surface);
    assert.notEqual(computeDshSnapshotRevision({ ...surface, lastEventSeq: 12 }), base);
    assert.notEqual(computeDshSnapshotRevision({ ...surface, surfaceReplaceGeneration: 1 }), base);
  });
});
