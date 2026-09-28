import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  environmentBranchBase,
  environmentBranchNamespace,
  parseEnvironmentBranchNamespace,
} from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import {
  environmentCleanupLedger,
  environmentCleanupSweepState,
  type EnvironmentCleanupEntry,
} from "./environment-cleanup-ledger.js";
import {
  MAX_ENVIRONMENT_CLEANUP_ATTEMPTS,
  ORPHANED_BRANCH_SWEEP_INTERVAL_MS,
  ORPHANED_STATE_MIN_AGE_MS,
  cancelScheduledEnvironmentCleanup,
  reconcileEnvironmentCleanup,
  runStartupEnvironmentCleanup,
  scheduleEnvironmentCleanupReconcile,
  sweepAbandonedTempFiles,
  sweepOrphanedEnvironmentBranches,
  sweepOrphanedEnvironmentState,
  sweepPreLedgerDiskState,
  sweepStrayWorkspaceDirectories,
} from "./environment-cleanup-reconciler.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { environmentStateDirectory } from "./environment-state-paths.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";
import { StorageService } from "./storage.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  for (const directory of tempDirectories) cancelScheduledEnvironmentCleanup(directory);
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await Bun.sleep(10);
  }
}

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirectories.push(directory);
  return directory;
}

async function reconcileContext(): Promise<{
  context: CommandContext;
  storage: StorageService;
  dataDir: string;
  worktreeDir: string;
}> {
  const dataDir = await tempDir("ork-reconcile-data-");
  const worktreeDir = await tempDir("ork-reconcile-workspaces-");
  const storage = new StorageService(dataDir);
  await storage.init();
  const context = {
    storage,
    worktreeDir,
    strictDockerOwner: false,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
  } as CommandContext;
  return { context, storage, dataDir, worktreeDir };
}

function environment(id: string): Environment {
  return {
    id,
    projectId: "p1",
    name: id,
    branch: id,
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  };
}

function entry(overrides: Partial<EnvironmentCleanupEntry>): EnvironmentCleanupEntry {
  return {
    version: 1,
    environmentId: "gone",
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

async function makeStateDirectory(directory: string, ageMs: number): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "state.json"), "{}\n");
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(directory, when, when);
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

describe("environment cleanup reconciler", () => {
  test("finishes steps a deletion left pending", async () => {
    const { context, dataDir, worktreeDir } = await reconcileContext();
    const worktreePath = path.join(worktreeDir, "project-gone");
    await fs.mkdir(path.join(worktreePath, "bridges"), { recursive: true });
    const stateDirectory = environmentStateDirectory(dataDir, "cursor-bridge-state", "gone");
    await makeStateDirectory(stateDirectory, 0);
    const ledger = environmentCleanupLedger(dataDir);
    await ledger.record(
      entry({
        worktreePath,
        stateDirectories: [stateDirectory],
        pending: ["worktree", "state-dirs"],
      }),
    );

    const result = await reconcileEnvironmentCleanup(context);
    expect(result.attempted).toBe(1);
    expect(await exists(worktreePath)).toBe(false);
    expect(await exists(stateDirectory)).toBe(false);
    expect(await ledger.get("gone")).toBeNull();
  });

  test("leaves an entry alone while its environment record still exists", async () => {
    const { context, storage, dataDir, worktreeDir } = await reconcileContext();
    await storage.addEnvironment(environment("e1"));
    const worktreePath = path.join(worktreeDir, "project-e1");
    await fs.mkdir(worktreePath);
    await environmentCleanupLedger(dataDir).record(
      entry({ environmentId: "e1", worktreePath, pending: ["worktree"] }),
    );

    expect((await reconcileEnvironmentCleanup(context)).attempted).toBe(0);
    expect(await exists(worktreePath)).toBe(true);
  });

  test("backs off after a recent attempt and reports when it becomes due", async () => {
    const { context, dataDir } = await reconcileContext();
    const now = new Date("2026-09-26T12:00:00.000Z");
    await environmentCleanupLedger(dataDir).record(
      entry({ pending: ["state-dirs"], attempts: 1, lastAttemptAt: now.toISOString() }),
    );

    const result = await reconcileEnvironmentCleanup(context, { now: () => now });
    expect(result.attempted).toBe(0);
    expect(result.nextDueAt).toBe(now.getTime() + 120_000);
  });

  test("stops retrying after the attempt cap but keeps the entry", async () => {
    const { context, dataDir } = await reconcileContext();
    const outside = await tempDir("ork-reconcile-outside-");
    const ledger = environmentCleanupLedger(dataDir);
    await ledger.record(
      entry({
        worktreePath: outside,
        pending: ["worktree"],
        attempts: MAX_ENVIRONMENT_CLEANUP_ATTEMPTS,
      }),
    );
    expect((await reconcileEnvironmentCleanup(context)).attempted).toBe(0);
    expect(await ledger.get("gone")).toMatchObject({ pending: ["worktree"] });
  });

  test("does not judge a branch while its worktree is still pending", async () => {
    const { context, dataDir } = await reconcileContext();
    const outside = await tempDir("ork-reconcile-outside-");
    const ledger = environmentCleanupLedger(dataDir);
    await ledger.record(
      entry({
        worktreePath: outside,
        projectPath: outside,
        branch: "feature",
        pending: ["worktree", "branch"],
      }),
    );
    await reconcileEnvironmentCleanup(context);
    expect(await ledger.get("gone")).toMatchObject({
      pending: ["worktree", "branch"],
      attempts: 1,
    });
  });
});

