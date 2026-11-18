import { describe, expect, test } from "bun:test";
import capturedWorkflow from "../../test-fixtures/workflow-claude-2.1.326.json";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSnapshot } from "../types/index.js";
import {
  MAX_WORKFLOW_AGENTS,
  WORKFLOW_SUBAGENT_TYPE,
  parseWorkflowProgress,
} from "./background-task-workflow.js";
import { readPersistedSessionMessages } from "./session-manager-persistence.js";
import { backgroundTasksForSnapshot } from "./background-task-snapshot.js";
import { stopBackgroundTask } from "./session-manager-background-tasks.js";
import {
  persistedBackgroundTaskMessage,
  reducePersistedBackgroundTaskMessage,
} from "./session-manager-messages.js";
import {
  handleTaskEdge,
  handleTaskNotification,
} from "./session-manager-prompt-handlers/system-tasks.js";
import {
  createPromptTurnForTesting,
  createSession,
  getSession,
  materializePersistedSession,
  mockSdkGetSessionMessages,
  queryControlOverrides,
  settleSessionPreferenceWritesForTesting,
  type SdkSessionMessage,
  nextQueryCall,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";

// Frames shaped as Claude Code 2.1.326 emits them for a `Workflow` call.
const started = {
  type: "system",
  subtype: "task_started",
  task_id: "wf-1",
  tool_use_id: "toolu-workflow",
  description: "Build investor Discover, Saved and Introductions",
  task_type: "local_workflow",
  workflow_name: "build-discover",
};

function agentRow(index: number, fields: Record<string, unknown> = {}) {
  return {
    type: "workflow_agent",
    index,
    label: `Build: area ${index}`,
    phaseIndex: 1,
    phaseTitle: "Build",
    agentId: `agent-${index}`,
    state: "progress",
    startedAt: 1_000 + index,
    tokens: 100 * index,
    toolCalls: index,
    lastToolName: "Edit",
    lastToolSummary: `Editing src/area-${index}.ts`,
    promptPreview: "never kept",
    ...fields,
  };
}

/** A workflow progress frame: the latest agent in `description`, its label as the "tool". */
function progress(rows: unknown[] | undefined, latest = "Build: introductions") {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: "wf-1",
    tool_use_id: "toolu-workflow",
    description: latest,
    last_tool_name: latest.replace(/^Build: /, ""),
    usage: { total_tokens: 541_000, tool_uses: 153, duration_ms: 60_000 },
    ...(rows ? { workflow_progress: rows } : {}),
  };
}

function liveTurn(name: string) {
  const created = createSession(name);
  track(created.id);
  const session = getSession(created.id)!;
  const { turn } = createPromptTurnForTesting(session);
  turn.queryIteratorControl = {} as NonNullable<typeof session.queryControl>;
  return { session, turn };
}

function replay(frames: unknown[]): Record<string, BackgroundTaskSnapshot> | undefined {
  let tasks: Record<string, BackgroundTaskSnapshot> | undefined;
  let clock = 1_000;
  for (const frame of frames) {
    const message = persistedBackgroundTaskMessage({ message: frame });
    if (message) tasks = reducePersistedBackgroundTaskMessage(tasks, message, (clock += 10));
  }
  return tasks;
}

