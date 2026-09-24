/**
 * Client read coordinator: one owner for renderer presentation-read scheduling.
 *
 * Mounted views describe what they need — a read key, whether they are active,
 * how fresh they want to be and how important the read is — and the
 * coordinator decides when a read actually runs. It owns:
 *
 * - **One timer per key.** Demand from every subscriber of a key is aggregated
 *   (the fastest active interval wins) instead of one interval per component.
 *   Periodic reads follow a fixed-rate grid anchored when the cadence was
 *   established, so a migrated `setInterval` keeps its exact foreground
 *   cadence; ticks that land while a read is in flight are skipped, as before.
 * - **Joining.** An equivalent read already in flight is joined. An
 *   invalidation arriving during a read sets a single dirty flag that causes
 *   exactly one trailing read. An explicit `refresh()` always obtains a read
 *   that started after the call; joining an older read alone never satisfies it.
 * - **Visibility and connectivity.** Automatic reads (periodic, invalidation,
 *   mount, retry) pause while the document is hidden or a transport has
 *   declared itself disconnected (`setDisconnected`). Browser `offline` is not
 *   treated as disconnected: a desktop Local backend stays reachable without
 *   internet access, so online/offline is only a hint and `online` merely
 *   triggers a reconcile. Visibility, focus, page-show, online and transport
 *   reconnect signals are coalesced for {@link READ_RESUME_COALESCE_MS} and
 *   reconciled once, critical keys first, lower priorities spread over a
 *   short bounded window.
 * - **Errors.** Failed reads retry with capped, jittered backoff and keep the
 *   last good value (reported as stale with its original observation time).
 *   Authentication failures are never turned into empty data. Permanently
 *   unsupported APIs stop automatic reads until reconnect or explicit refresh.
 * - **Identity.** Every read runs under the current connection identity and
 *   an entry epoch. A server switch, an eviction or a key change makes older
 *   results inert: they neither apply nor rearm timers.
 *
 * The coordinator is read-only. It must never own prompt submission, approval
 * resolution, workflow progression or queue draining; those remain direct,
 * backend-authoritative commands. Unsubscribing only removes this client's
 * demand — backend work and monitoring continue regardless of the renderer.
 *
 * ## Usage
 *
 * React components normally go through `useCoordinatedRead`
 * (`@/hooks/useCoordinatedRead`). Direct use:
 *
 * ```ts
 * const subscription = getReadCoordinator().subscribe({
 *   key: { resource: "system-usage", target: projectId, options: diskTarget },
 *   demand: { intervalMs: 5_000, priority: "auxiliary" },
 *   read: ({ signal }) => backend.getSystemUsage(diskTarget, { signal }),
 *   onState: (state) => render(state.value, state.stale, state.observedAt),
 * });
 * subscription.update({ demand: { intervalMs: 3_000, priority: "auxiliary" } });
 * await subscription.refresh(); // explicit, post-call observation
 * subscription.dispose();
 * ```
 *
 * Keys must describe everything that makes two reads non-equivalent: resource
 * kind, target identity (environment, session, project), serialized options
 * (limits, cursors, filters) and the requested view. A consumer that applies a
 * result into state private to one mounted instance (for example a
 * conditional token only that instance holds) must include an instance scope
 * in `view`, because a different subscriber's read would not be equivalent.
 */

export type ReadPriority = "critical" | "standard" | "auxiliary";

/**
 * Why a read started. Reads started for `explicit` (or that also satisfy an
 * explicit waiter) report `context.explicit === true`.
 */
export type ReadReason =
  | "mount"
  | "interval"
  | "invalidate"
  | "explicit"
  | "resume"
  | "reconnect"
  | "retry";

/**
 * - `transient`: retried with capped jittered backoff.
 * - `auth`: retried at the backoff ceiling; the last good value is retained.
 * - `unsupported`: the peer does not implement this read; automatic reads
 *   stop until a reconnect, a server switch or an explicit refresh.
 */
export type ReadErrorKind = "transient" | "auth" | "unsupported";

export type ReadStatus = "idle" | "loading" | "current" | "error" | "unsupported";

export interface ReadKey {
  /** Resource kind, e.g. `native-agent-session`, `files-panel`, `system-usage`. */
  resource: string;
  /** Target identity: environment, session, project or backend scope. */
  target: string;
  /** Serialized read options. Different options never share a response. */
  options?: string;
  /** Requested view (window, cursor, instance scope). */
  view?: string;
}

