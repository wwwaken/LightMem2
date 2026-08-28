/**
 * DeepSeek Harness session codec (Task-R2).
 *
 * Turns a DSH append-only durable event log into the LightRSI estimator input.
 * The estimator input is `{ registry, delta }` (eviction/src/types.ts:47); this
 * module owns the `delta` half. It does NOT hand-build a DeltaView — it produces
 * a DSH-specific `RawSemanticSnapshot` and defers assembly to the SHARED builder
 * `buildDeltaViewFromRawSemanticSnapshot`, exactly as the claude-code adapter
 * does (adapters/claude-code/src/context-rewrite/semantic-pipeline.ts). Registry
 * load/persist stays in shared @lightrsi/history helpers; the codec never
 * reimplements it.
 *
 * Read-only and transform-only: no surface replacement, no eviction events,
 * no `surfaceOp`. That is Task-R4.
 */

import {
  buildDeltaViewFromRawSemanticSnapshot,
  type BuildDeltaViewOptions,
  type DeltaView,
  type RawSemanticSnapshot,
  type RawSemanticMessageRecord,
  type RawSemanticToolCallRecord,
  type RawSemanticToolResultRecord,
  type TurnAnchor,
} from "@lightrsi/history";

import type {
  DshContentBlock,
  DshDurableEvent,
  DshLogEvent,
  DshMessage,
  DshSurfaceDescriptor,
} from "./types.js";

/** Event-type keys the codec maps; everything else is tolerated log-only noise. */
const KNOWN_EVENT_TYPES = new Set<DshDurableEvent["type"]>([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
]);

/** Narrow a log event to the known discriminated union; unknowns are skipped. */
function isKnownEvent(event: DshLogEvent): event is DshDurableEvent {
  return KNOWN_EVENT_TYPES.has(event.type as DshDurableEvent["type"]);
}

/** Bound for the short `argumentsSummary` / result `summary` fields. */
const SUMMARY_MAX_CHARS = 600;

