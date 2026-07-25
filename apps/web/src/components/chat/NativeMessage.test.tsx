import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../../tests/mocks/sonner";

import { NativeMessage } from "./NativeMessage";

function makeMessage(
  parts: Array<NativeMessagePart>,
  overrides?: Partial<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }>,
) {
  return {
    id: overrides?.id ?? "assistant-1",
    role: overrides?.role ?? ("assistant" as const),
    content: overrides?.content ?? "",
    createdAt: overrides?.createdAt ?? "2026-03-21T10:00:00.000Z",
    parts,
  };
}

describe("NativeMessage task list rendering", () => {
  afterEach(() => {
    cleanup();
    // Thinking expansion outlives unmount by design, so clear it between tests.
    useMessagePartExpansionStore.getState().reset();
    toastErrorMock.mockClear();
    toastSuccessMock.mockClear();
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

    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(container.textContent).toContain(
      "Let me analyze the code structure here",
    );
    // Collapsed preview is a single truncated line, not the expanded body
    expect(screen.getByRole("button", { name: /thinking/i })).toBeTruthy();
    expect(
      screen.getByText("Let me analyze the code structure here").className,
    ).toContain("truncate");
  });

  test("expands a long thinking part to show the full text", () => {
    const content =
      "First I inspect the reducer.\n\nThen I trace the dispatch path all the way through the bridge before deciding on a fix.";
    const message = makeMessage([{ type: "thinking", content }]);

    const { container } = render(<NativeMessage message={message} />);

    // Collapsed: whitespace is flattened into a single truncated preview line
    expect(container.textContent).toContain(
      "First I inspect the reducer. Then I trace the dispatch path",
    );

    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    // Expanded: the full text renders as markdown paragraphs
    expect(container.textContent).toContain("First I inspect the reducer.");
    expect(container.textContent).toContain(
      "Then I trace the dispatch path all the way through the bridge before deciding on a fix.",
    );
    expect(container.querySelectorAll("p").length).toBeGreaterThan(1);
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

  test("copies a user prompt and confirms it after a touch long press", async () => {
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {});
    const message = makeMessage(
      [
        { type: "text", content: "First part" },
        { type: "text", content: "Second part" },
      ],
      { role: "user", id: "user-1" },
    );

    render(<NativeMessage message={message} />);

    const prompt = screen.getByText("First part");
    fireEvent.pointerDown(prompt, {
      pointerType: "touch",
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 550));
    fireEvent.pointerUp(prompt, {
      pointerType: "touch",
      isPrimary: true,
      clientX: 20,
      clientY: 20,
    });

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("First part\n\nSecond part");
      expect(toastSuccessMock).toHaveBeenCalledWith("copied");
    });
  });

  test("falls back to message content when long-pressing a user prompt without text parts", async () => {
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {});
    const message = makeMessage([], {
      role: "user",
      id: "user-content-fallback",
      content: "Fallback prompt content",
    });

    render(<NativeMessage message={message} />);

    const prompt = screen.getByText("Fallback prompt content");
    fireEvent.pointerDown(prompt, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 7,
      clientX: 20,
      clientY: 20,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 550));
    fireEvent.pointerUp(prompt, {
      pointerType: "touch",
      isPrimary: true,
      pointerId: 7,
      clientX: 20,
      clientY: 20,
    });

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Fallback prompt content");
      expect(toastSuccessMock).toHaveBeenCalledWith("copied");
    });
  });

  test("reports clipboard failures from a user prompt long press", async () => {
    const clipboardError = new Error("clipboard denied");
    const consoleErrorMock = mock(() => {});
    const originalConsoleError = console.error;
    console.error = consoleErrorMock as typeof console.error;
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {
      throw clipboardError;
    });
    const message = makeMessage(
      [{ type: "text", content: "Prompt that cannot be copied" }],
      { role: "user", id: "user-copy-error" },
    );

    try {
      render(<NativeMessage message={message} />);

      const prompt = screen.getByText("Prompt that cannot be copied");
      fireEvent.pointerDown(prompt, {
        pointerType: "touch",
        isPrimary: true,
        pointerId: 8,
        clientX: 20,
        clientY: 20,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 550));
      fireEvent.pointerUp(prompt, {
        pointerType: "touch",
        isPrimary: true,
        pointerId: 8,
        clientX: 20,
        clientY: 20,
      });

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy message text");
      });
      expect(consoleErrorMock).toHaveBeenCalledWith(
        "[NativeMessage] Failed to copy user prompt:",
        clipboardError,
      );
      expect(toastSuccessMock).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("shows the response duration for an assistant reply to a user", () => {
    const previousMessage = makeMessage(
      [{ type: "text", content: "Question" }],
      {
        id: "user-duration-start",
        role: "user",
        createdAt: "2026-03-21T10:00:00.000Z",
      },
    );
    const message = makeMessage(
      [{ type: "text", content: "Answer" }],
      { createdAt: "2026-03-21T10:00:45.000Z" },
    );

    render(<NativeMessage message={message} previousMessage={previousMessage} />);

    expect(screen.getByText(/responded in 45s/)).toBeTruthy();
  });

  test("rounds a positive sub-second response duration up to one second", () => {
    const previousMessage = makeMessage([], {
      id: "user-subsecond-start",
      role: "user",
      createdAt: "2026-03-21T10:00:00.100Z",
    });
    const message = makeMessage([{ type: "text", content: "Fast answer" }], {
      createdAt: "2026-03-21T10:00:00.400Z",
    });

    render(<NativeMessage message={message} previousMessage={previousMessage} />);

    expect(screen.getByText(/responded in 1s/)).toBeTruthy();
  });

  test("omits response duration for equal, reversed, and invalid timestamps", () => {
    const cases = [
      {
        name: "equal",
        start: "2026-03-21T10:00:00.000Z",
        end: "2026-03-21T10:00:00.000Z",
      },
      {
        name: "reversed",
        start: "2026-03-21T10:00:01.000Z",
        end: "2026-03-21T10:00:00.000Z",
      },
      {
        name: "invalid start",
        start: "not-a-date",
        end: "2026-03-21T10:00:01.000Z",
      },
      {
        name: "invalid end",
        start: "2026-03-21T10:00:00.000Z",
        end: "not-a-date",
      },
    ];
    const first = cases[0]!;
    const { container, rerender } = render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: first.name }], {
          createdAt: first.end,
        })}
        previousMessage={makeMessage([], {
          id: `user-${first.name}`,
          role: "user",
          createdAt: first.start,
        })}
      />,
    );

    for (const durationCase of cases) {
      rerender(
        <NativeMessage
          message={makeMessage([{ type: "text", content: durationCase.name }], {
            createdAt: durationCase.end,
          })}
          previousMessage={makeMessage([], {
            id: `user-${durationCase.name}`,
            role: "user",
            createdAt: durationCase.start,
          })}
        />,
      );

      expect(container.textContent).not.toContain("responded in");
    }
  });

  test("formats durations at the minute boundary and across midnight", () => {
    const previousMessage = makeMessage([], {
      id: "user-minute-boundary",
      role: "user",
      createdAt: "2026-03-21T10:00:00.000Z",
    });
    const { rerender } = render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Minute answer" }], {
          createdAt: "2026-03-21T10:01:00.000Z",
        })}
        previousMessage={previousMessage}
      />,
    );

    expect(screen.getByText(/responded in 1m 0s/)).toBeTruthy();

    rerender(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Midnight answer" }], {
          createdAt: "2026-03-22T00:00:30.000Z",
        })}
        previousMessage={makeMessage([], {
          id: "user-midnight-boundary",
          role: "user",
          createdAt: "2026-03-21T23:59:30.000Z",
        })}
      />,
    );

    expect(screen.getByText(/responded in 1m 0s/)).toBeTruthy();
  });

  test("compacts only assistant continuations within the same calendar minute", () => {
    const previousMessage = makeMessage([{ type: "text", content: "First chunk" }], {
      id: "assistant-continuation-start",
      createdAt: "2026-03-21T10:00:10.000Z",
    });
    const { container, rerender } = render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Same-minute chunk" }], {
          createdAt: "2026-03-21T10:00:55.000Z",
        })}
        previousMessage={previousMessage}
      />,
    );

    expect(container.firstElementChild?.className).toContain("pt-0");
    expect(container.firstElementChild?.className).toContain("pb-3");

    rerender(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Next-minute chunk" }], {
          createdAt: "2026-03-21T10:01:00.000Z",
        })}
        previousMessage={makeMessage([], {
          id: "assistant-minute-boundary",
          createdAt: "2026-03-21T10:00:59.000Z",
        })}
      />,
    );

    expect(container.firstElementChild?.className).toContain("py-3");
    expect(container.firstElementChild?.className).not.toContain("pt-0");

    rerender(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Next-day chunk" }], {
          createdAt: "2026-03-22T00:00:01.000Z",
        })}
        previousMessage={makeMessage([], {
          id: "assistant-day-boundary",
          createdAt: "2026-03-21T23:59:59.000Z",
        })}
      />,
    );

    expect(container.firstElementChild?.className).toContain("py-3");
    expect(container.firstElementChild?.className).not.toContain("pt-0");
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
      screen.getByRole("button", { name: /regular thinking wrapper/i })
        .parentElement?.className,
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
    expect(container.textContent).toContain("Todo Write");
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

