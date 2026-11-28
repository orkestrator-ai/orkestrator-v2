import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import { installEssentialLog } from "@orkestrator/protocol/node/essential-log";
import { installControlledTimeout } from "../../../tests/helpers/controlled-timeout";
import { BACKEND_EXIT_WAIT_MS, registerBackendShutdown } from "../electron/backend-lifecycle";
import { registerEssentialShutdown } from "../electron/essential-logging";
import { registerApplicationLoggingShutdown } from "../electron/application-logging";
import { installQuitSignalHandlers, QUIT_SIGNALS } from "../electron/quit-signals";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  resetLogger();
});

function quittingApp() {
  const events = new EventEmitter();
  const finished = Promise.withResolvers<void>();
  const app = {
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    exit: mock(() => {
      events.emit("quit", {}, 0);
      finished.resolve();
    }),
    quit: mock(() => {
      events.emit("before-quit");
      let held = false;
      events.emit("will-quit", { preventDefault: () => (held = true) });
      if (!held) {
        events.emit("quit", {}, 0);
        finished.resolve();
      }
    }),
  };
  return {
    app: app as unknown as Parameters<typeof installQuitSignalHandlers>[0]["app"] & typeof app,
    finished: finished.promise,
  };
}

function signalHarness(now?: () => number) {
  const { app, finished } = quittingApp();
  const emitter = new EventEmitter();
  const signalQuit = installQuitSignalHandlers({
    app,
    process: emitter as unknown as NodeJS.Process,
    normalBackendWaitMs: BACKEND_EXIT_WAIT_MS,
    timing: { backendMs: 30, holdsMs: 200, exitMs: 2_000 },
    now,
  });
  cleanups.push(() => signalQuit.dispose());
  return {
    app,
    finished,
    signalQuit,
    emitter,
    send: (signal: (typeof QUIT_SIGNALS)[number]) => emitter.emit(signal, signal),
  };
}

async function essentialWriter() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-quit-signal-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  configureLogger({ sink: () => {} });
  const log = installEssentialLog({ dataDir: root, owner: "desktop" });
  cleanups.push(() => log.stop());
  await log.flush();
  const file = path.join(log.directory, "essential.jsonl");
  const records = async () =>
    (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> });
  return { log, records };
}

