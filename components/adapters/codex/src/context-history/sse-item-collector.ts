import { asJsonObject, cloneJson, sanitizeValue } from "./shared.js";
import type { CodexJournalStatus, JsonObject } from "./types.js";

type StreamEvent = {
  event: string;
  data: JsonObject;
};

type OutputItemAliases = {
  byItemId: Map<string, string>;
  byOutputIndex: Map<number, string>;
};

type CollectorState = {
  outputItems: Map<string, JsonObject>;
  aliases: OutputItemAliases;
  eventTypeCounts: Record<string, number>;
  responseId?: string;
  previousResponseId?: string;
  status: CodexJournalStatus;
};

type EventHandler = (state: CollectorState, data: JsonObject, index: number) => void;

export type CodexSseItemCollectorResult = {
  outputItems: JsonObject[];
  eventTypeCounts: Record<string, number>;
  malformedEventCount: number;
  malformedEventTypeCounts: Record<string, number>;
  responseId?: string;
  previousResponseId?: string;
  status: CodexJournalStatus;
};

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function sseFieldValue(line: string, prefix: string): string {
  const value = line.slice(prefix.length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function parseSseEvents(rawStreamText: string): {
  events: StreamEvent[];
  malformedEventCount: number;
  malformedEventTypeCounts: Record<string, number>;
} {
  const events: StreamEvent[] = [];
  let malformedEventCount = 0;
  const malformedEventTypeCounts: Record<string, number> = {};

  for (const chunk of rawStreamText.split(/\r?\n\r?\n/)) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = sseFieldValue(line, "event:").trim();
      else if (line.startsWith("data:")) dataLines.push(sseFieldValue(line, "data:"));
    }

    if (dataLines.length === 0) continue;
    const dataText = dataLines.join("\n").trim();
    if (!dataText || dataText === "[DONE]") continue;

    const data = asJsonObject(safeJsonParse(dataText));
    if (data) events.push({ event, data });
    else {
      malformedEventCount += 1;
      malformedEventTypeCounts[event] = (malformedEventTypeCounts[event] ?? 0) + 1;
    }
  }

  return { events, malformedEventCount, malformedEventTypeCounts };
}

function outputIndexFromData(data: JsonObject): number | undefined {
  return typeof data.output_index === "number" && Number.isInteger(data.output_index) && data.output_index >= 0
    ? data.output_index
    : undefined;
}

function outputItemIdFromData(data: JsonObject): string | undefined {
  const item = asJsonObject(data.item);
  if (typeof item?.id === "string") return item.id;
  return typeof data.item_id === "string" ? data.item_id : undefined;
}

function resolveOutputItemKey(data: JsonObject, fallbackIndex: number, aliases: OutputItemAliases): string {
  const itemId = outputItemIdFromData(data);
  if (itemId && aliases.byItemId.has(itemId)) return aliases.byItemId.get(itemId) as string;

  const outputIndex = outputIndexFromData(data);
  if (outputIndex !== undefined && aliases.byOutputIndex.has(outputIndex)) {
    return aliases.byOutputIndex.get(outputIndex) as string;
  }

  if (itemId) return itemId;
  if (outputIndex !== undefined) return `output_index:${outputIndex}`;
  return `event:${fallbackIndex}`;
}

function eventTypeFromData(event: string, data: JsonObject): string {
  return typeof data.type === "string" && data.type.startsWith("response.")
    ? data.type
    : event;
}

function rememberOutputItemKey(key: string, data: JsonObject, item: JsonObject, aliases: OutputItemAliases): void {
  const itemId = typeof item.id === "string" ? item.id : outputItemIdFromData(data);
  if (itemId) aliases.byItemId.set(itemId, key);
  const outputIndex = outputIndexFromData(data);
  if (outputIndex !== undefined) aliases.byOutputIndex.set(outputIndex, key);
}

function mergeOutputItem(existing: JsonObject | undefined, incoming: JsonObject): JsonObject {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming };
  mergeIndexedObjectArray(merged, existing, incoming, "content");
  mergeIndexedObjectArray(merged, existing, incoming, "summary");
  preserveNonEmptyString(merged, existing, incoming, "arguments");
  preserveNonEmptyString(merged, existing, incoming, "input");
  preserveNonEmptyString(merged, existing, incoming, "text");
  preserveNonEmptyString(merged, existing, incoming, "encrypted_content");
  return merged;
}

