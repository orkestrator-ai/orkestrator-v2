import {
  isRecurringJobKind,
  isRecurringPriorityClass,
  recurringPriorityRank,
  type RecurringErrorCategory,
  type RecurringJobKind,
  type RecurringPriorityClass,
} from "@orkestrator/protocol/recurring-work";
import {
  recurringDiagnosticsRegistry,
  type RecurringDiagnosticsRegistry,
} from "./recurring-diagnostics.js";
import {
  recurringErrorCategory,
  recurringWorkMetrics,
  type RecurringWorkMetrics,
  type RecurringWorkSpan,
} from "./recurring-work-metrics.js";

/**
 * A small, bounded, process-local scheduler for keyed recurring work.
 *
 * It owns *mechanics only*: which key is due when, which runs next, and how
 * many run at once. Whether a key should exist, what a run does, what its
 * result means and how it is persisted stay with the domain service that
 * registers it. Nothing here is durable; an owner rebuilds its keys from
 * authoritative storage at startup and whenever it reconciles.
 *
 * ## Contract
 *
 * - **One run per key.** A key never has two runs in flight, including across
 *   remove/re-register: a new generation waits until the old generation's
 *   physical operation settles.
 * - **Repeat from completion.** The next due time is computed when a run
 *   settles (`nextDelayMs`, else the failure policy, else `intervalMs`), so a
 *   slow run cannot build a backlog.
 * - **Periodic vs dirty.** A due time or {@link RecurringScheduler.requestSooner}
 *   that arrives while the key is running is dropped — a run that outlasts its
 *   interval gets its rest. {@link RecurringScheduler.invalidate} while running
 *   sets a single pending-dirty marker and the key reruns once, immediately,
 *   after the current run settles, however many invalidations arrived.
 * - **Never postpone.** `requestSooner`/`invalidate` only pull a due time
 *   earlier. Jitter applies to soft deadlines only — registration and
 *   completion-scheduled repeats — and is bounded by
 *   {@link RecurringSchedulerLimits.maxJitterMs}. Worst-case lateness of a soft
 *   deadline is therefore `min(jitterMs, maxJitterMs)` plus timer latency plus
 *   time waiting for a free slot of its class. Hard deadlines are never
 *   jittered.
 * - **One timer.** A single timer is armed for the earliest future due time.
 *   After sleep/resume or any clock jump every overdue key runs *once*, in
 *   priority order; missed intervals are not replayed.
 * - **Bounded.** Registered keys, concurrent runs and pending (due-and-waiting)
 *   keys per class have hard limits. Exhaustion is an explicit result, never a
 *   silent drop: registration returns `{ ok: false, reason: "capacity" }`, and
 *   a refused `requestSooner`/`invalidate` returns a rejection *and* marks the
 *   key `reconcileRequired`, which its next run receives so the owner performs
 *   an authoritative read instead of trusting a hint that was dropped.
 * - **Reserved capacity.** `critical` runs have their own concurrency and can
 *   never be starved by best-effort work. `recovery` and `critical` keys may
 *   use {@link RecurringSchedulerLimits.reservedKeys}; `interactive` and
 *   `recovery` runs may use {@link RecurringSchedulerLimits.reservedConcurrency}
 *   slots that `progress`/`discovery`/`maintenance` cannot.
 * - **Fair priority.** Among due keys the most urgent class runs first, then
 *   the earliest due. A waiting key that has been passed over
 *   {@link RecurringSchedulerLimits.starvationLimit} times runs next regardless
 *   of class, so a stream of interactive work cannot hide discovery forever.
 * - **Generation and cancellation.** Every run receives an `AbortSignal` and an
 *   `isCurrent()` fence. Removal, replacement and disposal abort the signal and
 *   make `isCurrent()` false so the owner can refuse to publish a stale
 *   result. Aborting is *not* evidence the operation stopped: its concurrency
 *   slot is released only when the run's promise settles.
 * - **Errors stay inside.** A synchronous throw, a rejection, a failing retry
 *   policy or a failing metrics recorder is handled here and recorded under a
 *   finite category; nothing becomes an unhandled rejection.
 * - **Bounded shutdown.** {@link RecurringScheduler.dispose} aborts every run,
 *   waits at most `timeoutMs` for them to settle, and reports (content-free)
 *   what was still running. It never hangs.
 *
 * ## Wiring a new owner
 *
 * ```ts
 * const scheduler = new RecurringScheduler({ owner: "worktree-snapshots", limits: { maxConcurrent: 4 } });
 * scheduler.register({
 *   key: `diff\0${environmentId}`,          // internal only; never reported
 *   kind: "diff-scan",
 *   priority: "discovery",
 *   generation: targetGeneration,           // bump when the target changes
 *   intervalMs: 15_000,
 *   jitterMs: 1_000,
 *   run: async ({ signal, isCurrent, reconcileRequired }) => {
 *     const result = await scan(target, signal);
 *     if (!isCurrent()) return { outcome: "unchanged" };   // fenced: do not publish
 *     return publish(result) ? { outcome: "success" } : { outcome: "unchanged" };
 *   },
 * });
 * scheduler.invalidate(`diff\0${environmentId}`); // watcher hint: one post-change read
 * ```
 */

