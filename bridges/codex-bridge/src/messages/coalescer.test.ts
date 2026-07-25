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
