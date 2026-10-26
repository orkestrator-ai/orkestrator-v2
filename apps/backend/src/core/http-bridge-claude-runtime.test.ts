import { describe, expect, test } from "bun:test";
import { normalizeClaudeBackgroundTasks } from "./http-bridge-claude-runtime.js";

describe("normalizeClaudeBackgroundTasks", () => {
  test("carries Claude's subagent type as the neutral agent role", () => {
    /*
     * A card the transcript cannot place has only the snapshot to read, so the
     * role is what tells a delegated agent from a backgrounded main session
     * when neither carries a description.
     */
    expect(
      normalizeClaudeBackgroundTasks({
        agent: { status: "running", subagentType: "Explore" },
        main: { status: "running", subagentType: " main-session " },
        shell: { status: "running", description: "Watch" },
      }),
    ).toEqual([
      { id: "agent", status: "running", agentRole: "Explore" },
      { id: "main", status: "running", agentRole: "main-session" },
      { id: "shell", status: "running", description: "Watch" },
    ]);
  });

  test("drops a role that is not a usable name rather than cutting it down", () => {
    expect(
      normalizeClaudeBackgroundTasks({
        blank: { status: "running", subagentType: "   " },
        number: { status: "running", subagentType: 7 },
        control: { status: "running", subagentType: "Explore\nInjected" },
        long: { status: "running", subagentType: "x".repeat(257) },
      }),
    ).toEqual([
      { id: "blank", status: "running" },
      { id: "number", status: "running" },
      { id: "control", status: "running" },
      { id: "long", status: "running" },
    ]);
  });

  test("carries task metadata in neutral terms", () => {
    const [task] = normalizeClaudeBackgroundTasks({
      "shell-1": {
        status: "killed",
        taskType: "local_bash",
        parentTaskId: "agent-1",
        command: "bun test",
        outputTail: "1 fail",
        lastToolName: "Bash",
        progressSummary: "  Running the suite  ",
        pausedMs: 1500,
        endReason: "worker_restart",
        ambient: true,
      },
    })!;
    expect(task).toMatchObject({
      kind: "shell",
      parentTaskId: "agent-1",
      command: "bun test",
      outputTail: "1 fail",
      lastToolName: "Bash",
      progressSummary: "Running the suite",
      pausedMs: 1500,
      endReason: "process-restart",
      ambient: true,
    });
  });

  test("carries a resume cleanup as its own end reason", () => {
    const [task] = normalizeClaudeBackgroundTasks({
      bfs6uwwmn: { status: "killed", endReason: "resume_cleanup" },
    })!;
    expect(task?.endReason).toBe("resume-cleanup");
  });

  test("maps every provider kind and preserves prompt and workflow name", () => {
    const kinds = {
      local_bash: "shell",
      local_agent: "agent",
      local_workflow: "workflow",
      remote_agent: "remote-agent",
      mcp_task: "mcp",
      monitor_mcp: "mcp",
      in_process_teammate: "teammate",
    } as const;
    for (const [taskType, kind] of Object.entries(kinds)) {
      expect(
        normalizeClaudeBackgroundTasks({
          task: { status: "running", taskType, prompt: "Review docs", workflowName: "spec" },
        }),
      ).toEqual([
        { id: "task", status: "running", kind, prompt: "Review docs", workflowName: "spec" },
      ]);
    }
  });

  test("names an unknown task kind other and drops unusable metadata", () => {
    const [task] = normalizeClaudeBackgroundTasks({
      odd: {
        status: "running",
        taskType: "dream",
        parentTaskId: "bad\nid",
        pausedMs: -1,
        endReason: "boredom",
        ambient: "yes",
      },
    })!;
    expect(task?.kind).toBe("other");
    expect(task?.parentTaskId).toBeUndefined();
    expect(task?.pausedMs).toBeUndefined();
    expect(task?.endReason).toBeUndefined();
    expect(task?.ambient).toBeUndefined();
  });
});
