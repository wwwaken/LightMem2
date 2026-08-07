import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const OVERLAY_HISTORY_SCHEMA_VERSION = 1 as const;

export type OverlayHistoryEntry = {
  schemaVersion: typeof OVERLAY_HISTORY_SCHEMA_VERSION;
  storedAt: string;
  sessionId: string;
  planId: string;
  previousRevision: string;
  nextRevision: string;
  removedItemIds: string[];
  savedChars: number;
  relocated: boolean;
};

function sessionDir(stateDir: string, sessionId: string): string {
  return join(stateDir, "claude-context", "sessions", sessionId);
}

function overlayHistoryPath(stateDir: string, sessionId: string): string {
  return join(sessionDir(stateDir, sessionId), "overlay-history.jsonl");
}

export async function appendOverlayHistory(
  stateDir: string,
  entry: Omit<OverlayHistoryEntry, "schemaVersion" | "storedAt">,
): Promise<void> {
  try {
    await mkdir(sessionDir(stateDir, entry.sessionId), { recursive: true });
    const record: OverlayHistoryEntry = {
      schemaVersion: OVERLAY_HISTORY_SCHEMA_VERSION,
      storedAt: new Date().toISOString(),
      ...entry,
    };
    await appendFile(overlayHistoryPath(stateDir, entry.sessionId), JSON.stringify(record) + "\n", "utf8");
  } catch {
    // fail-open: history logging must not affect request handling
  }
}

export async function readOverlayHistory(
  stateDir: string,
  sessionId: string,
): Promise<OverlayHistoryEntry[]> {
  try {
    const raw = await readFile(overlayHistoryPath(stateDir, sessionId), "utf8");
    const entries: OverlayHistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as OverlayHistoryEntry;
        if (parsed && parsed.schemaVersion === OVERLAY_HISTORY_SCHEMA_VERSION) {
          entries.push(parsed);
        }
      } catch {
        // skip malformed line, keep reading
      }
    }
    return entries;
  } catch {
    return [];
  }
}
