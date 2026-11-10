import { jest } from "bun:test";
import { act } from "@testing-library/react";

/** One animation frame. Happy DOM delivers frames on real immediates, outside Bun's fake clock. */
export const animationFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/**
 * Lets `ms` of time pass on Bun's fake clock (`jest.useFakeTimers()`, installed
 * before rendering) in 10 ms steps, delivering an animation frame before each
 * step and after the last. Frame-driven work therefore interleaves with timers
 * in order, as it would in real time, and every timer due within `ms` has run
 * when this resolves. Unlike a real sleep it takes no wall time.
 */
export async function elapseFakeTime(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    await animationFrame();
    act(() => {
      jest.advanceTimersByTime(Math.min(10, ms - elapsed));
    });
  }
  await animationFrame();
}
