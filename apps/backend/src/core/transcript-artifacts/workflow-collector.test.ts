import { describe, expect, test } from "bun:test";
import { WORKFLOW_SNAPSHOT_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";
import { validateWorkflowSnapshot } from "@orkestrator/protocol/workflow-snapshot";
import {
  BUILD_PIPELINE_STATUS,
  MULTI_REVIEW_STATUS,
  REVIEWER_STATUS,
  adaptBuildPipeline,
  adaptMultiReview,
} from "./workflow-collector-adapters.js";
import {
  WorkflowSnapshotCollector,
  type WorkflowRecord,
  type WorkflowRecordReader,
} from "./workflow-collector.js";

const SCOPE = { environmentId: "env-1", projectId: "project-1" };

function multiReview(overrides: Record<string, unknown> = {}) {
  return {
    id: "mr-1",
    environmentId: "env-1",
    projectId: "project-1",
    phase: "consolidating",
    reviewers: [
      {
        id: "r1",
        status: "completed",
        model: "opus",
        report: { issues: [{ title: "x" }], testCoverageGaps: [{}] },
        sessionKey: "s1",
        startedAt: "2026-10-20T10:00:00.000Z",
        completedAt: "2026-10-20T10:01:00Z",
      },
      { id: "r2", status: "running", model: "gpt", sessionKey: "s2" },
      { id: "r3", status: "weird-status" },
    ],
    stepRuntimes: {
      prepare: { startedAt: "2026-10-20T09:00:00Z", completedAt: "2026-10-20T09:30:00Z" },
    },
    reviewSession: { status: "idle" },
    validationRun: {
      id: "v1",
      status: "completed",
      results: [{ status: "passed" }, { status: "failed" }],
      startedAt: "2026-10-20T09:10:00Z",
      completedAt: "2026-10-20T09:20:00Z",
      plan: { commands: [{ command: "SECRET-COMMAND" }] },
    },
    targetBranch: "main",
    reviewInstruction: "PROMPT TEXT THAT MUST NOT LEAK",
    ...overrides,
  };
}

function reader(
  records: Partial<Record<"multi" | "build", WorkflowRecord & { projectId?: string }>>,
  onRead?: (count: number) => void,
): WorkflowRecordReader {
  let reads = 0;
  const next = <T>(value: T | undefined): Promise<T | null> => {
    reads += 1;
    const copy = value ? structuredClone(value) : null;
    onRead?.(reads);
    return Promise.resolve(copy);
  };
  return {
    getMultiReviewWorkflow: (id) => next(records.multi?.id === id ? records.multi : undefined),
    getBuildPipeline: (id) =>
      next(
        records.build?.id === id
          ? ({
              ...records.build,
              projectId: records.build.projectId ?? "project-1",
            } as WorkflowRecord & { projectId: string })
          : undefined,
      ),
  };
}

describe("status adapters", () => {
  test("map every known phase and keep unknown states explicit", () => {
    expect(MULTI_REVIEW_STATUS).toMatchObject({
      completed: "succeeded",
      cancelled: "canceled",
      paused: "blocked",
      failed: "failed",
    });
    expect(REVIEWER_STATUS).toMatchObject({ completed: "succeeded", running: "running" });
    expect(BUILD_PIPELINE_STATUS.complete).toBe("succeeded");
    const adapted = adaptMultiReview("mr-1", multiReview());
    const r3 = adapted.nodes.find((node) => node.id === "reviewer:r3")!;
    expect(r3).toMatchObject({ status: "unknown", rawStatus: "weird-status" });
    expect(adapted.status).toBe("running");
  });

  test("multi review: accepted only for recorded reports, scoped link targets, no prompts", () => {
    const adapted = adaptMultiReview("mr-1", multiReview());
    const r1 = adapted.nodes.find((node) => node.id === "reviewer:r1")!;
    expect(r1.validation).toEqual({ state: "accepted", findingCount: 2 });
    expect(r1.links.map((link) => link.targetRef)).toEqual([
      "multi-review:mr-1:reviewer:r1",
      "multi-review:mr-1:reviewer:r1",
    ]);
    const r2 = adapted.nodes.find((node) => node.id === "reviewer:r2")!;
    expect(r2.validation?.state).toBe("pending");
    const consolidate = adapted.nodes.find((node) => node.id === "consolidate")!;
    expect(consolidate).toMatchObject({ status: "running", validation: { state: "pending" } });
    expect(adapted.nodes.find((node) => node.id === "prepare")).toMatchObject({
      status: "succeeded",
      links: [{ targetRef: "multi-review:mr-1" }],
    });
    expect(adapted.nodes.find((node) => node.id === "validation")?.validation).toEqual({
      state: "not-applicable",
      errorCount: 1,
    });
    const text = JSON.stringify(adapted);
    expect(text).not.toContain("PROMPT TEXT");
    expect(text).not.toContain("SECRET-COMMAND");
  });

  test("a report alone is not acceptance: the record must state it", () => {
    const multi = adaptMultiReview(
      "mr-1",
      multiReview({
        reviewers: [
          { id: "r1", status: "running", report: { issues: [{}], testCoverageGaps: [] } },
          { id: "r2", status: "failed", report: { issues: [], testCoverageGaps: [] } },
        ],
        phase: "consolidating",
        consolidatedReport: { issues: [{}], testCoverageGaps: [] },
      }),
    );
    expect(multi.nodes.find((node) => node.id === "reviewer:r1")?.validation).toEqual({
      state: "unknown",
    });
    expect(multi.nodes.find((node) => node.id === "reviewer:r2")?.validation).toEqual({
      state: "rejected",
    });
    // Consolidation still running: its report is not yet an accepted result.
    expect(multi.nodes.find((node) => node.id === "consolidate")?.validation).toEqual({
      state: "unknown",
    });
    const consolidated = adaptMultiReview(
      "mr-1",
      multiReview({
        phase: "completed",
        consolidatedReport: { issues: [{}], testCoverageGaps: [] },
        stepRuntimes: {
          prepare: { startedAt: "2026-10-20T09:00:00Z", completedAt: "2026-10-20T09:30:00Z" },
          consolidate: { startedAt: "2026-10-20T09:40:00Z", completedAt: "2026-10-20T09:50:00Z" },
        },
      }),
    );
    expect(consolidated.nodes.find((node) => node.id === "consolidate")?.validation).toEqual({
      state: "accepted",
      findingCount: 1,
    });

    const pipeline = (structuredResultStatus?: string) =>
      adaptBuildPipeline("bp-1", {
        phase: "addressing",
        currentSessionIndex: 1,
        structuredReview: { issues: [{}, {}], testCoverageGaps: [] },
        verificationResult: "maybe",
        sessions: [
          { phase: "build", status: "idle", iteration: 1 },
          {
            phase: "review",
            status: "idle",
            iteration: 1,
            ...(structuredResultStatus ? { structuredResultStatus } : {}),
          },
          { phase: "verify", status: "running", iteration: 1 },
        ],
      });
    expect(pipeline().nodes[2]!.validation).toEqual({ state: "unknown" });
    expect(pipeline("pending").nodes[2]!.validation).toEqual({ state: "unknown" });
    expect(pipeline("accepted").nodes[2]!.validation).toEqual({
      state: "accepted",
      findingCount: 2,
    });
    // An unrecognised verification value is not a recorded verdict.
    expect(pipeline("accepted").nodes[3]!.validation).toBeUndefined();
  });

  test("a reviewer id that is not a valid opaque reference gets no link", () => {
    const adapted = adaptMultiReview(
      "mr-1",
      multiReview({ reviewers: [{ id: "has space", status: "completed", sessionKey: "s" }] }),
    );
    expect(adapted.nodes.find((node) => node.id === "reviewer:has space")?.links).toEqual([]);
  });

  test("build pipeline sessions keep attempts and verification acceptance", () => {
    const adapted = adaptBuildPipeline("bp-1", {
      phase: "complete",
      taskTitle: "Add feature",
      currentSessionIndex: 3,
      verificationResult: "pass",
      sessions: [
        {
          phase: "build",
          status: "idle",
          iteration: 1,
          label: "Build",
          startedAt: "2026-10-20T09:00:00Z",
          completedAt: "2026-10-20T08:00:00Z",
        },
        { phase: "verify", status: "idle", iteration: 1, label: "Verify" },
        { phase: "fix", status: "idle", iteration: 2, label: "Fix" },
        { phase: "verify", status: "idle", iteration: 2, label: "Verify" },
      ],
    });
    expect(adapted.status).toBe("succeeded");
    expect(adapted.nodes[1]).toMatchObject({
      id: "session-0",
      attemptId: "iteration-1",
      startedAt: "2026-10-20T09:00:00.000Z",
    });
    expect(adapted.nodes[1]!.finishedAt).toBeUndefined(); // finish before start is dropped
    expect(adapted.nodes[4]!.validation).toEqual({ state: "accepted" });
    expect(adapted.nodes[2]!.validation).toBeUndefined();
    expect(adapted.edges.find((edge) => edge.to === "session-2")?.relation).toBe("retry");
    expect(adapted.nodes.every((node) => node.links.length === 0)).toBe(true);
  });
});

describe("WorkflowSnapshotCollector", () => {
  test("collects a valid snapshot bound to the record revision", async () => {
    const collector = new WorkflowSnapshotCollector(
      reader({
        multi: { id: "mr-1", environmentId: "env-1", revision: 7, snapshot: multiReview() },
      }),
      () => Date.parse("2026-10-20T12:00:00Z"),
    );
    const snapshot = await collector.collect(SCOPE, { workflowId: "multi-review", runId: "mr-1" });
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
    expect(snapshot).toMatchObject({
      runId: "mr-1",
      sourceRevision: "7",
      capturedAt: "2026-10-20T12:00:00.000Z",
    });
    expect(snapshot.completeness).toMatchObject({ mode: "complete", omittedNodes: 0 });
  });

  test("another environment or project is not_found; expected revision mismatch is a retryable conflict", async () => {
    const collector = new WorkflowSnapshotCollector(
      reader({
        multi: { id: "mr-1", environmentId: "env-1", revision: 7, snapshot: multiReview() },
      }),
    );
    for (const scope of [
      { environmentId: "env-2", projectId: "project-1" },
      { environmentId: "env-1", projectId: "project-2" },
    ]) {
      await expect(
        collector.collect(scope, { workflowId: "multi-review", runId: "mr-1" }),
      ).rejects.toMatchObject({ error: { code: "not_found" } });
    }
    await expect(
      collector.collect(SCOPE, { workflowId: "multi-review", runId: "missing" }),
    ).rejects.toMatchObject({ error: { code: "not_found" } });
    await expect(
      collector.collect(SCOPE, {
        workflowId: "multi-review",
        runId: "mr-1",
        expectedWorkflowRevision: "6",
      }),
    ).rejects.toMatchObject({
      error: { code: "revision_conflict", retryClass: "transient" },
    });
    await expect(
      collector.collect(SCOPE, { workflowId: "nope", runId: "mr-1" }),
    ).rejects.toBeInstanceOf(ArtifactFailure);
  });

  test("a record that changes between reads is never joined", async () => {
    const record = {
      id: "mr-1",
      environmentId: "env-1",
      revision: 1,
      snapshot: { projectId: "project-1", phase: "reviewing", reviewers: [] },
    };
    const collector = new WorkflowSnapshotCollector(
      reader({ multi: record }, (count) => {
        if (count === 1) record.revision = 2;
      }),
    );
    await expect(
      collector.collect(SCOPE, { workflowId: "multi-review", runId: "mr-1" }),
    ).rejects.toMatchObject({ error: { code: "revision_conflict" } });
  });

  test("summary mode keeps exact totals when a run exceeds the node ceiling", async () => {
    const sessions = Array.from({ length: 260 }, (_unused, index) => ({
      phase: "build",
      status: "idle",
      iteration: 1,
      label: `S${index}`,
      completedAt: "2026-10-20T09:00:00Z",
    }));
    const collector = new WorkflowSnapshotCollector(
      reader({
        build: {
          id: "bp-1",
          environmentId: "env-1",
          revision: 3,
          snapshot: { phase: "complete", sessions, currentSessionIndex: 259 },
        },
      }),
    );
    const snapshot = await collector.collect(SCOPE, {
      workflowId: "build-pipeline",
      runId: "bp-1",
    });
    expect(snapshot.completeness).toEqual({
      mode: "summary",
      totalNodes: 261,
      totalEdges: 260,
      omittedNodes: 261 - WORKFLOW_SNAPSHOT_POLICY.maxNodes,
      omittedEdges: 260 - snapshot.edges.length,
      reason: "size-limit",
    });
    expect(snapshot.nodes).toHaveLength(WORKFLOW_SNAPSHOT_POLICY.maxNodes);
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
  });
});
