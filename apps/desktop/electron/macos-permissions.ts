import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
  MacOsMissingPermission,
  MacOsPermissionsStatus,
  MacOsPrivacySettingsPane,
} from "@orkestrator/protocol/macos-permissions";

const FULL_DISK_ACCESS_PROBE_PATH = "/Library/Application Support/com.apple.TCC";

type PermissionProbe = MacOsMissingPermission & { path: string };

export type MacOsPermissionsProbeOptions = {
  platform?: NodeJS.Platform;
  homeDirectory: string;
  readDirectory?: (directory: string) => Promise<void>;
};

function permissionProbes(homeDirectory: string): PermissionProbe[] {
  return [
    {
      id: "full-disk-access",
      label: "Full Disk Access",
      settingsPane: "full-disk-access",
      required: true,
      path: FULL_DISK_ACCESS_PROBE_PATH,
    },
    {
      id: "desktop",
      label: "Desktop folder",
      settingsPane: "files-and-folders",
      required: true,
      path: path.join(homeDirectory, "Desktop"),
    },
    {
      id: "documents",
      label: "Documents folder",
      settingsPane: "files-and-folders",
      required: true,
      path: path.join(homeDirectory, "Documents"),
    },
    {
      id: "downloads",
      label: "Downloads folder",
      settingsPane: "files-and-folders",
      required: true,
      path: path.join(homeDirectory, "Downloads"),
    },
    {
      id: "music",
      label: "Music folder",
      settingsPane: "files-and-folders",
      required: true,
      path: path.join(homeDirectory, "Music"),
    },
    {
      id: "pictures",
      label: "Pictures folder",
      settingsPane: "files-and-folders",
      required: true,
      path: path.join(homeDirectory, "Pictures"),
    },
    {
      id: "movies",
      label: "Movies folder",
      settingsPane: "files-and-folders",
      required: true,
      path: path.join(homeDirectory, "Movies"),
    },
    {
      id: "photos",
      label: "Photos library",
      settingsPane: "photos",
      required: true,
      path: path.join(homeDirectory, "Pictures", "Photos Library.photoslibrary"),
    },
    {
      id: "media-library",
      label: "Media Library",
      settingsPane: "media-library",
      required: true,
      path: path.join(homeDirectory, "Music", "Music", "Music Library.musiclibrary"),
    },
  ];
}

function isPermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Reading only directory entries exercises the same macOS privacy check as a
 * recursive `find` without retaining or exposing any file names. The Photos
 * and Music library package probes deliberately cross the nested privacy
 * boundaries that a home-directory search would otherwise encounter later.
 */
export async function readDirectoryEntries(directory: string): Promise<void> {
  await readdir(directory);
}

/**
 * Probe access sequentially so macOS never stacks several privacy prompts at
 * once. Missing standard folders and unrelated I/O failures do not block app
 * startup; only the OS permission-denied errors are actionable here.
 */
export async function probeMacOsPermissions({
  platform = process.platform,
  homeDirectory,
  readDirectory = readDirectoryEntries,
}: MacOsPermissionsProbeOptions): Promise<MacOsPermissionsStatus> {
  if (platform !== "darwin") return { supported: false, missing: [] };

  const missing: MacOsMissingPermission[] = [];
  for (const probe of permissionProbes(homeDirectory)) {
    try {
      await readDirectory(probe.path);
    } catch (error) {
      if (isPermissionDenied(error)) {
        const { path: _path, ...permission } = probe;
        missing.push(permission);
      }
    }
  }
  return { supported: true, missing };
}

export function macOsPrivacySettingsUrl(pane: MacOsPrivacySettingsPane): string {
  const anchor = {
    "full-disk-access": "Privacy_AllFiles",
    "files-and-folders": "Privacy_FilesAndFolders",
    photos: "Privacy_Photos",
    "media-library": "Privacy_Media",
  }[pane];
  return `x-apple.systempreferences:com.apple.preference.security?${anchor}`;
}

/**
 * Coalesce overlapping status checks onto one sequential walk so StrictMode
 * remounts and extra renderer windows cannot stack protected-location prompts.
 */
export function createSerializedMacOsPermissionProbe(
  probe: () => Promise<MacOsPermissionsStatus>,
): () => Promise<MacOsPermissionsStatus> {
  let inFlight: Promise<MacOsPermissionsStatus> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = probe().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

export function shouldProbeMacOsPermissionsBeforeBackend({
  platform = process.platform,
  runtimeFlavor,
}: {
  platform?: NodeJS.Platform;
  runtimeFlavor: string;
}): boolean {
  // Isolated Electron agent tests must not hang on interactive TCC dialogs.
  return platform === "darwin" && runtimeFlavor !== "agent-test";
}
