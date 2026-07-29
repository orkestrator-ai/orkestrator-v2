import { describe, expect, test } from "bun:test";
import {
  BUILD_PIPELINE_VERSION,
  isActiveBuildPhase,
  isBuildPipeline,
  isStartBuildPipelineInput,
  type BuildPipeline,
} from "./build-pipeline.js";

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
});
