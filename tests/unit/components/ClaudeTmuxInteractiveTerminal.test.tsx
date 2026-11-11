import { KeyboardShortcutsDialog } from "@/components/layout/KeyboardShortcutsDialog";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { CLAUDE_TMUX_INTERACTIVE_RENEW_MS } from "@orkestrator/protocol/contract/domains/claude-tmux";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { invoke } from "@/lib/native/backend";
import {
  listenForTerminalBrowserTabRequests,
  type TerminalBrowserTabRequest,
} from "@/lib/terminal-links";
import type { ITerminalOptions } from "@xterm/xterm";
import * as realXterm from "@xterm/xterm";
import * as realFitAddon from "@xterm/addon-fit";
import * as realBackendEvent from "@/lib/native/events";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import * as realTerminalPaste from "@/lib/terminal-paste";
import * as realClipboardImagePaste from "@/hooks/useClipboardImagePaste";
import type { TerminalOutputPayload } from "@/hooks/useTerminal";
import type { TerminalPasteOptions } from "@/lib/terminal-paste";
import { emitViewportChange, restoreMatchMedia, setMobileViewport } from "../../mocks/match-media";

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
  /** Stands in for xterm's helper textarea, so focus moves in the DOM. */
  textarea: HTMLTextAreaElement | null = null;

  constructor(public options: ITerminalOptions = {}) {
    terminalInstances.push(this);
  }

  loadAddon() {}

  open(parent: HTMLElement) {
    this.textarea = document.createElement("textarea");
    parent.appendChild(this.textarea);
  }

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

  input(data: string) {
    this.emitData(data);
  }

  emitKey(event: Partial<KeyboardEvent>) {
    return this.keyHandler?.(event as KeyboardEvent);
  }

  write(data: Uint8Array) {
    this.writes.push(data);
  }

  focus() {
    this.focused = true;
    this.textarea?.focus();
  }

  dispose() {
    this.disposed = true;
    this.textarea?.remove();
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

const listenMock = mock(
  async (_eventName: string, handler: OutputHandler, _options?: { signal?: AbortSignal }) => {
    outputHandler = handler;
    return unlistenMock;
  },
);
const unlistenMock = mock(() => {});
const createInteractiveTerminalMock = mock(async () => "pty-1");
const startInteractiveTerminalMock = mock(async () => {});
const writeInteractiveTerminalMock = mock(async (_terminalSessionId: string, _data: string) => {});
const resizeInteractiveTerminalMock = mock(async () => {});
const detachInteractiveTerminalMock = mock(async () => {});
const renewInteractiveTerminalMock = mock(
  async (_terminalSessionId: string): Promise<"renewed" | "lapsed" | "unsupported"> => "renewed",
);
const handleTerminalPasteMock = mock(async (_options: TerminalPasteOptions) => {});

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
  renewInteractiveTerminal: renewInteractiveTerminalMock,
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

const { ClaudeTmuxInteractiveTerminal } =
  await import("@/components/claude/ClaudeTmuxInteractiveTerminal");

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
    (invoke as unknown as ReturnType<typeof mock>).mockReset();
    (invoke as unknown as ReturnType<typeof mock>).mockResolvedValue(undefined);
    listenMock.mockClear();
    unlistenMock.mockClear();
    createInteractiveTerminalMock.mockClear();
    createInteractiveTerminalMock.mockResolvedValue("pty-1");
    startInteractiveTerminalMock.mockClear();
    startInteractiveTerminalMock.mockResolvedValue(undefined);
    writeInteractiveTerminalMock.mockClear();
    resizeInteractiveTerminalMock.mockClear();
    detachInteractiveTerminalMock.mockClear();
    renewInteractiveTerminalMock.mockReset();
    renewInteractiveTerminalMock.mockResolvedValue("renewed");
    handleTerminalPasteMock.mockClear();
    handleTerminalPasteMock.mockResolvedValue(undefined);
    capturedImagePasteOptions = null;
    delete window.orkestrator;

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
    const { unmount } = renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

    expect(terminalInstances[0]!.options.macOptionClickForcesSelection).toBe(true);
    expect(terminalInstances[0]!.options.altClickMovesCursor).toBe(false);
    expect(createInteractiveTerminalMock).toHaveBeenCalledWith("tab-1", 120, 30, environmentId);
    expect(listenMock.mock.calls[0]?.[0]).toBe("terminal-output-pty-1");
    expect(resizeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", 120, 30);

    act(() => {
      outputHandler?.({ payload: [65, 66] });
      terminalInstances[0]!.emitData("x");
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(Array.from(terminalInstances[0]!.writes[0]!)).toEqual([65, 66]);
    await waitFor(() => expect(writeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", "x"));
    expect(resizeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", 120, 30);
    expect(terminalInstances[0]!.focused).toBe(true);

    unmount();

    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
    expect(terminalInstances[0]!.disposed).toBe(true);
  });

  test.each([{ ctrlKey: true }, { metaKey: true }])(
    "registers OSC 8 routing for modifier %j with source identity",
    async (modifier) => {
      const requests: TerminalBrowserTabRequest[] = [];
      const stopListening = listenForTerminalBrowserTabRequests((request) =>
        requests.push(request),
      );
      const { unmount } = renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="source-pane" environmentId="source-env" isActive />,
      );
      try {
        await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
        const handler = terminalInstances[0]!.options.linkHandler;
        expect(handler).toBeDefined();
        const range = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } };
        handler!.activate(
          new MouseEvent("click", { button: 0, ...modifier }),
          "https://example.com/external",
          range,
        );
        handler!.activate(
          new MouseEvent("click", { button: 0, ...modifier, shiftKey: true }),
          "http://localhost:5173/internal",
          range,
        );
        for (const button of [0, 1, 2]) {
          handler!.activate(
            new MouseEvent("click", { button }),
            "https://example.com/ignored",
            range,
          );
          if (button !== 0) {
            for (const shiftKey of [false, true]) {
              handler!.activate(
                new MouseEvent("click", { button, ...modifier, shiftKey }),
                "https://example.com/ignored",
                range,
              );
            }
          }
        }
        await Promise.resolve();
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith("open_in_browser", {
          url: "https://example.com/external",
        });
        expect(requests).toEqual([
          {
            environmentId: "source-env",
            sourceTabId: "source-pane",
            url: "http://localhost:5173/internal",
          },
        ]);
      } finally {
        stopListening();
        unmount();
      }
    },
  );

  test("suppresses background geometry and republishes when the Electron window gains focus", async () => {
    const originalHasFocus = document.hasFocus;
    let documentFocused = false;
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => documentFocused,
    });
    window.orkestrator = { isolatedViewState: true } as Window["orkestrator"];

    try {
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
      act(() => resizeCallback?.([], {} as ResizeObserver));
      expect(resizeInteractiveTerminalMock).not.toHaveBeenCalled();

      documentFocused = true;
      act(() => window.dispatchEvent(new Event("focus")));
      await waitFor(() =>
        expect(resizeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", 120, 30),
      );
    } finally {
      Object.defineProperty(document, "hasFocus", {
        configurable: true,
        value: originalHasFocus,
      });
      delete window.orkestrator;
    }
  });

  test("sends Shift+Enter as LF to the tmux input bridge", async () => {
    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    const preventDefault = mock(() => {});
    const handled = terminalInstances[0]!.emitKey({
      type: "keydown",
      key: "Enter",
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault,
    });

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(writeInteractiveTerminalMock).toHaveBeenCalledWith("pty-1", "\n"));

    writeInteractiveTerminalMock.mockClear();
    expect(
      terminalInstances[0]!.emitKey({
        type: "keydown",
        key: "Enter",
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
      }),
    ).toBe(true);
    expect(writeInteractiveTerminalMock).not.toHaveBeenCalled();
  });

  test.each(["metaKey", "ctrlKey"])(
    "yields %s+Shift+/ to the dialog without bridge input",
    async (modifier) => {
      renderInAppCommandScope(
        <>
          <KeyboardShortcutsDialog />
          <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />
        </>,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
      const terminal = terminalInstances[0]!;
      const event = new KeyboardEvent("keydown", {
        key: modifier === "ctrlKey" ? "?" : "/",
        code: "Slash",
        shiftKey: true,
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      const handled = terminal.emitKey(event);
      if (handled) terminal.emitData("\x1f");
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      fireEvent(window, event);
      await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
      expect(writeInteractiveTerminalMock).not.toHaveBeenCalled();
    },
  );

  test("passes Cmd+W through to the application tab shortcut", async () => {
    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    expect(
      terminalInstances[0]!.emitKey({
        type: "keydown",
        key: "w",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  test("fits without focusing the terminal when activated on mobile", async () => {
    setMobileViewport(true);
    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

    expect(fitInstances[0]!.fit).toHaveBeenCalled();
    expect(terminalInstances[0]!.focused).toBe(false);
  });

  test("shows contained mobile keys only while active and forwards canonical sequences", async () => {
    setMobileViewport(true);
    const view = renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-1"
        environmentId={environmentId}
        isActive={false}
      />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    expect(screen.queryByRole("toolbar", { name: "Terminal keys" }) === null).toBe(true);

    view.rerender(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
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
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );

    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalled());
    expect(
      screen.getAllByRole("button").every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Up arrow" }));
    expect(writeInteractiveTerminalMock).not.toHaveBeenCalled();

    resolveStart();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Up arrow" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  test("focuses the terminal when it is attached on desktop", async () => {
    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

    await waitFor(() => expect(terminalInstances[0]!.focused).toBe(true));
  });

  test("focuses on desktop, but not on mobile, when the tab becomes active again", async () => {
    const view = renderInAppCommandScope(
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
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
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
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
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

    renderInAppCommandScope(
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
    const { rerender } = renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal
        tabId="tab-2"
        environmentId={environmentId}
        containerId="container-1"
        isActive
      />,
    );

    await waitFor(() => expect(capturedImagePasteOptions?.onImageSaved).toBeDefined());

    await act(async () => {
      await capturedImagePasteOptions!.onImageSaved!("/workspace/.orkestrator/clipboard/image.png");
    });

    expect(writeInteractiveTerminalMock).toHaveBeenCalledWith(
      "pty-1",
      "/workspace/.orkestrator/clipboard/image.png ",
    );
  });

  test("logs clipboard image errors without throwing", async () => {
    const logs = captureLogs();

    try {
      renderInAppCommandScope(
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

      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "error",
          area: "web.claude-tmux",
          event: "clipboard.image-failed",
          fields: expect.objectContaining({
            error: expect.objectContaining({
              message: "Image too large (9.0MB). Maximum size is 8MB.",
            }),
          }),
        }),
      );
    } finally {
      logs.restore();
    }
  });

  test("cleans up the created session and listener when start fails", async () => {
    startInteractiveTerminalMock.mockRejectedValueOnce(new Error("spawn failed"));

    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await screen.findByText("Error: spawn failed");

    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
  });

  test("reports a missing environment without creating a terminal session", async () => {
    renderInAppCommandScope(<ClaudeTmuxInteractiveTerminal tabId="tab-1" isActive />);

    await screen.findByText("No environment specified for interactive terminal");
    expect(createInteractiveTerminalMock).not.toHaveBeenCalled();
    expect(startInteractiveTerminalMock).not.toHaveBeenCalled();
    const requests: TerminalBrowserTabRequest[] = [];
    const stopListening = listenForTerminalBrowserTabRequests((request) => requests.push(request));
    try {
      const handler = terminalInstances[0]!.options.linkHandler;
      expect(handler).toBeDefined();
      handler!.activate(
        new MouseEvent("click", { button: 0, ctrlKey: true, shiftKey: true }),
        "http://localhost:5173/fallback",
        {
          start: { x: 1, y: 1 },
          end: { x: 10, y: 1 },
        },
      );
      expect(requests).toEqual([
        { environmentId: "", sourceTabId: "tab-1", url: "http://localhost:5173/fallback" },
      ]);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      stopListening();
    }
  });

  test("reports session creation failures without attempting to start", async () => {
    createInteractiveTerminalMock.mockRejectedValueOnce(new Error("create failed"));

    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await screen.findByText("Error: create failed");
    expect(startInteractiveTerminalMock).not.toHaveBeenCalled();
    expect(detachInteractiveTerminalMock).not.toHaveBeenCalled();
  });

  test("contains fit failures while keeping the tmux session attached", async () => {
    fitFailure = new Error("fit unavailable");

    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
    );

    await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
    expect(screen.queryByText("Error: fit unavailable") === null).toBe(true);
    expect(detachInteractiveTerminalMock).not.toHaveBeenCalled();
  });

  test("contains asynchronous resize failures", async () => {
    const logs = captureLogs();
    resizeInteractiveTerminalMock.mockRejectedValueOnce(new Error("resize unavailable"));

    try {
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );

      await waitFor(() =>
        expect(logs.records()).toContainEqual(
          expect.objectContaining({
            level: "error",
            area: "web.claude-tmux",
            event: "terminal.resize-failed",
            fields: expect.objectContaining({
              sessionId: "pty-1",
              error: expect.objectContaining({ message: "resize unavailable" }),
            }),
          }),
        ),
      );
      expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
    } finally {
      logs.restore();
    }
  });

  test("coalesces desync notices while terminal recovery is in flight", async () => {
    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
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
    renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
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
    expect(screen.queryByText(/Terminal recovery failed/) === null).toBe(true);
  });

  test("contains and surfaces a rejected desync recovery", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    const logs = captureLogs();
    process.on("unhandledRejection", onUnhandled);

    try {
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
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
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "error",
          area: "web.claude-tmux",
          event: "terminal.recover-failed",
          fields: expect.objectContaining({
            sessionId: "pty-1",
            error: expect.objectContaining({ message: "recovery unavailable" }),
          }),
        }),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      logs.restore();
    }
  });

  test("cancels pending listener setup and detaches when the component unmounts", async () => {
    let listenSignal: AbortSignal | undefined;
    listenMock.mockImplementationOnce(
      (_eventName, handler: OutputHandler, options?: { signal?: AbortSignal }) => {
        outputHandler = handler;
        listenSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          listenSignal?.addEventListener(
            "abort",
            () => {
              unlistenMock();
              const error = new Error("cancelled");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      },
    );

    const { unmount } = renderInAppCommandScope(
      <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
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
  // To-do 7745 (retired): the backend stops capturing a terminal nobody renews, so a
  // reload or a closed window no longer leaves a capture loop behind.
  describe("interactive terminal lease", () => {
    const becomeVisible = () =>
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

    // The renewal interval, captured so a test fires its ticks by hand. Every
    // other interval (testing-library's polling) runs on the real timers.
    type RenewInterval = { fire: () => void; cleared: boolean };
    let renewIntervals: RenewInterval[] = [];
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const liveRenewIntervals = () => renewIntervals.filter((entry) => !entry.cleared);
    const tick = () =>
      act(async () => {
        for (const entry of liveRenewIntervals()) entry.fire();
        await Promise.resolve();
      });
    const setVisibility = (value: DocumentVisibilityState) =>
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });

    beforeEach(() => {
      renewIntervals = [];
      globalThis.setInterval = ((callback: (...args: unknown[]) => void, delayMs?: number) => {
        if (delayMs !== CLAUDE_TMUX_INTERACTIVE_RENEW_MS) return realSetInterval(callback, delayMs);
        const entry: RenewInterval = { fire: () => callback(), cleared: false };
        renewIntervals.push(entry);
        return entry as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval;
      globalThis.clearInterval = ((id?: unknown) => {
        const entry = renewIntervals.find((candidate) => candidate === id);
        if (entry) entry.cleared = true;
        else realClearInterval(id as ReturnType<typeof setInterval>);
      }) as typeof clearInterval;
    });

    afterEach(() => {
      cleanup();
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      if (visibilityDescriptor)
        Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      else delete (document as { visibilityState?: unknown }).visibilityState;
      document.body.querySelectorAll("[data-lease-focus-probe]").forEach((node) => node.remove());
    });

    test("renews on its interval while attached and stops when unmounted", async () => {
      const { unmount } = renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
      expect(liveRenewIntervals()).toHaveLength(1);

      await tick();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1));
      await tick();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(2));
      expect(renewInteractiveTerminalMock).toHaveBeenLastCalledWith("pty-1");
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
      expect(renewIntervals).toHaveLength(1);

      unmount();
      expect(liveRenewIntervals()).toHaveLength(0);
      expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-1");
    });

    test("never overlaps renewals while one is still in flight", async () => {
      const pending = deferred<"renewed" | "lapsed" | "unsupported">();
      renewInteractiveTerminalMock.mockImplementationOnce(() => pending.promise);
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

      await tick();
      await tick();
      becomeVisible();
      expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve("renewed");
        await pending.promise;
      });
      await tick();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(2));
      expect(liveRenewIntervals()).toHaveLength(1);
    });

    test("clears its interval when the backend predates leases", async () => {
      renewInteractiveTerminalMock.mockResolvedValue("unsupported");
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

      await tick();
      await waitFor(() => expect(liveRenewIntervals()).toHaveLength(0));
      await tick();
      expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1);
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
    });

    test("lease recovery leaves keyboard focus where the user put it", async () => {
      createInteractiveTerminalMock.mockResolvedValueOnce("pty-1").mockResolvedValueOnce("pty-2");
      renewInteractiveTerminalMock.mockResolvedValueOnce("lapsed");
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(terminalInstances[0]?.focused).toBe(true));
      const input = document.createElement("input");
      input.setAttribute("data-lease-focus-probe", "");
      document.body.appendChild(input);
      input.focus();
      expect(document.activeElement).toBe(input);

      await tick();
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-2"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(terminalInstances[1]!.focused).toBe(false);
      expect(document.activeElement).toBe(input);
    });

    test("lease recovery gives focus back to a terminal that had it", async () => {
      createInteractiveTerminalMock.mockResolvedValueOnce("pty-1").mockResolvedValueOnce("pty-2");
      renewInteractiveTerminalMock.mockResolvedValueOnce("lapsed");
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(terminalInstances[0]?.focused).toBe(true));
      expect(document.activeElement).toBe(terminalInstances[0]!.textarea);

      await tick();
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-2"));
      await waitFor(() => expect(terminalInstances[1]!.focused).toBe(true));
      expect(document.activeElement).toBe(terminalInstances[1]!.textarea);
    });

    test("lease recovery in an inactive pane does not take focus", async () => {
      createInteractiveTerminalMock.mockResolvedValueOnce("pty-1").mockResolvedValueOnce("pty-2");
      renewInteractiveTerminalMock.mockResolvedValueOnce("lapsed");
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal
          tabId="tab-1"
          environmentId={environmentId}
          isActive={false}
        />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

      await tick();
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-2"));
      await act(async () => {
        await Promise.resolve();
      });
      expect(terminalInstances[1]!.focused).toBe(false);
    });

    test("a lapse while the page is hidden reattaches only once it is visible", async () => {
      createInteractiveTerminalMock.mockResolvedValueOnce("pty-1").mockResolvedValueOnce("pty-2");
      renewInteractiveTerminalMock.mockResolvedValueOnce("lapsed");
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
      setVisibility("hidden");

      await tick();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // Throttled timers would let a terminal attached now lapse again.
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
      expect(terminalInstances[0]!.disposed).toBe(false);
      expect(liveRenewIntervals()).toHaveLength(0);
      becomeVisible();
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);

      setVisibility("visible");
      becomeVisible();
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-2"));
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(2);
      expect(liveRenewIntervals()).toHaveLength(1);
    });

    test("a deferred reattach is dropped when the terminal unmounts", async () => {
      renewInteractiveTerminalMock.mockResolvedValueOnce("lapsed");
      const { unmount } = renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
      setVisibility("hidden");
      await tick();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      unmount();
      setVisibility("visible");
      becomeVisible();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
    });

    test("renews the lease when the page becomes visible", async () => {
      const { unmount } = renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

      becomeVisible();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);

      unmount();
      renewInteractiveTerminalMock.mockClear();
      becomeVisible();
      expect(renewInteractiveTerminalMock).not.toHaveBeenCalled();
    });

    test("attaches a new terminal when the backend reports the lease lapsed", async () => {
      createInteractiveTerminalMock.mockResolvedValueOnce("pty-1").mockResolvedValueOnce("pty-2");
      renewInteractiveTerminalMock.mockResolvedValueOnce("lapsed");
      const { unmount } = renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

      becomeVisible();
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-2"));
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(2);
      expect(listenMock.mock.calls.at(-1)?.[0]).toBe("terminal-output-pty-2");
      expect(terminalInstances[0]!.disposed).toBe(true);

      becomeVisible();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenLastCalledWith("pty-2"));
      unmount();
      expect(detachInteractiveTerminalMock).toHaveBeenCalledWith("pty-2");
    });

    test("stops renewing against a backend that predates leases", async () => {
      renewInteractiveTerminalMock.mockResolvedValue("unsupported");
      renderInAppCommandScope(
        <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
      );
      await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

      becomeVisible();
      await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1));
      becomeVisible();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1);
      expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
    });

    test("keeps the terminal when a renewal fails transiently", async () => {
      const logs = captureLogs();
      try {
        renewInteractiveTerminalMock.mockRejectedValueOnce(new Error("gateway reconnecting"));
        renderInAppCommandScope(
          <ClaudeTmuxInteractiveTerminal tabId="tab-1" environmentId={environmentId} isActive />,
        );
        await waitFor(() => expect(startInteractiveTerminalMock).toHaveBeenCalledWith("pty-1"));

        becomeVisible();
        await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(1));
        becomeVisible();
        await waitFor(() => expect(renewInteractiveTerminalMock).toHaveBeenCalledTimes(2));
        expect(createInteractiveTerminalMock).toHaveBeenCalledTimes(1);
        expect(detachInteractiveTerminalMock).not.toHaveBeenCalled();
      } finally {
        logs.restore();
      }
    });
  });
});
