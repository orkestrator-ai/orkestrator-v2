import { describe, expect, test } from "bun:test";
import {
  buildPipelineConfiguredDefaults,
  defaultBuildPipelineAgent,
  enabledBuildPipelineAgents,
} from "./build-pipeline-defaults.js";
import type { AgentSettingsTiers } from "./agent-settings.js";

describe("pipeline defaults never pick an unqualified platform", () => {
  test("an Antigravity default agent falls back to the first qualified enabled one", () => {
    const tiers: AgentSettingsTiers = { global: { defaultAgent: "antigravity" } };
    expect(enabledBuildPipelineAgents(["antigravity", "codex"])).toEqual(["codex"]);
    expect(defaultBuildPipelineAgent(tiers, ["antigravity", "codex"])).toBe("codex");
    expect(defaultBuildPipelineAgent(tiers, ["antigravity"])).toBe("claude");
  });

  test("an action default naming Antigravity is ignored for every step", () => {
    const tiers: AgentSettingsTiers = {
      global: {
        defaultAgent: "antigravity",
        actionDefaults: {
          review: { platform: "antigravity" },
          review2: { platform: "antigravity" },
          addressFindings: { platform: "antigravity" },
          verify: { platform: "antigravity" },
          pr: { platform: "antigravity" },
          resolve: { platform: "antigravity" },
        },
      },
    };
    const defaults = buildPipelineConfiguredDefaults(tiers, ["antigravity", "pi"]);
    for (const step of Object.values(defaults.steps)) expect(step.agent).toBe("pi");
    for (const reviewer of defaults.reviewers) expect(reviewer.agent).toBe("pi");
  });
});
