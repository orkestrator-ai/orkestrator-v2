export const MACOS_PERMISSION_IDS = [
  "full-disk-access",
  "desktop",
  "documents",
  "downloads",
  "music",
  "pictures",
  "movies",
  "photos",
  "media-library",
] as const;

export type MacOsPermissionId = (typeof MACOS_PERMISSION_IDS)[number];

export type MacOsPrivacySettingsPane =
  | "full-disk-access"
  | "files-and-folders"
  | "photos"
  | "media-library";

export type MacOsMissingPermission = {
  id: MacOsPermissionId;
  label: string;
  settingsPane: MacOsPrivacySettingsPane;
  /** Every permission reported by the startup probe blocks local agent work. */
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
  return status.supported && status.missing.length > 0;
}
