import path from "node:path";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { measuredResponseDigest, responseDigest } from "./worktree-snapshot-digest.js";
import type { WorkAdmissionPool } from "./work-admission.js";

/**
 * Reads for scan identities no tracked owner covers.
 *
 * A tracked environment's file list and tree are owned by `DiffStatsService`.
 * Everything else — a committed-only list, a comparison ref other than the
 * environment's, a worktree the service has not tracked yet, a paused
 * container — is read here: equivalent concurrent requests join one physical
 * read and distinct identities never share.
 *
 * File lists are not cached past the read. Trees keep a small value cache
 * with a short TTL (`AdhocTreeCacheLimits`). No watcher or revision covers
 * these identities, so the TTL is their only freshness guarantee and stays at
 * the unwatched Files-panel bound. What it saves is the second of two reads
 * close together: another client, or the post-mutation re-read the Files
 * panel takes right after the read it first waits out. A known mutation or
 * lifecycle change (`invalidateTarget`) drops the target's value and fences
 * its running walk, an explicit refresh bypasses the value, and a failed walk
 * is never cached — the read rejects; it never answers with an empty tree.
 */

/**
 * Version of what a tree walk returns for a root: exclusions (`.git`,
 * `node_modules`), the node cap, symlink handling and node shape. Part of the
 * ad hoc cache identity so an entry cannot be served across a policy change;
 * bump it with any such change.
 */
export const FILE_TREE_POLICY_VERSION = 1;

export interface WorktreeLookup {
  worktreePath?: string;
  containerId?: string;
}

export interface FileListScanRequest {
  kind: "local" | "container";
  worktreePath?: string;
  containerId?: string;
  comparisonRef: string;
  includeUncommitted: boolean;
}

export interface FileListScanResult {
  changes: unknown[];
  truncated: boolean;
}

export interface TreeWalkRequest {
  kind: "local" | "container";
  worktreePath?: string;
  containerId?: string;
}

export interface AdhocTreeCacheLimits {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  /** A non-refresh read is served a cached tree for this long after its walk. */
  maxAgeMs: number;
}

export const DEFAULT_ADHOC_TREE_CACHE_LIMITS: AdhocTreeCacheLimits = {
  maxEntries: 8,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 4 * 1024 * 1024,
  maxAgeMs: 3_000,
};

export interface AdhocWorktreeReadsOptions {
  readFiles: (request: FileListScanRequest) => Promise<FileListScanResult>;
  walkTree: (request: TreeWalkRequest) => Promise<unknown[]>;
  admission?: WorkAdmissionPool | null;
  metrics?: RecurringWorkMetrics;
  monotonicNow?: () => number;
  treeCache?: Partial<AdhocTreeCacheLimits>;
}

/** Admission and lookup identity of a worktree or container. */
export function worktreeTargetKey(lookup: WorktreeLookup): string {
  if (lookup.worktreePath) return `local:${path.resolve(lookup.worktreePath)}`;
  if (lookup.containerId) return `container:${lookup.containerId}`;
  throw new Error("A worktree path or container id is required");
}

type Pending<T> = {
  promise: Promise<T>;
  targetKey: string;
  /** Set by a mutation of the target: the result must not be cached. */
  fenced: boolean;
};

type TreeValue = { tree: unknown[]; digest: string };

type CachedTree = TreeValue & { targetKey: string; bytes: number; completedAt: number };

export class AdhocWorktreeReads {
  private readonly lists = new Map<string, Pending<FileListScanResult & { digest: string }>>();
  private readonly trees = new Map<string, Pending<CachedTree>>();
  /** Insertion order is recency order: a hit re-inserts its entry. */
  private readonly treeValues = new Map<string, CachedTree>();
  private readonly metrics: RecurringWorkMetrics;
  private readonly now: () => number;
  private readonly treeLimits: AdhocTreeCacheLimits;

  constructor(private readonly options: AdhocWorktreeReadsOptions) {
    this.metrics = options.metrics ?? recurringWorkMetrics;
    this.now = options.monotonicNow ?? (() => Date.now());
    this.treeLimits = { ...DEFAULT_ADHOC_TREE_CACHE_LIMITS, ...options.treeCache };
  }

  async readFileList(
    request: FileListScanRequest & { refresh?: boolean },
  ): Promise<FileListScanResult & { digest: string }> {
    const targetKey = worktreeTargetKey(request);
    const key = [
      targetKey,
      request.comparisonRef,
      request.includeUncommitted ? "working-tree" : "committed",
    ].join("\0");
    this.metrics.requested("file-list-read");
    return this.join(this.lists, key, targetKey, request.refresh === true, "file-list-read", () =>
      this.admitted(targetKey, "file-list-read", async () => {
        const result = await this.metrics.observe("file-list-read", () =>
          this.options.readFiles({
            kind: request.kind,
            worktreePath: request.worktreePath,
            containerId: request.containerId,
            comparisonRef: request.comparisonRef,
            includeUncommitted: request.includeUncommitted,
          }),
        );
        return { ...result, digest: responseDigest(result.changes) };
      }),
    );
  }