describe("workflow progress rows", () => {
  test("keeps agent rows, newest state per index, without prompt previews", () => {
    const parsed = parseWorkflowProgress([
      { type: "workflow_phase", index: 1, title: "Build" },
      { type: "workflow_log", message: "starting" },
      agentRow(2, { state: "start", startedAt: undefined }),
      agentRow(1, { state: "done", durationMs: 4_000 }),
      agentRow(2),
      { type: "workflow_agent", index: -1, label: "bad", state: "progress" },
      { type: "workflow_agent", index: 3, label: "bad", state: "exploded" },
      "not a row",
    ]);
    expect(parsed?.omitted).toBe(0);
    expect(parsed?.agents.map((agent) => [agent.index, agent.state])).toEqual([
      [1, "done"],
      [2, "progress"],
    ]);
    expect(parsed?.agents[1]).toEqual({
      index: 2,
      label: "Build: area 2",
      state: "progress",
      phaseTitle: "Build",
      agentId: "agent-2",
      lastToolName: "Edit",
      lastToolSummary: "Editing src/area-2.ts",
      tokens: 200,
      toolCalls: 2,
      startedAt: 1_002,
    });
    expect(parseWorkflowProgress(undefined)).toBeUndefined();
    expect(parseWorkflowProgress([])).toMatchObject({ agents: [], omitted: 0 });
  });

  test("keeps running and failed rows ahead of queued agents and counts the full list", () => {
    const queued = Array.from({ length: MAX_WORKFLOW_AGENTS }, (_, index) =>
      agentRow(index + 2, { state: "start", startedAt: undefined }),
    );
    const rows = [agentRow(0, { state: "error" }), agentRow(1), ...queued];
    const parsed = parseWorkflowProgress(rows)!;
    expect(parsed.agents).toHaveLength(MAX_WORKFLOW_AGENTS);
    expect(parsed.omitted).toBe(2);
    const indexes = parsed.agents.map((agent) => agent.index);
    expect(indexes.slice(0, 2)).toEqual([0, 1]);
    expect(indexes.at(-1)).toBe(MAX_WORKFLOW_AGENTS + 1);
    expect(indexes).not.toContain(2);
    expect(parsed.counts).toEqual({ total: 66, running: 1, queued: 64, finished: 1, failed: 1 });
    expect(parseWorkflowProgress(rows, 3)).toMatchObject({ omitted: 5, counts: { partial: true } });
  });

  test("counts user skips as finished without giving them failure priority", () => {
    const skipped = Array.from({ length: MAX_WORKFLOW_AGENTS }, (_, index) =>
      agentRow(index + 1, { state: "error", skipped: true, error: "skipped by user" }),
    );
    const parsed = parseWorkflowProgress([agentRow(0, { state: "error" }), ...skipped])!;
    expect(parsed.agents).toHaveLength(MAX_WORKFLOW_AGENTS);
    expect(parsed.agents[0]).toMatchObject({ index: 0, state: "error" });
    expect(parsed.agents[1]).toMatchObject({ index: 2, state: "error", skipped: true });
    expect(parsed.counts).toEqual({ total: 65, running: 0, queued: 0, finished: 65, failed: 1 });
  });
});

function applyLiveFrames(
  turn: ReturnType<typeof liveTurn>["turn"],
  frames: Array<{ subtype: string }>,
) {
  for (const frame of frames) {
    const accept = frame.subtype === "task_notification" ? handleTaskNotification : handleTaskEdge;
    accept(turn, frame as unknown as SDKMessage);
  }
}

