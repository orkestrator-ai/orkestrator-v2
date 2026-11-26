import { registrarFrom } from "./commands/registry-contracts.js";
import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";
import { parseMachineLoadReport } from "@orkestrator/protocol/machine-load";
import type { CommandContext, CommandHandler } from "./commands/context.js";
import { registerSystemCommands } from "./commands/registry-system.js";
import { createCommandRegistry } from "./commands/registry.js";
import {
  describeOs,
  MACHINE_LOAD_FIRST_SAMPLE_MS,
  MACHINE_LOAD_MAX_SAMPLE_GAP_MS,
  MACHINE_LOAD_SAMPLE_MS,
  machineOsFamily,
  MACHINE_LOAD_HISTORY_LIMITS,
  MachineLoadHistory,
  type MachineLoadHistoryStore,
  MachineLoadSampler,
  parseOsRelease,
} from "./machine-load.js";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { flushMicrotasks, ManualTime } from "./recurring/test-support.js";
import { RecurringWorkMetrics } from "./recurring/work-metrics.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 9, 31, 12);

function cpus(busy: number, idle: number, cores = 1): CpuInfo[] {
  return Array.from({ length: cores }, () => ({
    model: "test",
    speed: 1,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  }));
}

/** A sampler on a fake clock whose machine runs at the percentages a test sets. */
function fixture(start = START, historyStore?: MachineLoadHistoryStore) {
  const state = { now: start, busy: 0, idle: 0, cpu: 50, ram: 40 };
  const ramReads: number[] = [];
  const sampler = new MachineLoadSampler({
    ...(historyStore ? { historyStore } : {}),
    now: () => state.now,
    cpus: () => cpus(state.busy, state.idle, 4),
    arch: () => "arm64",
    totalMemory: () => 16 * 2 ** 30,
    readRam: async (at) => {
      ramReads.push(at);
      return state.ram;
    },
    platform: "linux",
    readFile: async () => 'PRETTY_NAME="Arch Linux"\n',
    metrics: new RecurringWorkMetrics({ enabled: false }),
    diagnostics: null,
  });
  /** Moves the machine on by `ms` at the current percentages, then takes a reading. */
  const step = async (ms: number) => {
    state.now += ms;
    state.busy += state.cpu * ms;
    state.idle += (100 - state.cpu) * ms;
    await sampler.sample();
  };
  return { state, sampler, step, ramReads };
}

function window(report: ReturnType<MachineLoadSampler["report"]>, id: string) {
  return report.load.find((entry) => entry.window === id)!;
}

