import {
  DIFF_STATS_CHANGED_EVENT,
  type EnvironmentDiffStats,
  type EnvironmentDiffStatsChange,
  type EnvironmentDiffStatsRemoval,
} from "@orkestrator/protocol/diff-stats";
import { startWorktreeWatcher, type WorktreeWatcher } from "./worktree-watcher.js";

/**
 * Owns the diff counts for every environment, for every connected client.
 *
 * Before this, each renderer polled git itself: two clients meant two `git
 * fetch`es and two worktree walks for the same answer, the sidebar and the Files
 * panel asked separately for the environment they were both looking at, and the
 * work stopped entirely when the last window closed. The counts are a fact about
 * a worktree, not about a window, so they are computed here - once - and
 * announced.
 *
 * Scans are driven by change, not by a clock, wherever that is possible:
 *
 *  - **Local environments** get a recursive watcher. An idle environment costs
 *    nothing, and an edit shows up in about half a second instead of up to
 *    fifteen. A slow safety-net interval still runs, because a watcher can miss
 *    events under load and going quiet is worse than a wasted scan.
 *  - **Container environments** cannot be watched from the host without paying
 *    the same `docker exec` a scan costs, so they keep an interval - but one
 *    interval for the whole application rather than one per client.
 */

export interface DiffStatsTarget {
  environmentId: string;
  comparisonRef: string;
  /** Present for local environments; drives the watcher. */
  worktreePath?: string;
  containerId?: string;
  kind: "local" | "container";
}

export interface DiffScanResult {
  stats: EnvironmentDiffStats;
  /** Retained so the Files panel is served from the same scan. */
  changes: unknown[];
}

export interface DiffStatsServiceOptions {
  /** Runs the real git scan. Injected so the service is testable without git. */
  scan: (target: DiffStatsTarget) => Promise<DiffScanResult>;
  emit: (event: string, payload: unknown) => void;
  /** Interval for environments that cannot be watched. */
  pollIntervalMs?: number;
  /** Interval for watched environments; only covers missed events. */
  safetyNetIntervalMs?: number;
  now?: () => string;
  /** Milliseconds from an arbitrary origin; only differences are used. */
  monotonicNow?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  startWatcher?: typeof startWorktreeWatcher;
  onWarning?: (message: string, error: unknown) => void;
}

/** Matches the cadence the renderers used to poll at, for the unwatched case. */
export const DIFF_POLL_INTERVAL_MS = 15_000;
/** A watcher makes this a backstop, not the primary trigger. */
export const DIFF_SAFETY_NET_INTERVAL_MS = 120_000;

interface DiffStatsEntry {
  target: DiffStatsTarget;
  active: boolean;
  timer: unknown;
  watcher?: WorktreeWatcher;
  /** Invalidates callbacks from a watcher that was closed or superseded. */
  watcherGeneration: number;
  inFlight?: Promise<void>;
  /** Invalidates a scan that began before a known workspace mutation. */
  scanGeneration: number;
  /** A change arrived while a scan was running; scan again when it lands. */
  rescanRequested: boolean;
  last?: EnvironmentDiffStatsChange;
  cachedChanges?: unknown[];
  /** Monotonic stamp for the cached file list; see `cachedChanges`. */
  cachedAt?: number;
}

export class DiffStatsService {
  private readonly entries = new Map<string, DiffStatsEntry>();
  private readonly options: Required<
    Pick<DiffStatsServiceOptions, "scan" | "emit" | "pollIntervalMs" | "safetyNetIntervalMs" | "now" | "monotonicNow" | "schedule" | "cancel" | "startWatcher">
  > & { onWarning?: DiffStatsServiceOptions["onWarning"] };

