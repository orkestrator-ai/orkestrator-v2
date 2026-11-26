import { expect, test } from "bun:test";

import { readBridgeCapabilityEvidence } from "./capability-evidence.js";

const connection = {
  agent: "pi",
  baseUrl: "http://127.0.0.1:1",
  authToken: "test-token",
} as const;

test.each([404, 405])(
  "HTTP %i means the optional evidence route is unsupported",
  async (status) => {
    const fetchImpl = (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(
      await readBridgeCapabilityEvidence({
        connection,
        fetchImpl,
        agent: connection.agent,
        sessionId: "known",
      }),
    ).toEqual({ state: "unsupported" });
  },
);

test.each(["missing", "none"] as const)("a supporting bridge reports %s in band", async (state) => {
  let requested: string | undefined;
  const fetchImpl = (async (url: RequestInfo | URL) => {
    requested = String(url);
    return Response.json({ state });
  }) as unknown as typeof fetch;
  expect(
    await readBridgeCapabilityEvidence({
      connection,
      fetchImpl,
      agent: connection.agent,
      sessionId: "known/test",
    }),
  ).toEqual({ state });
  expect(requested).toBe(`${connection.baseUrl}/session/known%2Ftest/capability-evidence`);
});
