export const MACOS_PERMISSION_IDS = [
  "full-disk-access",
  "desktop",
  "documents",
  "downloads",
] as const;

export type MacOsPermissionId = (typeof MACOS_PERMISSION_IDS)[number];

export type MacOsPrivacySettingsPane = "full-disk-access" | "files-and-folders";

export type MacOsMissingPermission = {
  id: MacOsPermissionId;
  label: string;
  settingsPane: MacOsPrivacySettingsPane;
  /**
   * Required permissions can hold the advisory startup screen until granted or
   * dismissed. Full Disk Access is recommended only: macOS never prompts for it
   * and the rest of the product can run without it.
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
  return status.supported && status.missing.some((permission) => permission.required);
}

export function hasRecommendedMacOsPermissions(
  status: Pick<MacOsPermissionsStatus, "supported" | "missing">,
): boolean {
  return status.supported && status.missing.some((permission) => !permission.required);
}
