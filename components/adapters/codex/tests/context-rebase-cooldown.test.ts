import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCodexRebaseCooldown,
  CODEX_REBASE_COOLDOWN_SCHEMA,
  codexRebaseCooldownJournalPath,
  executeCodexRebaseWithFallback,
  readActiveCodexRebaseCooldown,
  readCodexRebaseCooldownJournal,
  readCodexRebaseEpochJournal,
  type JsonObject,
} from "../src/context-rewrite/index.js";

async function withTempState(
  fn: (stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-cooldown-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("CDR-04 Rebase Cooldown records active windows by session and plan", async () => {
  await withTempState(async (stateDir) => {
    const cooldown = await appendCodexRebaseCooldown({
      stateDir,
      sessionId: "codex-session-1",
      planId: "plan-1",
      reason: "rebase_upstream_rejected",
      cooldownMs: 300_000,
      startedAt: "2026-07-28T10:00:00.000Z",
    });
    assert.equal(cooldown.expiresAt, "2026-07-28T10:05:00.000Z");

    const active = await readActiveCodexRebaseCooldown({
      stateDir,
      sessionId: "codex-session-1",
      planId: "plan-1",
      now: "2026-07-28T10:04:59.000Z",
    });
    assert.equal(active?.reason, "rebase_upstream_rejected");

    assert.equal(await readActiveCodexRebaseCooldown({
      stateDir,
      sessionId: "codex-session-1",
      planId: "plan-1",
      now: "2026-07-28T10:05:00.000Z",
    }), undefined);
    assert.equal(await readActiveCodexRebaseCooldown({
      stateDir,
      sessionId: "codex-session-1",
      planId: "plan-other",
      now: "2026-07-28T10:04:00.000Z",
    }), undefined);
  });
});

test("CDR-04 Rebase Cooldown isolates malformed and wrong-session rows", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRebaseCooldown({
      stateDir,
      sessionId: "codex-session-malformed",
      planId: "plan-valid",
      reason: "rebase_response_id_missing",
      cooldownMs: 60_000,
      startedAt: "2026-07-28T10:00:00.000Z",
    });
    await appendFile(
      codexRebaseCooldownJournalPath(stateDir, "codex-session-malformed"),
      [
        "not-json",
        "{\"schema\":\"wrong\"}",
        JSON.stringify({
          schema: CODEX_REBASE_COOLDOWN_SCHEMA,
          sessionId: "codex-session-other",
          planId: "plan-other",
          reason: "wrong-session",
          startedAt: "2026-07-28T10:00:00.000Z",
          expiresAt: "2026-07-28T10:01:00.000Z",
        }),
        JSON.stringify({
          schema: CODEX_REBASE_COOLDOWN_SCHEMA,
          sessionId: "codex-session-malformed",
          planId: "plan-invalid-time",
          reason: "invalid-time",
          startedAt: "bad-time",
          expiresAt: "2026-07-28T10:01:00.000Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const journal = await readCodexRebaseCooldownJournal(stateDir, "codex-session-malformed");
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.cooldowns.length, 1);
    assert.equal(journal.malformedLineCount, 4);
  });
});

test("CDR-04 Rebase Cooldown persists fallback failures and blocks repeated rebase attempts", async () => {
  await withTempState(async (stateDir) => {
    const originalPayload = { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] };
    const rebasedPayload = { input: [{ role: "user", content: "rebased" }] };
    const sentPayloads: JsonObject[] = [];

    const failedRebase = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-cooldown",
      planId: "plan-cooldown",
      epochId: "epoch-cooldown",
      originalPayload,
      rebasedPayload,
      cooldownStore: {
        stateDir,
        cooldownMs: 300_000,
        now: "2026-07-28T10:00:00.000Z",
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return sentPayloads.length === 1
          ? { status: 400, headers: {}, text: JSON.stringify({ error: "unsupported" }) }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });

    assert.equal(failedRebase.outcome, "bypassed");
    assert.equal(failedRebase.cooldown?.reason, "rebase_upstream_rejected");
    assert.equal(sentPayloads.length, 2);

    const cooldownHitPayloads: JsonObject[] = [];
    const cooldownHit = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-cooldown",
      planId: "plan-cooldown",
      epochId: "epoch-should-not-start",
      originalPayload,
      rebasedPayload,
      epochStore: {
        stateDir,
        oldPreviousResponseId: "resp-old",
        oldRevision: "rev-old",
      },
      cooldownStore: {
        stateDir,
        cooldownMs: 300_000,
        now: "2026-07-28T10:01:00.000Z",
      },
      async sendUpstream(payload) {
        cooldownHitPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original-2", output: [] }) };
      },
    });

    assert.equal(cooldownHit.outcome, "bypassed");
    assert.equal(cooldownHit.rebaseResponse, undefined);
    assert.equal(cooldownHit.cooldown?.reason, "rebase_upstream_rejected");
    assert.deepEqual(cooldownHitPayloads, [originalPayload]);
    const epochJournal = await readCodexRebaseEpochJournal(stateDir, "codex-session-cooldown");
    assert.equal(epochJournal.entries.length, 0);
  });
});

