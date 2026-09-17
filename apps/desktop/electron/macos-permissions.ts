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
      required: false,
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
  ];
}

function isPermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * A shallow listing exercises the Files and Folders TCC check for this
 * directory. It does not authorize Photos, Media Library, or other nested
 * privacy services, so those paths are not treated as granted permissions.
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
  const anchor = pane === "full-disk-access" ? "Privacy_AllFiles" : "Privacy_FilesAndFolders";
  return `x-apple.systempreferences:com.apple.preference.security?${anchor}`;
}

/**
 * Coalesce overlapping status checks onto one sequential walk so StrictMode
 * remounts and extra renderer windows cannot stack Desktop/Documents/Downloads
 * prompts.
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
