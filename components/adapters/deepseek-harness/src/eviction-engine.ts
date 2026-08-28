/**
 * Eviction pre-step orchestration (Task-R5 landing point).
 *
 * Registers on DSH's `agent/pre-step` waterfall. On each model step it reads
 * the current session's durable log, builds the LightRSI estimator input via
 * the codec, and (once R3/R4 land) runs the estimator + applies a canonical
 * surface replacement. This unit wires the ORCHESTRATION and the fail-open
 * contract; the estimator call and the actual eviction apply are explicit
 * seams below — until they land, the handler is a safe no-op that always
 * defers to `next()`.
 *
 * Fail-open is the whole safety story here (§4.3): optimization failure must
 * never block the agent. Every non-cancellation error is logged with a
 * structured reason and the handler returns `next()`, leaving the surface
 * untouched. There is no HTTP-style "resend original request" — the correct
 * fail-open is "no surface mutation + call next()".
 */

import {
  buildDshDeltaView,
  buildDshRawSemanticSnapshot,
  computeDshSnapshotRevision,
} from "./session-codec.js";
import { createDshTaskStateEstimator } from "./lifecycle-estimator.js";
import type { TokenPilotDshConfig } from "./config.js";
import type {
  DshLogEvent,
  DshLogEventWithMeta,
  DshPluginContext,
  DshPreStepDecision,
  DshPreStepNext,
  DshPreStepPayload,
  DshSession,
} from "./types.js";

/** Event-type keys the codec understands (kept in sync with session-codec). */
const RECOGNIZED_TYPES = new Set<string>([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
]);

type SkipReason =
  | "disabled"
  | "aborted"
  | "empty-log"
  | "unrecognized-required-event"
  | "no-candidates"
  | "estimator-not-configured"
  | "estimator-not-wired"
  | "error";

function log(config: TokenPilotDshConfig, reason: SkipReason, detail?: unknown): void {
  if (config.logLevel === "debug") {
    // Structured, side-effect-only diagnostic; never throws.
    console.debug?.("[tokenpilot:dsh] pre-step defer", { reason, detail });
  }
}

/**
 * DSH's log protocol: an unrecognized event without `ignorable: true` may
 * change how the rest of the log is interpreted, so a reader must not silently
 * drop it (SessionEvent doc, core/session/src/types.ts). For eviction that
 * means: if the log contains an unrecognized, non-ignorable event, we do NOT
 * trust a snapshot that silently omitted it — we bail and defer.
 */
function hasUnrecognizedRequiredEvent(events: readonly DshLogEventWithMeta[]): boolean {
  for (const event of events) {
    if (!RECOGNIZED_TYPES.has(event.type) && event.ignorable !== true) return true;
  }
  return false;
}

/** Build the stable-revision descriptor from the live session (§4.1). */
function describeSurface(session: DshSession) {
  const seqs = session.events.map((event) => event.seq);
  return {
    sessionId: session.id,
    lastEventSeq: seqs.length > 0 ? seqs[seqs.length - 1] : 0,
    surfaceReplaceGeneration: session.surface.replaceGeneration,
    orderedSurfaceNodeSeqs: [...session.surface.nodes],
  };
}

/**
 * Register the TokenPilot eviction handler on `agent/pre-step`. Returns void;
 * the plugin entry (index.ts) calls this after config normalization.
 */
export function registerEvictionPreStep(ctx: DshPluginContext, config: TokenPilotDshConfig): void {
  // Constructed once: undefined when the estimator is disabled or missing creds.
  const estimator = createDshTaskStateEstimator(config.taskStateEstimator);

  ctx.on("agent/pre-step", async (payload: DshPreStepPayload, next: DshPreStepNext): Promise<DshPreStepDecision> => {
    // Master flag or per-module flag off: no-op, defer.
    if (!config.enabled || !config.eviction.enabled) {
      log(config, "disabled");
      return next();
    }

    try {
      if (payload.signal.aborted) {
        log(config, "aborted");
        return next();
      }

      const session = payload.agent.session;
      const events = session.events;
      if (events.length === 0) {
        log(config, "empty-log");
        return next();
      }

      if (hasUnrecognizedRequiredEvent(events)) {
        // Conservative: an unrecognized required event means the snapshot can't
        // be trusted for removal decisions. Defer rather than risk it (R3).
        log(config, "unrecognized-required-event");
        return next();
      }

      // Codec: durable events -> raw semantic snapshot -> estimator delta.
      const logEvents: readonly DshLogEvent[] = events;
      const snapshot = buildDshRawSemanticSnapshot(session.id, logEvents, {
        surfaceEventSeqs: session.surface.nodes,
      });
      const revision = computeDshSnapshotRevision(describeSurface(session));
      const delta = buildDshDeltaView(snapshot, { fromTurnSeqExclusive: 0 });
      void revision;
      void delta;

      if (!estimator) {
        // Enabled but no endpoint/credentials: nothing to run against. Defer.
        log(config, "estimator-not-configured");
        return next();
      }

      // ---- SEAM (R3/R4): estimator + safety filter + canonical replacement ----
      // The estimator is ready (`runTaskStateEstimate(estimator, { registry, delta })`).
      // Wiring the estimate call is deferred to R4, because acting on its output
      // needs the registry source + the surface-transaction apply path:
      //   1. load registry -> input = { registry, delta }; run the estimator
      //   2. filter candidates through the independent safety policy (R3)
      //   3. re-read surface; if `revision` changed, defer the whole batch
      //   4. append eviction/start -> replacement events -> eviction/applied/end (R4)
      //   5. re-meter via ctx.tokenMeter.measure(session)
      // Until then, we never mutate the surface: defer.
      log(config, "estimator-not-wired");
      return next();
    } catch (error) {
      // Fail-open: any non-cancellation error leaves the surface untouched.
      log(config, "error", error);
      return next();
    }
  });
}
