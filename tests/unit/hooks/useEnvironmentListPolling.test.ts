import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  ENVIRONMENT_LIST_POLL_INTERVAL_MS,
  useEnvironmentListPolling,
} from "../../../apps/web/src/hooks/useEnvironmentListPolling";

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("useEnvironmentListPolling", () => {
  test("refreshes every current project with the latest callback every five seconds and cleans up", async () => {
    let intervalCallback: (() => void) | null = null;
    const clearIntervalMock = mock(() => {});
    const firstRefreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    const nextRefreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());

    globalThis.setInterval = ((callback: TimerHandler, timeout?: number) => {
      expect(timeout).toBe(ENVIRONMENT_LIST_POLL_INTERVAL_MS);
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = clearIntervalMock as typeof clearInterval;

    const { rerender, unmount } = renderHook(
      ({ projectIds, refreshProject }) => useEnvironmentListPolling(projectIds, refreshProject),
      { initialProps: { projectIds: ["project-1"], refreshProject: firstRefreshProject } },
    );

    expect(firstRefreshProject).not.toHaveBeenCalled();

    await act(async () => {
      intervalCallback?.();
    });
    expect(firstRefreshProject.mock.calls.map(([projectId]) => projectId)).toEqual(["project-1"]);

    rerender({ projectIds: ["project-1", "project-2"], refreshProject: nextRefreshProject });
    await act(async () => {
      intervalCallback?.();
    });
    expect(firstRefreshProject).toHaveBeenCalledTimes(1);
    expect(nextRefreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1", "project-2",
    ]);

    unmount();
    expect(clearIntervalMock).toHaveBeenCalledWith(1);
  });

  test("does nothing when there are no projects", async () => {
    let intervalCallback: (() => void) | null = null;
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());

    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListPolling([], refreshProject));
    await act(async () => {
      intervalCallback?.();
    });

    expect(refreshProject).not.toHaveBeenCalled();
  });

  test("isolates in-flight work per project so one stalled refresh does not block others", async () => {
    let intervalCallback: (() => void) | null = null;
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      (projectId) => projectId === "project-1"
        ? new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
        : Promise.resolve(),
    );

    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListPolling(["project-1", "project-2"], refreshProject));

    act(() => {
      intervalCallback?.();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      intervalCallback?.();
    });
    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1", "project-2", "project-2",
    ]);

    await act(async () => {
      finishRefresh?.();
    });

    await act(async () => {
      intervalCallback?.();
    });
    expect(refreshProject.mock.calls.filter(([projectId]) => projectId === "project-1")).toHaveLength(2);
  });

  test("retries a project after a rejected refresh settles", async () => {
    let intervalCallback: (() => void) | null = null;
    const refreshProject = mock<(projectId: string) => Promise<void>>()
      .mockImplementationOnce(() => Promise.reject(new Error("temporary failure")))
      .mockImplementation(() => Promise.resolve());

    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListPolling(["project-1"], refreshProject));

    await act(async () => {
      intervalCallback?.();
    });
    await act(async () => {
      intervalCallback?.();
    });

    expect(refreshProject).toHaveBeenCalledTimes(2);
  });
});
