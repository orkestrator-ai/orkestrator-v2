import { describe, expect, test } from "bun:test";
import { HostSuspendDetector } from "./host-suspend-detector.js";
import { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import { RecurringScheduler } from "./recurring-scheduler.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { flushMicrotasks, ManualTime } from "./recurring-test-support.js";

function manualIntervals() {
  let callback: (() => void) | null = null;
  return {
    timers: {
      setInterval(next: () => void) {
        callback = next;
        return 1;
      },
      clearInterval() {
        callback = null;
      },
    },
    tick() {
      callback?.();
    },
    get active() {
      return callback !== null;
    },
  };
}

describe("HostSuspendDetector", () => {
  test("reports wall time that passed while the monotonic clock stood still", () => {
    let wall = 1_000_000;
    let monotonic = 0;
    const intervals = manualIntervals();
    const reports: number[] = [];
    const detector = new HostSuspendDetector({
      onSuspend: (ms) => reports.push(ms),
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      timers: intervals.timers,
    });
    detector.start();

    wall += 10_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([]);

    // Timer latency and slew below the threshold are not a suspension.
    wall += 13_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([]);

    // 60 s asleep: the wall clock moved, the monotonic clock did not.
    wall += 70_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([60_000]);

    // Reported once, not again on the next ordinary tick.
    wall += 10_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([60_000]);
  });

  test("a backwards wall-clock step is not a suspension", () => {
    let wall = 1_000_000;
    let monotonic = 0;
    const intervals = manualIntervals();
    const reports: number[] = [];
    const detector = new HostSuspendDetector({
      onSuspend: (ms) => reports.push(ms),
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      timers: intervals.timers,
    });
    detector.start();
    wall -= 3_600_000;
    monotonic += 10_000;
    intervals.tick();
    expect(reports).toEqual([]);
  });

  test("start is idempotent, stop releases the interval and late checks do nothing", () => {
    let wall = 0;
    const intervals = manualIntervals();
    const reports: number[] = [];
    const detector = new HostSuspendDetector({
      onSuspend: (ms) => reports.push(ms),
      wallNow: () => wall,
      monotonicNow: () => 0,
      timers: intervals.timers,
    });
    detector.start();
    detector.start();
    detector.stop();
    expect(intervals.active).toBe(false);
    wall += 60_000;
    detector.check();
    expect(reports).toEqual([]);
  });

  test("a throwing handler is contained", () => {
    let wall = 0;
    const intervals = manualIntervals();
    const detector = new HostSuspendDetector({
      onSuspend: () => {
        throw new Error("synthetic");
      },
      wallNow: () => wall,
      monotonicNow: () => 0,
      timers: intervals.timers,
    });
    detector.start();
    wall += 60_000;
    expect(() => intervals.tick()).not.toThrow();
  });
});

describe("RecurringScheduler.compensateSuspension", () => {
  test("each overdue key runs once after resume; missed intervals are not replayed", async () => {
    const time = new ManualTime();
    const registry = new RecurringDiagnosticsRegistry();
    const scheduler = new RecurringScheduler({
      owner: "test",
      now: time.now,
      timers: time.timerFactory,
      random: () => 0,
      metrics: new RecurringWorkMetrics({ enabled: false }),
      diagnostics: registry,
    });
    const runs = { fast: 0, slow: 0 };
    scheduler.register({
      key: "fast",
      kind: "mail-retention",
      priority: "maintenance",
      intervalMs: 10_000,
      initialDelayMs: 10_000,
      deadline: "hard",
      run: () => {
        runs.fast += 1;
        return { outcome: "success" };
      },
    });
    scheduler.register({
      key: "slow",
      kind: "mail-retention",
      priority: "maintenance",
      intervalMs: 300_000,
      initialDelayMs: 300_000,
      deadline: "hard",
      run: () => {
        runs.slow += 1;
        return { outcome: "success" };
      },
    });

    // The host sleeps for 120 s: monotonic time does not move.
    registry.notifySuspension(120_000);
    await flushMicrotasks();
    await time.advance(0);
    await flushMicrotasks();
    // "fast" was 10 s from due and 110 s overdue in wall time: it runs once.
    expect(runs).toEqual({ fast: 1, slow: 0 });

    // "slow" moved from 300 s to 180 s; it is not run early.
    await time.advance(179_000);
    await flushMicrotasks();
    expect(runs.slow).toBe(0);
    await time.advance(1_000);
    await flushMicrotasks();
    expect(runs.slow).toBe(1);

    await scheduler.dispose({ timeoutMs: 0 });
    // A disposed scheduler is no longer a listener.
    expect(() => registry.notifySuspension(60_000)).not.toThrow();
  });
});

describe("RecurringDiagnosticsRegistry fetch policies", () => {
  test("reports aggregate policy status without its generation id", () => {
    const registry = new RecurringDiagnosticsRegistry();
    const unregister = registry.addFetchPolicy("container-git-fetch", {
      status: () => ({
        generation: "synthetic-generation-secret",
        records: 2,
        containers: 1,
        inFlight: 1,
        waiting: 0,
        dirty: 0,
        failing: { network: 1 },
        evicted: 0,
      }),
    });
    const snapshot = registry.snapshot(new RecurringWorkMetrics({ enabled: false }));
    expect(snapshot.fetchPolicies).toEqual([
      {
        name: "container-git-fetch",
        status: {
          records: 2,
          containers: 1,
          inFlight: 1,
          waiting: 0,
          dirty: 0,
          failing: { network: 1 },
          evicted: 0,
        },
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-generation-secret");
    unregister();
    expect(registry.snapshot(new RecurringWorkMetrics({ enabled: false })).fetchPolicies).toEqual(
      [],
    );
  });
});
