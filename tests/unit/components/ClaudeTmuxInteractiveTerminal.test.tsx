import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as realXterm from "@xterm/xterm";
import * as realFitAddon from "@xterm/addon-fit";
import * as realTauriEvent from "@tauri-apps/api/event";
import * as realTmuxClient from "@/lib/claude-tmux-client";

const realXtermSnapshot = { ...realXterm };
const realFitAddonSnapshot = { ...realFitAddon };
const realTauriEventSnapshot = { ...realTauriEvent };
const realTmuxClientSnapshot = { ...realTmuxClient };

type OutputHandler = (event: { payload: number[] }) => void;

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

  emitData(data: string) {
    this.dataHandlers.forEach((handler) => handler(data));
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

mock.module("@xterm/xterm", () => ({
  Terminal: MockTerminal,
}));

mock.module("@xterm/addon-fit", () => ({
  FitAddon: MockFitAddon,
}));

mock.module("@tauri-apps/api/event", () => ({
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
    mock.module("@tauri-apps/api/event", () => realTauriEventSnapshot);
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
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
