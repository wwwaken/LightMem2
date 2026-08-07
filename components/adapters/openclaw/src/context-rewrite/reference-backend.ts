import { createHash } from "node:crypto";

import {
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  type ContextItemKind,
  type ContextItemRef,
  type ContextMutationOperation,
  type ContextMutationPlan,
  type ContextRewriteResult,
  type ContextRewriteValidation,
  type ModelContextRewriteBackend,
  type ModelContextSnapshot,
} from "@lightmem2/host-adapter";
import { estimateMessagesChars, type CanonicalTranscriptState } from "@lightmem2/history";

import { rewriteCanonicalState } from "../context-stack/page-out/canonical-rewrite-adapter.js";

const OPENCLAW_HOST_ID = "openclaw";

type CanonicalRewriteRequest = Parameters<typeof rewriteCanonicalState>[0];

export type OpenClawReferenceBackendRequest = CanonicalRewriteRequest;

export type OpenClawReferenceBackendMetadata = {
  canonicalState: CanonicalTranscriptState;
};

export type OpenClawReferenceBackendDetails = {
  appliedTaskIds: string[];
  beforeMessageCount: number;
  afterMessageCount: number;
  replacementMode: "pointer_stub" | "drop" | "mixed";
};

type OpenClawReferenceBackend = ModelContextRewriteBackend<
  OpenClawReferenceBackendRequest,
  OpenClawReferenceBackendMetadata,
  never,
  OpenClawReferenceBackendDetails
>;

type ReferenceBackendDependencies = {
  rewriteCanonicalState: typeof rewriteCanonicalState;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function contentBlocks(
  message: Record<string, unknown>,
): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content
        .map(asRecord)
        .filter(
          (block): block is Record<string, unknown> => block !== undefined,
        )
    : [];
}

function normalizedType(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
}

type ProtocolRef = {
  callId: string;
  kind: "call" | "result";
};

function messageProtocolRefs(
  message: Record<string, unknown>,
): ProtocolRef[] {
  const refs: ProtocolRef[] = [];
  const callTypes = new Set([
    "toolcall",
    "tool_call",
    "tool_use",
    "function_call",
    "custom_tool_call",
  ]);
  const resultTypes = new Set([
    "tool_result",
    "tool_call_output",
    "function_call_output",
    "custom_tool_call_output",
  ]);
  const topLevelType = normalizedType(message.type);

  if (callTypes.has(topLevelType)) {
    const callId =
      stringValue(message.id)
      ?? stringValue(message.call_id)
      ?? stringValue(message.tool_call_id);
    if (callId) refs.push({ callId, kind: "call" });
  }

  for (const rawCall of Array.isArray(message.tool_calls)
    ? message.tool_calls
    : []) {
    const call = asRecord(rawCall);
    const callId = stringValue(call?.id) ?? stringValue(call?.call_id);
    if (callId) refs.push({ callId, kind: "call" });
  }

  for (const block of contentBlocks(message)) {
    const type = normalizedType(block.type);
    if (callTypes.has(type)) {
      const callId =
        stringValue(block.id)
        ?? stringValue(block.call_id)
        ?? stringValue(block.tool_call_id);
      if (callId) refs.push({ callId, kind: "call" });
      continue;
    }
    if (resultTypes.has(type)) {
      const callId =
        stringValue(block.tool_use_id)
        ?? stringValue(block.call_id)
        ?? stringValue(block.tool_call_id)
        ?? stringValue(block.id);
      if (callId) refs.push({ callId, kind: "result" });
    }
  }

  const directResultId =
    stringValue(message.tool_call_id)
    ?? stringValue(message.toolCallId);
  const role = normalizedType(message.role);
  if (
    directResultId
    && (
      role === "tool"
      || role === "toolresult"
      || role === "tool_result"
      || resultTypes.has(topLevelType)
    )
  ) {
    refs.push({ callId: directResultId, kind: "result" });
  }

  return refs;
}

