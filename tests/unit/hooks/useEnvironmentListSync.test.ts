import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "@testing-library/react";
import type { NodeScope } from "../../../apps/web/src/lib/node-scope/node-scope";
import * as realResourceSync from "../../../apps/web/src/lib/resource-sync";

const realResourceSyncSnapshot = { ...realResourceSync };
type ResourceResyncHandler = Parameters<typeof realResourceSync.onResourceResync>[0];
const capturedResyncHandlers = new Set<ResourceResyncHandler>();

mock.module("@/lib/resource-sync", () => ({
  ...realResourceSyncSnapshot,
  onResourceResync: (handler: ResourceResyncHandler, scope?: NodeScope) => {
    capturedResyncHandlers.add(handler);
    const unsubscribeReal = realResourceSyncSnapshot.onResourceResync(handler, scope);
    return () => {
      capturedResyncHandlers.delete(handler);
      unsubscribeReal();
    };
  },
}));

import { useEnvironmentListSync } from "../../../apps/web/src/hooks/useEnvironmentListSync";
import { renderHookInAppCommandScope } from "../../../apps/web/src/test/render-in-node-scope";

const { dispatchResourceChange, requestResourceResync, resetResourceSync } =
  realResourceSyncSnapshot;

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

/** Drives one `environment` announcement past the dispatcher's coalescing window. */
async function announceEnvironmentChange(revision = 1, projectId?: string): Promise<void> {
  await act(async () => {
    dispatchResourceChange({
      resource: "environment",
      id: "env-1",
      revision,
      ...(projectId ? { projectId } : {}),
    });
    await new Promise((resolve) => originalSetInterval(resolve, 80));
  });
}

async function deliverResync(request: realResourceSync.ResourceResyncRequest): Promise<void> {
  await act(async () => {
    await Promise.all([...capturedResyncHandlers].map((handler) => handler(request)));
  });
}

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  resetResourceSync();
  capturedResyncHandlers.clear();
});

afterAll(() => {
  mock.module("@/lib/resource-sync", () => realResourceSyncSnapshot);
});

