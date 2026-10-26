import { afterEach, describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatGptLoginModelIds,
  composeModelId,
  DEFAULT_THINKING_LEVEL,
  emptyComposer,
  hydrateComposer,
  listModels,
  markSessionDefault,
  modelLocalId,
  modelProviderId,
  normalizeAgentModel,
  reconcileComposerSelection,
  refreshModels,
  resolveModel,
  thinkingLevel,
} from "./models.js";
import { modelRuntime, setModelRuntimeFactoryForTests } from "./runtime.js";

afterEach(() => {
  setModelRuntimeFactoryForTests();
  refreshModels();
});

describe("model ids", () => {
  test("round-trips a provider and model pair", () => {
    const id = composeModelId("anthropic", "claude-opus-4-5");
    expect(modelProviderId(id)).toBe("anthropic");
    expect(modelLocalId(id)).toBe("claude-opus-4-5");
  });

  test("splits on the first slash only, so a nested model id survives", () => {
    // OpenRouter-style ids carry their own slashes. Splitting on the last one
    // would hand the runtime "openrouter/anthropic" as the provider.
    const id = composeModelId("openrouter", "anthropic/claude-opus-4-5");
    expect(modelProviderId(id)).toBe("openrouter");
    expect(modelLocalId(id)).toBe("anthropic/claude-opus-4-5");
  });

  test("reports no provider for an id that names none", () => {
    expect(modelProviderId("claude-opus-4-5")).toBe("");
    expect(modelLocalId("claude-opus-4-5")).toBe("");
  });
});

describe("session default mark", () => {
  const rows = [
    { platform: "pi" as const, id: "openai/gpt-4", label: "GPT-4" },
    { platform: "pi" as const, id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol" },
  ];

  test("marks the first preferred id the catalogue offers, on copies", () => {
    const marked = markSessionDefault(rows, ["signed-out/x", "openai/gpt-6.1-sol", "openai/gpt-4"]);
    expect(marked.map((row) => row.sessionDefault ?? false)).toEqual([false, true]);
    // The input is the process-wide catalogue cache; it must stay unmarked.
    expect(rows.some((row) => "sessionDefault" in row)).toBe(false);
  });

  test("marks nothing when no preferred id is offered", () => {
    expect(markSessionDefault(rows, ["signed-out/x"])).toEqual(rows);
    expect(markSessionDefault(rows, [])).toEqual(rows);
  });
});

/** A model shaped the way `getSupportedThinkingLevels` reads one. */
function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_000,
    ...overrides,
  } as Model<Api>;
}

describe("catalogue cache", () => {
  test("does not let an invalidated in-flight probe repopulate the cache", async () => {
    let reads = 0;
    let releaseFirst: (models: Model<Api>[]) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstResult = new Promise<Model<Api>[]>((resolve) => {
      releaseFirst = resolve;
    });
    const before = model({ id: "before" });
    const after = model({ id: "after" });
    setModelRuntimeFactoryForTests(
      async () =>
        ({
          getAvailable: () => {
            reads += 1;
            if (reads === 1) {
              markStarted();
              return firstResult;
            }
            return Promise.resolve([after]);
          },
          getProvider: () => undefined,
        }) as unknown as ModelRuntime,
    );
    refreshModels();

    const staleRead = listModels();
    await started;
    refreshModels();
    releaseFirst([before]);

    // The caller that began before invalidation may finish with its own result,
    // but that result must not become the process-wide answer for the refreshed
    // generation.
    expect((await staleRead).map((entry) => entry.id)).toEqual(["test/before"]);
    expect((await listModels()).map((entry) => entry.id)).toEqual(["test/after"]);
    expect(reads).toBe(2);
  });
});

