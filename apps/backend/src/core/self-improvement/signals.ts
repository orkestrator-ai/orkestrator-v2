/**
 * Turns one diagnostics bundle into ranked, content-free signals. Each signal
 * has a stable signature, so the same problem is recognised across bundles, a
 * measure the ledger compares before and after a fix, and the same figures split
 * by the app version that was running, so a fix can be judged on the versions
 * that carry it.
 *
 * Pure: no I/O. Thresholds are starting points, exported so tests and the guide
 * name them; change them here when the loop proves one too noisy or too quiet.
 */
import type { BundleData, EssentialEntry, FieldValue, HealthRow } from "./bundle.js";

export type SignalCategory =
  | "crash"
  | "data"
  | "error"
  | "fault"
  | "performance"
  | "resource"
  | "warning"
  /** A theme a model found across conversations (`insights/analyze.ts`). */
  | "insight";

export type SignalSource = "essential-log" | "health-summary" | "database" | "insights";

/** `rate`: occurrences per day, summed across versions. `gauge`: the worst value seen. */
export type MeasureKind = "rate" | "gauge";

export interface VersionSlice {
  count: number;
  /** For a gauge: the worst value under this version. */
  value?: number;
}

export interface Signal {
  signature: string;
  category: SignalCategory;
  source: SignalSource;
  title: string;
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Distinct UTC days with at least one occurrence. */
  activeDays: number;
  measure: { kind: MeasureKind; unit: string; value: number };
  versions: Record<string, VersionSlice>;
  evidence: Record<string, string | number | boolean>;
  score: number;
}

export interface DigestWindow {
  from: string | null;
  to: string | null;
  days: number;
}

/**
 * Hours each source observed under each app version. A signal that is absent
 * under a version was still watched for these hours, which is what lets a fix be
 * judged by zero occurrences. The essential log counts wall time between
 * backend starts; the health rows count backend uptime; database counters cover
 * only the exporting backend's run.
 */
export type ObservedHours = Record<SignalSource, Record<string, number>>;

export interface ExtractedSignals {
  window: DigestWindow;
  signals: Signal[];
  observedHours: ObservedHours;
}

export const CATEGORY_WEIGHT: Readonly<Record<SignalCategory, number>> = {
  crash: 100,
  data: 90,
  error: 40,
  fault: 30,
  performance: 20,
  resource: 15,
  warning: 8,
  insight: 30,
};

export const THRESHOLDS = {
  /** RSS growth inside one backend run worth reporting, in MiB per hour… */
  rssGrowthMiBPerHour: 20,
  /** …once the run grew at least this much and ran this long. */
  rssGrowthMinMiB: 256,
  rssGrowthMinHours: 2,
  /** Peak backend RSS worth reporting on its own. */
  rssPeakMiB: 1536,
  /** Average backend CPU, as a percentage of one core, worth reporting. */
  cpuPercent: 25,
  /** A recurring job kind's busy time per hour of uptime worth reporting. */
  jobBusyMsPerHour: 5 * 60 * 1000,
  /** A slow SQLite series worth reporting: this many, or one this slow. */
  slowSeriesCount: 3,
  slowSeriesMaxMs: 1000,
  leaseWaitMaxMs: 2000,
  walMiB: 512,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIB = 1024 * 1024;
/** The exporting backend's last row is this recent when it is still running. */
const LIVE_RUN_WINDOW_MS = 15 * 60 * 1000;
export const UNKNOWN_VERSION = "unknown";

/** Events another source reports better, or that describe the log itself. */
const SKIPPED_EVENTS = new Set([
  "backend:previous-run",
  "logging:essential.started",
  "logging:essential.stopped",
]);

const CRASH_EVENTS = new Set([
  "desktop:backend.exited",
  "desktop:backend.start-failed",
  "desktop:uncaught-exception",
  "runtime:uncaught-exception",
  "runtime:rejection.unhandled",
]);
const DATA_EVENTS = new Set(["storage:migration.failed", "storage:snapshot.integrity-failed"]);
const PERFORMANCE_EVENTS = new Set([
  "runtime:stalled",
  "desktop:main-thread.stalled",
  "storage:operation.slow",
]);
/**
 * Logged at `warn` but costing the user work: an agent bridge that died
 * unasked, a lost writer lease (schedules and container changes stop), and a
 * conversation that could not be resumed. Ranked as errors.
 */
const ERROR_GRADE_EVENTS = new Set(["local-server:bridge.exited", "docker:writer-lease.lost"]);
const ERROR_GRADE_EVENT_NAMES = new Set(["session.resume-fell-back"]);
const THROTTLE_EVENTS = new Set(["throttle.suppressed", "throttle.recovered", "throttle.evicted"]);

/** Fields that name what kind of failure this was, in order of preference. */
const QUALIFIER_FIELDS = [
  "kind",
  "reason",
  "error.code",
  "error.name",
  "signal",
  "outcome",
  "origin",
];
/** Numeric fields worth keeping as the worst value seen. */
const EVIDENCE_MAX_FIELDS = [
  "lagMs",
  "durationMs",
  "faultSeconds",
  "ranForMs",
  "staleForMs",
  "exitCode",
  "error.exitCode",
];

function label(value: FieldValue | undefined): string | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const text = String(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 48);
  return text === "" || text === "-" ? null : text;
}