describe("machine load windows", () => {
  test("averages CPU and RAM per window, as percentages of the machine", async () => {
    const { state, sampler, step } = fixture();
    sampler.start();
    state.cpu = 20;
    state.ram = 30;
    for (let minute = 0; minute < 55; minute += 1) await step(MINUTE);
    state.cpu = 80;
    state.ram = 60;
    for (let minute = 0; minute < 5; minute += 1) await step(MINUTE);
    sampler.stop();

    const report = sampler.report();
    expect(window(report, "5m")).toEqual({
      window: "5m",
      windowSeconds: 300,
      coveredSeconds: 300,
      cpuPercent: 80,
      ramPercent: 60,
    });
    // 55 minutes at 20% and 5 at 80%.
    expect(window(report, "1h")).toMatchObject({
      coveredSeconds: 3_600,
      cpuPercent: 25,
      ramPercent: 32.5,
    });
  });

  test("core count does not change the percentage, so machine sizes compare", async () => {
    const { state, step, sampler } = fixture();
    sampler.start();
    state.cpu = 25;
    await step(MINUTE);
    expect(window(sampler.report(), "5m").cpuPercent).toBe(25);
    expect(sampler.report().cpuCores).toBe(4);
    sampler.stop();
  });

  test("a steady machine reads as fully covered between readings", async () => {
    const { state, sampler, step } = fixture();
    sampler.start();
    for (let minute = 0; minute < 10; minute += 1) await step(MINUTE);
    state.now += 40_000;
    const report = sampler.report();
    expect(window(report, "5m").coveredSeconds).toBe(300);
    expect(report.latestSampleAgeSeconds).toBe(40);
    sampler.stop();
  });

  for (const [name, initial, invalid] of [
    ["empty CPU lists", [], []],
    ["stalled counters", cpus(100, 100), cpus(100, 100)],
    ["decreasing totals", cpus(100, 100), cpus(50, 50)],
    ["decreasing idle", cpus(100, 100), cpus(300, 50)],
    ["decreasing busy", cpus(100, 100), cpus(50, 300)],
  ] as const) {
    test(`${name} add no coverage and recover from a fresh baseline`, async () => {
      let now = START;
      let counters: CpuInfo[] = [...initial];
      const sampler = new MachineLoadSampler({
        now: () => now,
        cpus: () => counters,
        platform: "linux",
        readFile: async () => "NAME=Linux",
        readRam: async () => 40,
      });
      await sampler.sample();
      now += MINUTE;
      counters = [...invalid];
      await sampler.sample();
      expect(sampler.report().latestSampleAgeSeconds).toBeNull();
      for (const entry of sampler.report().load) {
        expect(entry).toMatchObject({ coveredSeconds: 0, cpuPercent: null, ramPercent: null });
      }
      now += MINUTE;
      const last = invalid[0]?.times;
      counters = cpus((last?.user ?? 0) + 100, (last?.idle ?? 0) + 300);
      await sampler.sample();
      if (invalid.length === 0) {
        // Reappearing counters establish a baseline; only the next delta counts.
        expect(window(sampler.report(), "5m").coveredSeconds).toBe(0);
        now += MINUTE;
        counters = cpus(200, 600);
        await sampler.sample();
      }
      expect(window(sampler.report(), "5m")).toMatchObject({
        coveredSeconds: 60,
        cpuPercent: 25,
        ramPercent: 40,
      });
    });
  }

  test("a figure older than a window leaves it", async () => {
    const { state, sampler, step } = fixture();
    sampler.start();
    await step(MINUTE);
    state.now += 6 * MINUTE;
    const report = sampler.report();
    expect(window(report, "5m")).toMatchObject({
      coveredSeconds: 0,
      cpuPercent: null,
      ramPercent: null,
    });
    expect(window(report, "1h").coveredSeconds).toBe(60);
    expect(report.latestSampleAgeSeconds).toBe(360);
    sampler.stop();
  });
});

describe("machine load history", () => {
  test("stays bounded over days and keeps the long average right after downsampling", () => {
    const history = new MachineLoadHistory();
    // Two days at one reading a second would be 172,800 raw samples.
    const days = 2;
    const stepMs = 1_000;
    let largest = 0;
    let at = START;
    for (let index = 0; index < (days * 24 * HOUR) / stepMs; index += 1) {
      // The first of the two days is busy and must age out of the 24-hour window.
      const busy = at - START < 24 * HOUR;
      history.record({
        startMs: at,
        endMs: at + stepMs,
        cpuPercent: busy ? 90 : 10,
        ramPercent: busy ? 80 : 20,
      });
      at += stepMs;
      largest = Math.max(largest, history.bucketCount());
    }
    expect(largest).toBeLessThanOrEqual(62 + 98);

    const [short, medium, long] = history.windows(at);
    expect(short).toMatchObject({ coveredSeconds: 300, cpuPercent: 10, ramPercent: 20 });
    expect(medium).toMatchObject({ coveredSeconds: 3_600, cpuPercent: 10, ramPercent: 20 });
    // Coverage may be off by part of the oldest coarse bucket, and the figure with it.
    expect(long!.coveredSeconds).toBeGreaterThanOrEqual(86_400 - 15 * 60);
    expect(long!.cpuPercent).toBeLessThan(11);
    expect(long!.ramPercent).toBeLessThan(21);
  });

  test("weights an average by the time each reading covers", () => {
    const history = new MachineLoadHistory();
    history.record({ startMs: START, endMs: START + MINUTE, cpuPercent: 10, ramPercent: 10 });
    history.record({
      startMs: START + MINUTE,
      endMs: START + 4 * MINUTE,
      cpuPercent: 50,
      ramPercent: 50,
    });
    expect(history.windows(START + 4 * MINUTE)[0]).toMatchObject({
      coveredSeconds: 240,
      cpuPercent: 40,
      ramPercent: 40,
    });
  });
});

