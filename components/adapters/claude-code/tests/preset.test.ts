import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CODE_TOKENPILOT_HOST_BINDING } from "../src/preset.js";

test("Claude Code declares every TokenPilot feature its runtime supports", () => {
  assert.equal(CLAUDE_CODE_TOKENPILOT_HOST_BINDING.presetId, "tokenpilot");
  assert.deepEqual(
    CLAUDE_CODE_TOKENPILOT_HOST_BINDING.supportedFeatures,
    ["stabilizer", "reduction", "eviction"],
  );
});
