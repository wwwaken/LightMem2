import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeContentBlock } from "@lightrsi/kernel";

import {
  applyStablePrefixToInstructions,
  buildStabilityVisualSnapshotFromTexts,
  canonicalizeTools,
  defaultPrepareStablePrefix,
  fingerprintStablePrefixEnvelope,
  rewriteTextForStablePrefix,
  type StabilizerRequestEnvelope,
} from "../src/index.js";

function envelope(userText: string): StabilizerRequestEnvelope & { transport: string } {
  return {
    session: { host: { hostId: "test-host" } },
    model: "test-model",
    instructions: "Runtime: agent=agent-123 | session_id=session-456\nCurrent date: 2026-07-21",
    messages: [{ role: "user", content: userText }],
    tools: [],
    transport: "responses",
  };
}

test("canonicalizeTools stabilizes tool order and nested object keys", () => {
  const tools = canonicalizeTools([
    { type: "function", function: { parameters: { z: 1, a: 2 }, name: "zeta" } },
    { type: "function", function: { name: "alpha", parameters: { b: 1, a: 2 } } },
  ]);

  assert.equal((tools?.[0] as any).function.name, "alpha");
  assert.deepEqual(Object.keys((tools?.[0] as any).function.parameters), ["a", "b"]);
});

test("stable prefix rewrite preserves ordinary business text", () => {
  const source = "Invoice 2026-07-21 covers order 123456789012 for customer request planning.";
  const rewritten = rewriteTextForStablePrefix(source);

  assert.equal(rewritten.forwardedText, source);
  assert.equal(rewritten.dynamicContextText, "");
});

test("stable prefix preparation preserves host-specific envelope fields", () => {
  const input = envelope("Review the repository");
  const prepared = applyStablePrefixToInstructions({ envelope: input });

  assert.equal(prepared.transport, "responses");
  assert.equal(prepared.instructions, "Runtime: agent=agent-123");
  assert.match(String(prepared.messages[0].content), /Current date: 2026-07-21/);
});

test("default stable prefix preparation preserves user payload bytes", () => {
  const userText = " [request-123] \r\n- CURRENT_DATE: 2026-08-26\r\nSender (untrusted metadata): ```json\n{\"x\":1}\n```\r\nKeep exact.";
  const input = envelope(userText);
  input.instructions = "Stable instructions";

  const prepared = defaultPrepareStablePrefix(input);

  assert.equal(prepared, input);
  assert.equal(prepared.messages[0]?.content, userText);
});

test("default stable prefix preparation injects context without rewriting structured user content", () => {
  const content: RuntimeContentBlock[] = [
    { type: "text", text: "[IMPORTANT] keep exact\r\n---\nvalue: user-owned" },
    { type: "image", imageUrl: "https://example.com/user-owned.png" },
  ];
  const input: StabilizerRequestEnvelope = {
    session: { host: { hostId: "test-host" } },
    model: "test-model",
    instructions: "Your working directory is: C:\\repo\\project\nRuntime: agent=agent-123 | session_id=session-456",
    messages: [{ role: "user", content }],
    tools: [],
  };

  const prepared = defaultPrepareStablePrefix(input);

  assert.notEqual(prepared, input);
  assert.deepEqual(input.messages[0]?.content, content);
  assert.deepEqual(prepared.messages[0]?.content, [
    {
      type: "text",
      text: "- WORKDIR: C:\\repo\\project\n- AGENT_ID: agent-123\nsession_id=session-456\n\n[IMPORTANT] keep exact\r\n---\nvalue: user-owned",
    },
    { type: "image", imageUrl: "https://example.com/user-owned.png" },
  ]);
});

test("stable prefix fingerprint excludes volatile user tail", () => {
  const first = envelope("first request");
  const second = envelope("second request");

  assert.equal(fingerprintStablePrefixEnvelope(first), fingerprintStablePrefixEnvelope(second));
});

test("stability visual builder derives canonical prompt and user rewrite count", () => {
  const snapshot = buildStabilityVisualSnapshotFromTexts({
    at: "2026-06-29T13:00:00.000Z",
    sessionId: "session-2",
    model: "gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    promptCacheKeyBefore: "",
    promptCacheKeyAfter: "pk-2",
    dynamicContextTarget: "user",
    developerBefore: "Your working directory is: /repo/demo\nRuntime: agent=agent-1 |\nBe precise.",
    developerForwarded: "Your working directory is: <WORKDIR>\nRuntime: agent=<AGENT_ID> |\nBe precise.",
    userBefore: "hello",
    userForwarded: "- WORKDIR: /repo/demo\n- AGENT_ID: agent-1\n\nhello",
    firstTurnCandidate: true,
  });

  assert.match(snapshot.developerCanonical, /<WORKDIR>/);
  assert.match(snapshot.dynamicContextText ?? "", /WORKDIR: \/repo\/demo/);
  assert.equal(snapshot.userContentRewrites, 1);
});
