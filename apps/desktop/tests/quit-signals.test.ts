import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import { installEssentialLog } from "@orkestrator/protocol/node/essential-log";
import {
  BACKEND_EXIT_WAIT_MS,
  createBackendQuitWait,
  registerBackendShutdown,
} from "../electron/backend-lifecycle.js";
import { registerEssentialShutdown } from "../electron/essential-logging.js";
import {
  installQuitSignalHandlers,
  QUIT_SIGNALS,
  SIGNAL_QUIT_BACKEND_WAIT_MS,
} from "../electron/quit-signals.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetLogger();
});

/** Electron's quit sequence as the holds see it: `before-quit`, then a preventable `will-quit`. */
function quittingApp() {
  const events = new EventEmitter();
  const finished = Promise.withResolvers<number>();
  const startedAt = Date.now();
  const state = { quitCalls: 0 };
  const app = {
    on: events.on.bind(events),
    quit: mock(() => {
      state.quitCalls += 1;
      events.emit("before-quit");
      let held = false;
      events.emit("will-quit", { preventDefault: () => (held = true) });
      if (held) return;
      events.emit("quit", {}, 0);
      finished.resolve(Date.now() - startedAt);
    }),
  };
  return {
    app: app as unknown as Pick<Electron.App, "on" | "quit"> & { quit: typeof app.quit },
    state,
    finished: finished.promise,
  };
}

/** A stand-in for `process`, so no test ever signals the runner itself. */
function signalSource() {
  const emitter = new EventEmitter();
  return {
    process: emitter as unknown as Parameters<typeof installQuitSignalHandlers>[0]["process"] &
      object,
    send: (signal: NodeJS.Signals) => emitter.emit(signal, signal),
    listeners: (signal: NodeJS.Signals) => emitter.listenerCount(signal),
  };
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise,
    new Promise<"pending">((resolve) => (timer = setTimeout(() => resolve("pending"), ms))),
  ]);
  clearTimeout(timer);
  return result;
}

describe("the backend quit wait", () => {
  test("an ordinary quit keeps the 20 s bound", () => {
    expect(BACKEND_EXIT_WAIT_MS).toBe(20_000);
    const wait = createBackendQuitWait();
    wait.begin();
    expect(wait.allowanceMs()).toBe(20_000);
  });

  test("a signal-started quit waits about 3 s, inside a 5 s session stop timeout", () => {
    expect(SIGNAL_QUIT_BACKEND_WAIT_MS).toBe(3_000);
    expect(QUIT_SIGNALS).toEqual(["SIGTERM", "SIGHUP"]);
  });

  test("a cap counts from when it is applied and never lengthens the wait", () => {
    let clock = 1_000;
    const wait = createBackendQuitWait(20_000, () => clock);
    wait.cap(3_000);
    expect(wait.allowanceMs()).toBe(3_000);
    wait.begin();
    clock += 10_000;
    // A cap after the wait already ran past it ends the wait now.
    wait.cap(3_000);
    expect(wait.allowanceMs()).toBe(3_000);

    const later = createBackendQuitWait(20_000, () => clock);
    later.begin();
    clock += 5_000;
    later.cap(3_000);
    expect(later.allowanceMs()).toBe(8_000);
    later.cap(30_000);
    expect(later.allowanceMs()).toBe(8_000);
  });

  test("expires only after begin", async () => {
    const wait = createBackendQuitWait(5);
    expect(await settledWithin(wait.expired, 30)).toBe("pending");
    wait.begin();
    expect(await settledWithin(wait.expired, 1_000)).toBeUndefined();
  });
});

