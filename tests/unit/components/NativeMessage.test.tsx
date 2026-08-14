import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import type { NativeMessage as NativeMessageType } from "../../../apps/web/src/lib/chat/native-message-types";
import { mockWriteText } from "../../mocks/clipboard";
import {
  type CreateFileTabOptions,
  TerminalProvider,
  useTerminalContext,
} from "../../../apps/web/src/contexts/TerminalContext";

const mockOpenInBrowser = mock(async () => {});
const mockReadFileBase64 = mock(async () => "image-base64");
const mockReadContainerFileBase64 = mock(async () => "container-image-base64");

mock.module("@/lib/backend", () => ({
  openInBrowser: mockOpenInBrowser,
  readContainerFileBase64: mockReadContainerFileBase64,
  readFileBase64: mockReadFileBase64,
}));

import { NativeMessage } from "../../../apps/web/src/components/chat/NativeMessage";
import { normalizeClaudeMessagesForDisplay } from "../../../apps/web/src/lib/chat/native-message-adapters";
import { useMessagePartExpansionStore } from "../../../apps/web/src/stores/messagePartExpansionStore";

function TerminalContextHarness({
  children,
  createFileTab,
}: {
  children: React.ReactNode;
  createFileTab?: (path: string, options?: CreateFileTabOptions) => void;
}) {
  return (
    <TerminalProvider>
      <ConfigureTerminalContext createFileTab={createFileTab} />
      {children}
    </TerminalProvider>
  );
}

function ConfigureTerminalContext({
  createFileTab,
}: {
  createFileTab?: (path: string, options?: CreateFileTabOptions) => void;
}) {
  const { setCreateFileTab } = useTerminalContext();

  useEffect(() => {
    setCreateFileTab(createFileTab ?? null);
    return () => setCreateFileTab(null);
  }, [createFileTab, setCreateFileTab]);

  return null;
}

function getClassTokens(element: Element | null | undefined): string[] {
  return element?.getAttribute("class")?.split(/\s+/).filter(Boolean) ?? [];
}

