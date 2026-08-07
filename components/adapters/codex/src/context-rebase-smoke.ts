import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reserveUnusedPort } from "@lightmem2/host-adapter";

import { normalizeTokenPilotCodexConfig } from "./config.js";
import {
  buildCodexEffectiveHistory,
  loadCodexContextHistoryJournal,
  type JsonObject,
} from "./context-history/index.js";
import type { TokenPilotCodexLogger } from "./logger.js";
import { startCodexResponsesProxy, type CodexProxyRuntime } from "./proxy-runtime.js";
import {
  readCodexRebaseCooldownJournal,
  readLatestCodexRebaseEpoch,
} from "./context-rewrite/index.js";
import type { CodexRebaseAccounting } from "./context-rewrite/types.js";
import { resolveCodexSessionIdByResponseId } from "./session-state.js";

export const CODEX_REBASE_SMOKE_EVIDENCE_SCHEMA =
  "lightmem2.codex.context-rebase-smoke-evidence/v1";

export type CodexRebaseSmokeAccountingEvidence = {
  plannedSavedChars: number;
  plannedSavedTokens: number;
  actuallyRemovedChars: number;
  actuallyRemovedTokens: number;
  rebaseReplayCostChars: number;
  rebaseReplayCostTokens: number;
  subsequentSavedCharsPerTurn: number;
  subsequentSavedTokensPerTurn: number;
  estimatorCostChars: number;
  estimatorCostTokens: number;
  fallbackExtraRequestCount: number;
  cacheColdMissCount: number;
  breakEvenTurn?: number;
};

export type CodexRebaseSmokeEvidence = {
  schema: typeof CODEX_REBASE_SMOKE_EVIDENCE_SCHEMA;
  mode: "mock";
  provider: "local-scripted-responses";
  model: string;
  endpoint: "loopback-temporary";
  runtime: {
    node: string;
    codexCli: string;
  };
  startedAt: string;
  finishedAt: string;
  happyPath: {
    upstreamRequestCount: number;
    rebaseRequestFound: boolean;
    oldPreviousResponseIdRemoved: boolean;
    sentinel: {
      evictedAbsent: boolean;
      retainedPresent: boolean;
    };
    replayItemTypes: string[];
    reasoning: {
      present: boolean;
      encryptedPayloadChars: number;
      encryptedPayloadSha256: string;
      encryptedPayloadDigestMatches: boolean;
    };
    toolClosure: {
      callCount: number;
      outputCount: number;
      complete: boolean;
    };
    responseChain: {
      newRootResponseIdPresent: boolean;
      terminalResponseIdPresent: boolean;
      terminalSessionMappingMatches: boolean;
      epochCommitted: boolean;
      journalCommittedBeforeEpoch: boolean;
      continuationTurns: number;
      linksValid: boolean;
      restartPreserved: boolean;
      finalHistoryComplete: boolean;
    };
    accounting?: CodexRebaseSmokeAccountingEvidence;
  };
  fallback: {
    rebaseAttempts: number;
    originalRequestRetries: number;
    fallbackSucceeded: boolean;
    originalPreviousResponseIdRestored: boolean;
    epochRolledBack: boolean;
    cooldownRecorded: boolean;
    accounting?: CodexRebaseSmokeAccountingEvidence;
  };
  moduleMatrix: Array<{
    stabilizer: boolean;
    reduction: boolean;
    rewrite: boolean;
    stablePrefixApplied: boolean;
    reductionApplied: boolean;
    rewriteApplied: boolean;
    isolationPassed: boolean;
  }>;
  privacy: {
    credentialSource: "not-required";
    rawPromptPersisted: false;
    rawEncryptedPayloadPersisted: false;
    rawHeadersPersisted: false;
    ephemeralStateRemoved: true;
  };
};

export type RunCodexRebaseMockSmokeOptions = {
  model?: string;
  outputDir?: string;
};

export type CodexRebaseSmokeRunResult = {
  artifactPath: string;
  artifactSha256: string;
  evidence: CodexRebaseSmokeEvidence;
};

