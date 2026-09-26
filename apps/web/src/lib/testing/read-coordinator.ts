/**
 * Deterministic fakes for read-coordinator tests: a manual timer queue, a
 * controllable document/window, and a helper that installs a fake-backed
 * shared coordinator for hook tests. Test-only; never imported by app code.
 */
import {
  createReadCoordinator,
  resetReadCoordinatorForTests,
  type ReadCoordinator,
  type ReadCoordinatorClock,
  type ReadCoordinatorOptions,
} from "@/lib/read-coordinator";

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Manual timer queue. `advance` runs due timers in order and drains microtasks. */
export class FakeClock implements ReadCoordinatorClock {
  time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.time;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let next: { id: number; at: number; callback: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && id < next.id)) {
          next = { id, ...timer };
        }
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.time = next.at;
      next.callback();
      await flushMicrotasks();
    }
    this.time = target;
    await flushMicrotasks();
  }
}

export class FakeEvents {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener();
  }
  get listenerCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

export class FakeDocument extends FakeEvents {
  visibilityState: "visible" | "hidden" = "visible";
  setVisibility(state: "visible" | "hidden") {
    this.visibilityState = state;
    this.dispatch("visibilitychange");
  }
}

export interface FakeReadEnvironment {
  clock: FakeClock;
  document: FakeDocument;
  window: FakeEvents;
  coordinator: ReadCoordinator;
}

export function createFakeReadEnvironment(
  options: Partial<ReadCoordinatorOptions> = {},
): FakeReadEnvironment {
  const clock = new FakeClock();
  const document = new FakeDocument();
  const window = new FakeEvents();
  const coordinator = createReadCoordinator({
    clock,
    document,
    window,
    random: () => 0,
    ...options,
  });
  return { clock, document, window, coordinator };
}

/**
 * Makes the shared coordinator (used by hooks) a fake-backed one. Call
 * `resetReadCoordinatorForTests()` in `afterEach` to restore the default.
 */
export function installFakeReadCoordinator(
  options: Partial<ReadCoordinatorOptions> = {},
): FakeReadEnvironment {
  const environment = createFakeReadEnvironment(options);
  resetReadCoordinatorForTests(() => environment.coordinator);
  return environment;
}
