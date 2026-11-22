import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import electronUpdater from "electron-updater";
import { installEssentialLog } from "@orkestrator/protocol/node/essential-log";
import { createAppImageUpdater } from "../electron/appimage-update.js";
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  claimDesktopLogging,
  exitApplication,
  exitWithEssentialLog,
  registerEssentialShutdown,
} from "../electron/essential-logging.js";
import { configureLogger, createLogger, resetLogger } from "@orkestrator/protocol/logger";

test("a rejected secondary launch leaves the primary's unmatched start intact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-essential-"));
  const file = path.join(root, "logs", "essential", "essential.jsonl");
  const fakeApp = (primary: boolean) =>
    ({
      requestSingleInstanceLock: () => primary,
      quit() {},
      on() {},
    }) as unknown as Parameters<typeof claimDesktopLogging>[0];
  const primary = claimDesktopLogging(fakeApp(true), root);
  try {
    await primary.essentialLog!.flush();
    const before = await readFile(file, "utf8");
    const secondary = claimDesktopLogging(fakeApp(false), root);
    expect(secondary).toEqual({ isPrimaryInstance: false, essentialLog: null });
    expect(await readFile(file, "utf8")).toBe(before);
    // Still the primary's sink; the rejected launch must not replace it either.
    configureLogger({ sink: () => {} });
    createLogger("backend").info("shutdown.finished", { code: 7 });
    await primary.essentialLog!.flush();
    const after = await readFile(file, "utf8");
    expect(after.match(/"event":"essential.started"/g)).toHaveLength(1);
    expect(after).not.toContain('"event":"essential.stopped"');
    expect(after).toContain('"code":7');
  } finally {
    await primary.essentialLog?.stop();
    resetLogger();
    await rm(root, { recursive: true, force: true });
  }
});

test("immediate native exit receives already persisted queued entries without will-quit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-essential-exit-"));
  configureLogger({ sink: () => {} });
  const log = installEssentialLog({ dataDir: root, owner: "desktop" });
  try {
    createLogger("backend").info("shutdown.finished", { code: 42 });
    let called = false;
    exitWithEssentialLog(
      {
        exit: (code) => {
          called = true;
          expect(code).toBe(3);
          // Read synchronously at the exact point native exit takes over.
          const text = readFileSync(path.join(log.directory, "essential.jsonl"), "utf8");
          expect(text).toContain('"code":42');
          expect(text).not.toContain('"event":"essential.stopped"');
        },
      },
      log,
      3,
    );
    expect(called).toBe(true);
    await log.flush();
    const text = await readFile(path.join(log.directory, "essential.jsonl"), "utf8");
    expect(text.match(/"code":42/g)).toHaveLength(1);
  } finally {
    await log.stop();
    resetLogger();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing the application with code 0 is an orderly quit, not an immediate exit", () => {
  const calls: string[] = [];
  const app = { quit: () => calls.push("quit"), exit: () => calls.push("exit") };
  const log = { flushSync: () => calls.push("flushSync") };
  exitApplication(app, log as never, 0);
  exitApplication(app, log as never);
  expect(calls).toEqual(["quit", "quit"]);
});

test("a failure exit code still exits at once after draining the essential log", () => {
  const calls: string[] = [];
  const app = {
    quit: () => calls.push("quit"),
    exit: (code?: number) => calls.push(`exit:${code}`),
  };
  exitApplication(app, { flushSync: () => calls.push("flushSync") } as never, 2);
  expect(calls).toEqual(["flushSync", "exit:2"]);
});

function setupQuittingApp() {
  const events = new EventEmitter();
  const finished = Promise.withResolvers<void>();
  const app = {
    on: events.on.bind(events),
    quit() {
      events.emit("before-quit");
      let held = false;
      events.emit("will-quit", { preventDefault: () => (held = true) });
      if (held) return;
      events.emit("quit", {}, 0);
      finished.resolve();
    },
  };
  return { app: app as unknown as Pick<Electron.App, "on" | "quit">, finished: finished.promise };
}

