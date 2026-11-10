import { afterEach, describe, expect, test } from "bun:test";
import {
  addEventLoopStallContext,
  eventLoopDiagnostics,
  startEventLoopStallMonitor,
  type EventLoopStallMonitor,
  type EventLoopStallReport,
} from "./event-loop-stall-monitor.js";
import { configureLogger } from "./logger.js";
import { captureLogs } from "./testing/log-capture.js";

/** A virtual clock and a single pending timer the test fires by hand. */
function harness(options: { useDefaultLogger?: boolean; cpuUsage?: () => number } = {}) {
  let monotonic = 0;
  let wall = Date.parse("2026-10-28T02:22:55.000Z");
  let pending: { callback: () => void; dueAt: number } | null = null;
  const logs: EventLoopStallReport[] = [];
  const monitor = startEventLoopStallMonitor({
    intervalMs: 500,
    thresholdMs: 1_000,
    logIntervalMs: 30_000,
    alwaysLogMs: 10_000,
    ...(options.useDefaultLogger ? {} : { report: (stall) => logs.push(stall) }),
    ...(options.cpuUsage ? { cpuUsage: options.cpuUsage } : {}),
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
const removeContexts: Array<() => void> = [];
afterEach(() => {
  monitor?.stop();
  monitor = null;
  for (const remove of removeContexts.splice(0)) remove();
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
      {
        lagMs: 2_500,
        endedAt: "2026-10-28T02:22:59.150Z",
        intervalMs: 500,
        folded: "",
        level: "warn",
      },
    ]);
    expect(eventLoopDiagnostics()?.stalls).toBe(1);
  });

  test("writes a stall through the event-loop area without a report of its own", () => {
    const capture = captureLogs();
    try {
      const run = harness({ useDefaultLogger: true });
      monitor = run.monitor;
      run.tick(2_500);
      expect(capture.records()).toEqual([
        expect.objectContaining({
          level: "warn",
          area: "event-loop",
          event: "stalled",
          fields: { lagMs: 2_500, endedAt: "2026-10-28T02:22:58.000Z", intervalMs: 500 },
        }),
      ]);
    } finally {
      capture.restore();
    }
  });

  test("a stall line carries what the context sources say ran in its window", () => {
    const windows: Array<{ fromMs: number; toMs: number }> = [];
    removeContexts.push(
      addEventLoopStallContext((window) => {
        windows.push(window);
        return { storageMs: 2_400, storageDatabase: "main" };
      }),
      addEventLoopStallContext(() => {
        throw new Error("ignored");
      }),
      addEventLoopStallContext(() => ({ commandsInFlight: 2 })),
    );
    const capture = captureLogs();
    try {
      const run = harness({ useDefaultLogger: true });
      monitor = run.monitor;
      run.tick(0);
      // Sources are asked only for a reported stall, never on an ordinary tick.
      expect(windows).toEqual([]);
      run.tick(2_500);
      // From the last on-time tick to the late one.
      expect(windows).toEqual([{ fromMs: 500, toMs: 3_500 }]);
      expect(capture.records()[0]?.fields).toEqual({
        lagMs: 2_500,
        endedAt: "2026-10-28T02:22:58.500Z",
        intervalMs: 500,
        storageMs: 2_400,
        storageDatabase: "main",
        commandsInFlight: 2,
      });
    } finally {
      capture.restore();
    }
    for (const remove of removeContexts.splice(0)) remove();
    const run = harness();
    monitor?.stop();
    monitor = run.monitor;
    run.tick(2_500);
    expect(run.logs[0]?.context).toBeUndefined();
  });

  test("a stall line says how much CPU the process used during it", () => {
    // Microseconds of CPU time, advanced by hand between ticks.
    let cpuMicros = 5_000_000;
    const capture = captureLogs();
    try {
      const run = harness({ useDefaultLogger: true, cpuUsage: () => cpuMicros });
      monitor = run.monitor;
      cpuMicros += 40_000;
      run.tick(0);
      // A busy stall: the thread ran for most of it.
      cpuMicros += 2_812_400;
      run.tick(2_500);
      // A waiting stall: the thread barely ran.
      cpuMicros += 30_000;
      run.tick(35_000);
      expect(capture.records().map((record) => record.fields)).toEqual([
        expect.objectContaining({ lagMs: 2_500, cpuMs: 2_812 }),
        expect.objectContaining({ lagMs: 35_000, cpuMs: 30 }),
      ]);
    } finally {
      capture.restore();
    }
  });

  test("a CPU reader that throws or answers nonsense leaves cpuMs out", () => {
    let calls = 0;
    const run = harness({
      cpuUsage: () => {
        calls += 1;
        if (calls === 2) throw new Error("unavailable");
        return Number.NaN;
      },
    });
    monitor = run.monitor;
    run.tick(2_500);
    run.tick(40_000);
    expect(run.logs.map((stall) => stall.cpuMs)).toEqual([undefined, undefined]);
    expect(run.monitor.snapshot().stalls).toBe(2);
  });

  test("a stall of 10 seconds or more is written at any configured level, and a shorter one is not", () => {
    const capture = captureLogs();
    try {
      configureLogger({ level: "error" });
      const run = harness({ useDefaultLogger: true });
      monitor = run.monitor;
      run.tick(9_999);
      expect(capture.records()).toEqual([]);
      for (let index = 0; index < 60; index += 1) run.tick(0);
      run.tick(10_000);
      expect(capture.records().map((record) => [record.level, record.fields?.lagMs])).toEqual([
        ["error", 10_000],
      ]);
    } finally {
      capture.restore();
    }
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
    expect(run.logs[1]!.lagMs).toBe(1_300);
    expect(run.logs[1]!.folded).toContain(
      "2 shorter stall(s) since the last report, longest 1500 ms",
    );
    expect(run.monitor.snapshot().stalls).toBe(4);
  });

  test("always logs a stall longer than the always-log bound", () => {
    const run = harness();
    monitor = run.monitor;
    run.tick(1_200);
    run.tick(24_322_016);
    expect(run.logs).toHaveLength(2);
    expect(run.logs[1]).toMatchObject({ lagMs: 24_322_016, level: "error" });
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
