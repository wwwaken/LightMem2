import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireCodexRebaseSessionLock,
  appendPendingCodexRebaseEpoch,
  CODEX_REBASE_EPOCH_SCHEMA,
  codexRebaseEpochJournalPath,
  codexRebaseSessionLockPath,
  commitCodexRebaseEpoch,
  executeCodexRebaseWithFallback,
  failCodexRebaseEpoch,
  failPendingCodexRebaseEpochsAfterRestart,
  readCodexRebaseEpochJournal,
  readLatestCodexRebaseEpoch,
  readPendingCodexRebaseEpochs,
  type JsonObject,
} from "../src/context-rewrite/index.js";

async function withTempState(
  fn: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-epoch-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("CDR-03 Rebase Epoch writes pending records and commits only with a response id", async () => {
  await withTempState(async (stateDir) => {
    const pending = await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-1",
      epochId: "epoch-1",
      planId: "plan-1",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
      createdAt: "2026-07-28T10:00:00.000Z",
    });
    assert.equal(pending.status, "pending");

    await assert.rejects(() => commitCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-1",
      epochId: "epoch-1",
      newResponseId: "",
    }), /response id/);

    const committed = await commitCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-1",
      epochId: "epoch-1",
      newResponseId: "resp-new",
      newRevision: "rev-new",
      updatedAt: "2026-07-28T10:00:01.000Z",
    });

    assert.equal(committed.status, "committed");
    assert.equal(committed.newResponseId, "resp-new");
    assert.equal(committed.oldPreviousResponseId, "resp-old");
    assert.deepEqual(await readPendingCodexRebaseEpochs({ stateDir, sessionId: "codex-session-1" }), []);

    const journal = await readCodexRebaseEpochJournal(stateDir, "codex-session-1");
    assert.equal(journal.entries.length, 2);
    assert.equal(journal.epochs.length, 1);
    assert.equal(journal.epochs[0]?.status, "committed");
  });
});

test("CDR-01 Rebase Epoch session lock excludes concurrent owners and releases cleanly", async () => {
  await withTempState(async (stateDir) => {
    const first = await acquireCodexRebaseSessionLock({ stateDir, sessionId: "codex-session-lock" });
    assert.ok(first);
    assert.equal(
      await acquireCodexRebaseSessionLock({ stateDir, sessionId: "codex-session-lock" }),
      undefined,
    );

    await first.release();
    const next = await acquireCodexRebaseSessionLock({ stateDir, sessionId: "codex-session-lock" });
    assert.ok(next);
    await next.release();
  });
});

test("CDR-01 Rebase Epoch session lock recovers malformed stale lock directories", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-stale-lock";
    const lockPath = codexRebaseSessionLockPath(stateDir, sessionId);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), "{malformed", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const recovered = await acquireCodexRebaseSessionLock({
      stateDir,
      sessionId,
      staleAfterMs: 1_000,
    });
    assert.ok(recovered);
    await recovered.release();
  });
});

test("CDR-01 Rebase Epoch serializes stale-lock recovery claims", async () => {
  await withTempState(async (stateDir) => {
    const sessionId = "codex-session-stale-race";
    const lockPath = codexRebaseSessionLockPath(stateDir, sessionId);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), "{malformed", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    const locks = await Promise.all(Array.from({ length: 8 }, () =>
      acquireCodexRebaseSessionLock({ stateDir, sessionId, staleAfterMs: 1_000 })));
    const acquired = locks.filter((lock): lock is NonNullable<typeof lock> => Boolean(lock));
    assert.equal(acquired.length, 1);
    await Promise.all(acquired.map((lock) => lock.release()));
  });
});

