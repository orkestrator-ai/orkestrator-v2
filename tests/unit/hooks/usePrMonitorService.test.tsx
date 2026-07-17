import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as realBackend from "../../../apps/web/src/lib/backend";
import type {
  KanbanStatus,
  KanbanTask,
  PrDetectionResult,
} from "../../../apps/web/src/lib/backend";
import type { BuildPipeline } from "../../../apps/web/src/stores/buildPipelineStore";
import * as realSonner from "../../../apps/web/node_modules/sonner";
import type { Environment } from "../../../apps/web/src/types";

const realBackendSnapshot = { ...realBackend };
const realSonnerSnapshot = { ...realSonner };
const detectPrMock = mock(
  async (_containerId: string, _branch: string): Promise<PrDetectionResult | null> => null
);
const detectPrLocalMock = mock(
  async (_environmentId: string, _branch: string): Promise<PrDetectionResult | null> => null
);
const setEnvironmentPrMock = mock(
  async (
    _environmentId: string,
    _url: string,
    _state: string,
    _hasMergeConflicts: boolean
  ) => {}
);
const clearEnvironmentPrMock = mock(async (_environmentId: string) => {});
const toastSuccessMock = mock(() => {});
const moveTaskMock = mock(async (_taskId: string, _status: KanbanStatus) => {});
const updateTaskMock = mock(
  async (_taskId: string, _updates: Partial<KanbanTask>) => {}
);
const addCommentMock = mock(async (_taskId: string, _text: string) => {});

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  detectPr: detectPrMock,
  detectPrLocal: detectPrLocalMock,
  setEnvironmentPr: setEnvironmentPrMock,
  clearEnvironmentPr: clearEnvironmentPrMock,
}));

mock.module("sonner", () => ({
  ...realSonnerSnapshot,
  toast: {
    ...realSonnerSnapshot.toast,
    success: toastSuccessMock,
  },
}));

// Import every stateful dependency after installing module mocks. Bun can create
// a second module instance when a dependency is mocked after a store was loaded,
// which would make assertions observe a different Zustand store than the hook.
const { useAgentActivityStore } = await import(
  "../../../apps/web/src/stores/agentActivityStore"
);
const { useBuildPipelineStore } = await import(
  "../../../apps/web/src/stores/buildPipelineStore"
);
const { useEnvironmentStore } = await import(
  "../../../apps/web/src/stores/environmentStore"
);
const { useKanbanStore } = await import(
  "../../../apps/web/src/stores/kanbanStore"
);
const { PR_MONITOR_TIMEOUTS, usePrMonitorStore } = await import(
  "../../../apps/web/src/stores/prMonitorStore"
);
const { useUIStore } = await import("../../../apps/web/src/stores/uiStore");
const { usePrMonitorService } = await import(
  "../../../apps/web/src/hooks/usePrMonitorService"
);

const originalKanbanActions = {
  moveTask: useKanbanStore.getState().moveTask,
  updateTask: useKanbanStore.getState().updateTask,
  addComment: useKanbanStore.getState().addComment,
};

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const serviceIntervalHandle = {} as ReturnType<typeof setInterval>;
let tickCallback: (() => void) | null = null;
let serviceIntervalCleared = false;

function advanceTick(): void {
  act(() => {
    tickCallback?.();
  });
}

function makeCheckDue(environmentId: string): void {
  act(() => {
    usePrMonitorStore.setState((state) => ({
      monitoredEnvironments: {
        ...state.monitoredEnvironments,
        [environmentId]: {
          ...state.monitoredEnvironments[environmentId]!,
          lastCheckTime: 0,
        },
      },
    }));
  });
}

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "PR monitor environment",
    branch: "feature/pr-monitor",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Monitor PR",
    description: "",
    acceptanceCriteria: "",
    status: "in-progress",
    comments: [],
    images: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    environmentId: "env-1",
    ...overrides,
  };
}

function selectEnvironment(environment: Environment, ready = true): void {
  useEnvironmentStore.setState({
    environments: [environment],
    workspaceReadyEnvironments: ready ? new Set([environment.id]) : new Set(),
  });
  useUIStore.setState({ selectedEnvironmentId: environment.id });
}

