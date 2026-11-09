import { describe, expect, test } from "bun:test";
import { COORDINATOR_HANDOFF_RULE } from "@orkestrator/protocol/coordinator";
import {
  buildPipelineCriteriaReport,
  criteriaNoticeLines,
} from "./build-pipeline-criteria-report.js";
import { buildPipelineStatus } from "./coordinator-build-pipeline-status.js";
import { renderCoordinatorStatusNotice } from "./coordinator-status-wakes.js";
import { workflowSummary } from "./control-workflow-summary.js";

const HEAD = `abc1234${"0".repeat(33)}`;

type Result = { id: string; status: "passed" | "failed" | "not-checked"; evidence: string };

/** A pipeline snapshot as stored, with one Verify session that judged `results`. */
function snapshot(
  texts: string[],
  results: Result[] | undefined,
  overrides: Record<string, unknown> = {},
  session: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "pipeline-1",
    phase: "complete",
    createdAt: "2026-11-08T00:00:00.000Z",
    taskTitle: "Move the runner",
    verificationResult: "pass",
    taskSnapshot: {
      title: "Move the runner",
      description: "",
      acceptanceCriteria: texts.map((text) => `- ${text}`).join("\n"),
      comments: [],
      images: [],
      acceptanceCriteriaItems: texts.map((text, index) => ({ id: `ac-${index + 1}`, text })),
    },
    sessions:
      results === undefined
        ? []
        : [
            {
              id: "verify-1",
              phase: "verify",
              status: "completed",
              startedAt: "2026-11-08T01:00:00.000Z",
              completedAt: "2026-11-08T01:10:00.000Z",
              acceptanceCriteriaResults: results,
              validationHeadAtStart: HEAD,
              validationWorktreeStatusAtStart: "clean",
              validationUncommittedPathsAtStart: [],
              ...session,
            },
          ],
    ...overrides,
  };
}

describe("buildPipelineCriteriaReport", () => {
  test("counts each status, lists failures first and names the judged commit", () => {
    const report = buildPipelineCriteriaReport(
      snapshot(
        ["One", "Two", "Three"],
        [
          { id: "ac-1", status: "passed", evidence: "test passes" },
          { id: "ac-2", status: "failed", evidence: "no ticks" },
          { id: "ac-3", status: "not-checked", evidence: "needs a device" },
        ],
      ),
    );
    expect(report).toEqual({
      commit: HEAD,
      judged: "commit abc1234",
      checkedAt: "2026-11-08T01:10:00.000Z",
      total: 3,
      passed: 1,
      failed: 1,
      notChecked: 1,
      criteria: [
        { id: "ac-2", text: "Two", status: "failed", evidence: "no ticks" },
        { id: "ac-3", text: "Three", status: "not-checked", evidence: "needs a device" },
        { id: "ac-1", text: "One", status: "passed", evidence: "test passes" },
      ],
    });
  });

  test("a criterion Verify did not report is not checked, never passed", () => {
    const report = buildPipelineCriteriaReport(
      snapshot(["One", "Two"], [{ id: "ac-1", status: "passed", evidence: "ok" }]),
    )!;
    expect(report).toMatchObject({ passed: 1, notChecked: 1 });
    expect(report.criteria[0]).toMatchObject({ id: "ac-2", status: "not-checked" });
  });

  test("says when the commit was not recorded, or the worktree was dirty", () => {
    const results: Result[] = [{ id: "ac-1", status: "passed", evidence: "ok" }];
    const unrecorded = buildPipelineCriteriaReport(
      snapshot(["One"], results, {}, { validationHeadAtStart: undefined }),
    )!;
    expect(unrecorded.judged).toBe("commit not recorded");
    expect(unrecorded.commit).toBeUndefined();
    const dirty = buildPipelineCriteriaReport(
      snapshot(["One"], results, {}, { validationWorktreeStatusAtStart: "dirty" }),
    )!;
    expect(dirty).toMatchObject({
      commit: HEAD,
      uncommittedChanges: true,
      judged: "commit abc1234 with uncommitted changes",
    });
  });

  test("is null before any Verify reported, and for unreadable snapshots", () => {
    expect(buildPipelineCriteriaReport(snapshot(["One"], undefined))).toBeNull();
    expect(buildPipelineCriteriaReport({ phase: "complete" })).toBeNull();
    expect(buildPipelineCriteriaReport({ sessions: [], taskSnapshot: "x" })).toBeNull();
    expect(buildPipelineCriteriaReport(null)).toBeNull();
  });

  test("stays bounded: long text is cut and the list stops at its byte budget", () => {
    const texts = Array.from({ length: 100 }, (_, index) => `${index} ${"t".repeat(9_000)}`);
    const report = buildPipelineCriteriaReport(
      snapshot(
        texts,
        texts.map((_, index) => ({
          id: `ac-${index + 1}`,
          status: "failed",
          evidence: "e".repeat(2_000),
        })),
      ),
    )!;
    expect(report.total).toBe(100);
    expect(report.failed).toBe(100);
    expect(report.criteriaTruncated).toBe(true);
    expect(report.criteria.length).toBeLessThan(100);
    expect(report.criteria[0]).toMatchObject({ textTruncated: true });
    expect(report.criteria[0]!.text.length).toBe(500);
    expect(Buffer.byteLength(JSON.stringify(report.criteria))).toBeLessThanOrEqual(48 * 1024);
  });
});

