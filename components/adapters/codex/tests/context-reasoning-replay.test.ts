import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendCodexRequestJournalEntry,
  appendCodexResponseJournalEntry,
  buildCodexEffectiveHistory,
  type JsonObject,
} from "../src/context-history/index.js";
import {
  appendCodexRebaseCapability,
  buildCodexRebaseRequest,
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  codexRebaseEndpointIdentity,
  executeCodexRebaseWithFallback,
} from "../src/context-rewrite/index.js";

type ReasoningReplayTurnFixture = {
  requestId: string;
  request: JsonObject;
  response: JsonObject;
};

type ReasoningReplayFixture = {
  fixtureKind: string;
  sessionId: string;
  model: string;
  encryptedContent: string;
  complete: {
    turns: ReasoningReplayTurnFixture[];
    currentInput: JsonObject[];
  };
  missingReasoning: JsonObject;
  malformedReasoning: JsonObject;
  truncatedResponse: JsonObject;
};

async function withTempState(fn: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-reasoning-replay-"));
  try {
    await fn(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function loadFixture(): Promise<ReasoningReplayFixture> {
  const path = join(__dirname, "fixtures", "context-history", "encrypted-reasoning-replay.json");
  return JSON.parse(await readFile(path, "utf8")) as ReasoningReplayFixture;
}

function outputItems(response: JsonObject): JsonObject[] {
  return Array.isArray(response.output)
    ? response.output.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function replayInputShape(item: JsonObject): JsonObject {
  const replayed = structuredClone(item);
  delete replayed.id;
  delete replayed.status;
  delete replayed.created_at;
  return replayed;
}

function itemLabel(item: JsonObject): string {
  if (typeof item.type === "string") return item.type;
  return typeof item.role === "string" ? `message:${item.role}` : "item";
}

function countOccurrences(value: unknown, needle: string): number {
  return JSON.stringify(value).split(needle).length - 1;
}

async function persistCompleteFixture(stateDir: string, fixture: ReasoningReplayFixture): Promise<void> {
  for (const turn of fixture.complete.turns) {
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId: fixture.sessionId,
      requestId: turn.requestId,
      payload: turn.request,
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId: fixture.sessionId,
      requestId: turn.requestId,
      response: turn.response,
      status: "completed",
    });
  }
}

test("CDH-05 encrypted reasoning fixture remains replayable with ordered tool closure", async () => {
  await withTempState(async (stateDir) => {
    const fixture = await loadFixture();
    assert.equal(fixture.fixtureKind, "synthetic-sanitized-encrypted-reasoning-replay");
    await persistCompleteFixture(stateDir, fixture);

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: fixture.sessionId,
      headResponseId: "resp-reasoning-2",
    });
    const fixtureReasoning = outputItems(fixture.complete.turns[0]?.response ?? {})[0];
    const replayedReasoning = history.replayableItems.find((entry) => entry.item.type === "reasoning");

    assert.equal(history.incomplete, false);
    assert.deepEqual(history.deferredItems, []);
    assert.deepEqual(history.unresolvedCallIds, []);
    assert.ok(fixtureReasoning);
    assert.deepEqual(replayedReasoning?.item, fixtureReasoning);
    assert.equal(replayedReasoning?.item.encrypted_content, fixture.encryptedContent);
    assert.deepEqual(
      history.replayableItems.map((entry) => itemLabel(entry.item)),
      ["message:user", "reasoning", "function_call", "function_call_output", "message"],
    );
  });
});

test("CDR-02 replays encrypted reasoning exactly for stream and non-stream rebases", async () => {
  await withTempState(async (stateDir) => {
    const fixture = await loadFixture();
    await persistCompleteFixture(stateDir, fixture);
    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId: fixture.sessionId,
      headResponseId: "resp-reasoning-2",
    });
    const evicted = history.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes("EVICT_ME_REASONING_FIXTURE")
    ));
    const fixtureReasoning = outputItems(fixture.complete.turns[0]?.response ?? {})[0];
    assert.ok(evicted);
    assert.ok(fixtureReasoning);

    for (const stream of [false, true]) {
      const originalPayload: JsonObject = {
        model: fixture.model,
        stream,
        previous_response_id: "resp-reasoning-2",
        include: ["reasoning.encrypted_content"],
        input: fixture.complete.currentInput,
      };
      const originalBefore = structuredClone(originalPayload);
      const result = buildCodexRebaseRequest({
        sessionId: fixture.sessionId,
        planId: `plan-reasoning-replay-${stream ? "stream" : "non-stream"}`,
        baseRevision: history.revision,
        originalPayload,
        effectiveHistory: history,
        currentInput: fixture.complete.currentInput,
        mutationPlan: { operations: [{ type: "evict", stableItemId: evicted.stableItemId }] },
      });
      const replayInput = Array.isArray(result.payload.input)
        ? result.payload.input as JsonObject[]
        : [];
      const reasoning = replayInput.find((item) => item.type === "reasoning");

      assert.equal("previous_response_id" in result.payload, false);
      assert.equal(result.payload.stream, stream);
      assert.deepEqual(result.payload.include, ["reasoning.encrypted_content"]);
      assert.deepEqual(reasoning, replayInputShape(fixtureReasoning));
      assert.equal(reasoning?.encrypted_content, fixture.encryptedContent);
      assert.deepEqual(
        replayInput.map(itemLabel),
        ["reasoning", "function_call", "function_call_output", "message", "message:user"],
      );
      assert.equal(countOccurrences(replayInput, "CURRENT_INPUT_REASONING_FIXTURE"), 1);
      assert.equal(countOccurrences(replayInput, "EVICT_ME_REASONING_FIXTURE"), 0);
      assert.equal(countOccurrences(replayInput, "KEEP_ME_TOOL_OUTPUT"), 1);
      assert.equal(countOccurrences(replayInput, "KEEP_ME_ASSISTANT"), 1);
      assert.deepEqual(originalPayload, originalBefore);
    }
  });
});