function installKanbanMocks(tasks: KanbanTask[] = []): void {
  useKanbanStore.setState({
    tasks,
    moveTask: moveTaskMock,
    updateTask: updateTaskMock,
    addComment: addCommentMock,
  });
}

beforeEach(() => {
  // Other suites can load these singleton stores before this file and leave
  // state behind through Bun's shared module cache. Reset them before the
  // first test as well as after each test so this suite is order-independent.
  useAgentActivityStore.setState({
    tabStates: {},
    containerStates: {},
    containerRefCounts: {},
    stateChangeCallbacks: new Map(),
  });
  usePrMonitorStore.setState({ monitoredEnvironments: {}, activeEnvironmentId: null });
  useUIStore.setState({ selectedEnvironmentId: null });
  useEnvironmentStore.setState({
    environments: [],
    workspaceReadyEnvironments: new Set(),
  });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });

  tickCallback = null;
  serviceIntervalCleared = false;
  globalThis.setInterval = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout === 1000) {
      tickCallback = handler as () => void;
      return serviceIntervalHandle;
    }
    return originalSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    if (handle === serviceIntervalHandle) {
      serviceIntervalCleared = true;
    } else {
      originalClearInterval(handle);
    }
  }) as typeof clearInterval;

  detectPrMock.mockReset();
  detectPrLocalMock.mockReset();
  setEnvironmentPrMock.mockReset();
  clearEnvironmentPrMock.mockReset();
  toastSuccessMock.mockReset();
  moveTaskMock.mockReset();
  updateTaskMock.mockReset();
  addCommentMock.mockReset();

  detectPrMock.mockImplementation(async () => null);
  detectPrLocalMock.mockImplementation(async () => null);
  setEnvironmentPrMock.mockImplementation(async () => {});
  clearEnvironmentPrMock.mockImplementation(async () => {});
  moveTaskMock.mockImplementation(async (taskId, status) => {
    useKanbanStore.setState((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, status } : task
      ),
    }));
  });
  updateTaskMock.mockImplementation(async (taskId, updates) => {
    useKanbanStore.setState((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, ...updates } : task
      ),
    }));
  });
  addCommentMock.mockImplementation(async (taskId, text) => {
    useKanbanStore.setState((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              comments: [
                ...task.comments,
                { id: `comment-${task.comments.length + 1}`, text, createdAt: "2026-01-01T00:00:00.000Z" },
              ],
            }
          : task
      ),
    }));
  });
  installKanbanMocks();
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("sonner", () => realSonnerSnapshot);
});

afterEach(() => {
  cleanup();
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  tickCallback = null;
  useAgentActivityStore.setState({
    tabStates: {},
    containerStates: {},
    containerRefCounts: {},
    stateChangeCallbacks: new Map(),
  });
  usePrMonitorStore.setState({ monitoredEnvironments: {}, activeEnvironmentId: null });
  useUIStore.setState({ selectedEnvironmentId: null });
  useEnvironmentStore.setState({
    environments: [],
    workspaceReadyEnvironments: new Set(),
  });
  useKanbanStore.setState({
    tasks: [],
    moveTask: originalKanbanActions.moveTask,
    updateTask: originalKanbanActions.updateTask,
    addComment: originalKanbanActions.addComment,
  });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
});

