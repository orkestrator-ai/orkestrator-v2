import type { RecurringPriorityClass } from "@orkestrator/protocol/recurring-work";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { responseDigest } from "./worktree-snapshot-digest.js";
import type { WorkAdmissionPool } from "./work-admission.js";

/**
 * Owns the Files panel's workspace tree for each tracked environment.
 *
 * Tree membership and Git status are different facts: an empty folder or an
 * ignored file changes the tree without changing a single diff line, and an
 * edit changes the diff without changing the tree. So the tree has its own
 * owner, its own cache and its own revision, fed by the same watcher hints as
 * the file list but invalidated independently.
 *
 * Reads are served from the cached walk when it is still valid:
 *
 * - under **qualified watcher coverage**, valid until a tree-relevant hint,
 *   a mutation or an explicit refresh (no age bound — a quiet watched worktree
 *   is not re-walked because five seconds passed);
 * - otherwise (containers, a failed or unqualified watcher) for
 *   `maxAgeMs`, joining any walk already running.
 *
 * While a client has read the tree recently (`demandWindowMs`), a relevant
 * hint re-walks it proactively so the revision — and the announced event —
 * advances without waiting for the next read. The cache is bounded by entry
 * count and bytes; an evicted body keeps its digest and revision, so eviction
 * never rewinds or re-announces a revision.
 */

export interface TreeTarget {
  /** Owner key; the environment id. */
  key: string;
  kind: "local" | "container";
  worktreePath?: string;
  containerId?: string;
  /** Admission identity; tree walks do not queue behind the same target's Git scan. */
  admissionTarget: string;
}

export interface TreeCoverage {
  /** Qualified watcher coverage for this target right now. */
  qualified: boolean;
  /** Changes whenever the watcher is replaced; a walk under an older watcher is age-bounded. */
  watcherGeneration: number;
}

export interface TreeReadResult {
  tree: unknown[];
  digest: string;
  revision: number;
}

export interface TreeSnapshotLimits {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  maxAgeMs: number;
  demandWindowMs: number;
  failureRetryBaseMs: number;
  failureRetryMaxMs: number;
}

export const DEFAULT_TREE_SNAPSHOT_LIMITS: TreeSnapshotLimits = {
  maxEntries: 32,
  maxBytes: 16 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  maxAgeMs: 3_000,
  demandWindowMs: 60_000,
  failureRetryBaseMs: 5_000,
  failureRetryMaxMs: 60_000,
};

export interface WorktreeTreeSnapshotsOptions {
  walk: (target: TreeTarget) => Promise<unknown[]>;
  monotonicNow: () => number;
  coverage: (key: string) => TreeCoverage;
  admission?: WorkAdmissionPool | null;
  metrics?: RecurringWorkMetrics;
  limits?: Partial<TreeSnapshotLimits>;
  /** A tree revision advanced; the owner announces it. */
  onRevision?: (key: string) => void;
}

type TreeBody = {
  tree: unknown[];
  bytes: number;
  epoch: number;
  qualifiedAtWalk: boolean;
  watcherGeneration: number;
  completedAt: number;
};

type TreeAttempt = {
  epoch: number;
  mutationGeneration: number;
  promise: Promise<void>;
  abort: AbortController;
  /** Set when the walk published; serves its own readers even if not retained. */
  outcome?: TreeReadResult;
};

type TreeState = {
  target: TreeTarget;
  revision: number;
  digest?: string;
  body?: TreeBody;
  dirtyEpoch: number;
  mutationGeneration: number;
  inFlight?: TreeAttempt;
  lastReadAt?: number;
  failure?: { error: unknown; epoch: number; retryAt: number; attempts: number };
  released: boolean;
};

const MAX_READ_PASSES = 4;

export class WorktreeTreeSnapshots {
  private readonly states = new Map<string, TreeState>();
  private readonly limits: TreeSnapshotLimits;
  private readonly metrics: RecurringWorkMetrics;

  constructor(private readonly options: WorktreeTreeSnapshotsOptions) {
    this.limits = { ...DEFAULT_TREE_SNAPSHOT_LIMITS, ...options.limits };
    this.metrics = options.metrics ?? recurringWorkMetrics;
  }

