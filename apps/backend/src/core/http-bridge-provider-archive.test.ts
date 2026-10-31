/**
 * Removing a conversation from the resume list. Codex and Cursor offer it, and
 * it maps to the bridge's archive route, which keeps the conversation's history.
 */
import { describe, expect, test } from "bun:test";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  httpProvider,
} from "./agent-provider-test-support.js";

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
