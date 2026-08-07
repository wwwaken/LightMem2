export const MODEL_CONTEXT_REWRITE_SCHEMA_VERSION = 1 as const;

export type ModelContextRewriteMode =
  | "canonical"
  | "request_overlay"
  | "response_chain_rebase"
  | "none";

export type ContextItemKind =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "compaction"
  | "unknown";

export type ContextItemRef = {
  stableId: string;
  kind: ContextItemKind;
  role?: string;
  callId?: string;
  responseId?: string;
  taskIds?: string[];
  fingerprint: string;
  chars: number;
};

/**
 * Adapter-owned generic fields are process-local. Persisted shared contracts
 * must use the default `never` parameters so raw host payloads cannot leak.
 */
export type ModelContextSnapshot<TAdapterMetadata = never> = {
  schemaVersion: typeof MODEL_CONTEXT_REWRITE_SCHEMA_VERSION;
  hostId: string;
  sessionId: string;
  revision: string;
  items: ContextItemRef[];
  adapterMetadata?: TAdapterMetadata;
};

export type ContextMutationOperation<TAdapterReplacementItem = never> = {
  id: string;
  type: "remove" | "replace";
  targetItemIds: string[];
  /** Exact target-to-fingerprint map used to prove targets survived revision drift. */
  targetItemFingerprints?: Record<string, string>;
  replacementItems?: TAdapterReplacementItem[];
  taskIds?: string[];
  rationale: string;
  estimatedSavedChars: number;
  archiveRefs?: string[];
};

/** Persisted readers must ignore unknown fields from newer schema revisions. */
export type ContextMutationPlan<TAdapterReplacementItem = never> = {
  schemaVersion: typeof MODEL_CONTEXT_REWRITE_SCHEMA_VERSION;
  planId: string;
  hostId: string;
  sessionId: string;
  baseRevision: string;
  sourceModuleId: string;
  sourcePresetId?: string;
  operations: ContextMutationOperation<TAdapterReplacementItem>[];
  createdAt: string;
};

export type ContextRewriteValidation = {
  valid: boolean;
  applicableOperationIds: string[];
  deferredOperationIds: string[];
  reasons: string[];
};

export type ContextRewriteResult<TResultDetails = never> = {
  schemaVersion: typeof MODEL_CONTEXT_REWRITE_SCHEMA_VERSION;
  mode: ModelContextRewriteMode;
  planId: string;
  applied: boolean;
  changed: boolean;
  previousRevision: string;
  nextRevision: string;
  appliedOperationIds: string[];
  deferredOperationIds: string[];
  removedItemIds: string[];
  savedChars: number;
  fallbackUsed: boolean;
  details?: TResultDetails;
};

export interface ModelContextRewriteBackend<
  TRequest = unknown,
  TAdapterMetadata = never,
  TAdapterReplacementItem = never,
  TResultDetails = never,
> {
  readonly hostId: string;
  readonly mode: ModelContextRewriteMode;

  readSnapshot(params: {
    sessionId: string;
    request: TRequest;
  }): Promise<ModelContextSnapshot<TAdapterMetadata>>;

  validate(params: {
    snapshot: ModelContextSnapshot<TAdapterMetadata>;
    plan: ContextMutationPlan<TAdapterReplacementItem>;
  }): Promise<ContextRewriteValidation>;

  apply(params: {
    snapshot: ModelContextSnapshot<TAdapterMetadata>;
    plan: ContextMutationPlan<TAdapterReplacementItem>;
    request: TRequest;
  }): Promise<{
    request: TRequest;
    result: ContextRewriteResult<TResultDetails>;
  }>;
}