export interface ReadDemand {
  /**
   * Whether this subscriber currently wants automatic reads (tab active, panel
   * open). An inactive subscriber receives no automatic reads and ignores
   * invalidations: its owner performs its own activation read, or calls
   * `refresh()`. Defaults to `true`.
   */
  active?: boolean;
  /** Requested periodic freshness. `null`/absent means event/explicit only. */
  intervalMs?: number | null;
  /** Resume ordering. Defaults to `standard`. */
  priority?: ReadPriority;
  /**
   * Optional quiet backoff schedule. After consecutive uninterrupted periodic
   * reads the effective interval steps through these values (never below
   * `intervalMs`). Any invalidation, explicit refresh, resume, reconnect or
   * failure restores `intervalMs`. It applies only when every active periodic
   * subscriber of the key opts in. Callers keep it disabled until the
   * relevant event and recovery coverage is qualified.
   */
  quietBackoffMs?: readonly number[] | null;
}

export interface ReadContext {
  reason: ReadReason;
  /** True when the read must satisfy an explicit refresh. */
  explicit: boolean;
  /**
   * Aborted when this read's result can no longer apply (server switch,
   * eviction). Only honour it where aborting does not stop backend work.
   */
  signal: AbortSignal;
  connectionId: string | null;
  connectionGeneration: number;
}

export interface ReadState<T> {
  status: ReadStatus;
  value: T | undefined;
  hasValue: boolean;
  /**
   * Clock time (coordinator clock) at which the read that produced `value`
   * started. A failed refresh never advances it.
   */
  observedAt: number | null;
  /** A value is retained but a later read failed, is unsupported or is due. */
  stale: boolean;
  error: unknown;
  errorKind: ReadErrorKind | null;
  /** Consecutive failures since the last success/reconnect/explicit action. */
  failures: number;
  /** Increments each time a successful result is applied. */
  revision: number;
  connectionId: string | null;
  connectionGeneration: number;
}

export type ReadFunction<T> = (context: ReadContext) => Promise<T> | T;

export interface ReadSubscriptionOptions<T> {
  key: ReadKey;
  read: ReadFunction<T>;
  demand?: ReadDemand;
  /**
   * Read (or deliver a fresh retained value) when subscribing. Migrations that
   * already perform their own mount read pass `false`; the subscription time
   * then counts as the last observation for resume/overdue decisions.
   * Defaults to `true`.
   */
  readOnSubscribe?: boolean;
  classifyError?: (error: unknown) => ReadErrorKind;
  /** Called after state changes while this subscription is live. */
  onState?: (state: ReadState<T>) => void;
}

export interface ReadSubscription<T> {
  update(changes: {
    demand?: ReadDemand;
    read?: ReadFunction<T>;
    onState?: (state: ReadState<T>) => void;
  }): void;
  /** Hint that the resource changed. Coalesced; deferred while paused. */
  invalidate(): void;
  /**
   * Explicit refresh. Resolves (never rejects) with the state after a read
   * that started after this call. Runs even while paused, in backoff or
   * marked unsupported.
   */
  refresh(): Promise<ReadState<T>>;
  getState(): ReadState<T>;
  dispose(): void;
}

