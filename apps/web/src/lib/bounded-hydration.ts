import type { ViewRevisionStamp, ViewSyncCapability } from "@orkestrator/protocol/view-sync";
import { RevisionRanges, approximateJsonBytes } from "./bounded-hydration-primitives";

export {
  BoundedKeySet,
  RevisionRanges,
  approximateJsonBytes,
  readViewSnapshot,
  toHydrationFetchResult,
} from "./bounded-hydration-primitives";

/**
 * Bounded subscribe-before-snapshot hydration for keyed, event-led views.
 *
 * A view such as the PR monitor or diff statistics is a live event stream
 * folded over an authoritative snapshot. The caller subscribes first, then
 * asks this controller to hydrate; events that arrive while a snapshot is in
 * flight are held in a bounded, per-key coalescing buffer rather than an
 * unbounded array, and are applied after the snapshot only when they are newer
 * than the state it captured.
 *
 * Guarantees (see `docs/architecture/event-snapshot-recovery.md`):
 *
 * - Buffered state is bounded by key count and estimated bytes. Updates for a
 *   key coalesce, keeping the highest revision, deletions included.
 * - Overflow stops buffering bodies and keeps only high-water evidence. A
 *   snapshot that does not cover that evidence is applied (it is still newer
 *   than the store) and a bounded retry obtains a sufficient one.
 * - A snapshot is applied only if it is still current for the connection epoch
 *   and for the owner generation observed while it was requested.
 * - An older event never overwrites a newer snapshot, and a removal observed
 *   during hydration never resurrects the key.
 * - One hydration in flight, at most one queued rerun. Each attempt has an
 *   owned timeout; failures retry with capped jittered backoff and end in an
 *   explicit `degraded` status instead of retrying forever.
 * - Legacy peers (no revision stamps) keep the conservative behaviour: every
 *   buffered update is replayed over the snapshot, and periodic safety checks
 *   are skipped because they would be full snapshot reads.
 *
 * The controller is transport-agnostic: callers validate payloads, translate
 * them into {@link HydrationUpdate}s, and wire reconnect and safety triggers.
 * Notifications (toasts, sounds) are passed as optional side effects so they
 * run after the state they describe, are separately bounded, and are never
 * treated as state.
 */

export interface HydrationEntry<V> {
  key: string;
  value: V;
}

/**
 * One validated live update. The controller never interprets `value`: it is
 * handed to `applyUpdate` unchanged, so a domain may encode a removal as `null`
 * or as its own removal event. Ordering (removals included) comes from `stamp`.
 */
export interface HydrationUpdate<V> {
  key: string;
  value: V | null;
  /** Owner stamp; null for a legacy peer. */
  stamp: ViewRevisionStamp | null;
}

/** Normalised answer from a domain snapshot read. */
export type HydrationFetchResult<V> =
  | { kind: "snapshot"; stamp: ViewRevisionStamp | null; entries: HydrationEntry<V>[] }
  | { kind: "unchanged"; stamp: ViewRevisionStamp }
  | { kind: "deleted"; stamp: ViewRevisionStamp }
  | { kind: "unsupported" }
  | { kind: "invalid" };

export type HydrationReason =
  | "initial"
  | "reconnect"
  | "gap"
  | "generation"
  | "overflow"
  | "safety"
  | "retry"
  | "tracking-limit"
  | "explicit";

export interface HydrationFetchRequest {
  /** Contiguously applied position, when the peer supports revisions. */
  known: ViewRevisionStamp | null;
  signal: AbortSignal;
  reason: HydrationReason;
}

/**
 * Freshness of the mirrored view.
 *
 * - `idle`: never hydrated.
 * - `hydrating`: an authoritative read is in flight and the view is not yet
 *   confirmed (mount, reconnect, gap, overflow or generation recovery).
 * - `current`: confirmed by a snapshot or `unchanged` answer; live updates apply.
 * - `stale`: the last read failed or was insufficient; a bounded retry is due.
 *   Live updates still apply.
 * - `degraded`: retries are exhausted. Live updates still apply; the next
 *   reconnect or safety check starts a fresh recovery.
 * - `unsupported`: the peer does not have the snapshot command.
 */
export type HydrationStatus =
  | "idle"
  | "hydrating"
  | "current"
  | "stale"
  | "degraded"
  | "unsupported";

