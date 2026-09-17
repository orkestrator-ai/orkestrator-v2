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
      path: FULL_DISK_ACCESS_PROBE_PATH,
    },
    {
      id: "desktop",
      label: "Desktop folder",
      settingsPane: "files-and-folders",
      path: path.join(homeDirectory, "Desktop"),
    },
    {
      id: "documents",
      label: "Documents folder",
      settingsPane: "files-and-folders",
      path: path.join(homeDirectory, "Documents"),
    },
    {
      id: "downloads",
      label: "Downloads folder",
      settingsPane: "files-and-folders",
      path: path.join(homeDirectory, "Downloads"),
    },
    {
      id: "music",
      label: "Music folder",
      settingsPane: "files-and-folders",
      path: path.join(homeDirectory, "Music"),
    },
    {
      id: "pictures",
      label: "Pictures and Photos folder",
      settingsPane: "files-and-folders",
      path: path.join(homeDirectory, "Pictures"),
    },
  ];
}

function isPermissionDenied(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

async function defaultReadDirectory(directory: string): Promise<void> {
  // Reading only the directory entries exercises the same macOS privacy check
  // as a recursive `find` without retaining or exposing any file names.
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
  readDirectory = defaultReadDirectory,
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
