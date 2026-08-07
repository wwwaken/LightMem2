import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextMutationPlan,
} from "@lightmem2/host-adapter";
import {
  createEmptySessionTaskRegistry,
  persistSessionTaskRegistry,
} from "@lightmem2/history";

import {
  createOpenClawReferenceBackend,
  type OpenClawReferenceBackendRequest,
} from "./reference-backend.js";

const fixtureDirectory = path.join(
  __dirname,
  "fixtures",
  "reference-backend",
);

function readFixture(
  fileName: string,
): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(
      path.join(fixtureDirectory, fileName),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";

  return value
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      return String(
        (block as Record<string, unknown>).text ?? "",
      );
    })
    .join("");
}

function taskIdsFor(
  message: Record<string, unknown>,
): string[] {
  const details = message.details as {
    contextSafe?: {
      taskIds?: string[];
    };
  } | undefined;

  return details?.contextSafe?.taskIds ?? [];
}

function createRequest(
  messages: Record<string, unknown>[],
  stateDir = "/tmp/openclaw-reference-backend",
): OpenClawReferenceBackendRequest {
  return {
    stateDir,
    sessionId: "session-1",
    state: {
      version: 1,
      sessionId: "session-1",
      messages,
      seenMessageIds: messages.map(
        (message) => String(message.messageId),
      ),
      updatedAt: "2026-07-30T00:00:00.000Z",
    },
    evictionEnabled: true,
    evictionPolicy: "model_scored",
    evictionMinBlockChars: 1,
    evictionReplacementMode: "pointer_stub",
    helpers: {
      appendTaskStateTrace: async () => undefined,
      appendEvictionVisualSnapshot:
        async () => undefined,

      asRecord: (value) =>
        value
        && typeof value === "object"
        && !Array.isArray(value)
          ? value as Record<string, unknown>
          : undefined,

      canonicalMessageTaskIds: taskIdsFor,
      contentToText,

      dedupeStrings: (values) => [
        ...new Set(values),
      ],

      ensureContextSafeDetails: (
        _details,
        patch,
      ) => ({
        contextSafe: patch,
      }),

      extractPathLike: () => undefined,

      extractToolMessageText: (message) =>
        contentToText(message.content),

      isToolResultLikeMessage: (message) =>
        ["tool", "toolresult"].includes(
          String(
            message.role ?? "",
          ).toLowerCase(),
        ),

      logger: {
        info: () => undefined,
      },

      messageToolCallId: (message) =>
        typeof message.tool_call_id === "string"
          ? message.tool_call_id
          : typeof message.toolCallId === "string"
            ? message.toolCallId
            : undefined,

      safeId: (value) => value,
    },
  };
}

function createPlan(params: {
  snapshotRevision: string;
  targetItemIds: string[];
  type?: "remove" | "replace";
  taskId?: string;
}): ContextMutationPlan {
  return {
    schemaVersion:
      MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId: "plan-1",
    hostId: "openclaw",
    sessionId: "session-1",
    baseRevision: params.snapshotRevision,
    sourceModuleId: "eviction",
    operations: [
      {
        id: "operation-1",
        type: params.type ?? "replace",
        targetItemIds: params.targetItemIds,
        taskIds: [params.taskId ?? "task-completed"],
        rationale: "page out completed task",
        estimatedSavedChars: 20,
      },
    ],
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

test(
  "maps canonical, tool, and pointer fixtures into shared item kinds",
  async () => {
    const request = createRequest([
      readFixture("canonical-message.json"),
      readFixture("tool-call.json"),
      readFixture("tool-result.json"),
      readFixture("pointer-stub.json"),
    ]);

    const backend =
      createOpenClawReferenceBackend();

    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });

    assert.equal(snapshot.hostId, "openclaw");

    assert.deepEqual(
      snapshot.items.map((item) => item.kind),
      [
        "user",
        "tool_call",
        "tool_result",
        "compaction",
      ],
    );

    assert.equal(
      snapshot.items[1]?.callId,
      "call-fixture-1",
    );

    assert.equal(
      snapshot.items[2]?.callId,
      "call-fixture-1",
    );

    assert.deepEqual(
      snapshot.items[0]?.taskIds,
      ["task-completed"],
    );
  },
);

