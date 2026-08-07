import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  MINIMAL_HOST_CAPABILITIES,
  canSupportLifecycleEvictionEquivalently,
  type ContextMutationPlan,
  type ContextRewriteResult,
  type ContextRewriteValidation,
  type ModelContextRewriteBackend,
  type ModelContextRewriteMode,
  type ModelContextSnapshot,
} from "../src/index.js";

const snapshot: ModelContextSnapshot = {
  schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  hostId: "claude-code",
  sessionId: "session-1",
  revision: "revision-1",
  items: [
    {
      stableId: "item-1",
      kind: "user",
      fingerprint: "fp-abc",
      chars: 10,
    },
  ],
};

const plan: ContextMutationPlan = {
  schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  planId: "plan-1",
  hostId: "claude-code",
  sessionId: "session-1",
  baseRevision: "revision-1",
  sourceModuleId: "eviction",
  operations: [
    {
      id: "op-1",
      type: "remove",
      targetItemIds: ["item-1"],
      rationale: "evicted task",
      estimatedSavedChars: 10,
    },
  ],
  createdAt: "2026-07-30T00:00:00.000Z",
};

const validation: ContextRewriteValidation = {
  valid: true,
  applicableOperationIds: ["op-1"],
  deferredOperationIds: [],
  reasons: [],
};

const sharedSnapshotRejectsRawMetadata: ModelContextSnapshot = {
  ...snapshot,
  // @ts-expect-error Shared persisted snapshots cannot carry adapter-owned raw payloads.
  adapterMetadata: { nativeMessages: [{ role: "user", content: "raw" }] },
};

const sharedPlanRejectsRawReplacements: ContextMutationPlan = {
  ...plan,
  operations: [{
    ...plan.operations[0]!,
    // @ts-expect-error Shared persisted plans cannot carry adapter-owned replacement payloads.
    replacementItems: [{ type: "host_native_message", content: "raw" }],
  }],
};

const sharedResultRejectsRawDetails: ContextRewriteResult = {
  schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  mode: "none",
  planId: "plan-1",
  applied: false,
  changed: false,
  previousRevision: "revision-1",
  nextRevision: "revision-1",
  appliedOperationIds: [],
  deferredOperationIds: [],
  removedItemIds: [],
  savedChars: 0,
  fallbackUsed: true,
  // @ts-expect-error Shared persisted results cannot carry adapter-owned raw details.
  details: { rawRequest: { input: "secret" } },
};

void sharedSnapshotRejectsRawMetadata;
void sharedPlanRejectsRawReplacements;
void sharedResultRejectsRawDetails;

function createResult(
  mode: ModelContextRewriteMode,
): ContextRewriteResult {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    mode,
    planId: plan.planId,
    applied: true,
    changed: true,
    previousRevision: snapshot.revision,
    nextRevision: "revision-2",
    appliedOperationIds: ["op-1"],
    deferredOperationIds: [],
    removedItemIds: ["item-1"],
    savedChars: 10,
    fallbackUsed: false,
  };
}

type FakeRequest = {
  input: string;
};

const claudeBackend: ModelContextRewriteBackend<FakeRequest> = {
  hostId: "claude-code",
  mode: "request_overlay",
  async readSnapshot() {
    return snapshot;
  },
  async validate() {
    return validation;
  },
  async apply({ request }) {
    return { request, result: createResult(this.mode) };
  },
};

const codexBackend: ModelContextRewriteBackend<FakeRequest> = {
  hostId: "codex",
  mode: "response_chain_rebase",
  async readSnapshot() {
    return { ...snapshot, hostId: "codex" };
  },
  async validate() {
    return validation;
  },
  async apply({ request }) {
    return { request, result: createResult(this.mode) };
  },
};

test("schema version is locked to 1", () => {
  assert.equal(MODEL_CONTEXT_REWRITE_SCHEMA_VERSION, 1);
});