/** The provider part of a `provider:id` label, so per-environment ids do not split a signature. */
function providerOf(value: FieldValue | undefined): string | null {
  return typeof value === "string" ? label(value.split(":")[0]) : null;
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = "", pre = ""] = value.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === "") return 1;
  if (b.pre === "") return -1;
  return a.pre < b.pre ? -1 : 1;
}

interface VersionTimeline {
  versionAt(at: number): string;
  hoursByVersion(from: number, to: number): Record<string, number>;
}

/** App versions over time, from each `backend:starting` line. */
export function versionTimeline(
  entries: readonly EssentialEntry[],
  fallback: string,
): VersionTimeline {
  const starts = entries
    .filter((entry) => entry.area === "backend" && entry.event === "starting")
    .map((entry) => ({ at: entry.at, version: label(entry.fields.version) ?? UNKNOWN_VERSION }));
  const versionAt = (at: number): string => {
    let version = starts.length === 0 ? fallback : UNKNOWN_VERSION;
    for (const start of starts) {
      if (start.at <= at) version = start.version;
      else break;
    }
    return version;
  };
  const hoursByVersion = (from: number, to: number): Record<string, number> => {
    const hours: Record<string, number> = {};
    const add = (version: string, start: number, end: number) => {
      const span = Math.min(end, to) - Math.max(start, from);
      if (span > 0) hours[version] = (hours[version] ?? 0) + span / HOUR_MS;
    };
    if (starts.length === 0) {
      add(fallback, from, to);
      return hours;
    }
    add(UNKNOWN_VERSION, from, starts[0]!.at);
    starts.forEach((start, index) => add(start.version, start.at, starts[index + 1]?.at ?? to));
    return hours;
  };
  return { versionAt, hoursByVersion };
}

class SignalBuilder {
  count = 0;
  first = Number.POSITIVE_INFINITY;
  last = Number.NEGATIVE_INFINITY;
  readonly days = new Set<string>();
  readonly versions: Record<string, VersionSlice> = {};
  readonly evidence: Record<string, string | number | boolean> = {};
  /** Days a rate is spread over, when the source covers less than the bundle's window. */
  rateDays: number | null = null;

  constructor(
    readonly signature: string,
    readonly category: SignalCategory,
    readonly source: SignalSource,
    readonly title: string,
    readonly measureKind: MeasureKind,
    readonly unit: string,
  ) {}

  occur(at: number, version: string, weight = 1): void {
    this.count += weight;
    this.first = Math.min(this.first, at);
    this.last = Math.max(this.last, at);
    this.days.add(dayOf(at));
    const slice = (this.versions[version] ??= { count: 0 });
    slice.count += weight;
  }

  gauge(version: string, value: number): void {
    const slice = (this.versions[version] ??= { count: 0 });
    slice.value = Math.max(slice.value ?? Number.NEGATIVE_INFINITY, value);
  }

