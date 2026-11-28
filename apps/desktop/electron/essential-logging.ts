import { createLogger } from "@orkestrator/protocol/logger";
import { registerWillQuitHold } from "./application-logging.js";
import {
  installEssentialLog,
  type InstalledEssentialLog,
} from "@orkestrator/protocol/node/essential-log";
import type { SignalQuitDeadlines } from "./quit-signals.js";
import { claimSingleInstanceLock } from "./single-instance.js";

const log = createLogger("desktop");

/** userData must be set before calling: rejected launches own no persistent sink. */
export function claimDesktopLogging(
  app: Parameters<typeof claimSingleInstanceLock>[0],
  dataDir: string,
): {
  isPrimaryInstance: boolean;
  essentialLog: InstalledEssentialLog | null;
} {
  const isPrimaryInstance = claimSingleInstanceLock(app);
  return {
    isPrimaryInstance,
    essentialLog: isPrimaryInstance ? installEssentialLog({ dataDir, owner: "desktop" }) : null,
  };
}

/** Electron app.exit skips will-quit; drain before entering that native exit path. */
export function exitWithEssentialLog(
  app: Pick<Electron.App, "exit">,
  log: InstalledEssentialLog | null,
  code?: number,
): void {
  log?.flushSync();
  app.exit(code);
}

/**
 * The renderer's process exit ("Close application"). Exit code 0 is an
 * ordinary quit: the backend drains and the essential log records
 * `essential.stopped`. `app.exit` would skip `will-quit`, so the next launch
 * would read the close as a desktop that died (`logging:writer-died:desktop`).
 * Any other code still exits at once, after draining what is queued.
 */
export function exitApplication(
  app: Pick<Electron.App, "exit" | "quit">,
  log: InstalledEssentialLog | null,
  code = 0,
): void {
  if (code === 0) {
    app.quit();
    return;
  }
  exitWithEssentialLog(app, log, code);
}

/** Keep Electron's lock until process exit and schedule only from the final quit event. */
export function registerEssentialShutdown(options: {
  app: Pick<Electron.App, "on" | "quit">;
  backendStopped(): Promise<void>;
  essentialLog: Pick<InstalledEssentialLog, "stop">;
  timeoutMs: number;
  signalQuit?: SignalQuitDeadlines;
  relaunchImage(image: string): void;
}): { quitForUpdate(image: string): void; updatePending(): boolean } {
  const { app, backendStopped, essentialLog, timeoutMs, signalQuit, relaunchImage } = options;
  let updateImage: string | undefined;
  let confirmed = false;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      const drained = await backendStopped().then(
        () => true,
        () => false,
      );
      confirmed = (await essentialLog.stop()) && drained;
    })());
  registerWillQuitHold(app, stop, timeoutMs, signalQuit?.holdsExpired);
  // Start the marker even if a window is slow to reach will-quit.
  void signalQuit?.started.then(stop).catch(() => undefined);

  app.on("quit", (_event, code) => {
    if (!updateImage || code !== 0) return;
    if (confirmed) relaunchImage(updateImage);
    else log.error("relaunch.schedule-failed", { reason: "AppImage shutdown was not confirmed" });
  });

  return {
    quitForUpdate(image) {
      updateImage = image;
      app.quit();
    },
    updatePending: () => updateImage !== undefined,
  };
}
