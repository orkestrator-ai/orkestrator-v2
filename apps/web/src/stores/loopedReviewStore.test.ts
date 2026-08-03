import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ReviewCoverageGap,
  ReviewIssue,
  StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import {
  applyReviewReconciliation,
  assertReconciliationAccountsForReport,
  hasReviewFindings,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  isLoopedReviewActivePhase,
  isLoopedReviewTerminalPhase,
  isLoopedReviewWorkflow,
  nextReviewAllowance,
  normalizeReviewAllowance,
  parseLoopedReviewReconciliation,
  parseReviewPackage,
  useLoopedReviewStore,
  type LoopedReviewReconciliation,
  type ReviewPackage,
} from "./loopedReviewStore";
import { loopedReviewFixture } from "@/test/looped-review-fixture";

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

const coverageGap: ReviewCoverageGap = {
  file: "src/store.ts",
  untestedBehavior: "A recovered dispatch is not covered.",
};

const emptyReconciliation: LoopedReviewReconciliation = {
  newIssues: [],
  issueUpdates: [],
  newCoverageGaps: [],
  coverageGapUpdates: [],
  issueOutcomes: [],
  coverageGapOutcomes: [],
};

const reviewPackage: ReviewPackage = {
  id: "package-1",
  round: 1,
  preparedAt: "2026-07-25T00:00:00.000Z",
  targetBranch: "main",
  baseRef: "a".repeat(40),
  headRef: "b".repeat(40),
  commit: null,
  completeDiff: "",
  changedFiles: [],
  validation: [],
  skippedFiles: [],
  uncommittedFiles: [],
  limitations: [],
};

