import { afterEach, describe, expect, test, mock, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcileContainerDelegationBase } from "./commands-environment.js";
import { enableGitScanCaches, getLocalGitStatusDetailed } from "./commands-files.js";
import {
  SCRATCH_COMMIT_AUTHOR,
  SCRATCH_COMMIT_EMAIL,
  SCRATCH_COMMIT_SUBJECT,
  isResumableScratchRepository,
} from "./commands-projects.js";
import {
  GIT_FSMONITOR_DISABLED_ARGS,
  removeLegacyWorktreeFsmonitor,
  resetLegacyFsmonitorMigrationsForTests,
  retryGitWithoutFsmonitorOnTimeout,
  runGitWithFsmonitorFallback,
  stopGitFsmonitorDaemon,
} from "./git-fsmonitor.js";
import { CommandFailedError, runCommand } from "./shell.js";
import * as shell from "./shell.js";
import { StorageService, createProject } from "./storage.js";
import { ProjectGitService } from "./project-git-service.js";
import { listRootChanges } from "./root-changes.js";
import { readWorktreeStatus } from "./workspace-code-rewind.js";

const tempDirectories: string[] = [];

/**
 * Whether this git ships the builtin daemon. It is a build feature, not a
 * platform one: macOS and Windows have had it since 2.36, and Linux builds
 * have it too (git 2.56.0 on Linux reports it).
 */
const daemonSupported = (
  await runCommand("git", ["version", "--build-options"], { timeoutMs: 10_000 })
).stdout.includes("feature: fsmonitor--daemon");

