import { describe, expect, test } from "bun:test";
import {
  handleStartupFailure,
  registerQuitReopenRelaunch,
  registerWindowAllClosedQuit,
} from "../../../apps/desktop/electron/quit-policy";
import {
  registerApplicationLoggingShutdown,
  type InstalledApplicationLogging,
} from "../../../apps/desktop/electron/application-logging";
import { registerSecondInstanceFocus } from "../../../apps/desktop/electron/single-instance";

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
    expect(harness.calls.quit).toBe(0);
  });

  test("never spawns a replacement for a supervised agent-test process", () => {
    const harness = registerReopen(false);
    harness.beginQuit();

    expect(harness.deferReopenWhileQuitting()).toBe(true);
    expect(harness.calls).toEqual({ relaunch: 0, quit: 0 });
  });

  test("reuses a relaunch already scheduled by the restart IPC", () => {
    const harness = registerReopen();
    harness.scheduleRelaunch();
    harness.beginQuit();
    expect(harness.deferReopenWhileQuitting()).toBe(true);
    expect(harness.calls).toEqual({ relaunch: 1, quit: 0 });
  });

  test("reopen does not bypass the pending production log flush", async () => {
    const listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
    const calls = { relaunch: 0, quit: 0, exits: 0 };
    let releaseStop!: () => void;
    const app = {
      on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      relaunch: () => {
        calls.relaunch += 1;
      },
      quit: () => {
        calls.quit += 1;
        emit("before-quit");
        let prevented = false;
        emit("will-quit", {
          preventDefault: () => {
            prevented = true;
          },
        });
        if (!prevented) calls.exits += 1;
      },
    } as unknown as Electron.App;
    function emit(name: string, event = { preventDefault: () => {} }): void {
      for (const listener of listeners.get(name) ?? []) listener(event);
    }
    const logging = {
      stop: () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    } as InstalledApplicationLogging;
    const guard = registerQuitReopenRelaunch({ app, allowRelaunch: true });
    registerApplicationLoggingShutdown(app, logging, 5_000);

    app.quit();
    expect(calls).toEqual({ relaunch: 0, quit: 1, exits: 0 });
    expect(guard.deferReopenWhileQuitting()).toBe(true);
    expect(guard.deferReopenWhileQuitting()).toBe(true);
    expect(calls).toEqual({ relaunch: 1, quit: 1, exits: 0 });

    releaseStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual({ relaunch: 1, quit: 2, exits: 1 });
  });

  test("second-instance relaunch precedes and suppresses focus and new-window", () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const calls: string[] = [];
    const app = {
      on: (name: string, listener: (...args: unknown[]) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      },
      relaunch: () => {
        calls.push("relaunch");
      },
    } as unknown as Electron.App;
    const emit = (name: string, ...args: unknown[]) => {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    };
    const guard = registerQuitReopenRelaunch({ app, allowRelaunch: true });
    app.on("second-instance", () => {
      guard.deferReopenWhileQuitting();
    });
    registerSecondInstanceFocus(
      app,
      () =>
        guard.isQuitting()
          ? null
          : {
              isMinimized: () => false,
              restore: () => {},
              focus: () => {
                calls.push("focus");
              },
            },
      () => {
        if (!guard.isQuitting()) calls.push("new-window");
      },
    );

    emit("before-quit");
    emit("second-instance", {}, ["orkestrator", "--new-window"]);
    emit("second-instance", {}, ["orkestrator"]);
    expect(calls).toEqual(["relaunch"]);
  });

  test("silences a startup rejection caused by quit but reports an ordinary failure", () => {
    const error = new Error("backend stopped during startup");
    const calls: string[] = [];
    const options = {
      error,
      report: () => {
        calls.push("report");
      },
      quit: () => {
        calls.push("quit");
      },
    };
    handleStartupFailure({ ...options, isQuitting: () => true });
    expect(calls).toEqual([]);
    handleStartupFailure({ ...options, isQuitting: () => false });
    expect(calls).toEqual(["report", "quit"]);
  });
});
