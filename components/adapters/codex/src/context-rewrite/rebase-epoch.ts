import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { appendJsonl } from "@lightmem2/host-adapter";
import {
  CODEX_REBASE_EPOCH_SCHEMA,
  type CodexRebaseEpoch,
  type CodexRebaseAccounting,
  type CodexRebaseEpochStatus,
} from "./types.js";

export type CodexRebaseEpochJournalReadResult = {
  entries: CodexRebaseEpoch[];
  epochs: CodexRebaseEpoch[];
  malformedLineCount: number;
  readError?: string;
};

export type CodexRebaseSessionLock = {
  lockPath: string;
  release(): Promise<void>;
};

type CodexRebaseLockOwner = {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

const DEFAULT_REBASE_LOCK_STALE_MS = 30 * 60 * 1000;

function encodedSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId.trim() || "unknown-session");
}

export function codexRebaseEpochJournalPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "context-rewrite", "codex", "sessions", encodedSessionId(sessionId), "rebase-epochs.jsonl");
}

export function codexRebaseSessionLockPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "context-rewrite", "codex", "sessions", encodedSessionId(sessionId), "rebase.lock");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isStatus(value: unknown): value is CodexRebaseEpochStatus {
  return value === "pending" || value === "committed" || value === "failed" || value === "rolled_back";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isIsoTimestamp(value: unknown): value is string {
  const parsed = timestampMs(value);
  return parsed !== undefined && new Date(parsed).toISOString() === value;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function asLockOwner(value: unknown): CodexRebaseLockOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  return typeof owner.token === "string" && owner.token.length > 0
    && typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.hostname === "string" && owner.hostname.length > 0
    && timestampMs(owner.createdAt) !== undefined
    ? owner as CodexRebaseLockOwner
    : undefined;
}

async function readLockOwner(lockPath: string): Promise<CodexRebaseLockOwner | undefined> {
  try {
    return asLockOwner(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

async function lockIsStale(params: {
  lockPath: string;
  staleAfterMs: number;
  nowMs: number;
}): Promise<boolean> {
  const owner = await readLockOwner(params.lockPath);
  if (owner) {
    if (owner.hostname === hostname()) return !isProcessAlive(owner.pid);
    return params.nowMs - (timestampMs(owner.createdAt) ?? params.nowMs) > params.staleAfterMs;
  }
  try {
    const lockStat = await stat(params.lockPath);
    return params.nowMs - lockStat.mtimeMs > params.staleAfterMs;
  } catch {
    return true;
  }
}

export async function acquireCodexRebaseSessionLock(params: {
  stateDir: string;
  sessionId: string;
  staleAfterMs?: number;
  nowMs?: number;
}): Promise<CodexRebaseSessionLock | undefined> {
  const lockPath = codexRebaseSessionLockPath(params.stateDir, params.sessionId);
  const recoveryPath = `${lockPath}.recovery`;
  const staleAfterMs = Math.max(1_000, params.staleAfterMs ?? DEFAULT_REBASE_LOCK_STALE_MS);
  const nowMs = params.nowMs ?? Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await stat(recoveryPath);
      return undefined;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (!await lockIsStale({ lockPath, staleAfterMs, nowMs })) return undefined;
      try {
        await mkdir(recoveryPath);
      } catch (recoveryError) {
        if (errorCode(recoveryError) !== "EEXIST") throw recoveryError;
        return undefined;
      }
      try {
        if (await lockIsStale({
          lockPath,
          staleAfterMs,
          nowMs: Date.now(),
        })) {
          await rm(lockPath, { recursive: true, force: true });
        }
      } finally {
        await rm(recoveryPath, { recursive: true, force: true });
      }
      continue;
    }

    const owner: CodexRebaseLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date(nowMs).toISOString(),
    };
    try {
      await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
    return {
      lockPath,
      async release() {
        try {
          const current = await readLockOwner(lockPath);
          if (current?.token === owner.token) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch {
          // A stale lock is safer than deleting a lock that may have changed ownership.
        }
      },
    };
  }
  return undefined;
}

function canonicalCodexRebaseAccounting(value: unknown): CodexRebaseAccounting | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (!isNonNegativeNumber(entry.plannedSavedChars)
    || !isNonNegativeNumber(entry.plannedSavedTokens)
    || !isNonNegativeNumber(entry.actuallyRemovedChars)
    || !isNonNegativeNumber(entry.actuallyRemovedTokens)
    || !isNonNegativeNumber(entry.rebaseReplayCostChars)
    || !isNonNegativeNumber(entry.rebaseReplayCostTokens)
    || !isNonNegativeNumber(entry.subsequentSavedCharsPerTurn)
    || !isNonNegativeNumber(entry.subsequentSavedTokensPerTurn)
    || !isNonNegativeNumber(entry.estimatorCostChars)
    || !isNonNegativeNumber(entry.estimatorCostTokens)
    || !isNonNegativeNumber(entry.fallbackExtraRequestCount)
    || !isNonNegativeNumber(entry.cacheColdMissCount)
    || (entry.breakEvenTurn !== undefined && !isNonNegativeNumber(entry.breakEvenTurn))) {
    return undefined;
  }
  return {
    plannedSavedChars: entry.plannedSavedChars,
    plannedSavedTokens: entry.plannedSavedTokens,
    actuallyRemovedChars: entry.actuallyRemovedChars,
    actuallyRemovedTokens: entry.actuallyRemovedTokens,
    rebaseReplayCostChars: entry.rebaseReplayCostChars,
    rebaseReplayCostTokens: entry.rebaseReplayCostTokens,
    subsequentSavedCharsPerTurn: entry.subsequentSavedCharsPerTurn,
    subsequentSavedTokensPerTurn: entry.subsequentSavedTokensPerTurn,
    estimatorCostChars: entry.estimatorCostChars,
    estimatorCostTokens: entry.estimatorCostTokens,
    fallbackExtraRequestCount: entry.fallbackExtraRequestCount,
    cacheColdMissCount: entry.cacheColdMissCount,
    ...(entry.breakEvenTurn !== undefined ? { breakEvenTurn: entry.breakEvenTurn } : {}),
  };
}

function canonicalCodexRebaseEpoch(value: unknown): CodexRebaseEpoch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.schema !== CODEX_REBASE_EPOCH_SCHEMA
    || !isNonBlankString(entry.epochId)
    || !isNonBlankString(entry.sessionId)
    || !isNonBlankString(entry.planId)
    || !isNonBlankString(entry.oldPreviousResponseId)
    || !isNonBlankString(entry.oldRevision)
    || !isStatus(entry.status)
    || !isIsoTimestamp(entry.createdAt)
    || !isIsoTimestamp(entry.updatedAt)
    || (entry.journalCommittedAt !== undefined && !isIsoTimestamp(entry.journalCommittedAt))
    || (entry.newResponseId !== undefined && !isNonBlankString(entry.newResponseId))
    || (entry.newRevision !== undefined && !isNonBlankString(entry.newRevision))
    || (entry.failureReason !== undefined && !isNonBlankString(entry.failureReason))) {
    return undefined;
  }
  const accounting = entry.accounting === undefined
    ? undefined
    : canonicalCodexRebaseAccounting(entry.accounting);
  if (entry.accounting !== undefined && !accounting) return undefined;
  return {
    schema: CODEX_REBASE_EPOCH_SCHEMA,
    epochId: entry.epochId,
    sessionId: entry.sessionId,
    planId: entry.planId,
    oldPreviousResponseId: entry.oldPreviousResponseId,
    ...(entry.newResponseId !== undefined ? { newResponseId: entry.newResponseId } : {}),
    oldRevision: entry.oldRevision,
    ...(entry.newRevision !== undefined ? { newRevision: entry.newRevision } : {}),
    status: entry.status,
    ...(entry.failureReason !== undefined ? { failureReason: entry.failureReason } : {}),
    ...(accounting ? { accounting } : {}),
    ...(entry.journalCommittedAt !== undefined ? { journalCommittedAt: entry.journalCommittedAt } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function collapseLatestEpochs(entries: CodexRebaseEpoch[]): CodexRebaseEpoch[] {
  const latest = new Map<string, CodexRebaseEpoch>();
  for (const entry of entries) {
    latest.delete(entry.epochId);
    latest.set(entry.epochId, entry);
  }
  return Array.from(latest.values());
}

function latestEpochById(entries: CodexRebaseEpoch[], epochId: string): CodexRebaseEpoch | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.epochId === epochId) return entry;
  }
  return undefined;
}

