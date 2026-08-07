import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl } from "@lightmem2/host-adapter";
import {
  CODEX_REBASE_COOLDOWN_SCHEMA,
  type CodexRebaseCooldown,
  type CodexRebaseCooldownNotice,
} from "./types.js";

export type CodexRebaseCooldownJournalReadResult = {
  entries: CodexRebaseCooldown[];
  cooldowns: CodexRebaseCooldown[];
  malformedLineCount: number;
  readError?: string;
};

function encodedSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId.trim() || "unknown-session");
}

export function codexRebaseCooldownJournalPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "context-rewrite", "codex", "sessions", encodedSessionId(sessionId), "rebase-cooldowns.jsonl");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCodexRebaseCooldown(value: unknown): value is CodexRebaseCooldown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.schema === CODEX_REBASE_COOLDOWN_SCHEMA
    && typeof entry.sessionId === "string"
    && typeof entry.planId === "string"
    && typeof entry.reason === "string"
    && timestampMs(entry.startedAt) !== undefined
    && timestampMs(entry.expiresAt) !== undefined;
}

function collapseLatestCooldowns(entries: CodexRebaseCooldown[]): CodexRebaseCooldown[] {
  const latest = new Map<string, CodexRebaseCooldown>();
  for (const entry of entries) {
    latest.delete(entry.planId);
    latest.set(entry.planId, entry);
  }
  return Array.from(latest.values());
}

function cooldownNotice(entry: CodexRebaseCooldown): CodexRebaseCooldownNotice {
  return {
    planId: entry.planId,
    startedAt: entry.startedAt,
    expiresAt: entry.expiresAt,
    reason: entry.reason,
  };
}

function latestCooldownByPlan(
  cooldowns: CodexRebaseCooldown[],
  planId: string,
): CodexRebaseCooldown | undefined {
  for (let index = cooldowns.length - 1; index >= 0; index -= 1) {
    const entry = cooldowns[index];
    if (entry?.planId === planId) return entry;
  }
  return undefined;
}

export async function readCodexRebaseCooldownJournal(
  stateDir: string,
  sessionId: string,
): Promise<CodexRebaseCooldownJournalReadResult> {
  let raw: string;
  try {
    raw = await readFile(codexRebaseCooldownJournalPath(stateDir, sessionId), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { entries: [], cooldowns: [], malformedLineCount: 0 };
    }
    return {
      entries: [],
      cooldowns: [],
      malformedLineCount: 0,
      readError: error instanceof Error ? error.message : String(error),
    };
  }

  const entries: CodexRebaseCooldown[] = [];
  let malformedLineCount = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isCodexRebaseCooldown(parsed) && parsed.sessionId === sessionId) entries.push(parsed);
      else malformedLineCount += 1;
    } catch {
      malformedLineCount += 1;
    }
  }
  return {
    entries,
    cooldowns: collapseLatestCooldowns(entries),
    malformedLineCount,
  };
}

export async function appendCodexRebaseCooldown(params: {
  stateDir: string;
  sessionId: string;
  planId: string;
  reason: string;
  cooldownMs: number;
  startedAt?: string;
}): Promise<CodexRebaseCooldown> {
  const startedAt = params.startedAt ?? new Date().toISOString();
  const startedAtMs = timestampMs(startedAt);
  if (startedAtMs === undefined) throw new Error("Codex rebase cooldown requires a valid start time");
  const durationMs = Number.isFinite(params.cooldownMs) ? Math.max(0, params.cooldownMs) : 0;
  const entry: CodexRebaseCooldown = {
    schema: CODEX_REBASE_COOLDOWN_SCHEMA,
    sessionId: params.sessionId,
    planId: params.planId,
    reason: params.reason,
    startedAt,
    expiresAt: new Date(startedAtMs + durationMs).toISOString(),
  };
  await appendJsonl(codexRebaseCooldownJournalPath(params.stateDir, params.sessionId), entry);
  return entry;
}

export async function readActiveCodexRebaseCooldown(params: {
  stateDir: string;
  sessionId: string;
  planId: string;
  now?: string;
}): Promise<CodexRebaseCooldown | undefined> {
  const journal = await readCodexRebaseCooldownJournal(params.stateDir, params.sessionId);
  const cooldown = latestCooldownByPlan(journal.cooldowns, params.planId);
  if (!cooldown) return undefined;
  const nowMs = timestampMs(params.now ?? new Date().toISOString());
  const expiresAtMs = timestampMs(cooldown.expiresAt);
  if (nowMs === undefined || expiresAtMs === undefined || nowMs >= expiresAtMs) return undefined;
  return cooldown;
}

export function codexRebaseCooldownNotice(entry: CodexRebaseCooldown): CodexRebaseCooldownNotice {
  return cooldownNotice(entry);
}
