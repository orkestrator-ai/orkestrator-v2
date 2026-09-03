import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertLinuxInstallerPlatform,
  createDesktopEntry,
  findLinuxBundle,
  installLinuxBundle,
  resolveLinuxInstallTargets,
  type LinuxInstallTargets,
} from "../../scripts/install-packaged-app-linux";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Linux packaged app installer", () => {
  test("rejects non-Linux hosts before installation", () => {
    expect(() => assertLinuxInstallerPlatform("darwin")).toThrow(
      "The Linux package installer must be run on Linux.",
    );
    expect(() => assertLinuxInstallerPlatform("linux")).not.toThrow();
  });

  test("uses per-user XDG locations without relying on a distro package manager", () => {
    expect(
      resolveLinuxInstallTargets({
        HOME: "/home/ada",
        XDG_DATA_HOME: "/home/ada/custom-data",
      }),
    ).toEqual({
      applicationDir: "/home/ada/custom-data/orkestrator-v2",
      launcherPath: "/home/ada/.local/bin/orkestrator-v2",
      desktopEntryPath: "/home/ada/custom-data/applications/orkestrator-v2.desktop",
      iconPath: "/home/ada/custom-data/icons/hicolor/512x512/apps/orkestrator-v2.png",
    });

    expect(
      resolveLinuxInstallTargets({ HOME: "/home/ada", XDG_DATA_HOME: "relative/data" })
        .applicationDir,
    ).toBe("/home/ada/.local/share/orkestrator-v2");
  });

  test("finds and installs an unpacked Linux bundle with desktop integration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-linux-install-"));
    temporaryRoots.push(root);

    const releaseDirectory = path.join(root, "release");
    const source = path.join(releaseDirectory, "linux-arm64-unpacked");
    const sourceExecutable = path.join(source, "orkestrator-v2");
    const sourceResource = path.join(source, "resources", "payload.txt");
    const sourceResourceLink = path.join(source, "resources", "payload-link.txt");
    const iconSource = path.join(root, "icon.png");
    const targets: LinuxInstallTargets = {
      applicationDir: path.join(root, "data", "orkestrator-v2"),
      launcherPath: path.join(root, "bin", "orkestrator-v2"),
      desktopEntryPath: path.join(root, "data", "applications", "orkestrator-v2.desktop"),
      iconPath: path.join(root, "data", "icons", "orkestrator-v2.png"),
    };

    await mkdir(path.dirname(sourceResource), { recursive: true });
    await writeFile(sourceExecutable, "electron binary");
    await writeFile(sourceResource, "resource data");
    await symlink("payload.txt", sourceResourceLink);
    await writeFile(iconSource, "png data");

    expect(await findLinuxBundle(releaseDirectory, "arm64")).toBe(source);

    await installLinuxBundle(source, iconSource, targets);

    const installedExecutable = path.join(targets.applicationDir, "orkestrator-v2");
    expect(await readFile(installedExecutable, "utf8")).toBe("electron binary");
    expect((await stat(installedExecutable)).mode & 0o111).not.toBe(0);
    expect((await lstat(targets.launcherPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(targets.launcherPath)).toBe(installedExecutable);
    expect(await readlink(path.join(targets.applicationDir, "resources", "payload-link.txt"))).toBe(
      "payload.txt",
    );
    expect(await readFile(targets.iconPath, "utf8")).toBe("png data");
    expect(await readFile(targets.desktopEntryPath, "utf8")).toBe(
      createDesktopEntry(targets.launcherPath),
    );

    await writeFile(path.join(targets.applicationDir, "stale.txt"), "stale data");
    await writeFile(sourceExecutable, "replacement binary");
    await installLinuxBundle(source, iconSource, targets);

    expect(await readFile(installedExecutable, "utf8")).toBe("replacement binary");
    await expect(stat(path.join(targets.applicationDir, "stale.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("selects only the unpacked bundle matching the requested architecture", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-linux-architecture-"));
    temporaryRoots.push(root);
    const releaseDirectory = path.join(root, "release");
    const x64Bundle = path.join(releaseDirectory, "linux-unpacked");
    const arm64Bundle = path.join(releaseDirectory, "linux-arm64-unpacked");

    await mkdir(x64Bundle, { recursive: true });
    await mkdir(arm64Bundle, { recursive: true });
    await writeFile(path.join(x64Bundle, "orkestrator-v2"), "x64 binary");
    await writeFile(path.join(arm64Bundle, "orkestrator-v2"), "arm64 binary");

    expect(await findLinuxBundle(releaseDirectory, "x64")).toBe(x64Bundle);
    expect(await findLinuxBundle(releaseDirectory, "arm64")).toBe(arm64Bundle);
  });

  test("returns null when the requested architecture has no complete bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-linux-missing-"));
    temporaryRoots.push(root);
    const missingReleaseDirectory = path.join(root, "missing-release");
    const releaseDirectory = path.join(root, "release");
    const incompleteBundle = path.join(releaseDirectory, "linux-unpacked");

    expect(await findLinuxBundle(missingReleaseDirectory, "x64")).toBeNull();
    await mkdir(releaseDirectory, { recursive: true });
    expect(await findLinuxBundle(releaseDirectory, "x64")).toBeNull();
    await mkdir(incompleteBundle);
    expect(await findLinuxBundle(releaseDirectory, "x64")).toBeNull();
  });

  test("rejects a source without the packaged executable using an actionable error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-linux-invalid-"));
    temporaryRoots.push(root);
    const source = path.join(root, "linux-unpacked");
    const iconSource = path.join(root, "icon.png");
    const targets = targetsUnder(root);

    await mkdir(source);
    await writeFile(iconSource, "png data");

    await expect(installLinuxBundle(source, iconSource, targets)).rejects.toThrow(
      `${source} is not an Orkestrator Linux bundle`,
    );
  });

  test("preserves an existing installation when staging the replacement fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-linux-rollback-"));
    temporaryRoots.push(root);
    const source = path.join(root, "release", "linux-unpacked");
    const targets = targetsUnder(root);
    const installedExecutable = path.join(targets.applicationDir, "orkestrator-v2");

    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "orkestrator-v2"), "replacement binary");
    await mkdir(targets.applicationDir, { recursive: true });
    await writeFile(installedExecutable, "working binary");
    await mkdir(path.dirname(targets.launcherPath), { recursive: true });
    await symlink(installedExecutable, targets.launcherPath);

    await expect(
      installLinuxBundle(source, path.join(root, "missing-icon.png"), targets),
    ).rejects.toThrow();

    expect(await readFile(installedExecutable, "utf8")).toBe("working binary");
    expect(await readlink(targets.launcherPath)).toBe(installedExecutable);
    for (const directory of [
      path.dirname(targets.applicationDir),
      path.dirname(targets.launcherPath),
      path.dirname(targets.iconPath),
    ]) {
      expect((await readdir(directory)).some((entry) => entry.includes(".install-"))).toBe(false);
    }
  });

  test("restores the previous installation when promotion fails after it starts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orkestrator-linux-promotion-"));
    temporaryRoots.push(root);
    const source = path.join(root, "release", "linux-unpacked");
    const iconSource = path.join(root, "icon.png");
    const applicationDir = path.join(root, "data", "orkestrator-v2");
    const installedExecutable = path.join(applicationDir, "orkestrator-v2");
    const launcherPath = path.join(applicationDir, "launcher");
    const targets: LinuxInstallTargets = {
      applicationDir,
      launcherPath,
      desktopEntryPath: path.join(root, "desktop", "orkestrator-v2.desktop"),
      iconPath: path.join(root, "icons", "orkestrator-v2.png"),
    };

    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "orkestrator-v2"), "replacement binary");
    await writeFile(iconSource, "replacement icon");
    await mkdir(applicationDir, { recursive: true });
    await writeFile(installedExecutable, "working binary");
    await symlink(installedExecutable, launcherPath);

    // The deliberately overlapping launcher target moves with the previous app
    // during the first promotion, forcing the next promotion to fail.
    await expect(installLinuxBundle(source, iconSource, targets)).rejects.toThrow();

    expect(await readFile(installedExecutable, "utf8")).toBe("working binary");
    expect(await readlink(launcherPath)).toBe(installedExecutable);
  });

  test("quotes spaces and double-escapes reserved desktop Exec characters", () => {
    expect(createDesktopEntry("/home/Ada Lovelace/.local/bin/orkestrator-v2")).toContain(
      'Exec="/home/Ada Lovelace/.local/bin/orkestrator-v2"',
    );
    expect(createDesktopEntry('/tmp/a"b')).toContain('Exec="/tmp/a\\\\"b"');
    expect(createDesktopEntry("/tmp/$cash")).toContain('Exec="/tmp/\\\\$cash"');
    expect(createDesktopEntry("/tmp/a`b")).toContain('Exec="/tmp/a\\\\`b"');
    expect(createDesktopEntry(String.raw`/tmp/a\b`)).toContain('Exec="/tmp/a\\\\\\\\b"');
  });

  test("uses one application id for the desktop file, icon, and window class", () => {
    const entry = createDesktopEntry("/home/ada/.local/bin/orkestrator-v2");

    expect(entry).toContain("Icon=orkestrator-v2");
    expect(entry).toContain("StartupWMClass=orkestrator-v2");
  });
});

function targetsUnder(root: string): LinuxInstallTargets {
  return {
    applicationDir: path.join(root, "data", "orkestrator-v2"),
    launcherPath: path.join(root, "bin", "orkestrator-v2"),
    desktopEntryPath: path.join(root, "data", "applications", "orkestrator-v2.desktop"),
    iconPath: path.join(root, "data", "icons", "orkestrator-v2.png"),
  };
}
