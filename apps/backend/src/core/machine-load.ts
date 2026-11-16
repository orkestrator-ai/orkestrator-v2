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
import {
  measuredCpuPercent,
  cpuTimes,
  hostRamReader,
  type CachedRamReader,
} from "./system-usage.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  decodeMachineLoadHistory,
  encodeMachineLoadHistory,
  type MachineLoadHistoryDocument,
  type MachineLoadHistoryLimits,
  type MachineLoadHistoryParts,
} from "./machine-load-history-document.js";

const log = createLogger("host");

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
 * History lives in memory. With a history store (the backend passes its
 * database document, `storage-machine-load-history.ts`) it is restored at
 * start, written whenever a 15-minute period has passed since the last write,
 * and written once more at stop, so a restart or update costs at most the
 * newest 15 minutes after a crash and nothing after a clean stop. The time the
 * backend was down holds no buckets, so it reads as no history. Every average
 * says how much of its window it covers, so a 24-hour figure built from ten
 * minutes reads as ten minutes.
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

/** What a stored document may hold: the steady-state bucket counts with a little room. */
export const MACHINE_LOAD_HISTORY_LIMITS: MachineLoadHistoryLimits = {
  fineBucketMs: MACHINE_LOAD_FINE_BUCKET_MS,
  coarseBucketMs: MACHINE_LOAD_COARSE_BUCKET_MS,
  maxSampleGapMs: MACHINE_LOAD_MAX_SAMPLE_GAP_MS,
  maxFineBuckets: Math.ceil(FINE_RETENTION_MS / MACHINE_LOAD_FINE_BUCKET_MS) + 4,
  maxCoarseBuckets: Math.ceil(LONGEST_WINDOW_MS / MACHINE_LOAD_COARSE_BUCKET_MS) + 4,
};

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

function periodOf(timeMs: number): number {
  return Math.floor(timeMs / MACHINE_LOAD_COARSE_BUCKET_MS);
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
    this.ageOut(sample.endMs);
  }

  /** Moves minutes past the shorter windows into coarse buckets and drops what left the longest. */
  private ageOut(nowMs: number): void {
    while (this.fine[0] && this.fine[0].endMs <= nowMs - FINE_RETENTION_MS) {
      const { key: _fineKey, ...minute } = this.fine.shift()!;
      addToBuckets(this.coarse, Math.floor(minute.endMs / MACHINE_LOAD_COARSE_BUCKET_MS), minute);
    }
    while (this.coarse[0] && this.coarse[0].endMs <= nowMs - LONGEST_WINDOW_MS) {
      this.coarse.shift();
    }
  }

  /**
   * The wall clock moved back: readings now dated in the future can never age
   * out correctly. Returns whether anything was dropped.
   */
  dropAfter(timeMs: number): boolean {
    const before = this.bucketCount();
    this.fine = this.fine.filter((bucket) => bucket.endMs <= timeMs);
    this.coarse = this.coarse.filter((bucket) => bucket.endMs <= timeMs);
    return this.bucketCount() !== before;
  }

  /** A copy of the buckets without their keys, for the history store. */
  parts(): MachineLoadHistoryParts {
    const strip = ({ key: _key, ...bucket }: LoadBucket) => bucket;
    return { fine: this.fine.map(strip), coarse: this.coarse.map(strip) };
  }

  /**
   * History from validated stored buckets, as of `nowMs`: buckets dated after
   * it are dropped (the clock moved back while the backend was down) and the
   * rest age as if the readings had just been recorded.
   */
  static restore(parts: MachineLoadHistoryParts, nowMs: number): MachineLoadHistory {
    const history = new MachineLoadHistory();
    history.fine = parts.fine.map((bucket) => ({
      key: Math.floor(bucket.endMs / MACHINE_LOAD_FINE_BUCKET_MS),
      ...bucket,
    }));
    history.coarse = parts.coarse.map((bucket) => ({
      key: Math.floor(bucket.endMs / MACHINE_LOAD_COARSE_BUCKET_MS),
      ...bucket,
    }));
    history.dropAfter(nowMs);
    history.ageOut(nowMs);
    return history;
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

/**
 * `PRETTY_NAME` from os-release, else `NAME`. `VERSION_ID` is added when the
 * name carries no number of its own, and `ID_LIKE` names the distributions a
 * derivative follows: Omarchy's whole `PRETTY_NAME` is `Omarchy`, which reads
 * here as `Omarchy 4.0.6 (like arch)`.
 */
export function parseOsRelease(text: string): string | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([A-Z_]+)=(.*)$/);
    if (match) fields.set(match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, "$2").trim());
  }
  const name = fields.get("PRETTY_NAME") || fields.get("NAME");
  if (!name) return null;
  const version = fields.get("VERSION_ID");
  const versioned = version && !/[0-9]/.test(name) ? `${name} ${version}` : name;
  const like = (fields.get("ID_LIKE") ?? "").split(/\s+/).filter((id) => /^[a-z0-9._-]+$/.test(id));
  return like.length > 0 ? `${versioned} (like ${like.join(", ")})` : versioned;
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

/**
 * Where history survives a restart. Both calls are synchronous (one database
 * row), and either may throw; the sampler logs and carries on in memory.
 */