function truncate(text: string, maxChars = SUMMARY_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}...`;
}

/** Turn-scoped absolute id, stable across replay/restart. Matches the cross-adapter `${sessionId}:t${n}` convention. */
function turnAbsId(sessionId: string, turnSeq: number): string {
  return `${sessionId}:t${turnSeq}`;
}

function anchor(sessionId: string, turnSeq: number, role: TurnAnchor["role"]): TurnAnchor {
  return { sessionId, turnAbsId: turnAbsId(sessionId, turnSeq), turnSeq, role };
}

/**
 * Concatenate the model-visible text of a message. Visible `text` blocks only;
 * `reasoning` is deliberately excluded (DSH marks it distinct from visible
 * text, packages/llm/llm/src/types.ts:60). Unknown block types are ignored,
 * never fatal.
 */
function visibleText(message: DshMessage): string {
  return blocksText(message.content ?? []).join("\n").trim();
}

/**
 * Collect visible `text` from a block list. Descends into `tool-result` blocks,
 * whose model-facing text lives in their nested `content`
 * (packages/llm/llm/src/types.ts:88). Unknown block types are ignored.
 */
function blocksText(blocks: DshContentBlock[]): string[] {
  const parts: string[] = [];
  for (const block of blocks) {
    if (isTextBlock(block)) {
      parts.push(block.text);
    } else if (block.type === "tool-result" && Array.isArray((block as { content?: unknown }).content)) {
      parts.push(...blocksText((block as { content: DshContentBlock[] }).content));
    }
  }
  return parts;
}

function isTextBlock(block: DshContentBlock): block is { type: "text"; text: string } {
  return block.type === "text" && typeof (block as { text?: unknown }).text === "string";
}

/**
 * Build a DSH raw-semantic snapshot from the ordered durable event log.
 *
 * Preserves the metadata the derived surface strips: durable `seq` (stable
 * anchor), turn, step, event type, source, and `callId` correlation. Turn
 * context is tracked from `turn/start`; events that carry their own `turn`
 * (assistant/tool) use that authoritatively.
 *
 * Log-only / unknown events (todo/write, request/*, assistant/chunk,
 * session/end-seed, plugin events) contribute no records and never abort the
 * snapshot.
 */
export function buildDshRawSemanticSnapshot(
  sessionId: string,
  events: readonly DshLogEvent[],
  options: { surfaceEventSeqs?: readonly number[] } = {},
): RawSemanticSnapshot {
  const messages: RawSemanticMessageRecord[] = [];
  const toolCalls: RawSemanticToolCallRecord[] = [];
  const toolResults: RawSemanticToolResultRecord[] = [];
  const toolNameByCallId = new Map<string, string>();
  const surfaceEventSeqs = options.surfaceEventSeqs
    ? new Set(options.surfaceEventSeqs)
    : undefined;
  const visibleCallIds = new Set<string>();

  if (surfaceEventSeqs) {
    for (const event of events) {
      if (!surfaceEventSeqs.has(event.seq) || !isKnownEvent(event)) continue;
      if (event.type === "tool/result") {
        const callId = event.data.message.source?.callId ?? extractResultCallId(event.data.message);
        if (callId) visibleCallIds.add(callId);
      } else if (event.type === "assistant/message") {
        for (const block of event.data.message.content ?? []) {
          if (block.type === "tool-call" && typeof block.id === "string" && block.id) {
            visibleCallIds.add(block.id);
          }
        }
      }
    }
  }

  let currentTurn = 0;
  let lastTurnSeq = 0;

  for (const event of events) {
    // Log-only / unknown / plugin events contribute no records and never abort.
    if (!isKnownEvent(event)) continue;

    switch (event.type) {
      case "turn/start": {
        currentTurn = event.data.turn;
        lastTurnSeq = Math.max(lastTurnSeq, currentTurn);
        break;
      }

      case "user/message": {
        if (surfaceEventSeqs && !surfaceEventSeqs.has(event.seq)) break;
        const text = visibleText(event.data);
        if (text.length > 0) {
          messages.push({ anchor: anchor(sessionId, currentTurn, "user"), role: "user", text });
        }
        break;
      }

      case "assistant/message": {
        const turn = event.data.turn ?? currentTurn;
        lastTurnSeq = Math.max(lastTurnSeq, turn);
        if (surfaceEventSeqs && !surfaceEventSeqs.has(event.seq)) break;
        const text = visibleText(event.data.message);
        if (text.length > 0) {
          messages.push({ anchor: anchor(sessionId, turn, "assistant"), role: "assistant", text });
        }
        break;
      }

      case "tool/call": {
        const turn = event.data.turn ?? currentTurn;
        lastTurnSeq = Math.max(lastTurnSeq, turn);
        if (surfaceEventSeqs
          && !surfaceEventSeqs.has(event.seq)
          && !visibleCallIds.has(event.data.callId)) break;
        const args = event.data.arguments ?? "";
        toolCalls.push({
          anchor: anchor(sessionId, turn, "assistant"),
          toolCallId: event.data.callId,
          toolName: event.data.name,
          argumentsText: args,
          argumentsSummary: truncate(args),
        });
        toolNameByCallId.set(event.data.callId, event.data.name);
        break;
      }

      case "tool/result": {
        const turn = event.data.turn ?? currentTurn;
        lastTurnSeq = Math.max(lastTurnSeq, turn);
        if (surfaceEventSeqs && !surfaceEventSeqs.has(event.seq)) break;
        const callId = event.data.message.source?.callId ?? extractResultCallId(event.data.message);
        const fullText = visibleText(event.data.message);
        toolResults.push({
          anchor: anchor(sessionId, turn, "tool"),
          toolCallId: callId ?? "",
          toolName: callId ? (toolNameByCallId.get(callId) ?? "") : "",
          status: event.data.error ? "error" : "success",
          fullText,
          summary: truncate(fullText),
        });
        break;
      }

      // step/start, step/end, and every log-only / unknown event: intentionally
      // no record, snapshot continues.
      default:
        break;
    }
  }

  return { sessionId, lastTurnSeq, messages, toolCalls, toolResults };
}

/** Recover a tool-result's callId from its single ToolResultBlock when `source.callId` is absent. */
function extractResultCallId(message: DshMessage): string | undefined {
  for (const block of message.content ?? []) {
    if (block.type === "tool-result" && typeof (block as { toolCallId?: unknown }).toolCallId === "string") {
      return (block as { toolCallId: string }).toolCallId;
    }
  }
  return undefined;
}

/**
 * Assemble the estimator's `delta` for a turn interval by delegating to the
 * shared history builder. `fromTurnSeqExclusive` is typically the registry's
 * `lastProcessedTurnSeq`.
 */
export function buildDshDeltaView(
  snapshot: RawSemanticSnapshot,
  options: BuildDeltaViewOptions,
): DeltaView {
  return buildDeltaViewFromRawSemanticSnapshot(snapshot, options);
}

/**
 * Stable snapshot revision (§4.1): a reproducible summary of session id, last
 * durable seq, surface replace generation, and the ordered surface node seqs.
 * Identical inputs → identical revision, across replay and restart. Used by the
 * estimate→apply guard (revision drift ⇒ defer, R4).
 */
export function computeDshSnapshotRevision(surface: DshSurfaceDescriptor): string {
  const nodes = surface.orderedSurfaceNodeSeqs.join(",");
  const canonical = `${surface.sessionId}|seq:${surface.lastEventSeq}|gen:${surface.surfaceReplaceGeneration}|nodes:${nodes}`;
  return `dsh-rev-${djb2(canonical)}-${surface.surfaceReplaceGeneration}`;
}

/** Small deterministic string hash (djb2). No crypto dependency; stability, not security. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
