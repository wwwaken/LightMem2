/**
 * Encode the (possibly overlay-rewritten) envelope for upstream forwarding, or —
 * if encoding throws — bypass overlay/reduction entirely and forward the
 * original request body untouched. A rewriting/encoding failure must never drop
 * the request: we degrade to the raw body rather than failing the call.
 *
 * Returns the payload to forward plus a `bypassed` flag so the caller can record
 * the bypass reason in traces.
 */
export function encodeRequestOrBypass<Envelope>(params: {
  codec: { encodeRequest(envelope: Envelope): unknown };
  envelope: Envelope;
  rawBody: string;
}): { payload: unknown; bypassed: boolean } {
  try {
    return { payload: params.codec.encodeRequest(params.envelope), bypassed: false };
  } catch {
    return { payload: JSON.parse(params.rawBody) as unknown, bypassed: true };
  }
}
