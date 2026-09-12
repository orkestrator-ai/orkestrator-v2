import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  containerCreateFolderCommand,
  createLocalFolder,
  resolveWorkspaceFolderCreate,
} from "./commands-files.js";

describe("workspace folder creation", () => {
  let worktreePath = "";

  beforeEach(async () => {
    worktreePath = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-folder-"));
    await fs.mkdir(path.join(worktreePath, "src"));
  });

  afterEach(async () => {
    await fs.rm(worktreePath, { recursive: true, force: true });
  });

  test("creates a folder in an existing directory and at the workspace root", async () => {
    await expect(createLocalFolder(worktreePath, "src", "components")).resolves.toBe(
      "src/components",
    );
    await expect(fs.stat(path.join(worktreePath, "src", "components"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect((await fs.stat(path.join(worktreePath, "src", "components"))).isDirectory()).toBe(true);

    await expect(createLocalFolder(worktreePath, ".", "docs")).resolves.toBe("docs");
    expect((await fs.stat(path.join(worktreePath, "docs"))).isDirectory()).toBe(true);
  });

  test("rejects unsafe names, missing parents, and collisions", async () => {
    await fs.writeFile(path.join(worktreePath, "src", "App.tsx"), "export {}\n");

    expect(() => resolveWorkspaceFolderCreate("src", "")).toThrow("name is required");
    expect(() => resolveWorkspaceFolderCreate("src", "   ")).toThrow("name is required");
    expect(() => resolveWorkspaceFolderCreate("src", ".")).toThrow(
      "path must stay inside the workspace",
    );
    expect(() => resolveWorkspaceFolderCreate("src", "..")).toThrow(
      "path must stay inside the workspace",
    );
    expect(() => resolveWorkspaceFolderCreate("src", "nested/child")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceFolderCreate("src", "nested\\child")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceFolderCreate("src", ".git")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFolderCreate("../outside", "docs")).toThrow(
      "parent directory traversal is not allowed",
    );
    expect(() => resolveWorkspaceFolderCreate("src", "x".repeat(256))).toThrow(
      "name exceeds 255 characters",
    );
    expect(resolveWorkspaceFolderCreate("src", "  hooks  ")).toEqual({
      directory: "src",
      folderPath: "src/hooks",
    });
    expect(resolveWorkspaceFolderCreate(".", "docs")).toEqual({
      directory: ".",
      folderPath: "docs",
    });

    await expect(createLocalFolder(worktreePath, "missing", "docs")).rejects.toThrow(
      "Parent directory does not exist: missing",
    );
    await expect(createLocalFolder(worktreePath, "src", "App.tsx")).rejects.toThrow(
      "A file or folder already exists at src/App.tsx",
    );
    await expect(createLocalFolder(worktreePath, ".", "src")).rejects.toThrow(
      "A file or folder already exists at src",
    );
  });

  test("rejects symlink ancestors without creating the folder", async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-folder-outside-"));
    try {
      await fs.symlink(outside, path.join(worktreePath, "escape"));
      await expect(createLocalFolder(worktreePath, "escape", "victim")).rejects.toThrow(
        "symlink ancestor",
      );
      await expect(fs.stat(path.join(outside, "victim"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("builds a confined container mkdir command", () => {
    const command = containerCreateFolderCommand("src", "src/hooks");
    expect(command).toContain('mkdir -- "$folderPath"');
    expect(command).toContain('assert_safe_path "$folderPath"');
    expect(command).toContain("A file or folder already exists");
    expect(command).not.toContain("mkdir -p");
  });
});