export interface BoundedHydrationLimits {
  /** Distinct keys buffered while a snapshot is in flight. */
  maxBufferedKeys: number;
  /** Estimated bytes of buffered update bodies. */
  maxBufferedBytes: number;
  /** Received-revision intervals tracked above the contiguous position. */
  maxRevisionRanges: number;
  /** Per-key revisions retained above the contiguous position. */
  maxTrackedKeyRevisions: number;
  /** Notifications deferred until their state is applied. */
  maxDeferredNotifications: number;
  /** Owned timeout for one snapshot attempt. */
  snapshotTimeoutMs: number;
  /** Attempts per recovery before the view is marked degraded. */
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export const DEFAULT_BOUNDED_HYDRATION_LIMITS: BoundedHydrationLimits = {
  maxBufferedKeys: 512,
  maxBufferedBytes: 1024 * 1024,
  maxRevisionRanges: 64,
  maxTrackedKeyRevisions: 1024,
  maxDeferredNotifications: 32,
  snapshotTimeoutMs: 15_000,
  maxAttempts: 4,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
};

export interface HydrationClock {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** [0, 1); used for retry jitter. */
  random: () => number;
}

const DEFAULT_CLOCK: HydrationClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export interface HydrationDiagnostics {
  status: HydrationStatus;
  capability: ViewSyncCapability | "unknown";
  /** Snapshot reads started, including conditional reads. */
  fetches: number;
  /** Reads started, by trigger. Excludes the initial hydration. */
  reconciliations: Partial<Record<HydrationReason, number>>;
  overflows: number;
  droppedNotifications: number;
  bufferedKeys: number;
  bufferedBytes: number;
  /** Largest buffer ever held; evidence that the bounds hold. */
  peakBufferedKeys: number;
  peakBufferedBytes: number;
  trackedKeyRevisions: number;
  /** Contiguously applied position, when revisioned. */
  applied: ViewRevisionStamp | null;
}

export interface BoundedHydrationOptions<V> {
  /** Diagnostic label only. */
  name: string;
  fetchSnapshot: (request: HydrationFetchRequest) => Promise<HydrationFetchResult<V>>;
  /** Replaces the whole view from an authoritative snapshot. */
  replaceAll: (entries: HydrationEntry<V>[]) => void;
  /** Applies one update or removal. */
  applyUpdate: (key: string, value: V | null) => void;
  /** Estimated retained bytes for one buffered body. Defaults to a bounded walk. */
  estimateBytes?: (value: V | null) => number;
  limits?: Partial<BoundedHydrationLimits>;
  clock?: HydrationClock;
  onStatusChange?: (status: HydrationStatus) => void;
}

export interface BoundedHydration<V> {
  /** Routes one validated live update; `notify` runs after its state applies. */
  receive: (update: HydrationUpdate<V>, notify?: () => void) => void;
  /** Starts (or queues one rerun of) an authoritative read. */
  request: (reason: HydrationReason) => void;
  /** Transport reconnected: fences in-flight reads and rehydrates. */
  onReconnect: () => void;
  /** Low-frequency compact check; a no-op for legacy/unsupported peers. */
  safetyCheck: () => void;
  getStatus: () => HydrationStatus;
  getDiagnostics: () => HydrationDiagnostics;
  dispose: () => void;
}

interface BufferedUpdate<V> {
  value: V | null;
  stamp: ViewRevisionStamp | null;
  bytes: number;
}

interface BufferWindow<V> {
  /** Insertion order is latest-arrival order (entries are re-inserted). */
  entries: Map<string, BufferedUpdate<V>>;
  bytes: number;
  overflowed: boolean;
  /** Highest dropped stamp, in the latest generation seen; null for legacy. */
  highWater: ViewRevisionStamp | null;
  /** Received revisions for `rangesGeneration`, so coalescing loses no evidence. */
  ranges: RevisionRanges;
  rangesGeneration: string | null;
  notifications: Array<() => void>;
}

interface InFlight {
  id: number;
  epoch: number;
  known: ViewRevisionStamp | null;
  controller: AbortController;
  timeout: unknown;
  /** Generations observed on live updates while this read was outstanding. */
  generations: Set<string>;
}

interface AppliedPosition {
  generation: string;
  /** Every revision at or below this has been applied or superseded. */
  contiguous: number;
}

export function createBoundedHydration<V>(
  options: BoundedHydrationOptions<V>,
): BoundedHydration<V> {
  const limits: BoundedHydrationLimits = {
    ...DEFAULT_BOUNDED_HYDRATION_LIMITS,
    ...options.limits,
  };
  const clock = options.clock ?? DEFAULT_CLOCK;
  const estimateBytes = options.estimateBytes ?? ((value: V | null) => approximateJsonBytes(value));

  let disposed = false;
  let status: HydrationStatus = "idle";
  let capability: ViewSyncCapability | "unknown" = "unknown";
  let connectionEpoch = 0;
  let nextAttemptId = 0;
  let inFlight: InFlight | null = null;
  let window: BufferWindow<V> | null = null;
  let rerun: HydrationReason | null = null;
  let retryTimer: unknown = null;
  let failures = 0;
  let hydratedOnce = false;
  let applied: AppliedPosition | null = null;
  /** Per-key revisions above `applied.contiguous` (only while a gap is open). */
  const keyRevisions = new Map<string, number>();
  /** Revisions received above `applied.contiguous` (only while a gap is open). */
  const aheadRanges = new RevisionRanges(limits.maxRevisionRanges);
  const diagnostics = {
    fetches: 0,
    reconciliations: {} as Partial<Record<HydrationReason, number>>,
    overflows: 0,
    droppedNotifications: 0,
    peakBufferedKeys: 0,
    peakBufferedBytes: 0,
  };

  const setStatus = (next: HydrationStatus) => {
    if (status === next) return;
    status = next;
    try {
      options.onStatusChange?.(next);
    } catch (error) {
      console.error(`[${options.name}] Hydration status listener failed:`, error);
    }
  };

  const runNotification = (notify: (() => void) | undefined) => {
    if (!notify) return;
    try {
      notify();
    } catch (error) {
      console.error(`[${options.name}] Notification failed:`, error);
    }
  };

  // ---------------------------------------------------------------------
  // Applied position bookkeeping (revisioned peers only)
  // ---------------------------------------------------------------------

  const resetPosition = (next: AppliedPosition | null) => {
    applied = next;
    keyRevisions.clear();
    aheadRanges.clear();
  };

  /** Moves the contiguous position forward and drops bookkeeping below it. */
  const advanceContiguous = (position: AppliedPosition, to: number) => {
    const extended = aheadRanges.extend(to);
    if (extended <= position.contiguous) return;
    position.contiguous = extended;
    aheadRanges.prune(extended);
    for (const [key, revision] of Array.from(keyRevisions)) {
      if (revision <= extended) keyRevisions.delete(key);
    }
  };

  /** Records that `revision` was received, whether or not its body applied. */
  const recordReceived = (position: AppliedPosition, key: string, revision: number) => {
    if (revision === position.contiguous + 1) {
      advanceContiguous(position, revision);
      return;
    }
    aheadRanges.add(revision);
    const known = keyRevisions.get(key);
    if (known === undefined || known < revision) keyRevisions.set(key, revision);
  };

  /**
   * Applies a stamped update against the applied position. Returns whether the
   * body was applied: false when covered, duplicated, or older than what the
   * key already shows.
   */
  const acceptStamped = (key: string, value: V | null, stamp: ViewRevisionStamp): boolean => {
    const position = applied!;
    if (stamp.revision <= position.contiguous) return false;
    const keyRevision = keyRevisions.get(key);
    const newer = keyRevision === undefined || stamp.revision > keyRevision;
    if (newer) options.applyUpdate(key, value);
    recordReceived(position, key, stamp.revision);
    return newer;
  };

  /** Revisions above the applied position are still missing. */
  const hasOpenGap = () =>
    applied !== null && (aheadRanges.saturated || aheadRanges.hasAbove(applied.contiguous));

  const trackingExceeded = () =>
    keyRevisions.size > limits.maxTrackedKeyRevisions || aheadRanges.saturated;

  // ---------------------------------------------------------------------
  // Hydration buffer window
  // ---------------------------------------------------------------------

  const openWindow = (): BufferWindow<V> => ({
    entries: new Map(),
    bytes: 0,
    overflowed: false,
    highWater: null,
    ranges: new RevisionRanges(limits.maxRevisionRanges),
    rangesGeneration: null,
    notifications: [],
  });

  const deferNotification = (target: BufferWindow<V>, notify?: () => void) => {
    if (!notify) return;
    target.notifications.push(notify);
    // Best-effort by contract: under a flood keep the newest notifications.
    while (target.notifications.length > limits.maxDeferredNotifications) {
      target.notifications.shift();
      diagnostics.droppedNotifications += 1;
    }
  };

  const raiseHighWater = (target: BufferWindow<V>, stamp: ViewRevisionStamp | null) => {
    if (!stamp) return;
    const current = target.highWater;
    if (!current || current.generation !== stamp.generation || current.revision < stamp.revision) {
      target.highWater = { generation: stamp.generation, revision: stamp.revision };
    }
  };

  const overflow = (target: BufferWindow<V>, incoming: ViewRevisionStamp | null) => {
    diagnostics.overflows += 1;
    for (const buffered of target.entries.values()) raiseHighWater(target, buffered.stamp);
    raiseHighWater(target, incoming);
    // Stop retaining bodies: keep only the evidence a snapshot must cover.
    target.entries.clear();
    target.bytes = 0;
    target.ranges.clear();
    target.rangesGeneration = null;
    target.overflowed = true;
  };

  const buffer = (target: BufferWindow<V>, update: HydrationUpdate<V>, notify?: () => void) => {
    const { stamp } = update;
    if (target.overflowed) {
      raiseHighWater(target, stamp);
      deferNotification(target, notify);
      return;
    }
    const existing = target.entries.get(update.key);
    if (
      stamp &&
      existing?.stamp &&
      existing.stamp.generation === stamp.generation &&
      existing.stamp.revision >= stamp.revision
    ) {
      // Duplicate or out-of-order delivery of an already buffered revision.
      return;
    }
    const bytes = Math.max(0, estimateBytes(update.value));
    const nextBytes = target.bytes - (existing?.bytes ?? 0) + bytes;
    if (
      (!existing && target.entries.size >= limits.maxBufferedKeys) ||
      nextBytes > limits.maxBufferedBytes
    ) {
      overflow(target, stamp);
      deferNotification(target, notify);
      return;
    }
    // Re-insert so iteration order is latest-arrival order for legacy replay.
    target.entries.delete(update.key);
    target.entries.set(update.key, { value: update.value, stamp, bytes });
    target.bytes = nextBytes;
    diagnostics.peakBufferedKeys = Math.max(diagnostics.peakBufferedKeys, target.entries.size);
    diagnostics.peakBufferedBytes = Math.max(diagnostics.peakBufferedBytes, target.bytes);
    if (stamp) {
      if (target.rangesGeneration !== stamp.generation) {
        target.ranges.clear();
        target.rangesGeneration = stamp.generation;
      }
      target.ranges.add(stamp.revision);
    }
    deferNotification(target, notify);
  };

  /**
   * Applies a window's buffered bodies over the store: after a snapshot, or in
   * place of one when an attempt failed. Stamped bodies are filtered against
   * the applied position in revision order; legacy bodies (or bodies with no
   * baseline to compare against) replay in latest-arrival order. Deferred
   * notifications run last, after the state they describe.
   */
  const drainWindow = (target: BufferWindow<V>, legacy: boolean) => {
    const position = applied;
    if (legacy || !position) {
      for (const [key, buffered] of target.entries) options.applyUpdate(key, buffered.value);
    } else {
      const stamped = Array.from(target.entries)
        .filter(([, buffered]) => buffered.stamp?.generation === position.generation)
        .sort(([, a], [, b]) => a.stamp!.revision - b.stamp!.revision);
      // Coalescing kept one body per key; the window's ranges prove which
      // intermediate revisions were received, so they are not a gap.
      if (target.rangesGeneration === position.generation) {
        if (target.ranges.saturated) aheadRanges.saturated = true;
        else aheadRanges.merge(target.ranges);
      }
      for (const [key, buffered] of stamped) {
        const revision = buffered.stamp!.revision;
        if (revision <= position.contiguous) continue;
        const keyRevision = keyRevisions.get(key);
        if (keyRevision !== undefined && revision < keyRevision) continue;
        options.applyUpdate(key, buffered.value);
        const known = keyRevisions.get(key);
        if (known === undefined || known < revision) keyRevisions.set(key, revision);
      }
      advanceContiguous(position, position.contiguous);
    }
    target.entries.clear();
    target.bytes = 0;
    for (const notify of target.notifications.splice(0)) runNotification(notify);
  };

  const closeWindow = (legacy: boolean) => {
    const target = window;
    window = null;
    if (target) drainWindow(target, legacy);
  };

  // ---------------------------------------------------------------------
  // Attempts
  // ---------------------------------------------------------------------

  const cancelRetry = () => {
    if (retryTimer === null) return;
    clock.clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** Automatic recovery is allowed; otherwise a pending retry or trigger owns it. */
  const canAutoRecover = () => retryTimer === null && status !== "degraded";

  const start = (reason: HydrationReason) => {
    if (disposed) return;
    cancelRetry();
    window ??= openWindow();
    if (reason !== "initial") {
      diagnostics.reconciliations[reason] = (diagnostics.reconciliations[reason] ?? 0) + 1;
    }
    const known =
      capability === "revisioned" && applied
        ? { generation: applied.generation, revision: applied.contiguous }
        : null;
    const attempt: InFlight = {
      id: ++nextAttemptId,
      epoch: connectionEpoch,
      known,
      controller: new AbortController(),
      timeout: null,
      generations: new Set(),
    };
    inFlight = attempt;
    diagnostics.fetches += 1;
    // A compact safety check of a confirmed view does not flip it to pending.
    if (!(reason === "safety" && status === "current")) setStatus("hydrating");
    attempt.timeout = clock.setTimeout(() => {
      if (settle(attempt.id)) afterFailure(attempt);
    }, limits.snapshotTimeoutMs);

    let pending: Promise<HydrationFetchResult<V>>;
    try {
      pending = options.fetchSnapshot({ known, signal: attempt.controller.signal, reason });
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (result) => {
        if (settle(attempt.id)) complete(attempt, result);
      },
      () => {
        if (settle(attempt.id)) afterFailure(attempt);
      },
    );
  };

  /** Settles the attempt if it is still the live one; late answers are ignored. */
  const settle = (id: number): boolean => {
    if (disposed || !inFlight || inFlight.id !== id) return false;
    clock.clearTimeout(inFlight.timeout);
    inFlight = null;
    return true;
  };

  const runQueued = () => {
    if (disposed || inFlight || rerun === null) return false;
    const reason = rerun;
    rerun = null;
    start(reason);
    return true;
  };

  const scheduleRetry = (reason: "retry" | "overflow") => {
    failures += 1;
    if (failures >= limits.maxAttempts) {
      failures = 0;
      setStatus("degraded");
      return;
    }
    setStatus("stale");
    const base = Math.min(limits.retryMaxMs, limits.retryBaseMs * 2 ** (failures - 1));
    const delay = Math.round(base * (0.5 + 0.5 * clock.random()));
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      if (!disposed && !inFlight) start(reason);
    }, delay);
  };

