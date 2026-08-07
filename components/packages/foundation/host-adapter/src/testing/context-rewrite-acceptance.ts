import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export type AcceptancePhase = "before_restart" | "after_restart";

export interface AcceptanceSentinels {
  uuid: string;
  evict: string;
  keep: string;
}

export interface MockUpstreamResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CapturedRequest {
  phase: AcceptancePhase;
  sequence: number;
  method: string;
  path: string;
  body: unknown;
  rawBody: string;
  contentType?: string;
  responseStatus: number;
}

export interface ToolClosureResult {
  complete: boolean;
  missingOutputs: string[];
  orphanOutputs: string[];
  duplicateCalls: string[];
  duplicateOutputs: string[];
  invalidItems: string[];
}

export interface AcceptancePhaseResult {
  phase: AcceptancePhase;
  requestCount: number;
  failedRequestCount: number;
  unsafeSuccessfulRequestSequences: number[];
  fallbackCount: number;
  fallbackSucceeded: boolean;
  keepFound: boolean;
  evictFound: boolean;
  savedCharacters: number;
  toolClosure: ToolClosureResult;
  passed: boolean;
}

export interface AcceptanceSummary {
  passed: boolean;
  requestCount: number;
  savedCharacters: number;
  fallbackCount: number;
  fallbackSucceeded: boolean;
  phases: AcceptancePhaseResult[];
}

export interface AcceptanceHarnessInput {
  sentinels: AcceptanceSentinels;
  requests: readonly CapturedRequest[];
  originalRequests: Record<AcceptancePhase, unknown>;
}

