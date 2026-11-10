import { describe, expect, test } from "bun:test";
import {
  MODULE_IMPORT_FAILED,
  NETWORK_CHANGED,
  RendererStartupError,
  collectStartupConsole,
  isNetworkChangedStartupFailure,
  nextStartupStep,
  waitForRendererStart,
  watchElectronStartup,
  type StartupConsoleMessage,
  type StartupWindow,
} from "./electron-startup-recovery";

const TITLE = "Orkestrator AI — DEV [service-preview-smoke]";
const ABORTED = "Failed to load resource: net::ERR_NETWORK_CHANGED";
const IMPORT_FAILED =
  '[web.startup] renderer.load-failed error.name=TypeError error.message="Failed to fetch dynamically imported module: http://127.0.0.1:33067/src/renderer-entry.tsx"';

/** A window whose loads play out in order: each entry is one load's outcome. */
function fakeWindow(loads: Array<{ ready: boolean; console: string[] }>) {
  let load = 0;
  let pending = [...loads[0]!.console];
  const state = { reloads: 0 };
  const window: StartupWindow = {
    title: async () => (loads[load]!.ready ? TITLE : "Orkestrator AI"),
    failureShown: async () => !loads[load]!.ready,
    reload: async () => {
      state.reloads += 1;
      load = Math.min(load + 1, loads.length - 1);
      pending = [...loads[load]!.console];
    },
    drainConsole: () => {
      const drained = pending;
      pending = [];
      return drained;
    },
  };
  return { window, state };
}

function clock() {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => void (time += ms) };
}

describe("isNetworkChangedStartupFailure", () => {
  test("needs both the failed import and a network-change abort", () => {
    expect(isNetworkChangedStartupFailure([ABORTED, IMPORT_FAILED])).toBe(true);
    expect(isNetworkChangedStartupFailure([IMPORT_FAILED])).toBe(false);
    expect(isNetworkChangedStartupFailure([ABORTED])).toBe(false);
    expect(isNetworkChangedStartupFailure([])).toBe(false);
  });
});

describe("nextStartupStep", () => {
  const base = { consoleLines: [ABORTED, IMPORT_FAILED], reloads: 0, maxReloads: 3 };

  test("a matching title is ready even after aborts", () => {
    expect(nextStartupStep({ ...base, titleMatches: true, failureShown: false })).toBe("ready");
  });

  test("waits while the startup screen has not failed", () => {
    expect(nextStartupStep({ ...base, titleMatches: false, failureShown: false })).toBe("wait");
  });

  test("reloads a network-change failure until the budget is spent", () => {
    expect(nextStartupStep({ ...base, titleMatches: false, failureShown: true })).toBe("reload");
    expect(nextStartupStep({ ...base, titleMatches: false, failureShown: true, reloads: 3 })).toBe(
      "fail",
    );
  });

  test("never reloads any other startup failure", () => {
    expect(
      nextStartupStep({
        ...base,
        titleMatches: false,
        failureShown: true,
        consoleLines: ["[web.startup] renderer.load-failed error.name=Error error.message=boom"],
      }),
    ).toBe("fail");
  });
});

describe("waitForRendererStart", () => {
  test("returns without reloading when the first load starts", async () => {
    const { window, state } = fakeWindow([{ ready: true, console: [] }]);
    expect(await waitForRendererStart(window, TITLE, clock())).toBe(0);
    expect(state.reloads).toBe(0);
  });

  test("reloads after a network-change failure and then starts", async () => {
    const { window, state } = fakeWindow([
      { ready: false, console: [ABORTED, ABORTED, IMPORT_FAILED] },
      { ready: true, console: [] },
    ]);
    expect(await waitForRendererStart(window, TITLE, clock())).toBe(1);
    expect(state.reloads).toBe(1);
  });

  test("a reloaded page is judged only on its own console", async () => {
    // The first load's aborts must not license a reload of a second load that
    // failed for another reason.
    const { window, state } = fakeWindow([
      { ready: false, console: [ABORTED, IMPORT_FAILED] },
      { ready: false, console: ["[web.startup] renderer.load-failed error.message=boom"] },
    ]);
    await expect(waitForRendererStart(window, TITLE, clock())).rejects.toThrow(
      "not a network-change module failure",
    );
    expect(state.reloads).toBe(1);
  });

  test("fails a startup failure that is not a network change, without reloading", async () => {
    const { window, state } = fakeWindow([{ ready: false, console: [IMPORT_FAILED] }]);
    await expect(waitForRendererStart(window, TITLE, clock())).rejects.toBeInstanceOf(
      RendererStartupError,
    );
    expect(state.reloads).toBe(0);
  });

  test("gives up after the reload budget", async () => {
    const failing = { ready: false, console: [ABORTED, IMPORT_FAILED] };
    const { window, state } = fakeWindow([failing, failing, failing, failing, failing]);
    await expect(
      waitForRendererStart(window, TITLE, { ...clock(), maxReloads: 2 }),
    ).rejects.toThrow(`still failing after 2 reloads for ${NETWORK_CHANGED}`);
    expect(state.reloads).toBe(2);
  });

  test("times out on a window that neither starts nor fails", async () => {
    const window: StartupWindow = {
      title: async () => "Orkestrator AI",
      failureShown: async () => false,
      reload: async () => undefined,
      drainConsole: () => [],
    };
    await expect(
      waitForRendererStart(window, TITLE, { ...clock(), timeoutMs: 1_000 }),
    ).rejects.toThrow(`stayed "Orkestrator AI" for 1000 ms`);
  });
});

