import { beforeEach, describe, expect, test } from "bun:test";
import {
  ModelCatalogCache,
  parseModelCatalog,
  type BridgeModel,
} from "./models-cache.js";

const SAMPLE_CATALOG = {
  models: [
    {
      slug: "gpt-5.3-codex",
      display_name: "GPT-5.3 Codex",
      description: "Latest frontier agentic coding model.",
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Deeper reasoning" },
        { effort: "xhigh", description: "Extra high reasoning" },
        { effort: "max", description: "Maximum reasoning" },
        { effort: "ultra", description: "Automatic task delegation" },
      ],
    },
    {
      // Should be filtered out: hidden from lists.
      slug: "internal-preview",
      visibility: "hidden",
    },
    {
      // Should be filtered out: not supported in API.
      slug: "retired-model",
      supported_in_api: false,
    },
    {
      // Should be filtered out: empty slug.
      slug: "   ",
    },
    {
      // Minimal entry — no display_name, no reasoning levels.
      slug: "gpt-5-mini",
      supported_in_api: true,
    },
  ],
};

describe("parseModelCatalog", () => {
  test("filters hidden, retired, and blank-slug entries", () => {
    const models = parseModelCatalog(JSON.stringify(SAMPLE_CATALOG));
    const ids = models.map((m) => m.id);
    expect(ids).toEqual(["gpt-5.3-codex", "gpt-5-mini"]);
  });

  test("preserves display name and description when present", () => {
    const [first] = parseModelCatalog(JSON.stringify(SAMPLE_CATALOG));
    expect(first?.name).toBe("GPT-5.3 Codex");
    expect(first?.description).toBe("Latest frontier agentic coding model.");
  });

  test("falls back to slug when display_name is missing", () => {
    const models = parseModelCatalog(JSON.stringify(SAMPLE_CATALOG));
    const mini = models.find((m) => m.id === "gpt-5-mini");
    expect(mini?.name).toBe("gpt-5-mini");
  });

  test("maps reasoning levels and picks medium as default when available", () => {
    const [first] = parseModelCatalog(JSON.stringify(SAMPLE_CATALOG));
    expect(first?.reasoningEfforts).toEqual(["medium", "high", "xhigh", "max", "ultra"]);
    expect(first?.defaultReasoningEffort).toBe("medium");
    expect(first?.reasoningOptions.map((o) => o.effort)).toEqual([
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  test("returns a default reasoning option when levels are missing", () => {
    const models = parseModelCatalog(JSON.stringify(SAMPLE_CATALOG));
    const mini = models.find((m) => m.id === "gpt-5-mini");
    expect(mini?.reasoningEfforts).toEqual(["medium"]);
    expect(mini?.defaultReasoningEffort).toBe("medium");
  });

  test("returns empty array when payload.models is not an array", () => {
    expect(parseModelCatalog(JSON.stringify({}))).toEqual([]);
    expect(parseModelCatalog(JSON.stringify({ models: "not an array" }))).toEqual([]);
  });

  test("skips reasoning entries with unknown effort values", () => {
    const raw = JSON.stringify({
      models: [
        {
          slug: "noisy",
          supported_reasoning_levels: [
            { effort: "bogus" },
            { effort: "high", description: "Deeper" },
          ],
        },
      ],
    });
    const [noisy] = parseModelCatalog(raw);
    expect(noisy?.reasoningEfforts).toEqual(["high"]);
    expect(noisy?.defaultReasoningEffort).toBe("high");
  });
});

describe("ModelCatalogCache", () => {
  const MODEL_A: BridgeModel = {
    id: "model-a",
    name: "Model A",
    reasoningEfforts: ["medium"],
    reasoningOptions: [{ effort: "medium", label: "Medium" }],
    defaultReasoningEffort: "medium",
  };
  const MODEL_B: BridgeModel = {
    id: "model-b",
    name: "Model B",
    reasoningEfforts: ["high"],
    reasoningOptions: [{ effort: "high", label: "High" }],
    defaultReasoningEffort: "high",
  };
  const FALLBACK: BridgeModel[] = [
    {
      id: "fallback",
      name: "Fallback",
      reasoningEfforts: ["medium"],
      reasoningOptions: [{ effort: "medium", label: "Medium" }],
      defaultReasoningEffort: "medium",
    },
  ];

  let writes: BridgeModel[][] = [];

  beforeEach(() => {
    writes = [];
  });

  test("returns the persisted cache immediately on first call and refreshes in the background", async () => {
    let resolved = false;
    const cache = new ModelCatalogCache({
      fetchFromCli: async () => {
        // Simulate a slow CLI — this must not block the first get().
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
        return [MODEL_B];
      },
      readPersistedCache: async () => [MODEL_A],
      writePersistedCache: async (m) => {
        writes.push(m);
      },
      fallback: FALLBACK,
    });

    const first = await cache.get();
    expect(first.source).toBe("cache");
    expect(first.models).toEqual([MODEL_A]);
    // CLI refresh still in flight when we returned.
    expect(resolved).toBe(false);

    await cache.refreshNow();
    expect(writes).toEqual([[MODEL_B]]);

    const second = await cache.get();
    expect(second.models).toEqual([MODEL_B]);
  });

  test("falls back to the Codex CLI cache when no persisted bridge cache exists", async () => {
    const cache = new ModelCatalogCache({
      fetchFromCli: async () => null,
      readPersistedCache: async () => null,
      readCodexCliCache: async () => [MODEL_A],
      writePersistedCache: async (m) => {
        writes.push(m);
      },
      fallback: FALLBACK,
    });

    const result = await cache.get();
    expect(result.source).toBe("cache");
    expect(result.models).toEqual([MODEL_A]);
  });

  test("returns the hardcoded fallback when every cache source misses", async () => {
    const cache = new ModelCatalogCache({
      fetchFromCli: async () => null,
      readPersistedCache: async () => null,
      readCodexCliCache: async () => null,
      writePersistedCache: async (m) => {
        writes.push(m);
      },
      fallback: FALLBACK,
    });

    const result = await cache.get();
    expect(result.source).toBe("fallback");
    expect(result.models).toEqual(FALLBACK);
  });

  test("serves from memory without hitting the CLI within the TTL", async () => {
    let fetchCalls = 0;
    const cache = new ModelCatalogCache({
      fetchFromCli: async () => {
        fetchCalls += 1;
        return [MODEL_B];
      },
      readPersistedCache: async () => [MODEL_A],
      writePersistedCache: async () => {},
      fallback: FALLBACK,
      ttlMs: 60_000,
      now: () => 1_000,
    });

    // Warm up: populate persisted cache, kick off the first refresh.
    await cache.get();
    await cache.refreshNow();
    expect(fetchCalls).toBe(1);

    // Subsequent gets within the TTL must not trigger additional fetches.
    await cache.get();
    await cache.get();
    expect(fetchCalls).toBe(1);
  });

  test("kicks off a background refresh once the in-memory TTL expires", async () => {
    let fetchCalls = 0;
    let clock = 0;
    const cache = new ModelCatalogCache({
      fetchFromCli: async () => {
        fetchCalls += 1;
        return [MODEL_B];
      },
      readPersistedCache: async () => [MODEL_A],
      writePersistedCache: async () => {},
      fallback: FALLBACK,
      ttlMs: 100,
      now: () => clock,
    });

    await cache.get();
    await cache.refreshNow();
    expect(fetchCalls).toBe(1);

    // Advance past the TTL: next get() serves from memory AND schedules a refresh.
    clock = 500;
    const result = await cache.get();
    expect(result.models).toEqual([MODEL_B]);
    await cache.refreshNow();
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
  });

  test("swallows background refresh errors without affecting served data", async () => {
    const cache = new ModelCatalogCache({
      fetchFromCli: async () => {
        throw new Error("boom");
      },
      readPersistedCache: async () => [MODEL_A],
      writePersistedCache: async () => {},
      fallback: FALLBACK,
    });

    const first = await cache.get();
    expect(first.models).toEqual([MODEL_A]);
    await cache.refreshNow(); // must not throw

    const second = await cache.get();
    expect(second.models).toEqual([MODEL_A]);
  });
});
