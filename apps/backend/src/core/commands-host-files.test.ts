import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import {
  createHostDirectory,
  listHostDirectory,
  listHostDirectoryRoots,
  MAX_HOST_DIRECTORY_ENTRIES,
  registerHostFileCommands,
  validateHostFolderName,
} from "./commands-host-files.js";
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
  test("rejects over-length paths before filesystem access", async () => {
    await expect(
      listHostDirectory("/" + "x".repeat(4096), {
        includeFiles: true,
        showHidden: false,
      }),
    ).rejects.toThrow("path is too long");
  });

  test("reports permission-denied directory reads", async () => {
    const read = spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    try {
      await expect(
        listHostDirectory(root, { includeFiles: true, showHidden: false }),
      ).rejects.toThrow(`Permission denied reading ${root}`);
    } finally {
      read.mockRestore();
    }
  });

  test("resolves explicit files independently of a folder-first capped listing", async () => {
    const large = path.join(root, "large");
    await fs.mkdir(large);
    // All returned entries are directories; even the first file lies beyond the cap.
    for (let offset = 0; offset < MAX_HOST_DIRECTORY_ENTRIES; offset += 50) {
      await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          fs.mkdir(path.join(large, `dir-${offset + index}`)),
        ),
      );
    }
    const file = path.join(large, "target.txt");
    await fs.writeFile(file, "x");
    const listing = await listHostDirectory(file, { includeFiles: true, showHidden: false });
    expect(listing.entries).toHaveLength(MAX_HOST_DIRECTORY_ENTRIES);
    expect(listing.entries.every((entry) => entry.isDirectory)).toBe(true);
    expect(listing.truncated).toBe(true);
    expect(listing.requestedFile).toBe(file);
  });

  test("normalizes ~ and .. in explicit file paths", async () => {
    const home = spyOn(os, "homedir").mockReturnValue(root);
    try {
      for (const requested of ["~/notes.txt", path.join(root, "beta") + "/../notes.txt"]) {
        const listing = await listHostDirectory(requested, {
          includeFiles: true,
          showHidden: false,
        });
        expect(listing.path).toBe(root);
        expect(listing.requestedFile).toBe(path.join(root, "notes.txt"));
      }
      expect(
        (await listHostDirectory("~/missing", { includeFiles: true, showHidden: false }))
          .requestedFile,
      ).toBeNull();
      expect(
        (await listHostDirectory("~/notes.txt", { includeFiles: false, showHidden: false }))
          .requestedFile,
      ).toBeNull();
    } finally {
      home.mockRestore();
    }
  });

  test("Windows roots include only accessible drive letters in order", async () => {
    const access = spyOn(fs, "access").mockImplementation(async (drive) => {
      if (drive !== "C:\\" && drive !== "Z:\\") throw new Error("missing drive");
    });
    try {
      expect(await listHostDirectoryRoots("win32")).toEqual(["C:\\", "Z:\\"]);
      expect(access).toHaveBeenCalledTimes(26);
    } finally {
      access.mockRestore();
    }
  });

  test("rejects supplied arguments with invalid types instead of changing their intent", async () => {
    const commands = new Map<string, CommandHandler>();
    registerHostFileCommands((name, handler) => commands.set(name, handler));
    const run = commands.get("list_host_directory")!;
    for (const [field, value, type] of [
      ["path", 42, "string"],
      ["path", null, "string"],
      ["includeFiles", "yes", "boolean"],
      ["includeFiles", 1, "boolean"],
      ["showHidden", "false", "boolean"],
      ["showHidden", null, "boolean"],
    ] as const) {
      await expect(
        Promise.resolve().then(() => run({ [field]: value }, {} as never)),
      ).rejects.toThrow(`Expected ${field} to be a ${type}`);
    }
  });
});

describe("create_host_directory", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "orkestrator-host-mkdir-")));
    await fs.writeFile(path.join(root, "notes.txt"), "x");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("creates one trimmed folder inside an existing directory", async () => {
    const created = await createHostDirectory(root, "  New Project  ");

    expect(created.path).toBe(path.join(root, "New Project"));
    expect((await fs.stat(created.path)).isDirectory()).toBe(true);
  });

  test("expands ~ in the parent", async () => {
    const home = spyOn(os, "homedir").mockReturnValue(root);
    try {
      const created = await createHostDirectory("~", "from-home");
      expect(created.path).toBe(path.join(root, "from-home"));
    } finally {
      home.mockRestore();
    }
  });

  test("refuses an entry that already exists instead of reusing it", async () => {
    await fs.mkdir(path.join(root, "taken"));

    await expect(createHostDirectory(root, "taken")).rejects.toThrow(
      `"taken" already exists in ${root}`,
    );
    await expect(createHostDirectory(root, "notes.txt")).rejects.toThrow("already exists");
  });

  test("never creates missing parents or writes under a file", async () => {
    await expect(createHostDirectory(path.join(root, "gone"), "child")).rejects.toThrow(
      "does not exist",
    );
    await expect(createHostDirectory(path.join(root, "notes.txt"), "child")).rejects.toThrow(
      "is not a folder",
    );
    await expect(fs.stat(path.join(root, "gone"))).rejects.toThrow();
  });

  test("rejects relative parents", async () => {
    await expect(createHostDirectory("relative", "child")).rejects.toThrow("absolute");
    await expect(createHostDirectory("   ", "child")).rejects.toThrow("parent is required");
  });

  test("names cannot escape the parent folder", async () => {
    for (const name of ["", "  ", ".", "..", "a/b", "../escape", "a\\b", "bad\u0000name"]) {
      await expect(createHostDirectory(root, name)).rejects.toThrow("Folder name");
    }
    expect(await fs.readdir(root)).toEqual(["notes.txt"]);
  });

  test("validates names for the host platform", () => {
    expect(validateHostFolderName("a:b", "linux")).toBe("a:b");
    expect(() => validateHostFolderName("a:b", "win32")).toThrow("cannot contain");
    expect(() => validateHostFolderName("x".repeat(256), "linux")).toThrow("too long");
    // 255 UTF-8 bytes is the limit, not 255 characters.
    expect(() => validateHostFolderName("é".repeat(128), "linux")).toThrow("too long");
    expect(validateHostFolderName("x".repeat(255), "linux")).toHaveLength(255);
  });

  test("reports permission-denied folder creation", async () => {
    const mkdir = spyOn(fs, "mkdir").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    try {
      await expect(createHostDirectory(root, "locked")).rejects.toThrow(
        `Permission denied creating a folder in ${root}`,
      );
    } finally {
      mkdir.mockRestore();
    }
  });

  test("the registered command validates its arguments", async () => {
    const commands = new Map<string, CommandHandler>();
    registerHostFileCommands((name, handler) => commands.set(name, handler));
    const run = commands.get("create_host_directory")!;

    expect(await run({ parent: root, name: "made" }, {} as never)).toEqual({
      path: path.join(root, "made"),
    });
    for (const [args, message] of [
      [{ parent: root, name: "x", extra: true }, "Unexpected arguments field: extra"],
      [{ parent: 42, name: "x" }, "Expected parent to be a string"],
      [{ parent: root }, "Expected name to be a string"],
    ] as const) {
      await expect(Promise.resolve().then(() => run(args, {} as never))).rejects.toThrow(message);
    }
  });
});
