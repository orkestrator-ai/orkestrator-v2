import { describe, expect, test } from "bun:test";
import {
  hasBlockingMacOsPermissions,
  isMacOsPrivacySettingsPane,
  MACOS_PERMISSION_IDS,
  MACOS_PRIVACY_SETTINGS_PANES,
} from "./macos-permissions";

describe("macOS permission status helpers", () => {
  test("covers every protected location an agent can encounter in a home or root search", () => {
    expect(MACOS_PERMISSION_IDS).toEqual([
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
    ]);
  });

  test("exposes every System Settings pane the desktop IPC may open", () => {
    expect(MACOS_PRIVACY_SETTINGS_PANES).toEqual([
      "full-disk-access",
      "files-and-folders",
      "photos",
      "media-library",
    ]);
    expect(isMacOsPrivacySettingsPane("photos")).toBe(true);
    expect(isMacOsPrivacySettingsPane("media-library")).toBe(true);
    expect(isMacOsPrivacySettingsPane("Privacy_Camera")).toBe(false);
  });

  test("does not treat advisory Full Disk Access as startup-blocking", () => {
    const status = {
      supported: true,
      missing: [
        {
          id: "full-disk-access" as const,
          label: "Full Disk Access",
          settingsPane: "full-disk-access" as const,
          required: false,
        },
      ],
    };

    expect(hasBlockingMacOsPermissions(status)).toBe(false);
  });

  test("does not trust a legacy advisory flag on a missing folder permission", () => {
    const status = {
      supported: true,
      missing: [
        {
          id: "documents" as const,
          label: "Documents folder",
          settingsPane: "files-and-folders" as const,
          required: false,
        },
      ],
    };

    expect(hasBlockingMacOsPermissions(status)).toBe(true);
  });

  test("still blocks when folder grants are missing alongside Full Disk Access", () => {
    const status = {
      supported: true,
      missing: [
        {
          id: "full-disk-access" as const,
          label: "Full Disk Access",
          settingsPane: "full-disk-access" as const,
          required: false,
        },
        {
          id: "documents" as const,
          label: "Documents folder",
          settingsPane: "files-and-folders" as const,
          required: true,
        },
      ],
    };

    expect(hasBlockingMacOsPermissions(status)).toBe(true);
  });

  test("does not block unsupported platforms", () => {
    expect(hasBlockingMacOsPermissions({ supported: false, missing: [] })).toBe(false);
  });
});
