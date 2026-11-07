/**
 * Fakes for tests of the node-scope lifecycle (`lifecycle.ts`): a manual
 * clock with timeouts and intervals, a document visibility and a memory
 * warning source the test drives.
 */

import type { Unlisten } from "@orkestrator/protocol/node-client";
import type { LifecycleClock, LifecycleMemoryWarnings, LifecycleVisibility } from "./lifecycle";

interface Timer {
  at: number;
  callback: () => void;
  every: number | null;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Manual timers. `advance` runs due timers in time order and drains microtasks after each. */
export class FakeLifecycleClock implements LifecycleClock {
  time = 1_000;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  now = () => this.time;
  setTimeout = (callback: () => void, ms: number) => this.add(callback, ms, null);
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };
  setInterval = (callback: () => void, ms: number) => this.add(callback, ms, Math.max(1, ms));
  clearInterval = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  /** Timeouts and intervals not yet cleared. */
  get pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let next: { id: number; timer: Timer } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.timer.at || (timer.at === next.timer.at && id < next.id)) {
          next = { id, timer };
        }
      }
      if (!next) break;
      const { id, timer } = next;
      this.time = timer.at;
      if (timer.every === null) this.timers.delete(id);
      else timer.at += timer.every;
      timer.callback();
      await flushMicrotasks();
    }
    this.time = target;
    await flushMicrotasks();
  }

  private add(callback: () => void, ms: number, every: number | null): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback, every });
    return id;
  }
}

export class FakeVisibility implements LifecycleVisibility {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  isHidden = () => this.hidden;
  subscribe = (listener: () => void): Unlisten => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of Array.from(this.listeners)) listener();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

export class FakeMemoryWarnings implements LifecycleMemoryWarnings {
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void): Unlisten => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  warn(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}
