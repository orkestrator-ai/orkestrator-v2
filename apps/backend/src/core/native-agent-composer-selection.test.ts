import { describe, expect, test } from "bun:test";
import {
  lastAssistantModelRef,
  openCodeComposerSelectionToPersist,
} from "./native-agent-composer-selection.js";

describe("lastAssistantModelRef", () => {
  test("reads a normalized assistant modelId", () => {
    expect(
      lastAssistantModelRef([
        { role: "user", content: "go" },
        { role: "assistant", modelId: "opencode-go/deepseek-v4-flash", reasoningId: "default" },
      ]),
    ).toEqual({
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "default",
    });
  });

  test("reads OpenCode info.providerID/modelID", () => {
    expect(
      lastAssistantModelRef([
        {
          info: {
            role: "assistant",
            providerID: "opencode-go",
            modelID: "deepseek-v4-flash",
            variant: "default",
          },
        },
      ]),
    ).toEqual({
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "default",
    });
  });

  test("ignores earlier assistants once a later one reports a model", () => {
    expect(
      lastAssistantModelRef([
        { role: "assistant", modelId: "opencode/nemotron-ultra-free" },
        { role: "assistant", modelId: "opencode-go/deepseek-v4-flash" },
      ]),
    ).toEqual({ modelId: "opencode-go/deepseek-v4-flash" });
  });
});

describe("openCodeComposerSelectionToPersist", () => {
  test("does not persist when host controls already have a model", () => {
    expect(
      openCodeComposerSelectionToPersist({
        sessionControlsModelId: "opencode-go/deepseek-v4-flash",
        lastAssistantModelId: "opencode/nemotron-ultra-free",
        sessionModelId: "opencode/nemotron-ultra-free",
      }),
    ).toBeUndefined();
  });

  test("persists the last assistant model before OpenCode session.model", () => {
    expect(
      openCodeComposerSelectionToPersist({
        lastAssistantModelId: "opencode-go/deepseek-v4-flash",
        lastAssistantReasoningId: "default",
        sessionModelId: "opencode/nemotron-ultra-free",
      }),
    ).toEqual({
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "default",
    });
  });

  test("persists OpenCode session.model when no assistant model is known", () => {
    expect(
      openCodeComposerSelectionToPersist({
        sessionModelId: "opencode-go/deepseek-v4-flash",
        sessionReasoningId: "default",
      }),
    ).toEqual({
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "default",
    });
  });
});
