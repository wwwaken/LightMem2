import { createHash } from "node:crypto";
import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextItemKind,
  type ContextItemRef,
  type ModelContextSnapshot,
} from "@lightmem2/host-adapter";
import type { RuntimeMessage } from "@lightmem2/kernel";

const CLAUDE_HOST_ID = "claude-code";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Content-only digest. The persisted snapshot stores fingerprints, never raw
// host payloads, so evicted text cannot leak through the shared contract.
function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex")
    .slice(0, 32);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content
        .map(asRecord)
        .filter((block): block is Record<string, unknown> => block !== undefined)
    : [];
}

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  return JSON.stringify(value ?? "").length;
}

// Map an Anthropic content block to the shared ContextItemKind vocabulary.
function blockKind(role: string, block: Record<string, unknown>): ContextItemKind {
  const type = String(block.type ?? "").toLowerCase();
  if (type === "tool_use") return "tool_call";
  if (type === "tool_result") return "tool_result";
  if (role === "system") return "system";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  return "unknown";
}

function blockToItemRef(
  sessionId: string,
  messageIndex: number,
  blockIndex: number,
  role: string,
  block: Record<string, unknown>,
): ContextItemRef {
  const kind = blockKind(role, block);
  const callId =
    stringValue(block.tool_use_id) ?? stringValue(block.id);
  const content =
    block.type === "tool_result"
      ? block.content
      : block.type === "tool_use"
        ? block.input
        : (block.text ?? block.content);

  return {
    // Position-based identity within the session; stable across resends of the
    // same history because message/block order is preserved.
    stableId: `${sessionId}:${messageIndex}:${blockIndex}`,
    kind,
    role,
    callId,
    fingerprint: fingerprint({ kind, callId, content }),
    chars: textLength(content),
  };
}

function messageToItemRefs(
  sessionId: string,
  messageIndex: number,
  message: RuntimeMessage,
): ContextItemRef[] {
  const record = asRecord(message) ?? {};
  const role = String(record.role ?? "unknown");

  // String content is a single implicit block.
  if (typeof record.content === "string") {
    return [
      {
        stableId: `${sessionId}:${messageIndex}:0`,
        kind: role === "user" ? "user" : role === "assistant" ? "assistant" : "system",
        role,
        fingerprint: fingerprint({ role, content: record.content }),
        chars: record.content.length,
      },
    ];
  }

  return contentBlocks(record).map((block, blockIndex) =>
    blockToItemRef(sessionId, messageIndex, blockIndex, role, block),
  );
}

// Build a full snapshot of the current inbound request. One snapshot per
// request; it reflects the latest complete history, not an accumulation.
export function buildClaudeContextSnapshot(params: {
  sessionId: string;
  revision: string;
  messages: RuntimeMessage[];
}): ModelContextSnapshot {
  const items: ContextItemRef[] = [];
  params.messages.forEach((message, messageIndex) => {
    items.push(...messageToItemRefs(params.sessionId, messageIndex, message));
  });

  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    hostId: CLAUDE_HOST_ID,
    sessionId: params.sessionId,
    revision: params.revision,
    items,
  };
}