describe("collectStartupConsole", () => {
  test("keeps only the lines that decide a reload, and stops on dispose", () => {
    const listeners = new Set<(message: { text(): string }) => void>();
    const source = {
      on: (_event: "console", listener: (message: { text(): string }) => void) =>
        listeners.add(listener),
      off: (_event: "console", listener: (message: { text(): string }) => void) =>
        listeners.delete(listener),
    };
    const emit = (text: string) => {
      for (const listener of listeners) listener({ text: () => text });
    };
    const console = collectStartupConsole(source);
    emit("[DesktopStartup] checking");
    emit(ABORTED);
    emit(`${MODULE_IMPORT_FAILED}: http://127.0.0.1:1/src/renderer-entry.tsx`);
    expect(console.drain()).toHaveLength(2);
    expect(console.drain()).toEqual([]);
    emit(IMPORT_FAILED);
    for (let index = 0; index < 300; index += 1) emit(ABORTED);
    expect(isNetworkChangedStartupFailure(console.drain())).toBe(true);
    console.dispose();
    emit(ABORTED);
    expect(console.drain()).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});

/** A context whose console messages name the window that logged them. */
function fakeContext() {
  const listeners = new Set<(message: StartupConsoleMessage) => void>();
  const context = {
    on: (_event: "console", listener: (message: StartupConsoleMessage) => void) =>
      listeners.add(listener),
    off: (_event: "console", listener: (message: StartupConsoleMessage) => void) =>
      listeners.delete(listener),
  };
  const emit = (page: unknown, text: string) => {
    for (const listener of listeners) listener({ text: () => text, page: () => page });
  };
  return { app: { context: () => context }, emit, listeners };
}

/**
 * A Playwright page as `pageStartupWindow` reads it: a title, the startup
 * failure text and a reload. Each reload runs `onReload`, which may log.
 */
function fakePage(loads: boolean[], onReload: () => void = () => undefined) {
  let load = 0;
  const state = { reloads: 0 };
  const page = {
    title: async () => (loads[load] ? TITLE : "Orkestrator AI"),
    // Present, whatever its box: a headless window is 1x1 until a spec sizes it.
    getByText: () => ({ count: async () => (loads[load] ? 0 : 1) }),
    reload: async () => {
      state.reloads += 1;
      load = Math.min(load + 1, loads.length - 1);
      onReload();
    },
  };
  return { page: page as never, state };
}

describe("collectStartupConsole by window", () => {
  test("a window's drain takes its own lines and unclaimed ones, never another window's", () => {
    const { app, emit } = fakeContext();
    const console = collectStartupConsole(app.context());
    const first = {};
    const second = {};
    emit(first, ABORTED);
    emit(first, IMPORT_FAILED);
    emit(second, ABORTED);
    emit(null, IMPORT_FAILED);
    expect(console.drain(second)).toEqual([ABORTED, IMPORT_FAILED]);
    expect(console.drain(first)).toEqual([ABORTED, IMPORT_FAILED]);
    expect(console.drain()).toEqual([]);
  });
});

describe("watchElectronStartup", () => {
  test("reloads a window that lost its modules to a network change, once", async () => {
    const { app, emit, listeners } = fakeContext();
    const watch = watchElectronStartup(app);
    const { page, state } = fakePage([false, true]);
    emit(page, `${MODULE_IMPORT_FAILED}: http://127.0.0.1:1/src/renderer-entry.tsx`);
    emit(page, ABORTED);
    await expect(watch.waitForTitle(page, TITLE, { timeoutMs: 5_000 })).resolves.toBe(1);
    expect(state.reloads).toBe(1);
    watch.dispose();
    expect(listeners.size).toBe(0);
  });

  test("a later window is judged on its own console, not on an earlier window's aborts", async () => {
    const { app, emit } = fakeContext();
    const watch = watchElectronStartup(app);
    const earlier = {};
    emit(earlier, IMPORT_FAILED);
    emit(earlier, ABORTED);
    const { page, state } = fakePage([false, true]);
    emit(page, "[web.startup] renderer.load-failed error.name=Error error.message=boom");
    await expect(watch.waitForTitle(page, TITLE, { timeoutMs: 5_000 })).rejects.toThrow(
      "not a network-change module failure",
    );
    expect(state.reloads).toBe(0);
    watch.dispose();
  });

  test("a window that keeps failing for the same reason fails after the budget", async () => {
    const { app, emit } = fakeContext();
    const watch = watchElectronStartup(app);
    let pageRef: unknown;
    const { page, state } = fakePage([false], () => {
      emit(pageRef, IMPORT_FAILED);
      emit(pageRef, ABORTED);
    });
    pageRef = page;
    emit(page, IMPORT_FAILED);
    emit(page, ABORTED);
    await expect(
      watch.waitForTitle(page, TITLE, { timeoutMs: 5_000, maxReloads: 2 }),
    ).rejects.toBeInstanceOf(RendererStartupError);
    expect(state.reloads).toBe(2);
    watch.dispose();
  });
});
