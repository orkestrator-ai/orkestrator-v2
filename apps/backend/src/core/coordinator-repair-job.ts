import { timingValue, type AgentTestTiming } from "./agent-test-timing.js";
import type { BackendActivityJob } from "./backend-activity-jobs.js";

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
}

/**
 * The coordinator-repair activity job. In an isolated agent-test profile a
 * spec may shorten the delay before the next pass with
 * `coordinatorRepairIntervalMs` (to-do 7569 (retired), task 4): the pass returns
 * it as its next delay, which `BackendActivityJobs` honours. The pass already
 * scheduled when the file is written keeps its delay.
 */
export function coordinatorRepairJob(options: CoordinatorRepairJobOptions): BackendActivityJob {
  const { intervalMs, timing } = options;
  return {
    name: "coordinator-repair",
    kind: "coordinator-repair",
    priority: "recovery",
    intervalMs,
    run: async () => {
      await options.repair();
      return timing ? timingValue(timing, "coordinatorRepairIntervalMs", intervalMs) : undefined;
    },
    onError: options.onError,
    ...(options.onSuccess ? { onSuccess: options.onSuccess } : {}),
  };
}
