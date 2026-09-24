import { afterEach, describe, expect, mock, test } from "bun:test";
import { installControlledTimeout } from "../helpers/controlled-timeout";

let active: ReturnType<typeof installControlledTimeout> | undefined;

function install(...args: Parameters<typeof installControlledTimeout>) {
  active = installControlledTimeout(...args);
  return active;
}

afterEach(() => {
  active?.restore();
  active = undefined;
});

describe("installControlledTimeout", () => {
  test("captures the controlled delay and leaves every other delay on the real clock", async () => {
    const clock = install(400);
    const controlled = mock(() => {});
    const uncontrolled = mock(() => {});

    setTimeout(controlled, 400);
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        uncontrolled();
        resolve();
      }, 1);
    });

    // The real 1 ms timer has already run; the controlled one waits for advance.
    expect(uncontrolled).toHaveBeenCalledTimes(1);
    expect(controlled).not.toHaveBeenCalled();
    expect(clock.pendingCount()).toBe(1);

    expect(clock.advance()).toBe(1);
    expect(controlled).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount()).toBe(0);
  });

  test("forwards the scheduled arguments", () => {
    const clock = install(400);
    const callback = mock((..._args: unknown[]) => {});

    setTimeout(callback, 400, "first", 2);
    clock.advance();

    expect(callback).toHaveBeenCalledWith("first", 2);
  });

  test("clearing a captured timer stops it from running on advance", () => {
    const clock = install(400);
    const callback = mock(() => {});

    const handle = setTimeout(callback, 400);
    clearTimeout(handle);

    expect(clock.pendingCount()).toBe(0);
    expect(clock.advance()).toBe(0);
    expect(callback).not.toHaveBeenCalled();
  });

  test("a second concurrent timer at the controlled delay throws instead of being swallowed", () => {
    const clock = install(400, { label: "auto-save debounce" });
    const owner = mock(() => {});
    const stranger = mock(() => {});

    setTimeout(owner, 400);
    // An unrelated module that happens to share the delay. Silently capturing
    // it would drop it at restore() and the test would pass for the wrong
    // reason, so the collision has to be loud.
    expect(() => setTimeout(stranger, 400)).toThrow(/auto-save debounce \(400 ms\)/);

    expect(clock.pendingCount()).toBe(1);
    clock.advance();
    expect(owner).toHaveBeenCalledTimes(1);
    expect(stranger).not.toHaveBeenCalled();
  });

  test("maxPending admits a delay with more than one legitimate owner", () => {
    const clock = install(400, { maxPending: 2 });
    const first = mock(() => {});
    const second = mock(() => {});

    setTimeout(first, 400);
    setTimeout(second, 400);
    expect(clock.pendingCount()).toBe(2);

    expect(clock.advance()).toBe(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("assertDrained reports a captured timer that was never advanced", () => {
    const clock = install(400, { label: "auto-save debounce" });

    setTimeout(() => {}, 400);
    expect(() => clock.assertDrained()).toThrow(/never advanced/);

    clock.advance();
    expect(() => clock.assertDrained()).not.toThrow();
  });

  test("restore reports dropped timers and puts the real clock back", () => {
    const clock = install(400);
    const patched = globalThis.setTimeout;
    const dropped = mock(() => {});
    setTimeout(dropped, 400);

    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    let count: number;
    try {
      count = clock.restore();
    } finally {
      console.warn = warn;
    }
    active = undefined;

    expect(count).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain("dropped 1 pending timer(s)");
    expect(dropped).not.toHaveBeenCalled();
    expect(globalThis.setTimeout).not.toBe(patched);
  });

  test("restore is silent when every captured timer ran", () => {
    const clock = install(400);
    setTimeout(() => {}, 400);
    clock.advance();

    const warn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      expect(clock.restore()).toBe(0);
    } finally {
      console.warn = warn;
    }
    active = undefined;

    expect(warnings).toEqual([]);
  });

  test("a callback that re-arms the controlled delay stays under control", () => {
    const clock = install(400);
    let rearmed = false;

    setTimeout(() => {
      if (rearmed) return;
      rearmed = true;
      setTimeout(() => {}, 400);
    }, 400);

    // The map is cleared before the due callbacks run, so re-arming from inside
    // one does not trip the maxPending guard and does not run in this advance.
    expect(clock.advance()).toBe(1);
    expect(clock.pendingCount()).toBe(1);
  });
});
