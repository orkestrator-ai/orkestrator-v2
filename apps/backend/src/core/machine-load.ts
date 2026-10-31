import { promises as fs } from "node:fs";
import os from "node:os";
import type { CpuInfo } from "node:os";
import {
  MACHINE_LOAD_WINDOWS,
  type MachineLoadReport,
  type MachineLoadWindow,
  type MachineOsFamily,
} from "@orkestrator/protocol/machine-load";
import { BackendActivityJobs } from "./backend-activity-jobs.js";
import type { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import type { RecurringTimerFactory } from "./recurring-scheduler.js";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { runCommand } from "./shell.js";
import { cpuPercent, cpuTimes, hostRamReader, type CachedRamReader } from "./system-usage.js";

/**
 * Each backend's rolling record of its own machine, for coordinators choosing
 * where to put work (`get_machine_load`, shown by `list_nodes`).
 *
 * CPU is the change in `os.cpus()` between readings, so each sample is the true
 * average of the time since the last one and sampling faster would not improve
 * it. RAM is a point reading from the cached reader the title bar uses. The
 * usage snapshot itself is not used here: its stale-baseline rule would reduce
 * CPU to a 200 ms point sample, and it runs GPU and disk probes this discards.
 *
 * History is in memory and starts empty on each start. Every average says how
 * much of its window it covers, so a 24-hour figure built from ten minutes
 * reads as ten minutes.
 */

export const MACHINE_LOAD_SAMPLE_MS = 60_000;
/** A first reading soon after start, so a restarted machine does not read as unknown for long. */
export const MACHINE_LOAD_FIRST_SAMPLE_MS = 15_000;
/** Longer than this between readings is a sleeping or stalled host, and counts as no history. */
export const MACHINE_LOAD_MAX_SAMPLE_GAP_MS = 3 * MACHINE_LOAD_SAMPLE_MS;
export const MACHINE_LOAD_FINE_BUCKET_MS = 60_000;
export const MACHINE_LOAD_COARSE_BUCKET_MS = 15 * 60_000;

const WINDOW_LENGTHS_MS = MACHINE_LOAD_WINDOWS.map(({ seconds }) => seconds * 1_000);
const LONGEST_WINDOW_MS = Math.max(...WINDOW_LENGTHS_MS);
/** Every shorter window reads minute buckets; only the longest reaches the coarse ones. */
const FINE_RETENTION_MS = Math.max(
  ...WINDOW_LENGTHS_MS.filter((length) => length < LONGEST_WINDOW_MS),
);

export interface MachineLoadSample {
  startMs: number;
  endMs: number;
  cpuPercent: number;
  ramPercent: number;
}

interface LoadBucket {
  key: number;
  startMs: number;
  endMs: number;
  coveredMs: number;
  /** Percent times milliseconds, so buckets merge and average by the time they cover. */
  cpuWeighted: number;
  ramWeighted: number;
}

function addToBuckets(buckets: LoadBucket[], key: number, part: Omit<LoadBucket, "key">): void {
  const last = buckets.at(-1);
  if (last?.key === key) {
    last.startMs = Math.min(last.startMs, part.startMs);
    last.endMs = Math.max(last.endMs, part.endMs);
    last.coveredMs += part.coveredMs;
    last.cpuWeighted += part.cpuWeighted;
    last.ramWeighted += part.ramWeighted;
  } else {
    buckets.push({ key, ...part });
  }
}

function roundPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/**
 * The bounded history: a bucket a minute for every window but the longest, and
 * one every 15 minutes for the longest. For 5 minutes, 1 hour and 24 hours that
 * is at most about 60 and 96 buckets however often samples arrive.
 */
export class MachineLoadHistory {
  private fine: LoadBucket[] = [];
  private coarse: LoadBucket[] = [];

  record(sample: MachineLoadSample): void {
    const coveredMs = sample.endMs - sample.startMs;
    addToBuckets(this.fine, Math.floor(sample.endMs / MACHINE_LOAD_FINE_BUCKET_MS), {
      startMs: sample.startMs,
      endMs: sample.endMs,
      coveredMs,
      cpuWeighted: sample.cpuPercent * coveredMs,
      ramWeighted: sample.ramPercent * coveredMs,
    });
    while (this.fine[0] && this.fine[0].endMs <= sample.endMs - FINE_RETENTION_MS) {
      const { key: _fineKey, ...minute } = this.fine.shift()!;
      addToBuckets(this.coarse, Math.floor(minute.endMs / MACHINE_LOAD_COARSE_BUCKET_MS), minute);
    }
    while (this.coarse[0] && this.coarse[0].endMs <= sample.endMs - LONGEST_WINDOW_MS) {
      this.coarse.shift();
    }
  }

  /** The wall clock moved back: readings now dated in the future can never age out correctly. */
  dropAfter(timeMs: number): void {
    this.fine = this.fine.filter((bucket) => bucket.endMs <= timeMs);
    this.coarse = this.coarse.filter((bucket) => bucket.endMs <= timeMs);
  }

  bucketCount(): number {
    return this.fine.length + this.coarse.length;
  }

  windows(nowMs: number): MachineLoadWindow[] {
    return MACHINE_LOAD_WINDOWS.map(({ window, seconds }) => {
      const startMs = nowMs - seconds * 1_000;
      let coveredMs = 0;
      let cpuWeighted = 0;
      let ramWeighted = 0;
      for (const bucket of [...this.coarse, ...this.fine]) {
        const overlapMs = Math.min(bucket.endMs, nowMs) - Math.max(bucket.startMs, startMs);
        if (overlapMs <= 0) continue;
        const share = overlapMs / Math.max(1, bucket.endMs - bucket.startMs);
        coveredMs += bucket.coveredMs * share;
        cpuWeighted += bucket.cpuWeighted * share;
        ramWeighted += bucket.ramWeighted * share;
      }
      const covered = coveredMs > 0;
      return {
        window,
        windowSeconds: seconds,
        coveredSeconds: Math.min(seconds, Math.round(coveredMs / 1_000)),
        cpuPercent: covered ? roundPercent(cpuWeighted / coveredMs) : null,
        ramPercent: covered ? roundPercent(ramWeighted / coveredMs) : null,
      };
    });
  }
}

export function machineOsFamily(platform: NodeJS.Platform): MachineOsFamily {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "other";
}

function osFallback(platform: NodeJS.Platform, release: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return `Linux ${release}`;
  if (platform === "win32") return `Windows ${release}`;
  return `${platform} ${release}`;
}

/** `PRETTY_NAME` from os-release, else `NAME` and `VERSION_ID`. */
export function parseOsRelease(text: string): string | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([A-Z_]+)=(.*)$/);
    if (match) fields.set(match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, "$2").trim());
  }
  const pretty = fields.get("PRETTY_NAME");
  if (pretty) return pretty;
  const name = fields.get("NAME");
  if (!name) return null;
  const version = fields.get("VERSION_ID");
  return version ? `${name} ${version}` : name;
}

