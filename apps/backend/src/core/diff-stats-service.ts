import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RecurringPriorityClass } from "@orkestrator/protocol/recurring-work";
import {
  DIFF_STATS_CHANGED_EVENT,
  type EnvironmentDiffStats,
  type EnvironmentDiffStatsChange,
  type EnvironmentDiffStatsRemoval,
  type EnvironmentDiffStatsSnapshot,
} from "@orkestrator/protocol/diff-stats";
import {
  WORKTREE_SNAPSHOT_CHANGED_EVENT,
  type WorktreeReadStamp,
  type WorktreeSnapshotFreshness,
  type WorktreeSnapshotRemoval,
  type WorktreeSnapshotRevisionsSnapshot,
  type WorktreeSnapshotState,
} from "@orkestrator/protocol/worktree-snapshots";
import { startWorktreeWatcher, type WorktreeWatcher } from "./worktree-watcher.js";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { responseDigest, semanticFileListDigest } from "./worktree-snapshot-digest.js";
import {
  WorktreeTreeSnapshots,
  type TreeSnapshotLimits,
  type TreeTarget,
} from "./worktree-tree-snapshots.js";
import {
  AdhocWorktreeReads,
  worktreeTargetKey,
  type FileListScanRequest,
  type FileListScanResult,
  type TreeWalkRequest,
  type WorktreeLookup,
} from "./worktree-adhoc-reads.js";
import type { WorkAdmissionPool } from "./work-admission.js";

/**
 * Owns the diff counts, changed-file list and file tree of every environment,
 * for every connected client.
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
 *  - **Local environments** get a recursive watcher over the worktree and its
 *    Git metadata. An idle environment costs nothing, and an edit shows up in
 *    about half a second. A slow safety-net interval still runs, because a
 *    watcher can miss events under load and going quiet is worse than a wasted
 *    scan.
 *  - **Container environments** cannot be watched from the host without paying
 *    the same `docker exec` a scan costs, so they keep an interval - but one
 *    interval for the whole application rather than one per client.
 *
 * ## One read owner per scan identity
 *
 * A tracked environment's scan identity is this service's generation, the
 * environment's target lineage (`targetGeneration`: worktree path or container
 * and comparison ref), and the working-tree option. Background scans, the
 * sidebar and every Files panel read through {@link readFileList} and join one
 * physical scan. Identities no entry covers (committed-only lists, another ref,
 * an untracked worktree) go to {@link AdhocWorktreeReads}, which joins
 * equivalent concurrent reads and never shares across identities.
 *
 * Freshness is an epoch, not an age. Every watcher hint, known mutation and
 * explicit refresh advances `dirtyEpoch`; a scan records the epoch it started
 * at. A read requires a result at least as new as the epoch current when it
 * arrived — so it may join a scan already running since the last change, but
 * an explicit refresh first advances the epoch and therefore always waits for
 * a scan that started after the click. Under qualified watcher coverage a
 * result stays valid until the next hint (a quiet worktree is never rescanned
 * because five seconds passed); without it, results are valid for
 * `fileListMaxAgeMs`.
 *
 * Publication is fenced by the target lineage and by `mutationGeneration`: a
 * scan that began before a known workspace mutation, a retarget, a pause or an
 * untrack can never publish counts, a file list, or a revision.
 *
 * Every tracked environment's file-list and tree revisions are announced as a
 * keyed view (`WORKTREE_SNAPSHOT_CHANGED_EVENT`, see
 * `@orkestrator/protocol/worktree-snapshots`) with its own contiguous revision,
 * so a client can re-read exactly when something it shows changed.
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
  /**
   * Reads a file list for an identity no tracked entry covers. Defaults to
   * `scan` for working-tree reads; committed-only reads need this.
   */
  readFiles?: (request: FileListScanRequest) => Promise<FileListScanResult>;
  /** Walks a workspace tree (bounded by the caller). */
  walkTree?: (request: TreeWalkRequest) => Promise<unknown[]>;
  /** Global admission for Git/Docker work (`git-docker-scan`); none in unit tests by default. */
  admission?: WorkAdmissionPool | null;
  /** Interval for environments that cannot be watched. */
  pollIntervalMs?: number;
  /** Interval for watched environments; only covers missed events. */
  safetyNetIntervalMs?: number;
  /** How long an unwatched target's file list may be served to a reader. */
  fileListMaxAgeMs?: number;
  treeLimits?: Partial<TreeSnapshotLimits>;
  failureRetry?: Partial<RetryPolicy>;
  watcherRetry?: Partial<RetryPolicy>;
  now?: () => string;
  /** Milliseconds from an arbitrary origin; only differences are used. */
  monotonicNow?: () => number;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  /** One-shot timers for capped retries; defaults to an unref'd `setTimeout`. */
  delay?: (callback: () => void, delayMs: number) => unknown;
  cancelDelay?: (timer: unknown) => void;
  startWatcher?: typeof startWorktreeWatcher;
  onWarning?: (message: string, error: unknown) => void;
  /**
   * Owner generation stamped on every event and snapshot. Defaults to a fresh
   * random token per service instance (see `packages/protocol/src/view-sync.ts`).
   */
  generation?: string;
  /** Content-free cost accounting; defaults to the process-wide recorder. */
  metrics?: RecurringWorkMetrics;
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** Retries per failure streak; after that only the regular cadence retries. */
  maxAttempts: number;
}

