import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { DISABLE_AUTO_UPDATE_ENV } from "@orkestrator/protocol/updates";

/** Opt-out for managed installs and for debugging the updater itself. */
export { DISABLE_AUTO_UPDATE_ENV };

export type UpdateCheckResult = {
  isUpdateAvailable?: boolean;
  updateInfo?: { version: string };
};

/**
 * The slice of `electron-updater`'s `AppUpdater` the desktop update host
 * drives (`update-host.ts`). The backend resolves which release to install;
 * the updater is pinned to that release with a generic feed, so its own
 * GitHub channel resolution is never used.
 */
export type UpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "download-progress", listener: (info: { percent?: number }) => void): unknown;
  off(event: "download-progress", listener: (info: { percent?: number }) => void): unknown;
  setFeedURL(options: {
    provider: "generic";
    url: string;
    channel?: string;
    useMultipleRangeRequest?: boolean;
  }): void;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(cancellationToken?: unknown): Promise<unknown>;
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
  isWritable?: (directory: string) => boolean;
};

function isWritableDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this process is an installation that can update itself.
 *
 * `app-update.yml` is only embedded by release builds (the `publish` target
 * lives in `electron-builder.release.config.ts`), so its presence excludes dev
 * runs, agent-test profiles and the ad-hoc signed `package:mac` install, whose
 * signature could never satisfy an update signed with the Developer ID.
 * On Linux only the AppImage can replace itself without elevation, and only
 * from a folder this user can write to; a pacman install is updated by the
 * package manager.
 */
export function isAutoUpdateSupported(environment: AutoUpdateEnvironment): boolean {
  return autoUpdateUnavailableReason(environment) === null;
}

/** Why this install cannot update itself, in words for the update panel. */
export function autoUpdateUnavailableReason(environment: AutoUpdateEnvironment): string | null {
  if (environment.env[DISABLE_AUTO_UPDATE_ENV] === "1") {
    return `Updates are turned off on this machine (${DISABLE_AUTO_UPDATE_ENV}=1).`;
  }
  if (!environment.isPackaged || environment.runtimeFlavor !== "production") {
    return "Development and test builds do not update themselves.";
  }
  if (environment.platform === "linux") {
    const appImage = environment.env.APPIMAGE;
    if (!appImage) {
      return "Only the AppImage updates itself; update this install with its package manager.";
    }
    // The update replaces the file by renaming a new one next to it.
    if (!(environment.isWritable ?? isWritableDirectory)(path.dirname(appImage))) {
      return `The AppImage's folder (${path.dirname(appImage)}) is not writable, so it cannot replace itself; move it to a folder you own, or update it by hand.`;
    }
  }
  const fileExists = environment.fileExists ?? existsSync;
  if (!fileExists(path.join(environment.resourcesPath, "app-update.yml"))) {
    return "This build was not made for in-app updates; install a release build to update in the app.";
  }
  return null;
}