describe("loopedReviewStore backend projection", () => {
  beforeEach(() => {
    useLoopedReviewStore.setState({ workflows: new Map() });
  });

  test("installs an authoritative version-2 snapshot", () => {
    const workflow = loopedReviewFixture({ backendRevision: 4, phase: "discovering" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    expect(useLoopedReviewStore.getState().workflows.get(workflow.id)).toEqual(workflow);
    expect(workflow.version).toBe(LOOPED_REVIEW_WORKFLOW_VERSION);
    expect(workflow.controller).toBe("backend");
  });

  test("does not let an older hydration overwrite a newer projection", () => {
    const current = loopedReviewFixture({ backendRevision: 7, phase: "fixing" });
    useLoopedReviewStore.getState().replaceWorkflow(current);
    useLoopedReviewStore.getState().replaceWorkflow({
      ...current,
      backendRevision: 6,
      phase: "preparing",
    });
    expect(useLoopedReviewStore.getState().workflows.get(current.id)?.phase).toBe("fixing");
  });

  test("an equal-revision backend snapshot replaces renderer memory", () => {
    const current = loopedReviewFixture({ backendRevision: 7, phase: "fixing" });
    useLoopedReviewStore.getState().replaceWorkflow(current);
    useLoopedReviewStore.getState().replaceWorkflow({
      ...current,
      phase: "paused",
      pausedFromPhase: "fixing",
    });
    expect(useLoopedReviewStore.getState().workflows.get(current.id)?.phase).toBe("paused");
  });

  test("removes projections without changing backend state", () => {
    const workflow = loopedReviewFixture();
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    useLoopedReviewStore.getState().removeWorkflow(workflow.id);
    expect(useLoopedReviewStore.getState().workflows.has(workflow.id)).toBe(false);
  });

  test("exposes no renderer phase-advancement methods", () => {
    const state = useLoopedReviewStore.getState() as unknown as Record<string, unknown>;
    for (const method of [
      "createWorkflow", "setPhase", "addSession", "recordReport",
      "recordReconciliation", "completeFix", "claimDispatch", "completePr",
      "pauseWorkflow", "resumeWorkflow", "retryWorkflow", "cancelWorkflow",
    ]) {
      expect(state[method]).toBeUndefined();
    }
  });
});
describe("looped review shared bounds and validation", () => {
  test("normalizes allowance and converges toward one", () => {
    expect(normalizeReviewAllowance(undefined)).toBe(6);
    expect(normalizeReviewAllowance(0)).toBe(1);
    expect(normalizeReviewAllowance(99)).toBe(10);
    expect(nextReviewAllowance(10)).toBe(5);
    expect(nextReviewAllowance(2)).toBe(1);
  });

  test("recognizes active and terminal phases", () => {
    expect(isLoopedReviewActivePhase("preparing")).toBe(true);
    expect(isLoopedReviewActivePhase("paused")).toBe(false);
    expect(isLoopedReviewActivePhase("cancelling")).toBe(false);
    expect(isLoopedReviewTerminalPhase("completed")).toBe(true);
    expect(isLoopedReviewTerminalPhase("failed")).toBe(false);
  });

  test("accepts complete backend snapshots and rejects legacy snapshots", () => {
    const workflow = loopedReviewFixture();
    expect(isLoopedReviewWorkflow(workflow)).toBe(true);
    expect(isLoopedReviewWorkflow({ ...workflow, version: 1 })).toBe(false);
    expect(isLoopedReviewWorkflow({ ...workflow, controller: undefined })).toBe(false);
  });

  test("validates cancelling origin and nested workflow invariants", () => {
    const cancelling = loopedReviewFixture({
      phase: "cancelling",
      cancellingFromPhase: "discovering",
    });
    expect(isLoopedReviewWorkflow(cancelling)).toBe(true);
    expect(isLoopedReviewWorkflow({ ...cancelling, cancellingFromPhase: undefined })).toBe(false);
    expect(isLoopedReviewWorkflow({ ...loopedReviewFixture(), cancellingFromPhase: "fixing" })).toBe(false);

    const withSession = loopedReviewFixture({
      sessions: [{
        id: "session-1",
        phase: "discovery",
        round: 1,
        pass: 1,
        sessionKey: "key-1",
        providerSessionId: "provider-1",
        requestIds: [],
        origin: "looped-review",
        interactionPolicy: loopedReviewFixture().interactionPolicy,
        status: "idle",
        startedAt: "2026-08-01T00:00:00.000Z",
      }],
    });
    expect(isLoopedReviewWorkflow(withSession)).toBe(true);
    expect(isLoopedReviewWorkflow({
      ...withSession,
      sessions: [{ ...withSession.sessions[0]!, sessionKey: "" }],
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...withSession,
      rounds: [{ ...withSession.rounds[0]!, round: 0 }],
    })).toBe(false);
  });

  test("detects both kinds of pooled finding", () => {
    expect(hasReviewFindings({ issues: [], coverageGaps: [] })).toBe(false);
    expect(hasReviewFindings({ issues: [{ poolId: "issue-1", ...issue }], coverageGaps: [] })).toBe(true);
    expect(hasReviewFindings({ issues: [], coverageGaps: [{ poolId: "gap-1", ...coverageGap }] })).toBe(true);
  });
});

describe("looped review public parsers", () => {
  test("validates and normalizes review packages", () => {
    expect(parseReviewPackage(reviewPackage, {
      id: reviewPackage.id,
      round: 1,
      targetBranch: "main",
    })).toEqual(reviewPackage);
    expect(parseReviewPackage({
      ...reviewPackage,
      validation: [{
        command: "bun test",
        status: "skipped",
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        limitation: null,
      }],
    }).validation[0]).not.toHaveProperty("limitation");
    expect(() => parseReviewPackage({ ...reviewPackage, round: 0 })).toThrow("runtime validation");
    expect(() => parseReviewPackage({
      ...reviewPackage,
      changedFiles: [
        { path: "a.ts", status: "M", content: "one", contentSha256: "a".repeat(64), omittedReason: null },
        { path: "a.ts", status: "M", content: "two", contentSha256: "b".repeat(64), omittedReason: null },
      ],
      completeDiff: "diff",
    })).toThrow("duplicate changed-file paths");
    expect(() => parseReviewPackage(reviewPackage, { id: "other" })).toThrow("active review round");
  });

  test("validates reconciliation dispositions", () => {
    expect(parseLoopedReviewReconciliation(emptyReconciliation)).toEqual(emptyReconciliation);
    expect(() => parseLoopedReviewReconciliation(null)).toThrow("must be an object");
    expect(() => parseLoopedReviewReconciliation({
      ...emptyReconciliation,
      issueOutcomes: [{ reportIndex: -1, outcome: "new", poolId: null }],
    })).toThrow("runtime validation");
    expect(() => parseLoopedReviewReconciliation({
      ...emptyReconciliation,
      coverageGapOutcomes: [{ reportIndex: 0, outcome: "updated", poolId: null }],
    })).toThrow("runtime validation");
  });
});

describe("looped review reconciliation accounting", () => {
  test("assigns stable IDs, preserves update IDs, and rejects invalid updates", () => {
    const initial = applyReviewReconciliation(
      { issues: [], coverageGaps: [] },
      { ...emptyReconciliation, newIssues: [issue] },
      () => "stable",
    );
    expect(initial).toMatchObject({ added: 1, updated: 0 });
    expect(initial.pool.issues[0]?.poolId).toBe("issue-stable");

    const updated = applyReviewReconciliation(initial.pool, {
      ...emptyReconciliation,
      issueUpdates: [{ poolId: "issue-stable", finding: { ...issue, confidence: 99 } }],
    });
    expect(updated.pool.issues[0]).toMatchObject({ poolId: "issue-stable", confidence: 99 });
    expect(() => applyReviewReconciliation(initial.pool, {
      ...emptyReconciliation,
      issueUpdates: [{ poolId: "missing", finding: issue }],
    })).toThrow("unknown issue pool ID");
    expect(() => applyReviewReconciliation(initial.pool, {
      ...emptyReconciliation,
      issueUpdates: [
        { poolId: "issue-stable", finding: issue },
        { poolId: "issue-stable", finding: issue },
      ],
    })).toThrow("more than once");
  });

  test("requires every report finding to match one declared operation", () => {
    const report = {
      issues: [issue],
      testCoverageGaps: [coverageGap],
    } as unknown as StructuredReviewReport;
    const valid = {
      ...emptyReconciliation,
      newIssues: [issue],
      newCoverageGaps: [coverageGap],
      issueOutcomes: [{ reportIndex: 0, outcome: "new" as const, poolId: null }],
      coverageGapOutcomes: [{ reportIndex: 0, outcome: "new" as const, poolId: null }],
    };
    expect(() => assertReconciliationAccountsForReport(
      report,
      { issues: [], coverageGaps: [] },
      valid,
    )).not.toThrow();
    expect(() => assertReconciliationAccountsForReport(
      report,
      { issues: [], coverageGaps: [] },
      { ...valid, newIssues: [{ ...issue, title: "Different" }] },
    )).toThrow("does not match report index 0");
    expect(() => assertReconciliationAccountsForReport(
      report,
      { issues: [], coverageGaps: [] },
      { ...valid, issueOutcomes: [] },
    )).toThrow("accounted for 0 issues");
  });
});
