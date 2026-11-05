import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { containerDeleteFileCommand, deleteLocalFile } from "./commands-files.js";
import { runCommand } from "./shell.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]) {
  return runCommand(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd },
  );
}

/**
 * A repository with a folder holding tracked, untracked, ignored and empty
 * entries, which is everything a folder delete has to take with it.
 */
async function createRepositoryWithFolder(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-delete-folder-")));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await fs.writeFile(path.join(root, ".gitignore"), "*.log\n");
  await fs.writeFile(path.join(root, "keep.txt"), "keep\n");
  await fs.mkdir(path.join(root, "docs", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "docs", "tracked.md"), "tracked\n");
  await fs.writeFile(path.join(root, "docs", "nested", "deep.md"), "deep\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  await fs.writeFile(path.join(root, "docs", "untracked.md"), "untracked\n");
  await fs.writeFile(path.join(root, "docs", "nested", "ignored.log"), "ignored\n");
  await fs.mkdir(path.join(root, "docs", "empty"));
  return root;
}

async function addNestedRepository(root: string, relativePath: string): Promise<void> {
  const nested = path.join(root, relativePath);
  await fs.mkdir(nested, { recursive: true });
  await git(nested, "init", "-b", "main");
  await fs.writeFile(path.join(nested, "inner.txt"), "inner\n");
  await git(nested, "add", ".");
  await git(nested, "commit", "-m", "nested");
}

async function stagedDeletions(root: string): Promise<string> {
  return (await git(root, "diff", "--cached", "--name-status")).stdout.trim();
}

/** Runs the container delete script against a host directory standing in for /workspace. */
function runContainerDelete(root: string, target: string) {
  const script = containerDeleteFileCommand(target).replaceAll("/workspace", root);
  const result = Bun.spawnSync(["bash", "-c", script], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return { exitCode: result.exitCode, stderr: result.stderr.toString() };
}

describe("deleting a folder from a local worktree", () => {
  test("removes tracked, untracked, ignored and empty entries and stages the deletions", async () => {
    const root = await createRepositoryWithFolder();

    await expect(deleteLocalFile(root, "docs")).resolves.toBe("docs");

    expect(existsSync(path.join(root, "docs"))).toBe(false);
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
    expect(await stagedDeletions(root)).toBe("D\tdocs/nested/deep.md\nD\tdocs/tracked.md");
  });

  test("removes a folder that only holds untracked files", async () => {
    const root = await createRepositoryWithFolder();
    await fs.mkdir(path.join(root, "scratch", "inner"), { recursive: true });
    await fs.writeFile(path.join(root, "scratch", "inner", "notes.txt"), "notes\n");

    await expect(deleteLocalFile(root, "scratch")).resolves.toBe("scratch");

    expect(existsSync(path.join(root, "scratch"))).toBe(false);
    expect(await stagedDeletions(root)).toBe("");
  });

  test("still deletes a single file", async () => {
    const root = await createRepositoryWithFolder();

    await expect(deleteLocalFile(root, "docs/tracked.md")).resolves.toBe("docs/tracked.md");

    expect(existsSync(path.join(root, "docs", "tracked.md"))).toBe(false);
    expect(existsSync(path.join(root, "docs", "nested", "deep.md"))).toBe(true);
  });

  test("reports a folder that keeps a nested Git repository instead of claiming success", async () => {
    const root = await createRepositoryWithFolder();
    await addNestedRepository(root, "docs/vendor");

    await expect(deleteLocalFile(root, "docs")).rejects.toThrow(
      "docs was not fully deleted: it contains a nested Git repository",
    );

    // The nested repository and its history are left alone.
    expect(existsSync(path.join(root, "docs", "vendor", ".git"))).toBe(true);
    expect(existsSync(path.join(root, "docs", "tracked.md"))).toBe(false);
  });

  test("refuses the workspace root and Git metadata", async () => {
    const root = await createRepositoryWithFolder();

    await expect(deleteLocalFile(root, ".")).rejects.toThrow("path must stay inside the workspace");
    await expect(deleteLocalFile(root, ".git")).rejects.toThrow("Git metadata cannot be modified");
    expect(existsSync(path.join(root, ".git"))).toBe(true);
  });
});

describe("deleting a folder from a container workspace", () => {
  test("the delete script removes the whole folder and stages tracked deletions", async () => {
    const root = await createRepositoryWithFolder();

    expect(runContainerDelete(root, "docs")).toMatchObject({ exitCode: 0 });

    expect(existsSync(path.join(root, "docs"))).toBe(false);
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
    expect(await stagedDeletions(root)).toBe("D\tdocs/nested/deep.md\nD\tdocs/tracked.md");
  });

  test("the delete script fails when a nested Git repository survives", async () => {
    const root = await createRepositoryWithFolder();
    await addNestedRepository(root, "docs/vendor");

    const result = runContainerDelete(root, "docs");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "docs was not fully deleted: it contains a nested Git repository",
    );
    expect(existsSync(path.join(root, "docs", "vendor", ".git"))).toBe(true);
  });
});
