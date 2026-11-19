import { describe, expect, test } from "bun:test";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  createPastSessionLoader,
  createSessionHistoryProvider,
  type PastSessionEntry,
} from "./history-sessions";

const environment = { id: "e-1", name: "checkout", projectId: "p", projectName: "orkestrator-v2" };

function provider(
  lists: Partial<Record<AgentPlatform, PastSessionEntry[] | Error>>,
  options: { openSessionIds?: Set<string>; resultLimit?: number } = {},
) {
  const calls: AgentPlatform[] = [];
  const loader = createPastSessionLoader({
    platforms: Object.keys(lists) as AgentPlatform[],
    list: async (platform) => {
      calls.push(platform);
      const list = lists[platform];
      if (list instanceof Error) throw list;
      return list ?? [];
    },
  });
  return {
    calls,
    provider: createSessionHistoryProvider({
      loader,
      environment,
      machine: () => null,
      platformLabel: (platform) => (platform === "claude" ? "Claude" : "Codex"),
      openSessionIds: options.openSessionIds ?? new Set(),
      ...(options.resultLimit ? { resultLimit: options.resultLimit } : {}),
    }),
  };
}

describe("past-session History source", () => {
  test("lists each platform once per palette session and filters as the user types", async () => {
    const { calls, provider: sessions } = provider({
      claude: [
        { sessionId: "c1", title: "Fix flaky test", updatedAt: "2026-11-18T10:00:00Z" },
        { sessionId: "c2", title: "Release notes", updatedAt: "2026-11-19T10:00:00Z" },
        { sessionId: "c3", title: "Archived plan", archived: true },
        { title: "No id" },
      ],
      codex: [{ sessionId: "x1", updatedAt: "2026-11-17T10:00:00Z" }],
    });
    const signal = new AbortController().signal;
    const all = await sessions.search("", signal);
    // Most recent first; archived and id-less entries are left out.
    expect(all.rows.map((row) => row.sessionId)).toEqual(["c2", "c1", "x1"]);
    expect(all.rows[2]).toMatchObject({
      source: "session",
      title: "Untitled conversation",
      kind: "Codex session",
      platform: "codex",
      rowId: "history-session:this:e-1:codex:x1",
      environmentId: "e-1",
    });
    const release = await sessions.search("release", signal);
    expect(release.rows.map((row) => row.sessionId)).toEqual(["c2"]);
    const codex = await sessions.search("codex", signal);
    expect(codex.rows.map((row) => row.sessionId)).toEqual(["x1"]);
    expect(calls.sort()).toEqual(["claude", "codex"]);
  });

  test("leaves out conversations already open in a tab and bounds its answer", async () => {
    const { provider: sessions } = provider(
      {
        claude: Array.from({ length: 5 }, (_, index) => ({ sessionId: `c${index}`, title: "t" })),
      },
      { openSessionIds: new Set(["c0"]), resultLimit: 2 },
    );
    const answer = await sessions.search("", new AbortController().signal);
    expect(answer.rows).toHaveLength(2);
    expect(answer.rows.some((row) => row.sessionId === "c0")).toBe(false);
    expect(answer.partial).toBe(true);
  });

  test("one unreadable platform is partial; every platform unreadable fails", async () => {
    const { provider: some } = provider({
      claude: [{ sessionId: "c1", title: "kept" }],
      codex: new Error("bridge unavailable"),
    });
    const partial = await some.search("", new AbortController().signal);
    expect(partial.rows.map((row) => row.sessionId)).toEqual(["c1"]);
    expect(partial.partial).toBe(true);

    const { provider: none } = provider({ claude: new Error("down") });
    await expect(none.search("", new AbortController().signal)).rejects.toThrow(
      "No past-session list could be read",
    );
  });

  test("an aborted search rejects without waiting for the list", async () => {
    const controller = new AbortController();
    const loader = createPastSessionLoader({
      platforms: ["claude"],
      list: () => new Promise<PastSessionEntry[]>(() => {}),
    });
    const sessions = createSessionHistoryProvider({
      loader,
      environment,
      machine: () => null,
      platformLabel: () => "Claude",
      openSessionIds: new Set(),
    });
    const pending = sessions.search("", controller.signal);
    controller.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });
});
