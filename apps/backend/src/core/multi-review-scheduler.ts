/**
 * Due-time supervision for backend-owned review workflows.
 *
 * The previous supervisor scanned every workflow once a second and, when a
 * timer fired during a slow pass, immediately ran another pass as soon as the
 * first finished. A panel whose pass took longer than a second therefore ran
 * continuously, re-reading every reviewer's status back to back.
 *
 * This scheduler keeps one due time per active workflow instead:
 *
 * - A pass is started when its workflow is due, and the next due time is
 *   computed from the pass's *completion*, never from the missed deadline, so
 *   a slow pass cannot build a backlog.
 * - A workflow that is already running is never started twice; a timer wake
 *   for it is simply dropped, and its completion schedules the next pass.
 * - A slow reconciliation scan rediscovers workflows from authoritative storage
 *   — after a restart, a missed wake, or a write from another path — so a lost
 *   signal delays work by at most one scan interval but never strands it.
 * - Ready workflows start in due order under a global cap, so one large panel
 *   cannot monopolize the service while others wait.
 *
 * Nothing here is persisted. The durable workflow is the only authority; this
 * is a timer projection of it, rebuilt by the first scan after startup.
 *
 * This is the `multi-review` domain's rollback under
 * `ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK`; it goes with that switch
 * (0048-recurring-work-qualification.md).
 */
import { type RecurringTimerFactory, systemRecurringTimers } from "./recurring-scheduler.js";

export interface WorkflowDueSchedulerOptions {
  /** Runs one supervision pass. Must not reject for workflow-level faults. */
  run(workflowId: string): Promise<void>;
  /** Epoch ms of the next pass after one completes; `undefined` unschedules. */
  nextDueAt(workflowId: string): Promise<number | undefined>;
  /** IDs of every workflow that currently needs supervision, from storage. */
  discover(): Promise<string[]>;
  /** Reconciliation scan period. */
  reconcileIntervalMs: number;
  /** Maximum workflows advanced at once. */
  maxConcurrent: number;
  now?: () => number;
  /** Test seam: timers on the same clock as {@link now}. */
  timers?: RecurringTimerFactory;
  /** Receives bounded, content-free pass diagnostics. */
  onPass?(event: { queueDelayMs: number; durationMs: number }): void;
}

/** Hard ceiling on tracked workflows; each environment has at most one active. */
const MAX_SCHEDULED_WORKFLOWS = 4_096;

export class WorkflowDueScheduler {
  private readonly due = new Map<string, number>();
  private readonly dueRevision = new Map<string, number>();
  private revision = 0;
  private readonly running = new Map<string, Promise<void>>();
  private timer: unknown = null;
  private reconcileAt = 0;
  private reconciling: Promise<void> | null = null;
  private stopped = true;
  private readonly now: () => number;
  private readonly timers: RecurringTimerFactory;

  constructor(private readonly options: WorkflowDueSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? systemRecurringTimers;
  }

  get active(): boolean {
    return !this.stopped;
  }

  /** Number of workflows with a pending due time; bounded by active workflows. */
  get scheduledCount(): number {
    return this.due.size;
  }

  /** Passes and reconciliation scans running now. */
  get inFlight(): number {
    return this.running.size + (this.reconciling ? 1 : 0);
  }

  start(): void {
    this.stopped = false;
    this.reconcileAt = this.now();
    this.arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.due.clear();
    this.dueRevision.clear();
    await Promise.allSettled([
      ...this.running.values(),
      ...(this.reconciling ? [this.reconciling] : []),
    ]);
  }

