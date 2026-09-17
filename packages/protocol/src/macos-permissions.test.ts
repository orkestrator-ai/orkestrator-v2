import { describe, expect, test } from "bun:test";
import { hasBlockingMacOsPermissions, hasRecommendedMacOsPermissions } from "./macos-permissions";

describe("macOS permission status helpers", () => {
  test("treats Full Disk Access as recommended rather than startup-blocking", () => {
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
    expect(hasRecommendedMacOsPermissions(status)).toBe(true);
  });

  test("blocks startup only when a required Files and Folders grant is missing", () => {
    const status = {
      supported: true,
      missing: [
        {
          id: "documents" as const,
          label: "Documents folder",
          settingsPane: "files-and-folders" as const,
          required: true,
        },
      ],
    };

    expect(hasBlockingMacOsPermissions(status)).toBe(true);
    expect(hasRecommendedMacOsPermissions(status)).toBe(false);
  });

  test("does not block unsupported platforms", () => {
    expect(hasBlockingMacOsPermissions({ supported: false, missing: [] })).toBe(false);
    expect(hasRecommendedMacOsPermissions({ supported: false, missing: [] })).toBe(false);
  });
});
