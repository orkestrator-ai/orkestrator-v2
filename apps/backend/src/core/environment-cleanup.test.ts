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
    environmentId: "e1",
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
      worktreeRoot: null,
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
  test("logs a kept branch once, though a step can run again", async () => {
    const { context, dataDir } = await cleanupContext();
    const { projectPath, base } = await project();
    await branchWithCommits(projectPath, "feature", base, ["a.txt"]);
    const cleanup = entry({
      environmentId: "env-kept-branch",
      projectPath,
      branch: "feature",
      createdFromCommit: base,
      pending: ["branch"],
    });
    await environmentCleanupLedger(dataDir).record(cleanup);
    const logs = captureLogs();
    try {
      expect(await runEnvironmentCleanupStep(cleanup, "branch", context)).toBe(true);
      expect(await runEnvironmentCleanupStep(cleanup, "branch", context)).toBe(true);
      expect(logs.outputs.map((output) => output.method)).toEqual(["info"]);
      expect(logs.records()[0]).toMatchObject({
        area: "environment",
        event: "cleanup.branch-kept",
        fields: { scope: "env-kept-branch" },
      });
    } finally {
      logs.restore();
    }
  });

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

  test("stops the worktree's fsmonitor daemon before removing it", async () => {
    const { context, dataDir, worktreeDir } = await cleanupContext();
    const { projectPath, base } = await project();
    const worktreePath = path.join(worktreeDir, "project-feature");
    await git(projectPath, "worktree", "add", "-q", "-b", "feature", worktreePath, base);
    const cleanup = entry({ projectPath, worktreePath, branch: "feature", pending: ["worktree"] });
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
    await git(projectPath, "worktree", "add", "-q", "-b", "feature", worktreePath, base);
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
    expect(await environmentCleanupLedger(dataDir).get("e1")).toMatchObject({
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
            stdout: JSON.stringify({ "orkestrator-owner": "other", "environment-id": "e1" }),
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({ "orkestrator-owner": owner, "environment-id": "e1" }),
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

    await ledger.complete("e1", "container");
    expect(await runEnvironmentCleanupStep(blocked, "volumes", context, { run })).toBe(true);
    expect(calls).toContain("volume rm vol-ws");
    expect(calls.some((call) => call.startsWith("volume rm -f"))).toBe(false);

    calls.length = 0;
    const foreign = entry({ volumes: ["vol-gone", "vol-foreign"], pending: ["volumes"] });
    await ledger.record(foreign);
    expect(await runEnvironmentCleanupStep(foreign, "volumes", context, { run })).toBe(false);
    expect(calls).not.toContain("volume rm vol-foreign");
    expect((await ledger.get("e1"))?.pending).toEqual(["volumes"]);
  });
});
