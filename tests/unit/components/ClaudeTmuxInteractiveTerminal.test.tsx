import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as realXterm from "@xterm/xterm";
import * as realFitAddon from "@xterm/addon-fit";
import * as realTauriEvent from "@/lib/native/events";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import * as realTerminalPaste from "@/lib/terminal-paste";
import * as realClipboardImagePaste from "@/hooks/useClipboardImagePaste";

const realXtermSnapshot = { ...realXterm };
const realFitAddonSnapshot = { ...realFitAddon };
const realTauriEventSnapshot = { ...realTauriEvent };
const realTmuxClientSnapshot = { ...realTmuxClient };
const realTerminalPasteSnapshot = { ...realTerminalPaste };
const realClipboardImagePasteSnapshot = { ...realClipboardImagePaste };

type OutputHandler = (event: { payload: number[] }) => void;
type KeyHandler = (event: KeyboardEvent) => boolean;
type ImagePasteOptions = {
  onImageSaved?: (filePath: string) => void | Promise<void>;
  onError?: (message: string) => void | Promise<void>;
};

let capturedImagePasteOptions: ImagePasteOptions | null = null;

const terminalInstances: MockTerminal[] = [];
const fitInstances: MockFitAddon[] = [];
let outputHandler: OutputHandler | null = null;
let resizeCallback: ResizeObserverCallback | null = null;

class MockTerminal {
  cols = 120;
  rows = 30;
  writes: Uint8Array[] = [];
  focused = false;
  disposed = false;
  dataHandlers: Array<(data: string) => void> = [];
  keyHandler: KeyHandler | null = null;

  constructor() {
    terminalInstances.push(this);
  }

  loadAddon() {}

  open() {}

  onData(handler: (data: string) => void) {
    this.dataHandlers.push(handler);
    return {
      dispose: mock(() => {
        this.dataHandlers = this.dataHandlers.filter((item) => item !== handler);
      }),
    };
  }

  attachCustomKeyEventHandler(handler: KeyHandler) {
    this.keyHandler = handler;
  }

  emitData(data: string) {
    this.dataHandlers.forEach((handler) => handler(data));
  }

  emitKey(event: Partial<KeyboardEvent>) {
    return this.keyHandler?.(event as KeyboardEvent);
  }

  write(data: Uint8Array) {
    this.writes.push(data);
  }

  focus() {
    this.focused = true;
  }

  dispose() {
    this.disposed = true;
  }
}

class MockFitAddon {
  fit = mock(() => {});

  constructor() {
    fitInstances.push(this);
  }
}

const listenMock = mock(async (_eventName: string, handler: OutputHandler) => {
  outputHandler = handler;
  return unlistenMock;
});
const unlistenMock = mock(() => {});
const createInteractiveTerminalMock = mock(async () => "pty-1");
const startInteractiveTerminalMock = mock(async () => {});
const writeInteractiveTerminalMock = mock(async () => {});
const resizeInteractiveTerminalMock = mock(async () => {});
const detachInteractiveTerminalMock = mock(async () => {});
const handleTerminalPasteMock = mock(async () => {});

mock.module("@xterm/xterm", () => ({
  Terminal: MockTerminal,
}));

mock.module("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
}));

mock.module("@/lib/native/events", () => ({
  ...realTauriEventSnapshot,
  listen: listenMock,
}));

mock.module("@/lib/claude-tmux-client", () => ({
  ...realTmuxClientSnapshot,
  createInteractiveTerminal: createInteractiveTerminalMock,
  startInteractiveTerminal: startInteractiveTerminalMock,
  writeInteractiveTerminal: writeInteractiveTerminalMock,
  resizeInteractiveTerminal: resizeInteractiveTerminalMock,
  detachInteractiveTerminal: detachInteractiveTerminalMock,
}));

mock.module("@/lib/terminal-paste", () => ({
  ...realTerminalPasteSnapshot,
  handleTerminalPaste: handleTerminalPasteMock,
}));

