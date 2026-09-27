import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import {
  environmentCleanupLedger,
  type EnvironmentCleanupEntry,
} from "./environment-cleanup-ledger.js";
import {
  buildEnvironmentCleanupEntry,
  cleanupEnvironmentBranch,
  redactCleanupError,
  runEnvironmentCleanupStep,
  type CleanupCommandRunner,
} from "./environment-cleanup.js";
import { environmentStateDirectories } from "./environment-state-paths.js";
import type { Environment } from "./models.js";
import { CommandFailedError, runCommand } from "./shell.js";
import { StorageService } from "./storage.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirectories.push(directory);
  return directory;
}

async function git(projectPath: string, ...args: string[]): Promise<string> {
  return (await runCommand("git", ["-C", projectPath, ...args])).stdout.trim();
}

async function commit(projectPath: string, file: string): Promise<string> {
  await fs.writeFile(path.join(projectPath, file), `${file}\n`);
  await git(projectPath, "add", file);
  await git(projectPath, "commit", "-m", file);
  return git(projectPath, "rev-parse", "HEAD");
}

/** A project with `main` published as `origin/main` and `origin/HEAD`. */
async function project(): Promise<{ projectPath: string; base: string }> {
  const projectPath = await tempDir("ork-cleanup-project-");
  await runCommand("git", ["init", "-b", "main", projectPath]);
  await git(projectPath, "config", "user.name", "Orkestrator Test");
  await git(projectPath, "config", "user.email", "test@example.invalid");
  const base = await commit(projectPath, "README.md");
  await git(projectPath, "update-ref", "refs/remotes/origin/main", base);
  await git(projectPath, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { projectPath, base };
}

/** Creates `branch` from `from` without checking it out anywhere. */
async function branchWithCommits(
  projectPath: string,
  branch: string,
  from: string,
  files: string[],
): Promise<string> {
  await git(projectPath, "checkout", "-q", "-b", branch, from);
  let tip = from;
  for (const file of files) tip = await commit(projectPath, file);
  await git(projectPath, "checkout", "-q", "main");
  return tip;
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  return runCommand("git", ["-C", projectPath, "rev-parse", "--verify", "--quiet", branch]).then(
    () => true,
    () => false,
  );
}

function entry(overrides: Partial<EnvironmentCleanupEntry>): EnvironmentCleanupEntry {
  return {
    version: 1,
    environmentId: "e1",
    recordedAt: new Date(0).toISOString(),
    projectPath: null,
    worktreePath: null,
    branch: null,
    prMerged: false,
    createdFromCommit: null,
    baseBranches: [],
    containerId: null,
    stateDirectories: [],
    pending: [],
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "e1",
    projectId: "p1",
    name: "Environment",
    branch: "feature",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

async function cleanupContext(): Promise<{
  context: CommandContext;
  storage: StorageService;
  dataDir: string;
  worktreeDir: string;
}> {
  const dataDir = await tempDir("ork-cleanup-data-");
  const worktreeDir = await tempDir("ork-cleanup-workspaces-");
  const storage = new StorageService(dataDir);
  await storage.init();
  const context = { storage, worktreeDir, strictDockerOwner: false } as CommandContext;
  return { context, storage, dataDir, worktreeDir };
}

describe("environment cleanup entry", () => {
  test("schedules branch cleanup only for a local environment with a worktree", async () => {
    const dataDir = "/data";
    const local = buildEnvironmentCleanupEntry(
      environment({ worktreePath: "/w/p-feature", prState: "merged", createdFromCommit: "abc" }),
      { localPath: "/project" },
      dataDir,
    );
    expect(local).toMatchObject({
      branch: "feature",
      prMerged: true,
      createdFromCommit: "abc",
      pending: ["worktree", "branch", "state-dirs"],
      stateDirectories: environmentStateDirectories(dataDir, "e1"),
    });

    const container = buildEnvironmentCleanupEntry(
      environment({ environmentType: "containerized", containerId: "c1" }),
      { localPath: "/project" },
      dataDir,
    );
    expect(container).toMatchObject({ branch: null, pending: ["container", "state-dirs"] });
  });

  test("redacts failures to codes and exit statuses", () => {
    expect(
      redactCleanupError(Object.assign(new Error("open /secret/path"), { code: "EACCES" })),
    ).toBe("EACCES");
    expect(redactCleanupError(new Error("git failed with exit code 128: fatal: /secret"))).toBe(
      "exit 128",
    );
    expect(redactCleanupError(new Error("token=abc leaked"))).toBe("Error");
  });
});

describe("environment branch cleanup", () => {
  test("deletes a branch already contained in origin/HEAD", async () => {
    const { projectPath, base } = await project();
    const tip = await branchWithCommits(projectPath, "feature", base, ["a.txt"]);
    await git(projectPath, "update-ref", "refs/remotes/origin/main", tip);

    const outcome = await cleanupEnvironmentBranch(
      entry({ projectPath, branch: "feature", createdFromCommit: base }),
    );
    expect(outcome).toBe("deleted");
    expect(await branchExists(projectPath, "feature")).toBe(false);
  });

  test("deletes a branch with no commits beyond the one it was created from", async () => {
    const { projectPath, base } = await project();
    await git(
      projectPath,
      "update-ref",
      "refs/remotes/origin/main",
      await commit(projectPath, "b.txt"),
    );
    await branchWithCommits(projectPath, "feature", base, []);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "feature", createdFromCommit: base }),
      ),
    ).toBe("deleted");
  });

  test("keeps a branch with unmerged commits", async () => {
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, "feature", base, ["a.txt"]);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "feature", createdFromCommit: base }),
      ),
    ).toBe("kept");
    expect(await branchExists(projectPath, "feature")).toBe(true);
  });

  test("keeps a squash-merged branch without a surviving pushed-tip ref", async () => {
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, "feature", base, ["a.txt"]);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "feature", createdFromCommit: base, prMerged: true }),
      ),
    ).toBe("kept");
    expect(await branchExists(projectPath, "feature")).toBe(true);
  });

  test("keeps a merged-PR branch with extra local commits after its tracking ref was pruned", async () => {
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, "feature", base, ["pushed.txt", "local.txt"]);
    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "feature", createdFromCommit: base, prMerged: true }),
      ),
    ).toBe("kept");
    expect(await branchExists(projectPath, "feature")).toBe(true);
  });

  test("deletes a merged-PR branch whose tip is still reachable from the pushed ref", async () => {
    const { projectPath, base } = await project();
    const tip = await branchWithCommits(projectPath, "feature", base, ["pushed.txt"]);
    await git(projectPath, "update-ref", "refs/remotes/origin/feature", tip);
    expect(
      await cleanupEnvironmentBranch(entry({ projectPath, branch: "feature", prMerged: true })),
    ).toBe("deleted");
    expect(await git(projectPath, "rev-parse", "refs/remotes/origin/feature")).toBe(tip);
  });

  test("keeps a merged-PR branch that has local commits beyond what was pushed", async () => {
    const { projectPath, base } = await project();
    const pushed = await branchWithCommits(projectPath, "feature", base, ["a.txt"]);
    await git(projectPath, "update-ref", "refs/remotes/origin/feature", pushed);
    await git(projectPath, "checkout", "-q", "feature");
    await commit(projectPath, "after-merge.txt");
    await git(projectPath, "checkout", "-q", "main");

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "feature", createdFromCommit: base, prMerged: true }),
      ),
    ).toBe("kept");
  });

  test("keeps a branch that is checked out in a worktree", async () => {
    const { projectPath, base } = await project();
    const parent = await tempDir("ork-cleanup-checkout-");
    await git(projectPath, "worktree", "add", "-q", "-b", "feature", path.join(parent, "wt"), base);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "feature", createdFromCommit: base }),
      ),
    ).toBe("kept");
  });

  test("reports a missing branch as absent", async () => {
    const { projectPath } = await project();
    expect(await cleanupEnvironmentBranch(entry({ projectPath, branch: "gone" }))).toBe("absent");
  });
});

