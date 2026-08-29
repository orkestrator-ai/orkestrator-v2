import { describe, expect, test } from "bun:test";
import {
  MULTI_REVIEW_MAX_REVIEWERS,
  MULTI_REVIEW_MAX_SNAPSHOT_PATHS,
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  isStartMultiReviewInput,
} from "./multi-review";
import type { StructuredReviewReport } from "./structured-review";

const report: StructuredReviewReport = {
  reviewScope: {
    targetBranch: "main",
    baseRef: "origin/main...HEAD",
    commit: null,
    filesReviewed: [],
    filesSkipped: [],
    filesLeftUncommitted: [],
    commandsRun: [],
    commandsNotRun: [],
    limitations: [],
  },
  whatChanged: {
    overview: "Change",
    before: "Before",
    after: "After",
    keyCodeChanges: [],
    userImpact: "None",
  },
  riskProfile: { changeTypes: [], riskAreas: [], overallRisk: "low", reasoning: "Low" },
  testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
  strengths: [],
  issues: [],
  testCoverageGaps: [],
  verdict: { ready: "yes", reasoning: "Ready" },
  summaryOfChange: "Change",
  reviewSummary: "Clean",
};

describe("multi review protocol", () => {
  test("accepts one-to-many reviewer selections and rejects unbounded input", () => {
    const input = {
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ agent: "claude", model: "opus" }],
      fixModel: { agent: "codex", model: "gpt-5.6", reasoningEffort: "high" },
    };
    expect(isStartMultiReviewInput(input)).toBe(true);
    expect(isStartMultiReviewInput({ ...input, reviewers: [] })).toBe(false);
    expect(
      isStartMultiReviewInput({
        ...input,
        reviewers: Array.from({ length: MULTI_REVIEW_MAX_REVIEWERS + 1 }, () => input.reviewers[0]),
      }),
    ).toBe(false);
  });

  test("requires a consolidated report in every actionable phase", () => {
    const workflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-1",
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [
        { id: "reviewer-1", agent: "claude", model: "opus", status: "completed", report },
      ],
      fixModel: { agent: "codex", model: "gpt-5.6" },
      fixSession: {
        agent: "codex",
        model: "gpt-5.6",
        sessionKey: "fix-session",
        providerSessionId: "provider-fix",
        requestIds: ["request-1"],
        status: "idle",
        startedAt: new Date(0).toISOString(),
      },
      phase: "ready",
      consolidatedReport: report,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      backendRevision: 2,
    };
    expect(isMultiReviewWorkflow(workflow)).toBe(true);
    expect(isMultiReviewWorkflow({ ...workflow, fixSessionKey: "next-fix-session" })).toBe(true);
    expect(isMultiReviewWorkflow({ ...workflow, fixSessionKey: "" })).toBe(false);
    expect(isMultiReviewWorkflow({ ...workflow, phase: "interactive" })).toBe(true);
    expect(isMultiReviewWorkflow({ ...workflow, consolidatedReport: undefined })).toBe(false);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        phase: "interactive",
        consolidatedReport: undefined,
      }),
    ).toBe(false);
  });

  test("carries progress and stall timestamps on both supervised session kinds", () => {
    const timestamp = new Date(0).toISOString();
    const workflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-stall",
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [
        {
          id: "reviewer-1",
          agent: "claude",
          model: "opus",
          status: "running",
          providerSessionId: "provider-1",
          startedAt: timestamp,
          progressAt: timestamp,
          progressDigest: "a".repeat(64),
          stalledSince: timestamp,
        },
      ],
      fixModel: { agent: "codex", model: "gpt-5.6" },
      fixSession: {
        agent: "codex",
        model: "gpt-5.6",
        sessionKey: "fix-session",
        providerSessionId: "provider-fix",
        requestIds: ["request-1"],
        status: "running",
        startedAt: timestamp,
        progressAt: timestamp,
        progressDigest: "b".repeat(64),
        stalledSince: timestamp,
      },
      phase: "reviewing",
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 2,
    };
    expect(isMultiReviewWorkflow(workflow)).toBe(true);
    // The renderer reads these as clocks, so an unparseable one must be rejected
    // at the boundary rather than rendered as an unbounded stall.
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        reviewers: [{ ...workflow.reviewers[0], progressAt: "soon" }],
      }),
    ).toBe(false);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        reviewers: [{ ...workflow.reviewers[0], progressDigest: "not-a-digest" }],
      }),
    ).toBe(false);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        fixSession: { ...workflow.fixSession, stalledSince: "soon" },
      }),
    ).toBe(false);
  });

  test("treats an interactive handoff as a terminal workflow", () => {
    expect(isMultiReviewTerminalPhase("interactive")).toBe(true);
    expect(isMultiReviewTerminalPhase("completed")).toBe(true);
    expect(isMultiReviewTerminalPhase("cancelled")).toBe(true);
    expect(isMultiReviewTerminalPhase("ready")).toBe(false);
    expect(isMultiReviewTerminalPhase("fixing")).toBe(false);
  });

  test("accepts a pending address dispatch only on an interactive workflow", () => {
    const workflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-address",
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [
        { id: "reviewer-1", agent: "claude", model: "opus", status: "completed", report },
      ],
      fixModel: { agent: "codex", model: "gpt-5.6" },
      fixSession: {
        agent: "codex",
        model: "gpt-5.6",
        sessionKey: "fix-session",
        providerSessionId: "provider-fix",
        requestIds: ["request-1"],
        status: "idle",
        startedAt: new Date(0).toISOString(),
      },
      phase: "interactive",
      consolidatedReport: report,
      addressPromptPending: true,
      addressPromptAttempts: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      backendRevision: 2,
    };
    expect(isMultiReviewWorkflow(workflow)).toBe(true);
    expect(isMultiReviewWorkflow({ ...workflow, phase: "ready" })).toBe(false);
    expect(isMultiReviewWorkflow({ ...workflow, addressPromptPending: "yes" })).toBe(false);
    expect(isMultiReviewWorkflow({ ...workflow, addressPromptAttempts: -1 })).toBe(false);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        addressPromptPending: undefined,
        addressPromptAttempts: 1,
      }),
    ).toBe(false);
  });

  test("rejects unsafe branches, empty instructions, and duplicate reviewer identities", () => {
    const input = {
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ agent: "claude", model: "opus" }],
      fixModel: { agent: "codex", model: "gpt-5.6" },
    };
    expect(isStartMultiReviewInput({ ...input, targetBranch: "main; touch /tmp/x" })).toBe(false);
    expect(isStartMultiReviewInput({ ...input, reviewInstruction: "  " })).toBe(false);
    expect(
      isStartMultiReviewInput({ ...input, reviewers: [{ ...input.reviewers[0], id: "injected" }] }),
    ).toBe(false);

    const reviewer = { id: "same", agent: "claude", model: "opus", status: "pending" };
    expect(
      isMultiReviewWorkflow({
        version: MULTI_REVIEW_WORKFLOW_VERSION,
        controller: "backend",
        id: "workflow-1",
        environmentId: "env-1",
        projectId: "project-1",
        targetBranch: "main",
        reviewers: [reviewer, reviewer],
        fixModel: input.fixModel,
        phase: "reviewing",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        backendRevision: 1,
      }),
    ).toBe(false);
  });

  test("validates the durable review worktree snapshot", () => {
    const workflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-snapshot",
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "pending" }],
      fixModel: { agent: "codex", model: "gpt-5.6" },
      reviewWorktreeSnapshot: {
        status: "dirty",
        head: "1".repeat(40),
        paths: ["src/feature.ts"],
        fingerprint: "a".repeat(64),
        capturedAt: new Date(0).toISOString(),
      },
      phase: "reviewing",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      backendRevision: 1,
    };

    expect(isMultiReviewWorkflow(workflow)).toBe(true);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        reviewWorktreeSnapshot: { ...workflow.reviewWorktreeSnapshot, fingerprint: "bad" },
      }),
    ).toBe(false);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        reviewWorktreeSnapshot: { ...workflow.reviewWorktreeSnapshot, status: "clean" },
      }),
    ).toBe(false);
    expect(isMultiReviewWorkflow({ ...workflow, reviewSnapshotStale: true })).toBe(true);
    expect(isMultiReviewWorkflow({ ...workflow, reviewSnapshotStale: "yes" })).toBe(false);

    // `Date.parse` coerces its argument, so a numeric capturedAt would sail
    // through a check that only asserted the parse succeeded: 0 stringifies to
    // "0", which V8 reads as a valid date.
    for (const capturedAt of [0, 1, null, {}, ["2020-01-01"], "not a date"]) {
      expect(
        isMultiReviewWorkflow({
          ...workflow,
          reviewWorktreeSnapshot: { ...workflow.reviewWorktreeSnapshot, capturedAt },
        }),
      ).toBe(false);
    }

    // A clean snapshot pins the empty path set; a dirty one must name at least
    // one path, and neither may exceed the persisted bound.
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        reviewWorktreeSnapshot: {
          ...workflow.reviewWorktreeSnapshot,
          status: "clean",
          paths: [],
        },
      }),
    ).toBe(true);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        reviewWorktreeSnapshot: {
          ...workflow.reviewWorktreeSnapshot,
          paths: Array.from({ length: MULTI_REVIEW_MAX_SNAPSHOT_PATHS + 1 }, () => "src/a.ts"),
        },
      }),
    ).toBe(false);
  });

  test("requires a cancellation timestamp exactly while cancellation is active", () => {
    const workflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-cancel",
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [{ id: "reviewer-1", agent: "claude", model: "opus", status: "running" }],
      fixModel: { agent: "codex", model: "gpt-5.6" },
      phase: "cancelling",
      cancellingSince: new Date(0).toISOString(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      backendRevision: 2,
    };
    expect(isMultiReviewWorkflow(workflow)).toBe(true);
    expect(isMultiReviewWorkflow({ ...workflow, cancellingSince: undefined })).toBe(false);
    expect(isMultiReviewWorkflow({ ...workflow, phase: "reviewing" })).toBe(false);
  });

  test("accepts bounded durable schema-repair state", () => {
    const workflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: "workflow-repair",
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewers: [
        {
          id: "reviewer-1",
          agent: "claude",
          model: "opus",
          status: "running",
          requestId: "repair-request",
          dispatchState: "prepared",
          schemaRepairAttempts: 1,
          schemaRepairPrompt: "Return corrected JSON.",
        },
      ],
      fixModel: { agent: "codex", model: "gpt-5.6" },
      phase: "reviewing",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      backendRevision: 2,
    };
    expect(isMultiReviewWorkflow(workflow)).toBe(true);
    expect(
      isMultiReviewWorkflow({
        ...workflow,
        reviewers: [{ ...workflow.reviewers[0], schemaRepairAttempts: 4 }],
      }),
    ).toBe(false);
  });
});
