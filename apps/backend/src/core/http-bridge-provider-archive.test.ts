/**
 * Removing a conversation from the resume list. Codex and Cursor offer it, and
 * it maps to the bridge's archive route, which keeps the conversation's history.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { CATALOG_TIMEOUT_MS } from "../../../../bridges/pi-bridge/src/config.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  httpProvider,
  piConnection,
} from "./agent-provider-test-support.js";
import { BRIDGE_SESSION_LIST_TIMEOUT_MS } from "./http-bridge-transport.js";

describe("HTTP bridge resume-list archive", () => {
  test.each([
    ["Codex", codexConnection],
    ["Cursor", cursorConnection],
  ] as const)("posts archive and unarchive for a %s conversation", async (_name, connection) => {
    const { provider, requests } = httpProvider(
      () => Response.json({ archived: true }),
      connection,
    );
    await provider.setResumableSessionArchived!("thread/1", true);
    await provider.setResumableSessionArchived!("thread/1", false);
    expect(requests.map((request) => [request.init.method, new URL(request.url).pathname])).toEqual(
      [
        ["POST", "/session/list/thread%2F1/archive"],
        ["POST", "/session/list/thread%2F1/unarchive"],
      ],
    );
  });

  test("a bridge's timed-out list reaches the caller as an error, not an empty list", async () => {
    const { provider } = httpProvider(() =>
      Response.json({ error: "Pi took too long to read its session history" }, { status: 504 }),
    );
    const failure = await provider.listResumableSessions!().catch((error: unknown) => error);
    // The whole message: the resume dialog shows it to the user as is.
    expect((failure as Error).message).toBe("Pi took too long to read its session history");
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
  });

  test("a failed list with no reason in its body still names the operation", async () => {
    const { provider } = httpProvider(() => new Response("oops", { status: 500 }));
    const failure = await provider.listResumableSessions!().catch((error: unknown) => error);
    expect((failure as Error).message).toBe(
      "claude resumable session list is temporarily unavailable (HTTP 500)",
    );
  });

  test("a list waits for the bridge's own ceiling to answer", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      const { requestTimeoutMs: _testOverride, ...connection } = piConnection;
      const { provider } = httpProvider(() => Response.json({ sessions: [] }), connection);
      await provider.listResumableSessions!();
      // At the bridge's own ceiling this side gives up first, and the reason
      // never reaches the user.
      expect(timeout.mock.calls.at(-1)?.[0]).toBe(BRIDGE_SESSION_LIST_TIMEOUT_MS);
      expect(BRIDGE_SESSION_LIST_TIMEOUT_MS).toBeGreaterThan(CATALOG_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  test("asks for archived rows only on request, and keeps only a true flag", async () => {
    const { provider, requests } = httpProvider(
      () =>
        Response.json({
          sessions: [
            { id: "live", archived: false },
            { id: "kept", archived: true },
            { id: "odd", archived: "yes" },
          ],
        }),
      cursorConnection,
    );
    await provider.listResumableSessions!();
    const entries = await provider.listResumableSessions!({ includeArchived: true });
    expect(requests.map((request) => new URL(request.url).search)).toEqual([
      "",
      "?includeArchived=1",
    ]);
    expect(entries).toEqual([
      { sessionId: "live" },
      { sessionId: "kept", archived: true },
      { sessionId: "odd" },
    ]);
  });

  test.each([512, 513])(
    "retains independent live and archive quotas with %s live rows",
    async (liveCount) => {
      const { provider } = httpProvider(
        () =>
          Response.json({
            sessions: [
              ...Array.from({ length: liveCount }, (_, index) => ({ id: `live-${index}` })),
              ...Array.from({ length: 513 }, (_, index) => ({
                id: `archived-${index}`,
                archived: true,
              })),
            ],
          }),
        codexConnection,
      );
      const entries = await provider.listResumableSessions!({ includeArchived: true });
      expect(entries.filter((entry) => !entry.archived)).toHaveLength(512);
      expect(entries.filter((entry) => entry.archived)).toHaveLength(512);
      expect(entries[512]).toEqual({ sessionId: "archived-0", archived: true });
    },
  );

  test("surfaces the bridge's refusal", async () => {
    const { provider } = httpProvider(
      () => Response.json({ error: "This conversation is open in a tab" }, { status: 409 }),
      codexConnection,
    );
    await expect(provider.setResumableSessionArchived!("thread-1", true)).rejects.toThrow(
      "This conversation is open in a tab",
    );
  });

  test("a platform without archive never calls its bridge", async () => {
    const { provider, requests } = httpProvider(() => Response.json({}), claudeConnection);
    await expect(provider.setResumableSessionArchived!("session-1", true)).rejects.toThrow(
      "cannot archive",
    );
    expect(requests).toHaveLength(0);
  });
});
