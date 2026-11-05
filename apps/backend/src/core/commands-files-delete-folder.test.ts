import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  containerDeleteFileCommand,
  containerRevertFileCommand,
  deleteLocalFile,
  revertLocalFile,
} from "./commands-files.js";
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
function runContainerScript(root: string, command: string) {
  const script = command.replaceAll("/workspace", root);
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

  test("refuses a nested repository before removing any folder contents", async () => {
    const root = await createRepositoryWithFolder();
    await addNestedRepository(root, "docs/vendor");

    await expect(deleteLocalFile(root, "docs")).rejects.toThrow(
      "Cannot delete docs: nested Git repository at docs/vendor",
    );

    // The nested repository and its history are left alone.
    expect(existsSync(path.join(root, "docs", "vendor", ".git"))).toBe(true);
    await expectFolderIntact(root);
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

    expect(runContainerScript(root, containerDeleteFileCommand("docs"))).toMatchObject({
      exitCode: 0,
    });

    expect(existsSync(path.join(root, "docs"))).toBe(false);
    expect(existsSync(path.join(root, "keep.txt"))).toBe(true);
    expect(await stagedDeletions(root)).toBe("D\tdocs/nested/deep.md\nD\tdocs/tracked.md");
  });

  test("the delete script refuses a nested repository before mutation", async () => {
    const root = await createRepositoryWithFolder();
    await addNestedRepository(root, "docs/vendor");

    const result = runContainerScript(root, containerDeleteFileCommand("docs"));

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Cannot delete docs: nested Git repository at docs/vendor");
    expect(existsSync(path.join(root, "docs", "vendor", ".git"))).toBe(true);
    await expectFolderIntact(root);
  });
});

async function expectFolderIntact(root: string): Promise<void> {
  for (const file of [
    "docs/tracked.md",
    "docs/nested/deep.md",
    "docs/untracked.md",
    "docs/nested/ignored.log",
  ]) {
    expect(existsSync(path.join(root, file))).toBe(true);
  }
  expect(await stagedDeletions(root)).toBe("");
}

for (const mode of ["local", "container"] as const) {
  describe(`${mode} removal safety and shared revert behavior`, () => {
    const remove = async (root: string, target: string) => {
      if (mode === "local") return deleteLocalFile(root, target);
      const result = runContainerScript(root, containerDeleteFileCommand(target));
      if (result.exitCode !== 0) throw new Error(result.stderr);
    };
    const revert = async (root: string, target: string) => {
      if (mode === "local")
        return revertLocalFile(root, target, "main", { ensureFetched: async () => {} });
      const result = runContainerScript(root, containerRevertFileCommand(target, "main"));
      if (result.exitCode !== 0) throw new Error(result.stderr);
    };

    for (const target of ["scratch*", "scratch[ab]", ":(exclude)keep"]) {
      test(`deletes the literal folder ${target} and preserves every sibling`, async () => {
        const root = await createRepositoryWithFolder();
        const folders = [target, "scratch-backup", "scratcha", "other"];
        for (const folder of folders) {
          await fs.mkdir(path.join(root, folder));
          await fs.writeFile(path.join(root, folder, "tracked.txt"), "tracked");
        }
        await git(root, "add", ".");
        await git(root, "commit", "-m", "literal paths");
        for (const folder of folders) {
          await fs.writeFile(path.join(root, folder, "untracked.txt"), "untracked");
          await fs.writeFile(path.join(root, folder, "ignored.log"), "ignored");
        }
        await remove(root, target);
        expect(existsSync(path.join(root, target))).toBe(false);
        for (const folder of folders.slice(1)) {
          for (const file of ["tracked.txt", "untracked.txt", "ignored.log"]) {
            expect(await fs.readFile(path.join(root, folder, file), "utf8")).toBe(
              file.split(".")[0]!,
            );
          }
        }
        expect((await git(root, "diff", "--cached", "--name-only", "-z")).stdout).toBe(
          `${target}/tracked.txt\0`,
        );
      });
    }

    for (const kind of ["worktree", "bare"] as const) {
      test(`preflights a ${kind} repository before removing tracked, untracked or ignored data`, async () => {
        const root = await createRepositoryWithFolder();
        if (kind === "bare") {
          await git(root, "init", "--bare", "docs/vendor");
        } else {
          await git(root, "worktree", "add", "--detach", "docs/vendor", "HEAD");
        }
        await expect(remove(root, "docs")).rejects.toThrow("nested Git repository at docs/vendor");
        await expectFolderIntact(root);
      });
    }

    test("does not follow a symlink into a sibling repository", async () => {
      const root = await createRepositoryWithFolder();
      await addNestedRepository(root, "sibling");
      await fs.symlink("../sibling", path.join(root, "docs", "link"));
      await remove(root, "docs");
      expect(existsSync(path.join(root, "docs"))).toBe(false);
      expect(existsSync(path.join(root, "sibling", "inner.txt"))).toBe(true);
    });

    test("revert removes a newly added folder missing from the base", async () => {
      const root = await createRepositoryWithFolder();
      await fs.mkdir(path.join(root, "added"));
      await fs.writeFile(path.join(root, "added", "tracked.txt"), "added");
      await git(root, "add", "added");
      await fs.writeFile(path.join(root, "added", "untracked.txt"), "untracked");
      await fs.writeFile(path.join(root, "added", "ignored.log"), "ignored");
      await revert(root, "added");
      expect(existsSync(path.join(root, "added"))).toBe(false);
      expect(await stagedDeletions(root)).toBe("");
      expect(existsSync(path.join(root, "docs", "tracked.md"))).toBe(true);
    });

    test("revert restores a tracked file from the base", async () => {
      const root = await createRepositoryWithFolder();
      await fs.writeFile(path.join(root, "docs", "tracked.md"), "modified");
      await git(root, "add", "docs/tracked.md");
      await revert(root, "docs/tracked.md");
      expect(await fs.readFile(path.join(root, "docs", "tracked.md"), "utf8")).toBe("tracked\n");
      expect(await stagedDeletions(root)).toBe("");
    });

    test("revert refuses a newly added folder containing a nested repository without mutation", async () => {
      const root = await createRepositoryWithFolder();
      await addNestedRepository(root, "added/vendor");
      await fs.writeFile(path.join(root, "added", "tracked.txt"), "added");
      await git(root, "add", "added/tracked.txt");
      await fs.writeFile(path.join(root, "added", "ignored.log"), "ignored");
      await expect(revert(root, "added")).rejects.toThrow("nested Git repository at added/vendor");
      expect(await fs.readFile(path.join(root, "added", "tracked.txt"), "utf8")).toBe("added");
      expect(existsSync(path.join(root, "added", "ignored.log"))).toBe(true);
      expect(await stagedDeletions(root)).toBe("A\tadded/tracked.txt");
    });
  });
}