  constructor(options: DiffStatsServiceOptions) {
    this.options = {
      scan: options.scan,
      emit: options.emit,
      pollIntervalMs: options.pollIntervalMs ?? DIFF_POLL_INTERVAL_MS,
      safetyNetIntervalMs: options.safetyNetIntervalMs ?? DIFF_SAFETY_NET_INTERVAL_MS,
      now: options.now ?? (() => new Date().toISOString()),
      monotonicNow: options.monotonicNow ?? (() => Date.now()),
      schedule: options.schedule ?? ((callback, intervalMs) => {
        const timer = setInterval(callback, intervalMs);
        timer.unref?.();
        return timer;
      }),
      cancel: options.cancel ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>)),
      startWatcher: options.startWatcher ?? startWorktreeWatcher,
      onWarning: options.onWarning,
    };
  }

  /**
   * Begins tracking an environment, or retargets one already tracked.
   *
   * Idempotent, because every path that could learn an environment is live -
   * start, rehydrate, a config change moving the baseline - calls it. A changed
   * target invalidates the cached counts: they described a different comparison.
   */
  track(target: DiffStatsTarget): void {
    const existing = this.entries.get(target.environmentId);
    if (existing) {
      const retargeted = !isSameTarget(existing.target, target);
      // Already tracking exactly this, and still running: nothing to do.
      if (!retargeted && existing.active) return;

      if (retargeted) {
        const hadPublishedCounts = existing.last !== undefined;
        existing.target = target;
        // The previous counts were measured against something else; drop them so
        // a stale number cannot be served from the cache or suppress an emit.
        existing.last = undefined;
        existing.cachedChanges = undefined;
        existing.cachedAt = undefined;
        existing.scanGeneration += 1;
        if (hadPublishedCounts) {
          this.emitSafely({
            environmentId: target.environmentId,
            comparisonRef: target.comparisonRef,
            computedAt: this.options.now(),
            removed: true,
          } satisfies EnvironmentDiffStatsRemoval);
        }
      }
      // Covers both a retarget and a resume from `pause`, and is idempotent for
      // an active entry whose watched path did not move.
      existing.active = true;
      this.detachWatcher(existing);
      this.attachWatcher(existing);
      this.restartTimer(existing);
      this.request(existing);
      return;
    }

    const entry: DiffStatsEntry = {
      target,
      active: true,
      timer: undefined,
      watcherGeneration: 0,
      scanGeneration: 0,
      rescanRequested: false,
    };
    this.entries.set(target.environmentId, entry);
    this.attachWatcher(entry);
    this.restartTimer(entry);
    this.request(entry);
  }

  /** Stops tracking and releases the watcher. Safe to call for unknown ids. */
  untrack(environmentId: string): void {
    const entry = this.entries.get(environmentId);
    if (!entry) return;
    entry.active = false;
    this.detachWatcher(entry);
    this.options.cancel(entry.timer);
    this.entries.delete(environmentId);
  }

  /**
   * Stops scanning an environment while keeping its last counts.
   *
   * A stopped container cannot be read, but its work is still on disk and the
   * last reading is still the truth about it - which is exactly what a user
   * needs when deciding whether to resume or delete it. Untracking would discard
   * that; leaving it active would scan a container that is not there.
   */
  pause(environmentId: string): void {
    const entry = this.entries.get(environmentId);
    if (!entry || !entry.active) return;
    entry.active = false;
    entry.rescanRequested = false;
    this.detachWatcher(entry);
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    // The file list can go stale in ways the counts cannot, because nothing will
    // refresh it while paused.
    entry.cachedChanges = undefined;
    entry.cachedAt = undefined;
  }

  /** Every environment the service holds state for, paused or not. */
  trackedIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Releases every watcher and timer; used on backend shutdown. */
  shutdown(): void {
    for (const environmentId of [...this.entries.keys()]) {
      this.untrack(environmentId);
    }
  }

  /** Authoritative snapshot for a client that just connected or remounted. */
  snapshot(): EnvironmentDiffStatsChange[] {
    const entries: EnvironmentDiffStatsChange[] = [];
    for (const entry of this.entries.values()) {
      if (entry.last) entries.push(entry.last);
    }
    return entries;
  }

  /**
   * The per-file detail behind an environment's counts, when a recent enough
   * scan is cached. Returns undefined when the caller must run its own read.
   *
   * Age-bounded on purpose. The Files panel refreshes faster than a container's
   * scan interval, so serving it an arbitrarily old cache entry would trade the
   * duplicate work for staleness the user can see. Inside the bound the two
   * surfaces share one scan; outside it, the caller reads and calls
   * {@link adoptScan} so the next reader shares that one instead.
   */
  cachedChanges(
    lookup: { worktreePath?: string; containerId?: string },
    comparisonRef: string,
    maxAgeMs: number,
  ): unknown[] | undefined {
    const entry = this.findEntry(lookup);
    if (!entry || entry.target.comparisonRef !== comparisonRef) return undefined;
    if (!entry.cachedChanges || entry.cachedAt === undefined) return undefined;
    if (this.options.monotonicNow() - entry.cachedAt > maxAgeMs) return undefined;
    return entry.cachedChanges;
  }

  /**
   * Records a scan performed outside the service so later readers can share it.
   *
   * Only the file list is adopted, never the aggregate: this scan was requested
   * by a client with its own options and did not necessarily use the flags the
   * counts are defined by.
   */
  adoptScan(
    lookup: { worktreePath?: string; containerId?: string },
    comparisonRef: string,
    changes: unknown[],
  ): void {
    const entry = this.findEntry(lookup);
    if (!entry || entry.target.comparisonRef !== comparisonRef) return;
    entry.cachedChanges = changes;
    entry.cachedAt = this.options.monotonicNow();
  }

  /** Discards per-file detail after a mutation without losing last-known counts. */
  invalidateChanges(lookup: { worktreePath?: string; containerId?: string }): void {
    const entry = this.findEntry(lookup);
    if (!entry) return;
    entry.scanGeneration += 1;
    entry.cachedChanges = undefined;
    entry.cachedAt = undefined;
    // A scan that began before the mutation cannot repopulate the cache when it
    // lands. Arrange one fresh replacement without starting a parallel scan.
    if (entry.inFlight) entry.rescanRequested = true;
  }

  private findEntry(lookup: { worktreePath?: string; containerId?: string }): DiffStatsEntry | undefined {
    for (const entry of this.entries.values()) {
      if (lookup.worktreePath && entry.target.worktreePath === lookup.worktreePath) return entry;
      if (lookup.containerId && entry.target.containerId === lookup.containerId) return entry;
    }
    return undefined;
  }

  /** Forces a scan now, e.g. after an operation known to change the tree. */
  refresh(environmentId: string): void {
    const entry = this.entries.get(environmentId);
    if (entry) this.request(entry);
  }

  /** Test seam: whether an environment ended up watched rather than polled. */
  isWatching(environmentId: string): boolean {
    return this.entries.get(environmentId)?.watcher?.watching === true;
  }

  private attachWatcher(entry: DiffStatsEntry): void {
    const { worktreePath } = entry.target;
    if (entry.target.kind !== "local" || !worktreePath) return;
    const generation = ++entry.watcherGeneration;
    let failedSynchronously = false;
    const watcher = this.options.startWatcher({
      worktreePath,
      onChange: () => {
        if (entry.active && entry.watcherGeneration === generation) this.request(entry);
      },
      onError: (error) => {
        if (entry.watcherGeneration !== generation) return;
        failedSynchronously = true;
        this.warn(`Diff watcher failed for ${entry.target.environmentId}`, error);
        // The interval is the fallback, so it has to go back to the fast cadence
        // now that change signals will no longer arrive.
        entry.watcher?.close();
        entry.watcher = undefined;
        this.restartTimer(entry);
      },
    });
    // `startWorktreeWatcher` reports setup failures synchronously. Do not restore
    // the failed watcher after its callback deliberately switched us to polling.
    if (entry.watcherGeneration !== generation || failedSynchronously) {
      watcher.close();
      return;
    }
    entry.watcher = watcher;
  }

  private detachWatcher(entry: DiffStatsEntry): void {
    entry.watcherGeneration += 1;
    entry.watcher?.close();
    entry.watcher = undefined;
  }

  private restartTimer(entry: DiffStatsEntry): void {
    this.options.cancel(entry.timer);
    if (!entry.active) return;
    const intervalMs = entry.watcher?.watching
      ? this.options.safetyNetIntervalMs
      : this.options.pollIntervalMs;
    entry.timer = this.options.schedule(() => {
      if (entry.active) this.request(entry);
    }, intervalMs);
  }

  /**
   * Requests a scan, collapsing bursts.
   *
   * A watcher can fire many times for one save, and the safety net can land on
   * top of a scan already running. At most one scan per environment runs at a
   * time; anything that arrives during one is folded into a single re-run.
   */
  private request(entry: DiffStatsEntry): void {
    if (!entry.active) return;
    if (entry.inFlight) {
      entry.rescanRequested = true;
      return;
    }

    const attempt = this.run(entry).finally(() => {
      entry.inFlight = undefined;
      if (entry.active && entry.rescanRequested) {
        entry.rescanRequested = false;
        this.request(entry);
      }
    });
    entry.inFlight = attempt;
    void attempt;
  }

  private async run(entry: DiffStatsEntry): Promise<void> {
    const target = entry.target;
    const scanGeneration = entry.scanGeneration;
    let result: DiffScanResult;
    try {
      result = await this.options.scan(target);
    } catch (error) {
      // Counts are non-critical: a container that is still starting, or a git
      // that failed, must not clear a reading that was true a moment ago.
      this.warn(`Diff scan failed for ${target.environmentId}`, error);
      return;
    }

    // The environment may have been retargeted or dropped while the scan ran.
    if (
      !entry.active
      || !isSameTarget(entry.target, target)
      || entry.scanGeneration !== scanGeneration
    ) return;

    entry.cachedChanges = result.changes;
    entry.cachedAt = this.options.monotonicNow();
    if (entry.last && isSameStats(entry.last.stats, result.stats)) return;

    const change: EnvironmentDiffStatsChange = {
      environmentId: target.environmentId,
      comparisonRef: target.comparisonRef,
      stats: result.stats,
      computedAt: this.options.now(),
    };
    entry.last = change;
    this.emitSafely(change);
  }

  private emitSafely(payload: EnvironmentDiffStatsChange | EnvironmentDiffStatsRemoval): void {
    try {
      this.options.emit(DIFF_STATS_CHANGED_EVENT, payload);
    } catch (error) {
      // One faulty event sink must not turn a best-effort background refresh
      // into an unhandled rejection or stop future scans.
      this.warn(`Failed to emit diff stats for ${payload.environmentId}`, error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.onWarning?.(message, error);
    } catch {
      // Warning reporters are observational. A broken logger must never break
      // the background scan lifecycle it is supposed to describe.
    }
  }
}

function isSameTarget(a: DiffStatsTarget, b: DiffStatsTarget): boolean {
  return a.environmentId === b.environmentId
    && a.kind === b.kind
    && a.comparisonRef === b.comparisonRef
    && a.worktreePath === b.worktreePath
    && a.containerId === b.containerId;
}

function isSameStats(a: EnvironmentDiffStats, b: EnvironmentDiffStats): boolean {
  return a.additions === b.additions
    && a.deletions === b.deletions
    && a.filesChanged === b.filesChanged
    && a.truncated === b.truncated;
}