test("Claude can implement the request overlay contract", async () => {
  const request = { input: "hello" };
  const result = await claudeBackend.apply({ snapshot, plan, request });

  assert.equal(claudeBackend.mode, "request_overlay");
  assert.equal(result.request, request);
  assert.equal(result.result.planId, plan.planId);
  assert.deepEqual(result.result.removedItemIds, ["item-1"]);
  assert.equal(result.result.savedChars, 10);
});

test("Codex can implement the response chain rebase contract", async () => {
  const request = { input: "hello" };
  const result = await codexBackend.apply({ snapshot, plan, request });

  assert.equal(codexBackend.mode, "response_chain_rebase");
  assert.equal(result.request, request);
  assert.equal(result.result.planId, plan.planId);
});

test("context rewrite capabilities default to disabled", () => {
  assert.equal(MINIMAL_HOST_CAPABILITIES.modelContextRewriteMode, "none");
  assert.equal(MINIMAL_HOST_CAPABILITIES.supportsPersistentRewritePlans, false);
  assert.equal(MINIMAL_HOST_CAPABILITIES.supportsRewriteRollback, false);
});

test("persistent rewrite modes support lifecycle eviction", () => {
  const unsafeRequestOverlayCapabilities = {
    ...MINIMAL_HOST_CAPABILITIES,
    modelContextRewriteMode: "request_overlay" as const,
    supportsPersistentRewritePlans: true,
  };
  const requestOverlayCapabilities = {
    ...unsafeRequestOverlayCapabilities,
    supportsRewriteRollback: true,
  };
  const legacyTranscriptCapabilities = {
    ...MINIMAL_HOST_CAPABILITIES,
    supportsTranscriptRead: true,
    supportsTranscriptRewrite: true,
  };

  assert.equal(
    canSupportLifecycleEvictionEquivalently(MINIMAL_HOST_CAPABILITIES),
    false,
  );
  assert.equal(
    canSupportLifecycleEvictionEquivalently(unsafeRequestOverlayCapabilities),
    false,
  );
  assert.equal(canSupportLifecycleEvictionEquivalently(requestOverlayCapabilities), true);
  assert.equal(canSupportLifecycleEvictionEquivalently(legacyTranscriptCapabilities), true);
});

test("adapter-owned generic fields stay explicit and process-local", async () => {
  type AdapterMetadata = { nativeMessageCount: number };
  type AdapterReplacement = { nativeType: string };
  type AdapterResultDetails = { providerResponseId: string };

  const nativeSnapshot: ModelContextSnapshot<AdapterMetadata> = {
    ...snapshot,
    adapterMetadata: { nativeMessageCount: 1 },
  };
  const nativePlan: ContextMutationPlan<AdapterReplacement> = {
    ...plan,
    operations: [{
      ...plan.operations[0]!,
      replacementItems: [{ nativeType: "pointer_stub" }],
    }],
  };
  const backend: ModelContextRewriteBackend<
    FakeRequest,
    AdapterMetadata,
    AdapterReplacement,
    AdapterResultDetails
  > = {
    hostId: "adapter-with-native-state",
    mode: "request_overlay",
    async readSnapshot() {
      return nativeSnapshot;
    },
    async validate() {
      return validation;
    },
    async apply({ request }) {
      return {
        request,
        result: {
          ...createResult(this.mode),
          details: { providerResponseId: "resp-1" },
        },
      };
    },
  };

  const applied = await backend.apply({
    snapshot: nativeSnapshot,
    plan: nativePlan,
    request: { input: "hello" },
  });
  assert.equal(nativeSnapshot.adapterMetadata?.nativeMessageCount, 1);
  assert.equal(nativePlan.operations[0]?.replacementItems?.[0]?.nativeType, "pointer_stub");
  assert.equal(applied.result.details?.providerResponseId, "resp-1");
});

test("newer contract fields remain structurally forward compatible", () => {
  const futurePlan = {
    ...plan,
    futureSchemaHint: { introducedIn: 2 },
  };
  const acceptedByCurrentContract: ContextMutationPlan = futurePlan;

  assert.equal(acceptedByCurrentContract.planId, plan.planId);
  assert.equal(futurePlan.futureSchemaHint.introducedIn, 2);
});
