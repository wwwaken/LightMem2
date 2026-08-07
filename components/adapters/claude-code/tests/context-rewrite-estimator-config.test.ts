import assert from "node:assert/strict";
import test from "node:test";
import { resolveClaudeTaskStateEstimator } from "../src/context-rewrite/estimator-config.js";

test("returns an estimator when enabled and fully configured via config", () => {
  const estimator = resolveClaudeTaskStateEstimator({
    config: { enabled: true, baseUrl: "https://api.example.com", apiKey: "sk-x", model: "m1" },
    env: {},
  });
  assert.ok(estimator);
  assert.equal(typeof estimator!.estimate, "function");
});

test("returns undefined when not enabled", () => {
  const estimator = resolveClaudeTaskStateEstimator({
    config: { enabled: false, baseUrl: "https://api.example.com", apiKey: "sk-x", model: "m1" },
    env: {},
  });
  assert.equal(estimator, undefined);
});

test("returns undefined when enabled but missing apiKey", () => {
  const estimator = resolveClaudeTaskStateEstimator({
    config: { enabled: true, baseUrl: "https://api.example.com", model: "m1" },
    env: {},
  });
  assert.equal(estimator, undefined);
});

test("assembles from env when config is absent", () => {
  const estimator = resolveClaudeTaskStateEstimator({
    env: {
      LIGHTMEM2_TASK_STATE_ESTIMATOR_ENABLED: "true",
      LIGHTMEM2_TASK_STATE_ESTIMATOR_BASE_URL: "https://api.example.com",
      LIGHTMEM2_TASK_STATE_ESTIMATOR_API_KEY: "sk-env",
      LIGHTMEM2_TASK_STATE_ESTIMATOR_MODEL: "m-env",
    },
  });
  assert.ok(estimator);
});

test("falls back to TOKENPILOT_ env names", () => {
  const estimator = resolveClaudeTaskStateEstimator({
    env: {
      TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED: "1",
      TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL: "https://api.example.com",
      TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY: "sk-tp",
      TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL: "m-tp",
    },
  });
  assert.ok(estimator);
});

test("explicit config wins over env", () => {
  // env disables, config enables + configures → config wins → estimator built
  const estimator = resolveClaudeTaskStateEstimator({
    config: { enabled: true, baseUrl: "https://cfg.example.com", apiKey: "sk-cfg", model: "m-cfg" },
    env: { LIGHTMEM2_TASK_STATE_ESTIMATOR_ENABLED: "false" },
  });
  assert.ok(estimator);
});

test("disabled by default when nothing is set", () => {
  const estimator = resolveClaudeTaskStateEstimator({ env: {} });
  assert.equal(estimator, undefined);
});
