import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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

  test("marks past and non-finite deadlines expired", () => {
    const past = renderHook(() => usePromptDeadline(Date.now() - 1));
    const invalid = renderHook(() =>
      usePromptDeadline(Number.POSITIVE_INFINITY),
    );

    expect(past.result.current).toEqual({ remaining: null, expired: true });
    expect(invalid.result.current).toEqual({ remaining: null, expired: true });
  });

  test("recomputes when the upstream deadline changes", async () => {
    const initialProps: { expiresAt?: number } = {};
    const { result, rerender } = renderHook(
      ({ expiresAt }: { expiresAt?: number }) => usePromptDeadline(expiresAt),
      { initialProps },
    );

    rerender({ expiresAt: Date.now() + 65_000 });
    await waitFor(() => {
      expect(result.current.expired).toBe(false);
      expect(result.current.remaining).toBe("1:05");
    });

    rerender({ expiresAt: Date.now() - 1 });
    await waitFor(() => {
      expect(result.current).toEqual({ remaining: null, expired: true });
    });
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
