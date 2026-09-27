import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import {
  isRelevantCommonDirChange,
  isRelevantGitDirChange,
  relevantRefPaths,
  resolveWorktreeGitPaths,
  type WorktreeGitPaths,
} from "./worktree-git-paths.js";

/**
 * Turns "something in this worktree changed" into a debounced signal.
 *
 * Diff stats used to be recomputed on a blind fifteen-second timer, so an idle
 * environment paid for a full git scan every tick to produce a byte-identical
 * answer. Watching costs one file descriptor and reports in milliseconds, which
 * makes the badge both cheaper and more responsive than the timer it replaces.
 *
 * Recursive `fs.watch` is not available everywhere, so this degrades rather than
 * fails: when the watch cannot be established the caller keeps its timer.
 *
 * Events are hints, never proof. A burst is reported once, after
 * {@link WATCH_SETTLE_MS}, as a {@link WorktreeChangeHint} saying which views it
 * may have changed. The owner decides what to rescan; missed events are the
 * owner's safety scan's job.
 */

/** Editors save in bursts; one scan after the burst is enough. */
export const WATCH_SETTLE_MS = 400;

/**
 * Events in one settle window beyond which the burst is reported as an
 * overflow. The hint itself is one boolean pair either way; the flag tells the
 * owner that per-path reasoning is pointless for this burst.
 */
export const WATCH_BURST_OVERFLOW_EVENTS = 10_000;

/** Which snapshot views a settled burst may have changed. */
export interface WorktreeChangeHint {
  /** Git status / the changed-file list may differ. */
  fileList: boolean;
  /** Tree membership may differ (created, deleted or renamed entries). */
  tree: boolean;
  /** The burst exceeded {@link WATCH_BURST_OVERFLOW_EVENTS}, or the platform lost events. */
  overflow: boolean;
}

export type StartWatch = (
  target: string,
  listener: (eventType: string, filename: string | null) => void,
  options: { recursive: boolean },
) => FSWatcher;

export interface WorktreeWatcherOptions {
  worktreePath: string;
  /** Receives what the burst may have changed; absent means "anything". */
  onChange: (hint?: WorktreeChangeHint) => void;
  settleMs?: number;
  /**
   * The environment's comparison ref. Selects which shared ref files can move
   * the baseline; omit it and only the index/HEAD are metadata changes.
   */
  comparisonRef?: string;
  /** Injected for tests; defaults to node's fs.watch. */
  startWatch?: StartWatch;
  /**
   * Resolves the worktree's Git dirs. Defaults to {@link resolveWorktreeGitPaths};
   * `null` disables metadata watching (the watcher then never reports qualified
   * coverage for a linked worktree).
   */
  resolveGitPaths?: ((worktreePath: string) => Promise<WorktreeGitPaths | undefined>) | null;
  onError?: (error: unknown) => void;
  /** Called once when {@link WorktreeWatcher.qualified} becomes true. */
  onCoverageChange?: () => void;
}

export interface WorktreeWatcher {
  /** False when no watcher could be established and the caller must keep polling. */
  readonly watching: boolean;
  /**
   * True once the root *and* every Git metadata location that can change the
   * diff (a linked worktree's index/HEAD and the shared refs) are watched.
   * Until then, and forever when metadata could not be resolved, a quiet
   * watcher is not evidence that nothing changed. Watchers that omit it
   * (test doubles) are treated as qualified whenever they are watching.
   */
  readonly qualified?: boolean;
  close(): void;
}

/**
 * Git's own churn is not a source change.
 *
 * `.git` is rewritten constantly by locks, object writes and packing, and every
 * one of those would otherwise trigger a scan. Only the index, HEAD,
 * `packed-refs` and the refs the comparison resolves through change what a
 * diff reports, so those are let through and the rest is dropped. Without
 * `refs` only the index and HEAD are relevant.
 */
export function isIgnorableWorktreeChange(
  filename: string | null,
  refs: readonly string[] = [],
): boolean {
  return classifyWorktreeChange(filename, refs) === null;
}

/**
 * Which views one root-watcher event may affect, or `null` when it is proven
 * irrelevant. The tree skips `.git` and `node_modules` at every depth, so an
 * event inside either cannot change the tree; a build directory can still
 * hold tracked or visible untracked files, so only Git's own metadata is ever
 * ignored for the file list.
 */
export function classifyWorktreeChange(
  filename: string | null,
  refs: readonly string[] = [],
): { fileList: boolean; tree: boolean } | null {
  if (!filename) return { fileList: true, tree: true };
  const normalized = filename.split(path.sep).join("/");
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    const relative = normalized.slice(".git/".length);
    // A linked worktree's `.git` pointer file itself changing is rare and
    // re-points everything; treat it as relevant.
    if (normalized === ".git") return { fileList: true, tree: false };
    if (isRelevantGitDirChange(relative) || isRelevantCommonDirChange(relative, refs)) {
      return { fileList: true, tree: false };
    }
    return null;
  }
  const tree = !normalized.split("/").some((segment) => segment === "node_modules");
  return { fileList: true, tree };
}

