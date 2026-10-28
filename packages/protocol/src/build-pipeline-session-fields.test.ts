import { describe, expect, test } from "bun:test";
import { newReviewValidationRun } from "./review-workflow.js";
import {
  MAX_PIPELINE_REWINDS,
  MAX_PIPELINE_SESSION_ERROR_LENGTH,
  MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH,
  boundedPipelineSessionError,
  isBuildPipeline,
  isSupersededPipelineSession,
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
  test("Kanban retry deadlines are optional ISO timestamps", () => {
    const pipeline = pipelineWith({});
    expect(isBuildPipeline(pipeline)).toBe(true);
    pipeline.pendingKanbanReactivation = true;
    pipeline.kanbanReactivationRetryAt = "2026-10-27T20:00:00.000Z";
    expect(isBuildPipeline(pipeline)).toBe(true);
    for (const invalid of ["", "tomorrow", "2026-99-99T00:00:00Z", 100, null]) {
      expect(isBuildPipeline({ ...pipeline, kanbanReactivationRetryAt: invalid })).toBe(false);
    }
  });
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

describe("pipeline rewind fields", () => {
  const rewind = {
    id: "rewind-1",
    at: "2026-10-26T01:00:00.000Z",
    fromPhase: "failed",
    fromIteration: 3,
    iteration: 0,
    step: { kind: "session", phase: "verify" },
    sessionKey: "verify-1",
    supersededSessions: 10,
  };

  test("accepts superseded sessions, verdict copies and rewinds, and records without them", () => {
    expect(isBuildPipeline(pipelineWith({}))).toBe(true);
    expect(
      isBuildPipeline({
        ...pipelineWith({
          supersededBy: "rewind-1",
          supersededAt: "2026-10-26T01:00:00.000Z",
        }),
        rewinds: [rewind],
      }),
    ).toBe(true);
    expect(
      isBuildPipeline(
        pipelineWith({ phase: "verify", verificationResult: "fail", verificationFeedback: "No" }),
      ),
    ).toBe(true);
    expect(isSupersededPipelineSession({ supersededBy: "rewind-1" })).toBe(true);
    expect(isSupersededPipelineSession({})).toBe(false);
    expect(isSupersededPipelineSession(undefined)).toBe(false);
  });

  test("validates retained validation runs and durable Kanban reactivation", () => {
    const run = newReviewValidationRun("retained", {
      headRef: "a".repeat(40),
      commands: [],
      limitations: ["No validation configured"],
    });
    expect(
      isBuildPipeline({
        ...pipelineWith({}),
        rewinds: [{ ...rewind, validationRun: run, replacementValidationRunId: "replacement" }],
        pendingKanbanReactivation: true,
      }),
    ).toBe(true);
    expect(isBuildPipeline({ ...pipelineWith({}), pendingKanbanReactivation: "yes" })).toBe(false);
    expect(
      isBuildPipeline({
        ...pipelineWith({}),
        rewinds: [{ ...rewind, validationRun: { ...run, status: "invalid" } }],
      }),
    ).toBe(false);
  });

  test("rejects malformed rewind fields", () => {
    for (const invalid of ["", 1, null, "x".repeat(513)]) {
      expect(
        isBuildPipeline({
          ...pipelineWith({}),
          rewinds: [{ ...rewind, replacementValidationRunId: invalid }],
        }),
      ).toBe(false);
    }
    expect(isBuildPipeline(pipelineWith({ supersededBy: "" }))).toBe(false);
    expect(isBuildPipeline(pipelineWith({ supersededAt: "yesterday" }))).toBe(false);
    // A verdict copy belongs to a verify session only.
    expect(isBuildPipeline(pipelineWith({ verificationResult: "fail" }))).toBe(false);
    expect(
      isBuildPipeline(
        pipelineWith({
          phase: "verify",
          verificationFeedback: "x".repeat(MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH + 1),
        }),
      ),
    ).toBe(false);
    expect(isBuildPipeline({ ...pipelineWith({}), rewinds: {} })).toBe(false);
    expect(
      isBuildPipeline({ ...pipelineWith({}), rewinds: [{ ...rewind, step: { kind: "nope" } }] }),
    ).toBe(false);
    expect(
      isBuildPipeline({ ...pipelineWith({}), rewinds: [{ ...rewind, supersededSessions: -1 }] }),
    ).toBe(false);
    expect(
      isBuildPipeline({
        ...pipelineWith({}),
        rewinds: Array.from({ length: MAX_PIPELINE_REWINDS + 1 }, () => rewind),
      }),
    ).toBe(false);
  });

  test("start commits and code rewinds are validated commit IDs and backup refs", () => {
    const from = "c".repeat(40);
    const to = "a".repeat(64);
    const code = {
      from,
      to,
      droppedCommits: 3,
      backupRef: "refs/orkestrator/build-pipeline-rewinds/pipeline-1/rewind-1",
      upstream: "origin/build",
      upstreamCommitsDropped: 2,
    };
    expect(isBuildPipeline(pipelineWith({ headAtStart: to }))).toBe(true);
    expect(isBuildPipeline(pipelineWith({ headAtStart: "HEAD" }))).toBe(false);
    expect(isBuildPipeline({ ...pipelineWith({}), rewinds: [{ ...rewind, code }] })).toBe(true);
    const { upstream: _upstream, upstreamCommitsDropped: _dropped, ...local } = code;
    expect(isBuildPipeline({ ...pipelineWith({}), rewinds: [{ ...rewind, code: local }] })).toBe(
      true,
    );
    for (const invalid of [
      { ...code, from: "main" },
      { ...code, droppedCommits: -1 },
      { ...code, backupRef: "refs/heads/main" },
      { ...code, upstreamCommitsDropped: 1.5 },
    ]) {
      expect(
        isBuildPipeline({ ...pipelineWith({}), rewinds: [{ ...rewind, code: invalid }] }),
      ).toBe(false);
    }
  });
});