describe("thinking levels", () => {
  test("passes a level Pi defines straight through when no model narrows it", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(thinkingLevel(level)).toBe(level as never);
    }
  });

  test("falls back for a level from another platform's ladder", () => {
    // "default" is the shared composer's "leave it to the model" id, which Pi
    // has no equivalent for. Forwarding it would be rejected by the SDK.
    expect(thinkingLevel("default")).toBe(DEFAULT_THINKING_LEVEL);
    expect(thinkingLevel(undefined)).toBe(DEFAULT_THINKING_LEVEL);
    expect(thinkingLevel("  ")).toBe(DEFAULT_THINKING_LEVEL);
  });

  test("clamps a level the selected model does not support", () => {
    // `max` needs an explicit mapping. A selection carried over from a model
    // that had one must resolve to this model's nearest level rather than being
    // sent and silently reinterpreted mid-turn.
    const narrow = model({ thinkingLevelMap: { low: "low", medium: "medium", high: "high" } });
    expect(thinkingLevel("max", narrow)).not.toBe("max");
    expect(["off", "minimal", "low", "medium", "high"]).toContain(thinkingLevel("max", narrow));
    expect(thinkingLevel("low", narrow)).toBe("low");
  });

  test("treats off as a real level rather than an absence", () => {
    expect(thinkingLevel("off", model())).toBe("off");
  });
});

describe("reasoning options", () => {
  test("offers xhigh and max only when the model maps them", () => {
    // The rule is not the obvious one: an absent key *excludes* these two,
    // where it includes every other level. Reimplementing it offered controls
    // the model would then have clamped away without telling anyone.
    const withoutTop = normalizeAgentModel(model({ thinkingLevelMap: { medium: "medium" } }));
    expect(withoutTop.reasoning?.map((option) => option.id)).not.toContain("xhigh");
    expect(withoutTop.reasoning?.map((option) => option.id)).not.toContain("max");

    const withTop = normalizeAgentModel(
      model({ thinkingLevelMap: { medium: "medium", xhigh: "xhigh", max: "max" } }),
    );
    expect(withTop.reasoning?.map((option) => option.id)).toContain("xhigh");
    expect(withTop.reasoning?.map((option) => option.id)).toContain("max");
  });

  test("drops a level the model marks unsupported", () => {
    const model_ = normalizeAgentModel(model({ thinkingLevelMap: { minimal: null } }));
    expect(model_.reasoning?.map((option) => option.id)).not.toContain("minimal");
    expect(model_.reasoning?.map((option) => option.id)).toContain("medium");
  });

  test("gives a non-reasoning model the single honest option", () => {
    const plain = normalizeAgentModel(model({ reasoning: false }));
    expect(plain.reasoning?.map((option) => option.id)).toEqual(["off"]);
  });

  test("prefers the user's stored per-model level, then their global one", () => {
    // Both are what `/thinking` writes in a Pi terminal tab. Reading them is
    // what makes one preference serve the picker and the CLI alike.
    const perModel = normalizeAgentModel(model(), {
      perModel: () => "low",
      global: () => "max",
    });
    expect(perModel.defaultReasoningId).toBe("low");

    const globalOnly = normalizeAgentModel(model(), {
      perModel: () => undefined,
      global: () => "high",
    });
    expect(globalOnly.defaultReasoningId).toBe("high");

    expect(normalizeAgentModel(model()).defaultReasoningId).toBe(DEFAULT_THINKING_LEVEL);
  });

  test("clamps a stored level the selected model cannot honour", () => {
    const stored = normalizeAgentModel(
      model({ thinkingLevelMap: { low: "low", medium: "medium" } }),
      { perModel: () => "max", global: () => undefined },
    );
    expect(stored.reasoning?.map((option) => option.id)).toContain(stored.defaultReasoningId!);
  });
});

