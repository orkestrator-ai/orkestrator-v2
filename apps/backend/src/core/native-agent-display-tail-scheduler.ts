import {
  NATIVE_DISPLAY_TAIL_MAX_CHECKPOINT_AGE_MS,
  NATIVE_DISPLAY_TAIL_MAX_SESSIONS,
  NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";

/**
 * Bounded checkpoint scheduling for restart previews (plan step 07).
 *
 * Each session key holds at most one pending latest value; intermediate
 * tails are never queued. A key becomes due after a quiet period since its
 * last update, but never later than a maximum age since it first became
 * dirty, so continuous streaming still produces a recent preview. Due keys
 * share a small write pool. An update that lands while its key is being
 * written marks it dirty again and yields exactly one trailing write.
 *
 * Every pending value carries the deletion fence captured when it was
 * produced; storage refuses a write whose fence predates a deletion of the
 * key or its environment, so a late timer cannot resurrect a deleted tail.
 *
 * Shutdown stops accepting updates, then attempts each key's newest pending
 * value once within a deadline and reports only an aggregate skipped count.
 * It never waits indefinitely and never touches running agents: provider
 * history remains authoritative for everything a lost preview would show.
 */

export interface DisplayTailCheckpointSource {
  environmentId: string;
  /** Builds the stripped tail lazily, once, when the checkpoint is written. */
  build: () => NativeAgentDisplayTail | null;
}

export interface DisplayTailSchedulerOptions {
  write: (key: string, tail: NativeAgentDisplayTail, fence: number) => Promise<boolean>;
  captureFence: () => number;
  subscribeDeletions?: (
    listener: (
      event: { kind: "key"; key: string } | { kind: "environment"; environmentId: string },
    ) => void,
  ) => () => void;
  quietMs?: number;
  maxAgeMs?: number;
  maxConcurrentWrites?: number;
  maxPendingKeys?: number;
  shutdownDeadlineMs?: number;
  /** Monotonic clock in milliseconds. */
  clock?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface DisplayTailSchedulerStats {
  updates: number;
  coalesced: number;
  writes: number;
  failedWrites: number;
  droppedAdmission: number;
  droppedAfterStop: number;
  discarded: number;
}

export interface DisplayTailShutdownReport {
  attempted: number;
  written: number;
  skipped: number;
}

export const NATIVE_DISPLAY_TAIL_MAX_CONCURRENT_WRITES = 2;
export const NATIVE_DISPLAY_TAIL_SHUTDOWN_DEADLINE_MS = 1_500;

interface Entry {
  environmentId: string;
  pending: { build: () => NativeAgentDisplayTail | null; fence: number } | null;
  dirtySince: number;
  lastUpdate: number;
  timer: unknown;
  timerDue: number;
  writing: Promise<void> | null;
  ready: boolean;
  dueWhileWriting: boolean;
}

function monotonicNow(): number {
  return performance.now();
}

export class NativeAgentDisplayTailScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly ready: string[] = [];
  private active = 0;
  private stopped = false;
  private draining = false;
  private readonly unsubscribe: (() => void) | null;
  private readonly quietMs: number;
  private readonly maxAgeMs: number;
  private readonly maxConcurrent: number;
  private readonly maxPendingKeys: number;
  private readonly clock: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly counters: DisplayTailSchedulerStats = {
    updates: 0,
    coalesced: 0,
    writes: 0,
    failedWrites: 0,
    droppedAdmission: 0,
    droppedAfterStop: 0,
    discarded: 0,
  };

  constructor(private readonly options: DisplayTailSchedulerOptions) {
    this.quietMs = options.quietMs ?? NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS;
    this.maxAgeMs = Math.max(
      this.quietMs,
      options.maxAgeMs ?? NATIVE_DISPLAY_TAIL_MAX_CHECKPOINT_AGE_MS,
    );
    this.maxConcurrent = Math.max(
      1,
      options.maxConcurrentWrites ?? NATIVE_DISPLAY_TAIL_MAX_CONCURRENT_WRITES,
    );
    this.maxPendingKeys = Math.max(1, options.maxPendingKeys ?? NATIVE_DISPLAY_TAIL_MAX_SESSIONS);
    this.clock = options.clock ?? monotonicNow;
    this.setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        // A display cache must never keep the process alive.
        timer.unref?.();
        return timer;
      });
    this.clearTimer =
      options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.unsubscribe =
      options.subscribeDeletions?.((event) => {
        if (event.kind === "key") this.discard(event.key);
        else this.discardEnvironment(event.environmentId);
      }) ?? null;
  }

  stats(): DisplayTailSchedulerStats {
    return { ...this.counters };
  }

  /** Keys with a pending or in-flight checkpoint (bounded by `maxPendingKeys`). */
  get size(): number {
    return this.entries.size;
  }

  update(key: string, source: DisplayTailCheckpointSource): void {
    if (this.stopped) {
      this.counters.droppedAfterStop += 1;
      return;
    }
    this.counters.updates += 1;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxPendingKeys) {
        // Admission: a preview cache never grows an unbounded backlog. The
        // provider remains the recovery source for a skipped checkpoint.
        this.counters.droppedAdmission += 1;
        return;
      }
      entry = {
        environmentId: source.environmentId,
        pending: null,
        dirtySince: 0,
        lastUpdate: 0,
        timer: null,
        timerDue: 0,
        writing: null,
        ready: false,
        dueWhileWriting: false,
      };
      this.entries.set(key, entry);
    }
    const now = this.clock();
    if (entry.pending) this.counters.coalesced += 1;
    else entry.dirtySince = now;
    entry.environmentId = source.environmentId;
    entry.pending = { build: source.build, fence: this.options.captureFence() };
    entry.lastUpdate = now;
    if (!entry.writing && !entry.ready) this.arm(key, entry);
  }

  private dueAt(entry: Entry): number {
    return Math.min(entry.lastUpdate + this.quietMs, entry.dirtySince + this.maxAgeMs);
  }

  /**
   * Arms at most one timer per key. An existing timer that fires no later
   * than the new due time is kept; when it fires early it re-arms for the
   * remainder instead of every update clearing and recreating a timer.
   */
  private arm(key: string, entry: Entry): void {
    const due = this.dueAt(entry);
    if (entry.timer !== null && entry.timerDue <= due) return;
    if (entry.timer !== null) this.clearTimer(entry.timer);
    entry.timerDue = due;
    entry.timer = this.setTimer(() => this.onTimer(key, entry), Math.max(0, due - this.clock()));
  }

  private onTimer(key: string, entry: Entry): void {
    entry.timer = null;
    if (this.entries.get(key) !== entry || !entry.pending) return;
    if (entry.writing) {
      entry.dueWhileWriting = true;
      return;
    }
    if (this.clock() + 1 < this.dueAt(entry)) {
      this.arm(key, entry);
      return;
    }
    this.enqueue(key, entry);
  }

  private enqueue(key: string, entry: Entry): void {
    if (entry.ready) return;
    entry.ready = true;
    this.ready.push(key);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.ready.length > 0) {
      const key = this.ready.shift()!;
      const entry = this.entries.get(key);
      if (!entry) continue;
      entry.ready = false;
      if (!entry.pending || entry.writing) continue;
      this.start(key, entry);
    }
  }

  private start(key: string, entry: Entry): Promise<void> {
    const pending = entry.pending!;
    entry.pending = null;
    entry.dueWhileWriting = false;
    if (entry.timer !== null) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
    this.active += 1;
    const run = (async () => {
      const tail = pending.build();
      if (!tail) return;
      const written = await this.options.write(key, tail, pending.fence);
      if (written) this.counters.writes += 1;
      else this.counters.failedWrites += 1;
    })()
      .catch(() => {
        this.counters.failedWrites += 1;
      })
      .finally(() => {
        this.active -= 1;
        entry.writing = null;
        if (this.entries.get(key) === entry) {
          if (entry.pending && this.stopped) {
            // Shutdown drain: the newer value that arrived during this write
            // is attempted once. No update can replace it after stop.
            if (this.draining) this.enqueue(key, entry);
          } else if (entry.pending) {
            // Updated during the write: one trailing write, still honouring
            // the quiet/max-age deadlines unless the timer already fired.
            if (entry.dueWhileWriting || this.clock() >= this.dueAt(entry)) {
              this.enqueue(key, entry);
            } else {
              this.arm(key, entry);
            }
          } else if (!entry.pending) {
            this.entries.delete(key);
          }
        }
        this.pump();
      });
    entry.writing = run;
    return run;
  }

  /** Writes `key`'s pending value now (tests and explicit checkpoints). */
  async flush(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.writing) await entry.writing;
    if (this.entries.get(key) !== entry || !entry.pending || entry.writing) return;
    if (entry.ready) {
      const index = this.ready.indexOf(key);
      if (index >= 0) this.ready.splice(index, 1);
      entry.ready = false;
    }
    await this.start(key, entry);
  }

  /** Drops pending state for a deleted key; an in-flight write is fenced by storage. */
  discard(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.pending) this.counters.discarded += 1;
    entry.pending = null;
    if (entry.timer !== null) this.clearTimer(entry.timer);
    entry.timer = null;
    if (!entry.writing) this.entries.delete(key);
  }

  discardEnvironment(environmentId: string): void {
    for (const [key, entry] of Array.from(this.entries)) {
      if (entry.environmentId === environmentId) this.discard(key);
    }
  }

  /**
   * Stops accepting updates and drains within `deadlineMs`. Each key's newest
   * pending value is attempted at most once; whatever is still pending or in
   * flight at the deadline is reported as skipped and abandoned.
   */
  async shutdown(
    deadlineMs = this.options.shutdownDeadlineMs ?? NATIVE_DISPLAY_TAIL_SHUTDOWN_DEADLINE_MS,
  ): Promise<DisplayTailShutdownReport> {
    this.stopped = true;
    this.draining = true;
    this.unsubscribe?.();
    const writesBefore = this.counters.writes;
    let attempted = 0;
    for (const [key, entry] of this.entries) {
      if (entry.timer !== null) this.clearTimer(entry.timer);
      entry.timer = null;
      if (entry.pending && !entry.writing) {
        attempted += 1;
        this.enqueue(key, entry);
      } else if (entry.pending) {
        attempted += 1;
      }
    }
    const deadline = Date.now() + Math.max(0, deadlineMs);
    while (this.active > 0 || this.ready.length > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const inFlight = Array.from(this.entries.values(), (entry) => entry.writing).filter(
        (write): write is Promise<void> => write !== null,
      );
      if (inFlight.length === 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.race(inFlight),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    this.draining = false;
    let skipped = 0;
    for (const entry of this.entries.values()) {
      if (entry.pending) skipped += 1;
      else if (entry.writing) skipped += 1;
      entry.pending = null;
    }
    this.ready.length = 0;
    this.entries.clear();
    return { attempted, written: this.counters.writes - writesBefore, skipped };
  }
}