test(
  "defers a plan that would split a tool call from its result",
  async () => {
    const resultOutsideTask = {
      ...readFixture("tool-result.json"),
      details: {
        contextSafe: {
          taskIds: ["task-other"],
        },
      },
    };
    const request = createRequest([
      readFixture("tool-call.json"),
      resultOutsideTask,
    ]);

    const backend =
      createOpenClawReferenceBackend();

    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });

    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: ["fixture-tool-call"],
      type: "remove",
    });

    const validation = await backend.validate({
      snapshot,
      plan,
    });

    assert.equal(validation.valid, true);

    assert.deepEqual(
      validation.applicableOperationIds,
      [],
    );

    assert.deepEqual(
      validation.deferredOperationIds,
      ["operation-1"],
    );

    assert.match(
      validation.reasons[0] ?? "",
      /tool closure/,
    );
  },
);

test(
  "delegates canonical rewrite and emits ContextRewriteResult",
  async () => {
    const active = {
      ...readFixture("canonical-message.json"),
      messageId: "fixture-active",
      content: "active task must remain",
      details: {
        contextSafe: {
          taskIds: ["task-active"],
        },
      },
    };

    const request = createRequest([
      readFixture("canonical-message.json"),
      readFixture("tool-call.json"),
      readFixture("tool-result.json"),
      active,
    ]);

    const backend =
      createOpenClawReferenceBackend({
        rewriteCanonicalState:
          async (params) => ({
            state: {
              ...params.state,
              messages: [
                readFixture(
                  "pointer-stub.json",
                ),
                params.state.messages[3],
              ],
              updatedAt:
                "2026-07-30T00:01:00.000Z",
            },
            changed: true,
            appliedEvictionTaskIds: [
              "task-completed",
            ],
          }),
      });

    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });

    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: [
        "fixture-canonical",
        "fixture-tool-call",
        "fixture-tool-result",
      ],
    });

    const applied = await backend.apply({
      snapshot,
      plan,
      request,
    });

    assert.equal(
      applied.result.mode,
      "canonical",
    );

    assert.equal(
      applied.result.applied,
      true,
    );

    assert.equal(
      applied.result.changed,
      true,
    );

    assert.deepEqual(
      applied.result.appliedOperationIds,
      ["operation-1"],
    );

    assert.deepEqual(
      applied.result.deferredOperationIds,
      [],
    );

    assert.deepEqual(
      applied.result.removedItemIds,
      [
        "fixture-canonical",
        "fixture-tool-call",
        "fixture-tool-result",
      ],
    );

    assert.deepEqual(
      applied.result.details?.appliedTaskIds,
      ["task-completed"],
    );

    assert.equal(
      applied.result.details?.replacementMode,
      "pointer_stub",
    );

    assert.equal(
      applied.request.state.messages.length,
      2,
    );
  },
);

test(
  "does not let a deferred operation complete another operation's tool closure",
  async () => {
    const toolResult = {
      ...readFixture("tool-result.json"),
      details: {
        contextSafe: {
          taskIds: ["task-result"],
        },
      },
    };
    const request = createRequest([
      readFixture("tool-call.json"),
      toolResult,
    ]);
    const backend = createOpenClawReferenceBackend();
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });
    const plan: ContextMutationPlan = {
      schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
      planId: "split-tool-plan",
      hostId: "openclaw",
      sessionId: request.sessionId,
      baseRevision: snapshot.revision,
      sourceModuleId: "eviction",
      operations: [
        {
          id: "remove-call",
          type: "remove",
          targetItemIds: ["fixture-tool-call"],
          taskIds: ["task-completed"],
          rationale: "remove call",
          estimatedSavedChars: 10,
        },
        {
          id: "remove-result",
          type: "remove",
          targetItemIds: ["fixture-tool-result"],
          taskIds: ["task-result"],
          rationale: "remove result",
          estimatedSavedChars: 10,
        },
      ],
      createdAt: "2026-07-30T00:00:00.000Z",
    };

    const validation = await backend.validate({ snapshot, plan });

    assert.equal(validation.valid, true);
    assert.deepEqual(validation.applicableOperationIds, []);
    assert.deepEqual(
      validation.deferredOperationIds,
      ["remove-call", "remove-result"],
    );
    assert.equal(
      validation.reasons.every((reason) => /tool closure/.test(reason)),
      true,
    );
  },
);

