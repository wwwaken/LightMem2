import { appendCodexContextHistoryJournalEntry } from "./journal-append.js";
import { collectCodexResponseItemsFromStream } from "./sse-item-collector.js";
import {
  cloneJson,
  normalizeObservedAt,
  normalizeStatus,
  sanitizeValue,
} from "./shared.js";
import {
  CODEX_CONTEXT_HISTORY_RESPONSE_SCHEMA,
  type CodexJournalStatus,
  type CodexResponseJournalEntry,
  type JsonObject,
} from "./types.js";

function outputRefs(outputItems: JsonObject[]): CodexResponseJournalEntry["outputItemRefs"] {
  return outputItems.map((item) => ({
    type: typeof item.type === "string" ? item.type : undefined,
    itemId: typeof item.id === "string" ? item.id : undefined,
    callId: typeof item.call_id === "string" ? item.call_id : undefined,
  }));
}

function responseStatus(params: {
  status?: CodexJournalStatus;
  responseStatus?: CodexJournalStatus;
  streamStatus?: CodexJournalStatus;
  malformedEventCount?: number;
}): CodexJournalStatus {
  if (params.status === "failed" || params.responseStatus === "failed" || params.streamStatus === "failed") {
    return "failed";
  }
  if (params.status === "incomplete" || params.responseStatus === "incomplete" || params.streamStatus === "incomplete") {
    return "incomplete";
  }
  const status = normalizeStatus(params.status, params.streamStatus ?? params.responseStatus ?? "completed");
  return status === "completed" && (params.malformedEventCount ?? 0) > 0
    ? "incomplete"
    : status;
}

function responseBodyStatus(response: JsonObject): CodexJournalStatus | undefined {
  const status = typeof response.status === "string" ? response.status.toLowerCase() : undefined;
  if (!status) return undefined;
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "incomplete";
}

export async function appendCodexResponseJournalEntry(params: {
  stateDir: string;
  sessionId: string;
  requestId?: string;
  response?: JsonObject;
  rawStreamText?: string;
  previousResponseId?: string | null;
  status?: CodexJournalStatus;
  error?: string;
  observedAt?: string;
}): Promise<CodexResponseJournalEntry> {
  if (!params.sessionId.trim()
    || (params.requestId !== undefined && !params.requestId.trim())) {
    throw new TypeError("Codex response journal requires non-empty session and request ids");
  }
  const streamCollected = typeof params.rawStreamText === "string"
    ? collectCodexResponseItemsFromStream(params.rawStreamText)
    : undefined;
  const response = params.response ?? {};
  const outputItems = streamCollected
    ? streamCollected.outputItems
    : Array.isArray(response.output)
      ? cloneJson(sanitizeValue(response.output)) as JsonObject[]
      : [];
  const responseId = streamCollected?.responseId
    ?? (typeof response.id === "string" && response.id.trim() ? response.id : undefined);
  const computedStatus = responseStatus({
    status: params.status,
    responseStatus: responseBodyStatus(response),
    streamStatus: streamCollected?.status,
    malformedEventCount: streamCollected?.malformedEventCount,
  });
  const entry: CodexResponseJournalEntry = {
    schema: CODEX_CONTEXT_HISTORY_RESPONSE_SCHEMA,
    kind: "response",
    requestId: params.requestId,
    sessionId: params.sessionId,
    responseId,
    previousResponseId: params.previousResponseId !== undefined
      ? params.previousResponseId
      : streamCollected?.previousResponseId
        ?? (typeof response.previous_response_id === "string" ? response.previous_response_id : undefined),
    stream: typeof params.rawStreamText === "string",
    outputItems,
    outputItemRefs: outputRefs(outputItems),
    eventTypeCounts: streamCollected?.eventTypeCounts,
    malformedEventCount: streamCollected?.malformedEventCount,
    malformedEventTypeCounts: streamCollected?.malformedEventTypeCounts,
    status: computedStatus === "completed" && !responseId ? "incomplete" : computedStatus,
    error: params.error,
    observedAt: normalizeObservedAt(params.observedAt),
  };
  await appendCodexContextHistoryJournalEntry(params.stateDir, params.sessionId, entry);
  return entry;
}
