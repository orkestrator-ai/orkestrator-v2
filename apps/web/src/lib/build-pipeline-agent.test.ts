import { describe, expect, test } from "bun:test";
import {
  getBuildEnvironmentAgentSettings,
  resolveActiveBuildPipelineAgent,
  resolveAgentModeSettings,
  resolveBuildPipelineAgent,
} from "./build-pipeline-agent";

function createConfig(
  defaultAgent: "claude" | "codex" | "opencode" | "cursor" | "grok" | undefined,
  repositoryAgent?: "claude" | "codex" | "opencode" | "cursor" | "grok",
) {
  return {
    version: "1.0",
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [],
      allowedDomains: [],
      defaultAgent,
      opencodeModel: "anthropic/claude-sonnet-4",
      codexModel: "gpt-5.3-codex",
      codexReasoningEffort: "medium",
      opencodeMode: "native",
      claudeMode: "native",
      codexMode: "native",
      terminalAppearance: {
        fontFamily: "Fira Code",
        fontSize: 14,
        backgroundColor: "#000000",
      },
      terminalScrollback: 5000,
    },
    repositories: repositoryAgent
      ? {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultAgent: repositoryAgent,
          },
        }
      : {},
  } as any;
}

describe("resolveBuildPipelineAgent", () => {
  test("prefers the repository default agent", () => {
    const agent = resolveBuildPipelineAgent(createConfig("claude", "codex"), "project-1");

    expect(agent).toBe("codex");
  });

  test("falls back to the global default agent", () => {
    const agent = resolveBuildPipelineAgent(createConfig("opencode"), "project-1");

    expect(agent).toBe("opencode");
  });

  test("falls back to claude when neither repository nor global defaults are set", () => {
    const agent = resolveBuildPipelineAgent(createConfig(undefined), "project-1");

    expect(agent).toBe("claude");
  });

  test("falls back to the first enabled platform when a stored override is disabled", () => {
    const config = createConfig("claude", "codex");
    config.global.enabledAgentPlatforms = ["cursor", "grok"];
    expect(resolveBuildPipelineAgent(config, "project-1")).toBe("cursor");
  });
});

describe("resolveActiveBuildPipelineAgent", () => {
  test("prefers the pipeline agent over all defaults", () => {
    const agent = resolveActiveBuildPipelineAgent({
      pipelineAgent: "codex",
      environmentDefaultAgent: "opencode",
      config: createConfig("claude", "opencode"),
      projectId: "project-1",
    });

    expect(agent).toBe("codex");
  });

  test("falls back to the environment default when the pipeline agent is missing", () => {
    const agent = resolveActiveBuildPipelineAgent({
      environmentDefaultAgent: "opencode",
      config: createConfig("claude", "codex"),
      projectId: "project-1",
    });

    expect(agent).toBe("opencode");
  });
});

describe("resolveActiveBuildPipelineAgent — restoring a persisted pipeline", () => {
  // The durable launch intent is a boolean; the agent identity travels with the
  // environment's `defaultAgent`, written in the same backend call. A row
  // persisted by the Claude-only version of this code therefore still restores
  // as Claude, even once the global default has moved on to another agent.
  test("restores a legacy Claude-persisted environment as Claude", () => {
    const agent = resolveActiveBuildPipelineAgent({
      pipelineAgent: undefined,
      environmentDefaultAgent: "claude",
      config: createConfig("codex"),
      projectId: "project-1",
    });

    expect(agent).toBe("claude");
  });

  // Pre-`defaultAgent` rows exist too: those predate per-environment agents
  // entirely, so the config chain is the only answer available and must not
  // throw or resolve to undefined.
  test("falls back through config for a persisted environment with no agent recorded", () => {
    expect(
      resolveActiveBuildPipelineAgent({
        environmentDefaultAgent: undefined,
        config: createConfig("opencode"),
        projectId: "project-1",
      }),
    ).toBe("opencode");

    expect(
      resolveActiveBuildPipelineAgent({
        environmentDefaultAgent: undefined,
        config: createConfig(undefined),
        projectId: "project-1",
      }),
    ).toBe("claude");
  });
});

describe("resolveAgentModeSettings", () => {
  test("routes the selected agent's mode and nulls the other two", () => {
    expect(
      resolveAgentModeSettings("claude", {
        claudeMode: "terminal",
        opencodeMode: "native",
        codexMode: "native",
      }),
    ).toEqual({
      defaultAgent: "claude",
      claudeMode: "terminal",
      opencodeMode: null,
      codexMode: null,
    });

    expect(
      resolveAgentModeSettings("opencode", {
        claudeMode: "native",
        opencodeMode: "terminal",
        codexMode: "native",
      }),
    ).toEqual({
      defaultAgent: "opencode",
      claudeMode: null,
      opencodeMode: "terminal",
      codexMode: null,
    });

    expect(
      resolveAgentModeSettings("codex", {
        claudeMode: "native",
        opencodeMode: "native",
        codexMode: "terminal",
      }),
    ).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      opencodeMode: null,
      codexMode: "terminal",
    });
  });
});

describe("getBuildEnvironmentAgentSettings", () => {
  test("returns Claude native settings and names Claude as the launch agent", () => {
    expect(getBuildEnvironmentAgentSettings("claude")).toEqual({
      defaultAgent: "claude",
      claudeMode: "native",
      opencodeMode: null,
      codexMode: null,
      launchAgent: "claude",
    });
  });

  test("returns Codex native settings and names Codex as the launch agent", () => {
    expect(getBuildEnvironmentAgentSettings("codex")).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      opencodeMode: null,
      codexMode: "native",
      launchAgent: "codex",
    });
  });

  test("returns OpenCode native settings and names OpenCode as the launch agent", () => {
    expect(getBuildEnvironmentAgentSettings("opencode")).toEqual({
      defaultAgent: "opencode",
      claudeMode: null,
      opencodeMode: "native",
      codexMode: null,
      launchAgent: "opencode",
    });
  });

  // The durable intent exists so a mobile page eviction cannot lose the launch.
  // That risk is identical for every agent, so none of them may opt out.
  test("names a launch agent for every agent type", () => {
    for (const agentType of ["claude", "codex", "cursor", "grok", "opencode"] as const) {
      expect(getBuildEnvironmentAgentSettings(agentType).launchAgent).toBe(agentType);
    }
  });
});
