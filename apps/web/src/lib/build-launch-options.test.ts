import { describe, expect, test } from "bun:test";
import { buildLaunchDefaults } from "./build-launch-options";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";

function makeConfig(repository?: Partial<RepositoryConfig>): AppConfig {
  return {
    global: {
      defaultAgent: "claude",
      claudeModel: "claude-sonnet-5",
      codexModel: "gpt-5.4",
      opencodeModel: "opencode/claude-sonnet-5",
      codexReasoningEffort: "medium",
    } as GlobalConfig,
    repositories: repository
      ? {
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            ...repository,
          } as RepositoryConfig,
        }
      : {},
  } as AppConfig;
}

describe("buildLaunchDefaults", () => {
  test("seeds each agent from its own global model", () => {
    const defaults = buildLaunchDefaults(makeConfig(), "project-1", false);

    expect(defaults.defaultAgent).toBe("claude");
    expect(defaults.defaultEnvironmentType).toBe("containerized");
    expect(defaults.preferredModels).toEqual({
      claude: "claude-sonnet-5",
      codex: "gpt-5.4",
      opencode: "opencode/claude-sonnet-5",
    });
    expect(defaults.preferredReasoningEfforts).toEqual({ codex: "medium" });
  });

  test("applies the repository model and effort to the repository's agent only", () => {
    const defaults = buildLaunchDefaults(
      makeConfig({
        defaultAgent: "codex",
        defaultModel: "gpt-5.4-codex",
        defaultEffort: "high",
      }),
      "project-1",
      false,
    );

    expect(defaults.defaultAgent).toBe("codex");
    expect(defaults.preferredModels.codex).toBe("gpt-5.4-codex");
    // Untouched: a Codex model is not a Claude default.
    expect(defaults.preferredModels.claude).toBe("claude-sonnet-5");
    expect(defaults.preferredReasoningEfforts).toEqual({ codex: "high" });
  });

  test("treats the \"default\" placeholder as no repository override", () => {
    const defaults = buildLaunchDefaults(
      makeConfig({ defaultModel: "default", defaultEffort: "default" }),
      "project-1",
      false,
    );

    expect(defaults.preferredModels.claude).toBe("claude-sonnet-5");
    expect(defaults.preferredReasoningEfforts).toEqual({ codex: "medium" });
  });

  test("prefers the repository's last environment type, then the project's path", () => {
    expect(
      buildLaunchDefaults(
        makeConfig({ lastEnvironmentType: "containerized" }),
        "project-1",
        true,
      ).defaultEnvironmentType,
    ).toBe("containerized");
    expect(buildLaunchDefaults(makeConfig(), "project-1", true).defaultEnvironmentType)
      .toBe("local");
    expect(buildLaunchDefaults(makeConfig(), "unknown-project", false).defaultEnvironmentType)
      .toBe("containerized");
  });
});
