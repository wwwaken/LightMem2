import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTEXT_REWRITE_EVENT_NAMES,
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  appendContextRewriteEvent,
  createContextRewriteEvent,
  summarizeContextRewriteContent,
  type ContextRewriteEventInput,
} from "../src/index.js";

const FIXED_AT = "2026-08-04T00:00:00.000Z";
const SENTINEL = "EVICT_ME_observability_secret";
const AUTHORIZATION = "Bearer test-secret-token";

function baseInput(
  stage: ContextRewriteEventInput["stage"],
): ContextRewriteEventInput {
  return {
    stage,
    hostId: "test-host",
    sessionId: "session-1",
    at: FIXED_AT,
  };
}

test("defines all shared context rewrite lifecycle events", () => {
  assert.deepEqual(CONTEXT_REWRITE_EVENT_NAMES, [
    "context_rewrite_planned",
    "context_rewrite_validated",
    "context_rewrite_applied",
    "context_rewrite_deferred",
    "context_rewrite_failed",
    "context_rewrite_bypassed",
  ]);

  for (const stage of CONTEXT_REWRITE_EVENT_NAMES) {
    const event = createContextRewriteEvent(baseInput(stage));
    assert.equal(event.schemaVersion, MODEL_CONTEXT_REWRITE_SCHEMA_VERSION);
    assert.equal(event.stage, stage);
    assert.equal(event.at, FIXED_AT);
  }
});

test("summarizes content with a deterministic digest and length", () => {
  const summary = summarizeContextRewriteContent(SENTINEL);
  const expectedDigest = createHash("sha256")
    .update(SENTINEL)
    .digest("hex");

  assert.deepEqual(summary, {
    digest: `sha256:${expectedDigest}`,
    chars: SENTINEL.length,
  });
  assert.equal(JSON.stringify(summary).includes(SENTINEL), false);
});

test("creates whitelist-only events and redacts unsafe reason text", () => {
  const input = {
    ...baseInput("context_rewrite_failed"),
    planId: "plan-1",
    mode: "request_overlay",
    operationIds: ["op-1", "op-1", "op-2"],
    itemIds: ["item-1"],
    taskIds: ["task-1"],
    reasonCodes: ["revision_mismatch", `provider said ${SENTINEL}`],
    errorCategory: `upstream error: ${SENTINEL}`,
    estimatedSavedChars: 1200,
    savedChars: 0,
    fallbackUsed: true,
    contentSamples: [SENTINEL],
    payload: { raw: SENTINEL },
    authorization: AUTHORIZATION,
    headers: { authorization: AUTHORIZATION },
    errorMessage: SENTINEL,
  } as ContextRewriteEventInput & Record<string, unknown>;
  const event = createContextRewriteEvent(input);
  const serialized = JSON.stringify(event);

  assert.deepEqual(event.operationIds, ["op-1", "op-2"]);
  assert.equal(event.reasonCodes?.[0], "revision_mismatch");
  assert.match(event.reasonCodes?.[1] ?? "", /^redacted:sha256:[a-f0-9]{24}$/);
  assert.match(event.errorCategory ?? "", /^redacted:sha256:[a-f0-9]{24}$/);
  assert.equal(event.contentSummaries?.[0]?.chars, SENTINEL.length);
  assert.equal(serialized.includes(SENTINEL), false);
  assert.equal(serialized.includes(AUTHORIZATION), false);
  assert.equal("payload" in event, false);
  assert.equal("headers" in event, false);
  assert.equal("errorMessage" in event, false);
});

test("normalizes optional fields and drops invalid accounting values", () => {
  const event = createContextRewriteEvent({
    ...baseInput("context_rewrite_applied"),
    planId: " plan-1 ",
    previousRevision: " ctxrev-before ",
    nextRevision: " ctxrev-after ",
    applicableOperationIds: ["op-1", "op-1"],
    deferredOperationIds: ["op-2"],
    estimatedSavedChars: -1,
    savedChars: Number.NaN,
    fallbackUsed: false,
  });

  assert.equal(event.planId, "plan-1");
  assert.equal(event.previousRevision, "ctxrev-before");
  assert.equal(event.nextRevision, "ctxrev-after");
  assert.deepEqual(event.applicableOperationIds, ["op-1"]);
  assert.deepEqual(event.deferredOperationIds, ["op-2"]);
  assert.equal(event.estimatedSavedChars, undefined);
  assert.equal(event.savedChars, undefined);
  assert.equal(event.fallbackUsed, false);
});

