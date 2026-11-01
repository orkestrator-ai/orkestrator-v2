import { beforeEach, describe, expect, test } from "bun:test";
import { useClaudeOptionsStore } from "./claudeOptionsStore";

describe("claudeOptionsStore", () => {
  beforeEach(() => {
    useClaudeOptionsStore.setState({
      options: {},
    });
  });

  test("stores and clears launch options per environment", () => {
    useClaudeOptionsStore.getState().setOptions("env-1", {
      launchAgent: true,
      agentType: "codex",
      initialPrompt: "Fix tests",
    });

    expect(useClaudeOptionsStore.getState().getOptions("env-1")).toEqual({
      launchAgent: true,
      agentType: "codex",
      initialPrompt: "Fix tests",
    });
    expect(useClaudeOptionsStore.getState().getOptions("env-2")).toBeUndefined();

    useClaudeOptionsStore.getState().clearOptions("env-1");

    expect(useClaudeOptionsStore.getState().getOptions("env-1")).toBeUndefined();
  });

  test("round-trips one-shot model and reasoning effort", () => {
    const store = useClaudeOptionsStore.getState();
    store.setOptions("env-1", {
      launchAgent: true,
      agentType: "codex",
      initialPrompt: "Fix tests",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(useClaudeOptionsStore.getState().getOptions("env-1")).toEqual(
      expect.objectContaining({ model: "gpt-5.6-sol", reasoningEffort: "high" }),
    );

    store.clearOptions("env-1");
    expect(useClaudeOptionsStore.getState().getOptions("env-1")).toBeUndefined();
  });

  test("stores initial prompt attachments with launch options", () => {
    useClaudeOptionsStore.getState().setOptions("env-1", {
      launchAgent: true,
      agentType: "claude",
      initialPrompt: "Use this image",
      initialPromptAttachments: [
        {
          id: "img-1",
          name: "screenshot.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
      ],
    });

    expect(useClaudeOptionsStore.getState().getOptions("env-1")).toEqual({
      launchAgent: true,
      agentType: "claude",
      initialPrompt: "Use this image",
      initialPromptAttachments: [
        {
          id: "img-1",
          name: "screenshot.png",
          previewUrl: "data:image/png;base64,QUJD",
          base64Data: "QUJD",
        },
      ],
    });
  });
});