describe("orphaned environment state sweep", () => {
  test("removes old state with no owner and keeps environment and coordinator state", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    await storage.addEnvironment(environment("live"));
    const coordinatorConversation = coordinatorRuntimeId("coord-1", "conversation-1");
    storage.listCoordinatorWorkspaces = async () =>
      [{ id: "coord-1", conversations: [{ id: "conversation-1" }] }] as Awaited<
        ReturnType<StorageService["listCoordinatorWorkspaces"]>
      >;
    const old = ORPHANED_STATE_MIN_AGE_MS * 2;
    const orphan = environmentStateDirectory(dataDir, "cursor-bridge-state", "deleted");
    const orphanAcp = environmentStateDirectory(dataDir, "acp-bridge-state", "deleted");
    const live = environmentStateDirectory(dataDir, "cursor-bridge-state", "live");
    const coordinator = environmentStateDirectory(
      dataDir,
      "cursor-bridge-state",
      coordinatorConversation,
    );
    const recent = environmentStateDirectory(dataDir, "pi-bridge-state", "just-created");
    const unrelated = path.join(dataDir, "cursor-bridge-state", "not-a-state-key");
    await makeStateDirectory(orphan, old);
    await makeStateDirectory(orphanAcp, old);
    await makeStateDirectory(live, old);
    await makeStateDirectory(coordinator, old);
    await makeStateDirectory(recent, 0);
    await makeStateDirectory(unrelated, old);

    expect(await sweepOrphanedEnvironmentState(context)).toBe(2);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(orphanAcp)).toBe(false);
    expect(await exists(live)).toBe(true);
    expect(await exists(coordinator)).toBe(true);
    expect(await exists(recent)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
  });

  test("aborts rather than sweeping when the owners cannot be listed", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const orphan = environmentStateDirectory(dataDir, "cursor-bridge-state", "deleted");
    await makeStateDirectory(orphan, ORPHANED_STATE_MIN_AGE_MS * 2);
    storage.listCoordinatorWorkspaces = async () => {
      throw new Error("coordinator store unreadable");
    };

    await expect(sweepOrphanedEnvironmentState(context)).rejects.toThrow("unreadable");
    expect(await exists(orphan)).toBe(true);
  });

  test("startup revisits a young orphan after it ages without a restart", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    await storage.addEnvironment(environment("live"));
    const orphan = environmentStateDirectory(dataDir, "cursor-bridge-state", "deleted");
    const live = environmentStateDirectory(dataDir, "cursor-bridge-state", "live");
    await makeStateDirectory(orphan, ORPHANED_STATE_MIN_AGE_MS - 150);
    await makeStateDirectory(live, ORPHANED_STATE_MIN_AGE_MS * 2);
    await runStartupEnvironmentCleanup(context, { orphanSweepIntervalMs: 25 });
    expect(await exists(orphan)).toBe(true);
    await eventually(async () => !(await exists(orphan)));
    expect(await exists(live)).toBe(true);
    cancelScheduledEnvironmentCleanup(dataDir);
  });

  test("startup retries an orphan sweep after an owner lookup failure", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const orphan = environmentStateDirectory(dataDir, "cursor-bridge-state", "deleted");
    await makeStateDirectory(orphan, ORPHANED_STATE_MIN_AGE_MS * 2);
    const original = storage.listCoordinatorWorkspaces.bind(storage);
    let calls = 0;
    storage.listCoordinatorWorkspaces = async () => {
      if (++calls === 1) throw new Error("temporary lookup failure");
      return original();
    };
    await runStartupEnvironmentCleanup(context, { orphanSweepIntervalMs: 25 });
    expect(await exists(orphan)).toBe(true);
    await eventually(async () => !(await exists(orphan)));
    expect(calls).toBeGreaterThanOrEqual(2);
    cancelScheduledEnvironmentCleanup(dataDir);
  });
});