type MockUpstream = {
  baseUrl: string;
  requests: JsonObject[];
  close(): Promise<void>;
};

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6697, 10080,
]);
const SAFE_MODEL_LABEL_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const SAFE_VERSION_LABEL_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,79}$/i;
const CREDENTIAL_SHAPED_PATTERN = /(?:\bsk-(?:proj-)?[a-z0-9_-]{16,}\b|\bgh[pousr]_[a-z0-9_]{16,}\b|\bgithub_pat_[a-z0-9_]{16,}\b|\bAKIA[0-9A-Z]{16}\b)/i;

const silentLogger: TokenPilotCodexLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function smokeModelLabel(value: string | undefined): string {
  const model = value?.trim() || "gpt-5.4-mini";
  if (!SAFE_MODEL_LABEL_PATTERN.test(model) || CREDENTIAL_SHAPED_PATTERN.test(model)) {
    throw new TypeError("Codex rebase smoke model must be a non-sensitive model label");
  }
  return model;
}

function codexCliVersionLabel(value: string | undefined): string {
  const version = value?.trim();
  return version
    && SAFE_VERSION_LABEL_PATTERN.test(version)
    && !CREDENTIAL_SHAPED_PATTERN.test(version)
    ? version
    : "not-observed";
}

function jsonItems(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function serializedInput(payload: JsonObject | undefined): string {
  return JSON.stringify(jsonItems(payload?.input));
}

function accountingEvidence(
  accounting: CodexRebaseAccounting | undefined,
): CodexRebaseSmokeAccountingEvidence | undefined {
  if (!accounting) return undefined;
  return { ...accounting };
}

async function reserveFetchPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await reserveUnusedPort();
    if (!FETCH_FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("Unable to reserve a fetch-safe smoke port");
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    req.on("error", reject);
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
  });
}

async function startMockUpstream(params: {
  prefix: string;
  encryptedPayload?: string;
  rejectRebase?: boolean;
}): Promise<MockUpstream> {
  const port = await reserveFetchPort();
  const requests: JsonObject[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const payload = JSON.parse(await readRequestBody(req)) as JsonObject;
    requests.push(payload);
    const requestOrdinal = requests.length;
    const isRebase = requestOrdinal > 1 && !("previous_response_id" in payload);
    if (params.rejectRebase && isRebase) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: { code: "invalid_request_error", message: "scripted replay schema rejection" },
      }));
      return;
    }

    const responseId = `${params.prefix}-${requestOrdinal}`;
    const output = requestOrdinal === 1 && params.encryptedPayload
      ? [
        {
          id: `${params.prefix}-reasoning-1`,
          type: "reasoning",
          encrypted_content: params.encryptedPayload,
          summary: [],
        },
        {
          id: `${params.prefix}-call-item-1`,
          type: "function_call",
          call_id: `${params.prefix}-call-1`,
          name: "lookup_smoke_fixture",
          arguments: JSON.stringify({ record: "retained" }),
        },
      ]
      : [
        {
          id: `${params.prefix}-message-${requestOrdinal}`,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `scripted response ${requestOrdinal}` }],
        },
      ];
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: responseId,
      object: "response",
      status: "completed",
      previous_response_id:
        typeof payload.previous_response_id === "string" ? payload.previous_response_id : undefined,
      output,
    }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close() {
      return new Promise<void>((resolveClose, reject) => {
        server.close((error) => error ? reject(error) : resolveClose());
      });
    },
  };
}