describe("partial history and restarts", () => {
  test("a 24-hour figure from ten minutes says it covers ten minutes", async () => {
    const { sampler, step } = fixture();
    sampler.start();
    for (let minute = 0; minute < 10; minute += 1) await step(MINUTE);
    const report = sampler.report();
    expect(window(report, "5m").coveredSeconds).toBe(300);
    expect(window(report, "1h").coveredSeconds).toBe(600);
    expect(window(report, "24h")).toMatchObject({
      windowSeconds: 86_400,
      coveredSeconds: 600,
      cpuPercent: 50,
    });
    sampler.stop();
  });

  test("before the first reading every figure is null, and the OS is still known", async () => {
    const { sampler } = fixture();
    sampler.start();
    await flushMicrotasks();
    const report = sampler.report();
    expect(report).toMatchObject({
      osFamily: "linux",
      os: "Arch Linux",
      arch: "arm64",
      cpuCores: 4,
      totalRamGb: 16,
      latestSampleAgeSeconds: null,
    });
    for (const entry of report.load) {
      expect(entry).toMatchObject({ coveredSeconds: 0, cpuPercent: null, ramPercent: null });
    }
    sampler.stop();
  });

  test("without a history store a restarted backend starts empty, and nothing from before is kept", async () => {
    const first = fixture();
    first.sampler.start();
    for (let minute = 0; minute < 30; minute += 1) await first.step(MINUTE);
    first.sampler.stop();
    expect(window(first.sampler.report(), "1h").coveredSeconds).toBe(1_800);

    const restarted = fixture(first.state.now + MINUTE);
    restarted.sampler.start();
    expect(window(restarted.sampler.report(), "1h").coveredSeconds).toBe(0);
    await restarted.step(MINUTE);
    expect(window(restarted.sampler.report(), "1h").coveredSeconds).toBe(60);
    restarted.sampler.stop();
  });

  test("a sleeping host is a gap in coverage, not a reading", async () => {
    const { state, sampler, step } = fixture();
    sampler.start();
    await step(MINUTE);
    // Eight hours asleep, with a misleading CPU delta across it.
    state.cpu = 100;
    await step(8 * HOUR);
    expect(window(sampler.report(), "24h")).toMatchObject({ coveredSeconds: 60, cpuPercent: 50 });
    // The reading after waking measures from the wake, not from before the sleep.
    state.cpu = 10;
    await step(MINUTE);
    expect(window(sampler.report(), "5m")).toMatchObject({ coveredSeconds: 60, cpuPercent: 10 });
    expect(MACHINE_LOAD_MAX_SAMPLE_GAP_MS).toBeLessThan(8 * HOUR);
    sampler.stop();
  });

  test("reporting after rollback keeps only history completed before now, even when stopped", async () => {
    const { state, sampler, step } = fixture();
    sampler.start();
    state.cpu = 20;
    await step(MINUTE);
    state.cpu = 80;
    await step(MINUTE);
    await step(MINUTE);
    sampler.stop();
    state.now = START + 90_000;
    const report = sampler.report();
    expect(report.latestSampleAgeSeconds).toBeNull();
    for (const entry of report.load) {
      expect(entry).toMatchObject({ coveredSeconds: 60, cpuPercent: 20, ramPercent: 40 });
    }
  });

  test("a clock moved back drops readings now dated in the future", async () => {
    const { state, sampler, step } = fixture();
    sampler.start();
    for (let minute = 0; minute < 3; minute += 1) await step(MINUTE);
    state.now -= HOUR;
    const beforeSample = sampler.report();
    expect(beforeSample.latestSampleAgeSeconds).toBeNull();
    for (const entry of beforeSample.load) {
      expect(entry).toMatchObject({ coveredSeconds: 0, cpuPercent: null, ramPercent: null });
    }
    await sampler.sample();
    expect(window(sampler.report(), "24h").coveredSeconds).toBe(0);
    await step(MINUTE);
    expect(window(sampler.report(), "24h").coveredSeconds).toBe(60);
    expect(sampler.report().latestSampleAgeSeconds).toBe(0);
    sampler.stop();
  });
});

