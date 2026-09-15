import { describe, expect, test } from "bun:test";
import {
  buildLaunchDefaults,
  buildPipelineConfiguredDefaults,
  configuredOpenCodeModelIds,
} from "./build-launch-options";
import { MAX_BUILD_PIPELINE_REVIEWERS } from "@orkestrator/protocol/build-pipeline";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";

function makeConfig(
  repository?: Partial<RepositoryConfig>,
  global?: Partial<GlobalConfig>,
): AppConfig {
  return {
    global: {
      agentSettings: {
        defaultAgent: "claude",
        platforms: {
          claude: { model: "claude-sonnet-5" },
          codex: { model: "gpt-5.4", reasoningEffort: "medium" },
          opencode: { model: "opencode/claude-sonnet-5" },
        },
      },
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
        agentSettings: {
          defaultAgent: "codex",
          platforms: {
            codex: { model: "gpt-5.4-codex", reasoningEffort: "high" },
          },
        },
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

  test('drops the "default" placeholder rather than offering it as a model', () => {
    // No provider knows this id. The storage migration already refuses to store
    // it, so this is the belt-and-braces for a config written by an older build.
    const defaults = buildLaunchDefaults(
      makeConfig({
        agentSettings: {
          platforms: {
            claude: { model: "default", reasoningEffort: "default" },
          },
        },
      }),
      "project-1",
      false,
    );

    expect(defaults.preferredModels.claude).toBeUndefined();
    expect(defaults.preferredReasoningEfforts).toEqual({ codex: "medium" });
  });

  test("leaves an agent unseeded when it has no global model", () => {
    const defaults = buildLaunchDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "claude",
          platforms: { codex: { model: "gpt-5.4", reasoningEffort: "medium" } },
        },
      }),
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
      makeConfig({
        agentSettings: {
          defaultAgent: "codex",
          platforms: { codex: { model: "gpt-5.4-codex" } },
        },
      }),
      "project-1",
      false,
    );

    expect(defaults.preferredModels.codex).toBe("gpt-5.4-codex");
    // Nothing overrides the global effort when only a model is configured.
    expect(defaults.preferredReasoningEfforts).toEqual({ codex: "medium" });
  });

  test("applies a repository effort that has no matching model", () => {
    const defaults = buildLaunchDefaults(
      makeConfig({
        agentSettings: {
          defaultAgent: "opencode",
          platforms: { opencode: { reasoningEffort: "deep" } },
        },
      }),
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
        agentSettings: {
          defaultAgent: "opencode",
          platforms: {
            opencode: {
              model: "opencode/other-model",
              reasoningEffort: "deep",
            },
          },
        },
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
      makeConfig({
        agentSettings: {
          defaultAgent: "codex",
          platforms: { codex: { model: "gpt-5.4-codex" } },
        },
      }),
      "",
      false,
    );

    expect(defaults.defaultAgent).toBe("claude");
    expect(defaults.defaultEnvironmentType).toBe("containerized");
    expect(defaults.preferredModels.codex).toBe("gpt-5.4");
  });

  test("carries each platform's configured Fast/Normal choice", () => {
    const defaults = buildLaunchDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { model: "claude-sonnet-5", fastMode: true },
            // An explicit Normal is a choice, not an absence.
            codex: { model: "gpt-5.4", fastMode: false },
            opencode: { model: "opencode/claude-sonnet-5" },
          },
        },
      }),
      "project-1",
      false,
    );

    expect(defaults.preferredFastModes).toEqual({ claude: true, codex: false });
  });

  test("lets a repository speed override its own platform only", () => {
    const defaults = buildLaunchDefaults(
      makeConfig(
        {
          agentSettings: {
            defaultAgent: "codex",
            platforms: { codex: { fastMode: true } },
          },
        },
        {
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              claude: { model: "claude-sonnet-5", fastMode: false },
              codex: { model: "gpt-5.4", fastMode: false },
              opencode: { model: "opencode/claude-sonnet-5" },
            },
          },
        },
      ),
      "project-1",
      false,
    );

    expect(defaults.preferredFastModes).toEqual({ claude: false, codex: true });
  });

  test("leaves speed unseeded when no tier expresses one", () => {
    // Absent means the provider decides, which is not the same as Normal.
    expect(buildLaunchDefaults(makeConfig(), "project-1", false).preferredFastModes).toEqual({});
  });

  test("prefers the repository's last environment type, then the project's path", () => {
    expect(
      buildLaunchDefaults(makeConfig({ lastEnvironmentType: "containerized" }), "project-1", true)
        .defaultEnvironmentType,
    ).toBe("containerized");
    expect(
      buildLaunchDefaults(makeConfig({ lastEnvironmentType: "local" }), "project-1", false)
        .defaultEnvironmentType,
    ).toBe("local");
    expect(buildLaunchDefaults(makeConfig(), "project-1", true).defaultEnvironmentType).toBe(
      "local",
    );
    expect(buildLaunchDefaults(makeConfig(), "project-1", false).defaultEnvironmentType).toBe(
      "containerized",
    );
    expect(buildLaunchDefaults(makeConfig(), "unknown-project", false).defaultEnvironmentType).toBe(
      "containerized",
    );
  });
});

