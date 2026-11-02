import { describe, expect, test } from "bun:test";
import { REVIEW_PACKAGE_SESSION_LABEL, type BuildPipeline } from "./build-pipeline.js";
import {
  applyBuildPipelineRestartSelection,
  isBuildPipelineRestartSelection,
  pipelineRestartSlot,
} from "./build-pipeline-restart-selection.js";

const SECURITY = { label: "Security", instruction: "Look for injection." };
const codex = { agent: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" } as const;

function fanoutPipeline(): Pick<BuildPipeline, "steps" | "reviewers" | "reviewPreparation"> {
  return {
    steps: {
      build: { agent: "claude", model: "opus", instructions: "Small diffs." },
      review: { agent: "claude", model: "opus", lens: SECURITY },
    },
    reviewers: [
      { agent: "claude", model: "opus", lens: SECURITY },
      { agent: "cursor", model: "composer" },
    ],
  };
}

describe("isBuildPipelineRestartSelection", () => {
  test("accepts a selection and refuses unknown agents, blank models and extra keys", () => {
    expect(isBuildPipelineRestartSelection(codex)).toBe(true);
    expect(isBuildPipelineRestartSelection({ ...codex, fastMode: false })).toBe(true);
    expect(isBuildPipelineRestartSelection({ ...codex, agent: "gemini" })).toBe(false);
    expect(isBuildPipelineRestartSelection({ ...codex, model: "  " })).toBe(false);
    expect(isBuildPipelineRestartSelection({ ...codex, lens: "x" })).toBe(false);
    expect(isBuildPipelineRestartSelection({ ...codex, fastMode: "yes" })).toBe(false);
  });
});

describe("pipelineRestartSlot", () => {
  const pipeline = fanoutPipeline();

  test("maps each session to the configuration its step reads", () => {
    expect(pipelineRestartSlot(pipeline, { phase: "build", label: "Build Session" })).toEqual({
      kind: "step",
      step: "build",
    });
    expect(pipelineRestartSlot(pipeline, { phase: "fix", label: "Fix Session" })).toEqual({
      kind: "step",
      step: "build",
    });
    expect(pipelineRestartSlot(pipeline, { phase: "verify", label: "Verify" })).toEqual({
      kind: "step",
      step: "verify",
    });
    expect(pipelineRestartSlot(pipeline, { phase: "review", label: "Review 2" })).toEqual({
      kind: "reviewer",
      slot: 1,
    });
    expect(pipelineRestartSlot(pipeline, { phase: "review", label: "Consolidation" })).toEqual({
      kind: "review-preparation",
    });
    expect(
      pipelineRestartSlot(pipeline, { phase: "fix", label: REVIEW_PACKAGE_SESSION_LABEL }),
    ).toEqual({ kind: "review-preparation" });
  });

  test("has no slot for a reviewer the configuration no longer lists", () => {
    expect(pipelineRestartSlot(pipeline, { phase: "review", label: "Review 3" })).toBeNull();
  });
});

describe("applyBuildPipelineRestartSelection", () => {
  test("replaces a step's selection and keeps its instructions", () => {
    const pipeline = fanoutPipeline();
    applyBuildPipelineRestartSelection(pipeline, { kind: "step", step: "build" }, codex);
    expect(pipeline.steps?.build).toEqual({ ...codex, instructions: "Small diffs." });
  });

  test("changes only the restarted reviewer, and reviewer one in both places", () => {
    const pipeline = fanoutPipeline();
    applyBuildPipelineRestartSelection(pipeline, { kind: "reviewer", slot: 1 }, codex);
    expect(pipeline.reviewers?.[1]).toEqual(codex);
    expect(pipeline.reviewers?.[0]?.agent).toBe("claude");
    expect(pipeline.steps?.review?.agent).toBe("claude");

    applyBuildPipelineRestartSelection(pipeline, { kind: "reviewer", slot: 0 }, codex);
    expect(pipeline.reviewers?.[0]).toEqual({ ...codex, lens: SECURITY });
    expect(pipeline.steps?.review).toEqual({ ...codex, lens: SECURITY });
  });

  test("sets preparation and consolidation's shared selection", () => {
    const pipeline = fanoutPipeline();
    applyBuildPipelineRestartSelection(
      pipeline,
      { kind: "review-preparation" },
      {
        ...codex,
        reasoningEffort: "default",
      },
    );
    expect(pipeline.reviewPreparation).toEqual({ agent: "codex", model: "gpt-6.1-sol" });
  });
});