describe("criteriaNoticeLines", () => {
  const report = (failed: number, passed = 1) =>
    buildPipelineCriteriaReport(
      snapshot(
        Array.from({ length: failed + passed }, (_, index) => `Criterion ${index + 1}`),
        Array.from({ length: failed + passed }, (_, index) => ({
          id: `ac-${index + 1}`,
          status: index < failed ? ("failed" as const) : ("passed" as const),
          evidence: "seen",
        })),
      ),
    );

  test("a tally naming the commit, then each criterion that did not pass", () => {
    expect(criteriaNoticeLines(report(2), 8)).toEqual([
      "Acceptance criteria: 1/3 passed, 2 failed; Verify judged commit abc1234.",
      "Failed ac-1: Criterion 1",
      "Failed ac-2: Criterion 2",
    ]);
    expect(criteriaNoticeLines(report(0, 2), 8)).toEqual([
      "Acceptance criteria: 2/2 passed; Verify judged commit abc1234.",
    ]);
  });

  test("never exceeds its budget, and says how many it left out", () => {
    const lines = criteriaNoticeLines(report(10), 4);
    expect(lines).toEqual([
      "Acceptance criteria: 1/11 passed, 10 failed; Verify judged commit abc1234.",
      "Failed ac-1: Criterion 1",
      "Failed ac-2: Criterion 2",
      "8 more not passed; get_build_pipeline lists every criterion with its evidence.",
    ]);
    expect(criteriaNoticeLines(report(10), 1)).toHaveLength(1);
    expect(criteriaNoticeLines(report(10), 0)).toEqual([]);
    expect(criteriaNoticeLines(null, 8)).toEqual([]);
  });
});