/** Matches the cadence the renderers used to poll at, for the unwatched case. */
export const DIFF_POLL_INTERVAL_MS = 15_000;
/** A watcher makes this a backstop, not the primary trigger. */
export const DIFF_SAFETY_NET_INTERVAL_MS = 120_000;
/** Unwatched file lists: comfortably under the Files panel's 5 s cadence. */
export const FILE_LIST_MAX_AGE_MS = 3_000;
export const DEFAULT_FAILURE_RETRY: RetryPolicy = { baseMs: 5_000, maxMs: 60_000, maxAttempts: 5 };
export const DEFAULT_WATCHER_RETRY: RetryPolicy = {
  baseMs: 30_000,
  maxMs: 10 * 60_000,
  maxAttempts: 5,
};

export interface FileListReadRequest {
  lookup: WorktreeLookup;
  comparisonRef: string;
  includeUncommitted: boolean;
  /** Require a scan that starts after this call (a manual refresh). */
  refresh?: boolean;
}

export interface FileListReadResult {
  changes: unknown[];
  truncated: boolean;
  /** Wire digest of `changes` (see `responseDigest`). */
  digest: string;
  /** Present when a tracked owner served the read. */
  view?: WorktreeReadStamp;
}

export interface TreeReadRequest {
  lookup: WorktreeLookup;
  refresh?: boolean;
}

export interface TreeReadResultWithView {
  tree: unknown[];
  digest: string;
  view?: WorktreeReadStamp;
}

type ScanReason = "track" | "hint" | "refresh" | "read" | "periodic" | "retry" | "rerun";

type ScanAttempt = {
  target: DiffStatsTarget;
  targetKey: string;
  targetGeneration: number;
  mutationGeneration: number;
  epoch: number;
  qualified: boolean;
  watcherGeneration: number;
  abort: AbortController;
  promise: Promise<void>;
};

type FileListBody = {
  changes: unknown[];
  truncated: boolean;
  semanticDigest: string;
  responseDigest?: string;
  epoch: number;
  qualified: boolean;
  watcherGeneration: number;
  completedAt: number;
};

interface DiffStatsEntry {
  target: DiffStatsTarget;
  targetKey: string;
  active: boolean;
  timer: unknown;
  watcher?: WorktreeWatcher;
  /** Invalidates callbacks from a watcher that was closed or superseded. */
  watcherGeneration: number;
  watcherFailures: number;
  watcherRetryTimer?: unknown;
  /** Service-unique lineage; a retarget or resume starts a new one. */
  targetGeneration: number;
  /** Invalidates a scan that began before a known workspace mutation. */
  mutationGeneration: number;
  /** Advances on every hint, mutation and explicit refresh. */
  dirtyEpoch: number;
  inFlight?: ScanAttempt;
  last?: EnvironmentDiffStatsChange;
  /** Last good file list; served only while valid for the reader's epoch. */
  fileList?: FileListBody;
  fileListRevision: number;
  failure?: { error: unknown; epoch: number; retryAt: number };
  failures: number;
  retryTimer?: unknown;
  lastScanStartedAt?: number;
  /** Last announced snapshot state; the snapshot command serves exactly this. */
  published?: WorktreeSnapshotState;
}

const MAX_READ_PASSES = 4;

export class DiffStatsService {
  /** Owner generation; see `packages/protocol/src/view-sync.ts`. */
  readonly generation: string;
  /**
   * Domain revision: incremented once per announced change or removal, so
   * clients can order events against a snapshot and detect a missed one.
   */
  private revision = 0;
  /** Contiguous revision of the worktree-snapshot view (a separate event stream). */
  private snapshotRevision = 0;
  private nextTargetGeneration = 1;
  private readonly entries = new Map<string, DiffStatsEntry>();
  private readonly options: Required<
    Pick<
      DiffStatsServiceOptions,
      | "scan"
      | "emit"
      | "pollIntervalMs"
      | "safetyNetIntervalMs"
      | "fileListMaxAgeMs"
      | "now"
      | "monotonicNow"
      | "schedule"
      | "cancel"
      | "delay"
      | "cancelDelay"
      | "startWatcher"
    >
  > & { onWarning?: DiffStatsServiceOptions["onWarning"] };
  private readonly metrics: RecurringWorkMetrics;
  private readonly admission: WorkAdmissionPool | null;
  private readonly failureRetry: RetryPolicy;
  private readonly watcherRetry: RetryPolicy;
  private readonly tree: WorktreeTreeSnapshots;
  private readonly adhoc: AdhocWorktreeReads;

