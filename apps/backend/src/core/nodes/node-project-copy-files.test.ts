import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../shell.js";
import { listProjectCopyCandidates, listProjectCopyFiles } from "./node-project-copy-files.js";

jest.setTimeout(30_000);

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repository(files: Record<string, string>, tracked: string[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-copy-files-"));
  dirs.push(root);
  await runCommand("git", ["-C", root, "init", "-b", "main"]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  await runCommand("git", ["-C", root, "add", "--", ...tracked]);
  await runCommand("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--no-gpg-sign",
    "-m",
    "init",
  ]);
  return root;
}

describe("listProjectCopyCandidates", () => {
  test("lists untracked and ignored entries, suggests .env and configured files, flags dependencies", async () => {
    const root = await repository(
      {
        ".gitignore": "node_modules/\ndist/\n.env\n.env.local\nconfig/\n",
        "README.md": "readme",
        ".env.example": "A=",
        ".env": "SECRET=1",
        ".env.local": "LOCAL=1",
        "node_modules/pkg/index.js": "module.exports = 1;",
        "node_modules/pkg/package.json": "{}",
        "dist/out.js": "built",
        "config/local.json": "{}",
        "config/other.json": "{}",
        "notes.txt": "scratch",
      },
      [".gitignore", "README.md", ".env.example"],
    );

    const { candidates, truncated } = await listProjectCopyCandidates(root, ["config/local.json"]);

    expect(truncated).toBe(false);
    const byPath = new Map(candidates.map((entry) => [entry.path, entry]));
    expect(byPath.get(".env")).toMatchObject({
      kind: "file",
      suggested: true,
      heavy: false,
    });
    expect(byPath.get(".env.local")).toMatchObject({
      suggested: true,
      ignored: true,
    });
    expect(byPath.get("config/local.json")).toMatchObject({
      kind: "file",
      suggested: true,
    });
    expect(byPath.get("config/")).toMatchObject({
      kind: "directory",
      files: 2,
      suggested: false,
    });
    expect(byPath.get("node_modules/")).toMatchObject({
      kind: "directory",
      heavy: true,
      suggested: false,
      files: 2,
    });
    expect(byPath.get("dist/")).toMatchObject({
      heavy: true,
      suggested: false,
    });
    expect(byPath.get("notes.txt")).toMatchObject({
      ignored: false,
      suggested: false,
    });
    // Tracked files arrive with the clone.
    expect(byPath.has("README.md")).toBe(false);
    expect(byPath.has(".env.example")).toBe(false);
    // Suggested first, dependency output last.
    expect(candidates[0]?.suggested).toBe(true);
    expect(candidates.at(-1)?.heavy).toBe(true);
  });

  test("never lists Git metadata or symbolic links", async () => {
    const root = await repository({ "README.md": "x", "outside.txt": "o" }, ["README.md"]);
    await symlink(path.join(root, "outside.txt"), path.join(root, "link.txt"));

    const { candidates } = await listProjectCopyCandidates(root, []);

    expect(candidates.map((entry) => entry.path).sort()).toEqual(["outside.txt"]);
  });
});

describe("listProjectCopyFiles", () => {
  test("expands directories into regular files and skips links and Git metadata", async () => {
    const root = await repository(
      {
        "README.md": "x",
        "data/a.txt": "aaa",
        "data/nested/b.txt": "bb",
        "data/.git/HEAD": "ref",
        ".env": "S=1",
      },
      ["README.md"],
    );
    await symlink(path.join(root, ".env"), path.join(root, "data", "env-link"));

    const list = await listProjectCopyFiles(root, ["data/", ".env", ".env"]);

    expect(list.files.map((file) => file.path).sort()).toEqual([
      ".env",
      "data/a.txt",
      "data/nested/b.txt",
    ]);
    expect(list.totalBytes).toBe(3 + 3 + 2);
    expect(list.skipped).toBe(2);
    expect(list.tooLarge).toEqual([]);
  });

  test("skips a path reached through a linked folder outside the project", async () => {
    const root = await repository({ "README.md": "x" }, ["README.md"]);
    const outside = await mkdtemp(path.join(os.tmpdir(), "ork-copy-outside-"));
    dirs.push(outside);
    await writeFile(path.join(outside, "secret.txt"), "s");
    await symlink(outside, path.join(root, "linked"));

    const list = await listProjectCopyFiles(root, ["linked/secret.txt"]);

    expect(list).toEqual({ files: [], totalBytes: 0, skipped: 1, tooLarge: [] });
  });

  test("refuses paths that leave the project", async () => {
    const root = await repository({ "README.md": "x" }, ["README.md"]);

    await expect(listProjectCopyFiles(root, ["../etc/passwd"])).rejects.toThrow();
    await expect(listProjectCopyFiles(root, ["/etc/passwd"])).rejects.toThrow();
  });

  test("reports a missing path as skipped rather than failing", async () => {
    const root = await repository({ "README.md": "x" }, ["README.md"]);

    const list = await listProjectCopyFiles(root, ["gone.txt"]);

    expect(list).toEqual({
      files: [],
      totalBytes: 0,
      skipped: 1,
      tooLarge: [],
    });
  });
});
