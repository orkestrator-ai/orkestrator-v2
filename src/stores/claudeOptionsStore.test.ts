import { beforeEach, describe, expect, test } from "bun:test";
import { useClaudeOptionsStore } from "./claudeOptionsStore";

describe("claudeOptionsStore", () => {
  beforeEach(() => {
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {},
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

  test("stores and clears pending native launches per environment", () => {
    useClaudeOptionsStore.getState().setPendingNativeLaunch("env-1", {
      containerId: "container-1",
      environmentId: "env-1",
      initialPrompt: "Continue after setup",
      targetPaneId: "default",
      agentType: "codex",
    });

    useClaudeOptionsStore.getState().setPendingNativeLaunch("env-2", {
      containerId: null,
      environmentId: "env-2",
      targetPaneId: "default",
      agentType: "claude",
    });

    expect(
      useClaudeOptionsStore.getState().getPendingNativeLaunch("env-1")
    ).toEqual({
      containerId: "container-1",
      environmentId: "env-1",
      initialPrompt: "Continue after setup",
      targetPaneId: "default",
      agentType: "codex",
    });

    useClaudeOptionsStore.getState().clearPendingNativeLaunch("env-1");

    expect(
      useClaudeOptionsStore.getState().getPendingNativeLaunch("env-1")
    ).toBeUndefined();
    expect(
      useClaudeOptionsStore.getState().getPendingNativeLaunch("env-2")
    ).toEqual({
      containerId: null,
      environmentId: "env-2",
      targetPaneId: "default",
      agentType: "claude",
    });
  });

  test("clearing transient options does not clear a pending native launch", () => {
    useClaudeOptionsStore.getState().setOptions("env-1", {
      launchAgent: true,
      agentType: "opencode",
      initialPrompt: "Start after setup",
    });
    useClaudeOptionsStore.getState().setPendingNativeLaunch("env-1", {
      containerId: "container-1",
      environmentId: "env-1",
      initialPrompt: "Start after setup",
      targetPaneId: "default",
      agentType: "opencode",
    });

    useClaudeOptionsStore.getState().clearOptions("env-1");

    expect(useClaudeOptionsStore.getState().getOptions("env-1")).toBeUndefined();
    expect(
      useClaudeOptionsStore.getState().getPendingNativeLaunch("env-1")
    ).toEqual({
      containerId: "container-1",
      environmentId: "env-1",
      initialPrompt: "Start after setup",
      targetPaneId: "default",
      agentType: "opencode",
    });
  });
});
