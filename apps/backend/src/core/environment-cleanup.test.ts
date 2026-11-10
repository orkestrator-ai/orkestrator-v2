import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import type { CommandContext } from "./commands-context.js";
import {
  closeEnvironmentCleanupStorage,
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
import { dockerOwnerNamespace } from "./docker-ownership.js";

/** A UUID environment id and the branch created for it (its namespace is `e1a2b3c4d5e6`). */
const ENV_ID = "e1a2b3c4-d5e6-4f70-8899-aabbccddeeff";
const BRANCH = "feature-e1a2b3c4d5e6";

const tempDirectories: string[] = [];

afterEach(async () => {
  closeEnvironmentCleanupStorage();
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
    environmentId: ENV_ID,
    recordedAt: new Date(0).toISOString(),
    projectPath: null,
    worktreePath: null,
    branch: null,
    prMerged: false,
    createdFromCommit: null,
    baseBranches: [],
    containerId: null,
    retainedContainers: [],
    volumes: [],
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
    id: ENV_ID,
    projectId: "p1",
    name: "Environment",
    branch: BRANCH,
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
      branch: BRANCH,
      worktreeRoot: null,
      prMerged: true,
      createdFromCommit: "abc",
      pending: ["worktree", "branch", "state-dirs"],
      stateDirectories: environmentStateDirectories(dataDir, ENV_ID),
    });

    const container = buildEnvironmentCleanupEntry(
      environment({ environmentType: "containerized", containerId: "c1" }),
      { localPath: "/project" },
      dataDir,
    );
    expect(container).toMatchObject({
      branch: null,
      pending: ["container", "network", "state-dirs"],
    });
  });

  test("records the folder a worktree was created in", () => {
    const cleanup = buildEnvironmentCleanupEntry(
      environment({ worktreePath: "/chosen/p-feature", worktreeBaseDir: "/chosen" }),
      { localPath: "/project" },
      "/data",
    );
    expect(cleanup).toMatchObject({ worktreePath: "/chosen/p-feature", worktreeRoot: "/chosen" });
  });

  test("never schedules a branch the environment did not create", () => {
    for (const branch of ["dev", "main", "feature-0123456789ab", "release/2026-11"]) {
      const cleanup = buildEnvironmentCleanupEntry(
        environment({ branch, worktreePath: "/workspaces/p-x" }),
        { localPath: "/project" },
        "/data",
      );
      expect(cleanup.branch).toBeNull();
      expect(cleanup.pending).toEqual(["worktree", "state-dirs"]);
    }
  });

  test("never schedules the project checkout or its branch for a project home", () => {
    const dataDir = "/data";
    const entry = buildEnvironmentCleanupEntry(
      environment({ projectHome: true, worktreePath: "/project", branch: "main" }),
      { localPath: "/project" },
      dataDir,
    );
    expect(entry).toMatchObject({
      worktreePath: null,
      branch: null,
      pending: ["state-dirs"],
    });
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
    const tip = await branchWithCommits(projectPath, BRANCH, base, ["a.txt"]);
    await git(projectPath, "update-ref", "refs/remotes/origin/main", tip);

    const outcome = await cleanupEnvironmentBranch(
      entry({ projectPath, branch: BRANCH, createdFromCommit: base }),
    );
    expect(outcome).toBe("deleted");
    expect(await branchExists(projectPath, BRANCH)).toBe(false);
  });

  test("deletes a branch with no commits beyond the one it was created from", async () => {
    const { projectPath, base } = await project();
    await git(
      projectPath,
      "update-ref",
      "refs/remotes/origin/main",
      await commit(projectPath, "b.txt"),
    );
    await branchWithCommits(projectPath, BRANCH, base, []);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: BRANCH, createdFromCommit: base }),
      ),
    ).toBe("deleted");
  });

  test("keeps a branch with unmerged commits", async () => {
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, BRANCH, base, ["a.txt"]);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: BRANCH, createdFromCommit: base }),
      ),
    ).toBe("kept");
    expect(await branchExists(projectPath, BRANCH)).toBe(true);
  });

  test("keeps a squash-merged branch without a surviving pushed-tip ref", async () => {
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, BRANCH, base, ["a.txt"]);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: BRANCH, createdFromCommit: base, prMerged: true }),
      ),
    ).toBe("kept");
    expect(await branchExists(projectPath, BRANCH)).toBe(true);
  });

  test("keeps a merged-PR branch with extra local commits after its tracking ref was pruned", async () => {
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, BRANCH, base, ["pushed.txt", "local.txt"]);
    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: BRANCH, createdFromCommit: base, prMerged: true }),
      ),
    ).toBe("kept");
    expect(await branchExists(projectPath, BRANCH)).toBe(true);
  });

  test("deletes a merged-PR branch whose tip is still reachable from the pushed ref", async () => {
    const { projectPath, base } = await project();
    const tip = await branchWithCommits(projectPath, BRANCH, base, ["pushed.txt"]);
    await git(projectPath, "update-ref", `refs/remotes/origin/${BRANCH}`, tip);
    expect(
      await cleanupEnvironmentBranch(entry({ projectPath, branch: BRANCH, prMerged: true })),
    ).toBe("deleted");
    expect(await git(projectPath, "rev-parse", `refs/remotes/origin/${BRANCH}`)).toBe(tip);
  });

  test("keeps a merged-PR branch that has local commits beyond what was pushed", async () => {
    const { projectPath, base } = await project();
    const pushed = await branchWithCommits(projectPath, BRANCH, base, ["a.txt"]);
    await git(projectPath, "update-ref", `refs/remotes/origin/${BRANCH}`, pushed);
    await git(projectPath, "checkout", "-q", BRANCH);
    await commit(projectPath, "after-merge.txt");
    await git(projectPath, "checkout", "-q", "main");

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: BRANCH, createdFromCommit: base, prMerged: true }),
      ),
    ).toBe("kept");
  });

  test("keeps a branch that is checked out in a worktree", async () => {
    const { projectPath, base } = await project();
    const parent = await tempDir("ork-cleanup-checkout-");
    await git(projectPath, "worktree", "add", "-q", "-b", BRANCH, path.join(parent, "wt"), base);

    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: BRANCH, createdFromCommit: base }),
      ),
    ).toBe("kept");
  });

  test("keeps a fully merged branch that is not the environment's own", async () => {
    const { projectPath, base } = await project();
    await git(projectPath, "branch", "dev", base);
    await git(projectPath, "update-ref", "refs/remotes/origin/main", base);

    // An entry recorded by an older backend may still name a base branch, and
    // the orphan sweep may pass a namespace that is not the branch's own.
    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "dev", createdFromCommit: base }),
      ),
    ).toBe("kept");
    await branchWithCommits(projectPath, "other-0123456789ab", base, []);
    expect(
      await cleanupEnvironmentBranch(
        entry({ projectPath, branch: "other-0123456789ab", createdFromCommit: base }),
      ),
    ).toBe("kept");
    expect(await branchExists(projectPath, "dev")).toBe(true);
    expect(await branchExists(projectPath, "other-0123456789ab")).toBe(true);
  });

  test("reports a missing branch as absent", async () => {
    const { projectPath } = await project();
    expect(
      await cleanupEnvironmentBranch(entry({ projectPath, branch: "gone-e1a2b3c4d5e6" })),
    ).toBe("absent");
  });
});

