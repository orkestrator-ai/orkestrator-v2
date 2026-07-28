import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  formatPromptDeadline,
  usePromptDeadline,
} from "./usePromptDeadline";

describe("usePromptDeadline", () => {
  afterEach(cleanup);

  test("formats positive finite deadlines and rejects expired or invalid values", () => {
    expect(formatPromptDeadline(65_000)).toBe("1:05");
    expect(formatPromptDeadline(1)).toBe("0:01");
    expect(formatPromptDeadline(0)).toBeNull();
    expect(formatPromptDeadline(-1)).toBeNull();
    expect(formatPromptDeadline(Number.NaN)).toBeNull();
    expect(formatPromptDeadline(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("leaves an absent upstream deadline live", () => {
    const { result } = renderHook(() => usePromptDeadline());

    expect(result.current).toEqual({ remaining: null, expired: false });
  });

  test("keeps elapsed absolute deadlines informational but rejects invalid values", () => {
    const past = renderHook(() => usePromptDeadline(Date.now() - 1));
    const invalid = renderHook(() =>
      usePromptDeadline(Number.POSITIVE_INFINITY),
    );

    expect(past.result.current).toEqual({ remaining: null, expired: false });
    expect(invalid.result.current).toEqual({ remaining: null, expired: true });
  });

  test("recomputes synchronously when a past deadline is refreshed", () => {
    const initialProps: { expiresAt?: number } = {
      expiresAt: Date.now() - 1,
    };
    const { result, rerender } = renderHook(
      ({ expiresAt }: { expiresAt?: number }) => usePromptDeadline(expiresAt),
      { initialProps },
    );

    rerender({ expiresAt: Date.now() + 65_000 });
    expect(result.current.expired).toBe(false);
    expect(result.current.remaining).toBe("1:05");

    rerender({ expiresAt: Date.now() - 1 });
    expect(result.current).toEqual({ remaining: null, expired: false });
  });

  test("stops scheduling ticks once the display countdown reaches zero", () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    let tick: (() => void) | undefined;
    const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
      ((handler: TimerHandler) => {
        tick = handler as () => void;
        return 1 as never;
      }) as unknown as typeof setInterval,
    );
    const clearIntervalSpy = spyOn(globalThis, "clearInterval");

    try {
      const { result } = renderHook(() => usePromptDeadline(1_500));
      expect(result.current.remaining).toBe("0:01");
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      now = 2_000;
      act(() => tick?.());

      expect(result.current).toEqual({ remaining: null, expired: false });
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = originalNow;
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  test("clears its interval when the consumer unmounts", () => {
    const clearIntervalSpy = spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() =>
      usePromptDeadline(Date.now() + 65_000),
    );

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    clearIntervalSpy.mockRestore();
  });
});
