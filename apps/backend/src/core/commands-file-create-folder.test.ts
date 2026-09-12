import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_PINNED_FOLDER_CREATE,
  containerCreateFolderCommand,
  createLocalFolder,
  resolveWorkspaceFolderCreate,
} from "./commands-files.js";
import { createConfinedDirectory } from "./path-safety.js";

async function foldsCase(root: string): Promise<boolean> {
  const probe = path.join(root, "CaseProbe");
  await fs.mkdir(probe);
  try {
    await fs.stat(path.join(root, "caseprobe"));
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

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

  test("rejects unsafe names, missing parents, file parents, and collisions", async () => {
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
    expect(() => resolveWorkspaceFolderCreate("src", ".Git")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFolderCreate("src", ".GIT")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFolderCreate(".Git/refs", "heads2")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFolderCreate(".GIT/refs", "heads2")).toThrow(
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
    await expect(createLocalFolder(worktreePath, "src/App.tsx", "hooks")).rejects.toThrow(
      "ancestor is not a directory",
    );
    await expect(createLocalFolder(worktreePath, "src", "App.tsx")).rejects.toThrow(
      "A file or folder already exists at src/App.tsx",
    );
    await expect(createLocalFolder(worktreePath, ".", "src")).rejects.toThrow(
      "A file or folder already exists at src",
    );
  });

  test("rejects mixed-case .git paths without adding entries under .git", async () => {
    await fs.mkdir(path.join(worktreePath, ".git", "refs"), { recursive: true });
    await fs.writeFile(path.join(worktreePath, ".git", "HEAD"), "ref: refs/heads/main\n");

    await expect(createLocalFolder(worktreePath, ".", ".Git")).rejects.toThrow(
      "Git metadata cannot be modified",
    );
    await expect(createLocalFolder(worktreePath, ".", ".GIT")).rejects.toThrow(
      "Git metadata cannot be modified",
    );
    await expect(createLocalFolder(worktreePath, ".Git", "objects")).rejects.toThrow(
      "Git metadata cannot be modified",
    );
    await expect(createLocalFolder(worktreePath, ".GIT/refs", "heads2")).rejects.toThrow(
      "Git metadata cannot be modified",
    );

    await expect(fs.stat(path.join(worktreePath, ".git", "objects"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readdir(path.join(worktreePath, ".git", "refs"))).toEqual([]);
    expect(await fs.readFile(path.join(worktreePath, ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/main\n",
    );

    if (await foldsCase(worktreePath)) {
      expect(await fs.readdir(path.join(worktreePath, ".GIT", "refs"))).toEqual([]);
    }
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

  test("fails closed when a pinned parent is replaced with a symlink before mkdirat", async () => {
    const hidden = path.join(worktreePath, "src-original");
    const outside = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-folder-race-"));
    try {
      await expect(
        createConfinedDirectory(worktreePath, "src/hooks", {
          afterDirectoriesOpened: async () => {
            await fs.rename(path.join(worktreePath, "src"), hidden);
            await fs.symlink(outside, path.join(worktreePath, "src"));
          },
        }),
      ).rejects.toThrow("Workspace directory changed while the folder was being created");
      await expect(fs.stat(path.join(outside, "hooks"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(hidden, "hooks"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(path.join(worktreePath, "src"))).isSymbolicLink()).toBe(true);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("builds a confined container mkdirat command", () => {
    const command = containerCreateFolderCommand("src", "src/hooks");
    expect(command).toContain("bun -e ");
    expect(command).toContain("mkdirat");
    expect(command).toContain('assert_safe_path "$folderPath"');
    expect(command).toContain("A file or folder already exists");
    expect(command).not.toContain('mkdir -- "$folderPath"');
    expect(command).not.toContain("mkdir -p");
  });

  test("executes the container helper with confinement and collision checks", async () => {
    const run = (directory: string, folderPath: string, readyToken?: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          CONTAINER_PINNED_FOLDER_CREATE,
          "--",
          worktreePath,
          directory,
          folderPath,
          ...(readyToken ? [readyToken] : []),
        ],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );

    const created = run("src", "src/hooks");
    expect(await created.exited).toBe(0);
    expect((await fs.stat(path.join(worktreePath, "src", "hooks"))).isDirectory()).toBe(true);

    const collision = run("src", "src/hooks");
    expect(await collision.exited).toBe(1);
    expect(await new Response(collision.stderr).text()).toContain(
      "A file or folder already exists at src/hooks",
    );

    await fs.writeFile(path.join(worktreePath, "src", "App.tsx"), "export {}\n");
    const fileParent = run("src/App.tsx", "src/App.tsx/nested");
    expect(await fileParent.exited).toBe(1);
    expect(await new Response(fileParent.stderr).text()).toContain("ancestor is not a directory");

    const missing = run("missing", "missing/docs");
    expect(await missing.exited).toBe(1);
    expect(await new Response(missing.stderr).text()).toContain("does not exist");

    const outside = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-folder-helper-"));
    try {
      await fs.symlink(outside, path.join(worktreePath, "escape"));
      const linked = run("escape", "escape/victim");
      expect(await linked.exited).toBe(1);
      expect(await new Response(linked.stderr).text()).toContain("symlink ancestor");
      await expect(fs.stat(path.join(outside, "victim"))).rejects.toMatchObject({ code: "ENOENT" });

      const hidden = path.join(worktreePath, "src-original");
      const raced = run("src", "src/race", "READY");
      const stdout = raced.stdout.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      while (!seen.includes("READY")) {
        const chunk = await stdout.read();
        if (chunk.done) break;
        seen += decoder.decode(chunk.value);
      }
      await fs.rename(path.join(worktreePath, "src"), hidden);
      await fs.symlink(outside, path.join(worktreePath, "src"));
      raced.stdin.end();
      expect(await raced.exited).toBe(1);
      expect(await new Response(raced.stderr).text()).toContain("Workspace directory changed");
      await expect(fs.stat(path.join(outside, "race"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
