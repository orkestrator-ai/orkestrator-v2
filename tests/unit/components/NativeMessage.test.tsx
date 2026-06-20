import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import type { NativeMessage as NativeMessageType } from "../../../src/lib/chat/native-message-types";
import { mockWriteText } from "../../mocks/clipboard";
import {
  type CreateFileTabOptions,
  TerminalProvider,
  useTerminalContext,
} from "../../../src/contexts/TerminalContext";

const mockOpenInBrowser = mock(async () => {});
const mockReadFileBase64 = mock(async () => "image-base64");
const mockReadContainerFileBase64 = mock(async () => "container-image-base64");

mock.module("@/lib/tauri", () => ({
  openInBrowser: mockOpenInBrowser,
  readContainerFileBase64: mockReadContainerFileBase64,
  readFileBase64: mockReadFileBase64,
}));

import { NativeMessage } from "../../../src/components/chat/NativeMessage";

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

describe("NativeMessage", () => {
  afterEach(() => {
    cleanup();
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

    const hiddenRow = container.querySelector(".group-hover\\:opacity-100") as HTMLElement;
    expect(hiddenRow).not.toBeNull();
    expect(hiddenRow.textContent).toContain("12:00");

    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("Copy this user prompt");
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
    expect(screen.getByText("Worker")).toBeTruthy();
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
      "/workspace/.orkestrator/clipboard/screenshot.png",
    );
    expect(mockReadFileBase64).not.toHaveBeenCalled();
    expect(image.getAttribute("src")).toBe("data:image/png;base64,container-image-base64");
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
      name: /run_command pwd && rg --files \| head -200 success/i,
    });
    expect(trigger).toBeTruthy();
    expect(screen.queryByText("Bash")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("$ pwd && rg --files | head -200")).toBeTruthy();
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
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("1 tool")).toBeTruthy();
    expect(screen.getByText("1 update")).toBeTruthy();
    expect(screen.getByText('rg -n "codex" src')).toBeTruthy();
    expect(screen.queryByText("Inspect the Codex integration")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /lovelace/i }));

    expect(screen.getByText("Inspect the Codex integration")).toBeTruthy();
    expect(screen.getByRole("button", { name: /exec_command rg -n "codex" src success/i })).toBeTruthy();
    fireEvent.click(screen.getAllByText("exec_command")[0]!);
    expect(screen.getByText("$ rg -n \"codex\" src")).toBeTruthy();
    expect(screen.getByText("matches")).toBeTruthy();
  });

  test("renders success and failure subagent states when no activity was captured", () => {
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

    expect(screen.getByText("Success")).toBeTruthy();
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

    expect(screen.getByText("run_command")).toBeTruthy();
    expect(screen.queryByText("bash")).toBeNull();
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

    expect(screen.getByRole("button", { name: /run_command/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /\bbash\b/i })).toBeNull();
  });
});