describe("composer", () => {
  test("offers neither a speed toggle nor a mode, because Pi has neither", () => {
    const composer = emptyComposer();
    expect(composer.fastModeAvailable).toBe(false);
    expect(composer.fastModeEnabled).toBeNull();
    expect(composer.modes).toEqual([]);
  });

  test("reports the model and thinking level Pi actually accepted", () => {
    const composer = {
      ...emptyComposer(),
      selectedModelId: "signed-out/model",
      selectedReasoningId: "max",
    };

    const reconciled = reconcileComposerSelection(
      composer,
      model({ provider: "available", id: "fallback" }),
      "high",
    );

    // A stale explicit selection may fall back, but the picker and transcript
    // must never keep claiming the unavailable model actually ran.
    expect(reconciled.selectedModelId).toBe("available/fallback");
    expect(reconciled.selectedReasoningId).toBe("high");
  });
});

describe("default model", () => {
  // The catalogue Pi 1.2.0 listed for a ChatGPT-backed `openai-codex` login,
  // first entry first: that entry is the one the account cannot use. Pi 1.4.0
  // no longer lists either id there; these keep that legacy shape while
  // supplying the backend catalogue separately, as the runtime does.
  const spark = model({ provider: "openai-codex", id: "gpt-5.3-codex-spark" });
  const gpt55 = model({ provider: "openai-codex", id: "gpt-5.5" });
  const backendModel = model({ provider: "openai-codex", id: "gpt-6.1-sol" });
  const kimi = model({ provider: "opencode-go", id: "kimi-k3" });

  function catalogue(models: Model<Api>[]): void {
    setModelRuntimeFactoryForTests(
      async () =>
        ({
          getAvailable: () => Promise.resolve(models),
          getModel: () => undefined,
          getProvider: () => undefined,
          getModels: (provider: string) => (provider === "openai-codex" ? [backendModel] : []),
          isUsingSubscription: (provider: string) => provider === "openai-codex",
        }) as unknown as ModelRuntime,
    );
    refreshModels();
  }

  test("opens a composer with no selection on the first preferred model offered", async () => {
    catalogue([spark, gpt55, kimi]);

    const composer = await hydrateComposer(emptyComposer(), undefined, [
      "signed-out/model",
      "openai-codex/gpt-5.5",
      "opencode-go/kimi-k3",
    ]);

    expect(composer.selectedModelId).toBe("openai-codex/gpt-5.5");
  });

  test("keeps an explicit selection over every preference", async () => {
    catalogue([spark, gpt55, kimi]);

    const composer = await hydrateComposer(
      { ...emptyComposer(), selectedModelId: "opencode-go/kimi-k3" },
      undefined,
      ["openai-codex/gpt-5.5"],
    );

    expect(composer.selectedModelId).toBe("opencode-go/kimi-k3");
  });

  test("falls back to a ChatGPT backend model when no usable preference is offered", async () => {
    catalogue([spark, gpt55, backendModel]);

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe(
      "openai-codex/gpt-6.1-sol",
    );
    expect(
      (await hydrateComposer(emptyComposer(), undefined, ["signed-out/model"])).selectedModelId,
    ).toBe("openai-codex/gpt-6.1-sol");
  });

  test("resolves a missing or stale selection to the first preferred model offered", async () => {
    catalogue([spark, gpt55, backendModel, kimi]);

    expect(await resolveModel(undefined, ["openai-codex/gpt-5.5"])).toBe(gpt55);
    expect(await resolveModel("signed-out/model", ["signed-out/x", "opencode-go/kimi-k3"])).toBe(
      kimi,
    );
    expect(await resolveModel(undefined, ["signed-out/model"])).toBe(backendModel);
    expect(await resolveModel(undefined)).toBe(backendModel);
  });
});

