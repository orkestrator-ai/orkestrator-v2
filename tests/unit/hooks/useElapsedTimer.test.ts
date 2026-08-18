import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";

describe("useElapsedTimer", () => {
  let dateNowSpy: ReturnType<(typeof import("bun:test"))["spyOn"]> | undefined;

  afterEach(() => {
    dateNowSpy?.mockRestore();
  });

  describe("initial state", () => {
    test("both values are null when not loading", () => {
      const { result } = renderHook(() => useElapsedTimer(false, "session-1"));
      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("both values are null when loading is undefined", () => {
      const { result } = renderHook(() => useElapsedTimer(undefined, "session-1"));
      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });
  });

  describe("loading transitions", () => {
    test("elapsedSeconds is derived immediately from loadingStartedAt", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime + 5000);
      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt),
        { initialProps: { isLoading: false, sessionId: "session-1" } },
      );

      rerender({ isLoading: true, sessionId: "session-1", loadingStartedAt: startTime });

      expect(result.current.elapsedSeconds).toBe(5);
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("shows no elapsed time when loadingStartedAt is missing", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt),
        { initialProps: { isLoading: false, sessionId: "session-1" } },
      );

      rerender({ isLoading: true, sessionId: "session-1", loadingStartedAt: undefined });

      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("ticks elapsedSeconds from loadingStartedAt", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt),
        { initialProps: { isLoading: true, sessionId: "session-1", loadingStartedAt: startTime } },
      );

      dateNowSpy.mockReturnValue(startTime + 3000);
      act(() => {
        setIntervalMock?.advance();
      });

      expect(result.current.elapsedSeconds).toBe(3);
    });

    test("returns stored finalElapsedSeconds when loading ends", () => {
      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, finalElapsedSeconds }) =>
          useElapsedTimer(isLoading, sessionId, undefined, finalElapsedSeconds),
        { initialProps: { isLoading: false, sessionId: "session-1" } },
      );

      rerender({ isLoading: false, sessionId: "session-1", finalElapsedSeconds: 5 });
      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBe(5);
    });

    test("does not invent finalElapsedSeconds when loadingStartedAt is missing", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt, finalElapsedSeconds }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt, finalElapsedSeconds),
        { initialProps: { isLoading: false, sessionId: "session-1" } },
      );

      rerender({
        isLoading: true,
        sessionId: "session-1",
        loadingStartedAt: undefined,
        finalElapsedSeconds: undefined,
      });

      dateNowSpy.mockReturnValue(startTime + 5000);
      rerender({
        isLoading: false,
        sessionId: "session-1",
        loadingStartedAt: undefined,
        finalElapsedSeconds: undefined,
      });

      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("clears stored finalElapsedSeconds when loading starts again", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime + 1000);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt, finalElapsedSeconds }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt, finalElapsedSeconds),
        {
          initialProps: {
            isLoading: false,
            sessionId: "session-1",
            finalElapsedSeconds: 3,
          },
        },
      );

      rerender({
        isLoading: true,
        sessionId: "session-1",
        loadingStartedAt: startTime,
        finalElapsedSeconds: null,
      });

      expect(result.current.elapsedSeconds).toBe(1);
      expect(result.current.finalElapsedSeconds).toBeNull();
    });
  });

  describe("session changes", () => {
    test("keeps elapsed time when sessionId changes but the backend clock is unchanged", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime + 8000);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt),
        {
          initialProps: {
            isLoading: true,
            sessionId: "session-1",
            loadingStartedAt: startTime,
          },
        },
      );

      expect(result.current.elapsedSeconds).toBe(8);

      rerender({
        isLoading: true,
        sessionId: "session-2",
        loadingStartedAt: startTime,
      });
      expect(result.current.elapsedSeconds).toBe(8);
    });

    test("shows elapsed time immediately on remount from the backend clock", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime + 12000);

      const { result, unmount } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt),
        {
          initialProps: {
            isLoading: true,
            sessionId: "session-1",
            loadingStartedAt: startTime,
          },
        },
      );

      expect(result.current.elapsedSeconds).toBe(12);
      unmount();

      const remounted = renderHook(
        ({ isLoading, sessionId, loadingStartedAt }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt),
        {
          initialProps: {
            isLoading: true,
            sessionId: "session-1",
            loadingStartedAt: startTime,
          },
        },
      );

      expect(remounted.result.current.elapsedSeconds).toBe(12);
      remounted.unmount();
    });

    test("clears elapsed timer state when the backend clock is gone", () => {
      const startTime = 1000000;
      dateNowSpy = spyOn(Date, "now").mockReturnValue(startTime);

      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, loadingStartedAt, finalElapsedSeconds }) =>
          useElapsedTimer(isLoading, sessionId, loadingStartedAt, finalElapsedSeconds),
        {
          initialProps: {
            isLoading: true,
            sessionId: "session-1",
            loadingStartedAt: startTime,
          },
        },
      );

      dateNowSpy.mockReturnValue(startTime + 10000);
      rerender({
        isLoading: false,
        sessionId: "session-2",
        loadingStartedAt: undefined,
        finalElapsedSeconds: null,
      });
      expect(result.current.elapsedSeconds).toBeNull();
      expect(result.current.finalElapsedSeconds).toBeNull();
    });

    test("resets when sessionId changes to undefined", () => {
      const { result, rerender } = renderHook(
        ({ isLoading, sessionId, finalElapsedSeconds }) =>
          useElapsedTimer(isLoading, sessionId, undefined, finalElapsedSeconds),
        {
          initialProps: {
            isLoading: false as boolean | undefined,
            sessionId: "session-1" as string | undefined,
            finalElapsedSeconds: 5,
          },
        },
      );

      rerender({ isLoading: false, sessionId: "session-1", finalElapsedSeconds: 5 });
      expect(result.current.finalElapsedSeconds).toBe(5);

      rerender({ isLoading: false, sessionId: undefined, finalElapsedSeconds: null });
      expect(result.current.finalElapsedSeconds).toBeNull();
    });
  });
});

const setIntervalMock = (() => {
  let callback: (() => void) | null = null;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  beforeEach(() => {
    callback = null;
    globalThis.setInterval = ((fn: TimerHandler) => {
      callback = fn as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((_id?: ReturnType<typeof setInterval>) =>
      undefined) as unknown as typeof clearInterval;
  });

  afterEach(() => {
    callback = null;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });

  return {
    advance() {
      callback?.();
    },
  };
})();

function spyOn<T extends object, K extends keyof T>(obj: T, method: K) {
  const original = obj[method];
  let mockFn: ((...args: any[]) => any) | undefined;

  const spy = {
    mockReturnValue(value: any) {
      mockFn = () => value;
      (obj as any)[method] = mockFn;
      return spy;
    },
    mockRestore() {
      (obj as any)[method] = original;
    },
  };

  return spy;
}