function messageTaskIds(
  message: Record<string, unknown>,
  request: OpenClawReferenceBackendRequest,
): string[] | undefined {
  const fromHelper = request.helpers.canonicalMessageTaskIds(message);
  const direct = Array.isArray(message.taskIds)
    ? message.taskIds.filter(
        (value): value is string => stringValue(value) !== undefined,
      )
    : [];

  const taskIds = [
    ...new Set(
      [...fromHelper, ...direct]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];

  return taskIds.length > 0 ? taskIds : undefined;
}

function isPointerStub(message: Record<string, unknown>): boolean {
  const details = asRecord(message.details);
  const contextSafe = asRecord(details?.contextSafe);
  const eviction = asRecord(contextSafe?.eviction);

  return eviction?.kind === "cached_pointer_stub";
}

function messageKind(
  message: Record<string, unknown>,
  request: OpenClawReferenceBackendRequest,
): ContextItemKind {
  if (isPointerStub(message)) return "compaction";

  const role = String(message.role ?? "").trim().toLowerCase();
  const type = normalizedType(message.type);
  const blockTypes = contentBlocks(message).map((block) =>
    normalizedType(block.type),
  );

  if (
    request.helpers.isToolResultLikeMessage(message)
    || role === "tool"
    || role === "toolresult"
    || type === "tool_result"
    || type === "toolresult"
    || type === "function_call_output"
    || type === "custom_tool_call_output"
    || blockTypes.includes("tool_result")
  ) {
    return "tool_result";
  }

  if (
    type === "tool_call"
    || type === "function_call"
    || type === "custom_tool_call"
    || Array.isArray(message.tool_calls)
    || blockTypes.some((blockType) =>
      [
        "toolcall",
        "tool_call",
        "tool_use",
        "function_call",
        "custom_tool_call",
      ].includes(blockType),
    )
  ) {
    return "tool_call";
  }

  if (role === "system") return "system";
  if (role === "developer") return "developer";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "reasoning" || type === "reasoning") return "reasoning";
  if (type === "compaction") return "compaction";

  return "unknown";
}

function explicitMessageId(
  message: Record<string, unknown>,
): string | undefined {
  return (
    stringValue(message.messageId)
    ?? stringValue(message.message_id)
    ?? stringValue(message.id)
  );
}

function messageFingerprint(message: Record<string, unknown>): string {
  return hash({
    role: message.role,
    type: message.type,
    content: message.content,
    name: message.name,
    toolName: message.toolName ?? message.tool_name,
    toolCallId: message.toolCallId ?? message.tool_call_id,
    toolCalls: message.tool_calls,
    arguments: message.arguments,
    input: message.input,
    output: message.output,
    stopReason: message.stopReason ?? message.stop_reason,
  });
}

function buildItems(
  request: OpenClawReferenceBackendRequest,
): ContextItemRef[] {
  const fingerprintOccurrences = new Map<string, number>();
  const stableIdOccurrences = new Map<string, number>();

  return request.state.messages.map((rawMessage) => {
    const message = asRecord(rawMessage) ?? {};
    const fingerprint = messageFingerprint(message);
    const kind = messageKind(message, request);
    const occurrence = fingerprintOccurrences.get(fingerprint) ?? 0;

    fingerprintOccurrences.set(fingerprint, occurrence + 1);

    const stableIdBase =
      explicitMessageId(message)
      ?? `openclaw:${fingerprint.slice(0, 24)}:${occurrence}`;
    const stableIdOccurrence = stableIdOccurrences.get(stableIdBase) ?? 0;
    const stableId = stableIdOccurrence === 0
      ? stableIdBase
      : `${stableIdBase}:${stableIdOccurrence}`;
    stableIdOccurrences.set(stableIdBase, stableIdOccurrence + 1);
    const role = stringValue(message.role);
    const callIds = [
      ...new Set(
        messageProtocolRefs(message).map((ref) => ref.callId),
      ),
    ];
    const callId = callIds.length === 1 ? callIds[0] : undefined;
    const taskIds = messageTaskIds(message, request);

    return {
      stableId,
      kind,
      ...(role ? { role } : {}),
      ...(callId && (kind === "tool_call" || kind === "tool_result")
        ? { callId }
        : {}),
      ...(taskIds ? { taskIds } : {}),
      fingerprint,
      chars: request.helpers.contentToText(
        message.content ?? "",
      ).length,
    };
  });
}

