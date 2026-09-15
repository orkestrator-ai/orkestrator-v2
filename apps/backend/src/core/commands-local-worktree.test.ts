import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeLocalWorktree } from "./commands-environment.js";
import { runCommand } from "./shell.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("local worktree removal", () => {
  test("prunes a registered worktree whose directory disappeared", async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-project-"));
    const worktreeParent = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-parent-"));
    tempDirectories.push(projectPath, worktreeParent);
    const worktreePath = path.join(worktreeParent, "missing");

    await runCommand("git", ["init", projectPath]);
    await runCommand("git", ["-C", projectPath, "config", "user.name", "Orkestrator Test"]);
    await runCommand("git", ["-C", projectPath, "config", "user.email", "test@example.invalid"]);
    await fs.writeFile(path.join(projectPath, "README.md"), "test\n");
    await runCommand("git", ["-C", projectPath, "add", "README.md"]);
    await runCommand("git", ["-C", projectPath, "commit", "-m", "initial"]);
    await runCommand("git", ["-C", projectPath, "worktree", "add", "-b", "missing", worktreePath]);
    await fs.rm(worktreePath, { recursive: true, force: true });

    await removeLocalWorktree(projectPath, worktreePath);

    const { stdout } = await runCommand("git", [
      "-C",
      projectPath,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(stdout).not.toContain(worktreePath);
  });
});
