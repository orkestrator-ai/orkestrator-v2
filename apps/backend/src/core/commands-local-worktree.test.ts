import { afterEach, describe, expect, test, mock, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeLocalWorktree, cleanupFailedLocalWorktree } from "./commands-environment.js";
import { runCommand } from "./shell.js";
import * as shell from "./shell.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  mock.restore();
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

for (const cleanup of [false, true]) {
  for (const missing of [false, true]) {
    test(`${cleanup ? "failed creation cleanup" : "removal"} stops daemon before deleting (${missing ? "missing" : "present"})`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-worktree-stop-"));
      tempDirectories.push(root);
      const worktree = path.join(root, "worktree");
      if (!missing) await fs.mkdir(worktree);
      const calls: string[][] = [];
      spyOn(shell, "runCommand").mockImplementation(async (_command, args = []) => {
        calls.push(args);
        if (args.includes("fsmonitor--daemon")) {
          expect(await fs.stat(worktree)).toBeDefined();
          // Even a failed stop request must not block removal.
          throw new Error("daemon unavailable");
        }
        if (args.includes("remove")) await fs.rm(worktree, { recursive: true, force: true });
        return { stdout: "", stderr: "" };
      });
      if (cleanup) await cleanupFailedLocalWorktree(root, worktree, "feature");
      else await removeLocalWorktree(root, worktree);
      const stop = ["-C", worktree, "-c", "core.fsmonitor=false", "fsmonitor--daemon", "stop"];
      expect(calls[0]).toEqual(
        missing ? ["-C", root, "worktree", "remove", "--force", worktree] : stop,
      );
      expect(calls.filter((args) => args.includes("stop"))).toHaveLength(missing ? 0 : 1);
      expect(calls.some((args) => args.includes("remove"))).toBe(true);
      expect(calls.some((args) => args.includes("-D"))).toBe(cleanup);
    });
  }
}