test("CDR-03 Rebase Epoch marks restored pending epochs failed after restart", async () => {
  await withTempState(async (stateDir) => {
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-restart",
      epochId: "epoch-pending",
      planId: "plan-restart",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
    });

    const restored = await readPendingCodexRebaseEpochs({
      stateDir,
      sessionId: "codex-session-restart",
    });
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.epochId, "epoch-pending");
    assert.equal(restored[0]?.status, "pending");

    const recovered = await failPendingCodexRebaseEpochsAfterRestart({
      stateDir,
      sessionId: "codex-session-restart",
      updatedAt: "2026-07-30T10:00:00.000Z",
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "failed");
    assert.equal(recovered[0]?.failureReason, "process_restarted");
    assert.deepEqual(await readPendingCodexRebaseEpochs({
      stateDir,
      sessionId: "codex-session-restart",
    }), []);
  });
});

test("CDR-03 Rebase Epoch rejects mismatched or terminal epoch reuse", async () => {
  await withTempState(async (stateDir) => {
    const params = {
      stateDir,
      sessionId: "codex-session-reuse",
      epochId: "epoch-reuse",
      planId: "plan-reuse",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
    };
    await appendPendingCodexRebaseEpoch(params);
    await assert.rejects(() => appendPendingCodexRebaseEpoch({
      ...params,
      oldRevision: "rev-other",
    }), /epoch mismatch/);

    await commitCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-reuse",
      epochId: "epoch-reuse",
      newResponseId: "resp-new",
    });
    await assert.rejects(() => appendPendingCodexRebaseEpoch(params), /already terminal/);
  });
});

test("CDR-03 Rebase Epoch marks failed epochs and keeps terminal records immutable", async () => {
  await withTempState(async (stateDir) => {
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-failed",
      epochId: "epoch-failed",
      planId: "plan-failed",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
    });
    const failed = await failCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-failed",
      epochId: "epoch-failed",
      failureReason: "rebase_upstream_error",
    });
    assert.equal(failed.status, "failed");

    const unchanged = await commitCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-failed",
      epochId: "epoch-failed",
      newResponseId: "resp-late",
    });
    assert.equal(unchanged.status, "failed");
    assert.equal(unchanged.newResponseId, undefined);

    const journal = await readCodexRebaseEpochJournal(stateDir, "codex-session-failed");
    assert.equal(journal.entries.length, 2);
    assert.equal((await readLatestCodexRebaseEpoch({ stateDir, sessionId: "codex-session-failed" }))?.status, "failed");
  });
});

test("CDR-03 Rebase Epoch rejects conflicting reuse of the same terminal state", async () => {
  await withTempState(async (stateDir) => {
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-terminal-conflict",
      epochId: "epoch-terminal-conflict",
      planId: "plan-terminal-conflict",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
    });
    await commitCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-terminal-conflict",
      epochId: "epoch-terminal-conflict",
      newResponseId: "resp-new",
    });

    await assert.rejects(() => commitCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-terminal-conflict",
      epochId: "epoch-terminal-conflict",
      newResponseId: "resp-other",
    }), /response id conflict/);
  });
});