  /** Starts (or restarts, after a retarget) the tree lineage for a target. */
  register(target: TreeTarget): void {
    this.release(target.key);
    this.states.set(target.key, {
      target,
      revision: 0,
      dirtyEpoch: 1,
      mutationGeneration: 0,
      released: false,
    });
  }

  /** Drops a target and fences any walk still running for it. */
  release(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.released = true;
    state.inFlight?.abort.abort();
    this.states.delete(key);
  }

  has(key: string): boolean {
    return this.states.has(key);
  }

  revisionOf(key: string): number {
    return this.states.get(key)?.revision ?? 0;
  }

  /**
   * A watcher hint that may have changed membership. Marks the tree dirty and,
   * while a client is looking at it, re-walks now so the revision advances.
   */
  hint(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.dirtyEpoch += 1;
    if (!this.demanded(state)) return;
    if (state.inFlight) return; // The rerun after the running walk covers it.
    this.metrics.requested("file-tree-read");
    this.startWalk(state, "progress");
  }

  /** A known mutation: rejects walks that began before it and marks the tree dirty. */
  invalidate(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.mutationGeneration += 1;
    state.dirtyEpoch += 1;
    state.failure = undefined;
  }

  /**
   * Returns a tree no older than this request: the cached walk when it is
   * still valid, otherwise the running walk (if it started after the last
   * invalidation) or a new one. `refresh` requires a walk that starts after
   * the call.
   */
  async read(
    key: string,
    request: { refresh?: boolean; priority?: Exclude<RecurringPriorityClass, "critical"> } = {},
  ): Promise<TreeReadResult> {
    const state = this.states.get(key);
    if (!state) throw new Error("Tree target is not tracked");
    this.metrics.requested("file-tree-read");
    state.lastReadAt = this.options.monotonicNow();
    if (request.refresh) {
      state.dirtyEpoch += 1;
      state.failure = undefined;
    }
    const required = state.dirtyEpoch;
    let counted = false;
    const count = (outcome: "hit" | "join" | "miss") => {
      if (counted) return;
      counted = true;
      if (outcome === "hit") this.metrics.cacheHit("file-tree-read");
      else if (outcome === "join") this.metrics.coalesced("file-tree-read");
      else this.metrics.cacheMiss("file-tree-read");
    };

    for (let pass = 0; pass < MAX_READ_PASSES; pass += 1) {
      if (state.released) throw new Error("Tree target was released while reading");
      const body = state.body;
      if (body && body.epoch >= required && this.isValid(state, body)) {
        count("hit");
        return { tree: body.tree, digest: state.digest!, revision: state.revision };
      }
      const failure = state.failure;
      if (
        failure &&
        failure.epoch >= required &&
        this.options.monotonicNow() < failure.retryAt &&
        !state.inFlight
      ) {
        count("hit");
        throw failure.error;
      }
      let attempt = state.inFlight;
      if (attempt) {
        count("join");
      } else {
        count("miss");
        this.startWalk(state, request.priority ?? "interactive");
        attempt = state.inFlight as TreeAttempt | undefined;
      }
      if (!attempt) continue;
      await attempt.promise;
      // A body too large to retain still answers the reads that waited for it.
      if (attempt.outcome && attempt.epoch >= required) return attempt.outcome;
    }
    // Continuous invalidation: serve the newest walk rather than spin.
    if (state.body && state.body.epoch >= required) {
      return { tree: state.body.tree, digest: state.digest!, revision: state.revision };
    }
    if (state.failure) throw state.failure.error;
    throw new Error("Tree target changed faster than it could be read");
  }

  /** Bounded, content-free counters for diagnostics and tests. */
  status(): { entries: number; bodies: number; bytes: number; inFlight: number } {
    let bodies = 0;
    let bytes = 0;
    let inFlight = 0;
    for (const state of this.states.values()) {
      if (state.body) {
        bodies += 1;
        bytes += state.body.bytes;
      }
      if (state.inFlight) inFlight += 1;
    }
    return { entries: this.states.size, bodies, bytes, inFlight };
  }

  private demanded(state: TreeState): boolean {
    return (
      state.lastReadAt !== undefined &&
      this.options.monotonicNow() - state.lastReadAt <= this.limits.demandWindowMs
    );
  }