describe("scheduled environment cleanup", () => {
  test("coalesces a request during an in-flight pass into one rerun", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const outside = await tempDir("ork-reconcile-outside-");
    await environmentCleanupLedger(dataDir).record(
      entry({ worktreePath: outside, pending: ["worktree"] }),
    );
    const original = storage.loadEnvironments.bind(storage);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.loadEnvironments = async () => {
      calls++;
      if (calls === 1) await gate;
      return original();
    };
    scheduleEnvironmentCleanupReconcile(context);
    await eventually(async () => calls === 1);
    scheduleEnvironmentCleanupReconcile(context);
    release();
    await eventually(async () => calls === 2);
    expect(calls).toBe(2);
    cancelScheduledEnvironmentCleanup(dataDir);
  });

  test("cancelling during a pass prevents both reruns and retry timers", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    await environmentCleanupLedger(dataDir).record(entry({ pending: ["state-dirs"] }));
    const original = storage.loadEnvironments.bind(storage);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.loadEnvironments = async () => {
      calls++;
      if (calls === 1) await gate;
      return original();
    };
    scheduleEnvironmentCleanupReconcile(context);
    await eventually(async () => calls === 1);
    scheduleEnvironmentCleanupReconcile(context);
    cancelScheduledEnvironmentCleanup(dataDir);
    release();
    await Bun.sleep(50);
    expect(calls).toBe(1);
  });

  test("re-arms for a deferred ledger retry", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const outside = await tempDir("ork-reconcile-outside-");
    await environmentCleanupLedger(dataDir).record(
      entry({
        worktreePath: outside,
        pending: ["worktree"],
        attempts: 1,
        lastAttemptAt: new Date(Date.now() - 120_000 + 500).toISOString(),
      }),
    );
    let calls = 0;
    const original = storage.loadEnvironments.bind(storage);
    storage.loadEnvironments = async () => {
      calls++;
      return original();
    };
    scheduleEnvironmentCleanupReconcile(context);
    await eventually(
      async () => (await environmentCleanupLedger(dataDir).get("gone"))?.attempts === 2,
      2_000,
    );
    expect(calls).toBeGreaterThanOrEqual(1);
    expect((await environmentCleanupLedger(dataDir).get("gone"))?.attempts).toBe(2);
    cancelScheduledEnvironmentCleanup(dataDir);
  });
});

