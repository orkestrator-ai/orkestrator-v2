import { describe, expect, test } from "bun:test";
import {
  MAX_FEATURE_BUILD_TEXT_LENGTH,
  MAX_FEATURE_BUILD_TITLE_LENGTH,
  isCreateFeatureBuildInput,
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

  test("rejects a blank title, because the ticket has to be identifiable", () => {
    expect(isCreateFeatureBuildInput({ ...input, title: "   " })).toBe(false);
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
