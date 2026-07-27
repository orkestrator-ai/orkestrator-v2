import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ReviewCoverageGap,
  ReviewIssue,
  StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import {
  applyReviewReconciliation,
  assertReconciliationAccountsForReport,
  hasReviewFindings,
  isLoopedReviewActivePhase,
  isLoopedReviewTerminalPhase,
  isLoopedReviewWorkflow,
  LOOPED_REVIEW_DEFAULT_ALLOWANCE,
  LOOPED_REVIEW_STORAGE_KEY,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  nextReviewAllowance,
  normalizeReviewAllowance,
  parseLoopedReviewReconciliation,
  parseReviewPackage,
  useLoopedReviewStore,
  type LoopedReviewReconciliation,
  type LoopedReviewWorkflow,
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

const emptyReconciliation: LoopedReviewReconciliation = {
  newIssues: [],
  issueUpdates: [],
  newCoverageGaps: [],
  coverageGapUpdates: [],
  issueOutcomes: [],
  coverageGapOutcomes: [],
};

const report = {
  issues: [issue],
  testCoverageGaps: [],
} as unknown as StructuredReviewReport;
const cleanReport = {
  ...report,
  issues: [],
} as StructuredReviewReport;

const reviewPackage: ReviewPackage = {
  id: "package-1",
  round: 1,
  preparedAt: "2026-07-25T00:00:00.000Z",
  targetBranch: "main",
  baseRef: "a".repeat(40),
  headRef: "b".repeat(40),
  commit: null,
  completeDiff: "diff --git a/a b/a",
  changedFiles: [],
  validation: [],
  skippedFiles: [],
  uncommittedFiles: [],
  limitations: [],
};

const coverageGap: ReviewCoverageGap = {
  file: "src/store.ts",
  untestedBehavior: "A recovered dispatch is not covered.",
};

function createWorkflow(
  overrides: Partial<{
    agent: "claude" | "codex" | "opencode";
    allowance: number;
    reviewInstruction: string;
  }> = {},
): string {
  return useLoopedReviewStore.getState().createWorkflow({
    environmentId: "env-1",
    projectId: "project-1",
    agent: overrides.agent ?? "codex",
    model: "gpt-5.4",
    targetBranch: "main",
    allowance: overrides.allowance,
    reviewInstruction: overrides.reviewInstruction,
  });
}

function workflow(id: string): LoopedReviewWorkflow {
  return useLoopedReviewStore.getState().workflows.get(id)!;
}

function replaceWorkflow(
  id: string,
  updates: Partial<LoopedReviewWorkflow>,
): LoopedReviewWorkflow {
  const next = { ...workflow(id), ...updates };
  useLoopedReviewStore.getState().replaceWorkflow(next);
  return next;
}

function addSession(
  id: string,
  phase: "preparation" | "discovery" | "fix" | "pr" = "preparation",
  sessionId = `${phase}-session`,
): string {
  return useLoopedReviewStore.getState().addSession(id, {
    id: sessionId,
    phase,
    round: workflow(id).currentRound,
    ...(phase === "discovery" ? { pass: workflow(id).currentPass + 1 } : {}),
    providerSessionId: `provider-${sessionId}`,
  })!;
}

beforeEach(() => {
  useLoopedReviewStore.setState({ workflows: new Map() });
  localStorage.removeItem(LOOPED_REVIEW_STORAGE_KEY);
});

afterEach(() => {
  localStorage.removeItem(LOOPED_REVIEW_STORAGE_KEY);
});

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

describe("looped review public guards", () => {
  test("classifies active and terminal phases and detects either finding kind", () => {
    expect(isLoopedReviewActivePhase("preparing")).toBe(true);
    expect(isLoopedReviewActivePhase("paused")).toBe(false);
    expect(isLoopedReviewActivePhase("failed")).toBe(false);
    expect(isLoopedReviewTerminalPhase("cancelled")).toBe(true);
    expect(isLoopedReviewTerminalPhase("completed")).toBe(true);
    expect(isLoopedReviewTerminalPhase("failed")).toBe(false);

    expect(hasReviewFindings({ issues: [], coverageGaps: [] })).toBe(false);
    expect(hasReviewFindings({
      issues: [],
      coverageGaps: [{ poolId: "gap-1", ...coverageGap }],
    })).toBe(true);
  });

  test("validates looped reconciliation dispositions at runtime", () => {
    expect(parseLoopedReviewReconciliation(emptyReconciliation)).toEqual(
      emptyReconciliation,
    );
    expect(() => parseLoopedReviewReconciliation(null)).toThrow("must be an object");
    expect(() => parseLoopedReviewReconciliation({
      ...emptyReconciliation,
      issueOutcomes: [{
        reportIndex: -1,
        outcome: "new",
        poolId: null,
      }],
    })).toThrow("runtime validation");
    expect(() => parseLoopedReviewReconciliation({
      ...emptyReconciliation,
      coverageGapOutcomes: [{
        reportIndex: 0,
        outcome: "updated",
        poolId: null,
      }],
    })).toThrow("runtime validation");
  });

  test("requires every report finding to match its declared operation", () => {
    const reportWithGap = {
      ...report,
      testCoverageGaps: [coverageGap],
    } as StructuredReviewReport;
    expect(() => assertReconciliationAccountsForReport(
      reportWithGap,
      { issues: [], coverageGaps: [] },
      {
        ...emptyReconciliation,
        newIssues: [issue],
        newCoverageGaps: [coverageGap],
        issueOutcomes: [{ reportIndex: 0, outcome: "new", poolId: null }],
        coverageGapOutcomes: [{
          reportIndex: 0,
          outcome: "new",
          poolId: null,
        }],
      },
    )).not.toThrow();

    expect(() => assertReconciliationAccountsForReport(
      reportWithGap,
      { issues: [], coverageGaps: [] },
      {
        ...emptyReconciliation,
        newIssues: [{ ...issue, title: "Different" }],
        newCoverageGaps: [coverageGap],
        issueOutcomes: [{ reportIndex: 0, outcome: "new", poolId: null }],
        coverageGapOutcomes: [{
          reportIndex: 0,
          outcome: "new",
          poolId: null,
        }],
      },
    )).toThrow("does not match report index 0");
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

  test("updates and adds coverage gaps while keeping IDs provider-neutral", () => {
    const current = {
      issues: [],
      coverageGaps: [{ poolId: "gap-existing", ...coverageGap }],
    };
    const updatedGap = {
      ...coverageGap,
      untestedBehavior: "The retry path is now described.",
    };
    const addedGap = {
      file: "src/controller.ts",
      untestedBehavior: "Cancellation is untested.",
    };

    const result = applyReviewReconciliation(current, {
      newIssues: [],
      issueUpdates: [],
      newCoverageGaps: [addedGap],
      coverageGapUpdates: [{
        poolId: "gap-existing",
        finding: updatedGap,
      }],
    }, () => "generated");

    expect(result).toMatchObject({ added: 1, updated: 1 });
    expect(result.pool.coverageGaps).toEqual([
      { poolId: "gap-existing", ...updatedGap },
      { poolId: "gap-generated", ...addedGap },
    ]);
    expect(current.coverageGaps[0]?.untestedBehavior).toBe(
      coverageGap.untestedBehavior,
    );
  });
});

describe("looped review workflow CRUD and revision actions", () => {
  test("creates a complete versioned workflow and preserves optional input", () => {
    const id = useLoopedReviewStore.getState().createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "claude",
      model: "default",
      reasoningEffort: "high",
      targetBranch: "develop",
      reviewInstruction: "Focus on recovery.",
      context: { ticketTitle: "Durable workflow" },
      allowance: 99,
    });
    const created = workflow(id);

    expect(created).toMatchObject({
      version: LOOPED_REVIEW_WORKFLOW_VERSION,
      id,
      environmentId: "env-1",
      agent: "claude",
      reasoningEffort: "high",
      targetBranch: "develop",
      reviewInstruction: "Focus on recovery.",
      context: { ticketTitle: "Durable workflow" },
      startingAllowance: 10,
      currentAllowance: 10,
      currentRound: 1,
      currentPass: 0,
      phase: "preparing",
      backendRevision: 0,
      pr: { status: "pending" },
    });
    expect(created.rounds).toEqual([
      expect.objectContaining({
        round: 1,
        allowance: 10,
        status: "preparing",
        passes: [],
      }),
    ]);
    expect(isLoopedReviewWorkflow(created)).toBe(true);
  });

  test("replaces and removes workflows while ignoring unknown removals", () => {
    const id = createWorkflow();
    const replacement = {
      ...workflow(id),
      model: "replacement-model",
    };
    useLoopedReviewStore.getState().replaceWorkflow(replacement);
    expect(workflow(id)).toBe(replacement);

    const beforeUnknownRemove = useLoopedReviewStore.getState().workflows;
    useLoopedReviewStore.getState().removeWorkflow("missing");
    expect(useLoopedReviewStore.getState().workflows).toBe(beforeUnknownRemove);

    useLoopedReviewStore.getState().removeWorkflow(id);
    expect(useLoopedReviewStore.getState().workflows.has(id)).toBe(false);
  });

  test("updates backend revision without changing durable updatedAt", () => {
    const id = createWorkflow();
    const updatedAt = workflow(id).updatedAt;
    useLoopedReviewStore.getState().setBackendRevision(id, 7);
    expect(workflow(id)).toMatchObject({
      backendRevision: 7,
      updatedAt,
    });

    const acknowledged = workflow(id);
    useLoopedReviewStore.getState().setBackendRevision(id, 7);
    useLoopedReviewStore.getState().setBackendRevision("missing", 3);
    expect(workflow(id)).toBe(acknowledged);

    useLoopedReviewStore.getState().setBackendRevision(id, -1);
    useLoopedReviewStore.getState().setBackendRevision(id, 1.5);
    expect(workflow(id)).toBe(acknowledged);
  });

  test("sets an active phase and clears paused and failure metadata", () => {
    const id = createWorkflow();
    replaceWorkflow(id, {
      phase: "failed",
      pausedFromPhase: "discovering",
      failure: {
        code: "provider",
        message: "offline",
        retryPhase: "discovering",
        occurredAt: "2026-07-25T00:00:00.000Z",
      },
    });

    useLoopedReviewStore.getState().setPhase(id, "fixing");
    expect(workflow(id)).toMatchObject({ phase: "fixing" });
    expect(workflow(id).pausedFromPhase).toBeUndefined();
    expect(workflow(id).failure).toBeUndefined();
  });
});

describe("looped review sessions, packages, and passes", () => {
  test("adds and updates sessions only while the workflow is active", () => {
    const id = createWorkflow();
    const sessionId = addSession(id, "preparation", "session-explicit");
    expect(sessionId).toBe("session-explicit");
    expect(workflow(id)).toMatchObject({
      activeSessionId: sessionId,
      sessions: [{
        id: sessionId,
        phase: "preparation",
        providerSessionId: "provider-session-explicit",
        requestIds: [],
        status: "running",
      }],
    });

    useLoopedReviewStore.getState().updateSession(id, sessionId, {
      status: "idle",
      completedAt: "2026-07-25T01:00:00.000Z",
    });
    expect(workflow(id).sessions[0]).toMatchObject({
      status: "idle",
      completedAt: "2026-07-25T01:00:00.000Z",
    });

    expect(addSession(id, "preparation", sessionId)).toBeUndefined();
    useLoopedReviewStore.getState().updateSession(id, sessionId, {
      id: "changed-session-id",
      phase: "pr",
      round: 9,
      pass: 9,
      startedAt: "2099-01-01T00:00:00.000Z",
      status: "running",
    });
    expect(workflow(id).sessions[0]).toMatchObject({
      id: sessionId,
      phase: "preparation",
      round: 1,
      status: "running",
    });
    expect(workflow(id).sessions[0]?.pass).toBeUndefined();
    expect(workflow(id).sessions[0]?.startedAt).not.toBe(
      "2099-01-01T00:00:00.000Z",
    );

    useLoopedReviewStore.getState().updateSession(id, "missing-session", {
      status: "error",
    });
    expect(workflow(id).sessions).toHaveLength(1);
    expect(workflow(id).sessions[0]?.status).toBe("running");

    useLoopedReviewStore.getState().cancelWorkflow(id);
    expect(addSession(id, "fix", "late-session")).toBeUndefined();
    expect(useLoopedReviewStore.getState().addSession("missing", {
      id: "orphan-session",
      phase: "fix",
      round: 1,
      providerSessionId: "provider-orphan",
    })).toBeUndefined();
  });

  test("ignores packages for the wrong phase or round and accepts the active package", () => {
    const id = createWorkflow();
    useLoopedReviewStore.getState().setPreparedPackage(id, {
      ...reviewPackage,
      round: 2,
    });
    expect(workflow(id).phase).toBe("preparing");
    expect(workflow(id).rounds[0]?.package).toBeUndefined();

    useLoopedReviewStore.getState().setPreparedPackage(id, reviewPackage);
    expect(workflow(id)).toMatchObject({
      phase: "discovering",
      currentPass: 0,
    });
    expect(workflow(id).rounds[0]).toMatchObject({
      package: reviewPackage,
      status: "reviewing",
    });

    const accepted = workflow(id);
    useLoopedReviewStore.getState().setPreparedPackage(id, reviewPackage);
    expect(workflow(id)).toBe(accepted);
  });

  test("starts passes within allowance and records reports only for the active session", () => {
    const id = createWorkflow({ allowance: 1 });
    const sessionId = addSession(id, "discovery");
    useLoopedReviewStore.getState().setPreparedPackage(id, reviewPackage);

    useLoopedReviewStore.getState().startPass(id, "missing-session");
    expect(workflow(id).currentPass).toBe(0);
    useLoopedReviewStore.getState().startPass(id, sessionId);
    expect(workflow(id)).toMatchObject({
      currentPass: 1,
      activeSessionId: sessionId,
    });
    expect(workflow(id).rounds[0]?.passes).toEqual([
      expect.objectContaining({
        pass: 1,
        sessionId,
        status: "discovering",
      }),
    ]);

    const atAllowance = workflow(id);
    useLoopedReviewStore.getState().startPass(id, sessionId);
    expect(workflow(id)).toBe(atAllowance);

    useLoopedReviewStore.getState().recordReport(id, "wrong-session", cleanReport);
    expect(workflow(id)).toBe(atAllowance);
    useLoopedReviewStore.getState().recordReport(id, sessionId, cleanReport);
    expect(workflow(id).phase).toBe("reconciling");
    expect(workflow(id).rounds[0]?.passes[0]).toMatchObject({
      report: cleanReport,
      status: "reconciling",
    });
  });

  test("guards reconciliation by phase, active session, and a validated report", () => {
    const id = createWorkflow();
    const sessionId = addSession(id, "discovery");
    expect(
      useLoopedReviewStore.getState().recordReconciliation(
        id,
        sessionId,
        emptyReconciliation,
      ),
    ).toBeUndefined();

    useLoopedReviewStore.getState().setPreparedPackage(id, reviewPackage);
    useLoopedReviewStore.getState().startPass(id, sessionId);
    replaceWorkflow(id, { phase: "reconciling" });
    expect(() =>
      useLoopedReviewStore.getState().recordReconciliation(
        id,
        sessionId,
        emptyReconciliation,
      )
    ).toThrow("without its validated report");

    expect(
      useLoopedReviewStore.getState().recordReconciliation(
        id,
        "wrong-session",
        emptyReconciliation,
      ),
    ).toBeUndefined();
  });

  test("continues discovery when reconciliation adds findings below the allowance", () => {
    const id = createWorkflow({ allowance: 2 });
    const sessionId = addSession(id, "discovery");
    useLoopedReviewStore.getState().setPreparedPackage(id, reviewPackage);
    useLoopedReviewStore.getState().startPass(id, sessionId);
    useLoopedReviewStore.getState().recordReport(id, sessionId, report);

    const applied = useLoopedReviewStore.getState().recordReconciliation(
      id,
      sessionId,
      {
        ...emptyReconciliation,
        newIssues: [issue],
        issueOutcomes: [{
          reportIndex: 0,
          outcome: "new",
          poolId: null,
        }],
      },
    );
    expect(applied).toMatchObject({ added: 1, updated: 0 });
    expect(workflow(id)).toMatchObject({
      phase: "discovering",
      currentPass: 1,
      activePool: {
        issues: [expect.objectContaining({ title: issue.title })],
        coverageGaps: [],
      },
    });
  });
});

describe("looped review dispatch leases", () => {
  test("claims, marks, and clears only the matching dispatch", () => {
    const id = createWorkflow();
    const sessionId = addSession(id);
    const dispatch = {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId,
      phase: "preparing" as const,
      kind: "prepare" as const,
    };

    expect(useLoopedReviewStore.getState().claimDispatch(id, dispatch)).toBe(true);
    expect(workflow(id).dispatch).toMatchObject({
      ...dispatch,
      state: "prepared",
    });
    expect(workflow(id).sessions[0]).toMatchObject({
      status: "running",
      requestIds: ["request-1"],
    });
    expect(useLoopedReviewStore.getState().claimDispatch(id, {
      ...dispatch,
      id: "dispatch-2",
    })).toBe(false);

    useLoopedReviewStore.getState().markDispatchSent(id, "wrong-dispatch");
    expect(workflow(id).dispatch?.state).toBe("prepared");
    useLoopedReviewStore.getState().markDispatchSent(id, dispatch.id);
    expect(workflow(id).dispatch?.state).toBe("sent");

    useLoopedReviewStore.getState().clearDispatch(id, "wrong-dispatch");
    expect(workflow(id).dispatch?.id).toBe(dispatch.id);
    useLoopedReviewStore.getState().clearDispatch(id, dispatch.id);
    expect(workflow(id).dispatch).toBeUndefined();

    expect(useLoopedReviewStore.getState().claimDispatch(id, dispatch)).toBe(true);
    expect(workflow(id).sessions[0]?.requestIds).toEqual(["request-1"]);
  });

  test("rejects missing, inactive, phase-mismatched, and malformed dispatch claims", () => {
    const id = createWorkflow();
    const sessionId = addSession(id);
    const claim = {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId,
      phase: "preparing" as const,
      kind: "prepare" as const,
    };
    expect(useLoopedReviewStore.getState().claimDispatch("missing", claim)).toBe(false);
    expect(useLoopedReviewStore.getState().claimDispatch(id, {
      ...claim,
      phase: "discovering",
      kind: "discover",
    })).toBe(false);
    expect(useLoopedReviewStore.getState().claimDispatch(id, {
      ...claim,
      kind: "pr",
    })).toBe(false);
    expect(useLoopedReviewStore.getState().claimDispatch(id, {
      ...claim,
      sessionId: "missing-session",
    })).toBe(false);

    useLoopedReviewStore.getState().cancelWorkflow(id);
    expect(useLoopedReviewStore.getState().claimDispatch(id, claim)).toBe(false);
  });
});

describe("looped review pause, cancellation, failure, retry, and PR actions", () => {
  test("pauses and resumes only from the matching state", () => {
    const id = createWorkflow();
    useLoopedReviewStore.getState().pauseWorkflow(id);
    expect(workflow(id)).toMatchObject({
      phase: "paused",
      pausedFromPhase: "preparing",
    });

    const paused = workflow(id);
    useLoopedReviewStore.getState().pauseWorkflow(id);
    expect(workflow(id)).toBe(paused);
    useLoopedReviewStore.getState().resumeWorkflow(id);
    expect(workflow(id).phase).toBe("preparing");
    expect(workflow(id).pausedFromPhase).toBeUndefined();

    const resumed = workflow(id);
    useLoopedReviewStore.getState().resumeWorkflow(id);
    expect(workflow(id)).toBe(resumed);
  });

  test("cancels running sessions and dispatches, including from a paused phase", () => {
    const id = createWorkflow();
    const sessionId = addSession(id);
    useLoopedReviewStore.getState().claimDispatch(id, {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId,
      phase: "preparing",
      kind: "prepare",
    });
    useLoopedReviewStore.getState().pauseWorkflow(id);
    useLoopedReviewStore.getState().cancelWorkflow(id);

    expect(workflow(id)).toMatchObject({
      phase: "cancelled",
      sessions: [{ id: sessionId, status: "cancelled" }],
    });
    expect(workflow(id).dispatch).toBeUndefined();
    expect(workflow(id).pausedFromPhase).toBeUndefined();
    expect(isLoopedReviewWorkflow(workflow(id))).toBe(true);

    const cancelled = workflow(id);
    useLoopedReviewStore.getState().cancelWorkflow(id);
    useLoopedReviewStore.getState().failWorkflow(id, {
      code: "provider",
      message: "late error",
      retryPhase: "preparing",
    });
    expect(workflow(id)).toBe(cancelled);

    const failedId = createWorkflow();
    useLoopedReviewStore.getState().failWorkflow(failedId, {
      code: "provider",
      message: "offline",
      retryPhase: "preparing",
    });
    useLoopedReviewStore.getState().cancelWorkflow(failedId);
    expect(workflow(failedId).phase).toBe("cancelled");
    expect(workflow(failedId).failure).toBeUndefined();
  });

  test("marks PR failures and resets PR state on retry", () => {
    const id = createWorkflow();
    const prSessionId = addSession(id, "pr");
    replaceWorkflow(id, {
      rounds: workflow(id).rounds.map((round) => ({
        ...round,
        status: "completed",
        completedAt: "2026-07-25T01:00:00.000Z",
      })),
    });
    useLoopedReviewStore.getState().setPhase(id, "creating-pr");
    useLoopedReviewStore.getState().startPr(id, prSessionId);
    expect(workflow(id).pr).toEqual({
      status: "running",
      sessionId: prSessionId,
    });

    useLoopedReviewStore.getState().failWorkflow(id, {
      code: "pr",
      message: "push failed",
      retryPhase: "creating-pr",
    });
    expect(workflow(id)).toMatchObject({
      phase: "failed",
      pr: {
        status: "failed",
        sessionId: prSessionId,
        error: "push failed",
      },
    });

    useLoopedReviewStore.getState().retryWorkflow(id);
    expect(workflow(id)).toMatchObject({
      phase: "creating-pr",
      pr: {
        status: "pending",
        sessionId: prSessionId,
      },
    });
    expect(workflow(id).pr.error).toBeUndefined();
    expect(workflow(id).rounds[0]?.status).toBe("completed");
  });

  test("starts and completes a PR only from the valid phase and running state", () => {
    const id = createWorkflow();
    const prSessionId = addSession(id, "pr");

    useLoopedReviewStore.getState().startPr(id, prSessionId);
    useLoopedReviewStore.getState().completePr(id, "https://example.com/pull/1");
    expect(workflow(id).pr.status).toBe("pending");

    useLoopedReviewStore.getState().setPhase(id, "creating-pr");
    useLoopedReviewStore.getState().completePr(id, "https://example.com/pull/1");
    expect(workflow(id).phase).toBe("creating-pr");
    useLoopedReviewStore.getState().startPr(id, "missing-session");
    expect(workflow(id).pr.status).toBe("pending");
    useLoopedReviewStore.getState().startPr(id, prSessionId);
    useLoopedReviewStore.getState().completePr(id, "https://example.com/pull/1");
    expect(workflow(id)).toMatchObject({
      phase: "completed",
      pr: {
        status: "created",
        sessionId: prSessionId,
        url: "https://example.com/pull/1",
      },
    });
  });

  test("rewinds an incomplete discovery pass on retry", () => {
    const id = createWorkflow();
    const sessionId = addSession(id, "discovery");
    useLoopedReviewStore.getState().setPreparedPackage(id, reviewPackage);
    useLoopedReviewStore.getState().startPass(id, sessionId);
    useLoopedReviewStore.getState().failWorkflow(id, {
      code: "provider",
      message: "disconnected",
      retryPhase: "discovering",
    });
    expect(workflow(id).rounds[0]?.passes[0]?.status).toBe("failed");

    useLoopedReviewStore.getState().retryWorkflow(id);
    expect(workflow(id)).toMatchObject({
      phase: "discovering",
      currentPass: 0,
    });
    expect(workflow(id).failure).toBeUndefined();
    expect(workflow(id).dispatch).toBeUndefined();
  });
});

describe("looped review workflow transitions", () => {
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
    store.recordReport(id, sessionId, cleanReport);
    store.recordReconciliation(id, sessionId, emptyReconciliation);

    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    expect(workflow.phase).toBe("creating-pr");
    expect(workflow.currentPass).toBe(1);
    expect(workflow.rounds[0]?.passes[0]).toMatchObject({
      report: cleanReport,
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
      issueOutcomes: [{
        reportIndex: 0,
        outcome: "new",
        poolId: null,
      }],
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
    useLoopedReviewStore.getState().completeFix(id, "fix-session", {
      summary: "Fixed the pool",
      notes: ["Issue 2 was already fixed on the branch."],
    });

    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    expect(workflow.phase).toBe("preparing");
    expect(workflow.currentRound).toBe(2);
    expect(workflow.currentAllowance).toBe(3);
    expect(workflow.activePool).toEqual({ issues: [], coverageGaps: [] });
    // The pool is cleared here, so the archive is the only surviving record of
    // what the fix session did and what it reported as already-resolved.
    expect(workflow.archivedPools[0]).toMatchObject({
      round: 1,
      fixSessionId: "fix-session",
      fixSummary: "Fixed the pool",
      fixNotes: ["Issue 2 was already fixed on the branch."],
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
    useLoopedReviewStore.getState().completeFix(id, "fix-final", {
      summary: "Fixed",
      notes: [],
    });
    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    expect(workflow.phase).toBe("creating-pr");
    expect(workflow.rounds).toHaveLength(1);
  });

  test("ignores fix completion outside fixing or without active findings", () => {
    const id = createWorkflow();
    const preparing = workflow(id);
    const outcome = { summary: "Fixed", notes: [] };
    useLoopedReviewStore.getState().completeFix(id, "fix-session", outcome);
    expect(workflow(id)).toBe(preparing);

    useLoopedReviewStore.getState().setPhase(id, "fixing");
    const emptyFix = workflow(id);
    useLoopedReviewStore.getState().completeFix(id, "fix-session", outcome);
    expect(workflow(id)).toBe(emptyFix);
  });

  test("rejects reconciliation that omits a report finding", () => {
    const store = useLoopedReviewStore.getState();
    const id = store.createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
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

    expect(() =>
      store.recordReconciliation(id, sessionId, emptyReconciliation)
    ).toThrow("report contains 1");
    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    expect(workflow.phase).toBe("reconciling");
    expect(workflow.activePool.issues).toHaveLength(0);
  });

  test("accepts an explicit unchanged semantic match and stops the round", () => {
    const store = useLoopedReviewStore.getState();
    const id = store.createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "claude",
      model: "default",
      targetBranch: "main",
    });
    store.setPreparedPackage(id, reviewPackage);
    useLoopedReviewStore.setState((state) => {
      const workflows = new Map(state.workflows);
      workflows.set(id, {
        ...workflows.get(id)!,
        activePool: {
          issues: [{ poolId: "issue-existing", ...issue }],
          coverageGaps: [],
        },
      });
      return { workflows };
    });
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
      issueOutcomes: [{
        reportIndex: 0,
        outcome: "existing",
        poolId: "issue-existing",
      }],
    });

    expect(useLoopedReviewStore.getState().workflows.get(id)?.phase).toBe("fixing");
  });

  test("preserves ambiguous dispatch leases on retry but clears definite failures", () => {
    const store = useLoopedReviewStore.getState();
    const id = store.createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
    });
    const sessionId = store.addSession(id, {
      phase: "preparation",
      round: 1,
      providerSessionId: "provider-1",
    })!;
    expect(store.claimDispatch(id, {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId,
      phase: "preparing",
      kind: "prepare",
    })).toBe(true);
    store.markDispatchSent(id, "dispatch-1");
    store.failWorkflow(id, {
      code: "connection",
      message: "response lost",
      retryPhase: "preparing",
      preserveDispatch: true,
    });
    store.retryWorkflow(id);
    expect(useLoopedReviewStore.getState().workflows.get(id)?.dispatch).toMatchObject({
      id: "dispatch-1",
      requestId: "request-1",
      state: "sent",
    });

    store.failWorkflow(id, {
      code: "structured-output",
      message: "schema rejected",
      retryPhase: "preparing",
    });
    store.retryWorkflow(id);
    expect(useLoopedReviewStore.getState().workflows.get(id)?.dispatch).toBeUndefined();
  });
});

