import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_REVISION_ALGORITHM_VERSION,
  createContextRevision,
} from "../src/index.js";

const items = [
  { stableId: "item-1", fingerprint: "fp-1" },
  { stableId: "item-2", fingerprint: "fp-2" },
] as const;

test("context revision algorithm version is locked to 1", () => {
  assert.equal(CONTEXT_REVISION_ALGORITHM_VERSION, 1);
});

test("ordered stable IDs and fingerprints produce a deterministic revision", () => {
  const first = createContextRevision(items);
  const replayed = createContextRevision(items.map((item) => ({ ...item })));

  assert.match(first, /^ctxrev-v1-[0-9a-f]{64}$/);
  assert.equal(first, replayed);
});

test("item order changes the revision", () => {
  assert.notEqual(
    createContextRevision(items),
    createContextRevision([...items].reverse()),
  );
});

test("a changed fingerprint changes the revision", () => {
  assert.notEqual(
    createContextRevision(items),
    createContextRevision([
      items[0],
      { ...items[1], fingerprint: "fp-2-changed" },
    ]),
  );
});

test("volatile item metadata is excluded from the revision", () => {
  const first = [
    { ...items[0], timestamp: "2026-07-30T00:00:00.000Z", requestId: "req-1" },
    { ...items[1], timestamp: "2026-07-30T00:00:01.000Z", requestId: "req-1" },
  ];
  const replayed = [
    { ...items[0], timestamp: "2026-07-31T00:00:00.000Z", requestId: "req-2" },
    { ...items[1], timestamp: "2026-07-31T00:00:01.000Z", requestId: "req-2" },
  ];

  assert.equal(createContextRevision(first), createContextRevision(replayed));
});

test("empty item identity fields are rejected", () => {
  assert.throws(
    () => createContextRevision([{ stableId: " ", fingerprint: "fp-1" }]),
    /stableId must not be empty/,
  );
  assert.throws(
    () => createContextRevision([{ stableId: "item-1", fingerprint: "" }]),
    /fingerprint must not be empty/,
  );
});

test("revision identity fields are trimmed before hashing", () => {
  assert.equal(
    createContextRevision(items),
    createContextRevision([
      { stableId: " item-1 ", fingerprint: " fp-1 " },
      { stableId: " item-2 ", fingerprint: " fp-2 " },
    ]),
  );
});

test("duplicate stable IDs are rejected", () => {
  assert.throws(
    () => createContextRevision([
      { stableId: "item-1", fingerprint: "fp-1" },
      { stableId: " item-1 ", fingerprint: "fp-2" },
    ]),
    /unique stableIds/,
  );
});
