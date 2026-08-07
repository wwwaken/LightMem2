import assert from "node:assert/strict";
import test from "node:test";

import {
  collectCodexResponseItemsFromStream,
  type JsonObject,
} from "../src/context-history/index.js";

function sseBlock(event: string | undefined, data: JsonObject | string): string {
  const lines = event ? [`event: ${event}`] : [];
  const text = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of text.split("\n")) lines.push(`data: ${line}`);
  lines.push("");
  return lines.join("\n");
}

function sseStream(...blocks: string[]): string {
  return blocks.join("\n");
}

function asObject(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function outputText(item: JsonObject): string {
  assert.ok(Array.isArray(item.content));
  const part = asObject(item.content[0]);
  assert.equal(typeof part.text, "string");
  return part.text;
}

test("CDH-03 SSE Item Collector applies content part, delta, and done events", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.created", {
      response: { id: "resp-stream-1", previous_response_id: "resp-prev-1" },
    }),
    sseBlock("response.output_item.added", {
      output_index: 0,
      item: { id: "msg-1", type: "message", role: "assistant", content: [] },
    }),
    sseBlock("response.content_part.added", {
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "Hello" },
    }),
    sseBlock("response.output_text.delta", {
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      delta: ", world",
    }),
    sseBlock("response.output_text.done", {
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      text: "Hello, world!",
    }),
    sseBlock("response.content_part.done", {
      item_id: "msg-1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "Hello, world!" },
    }),
    sseBlock("response.completed", { response: { id: "resp-stream-1" } }),
    sseBlock(undefined, "[DONE]"),
  ));
  const message = asObject(result.outputItems[0]);

  assert.equal(result.status, "completed");
  assert.equal(result.responseId, "resp-stream-1");
  assert.equal(result.previousResponseId, "resp-prev-1");
  assert.equal(result.outputItems.length, 1);
  assert.equal(message.type, "message");
  assert.equal(outputText(message), "Hello, world!");
  assert.equal(result.eventTypeCounts["response.content_part.done"], 1);
  assert.equal(result.eventTypeCounts["response.output_text.done"], 1);
});

test("CDH-03 SSE Item Collector applies function argument delta and done events", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.output_item.added", {
      output_index: 0,
      item: {
        id: "fc-1",
        type: "function_call",
        call_id: "call-1",
        name: "run_tests",
        arguments: "",
      },
    }),
    sseBlock("response.function_call_arguments.delta", {
      item_id: "fc-1",
      output_index: 0,
      delta: "{\"command\":",
    }),
    sseBlock("response.function_call_arguments.delta", {
      item_id: "fc-1",
      output_index: 0,
      delta: "\"npm test\"}",
    }),
    sseBlock("response.function_call_arguments.done", {
      item_id: "fc-1",
      output_index: 0,
      arguments: "{\"command\":\"npm test\"}",
    }),
    sseBlock("response.completed", { response: { id: "resp-stream-2" } }),
  ));
  const item = asObject(result.outputItems[0]);

  assert.equal(result.status, "completed");
  assert.equal(item.type, "function_call");
  assert.equal(item.call_id, "call-1");
  assert.equal(item.arguments, "{\"command\":\"npm test\"}");
  assert.equal(result.eventTypeCounts["response.function_call_arguments.done"], 1);
});

test("CDH-03 SSE Item Collector uses response data.type when SSE event fields are absent", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock(undefined, {
      type: "response.created",
      response: { id: "resp-data-type" },
    }),
    sseBlock(undefined, {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg-1", type: "message", role: "assistant", content: [] },
    }),
    sseBlock(undefined, {
      type: "response.output_text.delta",
      item_id: "msg-1",
      output_index: 0,
      delta: "typed",
    }),
    sseBlock(undefined, {
      type: "response.completed",
      response: { id: "resp-data-type" },
    }),
  ));
  const message = asObject(result.outputItems[0]);

  assert.equal(result.status, "completed");
  assert.equal(result.responseId, "resp-data-type");
  assert.equal(outputText(message), "typed");
  assert.equal(result.eventTypeCounts["response.output_text.delta"], 1);
  assert.equal(result.eventTypeCounts.message, undefined);
});

