import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentSessionBackendTitle } from "./models.js";
import {
  NativeAgentSessionTitles,
  SESSION_TITLE_PUSH_RETRY_MS,
  type SessionTitleRead,
} from "./native-agent-session-titles.js";
import type { SessionTitleGenerator } from "./session-title-service.js";

function harness(
  options: { generated?: string | null; failPush?: boolean; noGenerator?: boolean } = {},
) {
  const records = new Map<string, NativeAgentSessionBackendTitle>();
  let now = 0;
  const storage = {
    recordNativeAgentSessionBackendTitle: mock(
      async (key: string, title: NativeAgentSessionBackendTitle) => {
        records.set(key, title);
        return true;
      },
    ),
  };
  const generate = mock(async (_input: { agent: string; source: string }) =>
    options.generated === null
      ? null
      : { title: options.generated ?? "Generated title", strategy: "codex" as const },
  );
  const generator: SessionTitleGenerator = { generate, shutdown: async () => undefined };
  const chosen: string[] = [];
  const titles = new NativeAgentSessionTitles({
    storage,
    ...(options.noGenerator ? {} : { generator }),
    onTitleChosen: (_key, title) => chosen.push(title),
    now: () => now,
  });
  const setProviderTitle = mock(async () => {
    if (options.failPush) throw new Error("provider refused");
  });
  const read = (overrides: Partial<SessionTitleRead> = {}): SessionTitleRead => ({
    sessionKey: "session-1",
    session: {
      providerSessionId: "provider-1",
      origin: "interactive-native",
      ...(records.get("session-1") ? { backendTitle: records.get("session-1") } : {}),
    },
    agent: "codex",
    providerTitle: "Agent Session",
    firstUserMessage: "Please fix the OAuth callback race in the login flow",
    reachesStart: true,
    transient: false,
    setProviderTitle,
    ...overrides,
  });
  return {
    titles,
    read,
    records,
    generate,
    setProviderTitle,
    chosen,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function settle(titles: NativeAgentSessionTitles): Promise<void> {
  await Promise.all(titles.pending());
  await Bun.sleep(0);
  await Bun.sleep(0);
}

describe("NativeAgentSessionTitles", () => {
  test.each(["interactive-native", "coordinator", "build-pipeline", "automated-review"] as const)(
    "gates model generation by origin (%s)",
    async (origin) => {
      const h = harness();
      h.titles.resolve(h.read({ session: { providerSessionId: "provider-1", origin } }));
      await settle(h.titles);
      expect(h.generate.mock.calls.length).toBe(
        origin === "interactive-native" || origin === "coordinator" ? 1 : 0,
      );
    },
  );

  test("shows the fallback, generates once, stores and pushes the generated title", async () => {
    const h = harness();
    expect(h.titles.resolve(h.read())).toBe("Please fix the OAuth callback race in the login flow");
    // A second read while generating does not start another run.
    h.titles.resolve(h.read());
    await settle(h.titles);

    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]).toEqual([
      { agent: "codex", source: "Please fix the OAuth callback race in the login flow" },
    ]);
    expect(h.chosen).toEqual(["Generated title"]);
    expect(h.setProviderTitle).toHaveBeenCalledWith("provider-1", "Generated title");
    expect(h.records.get("session-1")).toEqual({
      providerSessionId: "provider-1",
      title: "Generated title",
      source: "generated",
      pushed: true,
    });
    // The provider now reports it; it stays the title.
    expect(h.titles.resolve(h.read({ providerTitle: "Generated title" }))).toBe("Generated title");
  });

  // Offline half of the title qualification: what the renderer ends up showing
  // on every platform when nothing could generate a title, and when the
  // provider will not take the one chosen. Cursor and Grok have no setter.
  describe.each(["claude", "codex", "opencode", "cursor", "grok", "pi"] as const)("%s", (agent) => {
    const providerSetter = agent !== "cursor" && agent !== "grok";

    test("falls back to the first message and keeps it", async () => {
      const h = harness({ generated: null });
      const read = (overrides: Partial<SessionTitleRead> = {}) =>
        h.read({
          agent,
          ...(providerSetter ? {} : { setProviderTitle: undefined }),
          ...overrides,
        });
      const fallback = "Please fix the OAuth callback race in the login flow";
      expect(h.titles.resolve(read())).toBe(fallback);
      await settle(h.titles);
      expect(h.generate.mock.calls[0]?.[0].agent).toBe(agent);
      expect(h.records.get("session-1")).toMatchObject({ title: fallback, source: "fallback" });
      expect(h.titles.resolve(read())).toBe(fallback);
    });

    test("a provider that refuses the title does not lose it", async () => {
      const h = harness({ failPush: true });
      const read = (overrides: Partial<SessionTitleRead> = {}) =>
        h.read({
          agent,
          ...(providerSetter ? {} : { setProviderTitle: undefined }),
          ...overrides,
        });
      h.titles.resolve(read());
      await settle(h.titles);
      expect(h.setProviderTitle).toHaveBeenCalledTimes(providerSetter ? 1 : 0);
      expect(h.records.get("session-1")?.pushed).toBeUndefined();
      expect(h.titles.resolve(read({ providerTitle: "Provider summary" }))).toBe("Generated title");
    });
  });

  test("with the generator unavailable the first message is the title", async () => {
    const h = harness({ generated: null });
    h.titles.resolve(h.read());
    await settle(h.titles);
    expect(h.records.get("session-1")).toMatchObject({
      title: "Please fix the OAuth callback race in the login flow",
      source: "fallback",
      pushed: true,
    });
  });

  test("a failed provider push keeps the backend title and retries later", async () => {
    const h = harness({ failPush: true });
    h.titles.resolve(h.read());
    await settle(h.titles);
    expect(h.records.get("session-1")).toMatchObject({ title: "Generated title" });
    expect(h.records.get("session-1")?.pushed).toBeUndefined();

    // The provider's own title (a restarted Claude bridge's summary, say) does
    // not displace a title the provider never accepted.
    expect(h.titles.resolve(h.read({ providerTitle: "Provider summary" }))).toBe("Generated title");
    await Bun.sleep(0);
    expect(h.setProviderTitle).toHaveBeenCalledTimes(1);
    h.advance(SESSION_TITLE_PUSH_RETRY_MS);
    h.titles.resolve(h.read({ providerTitle: "Provider summary" }));
    await Bun.sleep(0);
    expect(h.setProviderTitle).toHaveBeenCalledTimes(2);
  });

  test("a provider with no setter (Cursor, Grok) keeps the backend title", async () => {
    const h = harness();
    const read = (overrides: Partial<SessionTitleRead> = {}) => {
      const { setProviderTitle: _absent, ...rest } = h.read({ agent: "grok", ...overrides });
      return rest;
    };
    h.titles.resolve(read({ providerTitle: undefined }));
    await settle(h.titles);
    expect(h.titles.resolve(read({ providerTitle: "Grok's own name" }))).toBe("Generated title");
  });

  test("a provider title of its own wins when the backend never chose one", () => {
    const h = harness();
    expect(h.titles.resolve(h.read({ providerTitle: "Renamed in Codex" }))).toBe(
      "Renamed in Codex",
    );
    expect(h.generate).not.toHaveBeenCalled();
  });

  test("once the provider holds the backend title, a later rename there wins", async () => {
    const h = harness();
    h.titles.resolve(h.read());
    await settle(h.titles);
    expect(h.titles.resolve(h.read({ providerTitle: "Renamed by the user" }))).toBe(
      "Renamed by the user",
    );
  });

  test("a window that starts mid-conversation shows a fallback but chooses nothing", async () => {
    const h = harness();
    expect(h.titles.resolve(h.read({ reachesStart: false }))).toBe(
      "Please fix the OAuth callback race in the login flow",
    );
    await settle(h.titles);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });

  test("transient reads never choose or push", async () => {
    const h = harness();
    h.titles.resolve(h.read({ transient: true }));
    await settle(h.titles);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.setProviderTitle).not.toHaveBeenCalled();
  });

  test("pipeline sessions keep the first-message title without a model run", async () => {
    const h = harness();
    h.titles.resolve(
      h.read({
        session: { providerSessionId: "provider-1", origin: "build-pipeline" },
      }),
    );
    await settle(h.titles);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.records.get("session-1")).toMatchObject({ source: "fallback" });
  });

  test("a title chosen for another provider session is ignored", () => {
    const h = harness({ noGenerator: true });
    const title = h.titles.resolve(
      h.read({
        session: {
          providerSessionId: "provider-2",
          origin: "interactive-native",
          backendTitle: {
            providerSessionId: "provider-1",
            title: "Old conversation",
            source: "generated",
          },
        },
      }),
    );
    expect(title).toBe("Please fix the OAuth callback race in the login flow");
  });

  test("a placeholder stays when there is nothing better", () => {
    const h = harness();
    expect(h.titles.resolve(h.read({ firstUserMessage: undefined }))).toBe("Agent Session");
    expect(
      h.titles.resolve(
        h.read({ agent: "claude", providerTitle: "Session a1b2c3", firstUserMessage: undefined }),
      ),
    ).toBe("Session a1b2c3");
  });
});