export interface ReadCoordinatorClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface EventSource {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface ReadCoordinatorVisibilitySource extends EventSource {
  readonly visibilityState?: string;
}

export interface ReadCoordinatorOptions {
  clock?: ReadCoordinatorClock;
  /** Document-like visibility source; `null` disables visibility handling. */
  document?: ReadCoordinatorVisibilitySource | null;
  /** Window-like source for the `focus`, `pageshow` and `online` hints. */
  window?: EventSource | null;
  /** Returns [0, 1). Used for resume spreading and retry jitter. */
  random?: () => number;
  connectionId?: string | null;
  maxRetainedEntries?: number;
  resumeCoalesceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface ReadCoordinatorDiagnostics {
  paused: boolean;
  hidden: boolean;
  disconnected: boolean;
  connectionId: string | null;
  connectionGeneration: number;
  readsStarted: number;
  entries: Array<{
    id: string;
    subscribers: number;
    active: boolean;
    inFlight: boolean;
    status: ReadStatus;
    cadenceMs: number | null;
    timerDueAt: number | null;
    failures: number;
  }>;
}

export interface ReadCoordinator {
  subscribe<T>(options: ReadSubscriptionOptions<T>): ReadSubscription<T>;
  /**
   * Records the active backend connection. Changing from one known identity to
   * another resets every entry: in-flight results become inert, retained
   * values are dropped and active keys re-read.
   */
  setConnection(connectionId: string | null): void;
  /** A transport reconnected or its replay generation changed. */
  notifyReconnected(): void;
  /** Transport-declared connectivity. Browser `online` is only a hint. */
  setDisconnected(disconnected: boolean): void;
  /** Invalidates every key matching the predicate. */
  invalidateMatching(predicate: (key: ReadKey) => boolean): void;
  getDiagnostics(): ReadCoordinatorDiagnostics;
  dispose(): void;
}

/** Window in which visibility/focus/online/reconnect signals become one pass. */
export const READ_RESUME_COALESCE_MS = 50;
/**
 * Delay after the reconcile pass before each priority's resume read starts,
 * as `[min, max]`; the actual delay is uniformly jittered inside the range so
 * many tabs or panels do not wake at the same instant.
 */
export const READ_RESUME_SPREAD_MS: Readonly<Record<ReadPriority, readonly [number, number]>> = {
  critical: [0, 0],
  standard: [100, 600],
  auxiliary: [300, 1_500],
};
/**
 * Documented upper bound between the first resume signal and the start of a
 * visible critical read (session state, pending interactions): the coalescing
 * window, as critical reads are never spread. Event-loop latency is extra.
 */
export const CRITICAL_READ_RESUME_MAX_DELAY_MS =
  READ_RESUME_COALESCE_MS + READ_RESUME_SPREAD_MS.critical[1];
export const READ_RETRY_BASE_MS = 1_000;
export const READ_RETRY_MAX_MS = 30_000;
/** Subscriber-less entries retained for remounts before the oldest is evicted. */
export const READ_RETAINED_ENTRY_LIMIT = 32;

const PRIORITY_RANK: Record<ReadPriority, number> = { critical: 0, standard: 1, auxiliary: 2 };

/** Stable identity string for a key. */
export function readKeyId(key: ReadKey): string {
  return JSON.stringify([key.resource, key.target, key.options ?? "", key.view ?? ""]);
}

/**
 * Default classification: gateway HTTP 401/403 is `auth`; an unknown backend
 * command is `unsupported`; everything else is `transient`. Arbitrary network
 * or auth errors are never inferred to mean unsupported.
 */
export function classifyReadError(error: unknown): ReadErrorKind {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  if (status === 401 || status === 403) return "auth";
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unknown backend command")) return "unsupported";
  return "transient";
}

interface NormalizedDemand {
  active: boolean;
  intervalMs: number | null;
  priority: ReadPriority;
  quietBackoffMs: readonly number[] | null;
}

function normalizeDemand(demand: ReadDemand | undefined): NormalizedDemand {
  const interval = demand?.intervalMs;
  return {
    active: demand?.active ?? true,
    intervalMs: typeof interval === "number" && interval > 0 ? interval : null,
    priority: demand?.priority ?? "standard",
    quietBackoffMs:
      demand?.quietBackoffMs && demand.quietBackoffMs.length > 0 ? demand.quietBackoffMs : null,
  };
}

interface Subscriber<T> {
  order: number;
  read: ReadFunction<T>;
  demand: NormalizedDemand;
  classifyError: ((error: unknown) => ReadErrorKind) | undefined;
  onState: ((state: ReadState<T>) => void) | undefined;
  disposed: boolean;
}

interface InFlight<T> {
  epoch: number;
  startedAt: number;
  reason: ReadReason;
  controller: AbortController;
  reader: Subscriber<T>;
  waiters: Array<(state: ReadState<T>) => void>;
}

interface Entry<T> {
  id: string;
  key: ReadKey;
  subscribers: Set<Subscriber<T>>;
  epoch: number;
  inFlight: InFlight<T> | null;
  dirty: boolean;
  waiters: Array<(state: ReadState<T>) => void>;
  value: T | undefined;
  hasValue: boolean;
  observedAt: number | null;
  revision: number;
  status: ReadStatus;
  error: unknown;
  errorKind: ReadErrorKind | null;
  failures: number;
  retryAt: number | null;
  unsupported: boolean;
  lastStartedAt: number | null;
  /** Coordinator-wide start sequence of the latest read (orders reads vs signals). */
  lastStartSeq: number;
  anchor: number;
  cadenceMs: number | null;
  quietStreak: number;
  resumeDueAt: number | null;
  resumeReason: ReadReason;
  timer: unknown;
  timerDueAt: number | null;
  idleSince: number | null;
}

function defaultClock(): ReadCoordinatorClock {
  const monotonic =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  return {
    now: monotonic,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function createReadCoordinator(options: ReadCoordinatorOptions = {}): ReadCoordinator {
  const clock = options.clock ?? defaultClock();
  const doc = options.document ?? null;
  const win = options.window ?? null;
  const random = options.random ?? Math.random;
  const maxRetained = Math.max(0, options.maxRetainedEntries ?? READ_RETAINED_ENTRY_LIMIT);
  const coalesceMs = options.resumeCoalesceMs ?? READ_RESUME_COALESCE_MS;
  const retryBaseMs = options.retryBaseMs ?? READ_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? READ_RETRY_MAX_MS;

  // Entries are heterogeneous; each subscription keeps its own `T`.
  const entries = new Map<string, Entry<any>>();
  let connectionId = options.connectionId ?? null;
  let connectionGeneration = 0;
  let disconnected = false;
  let paused = false;
  let reconnectWhilePaused = false;
  let pendingReconcile: "resume" | "reconnect" | null = null;
  let pendingReconcileSince: number | null = null;
  let reconcileTimer: unknown = null;
  let subscriberOrder = 0;
  let readsStarted = 0;
  let disposed = false;

  const isHidden = () => doc?.visibilityState === "hidden";
  const computePaused = () => isHidden() || disconnected;
  paused = computePaused();

  const snapshot = <T>(entry: Entry<T>): ReadState<T> => ({
    status: entry.status,
    value: entry.value,
    hasValue: entry.hasValue,
    observedAt: entry.observedAt,
    stale:
      entry.hasValue && (entry.status === "error" || entry.status === "unsupported" || entry.dirty),
    error: entry.error,
    errorKind: entry.errorKind,
    failures: entry.failures,
    revision: entry.revision,
    connectionId,
    connectionGeneration,
  });

  const notify = <T>(entry: Entry<T>): void => {
    const state = snapshot(entry);
    for (const subscriber of Array.from(entry.subscribers)) {
      if (subscriber.disposed || !subscriber.onState) continue;
      try {
        subscriber.onState(state);
      } catch (error) {
        console.error("[read-coordinator] State listener threw:", error);
      }
    }
  };

  const resolveWaiters = <T>(entry: Entry<T>, waiters: Array<(state: ReadState<T>) => void>) => {
    if (waiters.length === 0) return;
    const state = snapshot(entry);
    for (const resolve of waiters) resolve(state);
  };

  const aggregate = <T>(entry: Entry<T>): NormalizedDemand => {
    let active = false;
    let intervalMs: number | null = null;
    let priority: ReadPriority = "auxiliary";
    let quiet: number[] | null | undefined;
    for (const subscriber of entry.subscribers) {
      const demand = subscriber.demand;
      if (!demand.active) continue;
      active = true;
      if (PRIORITY_RANK[demand.priority] < PRIORITY_RANK[priority]) priority = demand.priority;
      if (demand.intervalMs === null) continue;
      intervalMs =
        intervalMs === null ? demand.intervalMs : Math.min(intervalMs, demand.intervalMs);
      if (!demand.quietBackoffMs) {
        quiet = null;
      } else if (quiet === undefined) {
        quiet = [...demand.quietBackoffMs];
      } else if (quiet !== null) {
        const steps = demand.quietBackoffMs;
        quiet = quiet
          .slice(0, Math.min(quiet.length, steps.length))
          .map((step, index) => Math.min(step, steps[index]!));
      }
    }
    return {
      active,
      intervalMs,
      priority: active ? priority : "standard",
      quietBackoffMs: quiet ?? null,
    };
  };

  const effectiveCadence = <T>(entry: Entry<T>, demand: NormalizedDemand): number | null => {
    if (demand.intervalMs === null) return null;
    const quiet = demand.quietBackoffMs;
    if (!quiet || entry.quietStreak === 0) return demand.intervalMs;
    return Math.max(demand.intervalMs, quiet[Math.min(entry.quietStreak - 1, quiet.length - 1)]!);
  };

  /** Re-anchors the fixed-rate grid when the effective cadence changes. */
  const refreshCadence = <T>(entry: Entry<T>, anchorAt: number): void => {
    const cadence = effectiveCadence(entry, aggregate(entry));
    if (cadence === entry.cadenceMs) return;
    entry.cadenceMs = cadence;
    entry.anchor = anchorAt;
  };

  const canAutoRead = <T>(entry: Entry<T>): boolean =>
    !disposed &&
    !paused &&
    !entry.unsupported &&
    entry.subscribers.size > 0 &&
    aggregate(entry).active;

  const inBackoff = <T>(entry: Entry<T>, now: number): boolean =>
    entry.status === "error" && entry.retryAt !== null && entry.retryAt > now;

  const clearTimer = <T>(entry: Entry<T>): void => {
    if (entry.timer !== null) clock.clearTimeout(entry.timer);
    entry.timer = null;
    entry.timerDueAt = null;
  };

  const pickReader = <T>(entry: Entry<T>): Subscriber<T> | null => {
    let best: Subscriber<T> | null = null;
    for (const subscriber of entry.subscribers) {
      if (subscriber.disposed) continue;
      // Prefer the most recent active subscriber; any equivalent reader works.
      if (
        !best ||
        (subscriber.demand.active && !best.demand.active) ||
        (subscriber.demand.active === best.demand.active && subscriber.order > best.order)
      ) {
        best = subscriber;
      }
    }
    return best;
  };

  const schedule = <T>(entry: Entry<T>): void => {
    if (entry.inFlight || !canAutoRead(entry)) {
      clearTimer(entry);
      return;
    }
    const now = clock.now();
    let due = Number.POSITIVE_INFINITY;
    if (entry.status === "error" && entry.retryAt !== null) {
      // Backoff owns every automatic read of a failing key.
      due = Math.max(entry.retryAt, now);
    } else {
      if (entry.resumeDueAt !== null) due = entry.resumeDueAt;
      else if (entry.dirty) due = now;
      if (entry.cadenceMs !== null) {
        const elapsed = Math.max(0, now - entry.anchor);
        const slot = entry.anchor + (Math.floor(elapsed / entry.cadenceMs) + 1) * entry.cadenceMs;
        due = Math.min(due, slot);
      }
    }
    if (!Number.isFinite(due)) {
      clearTimer(entry);
      return;
    }
    if (entry.timer !== null && entry.timerDueAt === due) return;
    clearTimer(entry);
    entry.timerDueAt = due;
    entry.timer = clock.setTimeout(() => onTimer(entry), Math.max(0, due - now));
  };

  const onTimer = <T>(entry: Entry<T>): void => {
    entry.timer = null;
    entry.timerDueAt = null;
    if (entries.get(entry.id) !== entry || entry.inFlight || !canAutoRead(entry)) return;
    let reason: ReadReason = "interval";
    if (entry.status === "error" && entry.retryAt !== null) reason = "retry";
    else if (entry.resumeDueAt !== null) reason = entry.resumeReason;
    else if (entry.dirty) reason = "invalidate";
    startRead(entry, reason);
  };

  const startRead = <T>(entry: Entry<T>, reason: ReadReason): void => {
    clearTimer(entry);
    entry.resumeDueAt = null;
    entry.dirty = false;
    const waiters = entry.waiters.splice(0);
    const reader = pickReader(entry);
    if (!reader || disposed) {
      resolveWaiters(entry, waiters);
      return;
    }
    const now = clock.now();
    const flight: InFlight<T> = {
      epoch: entry.epoch,
      startedAt: now,
      reason,
      controller: new AbortController(),
      reader,
      waiters,
    };
    entry.inFlight = flight;
    entry.lastStartedAt = now;
    entry.status = "loading";
    readsStarted += 1;
    entry.lastStartSeq = readsStarted;
    notify(entry);
    const context: ReadContext = {
      reason,
      explicit: reason === "explicit" || waiters.length > 0,
      signal: flight.controller.signal,
      connectionId,
      connectionGeneration,
    };
    let result: Promise<T>;
    try {
      result = Promise.resolve(reader.read(context));
    } catch (error) {
      result = Promise.reject(error);
    }
    result
      .then(
        (value) => settle(entry, flight, { ok: true, value }),
        (error: unknown) => settle(entry, flight, { ok: false, error }),
      )
      .catch((error: unknown) => {
        console.error("[read-coordinator] Failed to settle a read:", error);
      });
  };

  const settle = <T>(
    entry: Entry<T>,
    flight: InFlight<T>,
    outcome: { ok: true; value: T } | { ok: false; error: unknown },
  ): void => {
    if (entry.inFlight === flight) entry.inFlight = null;
    const current = !disposed && entries.get(entry.id) === entry && flight.epoch === entry.epoch;
    if (!current) {
      // Obsolete identity: never apply, never rearm. Reset carries live
      // waiters to the replacement read; anything left here is released.
      resolveWaiters(entry, flight.waiters);
      return;
    }
    const now = clock.now();
    if (outcome.ok) {
      entry.value = outcome.value;
      entry.hasValue = true;
      entry.observedAt = flight.startedAt;
      entry.revision += 1;
      entry.status = "current";
      entry.error = undefined;
      entry.errorKind = null;
      entry.failures = 0;
      entry.retryAt = null;
      entry.unsupported = false;
      entry.quietStreak = flight.reason === "interval" ? entry.quietStreak + 1 : 0;
    } else {
      const kind = (flight.reader.classifyError ?? classifyReadError)(outcome.error);
      entry.error = outcome.error;
      entry.errorKind = kind;
      entry.quietStreak = 0;
      if (kind === "unsupported") {
        entry.unsupported = true;
        entry.status = "unsupported";
        entry.retryAt = null;
      } else {
        entry.failures += 1;
        entry.status = "error";
        const ceiling =
          kind === "auth"
            ? retryMaxMs
            : Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(entry.failures - 1, 16));
        // Jitter between 50% and 100% of the ceiling, but a failing key never
        // reads faster than its healthy cadence, nor slower than the cap.
        const jittered = Math.round(ceiling * (0.5 + random() * 0.5));
        entry.retryAt = now + Math.min(retryMaxMs, Math.max(entry.cadenceMs ?? 0, jittered));
      }
    }
    refreshCadence(entry, flight.startedAt);
    resolveWaiters(entry, flight.waiters);
    notify(entry);
    if (entry.subscribers.size === 0) {
      entry.dirty = false;
      resolveWaiters(entry, entry.waiters.splice(0));
      enforceRetention();
      return;
    }
    if (entry.waiters.length > 0) {
      startRead(entry, "explicit");
    } else if (entry.dirty && canAutoRead(entry) && !inBackoff(entry, now)) {
      startRead(entry, "invalidate");
    } else {
      schedule(entry);
    }
  };

  const evict = <T>(entry: Entry<T>): void => {
    clearTimer(entry);
    entries.delete(entry.id);
    entry.epoch += 1;
    if (entry.inFlight) {
      entry.inFlight.controller.abort();
      resolveWaiters(entry, entry.inFlight.waiters.splice(0));
      entry.inFlight = null;
    }
    resolveWaiters(entry, entry.waiters.splice(0));
  };

  const enforceRetention = (): void => {
    const idle = Array.from(entries.values())
      .filter((entry) => entry.subscribers.size === 0)
      .sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0));
    while (idle.length > maxRetained) evict(idle.shift()!);
  };

