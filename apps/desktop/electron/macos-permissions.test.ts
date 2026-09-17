import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import {
  createSerializedMacOsPermissionProbe,
  macOsPrivacySettingsUrl,
  probeMacOsPermissions,
  readDirectoryEntries,
  shouldProbeMacOsPermissionsBeforeBackend,
} from "./macos-permissions";

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
      ],
    });
    expect(readDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      "/Library/Application Support/com.apple.TCC",
      "/Users/person/Desktop",
      "/Users/person/Documents",
      "/Users/person/Downloads",
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
    expect(readDirectory).toHaveBeenCalledTimes(4);
  });

  test("probes before backend start on macOS desktop builds only", () => {
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
  });
});
