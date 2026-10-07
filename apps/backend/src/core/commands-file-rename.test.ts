import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as dependencies from "./commands-dependencies.js";
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

  for (const name of ["a".repeat(210), "a".repeat(211), "a".repeat(213), `${"é".repeat(106)}a`]) {
    test(`case-only rename succeeds for a ${Buffer.byteLength(name)}-byte ${name.startsWith("é") ? "multibyte" : "ASCII"} name`, async () => {
      await fs.writeFile(path.join(worktreePath, "src", name), "long name");
      const newName = name.toUpperCase();
      await expect(renameLocalFile(worktreePath, `src/${name}`, newName)).resolves.toBe(
        `src/${newName}`,
      );
      expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual([newName]);
      expect(await fs.readFile(path.join(worktreePath, "src", newName), "utf8")).toBe("long name");
    });
  }

  test("restores the source when case-only publication fails", async () => {
    await fs.writeFile(path.join(worktreePath, "src", "readme.md"), "original");
    const move = dependencies.moveConfinedFile;
    const publicationError = new Error("Publication refused");
    const spy = spyOn(dependencies, "moveConfinedFile").mockImplementation(
      async (root, source, destination) => {
        if (destination === "src/README.md") throw publicationError;
        await move(root, source, destination);
      },
    );
    try {
      await expect(renameLocalFile(worktreePath, "src/readme.md", "README.md")).rejects.toBe(
        publicationError,
      );
      expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual(["readme.md"]);
      expect(await fs.readFile(path.join(worktreePath, "src", "readme.md"), "utf8")).toBe(
        "original",
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("reports the recovery path when a concurrent writer blocks publication and rollback", async () => {
    await fs.writeFile(path.join(worktreePath, "src", "readme.md"), "original");
    const move = dependencies.moveConfinedFile;
    let recoveryPath = "";
    const spy = spyOn(dependencies, "moveConfinedFile").mockImplementation(
      async (root, source, destination) => {
        await move(root, source, destination);
        if (source === "src/readme.md") {
          recoveryPath = destination;
          await fs.writeFile(path.join(root, "src", "readme.md"), "concurrent", { flag: "wx" });
          // Occupy publication on case-sensitive hosts too. On case-insensitive
          // hosts this names the file just created by the concurrent writer.
          try {
            await fs.writeFile(path.join(root, "src", "README.md"), "destination", { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
      },
    );
    try {
      let failure: unknown;
      try {
        await renameLocalFile(worktreePath, "src/readme.md", "README.md");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        `Recover the original file from ${recoveryPath}`,
      );
      expect(recoveryPath).toMatch(/^src\/\.[a-f0-9-]+\.rename$/);
      expect(await fs.readFile(path.join(worktreePath, recoveryPath), "utf8")).toBe("original");
      expect(await fs.readFile(path.join(worktreePath, "src", "readme.md"), "utf8")).toBe(
        "concurrent",
      );
      expect(await fs.readFile(path.join(worktreePath, "src", "README.md"), "utf8")).toMatch(
        /^(concurrent|destination)$/,
      );
    } finally {
      spy.mockRestore();
    }
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