  /** Failed, timed out, or answered with nothing usable. */
  const afterFailure = (attempt: InFlight) => {
    attempt.controller.abort();
    // A reconnect fenced this read; its queued rerun keeps the window open.
    if (attempt.epoch !== connectionEpoch && runQueued()) return;
    // Keep the view live between attempts: buffered updates are newer than
    // anything in the store, so apply them rather than freezing the view.
    closeWindow(capability !== "revisioned");
    if (runQueued()) return;
    scheduleRetry("retry");
  };

  const complete = (attempt: InFlight, result: HydrationFetchResult<V>) => {
    if (attempt.epoch !== connectionEpoch) {
      // A reconnect fenced this read; its queued rerun supersedes it and the
      // buffer window stays open for that rerun.
      if (!runQueued()) afterFailure(attempt);
      return;
    }
    if (result.kind === "invalid") {
      afterFailure(attempt);
      return;
    }
    if (result.kind === "unsupported") {
      capability = "unsupported";
      resetPosition(null);
      rerun = null;
      failures = 0;
      closeWindow(true);
      setStatus("unsupported");
      return;
    }

    const stamp = result.stamp;
    // Another owner generation appeared while this read was outstanding: the
    // answer may describe a replaced owner. Read again; the window stays open.
    if (stamp && Array.from(attempt.generations).some((gen) => gen !== stamp.generation)) {
      rerun ??= "generation";
      runQueued();
      return;
    }
    if (
      result.kind === "unchanged" &&
      (!attempt.known ||
        !applied ||
        attempt.known.generation !== result.stamp.generation ||
        attempt.known.revision !== result.stamp.revision)
    ) {
      // An `unchanged` answer for a position we did not ask about proves nothing.
      afterFailure(attempt);
      return;
    }

    const target = window ?? openWindow();
    window = null;
    let legacy = false;
    if (result.kind === "unchanged") {
      capability = "revisioned";
    } else if (result.kind === "deleted") {
      capability = "revisioned";
      options.replaceAll([]);
      resetPosition({ generation: result.stamp.generation, contiguous: result.stamp.revision });
    } else if (result.stamp) {
      capability = "revisioned";
      options.replaceAll(result.entries);
      resetPosition({ generation: result.stamp.generation, contiguous: result.stamp.revision });
    } else {
      capability = "legacy";
      legacy = true;
      resetPosition(null);
      options.replaceAll(result.entries);
    }
    hydratedOnce = true;

    const sufficient =
      !target.overflowed ||
      (!legacy &&
        stamp !== null &&
        target.highWater !== null &&
        target.highWater.generation === stamp.generation &&
        stamp.revision >= target.highWater.revision);
    drainWindow(target, legacy);

    if (!sufficient) {
      // Newer than the store, but updates past its revision were dropped.
      if (!runQueued()) scheduleRetry("overflow");
      return;
    }
    failures = 0;
    setStatus("current");
    if (rerun === null && (hasOpenGap() || trackingExceeded())) {
      rerun = trackingExceeded() ? "tracking-limit" : "gap";
    }
    runQueued();
  };

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  const request = (reason: HydrationReason) => {
    if (disposed) return;
    if (capability === "unsupported" && reason !== "reconnect" && reason !== "explicit") return;
    if (inFlight) {
      rerun ??= reason;
      return;
    }
    start(reason);
  };

