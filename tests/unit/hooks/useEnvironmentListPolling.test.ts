import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  ENVIRONMENT_LIST_POLL_INTERVAL_MS,
  useEnvironmentListPolling,
} from "../../../src/hooks/useEnvironmentListPolling";

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("useEnvironmentListPolling", () => {
  test("refreshes every current project every five seconds and cleans up", async () => {
    let intervalCallback: (() => void) | null = null;
    const clearIntervalMock = mock(() => {});
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());

    globalThis.setInterval = ((callback: TimerHandler, timeout?: number) => {
      expect(timeout).toBe(ENVIRONMENT_LIST_POLL_INTERVAL_MS);
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = clearIntervalMock as typeof clearInterval;

    const { rerender, unmount } = renderHook(
      ({ projectIds }) => useEnvironmentListPolling(projectIds, refreshProject),
      { initialProps: { projectIds: ["project-1"] } },
    );

    expect(refreshProject).not.toHaveBeenCalled();

    await act(async () => {
      intervalCallback?.();
    });
    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual(["project-1"]);

    rerender({ projectIds: ["project-1", "project-2"] });
    await act(async () => {
      intervalCallback?.();
    });
    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1",
      "project-1",
      "project-2",
    ]);

    unmount();
    expect(clearIntervalMock).toHaveBeenCalledWith(1);
  });

  test("does not overlap polls when a refresh is still in flight", async () => {
    let intervalCallback: (() => void) | null = null;
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () => new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
    );

    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListPolling(["project-1"], refreshProject));

    act(() => {
      intervalCallback?.();
      intervalCallback?.();
    });
    expect(refreshProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRefresh?.();
    });

    await act(async () => {
      intervalCallback?.();
      finishRefresh?.();
    });
    expect(refreshProject).toHaveBeenCalledTimes(2);
  });
});