describe("NativeMessage thinking parts", () => {
  afterEach(() => {
    cleanup();
    useMessagePartExpansionStore.getState().reset();
  });

  test("renders nothing for a thinking part with no content", () => {
    const { container } = render(
      <NativeMessage message={makeMessage([{ type: "thinking", content: "" }])} />,
    );

    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
    expect(container.textContent).not.toContain("Thinking");
    // Not even the grouped activity block, which would paint an empty border.
    expect(container.querySelector(".rounded-lg.border")).toBeNull();
  });

  test("renders nothing for a thinking part that is only whitespace", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([{ type: "thinking", content: "   \n\n\t  " }])}
      />,
    );

    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
    expect(container.textContent).not.toContain("Thinking");
    expect(container.querySelector(".rounded-lg.border")).toBeNull();
  });

  test("keeps the activity block for real reasoning alongside an empty part", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([
          { type: "thinking", content: "" },
          { type: "thinking", content: "Real reasoning" },
        ])}
      />,
    );

    expect(container.querySelector(".rounded-lg.border")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /thinking/i }),
    ).toHaveLength(1);
  });

  test("keeps single newlines as visible line breaks in expanded reasoning", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([
          { type: "thinking", content: "first line\nsecond line" },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    // remark-breaks is enabled for prose reasoning, so the newline survives as
    // a <br> inside a single paragraph rather than being collapsed away.
    expect(container.querySelectorAll("br")).toHaveLength(1);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.textContent).toContain("second line");
  });

  test("disables line breaks for task-list reasoning so list syntax still parses", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([
          {
            type: "thinking",
            content: "Plan:\n- [x] Read the file\n- [ ] Write the fix",
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    // With remark-breaks on, the newlines would turn the list into one
    // paragraph of text instead of checkbox rows.
    expect(
      container.querySelectorAll('[data-task-list-icon="true"]'),
    ).toHaveLength(2);
    expect(container.querySelectorAll("br")).toHaveLength(0);
    expect(screen.getByText("Read the file").className).toContain(
      "line-through",
    );
  });

  test("detects numbered task list syntax for the collapsed preview", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([
          {
            type: "thinking",
            content: "1. [x] Inspect reducer\n2. [ ] Patch dispatch",
          },
        ])}
      />,
    );

    expect(container.textContent).toContain("task list");
    expect(container.textContent).not.toContain("Inspect reducer");

    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    expect(
      container.querySelectorAll('[data-task-list-icon="true"]'),
    ).toHaveLength(2);
  });

  test("keeps a thinking part expanded when the list unmounts and remounts it", () => {
    const message = makeMessage([
      { type: "thinking", content: "Long reasoning that the user opened" },
    ]);

    const first = render(<NativeMessage message={message} />);
    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));
    expect(
      screen.getByRole("button", { name: /thinking/i }).getAttribute("aria-expanded"),
    ).toBe("true");

    // The virtualized transcript unmounts a message once it scrolls out of the
    // viewport window; scrolling back must not collapse what the user opened.
    first.unmount();
    const { container } = render(<NativeMessage message={message} />);

    expect(
      screen.getByRole("button", { name: /thinking/i }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  test("tracks each thinking part separately within one message", () => {
    const message = makeMessage([
      { type: "thinking", content: "First reasoning block" },
      { type: "tool-invocation", content: "ls", toolName: "Bash", toolState: "success" },
      { type: "thinking", content: "Second reasoning block" },
    ]);

    render(<NativeMessage message={message} />);

    const triggers = screen.getAllByRole("button", { name: /reasoning block/i });
    expect(triggers).toHaveLength(2);

    fireEvent.click(triggers[0]!);

    expect(triggers[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(triggers[1]!.getAttribute("aria-expanded")).toBe("false");
  });

  test("tracks thinking parts of different messages independently", () => {
    render(
      <NativeMessage
        message={makeMessage([{ type: "thinking", content: "Message one reasoning" }], {
          id: "assistant-a",
        })}
      />,
    );
    render(
      <NativeMessage
        message={makeMessage([{ type: "thinking", content: "Message two reasoning" }], {
          id: "assistant-b",
        })}
      />,
    );

    // Capture both triggers first: expanding hides the preview text that
    // distinguishes them in the accessible name.
    const firstTrigger = screen.getByRole("button", {
      name: /message one reasoning/i,
    });
    const secondTrigger = screen.getByRole("button", {
      name: /message two reasoning/i,
    });

    fireEvent.click(firstTrigger);

    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("renders thinking rows inside their grouped tool block", () => {
    const message = makeMessage([
      { type: "thinking", content: "Deciding what to run" },
      {
        type: "tool-invocation",
        content: "ls",
        toolName: "Bash",
        toolState: "success",
        toolArgs: { command: "ls -la" },
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    const group = container.querySelector(".rounded-lg.border.border-zinc-700\\/70");
    expect(group).toBeTruthy();
    // Both activity parts render as children of the one grouped block.
    expect(group?.textContent).toContain("Deciding what to run");
    expect(group?.textContent).toContain("ls -la");
    expect(
      group?.querySelectorAll(":scope > * > button, :scope > button").length,
    ).toBeGreaterThan(1);
  });

  test("renders a thinking part supplied as a subagent child action", () => {
    const message = makeMessage([
      {
        type: "subagent",
        content: "Reviewer",
        subagentId: "agent-thinking",
        subagentName: "Reviewer",
        toolState: "pending",
        subagentActions: [
          { type: "thinking", content: "Child agent reasoning" },
          {
            type: "tool-invocation",
            content: "ls",
            toolName: "Bash",
            toolState: "success",
            toolArgs: { command: "ls -la" },
          },
        ],
      },
    ]);

    render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));

    const childTrigger = screen.getByRole("button", {
      name: /child agent reasoning/i,
    });
    fireEvent.click(childTrigger);

    expect(childTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(childTrigger.textContent).toContain("Thinking");
  });
});

describe("NativeMessage part routing and message-level fallbacks", () => {
  afterEach(() => {
    cleanup();
    useMessagePartExpansionStore.getState().reset();
  });

  test("renders nothing for tool-result parts", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([
          {
            type: "tool-result",
            content: "raw tool result payload",
            toolName: "Bash",
            toolState: "success",
            toolOutput: "raw tool result payload",
          },
        ])}
      />,
    );

    expect(container.textContent).not.toContain("raw tool result payload");
  });

  test("renders nothing for an unrecognised part type", () => {
    const message = makeMessage([
      { type: "mystery-part", content: "unknown payload" } as unknown as NativeMessagePart,
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(container.textContent).not.toContain("unknown payload");
  });

  test("renders no body and no copy control for an empty assistant message", () => {
    const { container } = render(
      <NativeMessage message={makeMessage([], { id: "assistant-empty", content: "" })} />,
    );

    expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
    expect(container.textContent).toContain("Assistant");
  });

  test("copies assistant message content when the message has no text parts", async () => {
    mockWriteText.mockClear();
    mockWriteText.mockImplementation(async () => {});
    const message = makeMessage(
      [{ type: "thinking", content: "internal reasoning" }],
      { id: "assistant-fallback", content: "Assistant fallback content" },
    );

    render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Assistant fallback content");
    });
  });
});

describe("NativeMessage agent status and grouping details", () => {
  afterEach(() => {
    cleanup();
    useMessagePartExpansionStore.getState().reset();
  });

  test("colours the agent status pill by state", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "subagent",
            content: "Runner",
            subagentId: "agent-running",
            subagentName: "Runner",
            toolState: "pending",
          },
          {
            type: "subagent",
            content: "Winner",
            subagentId: "agent-success",
            subagentName: "Winner",
            toolState: "success",
          },
          {
            type: "subagent",
            content: "Loser",
            subagentId: "agent-failure",
            subagentName: "Loser",
            toolState: "failure",
          },
        ])}
      />,
    );

    expect(screen.getByText("Running").className).toContain("border-amber-500/30");
    expect(screen.getByText("Success").className).toContain("border-emerald-500/30");
    expect(screen.getByText("Failed").className).toContain("border-red-500/30");
  });

  test("omits the running badge when every grouped agent has finished", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "subagent",
            content: "Winner",
            subagentId: "agent-success",
            subagentName: "Winner",
            toolState: "success",
          },
          {
            type: "subagent",
            content: "Loser",
            subagentId: "agent-failure",
            subagentName: "Loser",
            toolState: "failure",
          },
        ])}
      />,
    );

    expect(screen.getByRole("region", { name: "2 agents" })).toBeTruthy();
    expect(screen.queryByText(/running$/i)).toBeNull();
  });

  test("counts running agents across mixed subagent and task-group children", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "task-group",
            content: "Task reviewer",
            task: {
              type: "tool-invocation",
              content: "Task reviewer",
              toolUseId: "task-mixed",
              toolState: "pending",
            },
            childTools: [],
          },
          {
            type: "subagent",
            content: "Tester",
            subagentId: "agent-mixed",
            subagentName: "Tester",
            toolState: "success",
          },
        ])}
      />,
    );

    expect(screen.getByRole("region", { name: "2 agents" })).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
  });

  test("falls back to the generic subagent label with no name, role or content", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "subagent",
            content: "",
            subagentId: "agent-nameless",
            toolState: "pending",
          },
        ])}
      />,
    );

    expect(screen.getByText("subagent")).toBeTruthy();
  });

  test("uses singular tool-use wording for a standalone subagent with one external use", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "subagent",
            content: "Reviewer",
            subagentId: "agent-single-use",
            subagentName: "Reviewer",
            toolState: "pending",
            toolUseCount: 1,
          },
        ])}
      />,
    );

    expect(screen.getByText("1 tool use")).toBeTruthy();
  });

  test("ignores a blank subagent prompt instead of rendering an empty task block", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "subagent",
            content: "Reviewer",
            subagentId: "agent-blank-prompt",
            subagentName: "Reviewer",
            subagentPrompt: "",
            toolState: "pending",
            subagentActions: [],
          },
        ])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));

    expect(screen.queryByText("Task")).toBeNull();
    expect(screen.getByText("No child actions yet.")).toBeTruthy();
  });

  test("reads an agent role from the subagentType and role argument aliases", () => {
    const makeTaskGroup = (
      id: string,
      toolArgs: Record<string, unknown>,
    ): NativeMessagePart => ({
      type: "task-group",
      content: "Agent",
      task: {
        type: "tool-invocation",
        content: "Agent",
        toolName: "Agent",
        toolTitle: "Agent",
        toolUseId: id,
        toolState: "pending",
        toolArgs,
      },
      childTools: [],
    });

    render(
      <NativeMessage
        message={makeMessage([
          makeTaskGroup("task-camel", {
            description: "Camel case role",
            subagentType: "explorer",
          }),
          makeTaskGroup("task-role", {
            description: "Plain role key",
            role: "planner",
          }),
        ])}
      />,
    );

    expect(screen.getByText("Camel case role (explorer)")).toBeTruthy();
    expect(screen.getByText("Plain role key (planner)")).toBeTruthy();
  });

  test("omits the secondary header label when a named agent has no description", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "task-group",
            content: "Agent",
            task: {
              type: "tool-invocation",
              content: "Agent",
              toolName: "Agent",
              toolTitle: "Agent",
              toolState: "success",
              toolArgs: { agent_name: "Presentation Reviewer" },
            },
            childTools: [],
          },
        ])}
      />,
    );

    const label = screen.getByText("Presentation Reviewer");
    expect(label.parentElement?.textContent).toBe(
      "AgentPresentation ReviewerSuccess",
    );
  });

  test("treats every casing of the generic Task tool label as a subagent", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "task-group",
            content: "Task",
            task: {
              type: "tool-invocation",
              content: "Task",
              toolName: "Task",
              toolTitle: "Task",
              toolUseId: "task-upper",
              toolState: "pending",
            },
            childTools: [],
          },
        ])}
      />,
    );

    expect(screen.getByText("Subagent")).toBeTruthy();
    expect(screen.queryByText("Task")).toBeNull();
  });

  test("falls back to an update count when an external agent reports no token text", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "task-group",
            content: "Agent",
            task: {
              type: "tool-invocation",
              content: "Agent",
              toolName: "Agent",
              toolTitle: "Agent",
              toolState: "pending",
              toolUseCount: 4,
              toolArgs: { description: "Counting agent" },
            },
            childTools: [
              {
                type: "tool-invocation",
                content: "Read",
                toolName: "Read",
                toolState: "success",
                toolArgs: { file_path: "/workspace/a.ts" },
              },
            ],
          },
        ])}
      />,
    );

    expect(screen.getByText("4 tool uses")).toBeTruthy();
    expect(screen.getByText("1 update")).toBeTruthy();
  });
});