describe("usePrMonitorService", () => {
  test("registers singleton polling subscriptions and releases them on unmount", () => {
    const { unmount } = renderHook(() => usePrMonitorService());

    expect(tickCallback).not.toBeNull();
    expect(serviceIntervalCleared).toBe(false);
    expect(useAgentActivityStore.getState().stateChangeCallbacks.size).toBe(1);
    expect(usePrMonitorStore.getState().activeEnvironmentId).toBeNull();

    act(() => useEnvironmentStore.getState().setWorkspaceReady("env-untracked", true));
    expect(detectPrMock).not.toHaveBeenCalled();

    unmount();

    expect(serviceIntervalCleared).toBe(true);
    expect(useAgentActivityStore.getState().stateChangeCallbacks.size).toBe(0);
  });

  test("persists open PR detections without showing a terminal-state toast", async () => {
    const environment = makeEnvironment();
    const detection = {
      url: "https://github.com/org/repo/pull/1",
      state: "open" as const,
      hasMergeConflicts: true,
    };
    detectPrMock.mockResolvedValueOnce(detection);
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() => expect(setEnvironmentPrMock).toHaveBeenCalledTimes(1));
    expect(setEnvironmentPrMock).toHaveBeenCalledWith(
      environment.id,
      detection.url,
      "open",
      true
    );
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.prState).toBe(
      "open"
    );
  });

  test("does not announce a merge that was already stored", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "merged",
    });
    detectPrMock.mockResolvedValueOnce({
      url: environment.prUrl!,
      state: "merged",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() => expect(setEnvironmentPrMock).toHaveBeenCalledTimes(1));
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("announces a confirmed merge once while failed persistence is retried", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const detection = {
      url: environment.prUrl!,
      state: "merged" as const,
      hasMergeConflicts: false,
    };
    detectPrMock.mockResolvedValue(detection);
    setEnvironmentPrMock
      .mockRejectedValueOnce(new Error("persistence unavailable"))
      .mockResolvedValue(undefined);
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith("Branch merged", {
        description: environment.branch,
        id: `branch-merged-${environment.id}`,
      });
      expect(usePrMonitorStore.getState().getMonitoringState(environment.id)?.consecutiveErrors).toBe(
        1
      );
    });

    makeCheckDue(environment.id);
    advanceTick();

    await waitFor(() => expect(setEnvironmentPrMock).toHaveBeenCalledTimes(2));
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(usePrMonitorStore.getState().getMonitoringState(environment.id)).toMatchObject({
      checkInProgress: false,
      consecutiveErrors: 0,
    });
    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.prState).toBe(
      "merged"
    );
  });

  test("clears a missing open PR and preserves missing terminal PRs", async () => {
    const openEnvironment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    selectEnvironment(openEnvironment);
    const first = renderHook(() => usePrMonitorService());

    await waitFor(() => expect(clearEnvironmentPrMock).toHaveBeenCalledWith(openEnvironment.id));
    expect(useEnvironmentStore.getState().getEnvironmentById(openEnvironment.id)).toMatchObject({
      prUrl: null,
      prState: null,
    });
    first.unmount();

    for (const prState of ["merged", "closed"] as const) {
      clearEnvironmentPrMock.mockClear();
      const terminalEnvironment = makeEnvironment({
        id: `env-${prState}`,
        containerId: `container-${prState}`,
        prUrl: `https://github.com/org/repo/pull/${prState}`,
        prState,
      });
      selectEnvironment(terminalEnvironment);
      const hook = renderHook(() => usePrMonitorService());

      await waitFor(() => {
        expect(
          usePrMonitorStore.getState().getMonitoringState(terminalEnvironment.id)?.checkInProgress
        ).toBe(false);
      });
      expect(clearEnvironmentPrMock).not.toHaveBeenCalled();
      expect(
        useEnvironmentStore.getState().getEnvironmentById(terminalEnvironment.id)?.prState
      ).toBe(prState);
      hook.unmount();
    }
  });

  test("tracks detection errors without clearing stored state and always finalizes", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    detectPrMock.mockRejectedValueOnce(new Error("GitHub unavailable"));
    selectEnvironment(environment);
    const startedAt = Date.now();

    renderHook(() => usePrMonitorService());

    await waitFor(() => {
      expect(usePrMonitorStore.getState().getMonitoringState(environment.id)).toMatchObject({
        checkInProgress: false,
        consecutiveErrors: 1,
      });
      expect(
        usePrMonitorStore.getState().getMonitoringState(environment.id)?.lastCheckTime
      ).toBeGreaterThanOrEqual(startedAt);
    });
    expect(setEnvironmentPrMock).not.toHaveBeenCalled();
    expect(clearEnvironmentPrMock).not.toHaveBeenCalled();
    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id)?.prState).toBe(
      "open"
    );
  });

  test("resets prior errors after a not-found result", async () => {
    const environment = makeEnvironment();
    selectEnvironment(environment);
    usePrMonitorStore.getState().startMonitoring(environment.id, "normal");
    usePrMonitorStore.setState((state) => ({
      monitoredEnvironments: {
        ...state.monitoredEnvironments,
        [environment.id]: {
          ...state.monitoredEnvironments[environment.id]!,
          consecutiveErrors: 3,
        },
      },
    }));

    renderHook(() => usePrMonitorService());

    await waitFor(() => {
      expect(usePrMonitorStore.getState().getMonitoringState(environment.id)?.consecutiveErrors).toBe(
        0
      );
    });
  });

  test("uses local-worktree detection for a ready local environment", async () => {
    const environment = makeEnvironment({
      environmentType: "local",
      worktreePath: "/tmp/repo-worktree",
      containerId: undefined,
      status: "stopped",
    });
    detectPrLocalMock.mockResolvedValueOnce({
      url: "https://github.com/org/repo/pull/2",
      state: "open",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() =>
      expect(detectPrLocalMock).toHaveBeenCalledWith(environment.id, environment.branch)
    );
    expect(detectPrMock).not.toHaveBeenCalled();
  });

  test("guards missing monitor, in-progress, missing environment, and unready environments", () => {
    const environment = makeEnvironment();
    useEnvironmentStore.setState({ environments: [environment] });
    usePrMonitorStore.setState({ activeEnvironmentId: environment.id });
    renderHook(() => usePrMonitorService());

    advanceTick();
    expect(detectPrMock).not.toHaveBeenCalled();

    act(() => {
      usePrMonitorStore.getState().startMonitoring(environment.id, "normal");
      usePrMonitorStore.setState((state) => ({
        monitoredEnvironments: {
          ...state.monitoredEnvironments,
          [environment.id]: {
            ...state.monitoredEnvironments[environment.id]!,
            checkInProgress: true,
          },
        },
      }));
    });
    advanceTick();
    expect(detectPrMock).not.toHaveBeenCalled();

    act(() => {
      usePrMonitorStore.setState((state) => ({
        monitoredEnvironments: {
          ...state.monitoredEnvironments,
          [environment.id]: {
            ...state.monitoredEnvironments[environment.id]!,
            checkInProgress: false,
          },
        },
      }));
      useEnvironmentStore.setState({ environments: [] });
    });
    advanceTick();
    expect(detectPrMock).not.toHaveBeenCalled();

    act(() => {
      useEnvironmentStore.setState({
        environments: [environment],
        workspaceReadyEnvironments: new Set(),
      });
    });
    advanceTick();
    expect(detectPrMock).not.toHaveBeenCalled();
  });

  test("reconciles a merged PR with an in-progress Kanban task", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const task = makeTask();
    installKanbanMocks([task]);
    detectPrMock.mockResolvedValueOnce({
      url: environment.prUrl!,
      state: "merged",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() =>
      expect(updateTaskMock).toHaveBeenCalledWith(task.id, {
        prState: "merged",
        prMergeCommented: true,
      })
    );
    expect(moveTaskMock).toHaveBeenCalledWith(task.id, "review");
    expect(addCommentMock).toHaveBeenCalledWith(task.id, "🎉 PR merged");
  });

  test("reconciles a pipeline task that is not loaded in the Kanban store", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const pipeline = {
      id: "pipeline-1",
      taskId: "pipeline-task-1",
      projectId: environment.projectId,
      environmentId: environment.id,
      environmentType: "containerized",
      agentType: "claude",
      phase: "complete",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      taskTitle: "Pipeline task",
      taskSnapshot: {},
      source: { type: "kanban", taskId: "pipeline-task-1" },
    } as BuildPipeline;
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([environment.id]),
    });
    detectPrMock.mockResolvedValueOnce({
      url: environment.prUrl!,
      state: "merged",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() => expect(addCommentMock).toHaveBeenCalledTimes(1));
    expect(updateTaskMock).toHaveBeenNthCalledWith(1, pipeline.taskId, {
      status: "review",
    });
    expect(addCommentMock).toHaveBeenCalledWith(pipeline.taskId, "🎉 PR merged");
    expect(updateTaskMock).toHaveBeenNthCalledWith(2, pipeline.taskId, {
      prState: "merged",
      prMergeCommented: true,
    });
  });

  test("does not regress a done task or duplicate an existing merge comment", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    installKanbanMocks([
      makeTask({ status: "done", prState: "merged", prMergeCommented: true }),
    ]);
    detectPrMock.mockResolvedValueOnce({
      url: environment.prUrl!,
      state: "merged",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() => expect(setEnvironmentPrMock).toHaveBeenCalledTimes(1));
    expect(moveTaskMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  test("adds closed PR metadata without moving the Kanban task", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const task = makeTask();
    installKanbanMocks([task]);
    detectPrMock.mockResolvedValueOnce({
      url: environment.prUrl!,
      state: "closed",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() =>
      expect(updateTaskMock).toHaveBeenCalledWith(task.id, {
        prState: "closed",
        prMergeCommented: true,
      })
    );
    expect(addCommentMock).toHaveBeenCalledWith(task.id, "❌ PR closed");
    expect(moveTaskMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  test("retries only the unfinished Kanban reconciliation step", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const task = makeTask();
    installKanbanMocks([task]);
    const detection = {
      url: environment.prUrl!,
      state: "merged" as const,
      hasMergeConflicts: false,
    };
    detectPrMock.mockResolvedValue(detection);
    updateTaskMock.mockRejectedValueOnce(new Error("metadata write failed"));
    selectEnvironment(environment);

    renderHook(() => usePrMonitorService());

    await waitFor(() => expect(updateTaskMock).toHaveBeenCalledTimes(1));
    makeCheckDue(environment.id);
    advanceTick();
    await waitFor(() => expect(updateTaskMock).toHaveBeenCalledTimes(2));

    expect(moveTaskMock).toHaveBeenCalledTimes(1);
    expect(addCommentMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(updateTaskMock).toHaveBeenLastCalledWith(task.id, {
      prState: "merged",
      prMergeCommented: true,
    });
  });

  test("retries a status action that resolves without persisting", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const task = makeTask();
    installKanbanMocks([task]);
    moveTaskMock.mockImplementationOnce(async () => {});
    detectPrMock.mockResolvedValue({
      url: environment.prUrl!,
      state: "merged",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(moveTaskMock).toHaveBeenCalledTimes(1));

    makeCheckDue(environment.id);
    advanceTick();

    await waitFor(() => expect(moveTaskMock).toHaveBeenCalledTimes(2));
    expect(addCommentMock).toHaveBeenCalledTimes(1);
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
  });

  test("retries a comment action that resolves without persisting", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const task = makeTask();
    installKanbanMocks([task]);
    addCommentMock.mockImplementationOnce(async () => {});
    detectPrMock.mockResolvedValue({
      url: environment.prUrl!,
      state: "closed",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(addCommentMock).toHaveBeenCalledTimes(1));

    makeCheckDue(environment.id);
    advanceTick();

    await waitFor(() => expect(addCommentMock).toHaveBeenCalledTimes(2));
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
  });

  test("retries metadata that resolves without persisting", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    const task = makeTask();
    installKanbanMocks([task]);
    updateTaskMock.mockImplementationOnce(async () => {});
    detectPrMock.mockResolvedValue({
      url: environment.prUrl!,
      state: "closed",
      hasMergeConflicts: false,
    });
    selectEnvironment(environment);
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(updateTaskMock).toHaveBeenCalledTimes(1));

    makeCheckDue(environment.id);
    advanceTick();

    await waitFor(() => expect(updateTaskMock).toHaveBeenCalledTimes(2));
    expect(addCommentMock).toHaveBeenCalledTimes(1);
  });

  test("transitions create-pending to normal and stores the detected PR on its task", async () => {
    const environment = makeEnvironment();
    const task = makeTask();
    installKanbanMocks([task]);
    detectPrMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        url: "https://github.com/org/repo/pull/3",
        state: "open",
        hasMergeConflicts: false,
      });
    selectEnvironment(environment);
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));

    act(() => {
      usePrMonitorStore.getState().setMonitoringMode(environment.id, "create-pending");
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "working");
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "idle");
    });

    await waitFor(() => {
      expect(usePrMonitorStore.getState().getMonitoringState(environment.id)?.mode).toBe("normal");
      expect(updateTaskMock).toHaveBeenCalledWith(task.id, {
        prUrl: "https://github.com/org/repo/pull/3",
        prState: "open",
      });
    });
  });

  test("keeps the create-pending transition successful when task metadata storage fails", async () => {
    const environment = makeEnvironment();
    const task = makeTask();
    installKanbanMocks([task]);
    detectPrMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        url: "https://github.com/org/repo/pull/3",
        state: "open",
        hasMergeConflicts: false,
      });
    updateTaskMock.mockRejectedValueOnce(new Error("task metadata unavailable"));
    selectEnvironment(environment);
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));

    act(() => {
      usePrMonitorStore.getState().setMonitoringMode(environment.id, "create-pending");
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "working");
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "idle");
    });

    await waitFor(() => {
      expect(usePrMonitorStore.getState().getMonitoringState(environment.id)?.mode).toBe("normal");
      expect(updateTaskMock).toHaveBeenCalledTimes(1);
    });
  });

  test("transitions merge-pending to normal after a terminal detection", async () => {
    const environment = makeEnvironment({
      prUrl: "https://github.com/org/repo/pull/1",
      prState: "open",
    });
    detectPrMock
      .mockResolvedValueOnce({
        url: environment.prUrl!,
        state: "open",
        hasMergeConflicts: false,
      })
      .mockResolvedValueOnce({
        url: environment.prUrl!,
        state: "closed",
        hasMergeConflicts: false,
      });
    selectEnvironment(environment);
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));

    act(() => {
      usePrMonitorStore.getState().setMonitoringMode(environment.id, "merge-pending");
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "working");
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "idle");
    });

    await waitFor(() =>
      expect(usePrMonitorStore.getState().getMonitoringState(environment.id)?.mode).toBe("normal")
    );
  });

  test("times out merge-pending mode and performs a fresh check", async () => {
    const environment = makeEnvironment();
    useEnvironmentStore.setState({
      environments: [environment],
      workspaceReadyEnvironments: new Set([environment.id]),
    });
    usePrMonitorStore.getState().startMonitoring(environment.id, "merge-pending");
    usePrMonitorStore.getState().setActiveEnvironment(environment.id);
    usePrMonitorStore.setState((state) => ({
      monitoredEnvironments: {
        ...state.monitoredEnvironments,
        [environment.id]: {
          ...state.monitoredEnvironments[environment.id]!,
          modeStartTime:
            Date.now() - (PR_MONITOR_TIMEOUTS["merge-pending"] ?? 0) - 1,
        },
      },
    }));
    renderHook(() => usePrMonitorService());

    advanceTick();

    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));
    expect(usePrMonitorStore.getState().getMonitoringState(environment.id)?.mode).toBe("normal");
  });

  test("idles the previous monitor and immediately checks a newly selected environment", async () => {
    const firstEnvironment = makeEnvironment();
    const secondEnvironment = makeEnvironment({
      id: "env-2",
      containerId: "container-2",
      branch: "feature/second",
      order: 1,
    });
    const thirdEnvironment = makeEnvironment({
      id: "env-3",
      containerId: "container-3",
      branch: "feature/third",
      order: 2,
    });
    useEnvironmentStore.setState({
      environments: [firstEnvironment, secondEnvironment, thirdEnvironment],
      workspaceReadyEnvironments: new Set([
        firstEnvironment.id,
        secondEnvironment.id,
        thirdEnvironment.id,
      ]),
    });
    usePrMonitorStore.getState().startMonitoring(secondEnvironment.id, "idle");
    useUIStore.setState({ selectedEnvironmentId: firstEnvironment.id });
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));

    act(() => useUIStore.setState({ selectedEnvironmentId: secondEnvironment.id }));

    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(2));
    expect(detectPrMock).toHaveBeenLastCalledWith(
      secondEnvironment.containerId,
      secondEnvironment.branch
    );
    expect(usePrMonitorStore.getState().activeEnvironmentId).toBe(secondEnvironment.id);
    expect(usePrMonitorStore.getState().getMonitoringState(firstEnvironment.id)?.mode).toBe("idle");
    expect(usePrMonitorStore.getState().getMonitoringState(secondEnvironment.id)?.mode).toBe(
      "normal"
    );

    act(() => useUIStore.setState({ selectedEnvironmentId: thirdEnvironment.id }));

    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(3));
    expect(detectPrMock).toHaveBeenLastCalledWith(
      thirdEnvironment.containerId,
      thirdEnvironment.branch
    );
    expect(usePrMonitorStore.getState().activeEnvironmentId).toBe(thirdEnvironment.id);
    expect(usePrMonitorStore.getState().getMonitoringState(secondEnvironment.id)?.mode).toBe(
      "idle"
    );
    expect(usePrMonitorStore.getState().getMonitoringState(thirdEnvironment.id)?.mode).toBe(
      "normal"
    );
  });

  test("checks only the active environment when its agent becomes idle", async () => {
    const activeEnvironment = makeEnvironment();
    const inactiveEnvironment = makeEnvironment({
      id: "env-2",
      containerId: "container-2",
      order: 1,
    });
    useEnvironmentStore.setState({
      environments: [activeEnvironment, inactiveEnvironment],
      workspaceReadyEnvironments: new Set([activeEnvironment.id, inactiveEnvironment.id]),
    });
    useUIStore.setState({ selectedEnvironmentId: activeEnvironment.id });
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));

    act(() => {
      useAgentActivityStore.getState().setContainerState(inactiveEnvironment.containerId!, "working");
      useAgentActivityStore.getState().setContainerState(inactiveEnvironment.containerId!, "idle");
    });
    await Promise.resolve();
    expect(detectPrMock).toHaveBeenCalledTimes(1);

    act(() => {
      useAgentActivityStore.getState().setContainerState(activeEnvironment.containerId!, "working");
      useAgentActivityStore.getState().setContainerState(activeEnvironment.containerId!, "idle");
    });
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(2));
  });

  test("ignores an idle trigger after monitoring for the active environment stops", async () => {
    const environment = makeEnvironment();
    selectEnvironment(environment);
    renderHook(() => usePrMonitorService());
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));

    act(() => {
      usePrMonitorStore.getState().stopMonitoring(environment.id);
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "working");
      useAgentActivityStore.getState().setContainerState(environment.containerId!, "idle");
    });

    await Promise.resolve();
    expect(detectPrMock).toHaveBeenCalledTimes(1);
  });

  test("checks an active environment when its workspace becomes ready", async () => {
    const environment = makeEnvironment();
    selectEnvironment(environment, false);
    renderHook(() => usePrMonitorService());
    await Promise.resolve();
    expect(detectPrMock).not.toHaveBeenCalled();

    act(() => useEnvironmentStore.getState().setWorkspaceReady(environment.id, true));

    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));
  });

  test("lets an in-flight authoritative check finalize after unmount", async () => {
    const environment = makeEnvironment();
    let resolveDetection: ((value: PrDetectionResult | null) => void) | undefined;
    detectPrMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDetection = resolve;
        })
    );
    selectEnvironment(environment);
    const { unmount } = renderHook(() => usePrMonitorService());
    await waitFor(() => expect(detectPrMock).toHaveBeenCalledTimes(1));

    unmount();
    resolveDetection?.({
      url: "https://github.com/org/repo/pull/4",
      state: "open",
      hasMergeConflicts: false,
    });

    await waitFor(() => expect(setEnvironmentPrMock).toHaveBeenCalledTimes(1));
    expect(usePrMonitorStore.getState().getMonitoringState(environment.id)).toMatchObject({
      checkInProgress: false,
    });
    expect(useAgentActivityStore.getState().stateChangeCallbacks.size).toBe(0);
  });
});
