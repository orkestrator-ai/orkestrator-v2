import { AsyncLocalStorage } from "node:async_hooks";
import {
  RECURRING_DURATION_BUCKETS_MS,
  RECURRING_ERROR_CATEGORIES,
  RECURRING_WORK_SCHEMA_VERSION,
  isRecurringJobKind,
  isRecurringWorkUnit,
  type RecurringDurationSummary,
  type RecurringErrorCategory,
  type RecurringJobKind,
  type RecurringWorkKindSnapshot,
  type RecurringWorkSnapshot,
  type RecurringWorkUnit,
} from "@orkestrator/protocol/recurring-work";

/**
 * Bounded, content-free cost accounting for recurring background work.
 *
 * Every dimension is a member of a fixed vocabulary from
 * `@orkestrator/protocol/recurring-work`: a job kind, a physical work unit, an
 * error category. There is no parameter through which an environment id, a
 * path, a branch, a URL, a prompt or a command's output could become a label,
 * and anything outside the vocabulary is counted in `droppedLabels` without
 * being retained. Memory is therefore bounded by the vocabulary size plus a
 * fixed table of in-flight attempts.
 *
 * Three levels are kept apart on purpose, because the baseline has to tell
 * them apart:
 *
 *  - **requested / coalesced** — someone asked; the ask was folded into work
 *    already running or served from a cache.
 *  - **started / completed / failed** — one attempt of the job actually ran.
 *  - **work units** — the physical cost that attempt caused (a `git` spawn, a
 *    `docker exec`, a storage read), counted once at the boundary that
 *    performs it. Attribution uses an async context: a unit is charged to the
 *    innermost {@link RecurringWorkMetrics.observe} span it happens inside, so
 *    a nested job (a fetch inside a diff scan) is never charged twice.
 *
 * Observation must never change or fail the work it observes. Every recording
 * path is wrapped; a fault increments `recorderFaults` and is swallowed. The
 * observed function's own result, exception and rejection reach its caller
 * untouched. Snapshots read only in-memory counters — collecting metrics
 * never reads a file or spawns a process.
 *
 * Enabled by default, like the gateway's own metrics: the cost is a few map
 * updates per attempt at cadences of a second or slower. Set
 * `ORKESTRATOR_RECURRING_METRICS=0` to disable (the rollback switch).
 */

const BUCKET_COUNT = RECURRING_DURATION_BUCKETS_MS.length + 1;
/** Attempts whose age is tracked for the "worst in-flight age" diagnostic. */
export const RECURRING_WORK_MAX_TRACKED_ACTIVE = 1_024;

export interface RecurringWorkSpan {
  readonly kind: RecurringJobKind | undefined;
  /** The attempt found something new (a transition, a changed count). */
  changed(): void;
  /** The attempt confirmed nothing changed. */
  unchanged(): void;
  work(unit: RecurringWorkUnit, count?: number): void;
  bytes(count: number): void;
}

export interface RecurringObserveOptions {
  /** Time the attempt waited for admission or its due time before starting. */
  queueDelayMs?: number;
}

export interface RecurringWorkMetricsOptions {
  enabled?: boolean;
  /** Monotonic milliseconds; only differences are used. */
  now?: () => number;
  maxTrackedActive?: number;
}

type KindStats = {
  requested: number;
  coalesced: number;
  started: number;
  completed: number;
  failed: number;
  rejected: number;
  changed: number;
  unchanged: number;
  cacheHits: number;
  cacheMisses: number;
  active: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  bytes: number;
  duration: RecurringDurationSummary;
  queueDelay: RecurringDurationSummary;
  workUnits: Map<RecurringWorkUnit, number>;
  errors: Map<RecurringErrorCategory, number>;
};

class ActiveSpan implements RecurringWorkSpan {
  outcome: "changed" | "unchanged" | undefined;
  settled = false;
  tracked = false;

  constructor(
    private readonly owner: RecurringWorkMetrics,
    readonly kind: RecurringJobKind,
    readonly startedAt: number,
  ) {}

  changed(): void {
    this.outcome = "changed";
  }

  unchanged(): void {
    if (this.outcome !== "changed") this.outcome = "unchanged";
  }

  work(unit: RecurringWorkUnit, count = 1): void {
    this.owner.work(unit, count, this.kind);
  }

  bytes(count: number): void {
    this.owner.bytes(count, this.kind);
  }
}

const NOOP_SPAN: RecurringWorkSpan = {
  kind: undefined,
  changed: () => undefined,
  unchanged: () => undefined,
  work: () => undefined,
  bytes: () => undefined,
};

function emptySummary(): RecurringDurationSummary {
  return {
    count: 0,
    totalMs: 0,
    minMs: null,
    maxMs: null,
    buckets: Array.from({ length: BUCKET_COUNT }, () => 0),
  };
}