test("CDR-03 Rebase Epoch isolates malformed rows without losing valid epochs", async () => {
  await withTempState(async (stateDir) => {
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-malformed",
      epochId: "epoch-valid",
      planId: "plan-valid",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
    });
    await appendFile(
      codexRebaseEpochJournalPath(stateDir, "codex-session-malformed"),
      [
        "not-json",
        "{\"schema\":\"wrong\"}",
        JSON.stringify({
          schema: CODEX_REBASE_EPOCH_SCHEMA,
          epochId: "epoch-other-session",
          sessionId: "codex-session-other",
          planId: "plan-other",
          oldPreviousResponseId: "resp-other",
          oldRevision: "rev-other",
          status: "pending",
          createdAt: "2026-07-28T10:00:00.000Z",
          updatedAt: "2026-07-28T10:00:00.000Z",
        }),
        JSON.stringify({
          schema: CODEX_REBASE_EPOCH_SCHEMA,
          epochId: "epoch-invalid-time",
          sessionId: "codex-session-malformed",
          planId: "plan-invalid-time",
          oldPreviousResponseId: "resp-old",
          oldRevision: "rev-old",
          status: "pending",
          createdAt: "bad-time",
          updatedAt: "2026-07-28T10:00:00.000Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const journal = await readCodexRebaseEpochJournal(stateDir, "codex-session-malformed");
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.epochs.length, 1);
    assert.equal(journal.malformedLineCount, 4);
  });
});

test("CDR-03 Rebase Epoch fails closed when the journal cannot be read", async () => {
  await withTempState(async (stateDir) => {
    const journalPath = codexRebaseEpochJournalPath(stateDir, "codex-session-read-error");
    await mkdir(journalPath, { recursive: true });
    await assert.rejects(
      () => readLatestCodexRebaseEpoch({
        stateDir,
        sessionId: "codex-session-read-error",
      }),
      /Unable to read Codex rebase epoch journal/,
    );
  });
});

test("CDR-03 Rebase Epoch integrates with fallback commit and rollback outcomes", async () => {
  await withTempState(async (stateDir) => {
    let statusBeforeCommit: string | undefined;
    const committed = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-fallback",
      planId: "plan-commit",
      epochId: "epoch-commit",
      originalPayload: { previous_response_id: "resp-old", input: [] },
      rebasedPayload: { input: [] },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
        newRevision: "rev-new",
      },
      async beforeCommit({ newResponseId }) {
        assert.equal(newResponseId, "resp-new");
        statusBeforeCommit = (await readLatestCodexRebaseEpoch({
          stateDir,
          sessionId: "codex-session-fallback",
        }))?.status;
      },
      async sendUpstream() {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({ id: "resp-new", output: [] }),
        };
      },
    });
    assert.equal(committed.outcome, "committed");
    assert.equal(statusBeforeCommit, "pending");
    assert.equal(committed.epoch?.status, "committed");
    assert.equal(committed.epoch?.newResponseId, "resp-new");

    let calls = 0;
    const rolledBack = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-fallback",
      planId: "plan-rollback",
      epochId: "epoch-rollback",
      originalPayload: { previous_response_id: "resp-old", input: [] },
      rebasedPayload: { input: [] },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
      },
      async sendUpstream() {
        calls += 1;
        return calls === 1
          ? { status: 400, headers: {}, text: JSON.stringify({ error: "rejected" }) }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.equal(rolledBack.outcome, "bypassed");
    assert.equal(rolledBack.epoch?.status, "rolled_back");

    const journal = await readCodexRebaseEpochJournal(stateDir, "codex-session-fallback");
    assert.deepEqual(journal.epochs.map((entry) => entry.status), ["committed", "rolled_back"]);
  });
});

test("CDR-03 Rebase Epoch falls back when response journaling fails before commit", async () => {
  await withTempState(async (stateDir) => {
    const sentPayloads: JsonObject[] = [];
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-journal-failure",
      planId: "plan-journal-failure",
      epochId: "epoch-journal-failure",
      originalPayload: { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
      rebasedPayload: { input: [{ role: "user", content: "rebased" }] },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
        newRevision: "rev-new",
      },
      async beforeCommit() {
        throw new Error("journal unavailable");
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return sentPayloads.length === 1
          ? { status: 200, headers: {}, text: JSON.stringify({ id: "resp-rebased", output: [] }) }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });

    assert.equal(result.outcome, "bypassed");
    assert.equal(result.cooldown?.reason, "rebase_journal_error");
    assert.equal(result.epoch?.status, "rolled_back");
    assert.equal(result.epoch?.failureReason, "rebase_journal_error");
    assert.equal(sentPayloads.length, 2);
    assert.equal(sentPayloads[1]?.previous_response_id, "resp-old");
  });
});

