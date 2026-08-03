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
    modelId: string;
  }>,
) {
  return {
    id: overrides?.id ?? "assistant-1",
    role: overrides?.role ?? ("assistant" as const),
    content: overrides?.content ?? "",
    createdAt: overrides?.createdAt ?? "2026-03-21T10:00:00.000Z",
    parts,
    ...(overrides?.modelId !== undefined ? { modelId: overrides.modelId } : {}),
  };
}

/** Mirrors `formatTime` in NativeMessage.tsx, which is module-private. */
function expectedTimeLabel(isoString: string): string {
  return new Date(isoString).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getClassTokens(element: Element | null | undefined): string[] {
  return element?.getAttribute("class")?.split(/\s+/).filter(Boolean) ?? [];
}

type NativeTaskGroupPart = Extract<NativeMessagePart, { type: "task-group" }>;
type NativeSubagentPart = Extract<NativeMessagePart, { type: "subagent" }>;

function makeAgentTaskGroupPart(
  overrides: Partial<Omit<NativeTaskGroupPart, "task">> & {
    task?: Partial<NativeTaskGroupPart["task"]>;
  } = {},
): NativeTaskGroupPart {
  return {
    type: "task-group",
    content: "Agent",
    childTools: [],
    ...overrides,
    task: {
      type: "tool-invocation",
      content: "Agent",
      toolName: "Agent",
      toolTitle: "Agent",
      toolState: "pending",
      ...overrides.task,
    },
  };
}

function makeStandaloneSubagentPart(
  overrides: Partial<NativeSubagentPart> = {},
): NativeSubagentPart {
  return {
    type: "subagent",
    content: "Reviewer",
    subagentName: "Reviewer",
    toolState: "pending",
    subagentActions: [],
    ...overrides,
  };
}

describe("NativeMessage assistant attribution", () => {
  test("shows the backend-confirmed model instead of the static provider label", () => {
    render(
      <NativeMessage
        message={makeMessage(
          [{ type: "text", content: "Done" }],
          { modelId: "gpt-5.6-sol" },
        )}
        assistantLabel="Codex"
      />,
    );

    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.queryByText("Codex")).toBeNull();
  });

  test("keeps the provider label for legacy messages with no confirmed model", () => {
    render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Done" }])}
        assistantLabel="Codex"
      />,
    );

    expect(screen.getByText("Codex")).toBeTruthy();
  });

  test.each(["", "   \n"])(
    "keeps the provider label for an unusable model id %#",
    (modelId) => {
      render(
        <NativeMessage
          message={makeMessage([{ type: "text", content: "Done" }], { modelId })}
          assistantLabel="Codex"
        />,
      );

      expect(screen.getByText("Codex")).toBeTruthy();
    },
  );

  test("uses a friendly catalog label when the tab supplies a resolver", () => {
    render(
      <NativeMessage
        message={makeMessage(
          [{ type: "text", content: "Done" }],
          { modelId: "anthropic/claude-sonnet-4" },
        )}
        assistantLabel="OpenCode"
        resolveModelLabel={() => "Claude Sonnet 4"}
      />,
    );

    expect(screen.getByText("Claude Sonnet 4").getAttribute("title"))
      .toBe("Claude Sonnet 4");
    expect(screen.queryByText("anthropic/claude-sonnet-4")).toBeNull();
  });

  test.each(["", "   \n"])(
    "falls back to the confirmed model id when the resolver returns an unusable label %#",
    (resolvedLabel) => {
      render(
        <NativeMessage
          message={makeMessage(
            [{ type: "text", content: "Done" }],
            { modelId: "anthropic/claude-sonnet-4" },
          )}
          assistantLabel="OpenCode"
          resolveModelLabel={() => resolvedLabel}
        />,
      );

      expect(screen.getByText("anthropic/claude-sonnet-4")).toBeTruthy();
      expect(screen.queryByText("OpenCode")).toBeNull();
    },
  );

  test("always attributes user messages to You even if they carry a model id", () => {
    render(
      <NativeMessage
        message={makeMessage(
          [{ type: "text", content: "Prompt" }],
          { role: "user", modelId: "gpt-5.6-sol" },
        )}
        assistantLabel="Codex"
      />,
    );

    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.queryByText("gpt-5.6-sol")).toBeNull();
  });

  test("hides the model label on an empty assistant message with no streamed content", () => {
    render(
      <NativeMessage
        message={makeMessage([], {
          id: "assistant-empty",
          modelId: "gpt-5.6-sol",
        })}
        resolveModelLabel={() => "GPT 5.6 Sol"}
      />,
    );

    expect(screen.queryByText("GPT 5.6 Sol")).toBeNull();
    expect(screen.queryByText("gpt-5.6-sol")).toBeNull();
  });

  test("renders nothing at all for an empty assistant message with no actions", () => {
    // Not just the label: the whole row goes, so the placeholder does not leave
    // an unexplained blank gap between the prompt and the reply.
    const { container } = render(
      <NativeMessage
        message={makeMessage([], {
          id: "assistant-empty-no-actions",
          modelId: "gpt-5.6-sol",
        })}
        resolveModelLabel={() => "GPT 5.6 Sol"}
      />,
    );

    expect(container.firstElementChild).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("hides the timestamp too, not only the model label, on an empty assistant message", () => {
    render(
      <NativeMessage
        message={makeMessage([{ type: "tool-result", content: "exit 0" }], {
          id: "assistant-empty-timestamp",
          modelId: "gpt-5.6-sol",
          createdAt: "2026-03-21T13:00:00.000Z",
        })}
        resolveModelLabel={() => "GPT 5.6 Sol"}
        actions={<button type="button">Fork</button>}
      />,
    );

    // The action keeps the row alive, but nothing attributes it.
    expect(screen.getByRole("button", { name: "Fork" })).toBeTruthy();
    expect(screen.queryByText("GPT 5.6 Sol")).toBeNull();
  });

  test("keeps a caller-supplied action reachable on a content-empty assistant message", () => {
    // `buildMessageForkActionKinds` can place a block's only "fork response"
    // action on a content-empty trailing row; suppressing the footer there
    // would strand the affordance for the whole exchange.
    render(
      <NativeMessage
        message={makeMessage([], {
          id: "assistant-empty-with-fork",
          modelId: "gpt-5.6-sol",
        })}
        resolveModelLabel={() => "GPT 5.6 Sol"}
        actions={<button type="button">Fork response</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Fork response" })).toBeTruthy();
    expect(screen.queryByText("GPT 5.6 Sol")).toBeNull();
  });

  test("shows attribution on a thinking-only assistant message", () => {
    render(
      <NativeMessage
        message={makeMessage([{ type: "thinking", content: "Reasoning" }], {
          id: "assistant-thinking-only",
          modelId: "gpt-5.6-sol",
        })}
        resolveModelLabel={() => "GPT 5.6 Sol"}
      />,
    );

    expect(screen.getByText("GPT 5.6 Sol")).toBeTruthy();
  });

  test("repeats the model label when a same-minute continuation switched model", () => {
    // Suppressing attribution here would render Sonnet's output under Opus's
    // label — the one thing the reader cannot infer from the row above.
    const previousContent = makeMessage([{ type: "text", content: "First chunk" }], {
      id: "assistant-opus",
      modelId: "opus-5",
    });
    render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Second chunk" }], {
          id: "assistant-sonnet",
          modelId: "sonnet-5",
        })}
        previousMessage={previousContent}
        resolveModelLabel={(modelId) =>
          modelId === "opus-5" ? "Opus 5" : "Sonnet 5"}
      />,
    );

    expect(screen.getByText("Sonnet 5")).toBeTruthy();
  });

  test("shows the model label on the first content-bearing message of a block", () => {
    // An info-only empty message precedes the streamed content in the same
    // minute; the empty block stays unlabeled and attribution lands once. The
    // timestamps are pinned to the same minute so the continuation branch is
    // genuinely exercised rather than trivially skipped.
    const emptyPrevious = makeMessage([], {
      id: "assistant-empty-before-content",
      modelId: "gpt-5.6-sol",
      createdAt: "2026-03-21T10:00:10.000Z",
    });
    render(
      <NativeMessage
        message={makeMessage(
          [{ type: "text", content: "Streamed answer" }],
          {
            id: "assistant-content",
            modelId: "gpt-5.6-sol",
            createdAt: "2026-03-21T10:00:40.000Z",
          },
        )}
        previousMessage={emptyPrevious}
        resolveModelLabel={() => "GPT 5.6 Sol"}
      />,
    );

    expect(screen.getByText("GPT 5.6 Sol")).toBeTruthy();
    expect(screen.getAllByText("GPT 5.6 Sol")).toHaveLength(1);
  });

  test("drops the model label on same-minute assistant continuations", () => {
    const previousContent = makeMessage([{ type: "text", content: "First chunk" }], {
      id: "assistant-content-start",
      modelId: "gpt-5.6-sol",
      createdAt: "2026-03-21T10:00:10.000Z",
    });
    render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Second chunk" }], {
          id: "assistant-content-continuation",
          modelId: "gpt-5.6-sol",
          createdAt: "2026-03-21T10:00:40.000Z",
        })}
        previousMessage={previousContent}
        resolveModelLabel={() => "GPT 5.6 Sol"}
      />,
    );

    // The continuation keeps its timestamp row but must not repeat the model.
    expect(screen.queryByText("GPT 5.6 Sol")).toBeNull();
    expect(screen.getByText(expectedTimeLabel("2026-03-21T10:00:40.000Z"))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy text" })).toBeTruthy();
  });

  test("anchors attribution and duration on the user after an empty info block", () => {
    // Transcript owners resolve previousMessage to the nearest content-bearing
    // message, so the first real content after `user → empty info → content`
    // renders the model label once and keeps the response duration that the
    // empty placeholder would otherwise have swallowed.
    const userMessage = makeMessage([{ type: "text", content: "Question" }], {
      id: "user-block-anchor",
      role: "user",
      createdAt: "2026-03-21T10:00:00.000Z",
    });
    render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Answer" }], {
          id: "assistant-content-after-empty",
          modelId: "gpt-5.6-sol",
          createdAt: "2026-03-21T10:00:45.000Z",
        })}
        previousMessage={userMessage}
        resolveModelLabel={() => "GPT 5.6 Sol"}
      />,
    );

    expect(screen.getAllByText("GPT 5.6 Sol")).toHaveLength(1);
    expect(screen.getByText(/responded in 45s/)).toBeTruthy();
  });
});

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

  test("truncates a long model label without making response metadata shrink", () => {
    const previousMessage = makeMessage([], {
      id: "user-long-model",
      role: "user",
      createdAt: "2026-03-21T10:00:00.000Z",
    });
    const modelId = "anthropic/claude-sonnet-4-5-20250929-with-a-long-suffix";
    render(
      <div className="w-48">
        <NativeMessage
          message={makeMessage([{ type: "text", content: "Answer" }], {
            createdAt: "2026-03-21T10:01:03.000Z",
            modelId,
          })}
          previousMessage={previousMessage}
        />
      </div>,
    );

    expect(screen.getByText(modelId).className).toContain("truncate");
    expect(screen.getByText(/responded in 1m 3s/).className)
      .toContain("whitespace-nowrap");
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

  test("survives a platform time formatter failure", () => {
    const original = Date.prototype.toLocaleTimeString;
    Date.prototype.toLocaleTimeString = function failingFormatter() {
      throw new RangeError("formatter unavailable");
    };
    try {
      render(
        <NativeMessage
          message={makeMessage([{ type: "text", content: "Still rendered" }])}
        />,
      );
      expect(screen.getByText("Still rendered")).toBeTruthy();
    } finally {
      Date.prototype.toLocaleTimeString = original;
    }
  });

  test("treats date comparison failures as separate assistant messages", () => {
    const original = Date.prototype.getTime;
    Date.prototype.getTime = function failingGetTime() {
      throw new RangeError("date unavailable");
    };
    try {
      render(
        <NativeMessage
          message={makeMessage(
            [{ type: "text", content: "Second answer" }],
            { id: "assistant-after-date-error" },
          )}
          previousMessage={makeMessage(
            [{ type: "text", content: "First answer" }],
            { id: "assistant-before-date-error" },
          )}
        />,
      );
      expect(screen.getByText(/Assistant/)).toBeTruthy();
    } finally {
      Date.prototype.getTime = original;
    }
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

  test("shows the derived command beside a custom exec tool", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "exec",
          toolName: "exec",
          toolArgs: {
            input: "const r = await tools.exec_command({ cmd: \"git status --short\" });",
            command: "git status --short",
          },
          toolState: "success",
        }])}
      />,
    );

    expect(screen.getByRole("button", {
      name: /Exec git status --short success/i,
    })).toBeTruthy();
  });

  test("previews raw custom-tool input when no command can be derived", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "exec",
          toolName: "exec",
          toolArgs: { input: "const result = await tools.some_custom_action();" },
          toolState: "success",
        }])}
      />,
    );

    expect(screen.getByRole("button", {
      name: /Exec const result = await tools\.some_custom_action\(\); success/i,
    })).toBeTruthy();
  });

  test.each([
    ["file_path", { file_path: "/repo/src/deep/example.ts" }, "example.ts"],
    ["file_path with no directory", { file_path: "example.ts" }, "example.ts"],
    ["pattern", { pattern: "**/*.tsx" }, "**/*.tsx"],
    ["regex", { regex: "function\\s+\\w+" }, "function\\s+\\w+"],
    ["url", { url: "https://example.test/a/b?c=d" }, "example.test"],
    ["malformed url", { url: "not a url" }, "not a url"],
    ["query", { query: "how to configure vite" }, "how to configure vite"],
  ])("summarizes %s in the collapsed row", (_label, toolArgs, expected) => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "tool",
          toolName: "tool",
          toolArgs,
          toolState: "success",
        }])}
      />,
    );

    expect(container.textContent).toContain(expected);
  });

  test("prefers a command over every other collapsed-row summary", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "tool",
          toolName: "tool",
          toolArgs: { command: "ls -la", file_path: "/repo/a.ts", query: "unused" },
          toolState: "success",
        }])}
      />,
    );

    const row = screen.getByRole("button", { name: /ls -la/i });
    expect(row.textContent).not.toContain("a.ts");
    expect(container.textContent).not.toContain("unused");
  });

  test("keeps a descriptive tool title alongside a raw-input preview", () => {
    // The raw-input fallback is generic, so it must not displace a title that
    // says which server the tool came from.
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "query_docs",
          toolName: "query_docs",
          toolTitle: "context7:query_docs",
          toolArgs: { input: "how do I configure routing" },
          toolState: "success",
        }])}
      />,
    );

    const row = screen.getByRole("button", { name: /context7:query_docs/i });
    expect(row.textContent).toContain("how do I configure routing");
  });

  test("lets a specific command displace the tool title", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "exec",
          toolName: "exec",
          toolTitle: "functions:exec",
          toolArgs: { input: "tools.exec_command({cmd:'ls'})", command: "ls" },
          toolState: "success",
        }])}
      />,
    );

    const row = screen.getByRole("button", { name: /Exec ls success/i });
    expect(row.textContent).not.toContain("functions:exec");
  });

  test("flattens and caps an oversized command in the collapsed row", () => {
    const command = `echo ${"a".repeat(400)}\n\n\tsecond line`;
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "exec",
          toolName: "exec",
          toolArgs: { command },
          toolState: "success",
        }])}
      />,
    );

    const row = screen.getByRole("button", { name: /Exec echo a+…/i });
    const preview = row.textContent ?? "";
    expect(preview).toContain("…");
    expect(preview).not.toContain("\n");
    // 180-char cap plus the tool name and state labels around it.
    expect(preview.length).toBeLessThan(220);
  });

  test("collapses interior whitespace in a raw-input preview", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "exec",
          toolName: "exec",
          toolArgs: { input: "  const a = 1;\n\n\tconst b = 2;  " },
          toolState: "success",
        }])}
      />,
    );

    expect(screen.getByRole("button", {
      name: /Exec const a = 1; const b = 2; success/i,
    })).toBeTruthy();
  });

  test("keeps the full exec source visible when the row is expanded", () => {
    const input = `const r = await tools.exec_command({ cmd: "${"echo hi; ".repeat(40)}" });`;
    const { container } = render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "exec",
          toolName: "exec",
          // `command` is a capped label; the authoritative source is `input`.
          toolArgs: { input, command: "echo hi; echo hi;…" },
          toolState: "success",
        }])}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Exec/i }));
    expect(container.textContent).toContain(input);
    expect(container.textContent).toContain("$ echo hi; echo hi;…");
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

  test("does not render an empty tool group shell", () => {
    const message = makeMessage([
      { type: "text", content: "Before tools" },
      {
        type: "tool-group",
        content: "",
        parts: [],
      },
      { type: "text", content: "After tools" },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    expect(container.textContent).toContain("Before tools");
    expect(container.textContent).toContain("After tools");
    expect(container.querySelector(".border-zinc-700\\/70")).toBeNull();
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
    expect(screen.getByText("Active")).toBeTruthy();
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
    expect(screen.getByText("Finished")).toBeTruthy();
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

  test("uses the response fallback for a whitespace-only latest text update", () => {
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
        childTools: [
          {
            type: "text",
            content: "  \n\t  ",
          },
        ],
      },
    ]);

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Response")).toBeTruthy();
    expect(screen.queryByText("Waiting for activity.")).toBeNull();
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
    const message = makeMessage(
      [
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
      ],
      { modelId: "gpt-5.6-sol" },
    );

    render(<NativeMessage message={message} />);

    const agentGroup = screen.getByRole("region", { name: "2 agents" });
    const modelLabel = screen.getByText("gpt-5.6-sol");

    expect(agentGroup).toBeTruthy();
    expect(screen.getByText("Agents")).toBeTruthy();
    expect(screen.getByText("1 active")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Tester")).toBeTruthy();
    expect(screen.getAllByText("gpt-5.6-sol")).toHaveLength(1);
    expect(
      agentGroup.compareDocumentPosition(modelLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("counts pending task children and undefined states as active but not terminal agents", () => {
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
    expect(screen.getByText("2 active")).toBeTruthy();
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
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

  test("keeps an expanded agent open when its virtualized row remounts", () => {
    const message = makeMessage([
      {
        type: "subagent",
        content: "Reviewer",
        subagentId: "agent-remount",
        subagentName: "Reviewer",
        subagentPrompt: "Inspect the streaming transcript",
        toolState: "pending",
        subagentActions: [],
      },
    ]);

    const first = render(<NativeMessage message={message} />);
    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));
    expect(
      screen.getByRole("button", { name: /reviewer/i }).getAttribute("aria-expanded"),
    ).toBe("true");

    first.unmount();
    render(<NativeMessage message={message} />);

    const remountedTrigger = screen.getByRole("button", { name: /reviewer/i });
    expect(remountedTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Inspect the streaming transcript")).toBeTruthy();

    fireEvent.click(remountedTrigger);
    expect(remountedTrigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("isolates matching standalone agent ids between messages", () => {
    render(
      <>
        <NativeMessage
          message={makeMessage(
            [makeStandaloneSubagentPart({
              content: "First reviewer",
              subagentId: "shared-agent-id",
              subagentName: "First reviewer",
            })],
            { id: "assistant-first-agent" },
          )}
        />
        <NativeMessage
          message={makeMessage(
            [makeStandaloneSubagentPart({
              content: "Second reviewer",
              subagentId: "shared-agent-id",
              subagentName: "Second reviewer",
            })],
            { id: "assistant-second-agent" },
          )}
        />
      </>,
    );

    const first = screen.getByRole("button", { name: /first reviewer/i });
    const second = screen.getByRole("button", { name: /second reviewer/i });
    fireEvent.click(first);

    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");
  });

  test("isolates matching message and agent ids between containers", () => {
    render(
      <>
        <NativeMessage
          message={makeMessage(
            [makeStandaloneSubagentPart({
              content: "First container reviewer",
              subagentId: "shared-container-agent",
              subagentName: "First container reviewer",
            })],
            { id: "shared-container-message" },
          )}
          containerId="container-a"
        />
        <NativeMessage
          message={makeMessage(
            [makeStandaloneSubagentPart({
              content: "Second container reviewer",
              subagentId: "shared-container-agent",
              subagentName: "Second container reviewer",
            })],
            { id: "shared-container-message" },
          )}
          containerId="container-b"
        />
      </>,
    );

    const first = screen.getByRole("button", {
      name: /first container reviewer/i,
    });
    const second = screen.getByRole("button", {
      name: /second container reviewer/i,
    });
    fireEvent.click(first);

    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");
  });

  test("isolates matching message and agent ids between explicit transcript scopes", () => {
    render(
      <>
        <NativeMessage
          message={makeMessage(
            [makeStandaloneSubagentPart({
              content: "First scoped reviewer",
              subagentId: "shared-scoped-agent",
              subagentName: "First scoped reviewer",
            })],
            { id: "shared-scoped-message" },
          )}
          agentExpansionScope="transcript-a"
        />
        <NativeMessage
          message={makeMessage(
            [makeStandaloneSubagentPart({
              content: "Second scoped reviewer",
              subagentId: "shared-scoped-agent",
              subagentName: "Second scoped reviewer",
            })],
            { id: "shared-scoped-message" },
          )}
          agentExpansionScope="transcript-b"
        />
      </>,
    );

    const first = screen.getByRole("button", { name: /first scoped reviewer/i });
    const second = screen.getByRole("button", { name: /second scoped reviewer/i });
    fireEvent.click(first);

    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");
  });

  test("keeps agent expansion open when a container id resolves after mount", () => {
    const message = makeMessage(
      [makeStandaloneSubagentPart({
        subagentId: "late-container-agent",
        subagentName: "Late container reviewer",
      })],
      { id: "late-container-message" },
    );
    const view = render(<NativeMessage message={message} />);
    const trigger = screen.getByRole("button", {
      name: /late container reviewer/i,
    });

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    view.rerender(<NativeMessage message={message} containerId="container-1" />);

    expect(
      screen.getByRole("button", { name: /late container reviewer/i })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  test("isolates id-less task agents with the same generic tool fallback between messages", () => {
    render(
      <>
        <NativeMessage
          message={makeMessage(
            [makeAgentTaskGroupPart({
              task: {
                toolUseId: undefined,
                subagentId: undefined,
                toolName: "Agent",
                toolArgs: { description: "First task agent" },
              },
            })],
            { id: "assistant-first-task" },
          )}
        />
        <NativeMessage
          message={makeMessage(
            [makeAgentTaskGroupPart({
              task: {
                toolUseId: undefined,
                subagentId: undefined,
                toolName: "Agent",
                toolArgs: { description: "Second task agent" },
              },
            })],
            { id: "assistant-second-task" },
          )}
        />
      </>,
    );

    const first = screen.getByRole("button", { name: /first task agent/i });
    const second = screen.getByRole("button", { name: /second task agent/i });
    fireEvent.click(first);

    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");
  });

  test("isolates id-less task agents within one message by part position", () => {
    render(
      <NativeMessage
        message={makeMessage([
          makeAgentTaskGroupPart({
            task: {
              toolUseId: undefined,
              subagentId: undefined,
              toolName: "Agent",
              toolArgs: { description: "First positional task" },
            },
          }),
          makeAgentTaskGroupPart({
            task: {
              toolUseId: undefined,
              subagentId: undefined,
              toolName: "Agent",
              toolArgs: { description: "Second positional task" },
            },
          }),
        ])}
      />,
    );

    const first = screen.getByRole("button", { name: /first positional task/i });
    const second = screen.getByRole("button", { name: /second positional task/i });
    fireEvent.click(first);

    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");
  });

  test("keeps an expanded task agent open when its virtualized row remounts", () => {
    const message = makeMessage(
      [makeAgentTaskGroupPart({
        task: {
          toolUseId: "task-remount",
          toolArgs: {
            description: "Remount reviewer",
            prompt: "Inspect the task-group transcript",
          },
        },
      })],
      { id: "assistant-task-remount" },
    );

    const first = render(<NativeMessage message={message} />);
    fireEvent.click(screen.getByRole("button", { name: /remount reviewer/i }));
    expect(screen.getByText("Inspect the task-group transcript")).toBeTruthy();

    first.unmount();
    render(<NativeMessage message={message} />);

    const remountedTrigger = screen.getByRole("button", {
      name: /remount reviewer/i,
    });
    expect(remountedTrigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Inspect the task-group transcript")).toBeTruthy();
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

  test("forwards the backend task snapshot to TodoToolPart", () => {
    // Without this the part renders from its own args and the whole snapshot
    // path is silently dead.
    const message = makeMessage([
      {
        type: "tool-invocation",
        content: "",
        toolName: "TaskUpdate",
        toolState: "success",
        toolArgs: { taskId: "2", status: "in_progress" },
        toolOutput: "Updated task #2 status",
        taskSnapshot: {
          items: [
            { id: "1", subject: "From the snapshot", status: "completed" },
            { id: "2", subject: "Also from the snapshot", status: "in_progress" },
          ],
          complete: true,
          changedTaskId: "2",
        },
      },
    ]);

    const { container } = render(<NativeMessage message={message} />);

    // The list, not the single task the call named.
    expect(container.textContent).toContain("1/2 complete");

    fireEvent.click(screen.getByRole("button", { name: /Task Update/i }));
    expect(container.textContent).toContain("From the snapshot");
    expect(container.textContent).toContain("Also from the snapshot");
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

  test("shows a background command's description and authoritative lifecycle state", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: {
            command: "bun test",
            description: "Run the full suite",
            run_in_background: true,
          },
          backgroundTask: {
            id: "bg-suite",
            description: "Run the full suite",
            status: "running",
          },
        }])}
      />,
    );

    const row = screen.getByRole("button", {
      name: /Run Command Run the full suite running/,
    });
    expect(row).toBeTruthy();
    expect(row.textContent).not.toContain("success");
  });

  test("shows the task name, id, and stopped state on TaskStop rows", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "TaskStop",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-wait" },
          toolOutput: JSON.stringify({
            task_id: "bg-wait",
            command: "sleep 300; echo waited",
          }),
          backgroundTask: {
            id: "bg-wait",
            description: "Wait for remaining review thread",
            status: "killed",
          },
        }])}
      />,
    );

    expect(screen.getByRole("button", {
      name: /TaskStop Wait for remaining review thread bg-wait stopped/,
    })).toBeTruthy();
  });

  test("reads the stopped command from a structured TaskStop result when no name was recovered", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "TaskStop",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-legacy" },
          toolOutput: JSON.stringify({
            message: "Successfully stopped task: bg-legacy (sleep 120; echo waited)",
            task_id: "bg-legacy",
            task_type: "bash",
            command: "sleep 120; echo waited",
          }),
        }])}
      />,
    );

    expect(screen.getByRole("button", {
      name: /TaskStop sleep 120; echo waited bg-legacy stopped/,
    })).toBeTruthy();
  });

  test("recovers the stopped command from a legacy plain-text TaskStop result", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "TaskStop",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-legacy" },
          toolOutput: "Successfully stopped task: bg-legacy (sleep 120; echo waited)",
        }])}
      />,
    );

    expect(screen.getByRole("button", {
      name: /TaskStop sleep 120; echo waited bg-legacy stopped/,
    })).toBeTruthy();
  });

  test("falls back to the task id when nothing names a stopped task", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "TaskStop",
          toolName: "TaskStop",
          toolState: "success",
          toolArgs: { task_id: "bg-orphan" },
        }])}
      />,
    );

    const row = screen.getByRole("button", { name: /TaskStop bg-orphan stopped/ });
    // The id is the row's only label here, so the secondary id chip must not
    // repeat it.
    expect(row.textContent?.match(/bg-orphan/g)).toHaveLength(1);
  });

  test("names a TaskOutput row after its task and shows the task's live state", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "TaskOutput",
          toolName: "TaskOutput",
          toolState: "success",
          toolArgs: { task_id: "bg-suite" },
          toolOutput: "…partial output…",
          backgroundTask: {
            id: "bg-suite",
            description: "Run the full suite",
            status: "running",
          },
        }])}
      />,
    );

    const row = screen.getByRole("button", {
      name: /TaskOutput Run the full suite bg-suite running/,
    });
    expect(row.textContent).not.toContain("success");
  });

  test.each([
    ["pending", "running…"],
    ["running", "running…"],
    ["paused", "paused"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["killed", "stopped"],
  ] as const)(
    "labels a background command whose task is %s as %s",
    (status, label) => {
      render(
        <NativeMessage
          message={makeMessage([{
            type: "tool-invocation",
            content: "Bash",
            toolName: "Bash",
            toolState: "success",
            toolArgs: {
              command: "bun test",
              description: "Run the full suite",
              run_in_background: true,
            },
            backgroundTask: { id: "bg-suite", description: "Run the full suite", status },
          }])}
        />,
      );

      const row = screen.getByRole("button", { name: /Run Command Run the full suite/ });
      expect(row.textContent).toContain(label);
      expect(row.textContent).not.toContain("success");
    },
  );

  test("shows a failed task action instead of the task's own lifecycle state", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "TaskStop",
          toolName: "TaskStop",
          toolState: "failure",
          toolArgs: { task_id: "bg-suite" },
          toolError: "Task bg-suite is not running (status: completed)",
          backgroundTask: {
            id: "bg-suite",
            description: "Run the full suite",
            status: "completed",
          },
        }])}
      />,
    );

    const row = screen.getByRole("button", { name: /TaskStop Run the full suite bg-suite/ });
    expect(row.textContent).toContain("failure");
    expect(row.textContent).not.toContain("completed");
  });

  test("labels an in-flight stop as stopping", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "TaskStop",
          toolName: "TaskStop",
          toolState: "pending",
          toolArgs: { task_id: "bg-suite" },
        }])}
      />,
    );

    const row = screen.getByRole("button", { name: /TaskStop bg-suite stopping/ });
    expect(row.textContent).not.toContain("running...");
  });

  test("renders a task description as prose and a command as code", () => {
    const { unmount } = render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: {
            command: "bun test",
            description: "Run the full suite",
            run_in_background: true,
          },
          backgroundTask: { id: "bg-suite", description: "Run the full suite", status: "running" },
        }])}
      />,
    );

    expect(screen.getByText("Run the full suite").className).not.toContain("font-mono");
    unmount();

    render(
      <NativeMessage
        message={makeMessage([{
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolState: "success",
          toolArgs: { command: "bun test", description: "Run the full suite" },
        }])}
      />,
    );

    expect(screen.getByText("bun test").className).toContain("font-mono");
  });

  test.each(["task_stop", " TaskStop "] as const)(
    "treats %s as a background task stop row",
    (toolName) => {
      render(
        <NativeMessage
          message={makeMessage([{
            type: "tool-invocation",
            content: toolName,
            toolName,
            toolState: "success",
            toolArgs: { taskId: "bg-suite" },
            backgroundTask: {
              id: "bg-suite",
              description: "Run the full suite",
              status: "killed",
            },
          }])}
        />,
      );

      expect(screen.getByRole("button", {
        name: /Run the full suite bg-suite stopped/,
      })).toBeTruthy();
    },
  );
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

  test("renders no body, no attribution, and no copy control for an empty assistant message", () => {
    const { container } = render(
      <NativeMessage message={makeMessage([], { id: "assistant-empty", content: "" })} />,
    );

    expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
    // An info-only message with no streamed content must not carry a dangling
    // model attribution; the label appears only once real content lands.
    expect(container.textContent).not.toContain("Assistant");
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

    expect(screen.getByText("Active").className).toContain("border-amber-500/30");
    expect(screen.getByText("Finished").className).toContain("border-emerald-500/30");
    expect(screen.getByText("Failed").className).toContain("border-red-500/30");
  });

  test("keeps successful terminal agents finished despite stale pending descendants", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "task-group",
            content: "Task reviewer",
            task: {
              type: "tool-invocation",
              content: "Task reviewer",
              toolUseId: "task-active-child",
              toolState: "success",
            },
            childTools: [
              {
                type: "tool-invocation",
                content: "Run tests",
                toolName: "Bash",
                toolState: "pending",
              },
            ],
          },
          {
            type: "subagent",
            content: "Transcript reviewer",
            subagentId: "agent-active-child",
            toolState: "success",
            subagentActions: [
              {
                type: "tool-invocation",
                content: "Inspect files",
                toolName: "Read",
                toolState: "pending",
              },
            ],
          },
        ])}
      />,
    );

    expect(screen.queryByText(/active$/i)).toBeNull();
    expect(screen.getAllByText("Finished")).toHaveLength(2);
  });

  test("prefers authoritative agent lifecycle over a successful launch tool", () => {
    render(
      <NativeMessage
        message={makeMessage([{
          type: "subagent",
          content: "Background reviewer",
          toolState: "success",
          agentState: "active",
          subagentActions: [],
        }])}
      />,
    );

    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.getByText("Waiting for activity.")).toBeTruthy();
  });

  test("renders an authoritative agent failure even when the launch tool succeeded", () => {
    render(
      <NativeMessage
        message={makeMessage([
          {
            type: "subagent",
            content: "Background reviewer",
            subagentId: "authoritative-failure",
            toolState: "success",
            agentState: "failed",
            subagentActions: [],
          },
          {
            type: "subagent",
            content: "Legacy reviewer",
            subagentId: "legacy-failure",
            toolState: "failure",
            subagentActions: [],
          },
        ])}
      />,
    );

    expect(screen.getAllByText("Failed")).toHaveLength(2);
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.getAllByText("No activity captured.")).toHaveLength(2);
  });

  test("expands standalone agents whose identity uses fallback fields", () => {
    const { rerender } = render(
      <NativeMessage
        message={makeMessage([
          {
            type: "subagent",
            content: "",
            toolState: "pending",
            subagentActions: [],
          },
        ], { id: "fallback-subagent" })}
      />,
    );

    const subagentTrigger = screen.getByRole("button", {
      name: /subagent active/i,
    });
    expect(subagentTrigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(subagentTrigger);
    expect(subagentTrigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(subagentTrigger);
    expect(subagentTrigger.getAttribute("aria-expanded")).toBe("false");

    rerender(
      <NativeMessage
        message={makeMessage([
          {
            type: "task-group",
            content: "",
            task: {
              type: "tool-invocation",
              content: "",
              toolState: "pending",
            },
            childTools: [],
          },
        ], { id: "fallback-task-group" })}
      />,
    );

    const taskTrigger = screen.getByRole("button", {
      name: /subagent active/i,
    });
    expect(taskTrigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(taskTrigger);
    expect(taskTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  const taskExpansionIdentityCases: Array<[
    string,
    NativeTaskGroupPart,
    RegExp,
  ]> = [
    [
      "tool-use id",
      makeAgentTaskGroupPart({
        task: {
          toolUseId: "task-tool-use-identity",
          toolArgs: { description: "Tool-use identity task" },
        },
      }),
      /tool-use identity task/i,
    ],
    [
      "subagent id",
      makeAgentTaskGroupPart({
        task: {
          toolUseId: undefined,
          subagentId: "task-subagent-identity",
          toolArgs: { description: "Subagent identity task" },
        },
      }),
      /subagent identity task/i,
    ],
    [
      "tool name",
      makeAgentTaskGroupPart({
        task: {
          toolUseId: undefined,
          subagentId: undefined,
          toolName: "ReviewerTool",
          toolTitle: "ReviewerTool",
        },
      }),
      /reviewertool/i,
    ],
    [
      "part content",
      makeAgentTaskGroupPart({
        content: "Content identity task",
        task: {
          toolUseId: undefined,
          subagentId: undefined,
          toolName: undefined,
          toolArgs: { description: "Content-keyed task" },
        },
      }),
      /content-keyed task/i,
    ],
    [
      "generic default",
      makeAgentTaskGroupPart({
        content: undefined as unknown as string,
        task: {
          toolUseId: undefined,
          subagentId: undefined,
          toolName: undefined,
          toolArgs: { description: "Default-keyed task" },
        },
      }),
      /default-keyed task/i,
    ],
  ];

  test.each(taskExpansionIdentityCases)(
    "persists task-agent expansion with %s input across a remount",
    (identityName, part, triggerName) => {
      const message = makeMessage([part], {
        id: `assistant-task-identity-${identityName.replaceAll(" ", "-")}`,
      });
      const first = render(<NativeMessage message={message} />);
      fireEvent.click(screen.getByRole("button", { name: triggerName }));

      first.unmount();
      render(<NativeMessage message={message} />);

      expect(
        screen.getByRole("button", { name: triggerName }).getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
    },
  );

  const subagentExpansionIdentityCases: Array<[
    string,
    NativeSubagentPart,
    RegExp,
  ]> = [
    [
      "subagent id",
      makeStandaloneSubagentPart({
        subagentId: "standalone-subagent-identity",
        subagentName: "Subagent-id reviewer",
      }),
      /subagent-id reviewer/i,
    ],
    [
      "tool-use id",
      makeStandaloneSubagentPart({
        subagentId: undefined,
        toolUseId: "standalone-tool-use-identity",
        subagentName: "Tool-use reviewer",
      }),
      /tool-use reviewer/i,
    ],
    [
      "subagent name",
      makeStandaloneSubagentPart({
        subagentId: undefined,
        toolUseId: undefined,
        subagentName: "Named identity reviewer",
      }),
      /named identity reviewer/i,
    ],
    [
      "part content",
      makeStandaloneSubagentPart({
        content: "Content identity reviewer",
        subagentId: undefined,
        toolUseId: undefined,
        subagentName: undefined,
        subagentRole: "Content-keyed reviewer",
      }),
      /content-keyed reviewer/i,
    ],
    [
      "generic default",
      makeStandaloneSubagentPart({
        content: undefined as unknown as string,
        subagentId: undefined,
        toolUseId: undefined,
        subagentName: undefined,
        subagentRole: "Default-keyed reviewer",
      }),
      /default-keyed reviewer/i,
    ],
  ];

  test.each(subagentExpansionIdentityCases)(
    "persists standalone-agent expansion with %s input across a remount",
    (identityName, part, triggerName) => {
      const message = makeMessage([part], {
        id: `assistant-subagent-identity-${identityName.replaceAll(" ", "-")}`,
      });
      const first = render(<NativeMessage message={message} />);
      fireEvent.click(screen.getByRole("button", { name: triggerName }));

      first.unmount();
      render(<NativeMessage message={message} />);

      expect(
        screen.getByRole("button", { name: triggerName }).getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
    },
  );

  test("uses the response fallback for standalone whitespace text and omits a whitespace prompt", () => {
    render(
      <NativeMessage
        message={makeMessage([
          makeStandaloneSubagentPart({
            subagentId: "agent-whitespace-text",
            subagentName: "Whitespace reviewer",
            subagentPrompt: "  \n\t  ",
            subagentActions: [{ type: "text", content: "  \n\t  " }],
          }),
        ])}
      />,
    );

    expect(screen.getByText("Response")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /whitespace reviewer/i }));
    expect(screen.queryByText("Task")).toBeNull();
  });

  test("previews the latest thinking and file updates in task agents", () => {
    render(
      <NativeMessage
        message={makeMessage([
          makeAgentTaskGroupPart({
            task: {
              toolUseId: "task-thinking-preview",
              toolArgs: { description: "Thinking preview reviewer" },
            },
            childTools: [{
              type: "thinking",
              content: "Inspecting the reducer",
            }],
          }),
          makeAgentTaskGroupPart({
            task: {
              toolUseId: "task-file-preview",
              toolArgs: { description: "File preview reviewer" },
            },
            childTools: [{
              type: "file",
              content: "/workspace/review-summary.md",
            }],
          }),
        ])}
      />,
    );

    const thinkingTrigger = screen.getByRole("button", {
      name: /thinking preview reviewer/i,
    });
    const fileTrigger = screen.getByRole("button", {
      name: /file preview reviewer/i,
    });
    expect(thinkingTrigger.textContent).toContain("Thinking");
    expect(fileTrigger.textContent).toContain("/workspace/review-summary.md");
  });

  test("previews the latest thinking and file updates in standalone agents", () => {
    render(
      <NativeMessage
        message={makeMessage([
          makeStandaloneSubagentPart({
            subagentId: "standalone-thinking-preview",
            subagentName: "Thinking standalone reviewer",
            subagentActions: [{ type: "thinking", content: "Inspecting" }],
          }),
          makeStandaloneSubagentPart({
            subagentId: "standalone-file-preview",
            subagentName: "File standalone reviewer",
            subagentActions: [
              { type: "file", content: "/workspace/standalone-review.md" },
            ],
          }),
        ])}
      />,
    );

    expect(
      screen.getByRole("button", { name: /thinking standalone reviewer/i })
        .textContent,
    ).toContain("Thinking");
    expect(
      screen.getByRole("button", { name: /file standalone reviewer/i })
        .textContent,
    ).toContain("/workspace/standalone-review.md");
  });

  test("renders no shell for an empty agent group", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([
          { type: "text", content: "Before agents" },
          { type: "agent-group", content: "", parts: [] },
          { type: "text", content: "After agents" },
        ])}
      />,
    );

    expect(container.textContent).toContain("Before agents");
    expect(container.textContent).toContain("After agents");
    expect(screen.queryByRole("region", { name: /agents/i })).toBeNull();
    expect(screen.queryByText("Agents")).toBeNull();
  });

  test("omits the active badge when every grouped agent has finished", () => {
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
    expect(screen.queryByText(/active$/i)).toBeNull();
  });

  test("counts active agents across mixed subagent and task-group children", () => {
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
    expect(screen.getByText("1 active")).toBeTruthy();
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
      "AgentPresentation ReviewerFinished",
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

describe("NativeMessage actions slot", () => {
  afterEach(() => {
    cleanup();
    useMessagePartExpansionStore.getState().reset();
  });

  test("renders caller-supplied actions before the copy button on a user message", () => {
    // This is the shared render path for all three tabs' fork buttons.
    const message = makeMessage([{ type: "text", content: "Ship it" }], {
      id: "user-1",
      role: "user",
      content: "Ship it",
    });

    render(
      <NativeMessage
        message={message}
        actions={<button type="button">Fork from here</button>}
      />,
    );

    const fork = screen.getByRole("button", { name: "Fork from here" });
    const copy = screen.getByRole("button", { name: "Copy text" });
    expect(fork).toBeTruthy();
    // Ordering is load-bearing: copy stays the right-most control.
    expect(
      fork.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("renders actions on an assistant message alongside the copy button", () => {
    render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Done" }])}
        actions={<button type="button">Custom action</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Custom action" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy text" })).toBeTruthy();
  });

  test("keeps assistant actions visible on mobile and hover-revealed on desktop", () => {
    render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Done" }])}
        actions={<button type="button">Custom action</button>}
      />,
    );

    const actionRow = screen.getByRole("button", { name: "Custom action" }).parentElement;
    const classTokens = getClassTokens(actionRow);
    expect(classTokens).toContain("opacity-100");
    expect(classTokens).toContain("md:hover-fine:opacity-0");
    expect(classTokens).toContain("md:hover-fine:group-hover:opacity-100");
    expect(classTokens).toContain("md:hover-fine:focus-within:opacity-100");
  });

  test("keeps user actions visible on mobile and hover-revealed on desktop", () => {
    render(
      <NativeMessage
        message={makeMessage([{ type: "text", content: "Ship it" }], {
          id: "user-1",
          role: "user",
          content: "Ship it",
        })}
        actions={<button type="button">Fork from here</button>}
      />,
    );

    const actionRow = screen.getByRole("button", { name: "Fork from here" })
      .parentElement?.parentElement;
    const classTokens = getClassTokens(actionRow);
    expect(classTokens).toContain("opacity-100");
    expect(classTokens).toContain("md:hover-fine:opacity-0");
    expect(classTokens).toContain("md:hover-fine:group-hover:opacity-100");
    expect(classTokens).toContain("md:hover-fine:focus-within:opacity-100");
  });

  test("renders actions even when there is nothing to copy", () => {
    /*
     * With no copy content the action row used to be `undefined`, so
     * `MessageShell` hid it — and with it any caller-supplied action.
     */
    const message = makeMessage([
      { type: "tool-invocation", content: "Read", toolName: "Read", toolState: "success" },
    ]);

    render(
      <NativeMessage
        message={message}
        actions={<button type="button">Fork from here</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "Fork from here" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
  });

  test("leaves the copy-only layout undisturbed when no actions are passed", () => {
    render(<NativeMessage message={makeMessage([{ type: "text", content: "Done" }])} />);

    const copy = screen.getByRole("button", { name: "Copy text" });
    expect(copy).toBeTruthy();
    // Exactly one control in the action row — nothing extra was introduced.
    expect(copy.parentElement?.querySelectorAll("button")).toHaveLength(1);
  });

  test("renders no action row at all when there is neither copy content nor actions", () => {
    const { container } = render(
      <NativeMessage
        message={makeMessage([
          { type: "tool-invocation", content: "Read", toolName: "Read", toolState: "success" },
        ])}
      />,
    );

    expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
    expect(container.textContent).not.toContain("Fork from here");
  });
});
