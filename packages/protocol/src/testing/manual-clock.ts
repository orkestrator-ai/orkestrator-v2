/**
 * A manually driven clock for tests: every timer it hands out fires only when
 * the test advances it.
 *
 * Pass it wherever a module takes a timer seam (`TimeoutTimers`,
 * `IntervalTimers` or `Timers` from `@orkestrator/protocol/timers`, or a
 * module's own interface of the same shape) and call `advance` instead of
 * sleeping past the delay. A test then proves a deadline has passed by
 * passing it, and proves one has not by not passing it, whatever the load on
 * the host. See docs/development/testing-guide.md, "Controlled time".
 *
 * Only the code that receives the clock is controlled. Promises, I/O and any
 * timer armed through the global `setTimeout` keep running in real time, so a
 * timer callback that starts asynchronous work needs `advanceAsync` (which
 * lets each callback's promise chain settle before the next timer runs) or an
 * awaited signal from that work.
 */
import type { Timers } from "../timers.js";

interface ManualTimer {
  callback: () => void;
  due: number;
  /** Set for an interval: the period it re-arms with. */
  period?: number;
  /** Scheduling order, which breaks ties between timers due at the same time. */
  sequence: number;
}

export interface ManualClockOptions {
  /** The initial `now()`, in milliseconds. Defaults to 0. */
  start?: number;
}

/**
 * The most timers one advance may run. A callback that re-arms a zero-delay
 * timer would otherwise loop forever inside a single advance.
 */
const MAX_TIMERS_PER_ADVANCE = 100_000;

/**
 * Microtask turns `flushMicrotasks` yields by default: enough for the promise
 * chains of mocked asynchronous dependencies, which resolve without real I/O.
 */
const DEFAULT_MICROTASK_TURNS = 50;

/** Yields `turns` microtask turns so promise chains started by a timer can settle. */
export async function flushMicrotasks(turns = DEFAULT_MICROTASK_TURNS): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function delayOf(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export class ManualClock implements Timers {
  #now: number;
  #nextHandle = 1;
  #sequence = 0;
  readonly #timers = new Map<number, ManualTimer>();

  constructor(options: ManualClockOptions = {}) {
    this.#now = options.start ?? 0;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    return this.#arm(callback, delayOf(ms), undefined);
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setInterval(callback: () => void, ms: number): unknown {
    // A zero period would fire forever within one instant; runtimes clamp it too.
    const period = Math.max(1, delayOf(ms));
    return this.#arm(callback, period, period);
  }

  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** How many timers are armed. */
  pendingCount(): number {
    return this.#timers.size;
  }

  /** Milliseconds until each armed timer fires, soonest first. */
  pendingDelays(): number[] {
    return [...this.#timers.values()].map((timer) => timer.due - this.#now).sort((a, b) => a - b);
  }

  /** The periods of the armed intervals, sorted. */
  intervalPeriods(): number[] {
    return [...this.#timers.values()]
      .flatMap((timer) => (timer.period === undefined ? [] : [timer.period]))
      .sort((a, b) => a - b);
  }

  /**
   * Moves time forward by `ms`, running every timer that falls due on the way
   * in due order, including timers those callbacks arm within the window.
   * Returns how many timers ran. A callback that throws stops the advance and
   * rethrows, with time left at that callback's due time.
   */
  advance(ms: number): number {
    const until = this.#now + delayOf(ms);
    let ran = 0;
    for (let timer = this.#nextDue(until); timer; timer = this.#nextDue(until)) {
      ran = this.#guard(ran);
      this.#fire(timer);
    }
    this.#now = until;
    return ran;
  }

  /**
   * Like `advance`, but awaits `settle` after each timer so the promise chain
   * its callback started (a mocked save, a retry) completes before the next
   * timer is considered, and once more at the end.
   */
  async advanceAsync(
    ms: number,
    settle: () => Promise<void> = () => flushMicrotasks(),
  ): Promise<number> {
    const until = this.#now + delayOf(ms);
    let ran = 0;
    await settle();
    for (let timer = this.#nextDue(until); timer; timer = this.#nextDue(until)) {
      ran = this.#guard(ran);
      this.#fire(timer);
      await settle();
    }
    this.#now = until;
    return ran;
  }

  /**
   * Moves time to the soonest armed timer and runs it (and any other timer due
   * at that instant). Returns how many ran; 0 when nothing is armed.
   */
  advanceToNext(): number {
    const next = this.#nextDue(Number.POSITIVE_INFINITY);
    return next ? this.advance(next[1].due - this.#now) : 0;
  }

  #arm(callback: () => void, delay: number, period: number | undefined): number {
    const handle = this.#nextHandle++;
    this.#timers.set(handle, {
      callback,
      due: this.#now + delay,
      period,
      sequence: this.#sequence++,
    });
    return handle;
  }

  /** The handle and timer due soonest at or before `until`, scheduling order breaking ties. */
  #nextDue(until: number): [number, ManualTimer] | undefined {
    let found: [number, ManualTimer] | undefined;
    for (const entry of this.#timers) {
      const timer = entry[1];
      if (timer.due > until) continue;
      if (
        !found ||
        timer.due < found[1].due ||
        (timer.due === found[1].due && timer.sequence < found[1].sequence)
      )
        found = entry;
    }
    return found;
  }

  #fire([handle, timer]: [number, ManualTimer]): void {
    this.#now = timer.due;
    if (timer.period === undefined) {
      this.#timers.delete(handle);
    } else {
      timer.due += timer.period;
      timer.sequence = this.#sequence++;
    }
    timer.callback();
  }

  #guard(ran: number): number {
    if (ran >= MAX_TIMERS_PER_ADVANCE)
      throw new Error(
        `ManualClock ran ${MAX_TIMERS_PER_ADVANCE} timers in one advance; ` +
          "a callback is probably re-arming a zero-delay timer",
      );
    return ran + 1;
  }
}
