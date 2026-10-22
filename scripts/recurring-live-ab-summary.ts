/**
 * Pure helpers for `recurring-live-ab.ts`: parsing `ps` CPU time, reducing
 * recurring-work samples to per-minute rates, and percentiles. Only counts
 * and durations pass through here; the metrics they read are content-free.
 */

/** Per kind, the counters a live sample keeps from `recurringWork.metrics`. */
export type KindCounters = {
  started: number;
  changed: number;
  failed: number;
  bytes: number;
  workUnits: Record<string, number>;
};

export type ProcessSample = { cpuMs: number; rssKiB: number };

export type LiveSample = {
  /** Milliseconds since the sampling window opened. */
  atMs: number;
  /** `null` when the metrics request failed. */
  kinds: Record<string, KindCounters> | null;
  processes: Partial<Record<"backend" | "electron", ProcessSample>>;
};

export type KindRates = {
  /** Actual interval during which this kind was observed. */
  observedMs: number;
  partial: boolean;
  startedPerMinute: number;
  changedPerMinute: number;
  failedPerMinute: number;
  bytesPerMinute: number;
  workUnitsPerMinute: Record<string, number>;
};

export type WindowSummary = {
  windowMs: number;
  samples: number;
  kinds: Record<string, KindRates>;
  processes: Partial<
    Record<
      "backend" | "electron",
      { cpuMsPerMinute: number; rssKiBMedian: number; rssKiBMax: number }
    >
  >;
};

/**
 * `ps -o time=` CPU time: `[[DD-]HH:]MM:SS[.ss]` on Linux and macOS
 * (macOS prints `M:SS.ss`). Returns milliseconds, or `null` when unparseable.
 */
export function parsePsCpuTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds);
  return Number.isFinite(total) ? Math.round(total * 1_000) : null;
}

export type PsRow = { pid: number; ppid: number; rssKiB: number; cpuMs: number };

/** Rows of `ps -A -o pid=,ppid=,rss=,time=`; unparseable lines are skipped. */
export function parsePsRows(output: string): PsRow[] {
  return output.split("\n").flatMap((line) => {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/);
    const cpuMs = time ? parsePsCpuTime(time) : null;
    const row = { pid: Number(pid), ppid: Number(ppid), rssKiB: Number(rss), cpuMs };
    return cpuMs !== null && [row.pid, row.ppid, row.rssKiB].every(Number.isFinite)
      ? [{ ...row, cpuMs }]
      : [];
  });
}

/**
 * CPU time and RSS of `root`, plus every descendant when `tree` is set;
 * `null` when `root` is not running. Summed RSS double-counts shared pages,
 * so it is an upper bound for a tree.
 */
export function processTreeTotals(
  rows: readonly PsRow[],
  root: number,
  tree: boolean,
): ProcessSample | null {
  if (!rows.some((row) => row.pid === root)) return null;
  const members = new Set([root]);
  for (let grew = tree; grew;) {
    grew = false;
    for (const row of rows) {
      if (!members.has(row.pid) && members.has(row.ppid)) {
        members.add(row.pid);
        grew = true;
      }
    }
  }
  let cpuMs = 0;
  let rssKiB = 0;
  for (const row of rows) {
    if (!members.has(row.pid)) continue;
    cpuMs += row.cpuMs;
    rssKiB += row.rssKiB;
  }
  return { cpuMs, rssKiB };
}

