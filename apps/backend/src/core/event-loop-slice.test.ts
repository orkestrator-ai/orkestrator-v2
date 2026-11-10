import { describe, expect, test } from "bun:test";
import { createEventLoopSlicer } from "./event-loop-slice.js";

describe("event loop slicer", () => {
  test("yields once a slice of work has run, then starts a new slice", async () => {
    let now = 0;
    let yields = 0;
    const slice = createEventLoopSlicer({
      sliceMs: 20,
      now: () => now,
      yieldNow: async () => {
        yields += 1;
      },
    });
    now = 19;
    await slice();
    expect(yields).toBe(0);
    now = 20;
    await slice();
    expect(yields).toBe(1);
    // The new slice starts when the yield returns.
    now = 39;
    await slice();
    expect(yields).toBe(1);
    now = 41;
    await slice();
    expect(yields).toBe(2);
  });

  test("by default lets a due timer run before the loop continues", async () => {
    const slice = createEventLoopSlicer({ sliceMs: 0 });
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);
    // Busy past the timer's due time, as a synchronous loop would be.
    const until = performance.now() + 5;
    while (performance.now() < until) {
      // Spin.
    }
    for (let attempt = 0; attempt < 10 && !timerRan; attempt += 1) await slice();
    expect(timerRan).toBe(true);
  });
});