  constructor(options: DiffStatsServiceOptions) {
    this.options = {
      scan: options.scan,
      emit: options.emit,
      pollIntervalMs: options.pollIntervalMs ?? DIFF_POLL_INTERVAL_MS,
      safetyNetIntervalMs: options.safetyNetIntervalMs ?? DIFF_SAFETY_NET_INTERVAL_MS,
      fileListMaxAgeMs: options.fileListMaxAgeMs ?? FILE_LIST_MAX_AGE_MS,
      now: options.now ?? (() => new Date().toISOString()),
      monotonicNow: options.monotonicNow ?? (() => Date.now()),
      schedule:
        options.schedule ??
        ((callback, intervalMs) => {
          const timer = setInterval(callback, intervalMs);
          timer.unref?.();
          return timer;
        }),
      cancel: options.cancel ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>)),
      delay:
        options.delay ??
        ((callback, delayMs) => {
          const timer = setTimeout(callback, delayMs);
          timer.unref?.();
          return timer;
        }),
      cancelDelay:
        options.cancelDelay ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
      startWatcher: options.startWatcher ?? startWorktreeWatcher,
      onWarning: options.onWarning,
    };
    this.generation = options.generation ?? randomUUID();
    this.metrics = options.metrics ?? recurringWorkMetrics;
    this.admission = options.admission ?? null;
    this.failureRetry = { ...DEFAULT_FAILURE_RETRY, ...options.failureRetry };
    this.watcherRetry = { ...DEFAULT_WATCHER_RETRY, ...options.watcherRetry };

    const walkTree =
      options.walkTree ??
      (async () => {
        throw new Error("Workspace tree reads are not configured");
      });
    this.tree = new WorktreeTreeSnapshots({
      walk: (target) => walkTree(target),
      monotonicNow: this.options.monotonicNow,
      admission: this.admission,
      metrics: this.metrics,
      limits: { maxAgeMs: this.options.fileListMaxAgeMs, ...options.treeLimits },
      coverage: (key) => {
        const entry = this.entries.get(key);
        return {
          qualified: entry ? this.isQualified(entry) : false,
          watcherGeneration: entry?.watcherGeneration ?? -1,
        };
      },
      onRevision: (key) => {
        const entry = this.entries.get(key);
        if (entry) this.publishSnapshot(entry);
      },
    });
    const scan = this.options.scan;
    this.adhoc = new AdhocWorktreeReads({
      admission: this.admission,
      metrics: this.metrics,
      walkTree,
      readFiles:
        options.readFiles ??
        (async (request) => {
          if (!request.includeUncommitted) {
            throw new Error("Committed-only file lists are not configured");
          }
          const result = await scan({
            environmentId: "adhoc",
            kind: request.kind,
            worktreePath: request.worktreePath,
            containerId: request.containerId,
            comparisonRef: request.comparisonRef,
          });
          return { changes: result.changes, truncated: result.stats.truncated };
        }),
    });
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
        existing.targetKey = worktreeTargetKey(target);
        // The previous counts were measured against something else; drop them so
        // a stale number cannot be served from the cache or suppress an emit.
        existing.last = undefined;
        if (hadPublishedCounts) {
          this.announce({
            environmentId: target.environmentId,
            comparisonRef: target.comparisonRef,
            computedAt: this.options.now(),
            removed: true,
          } satisfies EnvironmentDiffStatsRemoval);
        }
      }
      // A retarget or a resume from `pause` starts a new lineage: nothing
      // observed before it may be served or published after it.
      this.beginLineage(existing);
      existing.active = true;
      this.detachWatcher(existing);
      this.attachWatcher(existing);
      this.restartTimer(existing);
      this.request(existing, "track");
      this.publishSnapshot(existing);
      return;
    }

    const entry: DiffStatsEntry = {
      target,
      targetKey: worktreeTargetKey(target),
      active: true,
      timer: undefined,
      watcherGeneration: 0,
      watcherFailures: 0,
      targetGeneration: 0,
      mutationGeneration: 0,
      dirtyEpoch: 0,
      fileListRevision: 0,
      failures: 0,
    };
    this.entries.set(target.environmentId, entry);
    this.beginLineage(entry);
    this.attachWatcher(entry);
    this.restartTimer(entry);
    this.request(entry, "track");
  }

  /**
   * Stops tracking and releases the watcher. Safe to call for unknown ids.
   *
   * Published counts are withdrawn with a removal event: the snapshot no longer
   * contains them, and a client must not keep a deleted environment's badge
   * while a conditional read reports its view as unchanged.
   */
  untrack(environmentId: string): void {
    const entry = this.release(environmentId);
    if (!entry) return;
    if (entry.published) {
      this.announceSnapshot({ environmentId, removed: true } satisfies WorktreeSnapshotRemoval);
    }
    if (!entry.last) return;
    this.announce({
      environmentId,
      comparisonRef: entry.target.comparisonRef,
      computedAt: this.options.now(),
      removed: true,
    } satisfies EnvironmentDiffStatsRemoval);
  }

  private release(environmentId: string): DiffStatsEntry | undefined {
    const entry = this.entries.get(environmentId);
    if (!entry) return undefined;
    entry.active = false;
    this.stopWork(entry);
    this.entries.delete(environmentId);
    this.tree.release(environmentId);
    return entry;
  }

  /** Releases watcher, timers, retry timers and any queued admission wait. */
  private stopWork(entry: DiffStatsEntry): void {
    entry.mutationGeneration += 1;
    entry.inFlight?.abort.abort();
    this.detachWatcher(entry);
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    this.cancelRetryTimers(entry);
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
    this.stopWork(entry);
    // The file list and tree can go stale in ways the counts cannot, because
    // nothing will refresh them while paused; a late scan cannot restore them.
    entry.fileList = undefined;
    entry.failure = undefined;
    this.tree.release(environmentId);
    this.publishSnapshot(entry);
  }

  /** Every environment the service holds state for, paused or not. */
  trackedIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Releases every watcher and timer; used on backend shutdown. */
  shutdown(): void {
    let publishedCounts = false;
    let publishedSnapshots = false;
    for (const environmentId of Array.from(this.entries.keys())) {
      const entry = this.release(environmentId);
      if (entry?.last) publishedCounts = true;
      if (entry?.published) publishedSnapshots = true;
    }
    // No per-environment removals on shutdown, but the snapshot did change:
    // advance the revision so a conditional read cannot answer `unchanged`.
    if (publishedCounts) this.revision += 1;
    if (publishedSnapshots) this.snapshotRevision += 1;
  }

  /** Published counts, without revision metadata. */
  snapshot(): EnvironmentDiffStatsChange[] {
    const entries: EnvironmentDiffStatsChange[] = [];
    for (const entry of this.entries.values()) {
      if (entry.last) entries.push(entry.last);
    }
    return entries;
  }

  /** Current owner generation and the revision of the last announced event. */
  currentRevision(): { generation: string; revision: number } {
    return { generation: this.generation, revision: this.revision };
  }

  /**
   * Authoritative client snapshot, captured synchronously with its revision:
   * every announced change or removal up to `revision` is reflected in
   * `entries`, and none after it.
   */
  revisionedSnapshot(): Required<EnvironmentDiffStatsSnapshot> {
    return { entries: this.snapshot(), generation: this.generation, revision: this.revision };
  }

  /** Announced worktree-snapshot states (never an unannounced live value). */
  worktreeSnapshotEntries(): WorktreeSnapshotState[] {
    const entries: WorktreeSnapshotState[] = [];
    for (const entry of this.entries.values()) {
      if (entry.published) entries.push({ ...entry.published });
    }
    return entries;
  }

  currentWorktreeRevision(): { generation: string; revision: number } {
    return { generation: this.generation, revision: this.snapshotRevision };
  }

  revisionedWorktreeSnapshot(): Required<WorktreeSnapshotRevisionsSnapshot> {
    return {
      entries: this.worktreeSnapshotEntries(),
      generation: this.generation,
      revision: this.snapshotRevision,
    };
  }

  /**
   * The changed-file list for one scan identity.
   *
   * A tracked environment whose target, comparison ref and working-tree option
   * match is served by its owner: the cached result while valid for this
   * request's epoch, otherwise by joining or starting that owner's scan — the
   * same scan the diff counts come from. Anything else is an ad hoc identity.
   * A failed scan rejects; the last good list is retained for later reads.
   */
  async readFileList(request: FileListReadRequest): Promise<FileListReadResult> {
    const entry = this.findEntry(request.lookup);
    if (
      !entry ||
      !entry.active ||
      !request.includeUncommitted ||
      entry.target.comparisonRef !== request.comparisonRef
    ) {
      return this.readAdhocFileList(request);
    }
    return this.readTrackedFileList(entry, request);
  }

  /** The workspace tree; see {@link WorktreeTreeSnapshots}. */
  async readTree(request: TreeReadRequest): Promise<TreeReadResultWithView> {
    const entry = this.findEntry(request.lookup);
    const environmentId = entry?.target.environmentId;
    if (!entry || !entry.active || !environmentId || !this.tree.has(environmentId)) {
      return this.readAdhocTree(request);
    }
    const targetGeneration = entry.targetGeneration;
    let result;
    try {
      result = await this.tree.read(environmentId, { refresh: request.refresh });
    } catch (error) {
      if (
        this.entries.get(environmentId) !== entry ||
        entry.targetGeneration !== targetGeneration
      ) {
        return this.readAdhocTree(request);
      }
      throw error;
    }
    return {
      tree: result.tree,
      digest: result.digest,
      view: this.readStamp(entry, result.revision),
    };
  }

  /**
   * A known workspace mutation (revert, delete, move, create, copy): scans and
   * walks that began before it may not publish, and every reader after it gets
   * a post-mutation result. Last-known counts are kept.
   */
  invalidateChanges(lookup: WorktreeLookup): void {
    this.adhoc.invalidateTarget(lookup);
    const entry = this.findEntry(lookup);
    if (!entry) return;
    entry.mutationGeneration += 1;
    entry.dirtyEpoch += 1;
    this.tree.invalidate(entry.target.environmentId);
  }

  /**
   * The comparison base behind a target moved outside any watched path — for
   * example a container fetch (step 04's fetch policy) that advanced
   * `origin/<ref>`. Marks the file list dirty and rescans once (joining or
   * following a running scan) without fencing it: an in-flight result is an
   * older observation, not a wrong one, and the rescan supersedes it. The
   * tree is unaffected. Ad hoc reads of the target stop being joinable.
   */
  invalidateBaseline(lookup: WorktreeLookup): void {
    this.adhoc.invalidateTarget(lookup);
    const entry = this.findEntry(lookup);
    if (entry) this.request(entry, "hint");
  }

  /** Forces a scan now, e.g. after an operation known to change the tree. */
  refresh(environmentId: string): void {
    const entry = this.entries.get(environmentId);
    if (entry) this.request(entry, "refresh");
  }

  /** Test seam: whether an environment ended up watched rather than polled. */
  isWatching(environmentId: string): boolean {
    return this.entries.get(environmentId)?.watcher?.watching === true;
  }

  /** Content-free per-owner state for diagnostics and tests. */
  status(): {
    entries: number;
    active: number;
    watched: number;
    inFlight: number;
    retryTimers: number;
    tree: ReturnType<WorktreeTreeSnapshots["status"]>;
    adhocPending: number;
  } {
    let active = 0;
    let watched = 0;
    let inFlight = 0;
    let retryTimers = 0;
    for (const entry of this.entries.values()) {
      if (entry.active) active += 1;
      if (this.isQualified(entry)) watched += 1;
      if (entry.inFlight) inFlight += 1;
      if (entry.retryTimer !== undefined) retryTimers += 1;
      if (entry.watcherRetryTimer !== undefined) retryTimers += 1;
    }
    return {
      entries: this.entries.size,
      active,
      watched,
      inFlight,
      retryTimers,
      tree: this.tree.status(),
      adhocPending: this.adhoc.pending,
    };
  }

  private findEntry(lookup: WorktreeLookup): DiffStatsEntry | undefined {
    let key: string;
    try {
      key = worktreeTargetKey(lookup);
    } catch {
      return undefined;
    }
    for (const entry of this.entries.values()) {
      if (entry.targetKey === key) return entry;
    }
    return undefined;
  }

  private beginLineage(entry: DiffStatsEntry): void {
    entry.inFlight?.abort.abort();
    entry.targetGeneration = this.nextTargetGeneration++;
    entry.mutationGeneration += 1;
    entry.fileList = undefined;
    entry.fileListRevision = 0;
    entry.failure = undefined;
    entry.failures = 0;
    entry.watcherFailures = 0;
    this.cancelRetryTimers(entry);
    this.tree.register(this.treeTarget(entry));
  }

  private treeTarget(entry: DiffStatsEntry): TreeTarget {
    return {
      key: entry.target.environmentId,
      kind: entry.target.kind,
      worktreePath: entry.target.worktreePath,
      containerId: entry.target.containerId,
      admissionTarget: `${entry.targetKey}#tree`,
    };
  }

  private isQualified(entry: DiffStatsEntry): boolean {
    const watcher = entry.watcher;
    return entry.active && watcher?.watching === true && (watcher.qualified ?? true);
  }

  private attachWatcher(entry: DiffStatsEntry): void {
    const { worktreePath } = entry.target;
    if (entry.target.kind !== "local" || !worktreePath) return;
    const generation = ++entry.watcherGeneration;
    let failedSynchronously = false;
    const current = () => entry.active && entry.watcherGeneration === generation;
    const watcher = this.options.startWatcher({
      worktreePath,
      comparisonRef: entry.target.comparisonRef,
      onChange: (hint) => {
        if (!current()) return;
        // Watcher events are hints: they only mark views dirty. A hint that
        // cannot say which view it touched (or an overflow) dirties both.
        if (!hint || hint.tree || hint.overflow) this.tree.hint(entry.target.environmentId);
        if (!hint || hint.fileList || hint.overflow) this.request(entry, "hint");
      },
      onCoverageChange: () => {
        if (!current()) return;
        this.restartTimer(entry);
        this.publishSnapshot(entry);
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
        this.scheduleWatcherRetry(entry);
        this.publishSnapshot(entry);
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

  /**
   * Re-establishes a failed watcher with capped backoff. Events during the
   * outage were never observed, so a successful re-attach marks both views
   * dirty and rescans once.
   */
  private scheduleWatcherRetry(entry: DiffStatsEntry): void {
    if (entry.watcherRetryTimer !== undefined) return;
    entry.watcherFailures += 1;
    if (entry.watcherFailures > this.watcherRetry.maxAttempts) return;
    const delayMs = backoff(this.watcherRetry, entry.watcherFailures);
    const lineage = entry.targetGeneration;
    entry.watcherRetryTimer = this.options.delay(() => {
      entry.watcherRetryTimer = undefined;
      if (
        !entry.active ||
        entry.targetGeneration !== lineage ||
        this.entries.get(entry.target.environmentId) !== entry ||
        entry.watcher
      ) {
        return;
      }
      this.attachWatcher(entry);
      const reattached = entry.watcher as WorktreeWatcher | undefined;
      if (!reattached?.watching) return;
      this.restartTimer(entry);
      this.tree.hint(entry.target.environmentId);
      this.request(entry, "hint");
      this.publishSnapshot(entry);
    }, delayMs);
  }

  private cancelRetryTimers(entry: DiffStatsEntry): void {
    if (entry.retryTimer !== undefined) this.options.cancelDelay(entry.retryTimer);
    if (entry.watcherRetryTimer !== undefined) this.options.cancelDelay(entry.watcherRetryTimer);
    entry.retryTimer = undefined;
    entry.watcherRetryTimer = undefined;
  }

  private restartTimer(entry: DiffStatsEntry): void {
    this.options.cancel(entry.timer);
    entry.timer = undefined;
    if (!entry.active) return;
    const intervalMs = this.isQualified(entry)
      ? this.options.safetyNetIntervalMs
      : this.options.pollIntervalMs;
    entry.timer = this.options.schedule(() => this.periodic(entry, intervalMs), intervalMs);
  }

  /**
   * A periodic (safety or poll) tick. It never queues a rerun behind a running
   * scan, is skipped while a failure is backing off, and is skipped when a
   * scan for any reason started within half an interval — a Files-panel read
   * of a container already refreshed the counts it would have produced.
   */
  private periodic(entry: DiffStatsEntry, intervalMs: number): void {
    if (!entry.active) return;
    const now = this.options.monotonicNow();
    const recentlyScanned =
      entry.lastScanStartedAt !== undefined && now - entry.lastScanStartedAt < intervalMs / 2;
    const backingOff = entry.failure !== undefined && now < entry.failure.retryAt;
    if (recentlyScanned || backingOff) {
      this.metrics.requested("diff-scan");
      this.metrics.coalesced("diff-scan");
      return;
    }
    this.request(entry, "periodic");
  }

  /**
   * Requests a scan, collapsing bursts.
   *
   * A watcher can fire many times for one save, and the safety net can land on
   * top of a scan already running. At most one scan per environment runs at a
   * time. A genuine change (hint, mutation, refresh, retarget) that arrives
   * during one advances the epoch, which is what queues the single rerun; a
   * periodic tick or read landing during a scan joins it and queues nothing,
   * so a slow scan cannot turn the clock into a permanent rerun loop.
   */
  private request(entry: DiffStatsEntry, reason: ScanReason): void {
    if (!entry.active) return;
    if (reason === "track" || reason === "hint" || reason === "refresh") entry.dirtyEpoch += 1;
    this.metrics.requested("diff-scan");
    if (entry.inFlight) {
      this.metrics.coalesced("diff-scan");
      return;
    }
    this.startScan(entry, priorityFor(reason));
  }

  private startScan(
    entry: DiffStatsEntry,
    priority: Exclude<RecurringPriorityClass, "critical">,
  ): void {
    const attempt: ScanAttempt = {
      target: entry.target,
      targetKey: entry.targetKey,
      targetGeneration: entry.targetGeneration,
      mutationGeneration: entry.mutationGeneration,
      epoch: entry.dirtyEpoch,
      qualified: this.isQualified(entry),
      watcherGeneration: entry.watcherGeneration,
      abort: new AbortController(),
      promise: Promise.resolve(),
    };
    entry.lastScanStartedAt = this.options.monotonicNow();
    entry.inFlight = attempt;
    attempt.promise = this.runScan(entry, attempt, priority).finally(() => {
      if (entry.inFlight === attempt) entry.inFlight = undefined;
      if (
        entry.active &&
        this.entries.get(entry.target.environmentId) === entry &&
        entry.dirtyEpoch > attempt.epoch
      ) {
        this.request(entry, "rerun");
      }
    });
  }

  private async runScan(
    entry: DiffStatsEntry,
    attempt: ScanAttempt,
    priority: Exclude<RecurringPriorityClass, "critical">,
  ): Promise<void> {
    let result: DiffScanResult;
    try {
      const work = () => this.metrics.observe("diff-scan", () => this.options.scan(attempt.target));
      result = this.admission
        ? await this.admission.run(
            {
              kind: "diff-scan",
              priority,
              target: attempt.targetKey,
              signal: attempt.abort.signal,
            },
            work,
          )
        : await work();
    } catch (error) {
      if (!this.isLive(entry, attempt)) return;
      // Counts are non-critical: a container that is still starting, or a git
      // that failed, must not clear a reading that was true a moment ago.
      this.recordFailure(entry, attempt, error);
      return;
    }

    // The environment may have been retargeted, paused, dropped or mutated
    // while the scan ran.
    if (!this.isLive(entry, attempt) || entry.mutationGeneration !== attempt.mutationGeneration) {
      return;
    }
    this.recordSuccess(entry, attempt, result);
  }

  private isLive(entry: DiffStatsEntry, attempt: ScanAttempt): boolean {
    return (
      entry.active &&
      this.entries.get(entry.target.environmentId) === entry &&
      entry.targetGeneration === attempt.targetGeneration
    );
  }

  private recordSuccess(entry: DiffStatsEntry, attempt: ScanAttempt, result: DiffScanResult): void {
    const target = attempt.target;
    entry.failure = undefined;
    entry.failures = 0;
    if (entry.retryTimer !== undefined) {
      this.options.cancelDelay(entry.retryTimer);
      entry.retryTimer = undefined;
    }
    const changes = Array.isArray(result.changes) ? result.changes : [];
    const truncated = result.stats?.truncated === true;
    const semanticDigest = semanticFileListDigest(changes, truncated);
    if (entry.fileList?.semanticDigest !== semanticDigest) entry.fileListRevision += 1;
    entry.fileList = {
      changes,
      truncated,
      semanticDigest,
      epoch: attempt.epoch,
      qualified: attempt.qualified,
      watcherGeneration: attempt.watcherGeneration,
      completedAt: this.options.monotonicNow(),
    };

    if (entry.last && isSameStats(entry.last.stats, result.stats)) {
      this.metrics.outcome("diff-scan", "unchanged");
    } else {
      this.metrics.outcome("diff-scan", "changed");
      const change: EnvironmentDiffStatsChange = {
        environmentId: target.environmentId,
        comparisonRef: target.comparisonRef,
        stats: result.stats,
        computedAt: this.options.now(),
      };
      entry.last = change;
      this.announce(change);
    }
    this.publishSnapshot(entry);
  }

  /** Last good results stay; freshness says they are stale; retries are capped. */
  private recordFailure(entry: DiffStatsEntry, attempt: ScanAttempt, error: unknown): void {
    entry.failures += 1;
    const delayMs = backoff(this.failureRetry, entry.failures);
    entry.failure = {
      error,
      epoch: attempt.epoch,
      retryAt: this.options.monotonicNow() + delayMs,
    };
    this.warn(`Diff scan failed for ${attempt.target.environmentId}`, error);
    if (entry.retryTimer !== undefined) this.options.cancelDelay(entry.retryTimer);
    entry.retryTimer = undefined;
    if (entry.failures <= this.failureRetry.maxAttempts) {
      const lineage = entry.targetGeneration;
      entry.retryTimer = this.options.delay(() => {
        entry.retryTimer = undefined;
        if (entry.targetGeneration !== lineage) return;
        this.request(entry, "retry");
      }, delayMs);
    }
    this.publishSnapshot(entry);
  }

  private async readTrackedFileList(
    entry: DiffStatsEntry,
    request: FileListReadRequest,
  ): Promise<FileListReadResult> {
    this.metrics.requested("file-list-read");
    // A manual refresh is itself an invalidation: it needs a scan that starts
    // after the click, never the answer of one already running.
    if (request.refresh) entry.dirtyEpoch += 1;
    const required = entry.dirtyEpoch;
    const lineage = entry.targetGeneration;
    let counted = false;
    const count = (outcome: "hit" | "join" | "miss") => {
      if (counted) return;
      counted = true;
      if (outcome === "hit") this.metrics.cacheHit("file-list-read");
      else if (outcome === "join") this.metrics.coalesced("file-list-read");
      else this.metrics.cacheMiss("file-list-read");
    };

    for (let pass = 0; pass < MAX_READ_PASSES; pass += 1) {
      if (
        !entry.active ||
        entry.targetGeneration !== lineage ||
        this.entries.get(entry.target.environmentId) !== entry
      ) {
        // Retargeted, paused or dropped mid-read: the requested identity is no
        // longer this owner's, so read it as what it now is.
        return this.readAdhocFileList(request);
      }
      const body = entry.fileList;
      if (body && body.epoch >= required && this.isFileListValid(entry, body)) {
        count("hit");
        return this.fileListResult(entry, body);
      }
      const failure = entry.failure;
      if (
        failure &&
        failure.epoch >= required &&
        !entry.inFlight &&
        this.options.monotonicNow() < failure.retryAt
      ) {
        count("hit");
        throw failure.error;
      }
      if (entry.inFlight) {
        count("join");
        await entry.inFlight.promise;
        continue;
      }
      count("miss");
      this.request(entry, "read");
      if (entry.inFlight) await (entry.inFlight as ScanAttempt).promise;
    }
    const body = entry.fileList;
    if (body && body.epoch >= required) return this.fileListResult(entry, body);
    if (entry.failure) throw entry.failure.error;
    throw new Error("Worktree changed faster than its file list could be read");
  }

  private isFileListValid(entry: DiffStatsEntry, body: FileListBody): boolean {
    if (
      this.isQualified(entry) &&
      body.qualified &&
      body.watcherGeneration === entry.watcherGeneration
    ) {
      return true;
    }
    return this.options.monotonicNow() - body.completedAt <= this.options.fileListMaxAgeMs;
  }

  private fileListResult(entry: DiffStatsEntry, body: FileListBody): FileListReadResult {
    body.responseDigest ??= responseDigest(body.changes);
    return {
      changes: body.changes,
      truncated: body.truncated,
      digest: body.responseDigest,
      view: this.readStamp(entry, entry.fileListRevision),
    };
  }

  private readStamp(entry: DiffStatsEntry, revision: number): WorktreeReadStamp {
    return {
      generation: this.generation,
      environmentId: entry.target.environmentId,
      targetGeneration: entry.targetGeneration,
      revision,
      freshness: this.freshnessOf(entry),
      watched: this.isQualified(entry),
    };
  }

  private async readAdhocFileList(request: FileListReadRequest): Promise<FileListReadResult> {
    const kind = request.lookup.worktreePath ? "local" : "container";
    const result = await this.adhoc.readFileList({
      kind,
      worktreePath: request.lookup.worktreePath,
      containerId: request.lookup.containerId,
      comparisonRef: request.comparisonRef,
      includeUncommitted: request.includeUncommitted,
      refresh: request.refresh,
    });
    return { changes: result.changes, truncated: result.truncated, digest: result.digest };
  }

  private async readAdhocTree(request: TreeReadRequest): Promise<TreeReadResultWithView> {
    const kind = request.lookup.worktreePath ? "local" : "container";
    return this.adhoc.readTree({
      kind,
      worktreePath: request.lookup.worktreePath,
      containerId: request.lookup.containerId,
      refresh: request.refresh,
    });
  }

  private freshnessOf(entry: DiffStatsEntry): WorktreeSnapshotFreshness {
    if (!entry.active) return "stale";
    if (entry.failure) return entry.fileList ? "stale" : "failed";
    return "current";
  }

  /**
   * Announces an environment's snapshot state when it differs from the last
   * announcement. Nothing is announced before there is something to say (a
   * scan result, a failure or a tree walk); after that every change is.
   */
  private publishSnapshot(entry: DiffStatsEntry): void {
    const environmentId = entry.target.environmentId;
    if (this.entries.get(environmentId) !== entry) return;
    const treeRevision = this.tree.revisionOf(environmentId);
    if (!entry.published && !entry.fileList && !entry.failure && treeRevision === 0) return;
    const state: WorktreeSnapshotState = {
      environmentId,
      targetGeneration: entry.targetGeneration,
      comparisonRef: entry.target.comparisonRef,
      fileListRevision: entry.fileListRevision,
      treeRevision,
      freshness: this.freshnessOf(entry),
      watched: this.isQualified(entry),
    };
    if (entry.published && isSameSnapshotState(entry.published, state)) return;
    entry.published = state;
    this.announceSnapshot(state);
  }

  private announceSnapshot(payload: WorktreeSnapshotState | WorktreeSnapshotRemoval): void {
    this.snapshotRevision += 1;
    this.emitSafely(WORKTREE_SNAPSHOT_CHANGED_EVENT, payload.environmentId, {
      ...payload,
      generation: this.generation,
      revision: this.snapshotRevision,
    });
  }

  /**
   * Stamps and emits one change or removal. The revision advances even when
   * the sink throws, so a client that missed it sees a gap.
   */
  private announce(payload: EnvironmentDiffStatsChange | EnvironmentDiffStatsRemoval): void {
    this.revision += 1;
    this.emitSafely(DIFF_STATS_CHANGED_EVENT, payload.environmentId, {
      ...payload,
      generation: this.generation,
      revision: this.revision,
    });
  }

  private emitSafely(event: string, environmentId: string, payload: unknown): void {
    try {
      this.options.emit(event, payload);
    } catch (error) {
      // One faulty event sink must not turn a best-effort background refresh
      // into an unhandled rejection or stop future scans.
      const what = event === DIFF_STATS_CHANGED_EVENT ? "diff stats" : "worktree snapshot";
      this.warn(`Failed to emit ${what} for ${environmentId}`, error);
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

function priorityFor(reason: ScanReason): Exclude<RecurringPriorityClass, "critical"> {
  switch (reason) {
    case "read":
    case "refresh":
      return "interactive";
    case "hint":
    case "rerun":
      return "progress";
    default:
      return "discovery";
  }
}

function backoff(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.baseMs * 2 ** Math.max(0, attempt - 1), policy.maxMs);
}

function isSameTarget(a: DiffStatsTarget, b: DiffStatsTarget): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.kind === b.kind &&
    a.comparisonRef === b.comparisonRef &&
    normalizePath(a.worktreePath) === normalizePath(b.worktreePath) &&
    a.containerId === b.containerId
  );
}

function normalizePath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : path.resolve(value);
}

function isSameStats(a: EnvironmentDiffStats, b: EnvironmentDiffStats): boolean {
  return (
    a.additions === b.additions &&
    a.deletions === b.deletions &&
    a.filesChanged === b.filesChanged &&
    a.truncated === b.truncated
  );
}

function isSameSnapshotState(a: WorktreeSnapshotState, b: WorktreeSnapshotState): boolean {
  return (
    a.targetGeneration === b.targetGeneration &&
    a.comparisonRef === b.comparisonRef &&
    a.fileListRevision === b.fileListRevision &&
    a.treeRevision === b.treeRevision &&
    a.freshness === b.freshness &&
    a.watched === b.watched
  );
}
