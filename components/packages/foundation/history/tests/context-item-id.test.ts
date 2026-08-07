import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_ITEM_ID_ALGORITHM_VERSION,
  createContextItemFingerprint,
  createContextItemIdentities,
  createContextItemIdentity,
  createStableContextItemId,
  normalizeContextItemContent,
} from "../src/index.js";

test("context item ID algorithm version is locked to 1", () => {
  assert.equal(CONTEXT_ITEM_ID_ALGORITHM_VERSION, 1);
});

test("native item ID takes priority over call ID and mutable content", () => {
  const first = createContextItemIdentity({
    sessionId: "session-1",
    kind: "assistant",
    nativeItemId: "item-1",
    callId: "call-1",
    content: { text: "before" },
    occurrence: 0,
  });
  const replayed = createContextItemIdentity({
    sessionId: "session-1",
    kind: "assistant",
    nativeItemId: "item-1",
    callId: "call-changed",
    content: { text: "after" },
    occurrence: 99,
  });

  assert.equal(first.source, "native_item_id");
  assert.equal(first.stableId, replayed.stableId);
  assert.notEqual(first.fingerprint, replayed.fingerprint);
});

test("call ID is the stable fallback when no native item ID exists", () => {
  const first = createContextItemIdentity({
    sessionId: "session-1",
    kind: "tool_result",
    callId: "call-1",
    content: { output: "before" },
    occurrence: 2,
  });
  const replayed = createContextItemIdentity({
    sessionId: "session-1",
    kind: "tool_result",
    callId: "call-1",
    content: { output: "after" },
    occurrence: 20,
  });

  assert.equal(first.source, "call_id");
  assert.equal(first.stableId, replayed.stableId);
  assert.notEqual(first.fingerprint, replayed.fingerprint);
});

test("synthetic IDs are deterministic across object key order", () => {
  const first = createContextItemIdentity({
    sessionId: "session-1",
    kind: "user",
    role: "user",
    content: { text: "hello", metadata: { a: 1, b: 2 } },
    occurrence: 3,
  });
  const replayed = createContextItemIdentity({
    sessionId: "session-1",
    kind: "user",
    role: "user",
    content: { metadata: { b: 2, a: 1 }, text: "hello" },
    occurrence: 3,
  });

  assert.equal(first.source, "synthetic");
  assert.deepEqual(first, replayed);
  assert.equal(
    createStableContextItemId({
      sessionId: "session-1",
      kind: "user",
      role: "user",
      content: { text: "hello", metadata: { a: 1, b: 2 } },
      occurrence: 3,
    }),
    first.stableId,
  );
});

test("content changes the fingerprint and synthetic stable ID", () => {
  const first = createContextItemIdentity({
    sessionId: "session-1",
    kind: "user",
    content: "first",
    occurrence: 0,
  });
  const changed = createContextItemIdentity({
    sessionId: "session-1",
    kind: "user",
    content: "second",
    occurrence: 0,
  });

  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.notEqual(first.stableId, changed.stableId);
});

test("occurrence changes only the synthetic stable ID", () => {
  const input = {
    sessionId: "session-1",
    kind: "assistant",
    content: { text: "same content" },
  };
  const first = createContextItemIdentity({ ...input, occurrence: 0 });
  const second = createContextItemIdentity({ ...input, occurrence: 1 });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.stableId, second.stableId);
});

test("Claude full-message replay keeps the same synthetic identity", () => {
  const first = createContextItemIdentity({
    sessionId: "claude-session",
    kind: "user",
    role: "user",
    content: [
      { type: "text", text: "summarize" },
      { type: "tool_result", tool_use_id: "tool-1", content: "result" },
    ],
    occurrence: 4,
  });
  const replayed = createContextItemIdentity({
    sessionId: "claude-session",
    kind: "user",
    role: "user",
    content: [
      { text: "summarize", type: "text" },
      { content: "result", tool_use_id: "tool-1", type: "tool_result" },
    ],
    occurrence: 4,
  });

  assert.deepEqual(first, replayed);
});

