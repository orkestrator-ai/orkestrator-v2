import type { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import type { ClientEnvironment, Environment } from "./models.js";
import type { EnsureProjectHomeResult } from "./project-home-environment.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";

export type EnvironmentSetupSession = {
  environmentId: string;
  sessionId: string;
  running: boolean;
  startedAt: string;
  completedAt?: string;
  success?: boolean;
  error?: string;
  /** Whether the retained setup session has any transcript to replay. */
  hasOutput?: boolean;
};

export type EnvironmentSetupStartResult = {
  setupStarted: boolean;
  setupSessionId?: string;
  environment: Environment;
};

export type ClientEnvironmentSetupStartResult = Omit<EnvironmentSetupStartResult, "environment"> & {
  environment: ClientEnvironment;
};

/**
 * In-flight environment work of one backend instance: setup sessions, the
 * start/setup/baseline dedupe tasks, the per-environment lifecycle queue,
 * the allowlist apply queue, the project-home ensures, stop drains, container
 * replacement cancellations, the delete and merge guards, and the replacement
 * and move fence (`fence`).
 * Owned by `BackendRuntime` and reached through `context.runtime.environments`
 * at call time.
 *
 * `EnvironmentLifecycleTaskTracker` stays separate: it decides whether work
 * may be admitted at all and drains it on shutdown, while this class decides
 * how admitted work for one environment is ordered and deduplicated.
 */
export class EnvironmentOperations {
  /** Replacement, move and mutation admission (`environment-replacement-fence.ts`). */
  readonly fence = new EnvironmentMutationFence();

  private readonly setupSessions = new Map<string, EnvironmentSetupSession>();
  private readonly setupTasks = new Map<string, Promise<Environment>>();
  private readonly setupStartTasks = new Map<string, Promise<EnvironmentSetupStartResult>>();
  private readonly startTasks = new Map<string, Promise<EnvironmentSetupStartResult>>();
  private readonly lifecycleQueue = new Map<string, Promise<void>>();
  private readonly baselineTasks = new Map<string, Promise<Environment>>();
  private readonly deleting = new Set<string>();
  private readonly merging = new Set<string>();
  private readonly mergeCleanupRecoveries = new Map<string, Promise<void>>();
  private readonly projectHomeEnsures = new Map<string, Promise<EnsureProjectHomeResult>>();
  /** Allowlist applies into the running container, one per environment at a time. */
  private readonly allowedDomainsApplies = new Map<string, Promise<void>>();
  /** Environments whose explicit stop is draining their container's workload. */
  private readonly draining = new Set<string>();
  /** Container replacements whose user asked to stop before commit, by operation id. */
  private readonly replacementCancellations = new Set<string>();

  // Setup sessions and tasks

  setupSession(environmentId: string): EnvironmentSetupSession | undefined {
    return this.setupSessions.get(environmentId);
  }

  hasSetupSession(environmentId: string): boolean {
    return this.setupSessions.has(environmentId);
  }

  recordSetupSession(session: EnvironmentSetupSession): void {
    this.setupSessions.set(session.environmentId, session);
  }

  setupTask(environmentId: string): Promise<Environment> | undefined {
    return this.setupTasks.get(environmentId);
  }

  /** Publishes the running setup; it removes itself once it settles. */
  trackSetupTask(environmentId: string, task: Promise<Environment>): Promise<Environment> {
    const tracked = task.finally(() => {
      this.setupTasks.delete(environmentId);
    });
    this.setupTasks.set(environmentId, tracked);
    return tracked;
  }

  /** Joins the environment's in-flight setup start, or begins one. */
  joinSetupStart(
    environmentId: string,
    start: () => Promise<EnvironmentSetupStartResult>,
  ): Promise<EnvironmentSetupStartResult> {
    return dedupe(this.setupStartTasks, environmentId, start);
  }

  /** Joins the environment's in-flight baseline capture, or begins one. */
  joinBaselineCapture(
    environmentId: string,
    capture: () => Promise<Environment>,
  ): Promise<Environment> {
    return dedupe(this.baselineTasks, environmentId, capture);
  }

  /** Drops setup bookkeeping when the owning environment is removed. */
  forgetSetupState(environmentId: string): void {
    this.setupSessions.delete(environmentId);
    this.setupTasks.delete(environmentId);
    this.setupStartTasks.delete(environmentId);
    this.baselineTasks.delete(environmentId);
  }

  // Starts and the lifecycle queue

  isStarting(environmentId: string): boolean {
    return this.startTasks.has(environmentId);
  }

  /** Joins the environment's in-flight start, or begins one. */
  joinStart(
    environmentId: string,
    start: () => Promise<EnvironmentSetupStartResult>,
  ): Promise<EnvironmentSetupStartResult> {
    return dedupe(this.startTasks, environmentId, start);
  }

  /**
   * Once a conflicting operation has been admitted, a later start must queue
   * behind it instead of joining an earlier start that will be stopped/deleted.
   */
  invalidateStartDedupe(environmentId: string): void {
    this.startTasks.delete(environmentId);
  }

  /** A start or another lifecycle operation is queued or running. */
  hasLifecycleWork(environmentId: string): boolean {
    return this.lifecycleQueue.has(environmentId) || this.startTasks.has(environmentId);
  }

  /**
   * Serializes all resource-changing lifecycle operations for one environment.
   *
   * The queue tail always settles successfully so one failed operation cannot
   * poison retries. Callers still receive the original result/rejection.
   */
  enqueueLifecycleOperation<T>(
    environmentId: string,
    tasks: EnvironmentLifecycleTaskTracker,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleQueue.get(environmentId) ?? Promise.resolve();
    const result = tasks.admit(() => previous.then(operation, operation));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleQueue.set(environmentId, tail);
    void tail.finally(() => {
      if (this.lifecycleQueue.get(environmentId) === tail) {
        this.lifecycleQueue.delete(environmentId);
      }
    });
    return result;
  }

  // Project homes and allowlist applies

  /** Joins the project's in-flight project-home ensure, or begins one. */
  joinProjectHomeEnsure(
    projectId: string,
    ensure: () => Promise<EnsureProjectHomeResult>,
  ): Promise<EnsureProjectHomeResult> {
    return dedupe(this.projectHomeEnsures, projectId, ensure);
  }

  /**
   * Runs `apply` after the environment's previous allowlist apply settles,
   * whatever its outcome. Callers receive the original result or rejection.
   */
  enqueueAllowedDomainsApply<T>(environmentId: string, apply: () => Promise<T>): Promise<T> {
    const previous = this.allowedDomainsApplies.get(environmentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(apply);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.allowedDomainsApplies.set(environmentId, settled);
    void settled.then(() => {
      if (this.allowedDomainsApplies.get(environmentId) === settled) {
        this.allowedDomainsApplies.delete(environmentId);
      }
    });
    return next;
  }

  // Stop drains (`container-readiness.ts` fences the container itself)

  isDraining(environmentId: string): boolean {
    return this.draining.has(environmentId);
  }

  /** Marks the environment draining until the returned function is called. */
  beginDrain(environmentId: string): () => void {
    this.draining.add(environmentId);
    return () => {
      this.draining.delete(environmentId);
    };
  }

  // Container replacement cancellation

  /** The replacement stops at its next phase boundary and rolls back. */
  requestReplacementCancellation(operationId: string): void {
    this.replacementCancellations.add(operationId);
  }

  isReplacementCancellationRequested(operationId: string): boolean {
    return this.replacementCancellations.has(operationId);
  }

  /** Called once the replacement commits or fails. */
  forgetReplacementCancellation(operationId: string): void {
    this.replacementCancellations.delete(operationId);
  }

  // Delete and merge guards

  isDeleting(environmentId: string): boolean {
    return this.deleting.has(environmentId);
  }

  assertNotDeleting(environmentId: string | undefined): void {
    if (environmentId && this.deleting.has(environmentId)) {
      throw new Error(`Environment is being deleted: ${environmentId}`);
    }
  }

  /** Reserves the delete tombstone; false when a delete already holds it. */
  beginDelete(environmentId: string): boolean {
    if (this.deleting.has(environmentId)) return false;
    this.deleting.add(environmentId);
    return true;
  }

  endDelete(environmentId: string): void {
    this.deleting.delete(environmentId);
  }

  isMerging(environmentId: string): boolean {
    return this.merging.has(environmentId);
  }

  /** Reserves the merge guard; false when a merge already holds it. */
  beginMerge(environmentId: string): boolean {
    if (this.merging.has(environmentId)) return false;
    this.merging.add(environmentId);
    return true;
  }

  endMerge(environmentId: string): void {
    this.merging.delete(environmentId);
  }

  /** Runs one merge-cleanup recovery per environment at a time. */
  scheduleMergeCleanupRecovery(environmentId: string, recover: () => Promise<void>): void {
    if (this.mergeCleanupRecoveries.has(environmentId)) return;
    const task = recover().finally(() => {
      if (this.mergeCleanupRecoveries.get(environmentId) === task) {
        this.mergeCleanupRecoveries.delete(environmentId);
      }
    });
    this.mergeCleanupRecoveries.set(environmentId, task);
  }
}

function dedupe<T>(tasks: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const existing = tasks.get(key);
  if (existing) return existing;
  const task = run().finally(() => {
    if (tasks.get(key) === task) tasks.delete(key);
  });
  tasks.set(key, task);
  return task;
}