function revisionFor(state: CanonicalTranscriptState): string {
  return hash({
    version: state.version,
    sessionId: state.sessionId,
    messages: state.messages,
  });
}

function snapshotFor(
  sessionId: string,
  request: OpenClawReferenceBackendRequest,
): ModelContextSnapshot<OpenClawReferenceBackendMetadata> {
  if (
    request.sessionId !== sessionId
    || request.state.sessionId !== sessionId
  ) {
    throw new Error(`OpenClaw session mismatch: expected ${sessionId}`);
  }

  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    hostId: OPENCLAW_HOST_ID,
    sessionId,
    revision: revisionFor(request.state),
    items: buildItems(request),
    adapterMetadata: {
      canonicalState: structuredClone(request.state),
    },
  };
}

function normalizedUniqueStrings(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? [])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size
    && [...left].every((value) => right.has(value));
}

function operationTaskId(
  operation: ContextMutationOperation,
): string | undefined {
  const taskIds = normalizedUniqueStrings(operation.taskIds);
  return taskIds.length === 1 ? taskIds[0] : undefined;
}

function protocolItemsByCallId(
  snapshot: ModelContextSnapshot<OpenClawReferenceBackendMetadata>,
): Map<string, { callItemIds: string[]; resultItemIds: string[] }> {
  const protocol = new Map<
    string,
    { callItemIds: string[]; resultItemIds: string[] }
  >();
  const messages = snapshot.adapterMetadata?.canonicalState.messages ?? [];

  messages.forEach((rawMessage, index) => {
    const itemId = snapshot.items[index]?.stableId;
    const message = asRecord(rawMessage);
    if (!itemId || !message) return;

    for (const ref of messageProtocolRefs(message)) {
      const bucket = protocol.get(ref.callId) ?? {
        callItemIds: [],
        resultItemIds: [],
      };
      if (ref.kind === "call") {
        bucket.callItemIds.push(itemId);
      } else {
        bucket.resultItemIds.push(itemId);
      }
      protocol.set(ref.callId, bucket);
    }
  });

  return protocol;
}

function rewriteStayedWithinOperation(params: {
  beforeSnapshot: ModelContextSnapshot<OpenClawReferenceBackendMetadata>;
  afterRequest: OpenClawReferenceBackendRequest;
  operation: ContextMutationOperation;
  taskId: string;
  replacementMode: "pointer_stub" | "drop";
}): boolean {
  const targetIds = new Set(params.operation.targetItemIds);
  const protectedMessageCounts = new Map<string, number>();
  const beforeMessages =
    params.beforeSnapshot.adapterMetadata?.canonicalState.messages ?? [];

  beforeMessages.forEach((message, index) => {
    const itemId = params.beforeSnapshot.items[index]?.stableId;
    if (!itemId || targetIds.has(itemId)) return;
    const fingerprint = hash(message);
    protectedMessageCounts.set(
      fingerprint,
      (protectedMessageCounts.get(fingerprint) ?? 0) + 1,
    );
  });

  const unmatchedMessages: Record<string, unknown>[] = [];
  for (const rawMessage of params.afterRequest.state.messages) {
    const message = asRecord(rawMessage);
    if (!message) return false;
    const fingerprint = hash(message);
    const remaining = protectedMessageCounts.get(fingerprint) ?? 0;
    if (remaining > 0) {
      protectedMessageCounts.set(fingerprint, remaining - 1);
      continue;
    }
    unmatchedMessages.push(message);
  }

  if (
    [...protectedMessageCounts.values()].some((remaining) => remaining > 0)
  ) {
    return false;
  }

  if (params.replacementMode === "drop") {
    return unmatchedMessages.length === 0;
  }

  return unmatchedMessages.length === 1
    && isPointerStub(unmatchedMessages[0]!)
    && messageTaskIds(unmatchedMessages[0]!, params.afterRequest)
      ?.includes(params.taskId) === true;
}

