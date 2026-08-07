import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildClaudeContextSnapshot } from "../src/context-rewrite/snapshot.js";
import {
  saveLatestClaudeSnapshot,
  readLatestClaudeSnapshot,
  readClaudeItemFingerprints,
} from "../src/context-rewrite/snapshot-store.js";

const SESSION = "sess-snap";

async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lightmem2-snap-store-"));
}

function sampleSnapshot(revision: string) {
  return buildClaudeContextSnapshot({
    sessionId: SESSION,
    revision,
    messages: [
      { role: "user", content: "read the file" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "body" }],
      },
    ] as any,
  });
}

test("readLatestClaudeSnapshot returns undefined when nothing is stored", async () => {
  const stateDir = await tempStateDir();
  assert.equal(await readLatestClaudeSnapshot(stateDir, SESSION), undefined);
});

test("saveLatestClaudeSnapshot persists a snapshot that reads back identically", async () => {
  const stateDir = await tempStateDir();
  const snap = sampleSnapshot("rev-1");
  await saveLatestClaudeSnapshot(stateDir, SESSION, snap);
  const readBack = await readLatestClaudeSnapshot(stateDir, SESSION);
  assert.ok(readBack);
  assert.equal(readBack!.revision, "rev-1");
  assert.equal(readBack!.items.length, snap.items.length);
});

test("snapshot survives a fresh read (persistence across restart)", async () => {
  const stateDir = await tempStateDir();
  await saveLatestClaudeSnapshot(stateDir, SESSION, sampleSnapshot("rev-restart"));
  // a brand-new read call simulates a restarted process
  const readBack = await readLatestClaudeSnapshot(stateDir, SESSION);
  assert.equal(readBack!.revision, "rev-restart");
});

test("only the latest snapshot is kept, not accumulated", async () => {
  const stateDir = await tempStateDir();
  await saveLatestClaudeSnapshot(stateDir, SESSION, sampleSnapshot("rev-1"));
  await saveLatestClaudeSnapshot(stateDir, SESSION, sampleSnapshot("rev-2"));
  const readBack = await readLatestClaudeSnapshot(stateDir, SESSION);
  assert.equal(readBack!.revision, "rev-2");
});

test("item fingerprints are persisted alongside the snapshot", async () => {
  const stateDir = await tempStateDir();
  const snap = sampleSnapshot("rev-1");
  await saveLatestClaudeSnapshot(stateDir, SESSION, snap);
  const fingerprints = await readClaudeItemFingerprints(stateDir, SESSION);
  for (const item of snap.items) {
    assert.equal(fingerprints[item.stableId], item.fingerprint);
  }
});

test("corrupted snapshot file is treated as absent (fail-open)", async () => {
  const stateDir = await tempStateDir();
  await mkdir(join(stateDir, "claude-context", "sessions", SESSION), { recursive: true });
  await writeFile(
    join(stateDir, "claude-context", "sessions", SESSION, "latest-snapshot.json"),
    "{ not json",
    "utf8",
  );
  assert.equal(await readLatestClaudeSnapshot(stateDir, SESSION), undefined);
  // and a save after corruption still works
  await saveLatestClaudeSnapshot(stateDir, SESSION, sampleSnapshot("rev-ok"));
  assert.equal((await readLatestClaudeSnapshot(stateDir, SESSION))!.revision, "rev-ok");
});
