import { describe, expect, mock, test } from "bun:test";
import { agentAccountLoginKey } from "./agent-accounts/store.js";
import type { CommandContext } from "./commands-context.js";
import { HostCatalogSeeds } from "./host-catalog-seeds.js";
import {
  isHostModelCatalogStale,
  refreshStaleHostModelCatalogs,
  refreshStaleHostModelCatalogsInBackground,
} from "./host-model-catalog-seed.js";
import type { AgentModelCatalogCache } from "./models.js";
import { AGENT_MODEL_CATALOG_MAX_AGE_MS } from "./storage/shared.js";

const DAY = AGENT_MODEL_CATALOG_MAX_AGE_MS;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const iso = (time: number) => new Date(time).toISOString();

const oldCodex = { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" };
const newCodex = { id: "gpt-6.2-sol", name: "GPT-6.2-Sol" };
const claudeModel = { id: "sonnet", name: "Sonnet", resolvedModel: "sonnet" };

function fakeContext(
  entries: Partial<Record<"claude" | "codex", { models: unknown[]; updatedAt: string }>>,
  enabledAgentPlatforms: string[] = ["claude", "codex"],
) {
  const cache = { schemaVersion: 1, ...entries } as AgentModelCatalogCache;
  const cacheAgentModelCatalog = mock(async (agent: "claude" | "codex", models: unknown[]) => {
    (cache as Record<string, unknown>)[agent] = { updatedAt: iso(NOW), models };
    return cache;
  });
  const context = {
    runtime: {
      localServers: { catalogSeeds: new HostCatalogSeeds() },
      accounts: { withMutation: (run: () => Promise<unknown>) => run() },
    },
    storage: {
      agentAccounts: { loadAgentAccounts: async () => ({ active: {} }) },
      getAgentModelCatalogCache: async () => cache,
      cacheAgentModelCatalog,
      loadConfig: async () => ({ global: { enabledAgentPlatforms } }),
    },
  } as unknown as CommandContext;
  return { context, cache, cacheAgentModelCatalog };
}

describe("isHostModelCatalogStale", () => {
  test("is stale only for a catalogue last confirmed more than a day ago", () => {
    const cache = {
      schemaVersion: 1,
      codex: { updatedAt: iso(NOW - DAY - 1), models: [oldCodex] },
      claude: { updatedAt: iso(NOW - DAY + 60_000), models: [claudeModel] },
    } as AgentModelCatalogCache;
    expect(isHostModelCatalogStale(cache, "codex", NOW)).toBe(true);
    expect(isHostModelCatalogStale(cache, "claude", NOW)).toBe(false);
  });

  test("treats a missing or empty catalogue as first use, not staleness", () => {
    const cache = {
      schemaVersion: 1,
      codex: { updatedAt: iso(0), models: [] },
    } as unknown as AgentModelCatalogCache;
    expect(isHostModelCatalogStale(cache, "codex", NOW)).toBe(false);
    expect(isHostModelCatalogStale(cache, "claude", NOW)).toBe(false);
  });

  test("treats the epoch, which an unreadable stored time is read back as, as stale", () => {
    const cache = {
      schemaVersion: 1,
      codex: { updatedAt: iso(0), models: [oldCodex] },
    } as AgentModelCatalogCache;
    expect(isHostModelCatalogStale(cache, "codex", NOW)).toBe(true);
  });
});

describe("refreshStaleHostModelCatalogs", () => {
  test("re-downloads a stale Codex catalogue so a new model appears", async () => {
    const { context, cache } = fakeContext({
      codex: { updatedAt: iso(NOW - 2 * DAY), models: [oldCodex] },
      claude: { updatedAt: iso(NOW - 60_000), models: [claudeModel] },
    });
    const refresh = mock(async (_context: unknown, agent: string) => ({
      agent,
      accountLoginKey: agentAccountLoginKey(),
      models: [newCodex, oldCodex],
    }));
    await refreshStaleHostModelCatalogs(context, refresh as never, { now: () => NOW });
    // Only the stale platform is probed; the fresh Claude list is left alone.
    expect(refresh.mock.calls.map((call) => call[1])).toEqual(["codex"]);
    expect(cache.codex?.models.map((model) => model.id)).toEqual(["gpt-6.2-sol", "gpt-6.1-sol"]);
  });

  test("skips a platform the user has switched off", async () => {
    const { context } = fakeContext(
      { codex: { updatedAt: iso(NOW - 2 * DAY), models: [oldCodex] } },
      ["claude"],
    );
    const refresh = mock(async () => ({ agent: "codex", models: [newCodex] }));
    await refreshStaleHostModelCatalogs(context, refresh as never, { now: () => NOW });
    expect(refresh).not.toHaveBeenCalled();
  });

  test("keeps serving the cached list when the download fails, and cools down", async () => {
    const { context, cache } = fakeContext({
      codex: { updatedAt: iso(NOW - 2 * DAY), models: [oldCodex] },
    });
    const refresh = mock(async () => {
      throw new Error("not signed in");
    });
    await refreshStaleHostModelCatalogs(context, refresh as never, { now: () => NOW });
    await refreshStaleHostModelCatalogs(context, refresh as never, { now: () => NOW + 1_000 });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(cache.codex?.models).toEqual([oldCodex]);
  });

  test("the background form starts nothing while every catalogue is fresh", async () => {
    const { context, cache } = fakeContext({
      codex: { updatedAt: iso(NOW - 60_000), models: [oldCodex] },
    });
    const refresh = mock(async () => ({ agent: "codex", models: [newCodex] }));
    refreshStaleHostModelCatalogsInBackground(context, refresh as never, cache, () => NOW);
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });

  test("the background form refreshes a stale catalogue without being awaited", async () => {
    const { context, cache } = fakeContext({
      codex: { updatedAt: iso(NOW - 2 * DAY), models: [oldCodex] },
    });
    const settled = Promise.withResolvers<void>();
    const refresh = mock(async () => {
      settled.resolve();
      return { agent: "codex", accountLoginKey: agentAccountLoginKey(), models: [newCodex] };
    });
    refreshStaleHostModelCatalogsInBackground(context, refresh as never, cache, () => NOW);
    await settled.promise;
    // The download resolved; let the seed persist it.
    await Bun.sleep(0);
    expect(cache.codex?.models).toEqual([newCodex]);
  });
});