  max(field: string, value: number): void {
    const current = this.evidence[field];
    this.evidence[field] = typeof current === "number" ? Math.max(current, value) : value;
  }

  add(field: string, value: number): void {
    const current = this.evidence[field];
    this.evidence[field] = (typeof current === "number" ? current : 0) + value;
  }

  build(windowDays: number): Signal {
    const values = Object.values(this.versions)
      .map((slice) => slice.value)
      .filter((value): value is number => typeof value === "number");
    const value =
      this.measureKind === "rate"
        ? this.count / Math.max(this.rateDays ?? windowDays, 1 / 24)
        : values.length > 0
          ? Math.max(...values)
          : 0;
    const signal: Signal = {
      signature: this.signature,
      category: this.category,
      source: this.source,
      title: this.title,
      count: this.count,
      firstAt: Number.isFinite(this.first) ? new Date(this.first).toISOString() : null,
      lastAt: Number.isFinite(this.last) ? new Date(this.last).toISOString() : null,
      activeDays: this.days.size,
      measure: { kind: this.measureKind, unit: this.unit, value: round(value) },
      versions: this.versions,
      evidence: this.evidence,
      score: 0,
    };
    signal.score = scoreSignal(signal);
    return signal;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundValues(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value)]));
}

/**
 * Category weight, raised by how often it happens and how many days it spans,
 * so a daily fault outranks a one-off burst of the same weight. A gauge counts
 * as one occurrence a day.
 */
export function scoreSignal(signal: Pick<Signal, "category" | "measure" | "activeDays">): number {
  const perDay = signal.measure.kind === "rate" ? signal.measure.value : 1;
  const spread = 1 + Math.min(signal.activeDays, 7) / 7;
  return Math.round(CATEGORY_WEIGHT[signal.category] * (1 + Math.log10(1 + perDay)) * spread);
}

class Signals {
  private readonly builders = new Map<string, SignalBuilder>();

  get(signature: string, create: () => ConstructorParameters<typeof SignalBuilder>): SignalBuilder {
    let builder = this.builders.get(signature);
    if (!builder) {
      builder = new SignalBuilder(...create());
      this.builders.set(signature, builder);
    }
    return builder;
  }

  peek(signature: string): SignalBuilder | undefined {
    return this.builders.get(signature);
  }

  values(): SignalBuilder[] {
    return [...this.builders.values()];
  }
}

function essentialCategory(key: string, level: string, throttled: boolean): SignalCategory {
  if (CRASH_EVENTS.has(key)) return "crash";
  if (DATA_EVENTS.has(key)) return "data";
  if (PERFORMANCE_EVENTS.has(key)) return "performance";
  if (throttled) return "fault";
  const event = key.slice(key.indexOf(":") + 1);
  if (ERROR_GRADE_EVENTS.has(key) || ERROR_GRADE_EVENT_NAMES.has(event)) return "error";
  return level === "error" ? "error" : "warning";
}

