import { beforeEach, describe, expect, test } from "bun:test";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import {
  parseVerificationResult,
  buildBuildPrompt,
  buildVerificationPrompt,
  buildFixPrompt,
} from "./BuildChatTab";
import type { ClaudeMessage } from "@/lib/claude-client";

// --- parseVerificationResult ---

describe("parseVerificationResult", () => {
  function makeAssistantMessage(text: string): ClaudeMessage {
    return {
      id: `msg-${Date.now()}`,
      role: "assistant",
      content: text,
      parts: [{ type: "text", content: text }],
      timestamp: new Date().toISOString(),
    };
  }

  test("returns pass when last assistant message starts with YES", () => {
    const messages: ClaudeMessage[] = [
      { id: "1", role: "user", content: "verify", parts: [{ type: "text", content: "verify" }], timestamp: "" },
      makeAssistantMessage("YES\nAll criteria are satisfied."),
    ];

    const result = parseVerificationResult(messages);
    expect(result.verdict).toBe("pass");
    expect(result.feedback).toContain("YES");
  });

  test("returns pass when YES is followed by punctuation", () => {
    const result = parseVerificationResult([
      makeAssistantMessage("YES, everything looks good.\nAll acceptance criteria met."),
    ]);
    expect(result.verdict).toBe("pass");
  });

  test("returns fail when last assistant message starts with NO", () => {
    const messages: ClaudeMessage[] = [
      makeAssistantMessage("NO\nThe following criteria are not met:\n- Missing error handling"),
    ];

    const result = parseVerificationResult(messages);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toContain("Missing error handling");
  });

  test("returns fail when response is ambiguous (not YES/NO)", () => {
    const result = parseVerificationResult([
      makeAssistantMessage("I'm not sure if the criteria are met. Let me explain..."),
    ]);
    expect(result.verdict).toBe("fail");
  });

  test("returns fail with descriptive feedback when no assistant messages", () => {
    const result = parseVerificationResult([]);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toBe("No verification response received");
  });

  test("uses the last assistant message when multiple exist", () => {
    const messages: ClaudeMessage[] = [
      makeAssistantMessage("NO\nFirst check failed."),
      { id: "2", role: "user", content: "check again", parts: [{ type: "text", content: "check again" }], timestamp: "" },
      makeAssistantMessage("YES\nAll good now."),
    ];

    const result = parseVerificationResult(messages);
    expect(result.verdict).toBe("pass");
  });

  test("handles case-insensitive YES", () => {
    const result = parseVerificationResult([
      makeAssistantMessage("yes\nAll good."),
    ]);
    expect(result.verdict).toBe("pass");
  });

  test("concatenates multiple text parts", () => {
    const messages: ClaudeMessage[] = [{
      id: "1",
      role: "assistant",
      content: "NO",
      parts: [
        { type: "text", content: "NO" },
        { type: "text", content: "Missing tests." },
      ],
      timestamp: "",
    }];
    const result = parseVerificationResult(messages);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toContain("Missing tests.");
  });
});

// --- buildBuildPrompt ---

describe("buildBuildPrompt", () => {
  const baseTask = {
    title: "Add dark mode",
    description: "Implement dark mode toggle",
    acceptanceCriteria: "- Toggle switch exists\n- Theme persists",
    comments: [] as Array<{ text: string }>,
  };

  test("returns fallback when task is null", () => {
    const result = buildBuildPrompt(null, "");
    expect(result).toBe("Build the feature as described.");
  });

  test("includes title and description", () => {
    const result = buildBuildPrompt(baseTask, "");
    expect(result).toContain("**Title**: Add dark mode");
    expect(result).toContain("**Description**: Implement dark mode toggle");
  });

  test("includes acceptance criteria", () => {
    const result = buildBuildPrompt(baseTask, "");
    expect(result).toContain("**Acceptance Criteria**:");
    expect(result).toContain("Toggle switch exists");
  });

  test("includes comments when present", () => {
    const task = { ...baseTask, comments: [{ text: "Use CSS variables" }, { text: "Support system preference" }] };
    const result = buildBuildPrompt(task, "");
    expect(result).toContain("**Comments**:");
    expect(result).toContain("1. Use CSS variables");
    expect(result).toContain("2. Support system preference");
  });

  test("includes project notes when provided", () => {
    const result = buildBuildPrompt(baseTask, "We use Tailwind for styling");
    expect(result).toContain("**Project Notes**:");
    expect(result).toContain("We use Tailwind for styling");
  });

  test("omits empty description", () => {
    const task = { ...baseTask, description: "" };
    const result = buildBuildPrompt(task, "");
    expect(result).not.toContain("**Description**:");
  });

  test("ends with instruction to build without questions", () => {
    const result = buildBuildPrompt(baseTask, "");
    expect(result).toContain("Do not ask any questions");
  });
});

// --- buildVerificationPrompt ---

describe("buildVerificationPrompt", () => {
  const baseTask = {
    title: "Add search",
    description: "Full-text search",
    acceptanceCriteria: "- Search box visible\n- Results load in <1s",
    comments: [] as Array<{ text: string }>,
  };

  test("returns fallback when task is null", () => {
    const result = buildVerificationPrompt(null, "");
    expect(result).toContain("acceptance criteria");
  });

  test("asks for YES/NO answer", () => {
    const result = buildVerificationPrompt(baseTask, "");
    expect(result).toContain("YES or NO");
  });

  test("includes ticket context", () => {
    const result = buildVerificationPrompt(baseTask, "");
    expect(result).toContain("**Title**: Add search");
    expect(result).toContain("Search box visible");
  });
});

// --- buildFixPrompt ---

