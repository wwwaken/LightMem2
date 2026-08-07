import type { ContextSegment, RuntimeTurnContext } from "@lightmem2/kernel";
import {
  buildHistoryBlocks,
  collectRuleSignals,
  deriveHistoryLifecycle,
  type HistoryBlock,
  type HistorySignalType,
} from "@lightmem2/history";

const EVICTABLE_SIGNALS: HistorySignalType[] = ["REPEATED_READ", "LARGE_BLOCK"];
const TOOL_RESULT_POINTER = "[evicted: earlier tool result content removed]";

export type ClaudeEvictionConfig = {
  enabled: boolean;
  minBlockChars?: number;
};

export type ClaudeEvictionSelection = {
  blockId: string;
  segmentIds: string[];
  chars: number;
  reasons: HistorySignalType[];
};

export type ClaudeEvictionResult = {
  enabled: boolean;
  changed: boolean;
  evictedBlockIds: string[];
  savedChars: number;
  selections: ClaudeEvictionSelection[];
};

export type ClaudeEvictionApplySummary = {
  enabled: boolean;
  changed: boolean;
  evictedMessageCount: number;
  evictedToolResultCount: number;
  savedChars: number;
  evictedBlockIds: string[];
};

type ToolUseDescriptor = {
  name: string;
  dataKey?: string;
};

