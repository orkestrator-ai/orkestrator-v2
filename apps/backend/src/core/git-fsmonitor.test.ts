import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { enableGitScanCaches } from "./commands-files.js";
import {
  GIT_FSMONITOR_DISABLED_ARGS,
  removeLegacyWorktreeFsmonitor,
  resetLegacyFsmonitorMigrationsForTests,
  retryGitWithoutFsmonitorOnTimeout,
  stopGitFsmonitorDaemon,
} from "./git-fsmonitor.js";
import { CommandFailedError, runCommand } from "./shell.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  resetLegacyFsmonitorMigrationsForTests();
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommand("git", ["-C", cwd, ...args], { timeoutMs: 30_000 })).stdout.trim();
}

async function readConfig(file: string, key: string): Promise<string> {
  return runCommand("git", ["config", "--file", file, "--get", key], { timeoutMs: 10_000 }).then(
    (result) => result.stdout.trim(),
    () => "",
  );
}

/** A repository with one commit and one linked worktree. */
async function createRepositoryWithWorktree(): Promise<{ project: string; worktree: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-fsmonitor-"));
  tempDirectories.push(root);
  const project = path.join(root, "project");
  const worktree = path.join(root, "worktree");
  await runCommand("git", ["init", "-q", "-b", "main", project]);
  await git(project, ["config", "user.name", "Orkestrator Test"]);
  await git(project, ["config", "user.email", "test@example.invalid"]);
  await git(project, ["commit", "-q", "--allow-empty", "-m", "initial"]);
  await git(project, ["worktree", "add", "-q", "-b", "feature", worktree]);
  return { project, worktree };
}

describe("git fsmonitor", () => {
  test("fixture repositories inherit fsmonitor off from the test preload", async () => {
    const { worktree } = await createRepositoryWithWorktree();

    await expect(git(worktree, ["config", "--get", "core.fsmonitor"])).resolves.toBe("false");
  });

  test("scan caches turn on the untracked cache and never fsmonitor", async () => {
    const { project, worktree } = await createRepositoryWithWorktree();

    await enableGitScanCaches(worktree);

    const worktreeConfig = await git(worktree, ["rev-parse", "--git-path", "config.worktree"]);
    const configFile = path.resolve(worktree, worktreeConfig);
    await expect(readConfig(configFile, "core.untrackedCache")).resolves.toBe("true");
    await expect(readConfig(configFile, "core.fsmonitor")).resolves.toBe("");
    await expect(readConfig(path.join(project, ".git", "config"), "core.fsmonitor")).resolves.toBe(
      "",
    );
  });

  test("removes the fsmonitor setting an older version wrote to a linked worktree", async () => {
    const { project, worktree } = await createRepositoryWithWorktree();
    await git(worktree, ["config", "extensions.worktreeConfig", "true"]);
    await git(worktree, ["config", "--worktree", "core.untrackedCache", "true"]);
    await git(worktree, ["config", "--worktree", "core.fsmonitor", "true"]);
    // The user's own shared setting is not ours to change.
    await git(project, ["config", "core.fsmonitor", "true"]);

    await removeLegacyWorktreeFsmonitor(worktree);

    const configFile = path.join(project, ".git", "worktrees", "worktree", "config.worktree");
    await expect(readConfig(configFile, "core.fsmonitor")).resolves.toBe("");
    await expect(readConfig(configFile, "core.untrackedCache")).resolves.toBe("true");
    await expect(readConfig(path.join(project, ".git", "config"), "core.fsmonitor")).resolves.toBe(
      "true",
    );
  });

  test("leaves a main checkout and a user's own value alone", async () => {
    const { project, worktree } = await createRepositoryWithWorktree();
    await git(project, ["config", "extensions.worktreeConfig", "true"]);
    await git(project, ["config", "--worktree", "core.fsmonitor", "true"]);
    await git(worktree, ["config", "--worktree", "core.fsmonitor", "false"]);

    await removeLegacyWorktreeFsmonitor(project);
    await removeLegacyWorktreeFsmonitor(worktree);

    await expect(
      readConfig(path.join(project, ".git", "config.worktree"), "core.fsmonitor"),
    ).resolves.toBe("true");
    await expect(
      readConfig(
        path.join(project, ".git", "worktrees", "worktree", "config.worktree"),
        "core.fsmonitor",
      ),
    ).resolves.toBe("false");
  });

  test("does not touch the shared config when per-worktree config is off", async () => {
    const { project, worktree } = await createRepositoryWithWorktree();
    await git(project, ["config", "core.fsmonitor", "true"]);

    await removeLegacyWorktreeFsmonitor(worktree);

    await expect(readConfig(path.join(project, ".git", "config"), "core.fsmonitor")).resolves.toBe(
      "true",
    );
  });

  test("stopping a daemon that is not running is a quiet no-op", async () => {
    const { worktree } = await createRepositoryWithWorktree();
    const calls: string[][] = [];

    await expect(
      stopGitFsmonitorDaemon(worktree, async (command, args, options) => {
        calls.push([command, ...args]);
        return runCommand(command, args, options);
      }),
    ).resolves.toBeUndefined();
    await expect(stopGitFsmonitorDaemon(path.join(worktree, "missing"))).resolves.toBeUndefined();

    // The stop request itself must not be able to start a daemon.
    expect(calls).toEqual([
      ["git", "-C", worktree, ...GIT_FSMONITOR_DISABLED_ARGS, "fsmonitor--daemon", "stop"],
    ]);
  });

  // Git ships the builtin daemon on macOS and Windows only.
  test.skipIf(process.platform === "linux")("stops a running daemon", async () => {
    const { worktree } = await createRepositoryWithWorktree();
    await git(worktree, ["fsmonitor--daemon", "start"]);
    try {
      await expect(git(worktree, ["fsmonitor--daemon", "status"])).resolves.toContain(
        "is watching",
      );

      await stopGitFsmonitorDaemon(worktree);

      await expect(git(worktree, ["fsmonitor--daemon", "status"])).rejects.toThrow();
    } finally {
      await runCommand("git", ["-C", worktree, "fsmonitor--daemon", "stop"]).catch(() => undefined);
    }
  });

  test("retries a timed-out read once without fsmonitor", async () => {
    const calls: string[][] = [];
    const result = await retryGitWithoutFsmonitorOnTimeout(["status"], async (args) => {
      calls.push(args);
      if (calls.length === 1) throw new CommandFailedError("timed out", { timedOut: true });
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toEqual([["status"], [...GIT_FSMONITOR_DISABLED_ARGS, "status"]]);
  });

  test("does not retry a read that failed for another reason", async () => {
    const calls: string[][] = [];
    const failure = new CommandFailedError("fatal: not a git repository", { exitCode: 128 });

    await expect(
      retryGitWithoutFsmonitorOnTimeout(["status"], async (args) => {
        calls.push(args);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });
});
