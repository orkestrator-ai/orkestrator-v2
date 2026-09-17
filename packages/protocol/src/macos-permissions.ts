export const MACOS_PERMISSION_IDS = [
  "full-disk-access",
  "desktop",
  "documents",
  "downloads",
  "music",
  "pictures",
] as const;

export type MacOsPermissionId = (typeof MACOS_PERMISSION_IDS)[number];

export type MacOsPrivacySettingsPane = "full-disk-access" | "files-and-folders";

export type MacOsMissingPermission = {
  id: MacOsPermissionId;
  label: string;
  settingsPane: MacOsPrivacySettingsPane;
};

export type MacOsPermissionsStatus = {
  /** False outside macOS, where this startup gate does not apply. */
  supported: boolean;
  missing: MacOsMissingPermission[];
};