describe("buildFixPrompt", () => {
  const baseTask = {
    title: "Fix login",
    description: "Login page broken",
    acceptanceCriteria: "- Login works with email\n- Error shown on bad password",
    comments: [] as Array<{ text: string }>,
  };

  test("returns fallback with feedback when task is null", () => {
    const result = buildFixPrompt(null, "", "Missing error messages");
    expect(result).toContain("Missing error messages");
    expect(result).toContain("Do not ask any questions");
  });

  test("includes ticket context and failure reason", () => {
    const result = buildFixPrompt(baseTask, "", "Error message not displayed on invalid password");
    expect(result).toContain("**Title**: Fix login");
    expect(result).toContain("NOT been fully satisfied");
    expect(result).toContain("Error message not displayed on invalid password");
  });

  test("includes project notes", () => {
    const result = buildFixPrompt(baseTask, "Auth uses JWT tokens", "Session not persisted");
    expect(result).toContain("Auth uses JWT tokens");
  });
});

// --- buildPipelineStore ---

describe("buildPipelineStore", () => {
  beforeEach(() => {
    useBuildPipelineStore.setState({ pipelines: new Map() });
  });

  test("createPipeline creates a pipeline with correct initial state", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "task-1",
      projectId: "proj-1",
      environmentType: "local",
      taskTitle: "My Feature",
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(id);
    expect(pipeline).toBeDefined();
    expect(pipeline!.taskId).toBe("task-1");
    expect(pipeline!.projectId).toBe("proj-1");
    expect(pipeline!.phase).toBe("creating-environment");
    expect(pipeline!.sessions).toEqual([]);
    expect(pipeline!.currentSessionIndex).toBe(-1);
    expect(pipeline!.iteration).toBe(0);
    expect(pipeline!.maxIterations).toBe(3);
    expect(pipeline!.environmentId).toBe("");
    expect(pipeline!.taskTitle).toBe("My Feature");
  });

  test("setPipelineEnvironment links environment", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "containerized",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-123");
    const pipeline = useBuildPipelineStore.getState().pipelines.get(id);
    expect(pipeline!.environmentId).toBe("env-123");
  });

  test("setPhase updates pipeline phase", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().setPhase(id, "building");
    expect(useBuildPipelineStore.getState().pipelines.get(id)!.phase).toBe("building");
  });

  test("addSession appends session and updates currentSessionIndex", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    const session = {
      phase: "build" as const,
      iteration: 0,
      sessionKey: "env-123:tab-1",
      sdkSessionId: "sdk-1",
      status: "running" as const,
      startedAt: new Date().toISOString(),
      label: "Build Session",
    };

    useBuildPipelineStore.getState().addSession(id, session);
    const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
    expect(pipeline.sessions).toHaveLength(1);
    expect(pipeline.sessions[0]!.sdkSessionId).toBe("sdk-1");
    expect(pipeline.currentSessionIndex).toBe(0);
  });

  test("markSessionIdle sets session status to idle", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().addSession(id, {
      phase: "build",
      iteration: 0,
      sessionKey: "key",
      sdkSessionId: "sdk-1",
      status: "running",
      startedAt: "",
      label: "Build",
    });

    useBuildPipelineStore.getState().markSessionIdle(id, "sdk-1");
    const session = useBuildPipelineStore.getState().pipelines.get(id)!.sessions[0];
    expect(session!.status).toBe("idle");
  });

  test("incrementIteration increments iteration count", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().incrementIteration(id);
    expect(useBuildPipelineStore.getState().pipelines.get(id)!.iteration).toBe(1);

    useBuildPipelineStore.getState().incrementIteration(id);
    expect(useBuildPipelineStore.getState().pipelines.get(id)!.iteration).toBe(2);
  });

  test("setPipelineError sets phase to failed with error message", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().setPipelineError(id, "Something went wrong");
    const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
    expect(pipeline.phase).toBe("failed");
    expect(pipeline.error).toBe("Something went wrong");
  });

  test("setVerificationResult stores result and feedback", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().setVerificationResult(id, "fail", "Missing tests");
    const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
    expect(pipeline.verificationResult).toBe("fail");
    expect(pipeline.verificationFeedback).toBe("Missing tests");
  });

  test("getPipelineByTaskId finds pipeline by task ID", () => {
    const store = useBuildPipelineStore.getState();
    store.createPipeline({
      taskId: "task-abc",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    const found = useBuildPipelineStore.getState().getPipelineByTaskId("task-abc");
    expect(found).toBeDefined();
    expect(found!.taskId).toBe("task-abc");
  });

  test("getPipelineByTaskId returns undefined for non-existent task", () => {
    const found = useBuildPipelineStore.getState().getPipelineByTaskId("nonexistent");
    expect(found).toBeUndefined();
  });

  test("getActivePipelineForEnvironment finds active pipeline", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");
    useBuildPipelineStore.getState().setPhase(id, "building");

    const found = useBuildPipelineStore.getState().getActivePipelineForEnvironment("env-1");
    expect(found).toBeDefined();
    expect(found!.id).toBe(id);
  });

  test("getActivePipelineForEnvironment ignores completed pipelines", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "local",
      taskTitle: "Test",
    });

    useBuildPipelineStore.getState().setPipelineEnvironment(id, "env-1");
    useBuildPipelineStore.getState().setPhase(id, "complete");

    const found = useBuildPipelineStore.getState().getActivePipelineForEnvironment("env-1");
    expect(found).toBeUndefined();
  });

  test("actions on non-existent pipeline are no-ops", () => {
    const store = useBuildPipelineStore.getState();
    // These should not throw
    store.setPhase("nonexistent", "building");
    store.setPipelineEnvironment("nonexistent", "env-1");
    store.markSessionIdle("nonexistent", "sdk-1");
    store.incrementIteration("nonexistent");
    store.setPipelineError("nonexistent", "error");

    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });
});