export interface MachineLoadHistoryStore {
  /** The stored document, or `undefined` when none was ever written. */
  load(): unknown;
  save(document: MachineLoadHistoryDocument): void;
}

export interface MachineLoadSamplerOptions extends Partial<OsDescriptionDependencies> {
  /** Persists history across restarts; without one it starts empty each time. */
  historyStore?: MachineLoadHistoryStore;
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
  private history = new MachineLoadHistory();
  private readonly now: () => number;
  private readonly cpus: () => CpuInfo[];
  private readonly arch: () => string;
  private readonly totalMemory: () => number;
  private readonly readRam: CachedRamReader;
  private readonly metrics: RecurringWorkMetrics;
  private readonly platform: NodeJS.Platform;
  private jobs: BackendActivityJobs | null = null;
  private baseline: { at: number; times: ReturnType<typeof cpuTimes>; cores: number } | null = null;
  private latestSampleAt: number | null = null;
  private osName: string | null = null;
  /** Whether the history store has been read; it is read once, at the first start. */
  private restored = false;
  /** History changed since it was last written. */
  private unsaved = false;
  /** The 15-minute period of the last write (or of the restore), so writes stay one a period. */
  private savedPeriod: number | null = null;

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
    this.restoreHistory();
    const cpus = this.cpus();
    this.baseline = { at: this.now(), times: cpuTimes(cpus), cores: cpus.length };
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
            else log.warn("load.sample-failed", { error: formatLogError(error) });
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

  /** Stops sampling and writes any history not yet written (the shutdown write). */
  stop(): void {
    this.jobs?.stop();
    this.jobs = null;
    this.baseline = null;
    if (this.unsaved) this.saveHistory();
  }

  /** One reading. Public so a test can drive it with a fake clock. */
  async sample(): Promise<void> {
    await this.resolveOsName();
    const ramPercent = await this.readRam(this.now());
    const at = this.now();
    const cpus = this.cpus();
    const times = cpuTimes(cpus);
    const previous = this.baseline;
    this.baseline = { at, times, cores: cpus.length };
    if (!previous) return;
    const elapsedMs = at - previous.at;
    if (elapsedMs <= 0) {
      if (this.history.dropAfter(at)) this.unsaved = true;
      this.latestSampleAt = null;
      return;
    }
    if (elapsedMs > MACHINE_LOAD_MAX_SAMPLE_GAP_MS) return;
    // Empty CPU lists and core-count changes cannot provide matching counters.
    if (cpus.length === 0 || previous.cores !== cpus.length) return;
    const cpu = measuredCpuPercent(previous.times, times);
    // Both averages share coverage; an unmeasurable CPU interval covers neither.
    if (cpu === null) return;
    this.history.record({
      startMs: previous.at,
      endMs: at,
      cpuPercent: cpu,
      ramPercent,
    });
    this.latestSampleAt = at;
    this.unsaved = true;
    if (this.savedPeriod !== null && periodOf(at) !== this.savedPeriod) this.saveHistory();
  }

  /** No I/O, so a coordinator's `list_nodes` never waits on a probe. */
  report(): MachineLoadReport {
    const now = this.now();
    if (
      (this.baseline && this.baseline.at > now) ||
      (this.latestSampleAt !== null && this.latestSampleAt > now)
    ) {
      if (this.history.dropAfter(now)) this.unsaved = true;
      this.baseline = null;
      this.latestSampleAt = null;
    }
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

  /** Reads the stored history once. A missing or unusable document starts empty, with a log line. */
  private restoreHistory(): void {
    const store = this.options.historyStore;
    if (!store || this.restored) return;
    this.restored = true;
    const now = this.now();
    this.savedPeriod = periodOf(now);
    let stored: unknown;
    try {
      stored = store.load();
    } catch (error) {
      log.warn("load.history-fresh", { reason: "unreadable", error: formatLogError(error) });
      this.unsaved = true;
      return;
    }
    if (stored === undefined || stored === null) {
      log.info("load.history-fresh", { reason: "missing" });
      return;
    }
    const decoded = decodeMachineLoadHistory(stored, MACHINE_LOAD_HISTORY_LIMITS);
    if (!decoded.ok) {
      log.warn("load.history-fresh", { reason: decoded.reason });
      // Replace it at the next write, even if nothing is sampled before stop.
      this.unsaved = true;
      return;
    }
    this.history = MachineLoadHistory.restore(decoded, now);
    if (this.history.bucketCount() !== decoded.fine.length + decoded.coarse.length) {
      this.unsaved = true;
    }
    const longest = this.history.windows(now).at(-1);
    log.info("load.history-restored", {
      buckets: this.history.bucketCount(),
      coveredSeconds: longest?.coveredSeconds ?? 0,
    });
  }

  /** One row write. A failure is logged and retried at the next period or at stop. */
  private saveHistory(): void {
    const store = this.options.historyStore;
    if (!store || !this.restored) return;
    this.savedPeriod = periodOf(this.now());
    try {
      store.save(encodeMachineLoadHistory(this.history.parts()));
      this.unsaved = false;
    } catch (error) {
      log.warn("load.history-save-failed", { error: formatLogError(error) });
    }
  }

  /** Read until it succeeds once: the OS does not change while a backend runs. */
  private async resolveOsName(): Promise<void> {
    if (this.osName) return;
    this.osName = await describeOs(this.options);
  }
}