describe("looped review recovery validation", () => {
  test("rejects malformed discriminants instead of treating them as PR work", () => {
    const id = useLoopedReviewStore.getState().createWorkflow({
      environmentId: "env-1",
      projectId: "project-1",
      agent: "codex",
      model: "gpt-5.4",
      targetBranch: "main",
    });
    const workflow = useLoopedReviewStore.getState().workflows.get(id)!;
    const session = {
      id: "session-1",
      phase: "preparation" as const,
      round: 1,
      providerSessionId: "provider-1",
      requestIds: ["request-1"],
      status: "running" as const,
      startedAt: workflow.createdAt,
    };
    const malformed = {
      ...workflow,
      sessions: [session],
      activeSessionId: session.id,
      dispatch: {
        id: "dispatch-1",
        requestId: "request-1",
        sessionId: session.id,
        phase: "preparing",
        kind: "pr",
        state: "sent",
        createdAt: workflow.createdAt,
      },
    };
    expect(isLoopedReviewWorkflow(malformed)).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...malformed,
      dispatch: { ...malformed.dispatch, kind: "prepare" },
    })).toBe(true);
  });

  test("rejects incomplete package files and incompatible commit metadata", () => {
    expect(() => parseReviewPackage({
      ...reviewPackage,
      changedFiles: [{
        path: "src/a.ts",
        status: "M",
        content: null,
        contentSha256: null,
        omittedReason: null,
      }],
      completeDiff: "diff",
    })).toThrow("runtime validation");

    expect(() => parseReviewPackage({
      ...reviewPackage,
      commit: {
        sha: "c".repeat(40),
        subject: "fix: mismatch",
        committedFiles: [],
      },
    })).toThrow("incompatible");
  });

  test("rejects ambiguous package snapshots and accepts matching commit metadata", () => {
    const invalidPackages: unknown[] = [
      { ...reviewPackage, preparedAt: "not-a-date" },
      { ...reviewPackage, baseRef: "main" },
      {
        ...reviewPackage,
        changedFiles: [{
          path: "src/a.ts",
          status: "M",
          content: "next",
          contentSha256: "not-a-hash",
          omittedReason: null,
        }],
      },
      {
        ...reviewPackage,
        changedFiles: [
          {
            path: "src/a.ts",
            status: "M",
            content: "next",
            contentSha256: "c".repeat(64),
            omittedReason: null,
          },
          {
            path: "src/a.ts",
            status: "M",
            content: "next",
            contentSha256: "c".repeat(64),
            omittedReason: null,
          },
        ],
      },
      {
        ...reviewPackage,
        changedFiles: [{
          path: "src/a.ts",
          status: "M",
          content: "next",
          contentSha256: "c".repeat(64),
          omittedReason: null,
        }],
        completeDiff: "",
      },
      { ...reviewPackage, unexpected: true },
    ];
    for (const candidate of invalidPackages) {
      expect(() => parseReviewPackage(candidate)).toThrow();
    }

    const committed = parseReviewPackage({
      ...reviewPackage,
      commit: {
        sha: reviewPackage.headRef,
        subject: "feat(review): persist workflow",
        committedFiles: ["src/store.ts"],
      },
    }, {
      id: reviewPackage.id,
      round: reviewPackage.round,
      targetBranch: reviewPackage.targetBranch,
    });
    expect(committed.commit).toMatchObject({
      sha: reviewPackage.headRef,
      committedFiles: ["src/store.ts"],
    });
    expect(() => parseReviewPackage(reviewPackage, {
      targetBranch: "develop",
    })).toThrow("does not match");
  });

  test("normalizes strict-schema null sentinels without weakening package validation", () => {
    const parsed = parseReviewPackage({
      ...reviewPackage,
      validation: [{
        command: "bun test",
        status: "passed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        limitation: null,
      }],
      context: {
        ticketTitle: "Review workflow",
        ticketDescription: null,
        acceptanceCriteria: null,
        comments: null,
        imageNames: [],
        projectNotes: null,
      },
    }, {
      context: {
        ticketTitle: "Review workflow",
        imageNames: [],
      },
    });

    expect(parsed.validation[0]).not.toHaveProperty("limitation");
    expect(parsed.context).toEqual({
      ticketTitle: "Review workflow",
      imageNames: [],
    });
    expect(parseReviewPackage({
      ...reviewPackage,
      context: null,
    })).not.toHaveProperty("context");
    expect(() => parseReviewPackage({
      ...reviewPackage,
      id: "",
      context: null,
    })).toThrow("runtime validation");
  });

  test("returns false instead of throwing for null nested recovery records", () => {
    const id = createWorkflow();
    const valid = workflow(id);

    expect(() => isLoopedReviewWorkflow({
      ...valid,
      dispatch: null,
    })).not.toThrow();
    expect(isLoopedReviewWorkflow({
      ...valid,
      dispatch: null,
    })).toBe(false);
    expect(() => isLoopedReviewWorkflow({
      ...valid,
      failure: null,
    })).not.toThrow();
    expect(isLoopedReviewWorkflow({
      ...valid,
      failure: null,
    })).toBe(false);
  });

  test("rejects malformed optional provider and prompt fields", () => {
    const id = createWorkflow();
    const valid = workflow(id);

    expect(isLoopedReviewWorkflow({
      ...valid,
      reasoningEffort: 42,
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...valid,
      reviewInstruction: ["not", "text"],
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...valid,
      context: "untrusted",
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...valid,
      context: { comments: [42] },
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...valid,
      reasoningEffort: "high",
      reviewInstruction: "Focus on recovery.",
      context: { comments: ["One"], imageNames: [] },
    })).toBe(true);
  });

  test("restores archived pools with and without a recorded fix outcome", () => {
    const id = createWorkflow();
    const valid = workflow(id);
    const archive = {
      round: 1,
      fixedAt: valid.createdAt,
      fixSessionId: "fix-session",
      pool: { issues: [], coverageGaps: [] },
    };

    // Workflows archived before the fix outcome was recorded must still restore.
    expect(isLoopedReviewWorkflow({
      ...valid,
      archivedPools: [archive],
    })).toBe(true);
    expect(isLoopedReviewWorkflow({
      ...valid,
      archivedPools: [{
        ...archive,
        fixSummary: "Fixed the pool",
        fixNotes: ["Issue 2 was disproved."],
      }],
    })).toBe(true);
    expect(isLoopedReviewWorkflow({
      ...valid,
      archivedPools: [{ ...archive, fixSummary: 42 }],
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...valid,
      archivedPools: [{ ...archive, fixNotes: "not a list" }],
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...valid,
      archivedPools: [{ ...archive, fixNotes: [42] }],
    })).toBe(false);
  });

  test("rejects dangling references and invalid paused-state combinations", () => {
    const id = createWorkflow();
    const valid = workflow(id);
    expect(isLoopedReviewWorkflow({
      ...valid,
      activeSessionId: "missing-session",
    })).toBe(false);
    expect(isLoopedReviewWorkflow({
      ...valid,
      phase: "cancelled",
      pausedFromPhase: "preparing",
    })).toBe(false);
  });
});

