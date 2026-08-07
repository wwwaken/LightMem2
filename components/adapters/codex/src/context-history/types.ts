export const CODEX_CONTEXT_HISTORY_REQUEST_SCHEMA = "lightmem2.codex.context-history.request/v1";
export const CODEX_CONTEXT_HISTORY_RESPONSE_SCHEMA = "lightmem2.codex.context-history.response/v1";

export type JsonObject = Record<string, unknown>;

export type CodexJournalStatus = "pending" | "completed" | "failed" | "incomplete";

export type CodexRequestJournalEntry = {
  schema: typeof CODEX_CONTEXT_HISTORY_REQUEST_SCHEMA;
  kind: "request";
  requestId: string;
  sessionId: string;
  turnOrdinal: number;
  model?: string;
  stream: boolean;
  previousResponseId?: string;
  promptCacheKey?: string;
  inputItems: JsonObject[];
  committedInputItems?: JsonObject[];
  status: CodexJournalStatus;
  error?: string;
  observedAt: string;
};

export type CodexResponseOutputRef = {
  type?: string;
  itemId?: string;
  callId?: string;
};

export type CodexResponseJournalEntry = {
  schema: typeof CODEX_CONTEXT_HISTORY_RESPONSE_SCHEMA;
  kind: "response";
  requestId?: string;
  sessionId: string;
  responseId?: string;
  previousResponseId?: string | null;
  stream: boolean;
  outputItems: JsonObject[];
  outputItemRefs: CodexResponseOutputRef[];
  eventTypeCounts?: Record<string, number>;
  malformedEventCount?: number;
  malformedEventTypeCounts?: Record<string, number>;
  status: CodexJournalStatus;
  error?: string;
  observedAt: string;
};

export type CodexContextHistoryJournalEntry =
  | CodexRequestJournalEntry
  | CodexResponseJournalEntry;

export type CodexEffectiveHistoryItem = {
  stableItemId: string;
  nativeId?: string;
  callId?: string;
  item: JsonObject;
};

export type CodexEffectiveHistory = {
  revision: string;
  replayableItems: CodexEffectiveHistoryItem[];
  observationOnlyItems: CodexEffectiveHistoryItem[];
  deferredItems: CodexEffectiveHistoryItem[];
  unresolvedCallIds: string[];
  source: "proxy_journal" | "rollout_bootstrap" | "rollout_proxy_merge" | "empty";
  incomplete: boolean;
};

export type CodexRolloutSessionMeta = {
  sessionId?: string;
  cwd?: string;
  originator?: string;
  cliVersion?: string;
  source?: string;
  modelProvider?: string;
};

export type CodexRolloutTaskEvidence = {
  completedTurnIds: string[];
  abortedTurnIds: string[];
};

export type CodexRolloutSnapshot = {
  history: CodexEffectiveHistory;
  sessionMeta?: CodexRolloutSessionMeta;
  malformedLineCount: number;
  unknownRecordTypeCounts: Record<string, number>;
  taskEvidence: CodexRolloutTaskEvidence;
  compactionBaselineApplied: boolean;
};
