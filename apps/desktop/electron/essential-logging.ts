import {
  installEssentialLog,
  type InstalledEssentialLog,
} from "@orkestrator/protocol/node/essential-log";
import { claimSingleInstanceLock } from "./single-instance.js";

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