test("CDR-04 Rebase Cooldown expires and allows a later rebase attempt", async () => {
  await withTempState(async (stateDir) => {
    await appendCodexRebaseCooldown({
      stateDir,
      sessionId: "codex-session-expired",
      planId: "plan-expired",
      reason: "rebase_upstream_error",
      cooldownMs: 60_000,
      startedAt: "2026-07-28T10:00:00.000Z",
    });

    const sentPayloads: JsonObject[] = [];
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-expired",
      planId: "plan-expired",
      epochId: "epoch-expired",
      originalPayload: { previous_response_id: "resp-old", input: [] },
      rebasedPayload: { input: [] },
      cooldownStore: {
        stateDir,
        cooldownMs: 60_000,
        now: "2026-07-28T10:01:01.000Z",
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-rebased", output: [] }) };
      },
    });

    assert.equal(result.outcome, "committed");
    assert.equal(sentPayloads.length, 1);
    assert.deepEqual(sentPayloads[0], { input: [] });
  });
});

test("CDR-04 Rebase Cooldown is written when original fallback also fails", async () => {
  await withTempState(async (stateDir) => {
    let calls = 0;
    await assert.rejects(() => executeCodexRebaseWithFallback({
      sessionId: "codex-session-fallback-error",
      planId: "plan-fallback-error",
      epochId: "epoch-fallback-error",
      originalPayload: { previous_response_id: "resp-old", input: [] },
      rebasedPayload: { input: [] },
      cooldownStore: {
        stateDir,
        cooldownMs: 300_000,
        now: "2026-07-28T10:00:00.000Z",
      },
      async sendUpstream() {
        calls += 1;
        if (calls === 1) return { status: 400, headers: {}, text: JSON.stringify({ error: "rejected" }) };
        throw new Error("fallback connection reset");
      },
    }), /fallback connection reset/);

    const active = await readActiveCodexRebaseCooldown({
      stateDir,
      sessionId: "codex-session-fallback-error",
      planId: "plan-fallback-error",
      now: "2026-07-28T10:01:00.000Z",
    });
    assert.equal(active?.reason, "fallback_upstream_error");
  });
});

test("CDR-04 Rebase Cooldown does not interrupt successful original fallback when cooldown cannot be written", async () => {
  await withTempState(async (stateDir) => {
    const blockedStateDir = join(stateDir, "blocked-state");
    await writeFile(blockedStateDir, "", "utf8");
    const sentPayloads: JsonObject[] = [];

    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-cooldown-store-error",
      planId: "plan-cooldown-store-error",
      epochId: "epoch-cooldown-store-error",
      originalPayload: { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] },
      rebasedPayload: { input: [{ role: "user", content: "rebased" }] },
      cooldownStore: {
        stateDir: blockedStateDir,
        cooldownMs: 300_000,
        now: "2026-07-28T10:00:00.000Z",
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return sentPayloads.length === 1
          ? { status: 400, headers: {}, text: JSON.stringify({ error: "unsupported" }) }
          : { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });

    assert.equal(result.outcome, "bypassed");
    assert.equal(result.cooldown?.reason, "rebase_upstream_rejected");
    assert.equal(sentPayloads.length, 2);
    assert.deepEqual(sentPayloads[1], { previous_response_id: "resp-old", input: [{ role: "user", content: "current" }] });
  });
});
