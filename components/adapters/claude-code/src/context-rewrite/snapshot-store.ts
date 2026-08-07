import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@lightmem2/host-adapter";
import type { ModelContextSnapshot } from "@lightmem2/host-adapter";

const SNAPSHOT_STORE_SCHEMA_VERSION = 1 as const;

function sessionDir(stateDir: string, sessionId: string): string {
  return join(stateDir, "claude-context", "sessions", sessionId);
}
function latestSnapshotPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), "latest-snapshot.json");
}
function itemFingerprintsPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), "item-fingerprints.json");
}

type StoredSnapshotFile = {
  schemaVersion: typeof SNAPSHOT_STORE_SCHEMA_VERSION;
  storedAt: string;
  snapshot: ModelContextSnapshot;
};

type ItemFingerprintsFile = {
  schemaVersion: typeof SNAPSHOT_STORE_SCHEMA_VERSION;
  storedAt: string;
  revision: string;
  fingerprints: Record<string, string>;
};

/**
 * Persist the latest complete snapshot for a session, overwriting any previous
 * one (we keep only the latest, never accumulate duplicate history — CLA-01).
 * Also writes an item-fingerprints map so the overlay can prove item identity
 * across restarts without re-reading the whole snapshot. Fails open: a write
 * error never throws, so it cannot break request handling.
 */
export async function saveLatestClaudeSnapshot(
  stateDir: string,
  sessionId: string,
  snapshot: ModelContextSnapshot,
): Promise<void> {
  try {
    await mkdir(sessionDir(stateDir, sessionId), { recursive: true });
    const storedAt = new Date().toISOString();
    const fingerprints: Record<string, string> = {};
    for (const item of snapshot.items) {
      fingerprints[item.stableId] = item.fingerprint;
    }
    await writeJsonFileAtomic(latestSnapshotPath(stateDir, sessionId), {
      schemaVersion: SNAPSHOT_STORE_SCHEMA_VERSION,
      storedAt,
      snapshot,
    } satisfies StoredSnapshotFile);
    await writeJsonFileAtomic(itemFingerprintsPath(stateDir, sessionId), {
      schemaVersion: SNAPSHOT_STORE_SCHEMA_VERSION,
      storedAt,
      revision: snapshot.revision,
      fingerprints,
    } satisfies ItemFingerprintsFile);
  } catch {
    // fail-open: persistence errors must not affect request handling
  }
}

/**
 * Read back the latest persisted snapshot for a session, or undefined when it
 * is missing or corrupted (fail-open).
 */
export async function readLatestClaudeSnapshot(
  stateDir: string,
  sessionId: string,
): Promise<ModelContextSnapshot | undefined> {
  try {
    const raw = await readFile(latestSnapshotPath(stateDir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed
      || typeof parsed !== "object"
      || (parsed as StoredSnapshotFile).schemaVersion !== SNAPSHOT_STORE_SCHEMA_VERSION
    ) {
      return undefined;
    }
    return (parsed as StoredSnapshotFile).snapshot;
  } catch {
    return undefined;
  }
}

/**
 * Read the persisted item-fingerprints map for a session, or an empty map when
 * missing or corrupted (fail-open).
 */
export async function readClaudeItemFingerprints(
  stateDir: string,
  sessionId: string,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(itemFingerprintsPath(stateDir, sessionId), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed
      || typeof parsed !== "object"
      || (parsed as ItemFingerprintsFile).schemaVersion !== SNAPSHOT_STORE_SCHEMA_VERSION
    ) {
      return {};
    }
    const fingerprints = (parsed as ItemFingerprintsFile).fingerprints;
    return fingerprints && typeof fingerprints === "object" ? { ...fingerprints } : {};
  } catch {
    return {};
  }
}