describe("termination signals", () => {
  test("SIGTERM quits with the backend wait capped while the backend is still draining", async () => {
    const { app, finished } = quittingApp();
    const backendProcess = { stop: mock(() => new Promise<void>(() => {})) };
    const wait = createBackendQuitWait();
    registerBackendShutdown(app, backendProcess, BACKEND_EXIT_WAIT_MS, wait);
    const signals = signalSource();
    const handlers = installQuitSignalHandlers({
      app,
      backendWait: wait,
      process: signals.process,
      waitMs: 40,
    });
    cleanups.push(() => handlers.dispose());

    signals.send("SIGTERM");
    expect(handlers.received()).toBe("SIGTERM");
    expect(backendProcess.stop).toHaveBeenCalledTimes(1);
    expect(wait.allowanceMs()).toBe(40);
    // Released by the cap, far inside the 20 s hold.
    expect(await settledWithin(finished, 5_000)).toBeLessThan(5_000);
  });

  test("an ordinary quit still waits for the backend past the signal cap", async () => {
    const { app, finished } = quittingApp();
    const exited = Promise.withResolvers<void>();
    const wait = createBackendQuitWait();
    registerBackendShutdown(app, { stop: () => exited.promise }, BACKEND_EXIT_WAIT_MS, wait);
    const signals = signalSource();
    const handlers = installQuitSignalHandlers({
      app,
      backendWait: wait,
      process: signals.process,
      waitMs: 10,
    });
    cleanups.push(() => handlers.dispose());

    app.quit();
    expect(await settledWithin(finished, 100)).toBe("pending");
    expect(wait.allowanceMs()).toBe(BACKEND_EXIT_WAIT_MS);
    expect(handlers.received()).toBeNull();
    exited.resolve();
    expect(await settledWithin(finished, 5_000)).not.toBe("pending");
  });

  test("a signal during an ordinary quit shortens the wait already running", async () => {
    const { app, finished } = quittingApp();
    const wait = createBackendQuitWait();
    registerBackendShutdown(
      app,
      { stop: () => new Promise<void>(() => {}) },
      BACKEND_EXIT_WAIT_MS,
      wait,
    );
    const signals = signalSource();
    const handlers = installQuitSignalHandlers({
      app,
      backendWait: wait,
      process: signals.process,
      waitMs: 30,
    });
    cleanups.push(() => handlers.dispose());

    app.quit();
    expect(await settledWithin(finished, 50)).toBe("pending");
    signals.send("SIGHUP");
    expect(await settledWithin(finished, 5_000)).not.toBe("pending");
  });

  test("a second signal neither starts a second quit nor changes the cap", async () => {
    const { app, state, finished } = quittingApp();
    const wait = createBackendQuitWait();
    const cap = mock((ms: number) => wait.cap(ms));
    const backendProcess = { stop: mock(() => new Promise<void>(() => {})) };
    registerBackendShutdown(app, backendProcess, BACKEND_EXIT_WAIT_MS, wait);
    const signals = signalSource();
    const handlers = installQuitSignalHandlers({
      app,
      backendWait: { cap },
      process: signals.process,
      waitMs: 30,
    });
    cleanups.push(() => handlers.dispose());

    signals.send("SIGHUP");
    signals.send("SIGTERM");
    signals.send("SIGTERM");
    expect(state.quitCalls).toBe(1);
    expect(cap).toHaveBeenCalledTimes(1);
    expect(handlers.received()).toBe("SIGHUP");
    expect(backendProcess.stop).toHaveBeenCalledTimes(1);
    expect(await settledWithin(finished, 5_000)).not.toBe("pending");
  });

  test("dispose removes both listeners", () => {
    const signals = signalSource();
    const handlers = installQuitSignalHandlers({
      app: { quit: () => {} },
      backendWait: { cap: () => {} },
      process: signals.process,
    });
    expect(signals.listeners("SIGTERM")).toBe(1);
    expect(signals.listeners("SIGHUP")).toBe(1);
    handlers.dispose();
    expect(signals.listeners("SIGTERM")).toBe(0);
    expect(signals.listeners("SIGHUP")).toBe(0);
  });

  test.each(QUIT_SIGNALS)(
    "a %s quit writes its signal and essential.stopped before the cap's budget runs out",
    async (signal) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "desktop-quit-signal-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      configureLogger({ sink: () => {} });
      const essentialLog = installEssentialLog({ dataDir: root, owner: "desktop" });
      cleanups.push(() => essentialLog.stop());
      const file = path.join(essentialLog.directory, "essential.jsonl");

      const { app, finished } = quittingApp();
      const wait = createBackendQuitWait();
      const backendShutdown = registerBackendShutdown(
        app,
        { stop: () => new Promise<void>(() => {}) },
        BACKEND_EXIT_WAIT_MS,
        wait,
      );
      registerEssentialShutdown({
        app,
        backendStopped: backendShutdown.stopped,
        essentialLog,
        timeoutMs: BACKEND_EXIT_WAIT_MS + 2_000,
        relaunchImage: () => {},
      });
      const signals = signalSource();
      const handlers = installQuitSignalHandlers({
        app,
        backendWait: wait,
        process: signals.process,
        waitMs: 60,
      });
      cleanups.push(() => handlers.dispose());
      await essentialLog.flush();

      signals.send(signal);
      const elapsed = await settledWithin(finished, 5_000);
      expect(elapsed).not.toBe("pending");

      const records = (await readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> });
      const events = records.map((record) => record.event);
      expect(events.at(-1)).toBe("essential.stopped");
      const received = records.find((record) => record.event === "quit.signal-received");
      expect(received?.fields).toEqual({ signal, backendWaitMs: 60 });
      expect(events.indexOf("quit.signal-received")).toBeLessThan(
        events.indexOf("essential.stopped"),
      );
    },
  );
});
