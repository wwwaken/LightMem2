import { collectCodexResponseItemsFromStream } from "../context-history/sse-item-collector.js";
import { cloneJson } from "./shared.js";
import type {
  CodexRebaseFallbackResult,
  CodexRebaseEpoch,
  CodexRebaseAccounting,
  CodexRebaseCapabilityNotice,
  CodexRebaseCapabilityStoreParams,
  CodexRebaseCooldownNotice,
  CodexRebaseCooldownStoreParams,
  CodexRebaseEpochStoreParams,
  CodexUpstreamResponse,
  CodexUpstreamSender,
  JsonObject,
} from "./types.js";
import {
  acquireCodexRebaseSessionLock,
  appendPendingCodexRebaseEpoch,
  commitCodexRebaseEpoch,
  failCodexRebaseEpoch,
  readPendingCodexRebaseEpochs,
  rollbackCodexRebaseEpoch,
  type CodexRebaseSessionLock,
} from "./rebase-epoch.js";
import {
  appendCodexRebaseCooldown,
  codexRebaseCooldownNotice,
  readActiveCodexRebaseCooldown,
} from "./rebase-cooldown.js";
import {
  appendCodexRebaseCapability,
  classifyCodexRebaseCapabilityRejection,
  codexRebasePayloadItems,
  resolveCodexProviderReplayCompatibility,
} from "./rebase-capability.js";

const activeRebaseSessions = new Set<string>();

function isSuccessfulResponse(response: CodexUpstreamResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function responseIdFromObject(value: unknown): string | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  if (typeof object.id === "string" && object.id) return object.id;
  const response = asObject(object.response);
  return typeof response?.id === "string" && response.id ? response.id : undefined;
}

function responseStatusFromObject(value: unknown): string | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  if (typeof object.status === "string") return object.status;
  const response = asObject(object.response);
  return typeof response?.status === "string" ? response.status : undefined;
}