describe("ChatGPT login fallback", () => {
  // The shape Pi 1.4.0 gives a "Sign in with ChatGPT" login under `openai`:
  // the whole OpenAI catalogue, `gpt-4` first, of which the ChatGPT backend
  // refuses `gpt-4` and `gpt-5.5` (seen live 2026-10-23, 0054 runs 1–3).
  const openai = (id: string) => model({ provider: "openai", id });
  const gpt4 = openai("gpt-4");
  const gpt55 = openai("gpt-5.5");
  const gpt6Sol = openai("gpt-6-sol");
  const gpt61Sol = openai("gpt-6.1-sol");
  const anthropic = model({ provider: "anthropic", id: "claude-opus-4-8" });
  /** pi-ai's ChatGPT-backend catalogue, in its own id order. */
  const backend = [
    model({ provider: "openai-codex", id: "gpt-6-sol" }),
    model({ provider: "openai-codex", id: "gpt-6.1-sol" }),
  ];

  function catalogue(
    models: Model<Api>[],
    subscriptions: readonly string[] = ["openai"],
    overrides: Record<string, unknown> = {},
  ): void {
    setModelRuntimeFactoryForTests(
      async () =>
        ({
          getAvailable: () => Promise.resolve(models),
          getModel: () => undefined,
          getModels: (provider: string) => (provider === "openai-codex" ? backend : []),
          getProvider: () => undefined,
          isUsingSubscription: (provider: string) => subscriptions.includes(provider),
          ...overrides,
        }) as unknown as ModelRuntime,
    );
    refreshModels();
  }

  test("opens on the newest model the login runs instead of the refused first model", async () => {
    catalogue([gpt4, gpt55, gpt6Sol, gpt61Sol]);

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe("openai/gpt-6.1-sol");
    expect(
      (await hydrateComposer(emptyComposer(), undefined, ["signed-out/model"])).selectedModelId,
    ).toBe("openai/gpt-6.1-sol");
    expect(await resolveModel(undefined)).toBe(gpt61Sol);
    expect(await resolveModel("signed-out/model", ["signed-out/x"])).toBe(gpt61Sol);
  });

  test("takes the next newest when the catalogue lacks the newest", async () => {
    catalogue([gpt4, gpt55, gpt6Sol]);

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe("openai/gpt-6-sol");
    expect(await resolveModel(undefined)).toBe(gpt6Sol);
  });

  test("an explicit selection and a saved default keep winning", async () => {
    catalogue([gpt4, gpt55, gpt61Sol]);

    expect(
      (await hydrateComposer({ ...emptyComposer(), selectedModelId: "openai/gpt-4" }))
        .selectedModelId,
    ).toBe("openai/gpt-4");
    // Even a saved default the login refuses: only the last fallback changes.
    expect(
      (await hydrateComposer(emptyComposer(), undefined, ["openai/gpt-5.5"])).selectedModelId,
    ).toBe("openai/gpt-5.5");
    expect(await resolveModel(undefined, ["openai/gpt-5.5"])).toBe(gpt55);
  });

  test("an API key on openai keeps the catalogue's first model", async () => {
    catalogue([gpt4, gpt55, gpt61Sol], []);

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe("openai/gpt-4");
    expect(await resolveModel(undefined)).toBe(gpt4);
  });

  test("a first model from another provider is kept", async () => {
    catalogue([anthropic, gpt4, gpt61Sol]);

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe(
      "anthropic/claude-opus-4-8",
    );
    expect(await resolveModel(undefined)).toBe(anthropic);
  });

  test("keeps the first model when the login offers none of the backend's models", async () => {
    catalogue([gpt4, gpt55]);

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe("openai/gpt-4");
    expect(await resolveModel(undefined)).toBe(gpt4);
  });

  test("keeps the first model when the runtime cannot say how the provider signed in", async () => {
    catalogue([gpt4, gpt61Sol], ["openai"], {
      isUsingSubscription: () => {
        throw new Error("no auth snapshot");
      },
    });

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe("openai/gpt-4");
    expect(await resolveModel(undefined)).toBe(gpt4);
  });

  test.each([
    [
      "throws",
      () => {
        throw new Error("backend catalogue unavailable");
      },
    ],
    ["returns a non-array", () => ({ models: backend })],
  ])("keeps the first model when getModels %s", async (_label, getModels) => {
    catalogue([gpt4, gpt61Sol], ["openai"], { getModels });

    expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe("openai/gpt-4");
    expect(await resolveModel(undefined)).toBe(gpt4);
  });

  test("hydrates from the cached catalogue when runtime reconstruction rejects", async () => {
    catalogue([gpt4, gpt61Sol]);
    // Populate the catalogue before losing the runtime, so this exercises the
    // fallback's runtime read, rather than listModels returning an empty list.
    const cached = await listModels();
    let attempts = 0;
    setModelRuntimeFactoryForTests(async () => {
      attempts += 1;
      throw new Error("runtime unavailable");
    });

    const composer = await hydrateComposer(emptyComposer());

    expect(attempts).toBe(1);
    expect(composer.models).toEqual(cached);
    expect(composer.selectedModelId).toBe("openai/gpt-4");
  });

  test("ignores a subscription on a provider no ChatGPT login uses", () => {
    const runtime = {
      getModels: () => backend,
      isUsingSubscription: () => true,
    };

    expect(chatGptLoginModelIds(runtime, "anthropic")).toEqual([]);
    expect(chatGptLoginModelIds(runtime, "openai")).toEqual([
      "openai/gpt-6.1-sol",
      "openai/gpt-6-sol",
    ]);
    expect(chatGptLoginModelIds(runtime, "openai-codex")).toEqual([
      "openai-codex/gpt-6.1-sol",
      "openai-codex/gpt-6-sol",
    ]);
  });
});