test("redacts credential-shaped values in identifiers and reason codes", () => {
  const secret = "sk-test-012345678901234567890123456789";
  const event = createContextRewriteEvent({
    ...baseInput("context_rewrite_failed"),
    sessionId: secret,
    planId: secret,
    operationIds: [secret],
    itemIds: [secret],
    taskIds: [secret],
    reasonCodes: [secret, "revision_mismatch"],
    errorCategory: secret,
  });
  const serialized = JSON.stringify(event);

  assert.equal(serialized.includes(secret), false);
  assert.match(event.sessionId, /^redacted:sha256:[a-f0-9]{24}$/);
  assert.match(event.planId ?? "", /^redacted:sha256:[a-f0-9]{24}$/);
  assert.match(event.reasonCodes?.[0] ?? "", /^redacted:sha256:[a-f0-9]{24}$/);
  assert.equal(event.reasonCodes?.[1], "revision_mismatch");
  assert.match(event.errorCategory ?? "", /^redacted:sha256:[a-f0-9]{24}$/);

  for (const credential of [
    "ghp_012345678901234567890123456789012345",
    "github_pat_012345678901234567890123456789012345",
    "AKIAIOSFODNN7EXAMPLE",
    "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "api_key=01234567890123456789",
  ]) {
    const credentialEvent = createContextRewriteEvent({
      ...baseInput("context_rewrite_failed"),
      reasonCodes: [credential],
    });
    assert.equal(JSON.stringify(credentialEvent).includes(credential), false);
    assert.match(
      credentialEvent.reasonCodes?.[0] ?? "",
      /^redacted:sha256:[a-f0-9]{24}$/,
    );
  }
});

test("rejects an invalid rewrite mode instead of silently omitting it", () => {
  assert.throws(
    () => createContextRewriteEvent({
      ...baseInput("context_rewrite_planned"),
      mode: "unsupported-mode",
    } as unknown as ContextRewriteEventInput),
    /unsupported context rewrite mode/,
  );
});

test("ignores malformed optional array entries at the observability boundary", () => {
  const event = createContextRewriteEvent({
    ...baseInput("context_rewrite_planned"),
    operationIds: ["op-1", 42] as unknown as string[],
    reasonCodes: ["ok", null] as unknown as string[],
    contentSamples: ["safe", 42] as unknown as string[],
  });

  assert.deepEqual(event.operationIds, ["op-1"]);
  assert.deepEqual(event.reasonCodes, ["ok"]);
  assert.equal(event.contentSummaries?.length, 1);

  const malformed = createContextRewriteEvent({
    ...baseInput("context_rewrite_planned"),
    operationIds: "op-1" as unknown as string[],
    reasonCodes: null as unknown as string[],
    contentSamples: "raw" as unknown as string[],
  });
  assert.equal(malformed.operationIds, undefined);
  assert.equal(malformed.reasonCodes, undefined);
  assert.equal(malformed.contentSummaries, undefined);
});

test("rejects unsupported event names and invalid timestamps", () => {
  assert.throws(
    () => createContextRewriteEvent({
      ...baseInput("context_rewrite_planned"),
      stage: "context_rewrite_unknown",
    } as unknown as ContextRewriteEventInput),
    /unsupported context rewrite event name/,
  );
  assert.throws(
    () => createContextRewriteEvent({
      ...baseInput("context_rewrite_planned"),
      at: SENTINEL,
    }),
    /at must be a valid timestamp/,
  );
});

test("appends sanitized events to the shared trace store", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-rewrite-trace-"));
  try {
    const event = await appendContextRewriteEvent(stateDir, {
      ...baseInput("context_rewrite_planned"),
      planId: "plan-1",
      itemIds: ["item-1"],
      taskIds: ["task-1"],
      estimatedSavedChars: 1200,
      contentSamples: [SENTINEL],
    });
    const raw = await readFile(join(stateDir, "event-trace.jsonl"), "utf8");
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;

    assert.deepEqual(parsed, event);
    assert.equal(raw.includes(SENTINEL), false);
    assert.equal(parsed.stage, "context_rewrite_planned");
    assert.equal(parsed.schemaVersion, MODEL_CONTEXT_REWRITE_SCHEMA_VERSION);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
