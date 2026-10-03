import { existsSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";

/** First check shortly after launch, so it never competes with startup work. */
const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Opt-out for managed installs and for debugging the updater itself. */
export const DISABLE_AUTO_UPDATE_ENV = "ORKESTRATOR_DISABLE_AUTO_UPDATE";

export type UpdateCheckResult = {
  isUpdateAvailable?: boolean;
  downloadPromise?: Promise<string[]> | null;
};

class UpdateDownloadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The slice of `electron-updater`'s `AppUpdater` this module drives. */
export type UpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  quitAndInstall(): void;
};

export type AutoUpdateEnvironment = {
  isPackaged: boolean;
  runtimeFlavor: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Directory holding the `app-update.yml` that electron-builder embeds. */
  resourcesPath: string;
  fileExists?: (filePath: string) => boolean;
};

/**
 * Whether this process is an installation that can update itself.
 *
 * `app-update.yml` is only embedded by release builds (the `publish` target
 * lives in `electron-builder.release.config.ts`), so its presence excludes dev
 * runs, agent-test profiles and the ad-hoc signed `package:mac` install, whose
 * signature could never satisfy an update signed with the Developer ID.
 * On Linux only the AppImage can replace itself without elevation; a pacman
 * install is updated by the package manager.
 */
export function isAutoUpdateSupported(environment: AutoUpdateEnvironment): boolean {
  if (environment.env[DISABLE_AUTO_UPDATE_ENV] === "1") return false;
  if (!environment.isPackaged || environment.runtimeFlavor !== "production") return false;
  if (environment.platform === "linux" && !environment.env.APPIMAGE) return false;
  const fileExists = environment.fileExists ?? existsSync;
  return fileExists(path.join(environment.resourcesPath, "app-update.yml"));
}

export type AutoUpdateController = {
  /** Begin the launch check and the periodic checks. */
  start(): void;
  /** Menu-driven check that reports its outcome to the user. */
  checkNow(): Promise<void>;
  stop(): void;
};

export type AutoUpdateOptions = {
  updater: UpdaterLike;
  productName: string;
  currentVersion: string;
  getWindow(): BrowserWindow | null;
  showMessageBox(
    window: BrowserWindow | null,
    options: MessageBoxOptions,
  ): Promise<MessageBoxReturnValue>;
  log?: Pick<Console, "info" | "warn">;
};

/**
 * Drives electron-updater with a restart prompt in place of a forced restart.
 *
 * Windows may be running agent sessions, so a downloaded update is never
 * applied behind the user's back: they pick "Restart" or "Later", and "Later"
 * installs on the next quit (`autoInstallOnAppQuit`).
 */
export function createAutoUpdateController(options: AutoUpdateOptions): AutoUpdateController {
  const { updater, productName, currentVersion, getWindow, showMessageBox } = options;
  const log = options.log ?? console;
  let downloadedVersion: string | null = null;
  let promptedVersion: string | null = null;
  let manualCheck = false;
  let checkInFlight: Promise<UpdateCheckResult | null> | null = null;
  let readinessRevision = 0;
  let initialTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;

  async function promptToRestart(version: string): Promise<void> {
    if (promptedVersion === version) return;
    promptedVersion = version;
    const revision = readinessRevision;
    const result = await showMessageBox(getWindow(), {
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `${productName} ${version} is ready to install`,
      detail:
        "Restart to finish updating. Choose Later to install it the next time you quit — " +
        "running agent sessions are not interrupted until then.",
    });
    if (result.response === 0 && downloadedVersion === version && revision === readinessRevision) {
      updater.quitAndInstall();
    }
  }

  updater.on("update-downloaded", (info) => {
    downloadedVersion = info.version;
    log.info(`[Updater] Downloaded ${info.version}`);
    if (!checkInFlight) offerRestart(info.version);
  });
  function offerRestart(version: string): void {
    void promptToRestart(version).catch((error: unknown) =>
      log.warn("[Updater] Restart prompt failed:", error),
    );
  }

  function invalidateReadiness(): void {
    downloadedVersion = null;
    promptedVersion = null;
    readinessRevision += 1;
  }

  updater.on("error", (error) => {
    // MacUpdater emits update-downloaded for its ZIP before native staging.
    // A later native error must also invalidate an already-open restart dialog.
    invalidateReadiness();
    log.warn("[Updater] Update failed:", error);
  });

  async function performCheck(): Promise<UpdateCheckResult | null> {
    let result: UpdateCheckResult | null;
    try {
      result = await updater.checkForUpdates();
    } catch (error) {
      log.warn("[Updater] Update check failed:", error);
      throw error;
    }
    // Observe the separate promise immediately, even for background checks.
    // The error event alone does not consume a rejected download promise.
    try {
      await result?.downloadPromise;
    } catch (error) {
      invalidateReadiness();
      log.warn("[Updater] Update download or staging failed:", error);
      throw new UpdateDownloadError(error);
    }
    if (downloadedVersion) offerRestart(downloadedVersion);
    return result;
  }

  function check(): Promise<UpdateCheckResult | null> {
    // Hold the operation through download/staging so a menu click and a timer
    // cannot start competing downloads or misreport an in-flight update.
    checkInFlight ??= performCheck().finally(() => {
      checkInFlight = null;
    });
    return checkInFlight;
  }

  return {
    start(): void {
      if (initialTimer || intervalTimer) return;
      const backgroundCheck = (): void => {
        void check().catch(() => undefined);
      };
      initialTimer = setTimeout(backgroundCheck, INITIAL_CHECK_DELAY_MS);
      intervalTimer = setInterval(backgroundCheck, CHECK_INTERVAL_MS);
      // Neither timer may keep the process alive after the last window closes.
      initialTimer.unref();
      intervalTimer.unref();
    },
    stop(): void {
      if (initialTimer) clearTimeout(initialTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      initialTimer = null;
      intervalTimer = null;
    },
    async checkNow(): Promise<void> {
      if (manualCheck) return;
      manualCheck = true;
      try {
        if (downloadedVersion && !checkInFlight) {
          promptedVersion = null;
          await promptToRestart(downloadedVersion);
          return;
        }
        const result = await check();
        if (!result?.isUpdateAvailable) {
          await showMessageBox(getWindow(), {
            type: "info",
            message: `${productName} is up to date`,
            detail: `Version ${currentVersion} is the latest version.`,
          });
        }
      } catch (error) {
        await showMessageBox(getWindow(), {
          type: "error",
          message:
            error instanceof UpdateDownloadError
              ? "Could not download or prepare the update"
              : "Could not check for updates",
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        manualCheck = false;
      }
    },
  };
}