  async readTree(request: TreeWalkRequest & { refresh?: boolean }): Promise<TreeValue> {
    const targetKey = worktreeTargetKey(request);
    // Root (resolved path or container id) plus the walk policy; the tree
    // commands take no other options.
    const key = `${targetKey}\0tree-policy:${FILE_TREE_POLICY_VERSION}`;
    const refresh = request.refresh === true;
    this.metrics.requested("file-tree-read");
    this.pruneTrees();
    const cached = this.treeValues.get(key);
    if (cached && !refresh) {
      this.treeValues.delete(key);
      this.treeValues.set(key, cached);
      this.metrics.cacheHit("file-tree-read");
      return { tree: cached.tree, digest: cached.digest };
    }
    // A read after a failed refresh must not fall back to the pre-click value.
    if (refresh) this.treeValues.delete(key);
    const value = await this.join(
      this.trees,
      key,
      targetKey,
      refresh,
      "file-tree-read",
      () =>
        this.admitted(`${targetKey}#tree`, "file-tree-read", async () => {
          const tree = await this.metrics.observe("file-tree-read", async (span) => {
            span.work("directory-walk");
            return this.options.walkTree({
              kind: request.kind,
              worktreePath: request.worktreePath,
              containerId: request.containerId,
            });
          });
          // One serialization gives both the wire digest and the cached size.
          const { digest, bytes } = measuredResponseDigest(tree);
          return { tree, digest, bytes, targetKey, completedAt: this.now() };
        }),
      (walked) => this.retainTree(key, walked),
    );
    return { tree: value.tree, digest: value.digest };
  }

  /**
   * A known mutation or lifecycle change: later reads of this target must not
   * join an older read or reuse a cached tree, and a read still running may
   * not populate the cache.
   */
  invalidateTarget(lookup: WorktreeLookup): void {
    let targetKey: string;
    try {
      targetKey = worktreeTargetKey(lookup);
    } catch {
      return;
    }
    for (const map of [this.lists, this.trees] as Map<string, Pending<unknown>>[]) {
      for (const [key, pending] of Array.from(map)) {
        if (pending.targetKey !== targetKey) continue;
        pending.fenced = true;
        map.delete(key);
      }
    }
    for (const [key, value] of Array.from(this.treeValues)) {
      if (value.targetKey === targetKey) this.treeValues.delete(key);
    }
  }

  /** Shutdown: fences every running read and drops every cached tree. */
  clear(): void {
    for (const map of [this.lists, this.trees] as Map<string, Pending<unknown>>[]) {
      for (const pending of map.values()) pending.fenced = true;
      map.clear();
    }
    this.treeValues.clear();
  }

  /** In-flight reads, for tests and diagnostics. */
  get pending(): number {
    return this.lists.size + this.trees.size;
  }

  /** Bounded, content-free counters of the tree value cache. */
  treeCacheStatus(): { entries: number; bytes: number } {
    this.pruneTrees();
    let bytes = 0;
    for (const value of this.treeValues.values()) bytes += value.bytes;
    return { entries: this.treeValues.size, bytes };
  }

  private retainTree(key: string, walked: CachedTree): void {
    this.treeValues.delete(key);
    if (walked.bytes > this.treeLimits.maxEntryBytes) return;
    this.treeValues.set(key, walked);
    let bytes = 0;
    for (const value of this.treeValues.values()) bytes += value.bytes;
    // Least recently used first; the entry just stored is the newest.
    for (const [victimKey, victim] of Array.from(this.treeValues)) {
      if (this.treeValues.size <= this.treeLimits.maxEntries && bytes <= this.treeLimits.maxBytes) {
        break;
      }
      this.treeValues.delete(victimKey);
      bytes -= victim.bytes;
    }
  }

  /** Expired values are never served; drop them so a retired root's tree does not linger. */
  private pruneTrees(): void {
    const now = this.now();
    for (const [key, value] of Array.from(this.treeValues)) {
      if (now - value.completedAt > this.treeLimits.maxAgeMs) this.treeValues.delete(key);
    }
  }

  private async join<T>(
    map: Map<string, Pending<T>>,
    key: string,
    targetKey: string,
    refresh: boolean,
    kind: "file-list-read" | "file-tree-read",
    start: () => Promise<T>,
    retain?: (value: T) => void,
  ): Promise<T> {
    const existing = map.get(key);
    if (existing && !refresh) {
      this.metrics.coalesced(kind);
      return existing.promise;
    }
    // An explicit refresh must observe state after the call, so it waits out
    // an older read instead of adopting its answer.
    if (existing) await existing.promise.catch(() => undefined);
    const current = map.get(key);
    if (current && current !== existing && !refresh) return current.promise;
    this.metrics.cacheMiss(kind);
    const pending: Pending<T> = { promise: start(), targetKey, fenced: false };
    map.set(key, pending);
    const clear = () => {
      if (map.get(key) === pending) map.delete(key);
    };
    pending.promise.then((value) => {
      clear();
      // A read that began before a known mutation still answers its own
      // callers, but is not retained for anyone after the mutation.
      if (!pending.fenced) retain?.(value);
    }, clear);
    return pending.promise;
  }

  private admitted<T>(
    target: string,
    kind: "file-list-read" | "file-tree-read",
    work: () => Promise<T>,
  ): Promise<T> {
    const admission = this.options.admission;
    if (!admission) return work();
    return admission.run({ kind, priority: "interactive", target }, work);
  }
}
