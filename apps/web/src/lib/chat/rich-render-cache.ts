/**
 * Bounded scheduling and caching for expensive rich-content rendering
 * (syntax highlighting, diagram rendering).
 *
 * - Lanes have fixed concurrency (2 highlight jobs, 1 diagram job).
 * - At most 32 queued jobs holding at most 2 MiB of source in total; beyond
 *   that a request is refused with `capacity` so the caller shows its plain
 *   source fallback instead of growing an unbounded promise list.
 * - Visible work runs before idle prefetch.
 * - In-flight work is de-duplicated by cache key and counted separately from
 *   settled results; cancelling the last subscriber removes queued work and
 *   updates both the count and the byte total.
 * - Settled results live in an LRU of at most 128 entries / 16 MiB
 *   (estimated). Deterministic failures (invalid source) are cached for that
 *   revision; transient ones are not, so a retry can succeed.
 * - Counters are content-free.
 */
import { useSyncExternalStore } from "react";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";

export type RichRenderLane = "highlight" | "diagram";
export type RichRenderPriority = "visible" | "prefetch";

export interface RichRenderOutput<T> {
  value: T;
  /** Estimated retained bytes of the settled value. */
  bytes: number;
  /** Release DOM nodes / object URLs when evicted. */
  release?: () => void;
}

export class RichRenderCapacityError extends Error {
  constructor(readonly resource: "jobs" | "bytes") {
    super(
      resource === "jobs"
        ? "Too many rich renders are queued"
        : "Queued rich render source exceeds its budget",
    );
    this.name = "RichRenderCapacityError";
  }
}

/** A failure that will repeat for this exact input; it is cached. */
export class RichRenderDeterministicError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RichRenderDeterministicError";
  }
}

type Settled =
  | { ok: true; output: RichRenderOutput<unknown>; bytes: number }
  | { ok: false; error: unknown; bytes: number };

interface Job {
  key: string;
  lane: RichRenderLane;
  priority: RichRenderPriority;
  sourceBytes: number;
  run: (signal: AbortSignal) => Promise<RichRenderOutput<unknown>>;
  controller: AbortController;
  subscribers: number;
  started: boolean;
  promise: Promise<RichRenderOutput<unknown>>;
  resolve: (value: RichRenderOutput<unknown>) => void;
  reject: (error: unknown) => void;
}

export interface RichRenderCounters {
  requested: number;
  cacheHits: number;
  deduplicated: number;
  started: number;
  completed: number;
  failed: number;
  cancelled: number;
  refused: number;
  evicted: number;
}

const LANE_CONCURRENCY: Record<RichRenderLane, number> = {
  highlight: FRONTEND_RENDER_POLICY.highlightConcurrency,
  diagram: FRONTEND_RENDER_POLICY.diagramConcurrency,
};

export class RichRenderScheduler {
  private readonly settled = new Map<string, Settled>();
  private settledBytes = 0;
  private readonly inflight = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private queuedBytes = 0;
  private readonly running: Record<RichRenderLane, number> = { highlight: 0, diagram: 0 };
  readonly counters: RichRenderCounters = {
    requested: 0,
    cacheHits: 0,
    deduplicated: 0,
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    refused: 0,
    evicted: 0,
  };

  constructor(
    private readonly limits: {
      maxQueuedJobs: number;
      maxQueuedSourceBytes: number;
      maxSettledEntries: number;
      maxSettledBytes: number;
    } = {
      maxQueuedJobs: FRONTEND_RENDER_POLICY.maxQueuedJobs,
      maxQueuedSourceBytes: FRONTEND_RENDER_POLICY.maxQueuedSourceBytes,
      maxSettledEntries: FRONTEND_RENDER_POLICY.maxSettledCacheEntries,
      maxSettledBytes: FRONTEND_RENDER_POLICY.maxSettledCacheBytes,
    },
  ) {}

