import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import {
  cacheRelevantRequestOptionFingerprints,
  cacheRelevantRequestOptionNames,
  cacheRelevantRequestOptionShapes,
  prepareCodexStablePrefix,
} from "../src/stable-prefix.js";

function makeCacheFamilyEnvelope(model: string) {
  return {
    metadata: {},
    model,
    stream: true,
    instructions: "You are the coding agent.",
    messages: [
      { role: "system", content: "Project rules." },
      { role: "user", content: "Keep this task unchanged." },
    ],
  } as any;
}

test("cache contract stays uniform across aliases and future model names", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const models = ["gpt-5.6-sol", "cx/gpt-5.6-sol", "gpt-6.0-new", "provider/future-model"];
  const prepared = models.map((model) => prepareCodexStablePrefix(makeCacheFamilyEnvelope(model), config));

  assert.equal(new Set(prepared.map((item) => item.metadata?.lightrsiCacheContractDigest)).size, 1);
  assert.equal(new Set(prepared.map((item) => item.metadata?.cacheFamilyId)).size, 1);
  assert.deepEqual(prepared.map((item) => item.model), models);
  assert.deepEqual(prepared[1]?.messages, prepared[0]?.messages);
  assert.equal(prepared[1]?.instructions, prepared[0]?.instructions);
  assert.match(String(prepared[0]?.metadata?.lightrsiCacheContractDigest ?? ""), /^[a-f0-9]{24}$/);
});

test("cache contract ignores volatile sender metadata inside system prompts", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const base = makeCacheFamilyEnvelope("gpt-5.6-sol");
  const firstContent = 'Sender (untrusted metadata): ```json\n{"agent":"worker-a","session":"session-a"}\n```\n\nProject rules.';
  const secondContent = 'Sender (untrusted metadata): ```json\n{"agent":"worker-b","session":"session-b"}\n```\n\nProject rules.';
  const first = prepareCodexStablePrefix({
    ...base,
    messages: [
      {
        role: "system",
        content: firstContent,
        metadata: { __codexOriginalRole: "system" },
      },
      base.messages[1],
    ],
  }, config);
  const second = prepareCodexStablePrefix({
    ...base,
    messages: [
      {
        role: "system",
        content: secondContent,
        metadata: { __codexOriginalRole: "system" },
      },
      base.messages[1],
    ],
  }, config);

  assert.equal(
    first.metadata?.lightrsiCacheContractDigest,
    second.metadata?.lightrsiCacheContractDigest,
  );
  assert.equal(first.messages[0]?.content, firstContent);
  assert.equal(second.messages[0]?.content, secondContent);
});

test("cache contract ignores volatile DeepAgents conversation-history entries", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const base = makeCacheFamilyEnvelope("gpt-5.6-sol");
  const firstContent = "Read C:\\Users\\Alice Smith\\.deepagents\\conversation_history\\entry-aaaaaaaaaaaaaaa.json before continuing.";
  const secondContent = "Read C:\\Users\\Alice Smith\\.deepagents\\conversation_history\\entry-bbbbbbbbbbbbbbb.json before continuing.";
  const first = prepareCodexStablePrefix({
    ...base,
    messages: [{
      role: "system",
      content: firstContent,
      metadata: { __codexOriginalRole: "system" },
    }, base.messages[1]],
  }, config);
  const second = prepareCodexStablePrefix({
    ...base,
    messages: [{
      role: "system",
      content: secondContent,
      metadata: { __codexOriginalRole: "system" },
    }, base.messages[1]],
  }, config);

  assert.equal(
    first.metadata?.lightrsiCacheContractDigest,
    second.metadata?.lightrsiCacheContractDigest,
  );
  assert.equal(first.messages[0]?.content, firstContent);
  assert.equal(second.messages[0]?.content, secondContent);
});

