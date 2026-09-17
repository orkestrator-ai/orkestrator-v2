import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_CONNECTION_ID,
  parseStoredDesktopConnections,
} from "@orkestrator/protocol/connections";
import type {
  MacOsMissingPermission,
  MacOsPermissionId,
  MacOsPermissionsStatus,
  MacOsPrivacySettingsPane,
} from "@orkestrator/protocol/macos-permissions";

const FULL_DISK_ACCESS_PROBE_PATH = "/Library/Application Support/com.apple.TCC";
const DEFAULT_PHOTOS_LIBRARY = ["Pictures", "Photos Library.photoslibrary"] as const;
const DEFAULT_MUSIC_LIBRARY = ["Music", "Music", "Music Library.musiclibrary"] as const;

type PermissionProbe = MacOsMissingPermission & { path: string };

export type MacOsPermissionsProbeOptions = {
  platform?: NodeJS.Platform;
  runtimeFlavor?: string;
  homeDirectory: string;
  readDirectory?: (directory: string) => Promise<void>;
  listDirectory?: (directory: string) => Promise<string[]>;
};

function folderProbe(id: MacOsPermissionId, label: string, pathValue: string): PermissionProbe {
  return {
    id,
    label,
    settingsPane: "files-and-folders",
    required: true,
    path: pathValue,
  };
}

function staticPermissionProbes(homeDirectory: string): PermissionProbe[] {
  return [
    {
      id: "full-disk-access",
      label: "Full Disk Access",
      settingsPane: "full-disk-access",
      required: false,
      path: FULL_DISK_ACCESS_PROBE_PATH,
    },
    folderProbe("desktop", "Desktop folder", path.join(homeDirectory, "Desktop")),
    folderProbe("documents", "Documents folder", path.join(homeDirectory, "Documents")),
    folderProbe("downloads", "Downloads folder", path.join(homeDirectory, "Downloads")),
    folderProbe("music", "Music folder", path.join(homeDirectory, "Music")),
    folderProbe("pictures", "Pictures folder", path.join(homeDirectory, "Pictures")),
    folderProbe("movies", "Movies folder", path.join(homeDirectory, "Movies")),
    folderProbe(
      "icloud-drive",
      "iCloud Drive",
      path.join(homeDirectory, "Library", "Mobile Documents"),
    ),
    folderProbe(
      "cloud-storage",
      "Cloud Storage",
      path.join(homeDirectory, "Library", "CloudStorage"),
    ),
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

export async function listDirectoryNames(directory: string): Promise<string[]> {
  return readdir(directory);
}

async function discoverLibraryPackages(
  parentDirectory: string,
  extension: string,
  listDirectory: (directory: string) => Promise<string[]>,
): Promise<string[]> {
  try {
    const names = await listDirectory(parentDirectory);
    return names
      .filter((name) => name.endsWith(extension))
      .map((name) => path.join(parentDirectory, name));
  } catch {
    return [];
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function recordDeniedAccess(
  directory: string,
  permission: MacOsMissingPermission,
  readDirectory: (directory: string) => Promise<void>,
  missingIds: Set<MacOsPermissionId>,
  missing: MacOsMissingPermission[],
): Promise<void> {
  try {
    await readDirectory(directory);
  } catch (error) {
    if (isPermissionDenied(error) && !missingIds.has(permission.id)) {
      missingIds.add(permission.id);
      missing.push(permission);
    }
  }
}

/**
 * Probe access sequentially so macOS never stacks several privacy prompts at
 * once. Missing standard folders and unrelated I/O failures do not block app
 * startup; only the OS permission-denied errors are actionable here.
 */
export async function probeMacOsPermissions({
  platform = process.platform,
  runtimeFlavor,
  homeDirectory,
  readDirectory = readDirectoryEntries,
  listDirectory = listDirectoryNames,
}: MacOsPermissionsProbeOptions): Promise<MacOsPermissionsStatus> {
  if (runtimeFlavor === "agent-test" || platform !== "darwin") {
    return { supported: false, missing: [] };
  }

  const missing: MacOsMissingPermission[] = [];
  const missingIds = new Set<MacOsPermissionId>();
  for (const probe of staticPermissionProbes(homeDirectory)) {
    const { path: _path, ...permission } = probe;
    await recordDeniedAccess(probe.path, permission, readDirectory, missingIds, missing);
  }

  const photosParent = path.join(homeDirectory, "Pictures");
  const photosCandidates = uniquePaths([
    path.join(homeDirectory, ...DEFAULT_PHOTOS_LIBRARY),
    ...(await discoverLibraryPackages(photosParent, ".photoslibrary", listDirectory)),
  ]);
  for (const candidate of photosCandidates) {
    await recordDeniedAccess(
      candidate,
      {
        id: "photos",
        label: "Photos library",
        settingsPane: "photos",
        required: true,
      },
      readDirectory,
      missingIds,
      missing,
    );
    if (missingIds.has("photos")) break;
  }

  const mediaParent = path.join(homeDirectory, "Music", "Music");
  const mediaCandidates = uniquePaths([
    path.join(homeDirectory, ...DEFAULT_MUSIC_LIBRARY),
    ...(await discoverLibraryPackages(mediaParent, ".musiclibrary", listDirectory)),
  ]);
  for (const candidate of mediaCandidates) {
    await recordDeniedAccess(
      candidate,
      {
        id: "media-library",
        label: "Media Library",
        settingsPane: "media-library",
        required: true,
      },
      readDirectory,
      missingIds,
      missing,
    );
    if (missingIds.has("media-library")) break;
  }

  return { supported: true, missing };
}

export function macOsPrivacySettingsUrl(pane: MacOsPrivacySettingsPane): string {
  const anchors: Record<MacOsPrivacySettingsPane, string> = {
    "full-disk-access": "Privacy_AllFiles",
    "files-and-folders": "Privacy_FilesAndFolders",
    photos: "Privacy_Photos",
    "media-library": "Privacy_Media",
  };
  const anchor = anchors[pane];
  if (!anchor) throw new Error("Expected a macOS privacy settings pane");
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

export function peekPersistedActiveConnectionId(
  dataDir: string,
  readFile: (filePath: string, encoding: BufferEncoding) => string = readFileSync,
): string | null {
  try {
    const raw = JSON.parse(readFile(path.join(dataDir, "config.json"), "utf8")) as {
      desktopConnections?: unknown;
    };
    if (!raw.desktopConnections) return LOCAL_CONNECTION_ID;
    return parseStoredDesktopConnections(raw.desktopConnections).activeConnectionId;
  } catch {
    return null;
  }
}

export function shouldProbeMacOsPermissionsBeforeBackend({
  platform = process.platform,
  runtimeFlavor,
  persistedActiveConnectionId,
}: {
  platform?: NodeJS.Platform;
  runtimeFlavor: string;
  persistedActiveConnectionId?: string | null;
}): boolean {
  // Isolated Electron agent tests must not hang on interactive TCC dialogs.
  // Remote-only launches should not raise local folder prompts either.
  return (
    platform === "darwin" &&
    runtimeFlavor !== "agent-test" &&
    (persistedActiveConnectionId == null || persistedActiveConnectionId === LOCAL_CONNECTION_ID)
  );
}