// Capture the options the component passes to the clipboard image-paste hook
// (DOM/right-click path) so we can drive its onImageSaved/onError callbacks
// directly. The hook itself is covered by useClipboardImagePaste.test.ts.
mock.module("@/hooks/useClipboardImagePaste", () => ({
  ...realClipboardImagePasteSnapshot,
  useClipboardImagePaste: (options: ImagePasteOptions) => {
    capturedImagePasteOptions = options;
  },
}));

const { ClaudeTmuxInteractiveTerminal } = await import(
  "@/components/claude/ClaudeTmuxInteractiveTerminal"
);

describe("ClaudeTmuxInteractiveTerminal", () => {
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const environmentId = "env-1";

  afterAll(() => {
    mock.module("@xterm/xterm", () => realXtermSnapshot);
    mock.module("@xterm/addon-fit", () => realFitAddonSnapshot);
    mock.module("@/lib/native/events", () => realTauriEventSnapshot);
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
    mock.module("@/lib/terminal-paste", () => realTerminalPasteSnapshot);
    mock.module("@/hooks/useClipboardImagePaste", () => realClipboardImagePasteSnapshot);
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  beforeEach(() => {
    cleanup();
    terminalInstances.length = 0;
    fitInstances.length = 0;
    outputHandler = null;
    resizeCallback = null;
    listenMock.mockClear();
    unlistenMock.mockClear();
    createInteractiveTerminalMock.mockClear();
    createInteractiveTerminalMock.mockResolvedValue("pty-1");
    startInteractiveTerminalMock.mockClear();
    startInteractiveTerminalMock.mockResolvedValue(undefined);
    writeInteractiveTerminalMock.mockClear();
    resizeInteractiveTerminalMock.mockClear();
    detachInteractiveTerminalMock.mockClear();
    handleTerminalPasteMock.mockClear();
    handleTerminalPasteMock.mockResolvedValue(undefined);
    capturedImagePasteOptions = null;

    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    globalThis.ResizeObserver = class ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe() {}

      unobserve() {}

      disconnect() {}
    };
  });

  test("attaches, forwards terminal output and input, resizes, and detaches on unmount", async () => {
    const { unmount } = render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

    expect(createInteractiveTerminalMock).toHaveBeenCalledWith("tab-1", 120, 30, environmentId);
    expect(listenMock.mock.calls[0]?.[0]).toBe("terminal-output-pty-1");
    expect(resizeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", 120, 30);

    act(() => {
      outputHandler?.({ payload: [65, 66] });
      terminalInstances[0]!.emitData("x");
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(Array.from(terminalInstances[0]!.writes[0]!)).toEqual([65, 66]);
    await waitFor(() =>
      expect(writeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", "x"),
    );
    expect(resizeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", 120, 30);
    expect(terminalInstances[0]!.focused).toBe(true);

    unmount();

    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
    expect(terminalInstances[0]!.disposed).toBe(true);
  });

  test("handles keyboard paste through the shared terminal paste helper", async () => {
    handleTerminalPasteMock.mockImplementationOnce(async (options) => {
      await options.writeToTerminal("/workspace/.orkestrator/clipboard/image.png ");
      options.focusTerminal();
    });
    const preventDefault = mock(() => {});

    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        containerId="container-1"
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

    const handled = terminalInstances[0]!.emitKey({
      type: "keydown",
      key: "v",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      preventDefault,
    });

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalled();

    await waitFor(() => {
      expect(handleTerminalPasteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          containerId: "container-1",
          componentName: "ClaudeTmuxInteractiveTerminal",
        }),
      );
      expect(writeInteractiveTerminalMock).toHaveBeenCalledWith(
        "pty-1",
        "/workspace/.orkestrator/clipboard/image.png ",
      );
    });
    expect(terminalInstances[0]!.focused).toBe(true);
  });

  test("does not recreate the tmux session when paste-related props change", async () => {
    const { rerender } = render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        worktreePath={undefined}
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);

    // A change to worktreePath (e.g. environment store loads after mount) used to
    // change the paste handler's identity and tear down the whole terminal.
    rerender(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        worktreePath="/tmp/worktrees/env"
        isActive
      />,
    );

    await waitFor(() => expect(capturedImagePasteOptions).not.toBeNull());

    // Session must NOT have been recreated/detached.
    expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
    expect(detachInteractiveTerminalMock).not.toHaveBeenCalled();
    expect(terminalInstances).toHaveLength(1);
    expect(terminalInstances[0]!.disposed).toBe(false);

    // The key handler must still route the paste using the UPDATED props.
    terminalInstances[0]!.emitKey({
      type: "keydown",
      key: "v",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      preventDefault: mock(() => {}),
    });

    await waitFor(() =>
      expect(handleTerminalPasteMock).toHaveBeenCalledWith(
        expect.objectContaining({ worktreePath: "/tmp/worktrees/env" }),
      ),
    );
  });

  test("escapes saved image paths for local environments but not containers", async () => {
    // Local environment (no containerId): path must be shell-escaped.
    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        worktreePath="/tmp/worktrees/env"
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    expect(capturedImagePasteOptions?.onImageSaved).toBeDefined();

    await act(async () => {
      await capturedImagePasteOptions!.onImageSaved!(
        "/tmp/my project/.orkestrator/clipboard/image.png",
      );
    });

    expect(writeInteractiveTerminalMock).toHaveBeenCalledWith(
      "pty-1",
      "/tmp/my\\ project/.orkestrator/clipboard/image.png ",
    );
    expect(terminalInstances[0]!.focused).toBe(true);

    writeInteractiveTerminalMock.mockClear();
    cleanup();
    terminalInstances.length = 0;
    capturedImagePasteOptions = null;

    // Container environment: path is written verbatim (no escaping).
    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-2"
        environmentId={environmentId}
        containerId="container-1"
        isActive
      />,
    );

    await waitFor(() => expect(capturedImagePasteOptions?.onImageSaved).toBeDefined());

    await act(async () => {
      await capturedImagePasteOptions!.onImageSaved!(
        "/workspace/.orkestrator/clipboard/image.png",
      );
    });

    expect(writeInteractiveTerminalMock).toHaveBeenCalledWith(
      "pty-1",
      "/workspace/.orkestrator/clipboard/image.png ",
    );
  });

  test("logs clipboard image errors without throwing", async () => {
    const consoleError = mock(() => {});
    const originalConsoleError = console.error;
    console.error = consoleError as unknown as typeof console.error;

    try {
      render(
        <ClaudeTmuxInteractiveTerminal
          tabId="tab-1"
          environmentId={environmentId}
          containerId="container-1"
          isActive
        />,
      );

      await waitFor(() => expect(capturedImagePasteOptions?.onError).toBeDefined());

      await act(async () => {
        await capturedImagePasteOptions!.onError!("Image too large (9.0MB). Maximum size is 8MB.");
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[ClaudeTmuxInteractiveTerminal] Clipboard image error:",
        "Image too large (9.0MB). Maximum size is 8MB.",
      );
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("cleans up the created session and listener when start fails", async () => {
    startInteractiveTerminalMock.mockRejectedValueOnce(new Error("spawn failed"));

    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await screen.findByText("Error: spawn failed");

    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
  });

  test("does not start a session if the component unmounts while listener setup is pending", async () => {
    let resolveListen: ((unlisten: () => void) => void) | null = null;
    listenMock.mockImplementationOnce((_eventName, handler: OutputHandler) => {
      outputHandler = handler;
      return new Promise((resolve) => {
        resolveListen = resolve;
      });
    });

    const { unmount } = render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(1));
    unmount();

    await act(async () => {
      resolveListen?.(unlistenMock);
      await Promise.resolve();
    });

    expect(startInteractiveTerminalMock).not.toHaveBeenCalled();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
  });
});
