import { describe, test, expect, beforeEach } from "bun:test";
import {
  isActiveBuildPhase,
  useBuildPipelineStore,
} from "../../../apps/web/src/stores/buildPipelineStore";
import type {
  BuildPhase,
  PipelinePromptAttempt,
  PipelineReconnectAttempt,
  PipelineSession,
} from "../../../apps/web/src/stores/buildPipelineStore";
import type { TaskSnapshot } from "../../../apps/web/src/prompts";

const defaultTaskSnapshot: TaskSnapshot = {
  title: "Test task",
  description: "Test description",
  acceptanceCriteria: "criterion 1",
  comments: [],
  images: [],
};

function createPipelineParams(overrides: Partial<Parameters<typeof useBuildPipelineStore.getState>["0"]> = {}) {
  return {
    taskId: "task-1",
    projectId: "project-1",
    environmentType: "local" as const,
    agentType: "claude" as const,
    taskTitle: "Test task",
    taskSnapshot: defaultTaskSnapshot,
    ...overrides,
  };
}

function createMockSession(overrides: Partial<PipelineSession> = {}): PipelineSession {
  return {
    phase: "build",
    iteration: 0,
    sessionKey: "env-abc:default" as PipelineSession["sessionKey"],
    sdkSessionId: "session-123",
    status: "running",
    startedAt: new Date().toISOString(),
    label: "Build #1",
    ...overrides,
  };
}

function createReconnectAttempt(
  overrides: Partial<PipelineReconnectAttempt> = {},
): PipelineReconnectAttempt {
  return {
    id: "attempt-1",
    phase: "building",
    kind: "prompt-dispatch",
    sessionId: "session-123",
    startedAt: "2026-07-23T08:00:00.000Z",
    ...overrides,
  };
}

function createPromptAttempt(
  overrides: Partial<PipelinePromptAttempt> = {},
): PipelinePromptAttempt {
  return {
    id: "prompt-attempt-1",
    sessionId: "session-123",
    requestId: "request-123",
    phase: "building",
    prompt: "Build the requested change",
    useTaskImages: true,
    startedAt: "2026-07-23T08:00:00.000Z",
    ...overrides,
  };
}

