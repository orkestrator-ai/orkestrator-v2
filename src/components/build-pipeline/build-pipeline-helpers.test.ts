import { beforeEach, describe, expect, test } from "bun:test";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useEnvironmentStore } from "@/stores";
import {
  createBuildReviewPrompt,
  createBuildPrompt,
  createVerificationPrompt,
  createFixPrompt,
} from "@/prompts";
import { parseVerificationResult } from "@/lib/parse-verification-result";
import type { ClaudeMessage } from "@/lib/claude-client";
import { isSetupPending } from "@/lib/setup-commands";
import { waitForSetupInitiation } from "@/hooks/useBuildPipeline";

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

  // --- JSON format tests ---

  test("returns pass when JSON has complete: true in code block", () => {
    const messages: ClaudeMessage[] = [
      { id: "1", role: "user", content: "verify", parts: [{ type: "text", content: "verify" }], timestamp: "" },
      makeAssistantMessage('```json\n{"complete": true, "rationale": "All criteria are satisfied."}\n```'),
    ];

    const result = parseVerificationResult(messages);
    expect(result.verdict).toBe("pass");
    expect(result.feedback).toBe("All criteria are satisfied.");
  });

  test("returns fail when JSON has complete: false in code block", () => {
    const result = parseVerificationResult([
      makeAssistantMessage('```json\n{"complete": false, "rationale": "Missing error handling for edge cases."}\n```'),
    ]);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toBe("Missing error handling for edge cases.");
  });

  test("parses raw JSON without code block", () => {
    const result = parseVerificationResult([
      makeAssistantMessage('{"complete": true, "rationale": "Everything looks good."}'),
    ]);
    expect(result.verdict).toBe("pass");
    expect(result.feedback).toBe("Everything looks good.");
  });

  test("parses JSON from code block without json language tag", () => {
    const result = parseVerificationResult([
      makeAssistantMessage('```\n{"complete": false, "rationale": "Tests are missing."}\n```'),
    ]);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toBe("Tests are missing.");
  });

  test("handles JSON with extra whitespace in code block", () => {
    const result = parseVerificationResult([
      makeAssistantMessage('```json\n{\n  "complete": true,\n  "rationale": "All good."\n}\n```'),
    ]);
    expect(result.verdict).toBe("pass");
    expect(result.feedback).toBe("All good.");
  });

  test("falls back to legacy parsing on malformed JSON", () => {
    const result = parseVerificationResult([
      makeAssistantMessage('```json\n{"complete": true, "rationale": }\n```'),
    ]);
    // Malformed JSON can't be parsed, falls through to legacy YES/NO check.
    // First line is a code fence, not YES/NO, so verdict is fail.
    expect(result.verdict).toBe("fail");
  });

  // --- Legacy YES/NO fallback tests ---

  test("falls back to YES parsing for legacy format", () => {
    const result = parseVerificationResult([
      makeAssistantMessage("YES\nAll criteria are satisfied."),
    ]);
    expect(result.verdict).toBe("pass");
  });

  test("falls back to YES with punctuation for legacy format", () => {
    const result = parseVerificationResult([
      makeAssistantMessage("YES, everything looks good.\nAll acceptance criteria met."),
    ]);
    expect(result.verdict).toBe("pass");
  });

  test("returns fail for legacy NO format", () => {
    const result = parseVerificationResult([
      makeAssistantMessage("NO\nThe following criteria are not met:\n- Missing error handling"),
    ]);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toContain("Missing error handling");
  });

  test("returns fail when response is ambiguous", () => {
    const result = parseVerificationResult([
      makeAssistantMessage("I'm not sure if the criteria are met. Let me explain..."),
    ]);
    expect(result.verdict).toBe("fail");
  });

  // --- Common tests ---

  test("returns fail with descriptive feedback when no assistant messages", () => {
    const result = parseVerificationResult([]);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toBe("No verification response received");
  });

  test("uses the last assistant message when multiple exist", () => {
    const messages: ClaudeMessage[] = [
      makeAssistantMessage('```json\n{"complete": false, "rationale": "First check failed."}\n```'),
      { id: "2", role: "user", content: "check again", parts: [{ type: "text", content: "check again" }], timestamp: "" },
      makeAssistantMessage('```json\n{"complete": true, "rationale": "All good now."}\n```'),
    ];

    const result = parseVerificationResult(messages);
    expect(result.verdict).toBe("pass");
    expect(result.feedback).toBe("All good now.");
  });

  test("concatenates multiple text parts and finds JSON", () => {
    const messages: ClaudeMessage[] = [{
      id: "1",
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "Let me check the criteria..." },
        { type: "text", content: '```json\n{"complete": false, "rationale": "Missing tests."}\n```' },
      ],
      timestamp: "",
    }];
    const result = parseVerificationResult(messages);
    expect(result.verdict).toBe("fail");
    expect(result.feedback).toBe("Missing tests.");
  });
});

