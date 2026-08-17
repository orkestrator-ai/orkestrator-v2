import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MultiReviewPhase } from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";

// Other suites import the real command wrappers, so snapshot and restore per
// the Bun mock rules in AGENTS.md rather than leaving this module faked.
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };

const listMultiReviewWorkflowsMock = mock(
  async (_environmentId: string): Promise<unknown[]> => [],
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  listMultiReviewWorkflows: listMultiReviewWorkflowsMock,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const { findActiveMultiReviewWorkflow } = await import("./multi-review-persistence");
const { useMultiReviewStore } = await import("@/stores/multiReviewStore");

const ENVIRONMENT_ID = "env-1";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main", baseRef: "origin/main...HEAD", commit: null,
    filesReviewed: [], filesSkipped: [], filesLeftUncommitted: [], commandsRun: [],
    commandsNotRun: [], limitations: [],
  },
  whatChanged: {
    overview: "Change", before: "Before", after: "After", keyCodeChanges: [], userImpact: "None",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [], issues: [], testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change", reviewSummary: "Clean",
};

const FIX_SESSION = {
  agent: "claude", model: "opus", sessionKey: "fix-session",
  providerSessionId: "provider-fix", requestIds: ["request-1"], status: "idle",
  startedAt: TIMESTAMP,
};

/**
 * The validator demands a consolidated report and a live fix session from every
 * post-consolidation phase, an active fix request while fixing, and a
 * cancellation timestamp while cancelling. A snapshot missing them is rejected
 * outright, which would make the phase under test vacuous.
 */
function phaseFields(phase: MultiReviewPhase): Record<string, unknown> {
  const settled = ["ready", "fixing", "interactive", "completed"].includes(phase)
    ? { consolidatedReport: report, fixSession: FIX_SESSION }
    : {};
  return {
    ...settled,
    ...(phase === "fixing"
      ? {
          activeRequest: {
            kind: "fix", requestId: "request-fix", state: "sent", createdAt: TIMESTAMP,
          },
        }
      : {}),
    ...(phase === "cancelling" ? { cancellingSince: TIMESTAMP } : {}),
  };
}

function entry(id: string, phase: MultiReviewPhase, revision = 1) {
  return {
    id,
    environmentId: ENVIRONMENT_ID,
    version: 1,
    revision,
    updatedAt: TIMESTAMP,
    snapshot: {
      version: 1,
      controller: "backend",
      id,
      environmentId: ENVIRONMENT_ID,
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ id: `${id}-r1`, agent: "claude", model: "opus", status: "completed", report }],
      fixModel: { agent: "claude", model: "opus" },
      phase,
      ...phaseFields(phase),
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      backendRevision: revision,
    },
  };
}

beforeEach(() => {
  listMultiReviewWorkflowsMock.mockReset();
  listMultiReviewWorkflowsMock.mockImplementation(async () => []);
  useMultiReviewStore.setState({ workflows: new Map() });
});

describe("findActiveMultiReviewWorkflow", () => {
  test("reports no active workflow for an environment that has none", async () => {
    expect(await findActiveMultiReviewWorkflow(ENVIRONMENT_ID)).toBeNull();
  });

  /**
   * These are exactly the phases that block a new launch in the backend, and
   * the reason a closed tab strands the environment. `ready` and `failed` in
   * particular are *not* terminal even though nothing is executing.
   */
  test.each<MultiReviewPhase>([
    "reviewing", "consolidating", "ready", "fixing", "cancelling", "failed",
  ])("treats %s as the active workflow", async (phase) => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [entry("wf-active", phase)]);
    const active = await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    expect(active).toMatchObject({ id: "wf-active", phase });
  });

  test.each<MultiReviewPhase>([
    "interactive", "completed", "cancelled",
  ])("leaves a %s workflow free for a new launch", async (phase) => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [entry("wf-done", phase)]);
    expect(await findActiveMultiReviewWorkflow(ENVIRONMENT_ID)).toBeNull();
  });

  test("skips terminal history to find the one active workflow", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [
      entry("wf-old", "cancelled"),
      entry("wf-older", "completed"),
      entry("wf-live", "reviewing", 7),
    ]);
    const active = await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    expect(active).toMatchObject({ id: "wf-live", backendRevision: 7 });
  });

  /**
   * The launcher acts on this answer, so a record the validator rejects must
   * not be reported as blocking: it would strand the environment behind a
   * workflow the rest of the app cannot render or cancel.
   */
  test("ignores a record whose snapshot does not validate", async () => {
    const malformed = entry("wf-bad", "reviewing");
    listMultiReviewWorkflowsMock.mockImplementation(async () => [
      { ...malformed, snapshot: { ...malformed.snapshot, reviewers: "not-an-array" } },
    ]);
    expect(await findActiveMultiReviewWorkflow(ENVIRONMENT_ID)).toBeNull();
  });

  /**
   * The launcher runs this before deciding whether to start a workflow, so a
   * failed read must not be answered as "nothing active" — that would start a
   * second review the backend then refuses. Rejecting is what keeps the launch
   * fail-closed, and it must reach the caller rather than be swallowed here.
   */
  test("propagates a failed backend read instead of reporting no active workflow", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => {
      throw new Error("backend unavailable");
    });
    await expect(findActiveMultiReviewWorkflow(ENVIRONMENT_ID))
      .rejects.toThrow("backend unavailable");
  });

  /**
   * A failed read must also leave the projection alone. Pruning the store on the
   * way to an error would drop a workflow whose tab is open and rendering.
   */
  test("leaves the store untouched when the backend read fails", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [entry("wf-live", "reviewing", 3)]);
    await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    listMultiReviewWorkflowsMock.mockImplementation(async () => {
      throw new Error("backend unavailable");
    });
    await findActiveMultiReviewWorkflow(ENVIRONMENT_ID).catch(() => undefined);
    expect(useMultiReviewStore.getState().workflows.get("wf-live")).toMatchObject({
      id: "wf-live", phase: "reviewing", backendRevision: 3,
    });
  });

  test("stamps the authoritative revision onto the store", async () => {
    listMultiReviewWorkflowsMock.mockImplementation(async () => [
      entry("wf-live", "reviewing", 12),
    ]);
    await findActiveMultiReviewWorkflow(ENVIRONMENT_ID);
    expect(useMultiReviewStore.getState().workflows.get("wf-live")).toMatchObject({
      id: "wf-live", phase: "reviewing", backendRevision: 12,
    });
  });
});