describe("build pipeline wakes carry the criteria", () => {
  const results: Result[] = [
    { id: "ac-1", status: "passed", evidence: "test passes" },
    { id: "ac-2", status: "failed", evidence: "no ticks" },
  ];

  test("a completed build names the results and the judged commit, before delivery", () => {
    const status = buildPipelineStatus(
      snapshot(["One", "Two"], results, {
        delivery: { policy: "push-no-pr", decidedAt: "2026-11-08T02:00:00.000Z" },
      }),
      "pipeline-1",
    )!;
    expect(status.details).toEqual([
      "Task: Move the runner",
      "Last verification: pass.",
      "Acceptance criteria: 1/2 passed, 1 failed; Verify judged commit abc1234.",
      "Failed ac-2: Two",
      "The branch was pushed and no pull request was opened.",
    ]);
  });

  test("the delivery line survives a ticket with many failures", () => {
    const texts = Array.from({ length: 20 }, (_, index) => `Criterion ${index + 1}`);
    const status = buildPipelineStatus(
      snapshot(
        texts,
        texts.map((_, index) => ({ id: `ac-${index + 1}`, status: "failed", evidence: "x" })),
        { delivery: { policy: "push-no-pr", decidedAt: "2026-11-08T02:00:00.000Z" } },
      ),
      "pipeline-1",
    )!;
    expect(status.details).toHaveLength(8);
    expect(status.details[7]).toBe("The branch was pushed and no pull request was opened.");
    expect(status.details[6]).toContain("more not passed; get_build_pipeline");
  });

  test("a failed build names its criteria after the error", () => {
    const status = buildPipelineStatus(
      snapshot(["One", "Two"], results, {
        phase: "failed",
        error: "Verification failed after 3 iterations",
      }),
      "pipeline-1",
    )!;
    expect(status.details).toEqual([
      "Task: Move the runner",
      "Error: Verification failed after 3 iterations",
      "Acceptance criteria: 1/2 passed, 1 failed; Verify judged commit abc1234.",
      "Failed ac-2: Two",
    ]);
  });

  test("a terminal build or review wake asks for the handoff; progress does not", () => {
    const resource = { kind: "build-pipeline" as const, id: "pipeline-1" };
    const complete = buildPipelineStatus(snapshot(["One"], results.slice(0, 1)), "pipeline-1")!;
    const body = renderCoordinatorStatusNotice(resource, complete).body;
    expect(body).toContain(COORDINATOR_HANDOFF_RULE);
    expect(body).not.toContain("acknowledge it and finish the turn");
    const review = renderCoordinatorStatusNotice(
      { kind: "multi-review", id: "review-1" },
      { ...complete, key: "completed" },
    ).body;
    expect(review).toContain(COORDINATOR_HANDOFF_RULE);
    const stage = buildPipelineStatus({ phase: "verifying", iteration: 1 }, "pipeline-1")!;
    expect(stage.terminal).toBe(false);
    const progress = renderCoordinatorStatusNotice(resource, stage).body;
    expect(progress).not.toContain(COORDINATOR_HANDOFF_RULE);
    expect(progress).toContain("acknowledge it and finish the turn");
    const worker = renderCoordinatorStatusNotice(
      { kind: "agent-tab", id: "tab-1", environmentId: "env-1" },
      complete,
    ).body;
    expect(worker).not.toContain(COORDINATOR_HANDOFF_RULE);
  });
});

describe("get_build_pipeline", () => {
  test("returns the verdict and every criterion with its evidence and commit", () => {
    const summary = workflowSummary(
      snapshot(
        ["One", "Two"],
        [
          { id: "ac-1", status: "passed", evidence: "test passes" },
          { id: "ac-2", status: "failed", evidence: "no ticks" },
        ],
        { environmentId: "env-1" },
      ),
      { criteriaDetail: true },
    );
    expect(summary.verificationResult).toBe("pass");
    expect(summary.criteria).toMatchObject({
      commit: HEAD,
      judged: "commit abc1234",
      passed: 1,
      failed: 1,
      criteria: [
        { id: "ac-2", status: "failed", evidence: "no ticks" },
        { id: "ac-1", status: "passed", evidence: "test passes" },
      ],
    });
  });

  test("a Multi Review or a build before Verify carries no criteria", () => {
    expect(workflowSummary({ id: "review-1", phase: "ready" }).criteria).toBeUndefined();
    const before = workflowSummary(snapshot(["One"], undefined, { verificationResult: undefined }));
    expect(before.criteria).toBeUndefined();
    expect(before.verificationResult).toBeUndefined();
  });
});
