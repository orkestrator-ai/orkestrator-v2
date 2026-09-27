/**
 * Bounded, order-preserving task pool for one reviewer fan-out pass.
 *
 * Every reviewer is an independent input, so its provider I/O can overlap with
 * its peers'. It must not overlap without a cap: 32 simultaneous session
 * creations merely move the bottleneck into provider rate limits and local
 * agent processes. Each task therefore names a pool (admission or observation)
 * and a group (the provider platform); a task starts only when both have
 * capacity. Queued tasks start in list order, so initial admission is fair to
 * the configured reviewer order even though completion order is not.
 *
 * The pool owns no state beyond one pass. It never retries and never swallows:
 * a task's own error handling decides what a failure means.
 */

/** Conservative default number of reviewers set up at once. */
export const DEFAULT_REVIEW_ADMISSION_CONCURRENCY = 4;
/** Default number of running reviewers observed at once. */
export const DEFAULT_REVIEW_OBSERVATION_CONCURRENCY = 8;
/** Default number of concurrent operations against one provider platform. */
export const DEFAULT_REVIEW_PROVIDER_CONCURRENCY = 4;
/** Hard ceiling for any configured limit; configuration cannot exceed it. */
export const MAX_REVIEW_FANOUT_CONCURRENCY = 16;

export interface ReviewFanoutConcurrency {
  admission: number;
  observation: number;
  provider: number;
}

/** Clamps configured limits to `[1, MAX_REVIEW_FANOUT_CONCURRENCY]`. */
export function reviewFanoutConcurrency(
  configured: Partial<ReviewFanoutConcurrency> = {},
): ReviewFanoutConcurrency {
  const clamp = (value: number | undefined, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(MAX_REVIEW_FANOUT_CONCURRENCY, Math.max(1, Math.floor(value)));
  };
  return {
    admission: clamp(configured.admission, DEFAULT_REVIEW_ADMISSION_CONCURRENCY),
    observation: clamp(configured.observation, DEFAULT_REVIEW_OBSERVATION_CONCURRENCY),
    provider: clamp(configured.provider, DEFAULT_REVIEW_PROVIDER_CONCURRENCY),
  };
}

export interface BoundedTask {
  pool: "admission" | "observation";
  /** Provider platform or another bounded, non-sensitive grouping key. */
  group: string;
  run(): Promise<void>;
}

export interface BoundedTaskStats {
  /** Highest simultaneous task count observed, per pool and overall. */
  maxActive: number;
  maxActiveByPool: Record<BoundedTask["pool"], number>;
  maxActiveByGroup: Record<string, number>;
}

/**
 * Runs `tasks` under the limits and resolves once all have settled.
 *
 * `shouldStart` is consulted before each task starts. Returning false stops
 * starting new work — the caller uses it after a workflow-fatal error or a lost
 * fence — while tasks already running are allowed to settle, because an
 * in-flight provider call cannot be recalled.
 */
export async function runBoundedTasks(
  tasks: readonly BoundedTask[],
  limits: ReviewFanoutConcurrency,
  shouldStart: () => boolean = () => true,
): Promise<BoundedTaskStats> {
  const queue = Array.from(tasks);
  const activeByPool: Record<BoundedTask["pool"], number> = { admission: 0, observation: 0 };
  const activeByGroup = new Map<string, number>();
  const stats: BoundedTaskStats = {
    maxActive: 0,
    maxActiveByPool: { admission: 0, observation: 0 },
    maxActiveByGroup: {},
  };
  let active = 0;

  return new Promise<BoundedTaskStats>((resolve) => {
    const poolLimit = (pool: BoundedTask["pool"]) =>
      pool === "admission" ? limits.admission : limits.observation;

    const pump = (): void => {
      if (!shouldStart()) queue.length = 0;
      for (let index = 0; index < queue.length;) {
        const task = queue[index]!;
        const groupActive = activeByGroup.get(task.group) ?? 0;
        if (activeByPool[task.pool] >= poolLimit(task.pool) || groupActive >= limits.provider) {
          index += 1;
          continue;
        }
        queue.splice(index, 1);
        active += 1;
        activeByPool[task.pool] += 1;
        activeByGroup.set(task.group, groupActive + 1);
        stats.maxActive = Math.max(stats.maxActive, active);
        stats.maxActiveByPool[task.pool] = Math.max(
          stats.maxActiveByPool[task.pool],
          activeByPool[task.pool],
        );
        stats.maxActiveByGroup[task.group] = Math.max(
          stats.maxActiveByGroup[task.group] ?? 0,
          groupActive + 1,
        );
        void Promise.resolve()
          .then(() => task.run())
          // Task errors are the caller's business; the pool only needs to know
          // that the slot is free again. Catching here also keeps a rejected
          // task from becoming an unhandled rejection.
          .catch(() => undefined)
          .finally(() => {
            active -= 1;
            activeByPool[task.pool] -= 1;
            const remaining = (activeByGroup.get(task.group) ?? 1) - 1;
            if (remaining > 0) activeByGroup.set(task.group, remaining);
            else activeByGroup.delete(task.group);
            pump();
          });
        // Restart the scan: starting a task may have exhausted a limit.
        index = 0;
        if (!shouldStart()) queue.length = 0;
      }
      if (active === 0 && queue.length === 0) resolve(stats);
    };
    pump();
  });
}
