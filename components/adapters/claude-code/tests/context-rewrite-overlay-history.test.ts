import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendOverlayHistory,
  readOverlayHistory,
} from "../src/context-rewrite/overlay-history.js";

const SESSION = "sess-hist";

async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lightmem2-overlay-hist-"));
}

function sampleEntry(overrides: Partial<Parameters<typeof appendOverlayHistory>[1]> = {}) {
  return {
    sessionId: SESSION,
    planId: "plan-1",
    previousRevision: "rev-0",
    nextRevision: "rev-1",
    removedItemIds: [`${SESSION}:1:0`],
    savedChars: 4096,
    relocated: false,
    ...overrides,
  };
}

test("readOverlayHistory returns empty when nothing is logged", async () => {
  const stateDir = await tempStateDir();
  assert.deepEqual(await readOverlayHistory(stateDir, SESSION), []);
});

test("appendOverlayHistory records an entry that reads back", async () => {
  const stateDir = await tempStateDir();
  await appendOverlayHistory(stateDir, sampleEntry());
  const entries = await readOverlayHistory(stateDir, SESSION);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.planId, "plan-1");
  assert.equal(entries[0]!.savedChars, 4096);
  assert.ok(entries[0]!.storedAt);
});

test("entries accumulate in order (append-only history)", async () => {
  const stateDir = await tempStateDir();
  await appendOverlayHistory(stateDir, sampleEntry({ planId: "plan-1", nextRevision: "rev-1" }));
  await appendOverlayHistory(stateDir, sampleEntry({ planId: "plan-2", nextRevision: "rev-2" }));
  await appendOverlayHistory(stateDir, sampleEntry({ planId: "plan-3", nextRevision: "rev-3" }));
  const entries = await readOverlayHistory(stateDir, SESSION);
  assert.deepEqual(entries.map((e: { planId: string }) => e.planId), ["plan-1", "plan-2", "plan-3"]);
});

test("history survives a fresh read (persistence across restart)", async () => {
  const stateDir = await tempStateDir();
  await appendOverlayHistory(stateDir, sampleEntry({ planId: "plan-restart" }));
  const entries = await readOverlayHistory(stateDir, SESSION);
  assert.equal(entries[0]!.planId, "plan-restart");
});

test("malformed lines are skipped, valid ones still read", async () => {
  const stateDir = await tempStateDir();
  await appendOverlayHistory(stateDir, sampleEntry({ planId: "plan-good" }));
  // corrupt the file by appending a broken line
  await writeFile(
    join(stateDir, "claude-context", "sessions", SESSION, "overlay-history.jsonl"),
    JSON.stringify({ schemaVersion: 1, storedAt: "x", sessionId: SESSION, planId: "plan-good", previousRevision: "rev-0", nextRevision: "rev-1", removedItemIds: [], savedChars: 0, relocated: false }) + "\n{ broken\n",
    "utf8",
  );
  const entries = await readOverlayHistory(stateDir, SESSION);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.planId, "plan-good");
});
