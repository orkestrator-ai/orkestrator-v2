import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useTimedCopyFeedback } from "./useTimedCopyFeedback";

afterEach(cleanup);

describe("useTimedCopyFeedback", () => {
  test("shows feedback after copying and clears it after the configured duration", async () => {
    const copyText = mock(async () => undefined);
    const { result } = renderHook(() => useTimedCopyFeedback(10, copyText));

    await act(async () => result.current.copy("token-value"));
    expect(copyText).toHaveBeenCalledWith("token-value");
    expect(result.current.copied).toBe(true);
    await waitFor(() => expect(result.current.copied).toBe(false));
  });

  test("does not show copied feedback when clipboard writing fails", async () => {
    const copyText = mock(async () => { throw new Error("clipboard unavailable"); });
    const { result } = renderHook(() => useTimedCopyFeedback(10, copyText));

    let error: unknown;
    await act(async () => {
      try {
        await result.current.copy("token-value");
      } catch (caught) {
        error = caught;
      }
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("clipboard unavailable");
    expect(result.current.copied).toBe(false);
  });

  test("cleans up the pending feedback timer on unmount", async () => {
    const clearTimeoutSpy = mock(window.clearTimeout.bind(window));
    const originalClearTimeout = window.clearTimeout;
    window.clearTimeout = clearTimeoutSpy as typeof window.clearTimeout;
    try {
      const { result, unmount } = renderHook(() => useTimedCopyFeedback(10_000, async () => undefined));
      await act(async () => result.current.copy("token-value"));
      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.clearTimeout = originalClearTimeout;
    }
  });
});
