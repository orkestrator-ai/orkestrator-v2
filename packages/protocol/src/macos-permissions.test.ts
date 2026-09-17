import { describe, expect, test } from "bun:test";
import { hasBlockingMacOsPermissions, MACOS_PERMISSION_IDS } from "./macos-permissions";

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
      "photos",
      "media-library",
    ]);
  });

  test("treats every missing permission, including Full Disk Access, as startup-blocking", () => {
    const status = {
      supported: true,
      missing: [
        {
          id: "full-disk-access" as const,
          label: "Full Disk Access",
          settingsPane: "full-disk-access" as const,
          required: true,
        },
      ],
    };

    expect(hasBlockingMacOsPermissions(status)).toBe(true);
  });

  test("does not trust a legacy advisory flag on a missing permission", () => {
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

  test("does not block unsupported platforms", () => {
    expect(hasBlockingMacOsPermissions({ supported: false, missing: [] })).toBe(false);
  });
});