test(
  "defers malformed duplicate tool protocol items",
  async () => {
    const duplicateCall = {
      ...readFixture("tool-call.json"),
      messageId: "fixture-tool-call-duplicate",
    };
    const request = createRequest([
      readFixture("tool-call.json"),
      duplicateCall,
      readFixture("tool-result.json"),
    ]);
    const backend = createOpenClawReferenceBackend();
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });
    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: snapshot.items.map((item) => item.stableId),
      type: "remove",
    });

    const validation = await backend.validate({ snapshot, plan });

    assert.deepEqual(validation.applicableOperationIds, []);
    assert.deepEqual(validation.deferredOperationIds, ["operation-1"]);
    assert.match(validation.reasons[0] ?? "", /tool closure/);
  },
);

test(
  "defers messages shared by the target and another task",
  async () => {
    const sharedMessage = {
      ...readFixture("canonical-message.json"),
      details: {
        contextSafe: {
          taskIds: ["task-completed", "task-active"],
        },
      },
    };
    const request = createRequest([sharedMessage]);
    const backend = createOpenClawReferenceBackend();
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });
    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: ["fixture-canonical"],
      type: "remove",
    });

    const validation = await backend.validate({ snapshot, plan });

    assert.deepEqual(validation.applicableOperationIds, []);
    assert.match(validation.reasons[0] ?? "", /shared by multiple tasks/);
  },
);

test(
  "uses the mutation operation to constrain task and replacement semantics",
  async () => {
    const completed = readFixture("canonical-message.json");
    const unrelated = {
      ...readFixture("canonical-message.json"),
      messageId: "fixture-unrelated",
      content: "unrelated task must remain",
      details: {
        contextSafe: {
          taskIds: ["task-unrelated"],
        },
      },
    };
    const request = createRequest([completed, unrelated]);
    const calls: Array<{
      taskIds?: string[];
      annotateTaskAnchors?: boolean;
      replacementMode?: string;
    }> = [];
    const backend = createOpenClawReferenceBackend({
      rewriteCanonicalState: async (params) => {
        calls.push({
          taskIds: params.evictionTaskIds,
          annotateTaskAnchors: params.annotateTaskAnchors,
          replacementMode: params.evictionReplacementMode,
        });
        return {
          state: {
            ...params.state,
            messages: params.state.messages.filter(
              (message) => !taskIdsFor(message).includes("task-completed"),
            ),
            updatedAt: "2026-07-30T00:01:00.000Z",
          },
          changed: true,
          appliedEvictionTaskIds: ["task-completed"],
        };
      },
    });
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });
    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: ["fixture-canonical"],
      type: "remove",
    });

    const applied = await backend.apply({ snapshot, plan, request });

    assert.deepEqual(calls, [{
      taskIds: ["task-completed"],
      annotateTaskAnchors: false,
      replacementMode: "drop",
    }]);
    assert.equal(applied.result.applied, true);
    assert.deepEqual(
      applied.request.state.messages.map((message) => message.messageId),
      ["fixture-unrelated"],
    );
    assert.equal(applied.result.details?.replacementMode, "drop");
  },
);

test(
  "applies only the task requested by the plan when the registry has other candidates",
  async (context) => {
    const stateDir = await mkdtemp(
      path.join(os.tmpdir(), "openclaw-reference-backend-"),
    );
    context.after(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    const registry = createEmptySessionTaskRegistry("session-1");
    registry.evictableTaskIds = ["task-completed", "task-unrelated"];
    await persistSessionTaskRegistry(stateDir, registry);

    const request = createRequest([
      readFixture("canonical-message.json"),
      {
        ...readFixture("canonical-message.json"),
        messageId: "fixture-unrelated",
        content: "unrelated evictable task must remain",
        details: {
          contextSafe: {
            taskIds: ["task-unrelated"],
          },
        },
      },
    ], stateDir);
    const backend = createOpenClawReferenceBackend();
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });
    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: ["fixture-canonical"],
      type: "remove",
    });

    const applied = await backend.apply({ snapshot, plan, request });

    assert.equal(applied.result.applied, true);
    assert.deepEqual(
      applied.result.details?.appliedTaskIds,
      ["task-completed"],
    );
    assert.deepEqual(
      applied.request.state.messages.map((message) => message.messageId),
      ["fixture-unrelated"],
    );
  },
);