  /**
   * Requests a pass no later than `dueAt` (default: now). Used for user
   * actions, dispatch completions and other wake signals. A wake for a running
   * workflow is kept, so its pass reruns once after it completes — at most
   * once, however many wakes arrive while it runs.
   */
  wake(workflowId: string, dueAt: number = this.now()): void {
    if (this.stopped) return;
    const existing = this.due.get(workflowId);
    if (existing === undefined && this.due.size >= MAX_SCHEDULED_WORKFLOWS) return;
    // A wake during discover is newer than that scan even when an earlier
    // deadline was already queued. Reconciliation must not discard it.
    this.dueRevision.set(workflowId, ++this.revision);
    if (existing !== undefined && existing <= dueAt) return;
    this.due.set(workflowId, dueAt);
    this.arm();
  }

  /** Schedules the pass after one that ran outside the scheduler. */
  async reschedule(workflowId: string): Promise<void> {
    if (this.stopped || this.running.has(workflowId)) return;
    const next = await this.options.nextDueAt(workflowId).catch(() => undefined);
    if (next !== undefined) this.wake(workflowId, next);
  }

  forget(workflowId: string): void {
    this.due.delete(workflowId);
    this.dueRevision.delete(workflowId);
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    let nextAt = this.reconciling ? Infinity : this.reconcileAt;
    if (this.running.size < this.options.maxConcurrent) {
      for (const [workflowId, dueAt] of this.due) {
        if (!this.running.has(workflowId) && dueAt < nextAt) nextAt = dueAt;
      }
    }
    if (!Number.isFinite(nextAt)) return;
    this.timer = this.timers.set(() => void this.fire(), Math.max(0, nextAt - this.now()));
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    if (this.now() >= this.reconcileAt && !this.reconciling) {
      this.reconciling = this.reconcile().finally(() => {
        this.reconciling = null;
      });
      await this.reconciling;
    }
    this.pump();
    this.arm();
  }

  private async reconcile(): Promise<void> {
    const scanRevision = this.revision;
    try {
      const ids = await this.options.discover();
      const discovered = new Set(ids);
      for (const workflowId of ids) {
        if (!this.running.has(workflowId) && !this.due.has(workflowId)) {
          this.wake(workflowId);
        }
      }
      // Drop timers for workflows storage no longer reports as supervised
      // (terminal or deleted), so the map tracks only live work.
      for (const workflowId of Array.from(this.due.keys())) {
        if (
          !discovered.has(workflowId) &&
          (this.dueRevision.get(workflowId) ?? 0) <= scanRevision
        ) {
          this.due.delete(workflowId);
          this.dueRevision.delete(workflowId);
        }
      }
    } catch (error) {
      console.warn(
        "[multi-review] Reconciliation scan failed:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.reconcileAt = this.now() + this.options.reconcileIntervalMs;
    }
  }

  private pump(): void {
    if (this.stopped) return;
    const now = this.now();
    const ready = Array.from(this.due)
      .filter(([workflowId, dueAt]) => dueAt <= now && !this.running.has(workflowId))
      .sort(([leftId, left], [rightId, right]) => left - right || leftId.localeCompare(rightId));
    for (const [workflowId, dueAt] of ready) {
      if (this.running.size >= this.options.maxConcurrent) break;
      this.due.delete(workflowId);
      this.dueRevision.delete(workflowId);
      const started = this.now();
      const pass = this.options
        .run(workflowId)
        .catch(() => undefined)
        .then(async () => {
          this.options.onPass?.({
            queueDelayMs: Math.max(0, started - dueAt),
            durationMs: Math.max(0, this.now() - started),
          });
          if (this.stopped) return;
          const next = await this.options.nextDueAt(workflowId).catch(() => undefined);
          if (next !== undefined && !this.stopped) {
            // Computed from completion: a slow pass pushes its successor out
            // rather than queueing a catch-up.
            const pendingWake = this.due.get(workflowId);
            this.due.set(
              workflowId,
              pendingWake === undefined ? next : Math.min(pendingWake, next),
            );
            if (pendingWake === undefined) this.dueRevision.set(workflowId, ++this.revision);
          }
        })
        .finally(() => {
          this.running.delete(workflowId);
          this.pump();
          this.arm();
        });
      this.running.set(workflowId, pass);
    }
  }
}