function mergeIndexedObjectArray(
  target: JsonObject,
  existing: JsonObject,
  incoming: JsonObject,
  field: string,
): void {
  const existingValue = existing[field];
  const incomingValue = incoming[field];
  if (!Array.isArray(existingValue) || !Array.isArray(incomingValue)) return;

  const merged = incomingValue.slice();
  existingValue.forEach((existingItem, index) => {
    const incomingItem = merged[index];
    if (incomingItem === undefined) {
      merged[index] = existingItem;
      return;
    }

    const existingObject = asJsonObject(existingItem);
    const incomingObject = asJsonObject(incomingItem);
    if (!existingObject || !incomingObject) return;

    const mergedObject = { ...existingObject, ...incomingObject };
    preserveNonEmptyString(mergedObject, existingObject, incomingObject, "text");
    merged[index] = mergedObject;
  });
  target[field] = merged;
}

function preserveNonEmptyString(
  target: JsonObject,
  existing: JsonObject,
  incoming: JsonObject,
  field: string,
): void {
  const existingValue = existing[field];
  const incomingValue = incoming[field];
  if (
    typeof existingValue === "string"
    && existingValue.length > 0
    && (typeof incomingValue !== "string" || incomingValue.length === 0)
  ) {
    target[field] = existingValue;
  }
}

function outputTextDelta(data: JsonObject): string {
  const nestedDelta = asJsonObject(data.delta);
  if (typeof data.delta === "string") return data.delta;
  if (typeof nestedDelta?.output_text === "string") return nestedDelta.output_text;
  if (typeof nestedDelta?.text === "string") return nestedDelta.text;
  return "";
}

function outputTextDone(data: JsonObject): string | undefined {
  const nestedText = asJsonObject(data.text);
  if (typeof data.text === "string") return data.text;
  if (typeof data.output_text === "string") return data.output_text;
  if (typeof nestedText?.value === "string") return nestedText.value;
  return undefined;
}

function contentIndexFromData(data: JsonObject): number {
  return typeof data.content_index === "number" && Number.isInteger(data.content_index) && data.content_index >= 0
    ? data.content_index
    : 0;
}

function contentPartFromData(data: JsonObject): JsonObject | undefined {
  const part = asJsonObject(data.part) ?? asJsonObject(data.content_part);
  return part ? cloneJson(part) : undefined;
}

function ensureContentPart(item: JsonObject, data: JsonObject): JsonObject {
  if (!Array.isArray(item.content)) item.content = [];
  const content = item.content as unknown[];
  const index = contentIndexFromData(data);
  const existing = asJsonObject(content[index]);
  if (existing) return existing;

  const created: JsonObject = { type: "output_text", text: "" };
  content[index] = created;
  return created;
}

function mergeContentPart(item: JsonObject, data: JsonObject): void {
  const part = contentPartFromData(data);
  if (!part) return;

  const existing = ensureContentPart(item, data);
  const before = { ...existing };
  Object.assign(existing, part);
  preserveNonEmptyString(existing, before, part, "text");
}

function appendOutputText(item: JsonObject, data: JsonObject): void {
  const delta = outputTextDelta(data);
  if (!delta) return;

  const part = ensureContentPart(item, data);
  if (typeof part.type !== "string") part.type = "output_text";
  part.text = `${typeof part.text === "string" ? part.text : ""}${delta}`;
}

function setOutputText(item: JsonObject, data: JsonObject): void {
  const text = outputTextDone(data);
  if (text === undefined) return;

  const part = ensureContentPart(item, data);
  if (text.length === 0 && typeof part.text === "string" && part.text.length > 0) return;
  if (typeof part.type !== "string") part.type = "output_text";
  part.text = text;
}

function appendStringField(item: JsonObject, field: string, delta: unknown): void {
  if (typeof delta !== "string") return;
  if (!delta) return;
  item[field] = `${typeof item[field] === "string" ? item[field] : ""}${delta}`;
}

function setStringField(item: JsonObject, field: string, value: unknown): void {
  if (typeof value !== "string") return;
  if (value.length === 0 && typeof item[field] === "string" && item[field].length > 0) return;
  item[field] = value;
}

function reasoningText(data: JsonObject): string | undefined {
  if (typeof data.delta === "string") return data.delta;
  if (typeof data.text === "string") return data.text;
  return undefined;
}

function summaryIndexFromData(data: JsonObject): number {
  return typeof data.summary_index === "number" && Number.isInteger(data.summary_index) && data.summary_index >= 0
    ? data.summary_index
    : contentIndexFromData(data);
}