describe("history across a restart", () => {
  /** A history store in memory that keeps what a database row would: a JSON copy. */
  function memoryStore(initial?: unknown) {
    const store = {
      value: initial as unknown,
      saves: 0,
      failSaves: 0,
      loadError: null as Error | null,
      load: () => {
        if (store.loadError) throw store.loadError;
        return store.value;
      },
      save: (document: unknown) => {
        store.saves += 1;
        if (store.failSaves > 0) {
          store.failSaves -= 1;
          throw new Error("disk full");
        }
        store.value = JSON.parse(JSON.stringify(document));
      },
    };
    return store satisfies MachineLoadHistoryStore;
  }

  function historyEvents(logs: ReturnType<typeof captureLogs>) {
    return logs
      .records()
      .filter((record) => record.area === "host" && record.event.startsWith("load.history"))
      .map(({ level, event, fields }) => ({ level, event, reason: fields?.reason }));
  }

  test("the 24-hour figure keeps the readings from before a restart, and the downtime stays uncovered", async () => {
    const store = memoryStore();
    const first = fixture(START, store);
    first.sampler.start();
    first.state.cpu = 20;
    for (let minute = 0; minute < 120; minute += 1) await first.step(MINUTE);
    first.sampler.stop();

    // Down for ten minutes, then a new process on the same store.
    const restarted = fixture(first.state.now + 10 * MINUTE, store);
    restarted.sampler.start();
    const report = restarted.sampler.report();
    expect(report.latestSampleAgeSeconds).toBeNull();
    expect(window(report, "24h")).toMatchObject({ coveredSeconds: 7_200, cpuPercent: 20 });
    expect(window(report, "1h")).toMatchObject({ coveredSeconds: 3_000, cpuPercent: 20 });
    expect(window(report, "5m")).toMatchObject({ coveredSeconds: 0, cpuPercent: null });

    restarted.state.cpu = 80;
    await restarted.step(MINUTE);
    const after = restarted.sampler.report();
    expect(window(after, "24h").coveredSeconds).toBe(7_260);
    expect(window(after, "5m")).toMatchObject({ coveredSeconds: 60, cpuPercent: 80 });
    restarted.sampler.stop();
  });

  test("restored readings keep ageing out of the windows", async () => {
    const store = memoryStore();
    const first = fixture(START, store);
    first.sampler.start();
    for (let minute = 0; minute < 60; minute += 1) await first.step(MINUTE);
    first.sampler.stop();

    const nextDay = fixture(first.state.now + 24 * HOUR, store);
    nextDay.sampler.start();
    for (const entry of nextDay.sampler.report().load) {
      expect(entry).toMatchObject({ coveredSeconds: 0, cpuPercent: null });
    }
    nextDay.sampler.stop();
  });

  test("readings dated after the restarted clock are dropped", async () => {
    const store = memoryStore();
    const first = fixture(START, store);
    first.sampler.start();
    for (let minute = 0; minute < 60; minute += 1) await first.step(MINUTE);
    first.sampler.stop();

    // The clock was moved back half an hour while the backend was down.
    const restarted = fixture(START + 30 * MINUTE, store);
    restarted.sampler.start();
    expect(window(restarted.sampler.report(), "24h").coveredSeconds).toBe(1_800);
    restarted.sampler.stop();
    // The dropped readings are not written back.
    const saved = store.value as { fine: unknown[]; coarse: unknown[] };
    expect(saved.fine.length + saved.coarse.length).toBe(30);
  });

  /** The end time of every bucket in a stored document. */
  function storedEnds(store: ReturnType<typeof memoryStore>): number[] {
    const saved = store.value as { fine: number[][]; coarse: number[][] };
    return [...saved.fine, ...saved.coarse].map((bucket) => bucket[1]!);
  }

  test("a clock moved back while running drops future readings, and stop writes the drop", async () => {
    const store = memoryStore();
    const { state, sampler, step } = fixture(START, store);
    sampler.start();
    // Fifteen readings close a period, so everything recorded so far is written.
    for (let minute = 0; minute < 15; minute += 1) await step(MINUTE);
    expect(store.saves).toBe(1);
    expect(Math.max(...storedEnds(store))).toBe(START + 15 * MINUTE);

    state.now = START + 5 * MINUTE;
    expect(window(sampler.report(), "24h").coveredSeconds).toBe(300);
    // Nothing was sampled since the last write; only the drop is left to write.
    sampler.stop();
    expect(store.saves).toBe(2);
    expect(Math.max(...storedEnds(store))).toBe(START + 5 * MINUTE);

    const restarted = fixture(START + 5 * MINUTE, store);
    restarted.sampler.start();
    expect(window(restarted.sampler.report(), "24h").coveredSeconds).toBe(300);
    restarted.sampler.stop();
  });

  test("a drop found by a report while running is written with the next reading's period", async () => {
    const store = memoryStore();
    const { state, sampler, step } = fixture(START, store);
    sampler.start();
    for (let minute = 0; minute < 15; minute += 1) await step(MINUTE);
    expect(store.saves).toBe(1);

    state.now = START + 5 * MINUTE;
    sampler.report();
    expect(store.saves).toBe(1);
    // The first reading after the rollback only sets a fresh baseline.
    await step(MINUTE);
    expect(store.saves).toBe(1);
    // The next one falls in a period other than the last write's, so it writes.
    await step(MINUTE);
    expect(store.saves).toBe(2);
    const ends = storedEnds(store);
    expect(Math.max(...ends)).toBe(START + 7 * MINUTE);
    expect(ends.every((end) => end <= state.now)).toBe(true);
    sampler.stop();
    expect(store.saves).toBe(2);

    const restarted = fixture(state.now, store);
    restarted.sampler.start();
    expect(window(restarted.sampler.report(), "24h").coveredSeconds).toBe(360);
    restarted.sampler.stop();
  });

  test("writes once a 15-minute period rather than after every reading, and once more at stop", async () => {
    const store = memoryStore();
    const { sampler, step } = fixture(START, store);
    sampler.start();
    expect(store.saves).toBe(0);
    for (let minute = 0; minute < 14; minute += 1) await step(MINUTE);
    expect(store.saves).toBe(0);
    await step(MINUTE);
    expect(store.saves).toBe(1);
    for (let minute = 0; minute < 165; minute += 1) await step(MINUTE);
    // Three hours of readings: twelve writes, not 180.
    expect(store.saves).toBe(12);
    sampler.stop();
    // The last reading closed a period and was written then; nothing is left to flush.
    expect(store.saves).toBe(12);

    const restarted = fixture(START + 3 * HOUR + MINUTE, store);
    restarted.sampler.start();
    await restarted.step(MINUTE);
    expect(store.saves).toBe(12);
    restarted.sampler.stop();
    // The shutdown write carries the reading taken since the last period.
    expect(store.saves).toBe(13);
    const again = fixture(START + 3 * HOUR + 3 * MINUTE, store);
    again.sampler.start();
    expect(window(again.sampler.report(), "24h").coveredSeconds).toBe(3 * 3_600 + 60);
    again.sampler.stop();
  });

  test("a stop with nothing new to write does not write", () => {
    const store = memoryStore();
    const { sampler } = fixture(START, store);
    sampler.start();
    sampler.stop();
    expect(store.saves).toBe(0);
  });

  test("the stored document stays small after days of readings", async () => {
    const store = memoryStore();
    const { sampler, step } = fixture(START, store);
    sampler.start();
    let largest = 0;
    for (let minute = 0; minute < 2 * 24 * 60; minute += 1) {
      await step(MINUTE);
      largest = Math.max(largest, JSON.stringify(store.value ?? null).length);
    }
    sampler.stop();
    expect(largest).toBeLessThan(16 * 1024);
    const saved = store.value as { fine: unknown[]; coarse: unknown[] };
    expect(saved.fine.length).toBeLessThanOrEqual(MACHINE_LOAD_HISTORY_LIMITS.maxFineBuckets);
    expect(saved.coarse.length).toBeLessThanOrEqual(MACHINE_LOAD_HISTORY_LIMITS.maxCoarseBuckets);
  });

  test("a missing document starts empty and logs it", async () => {
    const logs = captureLogs();
    try {
      const store = memoryStore();
      const { sampler } = fixture(START, store);
      sampler.start();
      expect(window(sampler.report(), "24h").coveredSeconds).toBe(0);
      sampler.stop();
      expect(historyEvents(logs)).toEqual([
        { level: "info", event: "load.history-fresh", reason: "missing" },
      ]);
    } finally {
      logs.restore();
    }
  });

  test("a restored document logs what it restored", async () => {
    const store = memoryStore();
    const first = fixture(START, store);
    first.sampler.start();
    for (let minute = 0; minute < 20; minute += 1) await first.step(MINUTE);
    first.sampler.stop();
    const logs = captureLogs();
    const restarted = fixture(first.state.now, store);
    try {
      restarted.sampler.start();
      const restored = logs.records().find((record) => record.event === "load.history-restored");
      expect(restored).toMatchObject({
        level: "info",
        area: "host",
        fields: { buckets: 20, coveredSeconds: 1_200 },
      });
    } finally {
      restarted.sampler.stop();
      logs.restore();
    }
  });

  const unusable: Array<[string, (store: ReturnType<typeof memoryStore>) => void, string]> = [
    [
      "a malformed document",
      (store) => (store.value = { version: 1, fine: "x", coarse: [] }),
      "malformed",
    ],
    [
      "a document from a newer format",
      (store) => (store.value = { version: 9, fine: [], coarse: [] }),
      "newer-version",
    ],
    [
      "an unreadable row",
      (store) => (store.loadError = new Error("Store is corrupt")),
      "unreadable",
    ],
  ];
  for (const [name, corrupt, reason] of unusable) {
    test(`${name} starts empty, logs why, and is replaced at stop`, async () => {
      const logs = captureLogs();
      try {
        const store = memoryStore();
        corrupt(store);
        const { sampler } = fixture(START, store);
        sampler.start();
        for (const entry of sampler.report().load) expect(entry.coveredSeconds).toBe(0);
        expect(historyEvents(logs)).toEqual([
          { level: "warn", event: "load.history-fresh", reason },
        ]);
        store.loadError = null;
        sampler.stop();
        expect(store.saves).toBe(1);
        expect(store.value).toEqual({ version: 1, fine: [], coarse: [] });
      } finally {
        logs.restore();
      }
    });
  }

  test("a failed write is logged, sampling carries on, and the next period retries", async () => {
    const logs = captureLogs();
    try {
      const store = memoryStore();
      store.failSaves = 1;
      const { sampler, step } = fixture(START, store);
      sampler.start();
      for (let minute = 0; minute < 15; minute += 1) await step(MINUTE);
      expect(store.saves).toBe(1);
      expect(store.value).toBeUndefined();
      expect(logs.records().some((record) => record.event === "load.history-save-failed")).toBe(
        true,
      );
      expect(window(sampler.report(), "1h").coveredSeconds).toBe(900);
      for (let minute = 0; minute < 15; minute += 1) await step(MINUTE);
      expect(store.saves).toBe(2);
      expect((store.value as { fine: unknown[] }).fine).toHaveLength(30);
      sampler.stop();
    } finally {
      logs.restore();
    }
  });
});

