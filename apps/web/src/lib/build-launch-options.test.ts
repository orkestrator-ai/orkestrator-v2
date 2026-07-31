import { describe, expect, test } from "bun:test";
import { buildLaunchDefaults } from "./build-launch-options";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";

function makeConfig(
  repository?: Partial<RepositoryConfig>,
  global?: Partial<GlobalConfig>,
): AppConfig {
  return {
    global: {
      defaultAgent: "claude",
      claudeModel: "claude-sonnet-5",
      codexModel: "gpt-5.4",
      opencodeModel: "opencode/claude-sonnet-5",
      codexReasoningEffort: "medium",
      ...global,
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

  test("leaves an agent unseeded when it has no global model", () => {
    const defaults = buildLaunchDefaults(
      makeConfig(undefined, { claudeModel: undefined }),
      "project-1",
      false,
    );

    // The launcher falls back to the first catalog model rather than sending a
    // configured-but-absent id, so an unset global must stay unset here.
    expect(defaults.preferredModels.claude).toBeUndefined();
    expect(defaults.preferredModels.codex).toBe("gpt-5.4");
  });

  test("applies a repository model that has no matching effort", () => {
    const defaults = buildLaunchDefaults(
      makeConfig({ defaultAgent: "codex", defaultModel: "gpt-5.4-codex" }),
      "project-1",
      false,
    );

    expect(defaults.preferredModels.codex).toBe("gpt-5.4-codex");
    // Nothing overrides the global effort when only a model is configured.
    expect(defaults.preferredReasoningEfforts).toEqual({ codex: "medium" });
  });

  test("applies a repository effort that has no matching model", () => {
    const defaults = buildLaunchDefaults(
      makeConfig({ defaultAgent: "opencode", defaultEffort: "deep" }),
      "project-1",
      false,
    );

    expect(defaults.preferredReasoningEfforts).toEqual({
      codex: "medium",
      opencode: "deep",
    });
    // Every model stays on its own global default.
    expect(defaults.preferredModels).toEqual({
      claude: "claude-sonnet-5",
      codex: "gpt-5.4",
      opencode: "opencode/claude-sonnet-5",
    });
  });

  test("routes the repository overrides to an OpenCode default agent", () => {
    const defaults = buildLaunchDefaults(
      makeConfig({
        defaultAgent: "opencode",
        defaultModel: "opencode/other-model",
        defaultEffort: "deep",
      }),
      "project-1",
      false,
    );

    expect(defaults.defaultAgent).toBe("opencode");
    expect(defaults.preferredModels.opencode).toBe("opencode/other-model");
    expect(defaults.preferredModels.claude).toBe("claude-sonnet-5");
    expect(defaults.preferredReasoningEfforts).toEqual({
      codex: "medium",
      opencode: "deep",
    });
  });

  test("falls back to the globals for a repository entry that configures nothing", () => {
    const defaults = buildLaunchDefaults(makeConfig({}), "project-1", true);

    expect(defaults.defaultAgent).toBe("claude");
    // An entry exists, so this is not the missing-repository path.
    expect(defaults.defaultEnvironmentType).toBe("local");
    expect(defaults.preferredModels).toEqual({
      claude: "claude-sonnet-5",
      codex: "gpt-5.4",
      opencode: "opencode/claude-sonnet-5",
    });
    expect(defaults.preferredReasoningEfforts).toEqual({ codex: "medium" });
  });

  test("falls back to the globals for an empty project id", () => {
    const defaults = buildLaunchDefaults(
      makeConfig({ defaultAgent: "codex", defaultModel: "gpt-5.4-codex" }),
      "",
      false,
    );

    expect(defaults.defaultAgent).toBe("claude");
    expect(defaults.defaultEnvironmentType).toBe("containerized");
    expect(defaults.preferredModels.codex).toBe("gpt-5.4");
  });

  test("prefers the repository's last environment type, then the project's path", () => {
    expect(
      buildLaunchDefaults(
        makeConfig({ lastEnvironmentType: "containerized" }),
        "project-1",
        true,
      ).defaultEnvironmentType,
    ).toBe("containerized");
    expect(
      buildLaunchDefaults(
        makeConfig({ lastEnvironmentType: "local" }),
        "project-1",
        false,
      ).defaultEnvironmentType,
    ).toBe("local");
    expect(buildLaunchDefaults(makeConfig(), "project-1", true).defaultEnvironmentType)
      .toBe("local");
    expect(buildLaunchDefaults(makeConfig(), "project-1", false).defaultEnvironmentType)
      .toBe("containerized");
    expect(buildLaunchDefaults(makeConfig(), "unknown-project", false).defaultEnvironmentType)
      .toBe("containerized");
  });
});
