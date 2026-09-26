import { describe, expect, test } from "bun:test";
import {
  BridgeLifecycle,
  type BridgeLifecycleOptions,
  type LifecycleSignalTarget,
} from "./bridge-lifecycle.js";
import { FakeIntervals } from "./fake-intervals.js";

class FakeSignals implements LifecycleSignalTarget {
  readonly listeners = new Map<string, Set<() => void>>();

  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown {
    const set = this.listeners.get(signal) ?? new Set();
    set.add(listener);
    this.listeners.set(signal, set);
    return this;
  }

  off(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown {
    this.listeners.get(signal)?.delete(listener);
    return this;
  }

  count(): number {
    return [...this.listeners.values()].reduce((total, set) => total + set.size, 0);
  }

  emit(signal: "SIGTERM" | "SIGINT"): void {
    const set = this.listeners.get(signal);
    if (!set) return;
    const listeners = [...set];
    for (const listener of listeners) listener();
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<BridgeLifecycleOptions> = {}) {
  const timers = new FakeIntervals();
  const signals = new FakeSignals();
  const calls = { open: 0, close: 0, sweep: 0, exits: [] as number[], reports: [] as string[] };
  let parentAlive = true;
  const lifecycle = new BridgeLifecycle({
    label: "[test-bridge]",
    open: async () => {
      calls.open += 1;
    },
    close: async () => {
      calls.close += 1;
    },
    idleSweep: {
      intervalMs: 60_000,
      run: () => {
        calls.sweep += 1;
      },
    },
    parentPid: 4213,
    parentWatchMs: 5_000,
    exit: (code) => calls.exits.push(code),
    timers,
    isParentAlive: () => parentAlive,
    signals,
    report: (message) => calls.reports.push(message),
    ...overrides,
  });
  return {
    lifecycle,
    timers,
    signals,
    calls,
    killParent: () => {
      parentAlive = false;
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("BridgeLifecycle", () => {
  test("arms one idle sweep and a five-second parent watch, not the fifteen-second default", async () => {
    const { lifecycle, timers, signals } = harness();
    await lifecycle.start();

    expect(lifecycle.phase).toBe("started");
    expect(timers.periods()).toEqual([5_000, 60_000]);
    expect(signals.count()).toBe(2);
  });

  test("explicit shutdown without exit leaves no timer and no signal handler armed", async () => {
    const { lifecycle, timers, signals, calls } = harness();
    await lifecycle.start();

    await lifecycle.shutdown();

    expect(timers.armed.size).toBe(0);
    expect(signals.count()).toBe(0);
    expect(calls.close).toBe(1);
    expect(calls.exits).toEqual([]);
    expect(lifecycle.phase).toBe("stopped");
  });

  test("clears its timers before awaiting disposal", async () => {
    const closing = deferred();
    const { lifecycle, timers, calls } = harness({ close: () => closing.promise });
    await lifecycle.start();

    const shutdown = lifecycle.shutdown();
    // Disposal is still pending, yet nothing is left to fire into it.
    expect(timers.armed.size).toBe(0);
    expect(lifecycle.closing).toBe(true);
    timers.tick(10 * 60_000);
    expect(calls.sweep).toBe(0);

    closing.resolve();
    await shutdown;
  });

  test("repeated termination signals join the pending shutdown", async () => {
    const closing = deferred();
    let closes = 0;
    const { lifecycle, signals, calls } = harness({
      close: () => {
        closes += 1;
        return closing.promise;
      },
    });
    await lifecycle.start();
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    expect(signals.count()).toBe(2);
    expect(calls.exits).toEqual([]);
    closing.resolve();
    await lifecycle.requestExit();
    expect(closes).toBe(1);
    expect(calls.exits).toEqual([0]);
  });

  test("a repeated start rejects without arming a second set of timers", async () => {
    const { lifecycle, timers, signals, calls } = harness();
    await lifecycle.start();

    await expect(lifecycle.start()).rejects.toThrow("already started");
    expect(timers.periods()).toEqual([5_000, 60_000]);
    expect(signals.count()).toBe(2);
    expect(calls.open).toBe(1);
  });

  test("a start racing the first one rejects before opening again", async () => {
    const opening = deferred();
    const { lifecycle, calls } = harness({
      open: async () => {
        calls.open += 1;
        await opening.promise;
      },
    });

    const first = lifecycle.start();
    await expect(lifecycle.start()).rejects.toThrow("already started");
    opening.resolve();
    await first;
    expect(calls.open).toBe(1);
  });

  test("start after shutdown is refused rather than resurrecting released state", async () => {
    const { lifecycle, timers, calls } = harness();
    await lifecycle.start();
    await lifecycle.shutdown();

    await expect(lifecycle.start()).rejects.toThrow("already started");
    expect(timers.armed.size).toBe(0);
    expect(calls.open).toBe(1);
  });

  test("a shutdown that lands while opening prevents any timer from being armed", async () => {
    const opening = deferred();
    const { lifecycle, timers, signals } = harness({ open: () => opening.promise });

    const starting = lifecycle.start();
    const shutdown = lifecycle.shutdown();
    opening.resolve();
    await starting;
    await shutdown;

    expect(timers.armed.size).toBe(0);
    expect(signals.count()).toBe(0);
    expect(lifecycle.phase).toBe("stopped");
  });

  test("the idle sweep runs on its interval and reports, rather than throws, a failure", async () => {
    let throwNext = false;
    const { lifecycle, timers, calls } = harness({
      idleSweep: {
        intervalMs: 60_000,
        run: () => {
          calls.sweep += 1;
          if (throwNext) throw new TypeError("contains /private/path");
        },
      },
    });
    await lifecycle.start();

    timers.tick(60_000);
    expect(calls.sweep).toBe(1);
    throwNext = true;
    expect(() => timers.tick(60_000)).not.toThrow();
    expect(calls.sweep).toBe(2);
    // Content-free: the class name only, never the message.
    expect(calls.reports).toEqual(["[test-bridge] idle sweep failed (TypeError)"]);
  });

  test("a late sweep callback after shutdown does nothing", async () => {
    const { lifecycle, timers, calls } = harness();
    await lifecycle.start();
    const sweep = [...timers.armed.values()].find((entry) => entry.ms === 60_000)!;

    await lifecycle.shutdown();
    // The runtime can already have dequeued a callback when the interval was
    // cleared; invoking the captured one models exactly that.
    sweep.callback();

    expect(calls.sweep).toBe(0);
  });

  test("parent death triggers exactly one shutdown and one exit", async () => {
    const { lifecycle, timers, signals, calls, killParent } = harness();
    await lifecycle.start();

    timers.tick(5_000);
    expect(calls.close).toBe(0);
    killParent();
    timers.tick(5_000);
    // Further ticks and a racing signal must join the same shutdown.
    timers.tick(20_000);
    signals.emit("SIGTERM");
    await settle();

    expect(calls.close).toBe(1);
    expect(calls.exits).toEqual([0]);
    expect(timers.armed.size).toBe(0);
    expect(signals.count()).toBe(0);
  });

  test("a failed shutdown is reported and still exits, once", async () => {
    const { lifecycle, calls, killParent, timers } = harness({
      close: async () => {
        calls.close += 1;
        throw new Error("dispose failed with a secret");
      },
    });
    await lifecycle.start();

    killParent();
    timers.tick(5_000);
    await lifecycle.requestExit();
    await lifecycle.requestExit();

    expect(calls.close).toBe(1);
    expect(calls.exits).toEqual([1]);
    expect(calls.reports).toEqual(["[test-bridge] shutdown failed (Error)"]);
  });

  test("a signal shuts down and exits once; the handler for the other signal is removed", async () => {
    const { lifecycle, signals, calls, timers } = harness();
    await lifecycle.start();

    signals.emit("SIGINT");
    await settle();

    expect(calls.close).toBe(1);
    expect(calls.exits).toEqual([0]);
    expect(signals.count()).toBe(0);
    expect(timers.armed.size).toBe(0);
  });

  test("no parent means no parent watch", async () => {
    const { lifecycle, timers } = harness({ parentPid: null });
    await lifecycle.start();

    expect(timers.periods()).toEqual([60_000]);
    await lifecycle.shutdown();
    expect(timers.armed.size).toBe(0);
  });
});