function ensureReasoningSummaryPart(item: JsonObject, data: JsonObject): JsonObject {
  if (!Array.isArray(item.summary)) item.summary = [];
  const summary = item.summary as unknown[];
  const index = summaryIndexFromData(data);
  const existing = asJsonObject(summary[index]);
  if (existing) return existing;

  const created: JsonObject = { type: "summary_text", text: "" };
  summary[index] = created;
  return created;
}

function mergeReasoningSummaryPart(item: JsonObject, data: JsonObject): void {
  const part = contentPartFromData(data);
  if (!part) return;

  const existing = ensureReasoningSummaryPart(item, data);
  const before = { ...existing };
  Object.assign(existing, part);
  preserveNonEmptyString(existing, before, part, "text");
}

function appendReasoningSummaryText(item: JsonObject, data: JsonObject): void {
  const delta = reasoningText(data);
  if (!delta) return;

  const part = ensureReasoningSummaryPart(item, data);
  if (typeof part.type !== "string") part.type = "summary_text";
  part.text = `${typeof part.text === "string" ? part.text : ""}${delta}`;
}

function setReasoningSummaryText(item: JsonObject, data: JsonObject): void {
  const text = reasoningText(data);
  if (text === undefined) return;

  const part = ensureReasoningSummaryPart(item, data);
  if (text.length === 0 && typeof part.text === "string" && part.text.length > 0) return;
  if (typeof part.type !== "string") part.type = "summary_text";
  part.text = text;
}

function appendReasoningText(item: JsonObject, data: JsonObject): void {
  appendStringField(item, "text", reasoningText(data));
}

function setReasoningText(item: JsonObject, data: JsonObject): void {
  setStringField(item, "text", reasoningText(data));
}

function responseMetadata(data: JsonObject): {
  responseId?: string;
  previousResponseId?: string;
  output?: unknown[];
} {
  const response = asJsonObject(data.response);
  return {
    responseId: typeof response?.id === "string"
      ? response.id
      : typeof data.id === "string"
        ? data.id
        : undefined,
    previousResponseId: typeof response?.previous_response_id === "string"
      ? response.previous_response_id
      : typeof data.previous_response_id === "string"
        ? data.previous_response_id
        : undefined,
    output: Array.isArray(response?.output) ? response.output : undefined,
  };
}

function outputItemForEvent(
  state: CollectorState,
  data: JsonObject,
  index: number,
  fallback: JsonObject,
): { key: string; item: JsonObject } {
  const key = resolveOutputItemKey(data, index, state.aliases);
  return { key, item: state.outputItems.get(key) ?? fallback };
}

function commitOutputItem(state: CollectorState, key: string, data: JsonObject, item: JsonObject): void {
  state.outputItems.set(key, item);
  rememberOutputItemKey(key, data, item, state.aliases);
}

function updateResponseState(state: CollectorState, data: JsonObject, eventType: string): void {
  const metadata = responseMetadata(data);
  state.responseId = metadata.responseId ?? state.responseId;
  state.previousResponseId = metadata.previousResponseId ?? state.previousResponseId;
  if (eventType === "response.completed") state.status = "completed";
  if (eventType === "response.failed") state.status = "failed";
  if (eventType === "response.incomplete") state.status = "incomplete";

  metadata.output?.forEach((item, outputIndex) => {
    const cloned = asJsonObject(cloneJson(item));
    if (!cloned) return;

    const dataWithIndex: JsonObject = { output_index: outputIndex, item: cloned };
    const key = resolveOutputItemKey(dataWithIndex, state.outputItems.size, state.aliases);
    const merged = mergeOutputItem(state.outputItems.get(key), cloned);
    commitOutputItem(state, key, dataWithIndex, merged);
  });
}

function handleOutputItem(state: CollectorState, data: JsonObject, index: number): void {
  const eventItem = asJsonObject(data.item);
  if (!eventItem) return;

  const key = resolveOutputItemKey(data, index, state.aliases);
  const item = mergeOutputItem(state.outputItems.get(key), cloneJson(eventItem));
  commitOutputItem(state, key, data, item);
}

function messageFallback(data: JsonObject): JsonObject {
  return {
    id: typeof data.item_id === "string" ? data.item_id : undefined,
    type: "message",
    role: "assistant",
  };
}

function handleOutputTextDelta(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, messageFallback(data));
  appendOutputText(item, data);
  commitOutputItem(state, key, data, item);
}

function handleOutputTextDone(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, messageFallback(data));
  setOutputText(item, data);
  commitOutputItem(state, key, data, item);
}

