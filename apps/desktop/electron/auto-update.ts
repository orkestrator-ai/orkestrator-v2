import { existsSync } from "node:fs";
import path from "node:path";
import {
  HOST_UPDATE_CHANNEL_TAGS,
  hostUpdateChannelOfVersion,
  type HostUpdateChannel,
} from "@orkestrator/protocol/host-maintenance";
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";

/** First check shortly after launch, so it never competes with startup work. */
const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Opt-out for managed installs and for debugging the updater itself. */
export const DISABLE_AUTO_UPDATE_ENV = "ORKESTRATOR_DISABLE_AUTO_UPDATE";

export type UpdateCheckResult = {
  isUpdateAvailable?: boolean;
  updateInfo?: { version: string };
  downloadPromise?: Promise<string[]> | null;
};

/** What one check found, reported whether or not anyone asked for it. */
export type UpdateCheckReport = {
  channel?: HostUpdateChannel;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  checkedAt: string;
  error: string | null;
};

/** Outcome of staging an update for a remote request. */
export type StagedUpdate = { status: "staged"; version: string } | { status: "up-to-date" };

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
  allowDowngrade: boolean;
  channel: string | null;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
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
  /** A check nobody watches: no dialogs, and failures are only reported. */
  checkSilently(): Promise<void>;
  /**
   * Checks, downloads and stages an update for a remote request, without the
   * Restart Now / Later prompt: the remote flow shows its own countdown.
   */
  stageForRemote(onProgress?: (percent: number) => void): Promise<StagedUpdate>;
  /** Quits and installs `version` if it is the staged update; false otherwise. */
  installStaged(version: string): Promise<boolean>;
  /** Release the staged version after a remote job ends. */
  releaseRemoteStage(): void;
  /**
   * Follows `channel` from the next check. An update already downloaded from
   * the previous channel still installs on quit.
   */
  setChannel(channel: HostUpdateChannel): void;
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
  /** Called after every check, background ones included. */
  onCheckResult?(report: UpdateCheckReport): void;
  /** Drain the backend and release the AppImage single-instance lock before spawning its replacement. */
  prepareForInstall?(): Promise<void>;
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
  let channelGeneration = 0;
  let inFlightGeneration = 0;
  let initialTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  // While a remote request stages an update, its countdown replaces the prompt.
  let remoteStaging = 0;
  let remoteReserved = false;
  let progressListener: ((percent: number) => void) | null = null;

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  let channel: HostUpdateChannel | null = null;

  /**
   * electron-updater's GitHub provider reads `/releases/latest` unless
   * prereleases are allowed; with them, the `beta` channel takes the newest
   * stable or beta release and `alpha` the newest of any. Stable names
   * `latest` because a channel, once set, cannot be cleared.
   */
  function applyChannel(next: HostUpdateChannel): void {
    if (channel === next) return;
    channel = next;
    channelGeneration += 1;
    // Do not mutate a provider while its previous check/download is using it.
    if (!checkInFlight) configureChannel(next);
  }

  function configureChannel(next: HostUpdateChannel): void {
    updater.channel = HOST_UPDATE_CHANNEL_TAGS[next];
    updater.allowPrerelease = next !== "stable";
    // Setting a channel allows downgrades. Moving to a more stable channel
    // must wait for that channel to overtake this version instead.
    updater.allowDowngrade = false;
  }
  // The Local backend's record replaces this once its executor reads it.
  applyChannel(hostUpdateChannelOfVersion(currentVersion) ?? "stable");

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
      await options.prepareForInstall?.();
      updater.quitAndInstall();
    }
  }

  updater.on("download-progress", (info) => {
    progressListener?.(info.percent);
  });

  updater.on("update-downloaded", (info) => {
    downloadedVersion = info.version;
    log.info(`[Updater] Downloaded ${info.version}`);
    if (!checkInFlight) offerRestart(info.version);
  });
  function offerRestart(version: string): void {
    if (remoteStaging > 0) return;
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

  function reportCheck(report: Omit<UpdateCheckReport, "checkedAt">): void {
    try {
      options.onCheckResult?.({
        ...report,
        channel: channel!,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      log.warn("[Updater] Reporting a check failed:", error);
    }
  }

  async function performCheck(generation: number): Promise<UpdateCheckResult | null> {
    let result: UpdateCheckResult | null;
    try {
      result = await updater.checkForUpdates();
    } catch (error) {
      log.warn("[Updater] Update check failed:", error);
      if (generation === channelGeneration)
        reportCheck({
          latestVersion: null,
          updateAvailable: null,
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
    if (generation === channelGeneration)
      reportCheck({
        latestVersion: result?.updateInfo?.version ?? null,
        updateAvailable: result?.isUpdateAvailable ?? false,
        error: null,
      });
    // Observe the separate promise immediately, even for background checks.
    // The error event alone does not consume a rejected download promise.
    try {
      await result?.downloadPromise;
    } catch (error) {
      invalidateReadiness();
      log.warn("[Updater] Update download or staging failed:", error);
      throw new UpdateDownloadError(error);
    }
    if (generation === channelGeneration && downloadedVersion) offerRestart(downloadedVersion);
    return result;
  }

  async function check(): Promise<UpdateCheckResult | null> {
    // Serialize downloads, but never answer a channel switch with an old check.
    // Even old failures must finish before configuring and querying the new feed.
    while (true) {
      if (remoteReserved && !checkInFlight) return null;
      if (!checkInFlight) {
        configureChannel(channel!);
        inFlightGeneration = channelGeneration;
        checkInFlight = performCheck(inFlightGeneration).finally(() => {
          checkInFlight = null;
        });
      }
      const generation = inFlightGeneration;
      try {
        const result = await checkInFlight;
        if (generation === channelGeneration) return result;
      } catch (error) {
        if (generation === channelGeneration) throw error;
      }
    }
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
    async checkSilently(): Promise<void> {
      await check().catch(() => undefined);
    },
    async stageForRemote(onProgress?: (percent: number) => void): Promise<StagedUpdate> {
      remoteStaging += 1;
      if (onProgress) progressListener = onProgress;
      try {
        const result = !downloadedVersion || checkInFlight ? await check() : null;
        if (downloadedVersion) {
          // The remote countdown is this version's prompt; do not ask again.
          promptedVersion = downloadedVersion;
          remoteReserved = true;
          return { status: "staged", version: downloadedVersion };
        }
        if (result?.isUpdateAvailable) {
          throw new Error("The update downloaded but was not staged for installation");
        }
        return { status: "up-to-date" };
      } finally {
        remoteStaging -= 1;
        if (progressListener === onProgress) progressListener = null;
      }
    },
    releaseRemoteStage(): void {
      remoteReserved = false;
    },
    setChannel(next: HostUpdateChannel): void {
      if (channel !== next) log.info(`[Updater] Following the ${next} channel`);
      applyChannel(next);
    },
    async installStaged(version: string): Promise<boolean> {
      if (downloadedVersion !== version || checkInFlight) return false;
      // Nobody may be at this computer: relaunch after installing. Linux
      // AppImage otherwise exits without starting the new version; macOS
      // always relaunches and ignores both arguments.
      await options.prepareForInstall?.();
      updater.quitAndInstall(true, true);
      return true;
    },
    stop(): void {
      if (initialTimer) clearTimeout(initialTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      initialTimer = null;
      intervalTimer = null;
    },
    async checkNow(): Promise<void> {
      if (manualCheck || remoteReserved) return;
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
