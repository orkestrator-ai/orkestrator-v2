import { describe, expect, test } from "bun:test";
import { flushMicrotasks, ManualClock } from "@orkestrator/protocol/testing/manual-clock";
import { UpdateCoalescer } from "./coalescer.js";

describe("UpdateCoalescer", () => {
  test("coalesces a burst into one scheduled full snapshot", async () => {
    let published = 0;
    const clock = new ManualClock({ start: 1_000 });
    const coalescer = new UpdateCoalescer({
      intervalMs: 0,
      clock,
      publish: () => {
        published += 1;
      },
    });
    coalescer.schedule();
    coalescer.schedule();
    coalescer.schedule();
    expect(clock.pendingDelays()).toEqual([0]);
    await clock.advanceAsync(0);

    expect(published).toBe(1);
    expect(coalescer.getMetrics()).toEqual({ coalesced: 3, published: 1 });
    coalescer.stop();
  });

  test("publishes eventually at the interval selected for a schedule", async () => {
    const selectedIntervalMs = 40;
    const publishedAt: number[] = [];
    const clock = new ManualClock({ start: 1_000 });
    const coalescer = new UpdateCoalescer({
      intervalMs: () => selectedIntervalMs,
      clock,
      publish: () => {
        publishedAt.push(clock.now());
      },
    });

    await coalescer.flushNow();
    coalescer.schedule();
    expect(clock.pendingDelays()).toEqual([selectedIntervalMs]);

    await clock.advanceAsync(selectedIntervalMs - 1);
    expect(publishedAt).toEqual([1_000]);
    await clock.advanceAsync(1);

    expect(publishedAt).toEqual([1_000, 1_000 + selectedIntervalMs]);
    coalescer.stop();
  });

  test("re-reads a dynamic interval across schedules in both directions", async () => {
    let intervalMs = 35;
    const intervalReads: number[] = [];
    const publishedAt: number[] = [];
    const clock = new ManualClock({ start: 1_000 });
    const coalescer = new UpdateCoalescer({
      intervalMs: () => {
        intervalReads.push(intervalMs);
        return intervalMs;
      },
      clock,
      publish: () => {
        publishedAt.push(clock.now());
      },
    });

    await coalescer.flushNow();

    // Long to short: the next schedule must observe the newly shortened
    // interval, rather than retaining the previous schedule's value.
    intervalMs = 35;
    coalescer.schedule();
    expect(clock.pendingDelays()).toEqual([35]);
    await clock.advanceAsync(35);
    expect(publishedAt).toHaveLength(2);
    intervalMs = 0;
    coalescer.schedule();
    expect(clock.pendingDelays()).toEqual([0]);
    await clock.advanceAsync(0);
    expect(publishedAt).toHaveLength(3);

    // Short to long: after the immediate schedule, the callback must be
    // consulted again and defer the next publication.
    intervalMs = 35;
    coalescer.schedule();
    expect(clock.pendingDelays()).toEqual([35]);
    await clock.advanceAsync(35);

    expect(publishedAt).toEqual([1_000, 1_035, 1_035, 1_070]);

    expect(intervalReads).toEqual([35, 0, 35]);
    coalescer.stop();
  });

  test("flushNow bypasses a pending long dynamic interval", async () => {
    let published = 0;
    const clock = new ManualClock({ start: 1_000 });
    const coalescer = new UpdateCoalescer({
      intervalMs: () => 60_000,
      clock,
      publish: () => {
        published += 1;
      },
    });

    await coalescer.flushNow();
    coalescer.schedule();
    expect(clock.pendingDelays()).toEqual([60_000]);
    expect(published).toBe(1);

    await coalescer.flushNow();
    expect(published).toBe(2);

    // The cancelled cadence timer must not publish again.
    expect(clock.pendingCount()).toBe(0);
    await clock.advanceAsync(60_000);
    expect(published).toBe(2);
    coalescer.stop();
  });

  test("a terminal flush waits for the follow-up snapshot after an in-flight publish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let published = 0;
    const clock = new ManualClock({ start: 1_000 });
    const coalescer = new UpdateCoalescer({
      intervalMs: 0,
      clock,
      publish: async () => {
        published += 1;
        if (published === 1) await gate;
      },
    });

    const first = coalescer.flushNow();
    coalescer.schedule();
    let terminalFlushSettled = false;
    const terminalFlush = coalescer.flushNow().finally(() => {
      terminalFlushSettled = true;
    });
    // Only the gate can release the first publish; no timer is armed.
    expect(clock.pendingCount()).toBe(0);
    await flushMicrotasks();
    expect(terminalFlushSettled).toBe(false);

    release();
    await Promise.all([first, terminalFlush]);

    expect(published).toBe(2);
    coalescer.stop();
  });

  test("reports publish errors and remains usable", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const coalescer = new UpdateCoalescer({
      intervalMs: 0,
      publish: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("publish failed");
      },
      onError: (error) => errors.push(error),
    });

    await coalescer.flushNow();
    await coalescer.flushNow();
    expect(errors).toHaveLength(1);
    expect(coalescer.getMetrics()).toEqual({ coalesced: 0, published: 1 });
  });

  test("a change arriving during a failing publish is still published", async () => {
    // The follow-up snapshot is what carries the change; a failed publish must
    // not swallow it along with its own error.
    const errors: unknown[] = [];
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coalescer = new UpdateCoalescer({
      intervalMs: 0,
      publish: async () => {
        attempts += 1;
        if (attempts === 1) {
          await gate;
          throw new Error("publish failed");
        }
      },
      onError: (error) => errors.push(error),
    });

    const first = coalescer.flushNow();
    coalescer.schedule();
    release();
    await first;

    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    expect(coalescer.getMetrics().published).toBe(1);
    coalescer.stop();
  });

  test("a flush landing as a run finishes is not silently absorbed", async () => {
    /**
     * Regression: `runPromise` was cleared a microtask after the loop's final
     * dirty check, so a flush arriving in that window joined a run that had
     * already stopped consuming `dirty` and resolved without publishing.
     */
    const snapshots: number[] = [];
    let version = 0;
    const coalescer = new UpdateCoalescer({
      intervalMs: 0,
      publish: async () => {
        await Promise.resolve();
        snapshots.push(version);
      },
    });

    const first = coalescer.flushNow();
    await Promise.resolve();
    version = 1;
    const second = coalescer.flushNow();
    await Promise.all([first, second]);

    // The latest version must appear in a published snapshot.
    expect(snapshots).toContain(1);
    coalescer.stop();
  });

  test("stop cancels pending work and makes schedule/flush no-ops", async () => {
    let published = 0;
    const clock = new ManualClock({ start: 1_000 });
    const coalescer = new UpdateCoalescer({
      intervalMs: 50,
      clock,
      publish: () => {
        published += 1;
      },
    });
    coalescer.schedule(1);
    expect(clock.pendingCount()).toBe(1);
    coalescer.stop();
    expect(clock.pendingCount()).toBe(0);
    coalescer.schedule();
    await coalescer.flushNow();
    await clock.advanceAsync(50);
    expect(coalescer.isStopped()).toBe(true);
    expect(published).toBe(0);
  });
});
