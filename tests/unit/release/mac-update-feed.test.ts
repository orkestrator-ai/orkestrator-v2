import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { assertMacUpdateFeed, prepareMacUpdateFeeds } from "../../../scripts/mac-update-feed";
import { createReleaseConfig } from "../../../electron-builder.release.config";

const requireBuilder = createRequire(import.meta.resolve("electron-builder"));
const { writeUpdateInfoFiles } = requireBuilder("app-builder-lib/out/publish/updateInfoBuilder");
const requireDesktop = createRequire(
  new URL("../../../apps/desktop/package.json", import.meta.url),
);
const { AppUpdater } = requireDesktop("electron-updater/out/AppUpdater");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mac-update-feed-"));
  directories.push(dir);
  return dir;
}

describe("macOS update feed compatibility", () => {
  test("generated feed retains artifact integrity and gates the existing updater on Darwin 21 and 22", async () => {
    const dir = directory();
    const file = path.join(dir, "latest-mac.yml");
    const config = createReleaseConfig({ APPLE_KEYCHAIN_PROFILE: "test-only" });
    expect(config.mac?.minimumSystemVersion).toBe("13.0");
    const publish = config.publish;
    if (!Array.isArray(publish)) throw new Error("Release config must publish a provider list");
    const info = {
      version: "2.19.15",
      files: [{ url: "app.zip", sha512: "fixture-hash", size: 123 }],
      path: "app.zip",
      sha512: "fixture-hash",
      releaseDate: "2026-10-13T00:00:00.000Z",
    };
    // Use builder's real YAML writer without signing or uploading a release.
    await writeUpdateInfoFiles(
      [{ file, info, publishConfiguration: publish[0], packager: {}, arch: 1 }],
      { emitArtifactCreated: async () => undefined },
    );
    expect(() => assertMacUpdateFeed(readFileSync(file, "utf8"))).toThrow("Darwin 22");
    expect(prepareMacUpdateFeeds(dir)).toEqual([file]);
    const contents = readFileSync(file, "utf8");
    expect(() => assertMacUpdateFeed(contents)).not.toThrow();
    const feed = Bun.YAML.parse(contents);
    expect(feed).toEqual({ ...info, minimumSystemVersion: "22.0.0" });

    const updater = new AppUpdater(null, { version: "2.19.14" });
    updater.logger = null;
    const release = spyOn(os, "release");
    try {
      release.mockReturnValue("21.6.0");
      expect(await updater.isUpdateSupported(feed)).toBe(false);
      expect(await updater.isUpdateAvailable(feed)).toBe(false);
      expect(updater.currentVersion.version).toBe("2.19.14");
      release.mockReturnValue("22.0.0");
      expect(await updater.isUpdateSupported(feed)).toBe(true);
      expect(await updater.isUpdateAvailable(feed)).toBe(true);
    } finally {
      release.mockRestore();
    }
  });

  test("patches prerelease channels idempotently without changing Linux feeds", () => {
    const dir = directory();
    for (const name of ["latest-mac.yml", "beta-mac.yml", "latest-linux.yml"]) {
      writeFileSync(path.join(dir, name), "version: 2.19.15\nminimumSystemVersion: '21.0.0'\n");
    }
    expect(prepareMacUpdateFeeds(dir)).toHaveLength(2);
    expect(prepareMacUpdateFeeds(dir)).toHaveLength(2);
    for (const name of ["latest-mac.yml", "beta-mac.yml"]) {
      expect(() => assertMacUpdateFeed(readFileSync(path.join(dir, name), "utf8"))).not.toThrow();
    }
    expect(readFileSync(path.join(dir, "latest-linux.yml"), "utf8")).toContain("21.0.0");
  });

  test("refuses missing or invalid feeds", () => {
    const dir = directory();
    expect(() => prepareMacUpdateFeeds(dir)).toThrow("No generated");
    writeFileSync(path.join(dir, "latest-mac.yml"), "[]");
    expect(() => prepareMacUpdateFeeds(dir)).toThrow("Invalid");
  });
});