describe("ChatGPT login fallback against the pinned SDK", () => {
  // Fake tokens that never expire, so no refresh is attempted and no network
  // is needed: these read only the catalogue and the credential's type.
  const oauth = {
    type: "oauth",
    access: "fixture",
    refresh: "fixture",
    expires: 9_999_999_999_999,
  };

  async function sdkCatalogue(credentials: Record<string, unknown>): Promise<() => Promise<void>> {
    const root = await mkdtemp(join(tmpdir(), "pi-chatgpt-fallback-"));
    await writeFile(join(root, "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
    setModelRuntimeFactoryForTests(() =>
      ModelRuntime.create({
        authPath: join(root, "auth.json"),
        modelsPath: join(root, "models.json"),
        allowModelNetwork: false,
      }),
    );
    refreshModels();
    return () => rm(root, { recursive: true, force: true });
  }

  test("a ChatGPT login under openai opens on a backend model, not gpt-4", async () => {
    const cleanup = await sdkCatalogue({ openai: oauth });
    try {
      const composer = await hydrateComposer(emptyComposer());
      // The premise this fix rests on: the catalogue still starts on a model
      // the login refuses. If a Pi bump changes that, revisit the fallback.
      expect(composer.models[0]?.id).toBe("openai/gpt-4");
      expect(composer.selectedModelId).toBe("openai/gpt-6.1-sol");
      const resolved = await resolveModel(undefined);
      expect(resolved && composeModelId(resolved.provider, resolved.id)).toBe("openai/gpt-6.1-sol");
    } finally {
      await cleanup();
    }
  });

  test("every backend model is in the openai catalogue a ChatGPT login lists", async () => {
    const cleanup = await sdkCatalogue({ openai: oauth });
    try {
      const listed = (await listModels()).map((entry) => entry.id);
      const backend = (await modelRuntime())
        .getModels("openai-codex")
        .map((entry) => `openai/${entry.id}`);
      expect(backend.length).toBeGreaterThan(0);
      expect(backend.filter((id) => !listed.includes(id))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("a legacy openai-codex login opens on the newest backend model", async () => {
    const cleanup = await sdkCatalogue({ "openai-codex": { ...oauth, accountId: "fixture" } });
    try {
      expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe(
        "openai-codex/gpt-6.1-sol",
      );
    } finally {
      await cleanup();
    }
  });

  test("an openai API key keeps the catalogue's first model", async () => {
    const cleanup = await sdkCatalogue({ openai: { type: "api_key", key: "sk-fixture" } });
    try {
      expect((await hydrateComposer(emptyComposer())).selectedModelId).toBe("openai/gpt-4");
    } finally {
      await cleanup();
    }
  });
});