/** Backdates `root` and everything under it, deepest first. */
async function age(root: string, ageMs: number): Promise<void> {
  const when = new Date(Date.now() - ageMs);
  const stats = await fs.lstat(root);
  if (stats.isDirectory()) {
    for (const name of await fs.readdir(root)) await age(path.join(root, name), ageMs);
  }
  if (!stats.isSymbolicLink()) await fs.utimes(root, when, when);
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

/** A registered project with `main` published as `origin/main` and `origin/HEAD`. */
async function addProject(
  storage: StorageService,
  id = "p1",
): Promise<{ projectPath: string; base: string }> {
  const projectPath = await tempDir("ork-reconcile-project-");
  await runCommand("git", ["init", "-q", "-b", "main", projectPath]);
  await git(projectPath, "config", "user.name", "Orkestrator Test");
  await git(projectPath, "config", "user.email", "test@example.invalid");
  const base = await commit(projectPath, "README.md");
  await git(projectPath, "update-ref", "refs/remotes/origin/main", base);
  await git(projectPath, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await storage.addProject({
    id,
    name: "project",
    gitUrl: projectPath,
    localPath: projectPath,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  return { projectPath, base };
}

/** Creates `branch` from `from` with one commit per file, without leaving it checked out. */
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
  return runCommand("git", [
    "-C",
    projectPath,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).then(
    () => true,
    () => false,
  );
}

/** A branch name in the environment scheme for an environment that never existed here. */
function orphanBranch(slug: string): string {
  return `${slug}-${randomUUID().replace(/-/g, "").slice(0, 12)}-r1`;
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("stray workspace directory sweep", () => {
  test("removes an unowned directory that holds only build logs", async () => {
    const { context, worktreeDir } = await reconcileContext();
    const stray = path.join(worktreeDir, "project-gone");
    await fs.mkdir(path.join(stray, "bridges", "cursor-bridge", ".turbo"), { recursive: true });
    await fs.mkdir(path.join(stray, "empty"), { recursive: true });
    await fs.writeFile(
      path.join(stray, "bridges", "cursor-bridge", ".turbo", "turbo-build.log"),
      "",
    );
    await age(stray, ORPHANED_STATE_MIN_AGE_MS * 2);

    expect(await sweepStrayWorkspaceDirectories(context)).toEqual({
      removed: 1,
      keptWithContent: 0,
    });
    expect(await exists(stray)).toBe(false);
  });

  test("keeps and counts an unowned directory with any other file or a symlink", async () => {
    const { context, worktreeDir } = await reconcileContext();
    const withFile = path.join(worktreeDir, "hand-made");
    await fs.mkdir(path.join(withFile, ".turbo"), { recursive: true });
    await fs.writeFile(path.join(withFile, ".turbo", "turbo-build.log"), "");
    await fs.writeFile(path.join(withFile, ".turbo", "notes.txt"), "keep me\n");
    const withLink = path.join(worktreeDir, "linked");
    await fs.mkdir(withLink);
    await fs.symlink(os.tmpdir(), path.join(withLink, "link"));
    await age(withFile, ORPHANED_STATE_MIN_AGE_MS * 2);
    await age(withLink, ORPHANED_STATE_MIN_AGE_MS * 2);

    expect(await sweepStrayWorkspaceDirectories(context)).toEqual({
      removed: 0,
      keptWithContent: 2,
    });
    expect(await exists(path.join(withFile, ".turbo", "notes.txt"))).toBe(true);
    expect(await exists(withLink)).toBe(true);
  });

  test("keeps a directory an environment references or git registers", async () => {
    const { context, storage, worktreeDir } = await reconcileContext();
    const { projectPath } = await addProject(storage);
    const referenced = path.join(worktreeDir, "project-live");
    await fs.mkdir(referenced);
    await storage.addEnvironment({ ...environment(randomUUID()), worktreePath: referenced });
    const registered = path.join(worktreeDir, "project-registered");
    await git(projectPath, "worktree", "add", "-q", "--detach", registered, "main");
    // Emptied by hand, so only git's registration says it is owned.
    for (const name of await fs.readdir(registered)) {
      await fs.rm(path.join(registered, name), { recursive: true, force: true });
    }
    await age(referenced, ORPHANED_STATE_MIN_AGE_MS * 2);
    await age(registered, ORPHANED_STATE_MIN_AGE_MS * 2);

    expect(await sweepStrayWorkspaceDirectories(context)).toEqual({
      removed: 0,
      keptWithContent: 0,
    });
    expect(await exists(referenced)).toBe(true);
    expect(await exists(registered)).toBe(true);
  });

  test("keeps a directory modified within the last hour", async () => {
    const { context, worktreeDir } = await reconcileContext();
    const stray = path.join(worktreeDir, "project-new");
    await fs.mkdir(path.join(stray, ".turbo"), { recursive: true });
    await age(stray, ORPHANED_STATE_MIN_AGE_MS * 2);
    // A build still running inside the tree keeps the whole directory.
    await fs.writeFile(path.join(stray, ".turbo", "turbo-build.log"), "");

    expect(await sweepStrayWorkspaceDirectories(context)).toEqual({
      removed: 0,
      keptWithContent: 0,
    });
    expect(await exists(stray)).toBe(true);
  });

  test("startup removes a build-log-only directory", async () => {
    const { context, dataDir, worktreeDir } = await reconcileContext();
    const stray = path.join(worktreeDir, "bridges");
    await fs.mkdir(path.join(stray, "pi-bridge", ".turbo"), { recursive: true });
    await fs.writeFile(path.join(stray, "pi-bridge", ".turbo", "turbo-build.log"), "");
    await age(stray, ORPHANED_STATE_MIN_AGE_MS * 2);
    await runStartupEnvironmentCleanup(context);
    expect(await exists(stray)).toBe(false);
    cancelScheduledEnvironmentCleanup(dataDir);
  });
});

describe("orphaned environment branch sweep", () => {
  test("a failed stray sweep does not stop branch or temp sweeps", async () => {
    const { context, storage, dataDir, worktreeDir } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    const branch = orphanBranch("merged");
    await git(projectPath, "branch", branch, base);
    const pid = await deadPid();
    const abandoned = path.join(dataDir, `agent-platforms.json.${pid}.tmp`);
    await fs.writeFile(abandoned, "{}\n");
    await age(abandoned, ORPHANED_STATE_MIN_AGE_MS * 2);
    await fs.mkdir(path.join(worktreeDir, "stray"));
    const original = storage.loadProjects.bind(storage);
    let calls = 0;
    storage.loadProjects = async () => {
      if (++calls === 1) throw new Error("listing failed");
      return original();
    };

    await sweepPreLedgerDiskState(context);

    expect(await branchExists(projectPath, branch)).toBe(false);
    expect(await exists(abandoned)).toBe(false);
    expect(await exists(path.join(worktreeDir, "stray"))).toBe(true);
  });

  test("resumes past kept branches after a capped pass", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    for (const slug of ["aaa", "aab"]) {
      await branchWithCommits(projectPath, orphanBranch(slug), base, [`${slug}.txt`]);
    }
    const merged = orphanBranch("zzz");
    await git(projectPath, "branch", merged, base);
    const start = Date.now();
    const options = { maxOrphanedBranchesPerPass: 2 };

    expect(
      await sweepOrphanedEnvironmentBranches(context, { ...options, now: () => new Date(start) }),
    ).toEqual({ deleted: 0, kept: 2 });
    expect(await branchExists(projectPath, merged)).toBe(true);
    expect(Object.values(await environmentCleanupSweepState(dataDir).branchCursors())).toHaveLength(
      1,
    );
    expect(
      await sweepOrphanedEnvironmentBranches(context, {
        ...options,
        now: () => new Date(start + ORPHANED_BRANCH_SWEEP_INTERVAL_MS + 1),
      }),
    ).toEqual({ deleted: 1, kept: 0 });
    expect(await branchExists(projectPath, merged)).toBe(false);
  });

  test("a cancelled pass is not recorded and is retried", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    const first = orphanBranch("aaa");
    const second = orphanBranch("zzz");
    await branchWithCommits(projectPath, first, base, ["work.txt"]);
    await git(projectPath, "branch", second, base);
    let checks = 0;
    expect(
      await sweepOrphanedEnvironmentBranches(context, { isCancelled: () => ++checks > 2 }),
    ).toEqual({ deleted: 0, kept: 1 });
    expect(await environmentCleanupSweepState(dataDir).branchSweeps()).toEqual({});
    expect(await sweepOrphanedEnvironmentBranches(context)).toEqual({ deleted: 1, kept: 1 });
    expect(await branchExists(projectPath, second)).toBe(false);
  });

  test("a failed project does not stop another project or record the failure", async () => {
    const { context, storage, dataDir } = await reconcileContext();
    const first = await addProject(storage, "p1");
    const second = await addProject(storage, "p2");
    const branch = orphanBranch("merged");
    await git(second.projectPath, "branch", branch, second.base);
    await expect(
      sweepOrphanedEnvironmentBranches(context, {
        run: async (command, args, options) => {
          if (command === "git" && args[1] === first.projectPath && args[2] === "worktree")
            throw new Error("listing failed");
          return runCommand(command, args, options);
        },
      }),
    ).rejects.toThrow("listing failed");
    expect(await branchExists(second.projectPath, branch)).toBe(false);
    const swept = await environmentCleanupSweepState(dataDir).branchSweeps();
    expect(swept.p1).toBeUndefined();
    expect(swept.p2).toBeDefined();
  });
  test("recognises every branch name the environment scheme produces", () => {
    const id = "4d637502-8fc1-4165-8409-c61c97c3aa9f";
    expect(environmentBranchNamespace(id)).toBe("4d6375028fc1");
    for (const branch of [
      environmentBranchBase("Disk space usage", id),
      environmentBranchBase("Disk space usage", id, 3),
      `${environmentBranchBase("fix", id, 1)}-2`,
    ]) {
      expect(parseEnvironmentBranchNamespace(branch)).toBe("4d6375028fc1");
    }
    for (const branch of ["main", "feature/4d6375028fc1", "4d6375028fc1", "x-4d6375028fc"]) {
      expect(parseEnvironmentBranchNamespace(branch)).toBeNull();
    }
  });

  test("deletes a merged orphan branch and keeps an unmerged one", async () => {
    const { context, storage } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    const merged = orphanBranch("merged");
    const unmerged = orphanBranch("unmerged");
    const mergedTip = await branchWithCommits(projectPath, merged, base, ["merged.txt"]);
    await git(projectPath, "update-ref", "refs/remotes/origin/main", mergedTip);
    await branchWithCommits(projectPath, unmerged, base, ["unmerged.txt"]);
    const unrelated = "feature-without-namespace";
    await branchWithCommits(projectPath, unrelated, base, []);

    expect(await sweepOrphanedEnvironmentBranches(context)).toEqual({ deleted: 1, kept: 1 });
    expect(await branchExists(projectPath, merged)).toBe(false);
    expect(await branchExists(projectPath, unmerged)).toBe(true);
    expect(await branchExists(projectPath, unrelated)).toBe(true);
  });

  test("deletes an orphan with no commits beyond its reflog start point", async () => {
    const { context, storage } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    // Created from an unmerged base, so only the start-point test can pass.
    const baseTip = await branchWithCommits(projectPath, "delegation-base", base, ["base.txt"]);
    const orphan = orphanBranch("delegated");
    await git(projectPath, "branch", orphan, baseTip);

    expect(await sweepOrphanedEnvironmentBranches(context)).toEqual({ deleted: 1, kept: 0 });
    expect(await branchExists(projectPath, orphan)).toBe(false);
    expect(await branchExists(projectPath, "delegation-base")).toBe(true);
  });

  test("keeps a branch whose namespace belongs to a live environment", async () => {
    const { context, storage } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    const id = randomUUID();
    const branch = `live-${id.replace(/-/g, "").slice(0, 12)}-r1`;
    await branchWithCommits(projectPath, branch, base, []);
    // The environment's recorded branch is a later rename, so only the
    // namespace ties the old branch to it.
    await storage.addEnvironment({ ...environment(id), branch: "renamed" });

    expect(await sweepOrphanedEnvironmentBranches(context)).toEqual({ deleted: 0, kept: 0 });
    expect(await branchExists(projectPath, branch)).toBe(true);
  });

  test("keeps an orphan branch that is checked out in a worktree", async () => {
    const { context, storage, worktreeDir } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    const orphan = orphanBranch("checked-out");
    await branchWithCommits(projectPath, orphan, base, []);
    await git(projectPath, "worktree", "add", "-q", path.join(worktreeDir, "wt"), orphan);

    expect(await sweepOrphanedEnvironmentBranches(context)).toEqual({ deleted: 0, kept: 0 });
    expect(await branchExists(projectPath, orphan)).toBe(true);
  });

  test("sweeps each project at most once per interval", async () => {
    const { context, storage } = await reconcileContext();
    const { projectPath, base } = await addProject(storage);
    const start = Date.now();
    expect(await sweepOrphanedEnvironmentBranches(context, { now: () => new Date(start) })).toEqual(
      { deleted: 0, kept: 0 },
    );
    const orphan = orphanBranch("late");
    await branchWithCommits(projectPath, orphan, base, []);

    const soon = new Date(start + ORPHANED_BRANCH_SWEEP_INTERVAL_MS - 60_000);
    expect(await sweepOrphanedEnvironmentBranches(context, { now: () => soon })).toEqual({
      deleted: 0,
      kept: 0,
    });
    expect(await branchExists(projectPath, orphan)).toBe(true);

    const later = new Date(start + ORPHANED_BRANCH_SWEEP_INTERVAL_MS + 60_000);
    expect(await sweepOrphanedEnvironmentBranches(context, { now: () => later })).toEqual({
      deleted: 1,
      kept: 0,
    });
    expect(await branchExists(projectPath, orphan)).toBe(false);
  });
});

describe("abandoned temp file sweep", () => {
  async function tempFile(dataDir: string, name: string, ageMs: number): Promise<string> {
    const file = path.join(dataDir, name);
    await fs.writeFile(file, "{}\n");
    await age(file, ageMs);
    return file;
  }

  test("removes an old temp file whose writer is gone", async () => {
    const { context, dataDir } = await reconcileContext();
    const pid = await deadPid();
    const abandoned = await tempFile(
      dataDir,
      `agent-platforms.json.${pid}.tmp`,
      ORPHANED_STATE_MIN_AGE_MS * 2,
    );
    const otherShape = await tempFile(
      dataDir,
      `.coordinators.json.${randomUUID()}.tmp`,
      ORPHANED_STATE_MIN_AGE_MS * 2,
    );

    expect(await sweepAbandonedTempFiles(context)).toBe(1);
    expect(await exists(abandoned)).toBe(false);
    expect(await exists(otherShape)).toBe(true);
  });

  test("keeps a temp file whose writer is still running", async () => {
    const { context, dataDir } = await reconcileContext();
    const live = await tempFile(
      dataDir,
      `agent-platforms.json.${process.pid}.tmp`,
      ORPHANED_STATE_MIN_AGE_MS * 2,
    );

    expect(await sweepAbandonedTempFiles(context)).toBe(0);
    expect(await exists(live)).toBe(true);
  });

  test("keeps a fresh temp file even when its writer is gone", async () => {
    const { context, dataDir } = await reconcileContext();
    const fresh = await tempFile(dataDir, `agent-platforms.json.${await deadPid()}.tmp`, 0);

    expect(await sweepAbandonedTempFiles(context)).toBe(0);
    expect(await exists(fresh)).toBe(true);
  });
});