const defaultStartWatch: StartWatch = (target, listener, options) =>
  watch(target, { recursive: options.recursive, persistent: false }, listener);

export function startWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  const settleMs = options.settleMs ?? WATCH_SETTLE_MS;
  const start = options.startWatch ?? defaultStartWatch;
  const refs = relevantRefPaths(options.comparisonRef ?? "");
  const resolveGitPaths =
    options.resolveGitPaths === undefined ? resolveWorktreeGitPaths : options.resolveGitPaths;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let rootWatcher: FSWatcher | undefined;
  const metadataWatchers: FSWatcher[] = [];
  // A main checkout's metadata is below the root; a linked worktree's is not
  // until its extra watches are established.
  let metadataCovered = false;
  let pending: WorktreeChangeHint = { fileList: false, tree: false, overflow: false };
  let burstEvents = 0;

  const fail = (error: unknown) => {
    if (closed) return;
    options.onError?.(error);
    close();
  };

  const schedule = (hint: { fileList: boolean; tree: boolean; overflow?: boolean }) => {
    if (closed) return;
    burstEvents += 1;
    pending = {
      fileList: pending.fileList || hint.fileList,
      tree: pending.tree || hint.tree,
      overflow: pending.overflow || hint.overflow === true,
    };
    if (burstEvents > WATCH_BURST_OVERFLOW_EVENTS) {
      pending = { fileList: true, tree: true, overflow: true };
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const settled = pending;
      pending = { fileList: false, tree: false, overflow: false };
      burstEvents = 0;
      if (!closed) options.onChange(settled);
    }, settleMs);
    // Never hold the process open for a debounce that only refreshes a badge.
    timer.unref?.();
  };

  const watchPath = (
    target: string,
    recursive: boolean,
    listener: (eventType: string, filename: string | null) => void,
  ): FSWatcher => {
    const handle = start(target, listener, { recursive });
    // A watch can fail asynchronously - the directory is removed, the platform
    // runs out of descriptors or watches. Surfacing it lets the owner fall back
    // to polling instead of going quiet forever.
    handle.on("error", fail);
    return handle;
  };

  try {
    rootWatcher = watchPath(options.worktreePath, true, (_eventType, filename) => {
      const hint = classifyWorktreeChange(filename, refs);
      if (hint) schedule(hint);
    });
  } catch (error) {
    options.onError?.(error);
    rootWatcher = undefined;
  }

  if (rootWatcher && resolveGitPaths) {
    void resolveGitPaths(options.worktreePath).then(
      (paths) => {
        if (closed || !paths) return;
        if (!paths.linked && isInside(options.worktreePath, paths.commonDir)) {
          metadataCovered = true;
          options.onCoverageChange?.();
          return;
        }
        try {
          if (paths.linked || !isInside(options.worktreePath, paths.gitDir)) {
            metadataWatchers.push(
              watchPath(paths.gitDir, false, (_eventType, filename) => {
                if (isRelevantGitDirChange(filename)) schedule({ fileList: true, tree: false });
              }),
            );
          }
          if (!isInside(options.worktreePath, paths.commonDir)) {
            metadataWatchers.push(
              watchPath(paths.commonDir, false, (_eventType, filename) => {
                if (filename === null || filename === "packed-refs") {
                  schedule({ fileList: true, tree: false });
                }
              }),
            );
            if (refs.length > 0) {
              metadataWatchers.push(
                watchPath(path.join(paths.commonDir, "refs"), true, (_eventType, filename) => {
                  const relative = filename === null ? null : `refs/${filename}`;
                  if (isRelevantCommonDirChange(relative, refs)) {
                    schedule({ fileList: true, tree: false });
                  }
                }),
              );
            }
          }
          if (!closed) {
            metadataCovered = true;
            options.onCoverageChange?.();
          }
        } catch (error) {
          fail(error);
        }
      },
      // Unresolvable metadata leaves the watcher running but unqualified.
      () => undefined,
    );
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const handle of [rootWatcher, ...metadataWatchers]) {
      try {
        handle?.close();
      } catch {
        // Already closed, or the platform tore it down with the directory.
      }
    }
    metadataWatchers.length = 0;
  }

  return {
    get watching() {
      return rootWatcher !== undefined && !closed;
    },
    get qualified() {
      return rootWatcher !== undefined && !closed && metadataCovered;
    },
    close,
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Deliberately no cheap "did anything change?" fingerprint.
 *
 * The obvious one - the mtime of `.git/index` plus HEAD - is wrong for these
 * counts. They include the working tree, and editing a tracked file moves
 * neither: the gate would report "unchanged" and suppress a scan that had real
 * changes to find, freezing the badge until something happened to touch the
 * index. A watcher sees the edit; an index stat cannot.
 *
 * So the fallback timer scans unconditionally, exactly as before, and only a
 * qualified watcher is allowed to reduce how often that happens.
 */