  const invalidateEntry = <T>(entry: Entry<T>): void => {
    if (entries.get(entry.id) !== entry || entry.subscribers.size === 0) return;
    if (!aggregate(entry).active) return;
    const now = clock.now();
    entry.quietStreak = 0;
    refreshCadence(entry, now);
    entry.dirty = true;
    if (entry.inFlight) return;
    if (canAutoRead(entry) && !inBackoff(entry, now)) startRead(entry, "invalidate");
    else schedule(entry);
  };

  const runReconcile = (): void => {
    if (reconcileTimer !== null) clock.clearTimeout(reconcileTimer);
    reconcileTimer = null;
    const kind = pendingReconcile;
    // Reads that started after the first coalesced signal already observe
    // the post-signal state; they need no second reconcile read.
    const since = pendingReconcileSince;
    pendingReconcile = null;
    pendingReconcileSince = null;
    if (kind === null || disposed) return;
    if (kind === "reconnect") {
      for (const entry of entries.values()) {
        entry.failures = 0;
        entry.retryAt = null;
        if (entry.unsupported) {
          entry.unsupported = false;
          entry.status = entry.hasValue ? "current" : "idle";
          entry.dirty = true;
        }
      }
    }
    if (paused) {
      if (kind === "reconnect") reconnectWhilePaused = true;
      return;
    }
    const effective: ReadReason =
      kind === "reconnect" || reconnectWhilePaused ? "reconnect" : "resume";
    reconnectWhilePaused = false;
    const now = clock.now();
    const ordered = Array.from(entries.values())
      .filter((entry) => entry.subscribers.size > 0)
      .map((entry) => ({ entry, demand: aggregate(entry) }))
      .filter(({ demand }) => demand.active)
      .sort((a, b) => PRIORITY_RANK[a.demand.priority] - PRIORITY_RANK[b.demand.priority]);
    for (const { entry, demand } of ordered) {
      if (entry.unsupported) continue;
      const observedSinceSignal = since !== null && entry.lastStartSeq > since;
      if (entry.inFlight) {
        // A running read that predates the reconnect is followed once.
        if (effective === "reconnect" && !observedSinceSignal) entry.dirty = true;
        continue;
      }
      if (observedSinceSignal && !entry.dirty && entry.status !== "error") {
        schedule(entry);
        continue;
      }
      if (effective === "resume" && inBackoff(entry, now)) {
        schedule(entry);
        continue;
      }
      const cadence = entry.cadenceMs;
      const overdue =
        cadence !== null && (entry.lastStartedAt === null || now - entry.lastStartedAt >= cadence);
      if (!(effective === "reconnect" || entry.dirty || overdue || entry.status === "error")) {
        schedule(entry);
        continue;
      }
      entry.quietStreak = 0;
      const [min, max] = READ_RESUME_SPREAD_MS[demand.priority];
      const delay = min + Math.round((max - min) * random());
      entry.cadenceMs = effectiveCadence(entry, demand);
      entry.anchor = now + delay;
      if (delay === 0) {
        startRead(entry, effective);
      } else {
        entry.resumeDueAt = now + delay;
        entry.resumeReason = effective;
        schedule(entry);
      }
    }
  };

