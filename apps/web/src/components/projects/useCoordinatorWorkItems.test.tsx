import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import * as builds from "@/lib/build-pipeline-persistence";
import * as reviews from "@/lib/multi-review-persistence";
import { portalStore } from "@/lib/portal/portal-store";
import { requestResourceResync, requestViewSafetyChecks } from "@/lib/resource-sync";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useCoordinatorWorkItems, WORK_PANEL_CLOCK_MS } from "./useCoordinatorWorkItems";

const empty = new Set<string>();
const now = Date.now();
function snapshot(kind: string, nodeId?: string): CoordinatorSnapshot {
  return {
    workspace: { id: "c", projectId: "p" },
    workflows: [
      {
        id: "a",
        coordinatorId: "c",
        projectId: "p",
        resourceId: "r",
        kind,
        createdAt: new Date(now).toISOString(),
        ...(nodeId ? { nodeId } : {}),
      },
    ],
  } as CoordinatorSnapshot;
}
function pipeline(phase: BuildPipeline["phase"]): BuildPipeline {
  return {
    id: "r",
    taskId: "t",
    projectId: "p",
    environmentId: "e",
    environmentType: "local",
    agentType: "codex",
    phase,
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: new Date(now).toISOString(),
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
  };
}
afterEach(() => {
  cleanup();
  portalStore.store.setState({ nodes: [] });
});

test.each(["build-pipeline", "multi-review"])(
  "local %s retries errors, distinguishes missing and recovers on resync",
  async (kind) => {
    useBuildPipelineStore.setState({ pipelines: new Map() });
    useMultiReviewStore.setState({ workflows: new Map() });
    useKanbanStore.setState({ currentProjectId: "p", tasks: [] });
    const owner = kind === "build-pipeline" ? builds : reviews;
    const method =
      kind === "build-pipeline" ? "hydrateBuildPipeline" : "hydrateMultiReviewWorkflow";
    const load = spyOn(owner as typeof builds, method as "hydrateBuildPipeline")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(null);
    try {
      const snap = snapshot(kind);
      const hook = renderHook(() => useCoordinatorWorkItems(snap, empty));
      await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      expect(hook.result.current.counts.running).toBe(1);
      await act(async () => requestViewSafetyChecks("interval"));
      await waitFor(() => expect(hook.result.current.counts.finished).toBe(1));
      expect(load).toHaveBeenCalledTimes(2);
      await act(async () => requestResourceResync());
      await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    } finally {
      load.mockRestore();
    }
  },
);

test("remote failed pipeline refreshes after retry and survives a read error without remounting", async () => {
  let phase: BuildPipeline["phase"] = "failed";
  let offline = false;
  const read = spyOn(portalStore, "invokeOnNode").mockImplementation(async () => {
    if (offline) throw new Error("offline");
    return { snapshot: pipeline(phase) } as never;
  });
  try {
    const snap = snapshot("build-pipeline", "remote");
    const hook = renderHook(() => useCoordinatorWorkItems(snap, empty));
    await waitFor(() => expect(hook.result.current.items[0]?.stage).toBe("Failed"));
    offline = true;
    await act(async () => requestViewSafetyChecks("interval"));
    expect(hook.result.current.items[0]?.stage).toBe("Failed");
    offline = false;
    phase = "reviewing";
    await act(async () => requestResourceResync());
    await waitFor(() => expect(hook.result.current.counts.running).toBe(1));
    expect(hook.result.current.items[0]?.stage).toBe("Build · Review");
    // Node summary refreshes also drive a targeted remote read.
    const count = read.mock.calls.length;
    await act(async () =>
      portalStore.store.setState({
        nodes: [
          {
            nodeId: "remote",
            loadedAt: 1,
            available: true,
            view: { displayName: "Remote" },
            environments: [],
          },
        ] as never,
      }),
    );
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(count));
  } finally {
    read.mockRestore();
  }
});

test("remote graph run is read through its node, follows changes, and expires on the clock", async () => {
  let tick: (() => void) | undefined;
  // Only the panel's clock is captured; waitFor keeps its own polling timer.
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    if (delay !== WORK_PANEL_CLOCK_MS) return realSetInterval(callback, delay);
    tick = callback;
    return 123;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((
    id: ReturnType<typeof setInterval>,
  ) => {
    if (id !== (123 as never)) realClearInterval(id);
  }) as typeof clearInterval);
  const date = spyOn(Date, "now").mockReturnValue(now);
  let status = "running";
  let offline = false;
  const read = spyOn(portalStore, "invokeOnNode").mockImplementation(async () => {
    if (offline) throw new Error("offline");
    return {
      status: "changed",
      run: {
        id: "r",
        projectId: "remote-project",
        environmentId: "remote-env",
        status,
        plan: { template: { name: "Ship it" } },
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        ...(status === "complete" ? { finishedAt: new Date(now).toISOString() } : {}),
      },
    } as never;
  });
  portalStore.store.setState({
    nodes: [
      {
        nodeId: "remote",
        loadedAt: 1,
        available: true,
        view: { displayName: "Studio" },
        environments: [],
      },
    ] as never,
  });
  try {
    const snap = snapshot("graph-run", "remote");
    const hook = renderHook(() => useCoordinatorWorkItems(snap, empty));
    await waitFor(() => expect(hook.result.current.items[0]?.stage).toBe("Graph run · running"));
    expect(read).toHaveBeenCalledWith("remote", "graph_run_get", { runId: "r" });
    expect(hook.result.current.items[0]).toMatchObject({
      machine: "Studio",
      target: { type: "remote", nodeId: "remote", environmentId: "remote-env" },
    });
    expect(hook.result.current.counts.running).toBe(1);
    // A failed read keeps the last stage.
    offline = true;
    await act(async () => requestViewSafetyChecks("interval"));
    expect(hook.result.current.items[0]?.stage).toBe("Graph run · running");
    // The run finishes while the coordinator is idle; a safety check re-reads it.
    offline = false;
    status = "complete";
    await act(async () => requestViewSafetyChecks("interval"));
    await waitFor(() => expect(hook.result.current.items[0]?.stage).toBe("Graph run complete"));
    expect(hook.result.current.counts.finished).toBe(1);
    // It drops off 24 hours after it finished, with no resource event.
    date.mockReturnValue(now + 25 * 60 * 60 * 1000);
    act(() => tick!());
    expect(hook.result.current.items).toHaveLength(0);
    hook.unmount();
    expect(clear).toHaveBeenCalledWith(123);
  } finally {
    read.mockRestore();
    interval.mockRestore();
    clear.mockRestore();
    date.mockRestore();
  }
});

