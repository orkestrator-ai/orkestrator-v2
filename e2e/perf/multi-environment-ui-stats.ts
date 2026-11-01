/**
 * Pure summaries for `multi-environment-ui-perf.ts`: no browser, Docker or
 * file access, so the arithmetic is unit-tested on its own.
 */

export interface Distribution {
  count: number;
  /** Samples that never reached their signal before the deadline. */
  missed: number;
  min: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
}

/** Nearest-rank percentile of already sorted values; null when there are none. */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10) / 10;

/** `null` samples are counted as missed, never as zero. */
export function distribution(samples: ReadonlyArray<number | null>): Distribution {
  const values = samples
    .filter((sample): sample is number => sample !== null && Number.isFinite(sample))
    .sort((left, right) => left - right);
  return {
    count: values.length,
    missed: samples.length - values.length,
    min: round(values[0] ?? null),
    median: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(values.at(-1) ?? null),
  };
}

export interface FrameSummary {
  frames: number;
  /** Intervals between animation frames, in milliseconds. */
  interval: Distribution;
  /** Intervals longer than 50 ms: a visible stall. */
  over50ms: number;
  /** Frames per second over the window. */
  fps: number | null;
}

/** Animation-frame timestamps (performance.now()) to interval statistics. */
export function frameSummary(timestamps: readonly number[]): FrameSummary {
  const intervals: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    intervals.push(timestamps[index]! - timestamps[index - 1]!);
  }
  const span = timestamps.length > 1 ? timestamps.at(-1)! - timestamps[0]! : 0;
  return {
    frames: timestamps.length,
    interval: distribution(intervals),
    over50ms: intervals.filter((interval) => interval > 50).length,
    fps: span > 0 ? Math.round(((timestamps.length - 1) / span) * 10_000) / 10 : null,
  };
}

export interface LongTaskSummary {
  count: number;
  totalMs: number;
  maxMs: number | null;
}

export function longTaskSummary(durations: readonly number[]): LongTaskSummary {
  return {
    count: durations.length,
    totalMs: Math.round(durations.reduce((sum, duration) => sum + duration, 0)),
    maxMs: durations.length > 0 ? Math.round(Math.max(...durations)) : null,
  };
}

/** Cumulative counters from the first line of Linux `/proc/stat`. */
export interface CpuCounters {
  busy: number;
  total: number;
}

/** Parses the aggregate `cpu` line of `/proc/stat`; null when it is not there. */
export function parseProcStat(text: string): CpuCounters | null {
  const line = text.split("\n").find((entry) => /^cpu\s/.test(entry));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((field) => !Number.isFinite(field))) return null;
  // user nice system idle iowait irq softirq steal (guest time is already in user).
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    fields;
  const idleAll = idle + iowait;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idleAll };
}

/** Host CPU use between two `/proc/stat` readings, as a percentage of all CPUs. */
export function cpuBusyPercent(
  before: CpuCounters | null,
  after: CpuCounters | null,
): number | null {
  if (!before || !after) return null;
  const total = after.total - before.total;
  if (total <= 0) return null;
  return Math.round(((after.busy - before.busy) / total) * 1000) / 10;
}

/** `docker stats` CPU column (`"187.53%"`) to a number; null when it is not a percentage. */
export function parseCpuPercent(value: string): number | null {
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)%\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

/** The ratio of two medians, for the busy-against-idle comparison; null when either is unknown. */
export function medianRatio(busy: Distribution, idle: Distribution): number | null {
  if (busy.median === null || idle.median === null || idle.median <= 0) return null;
  return Math.round((busy.median / idle.median) * 100) / 100;
}