export type ToolResultBinding = {
  segmentId: string;
  messageIndex: number;
  blockIndex: number;
  toolUseId: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record) return "";
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      if (Array.isArray(record.content)) return contentToText(record.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function canonicalHistoryToolName(value: unknown): string {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
  if (normalized === "bash" || normalized === "shell") return "exec";
  if (normalized === "webfetch") return "web_fetch";
  if (normalized === "websearch") return "web_search";
  return normalized || "tool_result";
}

function toolDataKey(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  for (const key of ["file_path", "filePath", "path", "url", "query", "command"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolResultSegmentId(toolUseId: string): string {
  return `anthropic-tool-result:${toolUseId}`;
}

function collectToolProtocol(
  messages: unknown[],
): { toolUses: Map<string, ToolUseDescriptor>; validResultIds: Set<string> } {
  const toolUsesById = new Map<string, ToolUseDescriptor[]>();
  const resultCounts = new Map<string, number>();

  for (const message of messages) {
    const record = asRecord(message);
    if (!record || !Array.isArray(record.content)) continue;
    for (const value of record.content) {
      const block = asRecord(value);
      if (!block) continue;
      if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id.trim() : "";
        if (!id) continue;
        const entries = toolUsesById.get(id) ?? [];
        entries.push({
          name: canonicalHistoryToolName(block.name),
          dataKey: toolDataKey(block.input),
        });
        toolUsesById.set(id, entries);
      } else if (block.type === "tool_result") {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
        if (id) resultCounts.set(id, (resultCounts.get(id) ?? 0) + 1);
      }
    }
  }

  const toolUses = new Map<string, ToolUseDescriptor>();
  const validResultIds = new Set<string>();
  for (const [id, entries] of toolUsesById) {
    if (entries.length !== 1 || resultCounts.get(id) !== 1) continue;
    toolUses.set(id, entries[0]);
    validResultIds.add(id);
  }
  return { toolUses, validResultIds };
}

export function buildToolResultSegments(
  messages: unknown[],
): { segments: ContextSegment[]; bindings: Map<string, ToolResultBinding> } {
  const { toolUses, validResultIds } = collectToolProtocol(messages);
  const segments: ContextSegment[] = [];
  const bindings = new Map<string, ToolResultBinding>();
  let activeTurnStartIndex = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (asRecord(messages[index])?.role === "user") {
      activeTurnStartIndex = index;
      break;
    }
  }

  for (const [messageIndex, message] of messages.entries()) {
    // Assistant prefill may follow the active user turn, so protect the last user message onward.
    if (messageIndex >= activeTurnStartIndex) continue;
    const record = asRecord(message);
    if (!record || !Array.isArray(record.content)) continue;
    for (const [blockIndex, value] of record.content.entries()) {
      const block = asRecord(value);
      if (!block || block.type !== "tool_result") continue;
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id.trim() : "";
      if (!toolUseId || !validResultIds.has(toolUseId)) continue;
      const descriptor = toolUses.get(toolUseId);
      if (!descriptor) continue;
      const segmentId = toolResultSegmentId(toolUseId);
      const toolPayload: Record<string, unknown> = { toolName: descriptor.name };
      if (descriptor.dataKey) toolPayload.path = descriptor.dataKey;
      segments.push({
        id: segmentId,
        kind: "volatile",
        text: contentToText(block.content),
        priority: messageIndex,
        source: "anthropic.messages.user.tool_result",
        metadata: {
          messageIndex,
          blockIndex,
          toolUseId,
          toolName: descriptor.name,
          toolPayload,
        },
      });
      bindings.set(segmentId, { segmentId, messageIndex, blockIndex, toolUseId });
    }
  }
  return { segments, bindings };
}

function buildTurnContext(
  sessionId: string,
  model: string,
  segments: ContextSegment[],
): RuntimeTurnContext {
  return {
    sessionId,
    sessionMode: "single",
    provider: "anthropic",
    model,
    apiFamily: "anthropic-messages",
    prompt: "",
    segments,
    budget: { maxInputTokens: 0, reserveOutputTokens: 0 },
  };
}

function selectEvictableBlocks(blocks: HistoryBlock[]): ClaudeEvictionSelection[] {
  const selections: ClaudeEvictionSelection[] = [];
  for (const block of blocks) {
    const signalTypes = block.signalTypes ?? [];
    const reasons = EVICTABLE_SIGNALS.filter((signal) => signalTypes.includes(signal));
    if (reasons.length === 0) continue;
    selections.push({
      blockId: block.blockId,
      segmentIds: [...block.segmentIds],
      chars: block.charCount,
      reasons,
    });
  }
  return selections;
}

export function analyzeClaudeEviction(params: {
  sessionId: string;
  model: string;
  messages: unknown[];
  config: ClaudeEvictionConfig;
}): ClaudeEvictionResult {
  if (!params.config.enabled) {
    return { enabled: false, changed: false, evictedBlockIds: [], savedChars: 0, selections: [] };
  }

  const minBlockChars = Math.max(256, params.config.minBlockChars ?? 4000);
  const { segments } = buildToolResultSegments(params.messages);
  const { blocks } = buildHistoryBlocks(buildTurnContext(params.sessionId, params.model, segments));
  const signals = collectRuleSignals(blocks, { largeBlockChars: minBlockChars });
  const lifecycle = deriveHistoryLifecycle(blocks, signals);
  const selections = selectEvictableBlocks(lifecycle.blocks);

  return {
    enabled: true,
    changed: selections.length > 0,
    evictedBlockIds: selections.map((selection) => selection.blockId),
    savedChars: selections.reduce(
      (sum, selection) => sum + Math.max(0, selection.chars - TOOL_RESULT_POINTER.length),
      0,
    ),
    selections,
  };
}

function unchangedSummary(enabled: boolean): ClaudeEvictionApplySummary {
  return {
    enabled,
    changed: false,
    evictedMessageCount: 0,
    evictedToolResultCount: 0,
    savedChars: 0,
    evictedBlockIds: [],
  };
}

export function applyClaudeEviction(params: {
  payload: { messages?: unknown[] };
  sessionId: string;
  model: string;
  config: ClaudeEvictionConfig;
}): ClaudeEvictionApplySummary {
  const messages = params.payload.messages;
  if (!params.config.enabled || !Array.isArray(messages)) {
    return unchangedSummary(Boolean(params.config.enabled));
  }

  const analysis = analyzeClaudeEviction({
    sessionId: params.sessionId,
    model: params.model,
    messages,
    config: params.config,
  });
  if (!analysis.changed) return unchangedSummary(true);

  const { bindings } = buildToolResultSegments(messages);
  const targetSegmentIds = new Set(analysis.selections.flatMap((selection) => selection.segmentIds));
  const changedMessages = new Set<number>();
  const evictedBlockIds: string[] = [];
  let savedChars = 0;
  let evictedToolResultCount = 0;

  for (const segmentId of targetSegmentIds) {
    const binding = bindings.get(segmentId);
    if (!binding) continue;
    const message = asRecord(messages[binding.messageIndex]);
    if (!message || !Array.isArray(message.content)) continue;
    const block = asRecord(message.content[binding.blockIndex]);
    if (
      !block
      || block.type !== "tool_result"
      || block.tool_use_id !== binding.toolUseId
    ) continue;

    const beforeChars = contentToText(block.content).length;
    if (beforeChars <= TOOL_RESULT_POINTER.length) continue;
    const nextContent = [...message.content];
    nextContent[binding.blockIndex] = { ...block, content: TOOL_RESULT_POINTER };
    messages[binding.messageIndex] = { ...message, content: nextContent };
    savedChars += beforeChars - TOOL_RESULT_POINTER.length;
    evictedToolResultCount += 1;
    changedMessages.add(binding.messageIndex);
    evictedBlockIds.push(`history-block:${segmentId}`);
  }

  return {
    enabled: true,
    changed: evictedToolResultCount > 0,
    evictedMessageCount: changedMessages.size,
    evictedToolResultCount,
    savedChars,
    evictedBlockIds,
  };
}