describe("environment cleanup steps", () => {
  test("logs a kept branch once, though a step can run again", async () => {
    const { context, dataDir } = await cleanupContext();
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, BRANCH, base, ["a.txt"]);
    const cleanup = entry({
      environmentId: "env-kept-branch",
      projectPath,
      branch: BRANCH,
      createdFromCommit: base,
      pending: ["branch"],
    });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const logs = captureLogs();
    try {
      expect(await runEnvironmentCleanupStep(cleanup, "branch", context)).toBe(true);
      expect(await runEnvironmentCleanupStep(cleanup, "branch", context)).toBe(true);
      // Only this cleanup's own records: the capture is process-wide, and a
      // CI run once caught an unrelated warning from outside the step
      // (Tests (backend), PR #2034).
      const own = logs.outputs.filter((output) => {
        const fields = output.record?.fields as Record<string, unknown> | undefined;
        return fields?.scope === "env-kept-branch" || fields?.environmentId === "env-kept-branch";
      });
      expect(own.map((output) => output.method)).toEqual(["info"]);
      expect(own[0]!.record).toMatchObject({
        area: "environment",
        event: "cleanup.branch-kept",
        fields: { scope: "env-kept-branch" },
      });
    } finally {
      logs.restore();
    }
  });

  test("513 kept-branch notices do not consume shared fault keys", async () => {
    const { context, dataDir } = await cleanupContext();
    const { projectPath } = await project();
    const logs = captureLogs();
    try {
      for (let n = 0; n < 513; n += 1) {
        const cleanup = entry({
          environmentId: `kept-${n}`,
          projectPath,
          branch: "invalid..ref",
          pending: ["branch"],
        });
        await environmentCleanupLedger(dataDir).record(cleanup);
        expect(await runEnvironmentCleanupStep(cleanup, "branch", context)).toBe(true);
      }
      expect(logs.records()).toHaveLength(513);
      expect(logs.records().every((record) => record.event === "cleanup.branch-kept")).toBe(true);
    } finally {
      logs.restore();
    }
  });

  test("removes a registered worktree and records completion", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const worktreePath = path.join(worktreeDir, "project-feature");
    await git(projectPath, "worktree", "add", "-q", "-b", BRANCH, worktreePath, base);
    const cleanup = entry({ projectPath, worktreePath, branch: BRANCH, pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);

    expect(await runEnvironmentCleanupStep(cleanup, "worktree", context)).toBe(true);
    await expect(fs.stat(worktreePath)).rejects.toThrow();
    expect(await git(projectPath, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
    expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toBeNull();
  });

  test("a signalled step starts no command and stays pending", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const worktreePath = path.join(worktreeDir, "project-feature");
    await fs.mkdir(worktreePath, { recursive: true });
    const cleanup = entry({ worktreePath, pending: ["container", "worktree"], containerId: "c1" });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const calls: string[][] = [];
    const controller = new AbortController();
    controller.abort();
    for (const step of ["container", "worktree"] as const) {
      expect(
        await runEnvironmentCleanupStep(cleanup, step, context, {
          containerOwnershipVerified: true,
          run: async (command, args) => {
            calls.push([command, ...args]);
            return { stdout: "", stderr: "" };
          },
          signal: controller.signal,
        }),
      ).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(await fs.stat(worktreePath)).toBeTruthy();
    expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toMatchObject({
      pending: ["container", "worktree"],
    });
  });

  test("a step's signal reaches every command it runs", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const worktreePath = path.join(worktreeDir, "project-feature");
    await fs.mkdir(worktreePath, { recursive: true });
    const cleanup = entry({ worktreePath, pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    expect(
      await runEnvironmentCleanupStep(cleanup, "worktree", context, {
        run: async (_command, _args, options) => {
          signals.push(options.signal);
          return { stdout: "", stderr: "" };
        },
        signal: controller.signal,
      }),
    ).toBe(true);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  test("stops the worktree's fsmonitor daemon before removing it", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const worktreePath = path.join(worktreeDir, "project-feature");
    await git(projectPath, "worktree", "add", "-q", "-b", BRANCH, worktreePath, base);
    const cleanup = entry({ projectPath, worktreePath, branch: BRANCH, pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const calls: string[][] = [];

    expect(
      await runEnvironmentCleanupStep(cleanup, "worktree", context, {
        run: async (command, args, options) => {
          calls.push([command, ...args]);
          return runCommand(command, args, options);
        },
      }),
    ).toBe(true);

    const stop = calls.findIndex((call) => call.includes("fsmonitor--daemon"));
    const remove = calls.findIndex((call) => call.includes("remove"));
    expect(calls[stop]).toEqual([
      "git",
      "-C",
      worktreePath,
      "-c",
      "core.fsmonitor=false",
      "fsmonitor--daemon",
      "stop",
    ]);
    expect(stop).toBeLessThan(remove);
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

  test("removes a worktree from the folder the environment recorded", async () => {
    const { context } = await cleanupContext();
    const { projectPath, base } = await project();
    const chosenRoot = await tempDir("ork-cleanup-chosen-");
    const worktreePath = path.join(chosenRoot, "project-feature");
    await git(projectPath, "worktree", "add", "-q", "-b", BRANCH, worktreePath, base);
    const sibling = path.join(chosenRoot, "unrelated");
    await fs.mkdir(sibling);

    expect(
      await runEnvironmentCleanupStep(
        entry({ projectPath, worktreePath, worktreeRoot: chosenRoot, pending: ["worktree"] }),
        "worktree",
        context,
      ),
    ).toBe(true);
    await expect(fs.stat(worktreePath)).rejects.toThrow();
    expect((await fs.stat(sibling)).isDirectory()).toBe(true);
  });

  test("refuses a worktree outside the folder the environment recorded", async () => {
    const { context, worktreeDir } = await cleanupContext();
    const chosenRoot = await tempDir("ork-cleanup-chosen-");
    // Inside the default root, but not the recorded one.
    const worktreePath = path.join(worktreeDir, "project-feature");
    await fs.mkdir(worktreePath);

    expect(
      await runEnvironmentCleanupStep(
        entry({ worktreePath, worktreeRoot: chosenRoot, pending: ["worktree"] }),
        "worktree",
        context,
      ),
    ).toBe(false);
    expect((await fs.stat(worktreePath)).isDirectory()).toBe(true);
  });

  test("refuses to delete a worktree directory outside the workspaces root", async () => {
    const { context, dataDir } = await cleanupContext();
    const outside = await tempDir("ork-cleanup-outside-");
    const cleanup = entry({ worktreePath: outside, pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);

    expect(await runEnvironmentCleanupStep(cleanup, "worktree", context)).toBe(false);
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
    expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toMatchObject({
      pending: ["worktree"],
      lastError: "worktree: worktree is outside the workspaces root",
    });
  });

  test("refuses a registered worktree outside the root before asking Git to remove it", async () => {
    const { context, dataDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const outside = path.join(await tempDir("ork-cleanup-outside-"), "worktree");
    await git(projectPath, "worktree", "add", "-q", "-b", BRANCH, outside, base);
    const cleanup = entry({ projectPath, worktreePath: outside, pending: ["worktree"] });
    await environmentCleanupLedger(dataDir).record(cleanup);
    expect(await runEnvironmentCleanupStep(cleanup, "worktree", context)).toBe(false);
    expect((await fs.stat(outside)).isDirectory()).toBe(true);
    expect(await git(projectPath, "worktree", "list", "--porcelain")).toContain(outside);
    expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toMatchObject({
      pending: ["worktree"],
    });
  });

  test("refuses a worktree reached through a symlink inside the root", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const outside = await tempDir("ork-cleanup-symlink-target-");
    const actual = path.join(outside, "worktree");
    await git(projectPath, "worktree", "add", "-q", "-b", BRANCH, actual, base);
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
    expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toMatchObject({
      pending: ["worktree"],
    });
  });

  test.each(["rev-parse", "worktree"])(
    "keeps the branch step pending when %s fails transiently",
    async (failedCommand) => {
      const { context, dataDir } = await cleanupContext();
      const { projectPath, base } = await project();
      await branchWithCommits(projectPath, BRANCH, base, []);
      const cleanup = entry({ projectPath, branch: BRANCH, pending: ["branch"] });
      await environmentCleanupLedger(dataDir).record(cleanup);
      const run: CleanupCommandRunner = async (command, args, options) => {
        if (command === "git" && args[2] === failedCommand) {
          throw new CommandFailedError("locked", { exitCode: 128 });
        }
        return runCommand(command, args, options);
      };
      expect(await runEnvironmentCleanupStep(cleanup, "branch", context, { run })).toBe(false);
      expect(await branchExists(projectPath, BRANCH)).toBe(true);
      expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toMatchObject({
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
    const directories = environmentStateDirectories(dataDir, ENV_ID);
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

  // These two drive `docker rm` through the injected runner. The ownership
  // probe before it calls the host's real Docker, which answers differently
  // when the daemon is unreachable or `c1` prefixes an existing object, so
  // they start past it; container-lifecycle-service.test.ts owns its verdicts.
  test("treats a container the daemon no longer knows as removed", async () => {
    const { context } = await cleanupContext();
    const calls: string[][] = [];
    const run: CleanupCommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "ps") return { stdout: "", stderr: "" };
      throw new Error("Error response from daemon: No such container: c1");
    };
    expect(
      await runEnvironmentCleanupStep(
        entry({ containerId: "c1", pending: ["container"] }),
        "container",
        context,
        { run, containerOwnershipVerified: true },
      ),
    ).toBe(true);
    expect(calls[0]).toEqual(["docker", "rm", "-f", "c1"]);
    // Then the environment's egress gateways are listed by their own labels.
    expect(calls.slice(1).map((call) => call.slice(0, 3))).toEqual([["docker", "ps", "-a"]]);
  });

  test("removes every egress gateway of the environment with its runtime", async () => {
    const { context, dataDir } = await cleanupContext();
    const owner = dockerOwnerNamespace(dataDir);
    const calls: string[][] = [];
    const gateway = "a".repeat(64);
    const run: CleanupCommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "ps") {
        return {
          // The second row claims the app label as well and is never removed.
          stdout: `${gateway}\tork-x\tenv-1\t2026-10-25 10:00:00 +0000 UTC\t\n${"b".repeat(64)}\tork-y\tenv-1\t2026-10-25 10:00:00 +0000 UTC\torkestrator-v2\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };
    expect(
      await runEnvironmentCleanupStep(
        entry({ containerId: "c1", pending: ["container"] }),
        "container",
        context,
        { run, containerOwnershipVerified: true },
      ),
    ).toBe(true);
    const list = calls.find((call) => call[1] === "ps") ?? [];
    expect(list).toContain(`label=orkestrator-owner=${owner}`);
    expect(list).toContain("label=orkestrator-resource-role=egress-gateway");
    expect(list).toContain(`label=orkestrator-egress-environment=${entry({}).environmentId}`);
    expect(calls.filter((call) => call[1] === "rm")).toEqual([
      ["docker", "rm", "-f", "c1"],
      ["docker", "rm", "-f", gateway],
    ]);
  });

  test("keeps the container step pending when the daemon fails", async () => {
    const { context, dataDir } = await cleanupContext();
    const cleanup = entry({ containerId: "c1", pending: ["container"] });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const run: CleanupCommandRunner = async () => {
      throw new Error("Cannot connect to the Docker daemon (exit 1)");
    };
    expect(
      await runEnvironmentCleanupStep(cleanup, "container", context, {
        run,
        containerOwnershipVerified: true,
      }),
    ).toBe(false);
    expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toMatchObject({
      pending: ["container"],
      lastError: "container: exit 1",
    });
  });
});

describe("storage volume cleanup", () => {
  test("waits for the container, verifies labels and treats a missing volume as removed", async () => {
    const { context, dataDir } = await cleanupContext();
    const owner = dockerOwnerNamespace(dataDir);
    const ledger = environmentCleanupLedger(dataDir);
    const calls: string[] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args.join(" "));
      if (args[1] === "inspect") {
        if (args.at(-1) === "vol-gone") throw new Error("Error: No such volume: vol-gone");
        if (args.at(-1) === "vol-foreign") {
          return {
            stdout: JSON.stringify({ "orkestrator-owner": "other", "environment-id": ENV_ID }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({ "orkestrator-owner": owner, "environment-id": ENV_ID }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    };

    // The container is still owed: volumes are not touched.
    const blocked = entry({ volumes: ["vol-ws"], pending: ["container", "volumes"] });
    await ledger.record(blocked);
    expect(await runEnvironmentCleanupStep(blocked, "volumes", context, { run })).toBe(false);
    expect(calls).toEqual([]);

    await ledger.complete(ENV_ID, "container");
    expect(await runEnvironmentCleanupStep(blocked, "volumes", context, { run })).toBe(true);
    expect(calls).toContain("volume rm vol-ws");
    expect(calls.some((call) => call.startsWith("volume rm -f"))).toBe(false);

    calls.length = 0;
    const foreign = entry({ volumes: ["vol-gone", "vol-foreign"], pending: ["volumes"] });
    await ledger.record(foreign);
    expect(await runEnvironmentCleanupStep(foreign, "volumes", context, { run })).toBe(false);
    expect(calls).not.toContain("volume rm vol-foreign");
    expect((await ledger.get(ENV_ID))?.pending).toEqual(["volumes"]);
  });
});

describe("nested Docker cancellation", () => {
  test.each([
    "network-inspect",
    "network-remove",
    "retained-ownership",
    "current-ownership",
  ] as const)("aborting %s waits for its command and leaves the step pending", async (target) => {
    const { context, dataDir } = await cleanupContext();
    const network = target.startsWith("network");
    const step = network ? "network" : "container";
    const cleanup = entry({
      pending: [step],
      ...(target === "retained-ownership"
        ? { retainedContainers: ["retained-cancel-fixture"] }
        : {}),
      ...(target === "current-ownership" ? { containerId: "current-cancel-fixture" } : {}),
    });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const controller = new AbortController();
    const calls: string[][] = [];
    let active = false;
    const pidFile = path.join(dataDir, "cancelled-command.pid");
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const run: CleanupCommandRunner = async (command, args, options) => {
      calls.push([command, ...args]);
      expect(options.signal).toBe(controller.signal);
      expect(options.waitForTermination).toBe(true);
      const isTarget =
        target === "network-inspect"
          ? args[1] === "inspect"
          : target === "network-remove"
            ? args[1] === "rm"
            : args[0] === "inspect";
      if (isTarget) {
        active = true;
        const running = runCommand(
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
          ],
          options,
        );
        reached();
        try {
          return await running;
        } finally {
          active = false;
        }
      }
      return {
        stdout:
          JSON.stringify({
            app: "orkestrator-v2",
            "orkestrator-owner": dockerOwnerNamespace(dataDir),
            "environment-id": ENV_ID,
            "orkestrator-resource-role": "network",
          }) + "\t0",
        stderr: "",
      };
    };
    let settled = false;
    const pending = runEnvironmentCleanupStep(cleanup, step, context, {
      run,
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    try {
      await started;
      const deadline = Date.now() + 5_000;
      while (
        !(await fs.stat(pidFile).then(
          () => true,
          () => false,
        ))
      ) {
        if (Date.now() > deadline) throw new Error("command did not start");
        await Bun.sleep(10);
      }
      const pid = Number(await fs.readFile(pidFile, "utf8"));
      expect(active).toBe(true);
      expect(settled).toBe(false);
      controller.abort();
      expect(await pending).toBe(false);
      expect(active).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(calls).toHaveLength(target === "network-remove" ? 2 : 1);
      expect(await environmentCleanupLedger(dataDir).get(ENV_ID)).toMatchObject({
        pending: [step],
      });
    } finally {
      controller.abort();
      await pending;
    }
  });
});
