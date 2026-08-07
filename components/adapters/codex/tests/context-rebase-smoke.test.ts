import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_REBASE_SMOKE_EVIDENCE_SCHEMA,
  runCodexRebaseMockSmoke,
} from "../src/context-rebase-smoke.js";

test("CDR-06 offline smoke emits sanitized five-turn, restart, and fallback evidence", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-smoke-test-"));
  const originalCodexCliVersion = process.env.CODEX_CLI_VERSION;
  try {
    process.env.CODEX_CLI_VERSION = "sk-test-012345678901234567890123456789";
    const result = await runCodexRebaseMockSmoke({ outputDir, model: "offline-smoke-model" });
    const evidence = result.evidence;
    const artifactText = await readFile(result.artifactPath, "utf8");

    assert.equal(evidence.schema, CODEX_REBASE_SMOKE_EVIDENCE_SCHEMA);
    assert.equal(evidence.mode, "mock");
    assert.equal(evidence.runtime.codexCli, "not-observed");
    assert.equal(evidence.happyPath.rebaseRequestFound, true);
    assert.equal(evidence.happyPath.oldPreviousResponseIdRemoved, true);
    assert.deepEqual(evidence.happyPath.sentinel, {
      evictedAbsent: true,
      retainedPresent: true,
    });
    assert.deepEqual(evidence.happyPath.replayItemTypes, [
      "message:user",
      "reasoning",
      "function_call",
      "function_call_output",
      "message",
      "message:user",
    ]);
    assert.equal(evidence.happyPath.reasoning.present, true);
    assert.ok(evidence.happyPath.reasoning.encryptedPayloadChars > 0);
    assert.equal(evidence.happyPath.reasoning.encryptedPayloadDigestMatches, true);
    assert.deepEqual(evidence.happyPath.toolClosure, {
      callCount: 1,
      outputCount: 1,
      complete: true,
    });
    assert.deepEqual(evidence.happyPath.responseChain, {
      newRootResponseIdPresent: true,
      terminalResponseIdPresent: true,
      terminalSessionMappingMatches: true,
      epochCommitted: true,
      journalCommittedBeforeEpoch: true,
      continuationTurns: 5,
      linksValid: true,
      restartPreserved: true,
      finalHistoryComplete: true,
    });
    assert.equal(evidence.happyPath.accounting?.fallbackExtraRequestCount, 0);
    assert.equal(evidence.happyPath.accounting?.cacheColdMissCount, 1);
    assert.ok((evidence.happyPath.accounting?.plannedSavedChars ?? 0) > 0);
    assert.ok((evidence.happyPath.accounting?.actuallyRemovedChars ?? 0) > 0);
    assert.ok((evidence.happyPath.accounting?.rebaseReplayCostChars ?? 0) > 0);
    assert.ok((evidence.happyPath.accounting?.subsequentSavedCharsPerTurn ?? 0) > 0);
    assert.equal(
      evidence.happyPath.accounting?.breakEvenTurn,
      Math.ceil(
        (evidence.happyPath.accounting?.rebaseReplayCostChars ?? 0)
          / (evidence.happyPath.accounting?.subsequentSavedCharsPerTurn ?? 1),
      ),
    );
    assert.deepEqual(evidence.fallback, {
      rebaseAttempts: 1,
      originalRequestRetries: 1,
      fallbackSucceeded: true,
      originalPreviousResponseIdRestored: true,
      epochRolledBack: true,
      cooldownRecorded: true,
      accounting: evidence.fallback.accounting,
    });
    assert.equal(evidence.fallback.accounting?.fallbackExtraRequestCount, 1);
    assert.equal(evidence.moduleMatrix.length, 8);
    assert.equal(evidence.moduleMatrix.every((entry) => entry.isolationPassed), true);
    assert.equal(
      new Set(evidence.moduleMatrix.map((entry) => (
        `${Number(entry.stabilizer)}${Number(entry.reduction)}${Number(entry.rewrite)}`
      ))).size,
      8,
    );
    assert.equal(evidence.privacy.ephemeralStateRemoved, true);
    assert.match(result.artifactSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(artifactText).schema, CODEX_REBASE_SMOKE_EVIDENCE_SCHEMA);
    assert.doesNotMatch(artifactText, /EVICT_ME_|KEEP_ME_|synthetic-encrypted-reasoning-/);
    assert.doesNotMatch(artifactText, /previous_response_id|authorization|bearer/i);
  } finally {
    if (originalCodexCliVersion === undefined) delete process.env.CODEX_CLI_VERSION;
    else process.env.CODEX_CLI_VERSION = originalCodexCliVersion;
    await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("CDR-06 offline smoke rejects credential-shaped model labels before execution", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-smoke-label-"));
  try {
    await assert.rejects(
      runCodexRebaseMockSmoke({
        outputDir,
        model: "sk-test-012345678901234567890123456789",
      }),
      /non-sensitive model label/,
    );
    await assert.rejects(readFile(join(outputDir, "codex-context-rebase-mock-smoke.json"), "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