test(
  "rejects a stale request after the plan snapshot was created",
  async () => {
    const request = createRequest([
      readFixture("canonical-message.json"),
    ]);
    let rewriteCalls = 0;
    const backend = createOpenClawReferenceBackend({
      rewriteCanonicalState: async (params) => {
        rewriteCalls += 1;
        return {
          state: params.state,
          changed: false,
          appliedEvictionTaskIds: [],
        };
      },
    });
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });
    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: ["fixture-canonical"],
    });
    request.state.messages.push({
      messageId: "new-message",
      role: "user",
      content: "new request state",
      details: { contextSafe: { taskIds: ["task-active"] } },
    });

    const applied = await backend.apply({ snapshot, plan, request });

    assert.equal(rewriteCalls, 0);
    assert.equal(applied.result.applied, false);
    assert.equal(applied.result.changed, false);
  },
);

test(
  "falls back when canonical rewrite changes messages outside the operation",
  async () => {
    const request = createRequest([
      readFixture("canonical-message.json"),
      {
        ...readFixture("canonical-message.json"),
        messageId: "fixture-unrelated",
        content: "unrelated task must remain",
        details: {
          contextSafe: {
            taskIds: ["task-unrelated"],
          },
        },
      },
    ]);
    const backend = createOpenClawReferenceBackend({
      rewriteCanonicalState: async (params) => ({
        state: {
          ...params.state,
          messages: [readFixture("pointer-stub.json")],
          updatedAt: "2026-07-30T00:01:00.000Z",
        },
        changed: true,
        appliedEvictionTaskIds: ["task-completed"],
      }),
    });
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });
    const plan = createPlan({
      snapshotRevision: snapshot.revision,
      targetItemIds: ["fixture-canonical"],
    });

    const applied = await backend.apply({ snapshot, plan, request });

    assert.equal(applied.request, request);
    assert.equal(applied.result.applied, false);
    assert.equal(applied.result.changed, false);
    assert.equal(applied.result.fallbackUsed, true);
  },
);

test(
  "clones canonical state stored in snapshot metadata",
  async () => {
    const request = createRequest([
      readFixture("canonical-message.json"),
    ]);
    const backend = createOpenClawReferenceBackend();
    const snapshot = await backend.readSnapshot({
      sessionId: request.sessionId,
      request,
    });

    request.state.messages[0].content = "mutated after snapshot";

    assert.equal(
      snapshot.adapterMetadata?.canonicalState.messages[0].content,
      "completed canonical task input",
    );
  },
);

test(
  "keeps synthetic item identity stable across volatile metadata changes",
  async () => {
    const backend = createOpenClawReferenceBackend();
    const firstRequest = createRequest([{
      role: "assistant",
      content: "stable semantic content",
      details: {
        observedAt: "2026-07-30T00:00:00.000Z",
        contextSafe: { taskIds: ["task-completed"] },
      },
    }]);
    const secondRequest = createRequest([{
      role: "assistant",
      content: "stable semantic content",
      details: {
        observedAt: "2026-07-30T00:05:00.000Z",
        contextSafe: { taskIds: ["task-completed"] },
      },
    }]);

    const first = await backend.readSnapshot({
      sessionId: firstRequest.sessionId,
      request: firstRequest,
    });
    const second = await backend.readSnapshot({
      sessionId: secondRequest.sessionId,
      request: secondRequest,
    });

    assert.equal(first.items[0]?.stableId, second.items[0]?.stableId);
    assert.equal(first.items[0]?.fingerprint, second.items[0]?.fingerprint);
  },
);
