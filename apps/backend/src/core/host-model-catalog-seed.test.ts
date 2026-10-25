import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import {
  __testing,
  HOST_CATALOG_SEED_FAILURE_COOLDOWN_MS,
  resetHostModelCatalogSeedCooldown,
  seedEnabledHostModelCatalogs,
  seedHostModelCatalogIfMissing,
} from "./host-model-catalog-seed.js";

function fakeContext(
  initial: { claude?: unknown[]; codex?: unknown[] } = {},
  enabledAgentPlatforms: string[] = ["claude", "codex"],
) {
  const cache: Record<string, { updatedAt: string; models: unknown[] }> = {};
  for (const [agent, models] of Object.entries(initial)) {
    cache[agent] = { updatedAt: "2026-01-01T00:00:00.000Z", models: models ?? [] };
  }
  const cacheAgentModelCatalog = mock(async (agent: string, models: unknown[]) => {
    cache[agent] = { updatedAt: "2026-01-01T00:00:00.000Z", models };
    return cache;
  });
  const context = {
    storage: {
      getAgentModelCatalogCache: async () => cache,
      cacheAgentModelCatalog,
      loadConfig: async () => ({ global: { enabledAgentPlatforms } }),
      getOpenCodeModelCatalog: async () => null,
    },
  } as unknown as CommandContext;
  return { context, cacheAgentModelCatalog };
}

const claudeModel = { id: "sonnet", name: "Sonnet", resolvedModel: "sonnet" };

describe("seedHostModelCatalogIfMissing", () => {
  beforeEach(() => {
    __testing.reset();
    mock.restore();
  });

  test("downloads and caches a missing Claude catalogue", async () => {
    const { context, cacheAgentModelCatalog } = fakeContext();
    const refresh = mock(async () => ({ agent: "claude" as const, models: [claudeModel] }));
    expect(await seedHostModelCatalogIfMissing(context, "claude", refresh as never)).toBe(true);
    expect(cacheAgentModelCatalog).toHaveBeenCalledWith("claude", [claudeModel]);
  });

  test("leaves an existing catalogue alone", async () => {
    const { context } = fakeContext({ claude: [claudeModel] });
    const refresh = mock(async () => ({ agent: "claude" as const, models: [] }));
    expect(await seedHostModelCatalogIfMissing(context, "claude", refresh as never)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  test("reports failure without throwing and cools down until a sign-in", async () => {
    const { context } = fakeContext();
    const refresh = mock(async () => {
      throw new Error("not signed in");
    });
    let now = 1_000;
    const clock = () => now;
    expect(
      await seedHostModelCatalogIfMissing(context, "codex", refresh as never, { now: clock }),
    ).toBe(false);
    now += 1_000;
    expect(
      await seedHostModelCatalogIfMissing(context, "codex", refresh as never, { now: clock }),
    ).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    resetHostModelCatalogSeedCooldown("codex");
    await seedHostModelCatalogIfMissing(context, "codex", refresh as never, { now: clock });
    expect(refresh).toHaveBeenCalledTimes(2);
    now += HOST_CATALOG_SEED_FAILURE_COOLDOWN_MS;
    await seedHostModelCatalogIfMissing(context, "codex", refresh as never, { now: clock });
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  test("reports a durable-cache read failure without rejecting", async () => {
    const { context } = fakeContext();
    context.storage.getAgentModelCatalogCache = mock(async () => {
      throw new Error("cache read failed");
    });
    const refresh = mock(async () => ({ agent: "claude" as const, models: [claudeModel] }));
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        seedHostModelCatalogIfMissing(context, "claude", refresh as never),
      ).resolves.toBe(false);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("queues a fresh seed when sign-in resets an older in-flight attempt", async () => {
    const { context, cacheAgentModelCatalog } = fakeContext();
    let rejectOld!: (error: Error) => void;
    let oldStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    let attempts = 0;
    const refresh = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        oldStarted();
        return await new Promise<never>((_resolve, reject) => {
          rejectOld = reject;
        });
      }
      return { agent: "claude" as const, models: [claudeModel] };
    });

    const staleSeed = seedHostModelCatalogIfMissing(context, "claude", refresh as never);
    await started;
    resetHostModelCatalogSeedCooldown("claude");
    const authenticatedSeed = seedHostModelCatalogIfMissing(context, "claude", refresh as never);
    rejectOld(new Error("old credentials"));

    await expect(staleSeed).resolves.toBe(false);
    await expect(authenticatedSeed).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(cacheAgentModelCatalog).toHaveBeenCalledWith("claude", [claudeModel]);
  });

  test("seeds every enabled platform that has no catalogue and skips the rest", async () => {
    const { context, cacheAgentModelCatalog } = fakeContext({ codex: [{ id: "gpt" }] }, [
      "claude",
      "codex",
      "pi",
    ]);
    const refresh = mock(async (_context: unknown, agent: string) =>
      agent === "claude"
        ? { agent: "claude" as const, models: [claudeModel] }
        : { agent: "pi" as const, models: [{ id: "pi/x" }] },
    );
    await seedEnabledHostModelCatalogs(context, refresh as never);
    expect(refresh.mock.calls.map((call) => call[1])).toEqual(["claude", "pi"]);
    expect(cacheAgentModelCatalog).toHaveBeenCalledTimes(2);
  });

  test("leaves OpenCode alone until a project is known", async () => {
    const { context } = fakeContext({}, ["opencode"]);
    const refresh = mock(async () => ({ agent: "opencode" as const, models: [] }));
    await seedEnabledHostModelCatalogs(context, refresh as never);
    expect(refresh).not.toHaveBeenCalled();
  });
});