function recordSummary(summary: RecurringDurationSummary, ms: number): void {
  if (!Number.isFinite(ms)) return;
  const value = Math.max(0, Math.round(ms));
  summary.count += 1;
  summary.totalMs += value;
  summary.minMs = summary.minMs === null ? value : Math.min(summary.minMs, value);
  summary.maxMs = summary.maxMs === null ? value : Math.max(summary.maxMs, value);
  let index = RECURRING_DURATION_BUCKETS_MS.findIndex((bound) => value <= bound);
  if (index === -1) index = RECURRING_DURATION_BUCKETS_MS.length;
  summary.buckets[index] = (summary.buckets[index] ?? 0) + 1;
}

function copySummary(summary: RecurringDurationSummary): RecurringDurationSummary {
  return { ...summary, buckets: [...summary.buckets] };
}

function positiveCount(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Maps a failure to a finite category by its shape, never by its message.
 * Messages can echo argv, paths, provider output or credentials.
 */
export function recurringErrorCategory(error: unknown): RecurringErrorCategory {
  if (error && typeof error === "object") {
    const details = error as {
      timedOut?: unknown;
      executableMissing?: unknown;
      name?: unknown;
      code?: unknown;
      category?: unknown;
    };
    if (
      typeof details.category === "string" &&
      (RECURRING_ERROR_CATEGORIES as readonly string[]).includes(details.category)
    ) {
      return details.category as RecurringErrorCategory;
    }
    if (details.timedOut === true || details.name === "TimeoutError") return "timeout";
    if (details.name === "AbortError") return "cancelled";
    if (
      details.executableMissing === true ||
      details.code === "ENOENT" ||
      details.code === "ECONNREFUSED"
    ) {
      return "unavailable";
    }
  }
  return "error";
}

/** `ORKESTRATOR_RECURRING_METRICS=0|false|off` disables recording. */
export function recurringMetricsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.ORKESTRATOR_RECURRING_METRICS?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

export class RecurringWorkMetrics {
  private readonly kinds = new Map<RecurringJobKind, KindStats>();
  private readonly unattributedUnits = new Map<RecurringWorkUnit, number>();
  private unattributedBytes = 0;
  private readonly activeSpans = new Set<ActiveSpan>();
  private readonly context = new AsyncLocalStorage<ActiveSpan>();
  private readonly now: () => number;
  private readonly maxTrackedActive: number;
  private enabledFlag: boolean;
  private createdAt: number;
  private droppedLabels = 0;
  private untrackedActive = 0;
  private recorderFaults = 0;

  constructor(options: RecurringWorkMetricsOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxTrackedActive = Math.max(
      0,
      Math.floor(options.maxTrackedActive ?? RECURRING_WORK_MAX_TRACKED_ACTIVE),
    );
    this.enabledFlag = options.enabled ?? true;
    this.createdAt = this.safeNow();
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    this.enabledFlag = enabled;
  }

  /** The kind of the innermost span the caller is running inside, if any. */
  current(): RecurringJobKind | undefined {
    if (!this.enabledFlag) return undefined;
    try {
      return this.context.getStore()?.kind;
    } catch {
      this.recorderFaults += 1;
      return undefined;
    }
  }

  requested(kind: RecurringJobKind, count = 1): void {
    this.bump(kind, "requested", count);
  }

  /** Folded into a running attempt or pending rerun instead of starting one. */
  coalesced(kind: RecurringJobKind, count = 1): void {
    this.bump(kind, "coalesced", count);
  }

  /** Refused by a bound; the owner keeps the obligation. */
  rejected(kind: RecurringJobKind, count = 1): void {
    this.bump(kind, "rejected", count);
  }

  cacheHit(kind: RecurringJobKind): void {
    this.bump(kind, "cacheHits", 1);
  }

  cacheMiss(kind: RecurringJobKind): void {
    this.bump(kind, "cacheMisses", 1);
  }

  /** Changed/unchanged for work observed without a span (e.g. a read helper). */
  outcome(kind: RecurringJobKind, outcome: "changed" | "unchanged"): void {
    this.bump(kind, outcome, 1);
  }

  queueDelay(kind: RecurringJobKind, ms: number): void {
    if (!this.enabledFlag) return;
    try {
      const stats = this.stats(kind);
      if (stats) recordSummary(stats.queueDelay, ms);
    } catch {
      this.recorderFaults += 1;
    }
  }

  /**
   * Counts physical work. Charged to `kind` when given, otherwise to the
   * innermost active span, otherwise to the unattributed bucket.
   */
  work(unit: RecurringWorkUnit, count = 1, kind?: RecurringJobKind): void {
    if (!this.enabledFlag) return;
    try {
      const amount = positiveCount(count);
      if (amount === undefined) return;
      if (!isRecurringWorkUnit(unit)) {
        this.droppedLabels += 1;
        return;
      }
      const owner = kind ?? this.context.getStore()?.kind;
      if (owner === undefined) {
        this.unattributedUnits.set(unit, (this.unattributedUnits.get(unit) ?? 0) + amount);
        return;
      }
      const stats = this.stats(owner);
      if (stats) stats.workUnits.set(unit, (stats.workUnits.get(unit) ?? 0) + amount);
    } catch {
      this.recorderFaults += 1;
    }
  }

  bytes(count: number, kind?: RecurringJobKind): void {
    if (!this.enabledFlag) return;
    try {
      const amount = positiveCount(count);
      if (amount === undefined) return;
      const owner = kind ?? this.context.getStore()?.kind;
      if (owner === undefined) {
        this.unattributedBytes += amount;
        return;
      }
      const stats = this.stats(owner);
      if (stats) stats.bytes += amount;
    } catch {
      this.recorderFaults += 1;
    }
  }

  /**
   * Runs one attempt of `kind`, recording start, duration and outcome.
   *
   * Returns exactly what `fn` returns — the same promise object, not a
   * wrapper — and rethrows a synchronous exception unchanged, so wrapping an
   * existing call site cannot alter its timing, identity or error handling.
   * The outcome is observed on a side chain whose handlers cannot throw, so a
   * rejection the caller already owns is not turned into an unhandled one.
   */
  observe<T>(
    kind: RecurringJobKind,
    fn: (span: RecurringWorkSpan) => T,
    options: RecurringObserveOptions = {},
  ): T {
    if (!this.enabledFlag) return fn(NOOP_SPAN);
    const span = this.start(kind, options);
    if (!span) return fn(NOOP_SPAN);
    let result: T;
    try {
      result = this.context.run(span, () => fn(span));
    } catch (error) {
      this.finish(span, error, true);
      throw error;
    }
    if (isPromiseLike(result)) {
      try {
        result.then(
          () => this.finish(span, undefined, false),
          (error: unknown) => this.finish(span, error, true),
        );
      } catch {
        this.recorderFaults += 1;
      }
      return result;
    }
    this.finish(span, undefined, false);
    return result;
  }

  snapshot(): RecurringWorkSnapshot {
    const now = this.safeNow();
    const oldestByKind = new Map<RecurringJobKind, number>();
    for (const span of this.activeSpans) {
      const oldest = oldestByKind.get(span.kind);
      if (oldest === undefined || span.startedAt < oldest)
        oldestByKind.set(span.kind, span.startedAt);
    }
    const kinds: RecurringWorkSnapshot["kinds"] = {};
    const totals: RecurringWorkSnapshot["totals"] = {
      active: 0,
      worstActiveAgeMs: null,
      requested: 0,
      started: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
    };
    for (const [kind, stats] of this.kinds) {
      const oldest = oldestByKind.get(kind);
      const oldestActiveAgeMs = oldest === undefined ? null : Math.max(0, Math.round(now - oldest));
      const entry: RecurringWorkKindSnapshot = {
        requested: stats.requested,
        coalesced: stats.coalesced,
        started: stats.started,
        completed: stats.completed,
        failed: stats.failed,
        rejected: stats.rejected,
        changed: stats.changed,
        unchanged: stats.unchanged,
        cacheHits: stats.cacheHits,
        cacheMisses: stats.cacheMisses,
        active: stats.active,
        oldestActiveAgeMs,
        lastSuccessAgeMs:
          stats.lastSuccessAt === null ? null : Math.max(0, Math.round(now - stats.lastSuccessAt)),
        lastFailureAgeMs:
          stats.lastFailureAt === null ? null : Math.max(0, Math.round(now - stats.lastFailureAt)),
        bytes: stats.bytes,
        duration: copySummary(stats.duration),
        queueDelay: copySummary(stats.queueDelay),
        workUnits: Object.fromEntries(stats.workUnits),
        errors: Object.fromEntries(stats.errors),
      };
      kinds[kind] = entry;
      totals.active += stats.active;
      totals.requested += stats.requested;
      totals.started += stats.started;
      totals.completed += stats.completed;
      totals.failed += stats.failed;
      totals.rejected += stats.rejected;
      if (
        oldestActiveAgeMs !== null &&
        (totals.worstActiveAgeMs === null || oldestActiveAgeMs > totals.worstActiveAgeMs)
      ) {
        totals.worstActiveAgeMs = oldestActiveAgeMs;
      }
    }
    return {
      schemaVersion: RECURRING_WORK_SCHEMA_VERSION,
      enabled: this.enabledFlag,
      windowMs: Math.max(0, Math.round(now - this.createdAt)),
      totals,
      kinds,
      unattributed: {
        bytes: this.unattributedBytes,
        workUnits: Object.fromEntries(this.unattributedUnits),
      },
      droppedLabels: this.droppedLabels,
      untrackedActive: this.untrackedActive,
      recorderFaults: this.recorderFaults,
    };
  }

  /**
   * Clears every counter. Attempts still in flight finish into fresh stats
   * without driving `active` negative.
   */
  reset(): void {
    this.kinds.clear();
    this.unattributedUnits.clear();
    this.unattributedBytes = 0;
    for (const span of this.activeSpans) span.settled = true;
    this.activeSpans.clear();
    this.droppedLabels = 0;
    this.untrackedActive = 0;
    this.recorderFaults = 0;
    this.createdAt = this.safeNow();
  }

  private start(kind: RecurringJobKind, options: RecurringObserveOptions): ActiveSpan | undefined {
    try {
      const stats = this.stats(kind);
      if (!stats) return undefined;
      const span = new ActiveSpan(this, kind, this.now());
      stats.started += 1;
      stats.active += 1;
      if (options.queueDelayMs !== undefined) recordSummary(stats.queueDelay, options.queueDelayMs);
      if (this.activeSpans.size < this.maxTrackedActive) {
        this.activeSpans.add(span);
        span.tracked = true;
      } else {
        this.untrackedActive += 1;
      }
      return span;
    } catch {
      this.recorderFaults += 1;
      return undefined;
    }
  }

  private finish(span: ActiveSpan, error: unknown, failed: boolean): void {
    try {
      if (span.settled) return;
      span.settled = true;
      if (span.tracked) this.activeSpans.delete(span);
      const stats = this.stats(span.kind);
      if (!stats) return;
      const now = this.now();
      stats.active = Math.max(0, stats.active - 1);
      recordSummary(stats.duration, now - span.startedAt);
      if (failed) {
        stats.failed += 1;
        stats.lastFailureAt = now;
        const category = recurringErrorCategory(error);
        stats.errors.set(category, (stats.errors.get(category) ?? 0) + 1);
        return;
      }
      stats.completed += 1;
      stats.lastSuccessAt = now;
      if (span.outcome === "changed") stats.changed += 1;
      else if (span.outcome === "unchanged") stats.unchanged += 1;
    } catch {
      this.recorderFaults += 1;
    }
  }

  private bump(
    kind: RecurringJobKind,
    field:
      | "requested"
      | "coalesced"
      | "rejected"
      | "cacheHits"
      | "cacheMisses"
      | "changed"
      | "unchanged",
    count: number,
  ): void {
    if (!this.enabledFlag) return;
    try {
      const amount = positiveCount(count);
      if (amount === undefined) return;
      const stats = this.stats(kind);
      if (stats) stats[field] += amount;
    } catch {
      this.recorderFaults += 1;
    }
  }

  private stats(kind: RecurringJobKind): KindStats | undefined {
    const existing = this.kinds.get(kind);
    if (existing) return existing;
    if (!isRecurringJobKind(kind)) {
      this.droppedLabels += 1;
      return undefined;
    }
    const created: KindStats = {
      requested: 0,
      coalesced: 0,
      started: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      changed: 0,
      unchanged: 0,
      cacheHits: 0,
      cacheMisses: 0,
      active: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      bytes: 0,
      duration: emptySummary(),
      queueDelay: emptySummary(),
      workUnits: new Map(),
      errors: new Map(),
    };
    this.kinds.set(kind, created);
    return created;
  }

  private safeNow(): number {
    try {
      return this.now();
    } catch {
      this.recorderFaults += 1;
      return 0;
    }
  }
}

/**
 * The process-wide recorder every backend owner reports into by default.
 * Services accept an injected recorder so tests and the baseline harness can
 * observe an isolated instance.
 */
export const recurringWorkMetrics = new RecurringWorkMetrics({
  enabled: recurringMetricsEnabled(),
});

/**
 * Physical-work unit for a spawned executable, chosen from the argv the caller
 * already built. Only the executable's basename and, for Docker, whether the
 * first argument is `exec` are inspected; nothing is retained.
 */
export function spawnWorkUnit(command: string, args: readonly string[]): RecurringWorkUnit {
  const slash = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  const executable = (slash === -1 ? command : command.slice(slash + 1)).toLowerCase();
  switch (executable) {
    case "git":
    case "git.exe":
      return "git-spawn";
    case "gh":
    case "gh.exe":
      return "gh-spawn";
    case "docker":
    case "docker.exe":
      return args[0] === "exec" ? "docker-exec" : "docker-cli";
    case "tmux":
      return "tmux-spawn";
    default:
      return "process-spawn";
  }
}
