import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "@lightmem2/host-adapter";

const SESSION_MAP_SCHEMA_VERSION = 1 as const;

type SessionMapFile = {
  schemaVersion: typeof SESSION_MAP_SCHEMA_VERSION;
  mappings: Record<string, string>;
};

const sessionMapWriteTails = new Map<string, Promise<void>>();

async function withSessionMapWriteLock<T>(
  stateDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const path = sessionMapPath(stateDir);
  const previous = sessionMapWriteTails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionMapWriteTails.set(path, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (sessionMapWriteTails.get(path) === current) {
      sessionMapWriteTails.delete(path);
    }
  }
}

function sessionMapPath(stateDir: string): string {
  return join(stateDir, "context-rewrite", "session-map.json");
}

function isValidMapFile(value: unknown): value is SessionMapFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion === SESSION_MAP_SCHEMA_VERSION &&
    typeof record.mappings === "object" &&
    record.mappings !== null &&
    !Array.isArray(record.mappings)
  ) {
    return Object.entries(record.mappings).every(([key, realSessionId]) => (
      key.trim().length > 0
      && typeof realSessionId === "string"
      && realSessionId.trim().length > 0
    ));
  }
  return false;
}

/**
 * Read the persisted synthetic->real session id map. Returns an empty map when
 * the file is missing or corrupted (fail-open, consistent with the overlay's
 * bypass philosophy).
 */
export async function readSessionMap(
  stateDir: string,
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(sessionMapPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidMapFile(parsed)) return {};
    return { ...parsed.mappings };
  } catch {
    return {};
  }
}

/**
 * Look up the persisted real session id for a synthetic id, if one was recorded.
 */
export async function lookupRealSessionId(
  stateDir: string,
  syntheticId: string,
): Promise<string | undefined> {
  const map = await readSessionMap(stateDir);
  const real = Object.prototype.hasOwnProperty.call(map, syntheticId)
    ? map[syntheticId]
    : undefined;
  return typeof real === "string" && real.trim().length > 0 ? real : undefined;
}

/**
 * Persist a synthetic->real session id binding. The binding is stable: once a
 * synthetic id resolves to a real id it is not overwritten, so the overlay keeps
 * a fixed anchor even if the "latest" session later changes. Fails open (never
 * throws) so a write error cannot break request forwarding.
 */
export async function recordSessionMapping(
  stateDir: string,
  syntheticId: string,
  realSessionId: string,
): Promise<void> {
  if (!syntheticId.trim() || !realSessionId.trim()) return;
  await withSessionMapWriteLock(stateDir, async () => {
    try {
      const map = await readSessionMap(stateDir);
      if (Object.prototype.hasOwnProperty.call(map, syntheticId)) return;
      map[syntheticId] = realSessionId;
      await writeJsonFileAtomic(sessionMapPath(stateDir), {
        schemaVersion: SESSION_MAP_SCHEMA_VERSION,
        mappings: map,
      });
    } catch {
      // fail-open: a persistence error must not affect request handling
    }
  });
}