export interface TemporaryAcceptanceEnvironment {
  rootDir: string;
  homeDir: string;
  stateDir: string;
  openClawStateDir: string;
  codexHomeDir: string;
  claudeHomeDir: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export interface AcceptanceHostRuntime {
  sendAcceptanceTurn(params: {
    phase: AcceptancePhase;
    sentinels: AcceptanceSentinels;
  }): Promise<unknown>;
  close(): Promise<void>;
}

export interface AcceptanceHostStartContext {
  phase: AcceptancePhase;
  upstreamUrl: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

export interface RestartAcceptanceScenario {
  sentinels?: AcceptanceSentinels;
  responses?: Partial<Record<AcceptancePhase, readonly MockUpstreamResponse[]>>;
  startHost(context: AcceptanceHostStartContext): Promise<AcceptanceHostRuntime>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAFE_ENV_KEYS = [
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "NODE",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(rawBody: string): unknown {
  if (!rawBody) return null;
  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function responseBody(response: MockUpstreamResponse): string {
  if (typeof response.body === "string") return response.body;
  return JSON.stringify(response.body ?? { id: `resp_mock_${randomUUID()}`, output: [] });
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function serializedLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized);
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) collectStrings(child, output);
}

function requestContains(body: unknown, sentinel: string): boolean {
  const strings: string[] = [];
  collectStrings(body, strings);
  return strings.some((value) => value.includes(sentinel));
}

function addProtocolRef(
  refs: Map<string, number>,
  key: string | undefined,
  invalidItems: string[],
  invalidLabel: string,
): void {
  if (!key) {
    invalidItems.push(invalidLabel);
    return;
  }
  refs.set(key, (refs.get(key) ?? 0) + 1);
}

function collectResponsesToolRefs(
  body: Record<string, unknown>,
  calls: Map<string, number>,
  outputs: Map<string, number>,
  invalidItems: string[],
): void {
  if (!Array.isArray(body.input)) return;
  for (const [index, value] of body.input.entries()) {
    if (!isRecord(value)) continue;
    const type = typeof value.type === "string" ? value.type : "";
    const callId = typeof value.call_id === "string" && value.call_id ? value.call_id : undefined;
    if (type === "function_call" || type === "custom_tool_call") {
      addProtocolRef(calls, callId && `responses:${type}:${callId}`, invalidItems, `responses.input[${index}].call_id`);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const callType = type === "function_call_output" ? "function_call" : "custom_tool_call";
      addProtocolRef(outputs, callId && `responses:${callType}:${callId}`, invalidItems, `responses.input[${index}].call_id`);
    }
  }
}

function collectMessageToolRefs(
  body: Record<string, unknown>,
  calls: Map<string, number>,
  outputs: Map<string, number>,
  invalidItems: string[],
): void {
  if (!Array.isArray(body.messages)) return;
  for (const [messageIndex, value] of body.messages.entries()) {
    if (!isRecord(value)) continue;

    if (Array.isArray(value.content)) {
      for (const [blockIndex, blockValue] of value.content.entries()) {
        if (!isRecord(blockValue)) continue;
        if (blockValue.type === "tool_use") {
          if (value.role !== "assistant") {
            invalidItems.push(`messages[${messageIndex}].content[${blockIndex}].role`);
          }
          const id = typeof blockValue.id === "string" && blockValue.id ? blockValue.id : undefined;
          addProtocolRef(calls, id && `anthropic:${id}`, invalidItems, `messages[${messageIndex}].content[${blockIndex}].id`);
        } else if (blockValue.type === "tool_result") {
          if (value.role !== "user") {
            invalidItems.push(`messages[${messageIndex}].content[${blockIndex}].role`);
          }
          const id = typeof blockValue.tool_use_id === "string" && blockValue.tool_use_id
            ? blockValue.tool_use_id
            : undefined;
          addProtocolRef(outputs, id && `anthropic:${id}`, invalidItems, `messages[${messageIndex}].content[${blockIndex}].tool_use_id`);
        }
      }
    }

    if (Array.isArray(value.tool_calls)) {
      for (const [callIndex, callValue] of value.tool_calls.entries()) {
        if (!isRecord(callValue)) continue;
        if (value.role !== "assistant") {
          invalidItems.push(`messages[${messageIndex}].tool_calls[${callIndex}].role`);
        }
        const id = typeof callValue.id === "string" && callValue.id ? callValue.id : undefined;
        addProtocolRef(calls, id && `chat:${id}`, invalidItems, `messages[${messageIndex}].tool_calls[${callIndex}].id`);
      }
    }
    const toolCallId = typeof value.tool_call_id === "string" && value.tool_call_id
      ? value.tool_call_id
      : undefined;
    if (toolCallId || value.role === "tool") {
      if (value.role !== "tool") {
        invalidItems.push(`messages[${messageIndex}].role`);
      }
      addProtocolRef(
        outputs,
        toolCallId && `chat:${toolCallId}`,
        invalidItems,
        `messages[${messageIndex}].tool_call_id`,
      );
    }
  }
}

function countFallbacks(
  requests: readonly CapturedRequest[],
  originalRequest: unknown,
): number {
  let awaitingFallback = false;
  let fallbackCount = 0;
  for (const request of requests) {
    if (isSuccessfulStatus(request.responseStatus)) {
      if (awaitingFallback && isDeepStrictEqual(request.body, originalRequest)) {
        fallbackCount += 1;
      }
      awaitingFallback = false;
    } else {
      awaitingFallback = true;
    }
  }
  return fallbackCount;
}

function effectiveRequest(requests: readonly CapturedRequest[]): CapturedRequest | undefined {
  const finalRequest = requests.at(-1);
  return finalRequest && isSuccessfulStatus(finalRequest.responseStatus)
    ? finalRequest
    : undefined;
}

export function createAcceptanceSentinels(uuid: string = randomUUID()): AcceptanceSentinels {
  const normalized = uuid.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`Invalid acceptance sentinel UUID: ${uuid}`);
  }
  return {
    uuid: normalized,
    evict: `EVICT_ME_${normalized}`,
    keep: `KEEP_ME_${normalized}`,
  };
}

export class MockUpstreamRecorder {
  private readonly captured: CapturedRequest[] = [];
  private readonly queuedResponses: Record<AcceptancePhase, MockUpstreamResponse[]> = {
    before_restart: [],
    after_restart: [],
  };
  private phase: AcceptancePhase = "before_restart";
  private server?: Server;
  private listeningUrl?: string;

  get url(): string {
    if (!this.listeningUrl) throw new Error("Mock upstream has not been started");
    return this.listeningUrl;
  }

  setPhase(phase: AcceptancePhase): void {
    this.phase = phase;
  }

  enqueueResponses(responses: readonly MockUpstreamResponse[]): void {
    this.queuedResponses[this.phase].push(...responses);
  }

