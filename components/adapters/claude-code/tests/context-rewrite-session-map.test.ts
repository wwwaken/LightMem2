import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readSessionMap,
  lookupRealSessionId,
  recordSessionMapping,
} from "../src/context-rewrite/session-map.js";

async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lightmem2-session-map-"));
}

test("readSessionMap returns empty map when file is missing", async () => {
  const stateDir = await tempStateDir();
  assert.deepEqual(await readSessionMap(stateDir), {});
});

test("recordSessionMapping persists a synth->real binding", async () => {
  const stateDir = await tempStateDir();
  await recordSessionMapping(stateDir, "claude-synth-abc", "real-123");
  assert.equal(await lookupRealSessionId(stateDir, "claude-synth-abc"), "real-123");
});

test("mapping survives a fresh read (persistence across restart)", async () => {
  const stateDir = await tempStateDir();
  await recordSessionMapping(stateDir, "claude-synth-xyz", "real-999");
  // simulate a restart: a brand-new read call with no in-memory state
  const map = await readSessionMap(stateDir);
  assert.equal(map["claude-synth-xyz"], "real-999");
});

test("existing binding is not overwritten (stable anchor)", async () => {
  const stateDir = await tempStateDir();
  await recordSessionMapping(stateDir, "claude-synth-1", "real-first");
  await recordSessionMapping(stateDir, "claude-synth-1", "real-second");
  assert.equal(await lookupRealSessionId(stateDir, "claude-synth-1"), "real-first");
});

test("corrupted map file is treated as empty (fail-open)", async () => {
  const stateDir = await tempStateDir();
  await mkdir(join(stateDir, "context-rewrite"), { recursive: true });
  await writeFile(join(stateDir, "context-rewrite", "session-map.json"), "{ not json", "utf8");
  assert.deepEqual(await readSessionMap(stateDir), {});
  // and a record after corruption still works (overwrites the bad file)
  await recordSessionMapping(stateDir, "claude-synth-recover", "real-ok");
  assert.equal(await lookupRealSessionId(stateDir, "claude-synth-recover"), "real-ok");
});

test("lookupRealSessionId returns undefined for unknown synth id", async () => {
  const stateDir = await tempStateDir();
  assert.equal(await lookupRealSessionId(stateDir, "claude-synth-none"), undefined);
});

test("concurrent bindings preserve every synthetic session mapping", async () => {
  const stateDir = await tempStateDir();
  const entries = Array.from({ length: 40 }, (_, index) => [
    `claude-synth-${index}`,
    `real-${index}`,
  ] as const);

  await Promise.all(entries.map(([syntheticId, realSessionId]) => (
    recordSessionMapping(stateDir, syntheticId, realSessionId)
  )));

  const map = await readSessionMap(stateDir);
  assert.equal(Object.keys(map).length, entries.length);
  for (const [syntheticId, realSessionId] of entries) {
    assert.equal(map[syntheticId], realSessionId);
  }
});

test("invalid mapping records are ignored", async () => {
  const stateDir = await tempStateDir();
  await recordSessionMapping(stateDir, "", "real-empty-key");
  await recordSessionMapping(stateDir, "claude-synth-empty-value", "   ");
  assert.deepEqual(await readSessionMap(stateDir), {});
});