function isEventStreamResponse(response: CodexUpstreamResponse): boolean {
  const contentType = Object.entries(response.headers)
    .find(([key]) => key.toLowerCase() === "content-type")?.[1]
    .toLowerCase();
  return Boolean(
    contentType?.includes("text/event-stream")
    || /^event:\s*response\.|^data:\s*\{|\n\n\s*event:\s*response\./m.test(response.text),
  );
}

function rebaseResponseObservation(response: CodexUpstreamResponse): {
  responseId?: string;
  completed: boolean;
  failureReason?: string;
} {
  if (!isSuccessfulResponse(response)) {
    return { completed: false, failureReason: "rebase_upstream_rejected" };
  }
  if (isEventStreamResponse(response)) {
    const collected = collectCodexResponseItemsFromStream(response.text);
    const sawCompleted = (collected.eventTypeCounts["response.completed"] ?? 0) > 0;
    if (collected.status === "failed") {
      return { responseId: collected.responseId, completed: false, failureReason: "rebase_stream_failed" };
    }
    if (collected.malformedEventCount > 0) {
      return { responseId: collected.responseId, completed: false, failureReason: "rebase_stream_malformed" };
    }
    if (collected.status !== "completed" || !sawCompleted) {
      return { responseId: collected.responseId, completed: false, failureReason: "rebase_stream_incomplete" };
    }
    return {
      responseId: collected.responseId,
      completed: typeof collected.responseId === "string" && collected.responseId.length > 0,
      failureReason: collected.responseId ? undefined : "rebase_response_id_missing",
    };
  }

  try {
    const parsed = JSON.parse(response.text) as unknown;
    const status = responseStatusFromObject(parsed)?.toLowerCase();
    if (status && status !== "completed") {
      return { responseId: responseIdFromObject(parsed), completed: false, failureReason: `rebase_response_${status}` };
    }
    const responseId = responseIdFromObject(parsed);
    return {
      responseId,
      completed: typeof responseId === "string" && responseId.length > 0,
      failureReason: responseId ? undefined : "rebase_response_id_missing",
    };
  } catch {
    return { completed: false, failureReason: "rebase_response_id_missing" };
  }
}

export async function executeCodexRebaseWithFallback(params: {
  sessionId: string;
  planId: string;
  epochId: string;
  originalPayload: JsonObject;
  rebasedPayload: JsonObject;
  sendUpstream: CodexUpstreamSender;
  beforeCommit?: (params: {
    response: CodexUpstreamResponse;
    newResponseId: string;
  }) => Promise<void>;
  accounting?: CodexRebaseAccounting;
  epochStore?: CodexRebaseEpochStoreParams;
  cooldownStore?: CodexRebaseCooldownStoreParams;
  capabilityStore?: CodexRebaseCapabilityStoreParams;
}): Promise<CodexRebaseFallbackResult> {
  let rebaseResponse: CodexUpstreamResponse | undefined;
  let epoch: CodexRebaseEpoch | undefined;
  let cooldown: CodexRebaseCooldownNotice | undefined;
  let capability: CodexRebaseCapabilityNotice | undefined;
  let failureReason = "rebase_upstream_error";
  const rebaseItems = params.capabilityStore
    ? codexRebasePayloadItems(params.rebasedPayload)
    : [];
  const rebaseItemTypes = rebaseItems.map((entry) => entry.itemType);

  async function sendOriginalBypass(
    notice?: CodexRebaseCapabilityNotice,
  ): Promise<CodexRebaseFallbackResult> {
    const response = await params.sendUpstream(cloneJson(params.originalPayload));
    return {
      response,
      outcome: isSuccessfulResponse(response) ? "bypassed" : "failed",
      capability: notice,
    };
  }

  if (params.capabilityStore && rebaseItems.length > 0) {
    try {
      const probeMode = params.capabilityStore.probeMode ?? "disabled";
      const compatibilityResult = await resolveCodexProviderReplayCompatibility({
        ...params.capabilityStore,
        items: rebaseItems,
        acceptedEvidence: params.capabilityStore.acceptedEvidence ?? ["real_provider"],
      });
      const rejected = compatibilityResult.decisions.filter((entry) => (
        entry.status === "verified_unsupported" || entry.status === "payload_rejected"
      ));
      const unknown = compatibilityResult.decisions.filter((entry) => entry.status === "unknown_probe_required");
      const probeEnabled = probeMode === "mock_fixture" || probeMode === "real_provider";
      if (!compatibilityResult.journalTrusted || rejected.length > 0 || (unknown.length > 0 && !probeEnabled)) {
        const skippedItemTypes = Array.from(new Set(
          [...rejected, ...unknown].map((entry) => entry.itemType),
        ));
        const payloadRejectedItemTypes = rejected
          .filter((entry) => entry.status === "payload_rejected")
          .map((entry) => entry.itemType);
        return sendOriginalBypass({
          provider: params.capabilityStore.provider,
          model: params.capabilityStore.model,
          itemTypes: rebaseItemTypes,
          skippedItemTypes,
          unsupportedItemTypes: rejected
            .filter((entry) => entry.status === "verified_unsupported")
            .map((entry) => entry.itemType),
          payloadRejectedItemTypes,
          decisions: compatibilityResult.decisions,
          reason: !compatibilityResult.journalTrusted
            ? "capability_journal_untrusted"
            : rejected.length > 0
              ? "provider_replay_rejected"
              : "provider_replay_probe_required",
        });
      }
    } catch {
      return sendOriginalBypass({
        provider: params.capabilityStore.provider,
        model: params.capabilityStore.model,
        itemTypes: rebaseItemTypes,
        skippedItemTypes: rebaseItemTypes,
        reason: "capability_check_error",
      });
    }
  }

  if (params.cooldownStore) {
    const activeCooldown = await readActiveCodexRebaseCooldown({
      stateDir: params.cooldownStore.stateDir,
      sessionId: params.sessionId,
      planId: params.planId,
      now: params.cooldownStore.now,
    });
    if (activeCooldown) {
      const response = await params.sendUpstream(cloneJson(params.originalPayload));
      return {
        response,
        outcome: isSuccessfulResponse(response) ? "bypassed" : "failed",
        cooldown: codexRebaseCooldownNotice(activeCooldown),
      };
    }
  }

  async function recordCooldown(reason: string): Promise<CodexRebaseCooldownNotice> {
    const startedAt = params.cooldownStore?.now ?? new Date().toISOString();
    if (!params.cooldownStore) {
      return { planId: params.planId, startedAt, reason };
    }
    return codexRebaseCooldownNotice(await appendCodexRebaseCooldown({
      stateDir: params.cooldownStore.stateDir,
      sessionId: params.sessionId,
      planId: params.planId,
      reason,
      cooldownMs: params.cooldownStore.cooldownMs,
      startedAt,
    }));
  }

  async function safeRecordCooldown(reason: string): Promise<CodexRebaseCooldownNotice> {
    try {
      return await recordCooldown(reason);
    } catch {
      return {
        planId: params.planId,
        startedAt: params.cooldownStore?.now ?? new Date().toISOString(),
        reason,
      };
    }
  }

  async function recordCapabilities(paramsForRecord: {
    items: Array<{ itemType: string; payloadDigest?: string }>;
    status: "verified_supported" | "verified_unsupported" | "payload_rejected";
    reason: string;
    responseStatus?: number;
    errorCode?: string;
  }): Promise<void> {
    const store = params.capabilityStore;
    if (!store) return;
    const evidence = store.evidenceSource
      ?? (store.probeMode === "mock_fixture" ? "mock_fixture" : "real_provider");
    for (const item of paramsForRecord.items) {
      await appendCodexRebaseCapability({
        stateDir: store.stateDir,
        provider: store.provider,
        model: store.model,
        wireMode: store.wireMode,
        apiVersion: store.apiVersion,
        endpointId: store.endpointId,
        itemType: item.itemType,
        itemSchemaVersion: store.itemSchemaVersion,
        status: paramsForRecord.status,
        evidence,
        payloadDigest: paramsForRecord.status === "payload_rejected" ? item.payloadDigest : undefined,
        reason: paramsForRecord.reason,
        responseStatus: paramsForRecord.responseStatus,
        errorCode: paramsForRecord.errorCode,
        observedAt: store.now,
        ttlMs: store.ttlMs,
      });
    }
  }

  async function safeRecordCapabilities(paramsForRecord: {
    items: Array<{ itemType: string; payloadDigest?: string }>;
    status: "verified_supported" | "verified_unsupported" | "payload_rejected";
    reason: string;
    responseStatus?: number;
    errorCode?: string;
  }): Promise<void> {
    try {
      await recordCapabilities(paramsForRecord);
    } catch {
      // Capability updates are advisory and must not change request outcome.
    }
  }

  async function transitionEpochAfterFallback(paramsForTransition: {
    fallbackSucceeded: boolean;
    failureReason: string;
  }): Promise<CodexRebaseEpoch | undefined> {
    if (!params.epochStore) return epoch;
    const fallbackAccounting = params.accounting
      ? {
        ...params.accounting,
        fallbackExtraRequestCount: params.accounting.fallbackExtraRequestCount + 1,
      }
      : undefined;
    try {
      return paramsForTransition.fallbackSucceeded
        ? await rollbackCodexRebaseEpoch({
          stateDir: params.epochStore.stateDir,
          sessionId: params.sessionId,
          epochId: params.epochId,
          failureReason: paramsForTransition.failureReason,
          accounting: fallbackAccounting,
        })
        : await failCodexRebaseEpoch({
          stateDir: params.epochStore.stateDir,
          sessionId: params.sessionId,
          epochId: params.epochId,
          failureReason: paramsForTransition.failureReason,
          accounting: fallbackAccounting,
        });
    } catch {
      return epoch;
    }
  }

  async function sendOriginalWithFallbackOutcome(reason: string): Promise<CodexRebaseFallbackResult> {
    let fallbackResponse: CodexUpstreamResponse;
    try {
      fallbackResponse = await params.sendUpstream(cloneJson(params.originalPayload));
    } catch (error) {
      cooldown = await safeRecordCooldown("fallback_upstream_error");
      await transitionEpochAfterFallback({
        fallbackSucceeded: false,
        failureReason: "fallback_upstream_error",
      });
      throw error;
    }
    const fallbackSucceeded = isSuccessfulResponse(fallbackResponse);
    cooldown = await safeRecordCooldown(reason);
    epoch = await transitionEpochAfterFallback({
      fallbackSucceeded,
      failureReason: reason,
    });
    return {
      response: fallbackResponse,
      outcome: fallbackSucceeded ? "bypassed" : "failed",
      rebaseResponse,
      epoch,
      cooldown,
      capability,
    };
  }

  const rebaseSessionKey = params.epochStore
    ? `${params.epochStore.stateDir}\0${params.sessionId}`
    : undefined;
  if (rebaseSessionKey && activeRebaseSessions.has(rebaseSessionKey)) {
    return sendOriginalBypass();
  }
  if (rebaseSessionKey) activeRebaseSessions.add(rebaseSessionKey);
  let sessionLock: CodexRebaseSessionLock | undefined;

  try {
    if (params.epochStore) {
      try {
        sessionLock = await acquireCodexRebaseSessionLock({
          stateDir: params.epochStore.stateDir,
          sessionId: params.sessionId,
        });
        if (!sessionLock) return await sendOriginalBypass();
        const activeEpoch = (await readPendingCodexRebaseEpochs({
          stateDir: params.epochStore.stateDir,
          sessionId: params.sessionId,
        })).find((entry) => entry.epochId !== params.epochId);
        if (activeEpoch) {
          return await sendOriginalBypass();
        }

        epoch = await appendPendingCodexRebaseEpoch({
          stateDir: params.epochStore.stateDir,
          sessionId: params.sessionId,
          planId: params.planId,
          epochId: params.epochId,
          oldPreviousResponseId: params.epochStore.oldPreviousResponseId,
          oldRevision: params.epochStore.oldRevision,
          accounting: params.accounting,
        });
      } catch {
        return await sendOriginalWithFallbackOutcome("epoch_store_error");
      }
    }

    try {
      rebaseResponse = await params.sendUpstream(cloneJson(params.rebasedPayload));
      const observation = rebaseResponseObservation(rebaseResponse);
      const newResponseId = observation.completed ? observation.responseId : undefined;
      if (newResponseId) {
        let journalCommittedAt: string | undefined;
        if (params.beforeCommit) {
          try {
            await params.beforeCommit({ response: rebaseResponse, newResponseId });
            journalCommittedAt = new Date().toISOString();
          } catch {
            return await sendOriginalWithFallbackOutcome("rebase_journal_error");
          }
        }
        if (params.epochStore) {
          try {
            epoch = await commitCodexRebaseEpoch({
              stateDir: params.epochStore.stateDir,
              sessionId: params.sessionId,
              epochId: params.epochId,
              newResponseId,
              newRevision: params.epochStore.newRevision,
              journalCommittedAt,
              accounting: params.accounting,
            });
          } catch {
            return await sendOriginalWithFallbackOutcome("epoch_store_error");
          }
        }
        if (params.capabilityStore && rebaseItemTypes.length > 0) {
          await safeRecordCapabilities({
            items: rebaseItems,
            status: "verified_supported",
            reason: "rebase_committed",
            responseStatus: rebaseResponse.status,
          });
          capability = {
            provider: params.capabilityStore.provider,
            model: params.capabilityStore.model,
            itemTypes: rebaseItemTypes,
            supportedItemTypes: rebaseItemTypes,
            reason: "rebase_committed",
          };
        }
        return {
          response: rebaseResponse,
          outcome: "committed",
          newResponseId,
          rebaseResponse,
          epoch,
          capability,
        };
      }
      failureReason = observation.failureReason ?? (
        isSuccessfulResponse(rebaseResponse)
          ? "rebase_response_id_missing"
          : "rebase_upstream_rejected"
      );
      if (params.capabilityStore) {
        const classification = classifyCodexRebaseCapabilityRejection({
          response: rebaseResponse,
          items: rebaseItems,
        });
        if (classification.kind === "item_unsupported") {
          const unsupportedItemTypes = classification.itemTypes;
          await safeRecordCapabilities({
            items: unsupportedItemTypes.map((itemType) => ({ itemType })),
            status: "verified_unsupported",
            reason: "item_schema_unsupported",
            responseStatus: rebaseResponse.status,
            errorCode: classification.errorCode,
          });
          capability = {
            provider: params.capabilityStore.provider,
            model: params.capabilityStore.model,
            itemTypes: rebaseItemTypes,
            unsupportedItemTypes,
            reason: "item_schema_unsupported",
          };
        } else if (classification.kind === "payload_rejected") {
          const rejectedItems = rebaseItems.filter((entry) => classification.itemTypes.includes(entry.itemType));
          await safeRecordCapabilities({
            items: rejectedItems,
            status: "payload_rejected",
            reason: "encrypted_payload_rejected",
            responseStatus: rebaseResponse.status,
            errorCode: classification.errorCode,
          });
          capability = {
            provider: params.capabilityStore.provider,
            model: params.capabilityStore.model,
            itemTypes: rebaseItemTypes,
            payloadRejectedItemTypes: classification.itemTypes,
            reason: "encrypted_payload_rejected",
          };
        }
      }
    } catch {
      failureReason = "rebase_upstream_error";
    }

    return await sendOriginalWithFallbackOutcome(failureReason);
  } finally {
    await sessionLock?.release();
    if (rebaseSessionKey) activeRebaseSessions.delete(rebaseSessionKey);
  }
}