afterEach(async () => {
  mock.restore();
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

    await removeLegacyWorktreeFsmonitor(worktree, true);

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

    await removeLegacyWorktreeFsmonitor(project, true);
    await removeLegacyWorktreeFsmonitor(worktree, true);

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

    await removeLegacyWorktreeFsmonitor(worktree, true);

    await expect(readConfig(path.join(project, ".git", "config"), "core.fsmonitor")).resolves.toBe(
      "true",
    );
  });

  test("a linked project-home scan preserves the user's setting and daemon", async () => {
    const { project, worktree } = await createRepositoryWithWorktree();
    await git(worktree, ["config", "extensions.worktreeConfig", "true"]);
    await git(worktree, ["config", "--worktree", "core.fsmonitor", "true"]);
    if (daemonSupported) await git(worktree, ["fsmonitor--daemon", "start"]);
    const original = shell.runCommand;
    const calls: string[][] = [];
    spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
      calls.push(args);
      return original(command, args, options);
    });
    try {
      await getLocalGitStatusDetailed(worktree, "main", true, {
        ensureFetched: async () => undefined,
      });
      await expect(
        readConfig(path.join(project, ".git/worktrees/worktree/config.worktree"), "core.fsmonitor"),
      ).resolves.toBe("true");
      expect(calls.some((args) => args.includes("stop"))).toBe(false);
      if (daemonSupported) {
        await expect(git(worktree, ["fsmonitor--daemon", "status"])).resolves.toContain(
          "is watching",
        );
      }
    } finally {
      await stopGitFsmonitorDaemon(worktree);
    }
  });

  test("migration stops the daemon and concurrent/later scans migrate only once", async () => {
    const { worktree } = await createRepositoryWithWorktree();
    await git(worktree, ["config", "extensions.worktreeConfig", "true"]);
    await git(worktree, ["config", "--worktree", "core.fsmonitor", "true"]);
    if (daemonSupported) await git(worktree, ["fsmonitor--daemon", "start"]);
    const original = shell.runCommand;
    const calls: string[][] = [];
    spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
      calls.push(args);
      return original(command, args, options);
    });
    try {
      const first = removeLegacyWorktreeFsmonitor(worktree, true);
      expect(removeLegacyWorktreeFsmonitor(worktree, true)).toBe(first);
      await first;
      await removeLegacyWorktreeFsmonitor(worktree, true);
      expect(calls.filter((args) => args.includes("rev-parse"))).toHaveLength(1);
      expect(calls.filter((args) => args.includes("stop"))).toHaveLength(1);
      if (daemonSupported) {
        await expect(git(worktree, ["fsmonitor--daemon", "status"])).rejects.toThrow();
      }
    } finally {
      await stopGitFsmonitorDaemon(worktree);
    }
  });

  for (const failingArgument of ["rev-parse", "--get", "--unset"]) {
    test(`a scan retries migration after a transient ${failingArgument} failure`, async () => {
      const { project, worktree } = await createRepositoryWithWorktree();
      await git(worktree, ["config", "extensions.worktreeConfig", "true"]);
      await git(worktree, ["config", "--worktree", "core.fsmonitor", "true"]);
      const original = shell.runCommand;
      let attempts = 0;
      spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
        if (
          args.includes(failingArgument) &&
          (failingArgument !== "rev-parse" || args.includes("--git-common-dir")) &&
          attempts++ === 0
        ) {
          throw new CommandFailedError("transient config failure", { exitCode: 128 });
        }
        return original(command, args, options);
      });
      const scan = () =>
        getLocalGitStatusDetailed(
          worktree,
          "main",
          true,
          {
            ensureFetched: async () => undefined,
          },
          true,
        );
      await scan();
      const config = path.join(project, ".git/worktrees/worktree/config.worktree");
      await expect(readConfig(config, "core.fsmonitor")).resolves.toBe("true");
      await scan();
      await expect(readConfig(config, "core.fsmonitor")).resolves.toBe("");
      expect(attempts).toBeGreaterThanOrEqual(2);
    });
  }

  test("local status scans retry all timed-out status/diff reads with fsmonitor disabled", async () => {
    const { worktree } = await createRepositoryWithWorktree();
    await fs.writeFile(path.join(worktree, "new.txt"), "new\n");
    const original = shell.runCommand;
    const reads: string[][] = [];
    spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
      if (args.includes("diff") || args.includes("status")) {
        reads.push(args);
        if (!args.includes("core.fsmonitor=false")) {
          throw new CommandFailedError("hung fsmonitor", { timedOut: true });
        }
      }
      return original(command, args, options);
    });
    const status = await getLocalGitStatusDetailed(worktree, "main", true, {
      ensureFetched: async () => undefined,
    });
    expect(status.changes).toMatchObject([{ path: "new.txt", status: "?" }]);
    expect(reads).toHaveLength(6);
    for (const args of reads.slice(0, 3)) {
      expect(reads).toContainEqual([...GIT_FSMONITOR_DISABLED_ARGS, ...args]);
    }
  });

  test("project-home toolbar status retries a timeout with fsmonitor disabled", async () => {
    const { project } = await createRepositoryWithWorktree();
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "ork-fsmonitor-data-"));
    tempDirectories.push(data);
    const storage = new StorageService(data);
    await storage.init();
    const record = await storage.addProject(createProject("remote", project));
    const original = shell.runCommand;
    const calls: string[][] = [];
    spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
      if (args.includes("status")) {
        calls.push(args);
        if (calls.length === 1) throw new CommandFailedError("timeout", { timedOut: true });
      }
      return original(command, args, options);
    });
    const status = await new ProjectGitService(storage).status(record.id);
    expect(status.branch).toBe("main");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([...GIT_FSMONITOR_DISABLED_ARGS, ...calls[0]!]);
  });

  test("a failed second read is returned without another retry", async () => {
    const failure = new CommandFailedError("second timeout", { timedOut: true });
    let calls = 0;
    await expect(
      retryGitWithoutFsmonitorOnTimeout(["status"], async () => {
        calls++;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(2);
  });

  test("cancellation does not start a fallback read", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const run = spyOn(shell, "runCommand").mockImplementation(async () => {
      controller.abort(reason);
      throw new CommandFailedError("cancelled", { timedOut: true });
    });
    await expect(
      runGitWithFsmonitorFallback(["status"], { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(run).toHaveBeenCalledTimes(1);
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

  test.skipIf(!daemonSupported)("stops a running daemon", async () => {
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

  test("an aborted read is not retried, even when it reports a timeout", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const calls: string[][] = [];
    await expect(
      retryGitWithoutFsmonitorOnTimeout(
        ["status"],
        async (args) => {
          calls.push(args);
          controller.abort(reason);
          throw new CommandFailedError("cancelled", { timedOut: true });
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(calls).toEqual([["status"]]);
  });
});

describe("working-tree status reads retry without fsmonitor after a timeout", () => {
  const timeoutOnce = () => {
    let timedOut = false;
    return (args: readonly string[]) => {
      if (args.includes("status") && !args.includes("core.fsmonitor=false") && !timedOut) {
        timedOut = true;
        throw new CommandFailedError("hung fsmonitor", { timedOut: true });
      }
    };
  };

  test("code rewind's environment status read", async () => {
    const calls: string[][] = [];
    const failFirst = timeoutOnce();
    const status = await readWorktreeStatus(async (environmentId, args) => {
      expect(environmentId).toBe("env-1");
      calls.push(args);
      failFirst(args);
      return " M file.txt\n";
    }, "env-1");
    expect(status).toBe(" M file.txt\n");
    expect(calls).toEqual([
      ["status", "--porcelain", "--untracked-files=all"],
      [...GIT_FSMONITOR_DISABLED_ARGS, "status", "--porcelain", "--untracked-files=all"],
    ]);
  });

  test("the project home's change list", async () => {
    const { project } = await createRepositoryWithWorktree();
    await fs.writeFile(path.join(project, "new.txt"), "new\n");
    const original = shell.runCommand;
    const failFirst = timeoutOnce();
    const reads: string[][] = [];
    spyOn(shell, "runCommand").mockImplementation(async (command, args = [], options) => {
      if (args.includes("status")) reads.push(args);
      failFirst(args);
      return original(command, args, options);
    });
    const listing = await listRootChanges(project);
    expect(listing.files).toMatchObject([{ path: "new.txt" }]);
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual([...GIT_FSMONITOR_DISABLED_ARGS, ...reads[0]!]);
  });

  test("the scratch-repository resume check", async () => {
    const calls: string[][] = [];
    const failFirst = timeoutOnce();
    const stdout: Record<string, string> = {
      "rev-list": "1",
      "symbolic-ref": "main",
      remote: "",
      status: "",
      log: [SCRATCH_COMMIT_AUTHOR, SCRATCH_COMMIT_EMAIL, SCRATCH_COMMIT_SUBJECT].join("\n"),
    };
    const resumable = await isResumableScratchRepository(
      "/scratch",
      async (_command, args = []) => {
        calls.push(args);
        failFirst(args);
        const key = Object.keys(stdout).find((name) => args.includes(name));
        return { stdout: key ? stdout[key]! : "", stderr: "" };
      },
    );
    expect(resumable).toBe(true);
    expect(calls).toContainEqual([
      "-C",
      "/scratch",
      ...GIT_FSMONITOR_DISABLED_ARGS,
      "status",
      "--porcelain",
    ]);
  });

  test("the delegated container's cleanliness check", async () => {
    const calls: string[][] = [];
    const failFirst = timeoutOnce();
    await expect(
      reconcileContainerDelegationBase(
        { branch: "delegated", delegationBaseCommit: "abc123" },
        "container-1",
        async (_command, args) => {
          calls.push(args);
          failFirst(args);
          return { stdout: args.includes("status") ? " M file.txt" : "other", stderr: "" };
        },
      ),
    ).rejects.toThrow("worker checkout has changes");
    expect(calls.filter((args) => args.includes("status"))).toEqual([
      ["exec", "container-1", "git", "-C", "/workspace", "status", "--porcelain"],
      [
        "exec",
        "container-1",
        "git",
        "-C",
        "/workspace",
        ...GIT_FSMONITOR_DISABLED_ARGS,
        "status",
        "--porcelain",
      ],
    ]);
  });
});
