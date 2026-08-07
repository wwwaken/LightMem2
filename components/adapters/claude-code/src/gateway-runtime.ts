/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir } from "node:fs/promises";
import {
  buildGatewayForwardHeaders,
  countTextWithPreciseTokens,
  createSseJsonStreamObserver,
  createStaticStatePathResolver,
  forwardGatewayRequest,
  type HostGatewayForwarder,
  type HostGatewayStreamObserver,
  recordUxEffect,
  sendJsonResponse,
  startHostGatewayRuntimeServer,
  setForwardResponseHeaders,
  loadActiveContextMutationPlans,
  saveActiveContextMutationPlan,
  markContextMutationPlanApplied,
  markContextMutationPlanFailed,
} from "@lightmem2/host-adapter";
import {
  prepareObservedBeforeCall,
} from "@lightmem2/product-surface";
import { configureStatePathResolver } from "@lightmem2/artifact-store";
import type { TokenPilotClaudeCodeConfig } from "./config.js";
import { proxyBaseUrlForPort } from "./config.js";
import type { TokenPilotClaudeCodeLogger } from "./logger.js";
import { createClaudeMessagesPayloadCodec } from "./messages-codec.js";
import { encodeRequestOrBypass } from "./context-rewrite/encode-bypass.js";
import { reduceClaudeRequestEnvelope, type ClaudeReductionSummary } from "./reduction.js";
import {
  applyClaudeEviction,
  analyzeClaudeEviction,
  buildToolResultSegments,
  type ClaudeEvictionApplySummary,
} from "./eviction.js";
import { claudeContextRewriteBackend, relocateContextMutationPlan } from "./context-rewrite/backend.js";
import { applyArchivePlan } from "./context-rewrite/archive.js";
import { saveLatestClaudeSnapshot } from "./context-rewrite/snapshot-store.js";
import { appendOverlayHistory } from "./context-rewrite/overlay-history.js";
import { buildContextMutationPlan } from "@lightmem2/eviction";
import { createHash as _createHash } from "node:crypto";
import {
  appendClaudeCodeRecentTurnBinding,
  upsertClaudeCodeSessionSnapshot,
} from "./session-state.js";
import { prepareClaudeStablePrefix } from "./stable-prefix.js";
import {
  buildStabilityVisualSnapshotFromEnvelopes,
  canonicalizeEnvelopeTools,
} from "@lightmem2/stabilizer";
import { appendClaudeCodeTrace } from "./trace.js";
import { createClaudeCodeGatewayForwarder, resolveClaudeCodeUpstream } from "./upstream.js";
import { appendClaudeCodeCacheAuditRecord, buildClaudeCodeCacheAuditSnapshot } from "./cache-audit.js";
import { buildAnthropicGatewayModelList, mapClaudeVisibleModelToUpstreamModel } from "./provider-profile.js";
import { resolveLatestClaudeCodeSessionId } from "./session-state.js";
import { lookupRealSessionId, recordSessionMapping } from "./context-rewrite/session-map.js";
import { initializeClaudeCodeTokenPilotPreset } from "./preset.js";

export type ClaudeCodeGatewayRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

type ClaudeCodeGatewayRuntimeDependencies = {
  cloneRequestPayload?: typeof structuredClone;
};

function isSyntheticClaudeSessionId(sessionId: string): boolean {
  return sessionId.startsWith("claude-synth-");
}

async function resolveObservedClaudeSessionId(stateDir: string, sessionId: string): Promise<string> {
  if (!isSyntheticClaudeSessionId(sessionId)) {
    return sessionId;
  }
  // Persisted synth->real binding takes priority so the overlay keeps a stable
  // anchor across requests and restarts, even if the "latest" session changes.
  const persisted = await lookupRealSessionId(stateDir, sessionId);
  if (persisted) {
    return persisted;
  }
  const latestSessionId = await resolveLatestClaudeCodeSessionId(stateDir);
  if (latestSessionId && !isSyntheticClaudeSessionId(latestSessionId)) {
    await recordSessionMapping(stateDir, sessionId, latestSessionId);
    return latestSessionId;
  }
  return sessionId;
}

function normalizeRequestHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(headers));
}

function countAnthropicMessagePayloadText(payload: unknown): string {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const system = typeof root.system === "string" ? root.system : "";
  const messagesText = Array.isArray(root.messages)
    ? root.messages
      .map((message) => {
        const item = message && typeof message === "object" && !Array.isArray(message)
          ? message as Record<string, unknown>
          : {};
        const content = item.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((block) => {
            const entry = block && typeof block === "object" && !Array.isArray(block)
              ? block as Record<string, unknown>
              : {};
            if (typeof entry.text === "string") return entry.text;
            if (typeof entry.content === "string") return entry.content;
            if (typeof entry.input === "string") return entry.input;
            if (typeof entry.output === "string") return entry.output;
            return "";
          })
          .filter(Boolean)
          .join("\n");
      })
      .filter(Boolean)
      .join("\n")
    : "";
  return [system, messagesText].filter(Boolean).join("\n");
}

async function recordClaudeRequestReductionUx(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  originalRequestText: string;
  reducedRequestText: string;
}): Promise<void> {
  const beforeCount = countTextWithPreciseTokens(params.model, params.originalRequestText);
  const afterCount = countTextWithPreciseTokens(params.model, params.reducedRequestText);
  const countMode = beforeCount.mode === "openai_tokens" && afterCount.mode === "openai_tokens"
    ? "openai_tokens"
    : "chars";
  const savedCount = countMode === "chars"
    ? Math.max(0, params.originalRequestText.length - params.reducedRequestText.length)
    : Math.max(0, beforeCount.count - afterCount.count);
  if (savedCount <= 0) return;
  await recordUxEffect(params.stateDir, {
    at: new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model,
    countMode,
    beforeCount: countMode === "chars" ? params.originalRequestText.length : beforeCount.count,
    afterCount: countMode === "chars" ? params.reducedRequestText.length : afterCount.count,
    savedCount,
    details: {
      requestSavedCount: savedCount,
    },
  });
}

