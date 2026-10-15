import { describe, expect, test } from "bun:test";
import type { HookCallbackMatcher, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSnapshot } from "../types/index.js";
import {
  persistedBackgroundTaskMessage,
  reducePersistedBackgroundTaskMessage,
} from "./session-manager-messages.js";
import {
  createSession,
  getSession,
  inspectDuringTurn,
  nextQueryCall,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";

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
