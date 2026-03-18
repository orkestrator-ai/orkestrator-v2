import { describe, test, expect, mock, beforeEach } from "bun:test";

// Track calls to the process functions
const mockProcessClipboardPaste = mock<
  (
    containerId: string,
    onImageSaved?: (filePath: string) => void | Promise<void>,
    onTextPaste?: (text: string) => void | Promise<void>,
    onError?: (error: string) => void
  ) => Promise<boolean>
>(() => Promise.resolve(true));

const mockProcessLocalClipboardPaste = mock<
  (
    worktreePath: string,
    onImageSaved?: (filePath: string) => void | Promise<void>,
    onTextPaste?: (text: string) => void | Promise<void>,
    onError?: (error: string) => void
  ) => Promise<boolean>
>(() => Promise.resolve(true));

const mockReadText = mock<() => Promise<string>>(() => Promise.resolve("pasted text"));

// Mock dependencies before importing
mock.module("@/hooks/useClipboardImagePaste", () => ({
  processClipboardPaste: mockProcessClipboardPaste,
  processLocalClipboardPaste: mockProcessLocalClipboardPaste,
}));

mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: mockReadText,
}));

import { escapePathForTerminalInput, handleTerminalPaste } from "../../../src/lib/terminal-paste";

describe("handleTerminalPaste", () => {
  const mockWriteToTerminal = mock<(text: string) => Promise<void>>(() => Promise.resolve());
  const mockFocusTerminal = mock(() => {});

  beforeEach(() => {
    mockProcessClipboardPaste.mockClear();
    mockProcessLocalClipboardPaste.mockClear();
    mockReadText.mockClear();
    mockWriteToTerminal.mockClear();
    mockFocusTerminal.mockClear();
    mockReadText.mockImplementation(() => Promise.resolve("pasted text"));
  });

  test("uses processClipboardPaste for container environments", async () => {
    await handleTerminalPaste({
      containerId: "container-123",
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockProcessClipboardPaste).toHaveBeenCalledTimes(1);
    expect(mockProcessClipboardPaste.mock.calls[0][0]).toBe("container-123");
    expect(mockProcessLocalClipboardPaste).not.toHaveBeenCalled();
    expect(mockReadText).not.toHaveBeenCalled();
  });

  test("uses processLocalClipboardPaste for local environments with worktreePath", async () => {
    await handleTerminalPaste({
      containerId: null,
      worktreePath: "/tmp/worktrees/my-env",
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockProcessLocalClipboardPaste).toHaveBeenCalledTimes(1);
    expect(mockProcessLocalClipboardPaste.mock.calls[0][0]).toBe("/tmp/worktrees/my-env");
    expect(mockProcessClipboardPaste).not.toHaveBeenCalled();
    expect(mockReadText).not.toHaveBeenCalled();
  });

  test("falls back to text-only paste when neither containerId nor worktreePath", async () => {
    await handleTerminalPaste({
      containerId: null,
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockReadText).toHaveBeenCalledTimes(1);
    expect(mockWriteToTerminal).toHaveBeenCalledWith("pasted text");
    expect(mockFocusTerminal).toHaveBeenCalled();
    expect(mockProcessClipboardPaste).not.toHaveBeenCalled();
    expect(mockProcessLocalClipboardPaste).not.toHaveBeenCalled();
  });

  test("text-only fallback does nothing when clipboard is empty", async () => {
    mockReadText.mockImplementation(() => Promise.resolve(""));

    await handleTerminalPaste({
      containerId: null,
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockReadText).toHaveBeenCalledTimes(1);
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(mockFocusTerminal).not.toHaveBeenCalled();
  });

  test("text-only fallback handles clipboard read error", async () => {
    mockReadText.mockImplementation(() => Promise.reject(new Error("clipboard unavailable")));
    const consoleSpy = mock(() => {});
    const originalError = console.error;
    console.error = consoleSpy;

    await handleTerminalPaste({
      containerId: null,
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "TestComp",
    });

    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    console.error = originalError;
  });

  test("prefers containerId over worktreePath when both provided", async () => {
    await handleTerminalPaste({
      containerId: "container-123",
      worktreePath: "/tmp/worktrees/my-env",
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockProcessClipboardPaste).toHaveBeenCalledTimes(1);
    expect(mockProcessLocalClipboardPaste).not.toHaveBeenCalled();
  });

  test("container paste callbacks write path with trailing space for images", async () => {
    // Capture the callbacks passed to processClipboardPaste
    mockProcessClipboardPaste.mockImplementation(
      async (_containerId, onImageSaved, _onTextPaste, _onError) => {
        onImageSaved?.("/workspace/.orkestrator/clipboard/image.png");
        return true;
      }
    );

    await handleTerminalPaste({
      containerId: "container-123",
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockWriteToTerminal).toHaveBeenCalledWith("/workspace/.orkestrator/clipboard/image.png ");
    expect(mockFocusTerminal).toHaveBeenCalled();
  });

  test("local paste callbacks write path with trailing space for images", async () => {
    mockProcessLocalClipboardPaste.mockImplementation(
      async (_worktreePath, onImageSaved, _onTextPaste, _onError) => {
        await onImageSaved?.("/tmp/worktrees/My Project/.orkestrator/clipboard/image (1).png");
        return true;
      }
    );

    await handleTerminalPaste({
      containerId: null,
      worktreePath: "/tmp/worktrees/my-env",
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockWriteToTerminal).toHaveBeenCalledWith(
      "/tmp/worktrees/My\\ Project/.orkestrator/clipboard/image\\ \\(1\\).png "
    );
    expect(mockFocusTerminal).toHaveBeenCalled();
  });

  test("local paste callbacks write text directly without trailing space", async () => {
    mockProcessLocalClipboardPaste.mockImplementation(
      async (_worktreePath, _onImageSaved, onTextPaste, _onError) => {
        onTextPaste?.("hello world");
        return true;
      }
    );

    await handleTerminalPaste({
      containerId: null,
      worktreePath: "/tmp/worktrees/my-env",
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    });

    expect(mockWriteToTerminal).toHaveBeenCalledWith("hello world");
    expect(mockFocusTerminal).toHaveBeenCalled();
  });

  test("waits for async local image writes before resolving", async () => {
    let resolveWrite: (() => void) | null = null;
    let pasteFinished = false;

    mockWriteToTerminal.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveWrite = resolve;
      })
    );

    mockProcessLocalClipboardPaste.mockImplementation(
      async (_worktreePath, onImageSaved, _onTextPaste, _onError) => {
        await onImageSaved?.("/tmp/worktrees/my-env/.orkestrator/clipboard/image.png");
        return true;
      }
    );

    const pastePromise = handleTerminalPaste({
      containerId: null,
      worktreePath: "/tmp/worktrees/my-env",
      writeToTerminal: mockWriteToTerminal,
      focusTerminal: mockFocusTerminal,
      componentName: "Test",
    }).then(() => {
      pasteFinished = true;
    });

    await Promise.resolve();
    expect(pasteFinished).toBe(false);

    expect(resolveWrite).not.toBeNull();
    resolveWrite!();
    await pastePromise;

    expect(pasteFinished).toBe(true);
    expect(mockFocusTerminal).toHaveBeenCalled();
  });
});

describe("escapePathForTerminalInput", () => {
  test("escapes spaces and shell metacharacters", () => {
    expect(escapePathForTerminalInput("/tmp/My Project/$draft(image)#1!.png")).toBe(
      "/tmp/My\\ Project/\\$draft\\(image\\)\\#1\\!.png"
    );
  });
});