test("cache contract includes every stable system message", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const base = makeCacheFamilyEnvelope("gpt-5.6-sol");
  const first = prepareCodexStablePrefix({
    ...base,
    messages: [
      {
        role: "system",
        content: "Project rules A.",
        metadata: { __codexOriginalRole: "system" },
      },
      {
        role: "system",
        content: "Developer root.",
        metadata: { __codexOriginalRole: "developer" },
      },
      base.messages[1],
    ],
  }, config);
  const second = prepareCodexStablePrefix({
    ...base,
    messages: [
      {
        role: "system",
        content: "Project rules B.",
        metadata: { __codexOriginalRole: "system" },
      },
      {
        role: "system",
        content: "Developer root.",
        metadata: { __codexOriginalRole: "developer" },
      },
      base.messages[1],
    ],
  }, config);

  assert.notEqual(
    first.metadata?.lightrsiCacheContractDigest,
    second.metadata?.lightrsiCacheContractDigest,
  );
});

test("GPT-5.6 omits explicit cache options when no structured cache block exists", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const prepared = prepareCodexStablePrefix(makeCacheFamilyEnvelope("gpt-5.6"), config);

  assert.equal(prepared.metadata?.promptCacheOptions, undefined);
  assert.equal(prepared.metadata?.promptCacheBreakpoint, undefined);
});

test("cache family ignores stable messages after provider cache boundary", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const base = makeCacheFamilyEnvelope("gpt-5.6-sol");
  const first = prepareCodexStablePrefix({
    ...base,
    messages: [
      { role: "system", content: "Project rules.", metadata: { __codexOriginalRole: "system" } },
      { role: "user", content: "Turn one." },
    ],
  }, config);
  const followUp = prepareCodexStablePrefix({
    ...base,
    messages: [
      { role: "system", content: "Project rules.", metadata: { __codexOriginalRole: "system" } },
      { role: "user", content: "Turn one." },
      { role: "system", content: "Repeated host context.", metadata: { __codexOriginalRole: "system" } },
      { role: "user", content: "Turn two." },
    ],
  }, config);

  assert.equal(first.metadata?.cacheFamilyId, followUp.metadata?.cacheFamilyId);
  assert.equal(first.metadata?.lightrsiCacheContractDigest, followUp.metadata?.lightrsiCacheContractDigest);
  assert.notEqual(first.metadata?.providerWirePrefixHash, "");
  assert.deepEqual(followUp.messages, [
    { role: "system", content: "Project rules.", metadata: { __codexOriginalRole: "system" } },
    { role: "user", content: "Turn one." },
    { role: "system", content: "Repeated host context.", metadata: { __codexOriginalRole: "system" } },
    { role: "user", content: "Turn two." },
  ]);
});

test("cache preparation preserves provider-bound tool order", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const tools = [
    { type: "function", function: { name: "z_tool", parameters: { z: 1, a: 2 } } },
    { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
  ];
  const prepared = prepareCodexStablePrefix({
    ...makeCacheFamilyEnvelope("gpt-5.6-sol"),
    tools,
  }, config);

  assert.deepEqual(prepared.tools, tools);
});

test("cache identity ignores repeated host developer blocks without mutating messages", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const root = { role: "system", content: "Repeated host block.", metadata: { __codexOriginalRole: "developer" } };
  const first = prepareCodexStablePrefix({
    ...makeCacheFamilyEnvelope("gpt-5.6-sol"),
    messages: [root, { role: "system", content: "Other block.", metadata: { __codexOriginalRole: "developer" } }],
  }, config);
  const followUp = prepareCodexStablePrefix({
    ...makeCacheFamilyEnvelope("gpt-5.6-sol"),
    messages: [root, { role: "system", content: "Other block.", metadata: { __codexOriginalRole: "developer" } }, root],
  }, config);

  assert.equal(first.metadata?.cacheFamilyId, followUp.metadata?.cacheFamilyId);
  assert.equal(followUp.messages.length, 3);
});

test("cache contract splits cache-relevant options and tool schemas", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const base = makeCacheFamilyEnvelope("gpt-5.6-sol");
  const withLowReasoning = prepareCodexStablePrefix({
    ...base,
    rawPayload: { reasoning: { effort: "low" } },
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  }, config);
  const withHighReasoning = prepareCodexStablePrefix({
    ...base,
    rawPayload: { reasoning: { effort: "high" } },
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
  }, config);
  const withDifferentTool = prepareCodexStablePrefix({
    ...base,
    rawPayload: { reasoning: { effort: "low" } },
    tools: [{ type: "function", name: "write_file", parameters: { type: "object" } }],
  }, config);

  assert.notEqual(
    withLowReasoning.metadata?.lightrsiCacheContractDigest,
    withHighReasoning.metadata?.lightrsiCacheContractDigest,
  );
  assert.notEqual(
    withLowReasoning.metadata?.lightrsiCacheContractDigest,
    withDifferentTool.metadata?.lightrsiCacheContractDigest,
  );
});