function extractWorkspaceHint(envelope: {
  instructions?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const metadataHint = typeof envelope.metadata?.workspaceHint === "string"
    ? envelope.metadata.workspaceHint.trim()
    : "";
  if (metadataHint) return metadataHint;
  const instructions = typeof envelope.instructions === "string" ? envelope.instructions : "";
  const match = instructions.match(/Your working directory is:\s*(.+)/);
  const raw = match?.[1]?.trim() ?? "";
  return raw && raw !== "<WORKDIR>" ? raw : undefined;
}

async function recordClaudeGatewayTurn(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  responseId?: string;
  previousResponseId?: string;
  disclosedReadPaths?: string[];
  requestChars: number;
  responseChars: number;
  assistantChars: number;
  reductionSavedChars: number;
  evictionSavedChars: number;
  stablePrefixApplied: boolean;
  reductionApplied: boolean;
  stream: boolean;
  workspaceHint?: string;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  await upsertClaudeCodeSessionSnapshot(params.stateDir, params.sessionId, {
    latestResponseId: params.responseId,
    previousResponseId: params.previousResponseId,
    latestModel: params.model,
    workspaceHint: params.workspaceHint,
    disclosedReadPaths: params.disclosedReadPaths,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
    evictionSavedChars: params.evictionSavedChars,
  });
  await appendClaudeCodeRecentTurnBinding(params.stateDir, {
    sessionId: params.sessionId,
    responseId: params.responseId,
    previousResponseId: params.previousResponseId,
    model: params.model,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
    evictionSavedChars: params.evictionSavedChars,
    stablePrefixApplied: params.stablePrefixApplied,
    reductionApplied: params.reductionApplied,
    stream: params.stream,
    updatedAt,
  });
}

export async function startClaudeCodeGatewayRuntime(params: {
  config: TokenPilotClaudeCodeConfig;
  logger: TokenPilotClaudeCodeLogger;
  forwarder?: HostGatewayForwarder;
  streamObserver?: HostGatewayStreamObserver;
  dependencies?: ClaudeCodeGatewayRuntimeDependencies;
}): Promise<ClaudeCodeGatewayRuntime> {
  initializeClaudeCodeTokenPilotPreset();
  const { config, logger } = params;
  if (!config.enabled) {
    throw new Error("TokenPilot Claude Code adapter is disabled by config");
  }

  configureStatePathResolver(createStaticStatePathResolver({
    hostId: "claude-code",
    displayName: "Claude Code",
    stateDir: config.stateDir,
    namespaceDir: "tokenpilot",
  }));

  await mkdir(config.stateDir, { recursive: true });
  const upstream = resolveClaudeCodeUpstream(config);
  const codec = createClaudeMessagesPayloadCodec();
  const forwarder = params.forwarder ?? createClaudeCodeGatewayForwarder(config);
  const streamObserver = params.streamObserver ?? createSseJsonStreamObserver({
    responseIdPaths: [["message", "id"], ["id"]],
    usagePaths: [["usage"]],
  });

  const runtime = await startHostGatewayRuntimeServer({
    port: config.proxyPort,
    requestPath: "/v1/messages",
    basePath: "/v1",
    healthPayload: {
      ok: true,
      adapter: "tokenpilot-claude-code",
      upstream: upstream.baseUrl,
      stateDir: config.stateDir,
    },
    async handleRoute({ req, res, pathname, readBody }) {
      const inboundHeaders = normalizeRequestHeaders(req.headers);
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;

      if (req.method === "GET" && pathname === "/v1/models") {
        const upstreamResp = await forwardGatewayRequest({
          upstream,
          method: "GET",
          requestPath: "/v1/models",
          inboundAuthorization: authorization,
          inboundHeaders,
        });
        if (upstreamResp.status === 404) {
          sendJsonResponse(res, 200, buildAnthropicGatewayModelList(config));
          return true;
        }
        const text = await upstreamResp.text();
        setForwardResponseHeaders(res, Object.fromEntries(upstreamResp.headers.entries()), "application/json; charset=utf-8");
        res.statusCode = upstreamResp.status;
        res.end(text);
        return true;
      }

      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        const body = await readBody();
        const payload = JSON.parse(body);
        const upstreamPayload = {
          ...payload,
          model: typeof payload?.model === "string"
            ? mapClaudeVisibleModelToUpstreamModel(config, payload.model)
            : payload?.model,
        };
        const upstreamResp = await forwardGatewayRequest({
          upstream,
          method: "POST",
          requestPath: "/v1/messages/count_tokens",
          payload: upstreamPayload,
          inboundAuthorization: authorization,
          inboundHeaders,
        });

        if (upstreamResp.status !== 404) {
          const text = await upstreamResp.text();
          setForwardResponseHeaders(res, Object.fromEntries(upstreamResp.headers.entries()), "application/json; charset=utf-8");
          res.statusCode = upstreamResp.status;
          res.end(text);
          return true;
        }

        const countText = countAnthropicMessagePayloadText(payload);
        const model = typeof payload?.model === "string" && payload.model.trim()
          ? payload.model
          : "claude-sonnet-4-6";
        const tokenCount = countTextWithPreciseTokens(model, countText);
        sendJsonResponse(res, 200, {
          input_tokens: tokenCount.count,
        });
        return true;
      }

      return false;
    },
    async handleRequest({ req, res, body }) {
      let payload = JSON.parse(body);
      let envelope = codec.decodeRequest(payload, {
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      const originalRequestText = typeof envelope.metadata?.inputText === "string"
        ? envelope.metadata.inputText
        : "";
      const sessionId = await resolveObservedClaudeSessionId(config.stateDir, envelope.session.sessionId);
      const evictionEnabled = config.modules.eviction && config.eviction.enabled;
      let evictionSummary: ClaudeEvictionApplySummary = {
        enabled: evictionEnabled,
        changed: false,
        evictedMessageCount: 0,
        evictedToolResultCount: 0,
        savedChars: 0,
        evictedBlockIds: [],
      };
      let evictionBypassReason: string | undefined;
      let activePlanId: string | undefined;
      let activePlanStatus: "active" | "applied" | undefined;
      if (evictionEnabled) {
        try {
          const candidatePayload = (
            params.dependencies?.cloneRequestPayload ?? structuredClone
          )(payload) as { messages?: unknown[] };
          const overlayMessages =
            (candidatePayload.messages ?? []) as typeof envelope.messages;
          const revision = _createHash("sha256")
            .update(JSON.stringify(overlayMessages))
            .digest("hex")
            .slice(0, 32);

          const analysis = analyzeClaudeEviction({
            sessionId,
            model: envelope.model,
            messages: overlayMessages,
            config: { enabled: true, minBlockChars: config.eviction.minBlockChars },
          });

          if (analysis.changed && analysis.selections.length > 0) {
            const { bindings } = buildToolResultSegments(overlayMessages);
            const segmentLocations = new Map(
              [...bindings.entries()].map(([segmentId, binding]) => [
                segmentId,
                { messageIndex: binding.messageIndex, blockIndex: binding.blockIndex },
              ]),
            );

            const overlayRequest = { sessionId, revision, messages: overlayMessages };
            const snapshot = await claudeContextRewriteBackend.readSnapshot({
              sessionId,
              request: overlayRequest,
            });
            // Persist the latest complete snapshot (+ item fingerprints) for this
            // session so the overlay has a durable, restart-surviving view of the
            // current turn (§4.5 claude-context). Fail-open, never blocks the request.
            await saveLatestClaudeSnapshot(config.stateDir, sessionId, snapshot);
            const loaded = await loadActiveContextMutationPlans({
              stateDir: config.stateDir,
              sessionId,
            });
            // Relocate any active plan onto the CURRENT snapshot: a later turn
            // may have shifted item positions (new stableIds + revision) while
            // the underlying content is unchanged, so an exact-revision match
            // would miss it. relocate re-anchors operations by fingerprint and
            // defers anything ambiguous or gone.
            let plan: ReturnType<typeof buildContextMutationPlan> | undefined;
            let replayedFromStore = false;
            for (const candidate of loaded.plans) {
              const { plan: relocatedPlan, relocated } = relocateContextMutationPlan({
                snapshot,
                plan: candidate,
              });
              if (relocated) {
                // Re-persist the relocated plan so its stored form tracks the
                // current revision (supervisor-confirmed behavior).
                await saveActiveContextMutationPlan({
                  stateDir: config.stateDir,
                  plan: relocatedPlan,
                });
                plan = relocatedPlan;
                replayedFromStore = true;
                break;
              }
            }
            if (!replayedFromStore) {
            if (loaded.bypassed) {
              throw new Error(`context mutation plan store unavailable: ${loaded.reasons.join(",")}`);
            }
            const persistedPlan = loaded.plans.find(
              (candidate) => candidate.baseRevision === snapshot.revision,
            );
            let plan;
            if (persistedPlan) {
              plan = persistedPlan;
              activePlanStatus = "active";
            } else {
              plan = buildContextMutationPlan({
                hostId: "claude-code",
                sessionId,
                snapshot,
                selections: analysis.selections.map((selection) => ({
                  segmentIds: selection.segmentIds,
                  chars: selection.chars,
                })),
                segmentLocations,
              });
              const stored = await saveActiveContextMutationPlan({
                stateDir: config.stateDir,
                plan,
              });
              if (stored.bypassed || (stored.status !== "active" && stored.status !== "applied")) {
                throw new Error(`context mutation plan could not be persisted: ${stored.reasons.join(",")}`);
              }
              activePlanStatus = stored.status;
            }
            if (!plan) {
              throw new Error("context mutation plan unavailable");
            }
            // Archive stage (before apply): each tool_result the plan would evict
            // is archived first. On success we record the opaque archiveRef on the
            // op so apply writes a recovery_ref into the stub. On failure we drop
            // that item from the op targets so apply will NOT stub it — the
            // original stays in the forwarded request. Never stub without a
            // successful archive, or the content is deleted unrecoverably.
            await applyArchivePlan({
              stateDir: config.stateDir,
              sessionId,
              snapshot,
              plan,
              request: overlayRequest,
            });
            activePlanId = plan.planId;
            const { request: rewritten, result } = await claudeContextRewriteBackend.apply({
              snapshot,
              plan,
              request: overlayRequest,
            });
            if (result.changed && activePlanStatus === "active") {
              const applied = await markContextMutationPlanApplied({
                stateDir: config.stateDir,
                sessionId,
                planId: plan.planId,
              });
              // Record this turn's overlay in the append-only audit log (§4.5).
              await appendOverlayHistory(config.stateDir, {
                sessionId,
                planId: plan.planId,
                previousRevision: result.previousRevision,
                nextRevision: result.nextRevision,
                removedItemIds: result.removedItemIds,
                savedChars: result.savedChars,
                relocated: replayedFromStore,
              });
              if (applied.bypassed) {
                throw new Error(`context mutation plan commit failed: ${applied.reasons.join(",")}`);
              }
            }

            evictionSummary = {
              ...evictionSummary,
              changed: result.changed,
              savedChars: result.savedChars,
              evictedBlockIds: result.removedItemIds,
              evictedToolResultCount: result.removedItemIds.length,
              evictedMessageCount: result.removedItemIds.length,
            };

            if (result.changed) {
              payload = { ...(payload as Record<string, unknown>), messages: rewritten.messages };
              envelope = codec.decodeRequest(payload, {
                headers: req.headers as Record<string, string | string[] | undefined>,
              });
            }
          }
        } catch {
          evictionBypassReason = "analysis_or_apply_error";
          logger.warn("context eviction bypassed category=analysis_or_apply_error");
          if (activePlanId && activePlanStatus === "active") {
            await markContextMutationPlanFailed({
              stateDir: config.stateDir,
              sessionId,
              planId: activePlanId,
            }).catch(() => undefined);
          }
        }
      }
      if (envelope.model.startsWith("tokenpilot/")) {
        envelope = {
          ...envelope,
          model: envelope.model.slice("tokenpilot/".length),
        };
      }
      envelope = {
        ...envelope,
        model: mapClaudeVisibleModelToUpstreamModel(config, envelope.model),
      };
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const model = envelope.model;
      const workspaceHint = extractWorkspaceHint(envelope);
      const prepared = await prepareObservedBeforeCall<ClaudeReductionSummary>({
        envelope,
        codec,
        config: { mode: "normal" },
        prepareStablePrefix(nextEnvelope) {
          return prepareClaudeStablePrefix(canonicalizeEnvelopeTools(nextEnvelope), config);
        },
        async applyBeforeCallReduction({ envelope: nextEnvelope, codec: nextCodec }) {
          return reduceClaudeRequestEnvelope({
            envelope: nextEnvelope,
            codec: nextCodec,
            config,
          });
        },
        observability: {
          stateDir: config.stateDir,
          sessionId,
          model,
          recordUxEffectNow: false,
          buildStability({ originalEnvelope, prepared }) {
            return prepared.diagnostics.stablePrefixApplied === true
              ? buildStabilityVisualSnapshotFromEnvelopes({
                sessionId,
                model,
                upstreamModel: model,
                originalEnvelope,
                preparedEnvelope: prepared.envelope,
                dynamicContextTarget: config.hooks.dynamicContextTarget,
                getDeveloperText(envelope) {
                  return typeof envelope.instructions === "string" ? envelope.instructions : "";
                },
              })
              : undefined;
          },
          buildReduction(reductionSummary) {
            return reductionSummary.savedChars > 0
              ? {
                countMode: "chars",
                beforeCount: reductionSummary.beforeChars,
                afterCount: reductionSummary.afterChars,
                savedCount: reductionSummary.savedChars,
                details: {
                  requestSavedCount: reductionSummary.savedChars,
                },
                segments: (reductionSummary.visualSegments ?? []).map((segment) => ({
                  segmentId: segment.segmentId,
                  itemIndex: segment.messageIndex,
                  field: segment.field === "text" ? "content" : segment.field,
                  blockIndex: segment.blockIndex,
                  toolName: segment.toolName,
                  savedChars: segment.savedChars,
                  beforeText: segment.beforeText,
                  afterText: segment.afterText,
                  report: segment.report,
                })),
              }
              : undefined;
          },
        },
      });
      const reductionSummary = prepared.reductionSummary;
      {
        const encoded = encodeRequestOrBypass({ codec, envelope: prepared.envelope, rawBody: body });
        payload = encoded.payload as Record<string, unknown>;
        if (encoded.bypassed) {
          evictionBypassReason = "encode_error";
          logger.warn("context overlay bypassed category=encode_error");
        }
      }
      const reducedRequestText = typeof prepared.envelope.metadata?.inputText === "string"
        ? prepared.envelope.metadata.inputText
        : "";
      const cacheAuditSnapshot = buildClaudeCodeCacheAuditSnapshot({
        envelope: prepared.envelope,
        sessionId,
        model: prepared.envelope.model,
        stream: prepared.envelope.stream,
        originalRequestPromptCacheKey:
          typeof prepared.envelope.metadata?.originalPromptCacheKey === "string"
            ? prepared.envelope.metadata.originalPromptCacheKey
            : null,
        requestPromptCacheKey:
          typeof prepared.envelope.metadata?.frameworkStablePromptCacheKey === "string"
            ? prepared.envelope.metadata.frameworkStablePromptCacheKey
            : typeof prepared.envelope.metadata?.promptCacheKey === "string"
              ? prepared.envelope.metadata.promptCacheKey
            : null,
      });

      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_before_call",
        sessionId,
        model: prepared.envelope.model,
        stream: prepared.envelope.stream,
        requestChars: body.length,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        reductionChangedBlocks: reductionSummary?.changedBlocks ?? 0,
        reductionChangedMessages: reductionSummary?.changedMessages ?? 0,
        reductionSkippedReason: reductionSummary?.skippedReason ?? null,
        reductionPassEffects: reductionSummary?.passEffects ?? [],
        evictionEnabled: evictionSummary.enabled,
        evictionApplied: evictionSummary.changed,
        evictionSavedChars: evictionSummary.savedChars,
        evictionChangedMessages: evictionSummary.evictedMessageCount,
        evictionChangedToolResults: evictionSummary.evictedToolResultCount,
        evictionBypassReason: evictionBypassReason ?? null,
      });

      if (prepared.envelope.stream) {
        const upstreamResp = await forwarder.requestStream({
          upstream,
          payload,
          inboundAuthorization: authorization,
          inboundHeaders: normalizeRequestHeaders(req.headers),
        });
        res.statusCode = upstreamResp.status;
        setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        const chunks: Buffer[] = [];
        upstreamResp.stream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          chunks.push(buffer);
          res.write(buffer);
        });
        upstreamResp.stream.once("end", async () => {
          const rawStreamText = Buffer.concat(chunks).toString("utf8");
          const snapshot = streamObserver.snapshot(rawStreamText);
          const responseId = typeof snapshot.metadata?.responseId === "string" ? snapshot.metadata.responseId : undefined;
          const previousResponseId =
            typeof snapshot.metadata?.previousResponseId === "string" ? snapshot.metadata.previousResponseId : undefined;
          await recordClaudeRequestReductionUx({
            stateDir: config.stateDir,
            sessionId,
            model: prepared.envelope.model,
            originalRequestText,
            reducedRequestText,
          });
          await appendClaudeCodeCacheAuditRecord({
            stateDir: config.stateDir,
            snapshot: cacheAuditSnapshot,
            responsePromptCacheKey: null,
            usage: snapshot.usage ?? null,
            status: upstreamResp.status,
          });
          await appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            assistantChars: snapshot.assistantText.length,
            responseChars: rawStreamText.length,
          });
          await recordClaudeGatewayTurn({
            stateDir: config.stateDir,
            sessionId,
            model: prepared.envelope.model,
            responseId,
            previousResponseId,
            disclosedReadPaths: reductionSummary?.disclosedReadPaths,
            requestChars: body.length,
            responseChars: rawStreamText.length,
            assistantChars: snapshot.assistantText.length,
            reductionSavedChars: reductionSummary?.savedChars ?? 0,
            evictionSavedChars: evictionSummary?.savedChars ?? 0,
            stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
            reductionApplied: prepared.diagnostics.reductionApplied === true,
            stream: true,
            workspaceHint,
          });
          res.end();
        });
        upstreamResp.stream.once("error", (error) => {
          logger.error(error instanceof Error ? error.message : String(error));
          void appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.destroyed) {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
        return;
      }

      const upstreamResp = await forwarder.request({
        upstream,
        payload,
        inboundAuthorization: authorization,
        inboundHeaders: normalizeRequestHeaders(req.headers),
      });
      setForwardResponseHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.statusCode = upstreamResp.status;
      let assistantChars = 0;
      let responseId: string | undefined;
      let previousResponseId: string | undefined;
      let responsePromptCacheKey: string | undefined;
      let decodedUsage: Record<string, unknown> | null = null;
      try {
        const decoded = codec.decodeResponse(JSON.parse(upstreamResp.text), prepared.envelope);
        assistantChars = decoded.assistantText?.length ?? 0;
        responseId = typeof decoded.metadata?.responseId === "string" ? decoded.metadata.responseId : undefined;
        previousResponseId =
          typeof decoded.metadata?.previousResponseId === "string" ? decoded.metadata.previousResponseId : undefined;
        responsePromptCacheKey =
          typeof decoded.metadata?.promptCacheKey === "string" ? decoded.metadata.promptCacheKey : undefined;
        decodedUsage = decoded.usage ?? null;
      } catch {
        assistantChars = 0;
      }
      await recordClaudeRequestReductionUx({
        stateDir: config.stateDir,
        sessionId,
        model: prepared.envelope.model,
        originalRequestText,
        reducedRequestText,
      });
      await appendClaudeCodeCacheAuditRecord({
        stateDir: config.stateDir,
        snapshot: cacheAuditSnapshot,
        responsePromptCacheKey,
        usage: decodedUsage,
        status: upstreamResp.status,
      });
      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_after_call",
        sessionId,
        model: prepared.envelope.model,
        stream: false,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
        assistantChars,
      });
      await recordClaudeGatewayTurn({
        stateDir: config.stateDir,
        sessionId,
        model: prepared.envelope.model,
        responseId,
        previousResponseId,
        disclosedReadPaths: reductionSummary?.disclosedReadPaths,
        requestChars: body.length,
        responseChars: upstreamResp.text.length,
        assistantChars,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        evictionSavedChars: evictionSummary?.savedChars ?? 0,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        stream: false,
        workspaceHint,
      });
      res.end(upstreamResp.text);
    },
    async handleError({ error, res }) {
      logger.error(error instanceof Error ? error.message : String(error));
      sendJsonResponse(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return {
    baseUrl: proxyBaseUrlForPort(config.proxyPort),
    close: runtime.close,
  };
}
