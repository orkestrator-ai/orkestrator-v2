export const MACOS_PERMISSION_IDS = [
  "full-disk-access",
  "desktop",
  "documents",
  "downloads",
  "music",
  "pictures",
  "movies",
  "icloud-drive",
  "cloud-storage",
  "photos",
  "media-library",
] as const;

export type MacOsPermissionId = (typeof MACOS_PERMISSION_IDS)[number];

export const MACOS_PRIVACY_SETTINGS_PANES = [
  "full-disk-access",
  "files-and-folders",
  "photos",
  "media-library",
] as const;

export type MacOsPrivacySettingsPane = (typeof MACOS_PRIVACY_SETTINGS_PANES)[number];

export function isMacOsPrivacySettingsPane(value: unknown): value is MacOsPrivacySettingsPane {
  return (
    typeof value === "string" && (MACOS_PRIVACY_SETTINGS_PANES as readonly string[]).includes(value)
  );
}

export type MacOsMissingPermission = {
  id: MacOsPermissionId;
  label: string;
  settingsPane: MacOsPrivacySettingsPane;
  /**
   * Folder, Photos, and Media grants that macOS can prompt for. Full Disk
   * Access is reported but never required: it has no TCC prompt and must not
   * lock the user out of the app.
   */
  required: boolean;
};

export type MacOsPermissionsStatus = {
  /** False outside macOS, where this startup gate does not apply. */
  supported: boolean;
  missing: MacOsMissingPermission[];
  /**
   * Present when the desktop permissions API was available but the probe failed.
   * Distinct from `supported: false`, which means the gate does not apply.
   */
  error?: string;
};

export function hasBlockingMacOsPermissions(
  status: Pick<MacOsPermissionsStatus, "supported" | "missing">,
): boolean {
  return (
    status.supported && status.missing.some((permission) => permission.id !== "full-disk-access")
  );
}
