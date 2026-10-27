import { describe, expect, test } from "bun:test";
import type { HookCallbackMatcher, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSnapshot } from "../types/index.js";
import {
  persistedBackgroundTaskMessage,
  reducePersistedBackgroundTaskMessage,
} from "./session-manager-messages.js";
import {
  createSession,
  createPromptTurnForTesting,
  getSession,
  inspectDuringTurn,
  nextQueryCall,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";

import {
  handleTaskEdge,
  handleBackgroundTasksChanged,
} from "./session-manager-prompt-handlers/system-tasks.js";
import {
  recordBackgroundTaskLaunch,
  recordShellCommand,
  recordShellResult,
} from "./session-manager-background-tasks.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type Hooks = Partial<Record<string, HookCallbackMatcher[]>>;

function shellHook(hooks: Hooks, event: string) {
  const matcher = hooks[event]?.find((candidate) => candidate.matcher === "^Bash$");
  expect(matcher).toBeDefined();
  return (input: Record<string, unknown>) =>
    matcher!.hooks[0]!({ hook_event_name: event, ...input } as unknown as HookInput, undefined, {
      signal: new AbortController().signal,
    });
}

describe("background task metadata", () => {
  test("records what each task message says beyond its lifecycle", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "system",
          subtype: "task_started",
          task_id: "agent-1",
          tool_use_id: "toolu-agent",
          description: "Audit docs",
          task_type: "local_agent",
          prompt: "Audit every doc in docs/",
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "shell-1",
          tool_use_id: "toolu-shell",
          description: "Run tests",
          task_type: "local_bash",
          parent_task_id: "agent-1",
        },
        {
          type: "system",
          subtype: "task_progress",
          task_id: "agent-1",
          description: "Audit docs",
          usage: { total_tokens: 10, tool_uses: 2, duration_ms: 5 },
          last_tool_name: "Grep",
          summary: "Checking links in the architecture docs",
        },
        {
          type: "system",
          subtype: "task_updated",
          task_id: "agent-1",
          patch: { status: "paused", total_paused_ms: 1500 },
        },
        {
          type: "system",
          subtype: "task_started",
          task_id: "flow-1",
          task_type: "local_workflow",
          workflow_name: "spec",
          skip_transcript: true,
        },
        {
          type: "system",
          subtype: "task_notification",
          task_id: "shell-1",
          status: "stopped",
          reason: "worker_restart",
          summary: "Stopped",
          output_file: "/tmp/shell-1.output",
        },
      ],
      (s) => s.backgroundTasks?.["shell-1"]?.status === "killed",
    );

    expect(session.backgroundTasks?.["agent-1"]).toMatchObject({
      taskType: "local_agent",
      prompt: "Audit every doc in docs/",
      lastToolName: "Grep",
      progressSummary: "Checking links in the architecture docs",
      pausedMs: 1500,
      status: "paused",
    });
    expect(session.backgroundTasks?.["shell-1"]).toMatchObject({
      taskType: "local_bash",
      parentTaskId: "agent-1",
      endReason: "worker_restart",
    });
    expect(session.backgroundTasks?.["flow-1"]).toMatchObject({
      taskType: "local_workflow",
      workflowName: "spec",
      ambient: true,
    });
    await finish();
  });

  test("reads a level's task kind and parent", async () => {
    const { session, finish } = await inspectDuringTurn(
      [
        {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            {
              task_id: "shell-2",
              task_type: "local_bash",
              description: "Watch",
              parent_task_id: "agent-2",
              ambient: true,
            },
          ],
        },
      ],
      (s) => s.backgroundTasks?.["shell-2"] !== undefined,
    );
    expect(session.backgroundTasks?.["shell-2"]).toMatchObject({
      taskType: "local_bash",
      parentTaskId: "agent-2",
      ambient: true,
    });
    await finish();
  });

  for (const cleared of [{ ambient: false }, {}, { ambient: false, parent_task_id: 42 }]) {
    test(`replacement clears classification and parent: ${JSON.stringify(cleared)}`, () => {
      const created = createSession("Replacement");
      track(created.id);
      const session = getSession(created.id)!;
      const { turn } = createPromptTurnForTesting(session);
      turn.queryIteratorControl = {} as NonNullable<typeof session.queryControl>;
      session.backgroundTasks = {
        parent: { id: "parent", status: "completed" },
        child: { id: "child", status: "running", ambient: true, parentTaskId: "parent" },
      };
      handleBackgroundTasksChanged(turn, {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "child", ...cleared }],
      } as unknown as SDKMessage);
      expect(session.backgroundTasks.child?.ambient).toBe(false);
      expect(session.backgroundTasks.child?.parentTaskId).toBeUndefined();
      expect(session.backgroundTasks.parent?.status).toBe("completed");
      // Sparse edges still carry the authoritative classification forward.
      handleTaskEdge(turn, {
        type: "system",
        subtype: "task_progress",
        task_id: "child",
      } as SDKMessage);
      expect(session.backgroundTasks.child?.ambient).toBe(false);
    });
  }

  test("replacement accepts the skip_transcript alias", () => {
    const created = createSession("Ambient alias");
    track(created.id);
    const session = getSession(created.id)!;
    const { turn } = createPromptTurnForTesting(session);
    turn.queryIteratorControl = {} as NonNullable<typeof session.queryControl>;
    handleBackgroundTasksChanged(turn, {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "watch", skip_transcript: true }],
    } as unknown as SDKMessage);
    expect(session.backgroundTasks?.watch?.ambient).toBe(true);
  });

  for (const failure of [false, true]) {
    test(`retains ${failure ? "failed" : "successful"} result hooks before registration`, async () => {
      const created = createSession("Unordered hooks");
      track(created.id);
      const prompt = sendPrompt(created.id, "delegate");
      const call = await nextQueryCall();
      const hooks = call.options.hooks as Hooks;
      const session = getSession(created.id)!;
      await shellHook(
        hooks,
        "PreToolUse",
      )({ tool_name: "Bash", tool_use_id: "early", tool_input: { command: "bun test" } });
      await shellHook(
        hooks,
        failure ? "PostToolUseFailure" : "PostToolUse",
      )({
        tool_name: "Bash",
        tool_use_id: "early",
        error: "cancelled\npartial output",
        is_interrupt: true,
        tool_response: { stdout: "stdout", stderr: "stderr" },
      });
      expect(session.shellCommands?.has("early")).toBe(true);
      // The level carries no tool id; only the later edge can correlate it.
      call.push({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "early-task", task_type: "local_bash" }],
      });
      await waitFor(() => session.backgroundTasks?.["early-task"] !== undefined);
      expect(session.backgroundTasks?.["early-task"]?.command).toBeUndefined();
      call.push({
        type: "system",
        subtype: "task_started",
        task_id: "early-task",
        tool_use_id: "early",
      });
      await waitFor(() => session.backgroundTasks?.["early-task"]?.command !== undefined);
      expect(session.backgroundTasks?.["early-task"]).toMatchObject({
        command: "bun test",
        outputTail: failure ? "cancelled\npartial output" : "stdout\nstderr",
      });
      expect(session.backgroundTasks?.["early-task"]?.error).toBe(
        failure ? "Interrupted" : undefined,
      );
      expect(session.shellCommands?.has("early")).toBe(false);
      call.finish();
      await prompt;
    });
  }

  test("successful result after registration joins stdout and stderr and consumes the command", async () => {
    const created = createSession("Successful shell");
    track(created.id);
    const prompt = sendPrompt(created.id, "delegate");
    const call = await nextQueryCall();
    const session = getSession(created.id)!;
    const hooks = call.options.hooks as Hooks;
    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "success",
      tool_use_id: "success-tool",
    });
    await waitFor(() => session.backgroundTasks?.success !== undefined);
    await shellHook(
      hooks,
      "PreToolUse",
    )({ tool_name: "Bash", tool_use_id: "success-tool", tool_input: { command: "echo ok" } });
    await shellHook(
      hooks,
      "PostToolUse",
    )({
      tool_name: "Bash",
      tool_use_id: "success-tool",
      tool_response: { stdout: "ok", stderr: "warning" },
    });
    expect(session.backgroundTasks?.success).toMatchObject({
      command: "echo ok",
      outputTail: "ok\nwarning",
    });
    expect(session.backgroundTasks?.success?.error).toBeUndefined();
    expect(session.shellCommands?.has("success-tool")).toBe(false);
    call.finish();
    await prompt;
  });

  test("bounds pending calls and strips controls before truncating command and output", async () => {
    const created = createSession("Bounds");
    track(created.id);
    const session = getSession(created.id)!;
    for (let i = 0; i < 257; i++) {
      await recordShellCommand(session, `call-${i}`, "echo ok");
      await recordShellResult(session, `call-${i}`, { output: "done" });
    }
    expect(session.shellCommands?.size).toBe(256);
    expect(session.shellCommands?.has("call-0")).toBe(false);
    expect(session.shellCommands?.has("call-256")).toBe(true);
    await recordShellCommand(session, "bounded", "\u0000" + "x".repeat(4100) + "END");
    await recordShellResult(session, "bounded", {
      output: "HEAD" + "y".repeat(2100) + "\u0007\u007f\tEND",
    });
    session.backgroundTasks = {
      bounded: { id: "bounded", status: "running", toolUseId: "bounded" },
    };
    // Another hook can attach a cached completed result after an edge.
    await recordShellCommand(session, "bounded", "\u0000" + "x".repeat(4100) + "END");
    expect(session.backgroundTasks.bounded?.command).toBe("x".repeat(4000) + "…");
    expect(session.backgroundTasks.bounded?.outputTail).toBe("…" + "y".repeat(1996) + "\tEND");
    expect(session.shellCommands?.has("bounded")).toBe(false);
  });

  for (const hookRestart of [false, true]) {
    test(`${hookRestart ? "hook" : "SendMessage"} resume clears run metadata`, () => {
      const created = createSession("Resume");
      track(created.id);
      const session = getSession(created.id)!;
      const { turn } = createPromptTurnForTesting(session);
      turn.queryIteratorControl = {} as NonNullable<typeof session.queryControl>;
      session.backgroundTasks = {
        agent: {
          id: "agent",
          status: "completed",
          toolUseId: "old",
          startedAt: 1,
          endedAt: 2,
          taskType: "local_agent",
          prompt: "Review",
          outputTail: "old output",
          lastToolName: "Read",
          progressSummary: "Old progress",
          pausedMs: 500,
          endReason: "worker_restart",
          error: "old error",
          summary: "old summary",
        },
      };
      if (hookRestart)
        // No CLI runs in this unit, so nothing owns the run.
        recordBackgroundTaskLaunch(session, { id: "agent" }, undefined, { newRun: true });
      else
        handleTaskEdge(turn, {
          type: "system",
          subtype: "task_started",
          task_id: "agent",
          tool_use_id: "new",
        } as SDKMessage);
      const task = session.backgroundTasks.agent!;
      expect(task).toMatchObject({ status: "running", taskType: "local_agent", prompt: "Review" });
      expect(task.startedAt).toBeGreaterThan(2);
      for (const key of [
        "outputTail",
        "lastToolName",
        "progressSummary",
        "pausedMs",
        "endReason",
        "error",
        "summary",
        "endedAt",
      ] as const)
        expect(task[key]).toBeUndefined();
    });
  }

  test("captures a shell task's command and how it ended from the Bash hooks", async () => {
    const created = createSession("Shell hooks");
    track(created.id);
    const prompt = sendPrompt(created.id, "delegate");
    const call = await nextQueryCall();
    const hooks = call.options.hooks as Hooks;
    const session = getSession(created.id)!;

    // A background subagent's call: the only place its command is named.
    await shellHook(
      hooks,
      "PreToolUse",
    )({
      tool_name: "Bash",
      tool_input: { command: "bun test --watch=false" },
      tool_use_id: "toolu-sub-bash",
      agent_id: "agent-3",
    });
    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "shell-3",
      tool_use_id: "toolu-sub-bash",
      description: "Run the suite",
      task_type: "local_bash",
      parent_task_id: "agent-3",
    });
    await waitFor(() => session.backgroundTasks?.["shell-3"] !== undefined);
    expect(session.backgroundTasks?.["shell-3"]?.command).toBe("bun test --watch=false");

    await shellHook(
      hooks,
      "PostToolUseFailure",
    )({
      tool_name: "Bash",
      tool_input: { command: "bun test --watch=false" },
      tool_use_id: "toolu-sub-bash",
      error: "Exit code 1\n3 pass\n1 fail",
    });
    expect(session.backgroundTasks?.["shell-3"]).toMatchObject({
      error: "Exit code 1",
      outputTail: "3 pass\n1 fail",
    });
    expect(session.shellCommands?.has("toolu-sub-bash")).toBe(false);

    call.finish();
    await prompt;
  });

  test("attaches a command whose hook lands after the task edge, and skips a backgrounded result", async () => {
    const created = createSession("Shell hooks late");
    track(created.id);
    const prompt = sendPrompt(created.id, "delegate");
    const call = await nextQueryCall();
    const hooks = call.options.hooks as Hooks;
    const session = getSession(created.id)!;

    call.push({
      type: "system",
      subtype: "task_started",
      task_id: "shell-4",
      tool_use_id: "toolu-late",
      description: "Serve",
      task_type: "local_bash",
    });
    await waitFor(() => session.backgroundTasks?.["shell-4"] !== undefined);
    await shellHook(
      hooks,
      "PreToolUse",
    )({
      tool_name: "Bash",
      tool_input: { command: "bun run dev" },
      tool_use_id: "toolu-late",
    });
    expect(session.backgroundTasks?.["shell-4"]?.command).toBe("bun run dev");

    await shellHook(
      hooks,
      "PostToolUse",
    )({
      tool_name: "Bash",
      tool_input: { command: "bun run dev" },
      tool_use_id: "toolu-late",
      tool_response: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "shell-4" },
    });
    expect(session.backgroundTasks?.["shell-4"]?.outputTail).toBeUndefined();
    expect(session.shellCommands?.has("toolu-late")).toBe(true);

    call.finish();
    await prompt;
  });

  test("replay keeps metadata and a resumed run drops the previous run's", () => {
    let tasks: Record<string, BackgroundTaskSnapshot> | undefined;
    const frames = [
      {
        subtype: "task_started",
        task_id: "agent-5",
        tool_use_id: "toolu-first",
        task_type: "local_agent",
        parent_task_id: "agent-0",
        prompt: "First run",
      },
      {
        subtype: "task_progress",
        task_id: "agent-5",
        last_tool_name: "Read",
        summary: "Reading",
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      },
      { subtype: "task_notification", task_id: "agent-5", status: "completed", summary: "Done" },
    ];
    for (const frame of frames) {
      const message = persistedBackgroundTaskMessage({ message: frame });
      if (message) tasks = reducePersistedBackgroundTaskMessage(tasks, message, Date.now());
    }
    expect(tasks?.["agent-5"]).toMatchObject({
      status: "completed",
      taskType: "local_agent",
      parentTaskId: "agent-0",
      prompt: "First run",
      lastToolName: "Read",
      progressSummary: "Reading",
    });

    const resumed = persistedBackgroundTaskMessage({
      message: {
        subtype: "task_started",
        task_id: "agent-5",
        tool_use_id: "toolu-resume",
        prompt: "Second run",
      },
    })!;
    tasks = reducePersistedBackgroundTaskMessage(tasks, resumed, Date.now());
    expect(tasks["agent-5"]).toMatchObject({
      status: "running",
      taskType: "local_agent",
      parentTaskId: "agent-0",
      prompt: "Second run",
    });
    expect(tasks["agent-5"]?.lastToolName).toBeUndefined();
    expect(tasks["agent-5"]?.progressSummary).toBeUndefined();
  });

  test("drops malformed metadata rather than publishing it", () => {
    const message = persistedBackgroundTaskMessage({
      message: {
        subtype: "task_started",
        task_id: "bad",
        task_type: "local\nbash",
        parent_task_id: 42,
        last_tool_name: "x".repeat(300),
        reason: "something_else",
        patch: { total_paused_ms: -5 },
      },
    })!;
    const tasks = reducePersistedBackgroundTaskMessage(undefined, message, Date.now());
    expect(tasks.bad?.taskType).toBeUndefined();
    expect(tasks.bad?.parentTaskId).toBeUndefined();
    expect(tasks.bad?.lastToolName).toBeUndefined();
    expect(tasks.bad?.endReason).toBeUndefined();
    expect(tasks.bad?.pausedMs).toBeUndefined();
  });
});
