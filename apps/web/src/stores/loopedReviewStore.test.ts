import { beforeEach, describe, expect, test } from "bun:test";
import type { ReviewCoverageGap, ReviewIssue } from "@orkestrator/protocol/structured-review";
import {
  hasReviewFindings,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  isLoopedReviewActivePhase,
  isLoopedReviewTerminalPhase,
  isLoopedReviewWorkflow,
  nextReviewAllowance,
  normalizeReviewAllowance,
  useLoopedReviewStore,
} from "./loopedReviewStore";
import { isLoopedReviewWorkflow as protocolGuard } from "@orkestrator/protocol/review-workflow";
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
  untestedBehavior: "Restarting mid-dispatch.",
};

const session = {
  id: "session-1",
  phase: "preparation" as const,
  round: 1,
  sessionKey: "key-1",
  providerSessionId: "provider-1",
  requestIds: [],
  origin: "looped-review" as const,
  interactionPolicy: loopedReviewFixture().interactionPolicy,
  status: "idle" as const,
  startedAt: "2026-08-01T00:00:00.000Z",
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

  test("removing an absent workflow leaves the map identity untouched", () => {
    const workflow = loopedReviewFixture();
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    const before = useLoopedReviewStore.getState().workflows;
    useLoopedReviewStore.getState().removeWorkflow("never-existed");
    expect(useLoopedReviewStore.getState().workflows).toBe(before);
  });

  test("keeps workflows for different environments apart", () => {
    const first = loopedReviewFixture({ environmentId: "env-a" });
    const second = loopedReviewFixture({ environmentId: "env-b" });
    useLoopedReviewStore.getState().replaceWorkflow(first);
    useLoopedReviewStore.getState().replaceWorkflow(second);
    expect(useLoopedReviewStore.getState().workflows.size).toBe(2);
    useLoopedReviewStore.getState().removeWorkflow(first.id);
    expect(useLoopedReviewStore.getState().workflows.get(second.id)?.environmentId).toBe("env-b");
  });

  test("exposes no renderer phase-advancement methods", () => {
    const state = useLoopedReviewStore.getState() as unknown as Record<string, unknown>;
    for (const method of [
      "createWorkflow",
      "setPhase",
      "addSession",
      "recordReport",
      "recordReconciliation",
      "completeFix",
      "claimDispatch",
      "completePr",
      "pauseWorkflow",
      "resumeWorkflow",
      "retryWorkflow",
      "cancelWorkflow",
    ]) {
      expect(state[method]).toBeUndefined();
    }
  });
});