test("a remote graph run its node no longer has becomes finished", async () => {
  const read = spyOn(portalStore, "invokeOnNode").mockImplementation(async () => {
    throw Object.assign(new Error("The graph run does not exist"), { code: "not-found" });
  });
  try {
    const snap = snapshot("graph-run", "remote");
    const hook = renderHook(() => useCoordinatorWorkItems(snap, empty));
    await waitFor(() => expect(hook.result.current.counts.finished).toBe(1));
    expect(hook.result.current.items[0]?.stage).toBe("Work no longer available");
  } finally {
    read.mockRestore();
  }
});

test("a held review removed from its store is confirmed missing and recovers on a later read", async () => {
  const record = {
    id: "r",
    projectId: "p",
    environmentId: "e",
    phase: "reviewing",
    reviewers: [],
    updatedAt: new Date(now).toISOString(),
  } as never;
  useMultiReviewStore.setState({ workflows: new Map([["r", record]]) });
  let missing = true;
  const load = spyOn(reviews, "hydrateMultiReviewWorkflow").mockImplementation(async () => {
    if (missing) {
      useMultiReviewStore.getState().removeWorkflow("r");
      return null;
    }
    useMultiReviewStore.setState({ workflows: new Map([["r", record]]) });
    return record;
  });
  try {
    const snap = snapshot("multi-review");
    const hook = renderHook(() => useCoordinatorWorkItems(snap, empty));
    expect(hook.result.current.counts.running).toBe(1);
    act(() => useMultiReviewStore.getState().removeWorkflow("r"));
    await waitFor(() => expect(hook.result.current.counts.finished).toBe(1));
    missing = false;
    await act(async () => requestViewSafetyChecks("interval"));
    await waitFor(() => expect(hook.result.current.counts.running).toBe(1));
    hook.unmount();
    // A returning panel reads authoritative store state, without its old events.
    const returned = renderHook(() => useCoordinatorWorkItems(snap, empty));
    expect(returned.result.current.counts.running).toBe(1);
  } finally {
    load.mockRestore();
  }
});

test.each(["build-pipeline", "multi-review"])(
  "remote %s clears deleted records, remounts missing and retries errors",
  async (kind) => {
    const reviewRecord = {
      version: 1,
      controller: "backend",
      id: "r",
      projectId: "p",
      environmentId: "e",
      targetBranch: "main",
      phase: "reviewing",
      reviewers: [
        { id: "one", agent: "codex", model: "gpt", status: "running" },
        { id: "two", agent: "codex", model: "gpt", status: "running" },
      ],
      fixModel: { agent: "codex", model: "gpt" },
      backendRevision: 1,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    let missing = false;
    let offline = false;
    const read = spyOn(portalStore, "invokeOnNode").mockImplementation(async () => {
      if (offline) throw new Error("offline");
      return (
        missing
          ? null
          : { snapshot: kind === "build-pipeline" ? pipeline("building") : reviewRecord }
      ) as never;
    });
    try {
      const snap = snapshot(kind, "remote");
      const hook = renderHook(() => useCoordinatorWorkItems(snap, empty));
      await waitFor(() => expect(hook.result.current.items[0]?.target).not.toBeNull());
      offline = true;
      await act(async () => requestViewSafetyChecks("interval"));
      expect(hook.result.current.counts.running).toBe(1);
      offline = false;
      missing = true;
      await act(async () => requestResourceResync());
      await waitFor(() => expect(hook.result.current.counts.finished).toBe(1));
      expect(hook.result.current.items[0]?.target).toBeNull();
      hook.unmount();
      const fresh = renderHook(() => useCoordinatorWorkItems(snap, empty));
      await waitFor(() => expect(fresh.result.current.counts.finished).toBe(1));
      missing = false;
      await act(async () => requestResourceResync());
      await waitFor(() => expect(fresh.result.current.counts.running).toBe(1));
    } finally {
      read.mockRestore();
    }
  },
);
