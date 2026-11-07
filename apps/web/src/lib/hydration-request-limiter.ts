/**
 * At most this many hydration reads are in flight per renderer document.
 *
 * A cold boot of a node's workspace used to send every environment's prompt queues and Multi
 * Review workflows and every project's environments and build pipelines at
 * once: 184 requests over 73 connections for one omarchy-hp boot, 419–532
 * requests/s for an mbp3 one (2026-11-06). Six matches the per-host connection
 * limit Chromium already applies over HTTP/1.1, so on that path the bound
 * costs nothing, while over HTTP/2 and the relay it stops one boot from
 * opening a burst of streams the node then answers in arbitrary order.
 */
export const HYDRATION_MAX_IN_FLIGHT = 6;

/**
 * A first-in, first-out bound on concurrent requests. A task starts at once
 * when a slot is free, so an idle renderer pays no extra tick. A task that
 * rejects frees its slot exactly as one that resolves, so a failing read never
 * holds up the reads queued behind it. Tasks must not wait on another task of
 * the same limiter, which could deadlock; every caller wraps one leaf request.
 */
export class RequestLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private startedCount = 0;

  constructor(private readonly maxInFlight: number) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error("maxInFlight must be a positive integer");
    }
  }

  /** Requests started since this limiter was created (or last reset). */
  get started(): number {
    return this.startedCount;
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        this.startedCount += 1;
        let settled: Promise<T>;
        try {
          settled = Promise.resolve(task());
        } catch (error) {
          settled = Promise.reject(error);
        }
        settled.then(resolve, reject).finally(() => this.release());
      };
      if (this.active < this.maxInFlight) start();
      else this.waiting.push(start);
    });
  }

  /** Resolves once nothing is in flight or queued. */
  whenIdle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Tests only: forget counts and queued work. */
  resetForTests(): void {
    this.active = 0;
    this.waiting.length = 0;
    this.startedCount = 0;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    if (this.active === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

/** The renderer's one bound for hydration reads (see `HYDRATION_MAX_IN_FLIGHT`). */
export const hydrationRequests = new RequestLimiter(HYDRATION_MAX_IN_FLIGHT);

/** Admit at most two Docker-reconciling reads to the shared six-slot pool.
 * Waiting here consumes no shared slot, leaving capacity for persisted reads.
 */
export const environmentRequests = new RequestLimiter(2);
