import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";

const toastErrorMock = mock(() => {});

mock.module("sonner", () => ({
  toast: {
    error: toastErrorMock,
  },
}));

import { NativeMessage } from "./NativeMessage";

function makeMessage(
  parts: Array<NativeMessagePart>,
  overrides?: Partial<{
    id: string;
    role: "user" | "assistant";
    content: string;
  }>,
) {
  return {
    id: overrides?.id ?? "assistant-1",
    role: overrides?.role ?? ("assistant" as const),
    content: overrides?.content ?? "",
    createdAt: "2026-03-21T10:00:00.000Z",
    parts,
  };
}

describe("NativeMessage task list rendering", () => {
  afterEach(() => {
    cleanup();
    toastErrorMock.mockClear();
  });

  test("renders task list in a collapsible thinking block that expands on click", () => {
    const message = makeMessage([
      {
        type: "thinking",
        content: "- [x] Finished task\n- [ ] Next task",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // Initially collapsed — content is hidden
    expect(container.textContent).toContain("task list");
    expect(container.textContent).not.toContain("Finished task");

    // Click the trigger to expand
    const trigger = screen.getByRole("button", { name: /thinking/i });
    fireEvent.click(trigger);

    // Now the task list content should be visible
    expect(container.textContent).not.toContain("[x]");
    expect(container.textContent).not.toContain("[ ]");

    const completedTask = screen.getByText("Finished task");
    expect(completedTask.className).toContain("line-through");

    const checkboxIcons = container.querySelectorAll(
      '[data-task-list-icon="true"]',
    );
    expect(checkboxIcons).toHaveLength(2);
    expect(checkboxIcons[0]?.getAttribute("data-state")).toBe("checked");
    expect(checkboxIcons[1]?.getAttribute("data-state")).toBe("unchecked");
  });

  test("renders regular thinking parts as collapsed single-line summary", () => {
    const message = makeMessage([
      {
        type: "thinking",
        content: "Let me analyze the code structure here",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(container.textContent).toContain(
      "Let me analyze the code structure here",
    );
    // Should NOT have a collapsible trigger (no chevron button)
    expect(container.querySelector("button")).toBeNull();
  });

  test("text parts with task lists render checkboxes directly (no collapsible)", () => {
    const message = makeMessage([
      {
        type: "text",
        content: "Here is a checklist:\n- [x] Done\n- [ ] Todo",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    const checkboxIcons = container.querySelectorAll(
      '[data-task-list-icon="true"]',
    );
    expect(checkboxIcons).toHaveLength(2);
    expect(container.textContent).not.toContain("[x]");
    expect(container.textContent).not.toContain("[ ]");
  });

  test("renders an icon-only copy button in the assistant metadata row", async () => {
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {});
    const message = makeMessage([
      {
        type: "text",
        content: "Copy this answer",
      },
    ]);

    render(<NativeMessage message={message} />);

    const copyButton = screen.getByRole("button", { name: "Copy text" });
    expect(copyButton.textContent).toBe("");
    expect(copyButton.parentElement?.className).toContain("pr-0");
    expect(screen.getByText(/Assistant/)).toBeTruthy();

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Copy this answer");
    });
    expect(screen.getByRole("button", { name: "Copied text" })).toBeTruthy();
  });

  test("uses uniform part spacing for tool and text blocks", () => {
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "",
        toolName: "Bash",
        toolState: "success",
      },
      {
        type: "tool-result",
        content: "",
      },
      {
        type: "text",
        content: "Text after tool",
      },
    ]);

    render(<NativeMessage message={message} />);

    const toolButton = screen.getByRole("button", { name: /Run Command/i });
    expect(toolButton.parentElement?.className).toContain("my-0");

    const text = screen.getByText("Text after tool");
    const markdownWrapper = text.closest(".prose");
    expect(markdownWrapper?.parentElement?.className).toContain(
      "[&_.prose>:first-child]:mt-0",
    );
    expect(markdownWrapper?.parentElement?.className).toContain(
      "[&_.prose>:last-child]:mb-0",
    );
    expect(markdownWrapper?.parentElement?.parentElement?.className).toContain(
      "py-1.5",
    );
    expect(markdownWrapper?.parentElement?.className).not.toContain("pt-2");
  });

  test("displays bash tool invocations as Run Command", () => {
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "ls",
        toolName: "bash",
        toolArgs: { command: "ls" },
        toolState: "success",
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByRole("button", { name: /Run Command/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /\bbash\b/i })).toBeNull();
  });

  test("uses uniform outer spacing for native part wrapper variants", () => {
    const message = makeMessage([
      {
        type: "thinking",
        content: "- [ ] Check wrapper spacing",
      },
      {
        type: "thinking",
        content: "Regular thinking wrapper",
      },
      {
        type: "file",
        content: "/workspace/screenshot.png",
      },
      {
        type: "subagent",
        content: "Lovelace",
        subagentName: "Lovelace",
        toolState: "success",
        subagentActions: [],
      },
      {
        type: "tool-group",
        content: "",
        parts: [
          {
            type: "tool-invocation",
            content: "",
            toolName: "Read",
            toolState: "success",
          },
        ],
      },
      {
        type: "task-group",
        content: "",
        task: {
          type: "tool-invocation",
          content: "",
          toolName: "Task",
          toolTitle: "Task wrapper",
          toolState: "success",
        },
        childTools: [
          {
            type: "tool-invocation",
            content: "",
            toolName: "Bash",
            toolState: "success",
          },
        ],
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(
      screen.getByRole("button", { name: /task list/i }).parentElement?.className,
    ).toContain("my-0");
    expect(
      screen.getByText("Regular thinking wrapper").parentElement?.className,
    ).toContain("my-0");
    expect(screen.getByRole("button", { name: /screenshot\.png/i }).className)
      .toContain("my-0");
    expect(
      screen.getByRole("button", { name: /lovelace/i }).parentElement?.className,
    ).toContain("my-0");
    expect(container.innerHTML).toContain("my-0 rounded-lg border border-zinc-700/70");
    expect(
      screen.getByRole("button", { name: /task wrapper/i }).parentElement?.className,
    ).toContain("my-0");
  });

  test("renders Claude Agent task groups as compact agent activity rows", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Run presentation reviewer",
        task: {
          type: "tool-invocation",
          content: "Run presentation reviewer",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
          toolArgs: {
            description: "Review presentation polish",
            prompt: "Inspect the SwiftUI views for layout and navigation issues.",
            subagent_type: "explorer",
          },
        },
        childTools: [
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            toolTitle: "Read",
            toolState: "success",
            toolArgs: { file_path: "/workspace/Sources/App.swift" },
          },
        ],
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(screen.getByText("Agent")).toBeTruthy();
    expect(
      screen.getByText("Review presentation polish (explorer)"),
    ).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(screen.getByText("1 update")).toBeTruthy();
    expect(container.textContent).not.toContain('"description"');
    expect(container.textContent).not.toContain("Inspect the SwiftUI views");

    fireEvent.click(
      screen.getByRole("button", { name: /review presentation polish/i }),
    );

    expect(
      screen.getByText("Inspect the SwiftUI views for layout and navigation issues."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Read App\.swift success/i })).toBeTruthy();
  });

  test("uses an explicit agent name with the description as a secondary header label", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Run reviewer",
        task: {
          type: "tool-invocation",
          content: "Run reviewer",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "success",
          toolArgs: {
            agent_name: "Presentation Reviewer",
            description: "Review presentation polish",
            role: "explorer",
          },
        },
        childTools: [
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            toolTitle: "Read",
            toolState: "success",
            toolArgs: { file_path: "/workspace/a.ts" },
          },
        ],
      },
    ]);

    render(<NativeMessage message={message} />);

    // Explicit name drives the primary label (with role), description is secondary.
    expect(
      screen.getByText("Presentation Reviewer (explorer)"),
    ).toBeTruthy();
    expect(screen.getByText("Review presentation polish")).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();
  });

  test("falls back to a non-generic tool label when no name or description is present", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Custom tool",
        task: {
          type: "tool-invocation",
          content: "Custom tool",
          toolName: "CustomReviewer",
          toolTitle: "CustomReviewer",
          toolState: "pending",
          toolArgs: {},
        },
        childTools: [],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("CustomReviewer")).toBeTruthy();
  });

  test("falls back to the Subagent label for a generic agent tool with no metadata", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
        },
        childTools: [],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Subagent")).toBeTruthy();
  });

  test("shows a waiting preview and empty state while a pending agent has no child tools", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
          toolArgs: { subagent_type: "explorer" },
        },
        childTools: [],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Waiting for activity.")).toBeTruthy();
    expect(screen.getByText("0 tools")).toBeTruthy();
    expect(screen.getByText("0 updates")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /subagent/i }));

    expect(screen.getByText("No child actions yet.")).toBeTruthy();
  });

  test("uses external tmux usage counts for agent task rows when available", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
          toolUseCount: 8,
          tokenCount: 20_400,
          tokenCountText: "20.4k tokens",
          toolArgs: {
            description: "Review API-client source modules group 1",
            subagent_type: "Explore",
          },
        },
        childTools: [],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("8 tool uses")).toBeTruthy();
    expect(screen.getByText("20.4k tokens")).toBeTruthy();
    expect(screen.queryByText("0 updates")).toBeNull();
  });

  test("renders adjacent agents inside a compact shared block", () => {
    const message = makeMessage([
      {
        type: "subagent",
        content: "Reviewer",
        subagentName: "Reviewer",
        toolState: "pending",
        subagentActions: [],
      },
      {
        type: "subagent",
        content: "Tester",
        subagentName: "Tester",
        toolState: "success",
        subagentActions: [],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByRole("region", { name: "2 agents" })).toBeTruthy();
    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Tester")).toBeTruthy();
  });

  test("counts pending task children and undefined states as running but not terminal agents", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Task reviewer",
        task: {
          type: "tool-invocation",
          content: "Task reviewer",
          toolUseId: "task-1",
          toolState: "pending",
        },
        childTools: [],
      },
      {
        type: "subagent",
        content: "Failed reviewer",
        subagentId: "agent-failed",
        toolState: "failure",
      },
      {
        type: "subagent",
        content: "Unreported reviewer",
        subagentId: "agent-unreported",
      },
      {
        type: "subagent",
        content: "Finished reviewer",
        subagentId: "agent-finished",
        toolState: "success",
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByRole("region", { name: "4 agents" })).toBeTruthy();
    expect(screen.getByText("2 running")).toBeTruthy();
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.getAllByText("Waiting for activity.")).toHaveLength(2);
    expect(screen.getAllByText("No activity captured.")).toHaveLength(2);
  });

  test("preserves an expanded agent when an adjacent streaming agent creates a group", () => {
    const firstAgent: NativeMessagePart = {
      type: "subagent",
      content: "Reviewer",
      subagentId: "agent-1",
      subagentName: "Reviewer",
      subagentPrompt: "Inspect the original task details",
      toolState: "pending",
      subagentActions: [],
    };
    const { rerender } = render(
      <NativeMessage message={makeMessage([firstAgent])} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));
    expect(screen.getByText("Inspect the original task details")).toBeTruthy();

    rerender(
      <NativeMessage
        message={makeMessage([
          firstAgent,
          {
            type: "subagent",
            content: "Tester",
            subagentId: "agent-2",
            subagentName: "Tester",
            toolState: "pending",
            subagentActions: [],
          },
        ])}
      />,
    );

    expect(screen.getByRole("region", { name: "2 agents" })).toBeTruthy();
    expect(screen.getByText("Inspect the original task details")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /reviewer/i }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("propagates the container id through grouped subagent actions", async () => {
    const message = makeMessage([
      {
        type: "subagent",
        content: "Reviewer",
        subagentId: "agent-1",
        subagentName: "Reviewer",
        toolState: "pending",
        subagentActions: [
          {
            type: "file",
            content: "relative-preview.png",
            fileUrl: "relative-preview.png",
          },
        ],
      },
      {
        type: "subagent",
        content: "Tester",
        subagentId: "agent-2",
        subagentName: "Tester",
        toolState: "pending",
        subagentActions: [],
      },
    ]);

    render(<NativeMessage message={message} containerId="container-1" />);

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));
    const previewButton = screen
      .getAllByRole("button", { name: /relative-preview\.png/i })
      .at(-1);
    expect(previewButton).toBeTruthy();
    fireEvent.click(previewButton!);

    expect(await screen.findByAltText("relative-preview.png")).toBeTruthy();
  });

  test("can render Claude tmux agent usage as tokens only", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "success",
          tokenCount: 45_700,
          tokenCountText: "45.7k tokens",
          agentUsageDisplay: "token-only",
          toolArgs: {
            description: "Review db-api test correctness",
            subagent_type: "Explore",
          },
        },
        childTools: [],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("45.7k tokens")).toBeTruthy();
    expect(screen.queryByText("0 tools")).toBeNull();
    expect(screen.queryByText("0 updates")).toBeNull();
  });

  test("uses external tmux usage counts for standalone subagent rows when available", () => {
    const message = makeMessage([
      {
        type: "subagent",
        content: "Lovelace",
        subagentName: "Lovelace",
        subagentRole: "Explore",
        toolState: "pending",
        subagentActions: [],
        subagentActionCount: 0,
        toolUseCount: 8,
        tokenCount: 20_400,
        tokenCountText: "20.4k tokens",
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("8 tool uses")).toBeTruthy();
    expect(screen.getByText("20.4k tokens")).toBeTruthy();
    expect(screen.queryByText("0 updates")).toBeNull();
  });

  test("can render standalone Claude tmux subagent usage as tokens only", () => {
    const message = makeMessage([
      {
        type: "subagent",
        content: "Review web test correctness",
        subagentName: "Review web test correctness",
        subagentRole: "Explore",
        toolState: "success",
        subagentActions: [],
        subagentActionCount: 0,
        tokenCount: 37_300,
        tokenCountText: "37.3k tokens",
        agentUsageDisplay: "token-only",
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("37.3k tokens")).toBeTruthy();
    expect(screen.queryByText("0 tools")).toBeNull();
    expect(screen.queryByText("0 updates")).toBeNull();
  });

  test("uses singular tool-use wording for a single external tool use", () => {
    const message = makeMessage([
      {
        type: "subagent",
        content: "Lovelace",
        subagentName: "Lovelace",
        toolState: "pending",
        subagentActions: [],
        subagentActionCount: 0,
        toolUseCount: 1,
        tokenCount: 980,
        tokenCountText: "980 tokens",
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("1 tool use")).toBeTruthy();
    expect(screen.getByText("980 tokens")).toBeTruthy();
  });

  test("shows a no-activity preview when a finished agent captured no child tools", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "success",
          toolArgs: {},
        },
        childTools: [],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("No activity captured.")).toBeTruthy();
  });

  test("previews the latest child command in the collapsed agent row", () => {
    const message = makeMessage([
      {
        type: "task-group",
        content: "Agent",
        task: {
          type: "tool-invocation",
          content: "Agent",
          toolName: "Agent",
          toolTitle: "Agent",
          toolState: "pending",
          toolArgs: { description: "Investigate build" },
        },
        childTools: [
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
            toolTitle: "Read",
            toolState: "success",
            toolArgs: { file_path: "/workspace/a.ts" },
          },
          {
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolTitle: "Bash",
            toolState: "pending",
            toolArgs: { command: "bun run build" },
          },
        ],
      },
    ]);

    render(<NativeMessage message={message} />);

    // Preview prefers the latest child's command over the task description.
    expect(screen.getByText("bun run build")).toBeTruthy();
    expect(screen.getByText("2 tools")).toBeTruthy();
  });

  test("shows an error toast when copying text fails", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {
      throw new Error("clipboard denied");
    });
    const message = makeMessage([
      {
        type: "text",
        content: "This will not copy",
      },
    ]);

    try {
      render(<NativeMessage message={message} />);

      fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy message text");
      });
      expect(screen.queryByRole("button", { name: "Copied text" })).toBeNull();
    } finally {
      console.error = consoleError;
    }
  });

  test("resets copied state after the confirmation timeout", async () => {
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {});
    const message = makeMessage([
      {
        type: "text",
        content: "Copy and reset",
      },
    ]);

    render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

    await screen.findByRole("button", { name: "Copied text" });
    await waitFor(
      () => {
        expect(screen.getByRole("button", { name: "Copy text" })).toBeTruthy();
      },
      { timeout: 1600 },
    );
  });

  test("handles mixed content in thinking: task list plus prose", () => {
    const content =
      "I need to work through several items:\n\n- [x] Read the file\n- [ ] Write the fix\n\nLet me start with the fix.";
    const message = makeMessage([{ type: "thinking", content }]);

    const { container } = render(<NativeMessage message={message} />);

    // Should detect the task list and use the collapsible variant
    const trigger = screen.getByRole("button", { name: /thinking/i });
    fireEvent.click(trigger);

    expect(container.textContent).toContain("Read the file");
    expect(container.textContent).toContain("Write the fix");
    expect(container.textContent).toContain("Let me start with the fix.");
  });

  test("handles empty task list items gracefully", () => {
    const message = makeMessage([
      {
        type: "text",
        content: "- [ ] \n- [x] Has text",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // Should render without crashing
    const checkboxIcons = container.querySelectorAll(
      '[data-task-list-icon="true"]',
    );
    expect(checkboxIcons.length).toBeGreaterThanOrEqual(1);
  });
});

describe("NativeMessage tool-invocation routing to TodoToolPart", () => {
  afterEach(() => {
    cleanup();
  });

  test("routes TodoWrite tool-invocation to TodoToolPart", () => {
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "",
        toolName: "TodoWrite",
        toolState: "success",
        toolArgs: {
          todos: [
            { content: "First task", status: "completed" },
            { content: "Second task", status: "pending" },
          ],
        },
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // Should render the TodoToolPart with completion count
    expect(container.textContent).toContain("TodoWrite");
    expect(container.textContent).toContain("1/2 complete");
    expect(container.textContent).toContain("success");
  });

  test("routes todo_list tool-invocation to TodoToolPart with friendly label", () => {
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "",
        toolName: "todo_list",
        toolState: "success",
        toolArgs: {
          todos: [
            { content: "Check tests", status: "completed" },
            { content: "Fix bug", status: "pending" },
          ],
        },
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // Should render using TodoToolPart with "Todo List" label
    expect(container.textContent).toContain("Todo List");
    expect(container.textContent).not.toContain("todo_list");
    expect(container.textContent).toContain("1/2 complete");
  });

  test("routes TaskUpdate tool-invocation to TodoToolPart instead of raw JSON", () => {
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "",
        toolName: "TaskUpdate",
        toolState: "success",
        toolArgs: {
          taskId: "2",
          status: "completed",
        },
        toolOutput: "Updated task #2 status",
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(container.textContent).toContain("Task Update");
    expect(container.textContent).toContain("1/1 complete");
    expect(container.textContent).not.toContain('"taskId"');
    expect(container.textContent).not.toContain('"completed"');
  });

  test("routes TaskCreate tool-invocation to TodoToolPart with task rows", () => {
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "",
        toolName: "TaskCreate",
        toolState: "success",
        toolArgs: {
          tasks: [
            { id: "1", title: "Inspect renderer", status: "completed" },
            { id: "2", title: "Add tests", status: "pending" },
          ],
        },
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(container.textContent).toContain("Task Create");
    expect(container.textContent).toContain("1/2 complete");

    const trigger = screen.getByRole("button", { name: /Task Create/i });
    fireEvent.click(trigger);

    expect(container.textContent).toContain("#1 Inspect renderer");
    expect(container.textContent).toContain("#2 Add tests");
  });

  test("does not route non-todo tools to TodoToolPart", () => {
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "",
        toolName: "Read",
        toolState: "success",
        toolArgs: { file_path: "/workspace/test.ts" },
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // Should NOT render TodoToolPart completion count
    expect(container.textContent).not.toContain("complete");
    // Should render generic tool part with tool name
    expect(container.textContent).toContain("Read");
  });
});
