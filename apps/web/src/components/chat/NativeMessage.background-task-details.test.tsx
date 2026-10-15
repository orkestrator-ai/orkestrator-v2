import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  childBackgroundTasksByParent,
  rowlessBackgroundTaskMessages,
} from "@/lib/chat/native-message-adapters";
import type {
  NativeTaskGroupPart,
  NativeMessage as NativeMessageType,
} from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";
import { BackgroundTaskCard, TaskGroupPart } from "./NativeMessage.agent-parts";
import { BackgroundTaskChildrenContext } from "./NativeMessage.shared";

afterEach(cleanup);

describe("background task details", () => {
  test("a shell task is named for its kind and shows its command, output and exit", () => {
    render(
      <BackgroundTaskCard
        task={{
          id: "shell-1",
          status: "completed",
          description: "Run the suite",
          kind: "shell",
          command: "bun test --watch=false",
          outputTail: "3 pass\n1 fail",
          error: "Exit code 1",
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /Shell Run the suite Completed/ })).toBeTruthy();
    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getAllByText("bun test --watch=false").length).toBeGreaterThan(0);
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText(/3 pass/)).toBeTruthy();
    expect(screen.getByText("Exit code 1")).toBeTruthy();
  });

  test("a live task previews the provider's status line, else the tool it last ran", () => {
    const { rerender } = render(
      <BackgroundTaskCard
        task={{
          id: "agent-1",
          status: "running",
          description: "Audit docs",
          kind: "agent",
          progressSummary: "Checking links in the architecture docs",
          lastToolName: "Grep",
        }}
        open={false}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText("Checking links in the architecture docs")).toBeTruthy();

    rerender(
      <BackgroundTaskCard
        task={{
          id: "agent-1",
          status: "running",
          description: "Audit docs",
          kind: "agent",
          lastToolName: "Grep",
        }}
        open={false}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByText("Using Grep")).toBeTruthy();

    // Settled, the outcome says more than the last status did.
    rerender(
      <BackgroundTaskCard
        task={{
          id: "agent-1",
          status: "completed",
          description: "Audit docs",
          kind: "agent",
          lastToolName: "Grep",
          summary: "Audited 17 docs",
        }}
        open={false}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.queryByText("Using Grep") === null).toBe(true);
    expect(screen.getByText("Audited 17 docs")).toBeTruthy();
  });

  test("a rowless agent shows its prompt, paused time and a restart ending", () => {
    render(
      <BackgroundTaskCard
        task={{
          id: "agent-2",
          status: "killed",
          description: "Review the bridge",
          kind: "agent",
          prompt: "Review bridges/claude-bridge for races",
          pausedMs: 65_000,
          endReason: "process-restart",
          startedAt: "2026-08-16T10:00:00.000Z",
          settledAt: "2026-08-16T10:03:05.000Z",
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.getByText("Review bridges/claude-bridge for races")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("1m 5s")).toBeTruthy();
    expect(screen.getByText("Ended")).toBeTruthy();
    // Wall time includes the separately displayed paused time.
    expect(screen.getByText("3m 5s")).toBeTruthy();
  });

  for (const grouped of [false, true]) {
    test(`${grouped ? "task group" : "rowless card"} keeps wall time consistent on settle and remount`, () => {
      const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-16T10:03:05Z"));
      const task = {
        id: "timed",
        status: "running" as const,
        kind: "agent" as const,
        description: "Audit docs",
        startedAt: "2026-08-16T10:00:00Z",
        pausedMs: 65_000,
      };
      const view = (status: "running" | "paused" | "completed") => {
        const backgroundTask = {
          ...task,
          status,
          ...(status === "completed" ? { settledAt: "2026-08-16T10:03:05Z" } : {}),
        };
        const part: NativeTaskGroupPart = {
          type: "task-group",
          content: "Agent",
          childTools: [],
          task: {
            type: "tool-invocation",
            content: "Agent",
            toolName: "Agent",
            toolUseId: "timed-tool",
            toolArgs: { description: "Audit docs" },
            backgroundTask,
          },
        };
        return grouped ? (
          <TaskGroupPart part={part} partKey="timed" />
        ) : (
          <BackgroundTaskCard task={backgroundTask} open={false} onOpenChange={() => {}} />
        );
      };
      try {
        const { rerender, unmount } = render(view("running"));
        expect(screen.getByText("3m 5s")).toBeTruthy();
        rerender(view("paused"));
        expect(screen.getByText("3m 5s")).toBeTruthy();
        rerender(view("completed"));
        expect(screen.getByText("3m 5s")).toBeTruthy();
        unmount();
        render(view("completed"));
        expect(screen.getByText("3m 5s")).toBeTruthy();
      } finally {
        clock.mockRestore();
      }
    });
  }

  test("a task group previews its own background progress, then its last tool", () => {
    const base: NativeTaskGroupPart = {
      type: "task-group",
      content: "Agent",
      childTools: [],
      task: {
        type: "tool-invocation",
        content: "Agent",
        toolName: "Agent",
        toolUseId: "progress",
        toolArgs: { description: "Audit docs" },
        backgroundTask: {
          id: "agent-progress",
          status: "running",
          progressSummary: "Checking links",
          lastToolName: "Grep",
        },
      },
    };
    const { rerender } = render(<TaskGroupPart part={base} partKey="progress" />);
    expect(screen.getByText("Checking links")).toBeTruthy();
    rerender(
      <TaskGroupPart
        part={{
          ...base,
          task: {
            ...base.task,
            backgroundTask: { ...base.task.backgroundTask!, progressSummary: undefined },
          },
        }}
        partKey="progress"
      />,
    );
    expect(screen.getByText("Using Grep")).toBeTruthy();
  });

  test("an agent card lists the tasks its agent launched and previews the live one", () => {
    const tasks = [
      { id: "agent-3", status: "running", toolUseId: "toolu-agent", kind: "agent" },
      {
        id: "shell-3",
        status: "running",
        description: "Run the suite",
        kind: "shell",
        command: "bun test",
        parentTaskId: "agent-3",
      },
      {
        id: "shell-4",
        status: "completed",
        description: "List docs",
        kind: "shell",
        command: "ls docs",
        parentTaskId: "agent-3",
      },
    ] as const;
    const message: NativeMessageType = {
      id: "assistant-agent",
      role: "assistant",
      content: "",
      createdAt: "2026-08-16T10:00:00.000Z",
      parts: [
        {
          type: "task-group",
          content: "Agent",
          childTools: [],
          task: {
            type: "tool-invocation",
            content: "Agent",
            toolName: "Agent",
            toolUseId: "toolu-agent",
            toolArgs: { description: "Audit docs", run_in_background: true },
            agentState: "active",
            backgroundTask: { id: "agent-3", status: "running", description: "Audit docs" },
          },
        },
      ],
    };
    expect(rowlessBackgroundTaskMessages(tasks, [message])).toHaveLength(0);

    render(
      <BackgroundTaskChildrenContext.Provider value={childBackgroundTasksByParent(tasks)}>
        <NativeMessage platform="claude" message={message} />
      </BackgroundTaskChildrenContext.Provider>,
    );

    expect(screen.getByText("Shell · bun test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Agent Audit docs/ }));
    expect(screen.getByText("Launched tasks")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Shell Run the suite Running/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Shell List docs Completed/ })).toBeTruthy();
    expect(screen.queryByText("No child actions yet.") === null).toBe(true);
  });
});
