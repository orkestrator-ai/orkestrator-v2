/**
 * A manually driven interval clock for lifecycle tests.
 *
 * Tests assert what is still armed after a shutdown and drive time without
 * sleeping. Implements the same `IntervalTimers` seam production owners take.
 */
import type { IntervalTimers } from "./parent-watchdog.js";

/** Manually driven intervals: `tick` fires every armed callback due by then. */
export class FakeIntervals implements IntervalTimers {
  #next = 1;
  readonly armed = new Map<number, { callback: () => void; ms: number; due: number }>();
  now = 0;

  setInterval(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.armed.set(id, { callback, ms, due: this.now + ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.armed.delete(handle as number);
  }

  /** The interval periods currently armed, sorted, for readable assertions. */
  periods(): number[] {
    return [...this.armed.values()].map((entry) => entry.ms).sort((a, b) => a - b);
  }

  tick(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, entry] of this.armed) {
        if (entry.due <= until && entry.due < nextDue) {
          nextId = id;
          nextDue = entry.due;
        }
      }
      if (nextId === undefined) break;
      const entry = this.armed.get(nextId)!;
      this.now = entry.due;
      entry.due += entry.ms;
      entry.callback();
    }
    this.now = until;
  }
}
