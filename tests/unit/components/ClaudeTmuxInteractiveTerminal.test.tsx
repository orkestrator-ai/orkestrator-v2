import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realXterm from "@xterm/xterm";
import * as realFitAddon from "@xterm/addon-fit";
import * as realBackendEvent from "@/lib/native/events";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import * as realTerminalPaste from "@/lib/terminal-paste";
import * as realClipboardImagePaste from "@/hooks/useClipboardImagePaste";
import type { TerminalOutputPayload } from "@/hooks/useTerminal";
import {
  emitViewportChange,
  restoreMatchMedia,
  setMobileViewport,
} from "../../mocks/match-media";

const realXtermSnapshot = { ...realXterm };
const realFitAddonSnapshot = { ...realFitAddon };
const realBackendEventSnapshot = { ...realBackendEvent };
const realTmuxClientSnapshot = { ...realTmuxClient };
const realTerminalPasteSnapshot = { ...realTerminalPaste };
const realClipboardImagePasteSnapshot = { ...realClipboardImagePaste };

type OutputHandler = (event: { payload: TerminalOutputPayload }) => void;
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
let fitFailure: Error | null = null;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
  fit = mock(() => {
    if (fitFailure) throw fitFailure;
  });

  constructor() {
    fitInstances.push(this);
  }
}

