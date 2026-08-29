import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateLoopedReviewPackage } from "./commands-review.js";
import { StorageService } from "./storage.js";

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(await new Response(process.stderr).text());
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("generateLoopedReviewPackage", () => {
  test("fails closed when tracked or untracked changes remain outside the package", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-review-package-"));
    temporaryDirectories.push(root);
    const worktree = path.join(root, "worktree");
    await fs.mkdir(worktree);
    await git(worktree, "init", "--initial-branch=main");
    await git(worktree, "config", "user.email", "test@example.com");
    await git(worktree, "config", "user.name", "Test User");
    await fs.writeFile(path.join(worktree, "tracked.txt"), "committed\n");
    await git(worktree, "add", "tracked.txt");
    await git(worktree, "commit", "-m", "feat: base");
    await git(worktree, "update-ref", "refs/remotes/origin/main", "HEAD");
    await fs.writeFile(path.join(worktree, "tracked.txt"), "modified\n");
    await fs.writeFile(path.join(worktree, "untracked.txt"), "new\n");

    const storage = new StorageService(path.join(root, "data"));
    await storage.init();
    await storage.addEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "review",
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: worktree,
      setupScriptsComplete: true,
    });

    await expect(
      generateLoopedReviewPackage(
        "env-1",
        "package-1",
        1,
        "main",
        [],
        [
          { path: "tracked.txt", reason: "Left behind." },
          { path: "untracked.txt", reason: "Left behind." },
        ],
        ["The worktree is not clean."],
        { storage } as never,
      ),
    ).rejects.toThrow("requires a clean worktree");
  });
});