describe("useEnvironmentListSync", () => {
  test("does not register its own interval (resource-sync owns the periodic resync)", () => {
    // The hook used to run a second 60s interval on top of resource-sync's own
    // resync timer, refreshing every project twice per tick.
    const setIntervalMock = mock(() => 1);
    // A recording fake; it cannot model setInterval's DOM/Node overload set.
    globalThis.setInterval = setIntervalMock as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    const { unmount } = renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1"], refreshProject),
    );
    unmount();

    // Assert the behavioral invariant, not one historical delay literal:
    // reintroducing an interval at 30s or 120s would be the same duplicate poll.
    expect(setIntervalMock).not.toHaveBeenCalled();
  });

  test("refreshes every current project with the latest callback on resync", async () => {
    const firstRefreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    const nextRefreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());

    const { rerender, unmount } = renderHookInAppCommandScope(
      ({ projectIds, refreshProject }) => useEnvironmentListSync(projectIds, refreshProject),
      { initialProps: { projectIds: ["project-1"], refreshProject: firstRefreshProject } },
    );

    expect(firstRefreshProject).not.toHaveBeenCalled();

    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });
    expect(firstRefreshProject.mock.calls.map(([projectId]) => projectId)).toEqual(["project-1"]);

    rerender({ projectIds: ["project-1", "project-2"], refreshProject: nextRefreshProject });
    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });
    expect(firstRefreshProject).toHaveBeenCalledTimes(1);
    expect(nextRefreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1",
      "project-2",
    ]);

    unmount();
    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });
    expect(nextRefreshProject).toHaveBeenCalledTimes(2);
  });

  test("refreshes when the backend announces an environment change", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1", "project-2"], refreshProject),
    );

    await announceEnvironmentChange();

    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1",
      "project-2",
    ]);
  });

  test("refreshes only the announced project and ignores unloaded projects", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1", "project-2"], refreshProject),
    );

    await announceEnvironmentChange(1, "project-2");
    await announceEnvironmentChange(2, "project-not-loaded");

    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual(["project-2"]);
  });

  describe("a lone announced environment", () => {
    /** Delivers one announcement, naming a project and an environment. */
    const announce = async (id: string, revision: number) => {
      await act(async () => {
        dispatchResourceChange({ resource: "environment", id, revision, projectId: "project-1" });
        await new Promise((resolve) => originalSetInterval(resolve, 80));
      });
    };
    const setup = (served: () => Promise<boolean> = () => Promise.resolve(true)) => {
      const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
      const refreshEnvironment = mock<(projectId: string, id: string) => Promise<boolean>>(served);
      renderHookInAppCommandScope(() =>
        useEnvironmentListSync(["project-1"], refreshProject, refreshEnvironment),
      );
      return { refreshProject, refreshEnvironment };
    };

    test("reads that record and not the project's list", async () => {
      const { refreshProject, refreshEnvironment } = setup();
      for (let revision = 1; revision <= 3; revision += 1) await announce("env-1", revision);

      expect(refreshEnvironment.mock.calls).toEqual([
        ["project-1", "env-1"],
        ["project-1", "env-1"],
        ["project-1", "env-1"],
      ]);
      expect(refreshProject).not.toHaveBeenCalled();
    });

    test("falls back to the list, and stays there, on a backend without the read", async () => {
      const { refreshProject, refreshEnvironment } = setup(() => Promise.resolve(false));

      await announce("env-1", 1);
      expect(refreshEnvironment).toHaveBeenCalledTimes(1);
      expect(refreshProject).toHaveBeenCalledTimes(1);

      await announce("env-1", 2);
      expect(refreshEnvironment).toHaveBeenCalledTimes(1);
      expect(refreshProject).toHaveBeenCalledTimes(2);

      // A resync may mean a different backend, so the next change asks again.
      await act(async () => {
        requestResourceResync();
        await Promise.resolve();
      });
      await announce("env-1", 3);
      expect(refreshEnvironment).toHaveBeenCalledTimes(2);
    });

    test("a change landing during its read is read afterwards, not lost", async () => {
      let finish: ((served: boolean) => void) | undefined;
      const { refreshProject, refreshEnvironment } = setup(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      await announce("env-1", 1);
      await announce("env-2", 2);
      expect(refreshEnvironment).toHaveBeenCalledTimes(1);

      await act(async () => {
        finish?.(true);
        await Promise.resolve();
      });
      expect(refreshEnvironment.mock.calls.at(-1)).toEqual(["project-1", "env-2"]);
      expect(refreshProject).not.toHaveBeenCalled();
    });

    test("several changes waiting at once read the list once", async () => {
      let finish: ((served: boolean) => void) | undefined;
      const { refreshProject, refreshEnvironment } = setup(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      // A reorder announces once per moved environment.
      await act(async () => {
        for (const [index, id] of ["env-1", "env-2", "env-3", "env-4"].entries()) {
          dispatchResourceChange({
            resource: "environment",
            id,
            revision: index + 1,
            projectId: "project-1",
          });
        }
        await new Promise((resolve) => originalSetInterval(resolve, 80));
      });
      expect(refreshEnvironment).toHaveBeenCalledTimes(1);
      await act(async () => {
        finish?.(true);
        await new Promise((resolve) => originalSetInterval(resolve, 0));
      });
      expect(refreshEnvironment).toHaveBeenCalledTimes(1);
      expect(refreshProject).toHaveBeenCalledTimes(1);
    });

    test("an announcement without a project still reads every list", async () => {
      const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
      const refreshEnvironment = mock<(projectId: string, id: string) => Promise<boolean>>(() =>
        Promise.resolve(true),
      );
      renderHookInAppCommandScope(() =>
        useEnvironmentListSync(["project-1", "project-2"], refreshProject, refreshEnvironment),
      );
      await announceEnvironmentChange();
      expect(refreshEnvironment).not.toHaveBeenCalled();
      expect(refreshProject).toHaveBeenCalledTimes(2);
    });
  });

  test("refreshes every current project after reconnect or revision-gap recovery", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1", "project-2"], refreshProject),
    );

    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });

    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1",
      "project-2",
    ]);
  });

  test("ignores manifest and irrelevant selective resync requests", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    renderHookInAppCommandScope(() => useEnvironmentListSync(["project-1"], refreshProject));

    await deliverResync({
      resources: new Set(["environment"]),
      reason: "manifest",
    });
    await deliverResync({
      resources: new Set(["project"]),
      reason: "explicit",
    });

    expect(refreshProject).not.toHaveBeenCalled();
  });

  test("handles a relevant selective explicit resync request", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1", "project-2"], refreshProject),
    );

    await deliverResync({
      resources: new Set(["environment"]),
      reason: "explicit",
    });

    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1",
      "project-2",
    ]);
  });

  test("coalesces an announcement burst into a single refresh per project", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHookInAppCommandScope(() => useEnvironmentListSync(["project-1"], refreshProject));

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
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    const { unmount } = renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1"], refreshProject),
    );
    unmount();

    await announceEnvironmentChange();

    expect(refreshProject).not.toHaveBeenCalled();
  });

  test("does not run a queued follow-up after unmounting during an in-flight refresh", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    const { unmount } = renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1"], refreshProject),
    );
    await announceEnvironmentChange(1);
    await announceEnvironmentChange(2);
    expect(refreshProject).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
    });

    expect(refreshProject).toHaveBeenCalledTimes(1);
  });

  test("does not re-run a removed project after its in-flight refresh settles", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    const hook = renderHookInAppCommandScope(
      ({ projectIds }) => useEnvironmentListSync(projectIds, refreshProject),
      { initialProps: { projectIds: ["project-1"] } },
    );
    await announceEnvironmentChange(1);
    hook.rerender({ projectIds: [] });
    await announceEnvironmentChange(2);
    expect(refreshProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRefresh?.();
      await Promise.resolve();
    });

    expect(refreshProject).toHaveBeenCalledTimes(1);
  });

  test("does nothing when there are no projects", async () => {
    const refreshProject = mock<(projectId: string) => Promise<void>>(() => Promise.resolve());

    renderHookInAppCommandScope(() => useEnvironmentListSync([], refreshProject));
    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });

    expect(refreshProject).not.toHaveBeenCalled();
  });

  test("isolates in-flight work per project so one stalled refresh does not block others", async () => {
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>((projectId) =>
      projectId === "project-1"
        ? new Promise<void>((resolve) => {
            finishRefresh = resolve;
          })
        : Promise.resolve(),
    );

    renderHookInAppCommandScope(() =>
      useEnvironmentListSync(["project-1", "project-2"], refreshProject),
    );

    act(() => {
      requestResourceResync();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      requestResourceResync();
    });
    expect(refreshProject.mock.calls.map(([projectId]) => projectId)).toEqual([
      "project-1",
      "project-2",
      "project-2",
    ]);

    await act(async () => {
      finishRefresh?.();
    });

    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });
    expect(
      refreshProject.mock.calls.filter(([projectId]) => projectId === "project-1"),
    ).toHaveLength(2);
  });

  test("re-runs a project whose refresh was requested while one was in flight", async () => {
    // The in-flight read was started before the mutation that prompted the new
    // request, so it cannot contain it. Dropping the request would leave the
    // list stale until the next slow manifest resync.
    let finishRefresh: (() => void) | undefined;
    const refreshProject = mock<(projectId: string) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHookInAppCommandScope(() => useEnvironmentListSync(["project-1"], refreshProject));

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
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHookInAppCommandScope(() => useEnvironmentListSync(["project-1"], refreshProject));

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
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHookInAppCommandScope(() => useEnvironmentListSync(["project-1"], refreshProject));

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
      () =>
        new Promise<void>((_resolve, reject) => {
          failRefresh = reject;
        }),
    );
    globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => {}) as typeof clearInterval;

    renderHookInAppCommandScope(() => useEnvironmentListSync(["project-1"], refreshProject));

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
    const refreshProject = mock<(projectId: string) => Promise<void>>()
      .mockImplementationOnce(() => Promise.reject(new Error("temporary failure")))
      .mockImplementation(() => Promise.resolve());

    renderHookInAppCommandScope(() => useEnvironmentListSync(["project-1"], refreshProject));

    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });
    await act(async () => {
      requestResourceResync();
      await Promise.resolve();
    });

    expect(refreshProject).toHaveBeenCalledTimes(2);
  });
});
