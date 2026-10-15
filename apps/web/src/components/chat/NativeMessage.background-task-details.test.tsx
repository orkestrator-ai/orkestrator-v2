import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  childBackgroundTasksByParent,
  rowlessBackgroundTaskMessages,
} from "@/lib/chat/native-message-adapters";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { NativeMessage } from "./NativeMessage";
import { BackgroundTaskCard } from "./NativeMessage.agent-parts";
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
    // 3m 5s on the clock, less 1m 5s paused.
    expect(screen.getByText("2m 0s")).toBeTruthy();
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
