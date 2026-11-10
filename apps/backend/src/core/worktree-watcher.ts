import path from "node:path";
import { watchDirectory, type WatchHandle } from "./watch-host.js";
import {
  isRelevantCommonDirChange,
  isRelevantGitDirChange,
  relevantRefPaths,
  resolveWorktreeGitPaths,
  type WorktreeGitPaths,
} from "./worktree-git-paths.js";
import {
  planWatchTargets,
  worktreeWatchPlanIo,
  type WatchTarget,
  type WorktreeWatchPlanIo,
} from "./worktree-watch-plan.js";

/**
 * Turns "something in this worktree changed" into a debounced signal.
 *
 * Diff stats used to be recomputed on a blind fifteen-second timer, so an idle
 * environment paid for a full git scan every tick to produce a byte-identical
 * answer. Watching reports in milliseconds, which makes the badge both cheaper
 * and more responsive than the timer it replaces.
 *
 * Recursive `fs.watch` is not available everywhere, so this degrades rather than
 * fails: when the watch cannot be established the caller keeps its timer.
 *
 * A `node_modules` Git proves ignored and free of tracked files is left out
 * (`worktree-watch-plan.ts`). What that means depends on the platform. On Linux
 * a recursive watch costs one inotify watch per directory, so the subtree is not
 * watched at all, and new directories are noticed and watched as they appear.
 * On macOS one recursive watch has no per-directory cost, while each extra one
 * makes the shared FSEvents stream rebuild (`watch-host.ts`), so the root stays
 * one watch and events under the subtree are dropped on arrival.
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
  /**
   * Worktree-relative paths the burst touched, when every event named one and
   * there were at most {@link WATCH_HINT_MAX_PATHS}. Absent means "unknown":
   * content generations of every live body must advance.
   */
  paths?: string[];
}

/** Paths carried by one settled hint before it degrades to "unknown paths". */
export const WATCH_HINT_MAX_PATHS = 256;

export type StartWatch = (
  target: string,
  listener: (eventType: string, filename: string | null) => void,
  options: { recursive: boolean },
) => WatchHandle;

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
  /** Injected for tests; defaults to {@link watchDirectory}. */
  startWatch?: StartWatch;
  /**
   * Decides what may be left out. `null` watches the whole root. Defaults to real
   * Git and file system reads, or to `null` when `startWatch` is injected.
   */
  plan?: WorktreeWatchPlanIo | null;
  /** A recursive watch costs one kernel watch per directory. Defaults to Linux. */
  perDirectoryWatches?: boolean;
  /**
   * Resolves the worktree's Git dirs. Defaults to {@link resolveWorktreeGitPaths};
   * `null` disables metadata watching (the watcher then never reports qualified
   * coverage for a linked worktree).
   */
  resolveGitPaths?: ((worktreePath: string) => Promise<WorktreeGitPaths | undefined>) | null;
  onError?: (error: unknown) => void;
  /**
   * Called when {@link WorktreeWatcher.qualified} becomes true, and again if a
   * directory this process may not read turns up after that, which makes it
   * false for good.
   */
  onCoverageChange?: () => void;
}

export interface WorktreeWatcher {
  /** False when no watcher could be established and the caller must keep polling. */
  readonly watching: boolean;
  /**
   * True once the root *and* every Git metadata location that can change the
   * diff (a linked worktree's index/HEAD and the shared refs) are watched.
   * Until then, and forever when metadata could not be resolved or a directory
   * in the worktree could not be read, a quiet watcher is not evidence that
   * nothing changed. Watchers that omit it (test doubles) are treated as
   * qualified whenever they are watching.
   */
  readonly qualified?: boolean;
  close(): void;
  /**
   * The owner's safety scan found a change that no hint since its previous
   * scan announced. Container watchers use it to stop being trusted
   * (`container-worktree-signal.ts`); local watchers omit it.
   */
  unannouncedChange?(): void;
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
  watchDirectory(target, listener, options);

/** A change that can alter which `node_modules` Git proves can be left out. */
function canChangeExclusions(name: string): boolean {
  if (name === ".git/index") return true;
  const base = path.posix.basename(name);
  return base === ".gitignore" || base === "node_modules";
}

function targetKey(target: WatchTarget): string {
  return `${target.recursive ? "r" : "d"}:${target.relative}`;
}

function isVanishedPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // Bun on Linux reports an inotify EACCES with the code `EPERM`.
  return code === "EACCES" || code === "EPERM";
}

