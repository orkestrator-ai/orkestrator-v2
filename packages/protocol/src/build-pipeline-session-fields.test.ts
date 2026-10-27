import { describe, expect, test } from "bun:test";
import {
  MAX_PIPELINE_SESSION_ERROR_LENGTH,
  boundedPipelineSessionError,
  isBuildPipeline,
  pipelineReviewIssueCounts,
  type BuildPipeline,
  type PipelineSession,
} from "./build-pipeline.js";

function pipelineWith(session: Partial<PipelineSession> & Record<string, unknown>): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "codex",
    phase: "reviewing",
    sessions: [
      {
        phase: "review",
        iteration: 0,
        sessionKey: "review-1",
        sdkSessionId: "sdk-review-1",
        status: "idle",
        startedAt: "2026-10-26T00:00:00.000Z",
        label: "Review 1",
        ...session,
      } as PipelineSession,
    ],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-10-26T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
  };
}

describe("pipeline session graph fields", () => {
  test("accepts the reviewer outcome, error and issue counts, and records without them", () => {
    expect(isBuildPipeline(pipelineWith({}))).toBe(true);
    expect(
      isBuildPipeline(
        pipelineWith({
          reviewPassId: "panel-1",
          superseded: true,
          reviewerOutcome: "failed",
          error: "Provider crashed",
          reviewIssueCounts: { P0: 1, P1: 0, P2: 2 },
        }),
      ),
    ).toBe(true);
  });

  test("rejects malformed values", () => {
    expect(isBuildPipeline(pipelineWith({ reviewerOutcome: "stalled" as never }))).toBe(false);
    expect(isBuildPipeline(pipelineWith({ reviewPassId: "" }))).toBe(false);
    expect(isBuildPipeline(pipelineWith({ superseded: "yes" as never }))).toBe(false);
    expect(isBuildPipeline(pipelineWith({ error: "" }))).toBe(false);
    expect(
      isBuildPipeline(pipelineWith({ error: "x".repeat(MAX_PIPELINE_SESSION_ERROR_LENGTH + 1) })),
    ).toBe(false);
    expect(isBuildPipeline(pipelineWith({ reviewIssueCounts: { P0: -1, P1: 0, P2: 0 } }))).toBe(
      false,
    );
    expect(isBuildPipeline(pipelineWith({ reviewIssueCounts: { P0: 1 } as never }))).toBe(false);
  });

  test("validates bounded sessionless reviewer history", () => {
    const reviewer = {
      id: "r2",
      slot: 1,
      agent: "codex" as const,
      model: "gpt",
      error: "Creation failed",
    };
    expect(isBuildPipeline(pipelineWith({ sessionlessReviewers: [reviewer] }))).toBe(true);
    for (const invalid of [
      { ...reviewer, slot: -1 },
      { ...reviewer, error: "" },
      { ...reviewer, model: "x".repeat(257) },
      { ...reviewer, agent: "unknown" },
    ]) {
      expect(isBuildPipeline(pipelineWith({ sessionlessReviewers: [invalid] as never }))).toBe(
        false,
      );
    }
    expect(isBuildPipeline(pipelineWith({ sessionlessReviewers: Array(100).fill(reviewer) }))).toBe(
      false,
    );
  });

  test("counts a report's issues by severity", () => {
    expect(
      pipelineReviewIssueCounts({
        issues: [{ severity: "P0" }, { severity: "P2" }, { severity: "P2" }],
      }),
    ).toEqual({ P0: 1, P1: 0, P2: 2 });
  });

  test("bounds a stored error", () => {
    expect(boundedPipelineSessionError("  short  ")).toBe("short");
    for (const error of ["", " \n\t"]) {
      expect(isBuildPipeline(pipelineWith({ error: boundedPipelineSessionError(error) }))).toBe(
        true,
      );
    }
    const long = boundedPipelineSessionError("y".repeat(MAX_PIPELINE_SESSION_ERROR_LENGTH * 2));
    expect(long).toHaveLength(MAX_PIPELINE_SESSION_ERROR_LENGTH);
    expect(isBuildPipeline(pipelineWith({ error: long }))).toBe(true);
  });
});
