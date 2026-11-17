import { afterEach, describe, expect, test } from "bun:test";
import {
  addEventLoopStallContext,
  eventLoopDiagnostics,
  hostSleptMs,
  startEventLoopStallMonitor,
  type EventLoopStallMonitor,
  type EventLoopStallMonitorOptions,
  type EventLoopStallReport,
  type EventLoopSuspensionReport,
} from "./event-loop-stall-monitor.js";
import { configureLogger } from "./logger.js";
import { captureLogs } from "./testing/log-capture.js";

/** A virtual clock and a single pending timer the test fires by hand. */
function harness(
  options: {
    useDefaultLogger?: boolean;
    cpuUsage?: () => number;
    hostCpuTimes?: EventLoopStallMonitorOptions["hostCpuTimes"];
  } = {},
) {
  let monotonic = 0;
  let wall = Date.parse("2026-10-28T02:22:55.000Z");
  let pending: { callback: () => void; dueAt: number } | null = null;
  const logs: EventLoopStallReport[] = [];
  const suspensions: EventLoopSuspensionReport[] = [];
  const monitor = startEventLoopStallMonitor({
    intervalMs: 500,
    thresholdMs: 1_000,
    logIntervalMs: 30_000,
    alwaysLogMs: 10_000,
    ...(options.useDefaultLogger ? {} : { report: (stall) => logs.push(stall) }),
    ...(options.useDefaultLogger
      ? {}
      : { reportSuspension: (suspension) => suspensions.push(suspension) }),
    ...(options.cpuUsage ? { cpuUsage: options.cpuUsage } : {}),
    ...(options.hostCpuTimes ? { hostCpuTimes: options.hostCpuTimes } : {}),
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
  return {
    monitor,
    logs,
    suspensions,
    tick,
    hasTimer: () => pending !== null,
    /** Moves both clocks without firing anything: time passing between ticks. */
    advance: (ms: number) => {
      monotonic += ms;
      wall += ms;
    },
  };
}

/**
 * A host with two CPUs whose time counters run only while it is awake, as
 * real ones do. `sleep` stops them; `lagging` holds one CPU's counter, the
 * way an idle CPU whose time is accounted late would read.
 */
function host() {
  const awake = [100_000, 100_000];
  let sleeping = false;
  let laggingCpu: number | null = null;
  let reads = 0;
  return {
    times: () => {
      reads += 1;
      return [...awake];
    },
    /** Called with every millisecond the harness clocks move. */
    pass(ms: number) {
      if (sleeping) return;
      awake.forEach((_, index) => {
        if (index !== laggingCpu) awake[index]! += ms;
      });
    },
    setSleeping: (value: boolean) => {
      sleeping = value;
    },
    setLagging: (cpu: number | null) => {
      laggingCpu = cpu;
    },
    reads: () => reads,
  };
}

/** A harness whose host clock follows its monotonic clock, with sleeps on demand. */
function hostHarness(options: { useDefaultLogger?: boolean; cpuUsage?: () => number } = {}) {
  const machine = host();
  const run = harness({ ...options, hostCpuTimes: machine.times });
  /** Fires the next tick after `awakeMs` awake and `asleepMs` asleep, in that order. */
  const tickAfter = ({ awakeMs = 0, asleepMs = 0 }: { awakeMs?: number; asleepMs?: number }) => {
    machine.pass(500 + awakeMs);
    machine.setSleeping(true);
    machine.pass(asleepMs);
    machine.setSleeping(false);
    run.tick(awakeMs + asleepMs);
  };
  return { ...run, machine, tickAfter };
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

  describe("host sleep", () => {
    test("a tick late only because the host slept is a suspension, not a stall", () => {
      const run = hostHarness();
      monitor = run.monitor;
      run.tickAfter({});
      run.tickAfter({ asleepMs: 128_123 });

      expect(run.logs).toEqual([]);
      expect(run.suspensions).toEqual([
        {
          suspendedMs: 128_123,
          lagMs: 128_123,
          endedAt: "2026-10-28T02:25:04.123Z",
          intervalMs: 500,
          suppressed: 0,
        },
      ]);
      expect(run.monitor.snapshot()).toMatchObject({
        ticks: 2,
        stalls: 0,
        maxLagMs: 0,
        lateTicks: { "100": 0, "1000": 0, "5000": 0, "30000": 0 },
        suspensions: 1,
        maxSuspendedMs: 128_123,
        recentStalls: [],
      });
    });

    test("the default logger writes a suspension as an info line in the event-loop area", () => {
      const capture = captureLogs();
      try {
        const run = hostHarness({ useDefaultLogger: true });
        monitor = run.monitor;
        run.tickAfter({ asleepMs: 40_000 });
        expect(
          capture
            .records()
            .map(({ level, area, event, fields }) => ({ level, area, event, fields })),
        ).toEqual([
          {
            level: "info",
            area: "event-loop",
            event: "host-suspended",
            fields: {
              suspendedMs: 40_000,
              lagMs: 40_000,
              endedAt: "2026-10-28T02:23:35.500Z",
              intervalMs: 500,
            },
          },
        ]);
      } finally {
        capture.restore();
      }
    });

    test("a stall that remains once the sleep is taken out is still a stall, and says so", () => {
      const run = hostHarness();
      monitor = run.monitor;
      run.tickAfter({ awakeMs: 12_000, asleepMs: 60_000 });
      expect(run.logs).toEqual([
        expect.objectContaining({ lagMs: 12_000, level: "error", hostSuspendedMs: 60_000 }),
      ]);
      expect(run.suspensions).toEqual([
        expect.objectContaining({ suspendedMs: 60_000, lagMs: 72_000 }),
      ]);
      expect(run.monitor.snapshot()).toMatchObject({ stalls: 1, maxLagMs: 12_000, suspensions: 1 });
    });

    test("a stall on an awake host is reported as before", () => {
      const run = hostHarness();
      monitor = run.monitor;
      run.tickAfter({ awakeMs: 15_000 });
      expect(run.logs).toEqual([
        {
          lagMs: 15_000,
          endedAt: "2026-10-28T02:23:10.500Z",
          intervalMs: 500,
          folded: "",
          level: "error",
          context: undefined,
        },
      ]);
      expect(run.suspensions).toEqual([]);
      expect(run.monitor.snapshot()).toMatchObject({ suspensions: 0, maxSuspendedMs: 0 });
    });

    test("one CPU accounted late cannot make an awake host look asleep", () => {
      const run = hostHarness();
      monitor = run.monitor;
      run.machine.setLagging(1);
      run.tickAfter({ awakeMs: 20_000 });
      expect(run.logs).toEqual([expect.objectContaining({ lagMs: 20_000, level: "error" })]);
      expect(run.suspensions).toEqual([]);
    });

    test("a process that ran for most of the lateness was not on a sleeping host", () => {
      // Counters that read as asleep (a broken reader), but the process used
      // CPU for nearly the whole late tick.
      let cpuMicros = 0;
      const run = hostHarness({ cpuUsage: () => cpuMicros });
      monitor = run.monitor;
      cpuMicros += 30_000_000;
      run.tickAfter({ asleepMs: 30_000 });
      expect(run.logs).toEqual([
        expect.objectContaining({ lagMs: 30_000, cpuMs: 30_000, level: "error" }),
      ]);
      expect(run.logs[0]?.hostSuspendedMs).toBeUndefined();
      expect(run.suspensions).toEqual([]);
    });

    test("a process that barely ran while the counters stopped is a suspension", () => {
      let cpuMicros = 0;
      const run = hostHarness({ cpuUsage: () => cpuMicros });
      monitor = run.monitor;
      cpuMicros += 20_000;
      run.tickAfter({ asleepMs: 30_000 });
      expect(run.logs).toEqual([]);
      expect(run.suspensions).toEqual([expect.objectContaining({ suspendedMs: 30_000 })]);
    });

    test("an unreadable or changed host reading leaves the stall reported", () => {
      let calls = 0;
      const run = harness({
        hostCpuTimes: () => {
          calls += 1;
          if (calls === 1) return [1_000, 1_000];
          if (calls === 2) return [1_000, 1_000, 1_000];
          if (calls === 3) throw new Error("unreadable");
          return null;
        },
      });
      monitor = run.monitor;
      // A CPU came online: the readings no longer compare.
      run.tick(20_000);
      // The reader throws: no baseline for the next.
      run.tick(20_000);
      run.tick(20_000);
      expect(run.logs.map((stall) => stall.lagMs)).toEqual([20_000, 20_000, 20_000]);
      expect(run.suspensions).toEqual([]);
    });

    test("suspension lines are spaced like stall lines, with the ones between counted", () => {
      const run = hostHarness();
      monitor = run.monitor;
      run.tickAfter({ asleepMs: 20_000 });
      run.tickAfter({ asleepMs: 5_000 });
      run.tickAfter({ asleepMs: 3_000 });
      expect(run.suspensions.map((suspension) => suspension.suspendedMs)).toEqual([20_000]);
      for (let index = 0; index < 60; index += 1) run.tickAfter({});
      run.tickAfter({ asleepMs: 50_000 });
      expect(
        run.suspensions.map(({ suspendedMs, suppressed }) => [suspendedMs, suppressed]),
      ).toEqual([
        [20_000, 0],
        [50_000, 2],
      ]);
      expect(run.monitor.snapshot()).toMatchObject({
        suspensions: 4,
        maxSuspendedMs: 50_000,
        stalls: 0,
      });
    });

    test("reads the host's CPU times every few seconds while ticks are on time", () => {
      const run = hostHarness();
      monitor = run.monitor;
      // One read at start.
      expect(run.machine.reads()).toBe(1);
      for (let index = 0; index < 20; index += 1) run.tickAfter({});
      // 10 s of on-time ticks: one read every 5 s.
      expect(run.machine.reads()).toBe(3);
      run.tickAfter({ asleepMs: 2_000 });
      expect(run.machine.reads()).toBe(4);
    });
  });
});

describe("hostSleptMs", () => {
  test("is the time that passed minus the longest any one CPU was awake", () => {
    expect(hostSleptMs([0, 0], [500, 1_000], 61_000)).toBe(60_000);
    expect(hostSleptMs([0, 0], [1_000, 1_000], 1_000)).toBe(0);
  });

  test("never goes below zero for counters that ran slightly ahead", () => {
    expect(hostSleptMs([0], [3_070], 3_005)).toBe(0);
  });

  test("is null for readings that do not compare", () => {
    expect(hostSleptMs([], [], 1_000)).toBeNull();
    expect(hostSleptMs([0, 0], [0], 1_000)).toBeNull();
  });
});
