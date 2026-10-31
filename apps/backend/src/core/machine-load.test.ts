import { describe, expect, test } from "bun:test";
import type { CpuInfo } from "node:os";
import { parseMachineLoadReport } from "@orkestrator/protocol/machine-load";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import { createCommandRegistry } from "./commands-registry.js";
import {
  describeOs,
  MACHINE_LOAD_FIRST_SAMPLE_MS,
  MACHINE_LOAD_MAX_SAMPLE_GAP_MS,
  MACHINE_LOAD_SAMPLE_MS,
  machineOsFamily,
  MachineLoadHistory,
  MachineLoadSampler,
  parseOsRelease,
} from "./machine-load.js";
import { flushMicrotasks, ManualTime } from "./recurring-test-support.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";

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
function fixture(start = START) {
  const state = { now: start, busy: 0, idle: 0, cpu: 50, ram: 40 };
  const ramReads: number[] = [];
  const sampler = new MachineLoadSampler({
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

  test("a restarted backend starts with no history, and nothing from before is kept", async () => {
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

  test("a clock moved back drops readings now dated in the future", async () => {
    const { state, sampler, step } = fixture();
    sampler.start();
    for (let minute = 0; minute < 3; minute += 1) await step(MINUTE);
    state.now -= HOUR;
    await sampler.sample();
    expect(window(sampler.report(), "24h").coveredSeconds).toBe(0);
    await step(MINUTE);
    expect(window(sampler.report(), "24h").coveredSeconds).toBe(60);
    expect(sampler.report().latestSampleAgeSeconds).toBe(0);
    sampler.stop();
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
    registerSystemCommands((name, handler) => commands.set(name, handler));
    return commands.get("get_machine_load")!;
  }

  test("is registered, takes no arguments and needs a running sampler", () => {
    expect(createCommandRegistry().has("get_machine_load")).toBe(true);
    const handler = command();
    expect(() => handler({}, {} as CommandContext)).toThrow("not running");
    expect(() => handler({ path: "/" }, {} as CommandContext)).toThrow(/Unexpected arguments/);
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
