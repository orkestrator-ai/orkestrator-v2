import { describe, expect, test } from "bun:test";
import type { BridgeConnection } from "../agent-provider-contract.js";
import {
  claudeConnection,
  codexConnection,
  httpProvider,
  piConnection,
} from "../agent-provider-test-support.js";

const TRANSPORT_NOTICE = "16 MiB transport limit";

function rows(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}` }));
}

/** A bridge answering `/messages` with `body` and every other read with an idle session. */
function bridge(connection: BridgeConnection, body: Record<string, unknown>) {
  return httpProvider((url) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith("/messages")) return Response.json(body);
    if (pathname.endsWith("/config")) return Response.json({});
    return Response.json({
      status: "idle",
      revision: 1,
      composer: { models: [], modes: [] },
    });
  }, connection);
}

const messagesUrls = (requests: Array<{ url: string }>) =>
  requests.map((request) => request.url).filter((url) => url.includes("/messages"));

describe("interactive session resource budget", () => {
  test("accepts a Claude session resource past 512 KiB", async () => {
    // The same resource the observe and steer reads take at 16 MiB; a long
    // background-task history outgrew the 512 KiB this read used to allow.
    const { provider } = httpProvider((url) => {
      const { pathname } = new URL(url);
      if (pathname.endsWith("/messages")) return Response.json({ messages: rows(1) });
      if (pathname.endsWith("/runtime-health") || pathname.endsWith("/init")) {
        return new Response(null, { status: 404 });
      }
      return Response.json({
        status: "idle",
        revision: 1,
        structuredOutput: { report: "x".repeat(600 * 1024) },
      });
    }, claudeConnection);

    const snapshot = await provider.interactiveSnapshot!("session-1");
    expect(snapshot.status).toBe("idle");
  });
});

describe("interactive snapshot read limit (TX-2)", () => {
  for (const connection of [claudeConnection, codexConnection, piConnection]) {
    describe(connection.agent, () => {
      test("sends the limit to the bridge", async () => {
        const { provider, requests } = bridge(connection, { messages: rows(3) });
        await provider.interactiveSnapshot!("session-1", { limit: 3 });
        expect(messagesUrls(requests)).toEqual([
          `${connection.baseUrl}/session/session-1/messages?limit=3`,
        ]);
      });

      test("reads the whole window when no limit is given", async () => {
        const { provider, requests } = bridge(connection, { messages: rows(3) });
        await provider.interactiveSnapshot!("session-1");
        expect(messagesUrls(requests)).toEqual([
          `${connection.baseUrl}/session/session-1/messages`,
        ]);
      });

      test("keeps only the newest rows from a bridge that ignores the limit", async () => {
        const { provider } = bridge(connection, { messages: rows(5) });
        const snapshot = await provider.interactiveSnapshot!("session-1", { limit: 2 });
        expect(snapshot.messages).toEqual([{ id: "m3" }, { id: "m4" }]);
      });

      test("does not report the tail's own cut as a transport omission", async () => {
        const { provider } = bridge(connection, {
          messages: rows(3),
          messageWindow: { truncated: true, omittedMessages: 400 },
        });
        const snapshot = await provider.interactiveSnapshot!("session-1", { limit: 3 });
        expect(JSON.stringify(snapshot.notices ?? [])).not.toContain(TRANSPORT_NOTICE);
      });

      test("still reports rows the transport bound dropped from a tail", async () => {
        const { provider } = bridge(connection, {
          messages: rows(2),
          messageWindow: { truncated: true, omittedMessages: 400 },
        });
        const snapshot = await provider.interactiveSnapshot!("session-1", { limit: 3 });
        expect(JSON.stringify(snapshot.notices ?? [])).toContain(TRANSPORT_NOTICE);
      });

      test("still reports parts the transport bound shed from a full tail", async () => {
        const { provider } = bridge(connection, {
          messages: rows(3),
          messageWindow: { truncated: true, omittedMessages: 400, omittedParts: 2 },
        });
        const snapshot = await provider.interactiveSnapshot!("session-1", { limit: 3 });
        expect(JSON.stringify(snapshot.notices ?? [])).toContain(TRANSPORT_NOTICE);
      });

      test("an unlimited read keeps reporting truncation as before", async () => {
        const { provider } = bridge(connection, {
          messages: rows(3),
          messageWindow: { truncated: true, omittedMessages: 400 },
        });
        const snapshot = await provider.interactiveSnapshot!("session-1");
        expect(JSON.stringify(snapshot.notices ?? [])).toContain(TRANSPORT_NOTICE);
      });
    });
  }
});
