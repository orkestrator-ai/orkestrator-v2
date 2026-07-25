import { describe, expect, test } from "bun:test";
import { UpdateCoalescer } from "./coalescer.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("UpdateCoalescer", () => {
  test("coalesces a burst into one scheduled full snapshot", async () => {
    let published = 0;
    const coalescer = new UpdateCoalescer({
      intervalMs: 0,
      publish: () => {
        published += 1;
      },
    });
    coalescer.schedule();
    coalescer.schedule();
    coalescer.schedule();
    await tick();

    expect(published).toBe(1);
    expect(coalescer.getMetrics()).toEqual({ coalesced: 3, published: 1 });
    coalescer.stop();
  });

  test("a terminal flush waits for the follow-up snapshot after an in-flight publish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let published = 0;
    const coalescer = new UpdateCoalescer({
      intervalMs: 0,
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
    await tick();
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
    const coalescer = new UpdateCoalescer({
      intervalMs: 50,
      publish: () => {
        published += 1;
      },
    });
    coalescer.schedule(1);
    coalescer.stop();
    coalescer.schedule();
    await coalescer.flushNow();
    await tick();
    expect(coalescer.isStopped()).toBe(true);
    expect(published).toBe(0);
  });
});
