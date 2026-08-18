import type { StorageService } from "./storage.js";

export const ENVIRONMENT_LIFECYCLE_SHUTDOWN_ERROR =
  "Backend is shutting down; environment lifecycle operations cannot be started";

export const INTERRUPTED_ENVIRONMENT_LIFECYCLE_ERROR =
  "Environment startup was interrupted because the backend stopped unexpectedly. Retry the environment start.";

/** Long enough for a `docker stop` to land, short enough to still be a quit. */
export const ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Owns environment lifecycle work that has been accepted by one backend
 * instance. Admission is closed synchronously when shutdown starts, while the
 * returned drain waits for every operation that was accepted before that point.
 *
 * The operation factory is intentionally lazy. Accepting an already-created
 * promise would allow it to mutate external state before the shutdown guard had
 * a chance to reject it.
 */
export class EnvironmentLifecycleTaskTracker {
  private accepting = true;
  private readonly tasks = new Set<Promise<unknown>>();
  private shutdownPromise: Promise<void> | null = null;

  admit<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      // Admission failure must be observable before a background command sends
      // its acknowledgement. Returning a rejected promise here would let a
      // caller accidentally detach it and report work as accepted.
      throw new Error(ENVIRONMENT_LIFECYCLE_SHUTDOWN_ERROR);
    }

    let task: Promise<T>;
    try {
      task = Promise.resolve(operation());
    } catch (error) {
      task = Promise.reject(error);
    }
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  /**
   * Closes admission immediately and resolves once accepted work has drained or
   * `timeoutMs` elapses, whichever is first.
   *
   * The deadline is not optional in practice. A drain covers queued operations
   * that have not started, and a queued container start or worktree delete is
   * allowed minutes. Nothing above this bounds shutdown, so an unbounded wait
   * here holds the process open until the OS kills it — losing the cleanup that
   * runs after the drain. Abandoned work still completes or dies with the
   * process; the deadline only stops shutdown blocking on it.
   */
  beginShutdown(timeoutMs = ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS): Promise<void> {
    this.accepting = false;
    this.shutdownPromise ??= this.drainWithin(timeoutMs);
    return this.shutdownPromise;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  pendingCount(): number {
    return this.tasks.size;
  }

  private async drainWithin(timeoutMs: number): Promise<void> {
    if (this.tasks.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      // A pending timer must not be the reason the process stays alive.
      timer.unref?.();
    });
    try {
      await Promise.race([this.drain(), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}

export interface InterruptedEnvironmentLifecycleReconciliation {
  /** Every environment whose persisted lifecycle state was reconciled. */
  reconciledEnvironmentIds: string[];
  /**
   * Environments whose durable deletion intent still requires cleanup.
   *
   * The composition root can use these ids to re-admit the idempotent deletion
   * continuation after command admission is ready. Reconciliation deliberately
   * does not clear the deletion tombstone before that continuation succeeds.
   */
  deletionRecoveryEnvironmentIds: string[];
}

/**
 * A process exit can interrupt a persisted `creating` transition before its
 * matching completion write, or a persisted `deleting` marker before its
 * cleanup. No lifecycle work survives a backend restart, so creation is moved
 * to a retryable error and interrupted deletion is returned to the composition
 * root for re-admission.
 *
 * Deletion intent is different from an ordinary progress marker:
 * `deletionRequestedAt` is a durable tombstone consulted by background writes.
 * It must remain in place until deletion actually succeeds, including while
 * restart recovery is waiting to be scheduled.
 */
export async function reconcileInterruptedEnvironmentLifecycleTasks(
  storage: StorageService,
): Promise<InterruptedEnvironmentLifecycleReconciliation> {
  const environments = await storage.loadEnvironments();
  const reconciled = new Set<string>();
  const deletionRecoveryEnvironmentIds: string[] = [];

  for (const environment of environments) {
    if (environment.status === "creating") {
      await storage.updateEnvironment(environment.id, {
        status: "error",
        // `creating` is not written only by a start in progress:
        // `syncStoredEnvironmentStatus` also derives it from Docker's `created`
        // state, which is exactly where a container whose `docker start` failed
        // comes to rest. Overwriting the recorded reason would replace an
        // accurate diagnosis with a false one on every subsequent boot.
        ...(environment.lifecycleError
          ? {}
          : { lifecycleError: INTERRUPTED_ENVIRONMENT_LIFECYCLE_ERROR }),
      });
      reconciled.add(environment.id);
    }

    // Creation and deletion are intentionally reconciled independently. A
    // backend can stop after deletion intent is persisted but before an older
    // `creating` status is replaced; skipping either half would strand the
    // environment or re-enable background writes to partially deleted state.
    if (environment.lifecycleOperation === "deleting") {
      if (!environment.deletionRequestedAt) {
        // Repair older or partially written records while keeping the value
        // stable across later restarts.
        await storage.updateEnvironment(environment.id, {
          deletionRequestedAt: environment.lifecycleOperationStartedAt ?? new Date().toISOString(),
        });
      }
      deletionRecoveryEnvironmentIds.push(environment.id);
      reconciled.add(environment.id);
    }
  }

  return {
    reconciledEnvironmentIds: [...reconciled],
    deletionRecoveryEnvironmentIds,
  };
}