test("CDH-03 SSE Item Collector ignores non-response data.type overrides", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.output_item.added", {
      type: "message",
      output_index: 0,
      item: { id: "msg-1", type: "message", role: "assistant", content: [] },
    }),
    sseBlock("response.output_text.delta", {
      type: "output_text",
      item_id: "msg-1",
      output_index: 0,
      delta: "kept",
    }),
  ));

  assert.equal(outputText(asObject(result.outputItems[0])), "kept");
  assert.equal(result.eventTypeCounts["response.output_text.delta"], 1);
  assert.equal(result.eventTypeCounts.output_text, undefined);
});

test("CDH-03 SSE Item Collector aggregates reasoning and custom tool delta events", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.output_item.added", {
      output_index: 0,
      item: { id: "rs-1", type: "reasoning", summary: [] },
    }),
    sseBlock("response.reasoning_summary_part.added", {
      item_id: "rs-1",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    sseBlock("response.reasoning_summary_text.delta", {
      item_id: "rs-1",
      output_index: 0,
      summary_index: 0,
      delta: "checked",
    }),
    sseBlock("response.reasoning_summary_text.done", {
      item_id: "rs-1",
      output_index: 0,
      summary_index: 0,
      text: "checked",
    }),
    sseBlock("response.output_item.added", {
      output_index: 1,
      item: {
        id: "cc-1",
        type: "custom_tool_call",
        call_id: "custom-1",
        name: "edit",
        input: "",
      },
    }),
    sseBlock("response.custom_tool_call_input.delta", {
      item_id: "cc-1",
      output_index: 1,
      delta: "pay",
    }),
    sseBlock("response.custom_tool_call_input.done", {
      item_id: "cc-1",
      output_index: 1,
      input: "payload",
    }),
    sseBlock("response.completed", { response: { id: "resp-stream-4" } }),
  ));
  const reasoning = asObject(result.outputItems[0]);
  const customCall = asObject(result.outputItems[1]);

  assert.ok(Array.isArray(reasoning.summary));
  assert.equal(asObject(reasoning.summary[0]).text, "checked");
  assert.equal(customCall.type, "custom_tool_call");
  assert.equal(customCall.call_id, "custom-1");
  assert.equal(customCall.input, "payload");
});