const listenMock = mock(async (
  _eventName: string,
  handler: OutputHandler,
  _options?: { signal?: AbortSignal },
) => {
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
  ...realBackendEventSnapshot,
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
    mock.module("@/lib/native/events", () => realBackendEventSnapshot);
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
    mock.module("@/lib/terminal-paste", () => realTerminalPasteSnapshot);
    mock.module("@/hooks/useClipboardImagePaste", () => realClipboardImagePasteSnapshot);
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    restoreMatchMedia();
  });

  beforeEach(() => {
    setMobileViewport(false);
    cleanup();
    terminalInstances.length = 0;
    fitInstances.length = 0;
    outputHandler = null;
    resizeCallback = null;
    fitFailure = null;
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

  test("fits without focusing the terminal when activated on mobile", async () => {
    setMobileViewport(true);
    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

    expect(fitInstances[0]!.fit).toHaveBeenCalled();
    expect(terminalInstances[0]!.focused).toBe(false);
  });

  test("shows contained mobile keys only while active and forwards canonical sequences", async () => {
    setMobileViewport(true);
    const view = render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive={false}
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();

    view.rerender(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    const toolbar = screen.getByRole("toolbar", { name: "Terminal keys" });
    expect(toolbar.parentElement?.className).toContain("relative");
    expect(toolbar.parentElement?.className).toContain("shrink-0");
    expect(toolbar.parentElement?.className).not.toContain("absolute");

    const expected = [
      ["Escape", "\u001b"],
      ["Tab", "\t"],
      ["Control C", "\u0003"],
      ["Up arrow", "\u001b[A"],
      ["Down arrow", "\u001b[B"],
      ["Left arrow", "\u001b[D"],
      ["Right arrow", "\u001b[C"],
    ] as const;
    for (const [name] of expected) {
      fireEvent.click(screen.getByRole("button", { name }));
    }

    await waitFor(() => {
      expect(writeInteractiveTerminalMock.mock.calls.slice(-expected.length)).toEqual(
        expected.map(([, data]) => ["pty-1", data]),
      );
    });
    expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
  });

  test("disables mobile keys until the tmux terminal has started", async () => {
    setMobileViewport(true);
    let resolveStart!: () => void;
    startInteractiveTerminalMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalled());
    expect(
      screen.getAllByRole("button").every((button) =>
        (button as HTMLButtonElement).disabled
      ),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Up arrow" }));
    expect(writeInteractiveTerminalMock).not.toHaveBeenCalled();

    resolveStart();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Up arrow" }) as HTMLButtonElement).disabled,
      ).toBe(false)
    );
  });

  test("focuses the terminal when it is attached on desktop", async () => {
    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

    await waitFor(() => expect(terminalInstances[0]!.focused).toBe(true));
  });

  test("focuses on desktop, but not on mobile, when the tab becomes active again", async () => {
    const view = render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive={false}
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    const terminal = terminalInstances[0]!;
    // The connect path focuses on desktop; reset so this test observes only
    // the isActive false -> true transition.
    terminal.focused = false;

    view.rerender(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );
    expect(terminal.focused).toBe(true);

    terminal.focused = false;
    act(() => emitViewportChange(true));
    view.rerender(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive={false}
      />,
    );
    view.rerender(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    expect(terminal.focused).toBe(false);
    // The same terminal instance throughout: a viewport change must never
    // tear down and recreate the tmux attachment.
    expect(terminalInstances).toHaveLength(1);
    expect(detachInteractiveTerminalMock).not.toHaveBeenCalled();
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

  test("reports a missing environment without creating a terminal session", async () => {
    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        isActive
      />,
    );

    await screen.findByText("No environment specified for interactive terminal");
    expect(createInteractiveTerminalMock).not.toHaveBeenCalled();
    expect(startInteractiveTerminalMock).not.toHaveBeenCalled();
  });

  test("reports session creation failures without attempting to start", async () => {
    createInteractiveTerminalMock.mockRejectedValueOnce(new Error("create failed"));

    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await screen.findByText("Error: create failed");
    expect(startInteractiveTerminalMock).not.toHaveBeenCalled();
    expect(detachInteractiveTerminalMock).not.toHaveBeenCalled();
  });

  test("contains fit failures while keeping the tmux session attached", async () => {
    fitFailure = new Error("fit unavailable");

    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    expect(screen.queryByText("Error: fit unavailable")).toBeNull();
    expect(detachInteractiveTerminalMock).not.toHaveBeenCalled();
  });

  test("contains asynchronous resize failures", async () => {
    const consoleError = mock((_message?: unknown, _error?: unknown) => {});
    const originalError = console.error;
    console.error = consoleError as typeof console.error;
    resizeInteractiveTerminalMock.mockRejectedValueOnce(new Error("resize unavailable"));

    try {
      render(
        <ClaudeTmuxInteractiveTerminal
          tabId="tab-1"
          environmentId={environmentId}
          isActive
        />,
      );

      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "[ClaudeTmuxInteractiveTerminal] Failed to resize terminal:",
          expect.objectContaining({ message: "resize unavailable" }),
        )
      );
      expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
    } finally {
      console.error = originalError;
    }
  });

  test("coalesces desync notices while terminal recovery is in flight", async () => {
    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );
    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledTimes(1));

    const recovery = deferred<void>();
    startInteractiveTerminalMock.mockImplementationOnce(() => recovery.promise);
    act(() => {
      outputHandler?.({ payload: { desynced: true } });
      outputHandler?.({ payload: { desynced: true } });
    });

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledTimes(2));
    expect(startInteractiveTerminalMock).toHaveBeenCalledTimes(2);

    recovery.resolve(undefined);
    await act(async () => {
      await recovery.promise;
    });
  });

  test("retries a failed desync recovery and accepts the restored full frame", async () => {
    render(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive
      />,
    );
    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledTimes(1));

    startInteractiveTerminalMock.mockRejectedValueOnce(new Error("transient recovery failure"));
    startInteractiveTerminalMock.mockResolvedValueOnce(undefined);
    act(() => {
      outputHandler?.({ payload: { desynced: true } });
    });

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledTimes(3));
    act(() => {
      outputHandler?.({ payload: { text: "restored", full: true } });
    });

    expect(new TextDecoder().decode(terminalInstances[0]!.writes.at(-1)!)).toBe("restored");
    expect(screen.queryByText(/Terminal recovery failed/)).toBeNull();
  });

  test("contains and surfaces a rejected desync recovery", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const consoleError = mock((_message?: unknown, _error?: unknown) => {});
    const originalError = console.error;
    console.error = consoleError as typeof console.error;
    process.on("unhandledRejection", onUnhandled);

    try {
      render(
        <ClaudeTmuxInteractiveTerminal
          tabId="tab-1"
          environmentId={environmentId}
          isActive
        />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledTimes(1));

      startInteractiveTerminalMock.mockRejectedValueOnce(new Error("recovery unavailable"));
      startInteractiveTerminalMock.mockRejectedValueOnce(new Error("recovery unavailable"));
      act(() => {
        outputHandler?.({ payload: { desynced: true } });
      });

      await screen.findByText("Terminal recovery failed: Error: recovery unavailable");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(startInteractiveTerminalMock).toHaveBeenCalledTimes(3);
      expect(consoleError).toHaveBeenCalledWith(
        "[ClaudeTmuxInteractiveTerminal] Failed to recover terminal:",
        expect.objectContaining({ message: "recovery unavailable" }),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      console.error = originalError;
    }
  });

  test("cancels pending listener setup and detaches when the component unmounts", async () => {
    let listenSignal: AbortSignal | undefined;
    listenMock.mockImplementationOnce((
      _eventName,
      handler: OutputHandler,
      options?: { signal?: AbortSignal },
    ) => {
      outputHandler = handler;
      listenSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        listenSignal?.addEventListener("abort", () => {
          unlistenMock();
          const error = new Error("cancelled");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
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

    await waitFor(() => {
      expect(listenSignal?.aborted).toBe(true);
      expect(unlistenMock).toHaveBeenCalledTimes(1);
      expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
    });

    expect(startInteractiveTerminalMock).not.toHaveBeenCalled();
  });
});
