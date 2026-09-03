import { describe, expect, mock, test } from "bun:test";
import type { CpuInfo } from "node:os";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import { createCommandRegistry } from "./commands-registry.js";
import {
  cpuPercent,
  cpuTimes,
  createSystemUsageReader,
  parsePercentLines,
  readDiskPercent,
  readGpuPercent,
  readLinuxGpuPercent,
} from "./system-usage.js";

function cpu(idle: number, user: number): CpuInfo {
  return {
    model: "test",
    speed: 1,
    times: { idle, user, nice: 0, sys: 0, irq: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("system usage", () => {
  test("registers the renderer snapshot command", () => {
    expect(createCommandRegistry().has("get_system_usage")).toBe(true);
  });

  test("passes the backend data directory to the registered reader", async () => {
    const commands = new Map<string, CommandHandler>();
    const read = mock(async () => ({
      cpuPercent: 1,
      ramPercent: 2,
      gpuPercent: null,
      diskPercent: 3,
      sampledAt: "2026-09-03T12:00:00.000Z",
    }));
    registerSystemCommands((name, handler) => commands.set(name, handler), read);

    await commands.get("get_system_usage")!({}, {
      storage: { getDataDir: () => "/authoritative/data" },
    } as unknown as CommandContext);

    expect(read).toHaveBeenCalledWith("/authoritative/data");
  });

  test("calculates CPU use and rejects invalid counter intervals", () => {
    const previous = cpuTimes([cpu(100, 100), cpu(100, 100)]);
    const current = cpuTimes([cpu(120, 180), cpu(120, 180)]);
    expect(cpuPercent(previous, current)).toBe(80);
    expect(cpuPercent(previous, previous)).toBe(0);
    expect(cpuPercent(previous, { idle: 190, total: 410 })).toBe(0);
    expect(cpuPercent(previous, { idle: 210, total: 390 })).toBe(0);
  });

  test("parses only non-empty finite percentage lines", () => {
    expect(parsePercentLines("45\n")).toEqual([45]);
    expect(parsePercentLines("45\n85\n")).toEqual([45, 85]);
    expect(parsePercentLines(" \nN/A\n12.5\nInfinity\n")).toEqual([12.5]);
  });

  test("calculates disk use and handles unusable filesystems", async () => {
    const statfs = mock(async (_path: string) => ({ blocks: 1_000, bavail: 375 }));
    expect(await readDiskPercent("/data", statfs)).toBe(62.5);
    expect(statfs).toHaveBeenCalledWith("/data");
    expect(await readDiskPercent("/data", async () => ({ blocks: 0, bavail: 0 }))).toBeNull();
    expect(
      await readDiskPercent("/missing", async () => {
        throw new Error("unreadable");
      }),
    ).toBeNull();
  });

  test("reads Linux GPU percentages while excluding empty and failed cards", async () => {
    const readFile = mock(async (path: string) => {
      if (path.includes("card0")) return "40\n";
      if (path.includes("card1")) return "";
      throw new Error("suspended");
    });
    expect(
      await readLinuxGpuPercent({
        platform: "linux",
        listCards: async () => ["card0", "card1", "card2"],
        readFile,
      }),
    ).toBe(40);
    expect(
      await readLinuxGpuPercent({
        platform: "darwin",
        listCards: async () => {
          throw new Error("must not run");
        },
      }),
    ).toBeNull();
    expect(
      await readLinuxGpuPercent({
        platform: "linux",
        listCards: async () => {
          throw new Error("missing sysfs");
        },
      }),
    ).toBeNull();
  });

  test("uses sysfs before nvidia-smi and parses multi-GPU output", async () => {
    const execute = mock(async () => ({ stdout: "45\n85\n" }));
    expect(await readGpuPercent({ linuxGpuPercent: async () => 31, runCommand: execute })).toBe(31);
    expect(execute).not.toHaveBeenCalled();

    expect(await readGpuPercent({ linuxGpuPercent: async () => null, runCommand: execute })).toBe(
      65,
    );
    expect(execute).toHaveBeenCalledWith(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { timeoutMs: 1_500 },
    );
  });

  test("returns null when nvidia-smi fails or produces no usable values", async () => {
    expect(
      await readGpuPercent({
        linuxGpuPercent: async () => null,
        runCommand: async () => ({ stdout: "\nN/A\n" }),
      }),
    ).toBeNull();
    expect(
      await readGpuPercent({
        linuxGpuPercent: async () => null,
        runCommand: async () => {
          throw new Error("timed out");
        },
      }),
    ).toBeNull();
  });

  test("takes a fresh bounded CPU sample after startup and long inactivity", async () => {
    let clock = 0;
    const snapshots = [
      [cpu(0, 0)],
      [cpu(100, 100)],
      [cpu(120, 180)],
      [cpu(10_000, 10_000)],
      [cpu(10_020, 10_080)],
    ];
    const read = createSystemUsageReader({
      cpus: () => snapshots.shift() ?? [cpu(10_020, 10_080)],
      totalMemory: () => 1_000,
      freeMemory: () => 250,
      diskPercent: async () => 62.5,
      gpuPercent: async () => 44,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    expect((await read("/data")).cpuPercent).toBe(80);
    clock += 60_000;
    expect((await read("/data")).cpuPercent).toBe(80);
  });

  test("coalesces overlapping reads instead of consuming a near-zero CPU interval", async () => {
    let clock = 0;
    const sampleDelay = deferred<void>();
    const cpus = mock()
      .mockReturnValueOnce([cpu(0, 0)])
      .mockReturnValueOnce([cpu(100, 100)])
      .mockReturnValue([cpu(120, 180)]);
    const read = createSystemUsageReader({
      cpus,
      totalMemory: () => 1_000,
      freeMemory: () => 500,
      diskPercent: async () => 20,
      gpuPercent: async () => 30,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
        await sampleDelay.promise;
      },
    });

    const first = read("/data");
    const second = read("/data");
    expect(first).toBe(second);
    sampleDelay.resolve();
    expect((await first).cpuPercent).toBe(80);
    expect((await second).cpuPercent).toBe(80);
    expect(cpus).toHaveBeenCalledTimes(3);
  });

  test("reuses very recent CPU usage and handles zero total memory", async () => {
    let clock = 0;
    const cpus = mock()
      .mockReturnValueOnce([cpu(0, 0)])
      .mockReturnValueOnce([cpu(100, 100)])
      .mockReturnValueOnce([cpu(120, 180)])
      .mockReturnValue([cpu(120, 180)]);
    const read = createSystemUsageReader({
      cpus,
      totalMemory: () => 0,
      freeMemory: () => 0,
      diskPercent: async () => null,
      gpuPercent: async () => null,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    expect(await read("/data")).toMatchObject({ cpuPercent: 80, ramPercent: 0 });
    clock += 50;
    expect(await read("/data")).toMatchObject({ cpuPercent: 80, ramPercent: 0 });
    expect(cpus).toHaveBeenCalledTimes(3);
  });

  test("uses distinct cache windows for available and unavailable GPU readings", async () => {
    let clock = 0;
    const values: Array<number | null> = [44, 45, null, 46];
    const gpuPercent = mock(async () => (values.length > 0 ? values.shift()! : 46));
    const read = createSystemUsageReader({
      cpus: () => [cpu(clock, clock)],
      totalMemory: () => 1,
      freeMemory: () => 0,
      diskPercent: async () => 0,
      gpuPercent,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    expect((await read("/data")).gpuPercent).toBe(44);
    clock += 4_999;
    expect((await read("/data")).gpuPercent).toBe(44);
    clock += 1;
    expect((await read("/data")).gpuPercent).toBe(45);
    clock += 5_000;
    expect((await read("/data")).gpuPercent).toBeNull();
    for (let index = 0; index < 6; index += 1) {
      clock += 4_999;
      expect((await read("/data")).gpuPercent).toBeNull();
    }
    clock += 5;
    expect((await read("/data")).gpuPercent).toBeNull();
    clock += 1;
    expect((await read("/data")).gpuPercent).toBe(46);
    expect(gpuPercent).toHaveBeenCalledTimes(4);
  });

  test("shares an in-flight GPU probe across different disk reads", async () => {
    let clock = 0;
    const gpuProbe = deferred<number | null>();
    const gpuPercent = mock(() => gpuProbe.promise);
    const read = createSystemUsageReader({
      cpus: () => [cpu(clock, clock)],
      totalMemory: () => 1,
      freeMemory: () => 0,
      diskPercent: async () => 0,
      gpuPercent,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    const first = read("/one");
    const second = read("/two");
    await Promise.resolve();
    await Promise.resolve();
    expect(gpuPercent).toHaveBeenCalledTimes(1);
    gpuProbe.resolve(55);
    expect((await first).gpuPercent).toBe(55);
    expect((await second).gpuPercent).toBe(55);
  });
});
