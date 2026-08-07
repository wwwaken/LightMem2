import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCodexRolloutBootstrap,
  type CodexRolloutSnapshot,
} from "../src/context-history/index.js";

function rolloutSnapshot(params?: {
  sessionId?: string;
  modelProvider?: string;
  encrypted?: boolean;
}): CodexRolloutSnapshot {
  const encrypted = params?.encrypted !== false;
  return {
    history: {
      revision: "rollout-revision",
      replayableItems: [
        {
          stableItemId: "message-1",
          item: { type: "message", role: "user", content: "continue" },
        },
        ...(encrypted
          ? [{
            stableItemId: "compaction-1",
            item: { type: "compaction", encrypted_content: "opaque" },
          }]
          : []),
      ],
      observationOnlyItems: [],
      deferredItems: [],
      unresolvedCallIds: [],
      source: "rollout_bootstrap",
      incomplete: false,
    },
    sessionMeta: {
      sessionId: params?.sessionId,
      modelProvider: params?.modelProvider,
    },
    malformedLineCount: 0,
    unknownRecordTypeCounts: {},
    taskEvidence: { completedTurnIds: [], abortedTurnIds: [] },
    compactionBaselineApplied: true,
  };
}

function validate(params?: {
  rollout?: CodexRolloutSnapshot;
  expectedCodexSessionId?: string;
  snapshotCodexSessionId?: string;
  sourceModel?: string;
  sourceUpstreamProvider?: string;
  currentModel?: string;
  currentCodexProvider?: string;
  currentUpstreamProvider?: string;
}) {
  return validateCodexRolloutBootstrap({
    rollout: params?.rollout ?? rolloutSnapshot({
      sessionId: "codex-session-1",
      modelProvider: "tokenpilot",
    }),
    expectedCodexSessionId: params?.expectedCodexSessionId ?? "codex-session-1",
    snapshotCodexSessionId: params?.snapshotCodexSessionId ?? "codex-session-1",
    sourceModel: params?.sourceModel ?? "gpt-5.6-sol",
    sourceUpstreamProvider: params?.sourceUpstreamProvider ?? "OpenAI",
    currentModel: params?.currentModel ?? "gpt-5.6-sol",
    currentCodexProvider: params?.currentCodexProvider ?? "tokenpilot",
    currentUpstreamProvider: params?.currentUpstreamProvider ?? "openai",
  });
}

test("rollout bootstrap accepts matching session and encrypted payload provenance", () => {
  const result = validate();

  assert.equal(result.rejectionReason, undefined);
  assert.equal(result.history?.revision, "rollout-revision");
});

test("rollout bootstrap rejects missing and mismatched session identities", () => {
  assert.equal(validate({ snapshotCodexSessionId: " " }).rejectionReason, "snapshot_session_identity_missing");
  assert.equal(
    validate({ snapshotCodexSessionId: "codex-session-other" }).rejectionReason,
    "snapshot_session_identity_mismatch",
  );
  assert.equal(
    validate({ snapshotCodexSessionId: "CODEX-SESSION-1" }).rejectionReason,
    "snapshot_session_identity_mismatch",
  );
  assert.equal(
    validate({ rollout: rolloutSnapshot({ modelProvider: "tokenpilot" }) }).rejectionReason,
    "rollout_session_identity_missing",
  );
  assert.equal(
    validate({
      rollout: rolloutSnapshot({ sessionId: "codex-session-other", modelProvider: "tokenpilot" }),
    }).rejectionReason,
    "rollout_session_identity_mismatch",
  );
});

test("rollout bootstrap rejects encrypted history with uncertain or changed provenance", () => {
  assert.equal(
    validate({
      rollout: rolloutSnapshot({ sessionId: "codex-session-1" }),
    }).rejectionReason,
    "encrypted_rollout_codex_provider_missing",
  );
  assert.equal(
    validate({ currentCodexProvider: "different-provider" }).rejectionReason,
    "encrypted_rollout_codex_provider_mismatch",
  );
  assert.equal(
    validate({ sourceUpstreamProvider: " " }).rejectionReason,
    "encrypted_rollout_upstream_provider_missing",
  );
  assert.equal(
    validate({ sourceUpstreamProvider: "Azure" }).rejectionReason,
    "encrypted_rollout_upstream_provider_mismatch",
  );
  assert.equal(
    validate({ sourceModel: " " }).rejectionReason,
    "encrypted_rollout_model_missing",
  );
  assert.equal(
    validate({ sourceModel: "gpt-5.5" }).rejectionReason,
    "encrypted_rollout_model_mismatch",
  );
});

test("rollout bootstrap allows visible-only history without encrypted provenance", () => {
  const result = validate({
    rollout: rolloutSnapshot({
      sessionId: "codex-session-1",
      encrypted: false,
    }),
    sourceModel: " ",
    sourceUpstreamProvider: " ",
    currentCodexProvider: " ",
  });

  assert.equal(result.rejectionReason, undefined);
  assert.equal(result.history?.revision, "rollout-revision");
});