describe("workflow task edges", () => {
  test("live and replayed workflow progress use the captured latest agent description", () => {
    const frames = capturedWorkflow.systemFrames.filter(
      ({ subtype }) => subtype === "task_started" || subtype === "task_progress",
    );
    const taskId = frames[0]!.task_id;
    const { session, turn } = liveTurn("Captured workflow progress");
    applyLiveFrames(turn, frames);

    const liveTask = backgroundTasksForSnapshot(session.backgroundTasks)[taskId];
    const replayedTask = replay(frames)?.[taskId];
    for (const task of [liveTask, replayedTask]) {
      expect(task).toMatchObject({
        description: "Inspect the fixture",
        progressSummary: "Inspect: Review",
        workflowAgentCounts: { total: 1 },
      });
    }
  });

  test("live progress keeps the workflow's name and reads its agents", () => {
    const { session, turn } = liveTurn("Workflow live");
    handleTaskEdge(turn, started as unknown as SDKMessage);
    handleTaskEdge(turn, progress([agentRow(1), agentRow(2)]) as unknown as SDKMessage);
    // A throttled frame carries no list; the last one stands.
    handleTaskEdge(turn, progress(undefined, "Build: saved") as unknown as SDKMessage);
    // A frame with just the launch summary leaves the latest agent in place.
    handleTaskEdge(turn, {
      ...progress(undefined),
      description: undefined,
      summary: started.description,
    } as unknown as SDKMessage);

    const task = session.backgroundTasks?.["wf-1"];
    expect(task?.description).toBe(started.description);
    expect(task?.progressSummary).toBe("Build: saved");
    expect(task?.lastToolName).toBeUndefined();
    expect(task?.workflowName).toBe("build-discover");
    expect(task?.usage).toEqual({ totalTokens: 541_000, toolUses: 153, durationMs: 60_000 });
    expect(task?.workflowAgents?.map((agent) => agent.agentId)).toEqual(["agent-1", "agent-2"]);

    handleTaskNotification(turn, {
      type: "system",
      subtype: "task_notification",
      task_id: "wf-1",
      tool_use_id: "toolu-workflow",
      status: "completed",
      summary: "Built all three pages",
      output_file: "/tmp/wf-1.output",
      workflow_progress: [agentRow(1, { state: "done" }), agentRow(2, { state: "done" })],
    } as unknown as SDKMessage);
    const settled = session.backgroundTasks?.["wf-1"];
    expect(settled?.status).toBe("completed");
    expect(settled?.description).toBe(started.description);
    expect(settled?.workflowAgents?.map((agent) => agent.state)).toEqual(["done", "done"]);
  });

  test("heartbeats update agent counts without replacing the latest agent with the title", () => {
    const frames = [
      started,
      progress([agentRow(1)], "Build: saved"),
      {
        ...progress([agentRow(1, { state: "done" }), agentRow(2)]),
        description: started.description,
        last_tool_name: undefined,
      },
    ];
    const { session, turn } = liveTurn("Workflow heartbeat");
    applyLiveFrames(turn, frames);
    for (const task of [session.backgroundTasks?.["wf-1"], replay(frames)?.["wf-1"]]) {
      expect(task).toMatchObject({
        description: started.description,
        progressSummary: "Build: saved",
        workflowAgentCounts: { total: 2, finished: 1, running: 1 },
      });
    }
  });

  test("an ordinary agent's progress still names its tool", () => {
    const { session, turn } = liveTurn("Agent live");
    handleTaskEdge(turn, {
      ...started,
      task_id: "agent-1",
      task_type: "local_agent",
      workflow_name: undefined,
    } as unknown as SDKMessage);
    handleTaskEdge(turn, {
      type: "system",
      subtype: "task_progress",
      task_id: "agent-1",
      description: "Renamed by the provider",
      summary: "Searching for references",
      last_tool_name: "Grep",
    } as unknown as SDKMessage);
    expect(session.backgroundTasks?.["agent-1"]).toMatchObject({
      description: "Renamed by the provider",
      progressSummary: "Searching for references",
      lastToolName: "Grep",
    });
  });

  test("replay keeps the workflow's name and its last agent list", () => {
    const tasks = replay([
      started,
      progress([agentRow(1)]),
      progress([agentRow(1, { state: "done" }), agentRow(2)], "Build: saved"),
      progress(undefined, "Build: area 2"),
    ]);
    expect(tasks?.["wf-1"]).toMatchObject({
      description: started.description,
      progressSummary: "Build: area 2",
      taskType: "local_workflow",
    });
    expect(tasks?.["wf-1"]?.lastToolName).toBeUndefined();
    expect(tasks?.["wf-1"]?.workflowAgents?.map((agent) => agent.state)).toEqual([
      "done",
      "progress",
    ]);
  });

  test("a resumed workflow run starts without the previous run's agents", () => {
    const tasks = replay([
      started,
      progress([agentRow(1)]),
      { ...started, subtype: "task_notification", status: "stopped", summary: "Stopped" },
      { ...started, tool_use_id: "toolu-resume" },
    ]);
    expect(tasks?.["wf-1"]?.status).toBe("running");
    expect(tasks?.["wf-1"]?.workflowAgents).toBeUndefined();
  });

  for (const correlation of ["run id", "tool-use id"] as const) {
    test(`ignores the previous run after a same-id relaunch using ${correlation}`, () => {
      const firstRunId = correlation === "run id" ? "run-a" : undefined;
      const nextRunId = correlation === "run id" ? "run-b" : undefined;
      const nextTool = correlation === "run id" ? undefined : "toolu-resumed";
      const frames = [
        { ...started, run_id: firstRunId },
        { ...started, subtype: "task_notification", status: "stopped", run_id: firstRunId },
        { ...started, description: "New run", run_id: nextRunId, tool_use_id: nextTool },
        { ...progress([agentRow(2)]), run_id: nextRunId, tool_use_id: nextTool },
        { ...progress([agentRow(1)], "Old progress"), run_id: firstRunId },
        { ...started, subtype: "task_notification", status: "failed", run_id: firstRunId },
      ];
      const { session, turn } = liveTurn("Relaunched workflow");
      applyLiveFrames(turn, frames);
      for (const task of [session.backgroundTasks?.["wf-1"], replay(frames)?.["wf-1"]]) {
        expect(task).toMatchObject({
          status: "running",
          description: "New run",
          toolUseId: nextTool,
          workflowAgents: [expect.objectContaining({ index: 2 })],
        });
      }
    });
  }

  test.each(["running", "paused"] as const)(
    "a distinct same-id start replaces a %s workflow and fences off its late edges",
    (oldStatus) => {
      const useRunId = oldStatus === "running";
      const priorRun = {
        tool_use_id: started.tool_use_id,
        run_id: useRunId ? "run-a" : undefined,
      };
      const nextRun = {
        tool_use_id: useRunId ? priorRun.tool_use_id : "toolu-resume",
        run_id: useRunId ? "run-b" : undefined,
      };
      const restart = [
        { ...started, ...priorRun },
        { ...progress([agentRow(1)], "Old progress"), ...priorRun },
        { ...started, ...priorRun, subtype: "task_updated", patch: { status: oldStatus } },
        { ...started, ...nextRun, description: "New run" },
      ];
      const late = [
        { ...progress([agentRow(1)], "Old progress"), ...priorRun },
        { ...started, ...priorRun, subtype: "task_updated", patch: { status: "failed" } },
        { ...started, ...priorRun, subtype: "task_notification", status: "failed" },
      ];
      const { session, turn } = liveTurn("Workflow relaunched before settlement");
      applyLiveFrames(turn, [...restart, ...late]);
      for (const task of [
        session.backgroundTasks?.["wf-1"],
        replay([...restart, ...late])?.["wf-1"],
      ]) {
        expect(task).toMatchObject({
          status: "running",
          description: "New run",
          toolUseId: nextRun.tool_use_id,
        });
        expect(task?.progressSummary).toBeUndefined();
        expect(task?.workflowAgents).toBeUndefined();
      }
      const newProgress = { ...progress([agentRow(2)]), ...nextRun };
      applyLiveFrames(turn, [newProgress]);
      for (const task of [
        session.backgroundTasks?.["wf-1"],
        replay([...restart, ...late, newProgress])?.["wf-1"],
      ]) {
        expect(task?.workflowAgents?.map((agent) => agent.index)).toEqual([2]);
      }
    },
  );

  test("compact terminal rows keep stable labels and ignore later progress", () => {
    const frames = [
      started,
      progress([agentRow(1, { agentType: "Explore" }), agentRow(2)]),
      { ...started, subtype: "task_updated", patch: { status: "completed" } },
      {
        ...started,
        subtype: "task_notification",
        status: "completed",
        workflow_progress: [
          agentRow(1, { state: "done", phaseTitle: undefined, agentType: undefined, tokens: 0 }),
          agentRow(2, { state: "done", phaseTitle: undefined, phaseIndex: 2 }),
          { type: "workflow_phase", index: 2, title: "Verify" },
        ],
      },
    ];
    const { session, turn } = liveTurn("Compact workflow");
    applyLiveFrames(turn, frames);
    const expected = [
      expect.objectContaining({
        state: "done",
        phaseTitle: "Build",
        agentType: "Explore",
        tokens: 0,
      }),
      expect.objectContaining({ state: "done", phaseTitle: "Verify" }),
    ];
    expect(session.backgroundTasks?.["wf-1"]?.workflowAgents).toEqual(expected);
    const late = [progress([agentRow(1)]), progress(undefined)];
    applyLiveFrames(turn, late);
    expect(session.backgroundTasks?.["wf-1"]?.workflowAgents).toEqual(expected);
    expect(replay([...frames, ...late])?.["wf-1"]?.workflowAgents).toEqual(expected);
  });

  test("hydrates a real Claude 2.1.326 rollout and the agent rows its SDK emitted", async () => {
    const session = await materializePersistedSession();
    const { turn } = createPromptTurnForTesting(session);
    const frames = capturedWorkflow.systemFrames;
    applyLiveFrames(turn, frames);
    await settleSessionPreferenceWritesForTesting();

    mockSdkGetSessionMessages.mockResolvedValue(capturedWorkflow.rollout as SdkSessionMessage[]);
    const hydrated = await readPersistedSessionMessages(session);
    const launch = frames[0]!;
    expect(hydrated?.backgroundTasks?.[launch.task_id]).toMatchObject({
      description: "Inspect the fixture",
      taskType: "local_workflow",
      toolUseId: launch.tool_use_id,
      status: "completed",
      usage: { totalTokens: 2, toolUses: 0 },
      workflowAgents: [
        expect.objectContaining({
          label: "Review",
          phaseTitle: "Inspect",
          agentType: "Explore",
          state: "done",
          toolCalls: 0,
        }),
      ],
    });
    expect(hydrated?.messages.flatMap(({ parts }) => parts)).toContainEqual(
      expect.objectContaining({ toolName: "Workflow", toolUseId: launch.tool_use_id }),
    );
  });

  test("a sparse terminal patch and notification retain a released workflow parked by the live set", async () => {
    const session = await materializePersistedSession();
    const prompt = sendPrompt(session.id, "run");
    const call = await nextQueryCall();
    const [launch, , patch, notification] = capturedWorkflow.systemFrames;
    const id = launch!.task_id;
    const agents = [
      agentRow(0, { state: "start", startedAt: undefined }),
      agentRow(1, { error: "Provider explanation" }),
      agentRow(2),
    ];
    call.push(launch);
    call.push({
      ...progress(agents),
      task_id: id,
      tool_use_id: launch!.tool_use_id,
      run_id: launch!.run_id,
    });
    await waitFor(() => session.backgroundTasks?.[id]?.workflowAgents?.length === 3);
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => session.status === "idle");
    const runtime = session.claudeRuntime!;
    call.push({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await waitFor(() => runtime.tasks.settling.has(id));
    expect(session.backgroundTasks?.[id]).toBeUndefined();

    call.push(patch);
    await waitFor(() => session.backgroundTasks?.[id]?.status === "completed");
    const expectSettledWorkflow = (task: BackgroundTaskSnapshot | undefined) => {
      expect(task).toMatchObject({
        status: "completed",
        description: launch!.description,
        toolUseId: launch!.tool_use_id,
      });
      expect(task?.workflowAgents?.map(({ error }) => error)).toEqual([
        "Workflow ended before this agent finished",
        "Provider explanation",
        "Workflow ended before this agent finished",
      ]);
      expect(task?.workflowAgents?.map(({ endedWithRun }) => endedWithRun)).toEqual([
        "stopped",
        "stopped",
        "stopped",
      ]);
    };
    expectSettledWorkflow(backgroundTasksForSnapshot(session.backgroundTasks)[id]);
    call.push(notification);
    await waitFor(() => !runtime.tasks.settling.has(id));
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(true);
    expectSettledWorkflow(backgroundTasksForSnapshot(session.backgroundTasks)[id]);
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
    await settleSessionPreferenceWritesForTesting();

    mockSdkGetSessionMessages.mockResolvedValue(capturedWorkflow.rollout as SdkSessionMessage[]);
    const hydrated = await readPersistedSessionMessages(session);
    expectSettledWorkflow(hydrated?.backgroundTasks?.[id]);
  });

  test("replays a multiline description from a full receipt without SDK start frames", async () => {
    const description = "Inspect the fixture\nReview the workflow\n\nPublish the results";
    const liveDescription = `\n${description}`;
    const session = await materializePersistedSession();
    const { turn } = createPromptTurnForTesting(session);
    const launch = capturedWorkflow.systemFrames[0]!;
    applyLiveFrames(turn, [{ ...launch, description: liveDescription }]);
    const rollout = structuredClone(capturedWorkflow.rollout);
    const launchRecord = rollout[1]!;
    if (!Array.isArray(launchRecord.message.content)) throw new Error("Expected launch receipt");
    launchRecord.message.content[0]!.content = [
      `Workflow launched in background. Task ID: ${launch.task_id}`,
      `Summary: ${liveDescription}`,
      "",
      "Transcript dir: /fixture/transcripts",
      "Script file: /fixture/workflow.js",
      "(Edit this file and re-invoke Workflow.)",
      "Run ID: fixture-run",
      "To resume after editing the script, use resumeFromRunId.",
    ].join("\n");
    mockSdkGetSessionMessages.mockResolvedValue(rollout as SdkSessionMessage[]);
    const hydrated = await readPersistedSessionMessages(session);
    expect(session.backgroundTasks?.[launch.task_id]?.description).toBe(description);
    expect(hydrated?.backgroundTasks?.[launch.task_id]?.description).toBe(description);
  });

  test("a successful control stop explains queued and running agent outcomes", async () => {
    queryControlOverrides.stopTask = async () => {};
    const created = createSession("Stop workflow");
    track(created.id);
    const prompt = sendPrompt(created.id, "run");
    const call = await nextQueryCall();
    const session = getSession(created.id)!;
    call.push(started);
    call.push(progress([agentRow(0, { state: "start", startedAt: undefined }), agentRow(1)]));
    await waitFor(() => session.backgroundTasks?.["wf-1"]?.workflowAgents?.length === 2);
    expect(await stopBackgroundTask(session.id, "wf-1")).toEqual({ ok: true });
    expect(session.backgroundTasks?.["wf-1"]).toMatchObject({
      status: "killed",
      workflowAgents: [0, 1].map((index) =>
        expect.objectContaining({
          index,
          endedWithRun: "stopped",
          error: "Workflow ended before this agent finished",
        }),
      ),
    });
    call.finish();
    await prompt;
  });

  test("an in-flight control stop does not settle a replacement workflow", async () => {
    const acknowledged = Promise.withResolvers<void>();
    queryControlOverrides.stopTask = () => acknowledged.promise;
    const created = createSession("Relaunch during workflow stop");
    track(created.id);
    const prompt = sendPrompt(created.id, "run");
    const call = await nextQueryCall();
    const session = getSession(created.id)!;
    call.push({ ...started, run_id: "old-run" });
    await waitFor(() => session.claudeRuntime?.tasks.live.has("wf-1") === true);
    const stop = stopBackgroundTask(session.id, "wf-1");
    expect(session.claudeRuntime?.tasks.stopRequested.has("wf-1")).toBe(true);
    call.push({ ...started, run_id: "new-run" });
    await waitFor(() => session.backgroundTasks?.["wf-1"]?.workflowRunId === "new-run");
    expect(session.claudeRuntime?.tasks.stopRequested.has("wf-1")).toBe(false);
    acknowledged.resolve();
    expect(await stop).toEqual({ ok: true });
    expect(session.backgroundTasks?.["wf-1"]?.status).toBe("running");
    call.finish();
    await prompt;
  });

  test("stops active agent rows when a workflow loses its process", async () => {
    const created = createSession("Workflow process exit");
    track(created.id);
    const prompt = sendPrompt(created.id, "run");
    const call = await nextQueryCall();
    const session = getSession(created.id)!;
    call.push(started);
    call.push(progress([agentRow(1), agentRow(2, { state: "done" })]));
    await waitFor(() => session.backgroundTasks?.["wf-1"]?.workflowAgents?.length === 2);
    call.finish();
    await prompt;
    await waitFor(() => session.backgroundTasks?.["wf-1"]?.status === "killed");
    const task = backgroundTasksForSnapshot(session.backgroundTasks)["wf-1"];
    expect(task?.workflowAgents).toEqual([
      expect.objectContaining({
        state: "error",
        endedWithRun: "stopped",
        error: expect.any(String),
      }),
      expect.objectContaining({ state: "done" }),
    ]);
    expect(task?.workflowAgentCounts).toEqual({
      total: 2,
      finished: 2,
      running: 0,
      queued: 0,
      failed: 0,
    });
  });

  test("a snapshot outline drops the agent list, a full one keeps it", () => {
    const { session, turn } = liveTurn("Workflow snapshot");
    handleTaskEdge(turn, started as unknown as SDKMessage);
    handleTaskEdge(turn, progress([agentRow(1)]) as unknown as SDKMessage);
    expect(
      backgroundTasksForSnapshot(session.backgroundTasks)["wf-1"]?.workflowAgents,
    ).toHaveLength(1);
    const outline = backgroundTasksForSnapshot(session.backgroundTasks, 10)["wf-1"];
    expect(outline?.workflowAgents).toBeUndefined();
    expect(outline?.workflowAgentsOmitted).toBe(1);
  });
});

describe("workflow agent hooks", () => {
  test("a released turn waits for an ordinary stop but defers both kinds of workflow agent stop", async () => {
    const created = createSession("Released workflow hooks");
    track(created.id);
    const prompt = sendPrompt(created.id, "run");
    const call = await nextQueryCall();
    const hooks = call.options.hooks as Record<
      string,
      Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>
    >;
    const session = getSession(created.id)!;
    const subagentHook = (event: "SubagentStart" | "SubagentStop", id: string, type: string) =>
      hooks[event]![0]!.hooks[0]!({
        hook_event_name: event,
        agent_id: id,
        agent_type: type,
        stop_hook_active: false,
        agent_transcript_path: "/fixture/agent.jsonl",
      });

    call.push(capturedWorkflow.rollout[0]);
    call.push(capturedWorkflow.rollout[1]);
    call.push(started);
    await waitFor(() => session.claudeRuntime?.tasks.live.has("wf-1") === true);
    await subagentHook("SubagentStart", "agent-0", "Explore");
    await subagentHook("SubagentStart", "agent-default", WORKFLOW_SUBAGENT_TYPE);
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => session.status === "idle");
    const runtime = session.claudeRuntime!;
    expect(runtime.tasks.live.has("agent-0")).toBe(true);
    await subagentHook("SubagentStop", "agent-default", WORKFLOW_SUBAGENT_TYPE);
    expect(session.backgroundTasks?.["agent-default"]).toBeUndefined();
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(false);
    await subagentHook("SubagentStop", "agent-0", "Explore");
    expect(session.backgroundTasks?.["agent-0"]?.status).toBe("completed");
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(false);

    // One omitted hook record has already settled and one is still runtime-owned.
    await subagentHook("SubagentStart", "agent-1", "Explore");
    expect(runtime.tasks.live.has("agent-1")).toBe(true);
    const rows = Array.from({ length: MAX_WORKFLOW_AGENTS + 2 }, (_, index) =>
      agentRow(index, index < 2 ? { state: "done", agentType: "Explore" } : {}),
    );
    call.push(progress(rows));
    await waitFor(() => session.backgroundTasks?.["wf-1"]?.workflowAgentsOmitted === 2);
    for (const id of ["agent-0", "agent-1"]) {
      expect(session.backgroundTasks?.[id]).toBeUndefined();
      expect(runtime.tasks.live.has(id)).toBe(false);
      expect(runtime.tasks.settling.has(id)).toBe(false);
    }
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(false);
    await subagentHook("SubagentStart", "agent-0", "Explore");
    expect(session.backgroundTasks?.["agent-0"]).toBeUndefined();
    expect(runtime.tasks.live.has("agent-0")).toBe(false);

    await subagentHook("SubagentStart", "unclaimed", "Explore");
    await subagentHook("SubagentStop", "unclaimed", "Explore");
    expect(session.backgroundTasks?.unclaimed).toMatchObject({ status: "completed" });
    expect(runtime.tasks.settling.has("unclaimed")).toBe(true);
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(false);
    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "unclaimed",
      status: "completed",
      summary: "Ordinary subagent completed",
    });
    await waitFor(() => !runtime.tasks.settling.has("unclaimed"));
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(true);
    expect(session.backgroundTasks?.unclaimed?.summary).toBe("Ordinary subagent completed");
    call.push({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "ordinary-continuation",
        role: "assistant",
        content: [{ type: "text", text: "The ordinary subagent finished." }],
      },
    });
    call.push({ type: "result", subtype: "success" });
    await waitFor(() => !runtime.latestTurn.isAwaitingContinuation());

    await subagentHook("SubagentStart", "hook-only", "Explore");
    await subagentHook("SubagentStop", "hook-only", "Explore");
    expect(session.backgroundTasks?.["hook-only"]?.status).toBe("completed");
    expect(runtime.tasks.settling.has("hook-only")).toBe(true);
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(false);

    await subagentHook("SubagentStart", "ordinary", "Explore");
    // The confirmed task's stop still triggers the normal root continuation.
    call.push({ ...started, task_id: "ordinary", task_type: "local_agent" });
    await waitFor(() => session.backgroundTasks?.ordinary?.taskType === "local_agent");
    await subagentHook("SubagentStop", "ordinary", "Explore");
    expect(runtime.latestTurn.isAwaitingContinuation()).toBe(true);
    call.finish();
    await prompt;
    await waitFor(() => runtime.tasks.settling.size === 0);
  });

  test("a workflow's agents never become tasks of their own", async () => {
    const created = createSession("Workflow hooks");
    track(created.id);
    const promptPromise = sendPrompt(created.id, "run the workflow");
    const call = await nextQueryCall();
    const hooks = call.options.hooks as Record<
      string,
      Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>
    >;
    const session = getSession(created.id)!;
    const subagentStart = (agentId: string, agentType: string) =>
      hooks.SubagentStart![0]!.hooks[0]!({
        hook_event_name: "SubagentStart",
        agent_id: agentId,
        agent_type: agentType,
      });

    call.push(started);
    await waitFor(() => session.backgroundTasks?.["wf-1"] !== undefined);
    // The CLI's own type for a workflow agent is never recorded.
    await subagentStart("agent-1", WORKFLOW_SUBAGENT_TYPE);
    expect(session.backgroundTasks?.["agent-1"]).toBeUndefined();
    // A script-chosen type is indistinguishable until a row claims the id...
    await subagentStart("agent-2", "Explore");
    expect(session.backgroundTasks?.["agent-2"]?.subagentType).toBe("Explore");
    call.push(progress([agentRow(1), agentRow(2, { agentType: "Explore" })]));
    await waitFor(() => session.backgroundTasks?.["agent-2"] === undefined);
    expect(session.claudeRuntime?.tasks.live.has("agent-2")).toBe(false);
    expect(session.claudeRuntime?.tasks.live.has("wf-1")).toBe(true);
    // ...and once it has, a later start for it is not recorded either.
    await subagentStart("agent-2", "Explore");
    expect(session.backgroundTasks?.["agent-2"]).toBeUndefined();
    // An ordinary subagent is still a task.
    await subagentStart("agent-other", "Explore");
    expect(session.backgroundTasks?.["agent-other"]?.subagentType).toBe("Explore");
    await hooks.SubagentStop![0]!.hooks[0]!({
      hook_event_name: "SubagentStop",
      agent_id: "agent-other",
      agent_type: "Explore",
      stop_hook_active: false,
      agent_transcript_path: "/tmp/agent-other.jsonl",
    });

    call.push({
      type: "system",
      subtype: "task_notification",
      task_id: "wf-1",
      tool_use_id: "toolu-workflow",
      status: "completed",
      summary: "Done",
      output_file: "/tmp/wf-1.output",
    });
    await waitFor(() => session.backgroundTasks?.["wf-1"]?.status === "completed");
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;
  });
});