  requests(): readonly CapturedRequest[] {
    return this.captured.map((request) => ({ ...request }));
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Mock upstream is already started");
    this.server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const nextResponse = this.queuedResponses[this.phase].shift() ?? { status: 200 };
      this.captured.push({
        phase: this.phase,
        sequence: this.captured.length + 1,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        body: parseBody(rawBody),
        rawBody,
        contentType: typeof request.headers["content-type"] === "string"
          ? request.headers["content-type"]
          : undefined,
        responseStatus: nextResponse.status,
      });
      response.statusCode = nextResponse.status;
      for (const [name, value] of Object.entries(nextResponse.headers ?? {})) {
        response.setHeader(name, value);
      }
      if (!response.hasHeader("content-type")) {
        response.setHeader("content-type", "application/json; charset=utf-8");
      }
      response.end(responseBody(nextResponse));
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mock upstream did not bind a TCP port");
    this.listeningUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listeningUrl = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

export function inspectToolClosure(body: unknown): ToolClosureResult {
  const calls = new Map<string, number>();
  const outputs = new Map<string, number>();
  const invalidItems: string[] = [];
  if (isRecord(body)) {
    collectResponsesToolRefs(body, calls, outputs, invalidItems);
    collectMessageToolRefs(body, calls, outputs, invalidItems);
  }

  const missingOutputs = [...calls.keys()].filter((key) => !outputs.has(key)).sort();
  const orphanOutputs = [...outputs.keys()].filter((key) => !calls.has(key)).sort();
  const duplicateCalls = [...calls].filter(([, count]) => count !== 1).map(([key]) => key).sort();
  const duplicateOutputs = [...outputs].filter(([, count]) => count !== 1).map(([key]) => key).sort();
  invalidItems.sort();
  return {
    complete: missingOutputs.length === 0
      && orphanOutputs.length === 0
      && duplicateCalls.length === 0
      && duplicateOutputs.length === 0
      && invalidItems.length === 0,
    missingOutputs,
    orphanOutputs,
    duplicateCalls,
    duplicateOutputs,
    invalidItems,
  };
}

export function inspectAcceptancePhase(
  phase: AcceptancePhase,
  requests: readonly CapturedRequest[],
  sentinels: AcceptanceSentinels,
  originalRequest: unknown,
): AcceptancePhaseResult {
  const phaseRequests = requests.filter((request) => request.phase === phase);
  const effective = effectiveRequest(phaseRequests);
  const fallbackCount = countFallbacks(phaseRequests, originalRequest);
  const fallbackSucceeded = fallbackCount > 0;
  const failedRequestCount = phaseRequests.filter((request) => !isSuccessfulStatus(request.responseStatus)).length;
  const successfulRequests = phaseRequests.filter((request) =>
    isSuccessfulStatus(request.responseStatus),
  );
  const unsafeSuccessfulRequestSequences = successfulRequests
    .filter((request) => {
      const keepFound = requestContains(request.body, sentinels.keep);
      const evictFound = requestContains(request.body, sentinels.evict);
      return !keepFound || evictFound || !inspectToolClosure(request.body).complete;
    })
    .map((request) => request.sequence);
  if (!effective) {
    return {
      phase,
      requestCount: phaseRequests.length,
      failedRequestCount,
      unsafeSuccessfulRequestSequences,
      fallbackCount,
      fallbackSucceeded,
      keepFound: false,
      evictFound: false,
      savedCharacters: 0,
      toolClosure: {
        complete: false,
        missingOutputs: [],
        orphanOutputs: [],
        duplicateCalls: [],
        duplicateOutputs: [],
        invalidItems: ["no_successful_upstream_request"],
      },
      passed: false,
    };
  }

  const keepFound = requestContains(effective.body, sentinels.keep);
  const evictFound = requestContains(effective.body, sentinels.evict);
  const toolClosure = inspectToolClosure(effective.body);
  const savedCharacters = successfulRequests.reduce(
    (total, request) => total + Math.max(
      0,
      serializedLength(originalRequest) - Buffer.byteLength(request.rawBody),
    ),
    0,
  );
  return {
    phase,
    requestCount: phaseRequests.length,
    failedRequestCount,
    unsafeSuccessfulRequestSequences,
    fallbackCount,
    fallbackSucceeded,
    keepFound,
    evictFound,
    savedCharacters,
    toolClosure,
    passed: keepFound
      && !evictFound
      && toolClosure.complete
      && unsafeSuccessfulRequestSequences.length === 0
      && !fallbackSucceeded,
  };
}

export function runAcceptanceHarness(input: AcceptanceHarnessInput): AcceptanceSummary {
  const phases: AcceptancePhaseResult[] = [
    inspectAcceptancePhase("before_restart", input.requests, input.sentinels, input.originalRequests.before_restart),
    inspectAcceptancePhase("after_restart", input.requests, input.sentinels, input.originalRequests.after_restart),
  ];
  return {
    passed: phases.every((phase) => phase.passed),
    requestCount: input.requests.length,
    savedCharacters: phases.reduce((total, phase) => total + phase.savedCharacters, 0),
    fallbackCount: phases.reduce((total, phase) => total + phase.fallbackCount, 0),
    fallbackSucceeded: phases.some((phase) => phase.fallbackSucceeded),
    phases,
  };
}

export function formatAcceptanceSummary(summary: AcceptanceSummary): string {
  return [
    `status=${summary.passed ? "PASS" : "FAIL"}`,
    `request_count=${summary.requestCount}`,
    `saved_characters=${summary.savedCharacters}`,
    `fallback_count=${summary.fallbackCount}`,
    `fallback_succeeded=${summary.fallbackSucceeded ? "yes" : "no"}`,
  ].join(" ");
}

export function createTemporaryAcceptanceEnvironment(
  prefix = "lightmem2-acceptance-",
): TemporaryAcceptanceEnvironment {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(rootDir, "home");
  const stateDir = path.join(rootDir, "state");
  const openClawHomeDir = path.join(rootDir, "openclaw-home");
  const openClawStateDir = path.join(rootDir, "openclaw-state");
  const codexHomeDir = path.join(rootDir, "codex-home");
  const claudeHomeDir = path.join(rootDir, "claude-home");
  const xdgConfigDir = path.join(rootDir, "xdg-config");
  const xdgStateDir = path.join(rootDir, "xdg-state");
  for (const directory of [
    homeDir,
    stateDir,
    openClawHomeDir,
    openClawStateDir,
    codexHomeDir,
    claudeHomeDir,
    xdgConfigDir,
    xdgStateDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: xdgConfigDir,
    XDG_STATE_HOME: xdgStateDir,
    LIGHTMEM2_OPENCLAW_HOME: openClawHomeDir,
    OPENCLAW_CONFIG_PATH: path.join(openClawHomeDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: openClawStateDir,
    CODEX_HOME: codexHomeDir,
    CODEX_CONFIG_PATH: path.join(codexHomeDir, "config.toml"),
    CODEX_HOOKS_CONFIG_PATH: path.join(codexHomeDir, "hooks.json"),
    TOKENPILOT_CODEX_CONFIG: path.join(codexHomeDir, "tokenpilot.json"),
    CLAUDE_CONFIG_DIR: claudeHomeDir,
    CLAUDE_CODE_SETTINGS_PATH: path.join(claudeHomeDir, "settings.json"),
    CLAUDE_CODE_MCP_CONFIG_PATH: path.join(claudeHomeDir, ".claude.json"),
    TOKENPILOT_CLAUDE_CODE_CONFIG: path.join(claudeHomeDir, "tokenpilot.json"),
  });

  let cleaned = false;
  return {
    rootDir,
    homeDir,
    stateDir,
    openClawStateDir,
    codexHomeDir,
    claudeHomeDir,
    env,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

export async function runRestartAcceptanceScenario(
  scenario: RestartAcceptanceScenario,
): Promise<AcceptanceSummary> {
  const sentinels = scenario.sentinels ?? createAcceptanceSentinels();
  const environment = createTemporaryAcceptanceEnvironment();
  const upstream = new MockUpstreamRecorder();
  const originalRequests = {} as Record<AcceptancePhase, unknown>;
  try {
    await upstream.start();
    for (const phase of ["before_restart", "after_restart"] as const) {
      upstream.setPhase(phase);
      upstream.enqueueResponses(scenario.responses?.[phase] ?? []);
      const runtime = await scenario.startHost({
        phase,
        upstreamUrl: upstream.url,
        stateDir: environment.stateDir,
        env: environment.env,
      });
      try {
        originalRequests[phase] = await runtime.sendAcceptanceTurn({ phase, sentinels });
      } finally {
        await runtime.close();
      }
    }
    return runAcceptanceHarness({
      sentinels,
      requests: upstream.requests(),
      originalRequests,
    });
  } finally {
    try {
      await upstream.close();
    } finally {
      environment.cleanup();
    }
  }
}
