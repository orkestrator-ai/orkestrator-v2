import { describe, expect, test } from "bun:test";
import { runtimeIntervalTimers } from "./parent-watchdog.js";
import { runtimeTimeoutTimers, unrefTimers } from "./timers.js";

type RefHandle = { hasRef(): boolean };

describe("unrefTimers", () => {
  test("never keeps the process alive", () => {
    const timeout = unrefTimers.setTimeout(() => undefined, 60_000) as RefHandle;
    const interval = unrefTimers.setInterval(() => undefined, 60_000) as RefHandle;
    try {
      expect(timeout.hasRef()).toBe(false);
      expect(interval.hasRef()).toBe(false);
    } finally {
      unrefTimers.clearTimeout(timeout);
      unrefTimers.clearInterval(interval);
    }
  });

  test("fires and clears like the runtime's timers", async () => {
    let fired = false;
    await new Promise<void>((resolve) => {
      unrefTimers.setTimeout(() => {
        fired = true;
        resolve();
      }, 0);
    });
    expect(fired).toBe(true);

    let cleared = 0;
    const handle = unrefTimers.setTimeout(() => (cleared += 1), 0);
    unrefTimers.clearTimeout(handle);
    // A later timer runs after the cleared one would have.
    await new Promise<void>((resolve) => runtimeTimeoutTimers.setTimeout(resolve, 0));
    expect(cleared).toBe(0);
  });

  test("is the watchdogs' interval default", () => {
    expect(runtimeIntervalTimers).toBe(unrefTimers);
  });

  test("reads the wall clock", () => {
    const before = Date.now();
    const now = unrefTimers.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe("runtimeTimeoutTimers", () => {
  test("keeps the runtime's default ref behaviour", () => {
    const handle = runtimeTimeoutTimers.setTimeout(() => undefined, 60_000) as RefHandle;
    try {
      expect(handle.hasRef()).toBe(true);
    } finally {
      runtimeTimeoutTimers.clearTimeout(handle);
    }
  });
});
