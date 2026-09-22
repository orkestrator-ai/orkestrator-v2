import { describe, expect, test } from "bun:test";
import {
  registerQuitReopenRelaunch,
  registerWindowAllClosedQuit,
} from "../../../apps/desktop/electron/quit-policy";

type Listener = () => void;

function fakeApp() {
  const listeners = new Map<string, Listener[]>();
  let quitCalls = 0;
  return {
    get quitCalls() {
      return quitCalls;
    },
    closeLastWindow() {
      for (const listener of listeners.get("window-all-closed") ?? []) listener();
    },
    app: {
      quit: () => {
        quitCalls += 1;
      },
      on: (event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    } as unknown as Electron.App,
  };
}

function register(options: { platform: NodeJS.Platform; alwaysQuit?: boolean }) {
  const harness = fakeApp();
  const lifecycle = registerWindowAllClosedQuit({
    app: harness.app,
    platform: options.platform,
    alwaysQuit: options.alwaysQuit ?? false,
  });
  return Object.assign(harness, lifecycle);
}

describe("window-all-closed quit policy", () => {
  test("survives the windowless gap between the first-run setup windows", () => {
    // The platform picker closes as soon as the user chooses, and the toolchain
    // progress window is only created afterwards. Quitting in between exited
    // mid-startup — before the selection reached disk — and read to the user as
    // the button doing nothing except closing the app.
    const harness = register({ platform: "linux" });

    harness.closeLastWindow();
    expect(harness.quitCalls).toBe(0);

    harness.markMainWindowCreated();
    harness.closeLastWindow();
    expect(harness.quitCalls).toBe(1);
  });

  test("quits when the main window closes off macOS", () => {
    for (const platform of ["linux", "win32"] as const) {
      const harness = register({ platform });
      harness.markMainWindowCreated();
      harness.closeLastWindow();
      expect(harness.quitCalls).toBe(1);
    }
  });

  test("keeps a macOS app alive once its window closes", () => {
    const harness = register({ platform: "darwin" });
    harness.markMainWindowCreated();
    harness.closeLastWindow();
    expect(harness.quitCalls).toBe(0);
  });

  test("quits an agent-test profile on macOS, but still not mid-startup", () => {
    // The launcher waits for the process to exit, so a windowless app lingering
    // in the dock would hang the run.
    const harness = register({
      platform: "darwin",
      alwaysQuit: true,
    });

    harness.closeLastWindow();
    expect(harness.quitCalls).toBe(0);

    harness.markMainWindowCreated();
    harness.closeLastWindow();
    expect(harness.quitCalls).toBe(1);
  });
});

function registerReopen(allowRelaunch = true) {
  const listeners = new Map<string, Listener[]>();
  const calls = { relaunch: 0, quit: 0 };
  const app = {
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    relaunch: () => {
      calls.relaunch += 1;
    },
    quit: () => {
      calls.quit += 1;
    },
  } as unknown as Electron.App;
  const guard = registerQuitReopenRelaunch({ app, allowRelaunch });
  return {
    ...guard,
    calls,
    beginQuit() {
      for (const listener of listeners.get("before-quit") ?? []) listener();
    },
  };
}

describe("reopen during quit", () => {
  test("leaves ordinary reopens to window creation", () => {
    const harness = registerReopen();
    expect(harness.isQuitting()).toBe(false);
    expect(harness.deferReopenWhileQuitting()).toBe(false);
    expect(harness.calls).toEqual({ relaunch: 0, quit: 0 });
  });

  test("relaunches once instead of opening a window on the stopped backend", () => {
    // macOS "Quit & Reopen" after a Full Disk Access grant reopens the app
    // while the log flush still holds the quit open. A window created then
    // could never reach the Local backend that before-quit had stopped.
    const harness = registerReopen();
    harness.beginQuit();

    expect(harness.isQuitting()).toBe(true);
    expect(harness.deferReopenWhileQuitting()).toBe(true);
    expect(harness.deferReopenWhileQuitting()).toBe(true);
    expect(harness.calls.relaunch).toBe(1);
    expect(harness.calls.quit).toBe(2);
  });

  test("never spawns a replacement for a supervised agent-test process", () => {
    const harness = registerReopen(false);
    harness.beginQuit();

    expect(harness.deferReopenWhileQuitting()).toBe(true);
    expect(harness.calls).toEqual({ relaunch: 0, quit: 1 });
  });
});
