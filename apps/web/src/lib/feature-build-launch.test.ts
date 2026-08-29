import { describe, expect, test } from "bun:test";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import {
  defaultFeatureBuildModels,
  featureBuildIdentity,
  featureBuildRequest,
  featureBuildStepConfigs,
  resolveFeatureBuildStep,
  type FeatureBuildModelState,
} from "@/lib/feature-build-launch";

const catalog: AgentModelCatalog = {
  claude: [
    {
      id: "sonnet",
      name: "Sonnet",
      reasoningEfforts: ["low", "high"],
      resolvedModel: "claude-sonnet-5",
    },
    { id: "opus", name: "Opus", reasoningEfforts: ["high", "max"] },
  ],
  codex: [{ id: "gpt-5.6", name: "GPT-5.6", reasoningEfforts: ["medium", "high"] }],
  opencode: [{ id: "default", name: "Default", reasoningEfforts: [] }],
};

function models(): FeatureBuildModelState {
  return defaultFeatureBuildModels({
    catalog,
    build: { agent: "claude", model: "opus", reasoningEffort: "max" },
    review: { agent: "claude", model: "sonnet", reasoningEffort: "high" },
    review2: { agent: "codex", model: "gpt-5.6" },
    address: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    pr: { agent: "claude", model: "sonnet" },
    resolve: { agent: "claude", model: "opus" },
  });
}

describe("resolveFeatureBuildStep", () => {
  test("matches a configured model through its resolved id", () => {
    // Configuration stores Claude models in resolved space while the catalogue
    // is keyed by alias; only the shared resolver matches the two.
    expect(resolveFeatureBuildStep({ agent: "claude", model: "claude-sonnet-5" }, catalog)).toEqual(
      {
        agent: "claude",
        model: "sonnet",
      },
    );
  });

  test("falls back to the platform's first model when the preference is unknown", () => {
    expect(resolveFeatureBuildStep({ agent: "claude", model: "haiku" }, catalog).model).toBe(
      "sonnet",
    );
  });

  test("omits a reasoning level the model does not support", () => {
    expect(
      resolveFeatureBuildStep({ agent: "claude", model: "sonnet", reasoningEffort: "max" }, catalog)
        .reasoningEffort,
    ).toBeUndefined();
    expect(
      resolveFeatureBuildStep({ agent: "claude", model: "opus", reasoningEffort: "max" }, catalog)
        .reasoningEffort,
    ).toBe("max");
  });
});

describe("defaultFeatureBuildModels", () => {
  test("opens on two reviewers, each from its own Settings entry", () => {
    const state = models();
    expect(state.reviewers).toHaveLength(2);
    expect(state.reviewers[0]).toMatchObject({ agent: "claude", model: "sonnet" });
    expect(state.reviewers[1]).toMatchObject({ agent: "codex", model: "gpt-5.6" });
    // Distinct keys, so removing one row cannot remove the other.
    expect(state.reviewers[0]!.key).not.toBe(state.reviewers[1]!.key);
  });

  test("takes the build step from the dialog's own default agent", () => {
    expect(models().build).toMatchObject({
      agent: "claude",
      model: "opus",
      reasoningEffort: "max",
    });
  });
});

describe("featureBuildStepConfigs", () => {
  test("sends the first reviewer as the review step so an older backend still works", () => {
    const { steps, reviewers } = featureBuildStepConfigs(models());
    expect(steps.review).toEqual({ agent: "claude", model: "sonnet", reasoningEffort: "high" });
    expect(reviewers).toHaveLength(2);
    expect(reviewers[0]).toEqual(steps.review!);
  });

  test("does not send a verify step; the backend runs it on the address model", () => {
    expect(featureBuildStepConfigs(models()).steps.verify).toBeUndefined();
  });

  test("maps resolve to the pipeline's conflict step", () => {
    expect(featureBuildStepConfigs(models()).steps["resolve-conflicts"]).toEqual({
      agent: "claude",
      model: "opus",
    });
  });

  test("collapses exact duplicate reviewers to the single-review path", () => {
    const state = models();
    state.reviewers[1] = { ...state.reviewers[0]!, key: "duplicate-reviewer" };

    expect(featureBuildStepConfigs(state).reviewers).toEqual([
      { agent: "claude", model: "sonnet", reasoningEffort: "high" },
    ]);
  });

  test("preserves one reviewer and falls back safely when the list is empty", () => {
    const single = models();
    single.reviewers = [single.reviewers[1]!];
    expect(featureBuildStepConfigs(single).reviewers).toEqual([
      { agent: "codex", model: "gpt-5.6" },
    ]);

    const empty = models();
    empty.reviewers = [];
    const configured = featureBuildStepConfigs(empty);
    expect(configured.reviewers).toEqual([
      { agent: "claude", model: "opus", reasoningEffort: "max" },
    ]);
    expect(configured.steps.review).toEqual(configured.reviewers[0]);
  });
});

