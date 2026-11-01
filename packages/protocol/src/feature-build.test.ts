import { describe, expect, test } from "bun:test";
import {
  MAX_FEATURE_BUILD_TEXT_LENGTH,
  MAX_FEATURE_BUILD_TITLE_LENGTH,
  featureBuildRequestIdentity,
  isCreateFeatureBuildInput,
  isStartFeaturePlanBuildInput,
} from "./feature-build.js";

const input = {
  projectId: "project-1",
  title: "Dark mode toggle",
  description: "Adds a toggle to the header.",
  acceptanceCriteria: "The preference survives a reload.",
  environmentType: "containerized" as const,
  agentType: "claude" as const,
};

describe("create feature build input", () => {
  test("accepts the minimum a ticket and a build need", () => {
    expect(
      isCreateFeatureBuildInput({
        projectId: "project-1",
        title: "Dark mode toggle",
        environmentType: "local",
        agentType: "codex",
      }),
    ).toBe(true);
  });

  test("accepts a blank title when a description can be used to generate it", () => {
    expect(isCreateFeatureBuildInput({ ...input, title: "   " })).toBe(true);
    expect(isCreateFeatureBuildInput({ ...input, title: "   ", description: "   " })).toBe(false);
    expect(
      isCreateFeatureBuildInput({
        ...input,
        title: "a".repeat(MAX_FEATURE_BUILD_TITLE_LENGTH + 1),
      }),
    ).toBe(false);
  });

  test("bounds the free text so one request cannot carry a whole repository", () => {
    expect(
      isCreateFeatureBuildInput({
        ...input,
        description: "a".repeat(MAX_FEATURE_BUILD_TEXT_LENGTH),
      }),
    ).toBe(true);
    expect(
      isCreateFeatureBuildInput({
        ...input,
        acceptanceCriteria: "a".repeat(MAX_FEATURE_BUILD_TEXT_LENGTH + 1),
      }),
    ).toBe(false);
  });

  test("validates the environment options it forwards to environment creation", () => {
    expect(
      isCreateFeatureBuildInput({
        ...input,
        environmentOptions: {
          name: "feature-dark-mode",
          networkAccessMode: "restricted",
          portMappings: [{ containerPort: 3000, hostPort: 3000, protocol: "tcp" }],
        },
      }),
    ).toBe(true);
    expect(
      isCreateFeatureBuildInput({
        ...input,
        environmentOptions: { networkAccessMode: "wide-open" },
      }),
    ).toBe(false);
    expect(
      isCreateFeatureBuildInput({
        ...input,
        environmentOptions: {
          portMappings: [{ containerPort: 0, hostPort: 3000, protocol: "tcp" }],
        },
      }),
    ).toBe(false);
  });

  test("accepts a reviewer panel and rejects an empty one", () => {
    expect(
      isCreateFeatureBuildInput({
        ...input,
        reviewers: [
          { agent: "claude", model: "opus" },
          { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
        ],
      }),
    ).toBe(true);
    expect(isCreateFeatureBuildInput({ ...input, reviewers: [] })).toBe(false);
  });

  test("validates a separate review preparation and consolidation model", () => {
    expect(
      isCreateFeatureBuildInput({
        ...input,
        reviewPreparation: {
          agent: "codex",
          model: "gpt-5.6",
          reasoningEffort: "high",
        },
      }),
    ).toBe(true);
    expect(
      isCreateFeatureBuildInput({
        ...input,
        reviewPreparation: { agent: "unknown", model: "gpt-5.6" },
      }),
    ).toBe(false);
  });

  test("accepts feature images and rejects malformed image entries", () => {
    expect(
      isCreateFeatureBuildInput({
        ...input,
        images: [{ filename: "reference.png", data: "QUJD" }],
      }),
    ).toBe(true);
    expect(
      isCreateFeatureBuildInput({
        ...input,
        images: [{ filename: "reference.png", data: "" }],
      }),
    ).toBe(false);
    expect(
      isCreateFeatureBuildInput({
        ...input,
        images: [{ filename: "", data: "QUJD" }],
      }),
    ).toBe(false);
  });

  test("accepts a bounded idempotency key and rejects a blank one", () => {
    expect(isCreateFeatureBuildInput({ ...input, requestId: "req-1" })).toBe(true);
    expect(isCreateFeatureBuildInput({ ...input, requestId: "  " })).toBe(false);
    expect(isCreateFeatureBuildInput({ ...input, requestId: "a".repeat(257) })).toBe(false);
  });

  test("rejects an unknown harness and an unknown environment type", () => {
    expect(isCreateFeatureBuildInput({ ...input, agentType: "gemini" })).toBe(false);
    expect(isCreateFeatureBuildInput({ ...input, environmentType: "remote" })).toBe(false);
  });
});

describe("isStartFeaturePlanBuildInput", () => {
  test("takes a plan id and optional environment type and agent", () => {
    expect(isStartFeaturePlanBuildInput({ featureId: "feature-1" })).toBe(true);
    expect(
      isStartFeaturePlanBuildInput({
        featureId: "feature-1",
        environmentType: "local",
        agentType: "claude",
      }),
    ).toBe(true);
  });

  test("refuses a blank plan, an unknown value and any other field", () => {
    expect(isStartFeaturePlanBuildInput({ featureId: "  " })).toBe(false);
    expect(isStartFeaturePlanBuildInput({})).toBe(false);
    expect(isStartFeaturePlanBuildInput({ featureId: "f", environmentType: "remote" })).toBe(false);
    expect(isStartFeaturePlanBuildInput({ featureId: "f", agentType: "gemini" })).toBe(false);
    expect(isStartFeaturePlanBuildInput({ featureId: "f", steps: {} })).toBe(false);
  });
});

describe("featureBuildRequestIdentity", () => {
  test("is the sorted request without its key, the string the backend hashes", () => {
    // Pinned: stored request hashes were computed over exactly this string, so
    // a change here would refuse every retry of an in-flight feature build.
    expect(
      featureBuildRequestIdentity({
        title: "T",
        projectId: "p",
        environmentType: "local",
        agentType: "codex",
        description: undefined,
        requestId: "key-1",
      }),
    ).toBe('{"agentType":"codex","environmentType":"local","projectId":"p","title":"T"}');
  });

  test("does not depend on key order", () => {
    const a = featureBuildRequestIdentity({
      projectId: "p",
      title: "T",
      environmentType: "local",
      agentType: "codex",
      steps: { build: { agent: "codex", model: "m" } },
    });
    const b = featureBuildRequestIdentity({
      steps: { build: { model: "m", agent: "codex" } },
      agentType: "codex",
      environmentType: "local",
      title: "T",
      projectId: "p",
    });
    expect(a).toBe(b);
  });
});
