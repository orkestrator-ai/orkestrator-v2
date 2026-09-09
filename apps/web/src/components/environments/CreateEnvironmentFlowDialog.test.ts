import { describe, expect, test } from "bun:test";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import type { AppConfig } from "@/types";
import { usesNativeStartupAgentTab } from "./CreateEnvironmentFlowDialog";

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
