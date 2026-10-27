/**
 * Removing a conversation from the resume list. Only Codex offers it, and it
 * maps to the bridge's archive route, which keeps the thread's history.
 */
import { describe, expect, test } from "bun:test";
import { codexConnection, cursorConnection, httpProvider } from "./agent-provider-test-support.js";

describe("HTTP bridge resume-list archive", () => {
  test("posts archive and unarchive for a Codex thread", async () => {
    const { provider, requests } = httpProvider(
      () => Response.json({ archived: true }),
      codexConnection,
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
    const { provider, requests } = httpProvider(() => Response.json({}), cursorConnection);
    await expect(provider.setResumableSessionArchived!("agent-1", true)).rejects.toThrow(
      "cannot archive",
    );
    expect(requests).toHaveLength(0);
  });
});
