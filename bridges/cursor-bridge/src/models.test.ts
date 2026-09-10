import { describe, expect, test } from "bun:test";
import type { ModelListItem } from "@cursor/sdk";
import type { AgentModel, NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { __testing, contextWindowForModelId, emptyComposer, modelSelection } from "./models.js";

/** Shaped like a real Cursor model: an effort axis plus a speed toggle. */
const opus: AgentModel = {
  platform: "cursor",
  id: "claude-opus-5",
  label: "Claude Opus 5",
  reasoning: [
    { id: "low", label: "low" },
    { id: "high", label: "high" },
  ],
  defaultReasoningId: "high",
  supportsSpeed: true,
  supportsMode: true,
};

/** Cursor's "Auto" exposes neither axis. */
const auto: AgentModel = {
  platform: "cursor",
  id: "default",
  label: "Auto",
  supportsMode: true,
};

function composerWith(patch: Partial<NativeAgentComposerState>): NativeAgentComposerState {
  return { ...emptyComposer(), models: [opus, auto], ...patch };
}

describe("modelSelection", () => {
  test("maps the reasoning axis onto Cursor's effort parameter", () => {
    expect(
      modelSelection(
        composerWith({ selectedModelId: "claude-opus-5", selectedReasoningId: "low" }),
      ),
    ).toEqual({ id: "claude-opus-5", params: [{ id: "effort", value: "low" }] });
  });

  test("maps the speed toggle onto Cursor's fast parameter", () => {
    expect(
      modelSelection(composerWith({ selectedModelId: "claude-opus-5", fastModeEnabled: true })),
    ).toEqual({ id: "claude-opus-5", params: [{ id: "fast", value: "true" }] });
    // False is a real selection, not an absent one.
    expect(
      modelSelection(composerWith({ selectedModelId: "claude-opus-5", fastModeEnabled: false })),
    ).toEqual({ id: "claude-opus-5", params: [{ id: "fast", value: "false" }] });
  });

  test("sends both axes together when both are selected", () => {
    expect(
      modelSelection(
        composerWith({
          selectedModelId: "claude-opus-5",
          selectedReasoningId: "high",
          fastModeEnabled: true,
        }),
      ),
    ).toEqual({
      id: "claude-opus-5",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
  });

  test("drops an axis the selected model does not declare", () => {
    // The SDK rejects the whole send on an unknown parameter, so a stale
    // effort carried onto Auto would fail the turn rather than be ignored.
    expect(
      modelSelection(
        composerWith({
          selectedModelId: "default",
          selectedReasoningId: "high",
          fastModeEnabled: true,
        }),
      ),
    ).toEqual({ id: "default" });
  });

  test("drops an effort value the model does not offer", () => {
    expect(
      modelSelection(
        composerWith({ selectedModelId: "claude-opus-5", selectedReasoningId: "ultra" }),
      ),
    ).toEqual({ id: "claude-opus-5" });
  });

  test("omits params entirely rather than sending an empty array", () => {
    expect(modelSelection(composerWith({ selectedModelId: "claude-opus-5" }))).toEqual({
      id: "claude-opus-5",
    });
  });

  test("falls back to a known model so a session can still start", () => {
    // Reached when the catalogue could not be read at all.
    expect(modelSelection(emptyComposer()).id).toBe("composer-2");
  });

  test("sends no params when the catalogue is unavailable to validate against", () => {
    const blind = { ...emptyComposer(), selectedModelId: "x", selectedReasoningId: "high" };
    expect(modelSelection(blind)).toEqual({ id: "x" });
  });

  test("sends remaining model parameters without a variant bundle", () => {
    const grok: AgentModel = {
      ...opus,
      id: "grok-4-6",
      label: "Cursor Grok 4.6",
      parameters: [
        {
          id: "thinking",
          label: "Thinking",
          kind: "select",
          options: [{ id: "high", label: "High" }],
          scope: "turn",
        },
      ],
    };
    expect(
      modelSelection({
        ...emptyComposer(),
        models: [grok],
        selectedModelId: "grok-4-6",
        selectedReasoningId: "high",
        fastModeEnabled: true,
        // A leftover encoded variant used to replace every other axis. It must
        // stay ignored now that the cross-product picker is gone.
        parameterValues: {
          thinking: "high",
          variant: JSON.stringify([{ id: "effort", value: "low" }]),
        },
      }),
    ).toEqual({
      id: "grok-4-6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
        { id: "thinking", value: "high" },
      ],
    });
  });
});

describe("model catalogue", () => {
  test("normalizes independent controls and retains defaults without a variant parameter", () => {
    const item: ModelListItem = {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      parameters: [
        {
          id: "effort",
          displayName: "Effort",
          values: [
            { value: "low", displayName: "Low" },
            { value: "high", displayName: "High" },
          ],
        },
        {
          id: "fast",
          displayName: "Fast",
          values: [{ value: "true" }, { value: "false" }],
        },
        {
          id: "thinking",
          displayName: "Thinking",
          values: [
            { value: "adaptive", displayName: "Adaptive" },
            { value: "high", displayName: "High" },
          ],
        },
      ],
      variants: [
        {
          displayName: "Claude Opus 5",
          isDefault: true,
          params: [
            { id: "effort", value: "high" },
            { id: "fast", value: "false" },
            { id: "thinking", value: "adaptive" },
          ],
        },
        {
          displayName: "Claude Opus 5",
          params: [
            { id: "effort", value: "low" },
            { id: "fast", value: "true" },
            { id: "thinking", value: "high" },
          ],
        },
      ],
    };

    const normalized = __testing.normalizeModel(item);

    expect(normalized).toMatchObject({
      id: "claude-opus-5",
      defaultReasoningId: "high",
      supportsSpeed: true,
      parameters: [
        {
          id: "thinking",
          kind: "select",
          defaultValue: "adaptive",
          options: [
            { id: "adaptive", label: "Adaptive" },
            { id: "high", label: "High" },
          ],
        },
      ],
    });
    expect(normalized.parameters?.map((parameter) => parameter.id)).toEqual(["thinking"]);
  });

  test("drops legacy variant state during hydration without dropping adjacent values", () => {
    const hydrated = __testing.hydrateComposerWithModels(
      {
        ...emptyComposer(),
        selectedModelId: opus.id,
        selectedReasoningId: "high",
        fastModeEnabled: false,
        parameterValues: {
          variant: JSON.stringify([{ id: "effort", value: "low" }]),
          thinking: "adaptive",
          audit: true,
        },
      },
      [opus],
    );

    expect(hydrated.parameterValues).toEqual({
      thinking: "adaptive",
      audit: true,
      effort: "high",
      fast: false,
    });
  });
});

describe("emptyComposer", () => {
  test("offers exactly the two modes the shared composer models", () => {
    const composer = emptyComposer();
    expect(composer.modes).toEqual([
      { id: "build", label: "Agent" },
      { id: "plan", label: "Plan" },
    ]);
    expect(composer.selectedModeId).toBe("build");
  });

  test("reports no speed control until a model says it has one", () => {
    expect(emptyComposer().fastModeAvailable).toBe(false);
    expect(emptyComposer().fastModeEnabled).toBeNull();
  });
});

describe("context windows", () => {
  test("normalizes confirmed windows onto the catalogue entry", () => {
    const grok: ModelListItem = { id: "grok-4-6", displayName: "Cursor Grok 4.6" };
    const opus: ModelListItem = { id: "claude-opus-5", displayName: "Claude Opus 5" };
    expect(__testing.normalizeModel(grok).contextWindow).toBe(500_000);
    expect(__testing.normalizeModel(opus).contextWindow).toBe(1_000_000);
  });

  test("leaves unconfirmed models without a window rather than guessing", () => {
    const unknown: ModelListItem = { id: "composer-2", displayName: "Composer" };
    expect(__testing.normalizeModel(unknown).contextWindow).toBeUndefined();
    expect(contextWindowForModelId("composer-2")).toBeUndefined();
    expect(contextWindowForModelId(undefined)).toBeUndefined();
  });

  test("normalizes separators and ignores the fast suffix", () => {
    expect(contextWindowForModelId("grok-4.6")).toBe(500_000);
    expect(contextWindowForModelId("grok-4-6-fast")).toBe(500_000);
    expect(contextWindowForModelId("Claude-Opus-5")).toBe(1_000_000);
  });

  test("answers an inherited object key with no window", () => {
    // The composer stores whatever model id the client names, so these reach
    // the table verbatim. A plain object would answer `constructor` with the
    // `Object` function and hand the gauge a non-number as its denominator.
    for (const key of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(contextWindowForModelId(key)).toBeUndefined();
    }
  });

  test("ignores whitespace and blank ids", () => {
    expect(contextWindowForModelId("  grok-4-6  ")).toBe(500_000);
    expect(contextWindowForModelId("   ")).toBeUndefined();
    expect(contextWindowForModelId("")).toBeUndefined();
    // `-fast` is a suffix on a known model, never a model of its own.
    expect(contextWindowForModelId("-fast")).toBeUndefined();
  });
});
