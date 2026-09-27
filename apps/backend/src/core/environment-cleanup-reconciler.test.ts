import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "./commands-context.js";
import {
  environmentCleanupLedger,
  type EnvironmentCleanupEntry,
} from "./environment-cleanup-ledger.js";
import {
  MAX_ENVIRONMENT_CLEANUP_ATTEMPTS,
  ORPHANED_STATE_MIN_AGE_MS,
  cancelScheduledEnvironmentCleanup,
  reconcileEnvironmentCleanup,
  runStartupEnvironmentCleanup,
  scheduleEnvironmentCleanupReconcile,
  sweepOrphanedEnvironmentState,
} from "./environment-cleanup-reconciler.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { environmentStateDirectory } from "./environment-state-paths.js";
import type { Environment } from "./models.js";
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