function buildSmokeConfig(params: {
  stateDir: string;
  proxyPort: number;
  upstreamBaseUrl: string;
  modelPlan?: { stableItemId: string };
  modules?: { stabilizer: boolean; reduction: boolean };
  rewriteEnabled?: boolean;
}) {
  return normalizeTokenPilotCodexConfig({
    stateDir: params.stateDir,
    proxyPort: params.proxyPort,
    upstreamProvider: "OpenAI",
    upstream: {
      name: "local-scripted-responses",
      baseUrl: params.upstreamBaseUrl,
      wireApi: "responses",
      requiresOpenAIAuth: false,
    },
    modules: {
      stabilizer: params.modules?.stabilizer ?? false,
      reduction: params.modules?.reduction ?? false,
    },
    contextRewrite: {
      enabled: params.rewriteEnabled ?? true,
      providerCompatibilityProbe: "mock_fixture",
      mode: "response_chain_rebase",
      failureMode: "bypass",
      retryOriginalRequest: true,
      cooldownMs: 300_000,
      mutationPlan: params.modelPlan
        ? { operations: [{ type: "evict", stableItemId: params.modelPlan.stableItemId }] }
        : { operations: [] },
    },
    reduction: {
      triggerMinChars: 256,
      maxToolChars: 400,
      passes: {
        readStateCompaction: false,
        toolPayloadTrim: true,
        htmlSlimming: false,
        execOutputTruncation: true,
        agentsStartupOptimization: false,
      },
      passOptions: {
        execOutputTruncation: {
          toolThresholds: { bash: 400 },
        },
      },
    },
  });
}

async function postResponse(
  runtime: CodexProxyRuntime,
  payload: JsonObject,
): Promise<JsonObject> {
  const response = await fetch(`${runtime.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex rebase smoke request failed with status ${response.status}`);
  }
  const parsed = JSON.parse(text) as JsonObject;
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw new Error("Codex rebase smoke response did not include a response id");
  }
  return parsed;
}

function toolClosureEvidence(input: JsonObject[]): {
  callCount: number;
  outputCount: number;
  complete: boolean;
} {
  const calls = input.filter((item) => item.type === "function_call");
  const outputs = input.filter((item) => item.type === "function_call_output");
  const callIds = calls.map((item) => item.call_id).filter((value): value is string => typeof value === "string");
  const outputIds = outputs
    .map((item) => item.call_id)
    .filter((value): value is string => typeof value === "string");
  const complete = callIds.length === calls.length
    && outputIds.length === outputs.length
    && new Set(callIds).size === callIds.length
    && new Set(outputIds).size === outputIds.length
    && callIds.length === outputIds.length
    && callIds.every((callId) => outputIds.includes(callId));
  return { callCount: calls.length, outputCount: outputs.length, complete };
}