  const requestReconcile = (kind: "resume" | "reconnect"): void => {
    if (disposed) return;
    pendingReconcile =
      kind === "reconnect" || pendingReconcile === "reconnect" ? "reconnect" : kind;
    pendingReconcileSince ??= readsStarted;
    if (reconcileTimer !== null) return;
    reconcileTimer = clock.setTimeout(runReconcile, coalesceMs);
  };

  const updatePaused = (): void => {
    const next = computePaused();
    if (next === paused) return;
    paused = next;
    if (!paused) return;
    for (const entry of entries.values()) {
      clearTimer(entry);
      if (entry.resumeDueAt !== null) {
        // A spread resume read that never started is still owed.
        entry.resumeDueAt = null;
        entry.dirty = true;
      }
    }
  };

  const onVisibilityChange = () => {
    updatePaused();
    if (!isHidden()) requestReconcile("resume");
  };
  const onFocus = () => requestReconcile("resume");
  // A network path came back: retry failed reads now rather than at backoff.
  const onOnline = () => requestReconcile("reconnect");
  doc?.addEventListener("visibilitychange", onVisibilityChange);
  win?.addEventListener("focus", onFocus);
  win?.addEventListener("pageshow", onFocus);
  win?.addEventListener("online", onOnline);

  const subscribe = <T>(options: ReadSubscriptionOptions<T>): ReadSubscription<T> => {
    const id = readKeyId(options.key);
    const now = clock.now();
    let entry = entries.get(id) as Entry<T> | undefined;
    if (!entry) {
      entry = {
        id,
        key: { ...options.key },
        subscribers: new Set(),
        epoch: 0,
        inFlight: null,
        dirty: false,
        waiters: [],
        value: undefined,
        hasValue: false,
        observedAt: null,
        revision: 0,
        status: "idle",
        error: undefined,
        errorKind: null,
        failures: 0,
        retryAt: null,
        unsupported: false,
        lastStartedAt: null,
        lastStartSeq: 0,
        anchor: now,
        cadenceMs: null,
        quietStreak: 0,
        resumeDueAt: null,
        resumeReason: "resume",
        timer: null,
        timerDueAt: null,
        idleSince: null,
      };
      entries.set(id, entry);
    }
    const owner = entry;
    owner.idleSince = null;
    const subscriber: Subscriber<T> = {
      order: ++subscriberOrder,
      read: options.read,
      demand: normalizeDemand(options.demand),
      classifyError: options.classifyError,
      onState: options.onState,
      disposed: disposed,
    };
    owner.subscribers.add(subscriber);
    refreshCadence(owner, now);

    if (!disposed) {
      if (options.readOnSubscribe === false) {
        // The consumer performs its own mount read.
        if (!owner.inFlight) owner.lastStartedAt = now;
      } else if (!owner.inFlight) {
        const fresh =
          owner.status === "current" &&
          !owner.dirty &&
          owner.observedAt !== null &&
          (owner.cadenceMs === null || now - owner.observedAt < owner.cadenceMs);
        if (fresh) {
          const state = snapshot(owner);
          queueMicrotask(() => {
            if (!subscriber.disposed) subscriber.onState?.(state);
          });
        } else if (canAutoRead(owner) && !inBackoff(owner, now)) {
          startRead(owner, "mount");
        } else if (subscriber.demand.active) {
          owner.dirty = true;
        }
      }
      schedule(owner);
    }

    const dispose = () => {
      if (subscriber.disposed) return;
      subscriber.disposed = true;
      owner.subscribers.delete(subscriber);
      if (entries.get(owner.id) !== owner) return;
      if (owner.subscribers.size > 0) {
        refreshCadence(owner, clock.now());
        schedule(owner);
        return;
      }
      clearTimer(owner);
      owner.resumeDueAt = null;
      owner.dirty = false;
      owner.idleSince = clock.now();
      // Explicit waiters queued behind a read nobody can now run.
      if (!owner.inFlight) resolveWaiters(owner, owner.waiters.splice(0));
      enforceRetention();
    };

    return {
      update(changes) {
        if (subscriber.disposed) return;
        if (changes.read) subscriber.read = changes.read;
        if (changes.onState) subscriber.onState = changes.onState;
        if (!changes.demand) return;
        const before = subscriber.demand;
        const next = normalizeDemand(changes.demand);
        subscriber.demand = next;
        const now = clock.now();
        if (before.active !== next.active || before.intervalMs !== next.intervalMs) {
          // A changed demand establishes a new cadence, as recreating an
          // interval did. An activated subscriber owns its activation read.
          owner.quietStreak = 0;
          owner.cadenceMs = null;
          if (!before.active && next.active) owner.lastStartedAt = now;
        }
        refreshCadence(owner, now);
        schedule(owner);
      },
      invalidate() {
        if (!subscriber.disposed) invalidateEntry(owner);
      },
      refresh() {
        if (subscriber.disposed || entries.get(owner.id) !== owner || disposed) {
          return Promise.resolve(snapshot(owner));
        }
        return new Promise<ReadState<T>>((resolve) => {
          owner.waiters.push(resolve);
          // An explicit action resets automatic backoff.
          owner.failures = 0;
          owner.retryAt = null;
          owner.quietStreak = 0;
          refreshCadence(owner, clock.now());
          if (!owner.inFlight) startRead(owner, "explicit");
        });
      },
      getState: () => snapshot(owner),
      dispose,
    };
  };

