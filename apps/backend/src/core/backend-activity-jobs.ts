import type {
  RecurringJobKind,
  RecurringPriorityClass,
} from "@orkestrator/protocol/recurring-work";
import type { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import {
  RecurringScheduler,
  type RecurringSchedulerStatus,
  type RecurringTimerFactory,
} from "./recurring-scheduler.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";

/**
 * The backend's activity bundle as named due jobs (step 08, tasks 10–11).
 *
 * Previously one 2 s `setInterval` started the native activity sweep, Claude
 * terminal-state reconcile, tmux queue drain, mail presence, mail injection
 * and pending renames together, and ran coordinator repair and mail
 * retention on `% 30` of that tick count; tab cleanup had its own 60 s timer.
 * Sharing a timer shared no reads, and the maintenance deadlines drifted with
 * the activity timer's health.
 *
 * Each job is now its own key with its own deadline on a small scheduler:
 *
 * - **Fixed rate, never overlapping.** A 2 s job's next due time is measured
 *   from its *start* (`interval − duration`, never negative), so its cadence
 *   — including the mail presence refresh behind the 4 s presence TTL — is
 *   the one it had, while the scheduler's one-run-per-key replaces the
 *   hand-written in-flight guards (which remain inside each operation too).
 * - **Elapsed maintenance.** Coordinator repair, mail retention and tab
 *   cleanup run on their own 60 s deadlines from start-up, independent of
 *   how many activity passes happened.
 * - **Adaptive intent.** A job may report that nothing is pending and rest on
 *   a slower safety cadence until woken (pending renames).
 * - **Metrics unchanged.** Every operation keeps its own recurring-work
 *   instrumentation; the scheduler records into a private, disabled recorder
 *   so attempts are not double counted. Its content-free status is still
 *   registered with the diagnostics.
 */

export interface BackendActivityJob {
  name: string;
  kind: RecurringJobKind;
  priority: Exclude<RecurringPriorityClass, "critical">;
  intervalMs: number;
  /** First run delay (defaults to `intervalMs`, as the interval timer did). */
  initialDelayMs?: number;
  /** Measure the next due time from the run's start (fixed rate). */
  fixedRate?: boolean;
  /**
   * Returns the next delay from the run's result: e.g. the safety cadence
   * when nothing is pending. `undefined` keeps the interval policy.
   */
  run(): Promise<number | undefined | void>;
  onError(error: unknown): void;
}

export class BackendActivityJobs {
  private scheduler: RecurringScheduler | null = null;

  constructor(
    private readonly jobs: readonly BackendActivityJob[],
    private readonly options: {
      now?: () => number;
      timers?: RecurringTimerFactory;
      diagnostics?: RecurringDiagnosticsRegistry | null;
    } = {},
  ) {}

  start(): void {
    if (this.scheduler) return;
    const now = this.options.now ?? (() => performance.now());
    const scheduler = new RecurringScheduler({
      owner: "maintenance",
      limits: {
        maxConcurrent: Math.max(1, this.jobs.length),
        reservedConcurrency: 0,
        maxKeys: Math.max(8, this.jobs.length + 1),
        reservedKeys: 1,
      },
      now,
      ...(this.options.timers ? { timers: this.options.timers } : {}),
      ...(this.options.diagnostics !== undefined ? { diagnostics: this.options.diagnostics } : {}),
      metrics: new RecurringWorkMetrics({ enabled: false }),
    });
    for (const job of this.jobs) {
      scheduler.register({
        key: job.name,
        kind: job.kind,
        priority: job.priority,
        deadline: "hard",
        intervalMs: job.intervalMs,
        initialDelayMs: job.initialDelayMs ?? job.intervalMs,
        run: async () => {
          const startedAt = now();
          let requested: number | undefined;
          try {
            const result = await job.run();
            if (typeof result === "number" && Number.isFinite(result) && result >= 0) {
              requested = result;
            }
          } catch (error) {
            job.onError(error);
          }
          if (requested !== undefined) return { outcome: "success", nextDelayMs: requested };
          if (!job.fixedRate) return { outcome: "success" };
          return {
            outcome: "success",
            nextDelayMs: Math.max(0, job.intervalMs - (now() - startedAt)),
          };
        },
      });
    }
    this.scheduler = scheduler;
  }

  /** Pulls a job forward (a wakeup hint). Dropped while the job runs. */
  wake(name: string): void {
    this.scheduler?.requestSooner(name);
  }

  stop(): void {
    const scheduler = this.scheduler;
    this.scheduler = null;
    if (scheduler) void scheduler.dispose({ timeoutMs: 0 });
  }

  status(): RecurringSchedulerStatus | null {
    return this.scheduler?.status() ?? null;
  }
}