describe("sampling on the timer", () => {
  function timed() {
    const time = new ManualTime();
    const reads: number[] = [];
    const errors: unknown[] = [];
    const sampler = new MachineLoadSampler({
      now: () => START + time.now(),
      cpus: () => cpus(time.now(), time.now()),
      arch: () => "arm64",
      totalMemory: () => 2 ** 30,
      readRam: async (at) => {
        reads.push(at);
        return 10;
      },
      platform: "linux",
      readFile: async () => "NAME=Linux\n",
      metrics: new RecurringWorkMetrics({ enabled: false }),
      schedulerNow: time.now,
      timers: time.timerFactory,
      diagnostics: null,
      onError: (error) => errors.push(error),
    });
    return { time, sampler, reads, errors };
  }

  test("reads once soon after start, then once an interval, without overlap", async () => {
    const { time, sampler, reads } = timed();
    sampler.start();
    await time.advance(MACHINE_LOAD_FIRST_SAMPLE_MS - 1);
    expect(reads).toHaveLength(0);
    await time.advance(1);
    expect(reads).toHaveLength(1);
    await time.advance(MACHINE_LOAD_SAMPLE_MS * 3);
    expect(reads).toHaveLength(4);
    sampler.stop();
  });

  test("stopping clears the timer, so nothing keeps a stopping backend alive", async () => {
    const { time, sampler, reads } = timed();
    sampler.start();
    await time.advance(MACHINE_LOAD_FIRST_SAMPLE_MS);
    const before = reads.length;
    expect(time.pendingTimers).toBeGreaterThan(0);
    sampler.stop();
    await time.advance(0);
    expect(time.pendingTimers).toBe(0);
    await time.advance(MACHINE_LOAD_SAMPLE_MS * 10);
    expect(reads).toHaveLength(before);
    sampler.stop();
  });

  test("start is idempotent: a second start adds no second timer", async () => {
    const { time, sampler, reads } = timed();
    sampler.start();
    sampler.start();
    await time.advance(MACHINE_LOAD_FIRST_SAMPLE_MS);
    expect(reads).toHaveLength(1);
    sampler.stop();
  });

  test("records each reading under its recurring-work kind", async () => {
    const time = new ManualTime();
    const metrics = new RecurringWorkMetrics({ now: time.now });
    const sampler = new MachineLoadSampler({
      now: () => START + time.now(),
      cpus: () => cpus(time.now(), time.now()),
      readRam: async () => 10,
      platform: "linux",
      readFile: async () => "NAME=Linux\n",
      metrics,
      schedulerNow: time.now,
      timers: time.timerFactory,
      diagnostics: null,
    });
    sampler.start();
    await time.advance(MACHINE_LOAD_FIRST_SAMPLE_MS + MACHINE_LOAD_SAMPLE_MS);
    expect(metrics.snapshot().kinds["machine-load-sample"]).toMatchObject({
      requested: 2,
      completed: 2,
      failed: 0,
    });
    sampler.stop();
  });

  test("a failed reading is reported and sampling carries on", async () => {
    const time = new ManualTime();
    const errors: unknown[] = [];
    let fail = true;
    const sampler = new MachineLoadSampler({
      now: () => START + time.now(),
      cpus: () => cpus(time.now(), time.now()),
      readRam: async () => {
        if (fail) throw new Error("no reading");
        return 10;
      },
      platform: "linux",
      readFile: async () => "NAME=Linux\n",
      metrics: new RecurringWorkMetrics({ enabled: false }),
      schedulerNow: time.now,
      timers: time.timerFactory,
      diagnostics: null,
      onError: (error) => errors.push(error),
    });
    sampler.start();
    await time.advance(MACHINE_LOAD_FIRST_SAMPLE_MS);
    expect(errors).toHaveLength(1);
    fail = false;
    await time.advance(MACHINE_LOAD_SAMPLE_MS);
    expect(window(sampler.report(), "5m").coveredSeconds).toBe(75);
    sampler.stop();
  });
});

