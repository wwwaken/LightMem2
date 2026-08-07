import assert from "node:assert/strict";
import test from "node:test";
import { encodeRequestOrBypass } from "../src/context-rewrite/encode-bypass.js";

test("encodes normally when the codec succeeds", () => {
  const result = encodeRequestOrBypass({
    codec: { encodeRequest: (env) => ({ encoded: env }) },
    envelope: { messages: ["rewritten"] },
    rawBody: JSON.stringify({ messages: ["original"] }),
  });
  assert.equal(result.bypassed, false);
  assert.deepEqual(result.payload, { encoded: { messages: ["rewritten"] } });
});

test("bypasses to the raw body when encode throws", () => {
  const result = encodeRequestOrBypass({
    codec: { encodeRequest: () => { throw new Error("encode failed"); } },
    envelope: { messages: ["rewritten"] },
    rawBody: JSON.stringify({ messages: ["original"], model: "m1" }),
  });
  assert.equal(result.bypassed, true);
  // forwarded payload is the ORIGINAL request, untouched by overlay
  assert.deepEqual(result.payload, { messages: ["original"], model: "m1" });
});
