import { describe, test, expect, beforeEach } from "bun:test";
import { useBuildPipelineStore } from "../../../apps/web/src/stores/buildPipelineStore";
import type { BuildPipeline, PipelineSession } from "../../../apps/web/src/stores/buildPipelineStore";
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
  });

  describe("setCurrentSessionIndex", () => {
    test("updates the current session index", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setCurrentSessionIndex(id, 5);

      expect(useBuildPipelineStore.getState().pipelines.get(id)!.currentSessionIndex).toBe(5);
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
    test("sets phase to failed and stores error message", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPhase(id, "building");

      useBuildPipelineStore.getState().setPipelineError(id, "Container crashed");

      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("failed");
      expect(pipeline.error).toBe("Container crashed");
    });

    test("no-ops for unknown pipeline ID", () => {
      useBuildPipelineStore.getState().setPipelineError("nonexistent", "error");
      expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    });
  });

  describe("retryFailedPipeline", () => {
    test("restores the requested phase and clears the failure", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());
      useBuildPipelineStore.getState().setPipelineError(id, "Connection dropped");

      const retried = useBuildPipelineStore.getState().retryFailedPipeline(id, "addressing");

      expect(retried).toBe(true);
      const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
      expect(pipeline.phase).toBe("addressing");
      expect(pipeline.error).toBeUndefined();
    });

    test("does not restart a pipeline that is not failed", () => {
      const id = useBuildPipelineStore.getState().createPipeline(createPipelineParams());

      const retried = useBuildPipelineStore.getState().retryFailedPipeline(id, "building");

      expect(retried).toBe(false);
      expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("creating-environment");
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
