import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRuntimeClock } from "./runtime-clock";
import { runtimeParts, runtimePartsAt } from "./runtime-summary";

let originalNow: typeof Date.now;
let originalSetInterval: typeof window.setInterval;
let originalClearInterval: typeof window.clearInterval;
let now = 0;
let ticks: Array<() => void> = [];
const clearInterval = mock((_handle?: number) => undefined);

beforeEach(() => {
  originalNow = Date.now;
  originalSetInterval = window.setInterval;
  originalClearInterval = window.clearInterval;
  now = 10_000;
  ticks = [];
  clearInterval.mockClear();
  Date.now = () => now;
  window.setInterval = ((callback: TimerHandler) => {
    ticks.push(callback as () => void);
    return ticks.length;
  }) as typeof window.setInterval;
  window.clearInterval = clearInterval as typeof window.clearInterval;
});

afterEach(() => {
  Date.now = originalNow;
  window.setInterval = originalSetInterval;
  window.clearInterval = originalClearInterval;
});

describe("createRuntimeClock", () => {
  test("reads the time at once on start, ticks while started, and stops with the last stop", () => {
    const clock = createRuntimeClock();
    const listener = mock(() => undefined);
    clock.subscribe(listener);
    expect(clock.getNow()).toBe(10_000);

    now = 15_000;
    const stopFirst = clock.start();
    expect(clock.getNow()).toBe(15_000);
    expect(listener).toHaveBeenCalledTimes(1);
    const stopSecond = clock.start();
    expect(ticks).toHaveLength(1);

    now = 16_000;
    ticks[0]!();
    expect(clock.getNow()).toBe(16_000);
    expect(listener).toHaveBeenCalledTimes(2);

    stopFirst();
    stopFirst();
    expect(clearInterval).not.toHaveBeenCalled();
    stopSecond();
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });
});

describe("runtimePartsAt", () => {
  test("re-derives a live part's elapsed and leaves settled parts alone", () => {
    const start = "2026-08-14T00:00:00.000Z";
    const live = runtimeParts({ startedAt: start }, true, Date.parse(start) + 5_000)!;
    expect(live.elapsed).toBe("5s");
    expect(runtimePartsAt(live, Date.parse(start) + 65_000).elapsed).toBe("1m 5s");
    expect(runtimePartsAt(live, Date.parse(start) + 5_400)).toBe(live);

    const settled = runtimeParts(
      { startedAt: start, completedAt: "2026-08-14T00:00:30.000Z" },
      true,
      Date.parse(start) + 90_000,
    )!;
    expect(runtimePartsAt(settled, Date.parse(start) + 600_000)).toBe(settled);
  });
});
