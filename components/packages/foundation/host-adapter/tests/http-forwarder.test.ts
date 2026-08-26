import assert from "node:assert/strict";
import test from "node:test";
import { buildGatewayForwardHeaders } from "../src/gateway/http-forwarder.js";

test("forward headers omit transport metadata that can split provider cache identity", () => {
  const headers = buildGatewayForwardHeaders({
    upstream: { baseUrl: "http://provider.test/v1", apiKey: "key", name: "provider", protocol: "custom" },
    inboundHeaders: {
      accept: "text/event-stream",
      "accept-language": "en-US",
      authorization: "Bearer inbound",
      "content-type": "application/json",
      "sec-fetch-mode": "cors",
      "user-agent": "browser",
      "x-request-id": "request",
    },
  });

  assert.deepEqual(headers, {
    accept: "text/event-stream",
    authorization: "Bearer inbound",
    "content-type": "application/json",
    "x-request-id": "request",
  });
});