  const receive = (update: HydrationUpdate<V>, notify?: () => void) => {
    if (disposed) return;
    const { stamp } = update;
    if (inFlight && stamp) inFlight.generations.add(stamp.generation);

    if (window) {
      buffer(window, update, notify);
      return;
    }

    if (!stamp) {
      options.applyUpdate(update.key, update.value);
      runNotification(notify);
      if (capability === "revisioned") {
        // A legacy event from a peer believed revisioned: the transport
        // reached a different backend. Fall back and re-establish state.
        capability = "legacy";
        resetPosition(null);
        if (canAutoRecover()) request("generation");
      }
      return;
    }

    if (!applied) {
      if (capability === "legacy" && hydratedOnce && canAutoRecover()) {
        // A stamped event after a legacy snapshot: the peer changed. Obtain a
        // revisioned baseline; this update is buffered for it.
        request("generation");
        if (window) {
          buffer(window, update, notify);
          return;
        }
      }
      // No baseline to order against: the update is the newest information.
      options.applyUpdate(update.key, update.value);
      runNotification(notify);
      return;
    }

    if (stamp.generation !== applied.generation) {
      if (canAutoRecover()) {
        request("generation");
        if (window) {
          buffer(window, update, notify);
          return;
        }
      }
      // Recovery is already pending; show the newest information meanwhile.
      options.applyUpdate(update.key, update.value);
      runNotification(notify);
      return;
    }

    if (acceptStamped(update.key, update.value, stamp)) runNotification(notify);
    if (!canAutoRecover()) return;
    if (trackingExceeded()) request("tracking-limit");
    else if (hasOpenGap()) request("gap");
  };

