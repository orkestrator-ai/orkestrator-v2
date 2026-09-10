import { describe, expect, test } from "bun:test";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AppConfig } from "@/types";
import type { ClaudeOptions } from "./CreateEnvironmentDialog";
import {
  resolveEnvironmentAgentLaunchSettings,
  usesNativeStartupAgentTab,
} from "./CreateEnvironmentFlowDialog";

const config = {
  global: { agentSettings: {} },
  repositories: {},
} as Pick<AppConfig, "global" | "repositories">;

function settings(
  defaultAgent: AgentSettingsTier["defaultAgent"],
  mode: "native" | "terminal",
  claudeNativeBackend?: "sdk" | "tmux",
): AgentSettingsTier {
  return {
    defaultAgent,
    platforms: {
      [defaultAgent!]: { mode, claudeNativeBackend },
    },
  };
}

describe("usesNativeStartupAgentTab", () => {
  test("includes native Codex and Claude SDK launches", () => {
    expect(usesNativeStartupAgentTab(config, "project-1", settings("codex", "native"))).toBe(true);
    expect(
      usesNativeStartupAgentTab(config, "project-1", settings("claude", "native", "sdk")),
    ).toBe(true);
  });

  test("excludes terminal launches and Claude native tmux", () => {
    expect(usesNativeStartupAgentTab(config, "project-1", settings("claude", "terminal"))).toBe(
      false,
    );
    expect(
      usesNativeStartupAgentTab(config, "project-1", settings("claude", "native", "tmux")),
    ).toBe(false);
  });
});

function launchOptions(overrides: Partial<ClaudeOptions>): ClaudeOptions {
  return {
    agentType: "claude",
    launchAgent: true,
    model: "sonnet",
    reasoningEffort: "high",
    initialPrompt: "",
    initialPromptAttachments: [],
    ...overrides,
  } as ClaudeOptions;
}

describe("resolveEnvironmentAgentLaunchSettings", () => {
  test("carries the dialog's Fast choice alongside the model and reasoning level", () => {
    // These three travel together: the backend applies each as a one-shot
    // override for this launch, so dropping speed here would leave the run on
    // the platform tier's setting while honouring the other two.
    expect(resolveEnvironmentAgentLaunchSettings(launchOptions({ fastMode: true }))).toMatchObject({
      pendingAgentLaunch: true,
      initialAgentModel: "sonnet",
      initialReasoningEffort: "high",
      initialFastMode: true,
    });
  });

  test("keeps an explicit Normal rather than collapsing it to unset", () => {
    expect(
      resolveEnvironmentAgentLaunchSettings(launchOptions({ fastMode: false })).initialFastMode,
    ).toBe(false);
  });

  test("leaves speed unset when the dialog offered no choice", () => {
    expect(
      resolveEnvironmentAgentLaunchSettings(launchOptions({})).initialFastMode,
    ).toBeUndefined();
  });

  test("drops the one-shot speed when nothing is being launched", () => {
    // Without a launch there is no run to pin, and a stale value would apply to
    // whatever the user opens next.
    expect(
      resolveEnvironmentAgentLaunchSettings(launchOptions({ launchAgent: false, fastMode: true }))
        .initialFastMode,
    ).toBeUndefined();
  });
});