function handleContentPart(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, messageFallback(data));
  mergeContentPart(item, data);
  setOutputText(item, data);
  commitOutputItem(state, key, data, item);
}

function functionCallFallback(data: JsonObject): JsonObject {
  return {
    id: typeof data.item_id === "string" ? data.item_id : undefined,
    type: "function_call",
  };
}

function handleFunctionArgumentsDelta(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, functionCallFallback(data));
  appendStringField(item, "arguments", data.delta);
  commitOutputItem(state, key, data, item);
}

function handleFunctionArgumentsDone(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, functionCallFallback(data));
  setStringField(item, "arguments", data.arguments);
  commitOutputItem(state, key, data, item);
}

function customToolFallback(data: JsonObject): JsonObject {
  return {
    id: typeof data.item_id === "string" ? data.item_id : undefined,
    type: "custom_tool_call",
  };
}

function handleCustomToolInputDelta(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, customToolFallback(data));
  appendStringField(item, "input", data.delta);
  commitOutputItem(state, key, data, item);
}

function handleCustomToolInputDone(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, customToolFallback(data));
  setStringField(item, "input", data.input);
  commitOutputItem(state, key, data, item);
}

function reasoningFallback(data: JsonObject): JsonObject {
  return {
    id: typeof data.item_id === "string" ? data.item_id : undefined,
    type: "reasoning",
  };
}

function handleReasoningSummaryPart(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, reasoningFallback(data));
  mergeReasoningSummaryPart(item, data);
  commitOutputItem(state, key, data, item);
}

function handleReasoningSummaryDelta(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, reasoningFallback(data));
  appendReasoningSummaryText(item, data);
  commitOutputItem(state, key, data, item);
}

function handleReasoningSummaryDone(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, reasoningFallback(data));
  setReasoningSummaryText(item, data);
  commitOutputItem(state, key, data, item);
}

function handleReasoningTextDelta(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, reasoningFallback(data));
  appendReasoningText(item, data);
  commitOutputItem(state, key, data, item);
}

function handleReasoningTextDone(state: CollectorState, data: JsonObject, index: number): void {
  const { key, item } = outputItemForEvent(state, data, index, reasoningFallback(data));
  setReasoningText(item, data);
  commitOutputItem(state, key, data, item);
}

const EVENT_HANDLERS: Record<string, EventHandler | undefined> = {
  "response.output_item.added": handleOutputItem,
  "response.output_item.done": handleOutputItem,
  "response.output_text.delta": handleOutputTextDelta,
  "response.content_part.delta": handleOutputTextDelta,
  "response.output_text.done": handleOutputTextDone,
  "response.content_part.added": handleContentPart,
  "response.content_part.done": handleContentPart,
  "response.function_call_arguments.delta": handleFunctionArgumentsDelta,
  "response.function_call_arguments.done": handleFunctionArgumentsDone,
  "response.custom_tool_call_input.delta": handleCustomToolInputDelta,
  "response.custom_tool_call_input.done": handleCustomToolInputDone,
  "response.reasoning_summary_part.added": handleReasoningSummaryPart,
  "response.reasoning_summary_part.done": handleReasoningSummaryPart,
  "response.reasoning_summary_text.delta": handleReasoningSummaryDelta,
  "response.reasoning_summary_text.done": handleReasoningSummaryDone,
  "response.reasoning_text.delta": handleReasoningTextDelta,
  "response.reasoning_text.done": handleReasoningTextDone,
};

export function collectCodexResponseItemsFromStream(rawStreamText: string): CodexSseItemCollectorResult {
  const parsed = parseSseEvents(rawStreamText);
  const state: CollectorState = {
    outputItems: new Map(),
    aliases: { byItemId: new Map(), byOutputIndex: new Map() },
    eventTypeCounts: {},
    status: "incomplete",
  };

  parsed.events.forEach(({ event, data }, index) => {
    const eventType = eventTypeFromData(event, data);
    state.eventTypeCounts[eventType] = (state.eventTypeCounts[eventType] ?? 0) + 1;
    updateResponseState(state, data, eventType);
    EVENT_HANDLERS[eventType]?.(state, data, index);
  });

  return {
    outputItems: Array.from(state.outputItems.values()).map((item) => cloneJson(sanitizeValue(item)) as JsonObject),
    eventTypeCounts: state.eventTypeCounts,
    malformedEventCount: parsed.malformedEventCount,
    malformedEventTypeCounts: parsed.malformedEventTypeCounts,
    responseId: state.responseId,
    previousResponseId: state.previousResponseId,
    status: state.status,
  };
}