function collectEssential(
  entries: readonly EssentialEntry[],
  timeline: VersionTimeline,
  signals: Signals,
): void {
  const openWriters = new Map<string, boolean>();
  for (const entry of entries) {
    const key = `${entry.area}:${entry.event}`;
    const version = timeline.versionAt(entry.at);

    if (key === "logging:essential.started" || key === "logging:essential.stopped") {
      const owner = label(entry.fields.owner) ?? "unknown";
      if (key === "logging:essential.started" && openWriters.get(owner) === true) {
        signals
          .get(`logging:writer-died:${owner}`, () => [
            `logging:writer-died:${owner}`,
            "crash",
            "essential-log",
            `The ${owner} process ended without an orderly exit (crash or kill)`,
            "rate",
            "per day",
          ])
          .occur(entry.at, version);
      }
      openWriters.set(owner, key === "logging:essential.started");
      continue;
    }
    if (SKIPPED_EVENTS.has(key)) continue;
    if (entry.level !== "error" && entry.level !== "warn") continue;

    const throttled = THROTTLE_EVENTS.has(entry.event);
    if (entry.event === "throttle.evicted") continue;
    const site = throttled ? label(entry.fields.site) : null;
    if (throttled && !site) continue;
    const event = site ?? entry.event;

    const provider =
      providerOf(entry.fields.source) ??
      (entry.area === "local-server" ? providerOf(entry.fields.key) : null);
    let signature: string;
    let title: string;
    let weight = 1;
    if (key === "renderer-errors:error.recorded") {
      const parts = [entry.fields.errorClass, entry.fields.boundary, entry.fields.fingerprint]
        .map(label)
        .map((part) => part ?? "unknown");
      signature = `renderer-errors:${parts.join(":")}`;
      title = `Renderer failure ${parts[0]} in ${parts[1]} (fingerprint ${parts[2]})`;
      weight = typeof entry.fields.count === "number" ? Math.max(1, entry.fields.count) : 1;
    } else {
      const qualifier =
        key === "local-server:bridge.exited"
          ? (label(entry.fields.signal) ??
            (typeof entry.fields.code === "number" ? `code-${entry.fields.code}` : null))
          : (QUALIFIER_FIELDS.map((field) => label(entry.fields[field])).find(Boolean) ?? null);
      signature = [entry.area, event, provider, qualifier].filter(Boolean).join(":");
      title = `${entry.area} ${event}${provider ? ` (${provider})` : ""}${qualifier ? `: ${qualifier}` : ""}`;
    }

    // A recovery closes the site's fault whatever kinds it had, so it carries no
    // `kind`: it adds evidence to each signature of that site and creates none.
    if (entry.event === "throttle.recovered") {
      const prefix = [entry.area, event, provider].filter(Boolean).join(":");
      for (const builder of signals.values()) {
        if (builder.signature !== prefix && !builder.signature.startsWith(`${prefix}:`)) continue;
        if (typeof entry.fields.faultSeconds === "number")
          builder.max("faultSeconds", entry.fields.faultSeconds);
        builder.add("recoveries", 1);
      }
      continue;
    }
    const category = essentialCategory(`${entry.area}:${event}`, entry.level, throttled);
    const builder = signals.get(signature, () => [
      signature,
      category,
      "essential-log",
      title,
      "rate",
      "per day",
    ]);
    if (entry.event === "throttle.suppressed") {
      const suppressed = typeof entry.fields.suppressed === "number" ? entry.fields.suppressed : 0;
      if (suppressed > 0) builder.occur(entry.at, version, suppressed);
      continue;
    }
    builder.occur(entry.at, version, weight);
    if (entry.level === "error") builder.evidence.level = "error";
    else builder.evidence.level ??= "warn";
    for (const field of EVIDENCE_MAX_FIELDS) {
      const value = entry.fields[field];
      if (typeof value === "number") builder.max(field, value);
    }
  }
}

interface Run {
  pid: number;
  startedAt: number;
  lastAt: number;
  clean: boolean;
  samples: HealthRow[];
}

function runsOf(rows: readonly HealthRow[]): Run[] {
  const runs = new Map<string, Run>();
  for (const row of rows) {
    const key = `${row.pid}:${row.startedAt}`;
    const run = runs.get(key) ?? {
      pid: row.pid,
      startedAt: row.startedAt,
      lastAt: row.at,
      clean: false,
      samples: [],
    };
    run.lastAt = Math.max(run.lastAt, row.at);
    run.clean ||= row.kind === "clean-exit";
    if (row.kind === "sample") run.samples.push(row);
    runs.set(key, run);
  }
  return [...runs.values()].sort((left, right) => left.startedAt - right.startedAt);
}

