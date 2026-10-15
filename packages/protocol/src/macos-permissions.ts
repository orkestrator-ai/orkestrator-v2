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

export type MacOsPermissionDescriptor = {
  label: string;
  settingsPane: MacOsPrivacySettingsPane;
  /** See {@link MacOsMissingPermission.required}. */
  required: boolean;
  /**
   * The Info.plist usage-description key macOS shows in this permission's
   * prompt (`build.mac.extendInfo` in the root package.json), when it has one.
   */
  infoPlistKey: string | null;
};

/**
 * Every permission the startup probe checks. The desktop probe and the release
 * requirements manifest both read it, so a new permission reaches the update
 * consent gate in the same change that starts probing it.
 */
export const MACOS_PERMISSION_CATALOGUE: Record<MacOsPermissionId, MacOsPermissionDescriptor> = {
  "full-disk-access": {
    label: "Full Disk Access",
    settingsPane: "full-disk-access",
    required: false,
    infoPlistKey: null,
  },
  desktop: {
    label: "Desktop folder",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: "NSDesktopFolderUsageDescription",
  },
  documents: {
    label: "Documents folder",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: "NSDocumentsFolderUsageDescription",
  },
  downloads: {
    label: "Downloads folder",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: "NSDownloadsFolderUsageDescription",
  },
  music: {
    label: "Music folder",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: "NSAppleMusicUsageDescription",
  },
  pictures: {
    label: "Pictures folder",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: "NSPhotoLibraryUsageDescription",
  },
  movies: {
    label: "Movies folder",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: "NSPhotoLibraryUsageDescription",
  },
  "icloud-drive": {
    label: "iCloud Drive",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: null,
  },
  "cloud-storage": {
    label: "Cloud Storage",
    settingsPane: "files-and-folders",
    required: true,
    infoPlistKey: null,
  },
  photos: {
    label: "Photos library",
    settingsPane: "photos",
    required: true,
    infoPlistKey: "NSPhotoLibraryUsageDescription",
  },
  "media-library": {
    label: "Media Library",
    settingsPane: "media-library",
    required: true,
    infoPlistKey: "NSAppleMusicUsageDescription",
  },
};

export function describeMacOsPermission(id: MacOsPermissionId): MacOsMissingPermission {
  const { label, settingsPane, required } = MACOS_PERMISSION_CATALOGUE[id];
  return { id, label, settingsPane, required };
}
