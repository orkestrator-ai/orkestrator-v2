import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listHostDirectory, registerHostFileCommands } from "./commands-host-files.js";
import type { CommandHandler } from "./commands-context.js";

describe("list_host_directory", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "orkestrator-host-files-")));
    await fs.mkdir(path.join(root, "beta"));
    await fs.mkdir(path.join(root, "Alpha"));
    await fs.mkdir(path.join(root, ".hidden-dir"));
    await fs.writeFile(path.join(root, "notes.txt"), "x");
    await fs.writeFile(path.join(root, ".env"), "x");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const names = (listing: Awaited<ReturnType<typeof listHostDirectory>>) =>
    listing.entries.map((entry) => entry.name);

  test("lists only visible folders by default, sorted", async () => {
    const listing = await listHostDirectory(root, { includeFiles: false, showHidden: false });

    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(path.dirname(root));
    expect(names(listing)).toEqual(["Alpha", "beta"]);
    expect(listing.entries.every((entry) => entry.isDirectory)).toBe(true);
    expect(listing.entries[0]?.path).toBe(path.join(root, "Alpha"));
    expect(listing.truncated).toBe(false);
  });

  test("includes files after folders, and hidden entries on request", async () => {
    const files = await listHostDirectory(root, { includeFiles: true, showHidden: false });
    expect(names(files)).toEqual(["Alpha", "beta", "notes.txt"]);

    const hidden = await listHostDirectory(root, { includeFiles: true, showHidden: true });
    expect(names(hidden)).toEqual([".hidden-dir", "Alpha", "beta", ".env", "notes.txt"]);
  });

  test("follows symlinks to folders and drops broken links", async () => {
    await fs.symlink(path.join(root, "beta"), path.join(root, "link-to-dir"));
    await fs.symlink(path.join(root, "missing"), path.join(root, "broken"));

    const listing = await listHostDirectory(root, { includeFiles: true, showHidden: false });

    expect(listing.entries.find((entry) => entry.name === "link-to-dir")?.isDirectory).toBe(true);
    expect(names(listing)).not.toContain("broken");
  });

  test("falls back to the nearest existing folder for a stale or file path", async () => {
    const missing = await listHostDirectory(path.join(root, "beta", "gone", "deeper"), {
      includeFiles: false,
      showHidden: false,
    });
    expect(missing.path).toBe(path.join(root, "beta"));

    const file = await listHostDirectory(path.join(root, "notes.txt"), {
      includeFiles: true,
      showHidden: false,
    });
    expect(file.path).toBe(root);
  });

  test("expands ~ and starts at home when no path is given", async () => {
    const home = await listHostDirectory(undefined, { includeFiles: false, showHidden: false });
    const tilde = await listHostDirectory("~", { includeFiles: false, showHidden: false });

    expect(tilde.path).toBe(home.path);
    expect(home.home).toBe(home.path);
  });

  test("reports no parent at the filesystem root", async () => {
    const listing = await listHostDirectory(path.parse(root).root, {
      includeFiles: false,
      showHidden: false,
    });

    expect(listing.parent).toBeNull();
    expect(listing.roots).toContain(path.parse(root).root);
  });

  test("rejects relative paths", async () => {
    await expect(
      listHostDirectory("relative/path", { includeFiles: false, showHidden: false }),
    ).rejects.toThrow("absolute");
  });

  test("the registered command validates its arguments", async () => {
    const commands = new Map<string, CommandHandler>();
    registerHostFileCommands((name, handler) => commands.set(name, handler));
    const run = commands.get("list_host_directory")!;

    const listing = (await run({ path: root, includeFiles: true }, {} as never)) as Awaited<
      ReturnType<typeof listHostDirectory>
    >;
    expect(names(listing)).toEqual(["Alpha", "beta", "notes.txt"]);

    await expect(Promise.resolve().then(() => run({ extra: true }, {} as never))).rejects.toThrow(
      "Unexpected arguments field: extra",
    );
  });
});
