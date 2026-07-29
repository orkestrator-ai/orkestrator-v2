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

/**
 * A process exit can interrupt a persisted `creating` transition before its
 * matching completion write, or a persisted `deleting` marker before its
 * cleanup. No lifecycle work survives a backend restart and both markers are
 * backed only by in-memory state, so leaving either in place reports progress
 * that can never complete.
 */
export async function reconcileInterruptedEnvironmentLifecycleTasks(
  storage: StorageService,
): Promise<string[]> {
  const environments = await storage.loadEnvironments();
  const reconciled: string[] = [];

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
      reconciled.push(environment.id);
      continue;
    }

    // Deletion is guarded by an in-memory tombstone, so a backend killed
    // mid-delete leaves a "Deleting…" record nothing else reconciles.
    if (environment.lifecycleOperation === "deleting") {
      await storage.updateEnvironment(environment.id, {
        lifecycleOperation: null,
        lifecycleOperationStartedAt: null,
        deletionRequestedAt: null,
      });
      reconciled.push(environment.id);
    }
  }

  return reconciled;
}
