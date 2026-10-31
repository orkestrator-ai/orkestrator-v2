import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultDataDir, isDefaultDataDir } from "./data-dir.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("isDefaultDataDir", () => {
  test("recognises the platform default, also through a symlink, and nothing else", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "orkestrator-data-dir-"));
    directories.push(home);
    const main = defaultDataDir("linux", {}, home);
    await mkdir(main, { recursive: true });
    const link = path.join(home, "linked");
    await symlink(main, link);
    const other = path.join(home, "second");
    await mkdir(other);

    expect(isDefaultDataDir(main, "linux", {}, home)).toBe(true);
    expect(isDefaultDataDir(`${main}/`, "linux", {}, home)).toBe(true);
    expect(isDefaultDataDir(link, "linux", {}, home)).toBe(true);
    expect(isDefaultDataDir(other, "linux", {}, home)).toBe(false);
    // `mise run dev` keeps its data next to the default under another name.
    expect(isDefaultDataDir(`${main}-dev`, "linux", {}, home)).toBe(false);
    // Not created yet: compared by resolved path.
    expect(isDefaultDataDir(path.join(home, "missing"), "linux", {}, home)).toBe(false);
    expect(
      isDefaultDataDir(
        path.join(home, "xdg", "orkestrator-v2"),
        "linux",
        { XDG_CONFIG_HOME: path.join(home, "xdg") },
        home,
      ),
    ).toBe(true);
  });
});