test("CDR-01 missing and malformed encrypted reasoning block rebase without mutating input", async () => {
  const fixture = await loadFixture();
  for (const [caseName, reasoning] of [
    ["missing", fixture.missingReasoning],
    ["malformed", fixture.malformedReasoning],
  ] as const) {
    await withTempState(async (stateDir) => {
      const sessionId = `${fixture.sessionId}-${caseName}`;
      const responseId = `resp-reasoning-${caseName}`;
      await appendCodexRequestJournalEntry({
        stateDir,
        sessionId,
        requestId: `request-reasoning-${caseName}`,
        payload: { model: fixture.model, input: [{ role: "user", content: caseName }] },
        status: "completed",
      });
      await appendCodexResponseJournalEntry({
        stateDir,
        sessionId,
        requestId: `request-reasoning-${caseName}`,
        response: { id: responseId, status: "completed", output: [reasoning] },
        status: "completed",
      });
      const history = await buildCodexEffectiveHistory({ stateDir, sessionId, headResponseId: responseId });
      const originalPayload: JsonObject = {
        model: fixture.model,
        previous_response_id: responseId,
        input: fixture.complete.currentInput,
      };
      const originalBefore = structuredClone(originalPayload);

      assert.equal(history.incomplete, true);
      assert.equal(history.deferredItems.length, 1);
      assert.equal(history.deferredItems[0]?.item.type, "reasoning");
      assert.throws(() => buildCodexRebaseRequest({
        sessionId,
        planId: `plan-reasoning-${caseName}`,
        baseRevision: history.revision,
        originalPayload,
        effectiveHistory: history,
        currentInput: fixture.complete.currentInput,
        mutationPlan: { operations: [] },
      }), /effective_history_incomplete/);
      assert.deepEqual(originalPayload, originalBefore);
    });
  }
});

test("CDR-01 truncated reasoning response blocks rebase without guessing encrypted content", async () => {
  await withTempState(async (stateDir) => {
    const fixture = await loadFixture();
    const sessionId = `${fixture.sessionId}-truncated`;
    await appendCodexRequestJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-reasoning-truncated",
      payload: { model: fixture.model, input: [{ role: "user", content: "truncated" }] },
      status: "completed",
    });
    await appendCodexResponseJournalEntry({
      stateDir,
      sessionId,
      requestId: "request-reasoning-truncated",
      response: fixture.truncatedResponse,
    });
    const responseId = String(fixture.truncatedResponse.id);
    const history = await buildCodexEffectiveHistory({ stateDir, sessionId, headResponseId: responseId });
    const originalPayload: JsonObject = {
      model: fixture.model,
      previous_response_id: responseId,
      input: fixture.complete.currentInput,
    };
    const originalBefore = structuredClone(originalPayload);

    assert.equal(history.incomplete, true);
    assert.deepEqual(history.replayableItems, []);
    assert.throws(() => buildCodexRebaseRequest({
      sessionId,
      planId: "plan-reasoning-truncated",
      baseRevision: history.revision,
      originalPayload,
      effectiveHistory: history,
      currentInput: fixture.complete.currentInput,
      mutationPlan: { operations: [] },
    }), /effective_history_incomplete/);
    assert.deepEqual(originalPayload, originalBefore);
  });
});

test("CDR-05 known unsupported reasoning replay bypasses before opening a rebase request", async () => {
  await withTempState(async (stateDir) => {
    const fixture = await loadFixture();
    await appendCodexRebaseCapability({
      stateDir,
      provider: "OpenAI",
      model: fixture.model,
      wireMode: CODEX_REBASE_WIRE_MODE,
      apiVersion: CODEX_REBASE_API_VERSION,
      endpointId: codexRebaseEndpointIdentity("https://api.openai.example/v1"),
      itemType: "reasoning",
      itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
      status: "verified_unsupported",
      evidence: "real_provider",
      reason: "schema_error",
    });
    const originalPayload: JsonObject = {
      model: fixture.model,
      previous_response_id: "resp-reasoning-2",
      input: fixture.complete.currentInput,
    };
    const rebasedPayload: JsonObject = {
      model: fixture.model,
      input: [{ type: "reasoning", encrypted_content: fixture.encryptedContent }, ...fixture.complete.currentInput],
    };
    const sentPayloads: JsonObject[] = [];
    const result = await executeCodexRebaseWithFallback({
      sessionId: fixture.sessionId,
      planId: "plan-reasoning-known-unsupported",
      epochId: "epoch-reasoning-known-unsupported",
      originalPayload,
      rebasedPayload,
      capabilityStore: {
        stateDir,
        provider: "OpenAI",
        model: fixture.model,
        wireMode: CODEX_REBASE_WIRE_MODE,
        apiVersion: CODEX_REBASE_API_VERSION,
        endpointId: codexRebaseEndpointIdentity("https://api.openai.example/v1"),
        itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
      },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return { status: 200, headers: {}, text: JSON.stringify({ id: "resp-original", output: [] }) };
      },
    });

    assert.equal(result.outcome, "bypassed");
    assert.deepEqual(result.capability?.unsupportedItemTypes, ["reasoning"]);
    assert.deepEqual(result.capability?.skippedItemTypes, ["reasoning", "message"]);
    assert.deepEqual(sentPayloads, [originalPayload]);
  });
});
