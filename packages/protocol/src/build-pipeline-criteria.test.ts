import { describe, expect, test } from "bun:test";
import {
  taskSnapshotCriteria,
  type BuildPipeline,
  type PipelineSession,
} from "./build-pipeline.js";
import { pipelineCriteriaStatusWord, pipelineCriteriaView } from "./build-pipeline-criteria.js";

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