  const setConnection = (next: string | null): void => {
    if (next === connectionId) return;
    const previous = connectionId;
    connectionId = next;
    // Learning the identity for the first time is not a switch.
    if (previous === null || next === null || disposed) return;
    connectionGeneration += 1;
    for (const entry of Array.from(entries.values())) {
      if (entry.subscribers.size === 0) {
        evict(entry);
        continue;
      }
      clearTimer(entry);
      entry.epoch += 1;
      if (entry.inFlight) {
        entry.waiters.unshift(...entry.inFlight.waiters.splice(0));
        entry.inFlight.controller.abort();
        entry.inFlight = null;
      }
      entry.value = undefined;
      entry.hasValue = false;
      entry.observedAt = null;
      entry.status = "idle";
      entry.error = undefined;
      entry.errorKind = null;
      entry.failures = 0;
      entry.retryAt = null;
      entry.unsupported = false;
      entry.quietStreak = 0;
      entry.resumeDueAt = null;
      entry.dirty = aggregate(entry).active;
      notify(entry);
    }
    // Active keys re-read (critical first) and explicit waiters ride along;
    // an explicit waiter the pass could not serve (inactive, paused or
    // spread) reads on its own.
    pendingReconcile = "reconnect";
    runReconcile();
    for (const entry of Array.from(entries.values())) {
      if (entry.waiters.length > 0 && !entry.inFlight) startRead(entry, "explicit");
    }
  };

