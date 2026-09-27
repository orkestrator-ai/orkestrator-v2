import path from "node:path";
import { recurringWorkMetrics, type RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { responseDigest } from "./worktree-snapshot-digest.js";
import type { WorkAdmissionPool } from "./work-admission.js";

/**
 * Reads for scan identities no tracked owner covers.
 *
 * A tracked environment's file list and tree are owned by `DiffStatsService`.
 * Everything else — a committed-only list, a comparison ref other than the
 * environment's, a worktree the service has not tracked yet, a paused
 * container — is read here: equivalent concurrent requests join one physical
 * read, distinct identities never share, and nothing is cached past the read,
 * because no watcher or mutation fence covers these identities.
 */

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

export interface AdhocWorktreeReadsOptions {
  readFiles: (request: FileListScanRequest) => Promise<FileListScanResult>;
  walkTree: (request: TreeWalkRequest) => Promise<unknown[]>;
  admission?: WorkAdmissionPool | null;
  metrics?: RecurringWorkMetrics;
}

/** Admission and lookup identity of a worktree or container. */
export function worktreeTargetKey(lookup: WorktreeLookup): string {
  if (lookup.worktreePath) return `local:${path.resolve(lookup.worktreePath)}`;
  if (lookup.containerId) return `container:${lookup.containerId}`;
  throw new Error("A worktree path or container id is required");
}

type Pending<T> = { promise: Promise<T>; targetKey: string };

export class AdhocWorktreeReads {
  private readonly lists = new Map<string, Pending<FileListScanResult & { digest: string }>>();
  private readonly trees = new Map<string, Pending<{ tree: unknown[]; digest: string }>>();
  private readonly metrics: RecurringWorkMetrics;

  constructor(private readonly options: AdhocWorktreeReadsOptions) {
    this.metrics = options.metrics ?? recurringWorkMetrics;
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

  async readTree(
    request: TreeWalkRequest & { refresh?: boolean },
  ): Promise<{ tree: unknown[]; digest: string }> {
    const targetKey = worktreeTargetKey(request);
    this.metrics.requested("file-tree-read");
    return this.join(
      this.trees,
      targetKey,
      targetKey,
      request.refresh === true,
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
          return { tree, digest: responseDigest(tree) };
        }),
    );
  }

  /** A known mutation: later reads of this target must not join an older read. */
  invalidateTarget(lookup: WorktreeLookup): void {
    let targetKey: string;
    try {
      targetKey = worktreeTargetKey(lookup);
    } catch {
      return;
    }
    for (const map of [this.lists, this.trees] as Map<string, Pending<unknown>>[]) {
      for (const [key, pending] of Array.from(map)) {
        if (pending.targetKey === targetKey) map.delete(key);
      }
    }
  }

  /** In-flight reads, for tests and diagnostics. */
  get pending(): number {
    return this.lists.size + this.trees.size;
  }

  private async join<T>(
    map: Map<string, Pending<T>>,
    key: string,
    targetKey: string,
    refresh: boolean,
    kind: "file-list-read" | "file-tree-read",
    start: () => Promise<T>,
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
    const pending: Pending<T> = { promise: start(), targetKey };
    map.set(key, pending);
    const clear = () => {
      if (map.get(key) === pending) map.delete(key);
    };
    pending.promise.then(clear, clear);
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