export interface OsDescriptionDependencies {
  platform: NodeJS.Platform;
  release: () => string;
  version: () => string;
  readFile: (path: string) => Promise<string>;
  runCommand: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string }>;
}

/** The readable name, or null when it could not be read this time. It never throws. */
export async function describeOs(
  dependencies: Partial<OsDescriptionDependencies> = {},
): Promise<string | null> {
  const platform = dependencies.platform ?? process.platform;
  const execute = dependencies.runCommand ?? runCommand;
  const readFile = dependencies.readFile ?? ((path: string) => fs.readFile(path, "utf8"));
  try {
    if (platform === "darwin") {
      const { stdout } = await execute("sw_vers", ["-productVersion"], { timeoutMs: 1_500 });
      const version = stdout.trim();
      return /^[0-9][0-9.]*$/.test(version) ? `macOS ${version}` : null;
    }
    if (platform === "linux") {
      for (const path of ["/etc/os-release", "/usr/lib/os-release"]) {
        const name = await readFile(path).then(parseOsRelease, () => null);
        if (name) return name;
      }
      return null;
    }
    if (platform === "win32") return (dependencies.version ?? os.version)().trim() || null;
    return `${platform} ${(dependencies.release ?? os.release)()}`;
  } catch {
    return null;
  }
}

export interface MachineLoadSamplerOptions extends Partial<OsDescriptionDependencies> {
  /** Wall clock: windows are real elapsed time, so a sleeping host shows up as a gap. */
  now?: () => number;
  cpus?: () => CpuInfo[];
  arch?: () => string;
  totalMemory?: () => number;
  readRam?: CachedRamReader;
  metrics?: RecurringWorkMetrics;
  /** The scheduler's own clock and timers (real ones are unref'd). */
  schedulerNow?: () => number;
  timers?: RecurringTimerFactory;
  diagnostics?: RecurringDiagnosticsRegistry | null;
  onError?: (error: unknown) => void;
}

