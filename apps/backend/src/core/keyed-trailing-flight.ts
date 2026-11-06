interface QueuedRun<T> {
  start: () => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface Lane<T> {
  queued: QueuedRun<T> | null;
}

/**
 * At most one run per key, and every caller is answered by a run that started
 * after it asked. A caller arriving while a run is in flight waits for it, then
 * shares one follow-up run with every other caller that arrived meanwhile.
 *
 * {@link KeyedSingleFlight} joins the run already in flight instead, which is
 * cheaper but can answer with an observation taken before the caller asked. Use
 * this one where that matters, such as a guard capturing a baseline.
 *
 * Callers sharing a key must want the same work: a queued run executes the
 * `start` of the first caller that queued it.
 */
export class KeyedTrailingFlight<T> {
  private readonly lanes = new Map<string, Lane<T>>();

  run(key: string, start: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(key);
    if (!lane) {
      const fresh: Lane<T> = { queued: null };
      this.lanes.set(key, fresh);
      return this.execute(key, fresh, start);
    }
    if (!lane.queued) {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      lane.queued = { start, promise, resolve, reject };
    }
    return lane.queued.promise;
  }

  /** Keys with a run in flight. */
  get size(): number {
    return this.lanes.size;
  }

  private async execute(key: string, lane: Lane<T>, start: () => Promise<T>): Promise<T> {
    try {
      return await start();
    } finally {
      const queued = lane.queued;
      lane.queued = null;
      if (queued) {
        this.execute(key, lane, queued.start).then(queued.resolve, queued.reject);
      } else {
        this.lanes.delete(key);
      }
    }
  }
}