/** Keeps only the counters the summary uses from one recorder snapshot. */
export function pickKindCounters(kinds: unknown): Record<string, KindCounters> {
  const picked: Record<string, KindCounters> = {};
  if (!kinds || typeof kinds !== "object") return picked;
  for (const [kind, raw] of Object.entries(kinds as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const number = (field: string) =>
      typeof entry[field] === "number" && Number.isFinite(entry[field])
        ? (entry[field] as number)
        : 0;
    const units: Record<string, number> = {};
    if (entry.workUnits && typeof entry.workUnits === "object") {
      for (const [unit, count] of Object.entries(entry.workUnits as Record<string, unknown>)) {
        if (typeof count === "number" && Number.isFinite(count)) units[unit] = count;
      }
    }
    picked[kind] = {
      started: number("started"),
      changed: number("changed"),
      failed: number("failed"),
      bytes: number("bytes"),
      workUnits: units,
    };
  }
  return picked;
}

/** Nearest-rank percentile; `null` for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

const perMinute = (delta: number, windowMs: number) =>
  windowMs > 0 ? Math.round((delta / windowMs) * 60_000 * 100) / 100 : 0;

/**
 * Per-kind rates use its first and last observed counters, marking shortened
 * intervals partial. A disappearance inside that interval or a counter decrease
 * invalidates its rate (`NaN`). Processes use the first and last `ps` readings.
 */
export function summarizeWindow(samples: readonly LiveSample[]): WindowSummary {
  const withMetrics = samples.filter((sample) => sample.kinds !== null);
  const first = withMetrics[0];
  const last = withMetrics.at(-1);
  const windowMs = first && last ? last.atMs - first.atMs : 0;
  const kinds: Record<string, KindRates> = {};
  if (first && last && windowMs > 0) {
    const observedKinds = new Set(withMetrics.flatMap((sample) => Object.keys(sample.kinds!)));
    for (const kind of observedKinds) {
      const readings = withMetrics.filter((sample) => sample.kinds![kind] !== undefined);
      const head = readings[0]!;
      const tail = readings.at(-1)!;
      const observedMs = tail.atMs - head.atMs;
      const partial = head !== first || tail !== last || readings.length !== withMetrics.length;
      // A disappearance is evidence of reset. Do not bridge that gap or hide
      // a reset whose counters have already caught up by the final sample.
      const invalid =
        observedMs <= 0 ||
        withMetrics.some(
          (sample) => sample.atMs >= head.atMs && sample.atMs <= tail.atMs && !sample.kinds![kind],
        );
      const rate = (values: number[]) => {
        if (invalid || values.some((value, index) => index > 0 && value < values[index - 1]!))
          return Number.NaN;
        return perMinute(values.at(-1)! - values[0]!, observedMs);
      };
      const delta = (field: "started" | "changed" | "failed" | "bytes") =>
        rate(readings.map((sample) => sample.kinds![kind]![field]));
      const units: Record<string, number> = {};
      for (const unit of new Set(
        readings.flatMap((sample) => Object.keys(sample.kinds![kind]!.workUnits)),
      )) {
        const value = rate(readings.map((sample) => sample.kinds![kind]!.workUnits[unit] ?? 0));
        if (value !== 0) units[unit] = value;
      }
      const rates: KindRates = {
        observedMs,
        partial,
        startedPerMinute: delta("started"),
        changedPerMinute: delta("changed"),
        failedPerMinute: delta("failed"),
        bytesPerMinute: delta("bytes"),
        workUnitsPerMinute: units,
      };
      if (
        partial ||
        rates.startedPerMinute !== 0 ||
        rates.changedPerMinute !== 0 ||
        rates.failedPerMinute !== 0 ||
        rates.bytesPerMinute !== 0 ||
        Object.keys(units).length > 0
      )
        kinds[kind] = rates;
    }
  }

  const processes: WindowSummary["processes"] = {};
  for (const name of ["backend", "electron"] as const) {
    const readings = samples.flatMap((sample) =>
      sample.processes[name] ? [{ atMs: sample.atMs, ...sample.processes[name]! }] : [],
    );
    const head = readings[0];
    const tail = readings.at(-1);
    if (!head || !tail || tail.atMs <= head.atMs) continue;
    const rss = readings.map((reading) => reading.rssKiB);
    processes[name] = {
      cpuMsPerMinute: perMinute(tail.cpuMs - head.cpuMs, tail.atMs - head.atMs),
      rssKiBMedian: percentile(rss, 50)!,
      rssKiBMax: Math.max(...rss),
    };
  }
  return { windowMs, samples: samples.length, kinds, processes };
}
