import { describe, expect, test } from "bun:test";
import { BackendActivityJobs, type BackendActivityJob } from "./backend-activity-jobs.js";
import { ManualTime, deferred, type Deferred } from "./recurring-test-support.js";

function job(
  time: ManualTime,
  runs: number[],
  fields: Partial<BackendActivityJob> & { name: string },
): BackendActivityJob {
  return {
    kind: "mail-presence",
    priority: "progress",
    intervalMs: 2_000,
    fixedRate: true,
    run: async () => {
      runs.push(time.now());
    },
    onError: () => undefined,
    ...fields,
  };
}

describe("BackendActivityJobs", () => {
  test("each job keeps its own fixed-rate cadence; a slow job neither overlaps nor delays others", async () => {
    const time = new ManualTime(0);
    const presence: number[] = [];
    const activity: number[] = [];
    let slow: Deferred<void> | null = deferred();
    let inFlight = 0;
    let peak = 0;
    const jobs = new BackendActivityJobs(
      [
        job(time, presence, { name: "mail-presence" }),
        job(time, activity, {
          name: "activity",
          kind: "native-activity-sweep",
          run: async () => {
            activity.push(time.now());
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            try {
              if (slow) await slow.promise;
            } finally {
              inFlight -= 1;
            }
          },
        }),
      ],
      { now: time.now, timers: time.timerFactory, diagnostics: null },
    );
    jobs.start();
    await time.advance(10_000);
    // Presence refreshes every 2 s regardless of the stuck activity sweep, so
    // the 4 s presence TTL is always renewed in time.
    expect(presence).toEqual([2_000, 4_000, 6_000, 8_000, 10_000]);
    expect(activity).toEqual([2_000]);
    slow.resolve();
    slow = null;
    await time.advance(0);
    await time.advance(4_000);
    expect(peak).toBe(1);
    // Overdue by then: one catch-up pass immediately, then back on 2 s.
    expect(activity).toEqual([2_000, 10_000, 12_000, 14_000]);
    jobs.stop();
  });

  test("maintenance runs on elapsed 60 s deadlines, not activity tick counts", async () => {
    const time = new ManualTime(0);
    const retention: number[] = [];
    const jobs = new BackendActivityJobs(
      [
        job(time, retention, {
          name: "mail-retention",
          kind: "mail-retention",
          priority: "maintenance",
          intervalMs: 60_000,
          fixedRate: false,
        }),
      ],
      { now: time.now, timers: time.timerFactory, diagnostics: null },
    );
    jobs.start();
    await time.advance(180_000);
    expect(retention).toEqual([60_000, 120_000, 180_000]);
    jobs.stop();
  });

  test("a job can rest on a safety cadence and be woken early", async () => {
    const time = new ManualTime(0);
    const renames: number[] = [];
    let pending = false;
    const jobs = new BackendActivityJobs(
      [
        job(time, renames, {
          name: "pending-renames",
          kind: "pending-rename-reconcile",
          run: async () => {
            renames.push(time.now());
            return pending ? undefined : 30_000;
          },
        }),
      ],
      { now: time.now, timers: time.timerFactory, diagnostics: null },
    );
    jobs.start();
    await time.advance(40_000);
    expect(renames).toEqual([2_000, 32_000]);
    pending = true;
    jobs.wake("pending-renames");
    await time.advance(0);
    await time.advance(4_000);
    expect(renames).toEqual([2_000, 32_000, 40_000, 42_000, 44_000]);
    jobs.stop();
  });

  test("a rename wake during a running safety pass survives its idle delay", async () => {
    const time = new ManualTime(0);
    const runs: number[] = [];
    const gate = deferred<void>();
    let pending = false;
    const jobs = new BackendActivityJobs(
      [
        job(time, runs, {
          name: "pending-renames",
          kind: "pending-rename-reconcile",
          run: async () => {
            runs.push(time.now());
            if (runs.length === 1) await gate.promise;
            return pending ? undefined : 30_000;
          },
        }),
      ],
      { now: time.now, timers: time.timerFactory, diagnostics: null },
    );
    jobs.start();
    await time.advance(2_000);
    pending = true;
    jobs.wake("pending-renames");
    gate.resolve();
    await time.advance(2_000);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    jobs.stop();
  });

  test("a failing job reports its error and keeps its cadence", async () => {
    const time = new ManualTime(0);
    const errors: unknown[] = [];
    const jobs = new BackendActivityJobs(
      [
        {
          name: "claude-state",
          kind: "claude-state-reconcile",
          priority: "progress",
          intervalMs: 2_000,
          fixedRate: true,
          run: async () => {
            throw new Error("boom");
          },
          onError: (error) => errors.push(error),
        },
      ],
      { now: time.now, timers: time.timerFactory, diagnostics: null },
    );
    jobs.start();
    await time.advance(6_000);
    expect(errors).toHaveLength(3);
    expect(jobs.status()?.keys).toBe(1);
    jobs.stop();
    expect(jobs.status()).toBeNull();
  });
});
