import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  composeModelId,
  DEFAULT_THINKING_LEVEL,
  emptyComposer,
  modelLocalId,
  modelProviderId,
  normalizeAgentModel,
  reconcileComposerSelection,
  thinkingLevel,
} from "./models.js";

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
