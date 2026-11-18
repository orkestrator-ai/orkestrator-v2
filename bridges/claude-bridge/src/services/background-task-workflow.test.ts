import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTaskSnapshot } from "../types/index.js";
import {
  MAX_WORKFLOW_AGENTS,
  WORKFLOW_SUBAGENT_TYPE,
  parseWorkflowProgress,
} from "./background-task-workflow.js";
import { backgroundTasksForSnapshot } from "./background-task-snapshot.js";
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
    expect(parseWorkflowProgress([])).toEqual({ agents: [], omitted: 0 });
  });

  test("past the bound keeps live and failed agents first and counts the rest", () => {
    const rows = Array.from({ length: MAX_WORKFLOW_AGENTS + 10 }, (_, index) =>
      agentRow(index, { state: index === 0 ? "error" : index === 1 ? "progress" : "done" }),
    );
    const parsed = parseWorkflowProgress(rows, 3)!;
    expect(parsed.agents).toHaveLength(MAX_WORKFLOW_AGENTS);
    expect(parsed.omitted).toBe(10 + 3);
    const indexes = parsed.agents.map((agent) => agent.index);
    expect(indexes.slice(0, 2)).toEqual([0, 1]);
    // The newest finished agents fill the rest, in run order.
    expect(indexes.at(-1)).toBe(MAX_WORKFLOW_AGENTS + 9);
    expect(indexes).not.toContain(2);
  });
});

describe("workflow task edges", () => {
  test("live progress keeps the workflow's name and reads its agents", () => {
    const { session, turn } = liveTurn("Workflow live");
    handleTaskEdge(turn, started as unknown as SDKMessage);
    handleTaskEdge(turn, progress([agentRow(1), agentRow(2)]) as unknown as SDKMessage);
    // A throttled frame carries no list; the last one stands.
    handleTaskEdge(turn, progress(undefined, "Build: saved") as unknown as SDKMessage);

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
      last_tool_name: "Grep",
    } as unknown as SDKMessage);
    expect(session.backgroundTasks?.["agent-1"]).toMatchObject({
      description: "Renamed by the provider",
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

  test("a snapshot outline drops the agent list, a full one keeps it", () => {
    const { session, turn } = liveTurn("Workflow snapshot");
    handleTaskEdge(turn, started as unknown as SDKMessage);
    handleTaskEdge(turn, progress([agentRow(1)]) as unknown as SDKMessage);
    expect(
      backgroundTasksForSnapshot(session.backgroundTasks)["wf-1"]?.workflowAgents,
    ).toHaveLength(1);
    expect(backgroundTasksForSnapshot(session.backgroundTasks, 10)["wf-1"]?.workflowAgents).toBe(
      undefined,
    );
  });
});

describe("workflow agent hooks", () => {
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
