import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENVIRONMENT_LIFECYCLE_SHUTDOWN_ERROR,
  EnvironmentLifecycleTaskTracker,
  INTERRUPTED_ENVIRONMENT_LIFECYCLE_ERROR,
  reconcileInterruptedEnvironmentLifecycleTasks,
} from "./environment-lifecycle-tasks.js";
import { StorageService } from "./storage.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("EnvironmentLifecycleTaskTracker", () => {
  test("drains every accepted operation, including queued work", async () => {
    const tracker = new EnvironmentLifecycleTaskTracker();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstTask = tracker.admit(() => first.promise);
    const secondTask = tracker.admit(() => first.promise.then(() => second.promise));

    const shutdown = tracker.beginShutdown();
    let drained = false;
    void shutdown.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(tracker.pendingCount()).toBe(2);

    first.resolve();
    await firstTask;
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(tracker.pendingCount()).toBe(1);

    second.resolve();
    await secondTask;
    await shutdown;
    expect(drained).toBe(true);
    expect(tracker.pendingCount()).toBe(0);
  });

  test("closes admission synchronously and never invokes rejected work", async () => {
    const tracker = new EnvironmentLifecycleTaskTracker();
    await tracker.beginShutdown();
    let invoked = false;

    expect(() => tracker.admit(async () => {
      invoked = true;
    })).toThrow(ENVIRONMENT_LIFECYCLE_SHUTDOWN_ERROR);
    expect(invoked).toBe(false);
    expect(tracker.isAccepting()).toBe(false);
  });

  test("settles shutdown after a tracked operation rejects", async () => {
    const tracker = new EnvironmentLifecycleTaskTracker();
    const operation = deferred<void>();
    const task = tracker.admit(() => operation.promise);
    const shutdown = tracker.beginShutdown();

    operation.reject(new Error("provisioning failed"));
    await expect(task).rejects.toThrow("provisioning failed");
    await expect(shutdown).resolves.toBeUndefined();
    expect(tracker.pendingCount()).toBe(0);
  });

  test("returns one idempotent shutdown promise", () => {
    const tracker = new EnvironmentLifecycleTaskTracker();
    expect(tracker.beginShutdown()).toBe(tracker.beginShutdown());
  });

  test("converts a synchronously throwing operation into a rejection", async () => {
    const tracker = new EnvironmentLifecycleTaskTracker();

    const task = tracker.admit(() => {
      throw new Error("factory exploded");
    });

    await expect(task).rejects.toThrow("factory exploded");
    // A synchronous throw must still leave the tracker drainable rather than
    // stranding an entry nothing will ever settle.
    await expect(tracker.beginShutdown()).resolves.toBeUndefined();
    expect(tracker.pendingCount()).toBe(0);
  });

  test("stops waiting on work that outlives the drain deadline", async () => {
    const tracker = new EnvironmentLifecycleTaskTracker();
    const stuck = deferred<void>();
    const task = tracker.admit(() => stuck.promise);

    // Nothing above shutdown bounds it, so an operation that never settles must
    // not hold the process open past the deadline.
    await expect(tracker.beginShutdown(5)).resolves.toBeUndefined();
    expect(tracker.pendingCount()).toBe(1);

    stuck.resolve();
    await task;
  });

  test("keeps the drain open for work that finishes within the deadline", async () => {
    const tracker = new EnvironmentLifecycleTaskTracker();
    const slow = deferred<void>();
    let settled = false;
    const task = tracker.admit(() => slow.promise.then(() => {
      settled = true;
    }));

    const shutdown = tracker.beginShutdown(5_000);
    slow.resolve();
    await shutdown;

    expect(settled).toBe(true);
    await task;
  });

  test("resolves immediately when nothing was ever admitted", async () => {
    const tracker = new EnvironmentLifecycleTaskTracker();
    await expect(tracker.beginShutdown(5_000)).resolves.toBeUndefined();
  });
});

test("startup reconciliation marks every interrupted creating environment as retryable error", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-lifecycle-recovery-"));
  const storage = new StorageService(dataDir);
  try {
    await storage.init();
    await storage.addEnvironment({
      id: "interrupted-local",
      projectId: "project",
      name: "Interrupted local",
      branch: "interrupted-local",
      containerId: null,
      status: "creating",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      environmentType: "local",
      order: 0,
      worktreePath: path.join(dataDir, "worktree"),
    });
    await storage.addEnvironment({
      id: "already-running",
      projectId: "project",
      name: "Running",
      branch: "running",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      environmentType: "local",
      order: 1,
    });

    await expect(reconcileInterruptedEnvironmentLifecycleTasks(storage))
      .resolves.toEqual(["interrupted-local"]);
    await expect(storage.getEnvironment("interrupted-local")).resolves.toMatchObject({
      status: "error",
      lifecycleError: INTERRUPTED_ENVIRONMENT_LIFECYCLE_ERROR,
    });
    await expect(storage.getEnvironment("already-running")).resolves.toMatchObject({
      status: "running",
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup reconciliation keeps a recorded failure instead of replacing it", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-lifecycle-preserve-"));
  const storage = new StorageService(dataDir);
  try {
    await storage.init();
    await storage.addEnvironment({
      id: "created-container",
      projectId: "project",
      name: "Created container",
      branch: "created-container",
      containerId: "container-created",
      status: "creating",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      environmentType: "containerized",
      order: 0,
    });
    // `creating` is also what `syncStoredEnvironmentStatus` derives from
    // Docker's `created` state, which is exactly where a container whose
    // `docker start` failed comes to rest. Reconciliation must not overwrite
    // that accurate reason with "the backend stopped unexpectedly".
    await storage.updateEnvironment("created-container", {
      lifecycleError: "The container runtime is unavailable. Start it and retry.",
    });

    await expect(reconcileInterruptedEnvironmentLifecycleTasks(storage))
      .resolves.toEqual(["created-container"]);
    await expect(storage.getEnvironment("created-container")).resolves.toMatchObject({
      status: "error",
      lifecycleError: "The container runtime is unavailable. Start it and retry.",
    });
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("startup reconciliation clears a delete marker no in-memory tombstone backs", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-lifecycle-deleting-"));
  const storage = new StorageService(dataDir);
  try {
    await storage.init();
    await storage.addEnvironment({
      id: "stranded-delete",
      projectId: "project",
      name: "Stranded delete",
      branch: "stranded-delete",
      containerId: null,
      status: "stopped",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      environmentType: "local",
      order: 0,
    });
    await storage.updateEnvironment("stranded-delete", {
      lifecycleOperation: "deleting",
      lifecycleOperationStartedAt: new Date(0).toISOString(),
      deletionRequestedAt: new Date(0).toISOString(),
    });

    await expect(reconcileInterruptedEnvironmentLifecycleTasks(storage))
      .resolves.toEqual(["stranded-delete"]);
    const reconciled = await storage.getEnvironment("stranded-delete");
    expect(reconciled?.lifecycleOperation).toBeUndefined();
    expect(reconciled?.lifecycleOperationStartedAt).toBeUndefined();
    expect(reconciled?.deletionRequestedAt).toBeUndefined();
    // A stranded marker is not a failure; the environment keeps its status.
    expect(reconciled?.status).toBe("stopped");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