describe("what the machine reports about itself", () => {
  test("macOS comes from sw_vers", async () => {
    expect(
      await describeOs({
        platform: "darwin",
        runCommand: async (command, args) => {
          expect([command, ...args]).toEqual(["sw_vers", "-productVersion"]);
          return { stdout: "26.1\n" };
        },
      }),
    ).toBe("macOS 26.1");
  });

  test("macOS with no readable version is retried, and reads as plain macOS meanwhile", async () => {
    let attempts = 0;
    const sampler = new MachineLoadSampler({
      platform: "darwin",
      now: () => START,
      cpus: () => cpus(0, 0),
      readRam: async () => 1,
      metrics: new RecurringWorkMetrics({ enabled: false }),
      runCommand: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("sw_vers failed");
        return { stdout: "26.1\n" };
      },
    });
    await sampler.sample();
    expect(sampler.report().os).toBe("macOS");
    await sampler.sample();
    expect(sampler.report().os).toBe("macOS 26.1");
    await sampler.sample();
    expect(attempts).toBe(2);
  });

  test("Linux prefers PRETTY_NAME and falls back to the second os-release path", async () => {
    expect(parseOsRelease('NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\n')).toBe(
      "Arch Linux",
    );
    expect(parseOsRelease('NAME="Ubuntu"\nVERSION_ID="24.04"\n')).toBe("Ubuntu 24.04");
    expect(parseOsRelease("NAME=Alpine\n")).toBe("Alpine");
    expect(parseOsRelease("# nothing\n")).toBeNull();
    const seen: string[] = [];
    expect(
      await describeOs({
        platform: "linux",
        readFile: async () => 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nVERSION_ID="13"\n',
      }),
    ).toBe("Debian GNU/Linux 13 (trixie)");
    expect(
      await describeOs({
        platform: "linux",
        readFile: async (path) => {
          seen.push(path);
          if (path === "/etc/os-release") throw new Error("missing");
          return 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\n';
        },
      }),
    ).toBe("Debian GNU/Linux 13 (trixie)");
    expect(seen).toEqual(["/etc/os-release", "/usr/lib/os-release"]);
    expect(
      await describeOs({
        platform: "linux",
        readFile: async () => {
          throw new Error("missing");
        },
      }),
    ).toBeNull();
  });

  test("a Linux name with no number gains its version, and a derivative names its base", () => {
    // beelink's /etc/os-release, read 2026-11-01: the whole PRETTY_NAME is "Omarchy".
    const omarchy = [
      'NAME="Omarchy"',
      'PRETTY_NAME="Omarchy"',
      "ID=omarchy",
      "ID_LIKE=arch",
      'BUILD_ID="4.0.6"',
      'VERSION_ID="4.0.6"',
      'HOME_URL="https://omarchy.org/"',
    ].join("\n");
    expect(parseOsRelease(omarchy)).toBe("Omarchy 4.0.6 (like arch)");
    expect(
      parseOsRelease(
        'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n',
      ),
    ).toBe("Ubuntu 24.04.1 LTS (like debian)");
    // A name that already carries a number is not given a second one.
    expect(parseOsRelease('PRETTY_NAME="Alpine Linux v3.20"\nVERSION_ID=3.20.3\n')).toBe(
      "Alpine Linux v3.20",
    );
    expect(parseOsRelease('PRETTY_NAME="Rocky Linux 9.4"\nID_LIKE="rhel centos fedora"\n')).toBe(
      "Rocky Linux 9.4 (like rhel, centos, fedora)",
    );
    // Arch is rolling: no VERSION_ID and nothing it derives from.
    expect(parseOsRelease('PRETTY_NAME="Arch Linux"\nBUILD_ID=rolling\nID=arch\n')).toBe(
      "Arch Linux",
    );
    // Only os-release identifiers are kept from ID_LIKE.
    expect(parseOsRelease('NAME="Odd"\nID_LIKE="arch <b>x</b>"\n')).toBe("Odd (like arch)");
  });

  test("Windows names itself, and an unknown platform is described plainly", async () => {
    expect(await describeOs({ platform: "win32", version: () => "Windows 11 Pro" })).toBe(
      "Windows 11 Pro",
    );
    expect(await describeOs({ platform: "freebsd", release: () => "14.1" })).toBe("freebsd 14.1");
    expect(machineOsFamily("darwin")).toBe("macos");
    expect(machineOsFamily("linux")).toBe("linux");
    expect(machineOsFamily("win32")).toBe("windows");
    expect(machineOsFamily("freebsd")).toBe("other");
  });

  test("the report carries only the documented fields, and parses as its own shape", async () => {
    const { sampler, step } = fixture();
    sampler.start();
    await step(MINUTE);
    const report = sampler.report();
    expect(Object.keys(report).toSorted()).toEqual([
      "arch",
      "cpuCores",
      "latestSampleAgeSeconds",
      "load",
      "os",
      "osFamily",
      "totalRamGb",
    ]);
    expect(parseMachineLoadReport(report)).toEqual(report);
    sampler.stop();
  });
});

describe("the get_machine_load command", () => {
  function command(): CommandHandler {
    const commands = new Map<string, CommandHandler>();
    registerSystemCommands(registrarFrom((name, handler) => commands.set(name, handler)));
    return commands.get("get_machine_load")!;
  }

  test("is registered, takes no arguments and needs a running sampler", () => {
    expect(createCommandRegistry().has("get_machine_load")).toBe(true);
    const handler = command();
    expect(() => handler({}, {} as CommandContext)).toThrow("not running");
    // A defined command drops unknown keys (plan item 7009): the sampler is still needed.
    expect(() => handler({ path: "/" }, {} as CommandContext)).toThrow("not running");
  });

  test("answers from the sampler without taking a reading", async () => {
    const { sampler, step, ramReads } = fixture();
    sampler.start();
    await step(MINUTE);
    const reads = ramReads.length;
    const answer = command()({}, { machineLoad: sampler } as unknown as CommandContext);
    expect(answer).toEqual(sampler.report());
    expect(ramReads).toHaveLength(reads);
    sampler.stop();
  });
});
