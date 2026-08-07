import type {
  CodexEffectiveHistory,
  CodexRolloutSnapshot,
} from "./types.js";

export type CodexRolloutBootstrapRejectionReason =
  | "snapshot_session_identity_missing"
  | "snapshot_session_identity_mismatch"
  | "rollout_session_identity_missing"
  | "rollout_session_identity_mismatch"
  | "encrypted_rollout_codex_provider_missing"
  | "encrypted_rollout_codex_provider_mismatch"
  | "encrypted_rollout_upstream_provider_missing"
  | "encrypted_rollout_upstream_provider_mismatch"
  | "encrypted_rollout_model_missing"
  | "encrypted_rollout_model_mismatch";

export type CodexRolloutBootstrapValidation = {
  history: CodexEffectiveHistory | null;
  rejectionReason?: CodexRolloutBootstrapRejectionReason;
};

function normalizeSessionIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeDimension(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function hasEncryptedReplayItems(rollout: CodexRolloutSnapshot): boolean {
  return rollout.history.replayableItems.some(({ item }) => {
    const type = normalizeDimension(typeof item.type === "string" ? item.type : undefined);
    return (type === "reasoning" || type === "compaction")
      && typeof item.encrypted_content === "string"
      && item.encrypted_content.length > 0;
  });
}

export function validateCodexRolloutBootstrap(params: {
  rollout: CodexRolloutSnapshot;
  expectedCodexSessionId?: string;
  snapshotCodexSessionId?: string;
  sourceModel?: string;
  sourceUpstreamProvider?: string;
  currentModel: string;
  currentCodexProvider: string;
  currentUpstreamProvider: string;
}): CodexRolloutBootstrapValidation {
  const expectedSessionId = normalizeSessionIdentity(params.expectedCodexSessionId);
  const snapshotSessionId = normalizeSessionIdentity(params.snapshotCodexSessionId);
  const rolloutSessionId = normalizeSessionIdentity(params.rollout.sessionMeta?.sessionId);
  if (!snapshotSessionId) {
    return { history: null, rejectionReason: "snapshot_session_identity_missing" };
  }
  if (expectedSessionId && snapshotSessionId !== expectedSessionId) {
    return { history: null, rejectionReason: "snapshot_session_identity_mismatch" };
  }
  if (!rolloutSessionId) {
    return { history: null, rejectionReason: "rollout_session_identity_missing" };
  }
  if (rolloutSessionId !== (expectedSessionId ?? snapshotSessionId)) {
    return { history: null, rejectionReason: "rollout_session_identity_mismatch" };
  }

  if (!hasEncryptedReplayItems(params.rollout)) {
    return { history: params.rollout.history };
  }

  const rolloutProvider = normalizeDimension(params.rollout.sessionMeta?.modelProvider);
  const currentCodexProvider = normalizeDimension(params.currentCodexProvider);
  if (!rolloutProvider || !currentCodexProvider) {
    return { history: null, rejectionReason: "encrypted_rollout_codex_provider_missing" };
  }
  if (rolloutProvider !== currentCodexProvider) {
    return { history: null, rejectionReason: "encrypted_rollout_codex_provider_mismatch" };
  }

  const sourceUpstreamProvider = normalizeDimension(params.sourceUpstreamProvider);
  const currentUpstreamProvider = normalizeDimension(params.currentUpstreamProvider);
  if (!sourceUpstreamProvider || !currentUpstreamProvider) {
    return { history: null, rejectionReason: "encrypted_rollout_upstream_provider_missing" };
  }
  if (sourceUpstreamProvider !== currentUpstreamProvider) {
    return { history: null, rejectionReason: "encrypted_rollout_upstream_provider_mismatch" };
  }

  const sourceModel = normalizeDimension(params.sourceModel);
  const currentModel = normalizeDimension(params.currentModel);
  if (!sourceModel || !currentModel) {
    return { history: null, rejectionReason: "encrypted_rollout_model_missing" };
  }
  if (sourceModel !== currentModel) {
    return { history: null, rejectionReason: "encrypted_rollout_model_mismatch" };
  }

  return { history: params.rollout.history };
}
