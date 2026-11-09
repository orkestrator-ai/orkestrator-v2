import { describe, expect, test } from "bun:test";
import {
  taskSnapshotCriteria,
  type BuildPipeline,
  type PipelineSession,
} from "./build-pipeline.js";
import {
  pipelineCriteriaStatusWord,
  pipelineCriteriaView,
  verifySessionJudgedCode,
} from "./build-pipeline-criteria.js";

const snapshot = {
  title: "Ticket",
  description: "",
  acceptanceCriteria: "- First\n- Second",
  comments: [],
  images: [],
};

function verify(
  overrides: Partial<PipelineSession>,
  status: "passed" | "failed" = "passed",
): PipelineSession {
  const ids = taskSnapshotCriteria(snapshot).map(({ id }) => id);
  return {
    phase: "verify",
    startedAt: "2026-01-01T00:00:00.000Z",
    acceptanceCriteriaResults: ids.map((id) => ({ id, status, evidence: "seen" })),
    ...overrides,
  } as PipelineSession;
}

function pipeline(sessions: PipelineSession[]): BuildPipeline {
  return {
    id: "pipeline-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    taskSnapshot: snapshot,
    sessions,
  } as unknown as BuildPipeline;
}

describe("pipelineCriteriaView", () => {
  test("judges the criteria by the newest Verify that reported", () => {
    const older = verify({ startedAt: "2026-01-01T01:00:00.000Z" }, "failed");
    const newer = verify({ startedAt: "2026-01-01T02:00:00.000Z" }, "passed");
    const view = pipelineCriteriaView(pipeline([older, newer]));
    expect(view.verifySession).toBe(newer);
    expect(view.criteria.map((criterion) => criterion.check?.status)).toEqual(["passed", "passed"]);
  });

  test("never takes the ticks from a superseded Verify", () => {
    const live = verify({ startedAt: "2026-01-01T01:00:00.000Z" }, "failed");
    const superseded = verify({ supersededBy: "restart-1" } as Partial<PipelineSession>, "passed");
    const view = pipelineCriteriaView(pipeline([live, superseded]));
    expect(view.verifySession).toBe(live);
    expect(pipelineCriteriaStatusWord(pipeline([live, superseded]))).toEqual({
      text: "0/2 criteria",
      tone: "destructive",
    });
  });

  test("reports criteria without checks before any Verify ran", () => {
    const view = pipelineCriteriaView(pipeline([]));
    expect(view.verifySession).toBeUndefined();
    expect(view.criteria.map(({ text }) => text)).toEqual(["First", "Second"]);
    expect(pipelineCriteriaStatusWord(pipeline([]))).toBeUndefined();
  });
});

describe("verifySessionJudgedCode", () => {
  const HEAD = "ABC1234".toLowerCase() + "0".repeat(33);

  test("names the commit the read-only guard held the worktree to", () => {
    expect(
      verifySessionJudgedCode({
        validationHeadAtStart: HEAD.toUpperCase(),
        validationWorktreeStatusAtStart: "clean",
        validationUncommittedPathsAtStart: [],
      }),
    ).toEqual({ commit: HEAD });
  });

  test("marks a dirty worktree, by status or by its recorded paths", () => {
    expect(
      verifySessionJudgedCode({
        validationHeadAtStart: HEAD,
        validationWorktreeStatusAtStart: "dirty",
      }),
    ).toEqual({ commit: HEAD, uncommittedChanges: true });
    expect(
      verifySessionJudgedCode({
        validationHeadAtStart: HEAD,
        validationUncommittedPathsAtStart: ["src/a.ts"],
      }),
    ).toEqual({ commit: HEAD, uncommittedChanges: true });
  });

  test("records nothing without a usable HEAD", () => {
    expect(verifySessionJudgedCode({})).toEqual({});
    expect(verifySessionJudgedCode({ validationHeadAtStart: "not-a-commit" })).toEqual({});
  });

  test("the pipeline view's checks carry the judged commit", () => {
    const view = pipelineCriteriaView(
      pipeline([verify({ validationHeadAtStart: HEAD, validationWorktreeStatusAtStart: "dirty" })]),
    );
    for (const criterion of view.criteria) {
      expect(criterion.check).toMatchObject({ commit: HEAD, uncommittedChanges: true });
    }
    // A Verify from before the baseline existed names no commit.
    const legacy = pipelineCriteriaView(pipeline([verify({})]));
    for (const criterion of legacy.criteria) expect(criterion.check?.commit).toBeUndefined();
  });
});
