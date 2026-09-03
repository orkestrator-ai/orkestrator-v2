import { promises as fs } from "node:fs";
import os from "node:os";
import type { CpuInfo } from "node:os";
import { runCommand } from "./shell.js";

export interface SystemUsageSnapshot {
  cpuPercent: number;
  ramPercent: number;
  gpuPercent: number | null;
  diskPercent: number | null;
  sampledAt: string;
}

interface CpuTimeSnapshot {
  idle: number;
  total: number;
}

interface SystemUsageDependencies {
  cpus: () => CpuInfo[];
  totalMemory: () => number;
  freeMemory: () => number;
  diskPercent: (path: string) => Promise<number | null>;
  gpuPercent: () => Promise<number | null>;
  now: () => number;
  delay: (milliseconds: number) => Promise<void>;
}

interface LinuxGpuDependencies {
  platform: NodeJS.Platform;
  listCards: () => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
}

interface GpuDependencies {
  linuxGpuPercent: () => Promise<number | null>;
  runCommand: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string }>;
}

const GPU_AVAILABLE_CACHE_MS = 5_000;
const GPU_UNAVAILABLE_CACHE_MS = 30_000;
const CPU_BASELINE_MAX_AGE_MS = 5_000;
const CPU_MIN_INTERVAL_MS = 100;
const CPU_FRESH_SAMPLE_MS = 200;

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

export function cpuTimes(cpus: CpuInfo[]): CpuTimeSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

export function cpuPercent(previous: CpuTimeSnapshot, current: CpuTimeSnapshot): number {
  const elapsed = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (elapsed <= 0 || idle < 0) return 0;
  return clampPercent(((elapsed - idle) / elapsed) * 100);
}

export async function readDiskPercent(
  path: string,
  statfs: (path: string) => Promise<{ blocks: number; bavail: number }> = fs.statfs,
): Promise<number | null> {
  try {
    const stats = await statfs(path);
    if (stats.blocks <= 0) return null;
    return clampPercent(((stats.blocks - stats.bavail) / stats.blocks) * 100);
  } catch {
    return null;
  }
}

function averagePercent(values: number[]): number | null {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return null;
  return clampPercent(valid.reduce((sum, value) => sum + value, 0) / valid.length);
}

export function parsePercentLines(output: string): number[] {
  return output
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

export async function readLinuxGpuPercent(
  dependencies: Partial<LinuxGpuDependencies> = {},
): Promise<number | null> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "linux") return null;
  const listCards =
    dependencies.listCards ??
    (async () =>
      (await fs.readdir("/sys/class/drm", { withFileTypes: true }))
        // Entries under /sys/class are normally symlinks rather than physical
        // directories, so the stable card name is the useful discriminator.
        .filter((entry) => /^card\d+$/.test(entry.name))
        .map((entry) => entry.name));
  const readFile = dependencies.readFile ?? ((path: string) => fs.readFile(path, "utf8"));

  try {
    const values = await Promise.all(
      (await listCards()).map(async (card) => {
        try {
          const [value] = parsePercentLines(
            await readFile(`/sys/class/drm/${card}/device/gpu_busy_percent`),
          );
          return value ?? Number.NaN;
        } catch {
          return Number.NaN;
        }
      }),
    );
    return averagePercent(values);
  } catch {
    return null;
  }
}

export async function readGpuPercent(
  dependencies: Partial<GpuDependencies> = {},
): Promise<number | null> {
  const linuxGpuPercent = dependencies.linuxGpuPercent ?? readLinuxGpuPercent;
  const execute = dependencies.runCommand ?? runCommand;
  const sysfsPercent = await linuxGpuPercent();
  if (sysfsPercent !== null) return sysfsPercent;

  try {
    const result = await execute(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { timeoutMs: 1_500 },
    );
    return averagePercent(parsePercentLines(result.stdout));
  } catch {
    return null;
  }
}

