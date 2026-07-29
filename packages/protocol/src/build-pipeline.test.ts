import { describe, expect, test } from "bun:test";
import {
  BUILD_PIPELINE_VERSION,
  isActiveBuildPhase,
  isBuildPipeline,
  isStartBuildPipelineInput,
  MAX_BUILD_PIPELINE_ITERATIONS,
  MAX_PIPELINE_USER_MESSAGES,
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  type BuildPipeline,
} from "./build-pipeline.js";
import type { StructuredReviewReport } from "./structured-review.js";

function snapshot(): BuildPipeline {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-07-29T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
  };
}

describe("build pipeline protocol", () => {
  test("accepts a backend-owned snapshot and exposes the current version", () => {
    expect(BUILD_PIPELINE_VERSION).toBe(2);
    expect(isBuildPipeline(snapshot())).toBe(true);
  });

  test("rejects a client-authored or malformed snapshot", () => {
    const { controller: _controller, ...clientAuthored } = snapshot();
    expect(isBuildPipeline(clientAuthored)).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), currentSessionIndex: 0 })).toBe(false);
  });

  test("validates every persisted optional state branch", () => {
    const valid = {
      ...snapshot(),
      phase: "paused" as const,
      sessions: [{
        phase: "review" as const,
        iteration: 1,
        sessionKey: "review-1",
        sdkSessionId: "session-1",
        status: "running" as const,
        startedAt: "2026-07-29T00:01:00.000Z",
        label: "Review",
        messages: [],
        messageRevision: 2,
        structuredRequestId: "structured-1",
      }],
      currentSessionIndex: 0,
      verificationResult: "fail" as const,
      verificationFeedback: "A test failed.",
      structuredReviewRequestId: "review-request",
      pausedFromPhase: "reviewing" as const,
      error: "Paused by user",
      failureContext: {
        phase: "reviewing" as const,
        kind: "prompt-dispatch" as const,
        sessionId: "session-1",
        prompt: "continue",
        useTaskImages: false,
        requestId: "request-1",
        structuredReview: true,
      },
      reconnectAttempt: {
        id: "reconnect-1",
        phase: "reviewing" as const,
        kind: "stage-transition" as const,
        startedAt: "2026-07-29T00:02:00.000Z",
      },
      pendingPromptAttempt: {
        id: "attempt-1",
        sessionId: "session-1",
        requestId: "request-1",
        phase: "reviewing" as const,
        prompt: "review",
        useTaskImages: false,
        structuredReview: true,
        startedAt: "2026-07-29T00:03:00.000Z",
      },
      activePromptContext: {
        phase: "reviewing" as const,
        kind: "prompt-dispatch" as const,
      },
      source: {
        type: "github" as const,
        repositoryOwner: "owner",
        repositoryName: "repository",
        issueNumber: 7,
        issueUrl: "https://example.test/issues/7",
        status: "open",
        updatedAt: "2026-07-29T00:04:00.000Z",
      },
      featurePlanId: "feature-1",
      sourceLinkedAt: "2026-07-29T00:05:00.000Z",
      completionCommentStatus: "posted" as const,
      completionCommentId: "comment-1",
      completionCommentPostedAt: "2026-07-29T00:06:00.000Z",
    };

    expect(isBuildPipeline(valid)).toBe(true);

    const invalidOverrides: Array<Record<string, unknown>> = [
      { createdAt: "yesterday" },
      { verificationResult: "maybe" },
      { structuredReviewRequestId: "" },
      { pausedFromPhase: "paused" },
      { failureContext: { phase: "building", kind: "unknown" } },
      { reconnectAttempt: { ...valid.reconnectAttempt, startedAt: "invalid" } },
      { pendingPromptAttempt: { ...valid.pendingPromptAttempt, requestId: "" } },
      { source: { ...valid.source, issueNumber: 0 } },
      { featurePlanId: "" },
      { sourceLinkedAt: "invalid" },
      { completionCommentStatus: "unknown" },
      { completionCommentPostedAt: "invalid" },
      { sessions: [{ ...valid.sessions[0], messageRevision: -1 }] },
      { sessions: [{ ...valid.sessions[0], startedAt: "invalid" }] },
    ];
    for (const override of invalidOverrides) {
      expect(isBuildPipeline({ ...valid, ...override })).toBe(false);
    }
  });

  test("validates every source variant", () => {
    const base = snapshot();
    expect(isBuildPipeline({
      ...base,
      source: { type: "kanban", taskId: "task-1" },
    })).toBe(true);
    expect(isBuildPipeline({
      ...base,
      source: {
        type: "linear",
        issueId: "linear-id",
        issueIdentifier: "ENG-1",
        issueUrl: "https://example.test/ENG-1",
        status: "Started",
        teamKey: "ENG",
        updatedAt: "2026-07-29T00:00:00.000Z",
      },
    })).toBe(true);
    expect(isBuildPipeline({
      ...base,
      source: { type: "linear", issueId: "", issueIdentifier: "ENG-1" },
    })).toBe(false);
    expect(isBuildPipeline({
      ...base,
      source: { type: "kanban", taskId: "" },
    })).toBe(false);
  });

  test("classifies only nonterminal, nonpaused phases as active", () => {
    expect(isActiveBuildPhase("building")).toBe(true);
    expect(isActiveBuildPhase("paused")).toBe(false);
    expect(isActiveBuildPhase("complete")).toBe(false);
    expect(isActiveBuildPhase("failed")).toBe(false);
  });

  test("validates bounded start requests at the gateway boundary", () => {
    const pipeline = snapshot();
    const input = {
      taskId: pipeline.taskId,
      projectId: pipeline.projectId,
      taskTitle: pipeline.taskTitle,
      taskSnapshot: pipeline.taskSnapshot,
      environmentType: pipeline.environmentType,
      agentType: pipeline.agentType,
      maxIterations: 3,
    };
    expect(isStartBuildPipelineInput(input)).toBe(true);
    expect(isStartBuildPipelineInput({ ...input, maxIterations: 11 })).toBe(false);
    expect(isStartBuildPipelineInput({
      ...input,
      taskSnapshot: { ...input.taskSnapshot, images: [{ filename: 7, data: "" }] },
    })).toBe(false);
  });

  test("rejects malformed start request identifiers, enums, sources, and limits", () => {
    const base = {
      taskId: "task-1",
      projectId: "project-1",
      taskTitle: "Task",
      taskSnapshot: snapshot().taskSnapshot,
      environmentType: "local",
      agentType: "codex",
    };
    const invalid: unknown[] = [
      null,
      { ...base, taskId: "" },
      { ...base, projectId: "" },
      { ...base, taskTitle: "" },
      { ...base, environmentType: "remote" },
      { ...base, agentType: "unknown" },
      { ...base, existingEnvironmentId: "" },
      { ...base, featurePlanId: "" },
      { ...base, namingPrompt: 1 },
      { ...base, maxIterations: 0 },
      { ...base, maxIterations: 1.5 },
      { ...base, source: { type: "kanban", taskId: "" } },
      {
        ...base,
        source: {
          type: "github",
          repositoryOwner: "owner",
          repositoryName: "repo",
          issueNumber: -1,
          issueUrl: "url",
          status: "open",
        },
      },
      {
        ...base,
        taskSnapshot: {
          ...base.taskSnapshot,
          comments: [{ text: 4 }],
        },
      },
    ];
    for (const value of invalid) {
      expect(isStartBuildPipelineInput(value)).toBe(false);
    }
  });

  test("accepts and bounds the queued user message list", () => {
    const message = {
      id: "message-1",
      text: "also update the README",
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    expect(isBuildPipeline({ ...snapshot(), pendingUserMessages: [] })).toBe(true);
    expect(isBuildPipeline({ ...snapshot(), pendingUserMessages: [message] }))
      .toBe(true);

    const invalid = [
      // Over the queue bound: a client that ignored sendMessage's limit, or a
      // hand-edited file, must not be able to grow this without bound.
      Array.from({ length: MAX_PIPELINE_USER_MESSAGES + 1 }, (_unused, index) => ({
        ...message,
        id: `message-${index}`,
      })),
      [{ ...message, text: "" }],
      [{ ...message, text: "x".repeat(MAX_PIPELINE_USER_MESSAGE_LENGTH + 1) }],
      [{ ...message, id: "" }],
      [{ ...message, createdAt: "not-a-date" }],
      [{ id: "message-1", text: "hello" }],
      "not-an-array",
    ];
    for (const pendingUserMessages of invalid) {
      expect(isBuildPipeline({ ...snapshot(), pendingUserMessages })).toBe(false);
    }
  });

  test("validates the review-retry request flag", () => {
    expect(isBuildPipeline({ ...snapshot(), reviewRetryRequested: true }))
      .toBe(true);
    expect(isBuildPipeline({ ...snapshot(), reviewRetryRequested: false }))
      .toBe(true);
    expect(isBuildPipeline({ ...snapshot(), reviewRetryRequested: "yes" }))
      .toBe(false);
  });

  test("validates the session fields the supervisor derives deadlines from", () => {
    const session = {
      phase: "review" as const,
      iteration: 0,
      sessionKey: "key",
      sdkSessionId: "session-1",
      status: "idle" as const,
      startedAt: "2026-07-29T00:00:00.000Z",
      label: "Review Session",
    };
    const withSession = (overrides: Record<string, unknown>) => ({
      ...snapshot(),
      sessions: [{ ...session, ...overrides }],
      currentSessionIndex: 0,
    });

    expect(isBuildPipeline(withSession({
      messagesFingerprint: "3:{}",
      messagesPersistedAt: "2026-07-29T00:00:01.000Z",
      structuredWaitStartedAt: "2026-07-29T00:00:02.000Z",
    }))).toBe(true);

    // A malformed timestamp here is not cosmetic: the supervisor subtracts it
    // from now() to decide whether to fail a stalled turn.
    expect(isBuildPipeline(withSession({ structuredWaitStartedAt: "soon" })))
      .toBe(false);
    expect(isBuildPipeline(withSession({ messagesPersistedAt: 0 }))).toBe(false);
    expect(isBuildPipeline(withSession({ messagesFingerprint: "" }))).toBe(false);
  });

  test("rejects a timestamp Date.parse would accept but toISOString never emits", () => {
    // Date.parse("March 5 2020") succeeds. Every timestamp in a snapshot comes
    // from toISOString, so accepting looser shapes only lets a legacy or
    // hand-edited record through into deadline arithmetic.
    for (const createdAt of [
      "March 5 2020",
      "2026-07-29",
      "2026-07-29T00:00:00",
      "29/07/2026",
      "",
    ]) {
      expect(isBuildPipeline({ ...snapshot(), createdAt })).toBe(false);
    }
    for (const createdAt of [
      "2026-07-29T00:00:00.000Z",
      "2026-07-29T00:00:00Z",
      "2026-07-29T00:00:00.000+01:00",
    ]) {
      expect(isBuildPipeline({ ...snapshot(), createdAt })).toBe(true);
    }
  });

  test("bounds maxIterations the same way on the record as at the gateway", () => {
    expect(isBuildPipeline({ ...snapshot(), maxIterations: 1 })).toBe(true);
    expect(isBuildPipeline({
      ...snapshot(),
      maxIterations: MAX_BUILD_PIPELINE_ITERATIONS,
    })).toBe(true);
    // The gateway caps starts at this bound, so a record above it can only come
    // from a writer that bypassed it — and it drives the fix-loop iteration cap.
    expect(isBuildPipeline({
      ...snapshot(),
      maxIterations: MAX_BUILD_PIPELINE_ITERATIONS + 1,
    })).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), maxIterations: 0 })).toBe(false);
  });

  test("delegates structuredReview validation to the review report guard", () => {
    const report = {
      reviewScope: {
        targetBranch: "main",
        baseRef: "base",
        commit: { sha: "head", subject: "feat: build" },
        filesReviewed: [],
        filesSkipped: [],
        filesLeftUncommitted: [],
        commandsRun: [],
        commandsNotRun: [],
        limitations: [],
      },
      whatChanged: {
        overview: "o",
        before: "b",
        after: "a",
        keyCodeChanges: [],
        userImpact: "u",
      },
      riskProfile: {
        changeTypes: ["feature"],
        riskAreas: [],
        overallRisk: "low",
        reasoning: "r",
      },
      testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
      strengths: [],
      issues: [],
      testCoverageGaps: [],
      verdict: { ready: "yes", reasoning: "r" },
      summaryOfChange: "s",
      reviewSummary: "r",
    } as unknown as StructuredReviewReport;

    expect(isBuildPipeline({ ...snapshot(), structuredReview: report }))
      .toBe(true);
    expect(isBuildPipeline({
      ...snapshot(),
      structuredReview: { ...report, issues: "not-an-array" },
    })).toBe(false);
  });

  test("accepts the blank environmentId a pipeline holds before provisioning", () => {
    // Deliberate: the record exists before its environment does, and that window
    // is exactly when a crash used to orphan the pipeline.
    expect(isBuildPipeline({ ...snapshot(), environmentId: "" })).toBe(true);
    expect(isBuildPipeline({ ...snapshot(), projectId: "" })).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), id: "" })).toBe(false);
    expect(isBuildPipeline({ ...snapshot(), taskId: "" })).toBe(false);
  });
});
