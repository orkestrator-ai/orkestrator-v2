import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as pathSafety from "../path-safety.js";
import { createLocalFolder, renameLocalFile, resolveWorkspaceFileRename } from "./files.js";

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

  test.each(["file", "folder"] as const)(
    "restores the %s when case-only publication fails",
    async (kind) => {
      const sourceFile = kind === "file" ? "src/readme.md" : "src/readme.md/keep.txt";
      if (kind === "folder") await fs.mkdir(path.join(worktreePath, "src/readme.md"));
      await fs.writeFile(path.join(worktreePath, sourceFile), "original");
      const move = pathSafety.moveConfinedFile;
      const publicationError = new Error("Publication refused");
      const spy = spyOn(pathSafety, "moveConfinedFile").mockImplementation(
        async (root, source, destination, hooks, options) => {
          if (destination === "src/README.md") throw publicationError;
          await move(root, source, destination, hooks, options);
        },
      );
      try {
        await expect(
          renameLocalFile(worktreePath, "src/readme.md", "README.md", kind),
        ).rejects.toBe(publicationError);
        expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual(["readme.md"]);
        expect(await fs.readFile(path.join(worktreePath, sourceFile), "utf8")).toBe("original");
      } finally {
        spy.mockRestore();
      }
    },
  );

  test("reports the recovery path when a concurrent writer blocks publication and rollback", async () => {
    await fs.writeFile(path.join(worktreePath, "src", "readme.md"), "original");
    const move = pathSafety.moveConfinedFile;
    let recoveryPath = "";
    const spy = spyOn(pathSafety, "moveConfinedFile").mockImplementation(
      async (root, source, destination, hooks, options) => {
        await move(root, source, destination, hooks, options);
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
      expect((failure as Error).message).toContain(`Recover the original from ${recoveryPath}`);
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

  test("renames a folder in place with its contents", async () => {
    await fs.mkdir(path.join(worktreePath, "src", "nested", "deeper"), { recursive: true });
    await fs.writeFile(path.join(worktreePath, "src", "nested", "deeper", "a.txt"), "inside");

    await expect(renameLocalFile(worktreePath, "src/nested", "renamed", "folder")).resolves.toBe(
      "src/renamed",
    );
    expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual(["renamed"]);
    await expect(
      fs.readFile(path.join(worktreePath, "src", "renamed", "deeper", "a.txt"), "utf8"),
    ).resolves.toBe("inside");
  });

  test("changes only the letter case of a folder name", async () => {
    await fs.mkdir(path.join(worktreePath, "src", "docs"));
    await fs.writeFile(path.join(worktreePath, "src", "docs", "a.txt"), "case");

    await expect(renameLocalFile(worktreePath, "src/docs", "Docs", "folder")).resolves.toBe(
      "src/Docs",
    );
    expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual(["Docs"]);
    await expect(
      fs.readFile(path.join(worktreePath, "src", "Docs", "a.txt"), "utf8"),
    ).resolves.toBe("case");
  });

  test("does not replace an existing folder", async () => {
    await fs.mkdir(path.join(worktreePath, "src", "a"));
    await fs.mkdir(path.join(worktreePath, "src", "b"));
    await fs.writeFile(path.join(worktreePath, "src", "a", "keep.txt"), "a");

    await expect(renameLocalFile(worktreePath, "src/a", "b", "folder")).rejects.toThrow(
      "A file or folder already exists at src/b",
    );
    await expect(
      fs.readFile(path.join(worktreePath, "src", "a", "keep.txt"), "utf8"),
    ).resolves.toBe("a");
  });

  test("does not follow a symlinked folder", async () => {
    await fs.mkdir(path.join(worktreePath, "src", "real"));
    await fs.symlink("real", path.join(worktreePath, "src", "link"));

    await expect(renameLocalFile(worktreePath, "src/link", "other", "folder")).rejects.toThrow(
      "Source is not a folder",
    );
    expect((await fs.readdir(path.join(worktreePath, "src"))).sort()).toEqual(["link", "real"]);
  });

  test("moves a folder only when renaming it in place", async () => {
    await fs.mkdir(path.join(worktreePath, "src", "nested"));
    await fs.mkdir(path.join(worktreePath, "other"));

    await expect(
      pathSafety.moveConfinedFile(
        worktreePath,
        "src/nested",
        "other/nested",
        {},
        {
          renameKind: "folder",
        },
      ),
    ).rejects.toThrow("A folder can only be renamed in place");
    await expect(
      pathSafety.moveConfinedFile(worktreePath, "src/nested", "src/renamed"),
    ).rejects.toThrow("Source is not a regular file: src/nested");
    expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual(["nested"]);
  });

  test("rejects a backslash-bearing source without touching either spelling", async () => {
    const literal = "src/left\\right";
    const normalized = "src/left/right";
    for (const [folder, contents] of [
      [literal, "literal"],
      [normalized, "normalized"],
    ] as const) {
      await fs.mkdir(path.join(worktreePath, folder), { recursive: true });
      await fs.writeFile(path.join(worktreePath, folder, "keep.txt"), contents);
    }

    await expect(renameLocalFile(worktreePath, literal, "renamed", "folder")).rejects.toThrow(
      "source path containing a backslash",
    );
    expect(await fs.readFile(path.join(worktreePath, literal, "keep.txt"), "utf8")).toBe("literal");
    expect(await fs.readFile(path.join(worktreePath, normalized, "keep.txt"), "utf8")).toBe(
      "normalized",
    );
  });

  test.each(["submodule", "linked worktree"])("protects an ancestor of a Git %s", async (kind) => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test User",
          "-c",
          "user.email=test@example.com",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          cwd,
          ...args,
        ],
        { encoding: "utf8" },
      );
    git(worktreePath, "init", "-q");
    git(worktreePath, "commit", "-qm", "seed", "--allow-empty");
    if (kind === "submodule") {
      const upstream = path.join(worktreePath, "upstream");
      await fs.mkdir(upstream);
      git(upstream, "init", "-q");
      git(upstream, "commit", "-qm", "seed", "--allow-empty");
      git(
        worktreePath,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        upstream,
        "src/nested",
      );
    } else {
      git(worktreePath, "worktree", "add", "-q", "--detach", "src/nested");
    }
    const nested = path.join(worktreePath, "src/nested");
    const originalHead = git(nested, "rev-parse", "HEAD");
    await expect(renameLocalFile(worktreePath, "src", "lib", "folder")).rejects.toThrow(
      "nested Git repository",
    );
    expect(git(nested, "rev-parse", "HEAD")).toBe(originalHead);
    await expect(fs.stat(path.join(worktreePath, "lib"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses a replacement source of either wrong kind", async () => {
    await fs.mkdir(path.join(worktreePath, "src/replacement-folder"));
    await fs.writeFile(path.join(worktreePath, "src/replacement-file"), "replacement");
    await expect(
      renameLocalFile(worktreePath, "src/replacement-folder", "renamed"),
    ).rejects.toThrow("Source is not a regular file");
    await expect(
      renameLocalFile(worktreePath, "src/replacement-file", "renamed", "folder"),
    ).rejects.toThrow("Source is not a folder");
    expect((await fs.readdir(path.join(worktreePath, "src"))).sort()).toEqual([
      "replacement-file",
      "replacement-folder",
    ]);
  });

  test.each(["a".repeat(214), "b".repeat(255), "é".repeat(127) + "z"])(
    "renames a folder within the UTF-8 component limit",
    async (name) => {
      await createLocalFolder(worktreePath, "src", "nested");
      await expect(renameLocalFile(worktreePath, "src/nested", name, "folder")).resolves.toBe(
        `src/${name}`,
      );
      expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual([name]);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "explains why an unreadable folder cannot be checked",
    async () => {
      const folder = path.join(worktreePath, "src/unreadable");
      await fs.mkdir(folder, { mode: 0o300 });
      try {
        await expect(
          renameLocalFile(worktreePath, "src/unreadable", "renamed", "folder"),
        ).rejects.toThrow("permission denied while checking for nested Git repositories");
        expect(await fs.readdir(path.join(worktreePath, "src"))).toEqual(["unreadable"]);
      } finally {
        await fs.chmod(folder, 0o700);
      }
    },
  );

  test("rejects missing files", async () => {
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
    expect(() => resolveWorkspaceFileRename("src/docs", "docs", "folder")).toThrow(
      "Folder is already named docs",
    );
    expect(() => resolveWorkspaceFileRename("src/docs", "é".repeat(128), "folder")).toThrow(
      "name exceeds 255 bytes",
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
