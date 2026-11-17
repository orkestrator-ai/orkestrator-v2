import { describe, expect, test } from "bun:test";
import {
  MAX_PIPELINE_BUILD_STOP_REASON_LENGTH,
  isPipelineBuildOutcome,
  pipelineBuildOutcomeFromInput,
  pipelineBuildStop,
  pipelineBuildStopSummary,
  type PipelineBuildOutcome,
} from "./build-pipeline-build-outcome.js";
import { isBuildPipeline, type BuildPipeline, type PipelineSession } from "./build-pipeline.js";

const AT = "2026-11-17T10:00:00.000Z";

function session(overrides: Partial<PipelineSession> = {}): PipelineSession {
  return {
    phase: "build",
    iteration: 0,
    sessionKey: "pipeline-1:build:0:a",
    sdkSessionId: "sdk-build",
    status: "idle",
    startedAt: AT,
    label: "Build Session",
    ...overrides,
  };
}

function pipeline(overrides: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "claude",
    phase: "complete",
    sessions: [session()],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: AT,
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
    ...overrides,
  };
}

const applied: PipelineBuildOutcome = {
  continueReview: false,
  stopKind: "no-work-needed",
  stopReason: "The setting already exists.",
  reportedAt: AT,
  appliedAt: AT,
};

describe("isPipelineBuildOutcome", () => {
  test("accepts a continue and a complete stop, and nothing in between", () => {
    expect(isPipelineBuildOutcome({ continueReview: true, reportedAt: AT })).toBe(true);
    expect(isPipelineBuildOutcome(applied)).toBe(true);
    expect(isPipelineBuildOutcome({ ...applied, stopKind: "blocked" })).toBe(true);
    // A stop needs its kind and reason; a continue carries neither.
    expect(isPipelineBuildOutcome({ continueReview: false, reportedAt: AT })).toBe(false);
    expect(isPipelineBuildOutcome({ ...applied, stopReason: " " })).toBe(false);
    expect(isPipelineBuildOutcome({ ...applied, stopKind: "maybe" })).toBe(false);
    expect(isPipelineBuildOutcome({ ...applied, continueReview: true })).toBe(false);
    expect(
      isPipelineBuildOutcome({
        ...applied,
        stopReason: "x".repeat(MAX_PIPELINE_BUILD_STOP_REASON_LENGTH + 1),
      }),
    ).toBe(false);
    expect(isPipelineBuildOutcome({ ...applied, appliedAt: "later" })).toBe(false);
    expect(isPipelineBuildOutcome({ continueReview: "no", reportedAt: AT })).toBe(false);
    expect(isPipelineBuildOutcome(null)).toBe(false);
  });

  test("a pipeline accepts it on a Build session only", () => {
    expect(isBuildPipeline(pipeline({ sessions: [session({ buildOutcome: applied })] }))).toBe(
      true,
    );
    expect(
      isBuildPipeline(
        pipeline({ sessions: [session({ phase: "rework", buildOutcome: applied })] }),
      ),
    ).toBe(false);
    expect(
      isBuildPipeline(
        pipeline({
          sessions: [session({ buildOutcome: { continueReview: false, reportedAt: AT } as never })],
        }),
      ),
    ).toBe(false);
  });
});

describe("pipelineBuildOutcomeFromInput", () => {
  test("a continue refuses stop details", () => {
    for (const detail of [{ stopKind: "blocked" as const }, { stopReason: "x" }]) {
      expect(pipelineBuildOutcomeFromInput({ continueReview: true, ...detail }, AT)).toHaveProperty(
        "error",
      );
    }
    expect(pipelineBuildOutcomeFromInput({ continueReview: true }, AT)).toEqual({
      continueReview: true,
      reportedAt: AT,
    });
  });

  test("a stop needs a reason, defaults to no-work-needed and is bounded", () => {
    expect(pipelineBuildOutcomeFromInput({ continueReview: false }, AT)).toHaveProperty("error");
    expect(
      pipelineBuildOutcomeFromInput({ continueReview: false, stopReason: "   " }, AT),
    ).toHaveProperty("error");
    expect(
      pipelineBuildOutcomeFromInput({ continueReview: false, stopReason: " Already done. " }, AT),
    ).toEqual({
      continueReview: false,
      stopKind: "no-work-needed",
      stopReason: "Already done.",
      reportedAt: AT,
    });
    const long = pipelineBuildOutcomeFromInput(
      { continueReview: false, stopKind: "blocked", stopReason: "y".repeat(5_000) },
      AT,
    );
    expect(isPipelineBuildOutcome(long)).toBe(true);
    expect((long as PipelineBuildOutcome).stopReason!.endsWith("…")).toBe(true);
    expect(
      pipelineBuildOutcomeFromInput(
        { continueReview: false, stopKind: "later" as never, stopReason: "x" },
        AT,
      ),
    ).toHaveProperty("error");
  });
});

describe("pipelineBuildStop", () => {
  test("reports an applied stop on a completed run", () => {
    expect(pipelineBuildStop(pipeline({ sessions: [session({ buildOutcome: applied })] }))).toEqual(
      { stopKind: "no-work-needed", stopReason: "The setting already exists.", appliedAt: AT },
    );
  });

  test("reports a blocked stop only while the run is paused from Build", () => {
    const blocked = { ...applied, stopKind: "blocked" as const };
    const sessions = [session({ buildOutcome: blocked })];
    expect(
      pipelineBuildStop(pipeline({ phase: "paused", pausedFromPhase: "building", sessions })),
    ).toMatchObject({ stopKind: "blocked" });
    expect(pipelineBuildStop(pipeline({ phase: "building", sessions }))).toBeUndefined();
    expect(pipelineBuildStop(pipeline({ phase: "failed", sessions }))).toBeUndefined();
  });

  test("ignores an unapplied, continuing, superseded or overridden report", () => {
    const { appliedAt: _unused, ...unapplied } = applied;
    for (const sessions of [
      [session({ buildOutcome: unapplied })],
      [session({ buildOutcome: { continueReview: true, reportedAt: AT } })],
      [session({ buildOutcome: applied, supersededBy: "rewind-1" })],
      [session()],
      // A later stage ran: the stop no longer describes where the run is.
      [
        session({ buildOutcome: applied }),
        session({ phase: "review", sessionKey: "review", label: "Review Session" }),
      ],
    ]) {
      expect(pipelineBuildStop(pipeline({ sessions }))).toBeUndefined();
    }
  });
});

test("pipelineBuildStopSummary names what was skipped and why", () => {
  expect(pipelineBuildStopSummary({ stopKind: "no-work-needed", stopReason: "Done." })).toBe(
    "Build found no further work, so review, fixes and the pull request were skipped: Done.",
  );
  expect(pipelineBuildStopSummary({ stopKind: "blocked", stopReason: "No key." })).toBe(
    "Build stopped before review: No key.",
  );
});
