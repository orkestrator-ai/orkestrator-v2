import { describe, expect, test } from "bun:test";
import type { IntervalTimers, TimeoutTimers, Timers } from "../timers.js";
import { flushMicrotasks, ManualClock } from "./manual-clock.js";

describe("ManualClock", () => {
  test("satisfies every timer seam", () => {
    const clock = new ManualClock();
    const seams: [Timers, TimeoutTimers, IntervalTimers] = [clock, clock, clock];
    expect(seams).toHaveLength(3);
  });

  test("fires a timeout only once its delay has passed", () => {
    const clock = new ManualClock({ start: 1_000 });
    const fired: number[] = [];
    clock.setTimeout(() => fired.push(clock.now()), 50);

    expect(clock.advance(49)).toBe(0);
    expect(fired).toEqual([]);
    expect(clock.pendingDelays()).toEqual([1]);

    expect(clock.advance(1)).toBe(1);
    expect(fired).toEqual([1_050]);
    expect(clock.pendingCount()).toBe(0);
    expect(clock.now()).toBe(1_050);
  });

  test("runs timers in due order, scheduling order breaking ties", () => {
    const clock = new ManualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push("b"), 20);
    clock.setTimeout(() => order.push("a"), 10);
    clock.setTimeout(() => order.push("c"), 20);

    clock.advance(100);
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("runs a timer a callback arms when it falls due within the same advance", () => {
    const clock = new ManualClock();
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.now());
      clock.setTimeout(() => fired.push(clock.now()), 30);
      clock.setTimeout(() => fired.push(clock.now()), 500);
    }, 10);

    expect(clock.advance(100)).toBe(2);
    expect(fired).toEqual([10, 40]);
    expect(clock.pendingDelays()).toEqual([410]);
  });

  test("a cleared timer never fires", () => {
    const clock = new ManualClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 5);
    clock.clearTimeout(handle);
    clock.clearTimeout(undefined);

    expect(clock.advance(1_000)).toBe(0);
    expect(fired).toBe(false);
  });

  test("an interval re-arms with its period until cleared", () => {
    const clock = new ManualClock();
    const fired: number[] = [];
    const handle = clock.setInterval(() => fired.push(clock.now()), 100);
    expect(clock.intervalPeriods()).toEqual([100]);

    clock.advance(350);
    expect(fired).toEqual([100, 200, 300]);

    clock.clearInterval(handle);
    clock.advance(1_000);
    expect(fired).toEqual([100, 200, 300]);
    expect(clock.intervalPeriods()).toEqual([]);
  });

  test("advanceToNext jumps to the soonest timer", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("late"), 9_000);
    clock.setTimeout(() => fired.push("soon"), 300);

    expect(clock.advanceToNext()).toBe(1);
    expect(fired).toEqual(["soon"]);
    expect(clock.now()).toBe(300);
    expect(new ManualClock().advanceToNext()).toBe(0);
  });

  test("treats negative and non-finite delays as zero", () => {
    const clock = new ManualClock();
    let fired = 0;
    clock.setTimeout(() => (fired += 1), -5);
    clock.setTimeout(() => (fired += 1), Number.NaN);

    expect(clock.advance(0)).toBe(2);
    expect(fired).toBe(2);
  });

  test("refuses to loop forever on a zero-delay timer that re-arms itself", () => {
    const clock = new ManualClock();
    const rearm = () => {
      clock.setTimeout(rearm, 0);
    };
    clock.setTimeout(rearm, 0);

    expect(() => clock.advance(0)).toThrow(/re-arming a zero-delay timer/);
  });

  test("advanceAsync lets each callback's promise chain settle before the next timer", async () => {
    const clock = new ManualClock();
    const log: string[] = [];
    clock.setTimeout(() => {
      void (async () => {
        await Promise.resolve();
        await Promise.resolve();
        log.push("first settled");
      })();
    }, 10);
    clock.setTimeout(() => log.push("second ran"), 20);

    expect(await clock.advanceAsync(20)).toBe(2);
    expect(log).toEqual(["first settled", "second ran"]);
  });

  test("advanceAsync accepts its own settle step", async () => {
    const clock = new ManualClock();
    let settles = 0;
    clock.setTimeout(() => undefined, 1);
    clock.setTimeout(() => undefined, 2);

    await clock.advanceAsync(5, async () => {
      settles += 1;
    });
    // Once before the first timer, once after each.
    expect(settles).toBe(3);
  });

  test("flushMicrotasks yields the requested number of turns", async () => {
    let reached = false;
    void (async () => {
      for (let turn = 0; turn < 9; turn += 1) await Promise.resolve();
      reached = true;
    })();
    await flushMicrotasks(5);
    expect(reached).toBe(false);
    await flushMicrotasks(10);
    expect(reached).toBe(true);
  });
});
