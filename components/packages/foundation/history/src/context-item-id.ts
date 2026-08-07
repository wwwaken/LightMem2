import { createHash } from "node:crypto";

export const CONTEXT_ITEM_ID_ALGORITHM_VERSION = 1 as const;

export type ContextItemIdentitySource =
  | "native_item_id"
  | "call_id"
  | "synthetic";

export type ContextItemIdentityInput = {
  sessionId: string;
  kind: string;
  role?: string;
  nativeItemId?: string;
  callId?: string;
  content: unknown;
  /** Occurrence among synthetic items with the same session and fingerprint. */
  occurrence?: number;
  /** @deprecated Use occurrence. This value is interpreted as an occurrence. */
  ordinal?: number;
};

export type ContextItemIdentitySeed = Omit<
  ContextItemIdentityInput,
  "occurrence" | "ordinal"
>;

export type ContextItemFingerprintInput = Pick<
  ContextItemIdentityInput,
  "kind" | "role" | "content"
>;

export type ContextItemIdentity = {
  stableId: string;
  fingerprint: string;
  source: ContextItemIdentitySource;
};

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("context item content must contain finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("context item content must be JSON-compatible");
  }
  if (ancestors.has(value)) throw new TypeError("context item content must not contain cycles");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => canonicalJson(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("context item content must contain plain objects");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("context item content must not contain symbol keys");
    }

    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function requiredIdentityPart(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must not be empty`);
  return normalized;
}

function optionalIdentityPart(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function syntheticOccurrence(input: ContextItemIdentityInput): number {
  if (
    input.occurrence !== undefined
    && input.ordinal !== undefined
    && input.occurrence !== input.ordinal
  ) {
    throw new TypeError("occurrence and deprecated ordinal must match");
  }
  const occurrence = input.occurrence ?? input.ordinal;
  if (
    typeof occurrence !== "number"
    || !Number.isSafeInteger(occurrence)
    || occurrence < 0
  ) {
    throw new TypeError("occurrence must be a non-negative safe integer");
  }
  return occurrence;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(normalizeContextItemContent(value))
    .digest("hex");
}

export function normalizeContextItemContent(content: unknown): string {
  return canonicalJson(content, new Set<object>());
}

export function createContextItemFingerprint(
  input: ContextItemFingerprintInput,
): string {
  const kind = requiredIdentityPart(input.kind, "kind").toLowerCase();
  const role = optionalIdentityPart(input.role)?.toLowerCase();
  const digest = sha256({
    algorithmVersion: CONTEXT_ITEM_ID_ALGORITHM_VERSION,
    content: normalizeContextItemContent(input.content),
    kind,
    role: role ?? null,
  });
  return `ctxfp-v${CONTEXT_ITEM_ID_ALGORITHM_VERSION}-${digest}`;
}

export function createContextItemIdentity(
  input: ContextItemIdentityInput,
): ContextItemIdentity {
  const sessionId = requiredIdentityPart(input.sessionId, "sessionId");
  const kind = requiredIdentityPart(input.kind, "kind").toLowerCase();
  const role = optionalIdentityPart(input.role)?.toLowerCase();
  const nativeItemId = optionalIdentityPart(input.nativeItemId);
  const callId = optionalIdentityPart(input.callId);
  const fingerprint = createContextItemFingerprint({
    kind,
    role,
    content: input.content,
  });

  let source: ContextItemIdentitySource;
  let identityValue: string | number;
  if (nativeItemId) {
    source = "native_item_id";
    identityValue = nativeItemId;
  } else if (callId) {
    source = "call_id";
    identityValue = callId;
  } else {
    source = "synthetic";
    identityValue = syntheticOccurrence(input);
  }

  const digest = sha256({
    algorithmVersion: CONTEXT_ITEM_ID_ALGORITHM_VERSION,
    fingerprint: source === "synthetic" ? fingerprint : null,
    identityValue,
    kind,
    sessionId,
    source,
  });
  return {
    stableId: `ctx-v${CONTEXT_ITEM_ID_ALGORITHM_VERSION}-${digest}`,
    fingerprint,
    source,
  };
}

export function createStableContextItemId(
  input: ContextItemIdentityInput,
): string {
  return createContextItemIdentity(input).stableId;
}

/**
 * Builds identities in transcript order while keeping synthetic IDs stable
 * when unrelated items are inserted before them.
 */
export function createContextItemIdentities(
  inputs: readonly ContextItemIdentitySeed[],
): ContextItemIdentity[] {
  const occurrencesByFingerprint = new Map<string, number>();
  return inputs.map((input) => {
    const fingerprint = createContextItemFingerprint(input);
    if (optionalIdentityPart(input.nativeItemId) || optionalIdentityPart(input.callId)) {
      return createContextItemIdentity(input);
    }
    const occurrenceKey = normalizeContextItemContent([
      requiredIdentityPart(input.sessionId, "sessionId"),
      fingerprint,
    ]);
    const occurrence = occurrencesByFingerprint.get(occurrenceKey) ?? 0;
    occurrencesByFingerprint.set(occurrenceKey, occurrence + 1);
    return createContextItemIdentity({
      ...input,
      occurrence,
    });
  });
}
