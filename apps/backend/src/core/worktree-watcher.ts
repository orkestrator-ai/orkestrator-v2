import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

/**
 * Turns "something in this worktree changed" into a debounced signal.
 *
 * Diff stats used to be recomputed on a blind fifteen-second timer, so an idle
 * environment paid for a full git scan every tick to produce a byte-identical
 * answer. Watching costs one file descriptor and reports in milliseconds, which
 * makes the badge both cheaper and more responsive than the timer it replaces.
 *
 * Recursive `fs.watch` is not available everywhere, so this degrades rather than
 * fails: when the watch cannot be established the caller keeps its timer and the
 * fingerprint gate below still suppresses the scans that would find nothing.
 */

/** Editors save in bursts; one scan after the burst is enough. */
export const WATCH_SETTLE_MS = 400;

export interface WorktreeWatcherOptions {
  worktreePath: string;
  onChange: () => void;
  settleMs?: number;
  /** Injected for tests; defaults to node's recursive fs.watch. */
  startWatch?: (
    target: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => FSWatcher;
  onError?: (error: unknown) => void;
}

export interface WorktreeWatcher {
  /** False when no watcher could be established and the caller must keep polling. */
  readonly watching: boolean;
  close(): void;
}

/**
 * Git's own churn is not a source change.
 *
 * `.git` is rewritten constantly by locks, object writes and packing, and every
 * one of those would otherwise trigger a scan. Only the index and HEAD change
 * what a diff reports, so those two are let through and the rest is dropped.
 */
export function isIgnorableWorktreeChange(filename: string | null): boolean {
  if (!filename) return false;
  const normalized = filename.split(path.sep).join("/");
  if (normalized !== ".git" && !normalized.startsWith(".git/")) return false;
  const relative = normalized.slice(".git/".length);
  return relative !== "index" && relative !== "HEAD";
}

export function startWorktreeWatcher(options: WorktreeWatcherOptions): WorktreeWatcher {
  const settleMs = options.settleMs ?? WATCH_SETTLE_MS;
  const start =
    options.startWatch ??
    ((target, listener) => watch(target, { recursive: true, persistent: false }, listener));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let watcher: FSWatcher | undefined;

  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) options.onChange();
    }, settleMs);
    // Never hold the process open for a debounce that only refreshes a badge.
    timer.unref?.();
  };

  try {
    watcher = start(options.worktreePath, (_eventType, filename) => {
      if (isIgnorableWorktreeChange(filename)) return;
      schedule();
    });
    // A watch can fail asynchronously - the directory is removed, the platform
    // runs out of descriptors. Surfacing it lets the owner fall back to polling
    // instead of going quiet forever.
    watcher.on("error", (error) => {
      options.onError?.(error);
      close();
    });
  } catch (error) {
    options.onError?.(error);
    watcher = undefined;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    try {
      watcher?.close();
    } catch {
      // Already closed, or the platform tore it down with the directory.
    }
  }

  return {
    get watching() {
      return watcher !== undefined && !closed;
    },
    close,
  };
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
 * working watcher is allowed to reduce how often that happens.
 */