async function settles<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"pending">((resolve) => (timer = setTimeout(() => resolve("pending"), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("desktop shutdown deadlines", () => {
  test("an ordinary AppImage quit confirms a backend close after the 20 s backend hold", async () => {
    const { log, records } = await essentialWriter();
    const { app, finished, signalQuit } = signalHarness();
    const ordinaryDeadline = installControlledTimeout(BACKEND_EXIT_WAIT_MS);
    cleanups.push(() => ordinaryDeadline.restore());
    const closed = Promise.withResolvers<void>();
    const backend = registerBackendShutdown(
      app,
      { stop: () => closed.promise },
      undefined,
      signalQuit,
    );
    const stop = mock(log.stop);
    const relaunchImage = mock(() => {});
    const update = registerEssentialShutdown({
      app,
      backendStopped: backend.stopped,
      essentialLog: { stop },
      timeoutMs: 22_000,
      relaunchImage,
      signalQuit,
    });

    update.quitForUpdate("/isolated/test.AppImage");
    expect(ordinaryDeadline.advance()).toBe(1);
    // The backend hold has expired. Its result stays available to the log hold.
    expect(await settles(backend.stopped(), 30)).toBe("pending");
    expect(stop).not.toHaveBeenCalled();
    closed.resolve();
    expect(await settles(finished, 1_000)).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect((await records()).at(-1)?.event).toBe("essential.stopped");
    expect(relaunchImage).toHaveBeenCalledWith("/isolated/test.AppImage");
    ordinaryDeadline.assertDrained();
  });

  test("a signal during an ordinary quit uses the monotonic clock after a wall clock jump", async () => {
    const { app, finished, signalQuit, send } = signalHarness();
    const backend = registerBackendShutdown(
      app,
      { stop: () => new Promise<void>(() => {}) },
      undefined,
      signalQuit,
    );
    app.quit();
    const wallClock = spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
    cleanups.push(() => wallClock.mockRestore());

    send("SIGHUP");
    await expect(backend.stopped()).rejects.toThrow("termination signal deadline");
    expect(await settles(finished, 1_000)).toBeUndefined();
  });

  test("a signal cannot extend the ordinary backend allowance", async () => {
    let clock = 0;
    const { app, signalQuit, send } = signalHarness(() => clock);
    app.quit();
    clock = BACKEND_EXIT_WAIT_MS;
    send("SIGTERM");
    expect(await settles(signalQuit.backendExpired, 0)).toBeUndefined();
  });

  test("a repeated signal leaves the original quit and deadline alone", async () => {
    const { app, signalQuit, send } = signalHarness();
    const stop = mock(() => new Promise<void>(() => {}));
    registerBackendShutdown(app, { stop }, undefined, signalQuit);
    send("SIGHUP");
    send("SIGTERM");
    send("SIGTERM");
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    await signalQuit.backendExpired;
  });

  test("dispose removes both signal listeners", () => {
    const { signalQuit, emitter } = signalHarness();
    expect(emitter.listenerCount("SIGTERM")).toBe(1);
    expect(emitter.listenerCount("SIGHUP")).toBe(1);
    signalQuit.dispose();
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
    expect(emitter.listenerCount("SIGHUP")).toBe(0);
  });

  test("a stalled essential writer releases its hold at the signal deadline", async () => {
    const { app, finished, signalQuit, send } = signalHarness(() => 0);
    const holdDeadline = installControlledTimeout(200);
    cleanups.push(() => holdDeadline.restore());
    const backend = registerBackendShutdown(app, { stop: async () => {} }, undefined, signalQuit);
    const stop = mock(() => new Promise<boolean>(() => {}));
    registerEssentialShutdown({
      app,
      backendStopped: backend.stopped,
      essentialLog: { stop },
      timeoutMs: 22_000,
      relaunchImage: () => {},
      signalQuit,
    });
    send("SIGTERM");
    expect(await settles(finished, 30)).toBe("pending");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(holdDeadline.advance()).toBe(1);
    expect(await settles(finished, 1_000)).toBeUndefined();
    expect(app.exit).not.toHaveBeenCalled();
  });

  test.each(QUIT_SIGNALS)(
    "%s writes the signal and marker while the application log flush is stalled",
    async (signal) => {
      const { log, records } = await essentialWriter();
      const { app, finished, signalQuit, send } = signalHarness(() => 0);
      const holdDeadline = installControlledTimeout(200);
      cleanups.push(() => holdDeadline.restore());
      const backend = registerBackendShutdown(
        app,
        { stop: () => new Promise<void>(() => {}) },
        undefined,
        signalQuit,
      );
      const logFlush = mock(() => new Promise<void>(() => {}));
      const marker = Promise.withResolvers<boolean>();
      registerApplicationLoggingShutdown(
        app,
        { stop: logFlush },
        undefined,
        { settled: backend.stopped, timeoutMs: BACKEND_EXIT_WAIT_MS },
        signalQuit.holdsExpired,
      );
      registerEssentialShutdown({
        app,
        backendStopped: backend.stopped,
        essentialLog: {
          async stop() {
            const committed = await log.stop();
            marker.resolve(committed);
            return committed;
          },
        },
        timeoutMs: 22_000,
        relaunchImage: () => {},
        signalQuit,
      });
      send(signal);
      await expect(backend.stopped()).rejects.toThrow("termination signal deadline");
      expect(await settles(marker.promise, 1_000)).toBe(true);
      expect(holdDeadline.advance()).toBe(1);
      expect(await settles(finished, 1_000)).toBeUndefined();
      expect(logFlush).toHaveBeenCalledTimes(1);
      expect(app.exit).not.toHaveBeenCalled();

      expect((await records()).slice(-2)).toMatchObject([
        {
          event: "quit.signal-received",
          fields: { signal, backendWaitMs: 30, quitAlreadyRequested: false },
        },
        { event: "essential.stopped" },
      ]);
    },
  );
});