describe("buildPipelineStore", () => {
  beforeEach(() => {
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  describe("initial state", () => {
    test("starts with empty pipelines and buildEnvironmentIds", () => {
      const state = useBuildPipelineStore.getState();
      expect(state.pipelines.size).toBe(0);
      expect(state.buildEnvironmentIds.size).toBe(0);
    });
  });

  describe("isActiveBuildPhase", () => {
    test("classifies every build phase", () => {
      const phases: BuildPhase[] = [
        "creating-environment",
        "starting-environment",
        "waiting-for-setup",
        "building",
        "reviewing",
        "addressing",
        "verifying",
        "fixing",
        "creating-pr",
        "resolving-conflicts",
        "paused",
        "complete",
        "failed",
      ];
      const expected: Record<BuildPhase, boolean> = {
        "creating-environment": true,
        "starting-environment": true,
        "waiting-for-setup": true,
        building: true,
        reviewing: true,
        addressing: true,
        verifying: true,
        fixing: true,
        "creating-pr": true,
        "resolving-conflicts": true,
        paused: false,
        complete: false,
        failed: false,
      };

      expect(Object.fromEntries(phases.map((phase) => [phase, isActiveBuildPhase(phase)]))).toEqual(expected);
    });
  });

  describe("createPipeline", () => {
    test("creates a pipeline with correct defaults", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id);
      expect(pipeline).toBeDefined();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(pipeline!.taskId).toBe("task-1");
      expect(pipeline!.projectId).toBe("project-1");
      expect(pipeline!.environmentType).toBe("local");
      expect(pipeline!.agentType).toBe("claude");
      expect(pipeline!.environmentId).toBe("");
      expect(pipeline!.phase).toBe("creating-environment");
      expect(pipeline!.sessions).toEqual([]);
      expect(pipeline!.currentSessionIndex).toBe(-1);
      expect(pipeline!.iteration).toBe(0);
      expect(pipeline!.maxIterations).toBe(3);
      expect(pipeline!.taskTitle).toBe("Test task");
      expect(pipeline!.taskSnapshot).toEqual(defaultTaskSnapshot);
      expect(pipeline!.source).toEqual({ type: "kanban", taskId: "task-1" });
    });

    test("stores Linear source metadata when provided", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams({
        taskId: "issue-1",
        source: {
          type: "linear",
          issueId: "issue-1",
          issueIdentifier: "ENG-123",
          issueUrl: "https://linear.app/acme/issue/ENG-123",
          status: "Todo",
          teamKey: "ENG",
          updatedAt: "2026-06-28T12:00:00.000Z",
        },
      }));

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id);
      expect(pipeline!.source).toEqual({
        type: "linear",
        issueId: "issue-1",
        issueIdentifier: "ENG-123",
        issueUrl: "https://linear.app/acme/issue/ENG-123",
        status: "Todo",
        teamKey: "ENG",
        updatedAt: "2026-06-28T12:00:00.000Z",
      });
    });

    test("returns a unique ID for each pipeline", () => {
      const { createPipeline } = useBuildPipelineStore.getState();
      const id1 = createPipeline(createPipelineParams({ taskId: "task-1" }));
      const id2 = createPipeline(createPipelineParams({ taskId: "task-2" }));

      expect(id1).not.toBe(id2);
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(2);
    });
  });

  describe("setCompletionCommentStatus", () => {
    test("tracks posted and failed completion comment state without changing phase", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "complete");

      useBuildPipelineStore.getState().setCompletionCommentStatus(id, "posted", {
        commentId: "comment-1",
        postedAt: "2026-06-28T12:00:00.000Z",
      });

      let pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("complete");
      expect(pipeline.completionCommentStatus).toBe("posted");
      expect(pipeline.completionCommentId).toBe("comment-1");

      useBuildPipelineStore.getState().setCompletionCommentStatus(id, "failed", {
        error: "Linear API unavailable",
      });

      pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("complete");
      expect(pipeline.completionCommentStatus).toBe("failed");
      expect(pipeline.completionCommentError).toBe("Linear API unavailable");
      expect(pipeline.completionCommentId).toBe("comment-1");
      expect(pipeline.completionCommentPostedAt).toBe("2026-06-28T12:00:00.000Z");
    });

    test("clears a previous failure when posting or posted succeeds", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setCompletionCommentStatus(id, "failed", {
        error: "Linear API unavailable",
      });

      useBuildPipelineStore.getState().setCompletionCommentStatus(id, "posting");
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.completionCommentError).toBeUndefined();

      useBuildPipelineStore.getState().setCompletionCommentStatus(id, "posted", {
        commentId: "comment-2",
        postedAt: "2026-07-23T08:00:00.000Z",
      });
      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.completionCommentStatus).toBe("posted");
      expect(pipeline.completionCommentError).toBeUndefined();
      expect(pipeline.completionCommentId).toBe("comment-2");
      expect(pipeline.completionCommentPostedAt).toBe("2026-07-23T08:00:00.000Z");
    });

    test("clears completion comment state so a failed Linear comment can be retried", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setCompletionCommentStatus(id, "failed", {
        commentId: "comment-1",
        postedAt: "2026-06-28T12:00:00.000Z",
        error: "Linear API unavailable",
      });

      useBuildPipelineStore.getState().clearCompletionCommentStatus(id);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.completionCommentStatus).toBeUndefined();
      expect(pipeline.completionCommentError).toBeUndefined();
      expect(pipeline.completionCommentId).toBeUndefined();
      expect(pipeline.completionCommentPostedAt).toBeUndefined();
    });

    test("no-ops completion comment actions for an unknown pipeline", () => {
      const before = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().setCompletionCommentStatus("missing", "posting");
      useBuildPipelineStore.getState().clearCompletionCommentStatus("missing");

      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });

    test("no-ops idempotently for identical or already-cleared comment state", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setCompletionCommentStatus(id, "failed", { error: "Unavailable" });
      const afterFailure = useBuildPipelineStore.getState().pipelines;

      store.setCompletionCommentStatus(id, "failed", { error: "Unavailable" });
      expect(useBuildPipelineStore.getState().pipelines).toBe(afterFailure);

      store.clearCompletionCommentStatus(id);
      const afterClear = useBuildPipelineStore.getState().pipelines;
      store.clearCompletionCommentStatus(id);
      expect(useBuildPipelineStore.getState().pipelines).toBe(afterClear);
    });
  });

  describe("setPipelineEnvironment", () => {
    test("sets the environment ID on a pipeline", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-42");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id);
      expect(pipeline!.environmentId).toBe("env-42");
    });

    test("rebuilds buildEnvironmentIds", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-42");

      expect(useBuildPipelineStore.getState().buildEnvironmentIds.has("env-42")).toBe(true);
    });

    test("does not include empty string environmentIds in buildEnvironmentIds", () => {
      const id1 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-1" }));
      const id2 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-2" }));
      // Only assign env to one pipeline
      useBuildPipelineStore.getState().setPipelineEnvironment(id1, "env-42");

      const ids = useBuildPipelineStore.getState().buildEnvironmentIds;
      expect(ids.size).toBe(1);
      expect(ids.has("env-42")).toBe(true);
      expect(ids.has("")).toBe(false);
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().setPipelineEnvironment("nonexistent", "env-42");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });
  });

  describe("removePipeline", () => {
    test("removes a pipeline and rebuilds buildEnvironmentIds", () => {
      const id1 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-1" }));
      const id2 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-2" }));
      useBuildPipelineStore.getState().setPipelineEnvironment(id1, "env-1");
      useBuildPipelineStore.getState().setPipelineEnvironment(id2, "env-2");

      useBuildPipelineStore.getState().removePipeline(id1);

      const state = useBuildPipelineStore.getState();
      expect(state.pipelines.has(id1)).toBe(false);
      expect(state.pipelines.has(id2)).toBe(true);
      expect(state.buildEnvironmentIds.has("env-1")).toBe(false);
      expect(state.buildEnvironmentIds.has("env-2")).toBe(true);
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().removePipeline("missing");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });

    test("invalidates prompt ownership by removing its pipeline", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.beginPromptAttempt(id, createPromptAttempt());

      store.removePipeline(id);

      expect(store.completePromptAttempt(id, "prompt-attempt-1")).toBe(false);
      expect(useBuildPipelineStore.getState().pipelines.has(id)).toBe(false);
    });
  });

  describe("removePipelinesForTask", () => {
    test("removes all pipelines for a task and keeps unrelated pipelines", () => {
      const id1 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-1" }));
      const id2 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-1" }));
      const id3 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-2" }));
      useBuildPipelineStore.getState().setPipelineEnvironment(id1, "env-1");
      useBuildPipelineStore.getState().setPipelineEnvironment(id2, "env-2");
      useBuildPipelineStore.getState().setPipelineEnvironment(id3, "env-3");

      useBuildPipelineStore.getState().removePipelinesForTask("task-1");

      const state = useBuildPipelineStore.getState();
      expect(state.pipelines.has(id1)).toBe(false);
      expect(state.pipelines.has(id2)).toBe(false);
      expect(state.pipelines.has(id3)).toBe(true);
      expect(state.buildEnvironmentIds.has("env-1")).toBe(false);
      expect(state.buildEnvironmentIds.has("env-2")).toBe(false);
      expect(state.buildEnvironmentIds.has("env-3")).toBe(true);
    });

    test("no-ops when no pipeline matches the task ID", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-1" }));
      useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");
      const before = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().removePipelinesForTask("task-unknown");

      const state = useBuildPipelineStore.getState();
      expect(state.pipelines).toBe(before);
      expect(state.pipelines.has(id)).toBe(true);
      expect(state.buildEnvironmentIds.has("env-1")).toBe(true);
    });
  });

  describe("addSession", () => {
    test("appends a session and updates currentSessionIndex", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const session = createMockSession();

      useBuildPipelineStore.getState().addSession(id, session);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.sessions).toHaveLength(1);
      expect(pipeline.sessions[0]).toEqual(session);
      expect(pipeline.currentSessionIndex).toBe(0);
    });

    test("increments currentSessionIndex for each added session", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());

      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s1" }));
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s2" }));

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.sessions).toHaveLength(2);
      expect(pipeline.currentSessionIndex).toBe(1);
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().addSession("nonexistent", createMockSession());
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });
  });

  describe("setPhase", () => {
    test("updates the pipeline phase", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());

      useBuildPipelineStore.getState().setPhase(id, "building");
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("building");

      useBuildPipelineStore.getState().setPhase(id, "reviewing");
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("reviewing");
    });

    test("captures the current phase when setting a pipeline to paused", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "reviewing");

      useBuildPipelineStore.getState().setPhase(id, "paused");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("paused");
      expect(pipeline.pausedFromPhase).toBe("reviewing");
    });

    test("preserves the captured phase when setting an already paused pipeline to paused", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "verifying");
      useBuildPipelineStore.getState().setPhase(id, "paused");

      useBuildPipelineStore.getState().setPhase(id, "paused");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("paused");
      expect(pipeline.pausedFromPhase).toBe("verifying");
    });

    test("does not leave paused state through ordinary phase transitions", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "building");
      useBuildPipelineStore.getState().setPhase(id, "paused");

      useBuildPipelineStore.getState().setPhase(id, "reviewing");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("paused");
      expect(pipeline.pausedFromPhase).toBe("building");
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().setPhase("nonexistent", "building");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });
  });

  describe("markSessionIdle", () => {
    test("marks a specific session as idle by sdkSessionId", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s1", status: "running" }));
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s2", status: "running" }));

      useBuildPipelineStore.getState().markSessionIdle(id, "s1");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.sessions[0]!.status).toBe("idle");
      expect(pipeline.sessions[1]!.status).toBe("running");
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().markSessionIdle("nonexistent", "s1");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });

    test("no-ops for an unknown or already idle session", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().addSession(id, createMockSession({ status: "idle" }));
      const before = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().markSessionIdle(id, "missing");
      useBuildPipelineStore.getState().markSessionIdle(id, "session-123");

      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });

  });

  describe("setCurrentSessionIndex", () => {
    test("updates the current session index", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setCurrentSessionIndex(id, 5);

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.currentSessionIndex).toBe(5);
    });

    test("no-ops for unknown pipeline ID", () => {
      const before = useBuildPipelineStore.getState().pipelines;
      useBuildPipelineStore.getState().setCurrentSessionIndex("missing", 5);
      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });

    test("no-ops idempotently when the index is unchanged", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const before = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().setCurrentSessionIndex(id, -1);

      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });
  });

  describe("setVerificationResult", () => {
    test("sets pass result and feedback", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setVerificationResult(id, "pass", "All tests pass");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.verificationResult).toBe("pass");
      expect(pipeline.verificationFeedback).toBe("All tests pass");
    });

    test("sets fail result and feedback", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setVerificationResult(id, "fail", "2 tests failed");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.verificationResult).toBe("fail");
      expect(pipeline.verificationFeedback).toBe("2 tests failed");
    });

    test("no-ops for unknown pipeline ID", () => {
      const before = useBuildPipelineStore.getState().pipelines;
      useBuildPipelineStore.getState().setVerificationResult("missing", "fail", "failure");
      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });

    test("no-ops idempotently when result and feedback are unchanged", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setVerificationResult(id, "pass", "All tests pass");
      const before = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().setVerificationResult(id, "pass", "All tests pass");

      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });
  });

  describe("incrementIteration", () => {
    test("increments the iteration count by 1", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.iteration).toBe(0);

      useBuildPipelineStore.getState().incrementIteration(id);
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.iteration).toBe(1);

      useBuildPipelineStore.getState().incrementIteration(id);
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.iteration).toBe(2);
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().incrementIteration("nonexistent");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });
  });

  describe("setPipelineError", () => {
    test("sets phase to failed and captures the exact failed phase", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "building");

      useBuildPipelineStore.getState().setPipelineError(id, "Container crashed");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("failed");
      expect(pipeline.error).toBe("Container crashed");
      expect(pipeline.failureContext).toEqual({
        phase: "building",
        kind: "stage-transition",
      });
    });

    test("stores explicit prompt failure context", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "reviewing");

      useBuildPipelineStore.getState().setPipelineError(id, "Dispatch failed", {
        phase: "reviewing",
        kind: "prompt-dispatch",
        sessionId: "review-session",
      });

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.failureContext).toEqual({
        phase: "reviewing",
        kind: "prompt-dispatch",
        sessionId: "review-session",
      });
    });

    test("preserves existing context when an already failed pipeline gets a new error", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "verifying");
      useBuildPipelineStore.getState().setPipelineError(id, "First failure", {
        phase: "verifying",
        kind: "stage-transition",
      });

      useBuildPipelineStore.getState().setPipelineError(id, "More detail");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.error).toBe("More detail");
      expect(pipeline.failureContext).toEqual({
        phase: "verifying",
        kind: "stage-transition",
      });
    });

    test("allows terminal semantic failures to opt out of reconnect", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "verifying");

      useBuildPipelineStore.getState().setPipelineError(id, "Max iterations reached", null);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("failed");
      expect(pipeline.error).toBe("Max iterations reached");
      expect(pipeline.failureContext).toBeUndefined();
    });

    test("allows an explicit terminal failure to replace a paused state", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.pausePipeline(id);

      store.setPipelineError(id, "Unattended pipeline requires input", null);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("failed");
      expect(pipeline.error).toBe("Unattended pipeline requires input");
      expect(pipeline.failureContext).toBeUndefined();
    });

    test("ignores late errors after pause or completion", () => {
      const pausedId = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const completedId = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-2" }));
      const store = useBuildPipelineStore.getState();
      store.setPhase(pausedId, "building");
      store.pausePipeline(pausedId);
      store.setPhase(completedId, "complete");

      store.setPipelineError(pausedId, "Late rejection");
      store.setPipelineError(completedId, "Late rejection");

      expect(useBuildPipelineStore.getState().pipelines.get(pausedId)!.phase).toBe("paused");
      expect(useBuildPipelineStore.getState().pipelines.get(completedId)!.phase).toBe("complete");
    });

    test("ignores an explicitly owned error after the phase has advanced", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "reviewing");

      store.setPipelineError(id, "Late build rejection", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "build-session",
      });

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("reviewing");
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.error).toBeUndefined();
    });

    test("ignores a stale error from a different failed operation", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "reviewing");
      store.setPipelineError(id, "Review failed", {
        phase: "reviewing",
        kind: "prompt-dispatch",
        sessionId: "review-session",
      });

      store.setPipelineError(id, "Late build failure", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "build-session",
      });

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.error).toBe("Review failed");
      expect(pipeline.failureContext?.sessionId).toBe("review-session");
    });

    test("clears paused and reconnect state", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.setState((state) => {
        const newMap = new Map(state.pipelines);
        const pipeline = newMap.get(id)!;
        newMap.set(id, {
          ...pipeline,
          phase: "building",
          pausedFromPhase: "reviewing",
          reconnectAttempt: createReconnectAttempt(),
        });
        return { pipelines: newMap };
      });

      useBuildPipelineStore.getState().setPipelineError(id, "Failed again");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.pausedFromPhase).toBeUndefined();
      expect(pipeline.reconnectAttempt).toBeUndefined();
    });

    test("no-ops idempotently for the same error and context", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const context = { phase: "building", kind: "prompt-dispatch", sessionId: "session-1" } as const;
      useBuildPipelineStore.getState().setPhase(id, "building");
      useBuildPipelineStore.getState().setPipelineError(id, "Connection lost", context);
      const before = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().setPipelineError(id, "Connection lost", { ...context });

      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().setPipelineError("nonexistent", "error");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });
  });

  describe("reconnect ownership", () => {
    test("begins a reconnect only when the attempt exactly matches failure context", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "addressing");
      useBuildPipelineStore.getState().setPipelineError(id, "Connection dropped", {
        phase: "addressing",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      useBuildPipelineStore.setState((state) => {
        const newMap = new Map(state.pipelines);
        newMap.set(id, { ...newMap.get(id)!, pausedFromPhase: "reviewing" });
        return { pipelines: newMap };
      });
      const attempt = createReconnectAttempt({ phase: "addressing" });

      const started = useBuildPipelineStore.getState().beginReconnect(id, attempt);

      expect(started).toBe(true);
      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("addressing");
      expect(pipeline.error).toBeUndefined();
      expect(pipeline.pausedFromPhase).toBeUndefined();
      expect(pipeline.failureContext).toEqual({
        phase: "addressing",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      expect(pipeline.reconnectAttempt).toEqual(attempt);
    });

    test("rejects unknown, active, mismatched, and duplicate attempts", () => {
      const store = useBuildPipelineStore.getState();
      expect(store.beginReconnect("missing", createReconnectAttempt())).toBe(false);

      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      expect(store.beginReconnect(id, createReconnectAttempt())).toBe(false);

      store.setPhase(id, "reviewing");
      store.setPipelineError(id, "Connection dropped", {
        phase: "reviewing",
        kind: "prompt-dispatch",
        sessionId: "review-session",
      });
      expect(store.beginReconnect(id, createReconnectAttempt())).toBe(false);
      expect(store.beginReconnect(id, createReconnectAttempt({
        phase: "reviewing",
        sessionId: "wrong-session",
      }))).toBe(false);
      expect(store.beginReconnect(id, createReconnectAttempt({
        phase: "reviewing",
        kind: "stage-transition",
        sessionId: "review-session",
      }))).toBe(false);

      const matching = createReconnectAttempt({
        phase: "reviewing",
        sessionId: "review-session",
      });
      expect(store.beginReconnect(id, matching)).toBe(true);
      expect(store.beginReconnect(id, { ...matching, id: "attempt-2" })).toBe(false);
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.reconnectAttempt?.id).toBe("attempt-1");
    });

    test("completes only the owned attempt and retains retry provenance", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.setPipelineError(id, "Connection dropped", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      store.beginReconnect(id, createReconnectAttempt());

      expect(store.completeReconnect("missing", "attempt-1")).toBe(false);
      expect(store.completeReconnect(id, "stale-attempt")).toBe(false);
      expect(store.completeReconnect(id, "attempt-1")).toBe(true);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("building");
      expect(pipeline.failureContext).toEqual({
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      expect(pipeline.activePromptContext).toEqual({
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      expect(pipeline.reconnectAttempt).toBeUndefined();
      expect(store.completeReconnect(id, "attempt-1")).toBe(false);
    });

    test("retains prompt provenance when reconnect reconciles an already running turn", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      const context = {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
        prompt: "Build the requested change",
        useTaskImages: true,
        requestId: "request-123",
      } as const;
      store.setPipelineError(id, "Response lost", context);
      store.beginReconnect(id, createReconnectAttempt({
        ...context,
        id: "running-reconnect",
      }));
      store.completeReconnect(id, "running-reconnect");
      store.setPhase(id, "building");

      store.setPipelineError(id, "Remote turn later failed");

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.failureContext).toEqual(context);
    });

    test("fails only the owned attempt and preserves failure context for another retry", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.setPipelineError(id, "Connection dropped", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      store.beginReconnect(id, createReconnectAttempt());

      expect(store.failReconnect("missing", "attempt-1", "retry failed")).toBe(false);
      expect(store.failReconnect(id, "stale-attempt", "retry failed")).toBe(false);
      expect(store.failReconnect(id, "attempt-1", "retry failed")).toBe(true);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("failed");
      expect(pipeline.error).toBe("retry failed");
      expect(pipeline.failureContext).toEqual({
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      expect(pipeline.reconnectAttempt).toBeUndefined();
      expect(store.failReconnect(id, "attempt-1", "late failure")).toBe(false);
    });

    test("reconnect dispatch failure preserves the exact prompt for another retry", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      const context = {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
        prompt: "Build the requested change",
        useTaskImages: true,
        requestId: "request-123",
      } as const;
      store.setPipelineError(id, "Response lost", context);
      store.beginReconnect(id, createReconnectAttempt({ ...context }));
      store.beginPromptAttempt(id, createPromptAttempt());

      expect(store.failReconnect(id, "attempt-1", "Dispatch failed again")).toBe(true);

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.failureContext).toEqual(context);
    });

    test("pause cancels attempt ownership so a late failure cannot overwrite Stop", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.setPipelineError(id, "Connection dropped", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      store.beginReconnect(id, createReconnectAttempt());

      store.pausePipeline(id);

      const paused = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(paused.phase).toBe("paused");
      expect(paused.pausedFromPhase).toBe("building");
      expect(paused.reconnectAttempt).toBeUndefined();
      expect(store.failReconnect(id, "attempt-1", "late failure")).toBe(false);
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("paused");
    });

    test("a different phase transition cancels reconnect ownership", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.setPipelineError(id, "Connection dropped", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      store.beginReconnect(id, createReconnectAttempt());

      store.setPhase(id, "reviewing");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("reviewing");
      expect(pipeline.failureContext).toBeUndefined();
      expect(pipeline.reconnectAttempt).toBeUndefined();
      expect(store.failReconnect(id, "attempt-1", "late failure")).toBe(false);
    });

    test("setting the same retry phase preserves attempt ownership", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.setPipelineError(id, "Connection dropped", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      store.beginReconnect(id, createReconnectAttempt());

      store.setPhase(id, "building");

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.reconnectAttempt?.id).toBe("attempt-1");
    });
  });

  describe("prompt attempt ownership", () => {
    test("persists pending and active prompt context while dispatch is in flight", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      const attempt = createPromptAttempt();

      expect(store.beginPromptAttempt(id, attempt)).toBe(true);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.pendingPromptAttempt).toEqual(attempt);
      expect(pipeline.activePromptContext).toEqual({
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
        requestId: "request-123",
        prompt: "Build the requested change",
        useTaskImages: true,
      });
    });

    test("rejects unknown, wrong-phase, and duplicate prompt attempts", () => {
      const store = useBuildPipelineStore.getState();
      expect(store.beginPromptAttempt("missing", createPromptAttempt())).toBe(false);

      const id = store.createPipeline(createPipelineParams());
      expect(store.beginPromptAttempt(id, createPromptAttempt())).toBe(false);
      store.setPhase(id, "building");
      expect(store.beginPromptAttempt(id, createPromptAttempt())).toBe(true);
      expect(store.beginPromptAttempt(id, createPromptAttempt({ id: "prompt-attempt-2" }))).toBe(false);
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.pendingPromptAttempt?.id).toBe("prompt-attempt-1");
    });

    test("completes only the owned dispatch and retains active prompt provenance", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.beginPromptAttempt(id, createPromptAttempt());

      expect(store.completePromptAttempt("missing", "prompt-attempt-1")).toBe(false);
      expect(store.completePromptAttempt(id, "stale-attempt")).toBe(false);
      expect(store.completePromptAttempt(id, "prompt-attempt-1")).toBe(true);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.pendingPromptAttempt).toBeUndefined();
      expect(pipeline.activePromptContext?.prompt).toBe("Build the requested change");
      expect(store.completePromptAttempt(id, "prompt-attempt-1")).toBe(false);
    });

    test("uses active prompt provenance for a later remote session error", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.beginPromptAttempt(id, createPromptAttempt());
      store.completePromptAttempt(id, "prompt-attempt-1");

      store.setPipelineError(id, "Remote execution failed");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.failureContext).toEqual({
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
        requestId: "request-123",
        prompt: "Build the requested change",
        useTaskImages: true,
      });
      expect(pipeline.activePromptContext).toBeUndefined();
    });

    test("marking the owning session idle clears active prompt provenance", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.addSession(id, createMockSession());
      store.beginPromptAttempt(id, createPromptAttempt());
      store.completePromptAttempt(id, "prompt-attempt-1");

      store.markSessionIdle(id, "session-123");

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.activePromptContext).toBeUndefined();
    });

    test("marking the owning session idle clears retained reconnect provenance", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.addSession(id, createMockSession());
      store.setPipelineError(id, "Response lost", {
        phase: "building",
        kind: "prompt-dispatch",
        sessionId: "session-123",
      });
      store.beginReconnect(id, createReconnectAttempt());
      store.completeReconnect(id, "attempt-1");

      store.markSessionIdle(id, "session-123");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.activePromptContext).toBeUndefined();
      expect(pipeline.failureContext).toBeUndefined();
    });

    test("a new prompt supersedes prior active prompt provenance", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const store = useBuildPipelineStore.getState();
      store.setPhase(id, "building");
      store.beginPromptAttempt(id, createPromptAttempt());
      store.completePromptAttempt(id, "prompt-attempt-1");
      useBuildPipelineStore.setState((state) => {
        const newMap = new Map(state.pipelines);
        newMap.set(id, {
          ...newMap.get(id)!,
          failureContext: {
            phase: "building",
            kind: "prompt-dispatch",
            sessionId: "old-session",
          },
        });
        return { pipelines: newMap };
      });

      store.beginPromptAttempt(id, createPromptAttempt({
        id: "prompt-attempt-2",
        requestId: "request-456",
        prompt: "Address the follow-up",
        useTaskImages: false,
      }));

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.activePromptContext?.requestId).toBe("request-456");
      expect(pipeline.activePromptContext?.prompt).toBe("Address the follow-up");
      expect(pipeline.activePromptContext?.useTaskImages).toBe(false);
      expect(pipeline.failureContext).toBeUndefined();
    });

    test("pause and phase changes clear pending and active prompt state", () => {
      const firstId = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const secondId = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-2" }));
      const store = useBuildPipelineStore.getState();
      for (const id of [firstId, secondId]) {
        store.setPhase(id, "building");
        store.beginPromptAttempt(id, createPromptAttempt({ id: `attempt-${id}` }));
      }

      store.pausePipeline(firstId);
      store.setPhase(secondId, "reviewing");

      for (const id of [firstId, secondId]) {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
        expect(pipeline.pendingPromptAttempt).toBeUndefined();
        expect(pipeline.activePromptContext).toBeUndefined();
      }
    });
  });

  describe("pausePipeline", () => {
    test("sets phase to paused and clears error", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "building");
      useBuildPipelineStore.getState().setPipelineError(id, "some error");

      // Re-create since setPipelineError sets phase to "failed"
      const id2 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-2" }));
      useBuildPipelineStore.getState().setPhase(id2, "building");

      useBuildPipelineStore.getState().pausePipeline(id2);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id2)!;
      expect(pipeline.phase).toBe("paused");
      expect(pipeline.pausedFromPhase).toBe("building");
      expect(pipeline.error).toBeUndefined();
    });

    test("clears existing error when pausing", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      // Manually set error on the pipeline
      useBuildPipelineStore.setState((state) => {
        const newMap = new Map(state.pipelines);
        const pipeline = newMap.get(id)!;
        newMap.set(id, { ...pipeline, phase: "building", error: "previous error" });
        return { pipelines: newMap };
      });

      useBuildPipelineStore.getState().pausePipeline(id);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("paused");
      expect(pipeline.pausedFromPhase).toBe("building");
      expect(pipeline.error).toBeUndefined();
    });

    test("preserves the original phase when pausing an already paused pipeline", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "verifying");
      useBuildPipelineStore.getState().pausePipeline(id);
      useBuildPipelineStore.getState().pausePipeline(id);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("paused");
      expect(pipeline.pausedFromPhase).toBe("verifying");
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().pausePipeline("nonexistent");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });
  });

  describe("resumePipeline", () => {
    test("restores the phase captured by pausePipeline", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "fixing");
      useBuildPipelineStore.getState().pausePipeline(id);

      const resumedPhase = useBuildPipelineStore.getState().resumePipeline(id);

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(resumedPhase).toBe("fixing");
      expect(pipeline.phase).toBe("fixing");
      expect(pipeline.pausedFromPhase).toBeUndefined();
    });

    test("uses a fallback phase when no pause snapshot exists", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.setState((state) => {
        const newMap = new Map(state.pipelines);
        const pipeline = newMap.get(id)!;
        newMap.set(id, { ...pipeline, phase: "paused", pausedFromPhase: undefined });
        return { pipelines: newMap };
      });

      const resumedPhase = useBuildPipelineStore.getState().resumePipeline(id, "building");

      expect(resumedPhase).toBe("building");
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("building");
    });

    test("no-ops for pipelines that are not paused", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "building");

      const resumedPhase = useBuildPipelineStore.getState().resumePipeline(id);

      expect(resumedPhase).toBeUndefined();
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("building");
    });

    test("no-ops for unknown pipelines and paused pipelines without a resume phase", () => {
      const store = useBuildPipelineStore.getState();
      expect(store.resumePipeline("missing", "building")).toBeUndefined();

      const id = store.createPipeline(createPipelineParams());
      useBuildPipelineStore.setState((state) => {
        const newMap = new Map(state.pipelines);
        newMap.set(id, { ...newMap.get(id)!, phase: "paused", pausedFromPhase: undefined });
        return { pipelines: newMap };
      });
      const before = useBuildPipelineStore.getState().pipelines;

      expect(store.resumePipeline(id)).toBeUndefined();
      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });
  });

  describe("markSessionRunning", () => {
    test("marks a specific session as running by sdkSessionId", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s1", status: "idle" }));
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s2", status: "idle" }));

      useBuildPipelineStore.getState().markSessionRunning(id, "s1");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.sessions[0]!.status).toBe("running");
      expect(pipeline.sessions[1]!.status).toBe("idle");
    });

    test("leaves other sessions unchanged", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s1", status: "running" }));
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s2", status: "error" }));

      useBuildPipelineStore.getState().markSessionRunning(id, "s2");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.sessions[0]!.status).toBe("running");
      expect(pipeline.sessions[1]!.status).toBe("running");
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().markSessionRunning("nonexistent", "s1");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });

    test("no-ops for unknown session ID within pipeline", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().addSession(id, createMockSession({ sdkSessionId: "s1", status: "idle" }));

      useBuildPipelineStore.getState().markSessionRunning(id, "nonexistent");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.sessions[0]!.status).toBe("idle");
    });

    test("no-ops idempotently for an already running session", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().addSession(id, createMockSession({ status: "running" }));
      const before = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().markSessionRunning(id, "session-123");

      expect(useBuildPipelineStore.getState().pipelines).toBe(before);
    });
  });

  describe("getPipelineByTaskId", () => {
    test("returns the pipeline matching the task ID", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "task-abc" }));

      const found = useBuildPipelineStore.getState().getPipelineByTaskId("task-abc");
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);
    });

    test("returns undefined for unknown task ID", () => {
      useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      expect(useBuildPipelineStore.getState().getPipelineByTaskId("nonexistent")).toBeUndefined();
    });
  });

  describe("getPipelineById", () => {
    test("returns the pipeline by its ID", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const found = useBuildPipelineStore.getState().getPipelineById(id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);
    });

    test("returns undefined for unknown ID", () => {
      expect(useBuildPipelineStore.getState().getPipelineById("nonexistent")).toBeUndefined();
    });
  });

  describe("getActivePipelineForEnvironment", () => {
    test("returns active pipeline for environment", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");
      useBuildPipelineStore.getState().setPhase(id, "building");

      const found = useBuildPipelineStore.getState().getActivePipelineForEnvironment("env-1");
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);
    });

    test("returns undefined for completed pipelines", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");
      useBuildPipelineStore.getState().setPhase(id, "complete");

      expect(useBuildPipelineStore.getState().getActivePipelineForEnvironment("env-1")).toBeUndefined();
    });

    test("returns undefined for failed pipelines", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");
      useBuildPipelineStore.getState().setPipelineError(id, "error");

      expect(useBuildPipelineStore.getState().getActivePipelineForEnvironment("env-1")).toBeUndefined();
    });

    test("returns undefined for unknown environment", () => {
      expect(useBuildPipelineStore.getState().getActivePipelineForEnvironment("nonexistent")).toBeUndefined();
    });
  });

  describe("isBuildEnvironment", () => {
    test("returns true for environments with pipelines", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");

      expect(useBuildPipelineStore.getState().isBuildEnvironment("env-1")).toBe(true);
    });

    test("returns false for environments without pipelines", () => {
      expect(useBuildPipelineStore.getState().isBuildEnvironment("env-1")).toBe(false);
    });
  });

  describe("_rebuildBuildEnvironmentIds", () => {
    test("returns set of all non-empty environment IDs from pipelines", () => {
      const id1 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "t1" }));
      const id2 = useBuildPipelineStore.getState().createPipeline(createPipelineParams({ taskId: "t2" }));
      useBuildPipelineStore.getState().setPipelineEnvironment(id1, "env-1");
      // id2 has empty string environmentId — should be excluded

      const ids = useBuildPipelineStore.getState()._rebuildBuildEnvironmentIds();
      expect(ids.size).toBe(1);
      expect(ids.has("env-1")).toBe(true);
    });
  });

  describe("immutability", () => {
    test("each mutation creates a new Map reference", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      const mapAfterCreate = useBuildPipelineStore.getState().pipelines;

      useBuildPipelineStore.getState().setPhase(id, "building");
      const mapAfterPhase = useBuildPipelineStore.getState().pipelines;

      expect(mapAfterCreate).not.toBe(mapAfterPhase);
    });
  });
});