function latestEpoch(epochs: CodexRebaseEpoch[]): CodexRebaseEpoch | undefined {
  return epochs.at(-1);
}

function throwIfReadFailed(journal: CodexRebaseEpochJournalReadResult): void {
  if (journal.readError) throw new Error(`Unable to read Codex rebase epoch journal: ${journal.readError}`);
}

export async function readCodexRebaseEpochJournal(
  stateDir: string,
  sessionId: string,
): Promise<CodexRebaseEpochJournalReadResult> {
  let raw: string;
  try {
    raw = await readFile(codexRebaseEpochJournalPath(stateDir, sessionId), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { entries: [], epochs: [], malformedLineCount: 0 };
    }
    return {
      entries: [],
      epochs: [],
      malformedLineCount: 0,
      readError: error instanceof Error ? error.message : String(error),
    };
  }

  const entries: CodexRebaseEpoch[] = [];
  let malformedLineCount = 0;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const entry = canonicalCodexRebaseEpoch(parsed);
      if (entry && entry.sessionId === sessionId) entries.push(entry);
      else malformedLineCount += 1;
    } catch {
      malformedLineCount += 1;
    }
  }
  return {
    entries,
    epochs: collapseLatestEpochs(entries),
    malformedLineCount,
  };
}

export async function appendPendingCodexRebaseEpoch(params: {
  stateDir: string;
  sessionId: string;
  planId: string;
  oldPreviousResponseId: string;
  oldRevision: string;
  epochId?: string;
  accounting?: CodexRebaseAccounting;
  createdAt?: string;
}): Promise<CodexRebaseEpoch> {
  const epochId = params.epochId ?? `epoch-${randomUUID()}`;
  const current = await readCodexRebaseEpochJournal(params.stateDir, params.sessionId);
  throwIfReadFailed(current);
  const existing = latestEpochById(current.entries, epochId);
  if (existing) {
    if (existing.status !== "pending") throw new Error(`Codex rebase epoch already terminal: ${epochId}`);
    if (
      existing.sessionId !== params.sessionId
    || existing.planId !== params.planId
      || existing.oldPreviousResponseId !== params.oldPreviousResponseId
      || existing.oldRevision !== params.oldRevision
    ) {
      throw new Error(`Codex rebase epoch mismatch: ${epochId}`);
    }
    if (params.accounting && JSON.stringify(existing.accounting) !== JSON.stringify(params.accounting)) {
      throw new Error(`Codex rebase epoch accounting mismatch: ${epochId}`);
    }
    return existing;
  }

  const createdAt = params.createdAt ?? new Date().toISOString();
  if (!isIsoTimestamp(createdAt)
    || !isNonBlankString(params.sessionId)
    || !isNonBlankString(params.planId)
    || !isNonBlankString(params.epochId)
    || !isNonBlankString(params.oldPreviousResponseId)
    || !isNonBlankString(params.oldRevision)) {
    throw new Error("Codex rebase epoch requires valid identity and create time");
  }
  const entry: CodexRebaseEpoch = {
    schema: CODEX_REBASE_EPOCH_SCHEMA,
    epochId,
    sessionId: params.sessionId,
    planId: params.planId,
    oldPreviousResponseId: params.oldPreviousResponseId,
    oldRevision: params.oldRevision,
    status: "pending",
    accounting: params.accounting,
    createdAt,
    updatedAt: createdAt,
  };
  await appendJsonl(codexRebaseEpochJournalPath(params.stateDir, params.sessionId), entry);
  return entry;
}

