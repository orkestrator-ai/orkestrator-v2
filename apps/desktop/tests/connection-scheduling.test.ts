import { afterEach, describe, expect, test } from "bun:test";
import { ReconnectScheduler } from "../electron/connection-scheduling";

const realSetTimeout = globalThis.setTimeout;

/** Captures each scheduled delay instead of waiting it out. */
function captureTimers(): { delays: number[]; run: () => void } {
  const pending: Array<() => void> = [];
  const delays: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    pending.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  return { delays, run: () => pending.shift()?.() };
}

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

describe("ReconnectScheduler", () => {
  const ladder = [1_000, 2_000, 5_000];

  test("each delay is drawn from the upper half of its rung", () => {
    const timers = captureTimers();
    const samples = [0, 0.5, 0.999_999, 0];
    const scheduler = new ReconnectScheduler(
      ladder,
      () => undefined,
      () => samples.shift() ?? 0,
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      scheduler.schedule("a");
      timers.run();
    }
    // Rung 1 s at the lowest sample, 2 s halfway, 5 s at the top, then the
    // last rung again at the lowest.
    expect(timers.delays).toEqual([500, 1_500, 5_000, 2_500]);
    scheduler.dispose();
  });

  test("machines that failed together retry at different moments", () => {
    const timers = captureTimers();
    const samples = [0.1, 0.9];
    const scheduler = new ReconnectScheduler(
      ladder,
      () => undefined,
      () => samples.shift() ?? 0,
    );
    scheduler.schedule("a");
    scheduler.schedule("b");
    expect(timers.delays[0]).not.toBe(timers.delays[1]);
    for (const delay of timers.delays) {
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
    scheduler.dispose();
  });

  test("a cancel resets the ladder, so the next failure starts from the first rung", () => {
    const timers = captureTimers();
    const scheduler = new ReconnectScheduler(
      ladder,
      () => undefined,
      () => 1,
    );
    scheduler.schedule("a");
    timers.run();
    scheduler.schedule("a");
    scheduler.cancel("a");
    scheduler.schedule("a");
    expect(timers.delays).toEqual([1_000, 2_000, 1_000]);
    scheduler.dispose();
  });
});
