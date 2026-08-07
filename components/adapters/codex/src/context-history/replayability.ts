import type { JsonObject } from "./types.js";

export type CodexReplayabilityMode = "replayable" | "observation_only" | "deferred";

export type CodexReplayabilityReason =
  | "default_replayable"
  | "tool_closure_required"
  | "tool_call_id_missing"
  | "exact_payload_required"
  | "exact_payload_missing"
  | "provider_observation"
  | "turn_context_instruction"
  | "unsupported_item_type";

export type CodexItemReplayability = {
  mode: CodexReplayabilityMode;
  reason: CodexReplayabilityReason;
};

export function codexReplayabilityForItem(item: JsonObject): CodexItemReplayability {
  const type = String(item.type ?? "").toLowerCase();
  const role = String(item.role ?? "").toLowerCase();
  if (type === "web_search_call" || type === "event_msg") {
    return { mode: "observation_only", reason: "provider_observation" };
  }
  if (type === "turn_context") {
    return { mode: "observation_only", reason: "turn_context_instruction" };
  }
  if (
    type === "function_call"
    || type === "custom_tool_call"
    || type === "function_call_output"
    || type === "custom_tool_call_output"
  ) {
    return typeof item.call_id === "string" && item.call_id.trim().length > 0
      ? { mode: "replayable", reason: "tool_closure_required" }
      : { mode: "deferred", reason: "tool_call_id_missing" };
  }
  if (type === "reasoning" || type === "compaction") {
    return typeof item.encrypted_content === "string" && item.encrypted_content.trim().length > 0
      ? { mode: "replayable", reason: "exact_payload_required" }
      : { mode: "deferred", reason: "exact_payload_missing" };
  }
  if (type === "message" || (!type && ["system", "developer", "user", "assistant"].includes(role))) {
    return { mode: "replayable", reason: "default_replayable" };
  }
  return { mode: "deferred", reason: "unsupported_item_type" };
}

export function isCodexObservationOnlyItem(item: JsonObject): boolean {
  return codexReplayabilityForItem(item).mode === "observation_only";
}

export function isCodexDeferredItem(item: JsonObject): boolean {
  return codexReplayabilityForItem(item).mode === "deferred";
}
