import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  archiveClaudeToolResult,
  recoverClaudeToolResult,
} from "../src/context-rewrite/archive.js";

const SESSION = "sess-archive";

async function tempStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lightmem2-archive-"));
}

test("archives a tool_result and returns an opaque ref + dataKey", async () => {
  const stateDir = await tempStateDir();
  const original = "TOOL_OUTPUT_" + "y".repeat(4000);
  const result = await archiveClaudeToolResult({
    stateDir,
    sessionId: SESSION,
    stableItemId: `${SESSION}:2:0`,
    toolUseId: "toolu_1",
    toolName: "Read",
    originalText: original,
  });
  assert.match(result.archiveRef, /^archive:\/\/claude\/[0-9a-f]{16}$/);
  assert.match(result.dataKey, /^claude_tool_result:[0-9a-f]{16}$/);
  assert.equal(result.originalChars, original.length);
  assert.ok(result.archivePath.length > 0);
});

test("recovers the original content from the archive", async () => {
  const stateDir = await tempStateDir();
  const original = "RECOVER_ME_" + "z".repeat(3000);
  const result = await archiveClaudeToolResult({
    stateDir,
    sessionId: SESSION,
    stableItemId: `${SESSION}:2:0`,
    toolUseId: "toolu_1",
    originalText: original,
  });
  const recovered = await recoverClaudeToolResult(result.archivePath);
  assert.equal(recovered, original);
});

test("identical content yields the same digest-based ref (stable dataKey)", async () => {
  const stateDir = await tempStateDir();
  const original = "SAME_CONTENT_" + "q".repeat(2000);
  const a = await archiveClaudeToolResult({
    stateDir, sessionId: SESSION, stableItemId: `${SESSION}:2:0`, toolUseId: "toolu_1", originalText: original,
  });
  const b = await archiveClaudeToolResult({
    stateDir, sessionId: SESSION, stableItemId: `${SESSION}:5:0`, toolUseId: "toolu_2", originalText: original,
  });
  assert.equal(a.archiveRef, b.archiveRef);
  assert.equal(a.dataKey, b.dataKey);
});

test("recoverClaudeToolResult returns undefined for a missing archive", async () => {
  const stateDir = await tempStateDir();
  const recovered = await recoverClaudeToolResult(join(stateDir, "nonexistent", "archive.json"));
  assert.equal(recovered, undefined);
});