describe("NativeMessage", () => {
  afterEach(() => {
    cleanup();
    // Thinking expansion outlives unmount by design, so clear it between tests.
    useMessagePartExpansionStore.getState().reset();
    mockOpenInBrowser.mockReset();
    mockOpenInBrowser.mockImplementation(async () => {});
    mockReadFileBase64.mockReset();
    mockReadFileBase64.mockImplementation(async () => "image-base64");
    mockReadContainerFileBase64.mockReset();
    mockReadContainerFileBase64.mockImplementation(async () => "container-image-base64");
    mockWriteText.mockReset();
    mockWriteText.mockImplementation(async () => {});
  });

  test("renders single newlines as visible line breaks in text parts", () => {
    const message: NativeMessageType = {
      id: "msg-line-breaks",
      role: "user",
      content: "First line\nSecond line\nThird line",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "First line\nSecond line\nThird line" },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);
    const lineBreaks = container.querySelectorAll("br");

    expect(container.textContent).toContain("First line");
    expect(container.textContent).toContain("Second line");
    expect(container.textContent).toContain("Third line");
    expect(lineBreaks).toHaveLength(2);
  });

  test("truncates user prompts longer than 12 lines by default", () => {
    const content = Array.from(
      { length: 13 },
      (_, index) => `Line ${index + 1}`,
    ).join("\n");
    const message: NativeMessageType = {
      id: "msg-long-user-prompt",
      role: "user",
      content,
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "text", content }],
    };

    render(<NativeMessage message={message} />);

    const toggle = screen.getByRole("button", { name: "show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      (toggle.previousElementSibling as HTMLElement).style.maxHeight,
    ).toContain("12");

    fireEvent.click(toggle);

    const collapseToggle = screen.getByRole("button", { name: "show less" });
    expect(collapseToggle.getAttribute("aria-expanded")).toBe("true");
    expect((collapseToggle.previousElementSibling as HTMLElement).style.maxHeight).toBe("");

    fireEvent.click(collapseToggle);

    expect(
      screen
        .getByRole("button", { name: "show more" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  test("does not add prompt truncation controls to short user or assistant messages", () => {
    const shortContent = Array.from(
      { length: 12 },
      (_, index) => `Line ${index + 1}`,
    ).join("\n");
    const longContent = Array.from(
      { length: 13 },
      (_, index) => `Line ${index + 1}`,
    ).join("\n");
    const shortUserMessage: NativeMessageType = {
      id: "msg-short-user-prompt",
      role: "user",
      content: shortContent,
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: shortContent,
        },
      ],
    };
    const longAssistantMessage: NativeMessageType = {
      id: "msg-long-assistant-message",
      role: "assistant",
      content: longContent,
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "text",
          content: longContent,
        },
      ],
    };

    const { rerender } = render(<NativeMessage message={shortUserMessage} />);

    expect(screen.queryByRole("button", { name: "show more" })).toBeNull();

    rerender(<NativeMessage message={longAssistantMessage} />);

    expect(screen.queryByRole("button", { name: "show more" })).toBeNull();
  });

  test("truncates long fallback user content when no text parts are present", () => {
    const content = Array.from(
      { length: 13 },
      (_, index) => `Fallback line ${index + 1}`,
    ).join("\n");
    const message: NativeMessageType = {
      id: "msg-long-user-fallback-prompt",
      role: "user",
      content,
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [],
    };

    render(<NativeMessage message={message} />);

    const toggle = screen.getByRole("button", { name: "show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      (toggle.previousElementSibling as HTMLElement).style.maxHeight,
    ).toContain("12");
  });

  test("counts CRLF and CR line endings when truncating user prompts", () => {
    const crlfContent = Array.from(
      { length: 13 },
      (_, index) => `CRLF line ${index + 1}`,
    ).join("\r\n");
    const crContent = Array.from(
      { length: 13 },
      (_, index) => `CR line ${index + 1}`,
    ).join("\r");
    const crlfMessage: NativeMessageType = {
      id: "msg-crlf-user-prompt",
      role: "user",
      content: crlfContent,
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "text", content: crlfContent }],
    };
    const crMessage: NativeMessageType = {
      id: "msg-cr-user-prompt",
      role: "user",
      content: crContent,
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "text", content: crContent }],
    };

    const { rerender } = render(<NativeMessage message={crlfMessage} />);

    expect(screen.getByRole("button", { name: "show more" })).toBeTruthy();

    rerender(<NativeMessage message={crMessage} />);

    expect(screen.getByRole("button", { name: "show more" })).toBeTruthy();
  });

  test("renders user copy control below the bubble with the timestamp row", async () => {
    const message: NativeMessageType = {
      id: "msg-user-copy",
      role: "user",
      content: "Copy this user prompt",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "Copy this user prompt" },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);
    const bubble = screen.getByText("Copy this user prompt").closest(".rounded-xl") as HTMLElement;
    expect(bubble.textContent).not.toContain("12:00");
    expect(bubble.className).toContain("[&_.prose_p]:my-0");

    const copy = screen.getByRole("button", { name: "Copy text" });
    const actionRow = copy.parentElement?.parentElement?.parentElement;
    const classTokens = getClassTokens(actionRow);
    expect(classTokens).toContain("opacity-100");
    expect(classTokens).toContain("md:hover-fine:opacity-0");
    expect(classTokens).toContain("md:hover-fine:group-hover:opacity-100");
    expect(classTokens).toContain("md:hover-fine:focus-within:opacity-100");
    expect(actionRow?.textContent).toContain("12:00");

    fireEvent.click(copy);

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Copy this user prompt");
    });
  });

  test("renders separate metadata and copy controls for delayed Claude text blocks", async () => {
    const messages = normalizeClaudeMessagesForDisplay([
      {
        id: "claude-delayed-blocks",
        role: "assistant",
        content: "FirstSecond",
        createdAt: "2026-03-07T12:00:00.000Z",
        parts: [
          {
            type: "text",
            content: "First",
            createdAt: "2026-03-07T12:00:00.000Z",
          },
          {
            type: "tool-invocation",
            content: "Read",
            toolName: "Read",
          },
          {
            type: "text",
            content: "Second",
            createdAt: "2026-03-07T12:02:01.000Z",
          },
        ],
      },
    ]);

    render(
      <>
        {messages.map((message, index) => (
          <NativeMessage
            key={message.id}
            message={message}
            previousMessage={messages[index - 1]}
            assistantLabel="Claude"
          />
        ))}
      </>,
    );

    expect(screen.getAllByText("Claude", { exact: true })).toHaveLength(2);
    const copyButtons = screen.getAllByRole("button", { name: "Copy text" });
    expect(copyButtons).toHaveLength(2);

    fireEvent.click(copyButtons[1]!);
    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Second");
    });
  });

  test("opens markdown links through the system browser", () => {
    const message: NativeMessageType = {
      id: "msg-link",
      role: "assistant",
      content: "Read [the docs](https://example.com/docs).",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "Read [the docs](https://example.com/docs)." },
      ],
    };

    render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("link", { name: "the docs" }));

    expect(mockOpenInBrowser).toHaveBeenCalledWith("https://example.com/docs");
  });

  test("does not ask the system browser to open an empty markdown destination", () => {
    const message: NativeMessageType = {
      id: "msg-empty-link",
      role: "assistant",
      content: "Read [the missing destination]().",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "Read [the missing destination]()." },
      ],
    };

    render(<NativeMessage message={message} />);

    const emptyLink = screen.getByText("the missing destination").closest("a");
    expect(emptyLink).toBeTruthy();
    fireEvent.click(emptyLink!);
    expect(mockOpenInBrowser).not.toHaveBeenCalled();
  });

  test("reports system-browser failures without throwing from link clicks", async () => {
    const consoleError = console.error;
    const mockConsoleError = mock(() => {});
    console.error = mockConsoleError as typeof console.error;
    mockOpenInBrowser.mockImplementationOnce(async () => {
      throw new Error("browser unavailable");
    });
    const message: NativeMessageType = {
      id: "msg-link-error",
      role: "assistant",
      content: "Read [the docs](https://example.com/docs).",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "Read [the docs](https://example.com/docs)." },
      ],
    };

    try {
      render(<NativeMessage message={message} />);
      fireEvent.click(screen.getByRole("link", { name: "the docs" }));

      await waitFor(() => {
        expect(mockConsoleError).toHaveBeenCalledWith(
          "[NativeMessage] Failed to open link:",
          expect.any(Error),
        );
      });
    } finally {
      console.error = consoleError;
    }
  });

  test("preserves chronological order for interleaved text and tool parts", () => {
    const message: NativeMessageType = {
      id: "msg-chronological-order",
      role: "assistant",
      content: "First explanation. Then a tool call. Then more explanation.",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "First explanation." },
        {
          type: "tool-invocation",
          content: "",
          toolName: "Read",
          toolArgs: { file_path: "/workspace/src/example.ts" },
          toolState: "success",
        },
        { type: "text", content: "More explanation after the tool call." },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);
    const renderedText = container.textContent ?? "";

    const firstTextIndex = renderedText.indexOf("First explanation.");
    const toolIndex = renderedText.indexOf("Read");
    const fileIndex = renderedText.indexOf("example.ts");
    const secondTextIndex = renderedText.indexOf("More explanation after the tool call.");

    expect(firstTextIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(firstTextIndex);
    expect(fileIndex).toBeGreaterThanOrEqual(toolIndex);
    expect(secondTextIndex).toBeGreaterThan(fileIndex);
  });

  test("uses uniform part spacing after subagents and for fallback text after tools", () => {
    const subagentMessage: NativeMessageType = {
      id: "msg-subagent-lead-in",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Lovelace",
          subagentId: "agent-1",
          subagentName: "Lovelace",
          subagentRole: "explorer",
          subagentActionCount: 1,
          toolState: "success",
          subagentActions: [
            {
              type: "tool-invocation",
              content: "exec_command",
              toolName: "exec_command",
              toolState: "success",
            },
            {
              type: "tool-result",
              content: "done",
            },
            {
              type: "text",
              content: "Child text after tool",
            },
          ],
        },
        { type: "text", content: "Top-level text after subagent" },
      ],
    };

    const { unmount } = render(<NativeMessage message={subagentMessage} />);

    const topLevelText = screen.getByText("Top-level text after subagent");
    expect(topLevelText.closest(".prose")?.parentElement?.className).toContain(
      "[&_.prose>:first-child]:mt-0",
    );
    expect(topLevelText.closest(".prose")?.parentElement?.className).not.toContain(
      "pt-2",
    );

    fireEvent.click(screen.getByRole("button", { name: /lovelace/i }));
    const childText = screen
      .getAllByText("Child text after tool")
      .find((element) => element.closest(".prose"));
    expect(childText).toBeTruthy();
    expect(childText!.closest(".prose")?.parentElement?.className).toContain(
      "[&_.prose>:first-child]:mt-0",
    );
    expect(childText!.closest(".prose")?.parentElement?.className).not.toContain(
      "pt-2",
    );

    unmount();

    const fallbackMessage: NativeMessageType = {
      id: "msg-fallback-lead-in",
      role: "assistant",
      content: "Fallback text after tool",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Read",
          toolState: "success",
        },
        {
          type: "tool-result",
          content: "done",
        },
      ],
    };

    render(<NativeMessage message={fallbackMessage} />);

    const fallbackText = screen.getByText("Fallback text after tool");
    expect(fallbackText.closest(".prose")?.parentElement?.className).toContain(
      "[&_.prose>:first-child]:mt-0",
    );
    expect(fallbackText.closest(".prose")?.parentElement?.className).not.toContain(
      "pt-2",
    );
  });

  test("renders system and error messages distinctly and shows continuation metadata", () => {
    const systemMessage: NativeMessageType = {
      id: "system-naming-1",
      role: "assistant",
      content: "Generated environment name",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [],
    };

    const { container, rerender } = render(
      <NativeMessage message={systemMessage} />,
    );

    expect(screen.getByText("Generated environment name")).toBeTruthy();
    expect(container.querySelector(".italic")).toBeTruthy();
    expect(screen.queryByText("Assistant")).toBeNull();

    const errorMessage: NativeMessageType = {
      id: "error-session-1",
      role: "assistant",
      content: "Bridge unavailable",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [],
    };

    rerender(<NativeMessage message={errorMessage} />);

    expect(screen.getByText("Bridge unavailable")).toBeTruthy();
    expect(container.querySelector(".text-destructive")).toBeTruthy();
    expect(screen.queryByText("Assistant")).toBeNull();

    const previousMessage: NativeMessageType = {
      id: "assistant-previous",
      role: "assistant",
      content: "Previous response",
      createdAt: "2026-03-07T12:00:15.000Z",
      parts: [{ type: "text", content: "Previous response" }],
    };
    const continuationMessage: NativeMessageType = {
      id: "assistant-continuation",
      role: "assistant",
      content: "Continuation response",
      createdAt: "2026-03-07T12:00:45.000Z",
      parts: [{ type: "text", content: "Continuation response" }],
    };

    rerender(
      <NativeMessage
        message={continuationMessage}
        previousMessage={previousMessage}
        assistantLabel="Worker"
      />,
    );

    expect(screen.getByText("Continuation response")).toBeTruthy();
    // A same-minute continuation repeats no attribution; the model label is
    // shown once, on the first content-bearing message of the block.
    expect(screen.queryByText("Worker")).toBeNull();
  });

  test("opens local image previews and closes the overlay with Escape", async () => {
    const message: NativeMessageType = {
      id: "msg-local-file-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "/tmp/screenshot.png",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /screenshot\.png/i }));

    const image = await screen.findByAltText("screenshot.png");
    expect(mockReadFileBase64).toHaveBeenCalledWith("/tmp/screenshot.png");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,image-base64");

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByAltText("screenshot.png")).toBeNull();
    });
  });

  test("reopens a cached local image preview without reading the file again", async () => {
    const message: NativeMessageType = {
      id: "msg-cached-local-file-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/tmp/cached.png" }],
    };

    render(<NativeMessage message={message} />);
    const attachment = screen.getByRole("button", { name: /cached\.png/i });

    fireEvent.click(attachment);
    await screen.findByAltText("cached.png");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByAltText("cached.png")).toBeNull());

    fireEvent.click(attachment);

    expect(await screen.findByAltText("cached.png")).toBeTruthy();
    expect(mockReadFileBase64).toHaveBeenCalledTimes(1);
  });

  test("closes image previews from the backdrop and close button but not the image panel", async () => {
    const message: NativeMessageType = {
      id: "msg-overlay-controls",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/tmp/overlay.png" }],
    };

    render(<NativeMessage message={message} />);
    const attachment = screen.getByRole("button", { name: /overlay\.png/i });
    fireEvent.click(attachment);

    let image = await screen.findByAltText("overlay.png");
    const panel = image.parentElement as HTMLElement;
    const backdrop = panel.parentElement as HTMLElement;
    fireEvent.click(panel);
    expect(screen.getByAltText("overlay.png")).toBeTruthy();

    fireEvent.click(backdrop);
    await waitFor(() => expect(screen.queryByAltText("overlay.png")).toBeNull());

    fireEvent.click(attachment);
    image = await screen.findByAltText("overlay.png");
    const closeButton = image.parentElement?.querySelector(
      "button",
    ) as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByAltText("overlay.png")).toBeNull());
  });

  test("keeps non-image attachments disabled and does not perform file reads", () => {
    const message: NativeMessageType = {
      id: "msg-text-attachment",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/tmp/notes.txt" }],
    };

    render(<NativeMessage message={message} />);

    const attachment = screen.getByRole("button", { name: /notes\.txt/i });
    expect((attachment as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(attachment);
    expect(mockReadFileBase64).not.toHaveBeenCalled();
    expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
  });

  test("loads safe container image previews through the container reader", async () => {
    const message: NativeMessageType = {
      id: "msg-container-file-preview",
      role: "user",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "/workspace/.orkestrator/clipboard/screenshot.png",
          fileUrl: "/workspace/.orkestrator/clipboard/screenshot.png",
        },
      ],
    };

    render(<NativeMessage message={message} containerId="container-1" />);

    fireEvent.click(screen.getByRole("button", { name: /screenshot\.png/i }));

    const image = await screen.findByAltText("screenshot.png");
    expect(mockReadContainerFileBase64).toHaveBeenCalledWith(
      "container-1",
      ".orkestrator/clipboard/screenshot.png",
    );
    expect(mockReadFileBase64).not.toHaveBeenCalled();
    expect(image.getAttribute("src")).toBe("data:image/png;base64,container-image-base64");
  });

  test("keeps decoded file URLs inside the container trust boundary", async () => {
    const message: NativeMessageType = {
      id: "msg-container-file-url-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "/workspace/screen shots/shot.png",
          fileUrl: "file:///workspace/screen%20shots/shot.png",
        },
      ],
    };

    render(<NativeMessage message={message} containerId="container-1" />);
    fireEvent.click(screen.getByRole("button", { name: /shot\.png/i }));

    await screen.findByAltText("shot.png");
    expect(mockReadContainerFileBase64).toHaveBeenCalledWith(
      "container-1",
      "screen shots/shot.png",
    );
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  test("rejects a container file URL that resolves outside the workspace", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    const message: NativeMessageType = {
      id: "msg-container-unsafe-file-url",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "/workspace/safe-looking.png",
          fileUrl: "file:///etc/secret.png",
        },
      ],
    };

    try {
      render(<NativeMessage message={message} containerId="container-1" />);
      fireEvent.click(screen.getByRole("button", { name: /safe-looking\.png/i }));

      await waitFor(() => expect(screen.getByText("(error)")).toBeTruthy());
      expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
      expect(mockReadFileBase64).not.toHaveBeenCalled();
    } finally {
      console.error = consoleError;
    }
  });

  test("rejects the workspace directory itself as a container image path", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    const message: NativeMessageType = {
      id: "msg-container-workspace-root",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/workspace", fileUrl: "preview.png" }],
    };

    try {
      render(<NativeMessage message={message} containerId="container-1" />);
      fireEvent.click(screen.getByRole("button", { name: /workspace/i }));

      await waitFor(() => expect(screen.getByText("(error)")).toBeTruthy());
      expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
      expect(mockReadFileBase64).not.toHaveBeenCalled();
    } finally {
      console.error = consoleError;
    }
  });

  test("does not fall back to host file reads for unsafe container image paths", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    const message: NativeMessageType = {
      id: "msg-unsafe-container-file-preview",
      role: "user",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "/etc/passwd.png",
          fileUrl: "/etc/passwd.png",
        },
      ],
    };

    try {
      render(<NativeMessage message={message} containerId="container-1" />);

      fireEvent.click(screen.getByRole("button", { name: /passwd\.png/i }));

      await waitFor(() => {
        expect(screen.getByText("(error)")).toBeTruthy();
      });
      expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
      expect(mockReadFileBase64).not.toHaveBeenCalled();
      expect(screen.queryByAltText("passwd.png")).toBeNull();
    } finally {
      console.error = consoleError;
    }
  });

  test("rejects traversal and control-character variants in container image paths", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    const unsafePaths = [
      "../secrets.png",
      "/workspace/../secrets.png",
      "/workspace\\..\\secrets.png",
      "/workspace//etc/passwd.png",
      "/workspace/\\etc\\secrets.png",
      "/workspace/C:\\Users\\Ada\\secrets.png",
      "C:\\Users\\Ada\\secrets.png",
      "\\etc\\secrets.png",
      "\\\\server\\share\\secrets.png",
      "/workspace/bad\0name.png",
      "/workspace/bad\nname.png",
      "/workspace/bad\rname.png",
    ];

    try {
      for (const [index, unsafePath] of unsafePaths.entries()) {
        const message: NativeMessageType = {
          id: `msg-unsafe-container-variant-${index}`,
          role: "assistant",
          content: "",
          createdAt: "2026-03-07T12:00:00.000Z",
          parts: [{ type: "file", content: unsafePath }],
        };
        const { container, unmount } = render(
          <NativeMessage message={message} containerId="container-1" />,
        );

        fireEvent.click(container.querySelector("button") as HTMLButtonElement);
        await waitFor(() => {
          expect(container.textContent).toContain("(error)");
        });
        unmount();
      }

      expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
      expect(mockReadFileBase64).not.toHaveBeenCalled();
    } finally {
      console.error = consoleError;
    }
  });

  test("opens data URL and remote image previews without local file reads", async () => {
    const dataUrl = "data:image/png;base64,inline-image";
    const dataUrlMessage: NativeMessageType = {
      id: "msg-data-url-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "inline.png",
          fileUrl: dataUrl,
        },
      ],
    };

    const { rerender } = render(<NativeMessage message={dataUrlMessage} />);

    fireEvent.click(screen.getByRole("button", { name: /inline\.png/i }));

    const inlineImage = await screen.findByAltText("inline.png");
    expect(inlineImage.getAttribute("src")).toBe(dataUrl);
    expect(mockReadFileBase64).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByAltText("inline.png")).toBeNull();
    });

    const remoteUrl = "https://example.com/remote.webp";
    const remoteMessage: NativeMessageType = {
      id: "msg-remote-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "remote.webp",
          fileUrl: remoteUrl,
        },
      ],
    };

    rerender(<NativeMessage message={remoteMessage} />);

    fireEvent.click(screen.getByRole("button", { name: /remote\.webp/i }));

    const remoteImage = await screen.findByAltText("remote.webp");
    expect(remoteImage.getAttribute("src")).toBe(remoteUrl);
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  test("opens HTTP image previews without local file reads", async () => {
    const remoteUrl = "http://example.com/remote.gif";
    const message: NativeMessageType = {
      id: "msg-http-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "remote.gif", fileUrl: remoteUrl }],
    };

    render(<NativeMessage message={message} />);
    fireEvent.click(screen.getByRole("button", { name: /remote\.gif/i }));

    const image = await screen.findByAltText("remote.gif");
    expect(image.getAttribute("src")).toBe(remoteUrl);
    expect(mockReadFileBase64).not.toHaveBeenCalled();
    expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
  });

  test("decodes percent-encoded Unix paths from file URLs", async () => {
    const message: NativeMessageType = {
      id: "msg-unix-file-url-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "error #1.png",
          fileUrl: "file:///tmp/screen%20shots/error%20%231.png",
        },
      ],
    };

    render(<NativeMessage message={message} />);
    fireEvent.click(screen.getByRole("button", { name: /error #1\.png/i }));

    await screen.findByAltText("error #1.png");
    expect(mockReadFileBase64).toHaveBeenCalledWith(
      "/tmp/screen shots/error #1.png",
    );
  });

  test("reads decoded local image paths from file URLs", async () => {
    const windowsFileUrlMessage: NativeMessageType = {
      id: "msg-windows-file-url-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "windows-shot.png",
          fileUrl: "file:///C:/Users/Ada/Pictures/windows-shot.png",
        },
      ],
    };

    const { rerender } = render(
      <NativeMessage message={windowsFileUrlMessage} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /windows-shot\.png/i }));

    await screen.findByAltText("windows-shot.png");
    expect(mockReadFileBase64).toHaveBeenCalledWith(
      "C:/Users/Ada/Pictures/windows-shot.png",
    );

    mockReadFileBase64.mockClear();

    const uncFileUrlMessage: NativeMessageType = {
      id: "msg-unc-file-url-preview",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "network-shot.png",
          fileUrl: "file://server/share/folder/network-shot.png",
        },
      ],
    };

    rerender(<NativeMessage message={uncFileUrlMessage} />);

    fireEvent.click(screen.getByRole("button", { name: /network-shot\.png/i }));

    await screen.findByAltText("network-shot.png");
    expect(mockReadFileBase64).toHaveBeenCalledWith(
      "//server/share/folder/network-shot.png",
    );
  });

  test("falls back to absolute attachment paths for malformed local file URLs", async () => {
    const malformedUrls = [
      "file:///tmp/bad%ZZ.png",
      "file://[invalid-host]/bad.png",
    ];

    for (const [index, fileUrl] of malformedUrls.entries()) {
      const path = `/tmp/fallback-${index}.png`;
      const message: NativeMessageType = {
        id: `msg-malformed-file-url-${index}`,
        role: "assistant",
        content: "",
        createdAt: "2026-03-07T12:00:00.000Z",
        parts: [{ type: "file", content: path, fileUrl }],
      };
      const { unmount } = render(<NativeMessage message={message} />);

      fireEvent.click(
        screen.getByRole("button", {
          name: new RegExp(`fallback-${index}`),
        }),
      );
      await screen.findByAltText(`fallback-${index}.png`);
      expect(mockReadFileBase64).toHaveBeenLastCalledWith(path);
      unmount();
    }

    expect(mockReadFileBase64).toHaveBeenCalledTimes(malformedUrls.length);
  });

  test("shows an error for a relative local image without a container", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    const message: NativeMessageType = {
      id: "msg-relative-local-image",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "screenshots/relative.png" }],
    };

    try {
      render(<NativeMessage message={message} />);
      fireEvent.click(screen.getByRole("button", { name: /relative\.png/i }));

      await waitFor(() => expect(screen.getByText("(error)")).toBeTruthy());
      expect(mockReadFileBase64).not.toHaveBeenCalled();
      expect(mockReadContainerFileBase64).not.toHaveBeenCalled();
    } finally {
      console.error = consoleError;
    }
  });

  test("shows an error state when local image preview loading fails", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    mockReadFileBase64.mockImplementationOnce(async () => {
      throw new Error("not found");
    });
    const message: NativeMessageType = {
      id: "msg-file-preview-error",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "file",
          content: "/tmp/missing.png",
        },
      ],
    };

    try {
      render(<NativeMessage message={message} />);

      fireEvent.click(screen.getByRole("button", { name: /missing\.png/i }));

      await waitFor(() => {
        expect(screen.getByText("(error)")).toBeTruthy();
      });
      expect(mockReadFileBase64).toHaveBeenCalledWith("/tmp/missing.png");
      expect(screen.queryByAltText("missing.png")).toBeNull();
    } finally {
      console.error = consoleError;
    }
  });

  test("retries a failed local image preview read", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    mockReadFileBase64
      .mockImplementationOnce(async () => {
        throw new Error("transient read failure");
      })
      .mockImplementationOnce(async () => "retry-base64");
    const message: NativeMessageType = {
      id: "msg-file-preview-retry",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/tmp/retry.png" }],
    };

    try {
      render(<NativeMessage message={message} />);
      const trigger = screen.getByRole("button", { name: /retry\.png/i });

      fireEvent.click(trigger);
      await waitFor(() => expect(screen.getByText("(error)")).toBeTruthy());

      fireEvent.click(trigger);
      const image = await screen.findByAltText("retry.png");
      expect(image.getAttribute("src")).toBe("data:image/png;base64,retry-base64");
      expect(screen.queryByText("(error)")).toBeNull();
      expect(mockReadFileBase64).toHaveBeenCalledTimes(2);
    } finally {
      console.error = consoleError;
    }
  });

  test("opens edit diffs in a file tab from the expanded tool view", () => {
    const createFileTab = mock(() => {});
    const message: NativeMessageType = {
      id: "msg-edit-diff",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/example.ts",
            before: "const value = 1;",
            after: "const value = 2;",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness createFileTab={createFileTab}>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    const editTrigger = screen.getByRole("button", { name: /edit/i });
    expect(editTrigger.parentElement?.className).toContain("my-0");

    fireEvent.click(editTrigger);
    fireEvent.click(screen.getByTitle("Open diff in new tab"));

    expect(createFileTab).toHaveBeenCalledWith("/workspace/src/example.ts", {
      isDiff: true,
      gitStatus: "M",
    });
  });

  test.each([
    ["the file-tab callback is unavailable", "/workspace/src/example.ts", undefined],
    ["the diff has no file path", undefined, mock(() => {})],
  ])("omits the edit pop-out when %s", (_reason, filePath, createFileTab) => {
    const message: NativeMessageType = {
      id: `msg-edit-no-popout-${filePath ? "callback" : "path"}`,
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            ...(filePath ? { filePath } : {}),
            before: "before",
            after: "after",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness createFileTab={createFileTab}>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.queryByTitle("Open diff in new tab")).toBeNull();
    if (createFileTab) {
      expect(createFileTab).not.toHaveBeenCalled();
    }
  });

  test("renders edit tool labels through the shared display-name helper", () => {
    const message: NativeMessageType = {
      id: "msg-edit-display-label",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/example.ts",
            before: "const value = 1;",
            after: "const value = 2;",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    expect(screen.getByRole("button", { name: /edit/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /example\.ts/i })).toBeTruthy();
  });

  test("renders unified edit diffs, raw output fallbacks, and error-only edit details", () => {
    const unifiedDiffMessage: NativeMessageType = {
      id: "msg-edit-unified-diff",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/example.ts",
            diff:
              "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new",
          },
        },
      ],
    };

    const { rerender } = render(
      <TerminalContextHarness>
        <NativeMessage message={unifiedDiffMessage} />
      </TerminalContextHarness>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /edit example\.ts success/i }),
    );
    expect(screen.getByText("--- a/src/example.ts")).toBeTruthy();
    expect(screen.getByText("+++ b/src/example.ts")).toBeTruthy();
    expect(screen.getByText("-old")).toBeTruthy();
    expect(screen.getByText("+new")).toBeTruthy();

    const rawOutputMessage: NativeMessageType = {
      id: "msg-edit-raw-output",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolOutput: "Applied patch without a diff preview",
        },
      ],
    };

    rerender(
      <TerminalContextHarness>
        <NativeMessage message={rawOutputMessage} />
      </TerminalContextHarness>,
    );

    fireEvent.click(screen.getByRole("button", { name: /edit success/i }));
    expect(screen.getByText("Applied patch without a diff preview")).toBeTruthy();
    expect(screen.getByText("Unknown file")).toBeTruthy();

    const errorOnlyMessage: NativeMessageType = {
      id: "msg-edit-error-only",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "failure",
          toolError: "Patch failed to apply",
        },
      ],
    };

    rerender(
      <TerminalContextHarness>
        <NativeMessage message={errorOnlyMessage} />
      </TerminalContextHarness>,
    );

    fireEvent.click(screen.getByRole("button", { name: /edit failure/i }));
    expect(screen.getByText("Patch failed to apply")).toBeTruthy();
  });

  test("uses precomputed edit additions and deletions in the collapsed summary", () => {
    const message: NativeMessageType = {
      id: "msg-edit-precomputed-stats",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/stats.ts",
            additions: 7,
            deletions: 3,
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    const trigger = screen.getByRole("button", {
      name: /edit stats\.ts \+7 -3 success/i,
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });

  test("renders before-only and after-only edit metadata", () => {
    const message: NativeMessageType = {
      id: "msg-edit-one-sided-diffs",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/deleted.ts",
            before: "removed only",
          },
        },
        {
          type: "tool-invocation",
          content: "",
          toolName: "Write",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/created.ts",
            after: "created only",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /edit deleted\.ts -1 success/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /write created\.ts \+1 success/i }),
    );

    expect(screen.getByText("-removed only")).toBeTruthy();
    expect(screen.getByText("+created only")).toBeTruthy();
  });

  test("treats empty before and after metadata as zero diff lines", () => {
    const message: NativeMessageType = {
      id: "msg-edit-empty-boundaries",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Write",
          toolState: "success",
          toolDiff: { filePath: "/workspace/created.ts", before: "", after: "created" },
        },
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: { filePath: "/workspace/deleted.ts", before: "removed", after: "" },
        },
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: { filePath: "/workspace/empty.ts", before: "", after: "" },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    const created = screen.getByRole("button", { name: /write created\.ts \+1 success/i });
    const deleted = screen.getByRole("button", { name: /edit deleted\.ts -1 success/i });
    const empty = screen.getByRole("button", { name: /edit empty\.ts success/i });
    expect((empty as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(created);
    fireEvent.click(deleted);
    expect(screen.getByText("+created")).toBeTruthy();
    expect(screen.getByText("-removed")).toBeTruthy();
    expect(screen.queryByText("+")).toBeNull();
    expect(screen.queryByText("-")).toBeNull();
  });

  test("keeps provider diff metadata without change markers authoritative", () => {
    const message: NativeMessageType = {
      id: "msg-edit-metadata-fallback",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/fallback.ts",
            diff: "diff metadata without plus or minus markers",
            before: "old fallback",
            after: "new fallback",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit fallback\.ts/i }));

    expect(screen.getByText("diff metadata without plus or minus markers")).toBeTruthy();
    expect(screen.queryByText("-old fallback")).toBeNull();
    expect(screen.queryByText("+new fallback")).toBeNull();
  });

  test("falls back to before and after when the provider diff is an empty string", () => {
    // An empty `diff` is not a provider asserting "nothing changed" — it is a
    // patch field the provider never filled in. Treating it as authoritative
    // renders a blank body under a header that still claims +1/-1.
    const message: NativeMessageType = {
      id: "msg-edit-empty-diff",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/empty.ts",
            diff: "",
            before: "old empty",
            after: "new empty",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit empty\.ts/i }));

    expect(screen.getByText("-old empty")).toBeTruthy();
    expect(screen.getByText("+new empty")).toBeTruthy();
  });

  test("renders a non-edit tool carrying only an empty diff as a generic tool row", () => {
    // `hasRenderableDiff` gates the edit treatment. An empty diff string must
    // not pull a search tool into the diff renderer.
    const message: NativeMessageType = {
      id: "msg-search-empty-diff",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Search for references",
          toolName: "search",
          toolState: "success",
          toolDiff: { filePath: "/workspace/src/looked-at.ts", diff: "" },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    expect(screen.queryByRole("button", { name: /edit looked-at\.ts/i })).toBeNull();
    expect(screen.getByText(/^search$/i)).toBeTruthy();
  });

  test("keeps edit diffs in step with toolDiff's values, not its identity", () => {
    // The diff memos are keyed on the fields they read rather than on
    // `toolDiff`'s identity, because normalization rebuilds every part object
    // on each streaming frame and re-deriving a completed edit's diff is
    // whole-file work. The hazard of value deps is staleness, so this pins
    // both halves: a new object with identical values must not change what is
    // shown, and changed values must still get through.
    const buildMessage = (before: string, after: string): NativeMessageType => ({
      id: "msg-edit-value-deps",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          // A fresh object every call, exactly as a streaming frame produces.
          toolDiff: { filePath: "/workspace/src/deps.ts", before, after },
        },
      ],
    });

    const { rerender } = render(
      <TerminalContextHarness>
        <NativeMessage message={buildMessage("first old", "first new")} />
      </TerminalContextHarness>,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit deps\.ts/i }));
    expect(screen.getByText("-first old")).toBeTruthy();
    expect(screen.getByText("+first new")).toBeTruthy();

    rerender(
      <TerminalContextHarness>
        <NativeMessage message={buildMessage("first old", "first new")} />
      </TerminalContextHarness>,
    );
    expect(screen.getByText("-first old")).toBeTruthy();
    expect(screen.getByText("+first new")).toBeTruthy();

    rerender(
      <TerminalContextHarness>
        <NativeMessage message={buildMessage("second old", "second new")} />
      </TerminalContextHarness>,
    );
    expect(screen.getByText("-second old")).toBeTruthy();
    expect(screen.getByText("+second new")).toBeTruthy();
    expect(screen.queryByText("-first old")).toBeNull();
  });

  test("disables edit rows that have no expandable details", () => {
    const createFileTab = mock(() => {});
    const message: NativeMessageType = {
      id: "msg-edit-no-details",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: { filePath: "/workspace/src/no-details.ts" },
        },
      ],
    };

    render(
      <TerminalContextHarness createFileTab={createFileTab}>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    expect(
      (
        screen.getByRole("button", {
          name: /edit no-details\.ts success/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByTitle("Open diff in new tab")).toBeNull();
    expect(createFileTab).not.toHaveBeenCalled();
  });

  test("shows shell commands in collapsed Claude Bash tool rows", () => {
    const message: NativeMessageType = {
      id: "msg-claude-bash-command-summary",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolTitle: "Bash",
          toolArgs: {
            command: "pwd && rg --files | head -200",
          },
          toolState: "success",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", {
      name: /Run Command pwd && rg --files \| head -200 success/i,
    });
    expect(trigger).toBeTruthy();
    expect(screen.queryByText("Bash")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("$ pwd && rg --files | head -200")).toBeTruthy();
  });

  test("shows search, URL, and query arguments in collapsed generic tool rows", () => {
    const message: NativeMessageType = {
      id: "msg-generic-tool-summaries",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Glob",
          toolName: "Glob",
          toolArgs: { pattern: "src/**/*.tsx" },
          toolState: "success",
        },
        {
          type: "tool-invocation",
          content: "Grep",
          toolName: "Grep",
          toolArgs: { regex: "TODO|FIXME" },
          toolState: "success",
        },
        {
          type: "tool-invocation",
          content: "WebFetch",
          toolName: "WebFetch",
          toolArgs: { url: "https://docs.example.com/reference" },
          toolState: "success",
        },
        {
          type: "tool-invocation",
          content: "WebFetch",
          toolName: "WebFetch",
          toolArgs: { url: "not a valid url" },
          toolState: "failure",
        },
        {
          type: "tool-invocation",
          content: "WebSearch",
          toolName: "WebSearch",
          toolArgs: { query: "react suspense testing" },
          toolState: "success",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(
      screen.getByRole("button", { name: /glob src\/\*\*\/\*\.tsx success/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /grep todo\|fixme success/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /webfetch docs\.example\.com success/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /webfetch not a valid url failure/i,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /websearch react suspense testing success/i,
      }),
    ).toBeTruthy();
  });

  test("renders task-list thinking parts as collapsible activity", () => {
    const message: NativeMessageType = {
      id: "msg-thinking-task-list",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "thinking",
          content: "- [ ] Review diff\n- [x] Run tests",
        },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", { name: /thinking task list/i });
    expect(trigger).toBeTruthy();

    fireEvent.click(trigger);

    expect(screen.getByText("Review diff")).toBeTruthy();
    expect(screen.getByText("Run tests")).toBeTruthy();
    expect(container.querySelectorAll("[data-task-list-icon]")).toHaveLength(2);
    expect(
      container.querySelector("[data-task-list-icon][data-state='checked']"),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-task-list-icon][data-state='unchecked']"),
    ).toBeTruthy();
  });

  test("normalizes away empty thinking without leaving an activity shell", () => {
    const message: NativeMessageType = {
      id: "msg-empty-thinking",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "thinking", content: "" },
        { type: "thinking", content: "  \n\t " },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);

    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
    expect(container.querySelector(".border-zinc-700\\/70")).toBeNull();
  });

  test("renders no control for an empty nested thinking update", () => {
    const message: NativeMessageType = {
      id: "msg-empty-nested-thinking",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Reviewer",
          subagentId: "empty-thinking-agent",
          toolState: "pending",
          subagentActions: [{ type: "thinking", content: "  \n\t " }],
        },
      ],
    };

    render(<NativeMessage message={message} />);
    const buttonCount = screen.getAllByRole("button").length;
    fireEvent.click(screen.getByRole("button", { name: /reviewer active/i }));

    expect(screen.getAllByRole("button")).toHaveLength(buttonCount);
  });

  test("does not render a shell for an empty tool group", () => {
    const message: NativeMessageType = {
      id: "msg-empty-tool-group",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "Before tools" },
        { type: "tool-group", content: "", parts: [] },
        { type: "text", content: "After tools" },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);

    expect(screen.getByText("Before tools")).toBeTruthy();
    expect(screen.getByText("After tools")).toBeTruthy();
    expect(container.querySelector(".border-zinc-700\\/70")).toBeNull();
  });

  test("uses Response when the latest task text update is empty", () => {
    const message: NativeMessageType = {
      id: "msg-empty-task-text",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "task-group",
          content: "Agent",
          task: {
            type: "tool-invocation",
            content: "Agent",
            toolName: "Agent",
            toolState: "pending",
          },
          childTools: [{ type: "text", content: "  \n\t " }],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Response")).toBeTruthy();
    expect(screen.queryByText("Waiting for activity.")).toBeNull();
  });

  test("renders transcript-derived subagent groups as collapsible activity stacks", () => {
    const message: NativeMessageType = {
      id: "msg-subagent",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Lovelace",
          subagentId: "agent-1",
          subagentName: "Lovelace",
          subagentRole: "explorer",
          subagentPrompt: "Inspect the Codex integration",
          subagentActionCount: 1,
          toolState: "pending",
          subagentActions: [
            {
              type: "tool-invocation",
              content: "exec_command",
              toolName: "exec_command",
              toolArgs: {
                command: "rg -n \"codex\" src",
              },
              toolState: "success",
              toolTitle: "exec_command",
              toolOutput: "matches",
            },
          ],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(screen.getByText("1 update")).toBeTruthy();
    expect(screen.getByText('rg -n "codex" src')).toBeTruthy();
    expect(screen.queryByText("Inspect the Codex integration")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /lovelace/i }));

    expect(screen.getByText("Inspect the Codex integration")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Exec Command rg -n "codex" src success/i })).toBeTruthy();
    fireEvent.click(screen.getAllByText("Exec Command")[0]!);
    expect(screen.getByText("$ rg -n \"codex\" src")).toBeTruthy();
    expect(screen.getByText("matches")).toBeTruthy();
  });

  test("renders finished and failed subagent states when no activity was captured", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-empty-states",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Hopper",
          subagentId: "agent-success",
          subagentName: "Hopper",
          subagentRole: "explorer",
          subagentActionCount: 0,
          toolState: "success",
          subagentActions: [],
        },
        {
          type: "subagent",
          content: "Shannon",
          subagentId: "agent-failure",
          subagentName: "Shannon",
          subagentRole: "worker",
          subagentActionCount: 0,
          toolState: "failure",
          subagentActions: [],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getAllByText("No activity captured.")).toHaveLength(2);
  });

  test("shows waiting preview when a pending subagent has no actions", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-waiting",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Lovelace",
          subagentId: "agent-pending",
          subagentName: "Lovelace",
          subagentRole: "explorer",
          subagentActionCount: 0,
          toolState: "pending",
          subagentActions: [],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Waiting for activity.")).toBeTruthy();
  });

  test("uses text updates and tool titles as subagent preview fallbacks", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-preview-fallbacks",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Turing",
          subagentId: "agent-text-preview",
          subagentName: "Turing",
          subagentRole: "worker",
          subagentActionCount: 0,
          toolState: "success",
          subagentActions: [
            {
              type: "text",
              content: "Summarized the repository layout.",
            },
          ],
        },
        {
          type: "subagent",
          content: "Kay",
          subagentId: "agent-title-preview",
          subagentName: "Kay",
          subagentRole: "explorer",
          subagentActionCount: 1,
          toolState: "success",
          subagentActions: [
            {
              type: "tool-invocation",
              content: "exec_command",
              toolName: "exec_command",
              toolTitle: "grep",
              toolState: "success",
            },
          ],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Summarized the repository layout.")).toBeTruthy();
    expect(screen.getByText("grep")).toBeTruthy();
  });

  test("uses display names for subagent tool-name previews without commands or titles", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-display-tool-name",
      role: "assistant",
      content: "Main agent response",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Hamilton",
          subagentId: "agent-display-name-preview",
          subagentName: "Hamilton",
          subagentRole: "worker",
          subagentActionCount: 1,
          toolState: "success",
          subagentActions: [
            {
              type: "tool-invocation",
              content: "shell",
              toolName: "bash",
              toolState: "success",
            },
          ],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Run Command")).toBeTruthy();
    expect(screen.queryByText("bash")).toBeNull();
  });

  test("uses the latest task child title when no command is available", () => {
    const message: NativeMessageType = {
      id: "msg-task-latest-child-title",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "task-group",
          content: "",
          task: {
            type: "tool-invocation",
            content: "",
            toolName: "task",
            toolState: "success",
            toolUseId: "task-latest-child-title",
            toolArgs: { agent_name: "Reviewer" },
          },
          childTools: [
            {
              type: "tool-invocation",
              content: "",
              toolName: "glob",
              toolTitle: "Search files",
              toolState: "success",
              toolArgs: { pattern: "src/**/*.ts" },
            },
          ],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Search files")).toBeTruthy();
  });

  test("falls back safely for empty and malformed task metadata", () => {
    const message: NativeMessageType = {
      id: "msg-task-malformed-metadata",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "task-group",
          content: "",
          task: {
            type: "tool-invocation",
            content: "",
            toolName: "task",
            toolState: "pending",
            toolUseId: "task-malformed-metadata",
            toolArgs: {
              description: 42,
              prompt: "   ",
              subagent_type: false,
              agent_name: "",
            },
          },
          childTools: [],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", { name: /Subagent Active/i });
    expect(screen.getByText("Waiting for activity.")).toBeTruthy();
    expect(screen.getByText("0 tools")).toBeTruthy();
    expect(screen.getByText("0 updates")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.getByText("No child actions yet.")).toBeTruthy();
    expect(screen.queryByText("42")).toBeNull();
  });

  test("removes an agent expansion key when the group is closed", () => {
    const message: NativeMessageType = {
      id: "msg-task-expansion-close",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "task-group",
          content: "",
          task: {
            type: "tool-invocation",
            content: "",
            toolName: "task",
            toolState: "pending",
            toolUseId: "task-expansion-close",
            toolArgs: {
              agent_name: "Closer",
              prompt: "Inspect expansion state",
            },
          },
          childTools: [],
        },
      ],
    };

    render(<NativeMessage message={message} />);
    const trigger = screen.getByRole("button", { name: /Closer Active/i });

    fireEvent.click(trigger);
    expect(screen.getByText("Inspect expansion state")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByText("Inspect expansion state")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("Inspect expansion state")).toBeTruthy();
  });

  test("uses display names for task-group titles when no tool title is present", () => {
    const message: NativeMessageType = {
      id: "msg-task-group-display-tool-name",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "task-group",
          content: "",
          task: {
            type: "tool-invocation",
            content: "",
            toolName: "bash",
            toolState: "success",
          },
          childTools: [],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByRole("button", { name: /Run Command/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /\bbash\b/i })).toBeNull();
  });

  test("reveals tool errors for non-edit tools when the row is expanded", () => {
    const message: NativeMessageType = {
      id: "msg-generic-tool-error",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolArgs: { command: "rg --files" },
          toolState: "failure",
          toolError: "rg: command not found",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", {
      name: /Run Command rg --files failure/i,
    });
    expect(screen.queryByText("rg: command not found")).toBeNull();

    fireEvent.click(trigger);

    expect(screen.getByText("rg: command not found")).toBeTruthy();
  });

  test("formats non-command tool arguments as pretty-printed JSON", () => {
    const message: NativeMessageType = {
      id: "msg-generic-tool-json-input",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Glob",
          toolName: "Glob",
          toolArgs: { pattern: "*.ts", path: "/workspace/src" },
          toolState: "success",
        },
      ],
    };

    const { container } = render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /glob \*\.ts success/i }));

    const input = container.querySelector("pre");
    expect(input?.textContent).toBe(
      '{\n  "pattern": "*.ts",\n  "path": "/workspace/src"\n}',
    );
  });

  test("labels pending tools as running and colours terminal tool states", () => {
    const message: NativeMessageType = {
      id: "msg-generic-tool-states",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolArgs: { command: "sleep 1" },
          toolState: "pending",
        },
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolArgs: { command: "echo ok" },
          toolState: "success",
        },
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolArgs: { command: "echo bad" },
          toolState: "failure",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const running = screen.getByText("running...");
    expect(running.className).toContain("animate-pulse");
    expect(running.className).toContain("text-yellow-600");
    expect(screen.queryByText("pending")).toBeNull();

    expect(screen.getByText("success").className).toContain("text-green-600");
    expect(screen.getByText("failure").className).toContain("text-red-400");
  });

  test("disables generic tool rows with nothing to expand and hides the chevron", () => {
    const message: NativeMessageType = {
      id: "msg-generic-tool-no-details",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Bash",
          toolState: "success",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", { name: /Run Command success/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.className).toContain("cursor-default");

    const chevron = trigger.querySelector("svg");
    expect(chevron?.getAttribute("class")).toContain("opacity-0");
  });

  test("shows a label for file paths without a directory separator", () => {
    const message: NativeMessageType = {
      id: "msg-generic-tool-bare-file-path",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Read",
          toolName: "Read",
          toolArgs: { file_path: "README.md" },
          toolState: "success",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(
      screen.getByRole("button", { name: /read README\.md success/i }),
    ).toBeTruthy();
  });

  test("prefers the command over other argument keys in collapsed tool rows", () => {
    const message: NativeMessageType = {
      id: "msg-generic-tool-arg-precedence",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Bash",
          toolName: "Bash",
          toolArgs: {
            command: "ls -la",
            file_path: "/workspace/src/other.ts",
            pattern: "*.ts",
            query: "unused query",
          },
          toolState: "success",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", {
      name: /Run Command ls -la success/i,
    });
    expect(trigger.textContent).not.toContain("other.ts");
    expect(trigger.textContent).not.toContain("unused query");
  });

  test("counts additions and deletions from raw diff output without diff metadata", () => {
    const rawDiff = [
      "--- a/src/raw.ts",
      "+++ b/src/raw.ts",
      "@@ -1,2 +1,3 @@",
      " const value = 1;",
      "-const removed = true;",
      "+const added = true;",
      "+const alsoAdded = true;",
    ].join("\n");
    const message: NativeMessageType = {
      id: "msg-edit-raw-diff-stats",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolOutput: rawDiff,
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    // +++/--- headers must not be counted: otherwise this would read +3 -2.
    const trigger = screen.getByRole("button", {
      name: /edit \+2 -1 success/i,
    });
    expect(trigger.textContent).not.toContain("+3");
    expect(trigger.textContent).not.toContain("-2");
  });

  test("renders unchanged diff context lines with muted styling", () => {
    const message: NativeMessageType = {
      id: "msg-edit-diff-context-lines",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/context.ts",
            diff: "@@ -1,3 +1,3 @@\n unchanged line\n-old line\n+new line",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    fireEvent.click(screen.getByRole("button", { name: /edit context\.ts/i }));

    const contextLine = screen.getByText("unchanged line");
    expect(contextLine.className).toContain("text-foreground/60");
    expect(contextLine.className).not.toContain("bg-green-500/20");
    expect(contextLine.className).not.toContain("bg-red-500/20");

    expect(screen.getByText("+new line").className).toContain("bg-green-500/20");
    expect(screen.getByText("-old line").className).toContain("bg-red-500/20");
    expect(screen.getByText("@@ -1,3 +1,3 @@").className).toContain(
      "text-blue-400",
    );
  });

  test("omits the unused stat when an edit only adds or only removes lines", () => {
    const message: NativeMessageType = {
      id: "msg-edit-single-sided-stats",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Write",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/added.ts",
            additions: 3,
            deletions: 0,
          },
        },
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/removed.ts",
            additions: 0,
            deletions: 4,
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    const additionsOnly = screen.getByRole("button", {
      name: /write added\.ts \+3 success/i,
    });
    expect(additionsOnly.querySelector(".text-green-500")?.textContent).toBe("+3");
    expect(additionsOnly.querySelector(".text-red-400")).toBeNull();
    expect(additionsOnly.textContent).not.toContain("-0");

    const deletionsOnly = screen.getByRole("button", {
      name: /edit removed\.ts -4 success/i,
    });
    expect(deletionsOnly.querySelector(".text-red-400")?.textContent).toBe("-4");
    expect(deletionsOnly.querySelector(".text-green-500")).toBeNull();
    expect(deletionsOnly.textContent).not.toContain("+0");
  });

  test("renders both the diff and the error for a partially failed edit", () => {
    const message: NativeMessageType = {
      id: "msg-edit-diff-with-error",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "failure",
          toolError: "Failed to write remaining hunks",
          toolDiff: {
            filePath: "/workspace/src/partial.ts",
            diff: "@@ -1 +1 @@\n-before\n+after",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /edit partial\.ts failure/i }),
    );

    expect(screen.getByText("-before")).toBeTruthy();
    expect(screen.getByText("+after")).toBeTruthy();
    expect(screen.getByText("Failed to write remaining hunks")).toBeTruthy();
  });

  test("labels pending edit tools as running", () => {
    const message: NativeMessageType = {
      id: "msg-edit-pending-state",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolState: "pending",
          toolDiff: {
            filePath: "/workspace/src/pending.ts",
            after: "const pending = true;",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    const running = screen.getByText("running...");
    expect(running.className).toContain("animate-pulse");
    expect(
      screen.getByRole("button", { name: /edit pending\.ts \+1 running/i }),
    ).toBeTruthy();
  });

  test("derives image mime types from the container attachment extension", async () => {
    const message: NativeMessageType = {
      id: "msg-container-mime-types",
      role: "user",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "file", content: "/workspace/shots/screenshot.jpg" },
        { type: "file", content: "/workspace/icons/logo.svg" },
      ],
    };

    render(<NativeMessage message={message} containerId="container-1" />);

    fireEvent.click(screen.getByRole("button", { name: /screenshot\.jpg/i }));
    const jpeg = await screen.findByAltText("screenshot.jpg");
    expect(jpeg.getAttribute("src")).toBe(
      "data:image/jpeg;base64,container-image-base64",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByAltText("screenshot.jpg")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /logo\.svg/i }));
    const svg = await screen.findByAltText("logo.svg");
    expect(svg.getAttribute("src")).toBe(
      "data:image/svg+xml;base64,container-image-base64",
    );
  });

  test.each([
    ["gif", "image/gif"],
    ["jpeg", "image/jpeg"],
    ["bmp", "image/bmp"],
    ["ico", "image/x-icon"],
    ["tif", "image/tiff"],
    ["tiff", "image/tiff"],
  ])("maps .%s container images to %s", async (extension, mimeType) => {
    const filename = `alias.${extension}`;
    const message: NativeMessageType = {
      id: `msg-container-mime-${extension}`,
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: `/workspace/${filename}` }],
    };

    render(<NativeMessage message={message} containerId="container-1" />);
    fireEvent.click(screen.getByRole("button", { name: filename }));

    const image = await screen.findByAltText(filename);
    expect(image.getAttribute("src")).toBe(
      `data:${mimeType};base64,container-image-base64`,
    );
  });

  test("strips query strings and fragments from image paths and defaults unknown extensions to png", async () => {
    const message: NativeMessageType = {
      id: "msg-mime-query-and-fallback",
      role: "user",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "file", content: "/workspace/shots/photo.webp?v=2#top" },
        { type: "file", content: "/workspace/shots/fragment.jpg#preview" },
        { type: "file", content: "/workspace/shots/archive.png.bak" },
      ],
    };

    render(<NativeMessage message={message} containerId="container-1" />);

    fireEvent.click(screen.getByRole("button", { name: /photo\.webp/i }));
    const webp = await screen.findByAltText("photo.webp?v=2#top");
    expect(webp.getAttribute("src")).toBe(
      "data:image/webp;base64,container-image-base64",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByAltText("photo.webp?v=2#top")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /fragment\.jpg/i }));
    const fragment = await screen.findByAltText("fragment.jpg#preview");
    expect(fragment.getAttribute("src")).toBe(
      "data:image/jpeg;base64,container-image-base64",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByAltText("fragment.jpg#preview")).toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: /archive\.png\.bak/i }));
    const fallback = await screen.findByAltText("archive.png.bak");
    expect(fallback.getAttribute("src")).toBe(
      "data:image/png;base64,container-image-base64",
    );
  });

  test("shows an in-flight loading state while an image attachment is read", async () => {
    let resolveRead: ((value: string) => void) | undefined;
    const pendingRead = new Promise<string>((resolve) => {
      resolveRead = resolve;
    });
    mockReadFileBase64.mockImplementationOnce(() => pendingRead);
    const message: NativeMessageType = {
      id: "msg-file-preview-loading",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/tmp/slow.png" }],
    };

    render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /slow\.png/i }));

    const attachment = screen.getByRole("button", { name: /slow\.png/i });
    expect(screen.getByText("(loading...)")).toBeTruthy();
    expect(attachment.className).toContain("opacity-50");
    expect((attachment as HTMLButtonElement).disabled).toBe(true);

    resolveRead?.("slow-base64");

    const image = await screen.findByAltText("slow.png");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,slow-base64");
    await waitFor(() => expect(screen.queryByText("(loading...)")).toBeNull());
  });

  test("shows the error state when an image read rejects with a non-Error value", async () => {
    const consoleError = console.error;
    console.error = mock(() => {}) as typeof console.error;
    mockReadFileBase64.mockImplementationOnce(async () => {
      throw "boom";
    });
    const message: NativeMessageType = {
      id: "msg-file-preview-non-error-rejection",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/tmp/broken.png" }],
    };

    try {
      render(<NativeMessage message={message} />);

      fireEvent.click(screen.getByRole("button", { name: /broken\.png/i }));

      await waitFor(() => expect(screen.getByText("(error)")).toBeTruthy());
      expect(screen.queryByAltText("broken.png")).toBeNull();
      expect(screen.queryByText("(loading...)")).toBeNull();
    } finally {
      console.error = consoleError;
    }
  });

  test("falls back to the raw path and a generic label for attachment display names", () => {
    const message: NativeMessageType = {
      id: "msg-file-display-name-fallbacks",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "file", content: "notes-only.txt" },
        { type: "file", content: "" },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByRole("button", { name: "notes-only.txt" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "file" })).toBeTruthy();
  });

  test("ignores non-Escape keys and detaches the overlay listener on unmount", async () => {
    const message: NativeMessageType = {
      id: "msg-overlay-key-handling",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "file", content: "/tmp/overlay-keys.png" }],
    };

    const { unmount } = render(<NativeMessage message={message} />);

    fireEvent.click(screen.getByRole("button", { name: /overlay-keys\.png/i }));
    await screen.findByAltText("overlay-keys.png");

    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByAltText("overlay-keys.png")).toBeTruthy();

    const consoleError = console.error;
    const mockConsoleError = mock(() => {});
    console.error = mockConsoleError as typeof console.error;
    try {
      unmount();
      fireEvent.keyDown(window, { key: "Escape" });

      expect(screen.queryByAltText("overlay-keys.png")).toBeNull();
      expect(mockConsoleError).not.toHaveBeenCalled();
    } finally {
      console.error = consoleError;
    }
  });

  test("keeps the copy control on subagent child text updates", () => {
    const message: NativeMessageType = {
      id: "msg-subagent-child-copy",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "subagent",
          content: "Noether",
          subagentId: "agent-child-copy",
          subagentName: "Noether",
          subagentActionCount: 1,
          toolState: "success",
          subagentActions: [
            { type: "text", content: "Child summary worth copying." },
          ],
        },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.queryAllByRole("button", { name: "Copy text" })).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /noether/i }));

    expect(screen.getAllByRole("button", { name: "Copy text" })).toHaveLength(1);
  });

  test("truncates user prompts strictly above the collapsed line count", () => {
    const buildContent = (lines: number) =>
      Array.from({ length: lines }, (_, index) => `Line ${index + 1}`).join("\n");
    const boundaryMessage: NativeMessageType = {
      id: "msg-user-prompt-boundary-12",
      role: "user",
      content: buildContent(12),
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "text", content: buildContent(12) }],
    };
    const overBoundaryMessage: NativeMessageType = {
      id: "msg-user-prompt-boundary-13",
      role: "user",
      content: buildContent(13),
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "text", content: buildContent(13) }],
    };

    const { rerender } = render(<NativeMessage message={boundaryMessage} />);

    expect(screen.queryByRole("button", { name: "show more" })).toBeNull();

    rerender(<NativeMessage message={overBoundaryMessage} />);

    expect(screen.getByRole("button", { name: "show more" })).toBeTruthy();
  });

  test("renders explicit system roles with system-message styling", () => {
    const message: NativeMessageType = {
      id: "ordinary-message-id",
      role: "system",
      content: "Workspace configuration changed",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [],
    };

    const { container } = render(<NativeMessage message={message} />);

    expect(screen.getByText("Workspace configuration changed")).toBeTruthy();
    expect(container.querySelector(".italic")).toBeTruthy();
    expect(screen.queryByText("Assistant")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy text" })).toBeNull();
  });

  test("shows a fresh assistant header after a previous error in the same minute", () => {
    const previousMessage: NativeMessageType = {
      id: "error-previous-response",
      role: "assistant",
      content: "Temporary bridge failure",
      createdAt: "2026-03-07T12:00:05.000Z",
      parts: [],
    };
    const message: NativeMessageType = {
      id: "assistant-after-error",
      role: "assistant",
      content: "Recovered response",
      createdAt: "2026-03-07T12:00:20.000Z",
      parts: [{ type: "text", content: "Recovered response" }],
    };

    render(
      <NativeMessage
        message={message}
        previousMessage={previousMessage}
        assistantLabel="Worker"
      />,
    );

    expect(screen.getByText("Worker")).toBeTruthy();
    expect(screen.getByText("Recovered response")).toBeTruthy();
  });

  test("uses message content for copying when the only text part is whitespace", async () => {
    const message: NativeMessageType = {
      id: "msg-whitespace-text-copy-fallback",
      role: "user",
      content: "Fallback copy content",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [{ type: "text", content: "  \n\t " }],
    };

    render(<NativeMessage message={message} />);

    expect(screen.queryByText("Fallback copy content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Fallback copy content");
    });
  });

  test("joins multiple assistant text parts when copying the message", async () => {
    const message: NativeMessageType = {
      id: "msg-multiple-assistant-text-copy",
      role: "assistant",
      content: "Legacy combined content",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        { type: "text", content: "First assistant block" },
        { type: "text", content: "Second assistant block" },
      ],
    };

    render(<NativeMessage message={message} />);

    expect(screen.getByText("First assistant block")).toBeTruthy();
    expect(screen.getByText("Second assistant block")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy text" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(
        "First assistant block\n\nSecond assistant block",
      );
    });
  });

  test("trims model IDs before resolving and rendering assistant labels", () => {
    const resolveModelLabel = mock((modelId: string) => `  ${modelId} label  `);
    const message: NativeMessageType = {
      id: "msg-trimmed-model-id",
      role: "assistant",
      content: "Model-labelled response",
      createdAt: "2026-03-07T12:00:00.000Z",
      modelId: "  gpt-example  ",
      parts: [{ type: "text", content: "Model-labelled response" }],
    };

    render(
      <NativeMessage
        message={message}
        assistantLabel="Fallback assistant"
        resolveModelLabel={resolveModelLabel}
      />,
    );

    expect(resolveModelLabel).toHaveBeenCalledWith("gpt-example");
    expect(screen.getByText("gpt-example label")).toBeTruthy();
    expect(screen.queryByText("Fallback assistant")).toBeNull();
  });

  test("omits a filename summary for generic tool paths ending in a separator", () => {
    const message: NativeMessageType = {
      id: "msg-tool-trailing-separator",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Read",
          toolName: "Read",
          toolArgs: { file_path: "/workspace/src/" },
          toolState: "success",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", { name: /read success/i });
    expect(trigger.textContent).not.toContain("workspace");
    expect(trigger.textContent).not.toContain("src");

    fireEvent.click(trigger);
    expect(screen.getByText(/"file_path": "\/workspace\/src\/"/)).toBeTruthy();
  });

  test("uses an edit tool title when a trailing-separator path has no filename", () => {
    const message: NativeMessageType = {
      id: "msg-edit-title-without-filename",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "",
          toolName: "Edit",
          toolTitle: "Apply Workspace Patch",
          toolState: "success",
          toolDiff: {
            filePath: "/workspace/src/",
            before: "old value",
            after: "new value",
          },
        },
      ],
    };

    render(
      <TerminalContextHarness>
        <NativeMessage message={message} />
      </TerminalContextHarness>,
    );

    const trigger = screen.getByRole("button", {
      name: /edit apply workspace patch \+1 -1 success/i,
    });
    expect(trigger.textContent).not.toContain("src");

    fireEvent.click(trigger);
    expect(screen.getByText("/workspace/src/")).toBeTruthy();
    expect(screen.getByText("-old value")).toBeTruthy();
    expect(screen.getByText("+new value")).toBeTruthy();
  });

  test("expands generic tools that have output but no arguments", () => {
    const message: NativeMessageType = {
      id: "msg-generic-output-only",
      role: "assistant",
      content: "",
      createdAt: "2026-03-07T12:00:00.000Z",
      parts: [
        {
          type: "tool-invocation",
          content: "Inspect",
          toolName: "Inspect",
          toolState: "success",
          toolOutput: "Inspection completed without input arguments.",
        },
      ],
    };

    render(<NativeMessage message={message} />);

    const trigger = screen.getByRole("button", { name: /inspect success/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Inspection completed without input arguments.")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("Inspection completed without input arguments.")).toBeTruthy();
  });
});