async function transitionCodexRebaseEpoch(params: {
  stateDir: string;
  sessionId: string;
  epochId: string;
  status: Exclude<CodexRebaseEpochStatus, "pending">;
  newResponseId?: string;
  newRevision?: string;
  failureReason?: string;
  accounting?: CodexRebaseAccounting;
  journalCommittedAt?: string;
  updatedAt?: string;
}): Promise<CodexRebaseEpoch> {
  const current = await readCodexRebaseEpochJournal(params.stateDir, params.sessionId);
  throwIfReadFailed(current);
  const existing = latestEpochById(current.entries, params.epochId);
  if (!existing) throw new Error(`Unknown Codex rebase epoch: ${params.epochId}`);
  if (existing.status !== "pending") {
    if (existing.status !== params.status) return existing;
    if (params.newResponseId !== undefined && params.newResponseId !== existing.newResponseId) {
      throw new Error(`Codex rebase epoch response id conflict: ${params.epochId}`);
    }
    if (params.newRevision !== undefined && params.newRevision !== existing.newRevision) {
      throw new Error(`Codex rebase epoch revision conflict: ${params.epochId}`);
    }
    if (params.failureReason !== undefined && params.failureReason !== existing.failureReason) {
      throw new Error(`Codex rebase epoch failure conflict: ${params.epochId}`);
    }
    if (params.accounting && JSON.stringify(params.accounting) !== JSON.stringify(existing.accounting)) {
      throw new Error(`Codex rebase epoch accounting conflict: ${params.epochId}`);
    }
    return existing;
  }
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  if (!isIsoTimestamp(updatedAt)) throw new Error("Codex rebase epoch requires a valid update time");

  const entry: CodexRebaseEpoch = {
    ...existing,
    status: params.status,
    newResponseId: params.newResponseId,
    newRevision: params.newRevision,
    failureReason: params.failureReason,
    accounting: params.accounting ?? existing.accounting,
    journalCommittedAt: params.journalCommittedAt ?? existing.journalCommittedAt,
    updatedAt,
  };
  await appendJsonl(codexRebaseEpochJournalPath(params.stateDir, params.sessionId), entry);
  return entry;
}