describe("featureBuildRequest", () => {
  const base = {
    projectId: "project-1",
    title: "  Dark mode  ",
    description: "  A toggle  ",
    acceptanceCriteria: "  It persists  ",
    environmentType: "containerized" as const,
    environmentName: "  feature-dark  ",
    networkAccessMode: "restricted" as const,
    portMappings: [{ containerPort: 5173, hostPort: 5173, protocol: "tcp" as const }],
    defaultAgent: "claude" as const,
    models: models(),
    requestId: "request-1",
  };

  test("trims the ticket and carries the environment shaping", () => {
    const request = featureBuildRequest({ ...base, customizeModels: false });
    expect(request.title).toBe("Dark mode");
    expect(request.description).toBe("A toggle");
    expect(request.acceptanceCriteria).toBe("It persists");
    expect(request.environmentOptions).toEqual({
      name: "feature-dark",
      networkAccessMode: "restricted",
      portMappings: base.portMappings,
    });
  });

  test("keeps two default reviewers when the models panel is closed", () => {
    const request = featureBuildRequest({ ...base, customizeModels: false });
    expect(request.steps).toBeUndefined();
    expect(request.reviewers).toEqual([
      { agent: "claude", model: "sonnet", reasoningEffort: "high" },
      { agent: "codex", model: "gpt-5.6" },
    ]);
    // The pipeline still needs a harness for the build step, and that is the
    // agent the dialog was showing.
    expect(request.agentType).toBe("claude");
  });

  test("does not send two identical default reviewers when the panel is closed", () => {
    const duplicateModels = models();
    duplicateModels.reviewers[1] = {
      ...duplicateModels.reviewers[0]!,
      key: "duplicate-reviewer",
    };

    expect(
      featureBuildRequest({ ...base, models: duplicateModels, customizeModels: false }).reviewers,
    ).toEqual([{ agent: "claude", model: "sonnet", reasoningEffort: "high" }]);
  });

  test("sends every step when the models panel is open", () => {
    const request = featureBuildRequest({ ...base, customizeModels: true });
    expect(request.steps?.build).toEqual({
      agent: "claude",
      model: "opus",
      reasoningEffort: "max",
    });
    expect(request.reviewers).toHaveLength(2);
    expect(request.agentType).toBe("claude");
  });

  test("drops port mappings for a local worktree, which has no ports to publish", () => {
    const request = featureBuildRequest({
      ...base,
      environmentType: "local",
      customizeModels: false,
    });
    expect(request.environmentOptions?.portMappings).toBeUndefined();
  });

  test("omits an empty environment name so provisioning names it from the ticket", () => {
    const request = featureBuildRequest({
      ...base,
      environmentName: "   ",
      customizeModels: false,
    });
    expect(request.environmentOptions?.name).toBeUndefined();
  });
});

describe("featureBuildIdentity", () => {
  const base = {
    projectId: "project-1",
    title: "Dark mode",
    description: "A toggle",
    acceptanceCriteria: "It persists",
    environmentType: "containerized" as const,
    environmentName: "feature-dark",
    networkAccessMode: "restricted" as const,
    portMappings: [],
    defaultAgent: "claude" as const,
    customizeModels: false,
    models: models(),
    requestId: "request-1",
  };

  test("ignores the key itself, so a resend under the same key is the same request", () => {
    // This is what makes reuse safe: the identity answers "is this the request
    // the key was spent on", which cannot depend on the key.
    expect(featureBuildIdentity(featureBuildRequest(base))).toBe(
      featureBuildIdentity(featureBuildRequest({ ...base, requestId: "request-2" })),
    );
  });

  test("changes when any argument the backend binds to the key changes", () => {
    const identity = featureBuildIdentity(featureBuildRequest(base));
    const differing = [
      { title: "Light mode" },
      { description: "Something else" },
      { acceptanceCriteria: "Different" },
      { environmentName: "other-name" },
      { networkAccessMode: "full" as const },
      { environmentType: "local" as const },
      { customizeModels: true },
      {
        models: {
          ...models(),
          reviewers: [{ key: "changed-reviewer", agent: "codex" as const, model: "gpt-5.6" }],
        },
      },
      { portMappings: [{ containerPort: 5173, hostPort: 5173, protocol: "tcp" as const }] },
    ];
    for (const override of differing) {
      expect(featureBuildIdentity(featureBuildRequest({ ...base, ...override }))).not.toBe(
        identity,
      );
    }
  });

  test("does not depend on the order the request's keys were built in", () => {
    const request = featureBuildRequest(base);
    const reordered = Object.fromEntries(Object.entries(request).reverse()) as typeof request;
    expect(featureBuildIdentity(reordered)).toBe(featureBuildIdentity(request));
  });
});