describe("looped review persistence", () => {
  test("round-trips valid workflow maps with optional and dispatch state", async () => {
    const id = createWorkflow({
      agent: "claude",
      allowance: 3,
      reviewInstruction: "Check persisted work.",
    });
    const sessionId = addSession(id);
    useLoopedReviewStore.getState().claimDispatch(id, {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId,
      phase: "preparing",
      kind: "prepare",
    });
    useLoopedReviewStore.getState().markDispatchSent(id, "dispatch-1");
    const stored = localStorage.getItem(LOOPED_REVIEW_STORAGE_KEY);
    expect(stored).not.toBeNull();

    useLoopedReviewStore.setState({ workflows: new Map() });
    if (stored) localStorage.setItem(LOOPED_REVIEW_STORAGE_KEY, stored);
    await useLoopedReviewStore.persist.rehydrate();

    expect(useLoopedReviewStore.getState().workflows).toBeInstanceOf(Map);
    expect(workflow(id)).toMatchObject({
      reviewInstruction: "Check persisted work.",
      currentAllowance: 3,
      dispatch: {
        id: "dispatch-1",
        requestId: "request-1",
        state: "sent",
      },
      sessions: [{
        id: sessionId,
        requestIds: ["request-1"],
      }],
    });
  });

  test("skips malformed entries without preventing valid workflows from loading", async () => {
    const id = createWorkflow();
    const valid = workflow(id);
    const nullDispatch = {
      ...valid,
      id: "null-dispatch",
      dispatch: null,
    };
    const nullFailure = {
      ...valid,
      id: "null-failure",
      failure: null,
    };
    useLoopedReviewStore.setState({ workflows: new Map() });
    localStorage.setItem(LOOPED_REVIEW_STORAGE_KEY, JSON.stringify({
      state: {
        workflows: [
          null,
          ["short"],
          [42, valid],
          ["mismatched-id", valid],
          ["null-dispatch", nullDispatch],
          ["null-failure", nullFailure],
          ["bad-optional", { ...valid, id: "bad-optional", context: "invalid" }],
          [id, valid],
        ],
      },
      version: LOOPED_REVIEW_WORKFLOW_VERSION,
    }));

    await useLoopedReviewStore.persist.rehydrate();
    expect(Array.from(useLoopedReviewStore.getState().workflows.keys())).toEqual([id]);
  });

  test("treats missing or non-array persisted workflow collections as empty", async () => {
    const id = createWorkflow();
    const inMemory = workflow(id);
    for (const persistedState of [{}, { workflows: "invalid" }]) {
      useLoopedReviewStore.setState({
        workflows: new Map([["in-memory", inMemory]]),
      });
      localStorage.setItem(LOOPED_REVIEW_STORAGE_KEY, JSON.stringify({
        state: persistedState,
        version: LOOPED_REVIEW_WORKFLOW_VERSION,
      }));

      await useLoopedReviewStore.persist.rehydrate();
      expect(useLoopedReviewStore.getState().workflows.size).toBe(0);
    }
  });

  test("uses the last valid duplicate persisted entry", async () => {
    const id = createWorkflow();
    const valid = workflow(id);
    useLoopedReviewStore.setState({ workflows: new Map() });
    localStorage.setItem(LOOPED_REVIEW_STORAGE_KEY, JSON.stringify({
      state: {
        workflows: [
          [id, { ...valid, model: "first" }],
          [id, { ...valid, model: "last" }],
        ],
      },
      version: LOOPED_REVIEW_WORKFLOW_VERSION,
    }));

    await useLoopedReviewStore.persist.rehydrate();
    expect(workflow(id).model).toBe("last");
  });
});
