import { createApiTaskStateEstimator, type TaskStateEstimator } from "@lightmem2/eviction";

// Read an env var by primary name, falling back to a secondary (TOKENPILOT_) name,
// mirroring OpenClaw's config-normalize convention.
function envValue(env: NodeJS.ProcessEnv, primary: string, fallback: string): string {
  const raw = env[primary] ?? env[fallback] ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

function isTruthy(value: string): boolean {
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type ClaudeEstimatorConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requestTimeoutMs?: number;
};

/**
 * Assemble the Claude-side task-state estimator from explicit config (wins) or
 * environment variables (fallback), mirroring OpenClaw's assembly pattern but
 * only for the fields the Claude generic path needs (no TokenPilot lifecycle /
 * evidence / promotion knobs). Returns undefined — meaning "semantic path off" —
 * when the estimator is not enabled or is not fully configured
 * (baseUrl + apiKey + model all required). Never throws: a missing/partial
 * config yields undefined, not an error, so callers can simply skip semantics.
 *
 * env is injectable for testing; it defaults to process.env.
 */
export function resolveClaudeTaskStateEstimator(params?: {
  config?: ClaudeEstimatorConfig;
  env?: NodeJS.ProcessEnv;
}): TaskStateEstimator | undefined {
  const config = params?.config ?? {};
  const env = params?.env ?? process.env;

  const enabled =
    config.enabled ?? isTruthy(envValue(env, "LIGHTMEM2_TASK_STATE_ESTIMATOR_ENABLED", "TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED"));
  if (!enabled) return undefined;

  const baseUrlRaw =
    config.baseUrl && config.baseUrl.trim().length > 0
      ? config.baseUrl.trim()
      : envValue(env, "LIGHTMEM2_TASK_STATE_ESTIMATOR_BASE_URL", "TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL");
  const baseUrl = baseUrlRaw ? baseUrlRaw.replace(/\/+$/, "") : "";
  const apiKey =
    config.apiKey && config.apiKey.trim().length > 0
      ? config.apiKey.trim()
      : envValue(env, "LIGHTMEM2_TASK_STATE_ESTIMATOR_API_KEY", "TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY");
  const model =
    config.model && config.model.trim().length > 0
      ? config.model.trim()
      : envValue(env, "LIGHTMEM2_TASK_STATE_ESTIMATOR_MODEL", "TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL");

  // Not fully configured → stay off rather than construct a broken estimator
  // (createApiTaskStateEstimator throws without all three).
  if (!baseUrl || !apiKey || !model) return undefined;

  const timeoutRaw = envValue(env, "LIGHTMEM2_TASK_STATE_ESTIMATOR_TIMEOUT_MS", "TOKENPILOT_TASK_STATE_ESTIMATOR_TIMEOUT_MS");
  const parsedTimeout = Number.parseInt(timeoutRaw, 10);
  const requestTimeoutMs =
    config.requestTimeoutMs ?? (Number.isFinite(parsedTimeout) ? Math.max(1000, parsedTimeout) : undefined);

  return createApiTaskStateEstimator({
    baseUrl,
    apiKey,
    model,
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  });
}