describe("environment cleanup steps", () => {
  test("removes a registered worktree and records completion", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const worktreePath = path.join(worktreeDir, "project-feature");
    await git(projectPath, "worktree", "add", "-q", "-b", "feature", worktreePath, base);
    const cleanup = entry({ projectPath, worktreePath, branch: "feature", pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);

    expect(await runEnvironmentCleanupStep(cleanup, "worktree", context)).toBe(true);
    await expect(fs.stat(worktreePath)).rejects.toThrow();
    expect(await git(projectPath, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
    expect(await environmentCleanupLedger(dataDir).get("e1")).toBeNull();
  });

  test("removes an unregistered leftover inside the workspaces root", async () => {
    const { context, worktreeDir } = await cleanupContext();
    const worktreePath = path.join(worktreeDir, "project-feature");
    // What a build that outlived deletion leaves behind.
    await fs.mkdir(path.join(worktreePath, "bridges", "cursor-bridge", ".turbo"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(worktreePath, "bridges", "cursor-bridge", ".turbo", "turbo-build.log"),
      "late\n",
    );

    expect(
      await runEnvironmentCleanupStep(
        entry({ worktreePath, pending: ["worktree"] }),
        "worktree",
        context,
      ),
    ).toBe(true);
    await expect(fs.stat(worktreePath)).rejects.toThrow();
  });

  test("refuses to delete a worktree directory outside the workspaces root", async () => {
    const { context, dataDir } = await cleanupContext();
    const outside = await tempDir("ork-cleanup-outside-");
    const cleanup = entry({ worktreePath: outside, pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);

    expect(await runEnvironmentCleanupStep(cleanup, "worktree", context)).toBe(false);
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
    expect(await environmentCleanupLedger(dataDir).get("e1")).toMatchObject({
      pending: ["worktree"],
      lastError: "worktree: worktree is outside the workspaces root",
    });
  });

  test("refuses a registered worktree outside the root before asking Git to remove it", async () => {
    const { context, dataDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const outside = path.join(await tempDir("ork-cleanup-outside-"), "worktree");
    await git(projectPath, "worktree", "add", "-q", "-b", "feature", outside, base);
    const cleanup = entry({ projectPath, worktreePath: outside, pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);
    expect(await runEnvironmentCleanupStep(cleanup, "worktree", context)).toBe(false);
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
    expect(await git(projectPath, "worktree", "list", "--porcelain")).toContain(outside);
    expect(await environmentCleanupLedger(dataDir).get("e1")).toMatchObject({
      pending: ["worktree"],
    });
  });

  test("refuses a worktree reached through a symlink inside the root", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const outside = await tempDir("ork-cleanup-symlink-target-");
    const actual = path.join(outside, "worktree");
    await git(projectPath, "worktree", "add", "-q", "-b", "feature", actual, base);
    const link = path.join(worktreeDir, "link");
    await fs.symlink(outside, link, "dir");
    const cleanup = entry({
      projectPath,
      worktreePath: path.join(link, "worktree"),
      pending: ["worktree"],
    });
    await environmentCleanupLedger(dataDir).record(cleanup);
    expect(await runEnvironmentCleanupStep(cleanup, "worktree", context)).toBe(false);
    expect(await fs.stat(actual)).toBeDefined();
    expect(await environmentCleanupLedger(dataDir).get("e1")).toMatchObject({
      pending: ["worktree"],
    });
  });

  test.each(["rev-parse", "worktree"])(
    "keeps the branch step pending when %s fails transiently",
    async (failedCommand) => {
      const { context, dataDir } = await cleanupContext();
      const { projectPath, base } = await project();
      await branchWithCommits(projectPath, "feature", base, []);
      const cleanup = entry({ projectPath, branch: "feature", pending: ["branch"] });
      await environmentCleanupLedger(dataDir).record(cleanup);
      const run: CleanupCommandRunner = async (command, args, options) => {
        if (command === "git" && args[2] === failedCommand) {
          throw new CommandFailedError("locked", { exitCode: 128 });
        }
        return runCommand(command, args, options);
      };
      expect(await runEnvironmentCleanupStep(cleanup, "branch", context, { run })).toBe(false);
      expect(await branchExists(projectPath, "feature")).toBe(true);
      expect(await environmentCleanupLedger(dataDir).get("e1")).toMatchObject({
        pending: ["branch"],
      });
    },
  );

  test("leaves a path that a live environment now owns", async () => {
    const { context, storage, worktreeDir } = await cleanupContext();
    const worktreePath = path.join(worktreeDir, "project-feature");
    await fs.mkdir(worktreePath);
    await storage.addEnvironment(environment({ id: "e2", worktreePath }));

    expect(
      await runEnvironmentCleanupStep(
        entry({ worktreePath, pending: ["worktree"] }),
        "worktree",
        context,
      ),
    ).toBe(true);
    expect((await fs.stat(worktreePath)).isDirectory()).toBe(true);
  });

  test("removes bridge state directories and refuses paths outside the data directory", async () => {
    const { context, dataDir } = await cleanupContext();
    const directories = environmentStateDirectories(dataDir, "e1");
    for (const directory of directories) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "checkpoints.ndjson"), "{}\n");
    }
    expect(
      await runEnvironmentCleanupStep(
        entry({ stateDirectories: directories, pending: ["state-dirs"] }),
        "state-dirs",
        context,
      ),
    ).toBe(true);
    for (const directory of directories) await expect(fs.stat(directory)).rejects.toThrow();

    const outside = await tempDir("ork-cleanup-foreign-state-");
    expect(
      await runEnvironmentCleanupStep(
        entry({ stateDirectories: [outside], pending: ["state-dirs"] }),
        "state-dirs",
        context,
      ),
    ).toBe(false);
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
  });

  test("treats a container the daemon no longer knows as removed", async () => {
    const { context } = await cleanupContext();
    const calls: string[][] = [];
    const run: CleanupCommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      throw new Error("Error response from daemon: No such container: c1");
    };
    expect(
      await runEnvironmentCleanupStep(
        entry({ containerId: "c1", pending: ["container"] }),
        "container",
        context,
        { run },
      ),
    ).toBe(true);
    expect(calls).toEqual([["docker", "rm", "-f", "c1"]]);
  });

  test("keeps the container step pending when the daemon fails", async () => {
    const { context, dataDir } = await cleanupContext();
    const cleanup = entry({ containerId: "c1", pending: ["container"] });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const run: CleanupCommandRunner = async () => {
      throw new Error("Cannot connect to the Docker daemon (exit 1)");
    };
    expect(await runEnvironmentCleanupStep(cleanup, "container", context, { run })).toBe(false);
    expect(await environmentCleanupLedger(dataDir).get("e1")).toMatchObject({
      pending: ["container"],
      lastError: "container: exit 1",
    });
  });
});