test("Tura-shaped command_run schema stays in one cache family across turns", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const commandRun = {
    type: "function",
    function: {
      name: "command_run",
      description: "Run one batch of commands.",
      parameters: {
        type: "object",
        required: ["commands"],
        properties: {
          commands: { type: "array", items: { type: "object" } },
        },
      },
    },
  };
  const startup = prepareCodexStablePrefix({
    ...makeCacheFamilyEnvelope("gpt-5.6-sol"),
    tools: [commandRun],
    metadata: { promptCacheKey: "tura-startup-session-key" },
  }, config);
  const active = prepareCodexStablePrefix({
    ...makeCacheFamilyEnvelope("gpt-5.6-sol"),
    tools: [commandRun],
    metadata: { promptCacheKey: "tura-active-session-key" },
  }, config);
  const final = prepareCodexStablePrefix({
    ...makeCacheFamilyEnvelope("gpt-5.6-sol"),
    tools: [commandRun],
    metadata: { promptCacheKey: "tura-final-session-key" },
  }, config);

  assert.equal(startup.metadata?.lightrsiCacheContractDigest, active.metadata?.lightrsiCacheContractDigest);
  assert.equal(active.metadata?.lightrsiCacheContractDigest, final.metadata?.lightrsiCacheContractDigest);
  assert.equal(startup.metadata?.promptCacheKey, active.metadata?.promptCacheKey);
  assert.equal(active.metadata?.promptCacheKey, final.metadata?.promptCacheKey);
});

test("cache contract ignores volatile Codex client metadata but preserves semantic options", () => {
  const config = normalizeTokenPilotCodexConfig({});
  const base = makeCacheFamilyEnvelope("gpt-5.6-sol");
  const first = prepareCodexStablePrefix({
    ...base,
    rawPayload: {
      client_metadata: {
        session_id: "session-a",
        thread_id: "thread-a",
        turn_id: "turn-a",
        "x-codex-installation-id": "installation-a",
        "x-codex-turn-metadata": "turn-metadata-a",
        "x-codex-window-id": "window-a",
      },
      reasoning: { effort: "medium" },
    },
  }, config);
  const second = prepareCodexStablePrefix({
    ...base,
    rawPayload: {
      client_metadata: {
        session_id: "session-b",
        thread_id: "thread-b",
        turn_id: "turn-b",
        "x-codex-installation-id": "installation-a",
        "x-codex-turn-metadata": "turn-metadata-b",
        "x-codex-window-id": "window-b",
      },
      reasoning: { effort: "medium" },
    },
  }, config);
  const differentReasoning = prepareCodexStablePrefix({
    ...base,
    rawPayload: {
      client_metadata: {
        session_id: "session-b",
      },
      reasoning: { effort: "high" },
    },
  }, config);

  assert.equal(
    first.metadata?.lightrsiCacheContractDigest,
    second.metadata?.lightrsiCacheContractDigest,
  );
  assert.notEqual(
    second.metadata?.lightrsiCacheContractDigest,
    differentReasoning.metadata?.lightrsiCacheContractDigest,
  );
});

test("cache-relevant option telemetry exposes sorted names without values", () => {
  assert.deepEqual(
    cacheRelevantRequestOptionNames({
      stream: true,
      model: "gpt-5.6-sol",
      reasoning: { effort: "high" },
      temperature: 0.2,
      metadata: { secret: "must-not-be-observed" },
      input: [{ role: "user", content: "private prompt" }],
    }),
    ["reasoning", "temperature"],
  );
  const fingerprints = cacheRelevantRequestOptionFingerprints({
    reasoning: { effort: "high" },
    temperature: 0.2,
    metadata: { secret: "must-not-be-observed" },
  });
  assert.deepEqual(Object.keys(fingerprints), ["reasoning", "temperature"]);
  assert.match(fingerprints.reasoning ?? "", /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(fingerprints), /high|secret|must-not-be-observed/);
  const shapes = cacheRelevantRequestOptionShapes({
    reasoning: { effort: "high" },
  });
  assert.deepEqual(shapes.reasoning, [
    "$:object",
    "$.effort:string",
  ]);
  assert.deepEqual(
    cacheRelevantRequestOptionNames({ client_metadata: { session_id: "private-session" } }),
    [],
  );
});