  private isValid(state: TreeState, body: TreeBody): boolean {
    const coverage = this.options.coverage(state.target.key);
    if (
      coverage.qualified &&
      body.qualifiedAtWalk &&
      body.watcherGeneration === coverage.watcherGeneration
    ) {
      return true;
    }
    return this.options.monotonicNow() - body.completedAt <= this.limits.maxAgeMs;
  }

  private startWalk(state: TreeState, priority: Exclude<RecurringPriorityClass, "critical">): void {
    const coverage = this.options.coverage(state.target.key);
    const attempt: TreeAttempt = {
      epoch: state.dirtyEpoch,
      mutationGeneration: state.mutationGeneration,
      abort: new AbortController(),
      promise: Promise.resolve(),
    };
    state.inFlight = attempt;
    attempt.promise = this.walk(state, attempt, priority, coverage).finally(() => {
      if (state.inFlight === attempt) state.inFlight = undefined;
      // Hints that arrived during the walk: one rerun, only while demanded.
      if (!state.released && state.dirtyEpoch > attempt.epoch && this.demanded(state)) {
        this.metrics.requested("file-tree-read");
        this.startWalk(state, "progress");
      }
    });
  }

  private async walk(
    state: TreeState,
    attempt: TreeAttempt,
    priority: Exclude<RecurringPriorityClass, "critical">,
    coverage: TreeCoverage,
  ): Promise<void> {
    let tree: unknown[];
    try {
      const work = () =>
        this.metrics.observe("file-tree-read", async (span) => {
          span.work("directory-walk");
          const walked = await this.options.walk(state.target);
          return walked;
        });
      tree = this.options.admission
        ? await this.options.admission.run(
            {
              kind: "file-tree-read",
              priority,
              target: state.target.admissionTarget,
              signal: attempt.abort.signal,
            },
            work,
          )
        : await work();
    } catch (error) {
      if (state.released || attempt.abort.signal.aborted) return;
      const attempts = (state.failure?.attempts ?? 0) + 1;
      const delay = Math.min(
        this.limits.failureRetryBaseMs * 2 ** (attempts - 1),
        this.limits.failureRetryMaxMs,
      );
      state.failure = {
        error,
        epoch: attempt.epoch,
        retryAt: this.options.monotonicNow() + delay,
        attempts,
      };
      return;
    }
    if (state.released || attempt.mutationGeneration !== state.mutationGeneration) return;

    state.failure = undefined;
    const serialized = JSON.stringify(tree);
    const digest = responseDigest(tree);
    const bytes = serialized.length;
    const changed = digest !== state.digest;
    if (changed) {
      state.revision += 1;
      state.digest = digest;
      this.metrics.outcome("file-tree-read", "changed");
    } else {
      this.metrics.outcome("file-tree-read", "unchanged");
    }
    // Keep the newest body even when a newer hint already arrived: its epoch
    // says which reads it can satisfy.
    state.body =
      bytes <= this.limits.maxEntryBytes
        ? {
            tree,
            bytes,
            epoch: attempt.epoch,
            qualifiedAtWalk: coverage.qualified,
            watcherGeneration: coverage.watcherGeneration,
            completedAt: this.options.monotonicNow(),
          }
        : undefined;
    attempt.outcome = { tree, digest, revision: state.revision };
    this.enforceBounds(state);
    if (changed) this.options.onRevision?.(state.target.key);
  }

  /** Evicts least recently read bodies until the cache fits its bounds. */
  private enforceBounds(keep: TreeState): void {
    let bodies = 0;
    let bytes = 0;
    for (const state of this.states.values()) {
      if (!state.body) continue;
      bodies += 1;
      bytes += state.body.bytes;
    }
    while (bodies > this.limits.maxEntries || bytes > this.limits.maxBytes) {
      let victim: TreeState | undefined;
      for (const state of this.states.values()) {
        if (!state.body || state === keep) continue;
        const age = state.lastReadAt ?? state.body.completedAt;
        const victimAge = victim ? (victim.lastReadAt ?? victim.body!.completedAt) : Infinity;
        if (age < victimAge) victim = state;
      }
      if (!victim) break;
      bodies -= 1;
      bytes -= victim.body!.bytes;
      victim.body = undefined;
    }
  }
}
