import { describe, expect, test } from "bun:test";
import type { NativeAgentComposerState } from "@orkestrator/protocol/native-agent";
import { queuedPromptControlRestore } from "./queued-prompt-controls";

const composer: NativeAgentComposerState = {
  models: [],
  selectedModelId: "opus",
  selectedReasoningId: "high",
  fastModeEnabled: false,
  fastModeAvailable: true,
  selectedModeId: "build",
  modes: [],
  includeLocalSettings: true,
  promptSuggestionsEnabled: false,
};

describe("queuedPromptControlRestore", () => {
  test("asks for nothing when the prompt was queued with the composer's settings", () => {
    expect(
      queuedPromptControlRestore(
        {
          model: "opus",
          reasoningEffort: "high",
          mode: "build",
          fastMode: false,
          agent: "general",
          includeLocalSettings: true,
          promptSuggestions: false,
        },
        composer,
        "general",
      ),
    ).toEqual({});
  });

  test("returns only the selections that differ", () => {
    expect(
      queuedPromptControlRestore(
        { model: "opus", reasoningEffort: "low", mode: "plan", fastMode: true },
        composer,
        undefined,
      ),
    ).toEqual({ reasoningId: "low", mode: "plan", fastMode: true });
  });

  test("a model change carries the queued reasoning even when it matches", () => {
    expect(
      queuedPromptControlRestore({ model: "sonnet", reasoningEffort: "high" }, composer, undefined),
    ).toEqual({ modelId: "sonnet", reasoningId: "high" });
  });

  test("prefers the execution agent over the subagent and compares it with the selection", () => {
    expect(
      queuedPromptControlRestore({ executionAgent: "plan", agent: "general" }, composer, "build"),
    ).toEqual({ executionProfileId: "plan" });
    expect(queuedPromptControlRestore({ agent: "general" }, composer, "general")).toEqual({});
  });

  test("restores every queued selection when the composer is unknown", () => {
    expect(
      queuedPromptControlRestore(
        { model: "opus", reasoningEffort: "high", mode: "plan", promptSuggestions: true },
        undefined,
        undefined,
      ),
    ).toEqual({ modelId: "opus", reasoningId: "high", mode: "plan", promptSuggestions: true });
  });
});
