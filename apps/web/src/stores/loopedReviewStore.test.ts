import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ReviewIssue,
  ReviewReconciliation,
  StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import {
  applyReviewReconciliation,
  LOOPED_REVIEW_DEFAULT_ALLOWANCE,
  nextReviewAllowance,
  normalizeReviewAllowance,
  useLoopedReviewStore,
  type ReviewPackage,
} from "./loopedReviewStore";

const issue: ReviewIssue = {
  severity: "P1",
  confidence: 90,
  category: "correctness",
  title: "Stale state",
  file: "src/store.ts",
  line: 42,
  symbol: "advance",
  description: "The phase can advance twice.",
  evidence: "Two callers pass the same guard.",
  suggestion: "Persist a dispatch lease.",
  verification: "Reconnect during dispatch.",
};

const emptyReconciliation: ReviewReconciliation = {
  newIssues: [],
  issueUpdates: [],
  newCoverageGaps: [],
  coverageGapUpdates: [],
};

const report = {
  issues: [issue],
  testCoverageGaps: [],
} as unknown as StructuredReviewReport;

const reviewPackage: ReviewPackage = {
  id: "package-1",
  round: 1,
  preparedAt: "2026-07-25T00:00:00.000Z",
  targetBranch: "main",
  baseRef: "origin/main",
  headRef: "abc123",
  commit: null,
  completeDiff: "diff --git a/a b/a",
  changedFiles: [],
  validation: [],
  skippedFiles: [],
  uncommittedFiles: [],
  limitations: [],
};

describe("looped review allowance", () => {
  test("defaults and clamps to the supported 1–10 range", () => {
    expect(normalizeReviewAllowance(undefined)).toBe(LOOPED_REVIEW_DEFAULT_ALLOWANCE);
    expect(normalizeReviewAllowance(0)).toBe(1);
    expect(normalizeReviewAllowance(11)).toBe(10);
    expect(normalizeReviewAllowance(7.5)).toBe(LOOPED_REVIEW_DEFAULT_ALLOWANCE);
  });

  test("halves and rounds up through the required 6, 3, 2, 1 sequence", () => {
    const allowances = [6];
    while (allowances.at(-1)! > 1) {
      allowances.push(nextReviewAllowance(allowances.at(-1)!));
    }
    expect(allowances).toEqual([6, 3, 2, 1]);
  });
});

describe("applyReviewReconciliation", () => {
  test("assigns stable IDs to new findings and preserves them on updates", () => {
    const initial = applyReviewReconciliation(
      { issues: [], coverageGaps: [] },
      { ...emptyReconciliation, newIssues: [issue] },
      () => "stable",
    );
    expect(initial.added).toBe(1);
    expect(initial.pool.issues[0]?.poolId).toBe("issue-stable");

    const updated = applyReviewReconciliation(
      initial.pool,
      {
        ...emptyReconciliation,
        issueUpdates: [{
          poolId: "issue-stable",
          finding: { ...issue, confidence: 99 },
        }],
      },
    );
    expect(updated.updated).toBe(1);
    expect(updated.pool.issues[0]).toMatchObject({
      poolId: "issue-stable",
      confidence: 99,
    });
  });

  test("rejects unknown and duplicate update IDs", () => {
    expect(() => applyReviewReconciliation(
      { issues: [], coverageGaps: [] },
      {
        ...emptyReconciliation,
        issueUpdates: [{ poolId: "missing", finding: issue }],
      },
    )).toThrow("unknown issue pool ID");

    const pool = {
      issues: [{ poolId: "issue-1", ...issue }],
      coverageGaps: [],
    };
    expect(() => applyReviewReconciliation(pool, {
      ...emptyReconciliation,
      issueUpdates: [
        { poolId: "issue-1", finding: issue },
        { poolId: "issue-1", finding: issue },
      ],
    })).toThrow("more than once");
  });
});

describe("looped review workflow transitions", () => {
  beforeEach(() => {
    useLoopedReviewStore.setState({ workflows: new Map() });
  });

  test("stops a clean first pass and proceeds directly to PR creation", () => {
    const store = useLoopedReviewStore.getState();
    const id = store.createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
      allowance: 6,
    });
    store.setPreparedPackage(id, reviewPackage);
    const sessionId = store.addSession(id, {
      phase: "discovery",
      round: 1,
      pass: 1,
      providerSessionId: "provider-1",
    })!;
    store.startPass(id, sessionId);
    store.recordReport(id, sessionId, report);
    store.recordReconciliation(id, sessionId, emptyReconciliation);

    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    expect(workflow.phase).toBe("creating-pr");
    expect(workflow.currentPass).toBe(1);
    expect(workflow.rounds[0]?.passes[0]).toMatchObject({
      report,
      reconciliation: emptyReconciliation,
      status: "completed",
    });
  });

  test("archives a fixed pool and reduces the next round allowance", () => {
    const store = useLoopedReviewStore.getState();
    const id = store.createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "claude",
      model: "default",
      targetBranch: "develop",
      allowance: 6,
    });
    store.setPreparedPackage(id, reviewPackage);
    const sessionId = store.addSession(id, {
      phase: "discovery",
      round: 1,
      pass: 1,
      providerSessionId: "provider-1",
    })!;
    store.startPass(id, sessionId);
    store.recordReport(id, sessionId, report);
    store.recordReconciliation(id, sessionId, {
      ...emptyReconciliation,
      newIssues: [issue],
    });

    // Force round exhaustion to exercise the fix transition without five more
    // synthetic passes.
    useLoopedReviewStore.setState((state) => {
      const workflows = new Map(state.workflows);
      const workflow = workflows.get(id)!;
      workflows.set(id, {
        ...workflow,
        phase: "fixing",
        currentPass: workflow.currentAllowance,
      });
      return { workflows };
    });
    useLoopedReviewStore.getState().completeFix(id, "fix-session");

    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    expect(workflow.phase).toBe("preparing");
    expect(workflow.currentRound).toBe(2);
    expect(workflow.currentAllowance).toBe(3);
    expect(workflow.activePool).toEqual({ issues: [], coverageGaps: [] });
    expect(workflow.archivedPools[0]).toMatchObject({
      round: 1,
      fixSessionId: "fix-session",
    });
  });

  test("fixes a one-pass round once and does not schedule another review", () => {
    const store = useLoopedReviewStore.getState();
    const id = store.createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "opencode",
      model: "provider/model",
      targetBranch: "main",
      allowance: 1,
    });
    useLoopedReviewStore.setState((state) => {
      const workflows = new Map(state.workflows);
      const workflow = workflows.get(id)!;
      workflows.set(id, {
        ...workflow,
        phase: "fixing",
        activePool: {
          issues: [{ poolId: "issue-1", ...issue }],
          coverageGaps: [],
        },
      });
      return { workflows };
    });
    useLoopedReviewStore.getState().completeFix(id, "fix-final");
    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    expect(workflow.phase).toBe("creating-pr");
    expect(workflow.rounds).toHaveLength(1);
  });
});