test("Codex journal replay keeps native state-event identity", () => {
  const first = createContextItemIdentity({
    sessionId: "codex-session",
    kind: "assistant",
    role: "assistant",
    nativeItemId: "item-message-1",
    content: { type: "message", content: [{ type: "output_text", text: "done" }] },
    occurrence: 5,
  });
  const replayed = createContextItemIdentity({
    sessionId: "codex-session",
    kind: "assistant",
    role: "assistant",
    nativeItemId: "item-message-1",
    content: { content: [{ text: "done", type: "output_text" }], type: "message" },
    occurrence: 5,
  });

  assert.equal(first.source, "native_item_id");
  assert.deepEqual(first, replayed);
});

test("batch identities survive unrelated prefix insertion", () => {
  const original = createContextItemIdentities([
    {
      sessionId: "session-1",
      kind: "user",
      role: "user",
      content: "target user message",
    },
    {
      sessionId: "session-1",
      kind: "assistant",
      role: "assistant",
      content: "target assistant message",
    },
  ]);
  const replayed = createContextItemIdentities([
    {
      sessionId: "session-1",
      kind: "system",
      role: "system",
      content: "unrelated inserted prefix",
    },
    {
      sessionId: "session-1",
      kind: "user",
      role: "user",
      content: "target user message",
    },
    {
      sessionId: "session-1",
      kind: "assistant",
      role: "assistant",
      content: "target assistant message",
    },
  ]);

  assert.deepEqual(original, replayed.slice(1));
});

test("batch identities disambiguate repeated synthetic content", () => {
  const identities = createContextItemIdentities([
    {
      sessionId: "session-1",
      kind: "user",
      content: "repeated",
    },
    {
      sessionId: "session-1",
      kind: "user",
      content: "repeated",
    },
  ]);

  assert.equal(identities[0]?.fingerprint, identities[1]?.fingerprint);
  assert.notEqual(identities[0]?.stableId, identities[1]?.stableId);
});

test("batch occurrence counters are isolated per session", () => {
  const identities = createContextItemIdentities([
    {
      sessionId: "session-1",
      kind: "user",
      content: "repeated",
    },
    {
      sessionId: "session-2",
      kind: "user",
      content: "repeated",
    },
  ]);
  const separatelyCreated = createContextItemIdentities([{
    sessionId: "session-2",
    kind: "user",
    content: "repeated",
  }]);

  assert.deepEqual(identities[1], separatelyCreated[0]);
});

test("deprecated ordinal remains a compatible occurrence alias", () => {
  const occurrenceIdentity = createContextItemIdentity({
    sessionId: "session-1",
    kind: "user",
    content: "hello",
    occurrence: 2,
  });
  const ordinalIdentity = createContextItemIdentity({
    sessionId: "session-1",
    kind: "user",
    content: "hello",
    ordinal: 2,
  });

  assert.deepEqual(occurrenceIdentity, ordinalIdentity);
  assert.throws(
    () => createContextItemIdentity({
      sessionId: "session-1",
      kind: "user",
      content: "hello",
      occurrence: 1,
      ordinal: 2,
    }),
    /must match/,
  );
});

test("normalization rejects non-JSON and cyclic content", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;

  assert.throws(
    () => normalizeContextItemContent({ missing: undefined }),
    /JSON-compatible/,
  );
  assert.throws(
    () => normalizeContextItemContent({ value: Number.POSITIVE_INFINITY }),
    /finite numbers/,
  );
  assert.throws(
    () => normalizeContextItemContent(cyclic),
    /must not contain cycles/,
  );
});

test("synthetic identity rejects an invalid occurrence", () => {
  assert.throws(
    () => createContextItemIdentity({
      sessionId: "session-1",
      kind: "user",
      content: "hello",
      occurrence: -1,
    }),
    /occurrence must be a non-negative safe integer/,
  );
});

test("fingerprints are independent of session and occurrence", () => {
  const fingerprint = createContextItemFingerprint({
    kind: "user",
    role: "user",
    content: { text: "hello" },
  });
  const identity = createContextItemIdentity({
    sessionId: "another-session",
    kind: "user",
    role: "user",
    content: { text: "hello" },
    occurrence: 42,
  });

  assert.equal(identity.fingerprint, fingerprint);
});
