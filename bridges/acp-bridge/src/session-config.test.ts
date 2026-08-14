import { describe, expect, test } from "bun:test";
import {
  applyCurrentModeUpdate,
  applyGrokCatalogUpdate,
  applyGrokModelChange,
  mergeComposerCatalog,
  normalizeAcpSessionConfig,
  parsePersistedAcpSessionConfig,
  parsePersistedComposerState,
  planComposerApply,
  MAX_CATALOG_MODELS,
  MAX_REASONING_OPTIONS,
} from "./session-config";

function grokConfig() {
  return normalizeAcpSessionConfig("grok", {
    modes: {
      currentModeId: "agent",
      availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }],
    },
    models: {
      currentModelId: "grok-build",
      availableModels: [{
        modelId: "grok-build",
        name: "Grok Build",
        _meta: { reasoningEffort: "high", reasoningEfforts: [{ value: "low" }, { value: "high" }] },
      }],
    },
  });
}

describe("normalizeAcpSessionConfig", () => {
  test("maps Cursor modes and parameterized config options into the shared composer", () => {
    const { composer, wire } = normalizeAcpSessionConfig("cursor", {
      sessionId: "sess",
      modes: {
        currentModeId: "agent",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "plan", name: "Plan" },
          { id: "ask", name: "Ask" },
        ],
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "composer-2.5",
          options: [
            { value: "composer-2.5", name: "Composer 2.5" },
            { value: "gpt-5.5", name: "GPT-5.5" },
          ],
        },
        {
          configId: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "high",
          options: [
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
        {
          configId: "fast",
          category: "model_config",
          type: "boolean",
          currentValue: false,
        },
      ],
    });

    expect(wire.availableModeIds).toEqual({ build: "agent", plan: "plan" });
    expect(composer.selectedModeId).toBe("build");
    expect(composer.modes.map((mode) => mode.id)).toEqual(["build", "plan"]);
    expect(composer.selectedModelId).toBe("composer-2.5");
    expect(composer.models.map((model) => model.id)).toEqual(["composer-2.5", "gpt-5.5"]);
    expect(composer.models[0]).toMatchObject({
      platform: "cursor",
      label: "Composer 2.5",
      supportsSpeed: true,
      supportsMode: true,
    });
    expect(composer.selectedReasoningId).toBe("high");
    expect(composer.fastModeAvailable).toBe(true);
    expect(composer.fastModeEnabled).toBe(false);
  });

  test("keeps modes when Cursor advertises an empty model list", () => {
    const { composer } = normalizeAcpSessionConfig("cursor", {
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "agent", name: "Agent" },
          { id: "plan", name: "Plan" },
        ],
      },
      configOptions: [
        { id: "model", category: "model", type: "select", currentValue: "", options: [] },
      ],
    });
    expect(composer.models).toEqual([]);
    expect(composer.selectedModeId).toBe("plan");
    expect(composer.modes).toHaveLength(2);
  });

  test("reads Grok availableModels and per-model reasoning from _meta", () => {
    const { composer, wire } = normalizeAcpSessionConfig("grok", {
      models: {
        currentModelId: "grok-build",
        availableModels: [
          {
            modelId: "grok-build",
            name: "Grok Build",
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: "high",
              reasoningEfforts: [{ value: "low" }, { value: "high" }, { value: "xhigh" }],
            },
          },
          {
            modelId: "grok-composer-2.5-fast",
            name: "Composer 2.5 Fast",
            _meta: { reasoningEfforts: ["low", "high"] },
          },
        ],
      },
    });

    expect(wire.usesSetModel).toBe(true);
    expect(composer.selectedModelId).toBe("grok-build");
    expect(composer.selectedReasoningId).toBe("high");
    expect(composer.models[0]?.reasoning?.map((option) => option.id)).toEqual(["low", "high", "xhigh"]);
    expect(composer.models[0]?.reasoning?.find((option) => option.id === "xhigh")?.label).toBe("Extra high");
    expect(composer.models[1]?.id).toBe("grok-composer-2.5-fast");
  });
});

