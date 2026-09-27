import { describe, expect, mock, test } from "bun:test";
import type { CpuInfo } from "node:os";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { APP_VERSION } from "./constants.js";
import { registerSystemCommands } from "./commands-registry-system.js";
import { createCommandRegistry } from "./commands-registry.js";
import {
  cpuPercent,
  cpuTimes,
  createSystemUsageReader,
  darwinRamPercentFromVmStat,
  GPU_AVAILABLE_CACHE_MS,
  parseDarwinGpuPercent,
  parseDarwinVmStat,
  parsePercentLines,
  RAM_UNAVAILABLE_CACHE_MS,
  readDarwinGpuPercent,
  readDarwinRamPercent,
  readDiskPercent,
  readGpuPercent,
  readLinuxGpuPercent,
  readRamPercent,
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

  test("reports the sanitized running app version", () => {
    const commands = new Map<string, CommandHandler>();
    registerSystemCommands((name, handler) => commands.set(name, handler));
    expect(createCommandRegistry().has("get_app_version")).toBe(true);
    expect(commands.get("get_app_version")!({}, {} as CommandContext)).toBe(APP_VERSION);
    expect(() => commands.get("get_app_version")!({ extra: true }, {} as CommandContext)).toThrow(
      /Unexpected arguments field: extra/,
    );
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

  test("reads Darwin GPU percentages from IOAccelerator performance statistics", async () => {
    expect(
      parseDarwinGpuPercent(
        `"PerformanceStatistics" = {"Device Utilization %"=0,"Renderer Utilization %"=24,"Tiler Utilization %"=14}`,
      ),
    ).toBe(24);
    expect(
      parseDarwinGpuPercent(
        `"PerformanceStatistics" = {"Device Utilization %" = 40}\n"PerformanceStatistics" = {"Renderer Utilization %" = 80}`,
      ),
    ).toBe(60);
    expect(
      parseDarwinGpuPercent(
        `"PerformanceStatistics" = {"Device Utilization %"=0,"Tiler Utilization %"=0}`,
      ),
    ).toBe(0);
    expect(
      parseDarwinGpuPercent(`"PerformanceStatistics" = {"Alloc system memory"=12}`),
    ).toBeNull();

    const execute = mock(async () => ({
      stdout: `"PerformanceStatistics" = {"Device Utilization %"=18,"Renderer Utilization %"=12}`,
    }));
    expect(
      await readDarwinGpuPercent({
        platform: "darwin",
        sampleCount: 1,
        runCommand: execute,
      }),
    ).toBe(18);
    expect(execute).toHaveBeenCalledWith(
      "ioreg",
      ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"],
      { timeoutMs: 1_500 },
    );
    expect(
      await readDarwinGpuPercent({
        platform: "linux",
        runCommand: async () => {
          throw new Error("must not run");
        },
      }),
    ).toBeNull();
    expect(
      await readDarwinGpuPercent({
        platform: "darwin",
        sampleCount: 2,
        delay: async () => {},
        runCommand: async () => {
          throw new Error("ioreg missing");
        },
      }),
    ).toBeNull();
  });

  test("keeps the peak Darwin GPU sample so idle snapshots do not hide activity", async () => {
    const outputs = [
      `"PerformanceStatistics" = {"Device Utilization %"=0,"Renderer Utilization %"=0}`,
      `"PerformanceStatistics" = {"Device Utilization %"=0,"Renderer Utilization %"=26}`,
      `"PerformanceStatistics" = {"Device Utilization %"=0,"Tiler Utilization %"=0}`,
    ];
    const execute = mock(async () => ({ stdout: outputs.shift() ?? outputs[0]! }));
    const delays: number[] = [];
    expect(
      await readDarwinGpuPercent({
        platform: "darwin",
        sampleCount: 3,
        delay: async (milliseconds) => {
          delays.push(milliseconds);
        },
        runCommand: execute,
      }),
    ).toBe(26);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([80, 80]);
  });

  test("samples Darwin GPU twice by default so title-bar polls stay cheap", async () => {
    const execute = mock(async () => ({
      stdout: `"PerformanceStatistics" = {"Device Utilization %"=18}`,
    }));
    expect(
      await readDarwinGpuPercent({
        platform: "darwin",
        delay: async () => {},
        runCommand: execute,
      }),
    ).toBe(18);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test("uses sysfs before nvidia-smi and parses multi-GPU output", async () => {
    const execute = mock(async () => ({ stdout: "45\n85\n" }));
    expect(await readGpuPercent({ linuxGpuPercent: async () => 31, runCommand: execute })).toBe(31);
    expect(execute).not.toHaveBeenCalled();

    expect(
      await readGpuPercent({
        linuxGpuPercent: async () => null,
        darwinGpuPercent: async () => null,
        runCommand: execute,
      }),
    ).toBe(65);
    expect(execute).toHaveBeenCalledWith(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { timeoutMs: 1_500 },
    );
  });

  test("uses ioreg after sysfs and treats an idle Darwin reading as authoritative", async () => {
    const execute = mock(async () => ({ stdout: "45\n85\n" }));
    expect(
      await readGpuPercent({
        linuxGpuPercent: async () => null,
        darwinGpuPercent: async () => 22,
        runCommand: execute,
      }),
    ).toBe(22);
    expect(
      await readGpuPercent({
        linuxGpuPercent: async () => null,
        darwinGpuPercent: async () => 0,
        runCommand: execute,
      }),
    ).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  test("returns null when nvidia-smi fails or produces no usable values", async () => {
    expect(
      await readGpuPercent({
        linuxGpuPercent: async () => null,
        darwinGpuPercent: async () => null,
        runCommand: async () => ({ stdout: "\nN/A\n" }),
      }),
    ).toBeNull();
    expect(
      await readGpuPercent({
        linuxGpuPercent: async () => null,
        darwinGpuPercent: async () => null,
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
      platform: "linux",
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
      platform: "linux",
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
      platform: "linux",
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
      platform: "linux",
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
    clock += GPU_AVAILABLE_CACHE_MS - 4_999;
    expect((await read("/data")).gpuPercent).toBe(45);
    clock += GPU_AVAILABLE_CACHE_MS;
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

  // Step 09 measurement: is a completed-snapshot TTL worth adding? Two clients
  // whose five-second title bars interleave send a non-overlapping request
  // every 2.5 s. Everything costly is already bounded by the GPU/RAM caches;
  // what remains per request is two `os.cpus()` reads and one `statfs`, and
  // the CPU window never needs the 200 ms fresh baseline. A TTL would save
  // nothing measurable, and it would hand out stale CPU figures.
  test("non-overlapping requests from two clients repeat no costly probe", async () => {
    let clock = 0;
    let cpuReads = 0;
    const cpus = () => {
      cpuReads += 1;
      return [cpu(clock * 3, clock)];
    };
    const gpuPercent = mock(async () => 10);
    const disks: string[] = [];
    let freshBaselines = 0;
    const read = createSystemUsageReader({
      platform: "linux",
      cpus,
      totalMemory: () => 1_000,
      freeMemory: () => 500,
      diskPercent: async (path) => {
        disks.push(path);
        return path === "/data" ? 40 : 90;
      },
      gpuPercent,
      now: () => clock,
      delay: async (milliseconds) => {
        freshBaselines += 1;
        clock += milliseconds;
      },
    });

    await read("/data");
    const startupBaselines = freshBaselines;
    const sampledAt = new Set<string>();
    for (let request = 0; request < 24; request += 1) {
      clock += 2_500;
      const snapshot = await read("/data");
      sampledAt.add(snapshot.sampledAt);
      expect(snapshot.diskPercent).toBe(40);
    }
    // 60 s of two clients: one GPU probe per 15 s cache window, no fresh CPU
    // baselines after startup, one statfs per request, every sample new.
    expect(gpuPercent.mock.calls.length).toBeLessThanOrEqual(5);
    expect(freshBaselines).toBe(startupBaselines);
    expect(disks.length).toBe(25);
    expect(sampledAt.size).toBe(24);
    expect(cpuReads).toBeLessThanOrEqual(2 + 1 + 24);

    // A disk reading is never reused for another filesystem target.
    const [data, other] = await Promise.all([read("/data"), read("/other")]);
    expect(data.diskPercent).toBe(40);
    expect(other.diskPercent).toBe(90);
  });

  test("shares an in-flight GPU probe across different disk reads", async () => {
    let clock = 0;
    const gpuProbe = deferred<number | null>();
    const gpuPercent = mock(() => gpuProbe.promise);
    const read = createSystemUsageReader({
      platform: "linux",
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

  test("parses Darwin vm_stat and reports Activity Monitor Memory Used", () => {
    const output = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               17320.",
      "Pages wired down:                        624415.",
      "Pages purgeable:                          67841.",
      "File-backed pages:                      1667777.",
      "Anonymous pages:                        4109534.",
      "Pages occupied by compressor:           1907369.",
    ].join("\n");
    expect(parseDarwinVmStat(output)).toEqual({
      pageSize: 16_384,
      wired: 624_415,
      purgeable: 67_841,
      anonymous: 4_109_534,
      compressor: 1_907_369,
    });
    expect(darwinRamPercentFromVmStat(output, 137_438_953_472)).toBe(78.4);
    expect(parseDarwinVmStat("Pages wired down: 1.")).toBeNull();
    expect(darwinRamPercentFromVmStat(output, 0)).toBeNull();

    const quoted = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      '"Pages wired down":                        624415.',
      '"Pages purgeable":                          67841.',
      '"Anonymous pages":                        4109534.',
      '"Pages occupied by compressor":           1907369.',
    ].join("\n");
    expect(parseDarwinVmStat(quoted)).toEqual({
      pageSize: 16_384,
      wired: 624_415,
      purgeable: 67_841,
      anonymous: 4_109_534,
      compressor: 1_907_369,
    });
    expect(darwinRamPercentFromVmStat(quoted, 137_438_953_472)).toBe(78.4);
  });

  test("reads Darwin RAM from vm_stat and falls back off-platform or on failure", async () => {
    const output = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages wired down:                              200.",
      "Pages purgeable:                               100.",
      "Anonymous pages:                              1000.",
      "Pages occupied by compressor:                  300.",
    ].join("\n");
    const execute = mock(async () => ({ stdout: output }));
    expect(
      await readDarwinRamPercent({
        platform: "darwin",
        totalMemory: () => 40_960_000,
        runCommand: execute,
      }),
    ).toBe(56);
    expect(execute).toHaveBeenCalledWith("vm_stat", [], { timeoutMs: 1_500 });
    expect(
      await readDarwinRamPercent({
        platform: "linux",
        runCommand: async () => {
          throw new Error("must not run");
        },
      }),
    ).toBeNull();
    expect(
      await readDarwinRamPercent({
        platform: "darwin",
        runCommand: async () => {
          throw new Error("vm_stat missing");
        },
      }),
    ).toBeNull();
  });

  test("uses Darwin RAM on macOS and the free-page formula elsewhere", async () => {
    expect(
      await readRamPercent({
        platform: "linux",
        totalMemory: () => 1_000,
        freeMemory: () => 250,
      }),
    ).toBe(75);
    expect(
      await readRamPercent({
        platform: "darwin",
        totalMemory: () => 40_960_000,
        freeMemory: () => 0,
        runCommand: async () => ({
          stdout: [
            "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
            "Pages wired down:                              200.",
            "Pages purgeable:                               100.",
            "Anonymous pages:                              1000.",
            "Pages occupied by compressor:                  300.",
          ].join("\n"),
        }),
      }),
    ).toBe(56);

    let clock = 0;
    const execute = mock(async () => ({
      stdout: [
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
        "Pages wired down:                              200.",
        "Pages purgeable:                               100.",
        "Anonymous pages:                              1000.",
        "Pages occupied by compressor:                  300.",
      ].join("\n"),
    }));
    const read = createSystemUsageReader({
      platform: "darwin",
      cpus: () => [cpu(clock, clock)],
      totalMemory: () => 40_960_000,
      freeMemory: () => 0,
      diskPercent: async () => 0,
      gpuPercent: async () => null,
      runCommand: execute,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    expect((await read("/data")).ramPercent).toBe(56);
    expect(execute).toHaveBeenCalledWith("vm_stat", [], { timeoutMs: 1_500 });
  });

  test("falls back to the free-page formula on Darwin when vm_stat is unusable", async () => {
    expect(
      await readRamPercent({
        platform: "darwin",
        totalMemory: () => 1_000,
        freeMemory: () => 10,
        runCommand: async () => {
          throw new Error("vm_stat missing");
        },
      }),
    ).toBe(99);
    expect(
      await readRamPercent({
        platform: "darwin",
        totalMemory: () => 2_000,
        freeMemory: () => 500,
        runCommand: async () => {
          throw new Error("vm_stat timed out");
        },
      }),
    ).toBe(75);
    expect(
      await readRamPercent({
        platform: "darwin",
        totalMemory: () => 1_000,
        freeMemory: () => 250,
        runCommand: async () => ({ stdout: "Pages wired down: 1." }),
      }),
    ).toBe(75);
    expect(
      await readRamPercent({
        platform: "darwin",
        totalMemory: () => 4_000,
        freeMemory: () => 1_000,
        runCommand: async () => ({
          stdout: [
            "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
            "Pages wired down:                              200.",
            "Pages purgeable:                               100.",
          ].join("\n"),
        }),
      }),
    ).toBe(75);
  });

  test("caches a failed Darwin vm_stat probe across title-bar polls", async () => {
    let clock = 0;
    const execute = mock(async () => {
      throw new Error("vm_stat denied");
    });
    const read = createSystemUsageReader({
      platform: "darwin",
      cpus: () => [cpu(clock, clock)],
      totalMemory: () => 1_000,
      freeMemory: () => 10,
      diskPercent: async () => 0,
      gpuPercent: async () => null,
      runCommand: execute,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    expect((await read("/data")).ramPercent).toBe(99);
    for (let index = 0; index < 5; index += 1) {
      clock += 5_000;
      expect((await read("/data")).ramPercent).toBe(99);
    }
    expect(execute).toHaveBeenCalledTimes(1);
    clock += RAM_UNAVAILABLE_CACHE_MS - 5_000 * 5 + 1;
    expect((await read("/data")).ramPercent).toBe(99);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  test("reuses the last Darwin vm_stat reading instead of the free-page fallback", async () => {
    let clock = 0;
    let fail = false;
    const execute = mock(async () => {
      if (fail) throw new Error("vm_stat timed out");
      return {
        stdout: [
          "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
          "Pages wired down:                              200.",
          "Pages purgeable:                               100.",
          "Anonymous pages:                              1000.",
          "Pages occupied by compressor:                  300.",
        ].join("\n"),
      };
    });
    const read = createSystemUsageReader({
      platform: "darwin",
      cpus: () => [cpu(clock, clock)],
      totalMemory: () => 40_960_000,
      freeMemory: () => 0,
      diskPercent: async () => 0,
      gpuPercent: async () => null,
      runCommand: execute,
      now: () => clock,
      delay: async (milliseconds) => {
        clock += milliseconds;
      },
    });

    expect((await read("/data")).ramPercent).toBe(56);
    fail = true;
    clock += 15_000;
    expect((await read("/data")).ramPercent).toBe(56);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
