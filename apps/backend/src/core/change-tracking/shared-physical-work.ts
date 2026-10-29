/**
 * Physical work shared across logical views of one worktree.
 *
 * Several environments can address the same checkout (aliases, symlinks,
 * relative paths). Their logical views — each with its own comparison ref —
 * stay separate, but the physical work behind equal requests is shared:
 *
 * - {@link SharedScanQueue}: equal scans of one physical worktree join. A scan
 *   already running cannot satisfy a later request (it may have read files
 *   before the change that prompted it), so later callers share one queued
 *   scan that starts after it — a fresh-fence join, never a stale one.
 * - {@link SharedWatcherRegistry}: one watcher per physical root and ref set,
 *   reference counted across every view that asked for it.
 *
 * Ten clients or ten aliases with equal demand therefore cost the same
 * physical scans and watchers as one.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  WorktreeChangeHint,
  WorktreeWatcher,
  WorktreeWatcherOptions,
} from "../worktree-watcher.js";

/** Canonical physical key for a host path or container (cached per input). */
export class PhysicalKeyResolver {
  private readonly cache = new Map<string, string>();

  key(target: {
    kind: "local" | "container";
    worktreePath?: string;
    containerId?: string;
  }): string {
    if (target.kind === "container") return `container:${target.containerId ?? ""}`;
    const input = target.worktreePath ?? "";
    let resolved = this.cache.get(input);
    if (!resolved) {
      try {
        resolved = realpathSync(input);
      } catch {
        resolved = path.resolve(input);
      }
      if (this.cache.size > 1_024) this.cache.clear();
      this.cache.set(input, resolved);
    }
    return `local:${resolved}`;
  }
}

interface QueueState<T> {
  running: Promise<T> | null;
  runningStartedAt: number;
  queued: Promise<T> | null;
}

export class SharedScanQueue<T> {
  private readonly states = new Map<string, QueueState<T>>();
  private joined = 0;
  private executed = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `requestedAt` (same clock as `now`) is when the caller's need arose: a
   * pass that started strictly later satisfies it even while still running,
   * so a caller delayed by admission joins rather than rescanning.
   */
  run(key: string, work: () => Promise<T>, requestedAt?: number): Promise<T> {
    let state = this.states.get(key);
    if (!state) {
      state = { running: null, runningStartedAt: 0, queued: null };
      this.states.set(key, state);
    }
    if (state.running && requestedAt !== undefined && state.runningStartedAt > requestedAt) {
      this.joined++;
      return state.running;
    }
    if (state.queued) {
      this.joined++;
      return state.queued;
    }
    const start = (): Promise<T> => {
      this.executed++;
      state!.runningStartedAt = this.now();
      const running = work().finally(() => {
        if (state!.running === running) state!.running = null;
        if (!state!.running && !state!.queued) this.states.delete(key);
      });
      state!.running = running;
      return running;
    };
    if (!state.running) return start();
    const queued = state.running
      .catch(() => undefined)
      .then(() => {
        state!.queued = null;
        return start();
      });
    state.queued = queued;
    return queued;
  }

  stats() {
    return { joined: this.joined, executed: this.executed, keys: this.states.size };
  }

  /** Resolves once no pass is running or queued, including passes queued meanwhile. */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.states.values()].flatMap((state) =>
        [state.running, state.queued].filter((pass): pass is Promise<T> => pass !== null),
      );
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }
}

interface SharedWatcher {
  generation?: object;
  watcher: WorktreeWatcher;
  listeners: Set<WorktreeWatcherOptions>;
}

/**
 * Reference-counted watchers keyed by physical root and comparison ref. Each
 * subscriber keeps its own callbacks; the underlying `fs.watch` handles exist
 * once.
 */
export class SharedWatcherRegistry {
  private readonly watchers = new Map<string, SharedWatcher>();

  constructor(
    private readonly start: (options: WorktreeWatcherOptions) => WorktreeWatcher,
    private readonly keys = new PhysicalKeyResolver(),
  ) {}

  /** Same signature as `startWorktreeWatcher`, so it can be injected directly. */
  readonly startWatcher = (options: WorktreeWatcherOptions): WorktreeWatcher => {
    const key = `${this.keys.key({ kind: "local", worktreePath: options.worktreePath })}\0${options.comparisonRef ?? ""}`;
    let shared = this.watchers.get(key);
    if (!shared || !shared.watcher.watching) {
      const listeners = shared?.listeners ?? new Set<WorktreeWatcherOptions>();
      shared?.watcher.close();
      const entry = shared ?? { watcher: { watching: false, close() {} }, listeners };
      const generation = {};
      entry.generation = generation;
      const watcher = this.start({
        ...options,
        onChange: (hint?: WorktreeChangeHint) => {
          if (entry.generation !== generation) return;
          for (const listener of Array.from(listeners)) listener.onChange(hint);
        },
        onError: (error) => {
          if (entry.generation !== generation) return;
          for (const listener of Array.from(listeners)) listener.onError?.(error);
        },
        onCoverageChange: () => {
          if (entry.generation !== generation) return;
          for (const listener of Array.from(listeners)) listener.onCoverageChange?.();
        },
      });
      entry.watcher = watcher;
      shared = entry;
      this.watchers.set(key, shared);
    }
    const entry = shared;
    entry.listeners.add(options);
    let closed = false;
    return {
      get watching() {
        return !closed && entry.watcher.watching;
      },
      get qualified() {
        return !closed && (entry.watcher.qualified ?? true);
      },
      close: () => {
        if (closed) return;
        closed = true;
        entry.listeners.delete(options);
        if (entry.listeners.size === 0) {
          entry.watcher.close();
          if (this.watchers.get(key) === entry) this.watchers.delete(key);
        }
      },
    };
  };

  activeWatchers(): number {
    return this.watchers.size;
  }
}