/** Least-squares slope of RSS over time, in MiB per hour. */
function rssSlope(samples: readonly HealthRow[]): number {
  const points = samples
    .filter((sample) => typeof sample.rssBytes === "number")
    .map((sample) => ({ x: sample.at / HOUR_MS, y: sample.rssBytes! / MIB }));
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

interface HealthResult {
  liveRun: Run | null;
  liveVersion: string;
  uptimeByVersion: Record<string, number>;
}

function collectHealth(
  data: BundleData,
  timeline: VersionTimeline,
  signals: Signals,
): HealthResult {
  const runs = runsOf(data.health);
  const exportedAt = Date.parse(data.manifest.createdAt);
  const newest = runs.reduce<Run | null>(
    (latest, run) => (latest === null || run.lastAt > latest.lastAt ? run : latest),
    null,
  );
  const liveRun =
    newest &&
    !newest.clean &&
    Number.isFinite(exportedAt) &&
    exportedAt - newest.lastAt <= LIVE_RUN_WINDOW_MS
      ? newest
      : null;
  const versionOf = (run: Run) =>
    run === liveRun
      ? data.manifest.appVersion || timeline.versionAt(run.startedAt)
      : timeline.versionAt(run.startedAt);

  const jobTotals = new Map<string, { started: number; failed: number; totalMs: number }>();
  let uptimeHours = 0;
  const uptimeByVersion: Record<string, number> = {};

  for (const run of runs) {
    const version = versionOf(run);
    const hours = Math.max(0, run.lastAt - run.startedAt) / HOUR_MS;
    uptimeHours += hours;
    uptimeByVersion[version] = (uptimeByVersion[version] ?? 0) + hours;
    const last = run.samples.at(-1);

    if (run !== liveRun && !run.clean) {
      const crash = signals.get("backend:crashed", () => [
        "backend:crashed",
        "crash",
        "health-summary",
        "The backend ended without its clean-exit marker (crash, kill or power loss)",
        "rate",
        "per day",
      ]);
      crash.occur(run.lastAt, version);
      crash.max("longestRunHours", round(hours));
      if (last?.rssBytes) crash.max("lastRssMiBBeforeCrash", Math.round(last.rssBytes / MIB));
    }

    const rssPeak = Math.max(0, ...run.samples.map((sample) => sample.rssBytes ?? 0)) / MIB;
    const first = run.samples[0];
    const grownMiB = first?.rssBytes && last?.rssBytes ? (last.rssBytes - first.rssBytes) / MIB : 0;
    const slope = rssSlope(run.samples);
    if (
      hours >= THRESHOLDS.rssGrowthMinHours &&
      grownMiB >= THRESHOLDS.rssGrowthMinMiB &&
      slope >= THRESHOLDS.rssGrowthMiBPerHour
    ) {
      const growth = signals.get("backend:rss-growth", () => [
        "backend:rss-growth",
        "resource",
        "health-summary",
        "Backend memory (RSS) kept growing through a run: a possible leak",
        "gauge",
        "MiB per hour",
      ]);
      growth.occur(run.lastAt, version);
      growth.gauge(version, round(slope));
      growth.max("grownMiB", Math.round(grownMiB));
      growth.max("peakMiB", Math.round(rssPeak));
    }
    if (rssPeak >= THRESHOLDS.rssPeakMiB) {
      const peak = signals.get("backend:rss-peak", () => [
        "backend:rss-peak",
        "resource",
        "health-summary",
        "Backend memory (RSS) peaked high",
        "gauge",
        "MiB",
      ]);
      peak.occur(run.lastAt, version);
      peak.gauge(version, Math.round(rssPeak));
    }

    if (last && hours > 0) {
      const cpuMs = (last.cpuUserMs ?? 0) + (last.cpuSystemMs ?? 0);
      const percent = (cpuMs / Math.max(1, last.uptimeMs ?? run.lastAt - run.startedAt)) * 100;
      if (percent >= THRESHOLDS.cpuPercent && hours >= 1) {
        const cpu = signals.get("backend:cpu", () => [
          "backend:cpu",
          "resource",
          "health-summary",
          "Backend CPU use was high averaged over a run",
          "gauge",
          "% of one core",
        ]);
        cpu.occur(run.lastAt, version);
        cpu.gauge(version, round(percent));
      }
      const stalls = last.stalls ?? 0;
      if (stalls > 0) {
        const stall = signals.get("backend:event-loop-stalls", () => [
          "backend:event-loop-stalls",
          "performance",
          "health-summary",
          "The backend's event loop stalled",
          "rate",
          "per day",
        ]);
        stall.occur(run.lastAt, version, stalls);
        if (typeof last.worstStallMs === "number") stall.max("worstStallMs", last.worstStallMs);
      }
    }

    // Job counters are cumulative within a run, so a run's largest figures are its totals.
    const runJobs = new Map<string, { started: number; failed: number; totalMs: number }>();
    for (const sample of run.samples) {
      for (const [kind, job] of Object.entries(sample.jobs ?? {})) {
        const current = runJobs.get(kind) ?? { started: 0, failed: 0, totalMs: 0 };
        runJobs.set(kind, {
          started: Math.max(current.started, job.started),
          failed: Math.max(current.failed, job.failed),
          totalMs: Math.max(current.totalMs, job.totalMs),
        });
      }
    }
    for (const [kind, job] of runJobs) {
      const total = jobTotals.get(kind) ?? { started: 0, failed: 0, totalMs: 0 };
      total.started += job.started;
      total.failed += job.failed;
      total.totalMs += job.totalMs;
      jobTotals.set(kind, total);
      if (job.failed > 0) {
        const signature = `recurring:${label(kind) ?? "unknown"}:failed`;
        const failed = signals.get(signature, () => [
          signature,
          "fault",
          "health-summary",
          `Recurring job ${kind} failed`,
          "rate",
          "per day",
        ]);
        failed.occur(run.lastAt, version, job.failed);
      }
    }
  }

  const healthDays =
    data.health.length > 0 ? (data.health.at(-1)!.at - data.health[0]!.at) / DAY_MS : 0;
  for (const builder of signals.values()) {
    if (builder.source === "health-summary" && builder.measureKind === "rate") {
      builder.rateDays = Math.max(healthDays, 1 / 24);
    }
  }

  for (const [kind, total] of jobTotals) {
    const failedSignal = signals.peek(`recurring:${label(kind) ?? "unknown"}:failed`);
    if (failedSignal && total.started > 0)
      failedSignal.evidence.failureRate = round(total.failed / total.started);
    const busyPerHour = uptimeHours > 0 ? total.totalMs / uptimeHours : 0;
    if (busyPerHour >= THRESHOLDS.jobBusyMsPerHour) {
      const signature = `recurring:${label(kind) ?? "unknown"}:busy`;
      const busy = signals.get(signature, () => [
        signature,
        "resource",
        "health-summary",
        `Recurring job ${kind} is busy for a large share of each hour`,
        "gauge",
        "ms per hour of uptime",
      ]);
      const at = data.health.at(-1)?.at ?? Date.now();
      const version = liveRun ? versionOf(liveRun) : UNKNOWN_VERSION;
      busy.occur(at, version);
      busy.gauge(version, Math.round(busyPerHour));
      busy.evidence.started = total.started;
    }
  }

  return {
    liveRun,
    liveVersion: liveRun ? versionOf(liveRun) : data.manifest.appVersion || UNKNOWN_VERSION,
    uptimeByVersion,
  };
}

function collectDatabase(
  data: BundleData,
  live: HealthResult,
  signals: Signals,
): Record<string, number> {
  const database = data.database;
  if (!database) return {};
  const at = Date.parse(data.manifest.createdAt) || Date.now();
  const version = live.liveVersion;
  // Database counters run since the exporting backend started. Without its
  // health rows that span is unknown, so rates fall back to one day and no
  // hours are claimed for verification.
  const hours = live.liveRun
    ? Math.max(1 / 60, (live.liveRun.lastAt - live.liveRun.startedAt) / HOUR_MS)
    : null;

  const rate = (
    signature: string,
    category: SignalCategory,
    title: string,
    count: number,
  ): SignalBuilder => {
    const builder = signals.get(signature, () => [
      signature,
      category,
      "database",
      title,
      "rate",
      "per day",
    ]);
    builder.occur(at, version, count);
    builder.rateDays = (hours ?? 24) / 24;
    if (hours !== null) builder.evidence.sinceBackendStartHours = round(hours);
    return builder;
  };

  for (const [key, series] of Object.entries(database.slowSeries)) {
    if (series.count < THRESHOLDS.slowSeriesCount && series.maxMs < THRESHOLDS.slowSeriesMaxMs)
      continue;
    const name = key
      .split(":")
      .map((part) => label(part) ?? "none")
      .join(":");
    const builder = rate(
      `storage:slow:${name}`,
      "performance",
      `Slow SQLite operations on ${name}`,
      series.count,
    );
    builder.max("maxMs", series.maxMs);
    builder.max("totalMs", series.totalMs);
  }
  for (const [family, figures] of Object.entries(database.leaseFamilies)) {
    const name = label(family) ?? "unknown";
    if (figures.timedOut > 0) {
      rate(
        `storage:lease-timeout:${name}`,
        "fault",
        `Storage lease ${name} timed out`,
        figures.timedOut,
      );
    }
    if (figures.maxWaitMs >= THRESHOLDS.leaseWaitMaxMs) {
      const builder = rate(
        `storage:lease-wait:${name}`,
        "performance",
        `Long storage lease waits on ${name}`,
        1,
      );
      builder.max("maxWaitMs", figures.maxWaitMs);
    }
  }
  if (database.transactionsBusy > 0) {
    rate(
      "storage:busy",
      "fault",
      "SQLite transactions gave up with SQLITE_BUSY",
      database.transactionsBusy,
    );
  }
  if ((database.mainWalBytes ?? 0) / MIB >= THRESHOLDS.walMiB) {
    const builder = signals.get("storage:wal-large", () => [
      "storage:wal-large",
      "resource",
      "database",
      "The main database's write-ahead log is large",
      "gauge",
      "MiB",
    ]);
    builder.occur(at, version);
    builder.gauge(version, Math.round(database.mainWalBytes! / MIB));
  }
  return hours === null ? {} : { [version]: hours };
}

/** Every signal in one bundle, highest score first. */
export function extractSignals(data: BundleData): ExtractedSignals {
  const timeline = versionTimeline(data.essential, data.manifest.appVersion || UNKNOWN_VERSION);
  const exportedAt = Date.parse(data.manifest.createdAt);
  const times = [
    ...data.essential.map((entry) => entry.at),
    ...data.health.map((row) => row.at),
    ...(Number.isFinite(exportedAt) ? [exportedAt] : []),
  ];
  const from = times.length > 0 ? Math.min(...times) : null;
  const to = times.length > 0 ? Math.max(...times) : null;
  const essentialFrom = data.essential[0]?.at ?? from;
  const days = from !== null && to !== null ? Math.max((to - from) / DAY_MS, 1 / 24) : 1;
  const versionHours =
    essentialFrom !== null && to !== null ? timeline.hoursByVersion(essentialFrom, to) : {};

  const signals = new Signals();
  collectEssential(data.essential, timeline, signals);
  const live = collectHealth(data, timeline, signals);
  const databaseHours = collectDatabase(data, live, signals);

  // `backend:previous-run` stands in for the health rows when a bundle has none.
  if (data.health.length === 0) {
    for (const entry of data.essential) {
      if (
        entry.area !== "backend" ||
        entry.event !== "previous-run" ||
        entry.fields.outcome !== "crashed"
      )
        continue;
      signals
        .get("backend:crashed", () => [
          "backend:crashed",
          "crash",
          "essential-log",
          "The backend ended without its clean-exit marker (crash, kill or power loss)",
          "rate",
          "per day",
        ])
        .occur(entry.at, timeline.versionAt(entry.at - 1));
    }
  }

  const built = signals
    .values()
    .map((builder) => builder.build(days))
    .sort(
      (left, right) => right.score - left.score || left.signature.localeCompare(right.signature),
    );
  return {
    window: {
      from: from === null ? null : new Date(from).toISOString(),
      to: to === null ? null : new Date(to).toISOString(),
      days: round(days),
    },
    signals: built,
    observedHours: {
      "essential-log": roundValues(versionHours),
      "health-summary": roundValues(live.uptimeByVersion),
      database: roundValues(databaseHours),
      // Filled by the insight stage: conversations read per version, not hours.
      insights: {},
    },
  };
}