describe("planComposerApply", () => {
  test("uses session/set_config_option for Cursor parameterized pickers", () => {
    const normalized = normalizeAcpSessionConfig("cursor", {
      modes: {
        currentModeId: "agent",
        availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }],
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "composer-2.5",
          options: [{ value: "composer-2.5", name: "Composer 2.5" }, { value: "gpt-5.5", name: "GPT-5.5" }],
        },
        {
          configId: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }],
        },
        { configId: "fast", category: "model_config", type: "boolean", currentValue: false },
      ],
    });

    expect(planComposerApply("sess", normalized, {
      modelId: "gpt-5.5",
      reasoningId: "high",
      fastMode: true,
      mode: "plan",
    })).toEqual([
      { method: "session/set_mode", params: { sessionId: "sess", modeId: "plan" } },
      { method: "session/set_config_option", params: { sessionId: "sess", configId: "model", value: "gpt-5.5" } },
      { method: "session/set_config_option", params: { sessionId: "sess", configId: "thought_level", value: "high" } },
      {
        method: "session/set_config_option",
        params: { sessionId: "sess", configId: "fast", type: "boolean", value: true },
      },
    ]);
  });

  test("uses session/set_model with reasoningEffort for Grok", () => {
    const normalized = normalizeAcpSessionConfig("grok", {
      models: {
        currentModelId: "grok-build",
        availableModels: [
          {
            modelId: "grok-build",
            name: "Grok Build",
            _meta: { reasoningEffort: "high", reasoningEfforts: [{ value: "low" }, { value: "high" }] },
          },
          { modelId: "grok-composer-2.5-fast", name: "Composer Fast" },
        ],
      },
    });

    expect(planComposerApply("sess", normalized, {
      modelId: "grok-composer-2.5-fast",
    })).toEqual([
      {
        method: "session/set_model",
        params: { sessionId: "sess", modelId: "grok-composer-2.5-fast" },
      },
    ]);
    expect(planComposerApply("sess", normalized, { reasoningId: "low" })).toEqual([
      {
        method: "session/set_model",
        params: {
          sessionId: "sess",
          modelId: "grok-build",
          _meta: { reasoningEffort: "low" },
        },
      },
    ]);
  });
});

describe("session config updates", () => {
  test("maps a current_mode_update onto Build/Plan", () => {
    const normalized = normalizeAcpSessionConfig("cursor", {
      modes: {
        currentModeId: "agent",
        availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }],
      },
    });
    expect(applyCurrentModeUpdate(normalized, "plan").composer.selectedModeId).toBe("plan");
  });

  test("applies a Grok model_changed notification without exposing _meta", () => {
    const normalized = normalizeAcpSessionConfig("grok", {
      models: {
        currentModelId: "grok-build",
        availableModels: [
          {
            modelId: "grok-build",
            name: "Grok Build",
            _meta: { reasoningEffort: "high", reasoningEfforts: [{ value: "low" }, { value: "high" }] },
          },
        ],
      },
    });
    const next = applyGrokModelChange("grok", normalized, {
      sessionUpdate: "model_changed",
      model_id: "grok-build",
      reasoning_effort: "low",
    });
    expect(next.composer.selectedReasoningId).toBe("low");
    expect(JSON.stringify(next.composer)).not.toContain("_meta");
  });

  test("merges live catalogs by model id", () => {
    const first = normalizeAcpSessionConfig("cursor", {
      configOptions: [{
        id: "model",
        category: "model",
        type: "select",
        currentValue: "a",
        options: [{ value: "a", name: "A" }],
      }],
    });
    const second = normalizeAcpSessionConfig("cursor", {
      configOptions: [{
        id: "model",
        category: "model",
        type: "select",
        currentValue: "b",
        options: [{ value: "a", name: "A" }, { value: "b", name: "B" }],
      }],
    });
    expect(mergeComposerCatalog("cursor", [first.composer, second.composer]).map((model) => model.id))
      .toEqual(["a", "b"]);
  });
});

describe("applyGrokCatalogUpdate", () => {
  test("replaces the catalogue from a flat models array and keeps the modes", () => {
    const next = applyGrokCatalogUpdate("grok", grokConfig(), {
      currentModelId: "grok-next",
      models: [
        { modelId: "grok-build", name: "Grok Build" },
        { modelId: "grok-next", name: "Grok Next" },
      ],
    });
    expect(next.composer.models.map((model) => model.id)).toEqual(["grok-build", "grok-next"]);
    expect(next.composer.selectedModelId).toBe("grok-next");
    // Modes are not carried on a models update, so they must be preserved from
    // the config being updated rather than silently dropped.
    expect(next.composer.modes.map((mode) => mode.id)).toEqual(["build", "plan"]);
    expect(next.wire.availableModeIds).toEqual({ build: "agent", plan: "plan" });
  });

  test("reads the nested models.availableModels shape and snake_case ids", () => {
    const next = applyGrokCatalogUpdate("grok", grokConfig(), {
      current_model_id: "grok-next",
      models: { availableModels: [{ modelId: "grok-next", name: "Grok Next" }] },
    });
    expect(next.composer.models.map((model) => model.id)).toEqual(["grok-next"]);
    expect(next.composer.selectedModelId).toBe("grok-next");
  });

  test("keeps the current selection when the update names no model", () => {
    const next = applyGrokCatalogUpdate("grok", grokConfig(), {
      availableModels: [
        { modelId: "grok-build", name: "Grok Build" },
        { modelId: "grok-next", name: "Grok Next" },
      ],
    });
    expect(next.composer.selectedModelId).toBe("grok-build");
  });

  test("falls back to a single model change when no catalogue is present", () => {
    const next = applyGrokCatalogUpdate("grok", grokConfig(), {
      model_id: "grok-build",
      reasoning_effort: "low",
    });
    expect(next.composer.models.map((model) => model.id)).toEqual(["grok-build"]);
    expect(next.composer.selectedReasoningId).toBe("low");
  });

  test("keeps the existing catalogue when the update advertises no usable model", () => {
    const current = grokConfig();
    const next = applyGrokCatalogUpdate("grok", current, { models: [{ name: "no id" }] });
    expect(next.composer.models.map((model) => model.id)).toEqual(["grok-build"]);
  });
});