export async function commitCodexRebaseEpoch(params: {
  stateDir: string;
  sessionId: string;
  epochId: string;
  newResponseId: string;
  newRevision?: string;
  accounting?: CodexRebaseAccounting;
  journalCommittedAt?: string;
  updatedAt?: string;
}): Promise<CodexRebaseEpoch> {
  if (!params.newResponseId) throw new Error("Codex rebase epoch commit requires a response id");
  return transitionCodexRebaseEpoch({
    ...params,
    status: "committed",
  });
}

export async function failCodexRebaseEpoch(params: {
  stateDir: string;
  sessionId: string;
  epochId: string;
  failureReason: string;
  accounting?: CodexRebaseAccounting;
  updatedAt?: string;
}): Promise<CodexRebaseEpoch> {
  return transitionCodexRebaseEpoch({
    ...params,
    status: "failed",
  });
}

export async function rollbackCodexRebaseEpoch(params: {
  stateDir: string;
  sessionId: string;
  epochId: string;
  failureReason: string;
  accounting?: CodexRebaseAccounting;
  updatedAt?: string;
}): Promise<CodexRebaseEpoch> {
  return transitionCodexRebaseEpoch({
    ...params,
    status: "rolled_back",
  });
}

export async function readPendingCodexRebaseEpochs(params: {
  stateDir: string;
  sessionId: string;
}): Promise<CodexRebaseEpoch[]> {
  const journal = await readCodexRebaseEpochJournal(params.stateDir, params.sessionId);
  throwIfReadFailed(journal);
  return journal.epochs.filter((entry) => entry.status === "pending");
}

export async function failPendingCodexRebaseEpochsAfterRestart(params: {
  stateDir: string;
  sessionId: string;
  updatedAt?: string;
}): Promise<CodexRebaseEpoch[]> {
  const pending = await readPendingCodexRebaseEpochs(params);
  const failed: CodexRebaseEpoch[] = [];
  for (const entry of pending) {
    failed.push(await failCodexRebaseEpoch({
      stateDir: params.stateDir,
      sessionId: params.sessionId,
      epochId: entry.epochId,
      failureReason: "process_restarted",
      updatedAt: params.updatedAt,
    }));
  }
  return failed;
}

export async function readLatestCodexRebaseEpoch(params: {
  stateDir: string;
  sessionId: string;
}): Promise<CodexRebaseEpoch | undefined> {
  const journal = await readCodexRebaseEpochJournal(params.stateDir, params.sessionId);
  throwIfReadFailed(journal);
  return latestEpoch(journal.epochs);
}