test("prepareCodexStablePrefix preserves instructions and developer prompt without provider-visible rewrite", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const envelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=agent-123 | mode=interactive",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "You are the coding agent.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | mode=interactive",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  };

  const prepared = prepareCodexStablePrefix(envelope, config);

  assert.notEqual(prepared, envelope);
  assert.match(String(prepared.instructions ?? ""), /Your working directory is: \/repo\/demo/);
  assert.doesNotMatch(String(prepared.instructions ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /Your working directory is: \/repo\/demo/);
  assert.doesNotMatch(String(prepared.messages[0]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.equal(prepared.messages.length, 2);
  assert.equal(prepared.messages[1]?.role, "user");
  assert.equal((prepared.messages[0] as any)?.metadata?.__codexOriginalRole, "developer");
  assert.match(String(prepared.messages[0]?.content ?? ""), /Runtime: agent=agent-123 \| mode=interactive/);
  assert.equal(prepared.messages[1]?.content, "hello");
  assert.match(String(prepared.metadata?.promptCacheKey ?? ""), /^lightrsi-family-[0-9a-f]{24}$/);
  assert.match(String(prepared.metadata?.providerWirePrefixHash ?? ""), /^[0-9a-f]{64}$/);
  assert.match(String(prepared.metadata?.cacheFamilyId ?? ""), /^lightrsi-family-[0-9a-f]{24}$/);
  assert.equal(prepared.metadata?.promptCacheRetention, undefined);
});

test("prepareCodexStablePrefix derives different cache keys for different stable prefixes", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "user",
    },
  });

  const baseEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.\nYour working directory is: /repo/demo",
    messages: [
      {
        role: "system" as const,
        content: "Project A rules.\nYour working directory is: /repo/demo",
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  };

  const preparedA = prepareCodexStablePrefix(baseEnvelope, config);
  const preparedB = prepareCodexStablePrefix({
    ...baseEnvelope,
    messages: [
      {
        ...baseEnvelope.messages[0],
        content: "Project B rules.\nYour working directory is: /repo/demo",
      },
      baseEnvelope.messages[1],
    ],
  }, config);

  assert.notEqual(preparedA.metadata?.promptCacheKey, preparedB.metadata?.promptCacheKey);
});

test("prepareCodexStablePrefix preserves instructions and developer prompt without merging dynamic context", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-merge-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Current date: 2026-07-08",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 |",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  }, config);

  assert.equal(prepared.messages.length, 2);
  assert.match(String(prepared.instructions ?? ""), /Current date: 2026-07-08/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /Your working directory is: \/repo\/demo/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /Runtime: agent=agent-123 \|/);
});

test("prepareCodexStablePrefix preserves developer root prompt and generic system prompt", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-root-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.",
    messages: [
      {
        role: "system" as const,
        content: "Generic system note.",
        metadata: {
          __codexOriginalRole: "system",
        },
      },
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 |",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  }, config);

  assert.equal(String(prepared.messages[0]?.content ?? ""), "Generic system note.");
  assert.equal(String(prepared.messages[1]?.content ?? ""), [
    "Developer policy.",
    "Your working directory is: /repo/demo",
    "Runtime: agent=agent-123 |",
  ].join("\n"));
  assert.equal(prepared.messages[2]?.role, "user");
  assert.equal(prepared.messages[2]?.content, "hello");
});