describe("looped review contract re-exports", () => {
  test("re-exports the protocol guard rather than a second implementation", () => {
    // A renderer copy of this guard had already drifted from the authoritative
    // one, and because a rejected snapshot is dropped from the UI entirely,
    // that drift hid live workflows. Identity is the property that matters.
    expect(isLoopedReviewWorkflow).toBe(protocolGuard);
  });

  test("normalizes allowance and converges toward one", () => {
    expect(normalizeReviewAllowance(undefined)).toBe(6);
    expect(normalizeReviewAllowance(0)).toBe(1);
    expect(normalizeReviewAllowance(99)).toBe(10);
    expect(normalizeReviewAllowance(4.5)).toBe(6);
    expect(normalizeReviewAllowance(Number.NaN)).toBe(6);
    expect(nextReviewAllowance(10)).toBe(5);
    expect(nextReviewAllowance(5)).toBe(3);
    expect(nextReviewAllowance(3)).toBe(2);
    expect(nextReviewAllowance(2)).toBe(1);
    expect(nextReviewAllowance(1)).toBe(1);
  });

  test("recognizes active and terminal phases", () => {
    expect(isLoopedReviewActivePhase("preparing")).toBe(true);
    expect(isLoopedReviewActivePhase("paused")).toBe(false);
    // Both map to "still running" for the build pipeline, so neither may be
    // reported as an active phase the supervisor should advance on its own.
    expect(isLoopedReviewActivePhase("cancelling")).toBe(false);
    expect(isLoopedReviewActivePhase("failed")).toBe(false);
    expect(isLoopedReviewTerminalPhase("completed")).toBe(true);
    expect(isLoopedReviewTerminalPhase("cancelled")).toBe(true);
    expect(isLoopedReviewTerminalPhase("failed")).toBe(false);
    expect(isLoopedReviewTerminalPhase("cancelling")).toBe(false);
  });

  test("accepts complete backend snapshots and rejects legacy snapshots", () => {
    const workflow = loopedReviewFixture();
    expect(isLoopedReviewWorkflow(workflow)).toBe(true);
    expect(isLoopedReviewWorkflow({ ...workflow, version: 1 })).toBe(false);
    expect(isLoopedReviewWorkflow({ ...workflow, controller: undefined })).toBe(false);
    expect(isLoopedReviewWorkflow(null)).toBe(false);
    expect(isLoopedReviewWorkflow([])).toBe(false);
    expect(isLoopedReviewWorkflow("workflow")).toBe(false);
  });

  test("validates cancellation metadata as a complete set", () => {
    const cancelling = loopedReviewFixture({
      phase: "cancelling",
      cancellingFromPhase: "discovering",
      cancellingSince: "2026-08-01T00:00:00.000Z",
    });
    expect(isLoopedReviewWorkflow(cancelling)).toBe(true);
    expect(isLoopedReviewWorkflow({ ...cancelling, cancellingFromPhase: undefined })).toBe(false);
    // Without a parseable start time the abort deadline never fires.
    expect(isLoopedReviewWorkflow({ ...cancelling, cancellingSince: undefined })).toBe(false);
    expect(isLoopedReviewWorkflow({ ...cancelling, cancellingSince: "soon" })).toBe(false);
    expect(
      isLoopedReviewWorkflow({ ...loopedReviewFixture(), cancellingFromPhase: "fixing" }),
    ).toBe(false);
  });

  test("validates nested session and round invariants", () => {
    const withSession = loopedReviewFixture({
      sessions: [{ ...session, phase: "discovery", pass: 1 }],
    });
    expect(isLoopedReviewWorkflow(withSession)).toBe(true);
    expect(
      isLoopedReviewWorkflow({
        ...withSession,
        sessions: [{ ...withSession.sessions[0]!, sessionKey: "" }],
      }),
    ).toBe(false);
    expect(
      isLoopedReviewWorkflow({
        ...withSession,
        rounds: [{ ...withSession.rounds[0]!, round: 0 }],
      }),
    ).toBe(false);
    // Duplicate session ids would make dispatch resolution ambiguous.
    expect(
      isLoopedReviewWorkflow({
        ...withSession,
        sessions: [withSession.sessions[0]!, withSession.sessions[0]!],
      }),
    ).toBe(false);
  });

  test("ties a dispatch to its kind and to the workflow's own phase", () => {
    const dispatch = {
      id: "dispatch-1",
      requestId: "request-1",
      sessionId: "session-1",
      phase: "preparing" as const,
      kind: "prepare" as const,
      state: "sent" as const,
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const withDispatch = loopedReviewFixture({ dispatch, sessions: [session] });
    expect(isLoopedReviewWorkflow(withDispatch)).toBe(true);
    expect(
      isLoopedReviewWorkflow({
        ...withDispatch,
        dispatch: { ...dispatch, kind: "discover" },
      }),
    ).toBe(false);
    expect(
      isLoopedReviewWorkflow({
        ...withDispatch,
        dispatch: { ...dispatch, state: "queued" },
      }),
    ).toBe(false);
    // The result handler branches on kind alone, so a dispatch left over from
    // an earlier phase would drive the wrong completion branch.
    expect(
      isLoopedReviewWorkflow({
        ...withDispatch,
        phase: "fixing",
        dispatch: { ...dispatch, phase: "fixing", kind: "fix" },
      }),
    ).toBe(true);
    expect(
      isLoopedReviewWorkflow({
        ...withDispatch,
        phase: "fixing",
      }),
    ).toBe(false);
    // A dispatch pointing at no session at all is unresolvable.
    expect(isLoopedReviewWorkflow({ ...withDispatch, sessions: [] })).toBe(false);
  });

  test("requires a failed workflow to carry its failure", () => {
    const failure = {
      code: "provider" as const,
      message: "boom",
      retryPhase: "discovering" as const,
      occurredAt: "2026-08-01T00:00:00.000Z",
    };
    expect(isLoopedReviewWorkflow(loopedReviewFixture({ phase: "failed", failure }))).toBe(true);
    expect(isLoopedReviewWorkflow(loopedReviewFixture({ phase: "failed" }))).toBe(false);
    expect(isLoopedReviewWorkflow(loopedReviewFixture({ failure }))).toBe(false);
  });

  test("detects both kinds of pooled finding", () => {
    expect(hasReviewFindings({ issues: [], coverageGaps: [] })).toBe(false);
    expect(hasReviewFindings({ issues: [{ poolId: "issue-1", ...issue }], coverageGaps: [] })).toBe(
      true,
    );
    expect(
      hasReviewFindings({ issues: [], coverageGaps: [{ poolId: "gap-1", ...coverageGap }] }),
    ).toBe(true);
  });
});