test.skipIf(process.platform !== "linux")(
  "an AppImage install failure leaves the writer active and allows a retry",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desktop-appimage-failed-"));
    const log = installEssentialLog({ dataDir: root, owner: "desktop" });
    const current = path.join(root, "Orkestrator-1.0.0.AppImage");
    const next = path.join(root, "pending", "Orkestrator-2.0.0.AppImage");
    const previousAppImage = process.env.APPIMAGE;
    process.env.APPIMAGE = current;
    const quit = mock((_image: string) => {});
    try {
      class FixtureUpdater extends electronUpdater.AppImageUpdater {
        constructor() {
          super(null, { version: "1.0.0" });
          Object.assign(this, { downloadedUpdateHelper: { file: next, downloadedFileInfo: {} } });
        }
      }
      const updater = createAppImageUpdater(FixtureUpdater);
      updater.logger = new electronUpdater.NoOpLogger();
      const reportError = mock((_error: Error) => {});
      updater.on("error", reportError);

      await mkdir(path.dirname(next));
      await writeFile(next, '#!/bin/sh\n[ "$APPIMAGE_EXIT_AFTER_INSTALL" = true ]\n', {
        mode: 0o700,
      });
      // unlinkSync fails on a directory. The pinned installer reports it
      // synchronously and the current app must keep its writer and backend.
      await mkdir(current);
      expect(updater.installForRestart(current, quit)).toBe(false);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(quit).not.toHaveBeenCalled();
      createLogger("backend").info("shutdown.finished", { code: 12 });
      await log.flush();
      const entries = await readFile(path.join(log.directory, "essential.jsonl"), "utf8");
      expect(entries).toContain('"event":"essential.started"');
      expect(entries).toContain('"code":12');
      expect(entries).not.toContain('"event":"essential.stopped"');

      await rmdir(current);
      await writeFile(current, "");
      expect(updater.installForRestart(current, quit)).toBe(true);
      expect(quit).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledWith(path.join(root, path.basename(next)));
      expect(updater.listenerCount("appimage-filename-updated")).toBe(0);
    } finally {
      if (previousAppImage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = previousAppImage;
      await log.stop();
      resetLogger();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["committed", "failed", "late"] as const)(
  "AppImage relaunch requires a confirmed stop append (%s)",
  async (outcome) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "desktop-appimage-"));
    const blockedWrite = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    let stopping = false;
    const log = installEssentialLog({
      dataDir: root,
      owner: "desktop",
      async beforeWrite() {
        if (!stopping) return;
        if (outcome === "failed") throw new Error("injected stop append failure");
        if (outcome === "late") await blockedWrite.promise;
      },
    });
    const file = path.join(log.directory, "essential.jsonl");
    const { app, finished } = setupQuittingApp();
    const relaunch = mock((_image: string) => {
      expect(readFileSync(file, "utf8")).toContain('"event":"essential.stopped"');
    });
    const { quitForUpdate } = registerEssentialShutdown({
      app,
      backendStopped: () => drained.promise,
      essentialLog: log,
      timeoutMs: outcome === "late" ? 20 : 3_000,
      relaunchImage: relaunch,
    });
    try {
      await log.flush();
      stopping = true;
      quitForUpdate("/updated.AppImage");
      expect(relaunch).not.toHaveBeenCalled();
      expect(readFileSync(file, "utf8")).not.toContain('"event":"essential.stopped"');
      drained.resolve();
      await finished;
      if (outcome === "committed") {
        expect(relaunch).toHaveBeenCalledTimes(1);
        expect(relaunch).toHaveBeenCalledWith("/updated.AppImage");
        const replacement = installEssentialLog({ dataDir: root, owner: "desktop" });
        try {
          await replacement.flush();
          const entries = await readFile(file, "utf8");
          expect(entries.match(/essential\.(started|stopped)/g)).toEqual([
            "essential.started",
            "essential.stopped",
            "essential.started",
          ]);
        } finally {
          await replacement.stop();
        }
      } else {
        expect(relaunch).not.toHaveBeenCalled();
        expect(await readFile(file, "utf8")).not.toContain('"event":"essential.stopped"');
        blockedWrite.resolve();
        expect(await log.stop()).toBe(outcome === "late");
        expect(relaunch).not.toHaveBeenCalled();
      }
    } finally {
      blockedWrite.resolve();
      drained.resolve();
      await log.stop();
      resetLogger();
      await rm(root, { recursive: true, force: true });
    }
  },
);
