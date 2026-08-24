import { describe, expect, it, mock } from "bun:test";
import {
  forceTerminalVisibilityRedraw,
  getTerminalResizeBounceDimensions,
  shouldTriggerEnvironmentVisibilityRedraw,
} from "./persistent-terminal-redraw";

describe("persistent terminal redraw helpers", () => {
  it("detects when an environment switch should force a redraw", () => {
    expect(
      shouldTriggerEnvironmentVisibilityRedraw({
        isEnvironmentVisible: true,
        wasEnvironmentVisible: false,
        isActive: true,
        terminalIsOpened: true,
        isConnected: true,
      }),
    ).toBe(true);

    expect(
      shouldTriggerEnvironmentVisibilityRedraw({
        isEnvironmentVisible: true,
        wasEnvironmentVisible: true,
        isActive: true,
        terminalIsOpened: true,
        isConnected: true,
      }),
    ).toBe(false);

    expect(
      shouldTriggerEnvironmentVisibilityRedraw({
        isEnvironmentVisible: true,
        wasEnvironmentVisible: true,
        wasDomReattached: true,
        isActive: true,
        terminalIsOpened: true,
        isConnected: true,
      }),
    ).toBe(true);

    expect(
      shouldTriggerEnvironmentVisibilityRedraw({
        isEnvironmentVisible: true,
        wasEnvironmentVisible: false,
        isActive: false,
        terminalIsOpened: true,
        isConnected: true,
      }),
    ).toBe(false);
  });

  it("nudges rows first when computing a resize bounce", () => {
    expect(getTerminalResizeBounceDimensions(120, 40)).toEqual({ cols: 120, rows: 41 });
  });

  it("falls back to nudging columns when rows cannot grow", () => {
    expect(getTerminalResizeBounceDimensions(120, 65535)).toEqual({ cols: 121, rows: 65535 });
  });

  it("settles the PTY at the post-fit dimensions when fit() resizes the viewport", async () => {
    const fit = mock(() => {});
    const refresh = mock(() => {});
    const resize = mock(async () => {});
    const scheduledTimeouts: Array<() => void> = [];

    const terminal = { cols: 100, rows: 30, refresh };

    const { cancel } = await forceTerminalVisibilityRedraw({
      terminal,
      fitAddon: { fit },
      resize,
      requestAnimationFrameFn: (callback) => {
        // Simulate fit() changing terminal dimensions during the rAF
        fit.mockImplementation(() => {
          terminal.cols = 110;
          terminal.rows = 35;
        });
        callback(0);
        return 1;
      },
      setTimeoutFn: ((callback: TimerHandler) => {
        scheduledTimeouts.push(callback as () => void);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
    });

    // A reattach into a differently sized pane fits to 110x35; settling the PTY
    // back at the pre-fit 100x30 would leave it out of step with the viewport.
    expect(resize).toHaveBeenNthCalledWith(1, 110, 36);
    expect(resize).toHaveBeenNthCalledWith(2, 110, 35);
    expect(fit).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);

    expect(scheduledTimeouts).toHaveLength(1);
    scheduledTimeouts[0]?.();

    expect(fit).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(3);

    // Cleanup exists
    expect(typeof cancel).toBe("function");
  });

  it("still bounces when fit() leaves the dimensions unchanged", async () => {
    const resize = mock(async () => {});

    await forceTerminalVisibilityRedraw({
      terminal: { cols: 80, rows: 24, refresh: mock(() => {}) },
      fitAddon: { fit: mock(() => {}) },
      resize,
      requestAnimationFrameFn: (callback) => {
        callback(0);
        return 1;
      },
      setTimeoutFn: (() =>
        1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    });

    // Two distinct sizes still reach the PTY, so the TUI receives a SIGWINCH.
    expect(resize).toHaveBeenNthCalledWith(1, 80, 25);
    expect(resize).toHaveBeenNthCalledWith(2, 80, 24);
  });

  it("bounces once fit() gives a viewport that had no dimensions before", async () => {
    const resize = mock(async () => {});
    const terminal = { cols: 0, rows: 0, refresh: mock(() => {}) };

    await forceTerminalVisibilityRedraw({
      terminal,
      fitAddon: {
        fit: () => {
          terminal.cols = 90;
          terminal.rows = 20;
        },
      },
      resize,
      requestAnimationFrameFn: (callback) => {
        callback(0);
        return 1;
      },
      setTimeoutFn: (() =>
        1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    });

    expect(resize).toHaveBeenNthCalledWith(1, 90, 21);
    expect(resize).toHaveBeenNthCalledWith(2, 90, 20);
  });

  it("cancel() clears the pending timeout", async () => {
    const clearTimeoutMock = mock(() => {});
    const timerId = 42 as unknown as ReturnType<typeof setTimeout>;

    const { cancel } = await forceTerminalVisibilityRedraw({
      terminal: { cols: 80, rows: 24, refresh: mock(() => {}) },
      fitAddon: { fit: mock(() => {}) },
      resize: mock(async () => {}),
      requestAnimationFrameFn: (callback) => {
        callback(0);
        return 1;
      },
      setTimeoutFn: (() => timerId) as unknown as typeof setTimeout,
      clearTimeoutFn: clearTimeoutMock,
    });

    cancel();
    expect(clearTimeoutMock).toHaveBeenCalledWith(timerId);
  });

  it("stops before resizing when cancelled after the first frame", async () => {
    const resize = mock(async () => {});

    await forceTerminalVisibilityRedraw({
      terminal: {
        cols: 100,
        rows: 30,
        refresh: mock(() => {}),
      },
      fitAddon: { fit: mock(() => {}) },
      resize,
      isCancelled: () => true,
      requestAnimationFrameFn: (callback) => {
        callback(0);
        return 1;
      },
    });

    expect(resize).not.toHaveBeenCalled();
  });
});
