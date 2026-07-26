import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import {
  ENVIRONMENT_LIST_RESYNC_INTERVAL_MS,
  useEnvironmentListSync,
} from "../../../apps/web/src/hooks/useEnvironmentListSync";
import {
  dispatchResourceChange,
  resetResourceSync,
} from "../../../apps/web/src/lib/resource-sync";

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

/** Drives one `environment` announcement past the dispatcher's coalescing window. */
async function announceEnvironmentChange(revision = 1): Promise<void> {
  await act(async () => {
    dispatchResourceChange({ resource: "environment", id: "env-1", revision });
    await new Promise((resolve) => originalSetInterval(resolve, 80));
  });
}

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  resetResourceSync();
});

describe("useEnvironmentListSync", () => {
  test("refreshes every current project with the latest callback on resync and cleans up", async () => {
    let intervalCallback: (() => void) | null = null;
    const clearIntervalMock = mock(() => {});
    const firstRefreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    const nextRefreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());

    globalThis.setInterval = ((callback: TimerHandler, timeout?: number) => {
      expect(timeout).toBe(ENVIRONMENT_LIST_RESYNC_INTERVAL_MS);
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = clearIntervalMock as typeof clearInterval;

    const { rerender, unmount } = renderHook(
      ({ projectIds, refreshProject }) => useEnvironmentListSync(projectIds, refreshProject),
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

  test("refreshes when the backend announces an environment change", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    globalThis.setInterval = ((() => 1) as unknown) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListSync(["project-1", "project-2"], refreshProject));

    await announceEnvironmentChange();

    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1", "project-2",
    ]);
  });

  test("coalesces an announcement burst into a single refresh per project", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    globalThis.setInterval = ((() => 1) as unknown) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListSync(["project-1"], refreshProject));

    await act(async () => {
      // A reorder announces once per moved environment.
      dispatchResourceChange({ resource: "environment", id: "env-1", revision: 1 });
      dispatchResourceChange({ resource: "environment", id: "env-1", revision: 2 });
      dispatchResourceChange({ resource: "environment", id: "env-1", revision: 3 });
      await new Promise((resolve) => originalSetInterval(resolve, 80));
    });

    expect(refreshProject).toHaveBeenCalledTimes(1);
  });

  test("stops refreshing after unmount", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    globalThis.setInterval = ((() => 1) as unknown) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    const { unmount } = renderHook(() => useEnvironmentListSync(["project-1"], refreshProject));
    unmount();

    await announceEnvironmentChange();

    expect(refreshProject).not.toHaveBeenCalled();
  });

  test("does nothing when there are no projects", async () => {
    let intervalCallback: (() => void) | null = null;
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());

    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListSync([], refreshProject));
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

    renderHook(() => useEnvironmentListSync(["project-1", "project-2"], refreshProject));

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

    renderHook(() => useEnvironmentListSync(["project-1"], refreshProject));

    await act(async () => {
      intervalCallback?.();
    });
    await act(async () => {
      intervalCallback?.();
    });

    expect(refreshProject).toHaveBeenCalledTimes(2);
  });
});
