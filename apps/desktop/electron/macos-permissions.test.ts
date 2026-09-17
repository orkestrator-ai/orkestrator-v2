import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import {
  createSerializedMacOsPermissionProbe,
  macOsPrivacySettingsUrl,
  peekPersistedActiveConnectionId,
  probeMacOsPermissions,
  readDirectoryEntries,
  shouldProbeMacOsPermissionsBeforeBackend,
} from "./macos-permissions";

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

const STATIC_PROBE_PATHS = [
  "/Library/Application Support/com.apple.TCC",
  "/Users/person/Desktop",
  "/Users/person/Documents",
  "/Users/person/Downloads",
  "/Users/person/Music",
  "/Users/person/Pictures",
  "/Users/person/Movies",
  "/Users/person/Library/Mobile Documents",
  "/Users/person/Library/CloudStorage",
  "/Users/person/Pictures/Photos Library.photoslibrary",
  "/Users/person/Music/Music/Music Library.musiclibrary",
];

describe("macOS permission probing", () => {
  test("is disabled without touching the filesystem on other platforms", async () => {
    const readDirectory = mock(async () => undefined);

    await expect(
      probeMacOsPermissions({ platform: "linux", homeDirectory: "/home/person", readDirectory }),
    ).resolves.toEqual({ supported: false, missing: [] });
    expect(readDirectory).not.toHaveBeenCalled();
  });

  test("never walks protected directories for the agent-test flavor", async () => {
    const readDirectory = mock(async () => {
      throw new Error("agent-test must not probe the host home");
    });
    const listDirectory = mock(async () => {
      throw new Error("agent-test must not list the host home");
    });

    await expect(
      probeMacOsPermissions({
        platform: "darwin",
        runtimeFlavor: "agent-test",
        homeDirectory: "/Users/developer",
        readDirectory,
        listDirectory,
      }),
    ).resolves.toEqual({ supported: false, missing: [] });
    expect(readDirectory).not.toHaveBeenCalled();
    expect(listDirectory).not.toHaveBeenCalled();
  });

  test("reports each protected location denied by macOS", async () => {
    const readDirectory = mock(async (directory: string) => {
      if (directory === "/Users/person/Documents") throw ioError("EACCES");
      if (directory === "/Users/person/Music") throw ioError("EPERM");
      if (directory === "/Users/person/Pictures") throw ioError("EACCES");
      if (directory === "/Users/person/Movies") throw ioError("EPERM");
      if (directory === "/Users/person/Library/Mobile Documents") throw ioError("EACCES");
      if (directory === "/Users/person/Library/CloudStorage") throw ioError("EPERM");
      if (directory === "/Users/person/Pictures/Photos Library.photoslibrary") {
        throw ioError("EACCES");
      }
      if (directory === "/Users/person/Music/Music/Music Library.musiclibrary") {
        throw ioError("EPERM");
      }
      if (directory === "/Library/Application Support/com.apple.TCC") {
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
          required: false,
        },
        {
          id: "documents",
          label: "Documents folder",
          settingsPane: "files-and-folders",
          required: true,
        },
        {
          id: "music",
          label: "Music folder",
          settingsPane: "files-and-folders",
          required: true,
        },
        {
          id: "pictures",
          label: "Pictures folder",
          settingsPane: "files-and-folders",
          required: true,
        },
        {
          id: "movies",
          label: "Movies folder",
          settingsPane: "files-and-folders",
          required: true,
        },
        {
          id: "icloud-drive",
          label: "iCloud Drive",
          settingsPane: "files-and-folders",
          required: true,
        },
        {
          id: "cloud-storage",
          label: "Cloud Storage",
          settingsPane: "files-and-folders",
          required: true,
        },
        {
          id: "photos",
          label: "Photos library",
          settingsPane: "photos",
          required: true,
        },
        {
          id: "media-library",
          label: "Media Library",
          settingsPane: "media-library",
          required: true,
        },
      ],
    });
    expect(readDirectory.mock.calls.map(([directory]) => directory)).toEqual(STATIC_PROBE_PATHS);
  });

  test("reports a renamed Photos library and iCloud Drive denials", async () => {
    const readDirectory = mock(async (directory: string) => {
      if (directory === "/Users/person/Library/Mobile Documents") throw ioError("EACCES");
      if (directory === "/Users/person/Pictures/Family.photoslibrary") throw ioError("EPERM");
    });
    const listDirectory = mock(async (directory: string) => {
      if (directory === "/Users/person/Pictures") {
        return ["Family.photoslibrary", "Vacation.jpg"];
      }
      if (directory === "/Users/person/Music/Music") {
        return ["Music Library.musiclibrary"];
      }
      return [];
    });

    await expect(
      probeMacOsPermissions({
        platform: "darwin",
        homeDirectory: "/Users/person",
        readDirectory,
        listDirectory,
      }),
    ).resolves.toEqual({
      supported: true,
      missing: [
        {
          id: "icloud-drive",
          label: "iCloud Drive",
          settingsPane: "files-and-folders",
          required: true,
        },
        {
          id: "photos",
          label: "Photos library",
          settingsPane: "photos",
          required: true,
        },
      ],
    });
    expect(readDirectory.mock.calls.map(([directory]) => directory)).toContain(
      "/Users/person/Pictures/Family.photoslibrary",
    );
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
    expect(macOsPrivacySettingsUrl("photos")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos",
    );
    expect(macOsPrivacySettingsUrl("media-library")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Media",
    );
  });

  test("exercises the live directory reader against a writable folder", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ork-macos-permissions-"));
    try {
      await writeFile(path.join(directory, "note.txt"), "ok");
      await expect(readDirectoryEntries(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("coalesces overlapping probes onto one sequential walk", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const readDirectory = mock(async (directory: string) => {
      started.push(directory);
      if (started.length === 1) await firstRead;
    });
    const getMacOsPermissions = createSerializedMacOsPermissionProbe(() =>
      probeMacOsPermissions({
        platform: "darwin",
        homeDirectory: "/Users/person",
        readDirectory,
      }),
    );

    const first = getMacOsPermissions();
    const second = getMacOsPermissions();
    await Promise.resolve();
    expect(started).toEqual(["/Library/Application Support/com.apple.TCC"]);

    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { supported: true, missing: [] },
      { supported: true, missing: [] },
    ]);
    expect(readDirectory).toHaveBeenCalledTimes(STATIC_PROBE_PATHS.length);
  });

  test("probes before backend start on local macOS desktop builds only", () => {
    expect(
      shouldProbeMacOsPermissionsBeforeBackend({
        platform: "darwin",
        runtimeFlavor: "production",
      }),
    ).toBe(true);
    expect(
      shouldProbeMacOsPermissionsBeforeBackend({
        platform: "darwin",
        runtimeFlavor: "development",
      }),
    ).toBe(true);
    expect(
      shouldProbeMacOsPermissionsBeforeBackend({
        platform: "darwin",
        runtimeFlavor: "agent-test",
      }),
    ).toBe(false);
    expect(
      shouldProbeMacOsPermissionsBeforeBackend({
        platform: "linux",
        runtimeFlavor: "production",
      }),
    ).toBe(false);
    expect(
      shouldProbeMacOsPermissionsBeforeBackend({
        platform: "darwin",
        runtimeFlavor: "production",
        persistedActiveConnectionId: "remote-1",
      }),
    ).toBe(false);
    expect(
      shouldProbeMacOsPermissionsBeforeBackend({
        platform: "darwin",
        runtimeFlavor: "production",
        persistedActiveConnectionId: "local",
      }),
    ).toBe(true);
  });

  test("reads the persisted desktop connection from config.json", () => {
    const files = new Map<string, string>([
      [
        path.join("/data", "config.json"),
        JSON.stringify({
          desktopConnections: {
            activeConnectionId: "remote-1",
            connections: [
              {
                id: "remote-1",
                name: "Remote",
                address: "https://gateway.example",
                encryptedToken: "token",
                lastConnectedAt: "2026-09-17T00:00:00.000Z",
              },
            ],
          },
        }),
      ],
    ]);

    expect(
      peekPersistedActiveConnectionId("/data", (filePath) => {
        const contents = files.get(filePath);
        if (!contents) throw new Error(`missing ${filePath}`);
        return contents;
      }),
    ).toBe("remote-1");
    expect(
      peekPersistedActiveConnectionId("/missing", () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    ).toBeNull();
  });
});
