import { describe, expect, test } from "bun:test";
import {
  getBuildEnvironmentAgentSettings,
  resolveActiveBuildPipelineAgent,
  resolveBuildPipelineAgent,
} from "./build-pipeline-agent";

function createConfig(defaultAgent: "claude" | "codex" | "opencode" | undefined, repositoryAgent?: "claude" | "codex" | "opencode") {
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

describe("getBuildEnvironmentAgentSettings", () => {
  test("returns Claude native settings and launch behavior", () => {
    expect(getBuildEnvironmentAgentSettings("claude")).toEqual({
      defaultAgent: "claude",
      claudeMode: "native",
      opencodeMode: null,
      shouldLaunchClaude: true,
    });
  });

  test("returns Codex settings without native-mode overrides", () => {
    expect(getBuildEnvironmentAgentSettings("codex")).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      opencodeMode: null,
      shouldLaunchClaude: false,
    });
  });

  test("returns OpenCode native settings without Claude launch behavior", () => {
    expect(getBuildEnvironmentAgentSettings("opencode")).toEqual({
      defaultAgent: "opencode",
      claudeMode: null,
      opencodeMode: "native",
      shouldLaunchClaude: false,
    });
  });
});