  const onReconnect = () => {
    if (disposed) return;
    connectionEpoch += 1;
    failures = 0;
    cancelRetry();
    if (capability === "unsupported") capability = "unknown";
    request("reconnect");
  };

  const safetyCheck = () => {
    if (disposed || inFlight || retryTimer !== null) return;
    if (capability === "legacy" || capability === "unsupported") return;
    // A degraded view is recovered by this low-frequency trigger.
    if (status === "degraded") failures = 0;
    request("safety");
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelRetry();
    if (inFlight) {
      clock.clearTimeout(inFlight.timeout);
      inFlight.controller.abort();
      inFlight = null;
    }
    window = null;
    rerun = null;
  };

  return {
    receive,
    request,
    onReconnect,
    safetyCheck,
    getStatus: () => status,
    getDiagnostics: () => ({
      status,
      capability,
      fetches: diagnostics.fetches,
      reconciliations: { ...diagnostics.reconciliations },
      overflows: diagnostics.overflows,
      droppedNotifications: diagnostics.droppedNotifications,
      bufferedKeys: window?.entries.size ?? 0,
      bufferedBytes: window?.bytes ?? 0,
      peakBufferedKeys: diagnostics.peakBufferedKeys,
      peakBufferedBytes: diagnostics.peakBufferedBytes,
      trackedKeyRevisions: keyRevisions.size,
      applied: applied ? { generation: applied.generation, revision: applied.contiguous } : null,
    }),
    dispose,
  };
}
