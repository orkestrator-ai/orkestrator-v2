import { afterEach, describe, expect, test } from "bun:test";
import {
  eventLoopDiagnostics,
  startEventLoopStallMonitor,
  type EventLoopStallMonitor,
  type EventLoopStallMonitorOptions,
} from "./event-loop-stall-monitor.js";

/** A virtual clock and a single pending timer the test fires by hand. */
function harness(formatStall?: EventLoopStallMonitorOptions["formatStall"]) {
  let monotonic = 0;
  let wall = Date.parse("2026-10-28T02:22:55.000Z");
  let pending: { callback: () => void; dueAt: number } | null = null;
  const logs: string[] = [];
  const monitor = startEventLoopStallMonitor({
    intervalMs: 500,
    thresholdMs: 1_000,
    logIntervalMs: 30_000,
    alwaysLogMs: 10_000,
    log: (message) => logs.push(message),
    ...(formatStall ? { formatStall } : {}),
    now: () => monotonic,
    wallClock: () => wall,
    setTimer: (callback, ms) => {
      pending = { callback, dueAt: monotonic + ms };
      return {};
    },
    clearTimer: () => {
      pending = null;
    },
  });
  /** Fires the next tick `lateMs` after it was due. */
  const tick = (lateMs = 0) => {
    const timer = pending;
    if (!timer) throw new Error("no timer scheduled");
    const advance = timer.dueAt + lateMs - monotonic;
    monotonic += advance;
    wall += advance;
    pending = null;
    timer.callback();
  };
  return { monitor, logs, tick, hasTimer: () => pending !== null };
}

let monitor: EventLoopStallMonitor | null = null;
afterEach(() => {
  monitor?.stop();
  monitor = null;
});

describe("event loop stall monitor", () => {
  test("counts late ticks by bucket and logs a stall with its length and end time", () => {
    const run = harness();
    monitor = run.monitor;
    run.tick(0);
    run.tick(150);
    run.tick(2_500);

    const snapshot = run.monitor.snapshot();
    expect(snapshot).toMatchObject({
      intervalMs: 500,
      thresholdMs: 1_000,
      ticks: 3,
      maxLagMs: 2_500,
      lateTicks: { "100": 2, "1000": 1, "5000": 0, "30000": 0 },
      stalls: 1,
    });
    expect(snapshot.recentStalls).toEqual([{ at: "2026-10-28T02:22:59.150Z", lagMs: 2_500 }]);
    expect(run.logs).toEqual([
      "[Backend] Event loop stalled for 2500 ms, ending 2026-10-28T02:22:59.150Z: a 500 ms timer fired late, so every request in that window waited",
    ]);
    expect(eventLoopDiagnostics()?.stalls).toBe(1);
  });

  test("lets the process word its own stall line", () => {
    const run = harness(
      ({ lagMs, endedAt, intervalMs, folded }) => `${lagMs}|${endedAt}|${intervalMs}|${folded}`,
    );
    monitor = run.monitor;
    run.tick(2_500);
    expect(run.logs).toEqual(["2500|2026-10-28T02:22:58.000Z|500|"]);
  });

  test("rate-limits stall lines and folds the suppressed ones into the next report", () => {
    const run = harness();
    monitor = run.monitor;
    run.tick(1_200);
    run.tick(1_500);
    run.tick(1_100);
    expect(run.logs).toHaveLength(1);
    for (let index = 0; index < 60; index += 1) run.tick(0);
    run.tick(1_300);
    expect(run.logs).toHaveLength(2);
    expect(run.logs[1]).toContain("stalled for 1300 ms");
    expect(run.logs[1]).toContain("2 shorter stall(s) since the last report, longest 1500 ms");
    expect(run.monitor.snapshot().stalls).toBe(4);
  });

  test("always logs a stall longer than the always-log bound", () => {
    const run = harness();
    monitor = run.monitor;
    run.tick(1_200);
    run.tick(24_322_016);
    expect(run.logs).toHaveLength(2);
    expect(run.logs[1]).toContain("stalled for 24322016 ms");
    expect(run.monitor.snapshot().lateTicks["30000"]).toBe(1);
  });

  test("keeps a bounded list of recent stalls", () => {
    const run = harness();
    monitor = run.monitor;
    for (let index = 0; index < 25; index += 1) run.tick(1_000 + index);
    const { recentStalls, stalls } = run.monitor.snapshot();
    expect(stalls).toBe(25);
    expect(recentStalls).toHaveLength(20);
    expect(recentStalls[0]!.lagMs).toBe(1_005);
  });

  test("stop cancels the timer and clears the diagnostics", () => {
    const run = harness();
    run.monitor.stop();
    expect(run.hasTimer()).toBe(false);
    expect(eventLoopDiagnostics()).toBeNull();
  });
});
