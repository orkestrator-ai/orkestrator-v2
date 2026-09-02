import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_PINNED_FILE_MOVE,
  containerMoveFileCommand,
  moveLocalFile,
  resolveWorkspaceFileMove,
} from "./commands-files.js";
import { moveConfinedFile } from "./path-safety.js";

describe("workspace file moves", () => {
  let worktreePath = "";

  beforeEach(async () => {
    worktreePath = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-file-move-"));
    await fs.mkdir(path.join(worktreePath, "source"));
    await fs.mkdir(path.join(worktreePath, "destination"));
  });

  afterEach(async () => {
    await fs.rm(worktreePath, { recursive: true, force: true });
  });

  test("moves a regular file into an existing directory", async () => {
    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "keep me");

    await expect(moveLocalFile(worktreePath, "source/notes.txt", "destination")).resolves.toBe(
      "destination/notes.txt",
    );
    await expect(
      fs.readFile(path.join(worktreePath, "destination", "notes.txt"), "utf8"),
    ).resolves.toBe("keep me");
    await expect(fs.stat(path.join(worktreePath, "source", "notes.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("moves a nested file to the workspace root", async () => {
    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "root me");

    await expect(moveLocalFile(worktreePath, "source/notes.txt", ".")).resolves.toBe("notes.txt");
    await expect(fs.readFile(path.join(worktreePath, "notes.txt"), "utf8")).resolves.toBe(
      "root me",
    );
    await expect(fs.stat(path.join(worktreePath, "source", "notes.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not overwrite a file already present at the destination", async () => {
    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "source");
    await fs.writeFile(path.join(worktreePath, "destination", "notes.txt"), "destination");

    await expect(moveLocalFile(worktreePath, "source/notes.txt", "destination")).rejects.toThrow(
      "A file already exists at destination/notes.txt",
    );
    await expect(fs.readFile(path.join(worktreePath, "source", "notes.txt"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(
      fs.readFile(path.join(worktreePath, "destination", "notes.txt"), "utf8"),
    ).resolves.toBe("destination");
  });

  test("normalizes separators and rejects unsafe destinations", () => {
    expect(resolveWorkspaceFileMove("source\\notes.txt", "destination")).toEqual({
      source: "source/notes.txt",
      directory: "destination",
      destination: "destination/notes.txt",
    });
    expect(() => resolveWorkspaceFileMove("source/notes.txt", ".git/objects")).toThrow(
      "Git metadata cannot be modified",
    );
    expect(() => resolveWorkspaceFileMove("source/notes.txt", "../outside")).toThrow(
      "parent directory traversal is not allowed",
    );
    expect(resolveWorkspaceFileMove("source/notes.txt", ".")).toEqual({
      source: "source/notes.txt",
      directory: ".",
      destination: "notes.txt",
    });
  });

  test("reports stale source and destination paths without leaking the worktree path", async () => {
    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "source");

    for (const [source, directory, message] of [
      ["source/gone.txt", "destination", "Source no longer exists: source/gone.txt"],
      ["source/notes.txt", "gone", "Destination directory no longer exists"],
    ] as const) {
      const error = await moveLocalFile(worktreePath, source, directory).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain(worktreePath);
    }
  });

  test("rejects non-files, invalid destination directories, and same-directory moves", async () => {
    await fs.mkdir(path.join(worktreePath, "source", "nested"));
    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "source");
    await fs.writeFile(path.join(worktreePath, "not-a-directory"), "file");
    await fs.symlink("notes.txt", path.join(worktreePath, "source", "linked.txt"));
    await fs.symlink("destination", path.join(worktreePath, "linked-destination"));

    await expect(moveLocalFile(worktreePath, "source/nested", "destination")).rejects.toThrow(
      "Source is not a regular file: source/nested",
    );
    await expect(moveLocalFile(worktreePath, "source/linked.txt", "destination")).rejects.toThrow(
      "Source is not a regular file: source/linked.txt",
    );
    await expect(
      moveLocalFile(worktreePath, "source/notes.txt", "not-a-directory"),
    ).rejects.toThrow("Destination directory is not a directory");
    await expect(
      moveLocalFile(worktreePath, "source/notes.txt", "linked-destination"),
    ).rejects.toThrow("Destination directory is not a directory");
    await expect(moveLocalFile(worktreePath, "source/notes.txt", "source")).rejects.toThrow(
      "File is already in source",
    );
  });

  test("atomically refuses a destination created after its directory is pinned", async () => {
    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "source");

    await expect(
      moveConfinedFile(worktreePath, "source/notes.txt", "destination/notes.txt", {
        afterDirectoriesOpened: () =>
          fs.writeFile(path.join(worktreePath, "destination", "notes.txt"), "racing writer"),
      }),
    ).rejects.toThrow("A file already exists at destination/notes.txt");
    await expect(fs.readFile(path.join(worktreePath, "source", "notes.txt"), "utf8")).resolves.toBe(
      "source",
    );
    await expect(
      fs.readFile(path.join(worktreePath, "destination", "notes.txt"), "utf8"),
    ).resolves.toBe("racing writer");
  });

  test("fails closed when a pinned source or destination ancestor is replaced", async () => {
    for (const replacedDirectory of ["source", "destination"] as const) {
      const caseRoot = path.join(worktreePath, replacedDirectory);
      const hidden = path.join(worktreePath, `${replacedDirectory}-original`);
      const external = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-file-move-external-"));
      try {
        await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "source");
        await fs.writeFile(path.join(external, "sentinel.txt"), "outside");
        await expect(
          moveConfinedFile(worktreePath, "source/notes.txt", "destination/notes.txt", {
            afterDirectoriesOpened: async () => {
              await fs.rename(caseRoot, hidden);
              await fs.symlink(external, caseRoot);
            },
          }),
        ).rejects.toThrow("Workspace directory changed while the file was being moved");
        await expect(fs.readFile(path.join(external, "sentinel.txt"), "utf8")).resolves.toBe(
          "outside",
        );
        await expect(fs.stat(path.join(external, "notes.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await fs.rm(external, { recursive: true, force: true });
        await fs.rm(caseRoot, { recursive: true, force: true });
        await fs.rename(hidden, caseRoot);
        await fs.rm(path.join(worktreePath, "destination", "notes.txt"), { force: true });
      }
    }
  });

  test("executes the container helper with the same no-replace guarantees", async () => {
    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "source");
    const run = (source: string, directory: string, destination: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          CONTAINER_PINNED_FILE_MOVE,
          "--",
          worktreePath,
          source,
          directory,
          destination,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );

    const moved = run("source/notes.txt", "destination", "destination/notes.txt");
    expect(await moved.exited).toBe(0);
    await expect(
      fs.readFile(path.join(worktreePath, "destination", "notes.txt"), "utf8"),
    ).resolves.toBe("source");

    await fs.writeFile(path.join(worktreePath, "source", "notes.txt"), "second source");
    const collision = run("source/notes.txt", "destination", "destination/notes.txt");
    expect(await collision.exited).toBe(1);
    expect(await new Response(collision.stderr).text()).toContain(
      "A file already exists at destination/notes.txt",
    );
    await expect(
      fs.readFile(path.join(worktreePath, "destination", "notes.txt"), "utf8"),
    ).resolves.toBe("source");
    expect(containerMoveFileCommand("source/notes.txt", ".", "notes.txt")).toContain("bun -e ");
    expect(containerMoveFileCommand("source/notes.txt", ".", "notes.txt")).not.toContain(
      'mv -- "$source" "$destination"',
    );
  });
});