/**
 * A directory below a recursive watch that this process may not read.
 *
 * Bun's recursive watch on Linux walks the tree itself. A directory it cannot
 * open (a rootless container runtime's data root kept in the worktree holds
 * hundreds) is reported as an `error` naming that directory, after which the
 * watch carries on and still reports everything else, new directories
 * included. Treating the report as fatal closed the watcher, and every retry
 * walked the whole tree again on the event loop, stalling the backend for tens
 * of seconds each time. The watch is kept instead, but unqualified (see
 * `unreadable` below). A watch whose own target is unreadable still fails: Bun
 * throws that synchronously, and an error naming no path is never a descendant.
 */
function isUnreadableDescendant(error: unknown, target: string): boolean {
  if (!isPermissionDenied(error)) return false;
  const reported = (error as NodeJS.ErrnoException).path;
  if (typeof reported !== "string") return false;
  const relative = path.relative(path.resolve(target), path.resolve(reported));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function startWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  const settleMs = options.settleMs ?? WATCH_SETTLE_MS;
  const start = options.startWatch ?? defaultStartWatch;
  const refs = relevantRefPaths(options.comparisonRef ?? "");
  const resolveGitPaths =
    options.resolveGitPaths === undefined ? resolveWorktreeGitPaths : options.resolveGitPaths;
  const plan =
    options.plan === undefined ? (options.startWatch ? null : worktreeWatchPlanIo) : options.plan;
  const splitting = plan !== null && (options.perDirectoryWatches ?? process.platform === "linux");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const treeWatches = new Map<
    string,
    { target: WatchTarget; handle: WatchHandle; identity: string | null }
  >();
  const metadataWatchers: WatchHandle[] = [];
  // Watches asked for but not set up yet; a quiet watcher proves nothing until then.
  let unestablished = 0;
  // A main checkout's metadata is below the root; a linked worktree's is not
  // until its extra watches are established.
  let metadataCovered = false;
  // A split root sees only its direct children until the plan has been applied.
  let treeCovered = !splitting;
  let coverageAnnounced = false;
  // A directory could not be watched because this process may not read it.
  // Should it become readable, nothing would watch it, so a quiet watcher
  // would hide its changes: the watcher stays open, its events still count as
  // hints, but it never reports qualified coverage again and its owner keeps
  // polling. Closing it instead had its owner re-walk the whole tree on every
  // retry, and gave it nothing a polling owner does not already have.
  let unreadable = false;
  let excluded: readonly string[] = [];
  let replanAtSettle = false;
  let replanQueued = false;
  let applyQueued = false;
  let reconciling = false;
  let pending: WorktreeChangeHint = { fileList: false, tree: false, overflow: false };
  let burstEvents = 0;
  // Content paths seen in this burst; null once one event lacked a name or
  // the bound was exceeded.
  let burstPaths: Set<string> | null = new Set();

  const fail = (error: unknown) => {
    if (closed) return;
    options.onError?.(error);
    close();
  };

  const noteUnreadable = () => {
    if (unreadable) return;
    unreadable = true;
    // Withdraw coverage already announced; none will be announced from now on.
    if (coverageAnnounced && !closed) options.onCoverageChange?.();
  };

  const announceCoverage = () => {
    if (
      closed ||
      coverageAnnounced ||
      unreadable ||
      !metadataCovered ||
      !treeCovered ||
      unestablished > 0
    ) {
      return;
    }
    coverageAnnounced = true;
    options.onCoverageChange?.();
  };

  const schedule = (
    hint: { fileList: boolean; tree: boolean; overflow?: boolean },
    contentPath?: string | null,
  ) => {
    if (closed) return;
    burstEvents += 1;
    if (contentPath === null) burstPaths = null;
    else if (contentPath !== undefined && burstPaths) {
      burstPaths.add(contentPath);
      if (burstPaths.size > WATCH_HINT_MAX_PATHS) burstPaths = null;
    }
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
      if (replanAtSettle) {
        replanAtSettle = false;
        replanQueued = true;
        reconcile();
      }
      const settled: WorktreeChangeHint =
        burstPaths && burstPaths.size > 0 && !pending.overflow
          ? { ...pending, paths: [...burstPaths] }
          : pending;
      pending = { fileList: false, tree: false, overflow: false };
      burstEvents = 0;
      burstPaths = new Set();
      if (!closed) options.onChange(settled);
    }, settleMs);
    // Never hold the process open for a debounce that only refreshes a badge.
    timer.unref?.();
  };

  const watchPath = (
    target: string,
    recursive: boolean,
    listener: (eventType: string, filename: string | null) => void,
  ): WatchHandle => {
    // Node types the name as `string | null`, but Bun on Linux passes
    // `undefined` when the watched directory itself is removed. Both mean
    // "unknown"; normalising here keeps every listener on one spelling instead
    // of throwing from inside the platform's event dispatch.
    const handle = start(target, (eventType, filename) => listener(eventType, filename ?? null), {
      recursive,
    });
    // A watch can fail asynchronously - the directory is removed, the platform
    // runs out of descriptors or watches. Surfacing it lets the owner fall back
    // to polling instead of going quiet forever. An unreadable directory inside
    // a recursive watch is not such a failure (see `isUnreadableDescendant`).
    handle.on("error", (error: Error) => {
      if (recursive && isUnreadableDescendant(error, target)) noteUnreadable();
      else fail(error);
    });
    if (handle.established) {
      unestablished += 1;
      void handle.established.then(
        () => {
          unestablished -= 1;
          // Reconcile edits made after the initial scan but before this watch
          // existed. No platform event can describe that uncovered interval.
          schedule({ fileList: true, tree: true }, null);
          announceCoverage();
        },
        () => {
          // A plan can retire a watch before readiness while its replacement
          // stays live. A real failure also emits `error` and closes the owner.
          unestablished -= 1;
          announceCoverage();
        },
      );
    }
    return handle;
  };

  const onTreeEvent = (target: WatchTarget, eventType: string, filename: string | null) => {
    const relative = filename === null ? null : filename.replaceAll(path.sep, "/");
    const name =
      relative === null ? null : target.relative ? `${target.relative}/${relative}` : relative;
    // The entry itself can have become a file or symlink; only descendants
    // still have a valid directory exclusion.
    if (name !== null && excluded.some((entry) => entry !== name && isInsideTree(entry, name)))
      return;
    // A renamed ancestor can remove the .gitignore that proved a descendant
    // safe to omit. Drop that proof immediately on both platform strategies.
    if (plan && (name === null || eventType === "rename")) {
      const affected = excluded.filter((entry) => name === null || isInsideTree(name, entry));
      if (affected.length > 0) {
        excluded = excluded.filter((entry) => !affected.includes(entry));
        replanQueued = true;
        schedule({ fileList: true, tree: true }, null);
        reconcile();
      }
    }
    const hint = classifyWorktreeChange(name, refs);
    if (plan && name !== null && canChangeExclusions(name)) {
      // A new `node_modules` must be left out before anything enters it. The
      // rest wait for the burst to settle, so a rebase costs one read.
      if (path.posix.basename(name) === "node_modules") {
        replanQueued = true;
        reconcile();
      } else replanAtSettle = true;
    }
    if (hint) {
      schedule(
        hint,
        name === null || name === ".git" || name.startsWith(".git/")
          ? name === null
            ? null
            : undefined
          : name,
      );
    }
    // Only a directory's own watch can say a child came or went: nothing below
    // a split directory is watched unless this adds it.
    if (splitting && (name === null || (eventType === "rename" && !target.recursive))) {
      noteStructureChange(name);
    }
  };

  const noteStructureChange = (name: string | null) => {
    if (!plan) return;
    if (name === null) {
      applyQueued = true;
      reconcile();
      return;
    }
    // The parent saying this entry came or went is the one dependable sign that
    // a watch on it, or anywhere below it, may be dead. Identity cannot say so:
    // Linux hands a removed directory's inode number straight to the next one
    // made, so a directory removed and created again usually reads as the same
    // `dev:ino` while its old inotify watch reports nothing ever again.
    if (retireWatchesWithin(name)) {
      applyQueued = true;
      reconcile();
      return;
    }
    void plan.directoryIdentity(options.worktreePath, name).then((identity) => {
      if (closed) return;
      const watched =
        treeWatches.get(targetKey({ relative: name, recursive: true })) ??
        treeWatches.get(targetKey({ relative: name, recursive: false }));
      if (identity === (watched?.identity ?? null)) return;
      applyQueued = true;
      reconcile();
    }, fail);
  };

  /**
   * Closes every tree watch at or below `name`; the next plan pass watches
   * whatever is there now. Returns whether there were any.
   */
  const retireWatchesWithin = (name: string): boolean => {
    let retired = false;
    for (const [key, watched] of Array.from(treeWatches)) {
      if (!watched.target.relative || !isInsideTree(name, watched.target.relative)) continue;
      treeWatches.delete(key);
      closeQuietly(watched.handle);
      retired = true;
    }
    return retired;
  };

  const attach = (target: WatchTarget, identity: string | null) => {
    const handle = watchPath(
      target.relative ? path.join(options.worktreePath, target.relative) : options.worktreePath,
      target.recursive,
      (eventType, filename) => onTreeEvent(target, eventType, filename),
    );
    treeWatches.set(targetKey(target), { target, handle, identity });
  };

  /** Moves the watches to the current plan; returns whether any were added. */
  const applyPlan = async (io: WorktreeWatchPlanIo): Promise<boolean> => {
    const root = options.worktreePath;
    let desired: readonly WatchTarget[];
    try {
      desired = await planWatchTargets(excluded, (relative) => io.childDirectories(root, relative));
    } catch (error) {
      // The worktree itself went away. Its owner decides what that means.
      if (isVanishedPath(error)) return false;
      throw error;
    }
    const identities = await Promise.all(
      desired.map((target) => io.directoryIdentity(root, target.relative)),
    );
    if (closed) return false;
    const wanted = new Map<string, { target: WatchTarget; identity: string | null }>();
    desired.forEach((target, index) => {
      const identity = identities[index] ?? null;
      if (identity !== null || target.relative === "") {
        wanted.set(targetKey(target), { target, identity });
      }
    });
    for (const [key, watched] of Array.from(treeWatches)) {
      const next = wanted.get(key);
      // No identity is not a different one: the first root watch starts before
      // it can be read, and a root that went away reports that on its own watch.
      if (next && (!next.identity || !watched.identity || next.identity === watched.identity)) {
        continue;
      }
      treeWatches.delete(key);
      closeQuietly(watched.handle);
    }
    let added = false;
    for (const [key, { target, identity }] of wanted) {
      const watched = treeWatches.get(key);
      if (watched) {
        watched.identity = identity;
        continue;
      }
      try {
        attach(target, identity);
        added = true;
        // Listing preceded attachment. Once a new direct watch is live, list
        // again to pick up any child created in that gap.
        if (!target.recursive) applyQueued = true;
      } catch (error) {
        // It went away between the listing and the watch, and the event in its
        // parent that says so plans again. The root has no parent to say so.
        if (target.relative === "") throw error;
        if (isPermissionDenied(error)) noteUnreadable();
        else if (!isVanishedPath(error)) throw error;
      }
    }
    return added;
  };

  const runReconcile = async (io: WorktreeWatchPlanIo) => {
    while (!closed && (replanQueued || applyQueued)) {
      const replan = replanQueued;
      replanQueued = false;
      applyQueued = false;
      if (replan) {
        // No answer proves nothing, so nothing stays left out.
        const listed = await io.listExcluded(options.worktreePath).catch(() => undefined);
        if (closed) return;
        const previous = excluded;
        excluded = listed ?? [];
        // Writes to a subtree put back were dropped until now, so report them.
        if (previous.some((entry) => !excluded.includes(entry))) {
          schedule({ fileList: true, tree: true }, null);
        }
      }
      if (!splitting) continue;
      const added = await applyPlan(io);
      if (closed) return;
      // A write before a new watch began reached nothing, so report the gap: the
      // scan this causes starts after the watch did.
      if (added) schedule({ fileList: true, tree: true }, null);
      if (!treeCovered) {
        treeCovered = true;
        announceCoverage();
      }
    }
  };

  /** One pass at a time; a request during a pass is picked up by that pass. */
  const reconcile = () => {
    if (!plan || closed || reconciling) return;
    reconciling = true;
    void runReconcile(plan)
      .catch(fail)
      .finally(() => {
        reconciling = false;
        if (replanQueued || applyQueued) reconcile();
      });
  };

  try {
    attach({ relative: "", recursive: !splitting }, null);
  } catch (error) {
    options.onError?.(error);
  }
  const watchEstablished = treeWatches.size > 0;
  if (watchEstablished && plan) {
    replanQueued = true;
    reconcile();
  }

  if (watchEstablished && resolveGitPaths) {
    void resolveGitPaths(options.worktreePath).then(
      (paths) => {
        if (closed || !paths) return;
        if (!paths.linked && isInside(options.worktreePath, paths.commonDir)) {
          metadataCovered = true;
          announceCoverage();
          return;
        }
        try {
          if (paths.linked || !isInside(options.worktreePath, paths.gitDir)) {
            metadataWatchers.push(
              watchPath(paths.gitDir, false, (_eventType, filename) => {
                if (!isRelevantGitDirChange(filename)) return;
                // Staging can put a tracked file inside a subtree left out.
                if (plan && filename !== "HEAD") replanAtSettle = true;
                schedule({ fileList: true, tree: false });
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
            announceCoverage();
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
    for (const { handle } of treeWatches.values()) closeQuietly(handle);
    for (const handle of metadataWatchers) closeQuietly(handle);
    treeWatches.clear();
    metadataWatchers.length = 0;
  }

  return {
    get watching() {
      return watchEstablished && !closed;
    },
    get qualified() {
      return (
        watchEstablished &&
        !closed &&
        !unreadable &&
        metadataCovered &&
        treeCovered &&
        unestablished === 0
      );
    },
    close,
  };
}

function closeQuietly(handle: WatchHandle): void {
  try {
    handle.close();
  } catch {
    // Already closed, or the platform tore it down with the directory.
  }
}

function isInsideTree(tree: string, name: string): boolean {
  return name === tree || (name.startsWith(tree) && name[tree.length] === "/");
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