/** Finite owner names, so diagnostics can say which scheduler a status is from. */
export const RECURRING_SCHEDULER_OWNERS = [
  "worktree-snapshots",
  "pr-monitor",
  "agent-observation",
  "workflows",
  "maintenance",
  "test",
] as const;
export type RecurringSchedulerOwner = (typeof RECURRING_SCHEDULER_OWNERS)[number];

export interface RecurringTimerFactory {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/** Real timers, unref'd so a pending due time never keeps the process alive. */
export const systemRecurringTimers: RecurringTimerFactory = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref?.();
    return timer;
  },
  clear(handle) {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type RecurringRunReason = "scheduled" | "requested" | "dirty";
export type RecurringRunOutcome = "success" | "unchanged" | "failure";

export interface RecurringRunContext {
  readonly kind: RecurringJobKind;
  /** The owner generation this run was started under. */
  readonly generation: number;
  /** Aborted on remove, replacement and dispose. Advisory for the domain. */
  readonly signal: AbortSignal;
  readonly reason: RecurringRunReason;
  /** How late the run started relative to its due time. */
  readonly overdueMs: number;
  /**
   * A change hint for this key was refused under saturation since the last
   * run; treat cached state as untrustworthy and read authoritatively.
   */
  readonly reconcileRequired: boolean;
  /** Metrics span for work units and changed/unchanged; kind-labelled only. */
  readonly span: RecurringWorkSpan;
  /** False once the key was removed, replaced by a newer generation, or disposed. */
  isCurrent(): boolean;
}

export interface RecurringRunResult {
  outcome: RecurringRunOutcome;
  /**
   * Delay until the next run, measured from completion. `undefined` uses the
   * job's policy; `null` leaves the key registered but idle until the owner
   * calls `requestSooner`/`invalidate`/`update`.
   */
  nextDelayMs?: number | null;
  /** Finite category for a reported (non-thrown) failure. */
  errorCategory?: RecurringErrorCategory;
}

export interface RecurringJobSpec {
  /** Internal scoped key. Used only for identity; never exported or recorded. */
  key: string;
  kind: RecurringJobKind;
  priority: RecurringPriorityClass;
  /** Owner generation; a higher value replaces the key, a lower one is refused. */
  generation?: number;
  /** Nominal repeat interval, measured from completion. */
  intervalMs: number;
  /** Delay before the first run. Defaults to 0 (run as soon as admitted). */
  initialDelayMs?: number;
  /** Maximum random lateness added to soft deadlines; capped by the scheduler. */
  jitterMs?: number;
  /** `hard` deadlines are never jittered. Defaults to `soft`. */
  deadline?: "soft" | "hard";
  run(context: RecurringRunContext): Promise<RecurringRunResult | void> | RecurringRunResult | void;
  /**
   * Delay after a failed run (thrown, rejected or reported). Receives the
   * number of consecutive failures (1-based). Defaults to `intervalMs`.
   */
  retryDelayMs?(consecutiveFailures: number, category: RecurringErrorCategory): number;
}

export type RecurringJobUpdate = Partial<
  Pick<
    RecurringJobSpec,
    "priority" | "intervalMs" | "jitterMs" | "deadline" | "run" | "retryDelayMs"
  >
>;

export type RecurringRejectReason =
  | "capacity"
  | "pending-capacity"
  | "stale-generation"
  | "disposed"
  | "invalid"
  | "unknown-key";

export type RecurringRegisterResult =
  | { ok: true; status: "registered" | "updated" | "replaced" }
  | { ok: false; reason: RecurringRejectReason };

export type RecurringRequestResult =
  | { ok: true; status: "scheduled" | "coalesced" | "pending-rerun" }
  | { ok: false; reason: RecurringRejectReason };

export interface RecurringSchedulerLimits {
  /** Registered keys, all classes. */
  maxKeys: number;
  /** Of `maxKeys`, slots only `critical`/`recovery` registrations may use. */
  reservedKeys: number;
  /** Concurrent non-critical runs. */
  maxConcurrent: number;
  /** Of `maxConcurrent`, slots only `interactive`/`recovery` runs may use. */
  reservedConcurrency: number;
  /** Concurrent critical runs; a separate pool best-effort work cannot touch. */
  maxCriticalConcurrent: number;
  /** Due-and-waiting keys per class beyond which explicit requests are refused. */
  maxPendingPerClass: number;
  /** Passes over a waiting key before it runs regardless of class. */
  starvationLimit: number;
  /** Ceiling on any job's `jitterMs`. */
  maxJitterMs: number;
}

export const DEFAULT_RECURRING_SCHEDULER_LIMITS: RecurringSchedulerLimits = {
  maxKeys: 1_024,
  reservedKeys: 32,
  maxConcurrent: 4,
  reservedConcurrency: 1,
  maxCriticalConcurrent: 4,
  maxPendingPerClass: 256,
  starvationLimit: 8,
  maxJitterMs: 30_000,
};

export interface RecurringSchedulerOptions {
  owner: RecurringSchedulerOwner;
  limits?: Partial<RecurringSchedulerLimits>;
  /** Monotonic milliseconds. Defaults to `performance.now()`. */
  now?: () => number;
  timers?: RecurringTimerFactory;
  /** Uniform in [0, 1). Injected so jitter is deterministic under test. */
  random?: () => number;
  metrics?: RecurringWorkMetrics;
  diagnostics?: RecurringDiagnosticsRegistry | null;
}

export interface RecurringDisposeReport {
  /** Every run settled within the drain window. */
  drained: boolean;
  /** Runs still in flight when the drain window closed (bounded list). */
  stillRunning: { kind: RecurringJobKind; runningForMs: number }[];
}

export interface RecurringSchedulerStatus {
  owner: RecurringSchedulerOwner;
  disposed: boolean;
  keys: number;
  running: number;
  runningCritical: number;
  /** Runs of removed/replaced generations whose operation has not settled. */
  settling: number;
  /** Due and waiting for a slot. */
  due: number;
  paused: number;
  /** Registered with no due time (`nextDelayMs: null`). */
  idle: number;
  reconcileRequired: number;
  oldestDueAgeMs: number | null;
  limits: RecurringSchedulerLimits;
  rejected: Partial<Record<RecurringRejectReason, number>>;
  byKind: Partial<
    Record<
      RecurringJobKind,
      { keys: number; running: number; due: number; oldestDueAgeMs: number | null }
    >
  >;
}

const MAX_REPORTED_STILL_RUNNING = 64;

type RunState = {
  generation: number;
  controller: AbortController;
  startedAt: number;
  critical: boolean;
  kind: RecurringJobKind;
  /** Removed, replaced or disposed while running; its result is discarded. */
  stale: boolean;
  /** The run's promise has settled, i.e. the physical operation finished. */
  done: boolean;
  settled: Promise<void>;
};

type Entry = {
  key: string;
  spec: RecurringJobSpec;
  generation: number;
  /** Monotonic; `Infinity` when idle. */
  dueAt: number;
  seq: number;
  paused: boolean;
  running: RunState | null;
  dirty: boolean;
  requested: boolean;
  reconcileRequired: boolean;
  bypassed: number;
  consecutiveFailures: number;
  lastSettledAt: number | null;
  registeredAt: number;
};

/** A failure the run reported by value; carried through the metrics span as a rejection. */
class ReportedRunFailure extends Error {
  constructor(
    readonly result: RecurringRunResult,
    readonly category: RecurringErrorCategory,
  ) {
    super("reported failure");
  }
}

const NON_CRITICAL_RESERVED_CLASSES: ReadonlySet<RecurringPriorityClass> = new Set([
  "interactive",
  "recovery",
]);
const RESERVED_KEY_CLASSES: ReadonlySet<RecurringPriorityClass> = new Set(["critical", "recovery"]);

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class RecurringScheduler {
  readonly owner: RecurringSchedulerOwner;
  private readonly limits: RecurringSchedulerLimits;
  private readonly now: () => number;
  private readonly timers: RecurringTimerFactory;
  private readonly random: () => number;
  private readonly metrics: RecurringWorkMetrics;
  private readonly entries = new Map<string, Entry>();
  /** Runs whose key was removed; they still hold a slot until they settle. */
  private readonly orphans = new Map<string, RunState>();
  private readonly rejectedCounts = new Map<RecurringRejectReason, number>();
  private running = 0;
  private runningCritical = 0;
  private seq = 0;
  private timer: unknown;
  private timerDueAt = Infinity;
  private pumpQueued = false;
  private disposed = false;
  private disposePromise: Promise<RecurringDisposeReport> | null = null;
  private readonly unregisterDiagnostics: () => void;

  constructor(options: RecurringSchedulerOptions) {
    this.owner = options.owner;
    const limits = { ...DEFAULT_RECURRING_SCHEDULER_LIMITS, ...options.limits };
    const positive = (value: number, fallback: number) =>
      Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
    const maxKeys = positive(limits.maxKeys, DEFAULT_RECURRING_SCHEDULER_LIMITS.maxKeys);
    const maxConcurrent = positive(
      limits.maxConcurrent,
      DEFAULT_RECURRING_SCHEDULER_LIMITS.maxConcurrent,
    );
    this.limits = {
      maxKeys,
      reservedKeys: Math.min(Math.floor(finiteNonNegative(limits.reservedKeys, 0)), maxKeys - 1),
      maxConcurrent,
      reservedConcurrency: Math.min(
        Math.floor(finiteNonNegative(limits.reservedConcurrency, 0)),
        maxConcurrent - 1,
      ),
      maxCriticalConcurrent: positive(
        limits.maxCriticalConcurrent,
        DEFAULT_RECURRING_SCHEDULER_LIMITS.maxCriticalConcurrent,
      ),
      maxPendingPerClass: positive(
        limits.maxPendingPerClass,
        DEFAULT_RECURRING_SCHEDULER_LIMITS.maxPendingPerClass,
      ),
      starvationLimit: positive(
        limits.starvationLimit,
        DEFAULT_RECURRING_SCHEDULER_LIMITS.starvationLimit,
      ),
      maxJitterMs: finiteNonNegative(limits.maxJitterMs, 0),
    };
    this.now = options.now ?? (() => performance.now());
    this.timers = options.timers ?? systemRecurringTimers;
    this.random = options.random ?? Math.random;
    this.metrics = options.metrics ?? recurringWorkMetrics;
    const diagnostics =
      options.diagnostics === undefined ? recurringDiagnosticsRegistry : options.diagnostics;
    const unregisterStatus = diagnostics?.addScheduler(this) ?? (() => undefined);
    const unregisterSuspension = diagnostics?.addSuspensionListener(this) ?? (() => undefined);
    this.unregisterDiagnostics = () => {
      unregisterStatus();
      unregisterSuspension();
    };
  }

  /**
   * Registers a key, or updates/replaces it idempotently.
   *
   * - Unknown key: registered, first due after `initialDelayMs` (+ soft jitter).
   * - Same generation: the spec is updated in place; the due time is kept.
   * - Higher generation: the old generation is fenced (its signal aborted,
   *   `isCurrent()` false, its result discarded) and the new one scheduled;
   *   it cannot start until the old run's operation settles.
   * - Lower generation: refused as `stale-generation`.
   */
  register(spec: RecurringJobSpec): RecurringRegisterResult {
    if (this.disposed) return this.reject(spec.kind, "disposed");
    if (!this.validSpec(spec)) return this.reject(spec.kind, "invalid");
    const generation = spec.generation ?? 0;
    const existing = this.entries.get(spec.key);
    const now = this.now();
    if (existing) {
      if (generation < existing.generation) return this.reject(spec.kind, "stale-generation");
      if (generation === existing.generation) {
        existing.spec = { ...spec };
        this.schedulePump();
        return { ok: true, status: "updated" };
      }
      if (existing.running) {
        this.fence(existing.running);
      }
      existing.spec = { ...spec };
      existing.generation = generation;
      existing.dueAt = now + this.softDelay(spec, finiteNonNegative(spec.initialDelayMs, 0));
      existing.dirty = false;
      existing.requested = false;
      existing.reconcileRequired = false;
      existing.bypassed = 0;
      existing.consecutiveFailures = 0;
      existing.paused = false;
      this.schedulePump();
      return { ok: true, status: "replaced" };
    }
    const usable = RESERVED_KEY_CLASSES.has(spec.priority)
      ? this.limits.maxKeys
      : this.limits.maxKeys - this.limits.reservedKeys;
    if (this.entries.size >= usable) return this.reject(spec.kind, "capacity");
    const entry: Entry = {
      key: spec.key,
      spec: { ...spec },
      generation,
      dueAt: now + this.softDelay(spec, finiteNonNegative(spec.initialDelayMs, 0)),
      seq: this.seq++,
      paused: false,
      running: null,
      dirty: false,
      requested: false,
      reconcileRequired: false,
      bypassed: 0,
      consecutiveFailures: 0,
      lastSettledAt: null,
      registeredAt: now,
    };
    // A removed generation of this key may still be physically running.
    const orphan = this.orphans.get(spec.key);
    if (orphan) {
      this.orphans.delete(spec.key);
      entry.running = orphan;
    }
    this.entries.set(spec.key, entry);
    this.schedulePump();
    return { ok: true, status: "registered" };
  }

  /** Changes policy without a new generation. Never postpones the current due time. */
  update(key: string, patch: RecurringJobUpdate): RecurringRegisterResult {
    const entry = this.entries.get(key);
    if (this.disposed) return this.reject(entry?.spec.kind, "disposed");
    if (!entry) return this.reject(undefined, "unknown-key");
    const next = { ...entry.spec, ...patch };
    if (!this.validSpec(next)) return this.reject(entry.spec.kind, "invalid");
    const shortened = next.intervalMs < entry.spec.intervalMs;
    entry.spec = next;
    if (shortened && !entry.running) {
      const basis = entry.lastSettledAt ?? entry.registeredAt;
      entry.dueAt = Math.min(entry.dueAt, basis + next.intervalMs);
    }
    this.schedulePump();
    return { ok: true, status: "updated" };
  }

  /**
   * Pulls the key's due time to at most `now + delayMs`. Never postpones.
   * Dropped while the key is running: use {@link invalidate} when something
   * changed and a post-change run is required.
   */
  requestSooner(key: string, options: { delayMs?: number } = {}): RecurringRequestResult {
    return this.request(key, finiteNonNegative(options.delayMs, 0), false);
  }

  /**
   * Something the key reads has changed. Runs it as soon as admitted; while
   * it is running, sets the single pending-dirty marker so exactly one
   * trailing run follows, however many invalidations arrive.
   */
  invalidate(key: string): RecurringRequestResult {
    return this.request(key, 0, true);
  }

  pause(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || this.disposed) return false;
    entry.paused = true;
    this.schedulePump();
    return true;
  }

  /** Resumes a paused key. An overdue key runs once; missed intervals are not replayed. */
  resume(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || this.disposed) return false;
    entry.paused = false;
    this.schedulePump();
    return true;
  }

  /**
   * Forgets a key. A run in flight is fenced and aborted; it keeps its slot
   * until it settles, and its result is discarded. Idempotent.
   */
  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    if (entry.running) {
      this.fence(entry.running);
      this.orphans.set(key, entry.running);
    }
    this.schedulePump();
    return true;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Re-evaluates due work now, e.g. after the host resumed from sleep. Every
   * overdue key runs once, in priority order.
   */
  wake(): void {
    this.schedulePump();
  }

  /**
   * Translates a host suspension into this scheduler's monotonic time. The
   * monotonic clock does not advance while the host sleeps, so a key due 10 s
   * before a 60 s sleep is, in wall time, 50 s overdue on resume. Every pending
   * due time moves earlier by `suspendedMs` (never before now), so each overdue
   * key runs once, in priority order; missed intervals are not replayed.
   */
  compensateSuspension(suspendedMs: number): void {
    if (this.disposed || !Number.isFinite(suspendedMs) || suspendedMs <= 0) return;
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.dueAt === Infinity || entry.dueAt <= now) continue;
      entry.dueAt = Math.max(now, entry.dueAt - suspendedMs);
    }
    this.schedulePump();
  }

  /**
   * Stops scheduling, aborts every run and waits at most `timeoutMs` for them
   * to settle. Resolves (never rejects) with what was still running.
   * Idempotent: later calls return the first call's report.
   */
  dispose(options: { timeoutMs?: number } = {}): Promise<RecurringDisposeReport> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.clearTimer();
    const runs: RunState[] = [];
    for (const entry of this.entries.values()) {
      if (entry.running) runs.push(entry.running);
    }
    for (const run of this.orphans.values()) runs.push(run);
    for (const run of runs) this.fence(run);
    this.entries.clear();
    this.unregisterDiagnostics();
    const timeoutMs = finiteNonNegative(options.timeoutMs, 5_000);
    this.disposePromise = new Promise<RecurringDisposeReport>((resolve) => {
      let finished = false;
      let timer: unknown;
      const finish = () => {
        if (finished) return;
        finished = true;
        try {
          this.timers.clear(timer);
        } catch {
          // A failing timer factory cannot keep shutdown waiting.
        }
        const now = this.now();
        const still = runs.filter((run) => !run.done);
        resolve({
          drained: still.length === 0,
          stillRunning: still.slice(0, MAX_REPORTED_STILL_RUNNING).map((run) => ({
            kind: run.kind,
            runningForMs: Math.max(0, Math.round(now - run.startedAt)),
          })),
        });
      };
      if (runs.length === 0) {
        finish();
        return;
      }
      try {
        timer = this.timers.set(finish, timeoutMs);
      } catch {
        finish();
        return;
      }
      void Promise.all(runs.map((run) => run.settled)).then(finish, finish);
    });
    return this.disposePromise;
  }

  status(): RecurringSchedulerStatus {
    const now = this.now();
    const byKind: RecurringSchedulerStatus["byKind"] = {};
    let due = 0;
    let paused = 0;
    let idle = 0;
    let reconcileRequired = 0;
    let oldestDueAt = Infinity;
    for (const entry of this.entries.values()) {
      const kind = byKind[entry.spec.kind] ?? {
        keys: 0,
        running: 0,
        due: 0,
        oldestDueAgeMs: null,
      };
      kind.keys += 1;
      if (entry.running) kind.running += 1;
      if (entry.paused) paused += 1;
      if (entry.dueAt === Infinity) idle += 1;
      if (entry.reconcileRequired) reconcileRequired += 1;
      if (this.isWaiting(entry, now)) {
        due += 1;
        kind.due += 1;
        const age = Math.max(0, Math.round(now - entry.dueAt));
        kind.oldestDueAgeMs = Math.max(kind.oldestDueAgeMs ?? 0, age);
        oldestDueAt = Math.min(oldestDueAt, entry.dueAt);
      }
      byKind[entry.spec.kind] = kind;
    }
    return {
      owner: this.owner,
      disposed: this.disposed,
      keys: this.entries.size,
      running: this.running,
      runningCritical: this.runningCritical,
      settling: this.orphans.size,
      due,
      paused,
      idle,
      reconcileRequired,
      oldestDueAgeMs: oldestDueAt === Infinity ? null : Math.max(0, Math.round(now - oldestDueAt)),
      limits: { ...this.limits },
      rejected: Object.fromEntries(this.rejectedCounts),
      byKind,
    };
  }

  private request(key: string, delayMs: number, dirty: boolean): RecurringRequestResult {
    const entry = this.entries.get(key);
    if (this.disposed) return this.reject(entry?.spec.kind, "disposed");
    if (!entry) return this.reject(undefined, "unknown-key");
    const kind = entry.spec.kind;
    this.metrics.requested(kind);
    if (entry.running && !entry.running.stale) {
      this.metrics.coalesced(kind);
      if (!dirty) return { ok: true, status: "coalesced" };
      entry.dirty = true;
      return { ok: true, status: "pending-rerun" };
    }
    const now = this.now();
    const target = now + delayMs;
    if (target >= entry.dueAt) {
      // Already due at least this soon; never postpone earlier work.
      if (dirty) entry.dirty = true;
      else entry.requested = true;
      this.metrics.coalesced(kind);
      return { ok: true, status: "coalesced" };
    }
    if (
      target <= now &&
      !this.isWaiting(entry, now) &&
      entry.spec.priority !== "critical" &&
      this.pendingCount(entry.spec.priority, now) >= this.limits.maxPendingPerClass
    ) {
      entry.reconcileRequired = true;
      return this.reject(kind, "pending-capacity");
    }
    entry.dueAt = target;
    if (dirty) entry.dirty = true;
    else entry.requested = true;
    this.schedulePump();
    return { ok: true, status: "scheduled" };
  }

  private pendingCount(priority: RecurringPriorityClass, now: number): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.spec.priority === priority && this.isWaiting(entry, now)) count += 1;
    }
    return count;
  }

  private isWaiting(entry: Entry, now: number): boolean {
    return !entry.paused && !entry.running && entry.dueAt <= now;
  }

  /**
   * Runs one admission pass on the next microtask, coalescing every request
   * made before it. Deferring means no run ever starts inside `register`,
   * `invalidate` or another run's callback, and a batch registered together
   * (startup reconciliation) is ordered by priority as one set.
   */
  private schedulePump(): void {
    if (this.disposed || this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      if (this.disposed) return;
      try {
        this.pump();
      } catch {
        // Bookkeeping faults must not escape into the microtask queue; the
        // next request or timer pass retries admission.
      }
    });
  }

  private pump(): void {
    const now = this.now();
    // Critical work has its own pool and is never blocked by best-effort work.
    while (this.runningCritical < this.limits.maxCriticalConcurrent) {
      const next = this.pick(now, true);
      if (!next) break;
      this.start(next, now);
    }
    while (this.running < this.limits.maxConcurrent) {
      const next = this.pick(now, false);
      if (!next) break;
      this.start(next, now);
    }
    this.armTimer(now);
  }

  private pick(now: number, critical: boolean): Entry | undefined {
    const bestEffortLimit = this.limits.maxConcurrent - this.limits.reservedConcurrency;
    let best: Entry | undefined;
    let starving: Entry | undefined;
    const eligible: Entry[] = [];
    for (const entry of this.entries.values()) {
      if ((entry.spec.priority === "critical") !== critical) continue;
      if (!this.isWaiting(entry, now)) continue;
      if (
        !critical &&
        !NON_CRITICAL_RESERVED_CLASSES.has(entry.spec.priority) &&
        this.running >= bestEffortLimit
      ) {
        continue;
      }
      eligible.push(entry);
      if (
        entry.bypassed >= this.limits.starvationLimit &&
        (!starving || this.before(entry, starving, true))
      ) {
        starving = entry;
      }
      if (!best || this.before(entry, best, false)) best = entry;
    }
    const chosen = starving ?? best;
    if (!chosen) return undefined;
    for (const entry of eligible) {
      if (entry !== chosen) entry.bypassed += 1;
    }
    return chosen;
  }

  /** Urgency order: class, then due time, then registration order. */
  private before(left: Entry, right: Entry, ignoreClass: boolean): boolean {
    if (!ignoreClass) {
      const rank =
        recurringPriorityRank(left.spec.priority) - recurringPriorityRank(right.spec.priority);
      if (rank !== 0) return rank < 0;
    }
    if (left.dueAt !== right.dueAt) return left.dueAt < right.dueAt;
    return left.seq < right.seq;
  }

  private start(entry: Entry, now: number): void {
    const spec = entry.spec;
    const critical = spec.priority === "critical";
    const reason: RecurringRunReason = entry.dirty
      ? "dirty"
      : entry.requested
        ? "requested"
        : "scheduled";
    const overdueMs = Math.max(0, now - entry.dueAt);
    const reconcileRequired = entry.reconcileRequired;
    // Every started run counts as one request; explicit requests are counted
    // when they arrive, so `requested - started` is what was coalesced away.
    if (reason === "scheduled") this.metrics.requested(spec.kind);
    entry.dirty = false;
    entry.requested = false;
    entry.reconcileRequired = false;
    entry.bypassed = 0;
    let markSettled: () => void = () => undefined;
    const run: RunState = {
      generation: entry.generation,
      controller: new AbortController(),
      startedAt: now,
      critical,
      kind: spec.kind,
      stale: false,
      done: false,
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    };
    entry.running = run;
    if (critical) this.runningCritical += 1;
    else this.running += 1;

    let outcome: Promise<RecurringRunResult | void>;
    try {
      outcome = Promise.resolve(
        this.metrics.observe(
          spec.kind,
          async (span) => {
            const result = await spec.run({
              kind: spec.kind,
              generation: run.generation,
              signal: run.controller.signal,
              reason,
              overdueMs,
              reconcileRequired,
              span,
              isCurrent: () => !run.stale && !this.disposed,
            });
            if (result && result.outcome === "failure") {
              throw new ReportedRunFailure(result, result.errorCategory ?? "error");
            }
            if (result?.outcome === "success") span.changed();
            else if (result?.outcome === "unchanged") span.unchanged();
            return result;
          },
          { queueDelayMs: overdueMs },
        ),
      );
    } catch (error) {
      outcome = Promise.reject(error);
    }
    outcome.then(
      (result) => this.settle(entry, run, result ?? { outcome: "success" }, undefined, markSettled),
      (error: unknown) =>
        this.settle(
          entry,
          run,
          error instanceof ReportedRunFailure ? error.result : { outcome: "failure" },
          error,
          markSettled,
        ),
    );
  }

  private settle(
    entry: Entry,
    run: RunState,
    result: RecurringRunResult,
    error: unknown,
    markSettled: () => void,
  ): void {
    try {
      if (run.critical) this.runningCritical = Math.max(0, this.runningCritical - 1);
      else this.running = Math.max(0, this.running - 1);
      if (this.orphans.get(entry.key) === run) this.orphans.delete(entry.key);
      const live = this.entries.get(entry.key);
      if (live && live.running === run) live.running = null;
      if (this.disposed) return;
      if (run.stale || live !== entry || live.generation !== run.generation) {
        // A fenced run's result describes a target that no longer exists.
        this.schedulePump();
        return;
      }
      const now = this.now();
      entry.lastSettledAt = now;
      let delay: number | null;
      if (result.outcome === "failure") {
        entry.consecutiveFailures += 1;
        const category =
          error instanceof ReportedRunFailure
            ? error.category
            : error === undefined
              ? (result.errorCategory ?? "error")
              : recurringErrorCategory(error);
        delay =
          result.nextDelayMs !== undefined
            ? result.nextDelayMs
            : this.retryDelay(entry, entry.consecutiveFailures, category);
      } else {
        entry.consecutiveFailures = 0;
        delay = result.nextDelayMs === undefined ? entry.spec.intervalMs : result.nextDelayMs;
      }
      if (entry.dirty) {
        // Something changed while this run was reading: one trailing run now.
        entry.dueAt = now;
      } else if (delay === null) {
        entry.dueAt = Infinity;
      } else {
        entry.dueAt = now + this.softDelay(entry.spec, finiteNonNegative(delay, 0));
      }
      this.schedulePump();
    } catch {
      // Scheduler bookkeeping must never reject into the run's promise chain.
    } finally {
      run.done = true;
      markSettled();
    }
  }

  private retryDelay(entry: Entry, failures: number, category: RecurringErrorCategory): number {
    try {
      const delay = entry.spec.retryDelayMs?.(failures, category);
      if (typeof delay === "number" && Number.isFinite(delay) && delay >= 0) return delay;
    } catch {
      // A faulty retry policy falls back to the ordinary interval.
    }
    return entry.spec.intervalMs;
  }

  private softDelay(spec: RecurringJobSpec, delayMs: number): number {
    if (spec.deadline === "hard") return delayMs;
    const jitter = Math.min(finiteNonNegative(spec.jitterMs, 0), this.limits.maxJitterMs);
    if (jitter <= 0) return delayMs;
    let sample = 0;
    try {
      sample = this.random();
    } catch {
      sample = 0;
    }
    const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
    return delayMs + Math.floor(unit * jitter);
  }

  private fence(run: RunState): void {
    if (run.stale) return;
    run.stale = true;
    try {
      run.controller.abort();
    } catch {
      // An abort listener that throws belongs to the domain; it cannot stop fencing.
    }
  }

  private armTimer(now: number): void {
    let earliest = Infinity;
    for (const entry of this.entries.values()) {
      if (entry.paused || entry.running) continue;
      if (entry.dueAt > now && entry.dueAt < earliest) earliest = entry.dueAt;
    }
    if (earliest === this.timerDueAt && this.timer !== undefined) return;
    this.clearTimer();
    if (earliest === Infinity) return;
    this.timerDueAt = earliest;
    try {
      this.timer = this.timers.set(
        () => {
          this.timer = undefined;
          this.timerDueAt = Infinity;
          this.schedulePump();
        },
        Math.max(0, earliest - now),
      );
    } catch {
      this.timer = undefined;
      this.timerDueAt = Infinity;
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      try {
        this.timers.clear(this.timer);
      } catch {
        // Nothing to recover: the callback re-checks state when it fires.
      }
    }
    this.timer = undefined;
    this.timerDueAt = Infinity;
  }

  private validSpec(spec: RecurringJobSpec): boolean {
    return (
      typeof spec.key === "string" &&
      spec.key.length > 0 &&
      isRecurringJobKind(spec.kind) &&
      isRecurringPriorityClass(spec.priority) &&
      typeof spec.run === "function" &&
      Number.isFinite(spec.intervalMs) &&
      spec.intervalMs >= 0 &&
      (spec.generation === undefined || Number.isFinite(spec.generation))
    );
  }

  private reject(
    kind: RecurringJobKind | undefined,
    reason: RecurringRejectReason,
  ): { ok: false; reason: RecurringRejectReason } {
    this.rejectedCounts.set(reason, (this.rejectedCounts.get(reason) ?? 0) + 1);
    if (kind !== undefined && isRecurringJobKind(kind)) this.metrics.rejected(kind);
    return { ok: false, reason };
  }
}