async function runHappyPath(model: string): Promise<CodexRebaseSmokeEvidence["happyPath"]> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-smoke-state-"));
  const marker = randomUUID();
  const evictSentinel = `EVICT_ME_${marker}`;
  const keepSentinel = `KEEP_ME_${marker}`;
  const encryptedPayload = `synthetic-encrypted-reasoning-${randomUUID()}`;
  const sessionId = `codex-rebase-smoke-${randomUUID()}`;
  const upstream = await startMockUpstream({
    prefix: "resp-smoke",
    encryptedPayload,
  });
  let runtime: CodexProxyRuntime | undefined;
  try {
    const config = buildSmokeConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamBaseUrl: upstream.baseUrl,
    });
    runtime = await startCodexResponsesProxy({
      config,
      logger: silentLogger,
      allowMockFixtureEvidence: true,
    });

    const first = await postResponse(runtime, {
      model,
      stream: false,
      include: ["reasoning.encrypted_content"],
      metadata: { tokenpilotSessionId: sessionId },
      input: [
        { role: "user", content: evictSentinel },
        { role: "user", content: keepSentinel },
      ],
    });
    const firstResponseId = String(first.id);
    const second = await postResponse(runtime, {
      model,
      stream: false,
      include: ["reasoning.encrypted_content"],
      previous_response_id: firstResponseId,
      input: [{
        type: "function_call_output",
        call_id: "resp-smoke-call-1",
        output: "retained tool result",
      }],
    });
    let previousResponseId = String(second.id);

    const beforeRebase = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: previousResponseId,
    });
    const evictedItem = beforeRebase.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes(evictSentinel)
    ));
    if (!evictedItem) throw new Error("Smoke setup could not resolve the eviction target");
    config.contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: evictedItem.stableItemId }],
    };

    const rebaseResponse = await postResponse(runtime, {
      model,
      stream: false,
      include: ["reasoning.encrypted_content"],
      previous_response_id: previousResponseId,
      input: [{ role: "user", content: "new chain turn 1" }],
    });
    previousResponseId = String(rebaseResponse.id);
    const newRootResponseIdPresent = previousResponseId.length > 0;
    config.contextRewrite.mutationPlan = { operations: [] };

    let restartPreserved = false;
    const continuationLinks: boolean[] = [];
    for (let turn = 2; turn <= 5; turn += 1) {
      if (turn === 3) {
        const headBeforeRestart = previousResponseId;
        await runtime.close();
        runtime = undefined;
        const restartedConfig = buildSmokeConfig({
          stateDir,
          proxyPort: await reserveFetchPort(),
          upstreamBaseUrl: upstream.baseUrl,
        });
        runtime = await startCodexResponsesProxy({
          config: restartedConfig,
          logger: silentLogger,
          allowMockFixtureEvidence: true,
        });
        restartPreserved = await resolveCodexSessionIdByResponseId(stateDir, headBeforeRestart) === sessionId;
      }
      const expectedPreviousResponseId = previousResponseId;
      const requestIndex = upstream.requests.length;
      const response = await postResponse(runtime, {
        model,
        stream: false,
        include: ["reasoning.encrypted_content"],
        previous_response_id: expectedPreviousResponseId,
        input: [{ role: "user", content: `new chain turn ${turn}` }],
      });
      previousResponseId = String(response.id);
      continuationLinks.push(
        upstream.requests[requestIndex]?.previous_response_id === expectedPreviousResponseId,
      );
    }

    const rebasePayload = upstream.requests[2];
    const replayInput = jsonItems(rebasePayload?.input);
    const replayText = serializedInput(rebasePayload);
    const reasoning = replayInput.find((item) => item.type === "reasoning");
    const replayedEncryptedPayload = typeof reasoning?.encrypted_content === "string"
      ? reasoning.encrypted_content
      : "";
    const closure = toolClosureEvidence(replayInput);
    const epoch = await readLatestCodexRebaseEpoch({ stateDir, sessionId });
    const journal = await loadCodexContextHistoryJournal(stateDir, sessionId);
    const committedRootResponse = journal.find((entry) => (
      entry.kind === "response"
      && entry.responseId === String(rebaseResponse.id)
      && entry.status === "completed"
      && entry.previousResponseId === null
    ));
    const committedRootRequest = committedRootResponse?.requestId
      ? journal.find((entry) => (
        entry.kind === "request"
        && entry.requestId === committedRootResponse.requestId
        && entry.status === "completed"
        && Array.isArray(entry.committedInputItems)
      ))
      : undefined;
    const finalHistory = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: previousResponseId,
    });
    const finalHistoryText = JSON.stringify(finalHistory.replayableItems);
    const terminalSessionMappingMatches =
      await resolveCodexSessionIdByResponseId(stateDir, previousResponseId) === sessionId;

    return {
      upstreamRequestCount: upstream.requests.length,
      rebaseRequestFound: Boolean(rebasePayload),
      oldPreviousResponseIdRemoved: Boolean(rebasePayload) && !("previous_response_id" in rebasePayload),
      sentinel: {
        evictedAbsent: !replayText.includes(evictSentinel) && !finalHistoryText.includes(evictSentinel),
        retainedPresent: replayText.includes(keepSentinel) && finalHistoryText.includes(keepSentinel),
      },
      replayItemTypes: replayInput.map((item) => (
        typeof item.type === "string"
          ? item.type
          : typeof item.role === "string" ? `message:${item.role}` : "unknown"
      )),
      reasoning: {
        present: Boolean(reasoning),
        encryptedPayloadChars: replayedEncryptedPayload.length,
        encryptedPayloadSha256: sha256(replayedEncryptedPayload),
        encryptedPayloadDigestMatches: sha256(replayedEncryptedPayload) === sha256(encryptedPayload),
      },
      toolClosure: closure,
      responseChain: {
        newRootResponseIdPresent,
        terminalResponseIdPresent: previousResponseId.length > 0,
        terminalSessionMappingMatches,
        epochCommitted: epoch?.status === "committed",
        journalCommittedBeforeEpoch:
          epoch?.status === "committed"
          && epoch.newResponseId === String(rebaseResponse.id)
          && Boolean(committedRootResponse)
          && Boolean(committedRootRequest)
          && Date.parse(committedRootResponse?.observedAt ?? "") <= Date.parse(epoch.updatedAt),
        continuationTurns: 5,
        linksValid: continuationLinks.every(Boolean),
        restartPreserved,
        finalHistoryComplete: !finalHistory.incomplete,
      },
      accounting: accountingEvidence(epoch?.accounting),
    };
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function runFallbackPath(model: string): Promise<CodexRebaseSmokeEvidence["fallback"]> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-fallback-smoke-state-"));
  const evictSentinel = `EVICT_ME_${randomUUID()}`;
  const sessionId = `codex-rebase-fallback-smoke-${randomUUID()}`;
  const upstream = await startMockUpstream({ prefix: "resp-fallback", rejectRebase: true });
  let runtime: CodexProxyRuntime | undefined;
  try {
    const config = buildSmokeConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamBaseUrl: upstream.baseUrl,
    });
    runtime = await startCodexResponsesProxy({
      config,
      logger: silentLogger,
      allowMockFixtureEvidence: true,
    });
    const first = await postResponse(runtime, {
      model,
      stream: false,
      metadata: { tokenpilotSessionId: sessionId },
      input: [{ role: "user", content: evictSentinel }],
    });
    const oldPreviousResponseId = String(first.id);
    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: oldPreviousResponseId,
    });
    const evictedItem = history.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes(evictSentinel)
    ));
    if (!evictedItem) throw new Error("Fallback smoke setup could not resolve the eviction target");
    config.contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: evictedItem.stableItemId }],
    };

    const result = await postResponse(runtime, {
      model,
      stream: false,
      previous_response_id: oldPreviousResponseId,
      input: [{ role: "user", content: "fallback current turn" }],
    });
    const rebasePayload = upstream.requests[1];
    const fallbackPayload = upstream.requests[2];
    const epoch = await readLatestCodexRebaseEpoch({ stateDir, sessionId });
    const cooldownJournal = await readCodexRebaseCooldownJournal(stateDir, sessionId);

    return {
      rebaseAttempts: rebasePayload && !("previous_response_id" in rebasePayload) ? 1 : 0,
      originalRequestRetries:
        fallbackPayload?.previous_response_id === oldPreviousResponseId ? 1 : 0,
      fallbackSucceeded: typeof result.id === "string" && result.id.length > 0,
      originalPreviousResponseIdRestored:
        fallbackPayload?.previous_response_id === oldPreviousResponseId,
      epochRolledBack: epoch?.status === "rolled_back",
      cooldownRecorded: cooldownJournal.cooldowns.length === 1,
      accounting: accountingEvidence(epoch?.accounting),
    };
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function runModuleCombination(params: {
  model: string;
  stabilizer: boolean;
  reduction: boolean;
  rewrite: boolean;
}): Promise<CodexRebaseSmokeEvidence["moduleMatrix"][number]> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-module-matrix-state-"));
  const sessionId = `codex-module-matrix-${randomUUID()}`;
  const evictSentinel = `EVICT_ME_${randomUUID()}`;
  const longToolOutput = `HEAD\n${"line\n".repeat(600)}`;
  const upstream = await startMockUpstream({ prefix: "resp-matrix" });
  let runtime: CodexProxyRuntime | undefined;
  try {
    const config = buildSmokeConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamBaseUrl: upstream.baseUrl,
      modules: {
        stabilizer: params.stabilizer,
        reduction: params.reduction,
      },
      rewriteEnabled: params.rewrite,
    });
    runtime = await startCodexResponsesProxy({
      config,
      logger: silentLogger,
      allowMockFixtureEvidence: true,
    });
    const callId = `matrix-call-${randomUUID()}`;
    const first = await postResponse(runtime, {
      model: params.model,
      stream: false,
      instructions: [
        "You are a coding agent.",
        "Your working directory is: /workspace/smoke",
        "Runtime: agent=matrix-agent | mode=offline",
      ].join("\n"),
      metadata: { tokenpilotSessionId: sessionId },
      input: [
        {
          role: "developer",
          content: [
            "You are a coding agent.",
            "Your working directory is: /workspace/smoke",
            "Runtime: agent=matrix-agent | mode=offline",
          ].join("\n"),
        },
        { role: "user", content: evictSentinel },
        { type: "function_call", call_id: callId, name: "bash", arguments: "{}" },
        { type: "function_call_output", call_id: callId, name: "bash", output: longToolOutput },
      ],
    });
    const firstResponseId = String(first.id);
    const firstUpstreamPayload = upstream.requests[0];
    const firstInput = jsonItems(firstUpstreamPayload?.input);
    const forwardedToolOutput = firstInput.find((item) => item.type === "function_call_output")?.output;
    const stablePrefixApplied = typeof firstUpstreamPayload?.prompt_cache_key === "string";
    const reductionApplied =
      typeof forwardedToolOutput === "string" && forwardedToolOutput.length < longToolOutput.length;

    const history = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: firstResponseId,
    });
    const evictedItem = history.replayableItems.find((entry) => (
      JSON.stringify(entry.item).includes(evictSentinel)
    ));
    if (!evictedItem) throw new Error("Module matrix could not resolve the eviction target");
    config.contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: evictedItem.stableItemId }],
    };
    await postResponse(runtime, {
      model: params.model,
      stream: false,
      previous_response_id: firstResponseId,
      input: [{ role: "user", content: "module matrix current turn" }],
    });
    const rewriteApplied = !("previous_response_id" in (upstream.requests[1] ?? {}));
    const isolationPassed = stablePrefixApplied === params.stabilizer
      && reductionApplied === params.reduction
      && rewriteApplied === params.rewrite;
    return {
      stabilizer: params.stabilizer,
      reduction: params.reduction,
      rewrite: params.rewrite,
      stablePrefixApplied,
      reductionApplied,
      rewriteApplied,
      isolationPassed,
    };
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