test("CDH-03 SSE Item Collector handles a mixed upstream stream fixture", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.created", {
      type: "response.created",
      response: { id: "resp-realistic-stream", previous_response_id: "resp-prev-realistic" },
    }),
    sseBlock("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg-realistic", type: "message", role: "assistant", content: [] },
    }),
    sseBlock("response.content_part.added", {
      type: "response.content_part.added",
      item_id: "msg-realistic",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    sseBlock("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "msg-realistic",
      output_index: 0,
      content_index: 0,
      delta: "I'll check ",
    }),
    sseBlock("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "msg-realistic",
      output_index: 0,
      content_index: 0,
      delta: "the state.",
    }),
    sseBlock("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "reason-realistic", type: "reasoning", encrypted_content: "encrypted-1", summary: [] },
    }),
    sseBlock("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: "reason-realistic",
      output_index: 1,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    sseBlock("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: "reason-realistic",
      output_index: 1,
      summary_index: 0,
      delta: "Need a safe rebase.",
    }),
    sseBlock("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 2,
      item: {
        id: "function-realistic",
        type: "function_call",
        call_id: "call-realistic",
        name: "read_file",
        arguments: "",
      },
    }),
    sseBlock("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: "function-realistic",
      output_index: 2,
      delta: "{\"path\":\"context.ts\"",
    }),
    sseBlock("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: "function-realistic",
      output_index: 2,
      arguments: "{\"path\":\"context.ts\"}",
    }),
    sseBlock("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 3,
      item: {
        id: "custom-realistic",
        type: "custom_tool_call",
        call_id: "custom-realistic",
        name: "patch",
        input: "",
      },
    }),
    sseBlock("response.custom_tool_call_input.delta", {
      type: "response.custom_tool_call_input.delta",
      item_id: "custom-realistic",
      output_index: 3,
      delta: "diff --git",
    }),
    sseBlock("response.custom_tool_call_input.done", {
      type: "response.custom_tool_call_input.done",
      item_id: "custom-realistic",
      output_index: 3,
      input: "diff --git",
    }),
    sseBlock("response.completed", {
      type: "response.completed",
      response: { id: "resp-realistic-stream", previous_response_id: "resp-prev-realistic" },
    }),
    sseBlock(undefined, "[DONE]"),
  ));

  const message = asObject(result.outputItems[0]);
  const reasoning = asObject(result.outputItems[1]);
  const functionCall = asObject(result.outputItems[2]);
  const customCall = asObject(result.outputItems[3]);

  assert.equal(result.status, "completed");
  assert.equal(result.responseId, "resp-realistic-stream");
  assert.equal(result.previousResponseId, "resp-prev-realistic");
  assert.equal(result.outputItems.length, 4);
  assert.equal(outputText(message), "I'll check the state.");
  assert.equal(asObject(reasoning.summary[0]).text, "Need a safe rebase.");
  assert.equal(reasoning.encrypted_content, "encrypted-1");
  assert.equal(functionCall.arguments, "{\"path\":\"context.ts\"}");
  assert.equal(customCall.input, "diff --git");
  assert.equal(result.malformedEventCount, 0);
  assert.equal(result.eventTypeCounts["response.output_item.added"], 4);
});

test("CDH-03 SSE Item Collector preserves accumulated fields across empty item updates", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.output_item.added", {
      output_index: 0,
      item: { id: "msg-1", type: "message", role: "assistant", content: [] },
    }),
    sseBlock("response.output_text.delta", {
      item_id: "msg-1",
      output_index: 0,
      delta: "partial",
    }),
    sseBlock("response.output_item.done", {
      output_index: 0,
      item: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "" }],
      },
    }),
  ));

  assert.equal(outputText(asObject(result.outputItems[0])), "partial");
});

test("CDH-03 SSE Item Collector preserves accumulated deltas across empty done events", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.output_item.added", {
      output_index: 0,
      item: { id: "msg-1", type: "message", role: "assistant", content: [] },
    }),
    sseBlock("response.output_text.delta", {
      item_id: "msg-1",
      output_index: 0,
      delta: "partial",
    }),
    sseBlock("response.output_text.done", {
      item_id: "msg-1",
      output_index: 0,
      text: "",
    }),
    sseBlock("response.output_item.added", {
      output_index: 1,
      item: {
        id: "fc-1",
        type: "function_call",
        call_id: "call-1",
        name: "read",
        arguments: "",
      },
    }),
    sseBlock("response.function_call_arguments.delta", {
      item_id: "fc-1",
      output_index: 1,
      delta: "{\"path\":\"a\"}",
    }),
    sseBlock("response.function_call_arguments.done", {
      item_id: "fc-1",
      output_index: 1,
      arguments: "",
    }),
    sseBlock("response.output_item.added", {
      output_index: 2,
      item: {
        id: "cc-1",
        type: "custom_tool_call",
        call_id: "custom-1",
        name: "patch",
        input: "",
      },
    }),
    sseBlock("response.custom_tool_call_input.delta", {
      item_id: "cc-1",
      output_index: 2,
      delta: "diff",
    }),
    sseBlock("response.custom_tool_call_input.done", {
      item_id: "cc-1",
      output_index: 2,
      input: "",
    }),
    sseBlock("response.output_item.added", {
      output_index: 3,
      item: { id: "msg-2", type: "message", role: "assistant", content: [] },
    }),
    sseBlock("response.output_text.delta", {
      item_id: "msg-2",
      output_index: 3,
      content_index: 0,
      delta: "content-part",
    }),
    sseBlock("response.content_part.done", {
      item_id: "msg-2",
      output_index: 3,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
    sseBlock("response.output_item.added", {
      output_index: 4,
      item: { id: "rs-1", type: "reasoning", summary: [] },
    }),
    sseBlock("response.reasoning_summary_text.delta", {
      item_id: "rs-1",
      output_index: 4,
      summary_index: 0,
      delta: "summary",
    }),
    sseBlock("response.reasoning_summary_text.done", {
      item_id: "rs-1",
      output_index: 4,
      summary_index: 0,
      text: "",
    }),
    sseBlock("response.reasoning_summary_part.done", {
      item_id: "rs-1",
      output_index: 4,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
  ));

  assert.equal(outputText(asObject(result.outputItems[0])), "partial");
  assert.equal(asObject(result.outputItems[1]).arguments, "{\"path\":\"a\"}");
  assert.equal(asObject(result.outputItems[2]).input, "diff");
  assert.equal(outputText(asObject(result.outputItems[3])), "content-part");
  assert.equal(asObject(asObject(result.outputItems[4]).summary[0]).text, "summary");
});

