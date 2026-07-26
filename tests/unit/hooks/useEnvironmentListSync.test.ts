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

  test("re-runs a project whose refresh was requested while one was in flight", async () => {
    // The in-flight read was started before the mutation that prompted the new
    // request, so it cannot contain it. Dropping the request would leave the
    // list stale until the next 60s resync.
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () => new Promise<void>((resolve) => { finishRefresh = resolve; }),
    );
    globalThis.setInterval = ((() => 1) as unknown) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListSync(["project-1"], refreshProject));

    await announceEnvironmentChange(1);
    expect(refreshProject).toHaveBeenCalledTimes(1);

    // A second announcement lands while the first read is still open.
    await announceEnvironmentChange(2);
    expect(refreshProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
    });

    expect(refreshProject).toHaveBeenCalledTimes(2);
  });

  test("collapses many requests arriving during one read into a single follow-up", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () => new Promise<void>((resolve) => { finishRefresh = resolve; }),
    );
    globalThis.setInterval = ((() => 1) as unknown) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListSync(["project-1"], refreshProject));

    await announceEnvironmentChange(1);
    for (const revision of [2, 3, 4]) {
      await announceEnvironmentChange(revision);
    }
    expect(refreshProject).toHaveBeenCalledTimes(1);

    const first = finishRefresh;
    await act(async () => {
      first?.();
      await Promise.resolve();
    });

    // One follow-up, not three.
    expect(refreshProject).toHaveBeenCalledTimes(2);
  });

  test("does not re-run when nothing was requested during the read", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () => new Promise<void>((resolve) => { finishRefresh = resolve; }),
    );
    globalThis.setInterval = ((() => 1) as unknown) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListSync(["project-1"], refreshProject));

    await announceEnvironmentChange(1);
    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
    });

    expect(refreshProject).toHaveBeenCalledTimes(1);
  });

  test("still re-runs when the in-flight refresh rejects", async () => {
    let failRefresh: ((error: Error) => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () => new Promise<void>((_resolve, reject) => { failRefresh = reject; }),
    );
    globalThis.setInterval = ((() => 1) as unknown) as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHook(() => useEnvironmentListSync(["project-1"], refreshProject));

    await announceEnvironmentChange(1);
    await announceEnvironmentChange(2);
    expect(refreshProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      failRefresh?.(new Error("backend down"));
      await Promise.resolve();
    });

    // A failed read is still a read that predates the mutation, so the pending
    // request must survive it.
    expect(refreshProject).toHaveBeenCalledTimes(2);
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
