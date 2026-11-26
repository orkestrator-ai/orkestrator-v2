import { expect, test } from "bun:test";
import { bridgeTranscriptUpdate } from "@orkestrator/protocol/node/progressive-transcript";
import { httpProvider } from "./agent-provider-test-support.js";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";

test("a transcript read never falls back to /messages, so it counts no compatibility use", async () => {
  const before = compatibilityPathUsage.snapshot().paths;
  const options = { limit: 10, targetBytes: 1024 };
  const current = httpProvider(() =>
    Response.json(
      bridgeTranscriptUpdate([], {
        ...options,
        sessionIdentity: "session-1",
        generation: 1,
        contentEpoch: 1,
        revision: 1,
        complete: true,
      }),
    ),
  );
  await (current.provider as NativeAgentRuntimeProvider).transcriptSnapshot!("session-1", options);
  // `/transcript` answers 404: the session is missing, and `/messages` is not read.
  const missing = httpProvider(() => new Response(null, { status: 404 }));
  const snapshot = await (missing.provider as NativeAgentRuntimeProvider).transcriptSnapshot!(
    "session-1",
    options,
  );
  expect(snapshot).toMatchObject({ messages: [], complete: true });
  expect(missing.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/session/session-1/transcript",
  ]);
  expect(compatibilityPathUsage.snapshot().paths).toEqual(before);
});