test("CDR-01 Rebase Epoch bypasses when another epoch is already in flight", async () => {
  await withTempState(async (stateDir) => {
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-in-flight",
      epochId: "epoch-existing",
      planId: "plan-existing",
      oldPreviousResponseId: "resp-old-existing",
      oldRevision: "rev-existing",
    });
    const sentPayloads: JsonObject[] = [];

    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-in-flight",
      planId: "plan-new",
      epochId: "epoch-new",
      originalPayload: { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
      rebasedPayload: { input: [{ role: "user", content: "rebased" }] },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });

    assert.equal(result.outcome, "bypassed");
    assert.equal(result.rebaseResponse, undefined);
    assert.equal(result.cooldown, undefined);
    assert.deepEqual(sentPayloads, [
      { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
    ]);
    assert.deepEqual(
      (await readPendingCodexRebaseEpochs({ stateDir, sessionId: "codex-session-in-flight" }))
        .map((entry) => entry.epochId),
      ["epoch-existing"],
    );
  });
});

test("CDR-01 Rebase Epoch allows different sessions to rebase concurrently", async () => {
  await withTempState(async (stateDir) => {
    let releaseBoth!: () => void;
    const bothCanFinish = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    let signalFirstStarted!: () => void;
    let signalSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      signalSecondStarted = resolve;
    });

    const run = (sessionId: string, epochId: string, signalStarted: () => void) =>
      executeCodexRebaseWithFallback({
        sessionId,
        planId: `plan-${sessionId}`,
        epochId,
        originalPayload: { previous_response_id: `resp-old-${sessionId}`, input: [] },
        rebasedPayload: { input: [{ role: "user", content: `rebased-${sessionId}` }] },
        epochStore: {
          stateDir,
          oldPreviousResponseId: `resp-old-${sessionId}`,
          oldRevision: `rev-old-${sessionId}`,
        },
        async sendUpstream() {
          signalStarted();
          await bothCanFinish;
          return { status: 200, headers: {}, text: JSON.stringify({ id: `resp-new-${sessionId}`, output: [] }) };
        },
      });

    const first = run("session-a", "epoch-a", signalFirstStarted);
    const second = run("session-b", "epoch-b", signalSecondStarted);
    await Promise.all([firstStarted, secondStarted]);
    releaseBoth();

    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.outcome), ["committed", "committed"]);
    assert.equal((await readLatestCodexRebaseEpoch({ stateDir, sessionId: "session-a" }))?.status, "committed");
    assert.equal((await readLatestCodexRebaseEpoch({ stateDir, sessionId: "session-b" }))?.status, "committed");
  });
});

test("CDR-01 Rebase Epoch serializes concurrent attempts for the same session", async () => {
  await withTempState(async (stateDir) => {
    const sentInputs: string[] = [];
    let releaseRebase: (() => void) | undefined;
    const rebaseBlocked = new Promise<void>((resolve) => {
      releaseRebase = resolve;
    });
    let firstRebaseStarted: (() => void) | undefined;
    const firstRebaseObserved = new Promise<void>((resolve) => {
      firstRebaseStarted = resolve;
    });
    const shared = {
      sessionId: "codex-session-concurrent",
      planId: "plan-concurrent",
      epochId: "epoch-concurrent",
      originalPayload: { input: [{ role: "user", content: "original" }] },
      rebasedPayload: { input: [{ role: "user", content: "rebased" }] },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
        newRevision: "rev-new",
      },
      async sendUpstream(payload: JsonObject) {
        const content = String((payload.input as JsonObject[] | undefined)?.[0]?.content ?? "");
        sentInputs.push(content);
        if (content === "rebased") {
          firstRebaseStarted?.();
          await rebaseBlocked;
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({ id: `resp-${content}`, status: "completed" }),
        };
      },
    };

    const first = executeCodexRebaseWithFallback(shared);
    await firstRebaseObserved;
    const second = executeCodexRebaseWithFallback(shared);
    const secondResult = await second;
    releaseRebase?.();
    const firstResult = await first;

    assert.equal(firstResult.outcome, "committed");
    assert.equal(secondResult.outcome, "bypassed");
    assert.deepEqual(sentInputs.sort(), ["original", "rebased"]);
  });
});