test("CDH-03 SSE Item Collector preserves encrypted reasoning across empty item updates", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.output_item.added", {
      output_index: 0,
      item: { id: "rs-1", type: "reasoning", encrypted_content: "opaque" },
    }),
    sseBlock("response.output_item.done", {
      output_index: 0,
      item: {
        id: "rs-1",
        type: "reasoning",
        encrypted_content: null,
        summary: [{ type: "summary_text", text: "summary" }],
      },
    }),
  ));

  assert.equal(asObject(result.outputItems[0]).encrypted_content, "opaque");
});

test("CDH-03 SSE Item Collector keeps reasoning items and only counts unknown events", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.future_event", {
      headers: { authorization: "Bearer secret" },
      note: "count only",
    }),
    sseBlock("response.output_text.delta", "{\"truncated\":"),
    sseBlock("response.output_item.done", {
      output_index: 0,
      item: { id: "rs-1", type: "reasoning", encrypted_content: "opaque" },
    }),
    sseBlock("response.completed", { response: { id: "resp-stream-3" } }),
  ));
  const item = asObject(result.outputItems[0]);

  assert.equal(result.status, "completed");
  assert.equal(result.malformedEventCount, 1);
  assert.equal(result.malformedEventTypeCounts["response.output_text.delta"], 1);
  assert.equal(result.eventTypeCounts["response.future_event"], 1);
  assert.equal(result.outputItems.length, 1);
  assert.equal(item.type, "reasoning");
  assert.equal(item.encrypted_content, "opaque");
  assert.doesNotMatch(JSON.stringify(result.outputItems), /authorization|Bearer secret/i);
});

test("CDH-03 SSE Item Collector marks interrupted streams incomplete", () => {
  const result = collectCodexResponseItemsFromStream(sseStream(
    sseBlock("response.created", { response: { id: "resp-interrupted" } }),
    sseBlock("response.output_item.added", {
      output_index: 0,
      item: { id: "msg-1", type: "message", role: "assistant", content: [] },
    }),
    sseBlock("response.output_text.delta", {
      item_id: "msg-1",
      output_index: 0,
      delta: "partial",
    }),
  ));

  assert.equal(result.status, "incomplete");
  assert.equal(result.responseId, "resp-interrupted");
  assert.equal(outputText(asObject(result.outputItems[0])), "partial");
});

test("CDH-03 SSE Item Collector parses multiline data fields", () => {
  const result = collectCodexResponseItemsFromStream(sseBlock(
    "response.created",
    "{\"response\":{\n\"id\":\"resp-multiline\",\n\"previous_response_id\":\"resp-prev\"}}",
  ));

  assert.equal(result.responseId, "resp-multiline");
  assert.equal(result.previousResponseId, "resp-prev");
});
