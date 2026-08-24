import { describe, expect, test } from "bun:test";
import type { AgentModel, NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { emptyComposer, modelSelection } from "./models.js";

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