  return {
    subscribe,
    setConnection,
    notifyReconnected: () => requestReconcile("reconnect"),
    setDisconnected(next) {
      if (disconnected === next) return;
      disconnected = next;
      updatePaused();
      if (!next) requestReconcile("reconnect");
    },
    invalidateMatching(predicate) {
      for (const entry of Array.from(entries.values())) {
        if (predicate(entry.key)) invalidateEntry(entry);
      }
    },
    getDiagnostics() {
      return {
        paused,
        hidden: isHidden(),
        disconnected,
        connectionId,
        connectionGeneration,
        readsStarted,
        entries: Array.from(entries.values()).map((entry) => ({
          id: entry.id,
          subscribers: entry.subscribers.size,
          active: aggregate(entry).active,
          inFlight: entry.inFlight !== null,
          status: entry.status,
          cadenceMs: entry.cadenceMs,
          timerDueAt: entry.timerDueAt,
          failures: entry.failures,
        })),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (reconcileTimer !== null) clock.clearTimeout(reconcileTimer);
      reconcileTimer = null;
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      win?.removeEventListener("focus", onFocus);
      win?.removeEventListener("pageshow", onFocus);
      win?.removeEventListener("online", onOnline);
      for (const entry of Array.from(entries.values())) evict(entry);
    },
  };
}

let sharedCoordinator: ReadCoordinator | null = null;
let sharedCoordinatorFactory: (() => ReadCoordinator) | null = null;

/**
 * The renderer's shared coordinator, bound to the real document, window and
 * monotonic clock on first use.
 */
export function getReadCoordinator(): ReadCoordinator {
  sharedCoordinator ??= sharedCoordinatorFactory
    ? sharedCoordinatorFactory()
    : createReadCoordinator({
        document: typeof document === "undefined" ? null : document,
        window: typeof window === "undefined" ? null : window,
      });
  return sharedCoordinator;
}

/**
 * Forwards a confirmed transport reconnect (fresh stream, replay miss or
 * generation change, as announced through `resource-sync`) to the shared
 * coordinator. It never creates one: without subscribers there is nothing to
 * reconcile.
 */
export function notifyReadCoordinatorReconnected(): void {
  sharedCoordinator?.notifyReconnected();
}

/** Records the active server connection (see `ReadCoordinator.setConnection`). */
export function setReadCoordinatorConnection(connectionId: string | null): void {
  getReadCoordinator().setConnection(connectionId);
}

/**
 * Test seam: disposes the shared coordinator. The next `getReadCoordinator()`
 * builds a new one from `factory` (or the default real-environment one).
 */
export function resetReadCoordinatorForTests(factory?: () => ReadCoordinator): void {
  sharedCoordinator?.dispose();
  sharedCoordinator = null;
  sharedCoordinatorFactory = factory ?? null;
}
