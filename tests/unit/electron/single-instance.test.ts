import { describe, expect, test } from "bun:test";
import {
  claimSingleInstanceLock,
  registerSecondInstanceFocus,
} from "../../../apps/desktop/electron/single-instance";

type Listener = () => void;

function fakeApp(hasLock: boolean) {
  const listeners = new Map<string, Listener[]>();
  let quitCalls = 0;
  return {
    get quitCalls() {
      return quitCalls;
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
    app: {
      requestSingleInstanceLock: () => hasLock,
      quit: () => {
        quitCalls += 1;
      },
      on: (event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    } as unknown as Electron.App,
  };
}

function fakeWindow(minimized: boolean) {
  const calls: string[] = [];
  return {
    calls,
    window: {
      isMinimized: () => minimized,
      restore: () => {
        calls.push("restore");
      },
      focus: () => {
        calls.push("focus");
      },
    },
  };
}

describe("claimSingleInstanceLock", () => {
  test("keeps running and does not quit when it wins the lock", () => {
    const harness = fakeApp(true);
    expect(claimSingleInstanceLock(harness.app)).toBe(true);
    expect(harness.quitCalls).toBe(0);
  });

  test("quits when another instance already holds the lock", () => {
    // A second instance would spawn a duplicate backend against the same
    // userData directory and a duplicate set of bridge processes.
    const harness = fakeApp(false);
    expect(claimSingleInstanceLock(harness.app)).toBe(false);
    expect(harness.quitCalls).toBe(1);
  });
});

describe("registerSecondInstanceFocus", () => {
  test("focuses an existing, visible window", () => {
    const harness = fakeApp(true);
    const { calls, window } = fakeWindow(false);
    registerSecondInstanceFocus(harness.app, () => window);

    harness.emit("second-instance");
    expect(calls).toEqual(["focus"]);
  });

  test("restores before focusing a minimized window", () => {
    const harness = fakeApp(true);
    const { calls, window } = fakeWindow(true);
    registerSecondInstanceFocus(harness.app, () => window);

    harness.emit("second-instance");
    expect(calls).toEqual(["restore", "focus"]);
  });

  test("is a no-op when no window exists yet", () => {
    // A second launch can arrive before `whenReady` has built the window, or
    // after it was closed on a platform where that does not quit the app.
    const harness = fakeApp(true);
    registerSecondInstanceFocus(harness.app, () => null);

    expect(() => harness.emit("second-instance")).not.toThrow();
  });

  test("reads the window lazily so a later-created window is still focused", () => {
    const harness = fakeApp(true);
    const { calls, window } = fakeWindow(false);
    let current: typeof window | null = null;
    registerSecondInstanceFocus(harness.app, () => current);

    harness.emit("second-instance");
    expect(calls).toEqual([]);

    // Startup finished and assigned `mainWindow` after registration.
    current = window;
    harness.emit("second-instance");
    expect(calls).toEqual(["focus"]);
  });

  test("registers exactly one second-instance listener", () => {
    const harness = fakeApp(true);
    registerSecondInstanceFocus(harness.app, () => null);
    expect(harness.listenerCount("second-instance")).toBe(1);
  });
});
