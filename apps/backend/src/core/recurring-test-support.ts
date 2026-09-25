/**
 * Deterministic time for recurring-work tests and the baseline harness.
 *
 * One manual clock drives both the monotonic `now()` the scheduler and
 * services read and the timers they arm. {@link ManualTime.advance} fires due
 * callbacks in due order, moving the clock to each one's due time first, and
 * drains microtasks between them so promise continuations observe the time
 * they would have in production. Nothing here sleeps.
 */

type ManualTimer = {
  id: number;
  dueAt: number;
  callback: () => void;
  intervalMs: number | null;
};

export class ManualTime {
  private current: number;
  private readonly timers = new Map<number, ManualTimer>();
  private nextId = 1;

  constructor(start = 0) {
    this.current = start;
  }

  readonly now = (): number => this.current;

  /** Timer factory in the recurring scheduler's `{ set, clear }` shape. */
  readonly timerFactory: {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
  } = {
    set: (callback, delayMs) => this.setTimeout(callback, delayMs),
    clear: (handle) => this.clear(handle),
  };

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, {
      id,
      dueAt: this.current + Math.max(0, delayMs),
      callback,
      intervalMs: null,
    });
    return id;
  }

  setInterval(callback: () => void, intervalMs: number): number {
    const id = this.nextId++;
    const period = Math.max(1, intervalMs);
    this.timers.set(id, { id, dueAt: this.current + period, callback, intervalMs: period });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /**
   * Advances the clock by `ms`, firing every timer that falls due on the way
   * (including ones armed by earlier callbacks), with microtasks drained after
   * each callback.
   */
  async advance(ms: number): Promise<void> {
    const target = this.current + Math.max(0, ms);
    while (true) {
      // Continuations queued before this call (a resolved gate, a settled
      // run) arm their timers at the current time, as they would in production.
      await flushMicrotasks();
      const next = this.earliest();
      if (!next || next.dueAt > target) break;
      this.current = Math.max(this.current, next.dueAt);
      if (next.intervalMs === null) this.timers.delete(next.id);
      else next.dueAt += next.intervalMs;
      next.callback();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }

  /**
   * Moves the clock without firing timers, as a suspended host would; the
   * next {@link advance} (even by 0) fires everything that became overdue.
   */
  jump(ms: number): void {
    this.current += Math.max(0, ms);
  }

  private earliest(): ManualTimer | undefined {
    let best: ManualTimer | undefined;
    for (const timer of this.timers.values()) {
      if (!best || timer.dueAt < best.dueAt || (timer.dueAt === best.dueAt && timer.id < best.id)) {
        best = timer;
      }
    }
    return best;
  }
}

/** Lets queued promise continuations run. Bounded; uses no timers. */
export async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    }),
    resolve: (value) => {
      result.settled = true;
      resolve(value);
    },
    reject: (error) => {
      result.settled = true;
      reject(error);
    },
    settled: false,
  };
  return result;
}