/**
 * Keeps sampling state and probe caches in the backend. Concurrent command
 * calls share one snapshot, and a stale CPU baseline is refreshed over a
 * bounded interval before it is presented as current usage.
 */
export function createSystemUsageReader(
  dependencies: Partial<SystemUsageDependencies> = {},
): (diskPath: string) => Promise<SystemUsageSnapshot> {
  const cpus = dependencies.cpus ?? os.cpus;
  const totalMemory = dependencies.totalMemory ?? os.totalmem;
  const freeMemory = dependencies.freeMemory ?? os.freemem;
  const diskPercent = dependencies.diskPercent ?? readDiskPercent;
  const gpuPercent = dependencies.gpuPercent ?? readGpuPercent;
  const now = dependencies.now ?? Date.now;
  const delay =
    dependencies.delay ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let previousCpuTimes = cpuTimes(cpus());
  let previousCpuSampledAt = now();
  let lastCpuUsage: number | null = null;
  let pendingCpu: Promise<number> | null = null;
  let cachedGpu: { value: number | null; expiresAt: number } | null = null;
  let pendingGpu: Promise<number | null> | null = null;
  const pendingReads = new Map<string, Promise<SystemUsageSnapshot>>();

  const calculateCpu = async (): Promise<number> => {
    const sampleStartedAt = now();
    const baselineAge = sampleStartedAt - previousCpuSampledAt;
    if (lastCpuUsage === null || baselineAge > CPU_BASELINE_MAX_AGE_MS) {
      const freshBaseline = cpuTimes(cpus());
      await delay(CPU_FRESH_SAMPLE_MS);
      const current = cpuTimes(cpus());
      const usage = cpuPercent(freshBaseline, current);
      previousCpuTimes = current;
      previousCpuSampledAt = now();
      lastCpuUsage = usage;
      return usage;
    }

    if (baselineAge < CPU_MIN_INTERVAL_MS) return lastCpuUsage;

    const current = cpuTimes(cpus());
    const usage = cpuPercent(previousCpuTimes, current);
    previousCpuTimes = current;
    previousCpuSampledAt = sampleStartedAt;
    lastCpuUsage = usage;
    return usage;
  };

  const sampleCpu = (): Promise<number> => {
    if (pendingCpu) return pendingCpu;
    const sample = calculateCpu();
    pendingCpu = sample;
    const clearPending = () => {
      if (pendingCpu === sample) pendingCpu = null;
    };
    void sample.then(clearPending, clearPending);
    return sample;
  };

  const sampleGpu = (sampledAt: number): Promise<number | null> => {
    if (cachedGpu && cachedGpu.expiresAt > sampledAt) return Promise.resolve(cachedGpu.value);
    if (pendingGpu) return pendingGpu;

    pendingGpu = (async () => {
      try {
        const value = await gpuPercent();
        cachedGpu = {
          value,
          expiresAt: now() + (value === null ? GPU_UNAVAILABLE_CACHE_MS : GPU_AVAILABLE_CACHE_MS),
        };
        return value;
      } finally {
        pendingGpu = null;
      }
    })();
    return pendingGpu;
  };

  return (diskPath) => {
    const pending = pendingReads.get(diskPath);
    if (pending) return pending;

    const read = (async () => {
      const cpuUsage = await sampleCpu();
      const sampledAt = now();
      const total = totalMemory();
      const ramUsage = total > 0 ? clampPercent(((total - freeMemory()) / total) * 100) : 0;
      const [diskUsage, gpuUsage] = await Promise.all([
        diskPercent(diskPath),
        sampleGpu(sampledAt),
      ]);

      return {
        cpuPercent: cpuUsage,
        ramPercent: ramUsage,
        gpuPercent: gpuUsage,
        diskPercent: diskUsage,
        sampledAt: new Date(sampledAt).toISOString(),
      };
    })();
    pendingReads.set(diskPath, read);
    const clearPending = () => {
      if (pendingReads.get(diskPath) === read) pendingReads.delete(diskPath);
    };
    void read.then(clearPending, clearPending);
    return read;
  };
}
