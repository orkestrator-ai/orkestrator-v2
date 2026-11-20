import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_WORKSPACE_FILE_NAME_BYTES } from "@orkestrator/protocol/contract/domains/files";
import {
  containerCreateFileArgs,
  containerFileCreateFailure,
  createContainerFile,
  createLocalFile,
  resolveWorkspaceFileCreate,
} from "./commands-file-create.js";
import { CommandFailedError, type runCommand } from "./shell.js";

describe("workspace file creation", () => {
  let worktreePath = "";

  beforeEach(async () => {
    worktreePath = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-file-"));
    await fs.mkdir(path.join(worktreePath, "src"));
    await fs.writeFile(path.join(worktreePath, "src", "App.tsx"), "export {}\n");
  });

  afterEach(async () => {
    await fs.rm(worktreePath, { recursive: true, force: true });
  });

  test("creates an empty file in a folder and at the workspace root", async () => {
    await expect(createLocalFile(worktreePath, "src", "notes.md")).resolves.toBe("src/notes.md");
    const created = await fs.lstat(path.join(worktreePath, "src", "notes.md"));
    expect(created.isFile()).toBe(true);
    expect(created.size).toBe(0);
    expect(created.mode & 0o777).toBe(0o644);

    await expect(createLocalFile(worktreePath, ".", "  TODO  ")).resolves.toBe("TODO");
    expect(await fs.readFile(path.join(worktreePath, "TODO"), "utf8")).toBe("");
    // No staging sibling is left behind.
    expect((await fs.readdir(path.join(worktreePath, "src"))).sort()).toEqual([
      "App.tsx",
      "notes.md",
    ]);
  });

  test("never replaces an existing file or folder", async () => {
    await expect(createLocalFile(worktreePath, "src", "App.tsx")).rejects.toThrow(
      "A file or folder already exists at src/App.tsx",
    );
    expect(await fs.readFile(path.join(worktreePath, "src", "App.tsx"), "utf8")).toBe(
      "export {}\n",
    );
    await expect(createLocalFile(worktreePath, ".", "src")).rejects.toThrow(
      "A file or folder already exists at src",
    );
    expect((await fs.lstat(path.join(worktreePath, "src"))).isDirectory()).toBe(true);
    expect((await fs.readdir(path.join(worktreePath, "src"))).sort()).toEqual(["App.tsx"]);
  });

  test("validates the name the same way folder creation does", () => {
    expect(() => resolveWorkspaceFileCreate("src", "")).toThrow("name is required");
    expect(() => resolveWorkspaceFileCreate("src", "   ")).toThrow("name is required");
    expect(() => resolveWorkspaceFileCreate("src", ".")).toThrow(
      "path must stay inside the workspace",
    );
    expect(() => resolveWorkspaceFileCreate("src", "..")).toThrow(
      "path must stay inside the workspace",
    );
    expect(() => resolveWorkspaceFileCreate("src", "nested/child.ts")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceFileCreate("src", "nested\\child.ts")).toThrow(
      "path separators are not allowed",
    );
    expect(() => resolveWorkspaceFileCreate(".", ".Git")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFileCreate(".git", "config")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFileCreate("../outside", "a.txt")).toThrow(
      "parent directory traversal is not allowed",
    );
    expect(() =>
      resolveWorkspaceFileCreate("src", "x".repeat(MAX_WORKSPACE_FILE_NAME_BYTES + 1)),
    ).toThrow(`Invalid fileName: name exceeds ${MAX_WORKSPACE_FILE_NAME_BYTES} bytes`);
    // The limit counts UTF-8 bytes, not characters.
    expect(() =>
      resolveWorkspaceFileCreate("src", "é".repeat(MAX_WORKSPACE_FILE_NAME_BYTES / 2 + 1)),
    ).toThrow("name exceeds");
    expect(resolveWorkspaceFileCreate("src", "x".repeat(MAX_WORKSPACE_FILE_NAME_BYTES))).toEqual({
      directory: "src",
      fileName: "x".repeat(MAX_WORKSPACE_FILE_NAME_BYTES),
      filePath: `src/${"x".repeat(MAX_WORKSPACE_FILE_NAME_BYTES)}`,
    });
  });

  test("rejects missing parents, file parents and symlink ancestors without writing", async () => {
    await expect(createLocalFile(worktreePath, "missing", "a.txt")).rejects.toThrow(
      "Parent directory does not exist: missing",
    );
    await expect(fs.stat(path.join(worktreePath, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(createLocalFile(worktreePath, "src/App.tsx", "a.txt")).rejects.toThrow();

    const outside = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-file-outside-"));
    try {
      await fs.symlink(outside, path.join(worktreePath, "escape"));
      await expect(createLocalFile(worktreePath, "escape", "victim.txt")).rejects.toThrow();
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("container file creation", () => {
  let workspace = "";

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-container-file-"));
    await fs.mkdir(path.join(workspace, "src"));
    await fs.writeFile(path.join(workspace, "src", "App.tsx"), "export {}\n");
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  /** Runs the in-container writer against a local directory standing in for /workspace. */
  const runWriter = (parentDirectory: string, fileName: string) => {
    const args = containerCreateFileArgs(
      "container-1",
      resolveWorkspaceFileCreate(parentDirectory, fileName),
    );
    const script = args[args.indexOf("-e") + 1]!;
    const rest = args.slice(args.indexOf("-e") + 2);
    expect(rest[0]).toBe("/workspace");
    const child = Bun.spawn([process.execPath, "-e", script, workspace, ...rest.slice(1)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void child.stdin.end();
    return Promise.all([child.exited, new Response(child.stderr).text()]);
  };

  test("builds an exclusive, existing-ancestor docker exec of the pinned writer", () => {
    const args = containerCreateFileArgs("container-1", resolveWorkspaceFileCreate("src", "a.ts"));
    expect(args.slice(0, 4)).toEqual(["exec", "-i", "container-1", "node"]);
    expect(args.slice(-8)).toEqual([
      "/workspace",
      "src",
      "a.ts",
      "0",
      "",
      "exclusive",
      "420",
      "existing",
    ]);
  });

  test("the writer creates an empty file and refuses an existing name", async () => {
    expect(await runWriter("src", "notes.md")).toEqual([0, ""]);
    expect(await fs.readFile(path.join(workspace, "src", "notes.md"), "utf8")).toBe("");
    expect(await runWriter(".", "root.txt")).toEqual([0, ""]);
    expect(await fs.readFile(path.join(workspace, "root.txt"), "utf8")).toBe("");

    const [existsCode, existsError] = await runWriter("src", "App.tsx");
    expect(existsCode).toBe(76);
    expect(existsError).toContain("EEXIST");
    expect(await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8")).toBe("export {}\n");

    const [folderCode] = await runWriter(".", "src");
    expect(folderCode).toBe(76);
    expect((await fs.lstat(path.join(workspace, "src"))).isDirectory()).toBe(true);

    const [missingCode, missingError] = await runWriter("missing", "a.txt");
    expect(missingCode).toBe(77);
    expect(missingError).toContain("ENOENT_ANCESTOR");
    await expect(fs.stat(path.join(workspace, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fs.readdir(path.join(workspace, "src"))).sort()).toEqual(["App.tsx", "notes.md"]);
  });

  test("the writer refuses a symlinked parent", async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-create-container-outside-"));
    try {
      await fs.symlink(outside, path.join(workspace, "escape"));
      const [code] = await runWriter("escape", "victim.txt");
      expect(code).toBe(73);
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("maps the writer's exits onto the local path's messages", async () => {
    const created = resolveWorkspaceFileCreate("src", "App.tsx");
    const failed = (exitCode: number, stderr: string) =>
      new CommandFailedError(`docker exited ${exitCode}: ${stderr}`, { exitCode, stderr });
    expect(containerFileCreateFailure(failed(76, "EEXIST"), created).message).toBe(
      "A file or folder already exists at src/App.tsx",
    );
    expect(containerFileCreateFailure(failed(77, "ENOENT_ANCESTOR"), created).message).toBe(
      "Parent directory does not exist: src",
    );
    expect(
      containerFileCreateFailure(
        failed(77, "ENOENT_ANCESTOR"),
        resolveWorkspaceFileCreate(".", "a"),
      ).message,
    ).toBe("Workspace root is not available");
    expect(containerFileCreateFailure(failed(73, ""), created).message).toContain(
      "not a folder inside the workspace",
    );
    expect(containerFileCreateFailure(failed(1, "boom"), created).message).toBe(
      "The file could not be created in the container workspace",
    );

    const calls: Array<{ command: string; args: string[] }> = [];
    const execute = (async (command: string, args: string[]) => {
      calls.push({ command, args });
      throw failed(76, "EEXIST");
    }) as unknown as typeof runCommand;
    await expect(
      createContainerFile(execute, "container-1", "src", "App.tsx", 1_000),
    ).rejects.toThrow("A file or folder already exists at src/App.tsx");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("docker");

    // An invalid name never reaches the container.
    await expect(createContainerFile(execute, "container-1", "src", "a/b", 1_000)).rejects.toThrow(
      "path separators are not allowed",
    );
    expect(calls).toHaveLength(1);
  });
});
