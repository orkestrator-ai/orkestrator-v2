import {
  AGENT_TEST_TIMING_BOUNDS,
  timingValue,
  type AgentTestTiming,
} from "./agent-test-timing.js";
import type { BackendActivityJob } from "./backend-activity-jobs.js";

/**
 * How often an agent-test profile's job looks at its timing override: the
 * shortest period an override may set, so a newly written one is honoured
 * within this delay rather than after the pass already scheduled.
 */
export const COORDINATOR_REPAIR_TIMING_CHECK_MS =
  AGENT_TEST_TIMING_BOUNDS.coordinatorRepairIntervalMs[0];

export interface CoordinatorRepairJobOptions {
  /** The production period between passes (`MAINTENANCE_JOB_MS`). */
  intervalMs: number;
  /**
   * An agent-test profile's timing overrides (`agent-test-timing.ts`);
   * `undefined` everywhere else, which keeps the interval policy.
   */
  timing: AgentTestTiming | undefined;
  /** One repair pass: closes delegations whose worker environment stopped. */
  repair(): Promise<void>;
  onError(error: unknown): void;
  onSuccess?(): void;
  /** The activity scheduler's clock; `performance.now` as there by default. */
  now?: () => number;
}

/**
 * The coordinator-repair activity job.
 *
 * Without agent-test timing it is the plain 60 s job. In an isolated
 * agent-test profile a spec may shorten the period with
 * `coordinatorRepairIntervalMs` (to-do 7569 (retired), task 4). There
 * the job wakes every {@link COORDINATOR_REPAIR_TIMING_CHECK_MS} and repairs
 * only once the period in force has passed since the last repair (or since
 * start-up), so an override written mid-period applies within a second
 * instead of after the 60 s pass already scheduled, and a missing override
 * keeps the production cadence. A wake that does not repair reads only the
 * timing file's size and modification time, and reports neither success nor
 * failure.
 */
export function coordinatorRepairJob(options: CoordinatorRepairJobOptions): BackendActivityJob {
  const { intervalMs, timing } = options;
  const base = {
    name: "coordinator-repair",
    kind: "coordinator-repair",
    priority: "recovery",
    intervalMs,
    onError: options.onError,
  } as const;
  if (!timing) {
    return {
      ...base,
      ...(options.onSuccess ? { onSuccess: options.onSuccess } : {}),
      run: async () => {
        await options.repair();
      },
    };
  }
  const now = options.now ?? (() => performance.now());
  const check = Math.min(COORDINATOR_REPAIR_TIMING_CHECK_MS, intervalMs);
  let lastRepairAt = now();
  return {
    ...base,
    initialDelayMs: check,
    run: async () => {
      const period = timingValue(timing, "coordinatorRepairIntervalMs", intervalMs);
      const elapsed = now() - lastRepairAt;
      if (elapsed < period) return Math.min(check, period - elapsed);
      lastRepairAt = now();
      // Reported here, not by the scheduler: it would count every wake that
      // skips as a success and clear a fault the last repair reported.
      try {
        await options.repair();
        options.onSuccess?.();
      } catch (error) {
        options.onError(error);
      }
      return Math.min(check, period);
    },
  };
}