describe("buildPipelineConfiguredDefaults", () => {
  test("uses Multi Review and the dedicated verification action for every ticket build", () => {
    const config = makeConfig(undefined, {
      agentSettings: {
        defaultAgent: "claude",
        platforms: {
          claude: { model: "claude-sonnet-5" },
          codex: { model: "gpt-5.4", reasoningEffort: "medium" },
        },
        actionDefaults: {
          review: { platform: "claude", model: "claude-opus" },
          review2: {
            platform: "codex",
            model: "gpt-5.6",
            reasoningEffort: "high",
          },
          reviewPreparation: { platform: "codex", model: "gpt-5.6" },
          fixReviewIssues: { platform: "claude", model: "claude-sonnet-5" },
          verify: {
            platform: "codex",
            model: "gpt-5.6",
            reasoningEffort: "xhigh",
          },
        },
        multiReview: {
          reviewerCount: 3,
          additionalReviewers: [{ platform: "claude", model: "claude-haiku" }],
        },
      },
    });

    const defaults = buildPipelineConfiguredDefaults(config, "project-1");

    expect(defaults.reviewers).toEqual([
      { agent: "claude", model: "claude-opus" },
      { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
      { agent: "claude", model: "claude-haiku" },
    ]);
    expect(defaults.reviewPreparation).toEqual({
      agent: "codex",
      model: "gpt-5.6",
      reasoningEffort: "medium",
    });
    expect(defaults.steps.address).toEqual({
      agent: "claude",
      model: "claude-sonnet-5",
    });
    expect(defaults.steps.verify).toEqual({
      agent: "codex",
      model: "gpt-5.6",
      reasoningEffort: "xhigh",
    });
    expect(configuredOpenCodeModelIds(defaults)).toEqual([]);
  });

  test("defaults to two identical reviewers and a preparation model copied from review", () => {
    const defaults = buildPipelineConfiguredDefaults(makeConfig(), "project-1");

    expect(defaults.reviewers).toEqual([
      { agent: "claude", model: "claude-sonnet-5" },
      { agent: "claude", model: "claude-sonnet-5" },
    ]);
    expect(defaults.reviewPreparation).toEqual({
      agent: "claude",
      model: "claude-sonnet-5",
    });
    expect(defaults.steps.verify).toEqual({
      agent: "claude",
      model: "claude-sonnet-5",
    });
  });

  test("seeds verify from address when the dedicated action is unset", () => {
    const defaults = buildPipelineConfiguredDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { model: "claude-sonnet-5" },
            codex: { model: "gpt-5.4", reasoningEffort: "medium" },
          },
          actionDefaults: {
            fixReviewIssues: { platform: "codex", model: "gpt-5.6" },
          },
        },
      }),
      "project-1",
    );

    expect(defaults.steps.address).toEqual({
      agent: "codex",
      model: "gpt-5.6",
      reasoningEffort: "medium",
    });
    expect(defaults.steps.verify).toEqual({
      agent: "codex",
      model: "gpt-5.6",
      reasoningEffort: "medium",
    });
  });

  test("drops the OpenCode placeholder instead of pinning it on a launch path", () => {
    const defaults = buildPipelineConfiguredDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "opencode",
          platforms: {
            opencode: { model: "default", reasoningEffort: "default" },
          },
          actionDefaults: {
            review: { platform: "opencode" },
            verify: { platform: "opencode" },
          },
        },
      }),
      "project-1",
    );

    expect(defaults.steps.review).toEqual({ agent: "opencode" });
    expect(defaults.steps.verify).toEqual({ agent: "opencode" });
    expect(defaults.reviewers[0]).toEqual({ agent: "opencode" });
  });

  test("omits reviewPreparation when the configured reviewer count is one", () => {
    const defaults = buildPipelineConfiguredDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "claude-sonnet-5" } },
          actionDefaults: {
            review: { platform: "claude", model: "claude-opus" },
            reviewPreparation: { platform: "codex", model: "gpt-5.6" },
          },
          multiReview: { reviewerCount: 1 },
        },
      }),
      "project-1",
    );

    expect(defaults.reviewers).toEqual([{ agent: "claude", model: "claude-opus" }]);
    expect(defaults.reviewPreparation).toBeUndefined();
  });

  test("falls back to reviewer 1 when review2 or an additional slot is unset", () => {
    const defaults = buildPipelineConfiguredDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "claude-sonnet-5" } },
          actionDefaults: {
            review: { platform: "claude", model: "claude-opus" },
          },
          multiReview: {
            reviewerCount: 4,
            additionalReviewers: [null],
          },
        },
      }),
      "project-1",
    );

    expect(defaults.reviewers).toEqual([
      { agent: "claude", model: "claude-opus" },
      { agent: "claude", model: "claude-opus" },
      { agent: "claude", model: "claude-opus" },
      { agent: "claude", model: "claude-opus" },
    ]);
  });

  test("ignores an action default whose platform is not enabled", () => {
    const defaults = buildPipelineConfiguredDefaults(
      makeConfig(undefined, {
        enabledAgentPlatforms: ["claude"],
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "claude-sonnet-5" } },
          actionDefaults: {
            review: { platform: "codex", model: "gpt-5.6" },
            verify: { platform: "codex", model: "gpt-5.6" },
          },
        },
      }),
      "project-1",
    );

    expect(defaults.steps.review).toEqual({
      agent: "claude",
      model: "claude-sonnet-5",
    });
    expect(defaults.steps.verify).toEqual({
      agent: "claude",
      model: "claude-sonnet-5",
    });
  });

  test("clamps reviewer count to the pipeline maximum", () => {
    const defaults = buildPipelineConfiguredDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "claude-sonnet-5" } },
          actionDefaults: {
            review: { platform: "claude", model: "claude-opus" },
          },
          multiReview: { reviewerCount: 99 },
        },
      }),
      "project-1",
    );

    expect(defaults.reviewers).toHaveLength(MAX_BUILD_PIPELINE_REVIEWERS);
  });

  test("lists configured OpenCode ids so launchers can keep them before the catalogue loads", () => {
    const defaults = buildPipelineConfiguredDefaults(
      makeConfig(undefined, {
        agentSettings: {
          defaultAgent: "opencode",
          platforms: { opencode: { model: "acme/platform" } },
          actionDefaults: {
            review: { platform: "opencode", model: "acme/review" },
            review2: { platform: "opencode", model: "acme/review-2" },
            reviewPreparation: { platform: "opencode", model: "acme/prep" },
            verify: { platform: "opencode", model: "acme/verify" },
          },
        },
      }),
      "project-1",
    );

    expect(configuredOpenCodeModelIds(defaults)).toEqual([
      "acme/review",
      "acme/platform",
      "acme/verify",
      "acme/review-2",
      "acme/prep",
    ]);
  });
});