export class MachineLoadSampler {
  private readonly history = new MachineLoadHistory();
  private readonly now: () => number;
  private readonly cpus: () => CpuInfo[];
  private readonly arch: () => string;
  private readonly totalMemory: () => number;
  private readonly readRam: CachedRamReader;
  private readonly metrics: RecurringWorkMetrics;
  private readonly platform: NodeJS.Platform;
  private jobs: BackendActivityJobs | null = null;
  private baseline: { at: number; times: ReturnType<typeof cpuTimes> } | null = null;
  private latestSampleAt: number | null = null;
  private osName: string | null = null;

  constructor(private readonly options: MachineLoadSamplerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cpus = options.cpus ?? os.cpus;
    this.arch = options.arch ?? os.arch;
    this.totalMemory = options.totalMemory ?? os.totalmem;
    this.readRam = options.readRam ?? hostRamReader;
    this.metrics = options.metrics ?? recurringWorkMetrics;
    this.platform = options.platform ?? process.platform;
  }

  start(): void {
    if (this.jobs) return;
    this.baseline = { at: this.now(), times: cpuTimes(this.cpus()) };
    void this.resolveOsName();
    this.jobs = new BackendActivityJobs(
      [
        {
          name: "machine-load-sample",
          kind: "machine-load-sample",
          priority: "discovery",
          intervalMs: MACHINE_LOAD_SAMPLE_MS,
          initialDelayMs: MACHINE_LOAD_FIRST_SAMPLE_MS,
          fixedRate: true,
          run: async () => {
            this.metrics.requested("machine-load-sample");
            await this.metrics.observe("machine-load-sample", () => this.sample());
          },
          onError: (error) => {
            if (this.options.onError) this.options.onError(error);
            else console.warn("[backend] Failed to sample machine load:", error);
          },
        },
      ],
      {
        ...(this.options.schedulerNow ? { now: this.options.schedulerNow } : {}),
        ...(this.options.timers ? { timers: this.options.timers } : {}),
        ...(this.options.diagnostics !== undefined
          ? { diagnostics: this.options.diagnostics }
          : {}),
      },
    );
    this.jobs.start();
  }

  stop(): void {
    this.jobs?.stop();
    this.jobs = null;
    this.baseline = null;
  }

  /** One reading. Public so a test can drive it with a fake clock. */
  async sample(): Promise<void> {
    await this.resolveOsName();
    const ramPercent = await this.readRam(this.now());
    const at = this.now();
    const times = cpuTimes(this.cpus());
    const previous = this.baseline;
    this.baseline = { at, times };
    if (!previous) return;
    const elapsedMs = at - previous.at;
    if (elapsedMs <= 0) {
      this.history.dropAfter(at);
      this.latestSampleAt = null;
      return;
    }
    if (elapsedMs > MACHINE_LOAD_MAX_SAMPLE_GAP_MS) return;
    this.history.record({
      startMs: previous.at,
      endMs: at,
      cpuPercent: cpuPercent(previous.times, times),
      ramPercent,
    });
    this.latestSampleAt = at;
  }

  /** No I/O, so a coordinator's `list_nodes` never waits on a probe. */
  report(): MachineLoadReport {
    const now = this.now();
    // Windows end at the newest reading while sampling is on schedule, so a
    // steady machine reads as fully covered between readings. Once readings
    // stop they end now, and the history ages out of them.
    const onSchedule =
      this.latestSampleAt !== null && now - this.latestSampleAt <= MACHINE_LOAD_MAX_SAMPLE_GAP_MS;
    return {
      osFamily: machineOsFamily(this.platform),
      os: this.osName ?? osFallback(this.platform, (this.options.release ?? os.release)()),
      arch: this.arch(),
      cpuCores: this.cpus().length,
      totalRamGb: Math.round((this.totalMemory() / 2 ** 30) * 10) / 10,
      latestSampleAgeSeconds:
        this.latestSampleAt === null
          ? null
          : Math.max(0, Math.round((now - this.latestSampleAt) / 1_000)),
      load: this.history.windows(onSchedule ? this.latestSampleAt! : now),
    };
  }

  /** Read until it succeeds once: the OS does not change while a backend runs. */
  private async resolveOsName(): Promise<void> {
    if (this.osName) return;
    this.osName = await describeOs(this.options);
  }
}
