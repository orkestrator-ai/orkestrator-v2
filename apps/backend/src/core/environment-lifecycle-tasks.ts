import type { StorageService } from "./storage.js";

export const ENVIRONMENT_LIFECYCLE_SHUTDOWN_ERROR =
  "Backend is shutting down; environment lifecycle operations cannot be started";

export const INTERRUPTED_ENVIRONMENT_LIFECYCLE_ERROR =
  "Environment startup was interrupted because the backend stopped unexpectedly. Retry the environment start.";

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

  beginShutdown(): Promise<void> {
    this.accepting = false;
    this.shutdownPromise ??= this.drain();
    return this.shutdownPromise;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  pendingCount(): number {
    return this.tasks.size;
  }

  private async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }
}

/**
 * A process exit can interrupt a persisted `creating` transition before its
 * matching completion write. No lifecycle work survives a backend restart, so
 * leaving that state in place would report progress that can never complete.
 */
export async function reconcileInterruptedEnvironmentLifecycleTasks(
  storage: StorageService,
): Promise<string[]> {
  const interrupted = (await storage.loadEnvironments()).filter(
    (environment) => environment.status === "creating",
  );
  for (const environment of interrupted) {
    await storage.updateEnvironment(environment.id, {
      status: "error",
      lifecycleError: INTERRUPTED_ENVIRONMENT_LIFECYCLE_ERROR,
    });
  }
  return interrupted.map((environment) => environment.id);
}
