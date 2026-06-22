import { describe, expect, test } from "bun:test";
import {
  createPipelineResumePrompt,
  getPipelineResumePhase,
} from "../../../src/lib/build-pipeline-resume";
import type {
  BuildPipeline,
  PipelineSession,
  ResumableBuildPhase,
} from "../../../src/stores/buildPipelineStore";

function createSession(phase: PipelineSession["phase"]): PipelineSession {
  return {
    phase,
    iteration: 0,
    sessionKey: "env-1:build",
    sdkSessionId: "session-1",
    status: "idle",
    startedAt: "2026-06-22T00:00:00.000Z",
    label: "Build Session",
  };
}

function createPipeline(
  sessionPhase: PipelineSession["phase"] | null,
  overrides: Partial<Pick<BuildPipeline, "pausedFromPhase" | "currentSessionIndex">> = {},
): Pick<BuildPipeline, "pausedFromPhase" | "sessions" | "currentSessionIndex"> {
  return {
    pausedFromPhase: overrides.pausedFromPhase,
    sessions: sessionPhase ? [createSession(sessionPhase)] : [],
    currentSessionIndex: overrides.currentSessionIndex ?? (sessionPhase ? 0 : -1),
  };
}

describe("build-pipeline-resume", () => {
  test("prefers the phase captured when the pipeline was paused", () => {
    const pipeline = createPipeline("build", { pausedFromPhase: "verifying" });

    expect(getPipelineResumePhase(pipeline)).toBe("verifying");
  });

  test.each([
    ["build", "building"],
    ["review", "reviewing"],
    ["verify", "verifying"],
    ["fix", "fixing"],
    ["pr", "creating-pr"],
    ["resolve-conflicts", "resolving-conflicts"],
  ] as const)("maps %s sessions to %s", (sessionPhase, resumePhase) => {
    expect(getPipelineResumePhase(createPipeline(sessionPhase))).toBe(resumePhase);
  });

  test("falls back to setup when there is no current session", () => {
    expect(getPipelineResumePhase(createPipeline(null))).toBe("waiting-for-setup");
  });

  test("returns actionable prompts for agent-backed phases", () => {
    const phases: ResumableBuildPhase[] = [
      "building",
      "reviewing",
      "addressing",
      "verifying",
      "fixing",
      "creating-pr",
      "resolving-conflicts",
    ];

    for (const phase of phases) {
      expect(createPipelineResumePrompt(phase)).toContain("Resume");
    }
  });

  test("does not create prompts for setup-only phases", () => {
    expect(createPipelineResumePrompt("creating-environment")).toBeNull();
    expect(createPipelineResumePrompt("starting-environment")).toBeNull();
    expect(createPipelineResumePrompt("waiting-for-setup")).toBeNull();
  });
});