  /** Synchronously read a settled result (moving it to most-recently-used). */
  peek<T>(key: string): { ok: true; value: T } | { ok: false; error: unknown } | null {
    const entry = this.settled.get(key);
    if (!entry) return null;
    this.settled.delete(key);
    this.settled.set(key, entry);
    return entry.ok
      ? { ok: true, value: entry.output.value as T }
      : { ok: false, error: entry.error };
  }

  request<T>(input: {
    key: string;
    lane: RichRenderLane;
    priority?: RichRenderPriority;
    sourceBytes: number;
    run: (signal: AbortSignal) => Promise<RichRenderOutput<T>>;
  }): { promise: Promise<T>; cancel: () => void } {
    this.counters.requested++;
    const cached = this.peek<T>(input.key);
    if (cached) {
      this.counters.cacheHits++;
      return {
        promise: cached.ok ? Promise.resolve(cached.value) : Promise.reject(cached.error),
        cancel: () => {},
      };
    }
    let job = this.inflight.get(input.key);
    if (job) {
      this.counters.deduplicated++;
      job.subscribers++;
      if (input.priority === "visible" && job.priority === "prefetch" && !job.started) {
        job.priority = "visible";
        this.sortQueue();
      }
    } else {
      if (this.queue.length >= this.limits.maxQueuedJobs) {
        this.counters.refused++;
        return { promise: Promise.reject(new RichRenderCapacityError("jobs")), cancel: () => {} };
      }
      if (this.queuedBytes + input.sourceBytes > this.limits.maxQueuedSourceBytes) {
        this.counters.refused++;
        return { promise: Promise.reject(new RichRenderCapacityError("bytes")), cancel: () => {} };
      }
      let resolve!: Job["resolve"];
      let reject!: Job["reject"];
      const promise = new Promise<RichRenderOutput<unknown>>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Subscribers attach their own handlers; this keeps an unobserved
      // cancellation from becoming an unhandled rejection.
      promise.catch(() => {});
      job = {
        key: input.key,
        lane: input.lane,
        priority: input.priority ?? "visible",
        sourceBytes: input.sourceBytes,
        run: input.run as Job["run"],
        controller: new AbortController(),
        subscribers: 1,
        started: false,
        promise,
        resolve,
        reject,
      };
      this.inflight.set(input.key, job);
      this.queue.push(job);
      this.queuedBytes += job.sourceBytes;
      this.sortQueue();
      this.pump();
    }
    const owned = job;
    let cancelled = false;
    return {
      promise: owned.promise.then((output) => output.value as T),
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        owned.subscribers--;
        if (owned.subscribers > 0) return;
        this.cancelJob(owned);
      },
    };
  }

  private cancelJob(job: Job): void {
    if (this.inflight.get(job.key) !== job) return;
    this.counters.cancelled++;
    this.inflight.delete(job.key);
    if (!job.started) {
      const index = this.queue.indexOf(job);
      if (index >= 0) {
        this.queue.splice(index, 1);
        this.queuedBytes -= job.sourceBytes;
      }
    }
    job.controller.abort();
    job.reject(new DOMException("Rich render cancelled", "AbortError"));
  }

  private sortQueue(): void {
    // Stable: visible before prefetch, otherwise FIFO.
    this.queue.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "visible" ? -1 : 1));
  }

  private pump(): void {
    for (let index = 0; index < this.queue.length;) {
      const job = this.queue[index]!;
      if (this.running[job.lane] >= LANE_CONCURRENCY[job.lane]) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      this.queuedBytes -= job.sourceBytes;
      this.start(job);
    }
  }

  private start(job: Job): void {
    job.started = true;
    this.running[job.lane]++;
    this.counters.started++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.running[job.lane]--;
      this.pump();
    };
    Promise.resolve()
      .then(() => job.run(job.controller.signal))
      .then(
        (output) => {
          finish();
          if (this.inflight.get(job.key) !== job) {
            output.release?.();
            return;
          }
          this.inflight.delete(job.key);
          this.counters.completed++;
          this.store(job.key, { ok: true, output, bytes: Math.max(0, output.bytes) });
          job.resolve(output);
        },
        (error: unknown) => {
          finish();
          if (this.inflight.get(job.key) !== job) return;
          this.inflight.delete(job.key);
          this.counters.failed++;
          if (error instanceof RichRenderDeterministicError) {
            this.store(job.key, { ok: false, error, bytes: 256 });
          }
          job.reject(error);
        },
      );
  }

  private store(key: string, entry: Settled): void {
    const previous = this.settled.get(key);
    if (previous) this.drop(key, previous);
    this.settled.set(key, entry);
    this.settledBytes += entry.bytes;
    for (const [candidate, value] of Array.from(this.settled.entries())) {
      if (
        this.settled.size <= this.limits.maxSettledEntries &&
        this.settledBytes <= this.limits.maxSettledBytes
      )
        break;
      if (candidate === key) continue;
      this.drop(candidate, value);
      this.counters.evicted++;
    }
  }

  private drop(key: string, entry: Settled): void {
    this.settled.delete(key);
    this.settledBytes -= entry.bytes;
    if (entry.ok) entry.output.release?.();
  }

  /**
   * Raise a queued prefetch job to visible priority (its block scrolled into
   * view). No effect on started, settled or unknown work.
   */
  promote(key: string): void {
    const job = this.inflight.get(key);
    if (!job || job.started || job.priority === "visible") return;
    job.priority = "visible";
    this.sortQueue();
  }

  /** Drop every settled and queued entry (logout, environment replacement, revocation). */
  clear(): void {
    this.clearMatching(() => true);
  }

  /**
   * Cancel in-flight work and drop settled entries whose key matches (a
   * deleted environment or conversation). Subscribers of cancelled work see
   * an AbortError and can re-request after `epoch()` changes.
   */
  clearMatching(predicate: (key: string) => boolean): void {
    let changed = false;
    for (const job of Array.from(this.inflight.values())) {
      if (!predicate(job.key)) continue;
      this.cancelJob(job);
      changed = true;
    }
    for (const [key, entry] of Array.from(this.settled.entries())) {
      if (!predicate(key)) continue;
      this.drop(key, entry);
      changed = true;
    }
    if (changed) this.bumpEpoch();
  }

  private epochValue = 0;
  private readonly epochListeners = new Set<() => void>();

  private bumpEpoch(): void {
    this.epochValue++;
    for (const listener of Array.from(this.epochListeners)) listener();
  }

  /** Changes whenever cached or in-flight work was cleared; callers re-request on change. */
  epoch(): number {
    return this.epochValue;
  }

  subscribeEpoch(listener: () => void): () => void {
    this.epochListeners.add(listener);
    return () => {
      this.epochListeners.delete(listener);
    };
  }

  /** Invalidate settled entries whose key includes `fragment` (theme/font/renderer change). */
  invalidate(predicate: (key: string) => boolean): void {
    for (const [key, entry] of Array.from(this.settled.entries())) {
      if (predicate(key)) this.drop(key, entry);
    }
  }

  stats(): {
    queued: number;
    queuedBytes: number;
    running: number;
    settled: number;
    settledBytes: number;
    inflight: number;
  } {
    return {
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      running: this.running.highlight + this.running.diagram,
      settled: this.settled.size,
      settledBytes: this.settledBytes,
      inflight: this.inflight.size,
    };
  }
}

/** One scheduler per renderer window. */
export const richRenderScheduler = new RichRenderScheduler();

const subscribeEpoch = (listener: () => void) => richRenderScheduler.subscribeEpoch(listener);
const readEpoch = () => richRenderScheduler.epoch();

/**
 * The shared scheduler's clear generation. Include it in a render effect's
 * dependencies so work cancelled by a clear (logout, deletion) is requested
 * again for content that is still on screen.
 */
export function useRichRenderEpoch(): number {
  return useSyncExternalStore(subscribeEpoch, readEpoch, readEpoch);
}