async function runModuleMatrix(model: string): Promise<CodexRebaseSmokeEvidence["moduleMatrix"]> {
  const evidence: CodexRebaseSmokeEvidence["moduleMatrix"] = [];
  for (const stabilizer of [false, true]) {
    for (const reduction of [false, true]) {
      for (const rewrite of [false, true]) {
        evidence.push(await runModuleCombination({ model, stabilizer, reduction, rewrite }));
      }
    }
  }
  return evidence;
}

async function writeEvidence(
  outputDir: string,
  evidence: CodexRebaseSmokeEvidence,
): Promise<{ artifactPath: string; artifactSha256: string }> {
  await mkdir(outputDir, { recursive: true });
  const artifactPath = join(outputDir, "codex-context-rebase-mock-smoke.json");
  const tempPath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, artifactPath);
  return { artifactPath, artifactSha256: sha256(text) };
}

export async function runCodexRebaseMockSmoke(
  options: RunCodexRebaseMockSmokeOptions = {},
): Promise<CodexRebaseSmokeRunResult> {
  const model = smokeModelLabel(options.model);
  const startedAt = new Date().toISOString();
  // Proxy startup configures a process-global state resolver, so smoke
  // scenarios intentionally run serially even though their state dirs differ.
  const happyPath = await runHappyPath(model);
  const fallback = await runFallbackPath(model);
  const moduleMatrix = await runModuleMatrix(model);
  const evidence: CodexRebaseSmokeEvidence = {
    schema: CODEX_REBASE_SMOKE_EVIDENCE_SCHEMA,
    mode: "mock",
    provider: "local-scripted-responses",
    model,
    endpoint: "loopback-temporary",
    runtime: {
      node: process.version,
      codexCli: codexCliVersionLabel(process.env.CODEX_CLI_VERSION),
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    happyPath,
    fallback,
    moduleMatrix,
    privacy: {
      credentialSource: "not-required",
      rawPromptPersisted: false,
      rawEncryptedPayloadPersisted: false,
      rawHeadersPersisted: false,
      ephemeralStateRemoved: true,
    },
  };
  const outputDir = options.outputDir
    ? resolve(options.outputDir)
    : await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-smoke-evidence-"));
  const artifact = await writeEvidence(outputDir, evidence);
  return { ...artifact, evidence };
}