// The normalizer writes the state file that this validator reads back. Anything
// the normalizer can emit but the validator rejects is state the bridge would
// persist and then refuse, so these round-trips are the contract between them.
describe("persisted session config", () => {
  test("round-trips a normalized Cursor config through the validator", () => {
    const normalized = normalizeAcpSessionConfig("cursor", {
      modes: {
        currentModeId: "agent",
        availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }],
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          currentValue: "composer-2.5",
          options: [{ value: "composer-2.5", name: "Composer 2.5" }, { value: "gpt-5.5", name: "GPT-5.5" }],
        },
        { id: "fast", category: "model_config", type: "boolean", currentValue: true },
      ],
    });
    const restored = parsePersistedAcpSessionConfig(
      "cursor",
      JSON.parse(JSON.stringify(normalized)),
    );
    expect(restored).toEqual(normalized);
  });

  test("round-trips a normalized Grok config through the validator", () => {
    const normalized = grokConfig();
    expect(parsePersistedAcpSessionConfig("grok", JSON.parse(JSON.stringify(normalized))))
      .toEqual(normalized);
  });

  test("round-trips a catalogue the normalizer built from duplicate vendor ids", () => {
    // The vendor is free to repeat an id; the normalizer deduplicates so the
    // validator's uniqueness rule can never reject the normalizer's own output.
    const normalized = normalizeAcpSessionConfig("grok", {
      models: {
        currentModelId: "grok-build",
        availableModels: [
          { modelId: "grok-build", name: "Grok Build" },
          { modelId: "grok-build", name: "Grok Build (again)" },
        ],
      },
    });
    expect(normalized.composer.models.map((model) => model.id)).toEqual(["grok-build"]);
    expect(parsePersistedAcpSessionConfig("grok", JSON.parse(JSON.stringify(normalized))))
      .toEqual(normalized);
  });

  test("bounds an oversized vendor catalogue to what the validator accepts", () => {
    const normalized = normalizeAcpSessionConfig("grok", {
      models: {
        availableModels: Array.from({ length: MAX_CATALOG_MODELS + 25 }, (_unused, index) => ({
          modelId: `grok-${index}`,
          name: `Grok ${index}`,
          _meta: {
            reasoningEfforts: Array.from(
              { length: MAX_REASONING_OPTIONS + 5 },
              (_ignored, effort) => `effort-${effort}`,
            ),
          },
        })),
      },
    });
    expect(normalized.composer.models).toHaveLength(MAX_CATALOG_MODELS);
    expect(normalized.composer.models[0]?.reasoning).toHaveLength(MAX_REASONING_OPTIONS);
    expect(parsePersistedAcpSessionConfig("grok", JSON.parse(JSON.stringify(normalized))))
      .not.toBeNull();
  });

  test("rejects structurally wrong persisted state", () => {
    expect(parsePersistedAcpSessionConfig("cursor", undefined)).toBeNull();
    expect(parsePersistedAcpSessionConfig("cursor", { composer: {}, wire: {} })).toBeNull();
    expect(parsePersistedAcpSessionConfig("cursor", {
      composer: { models: [], modes: [], fastModeAvailable: false, fastModeEnabled: null },
      wire: { configOptions: [], availableModeIds: {}, usesSetModel: "no" },
    })).toBeNull();
  });

  test("rejects a catalogue belonging to a different provider", () => {
    const normalized = grokConfig();
    expect(parsePersistedAcpSessionConfig("cursor", JSON.parse(JSON.stringify(normalized))))
      .toBeNull();
  });

  test("rejects duplicate model ids and duplicate reasoning ids", () => {
    const model = {
      platform: "grok",
      id: "grok-build",
      label: "Grok Build",
      reasoning: [{ id: "low", label: "Low" }, { id: "low", label: "Low again" }],
    };
    expect(parsePersistedComposerState("grok", {
      models: [model],
      modes: [],
      fastModeAvailable: false,
      fastModeEnabled: null,
    })).toBeNull();
    expect(parsePersistedComposerState("grok", {
      models: [{ ...model, reasoning: undefined }, { ...model, reasoning: undefined }],
      modes: [],
      fastModeAvailable: false,
      fastModeEnabled: null,
    })).toBeNull();
  });

  test("accepts a legacy composer-only snapshot", () => {
    const composer = grokConfig().composer;
    expect(parsePersistedComposerState("grok", JSON.parse(JSON.stringify(composer))))
      .toEqual(composer);
  });
});