test("prepareCodexStablePrefix keeps cache keys stable without rewriting volatile runtime metadata", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const makeEnvelope = (params: { date: string; agentId: string; requestId: string; traceId: string }) => ({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-stable-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      `Current date: ${params.date}`,
      "Repository policy: keep commits small.",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          `Runtime: agent=${params.agentId} | mode=interactive | request_id=${params.requestId} | trace_id=${params.traceId}`,
          "Always cite touched files.",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {},
  });

  const preparedA = prepareCodexStablePrefix(makeEnvelope({
    date: "2026-07-08",
    agentId: "agent-123",
    requestId: "req_12345678901234567890",
    traceId: "trace_12345678901234567890",
  }), config);
  const preparedB = prepareCodexStablePrefix(makeEnvelope({
    date: "2026-07-09",
    agentId: "agent-999",
    requestId: "req_99999999999999999999",
    traceId: "trace_99999999999999999999",
  }), config);

  assert.equal(preparedA.metadata?.promptCacheKey, preparedB.metadata?.promptCacheKey);
  assert.match(String(preparedA.instructions ?? ""), /Current date: 2026-07-08/);
  assert.match(String(preparedB.instructions ?? ""), /Current date: 2026-07-09/);
  assert.match(String(preparedA.messages[0]?.content ?? ""), /request_id=req_12345678901234567890/i);
  assert.match(String(preparedB.messages[0]?.content ?? ""), /request_id=req_99999999999999999999/i);
});

test("prepareCodexStablePrefix preserves first user message when dynamic context target is user", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "user",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-user-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Current date: 2026-07-08",
      "Project policy: keep commits small.",
    ].join("\n"),
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | request_id=req_12345678901234567890",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "please inspect the repo",
      },
    ],
    rawPayload: {},
    metadata: {},
  }, config);

  assert.equal(prepared.messages.length, 2);
  assert.match(String(prepared.instructions ?? ""), /Current date: 2026-07-08/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /Your working directory is: \/repo\/demo/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /agent=agent-123/);
  assert.match(String(prepared.messages[0]?.content ?? ""), /request_id=req_12345678901234567890/i);
  assert.equal(prepared.messages[1]?.content, "please inspect the repo");
});

test("prepareCodexStablePrefix does not expose inbound prompt_cache_key", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const prepared = prepareCodexStablePrefix({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-preserve-key-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.\nYour working directory is: /repo/demo",
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | mode=interactive",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {
      promptCacheKey: "upstream-existing-key",
    },
  }, config);

  assert.match(String(prepared.metadata?.promptCacheKey ?? ""), /^lightrsi-family-[a-f0-9]{24}$/);
  assert.match(String(prepared.metadata?.frameworkStablePromptCacheKey ?? ""), /^lightrsi-codex-/);
  assert.equal(prepared.metadata?.originalPromptCacheKey, undefined);
  assert.equal(prepared.metadata?.promptCacheRetention, undefined);
});

test("prepareCodexStablePrefix converges inbound runtime keys to one family key", () => {
  const config = normalizeTokenPilotCodexConfig({
    hooks: {
      dynamicContextTarget: "developer",
    },
  });

  const makeEnvelope = (promptCacheKey: string) => ({
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "codex-synth-converge-1",
      sessionMode: "single" as const,
      metadata: {},
    },
    model: "gpt-5.4",
    stream: true,
    instructions: "You are the coding agent.\nYour working directory is: /repo/demo",
    messages: [
      {
        role: "system" as const,
        content: [
          "Developer policy.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=agent-123 | mode=interactive",
        ].join("\n"),
        metadata: {
          __codexOriginalRole: "developer",
        },
      },
      {
        role: "user" as const,
        content: "hello",
      },
    ],
    rawPayload: {},
    metadata: {
      promptCacheKey,
    },
  });

  const preparedA = prepareCodexStablePrefix(makeEnvelope("legacy-key-a"), config);
  const preparedB = prepareCodexStablePrefix(makeEnvelope("legacy-key-b"), config);

  assert.match(String(preparedA.metadata?.promptCacheKey ?? ""), /^lightrsi-family-[a-f0-9]{24}$/);
  assert.equal(preparedA.metadata?.promptCacheKey, preparedB.metadata?.promptCacheKey);
  assert.equal(preparedA.metadata?.originalPromptCacheKey, undefined);
  assert.equal(preparedB.metadata?.originalPromptCacheKey, undefined);
  assert.equal(
    preparedA.metadata?.frameworkStablePromptCacheKey,
    preparedB.metadata?.frameworkStablePromptCacheKey,
  );
  assert.match(String(preparedA.metadata?.frameworkStablePromptCacheKey ?? ""), /^lightrsi-codex-/);
  assert.match(String(preparedA.metadata?.providerWirePrefixHash ?? ""), /^[a-f0-9]{64}$/);
  assert.match(String(preparedA.metadata?.cacheFamilyId ?? ""), /^lightrsi-family-[a-f0-9]{24}$/);
});
