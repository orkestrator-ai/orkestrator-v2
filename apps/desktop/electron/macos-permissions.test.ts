import { describe, expect, mock, test } from "bun:test";
import { macOsPrivacySettingsUrl, probeMacOsPermissions } from "./macos-permissions";

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("macOS permission probing", () => {
  test("is disabled without touching the filesystem on other platforms", async () => {
    const readDirectory = mock(async () => undefined);

    await expect(
      probeMacOsPermissions({ platform: "linux", homeDirectory: "/home/person", readDirectory }),
    ).resolves.toEqual({ supported: false, missing: [] });
    expect(readDirectory).not.toHaveBeenCalled();
  });

  test("reports each protected location denied by macOS", async () => {
    const readDirectory = mock(async (directory: string) => {
      if (directory === "/Users/person/Documents") throw ioError("EACCES");
      if (
        directory === "/Library/Application Support/com.apple.TCC" ||
        directory === "/Users/person/Pictures"
      ) {
        throw ioError("EPERM");
      }
    });

    await expect(
      probeMacOsPermissions({
        platform: "darwin",
        homeDirectory: "/Users/person",
        readDirectory,
      }),
    ).resolves.toEqual({
      supported: true,
      missing: [
        {
          id: "full-disk-access",
          label: "Full Disk Access",
          settingsPane: "full-disk-access",
        },
        {
          id: "documents",
          label: "Documents folder",
          settingsPane: "files-and-folders",
        },
        {
          id: "pictures",
          label: "Pictures and Photos folder",
          settingsPane: "files-and-folders",
        },
      ],
    });
    expect(readDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      "/Library/Application Support/com.apple.TCC",
      "/Users/person/Desktop",
      "/Users/person/Documents",
      "/Users/person/Downloads",
      "/Users/person/Music",
      "/Users/person/Pictures",
    ]);
  });

  test("does not misreport missing folders or unrelated I/O failures as privacy denials", async () => {
    const readDirectory = mock(async (directory: string) => {
      if (directory.endsWith("/Desktop")) throw ioError("ENOENT");
      if (directory.endsWith("/Downloads")) throw ioError("EIO");
    });

    await expect(
      probeMacOsPermissions({
        platform: "darwin",
        homeDirectory: "/Users/person",
        readDirectory,
      }),
    ).resolves.toEqual({ supported: true, missing: [] });
  });

  test("uses the dedicated macOS privacy settings panes", () => {
    expect(macOsPrivacySettingsUrl("full-disk-access")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
    );
    expect(macOsPrivacySettingsUrl("files-and-folders")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
    );
  });
});