// --- createBuildReviewPrompt ---

describe("createBuildReviewPrompt", () => {
  const baseTask = {
    title: "Add dark mode",
    description: "Implement dark mode toggle",
    acceptanceCriteria: "- Toggle switch exists\n- Theme persists",
    comments: [] as Array<{ text: string }>,
    images: [],
  };

  test("includes commit step", () => {
    const result = createBuildReviewPrompt(null, "");
    expect(result).toContain("## Step 1: Commit Changes");
    expect(result).toContain("conventional commit format");
    expect(result).toContain("Do NOT reference Claude");
  });

  test("includes test run step", () => {
    const result = createBuildReviewPrompt(null, "");
    expect(result).toContain("## Step 2: Run Tests");
    expect(result).toContain("Run the project's full test suite");
  });

  test("includes code review step with git diff against target branch", () => {
    const result = createBuildReviewPrompt(null, "", "main");
    expect(result).toContain("## Step 3: Code Review");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  test("includes review instructions when task is null", () => {
    const result = createBuildReviewPrompt(null, "");
    expect(result).toContain("Code Review");
  });

  test("includes all review categories", () => {
    const result = createBuildReviewPrompt(null, "");
    expect(result).toContain("Logic and correctness");
    expect(result).toContain("Readability");
    expect(result).toContain("Performance");
  });

  test("includes test coverage review step", () => {
    const result = createBuildReviewPrompt(null, "");
    expect(result).toContain("## Step 4: Test Coverage Review");
    expect(result).toContain("entire file");
    expect(result).toContain("not modified in this change");
  });

  test("includes structured output format", () => {
    const result = createBuildReviewPrompt(baseTask, "");
    expect(result).toContain("## Output Format");
    expect(result).toContain("File and line number(s)");
    expect(result).toContain("Code snippet");
    expect(result).toContain("Potential solution(s)");
  });

  test("includes ticket context when task is provided", () => {
    const result = createBuildReviewPrompt(baseTask, "");
    expect(result).toContain("**Title**: Add dark mode");
    expect(result).toContain("**Description**: Implement dark mode toggle");
    expect(result).toContain("**Acceptance Criteria**:");
    expect(result).toContain("Toggle switch exists");
  });

  test("includes comments when present", () => {
    const task = { ...baseTask, comments: [{ text: "Use CSS variables" }, { text: "Support system preference" }] };
    const result = createBuildReviewPrompt(task, "");
    expect(result).toContain("**Comments**:");
    expect(result).toContain("1. Use CSS variables");
    expect(result).toContain("2. Support system preference");
  });

  test("includes project notes when provided", () => {
    const result = createBuildReviewPrompt(baseTask, "We use Tailwind for styling");
    expect(result).toContain("**Project Notes**:");
    expect(result).toContain("We use Tailwind for styling");
  });

  test("omits empty description", () => {
    const task = { ...baseTask, description: "" };
    const result = createBuildReviewPrompt(task, "");
    expect(result).not.toContain("**Description**:");
  });

  test("includes git diff instruction", () => {
    const result = createBuildReviewPrompt(baseTask, "");
    expect(result).toContain("git diff");
  });

  test("does not include ticket context when task is null", () => {
    const result = createBuildReviewPrompt(null, "");
    expect(result).not.toContain("**Title**:");
    expect(result).not.toContain("**Acceptance Criteria**:");
  });

  test("includes project notes even when task is null", () => {
    const result = createBuildReviewPrompt(null, "We use Tailwind for styling");
    expect(result).toContain("**Project Notes**:");
    expect(result).toContain("We use Tailwind for styling");
  });

  test("uses the provided target branch", () => {
    const result = createBuildReviewPrompt(null, "", "develop");
    expect(result).toContain("git diff origin/develop...HEAD");
  });
});

// --- createBuildPrompt ---

describe("createBuildPrompt", () => {
  const baseTask = {
    title: "Add dark mode",
    description: "Implement dark mode toggle",
    acceptanceCriteria: "- Toggle switch exists\n- Theme persists",
    comments: [] as Array<{ text: string }>,
    images: [],
  };

  test("returns fallback when task is null", () => {
    const result = createBuildPrompt(null, "");
    expect(result).toBe("Build the feature as described.");
  });

  test("includes title and description", () => {
    const result = createBuildPrompt(baseTask, "");
    expect(result).toContain("**Title**: Add dark mode");
    expect(result).toContain("**Description**: Implement dark mode toggle");
  });

  test("includes acceptance criteria", () => {
    const result = createBuildPrompt(baseTask, "");
    expect(result).toContain("**Acceptance Criteria**:");
    expect(result).toContain("Toggle switch exists");
  });

  test("includes comments when present", () => {
    const task = { ...baseTask, comments: [{ text: "Use CSS variables" }, { text: "Support system preference" }] };
    const result = createBuildPrompt(task, "");
    expect(result).toContain("**Comments**:");
    expect(result).toContain("1. Use CSS variables");
    expect(result).toContain("2. Support system preference");
  });

  test("includes project notes when provided", () => {
    const result = createBuildPrompt(baseTask, "We use Tailwind for styling");
    expect(result).toContain("**Project Notes**:");
    expect(result).toContain("We use Tailwind for styling");
  });

  test("omits empty description", () => {
    const task = { ...baseTask, description: "" };
    const result = createBuildPrompt(task, "");
    expect(result).not.toContain("**Description**:");
  });

  test("ends with instruction to build without questions", () => {
    const result = createBuildPrompt(baseTask, "");
    expect(result).toContain("Do not ask any questions");
  });
});

// --- createVerificationPrompt ---

describe("createVerificationPrompt", () => {
  const baseTask = {
    title: "Add search",
    description: "Full-text search",
    acceptanceCriteria: "- Search box visible\n- Results load in <1s",
    comments: [] as Array<{ text: string }>,
    images: [],
  };

  test("returns fallback when task is null", () => {
    const result = createVerificationPrompt(null, "");
    expect(result).toContain("acceptance criteria");
  });

  test("asks for JSON response format", () => {
    const result = createVerificationPrompt(baseTask, "");
    expect(result).toContain('"complete"');
    expect(result).toContain('"rationale"');
    expect(result).toContain("JSON");
  });

  test("includes ticket context", () => {
    const result = createVerificationPrompt(baseTask, "");
    expect(result).toContain("**Title**: Add search");
    expect(result).toContain("Search box visible");
  });

  test("defaults to main as target branch", () => {
    const result = createVerificationPrompt(baseTask, "");
    expect(result).toContain("target branch `main`");
    expect(result).toContain("git diff origin/main...HEAD");
  });

  test("uses custom target branch when provided", () => {
    const result = createVerificationPrompt(baseTask, "", "develop");
    expect(result).toContain("target branch `develop`");
    expect(result).toContain("git diff origin/develop...HEAD");
  });

  test("includes instruction to identify current branch", () => {
    const result = createVerificationPrompt(baseTask, "");
    expect(result).toContain("git branch --show-current");
  });
});

// --- createFixPrompt ---

describe("createFixPrompt", () => {
  const baseTask = {
    title: "Fix login",
    description: "Login page broken",
    acceptanceCriteria: "- Login works with email\n- Error shown on bad password",
    comments: [] as Array<{ text: string }>,
    images: [],
  };

  test("returns fallback with feedback when task is null", () => {
    const result = createFixPrompt(null, "", "Missing error messages");
    expect(result).toContain("Missing error messages");
    expect(result).toContain("Do not ask any questions");
  });

  test("includes ticket context and failure reason", () => {
    const result = createFixPrompt(baseTask, "", "Error message not displayed on invalid password");
    expect(result).toContain("**Title**: Fix login");
    expect(result).toContain("NOT been fully satisfied");
    expect(result).toContain("Error message not displayed on invalid password");
  });

  test("includes project notes", () => {
    const result = createFixPrompt(baseTask, "Auth uses JWT tokens", "Session not persisted");
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
      taskSnapshot: { title: "My Feature", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
    expect(pipeline!.taskSnapshot).toEqual({ title: "My Feature", description: "", acceptanceCriteria: "", comments: [], images: [] });
  });

  test("createPipeline stores populated taskSnapshot", () => {
    const store = useBuildPipelineStore.getState();
    const snapshot = {
      title: "Dark Mode",
      description: "Add a dark mode toggle to the settings page",
      acceptanceCriteria: "- Toggle exists\n- Theme persists across sessions",
      comments: [{ text: "Use CSS variables" }, { text: "Support system preference" }],
      images: [],
    };
    const id = store.createPipeline({
      taskId: "task-2",
      projectId: "proj-2",
      environmentType: "local",
      taskTitle: "Dark Mode",
      taskSnapshot: snapshot,
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(id)!;
    expect(pipeline.taskSnapshot).toEqual(snapshot);
    expect(pipeline.taskSnapshot.comments).toHaveLength(2);
    expect(pipeline.taskSnapshot.comments[0]?.text).toBe("Use CSS variables");
  });

  test("setPipelineEnvironment links environment", () => {
    const store = useBuildPipelineStore.getState();
    const id = store.createPipeline({
      taskId: "t1",
      projectId: "p1",
      environmentType: "containerized",
      taskTitle: "Test",
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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
      taskSnapshot: { title: "Test", description: "", acceptanceCriteria: "", comments: [], images: [] },
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

// --- isSetupPending ---

describe("isSetupPending", () => {
  const defaults = {
    isLocal: true,
    setupCommandsResolved: true,
    hasPendingSetupCommands: false,
    setupScriptsRunning: false,
    workspaceReady: true,
  };

  // --- Local environment ---

  test("local: returns false when setup commands resolved, none pending, none running", () => {
    expect(isSetupPending({ ...defaults, isLocal: true })).toBe(false);
  });

  test("local: returns true when setup commands not yet resolved", () => {
    expect(isSetupPending({ ...defaults, isLocal: true, setupCommandsResolved: false })).toBe(true);
  });

  test("local: returns true when setup commands are pending", () => {
    expect(isSetupPending({ ...defaults, isLocal: true, hasPendingSetupCommands: true })).toBe(true);
  });

  test("local: returns true when setup scripts are still running", () => {
    expect(isSetupPending({ ...defaults, isLocal: true, setupScriptsRunning: true })).toBe(true);
  });

  test("local: ignores workspaceReady flag", () => {
    // Even if workspaceReady is false, local envs only care about setup commands
    expect(isSetupPending({ ...defaults, isLocal: true, workspaceReady: false })).toBe(false);
  });

  // --- Container environment ---

  test("container: returns false when workspace is ready", () => {
    expect(isSetupPending({ ...defaults, isLocal: false, workspaceReady: true })).toBe(false);
  });

  test("container: returns true when workspace is not ready", () => {
    expect(isSetupPending({ ...defaults, isLocal: false, workspaceReady: false })).toBe(true);
  });

  test("container: ignores local setup command flags", () => {
    // Even if local setup flags indicate pending, container only cares about workspaceReady
    expect(isSetupPending({
      isLocal: false,
      setupCommandsResolved: false,
      hasPendingSetupCommands: true,
      setupScriptsRunning: true,
      workspaceReady: true,
    })).toBe(false);
  });
});

// --- waitForSetupInitiation ---

describe("waitForSetupInitiation", () => {
  const envId = "test-env-id";

  beforeEach(() => {
    // Reset environment store setup state
    const store = useEnvironmentStore.getState();
    store.setSetupCommandsResolved(envId, false);
    store.setSetupScriptsRunning(envId, false);
    // Clear any pending setup commands
    store.consumePendingSetupCommands(envId);
  });

  test("returns immediately for container environments", async () => {
    const start = Date.now();
    await waitForSetupInitiation(envId, "containerized");
    expect(Date.now() - start).toBeLessThan(100);
  });

  test("returns when setupScriptsRunning is true (scripts started)", async () => {
    // Simulate TerminalContainer consuming commands and starting scripts
    useEnvironmentStore.getState().setSetupScriptsRunning(envId, true);

    const start = Date.now();
    await waitForSetupInitiation(envId, "local");
    expect(Date.now() - start).toBeLessThan(100);
  });

  test("returns when resolved and no pending commands (no setup scripts)", async () => {
    // Simulate startEnvironment completing with no setup commands
    useEnvironmentStore.getState().setSetupCommandsResolved(envId, true);
    // No pending commands (consumed or never set)

    const start = Date.now();
    await waitForSetupInitiation(envId, "local");
    expect(Date.now() - start).toBeLessThan(100);
  });

  test("waits when commands are pending and not yet consumed", async () => {
    // Simulate startEnvironment storing commands but TerminalContainer hasn't consumed yet
    useEnvironmentStore.getState().setPendingSetupCommands(envId, ["bun install"]);
    useEnvironmentStore.getState().setSetupCommandsResolved(envId, true);

    // After a delay, simulate TerminalContainer consuming commands and starting scripts
    setTimeout(() => {
      useEnvironmentStore.getState().consumePendingSetupCommands(envId);
      useEnvironmentStore.getState().setSetupScriptsRunning(envId, true);
    }, 100);

    const start = Date.now();
    await waitForSetupInitiation(envId, "local");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80); // Waited for the setTimeout
    expect(elapsed).toBeLessThan(500); // But didn't timeout
  });

  test("waits when setup commands not yet resolved", async () => {
    // Simulate startEnvironment hasn't completed yet (awaiting tauri)
    useEnvironmentStore.getState().setPendingSetupCommands(envId, []);

    // After a delay, resolve with no commands
    setTimeout(() => {
      useEnvironmentStore.getState().consumePendingSetupCommands(envId);
      useEnvironmentStore.getState().setSetupCommandsResolved(envId, true);
    }, 100);

    const start = Date.now();
    await waitForSetupInitiation(envId, "local");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(500);
  });

  test("resolves after timeout when setup never initiates", async () => {
    // Nothing will resolve — simulate a stuck state
    useEnvironmentStore.getState().setPendingSetupCommands(envId, ["bun install"]);
    // resolved stays false, running stays false, pending stays true

    const start = Date.now();
    await waitForSetupInitiation(envId, "local", { maxWaitMs: 200, pollMs: 20 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(500);
  });
});
