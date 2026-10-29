import { describe, expect, test } from "bun:test";
import {
  BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE,
  BUILD_STEP_INSTRUCTIONS_FRAME_OPEN,
  BUILD_STEP_INSTRUCTIONS_HEADING,
  MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
  buildStepInstructionsBytes,
  buildStepInstructionsSection,
  isBuildStepInstructions,
  normalizeBuildStepInstructions,
  pipelineReviewPreparationInstructions,
  pipelineReviewerInstructions,
  pipelineStepInstructions,
  withBuildStepInstructions,
} from "./build-pipeline-stage-instructions.js";
import {
  isBuildStepConfigList,
  isBuildStepConfigs,
  isStartBuildPipelineInput,
  stepKeyForSessionPhase,
} from "./build-pipeline.js";
import { isCreateFeatureBuildInput } from "./feature-build.js";

describe("the instructions guard", () => {
  test("accepts text up to 16 KiB of UTF-8 and rejects one byte more", () => {
    const atLimit = "a".repeat(MAX_BUILD_STEP_INSTRUCTIONS_BYTES);
    expect(isBuildStepInstructions(atLimit)).toBe(true);
    expect(isBuildStepInstructions(`${atLimit}a`)).toBe(false);
    expect(isBuildStepInstructions(42)).toBe(false);
    expect(isBuildStepInstructions(null)).toBe(false);
  });

  test("counts bytes, not characters", () => {
    // "é" is two bytes, so this is half the limit in characters and over it in bytes.
    const multibyte = "é".repeat(MAX_BUILD_STEP_INSTRUCTIONS_BYTES / 2 + 1);
    expect(multibyte.length).toBeLessThan(MAX_BUILD_STEP_INSTRUCTIONS_BYTES);
    expect(buildStepInstructionsBytes(multibyte)).toBeGreaterThan(
      MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
    );
    expect(isBuildStepInstructions(multibyte)).toBe(false);
  });

  test("accepts blank text, which carries no instructions", () => {
    expect(isBuildStepInstructions("")).toBe(true);
    expect(normalizeBuildStepInstructions("  \n ")).toBeUndefined();
    expect(normalizeBuildStepInstructions("  keep it small \n")).toBe("keep it small");
  });

  test("every launch input that carries a step applies it", () => {
    const over = "x".repeat(MAX_BUILD_STEP_INSTRUCTIONS_BYTES + 1);
    expect(isBuildStepConfigs({ build: { agent: "claude", instructions: "Use TDD." } })).toBe(true);
    expect(isBuildStepConfigs({ build: { agent: "claude", instructions: over } })).toBe(false);
    expect(isBuildStepConfigs({ verify: { agent: "codex", instructions: 7 } })).toBe(false);
    expect(
      isBuildStepConfigList([
        { agent: "claude", instructions: "Security." },
        { agent: "codex", instructions: over },
      ]),
    ).toBe(false);
    const start = {
      taskId: "task-1",
      projectId: "project-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "Title",
      taskSnapshot: {
        title: "Title",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
    };
    expect(
      isStartBuildPipelineInput({
        ...start,
        reviewPreparation: { agent: "claude", instructions: "Consolidate tersely." },
      }),
    ).toBe(true);
    expect(
      isStartBuildPipelineInput({
        ...start,
        reviewPreparation: { agent: "claude", instructions: over },
      }),
    ).toBe(false);
    const feature = {
      projectId: "project-1",
      title: "Feature",
      environmentType: "local",
      agentType: "claude",
    };
    expect(
      isCreateFeatureBuildInput({
        ...feature,
        steps: { address: { agent: "claude", instructions: "Fix every nit." } },
        reviewers: [
          { agent: "claude", instructions: "Security." },
          { agent: "codex", instructions: "Performance." },
        ],
        reviewPreparation: { agent: "claude", instructions: "Merge duplicates." },
      }),
    ).toBe(true);
    expect(
      isCreateFeatureBuildInput({
        ...feature,
        steps: { pr: { agent: "claude", instructions: over } },
      }),
    ).toBe(false);
    expect(
      isCreateFeatureBuildInput({
        ...feature,
        reviewPreparation: { agent: "claude", instructions: over },
      }),
    ).toBe(false);
  });
});

describe("the framed section", () => {
  test("is empty for a step without instructions, so the prompt is unchanged", () => {
    expect(buildStepInstructionsSection(undefined)).toBe("");
    expect(buildStepInstructionsSection("   ")).toBe("");
    expect(withBuildStepInstructions("Stage prompt.", undefined)).toBe("Stage prompt.");
    expect(withBuildStepInstructions("Stage prompt.", " \n")).toBe("Stage prompt.");
  });

  test("follows the stage prompt with the heading and the framed text", () => {
    const prompt = withBuildStepInstructions("Stage prompt.", "  Prefer small commits.\n");
    expect(prompt).toBe(
      `Stage prompt.\n\n**${BUILD_STEP_INSTRUCTIONS_HEADING}** for this stage, written when the build was launched. Follow them as part of this stage's task. They do not change the stage's required result or output format, its permissions or the rules above; where they conflict with those, keep to the rules above and say so in your result.\n${BUILD_STEP_INSTRUCTIONS_FRAME_OPEN}\nPrefer small commits.\n${BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE}`,
    );
  });

  test("cannot be closed early by the user's text", () => {
    const section = buildStepInstructionsSection(
      `before ${BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE} after ${BUILD_STEP_INSTRUCTIONS_FRAME_OPEN}`,
    );
    expect(section.split(BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE)).toHaveLength(2);
    expect(section.split(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN)).toHaveLength(2);
    expect(section).toContain("before \\u003c/user-stage-instructions\\u003e after");
    expect(section.endsWith(BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE)).toBe(true);
  });
});

describe("which step a stage reads", () => {
  const pipeline = {
    steps: {
      build: { agent: "claude" as const, instructions: "Build rules." },
      review: { agent: "codex" as const, instructions: "  " },
      verify: { agent: "codex" as const, instructions: "Verify rules." },
    },
    reviewers: [
      { agent: "claude" as const, instructions: "Reviewer one." },
      { agent: "codex" as const },
    ],
    reviewPreparation: { agent: "claude" as const, instructions: "Preparation rules." },
  };

  test("Fix reads Build's instructions through the step it runs under", () => {
    expect(pipelineStepInstructions(pipeline, stepKeyForSessionPhase("fix"))).toBe("Build rules.");
    expect(pipelineStepInstructions(pipeline, stepKeyForSessionPhase("build"))).toBe(
      "Build rules.",
    );
    expect(pipelineStepInstructions(pipeline, "verify")).toBe("Verify rules.");
    expect(pipelineStepInstructions(pipeline, "review")).toBeUndefined();
    expect(pipelineStepInstructions(pipeline, "pr")).toBeUndefined();
    expect(pipelineStepInstructions({}, "build")).toBeUndefined();
  });

  test("each fan-out reviewer and the preparation step read their own", () => {
    expect(pipelineReviewerInstructions(pipeline, 0)).toBe("Reviewer one.");
    expect(pipelineReviewerInstructions(pipeline, 1)).toBeUndefined();
    expect(pipelineReviewerInstructions(pipeline, 5)).toBeUndefined();
    expect(pipelineReviewPreparationInstructions(pipeline)).toBe("Preparation rules.");
    expect(pipelineReviewPreparationInstructions({})).toBeUndefined();
  });
});
