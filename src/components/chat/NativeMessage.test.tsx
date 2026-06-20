import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { mockWriteText } from "../../../tests/mocks/clipboard";

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

    const toolButton = screen.getByRole("button", { name: /run_command/i });
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

  test("displays bash tool invocations as run_command", () => {
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

    expect(screen.getByRole("button", { name: /run_command/i })).toBeTruthy();
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