function unchangedResult(params: {
  snapshot: ModelContextSnapshot<OpenClawReferenceBackendMetadata>;
  plan: ContextMutationPlan;
  validation: ContextRewriteValidation;
  fallbackUsed?: boolean;
}): ContextRewriteResult<OpenClawReferenceBackendDetails> {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    mode: "canonical",
    planId: params.plan.planId,
    applied: false,
    changed: false,
    previousRevision: params.snapshot.revision,
    nextRevision: params.snapshot.revision,
    appliedOperationIds: [],
    deferredOperationIds: params.validation.deferredOperationIds,
    removedItemIds: [],
    savedChars: 0,
    fallbackUsed: params.fallbackUsed === true,
  };
}

export function createOpenClawReferenceBackend(
  dependencies: Partial<ReferenceBackendDependencies> = {},
): OpenClawReferenceBackend {
  const rewrite =
    dependencies.rewriteCanonicalState ?? rewriteCanonicalState;

  return {
    hostId: OPENCLAW_HOST_ID,
    mode: "canonical",

    async readSnapshot({ sessionId, request }) {
      return snapshotFor(sessionId, request);
    },

    async validate({ snapshot, plan }) {
      const fatalReasons: string[] = [];
      const reasons: string[] = [];
      const deferredOperationIds: string[] = [];
      const applicableOperationIds: string[] = [];

      if (
        plan.schemaVersion
        !== MODEL_CONTEXT_REWRITE_SCHEMA_VERSION
      ) {
        fatalReasons.push(
          `unsupported schema version: ${plan.schemaVersion}`,
        );
      }

      if (
        snapshot.hostId !== OPENCLAW_HOST_ID
        || plan.hostId !== OPENCLAW_HOST_ID
      ) {
        fatalReasons.push("hostId must be openclaw");
      }

      if (plan.sessionId !== snapshot.sessionId) {
        fatalReasons.push(
          "plan sessionId does not match snapshot",
        );
      }

      if (plan.baseRevision !== snapshot.revision) {
        fatalReasons.push(
          "plan baseRevision does not match snapshot",
        );
      }

      const canonicalState =
        snapshot.adapterMetadata?.canonicalState;
      if (
        !canonicalState
        || canonicalState.sessionId !== snapshot.sessionId
        || canonicalState.messages.length !== snapshot.items.length
      ) {
        fatalReasons.push(
          "snapshot canonical metadata is missing or inconsistent",
        );
      }

      const snapshotItemIds = new Set(
        snapshot.items.map((item) => item.stableId),
      );
      if (snapshotItemIds.size !== snapshot.items.length) {
        fatalReasons.push("snapshot item ids must be unique");
      }

      if (fatalReasons.length > 0) {
        return {
          valid: false,
          applicableOperationIds: [],
          deferredOperationIds: plan.operations.map(
            (operation) => operation.id,
          ),
          reasons: fatalReasons,
        };
      }

      const protocolByCallId = protocolItemsByCallId(snapshot);
      const protocolRefsByItemId = new Map<string, ProtocolRef[]>();
      canonicalState!.messages.forEach((rawMessage, index) => {
        const itemId = snapshot.items[index]?.stableId;
        const message = asRecord(rawMessage);
        if (itemId && message) {
          protocolRefsByItemId.set(
            itemId,
            messageProtocolRefs(message),
          );
        }
      });

      const seenOperationIds = new Set<string>();
      const claimedItemIds = new Set<string>();
      const claimedTaskIds = new Set<string>();

      for (const operation of plan.operations) {
        let deferredReason: string | undefined;
        const targetIds = normalizedUniqueStrings(
          operation.targetItemIds,
        );
        const targetSet = new Set(targetIds);
        const taskId = operationTaskId(operation);

        if (
          !operation.id
          || seenOperationIds.has(operation.id)
        ) {
          deferredReason =
            `duplicate or empty operation id: ${
              operation.id || "<empty>"
            }`;
        } else if (
          targetIds.length === 0
          || targetIds.length !== operation.targetItemIds.length
        ) {
          deferredReason =
            `operation ${operation.id} has empty or duplicate targets`;
        } else if (
          targetIds.some(
            (id) => !snapshotItemIds.has(id),
          )
        ) {
          deferredReason =
            `operation ${operation.id} targets missing items`;
        } else if (!taskId) {
          deferredReason =
            `operation ${operation.id} must target exactly one task`;
        } else if (
          Array.isArray(operation.replacementItems)
          && operation.replacementItems.length > 0
        ) {
          deferredReason =
            `operation ${operation.id} has unsupported native replacements`;
        } else if (
          claimedTaskIds.has(taskId)
          || targetIds.some((id) => claimedItemIds.has(id))
        ) {
          deferredReason =
            `operation ${operation.id} overlaps an earlier operation`;
        } else {
          const taskItems = snapshot.items.filter(
            (item) => item.taskIds?.includes(taskId),
          );
          const expectedTargetIds = new Set(
            taskItems.map((item) => item.stableId),
          );
          if (
            expectedTargetIds.size === 0
            || !setsEqual(targetSet, expectedTargetIds)
          ) {
            deferredReason =
              `operation ${operation.id} must target the complete task bundle`;
          } else if (
            taskItems.some(
              (item) => normalizedUniqueStrings(item.taskIds).some(
                (itemTaskId) => itemTaskId !== taskId,
              ),
            )
          ) {
            deferredReason =
              `operation ${operation.id} targets messages shared by multiple tasks`;
          } else {
            const affectedCallIds = new Set<string>();
            let malformedToolItem = false;
            for (const itemId of targetIds) {
              const item = snapshot.items.find(
                (candidate) => candidate.stableId === itemId,
              );
              const refs = protocolRefsByItemId.get(itemId) ?? [];
              if (
                (item?.kind === "tool_call" || item?.kind === "tool_result")
                && refs.length === 0
              ) {
                malformedToolItem = true;
              }
              for (const ref of refs) affectedCallIds.add(ref.callId);
            }

            const breaksToolClosure = malformedToolItem
              || [...affectedCallIds].some((callId) => {
                const protocol = protocolByCallId.get(callId);
                if (
                  !protocol
                  || protocol.callItemIds.length !== 1
                  || protocol.resultItemIds.length !== 1
                ) {
                  return true;
                }
                return [
                  ...protocol.callItemIds,
                  ...protocol.resultItemIds,
                ].some((itemId) => !targetSet.has(itemId));
              });

            if (breaksToolClosure) {
              deferredReason =
                `operation ${operation.id} would break tool closure`;
            }
          }
        }

        seenOperationIds.add(operation.id);

        if (deferredReason) {
          deferredOperationIds.push(operation.id);
          reasons.push(deferredReason);
        } else {
          applicableOperationIds.push(operation.id);
          claimedTaskIds.add(taskId!);
          for (const targetId of targetIds) {
            claimedItemIds.add(targetId);
          }
        }
      }

      return {
        valid: true,
        applicableOperationIds,
        deferredOperationIds,
        reasons,
      };
    },

    async apply({ snapshot, plan, request }) {
      const validation = await this.validate({
        snapshot,
        plan,
      });

      if (
        !validation.valid
        || validation.applicableOperationIds.length === 0
      ) {
        return {
          request,
          result: unchangedResult({
            snapshot,
            plan,
            validation,
          }),
        };
      }

      let currentSnapshot: ModelContextSnapshot<OpenClawReferenceBackendMetadata>;
      try {
        currentSnapshot = snapshotFor(request.sessionId, request);
      } catch {
        return {
          request,
          result: unchangedResult({
            snapshot,
            plan,
            validation: {
              valid: false,
              applicableOperationIds: [],
              deferredOperationIds: plan.operations.map(
                (operation) => operation.id,
              ),
              reasons: ["request session does not match snapshot"],
            },
          }),
        };
      }

      if (currentSnapshot.revision !== snapshot.revision) {
        return {
          request,
          result: unchangedResult({
            snapshot,
            plan,
            validation: {
              valid: false,
              applicableOperationIds: [],
              deferredOperationIds: plan.operations.map(
                (operation) => operation.id,
              ),
              reasons: ["request revision does not match snapshot"],
            },
          }),
        };
      }

      const beforeChars = estimateMessagesChars(
        request.state.messages,
        request.helpers.contentToText,
      );
      let nextRequest: OpenClawReferenceBackendRequest = {
        ...request,
        state: structuredClone(request.state),
      };
      const applicableSet = new Set(
        validation.applicableOperationIds,
      );
      const appliedOperationIds: string[] = [];
      const appliedTaskIds: string[] = [];
      const deferredOperationIds = [
        ...validation.deferredOperationIds,
      ];
      const appliedReplacementModes = new Set<"pointer_stub" | "drop">();

      try {
        for (const operation of plan.operations) {
          if (!applicableSet.has(operation.id)) continue;

          const taskId = operationTaskId(operation)!;
          const replacementMode = operation.type === "remove"
            ? "drop"
            : "pointer_stub";
          const operationSnapshot = snapshotFor(
            request.sessionId,
            nextRequest,
          );
          const rewritten = await rewrite({
            ...nextRequest,
            evictionEnabled: true,
            evictionTaskIds: [taskId],
            annotateTaskAnchors: false,
            evictionReplacementMode: replacementMode,
          });
          const returnedTaskIds = normalizedUniqueStrings(
            rewritten.appliedEvictionTaskIds,
          );
          const appliedExpectedTask =
            returnedTaskIds.length === 1
            && returnedTaskIds[0] === taskId;
          const rewrittenRequest = {
            ...nextRequest,
            state: rewritten.state,
          };

          if (
            rewritten.changed !== appliedExpectedTask
            || (
              appliedExpectedTask
              && !rewriteStayedWithinOperation({
                beforeSnapshot: operationSnapshot,
                afterRequest: rewrittenRequest,
                operation,
                taskId,
                replacementMode,
              })
            )
          ) {
            return {
              request,
              result: unchangedResult({
                snapshot,
                plan,
                validation: {
                  valid: false,
                  applicableOperationIds: [],
                  deferredOperationIds: plan.operations.map(
                    (candidate) => candidate.id,
                  ),
                  reasons: [
                    `canonical rewrite returned inconsistent evidence for ${operation.id}`,
                  ],
                },
                fallbackUsed: true,
              }),
            };
          }

          if (!appliedExpectedTask) {
            deferredOperationIds.push(operation.id);
            continue;
          }

          nextRequest = {
            ...rewrittenRequest,
          };
          appliedOperationIds.push(operation.id);
          appliedTaskIds.push(taskId);
          appliedReplacementModes.add(replacementMode);
        }
      } catch {
        return {
          request,
          result: unchangedResult({
            snapshot,
            plan,
            validation: {
              valid: false,
              applicableOperationIds: [],
              deferredOperationIds: plan.operations.map(
                (operation) => operation.id,
              ),
              reasons: ["canonical rewrite failed"],
            },
            fallbackUsed: true,
          }),
        };
      }

      const nextSnapshot = snapshotFor(
        request.sessionId,
        nextRequest,
      );
      const nextItemIds = new Set(
        nextSnapshot.items.map((item) => item.stableId),
      );
      const removedItemIds = snapshot.items
        .map((item) => item.stableId)
        .filter((id) => !nextItemIds.has(id));
      const afterChars = estimateMessagesChars(
        nextRequest.state.messages,
        request.helpers.contentToText,
      );
      const replacementMode = appliedReplacementModes.size > 1
        ? "mixed"
        : [...appliedReplacementModes][0]
          ?? (request.evictionReplacementMode === "drop"
            ? "drop"
            : "pointer_stub");

      return {
        request: nextRequest,
        result: {
          schemaVersion:
            MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
          mode: "canonical",
          planId: plan.planId,
          applied: appliedOperationIds.length > 0,
          changed: appliedOperationIds.length > 0,
          previousRevision: snapshot.revision,
          nextRevision: nextSnapshot.revision,
          appliedOperationIds,
          deferredOperationIds,
          removedItemIds,
          savedChars: Math.max(
            0,
            beforeChars - afterChars,
          ),
          fallbackUsed: false,
          details: {
            appliedTaskIds,
            beforeMessageCount:
              request.state.messages.length,
            afterMessageCount:
              nextRequest.state.messages.length,
            replacementMode,
          },
        },
      };
    },
  };
}

export const openClawReferenceBackend =
  createOpenClawReferenceBackend();