test("CDR-03 Rebase Epoch records fallback extra request accounting", async () => {
  await withTempState(async (stateDir) => {
    let calls = 0;
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-fallback-accounting",
      planId: "plan-fallback-accounting",
      epochId: "epoch-fallback-accounting",
      originalPayload: { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
      rebasedPayload: { input: [{ role: "user", content: "rebased" }] },
      accounting: {
        plannedSavedChars: 40,
        plannedSavedTokens: 10,
        actuallyRemovedChars: 40,
        actuallyRemovedTokens: 10,
        rebaseReplayCostChars: 100,
        rebaseReplayCostTokens: 25,
        subsequentSavedCharsPerTurn: 40,
        subsequentSavedTokensPerTurn: 10,
        estimatorCostChars: 0,
        estimatorCostTokens: 0,
        fallbackExtraRequestCount: 0,
        cacheColdMissCount: 1,
        breakEvenTurn: 3,
      },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
      },
      async sendUpstream() {
        calls += 1;
        return calls === 1
          ? { status: 400, headers: {}, text: JSON.stringify({ error: "rejected" }) }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });
    assert.equal(result.outcome, "bypassed");

    const latest = await readLatestCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-fallback-accounting",
    });
    assert.equal(latest?.status, "rolled_back");
    assert.equal(latest?.accounting?.fallbackExtraRequestCount, 1);
    assert.equal(latest?.accounting?.cacheColdMissCount, 1);
  });
});

test("CDR-03 Rebase Epoch marks failed when original fallback throws", async () => {
  await withTempState(async (stateDir) => {
    let calls = 0;
    await assert.rejects(() => executeCodexRebaseWithFallback({
      sessionId: "codex-session-fallback-error",
      planId: "plan-fallback-error",
      epochId: "epoch-fallback-error",
      originalPayload: { previous_response_id: "resp-old", input: [] },
      rebasedPayload: { input: [] },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
      },
      async sendUpstream() {
        calls += 1;
        if (calls === 1) {
          return { status: 400, headers: {}, text: JSON.stringify({ error: "rejected" }) };
        }
        throw new Error("fallback connection reset");
      },
    }), /fallback connection reset/);

    const latest = await readLatestCodexRebaseEpoch({
      stateDir,
      sessionId: "codex-session-fallback-error",
    });
    assert.equal(latest?.status, "failed");
    assert.equal(latest?.failureReason, "fallback_upstream_error");
  });
});

test("CDR-03 Rebase Epoch bypasses rebase when pending epoch cannot be written", async () => {
  await withTempState(async (stateDir) => {
    const blockedStateDir = join(stateDir, "blocked-state");
    await writeFile(blockedStateDir, "", "utf8");
    const sentPayloads: JsonObject[] = [];

    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-epoch-store-error",
      planId: "plan-epoch-store-error",
      epochId: "epoch-store-error",
      originalPayload: { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
      rebasedPayload: { input: [{ role: "user", content: "rebased" }] },
      epochStore: {
        stateDir: blockedStateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });

    assert.equal(result.outcome, "bypassed");
    assert.equal(result.cooldown?.reason, "epoch_store_error");
    assert.deepEqual(sentPayloads, [
      { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
    ]);
  });
});

test("CDR-03 Rebase Epoch falls back when committed epoch cannot be persisted", async () => {
  await withTempState(async (stateDir) => {
    const sentPayloads: JsonObject[] = [];
    const journalPath = codexRebaseEpochJournalPath(stateDir, "codex-session-commit-store-error");

    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-commit-store-error",
      planId: "plan-commit-store-error",
      epochId: "epoch-commit-store-error",
      originalPayload: { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
      rebasedPayload: { input: [{ role: "user", content: "rebased" }] },
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
        newRevision: "rev-new",
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        if (sentPayloads.length === 1) {
          await rm(journalPath, { force: true });
          await mkdir(journalPath);
          return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-rebased", output: [] }) };
        }
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });

    assert.equal(result.outcome, "bypassed");
    assert.equal(result.cooldown?.reason, "epoch_store_error");
    assert.equal(sentPayloads.length, 2);
    assert.deepEqual(sentPayloads[1], { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] });
  });
});
