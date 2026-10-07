import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renameLocalFile, resolveWorkspaceFileRename } from "./commands-files.js";

describe("workspace file renames", () => {
  let worktreePath = "";

  beforeEach(async () => {
    worktreePath = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-file-rename-"));
    await fs.mkdir(path.join(worktreePath, "src"));
  });

  afterEach(async () => {
    await fs.rm(worktreePath, { recursive: true, force: true });
  });

  test("renames a nested file in place", async () => {
    await fs.writeFile(path.join(worktreePath, "src", "notes.txt"), "keep me");

    await expect(renameLocalFile(worktreePath, "src/notes.txt", "todo.md")).resolves.toBe(
      "src/todo.md",
    );
    await expect(fs.readFile(path.join(worktreePath, "src", "todo.md"), "utf8")).resolves.toBe(
      "keep me",
    );
    await expect(fs.stat(path.join(worktreePath, "src", "notes.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("renames a file at the workspace root", async () => {
    await fs.writeFile(path.join(worktreePath, "notes.txt"), "root");

    await expect(renameLocalFile(worktreePath, "notes.txt", "  readme.txt  ")).resolves.toBe(
      "readme.txt",
    );
    await expect(fs.readFile(path.join(worktreePath, "readme.txt"), "utf8")).resolves.toBe("root");
  });

  test("changes only the letter case of a file name", async () => {
    await fs.writeFile(path.join(worktreePath, "src", "readme.md"), "case");

    await expect(renameLocalFile(worktreePath, "src/readme.md", "README.md")).resolves.toBe(
      "src/README.md",
    );
    expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual(["README.md"]);
    await expect(fs.readFile(path.join(worktreePath, "src", "README.md"), "utf8")).resolves.toBe(
      "case",
    );
  });

  test("does not overwrite an existing file", async () => {
    await fs.writeFile(path.join(worktreePath, "src", "a.txt"), "a");
    await fs.writeFile(path.join(worktreePath, "src", "b.txt"), "b");

    await expect(renameLocalFile(worktreePath, "src/a.txt", "b.txt")).rejects.toThrow(
      "A file already exists at src/b.txt",
    );
    await expect(fs.readFile(path.join(worktreePath, "src", "a.txt"), "utf8")).resolves.toBe("a");
    await expect(fs.readFile(path.join(worktreePath, "src", "b.txt"), "utf8")).resolves.toBe("b");
  });

  test("rejects directories and missing files", async () => {
    await fs.mkdir(path.join(worktreePath, "src", "nested"));

    await expect(renameLocalFile(worktreePath, "src/nested", "other")).rejects.toThrow(
      "Source is not a regular file",
    );
    await expect(renameLocalFile(worktreePath, "src/missing.txt", "other.txt")).rejects.toThrow(
      "Source no longer exists",
    );
  });

  test("validates the new name as a single in-place segment", () => {
    expect(resolveWorkspaceFileRename("src/a.txt", "b.txt")).toEqual({
      source: "src/a.txt",
      directory: "src",
      destination: "src/b.txt",
    });
    expect(() => resolveWorkspaceFileRename("src/a.txt", "   ")).toThrow("name is required");
    expect(() => resolveWorkspaceFileRename("src/a.txt", "a.txt")).toThrow(
      "File is already named a.txt",
    );
    expect(() => resolveWorkspaceFileRename("src/a.txt", "../a.txt")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceFileRename("src/a.txt", "nested/a.txt")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceFileRename("src/a.txt", "nested\\a.txt")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceFileRename("src/a.txt", "..")).toThrow(
      "path must stay inside the workspace",
    );
    expect(() => resolveWorkspaceFileRename("src/a.txt", ".GIT")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFileRename("../a.txt", "b.txt")).toThrow(
      "parent directory traversal is not allowed",
    );
    expect(() => resolveWorkspaceFileRename("src/a.txt", "x".repeat(214))).toThrow(
      "name exceeds 213 bytes",
    );
  });
});
