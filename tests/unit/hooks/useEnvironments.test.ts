import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConfigStore } from "../../../apps/web/src/stores/configStore";
import { useBuildPipelineStore } from "../../../apps/web/src/stores/buildPipelineStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import { useClaudeOptionsStore } from "../../../apps/web/src/stores/claudeOptionsStore";
import { useLoopedReviewStore } from "../../../apps/web/src/stores/loopedReviewStore";
import { useUIStore } from "../../../apps/web/src/stores/uiStore";
import { useErrorDialogStore } from "../../../apps/web/src/stores/errorDialogStore";
import { useSessionStore } from "../../../apps/web/src/stores/sessionStore";
import { mockToastError, mockToastSuccess } from "../../mocks/sonner";
import type { Environment, EnvironmentType, NetworkAccessMode, PortMapping, StartEnvironmentResult } from "../../../apps/web/src/types";
import { createMockEnvironment } from "../utils/testFactories";
import { loopedReviewFixture } from "../../../apps/web/src/test/looped-review-fixture";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function seedBuildPipeline(environmentId: string): string {
  const id = "pipeline-1";
  useBuildPipelineStore.getState().replacePipeline({
    id,
    taskId: "task-1",
    projectId: "project-1",
    environmentId,
    environmentType: "local",
    agentType: "claude",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-07-29T08:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    source: { type: "kanban", taskId: "task-1" },
    backendRevision: 1,
    controller: "backend",
  });
  return id;
}

// Mock backend module BEFORE importing the hook
const mockGetEnvironments = mock<(projectId: string) => Promise<Environment[]>>(() => Promise.resolve([]));
const mockGetEnvironmentSnapshots = mock<(projectId: string) => Promise<Environment[]>>(() => Promise.resolve([]));
const mockGetEnvironment = mock<(environmentId: string) => Promise<Environment | null>>(() => Promise.resolve(null));
const mockGetEnvironmentSetupSession = mock(() => Promise.resolve(null));
const mockCreateEnvironment = mock<(
  projectId: string,
  name?: string,
  networkAccessMode?: NetworkAccessMode,
  initialPrompt?: string,
  portMappings?: PortMapping[],
  environmentType?: EnvironmentType,
  namingPrompt?: string,
  buildPipelineId?: string,
) => Promise<Environment>>((projectId) =>
  Promise.resolve(createMockEnvironment({ id: "new-env-id", projectId, name: "test-env" }))
);
const mockDeleteEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockStartEnvironment = mock<(environmentId: string) => Promise<StartEnvironmentResult>>(() => Promise.resolve({ setupCommands: undefined }));
const mockStartEnvironmentInBackground = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockStopEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockSyncEnvironmentStatus = mock<(environmentId: string) => Promise<Environment>>((environmentId) =>
  Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "container-123", status: "running" }))
);
const mockReorderEnvironments = mock<(projectId: string, environmentIds: string[]) => Promise<Environment[]>>(
  () => Promise.resolve([]),
);
const mockUpdatePortMappings = mock<(environmentId: string, portMappings: PortMapping[]) => Promise<Environment>>(
  (environmentId) => Promise.resolve(createMockEnvironment({ id: environmentId })),
);
const mockClearEnvironmentPr = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());

mock.module("@/lib/backend", () => ({
  getEnvironments: mockGetEnvironments,
  getEnvironmentSnapshots: mockGetEnvironmentSnapshots,
  getEnvironment: mockGetEnvironment,
  getEnvironmentSetupSession: mockGetEnvironmentSetupSession,
  createEnvironment: mockCreateEnvironment,
  deleteEnvironment: mockDeleteEnvironment,
  startEnvironment: mockStartEnvironment,
  startEnvironmentInBackground: mockStartEnvironmentInBackground,
  stopEnvironment: mockStopEnvironment,
  syncEnvironmentStatus: mockSyncEnvironmentStatus,
  reorderEnvironments: mockReorderEnvironments,
  updatePortMappings: mockUpdatePortMappings,
  clearEnvironmentPr: mockClearEnvironmentPr,
}));

// Capture the event listener callback registered via listen()
import { listen } from "@/lib/native/events";
const mockListen = listen as ReturnType<typeof mock>;

// Import hook AFTER mocking
import {
  reconcileEnvironmentSetupSnapshots,
  useEnvironmentLifecycleService,
  useEnvironments,
} from "../../../apps/web/src/hooks/useEnvironments";

describe("useEnvironments", () => {
  beforeEach(() => {
    // Reset store between tests
    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      sessionActivated: new Set(),
    });
    useUIStore.setState({ unreadEnvironmentIds: [] });
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    useLoopedReviewStore.setState({ workflows: new Map() });
    useErrorDialogStore.setState({ error: null });
    useClaudeOptionsStore.setState({ options: {}, pendingNativeLaunches: {} });
    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [".env.local", ".env"],
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    });

    // Reset mocks
    mockGetEnvironments.mockClear();
    mockGetEnvironmentSnapshots.mockClear();
    mockGetEnvironment.mockClear();
    mockGetEnvironmentSetupSession.mockClear();
    mockCreateEnvironment.mockClear();
    mockDeleteEnvironment.mockClear();
    mockStartEnvironment.mockClear();
    mockStartEnvironmentInBackground.mockClear();
    mockStopEnvironment.mockClear();
    mockSyncEnvironmentStatus.mockClear();
    mockReorderEnvironments.mockClear();
    mockUpdatePortMappings.mockClear();
    mockClearEnvironmentPr.mockClear();
    mockListen.mockClear();
    mockToastSuccess.mockClear();

    // Reset to default implementations
    mockGetEnvironments.mockImplementation(() => Promise.resolve([]));
    mockGetEnvironmentSnapshots.mockImplementation(() => Promise.resolve([]));
    mockGetEnvironment.mockImplementation(() => Promise.resolve(null));
    mockGetEnvironmentSetupSession.mockImplementation(() => Promise.resolve(null));
    mockCreateEnvironment.mockImplementation((projectId) =>
      Promise.resolve(createMockEnvironment({ id: "new-env-id", projectId, name: "test-env" }))
    );
    mockDeleteEnvironment.mockImplementation(() => Promise.resolve());
    mockStartEnvironment.mockImplementation(() => Promise.resolve({ setupCommands: undefined }));
    mockStartEnvironmentInBackground.mockImplementation(() => Promise.resolve());
    mockStopEnvironment.mockImplementation(() => Promise.resolve());
    mockSyncEnvironmentStatus.mockImplementation((environmentId) =>
      Promise.resolve(createMockEnvironment({ id: environmentId, containerId: "container-123", status: "running" }))
    );
    mockReorderEnvironments.mockImplementation(() => Promise.resolve([]));
    mockUpdatePortMappings.mockImplementation((environmentId) =>
      Promise.resolve(createMockEnvironment({ id: environmentId }))
    );
    mockClearEnvironmentPr.mockImplementation(() => Promise.resolve());
    mockListen.mockImplementation(() => Promise.resolve(() => {}));
  });

  test("returns empty environments when no projectId", () => {
    const { result } = renderHook(() => useEnvironments(null));

    expect(result.current.environments).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  test("loads environments when projectId is provided", async () => {
    const mockEnvs: Environment[] = [
      createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env-1" }),
    ];
    mockGetEnvironments.mockImplementation(() => Promise.resolve(mockEnvs));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.environments).toHaveLength(1);
    });

    expect(mockGetEnvironments).toHaveBeenCalledWith("project-1");
    expect(result.current.environments[0]?.id).toBe("env-1");
  });

  test("does not discard an environment created after a snapshot request began", async () => {
    const snapshot = createDeferred<Environment[]>();
    mockGetEnvironmentSnapshots.mockImplementation(() => snapshot.promise);
    const { result } = renderHook(() => useEnvironments(null));

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.loadEnvironments(
        "project-1",
        { silent: true, reconcileStatus: false },
      );
    });
    expect(mockGetEnvironmentSnapshots).toHaveBeenCalledWith("project-1");

    let environment!: Environment;
    await act(async () => {
      environment = await result.current.createEnvironment(
        "project-1",
        undefined,
        "full",
        undefined,
        undefined,
        "local",
        undefined,
        "pipeline-1",
      );
    });

    await act(async () => {
      snapshot.resolve([]);
      await refreshPromise;
    });

    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
      .toEqual(environment);
  });

  test("does not discard an environment when a snapshot runs during creation", async () => {
    const creation = createDeferred<Environment>();
    const snapshot = createDeferred<Environment[]>();
    mockCreateEnvironment.mockImplementation(() => creation.promise);
    mockGetEnvironmentSnapshots.mockImplementation(() => snapshot.promise);
    const { result } = renderHook(() => useEnvironments(null));

    let creationPromise!: Promise<Environment>;
    act(() => {
      creationPromise = result.current.createEnvironment(
        "project-1",
        undefined,
        "full",
        undefined,
        undefined,
        "local",
        undefined,
        "pipeline-1",
      );
    });
    expect(mockCreateEnvironment).toHaveBeenCalled();

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.loadEnvironments(
        "project-1",
        { silent: true, reconcileStatus: false },
      );
    });
    expect(mockGetEnvironmentSnapshots).toHaveBeenCalledWith("project-1");

    const environment = createMockEnvironment({
      id: "env-created",
      projectId: "project-1",
      environmentType: "local",
      buildPipelineId: "pipeline-1",
    });
    await act(async () => {
      creation.resolve(environment);
      await creationPromise;
    });

    await act(async () => {
      snapshot.resolve([]);
      await refreshPromise;
    });

    expect(useEnvironmentStore.getState().getEnvironmentById(environment.id))
      .toEqual(environment);
  });

  test("silently refreshes read-only snapshots without changing loading or error state", async () => {
    const refreshedEnvironment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "created-in-another-client",
    });
    mockGetEnvironmentSnapshots.mockImplementation(() => Promise.resolve([refreshedEnvironment]));
    useEnvironmentStore.setState({ error: "Existing visible error", isLoading: false });

    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await result.current.loadEnvironments("project-1", { silent: true, reconcileStatus: false });
    });

    expect(result.current.allEnvironments).toEqual([refreshedEnvironment]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe("Existing visible error");
    expect(mockGetEnvironmentSnapshots).toHaveBeenCalledWith("project-1");
    expect(mockGetEnvironments).not.toHaveBeenCalled();
  });

  test("keeps visible state unchanged when a silent snapshot refresh fails", async () => {
    const consoleWarn = console.warn;
    const warnMock = mock(() => undefined);
    console.warn = warnMock as typeof console.warn;
    mockGetEnvironmentSnapshots.mockImplementation(() => Promise.reject(new Error("snapshot unavailable")));
    useEnvironmentStore.setState({ error: "Existing visible error", isLoading: false });
    const { result } = renderHook(() => useEnvironments(null));

    try {
      await act(async () => {
        await result.current.loadEnvironments("project-1", { silent: true, reconcileStatus: false });
      });
    } finally {
      console.warn = consoleWarn;
    }

    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBe("Existing visible error");
    expect(warnMock).toHaveBeenCalledWith(
      "[useEnvironments] Failed to refresh environments for project project-1:",
      "snapshot unavailable",
    );
  });

  test("createEnvironment creates an environment successfully", async () => {
    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let createdEnv: Environment | undefined;
    await act(async () => {
      createdEnv = await result.current.createEnvironment("project-1");
    });

    expect(mockCreateEnvironment.mock.calls[0][0]).toBe("project-1");
    expect(createdEnv?.id).toBe("new-env-id");
    expect(result.current.allEnvironments).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(useConfigStore.getState().config.repositories["project-1"]?.lastEnvironmentType).toBe("containerized");
  });

  test("createEnvironment forwards optional creation parameters", async () => {
    const { result } = renderHook(() => useEnvironments("project-1"));
    const portMappings = [{ hostPort: 5173, containerPort: 5173, protocol: "tcp" as const }];

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.createEnvironment(
        "project-1",
        undefined,
        "restricted",
        undefined,
        portMappings,
        "containerized",
        "Build task\n\nShip the feature",
      );
    });

    expect(mockCreateEnvironment).toHaveBeenCalledWith(
      "project-1",
      undefined,
      "restricted",
      undefined,
      portMappings,
      "containerized",
      "Build task\n\nShip the feature",
      undefined,
    );
  });

  test("createEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to create");
    mockCreateEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.createEnvironment("project-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to create");

    expect(result.current.error).toBe("Failed to create");
  });

  test("deleteEnvironment deletes an environment successfully", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env" });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));
    const pipelineId = seedBuildPipeline("env-1");
    const deletedWorkflow = loopedReviewFixture({
      environmentId: "env-1",
      projectId: "project-1",
    });
    const retainedWorkflow = loopedReviewFixture({
      environmentId: "env-2",
      projectId: "project-1",
    });
    useLoopedReviewStore.getState().replaceWorkflow(deletedWorkflow);
    useLoopedReviewStore.getState().replaceWorkflow(retainedWorkflow);

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.deleteEnvironment("env-1");
    });

    expect(mockDeleteEnvironment).toHaveBeenCalledWith("env-1");
    expect(result.current.allEnvironments).toHaveLength(0);
    expect(result.current.error).toBeNull();
    expect(useBuildPipelineStore.getState().pipelines.has(pipelineId)).toBe(false);
    expect(useLoopedReviewStore.getState().workflows.has(deletedWorkflow.id)).toBe(false);
    expect(useLoopedReviewStore.getState().workflows.has(retainedWorkflow.id)).toBe(true);
  });

  test("deleteEnvironment drops the environment and its unread marker with it", async () => {
    const deleted = createMockEnvironment({
      id: "env-1", projectId: "project-1", name: "test-env", hasUnreadWork: true,
    });
    const kept = createMockEnvironment({
      id: "env-keep", projectId: "project-1", name: "keep", hasUnreadWork: true,
    });

    useEnvironmentStore.setState({
      environments: [deleted, kept],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([deleted, kept]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.deleteEnvironment("env-1");
    });

    // The marker is a field on the record, so there is nothing left to prune.
    expect(
      useEnvironmentStore.getState().environments
        .filter((environment) => environment.hasUnreadWork)
        .map((environment) => environment.id),
    ).toEqual(["env-keep"]);
  });

  test("deleteEnvironment keeps the environment and its work when the backend delete fails", async () => {
    mockDeleteEnvironment.mockImplementation(() => Promise.reject(new Error("Failed to delete")));

    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env" });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });
    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));
    const pipelineId = seedBuildPipeline("env-1");
    const workflow = loopedReviewFixture({
      environmentId: "env-1",
      projectId: "project-1",
    });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.deleteEnvironment("env-1")).rejects.toThrow("Failed to delete");
    });

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toBeDefined();
    expect(useBuildPipelineStore.getState().pipelines.has(pipelineId)).toBe(true);
    expect(useLoopedReviewStore.getState().workflows.has(workflow.id)).toBe(true);
  });

  test("deleteEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to delete");
    mockDeleteEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env" });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.deleteEnvironment("env-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to delete");

    expect(result.current.error).toBe("Failed to delete");
    expect(result.current.allEnvironments).toHaveLength(1);
  });

  test("startEnvironment starts an environment and updates status", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "stopped",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));
    mockGetEnvironment.mockImplementation(() =>
      Promise.resolve(createMockEnvironment({ ...existingEnv, status: "running" }))
    );

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.startEnvironment("env-1");
    });

    expect(mockStartEnvironment).toHaveBeenCalledWith("env-1");
    expect(mockGetEnvironment).toHaveBeenCalledWith("env-1");
  });

  test("hands background starts to the backend without awaiting Docker provisioning", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-background",
      projectId: "project-1",
      status: "stopped",
    });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockGetEnvironments.mockResolvedValue([existingEnv]);

    const { result } = renderHook(() => useEnvironments("project-1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.startEnvironment(
        "env-background",
        "Launch after setup",
        { background: true, silent: true },
      );
    });

    expect(mockStartEnvironmentInBackground).toHaveBeenCalledWith("env-background");
    expect(mockStartEnvironment).not.toHaveBeenCalled();
    expect(
      useEnvironmentStore.getState().getEnvironmentById("env-background")?.status,
    ).toBe("creating");
    expect(
      useEnvironmentStore.getState().isSetupCommandsResolved("env-background"),
    ).toBe(false);
  });

  test("never reports success for a background start, even without silent", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-background-not-silent",
      projectId: "project-1",
      status: "stopped",
    });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockGetEnvironments.mockResolvedValue([existingEnv]);

    const { result } = renderHook(() => useEnvironments("project-1"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.startEnvironment(existingEnv.id, undefined, { background: true });
    });

    // Acceptance is not completion. "Environment started" here would be a claim
    // the backend has not yet earned; the real outcome arrives through the
    // persisted status and lifecycleError.
    expect(mockStartEnvironmentInBackground).toHaveBeenCalledWith(existingEnv.id);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test("reports background admission failures and releases the setup gate", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-background-rejected",
      projectId: "project-1",
      status: "stopped",
    });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockStartEnvironmentInBackground.mockRejectedValue(
      new Error("background start rejected"),
    );
    const { result } = renderHook(() => useEnvironments(null));

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.startEnvironment(
          existingEnv.id,
          undefined,
          { background: true, silent: true },
        );
      });
    } catch (error) {
      thrownError = error as Error;
    }

    const state = useEnvironmentStore.getState();
    expect(thrownError?.message).toBe("background start rejected");
    expect(state.getEnvironmentById(existingEnv.id)?.status).toBe("error");
    expect(state.isSetupCommandsResolved(existingEnv.id)).toBe(true);
    expect(mockToastError).toHaveBeenCalledWith(
      "Failed to start environment",
      expect.any(Object),
    );
  });

  test("reports a retry's durable failure after a background admission rejection", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-background-reject-retry",
      projectId: "project-1",
      status: "stopped",
    });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    let admission = 0;
    mockStartEnvironmentInBackground.mockImplementation(() => {
      admission += 1;
      return admission === 1
        ? Promise.reject(new Error("background start rejected"))
        : Promise.resolve();
    });
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await expect(
        result.current.startEnvironment(existingEnv.id, undefined, {
          background: true,
          silent: true,
        }),
      ).rejects.toThrow("background start rejected");
    });
    expect(mockToastError).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.startEnvironment(existingEnv.id, undefined, {
        background: true,
        silent: true,
      });
    });

    mockGetEnvironmentSnapshots.mockResolvedValue([
      {
        ...existingEnv,
        status: "error",
        lifecycleError: "Environment start failed.",
      },
    ]);
    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });

    // The admission failure is immediate and the retry's backend-owned failure
    // is durable. Each outcome is reported once.
    expect(mockToastError).toHaveBeenCalledTimes(2);
    expect(useEnvironmentStore.getState().error).toBe("Environment start failed.");
  });

  test("does not let a pre-retry snapshot restore the prior lifecycle failure", async () => {
    const environment = createMockEnvironment({
      id: "env-stale-retry-snapshot",
      projectId: "project-1",
      status: "error",
      lifecycleError: "Environment start failed.",
      pendingAgentLaunch: true,
    });
    const staleSnapshot = createDeferred<Environment[]>();
    useEnvironmentStore.setState({
      environments: [environment],
      setupCommandsResolved: new Set([environment.id]),
    });
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        [environment.id]: {
          containerId: null,
          environmentId: environment.id,
          targetPaneId: "default",
          agentType: "claude",
          launchMode: "native",
        } as any,
      },
    });
    mockGetEnvironmentSnapshots.mockImplementation(() => staleSnapshot.promise);
    const { result } = renderHook(() => useEnvironments(null));

    let loadPromise!: Promise<void>;
    act(() => {
      loadPromise = result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });
    await waitFor(() => expect(mockGetEnvironmentSnapshots).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.startEnvironment(environment.id, undefined, {
        background: true,
        silent: true,
      });
    });
    await act(async () => {
      staleSnapshot.resolve([environment]);
      await loadPromise;
    });

    const state = useEnvironmentStore.getState();
    expect(state.getEnvironmentById(environment.id)).toMatchObject({
      status: "creating",
      lifecycleError: null,
      pendingAgentLaunch: true,
    });
    expect(state.isSetupCommandsResolved(environment.id)).toBe(false);
    expect(
      useClaudeOptionsStore.getState().pendingNativeLaunches[environment.id],
    ).toBeDefined();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("startEnvironment clears the setup placeholder when there are no setup commands", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "local-env",
      containerId: null,
      status: "stopped",
      environmentType: "local",
      worktreePath: undefined,
    });
    const startedEnv = createMockEnvironment({
      ...existingEnv,
      status: "running",
      worktreePath: "/tmp/local-env",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));
    mockStartEnvironment.mockImplementation(() => Promise.resolve({ setupCommands: undefined }));
    mockGetEnvironment.mockImplementation(() => Promise.resolve(startedEnv));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.startEnvironment("env-1");
    });

    const state = useEnvironmentStore.getState();
    expect(state.setupCommandsResolved.has("env-1")).toBe(true);
    expect(state.pendingSetupCommands.has("env-1")).toBe(false);
  });

  test("startEnvironment does not clobber completed backend setup with a stale started result", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "local-env",
      containerId: null,
      status: "stopped",
      environmentType: "local",
      worktreePath: undefined,
      setupScriptsComplete: false,
    });
    const completedEnv = createMockEnvironment({
      ...existingEnv,
      status: "running",
      worktreePath: "/tmp/local-env",
      setupScriptsComplete: true,
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));
    mockStartEnvironment.mockImplementation(() => Promise.resolve({
      setupCommands: [],
      setupManagedByBackend: true,
      setupStarted: true,
      setupSessionId: "env-1:setup",
    }));
    mockGetEnvironment.mockImplementation(() => Promise.resolve(completedEnv));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.startEnvironment("env-1");
    });

    const state = useEnvironmentStore.getState();
    expect(state.getEnvironmentById("env-1")?.setupScriptsComplete).toBe(true);
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(true);
  });

  test("startEnvironment marks workspace ready when a completion event was already handled mid-flight", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "local-env",
      containerId: null,
      status: "stopped",
      environmentType: "local",
      worktreePath: undefined,
      setupScriptsComplete: false,
    });
    // The refreshed snapshot still reports setupScriptsComplete=false (the
    // completion is reflected only in the runtime readiness sets, not the
    // persisted flag yet).
    const refreshedEnv = createMockEnvironment({
      ...existingEnv,
      status: "running",
      worktreePath: "/tmp/local-env",
      setupScriptsComplete: false,
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));
    mockStartEnvironment.mockImplementation(() => Promise.resolve({
      setupCommands: [],
      setupManagedByBackend: true,
      setupStarted: true,
      setupSessionId: "env-1:setup",
    }));
    // Simulate a setup-completion event landing while startEnvironment awaited:
    // commands resolved and scripts no longer running, but workspaceReady was
    // never flipped true (the inconsistent intermediate this guards against).
    mockGetEnvironment.mockImplementation(() => {
      const store = useEnvironmentStore.getState();
      store.setSetupCommandsResolved("env-1", true);
      store.setSetupScriptsRunning("env-1", false);
      return Promise.resolve(refreshedEnv);
    });

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.startEnvironment("env-1");
    });

    const state = useEnvironmentStore.getState();
    // The env must not be stranded "not running, not ready": setup finished, so
    // it should be ready and no longer flagged as running.
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(true);
  });

  test("startEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to start");
    mockStartEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "stopped",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.startEnvironment("env-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to start");

    expect(result.current.error).toBe("Failed to start");
    // Status should be set to error
    expect(result.current.allEnvironments[0]?.status).toBe("error");
  });

  test("stopEnvironment stops an environment and updates status", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "running",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.stopEnvironment("env-1");
    });

    expect(mockStopEnvironment).toHaveBeenCalledWith("env-1");
    expect(result.current.allEnvironments[0]?.status).toBe("stopped");
  });

  test("stopEnvironment sets error on failure", async () => {
    const expectedError = new Error("Failed to stop");
    mockStopEnvironment.mockImplementation(() => Promise.reject(expectedError));

    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: "container-123",
      status: "running",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.stopEnvironment("env-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    // Verify the correct error was thrown
    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toBe("Failed to stop");

    expect(result.current.error).toBe("Failed to stop");
  });

  test("syncEnvironmentStatus updates environment data", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "test-env",
      containerId: null,
      status: "stopped",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.syncEnvironmentStatus("env-1");
    });

    expect(mockSyncEnvironmentStatus).toHaveBeenCalledWith("env-1");
    // The mock returns a running status with containerId
    expect(result.current.allEnvironments[0]?.status).toBe("running");
    expect(result.current.allEnvironments[0]?.containerId).toBe("container-123");
  });

  test("syncEnvironmentStatus leaves state unchanged when synchronization fails", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", status: "running" });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockSyncEnvironmentStatus.mockImplementation(() => Promise.reject(new Error("docker unavailable")));
    const consoleError = console.error;
    const errorMock = mock(() => undefined);
    console.error = errorMock as typeof console.error;
    const { result } = renderHook(() => useEnvironments(null));

    try {
      let synced: Environment | undefined;
      await act(async () => {
        synced = await result.current.syncEnvironmentStatus("env-1");
      });
      expect(synced).toBeUndefined();
    } finally {
      console.error = consoleError;
    }

    expect(result.current.allEnvironments).toEqual([existingEnv]);
    expect(errorMock).toHaveBeenCalled();
  });

  test("restartEnvironment stops, disconnects, and starts the environment", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", status: "running" });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockGetEnvironment.mockImplementation(() => Promise.resolve({ ...existingEnv, status: "running" }));
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await result.current.restartEnvironment("env-1");
    });

    expect(mockStopEnvironment).toHaveBeenCalledWith("env-1");
    expect(mockStartEnvironment).toHaveBeenCalledWith("env-1");
    expect(result.current.allEnvironments[0]?.status).toBe("running");
  });

  test("restartEnvironment records an error when stopping fails", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", status: "running" });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockStopEnvironment.mockImplementation(() => Promise.reject(new Error("stop failed")));
    const { result } = renderHook(() => useEnvironments(null));

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.restartEnvironment("env-1");
      });
    } catch (error) {
      thrownError = error as Error;
    }

    expect(thrownError?.message).toBe("stop failed");
    expect(result.current.error).toBe("stop failed");
    expect(result.current.allEnvironments[0]?.status).toBe("error");
  });

  test("restartEnvironment reports a start failure after stop succeeds", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-restart-start-fails",
      projectId: "project-1",
      status: "running",
    });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockStartEnvironment.mockRejectedValue(new Error("replacement start failed"));
    const { result } = renderHook(() => useEnvironments(null));

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.restartEnvironment(existingEnv.id);
      });
    } catch (error) {
      thrownError = error as Error;
    }

    expect(mockStopEnvironment).toHaveBeenCalledWith(existingEnv.id);
    expect(mockStartEnvironment).toHaveBeenCalledWith(existingEnv.id);
    expect(thrownError?.message).toBe("replacement start failed");
    expect(result.current.error).toBe("replacement start failed");
    expect(result.current.allEnvironments[0]?.status).toBe("error");
  });

  test("restartEnvironment reports a session-disconnect failure after stop succeeds", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-restart-disconnect-fails",
      projectId: "project-1",
      status: "running",
    });
    const originalDisconnect =
      useSessionStore.getState().disconnectEnvironmentSessions;
    useEnvironmentStore.setState({ environments: [existingEnv] });
    useSessionStore.setState({
      disconnectEnvironmentSessions: async () => {
        throw new Error("session disconnect failed");
      },
    });

    try {
      const { result } = renderHook(() => useEnvironments(null));
      let thrownError: Error | undefined;
      try {
        await act(async () => {
          await result.current.restartEnvironment(existingEnv.id);
        });
      } catch (error) {
        thrownError = error as Error;
      }

      expect(mockStopEnvironment).toHaveBeenCalledWith(existingEnv.id);
      expect(mockStartEnvironment).not.toHaveBeenCalled();
      expect(thrownError?.message).toBe("session disconnect failed");
      expect(result.current.error).toBe("session disconnect failed");
      expect(result.current.allEnvironments[0]?.status).toBe("error");
    } finally {
      useSessionStore.setState({
        disconnectEnvironmentSessions: originalDisconnect,
      });
    }
  });

  test("setEnvironmentPR updates PR state", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1" });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await result.current.setEnvironmentPR("env-1", "https://github.com/acme/repo/pull/1", "open");
    });

    expect(result.current.allEnvironments[0]).toMatchObject({
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
    });
  });

  test("setEnvironmentPR reports persistence failures", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-pr-failure",
      projectId: "project-1",
    });
    const originalSetEnvironmentPR =
      useEnvironmentStore.getState().setEnvironmentPR;
    useEnvironmentStore.setState({
      environments: [existingEnv],
      setEnvironmentPR: () => {
        throw new Error("PR persistence failed");
      },
    });

    try {
      const { result } = renderHook(() => useEnvironments(null));
      let thrownError: Error | undefined;
      try {
        await act(async () => {
          await result.current.setEnvironmentPR(
            existingEnv.id,
            "https://github.com/acme/repo/pull/2",
            "open",
          );
        });
      } catch (error) {
        thrownError = error as Error;
      }

      expect(thrownError?.message).toBe("PR persistence failed");
      expect(result.current.error).toBe("PR persistence failed");
      expect(mockToastError).toHaveBeenCalledWith(
        "Failed to set PR URL",
        expect.any(Object),
      );
    } finally {
      useEnvironmentStore.setState({
        setEnvironmentPR: originalSetEnvironmentPR,
      });
    }
  });

  test("reorderEnvironments persists and merges the backend order", async () => {
    const first = createMockEnvironment({ id: "env-1", projectId: "project-1", order: 0 });
    const second = createMockEnvironment({ id: "env-2", projectId: "project-1", order: 1 });
    useEnvironmentStore.setState({ environments: [first, second] });
    mockReorderEnvironments.mockImplementation(() => Promise.resolve([
      { ...second, order: 0 },
      { ...first, order: 1 },
    ]));
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await result.current.reorderEnvironments("project-1", ["env-2", "env-1"]);
    });

    expect(mockReorderEnvironments).toHaveBeenCalledWith("project-1", ["env-2", "env-1"]);
    expect(result.current.allEnvironments.map((environment) => environment.id)).toEqual(["env-2", "env-1"]);
  });

  test("reorderEnvironments reloads the authoritative order after persistence fails", async () => {
    const first = createMockEnvironment({ id: "env-1", projectId: "project-1", order: 0 });
    const second = createMockEnvironment({ id: "env-2", projectId: "project-1", order: 1 });
    useEnvironmentStore.setState({ environments: [first, second] });
    mockReorderEnvironments.mockImplementation(() => Promise.reject(new Error("write failed")));
    mockGetEnvironments.mockImplementation(() => Promise.resolve([first, second]));
    const { result } = renderHook(() => useEnvironments(null));

    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.reorderEnvironments("project-1", ["env-2", "env-1"]);
      });
    } catch (error) {
      thrownError = error as Error;
    }

    expect(thrownError?.message).toBe("write failed");
    expect(mockGetEnvironments).toHaveBeenCalledWith("project-1");
    expect(result.current.allEnvironments.map((environment) => environment.id)).toEqual(["env-1", "env-2"]);
  });

  test("updatePortMappings updates the environment and reports failures", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1" });
    const portMappings: PortMapping[] = [{ hostPort: 3000, containerPort: 3000, protocol: "tcp" }];
    useEnvironmentStore.setState({ environments: [existingEnv] });
    mockUpdatePortMappings.mockImplementation(() => Promise.resolve({ ...existingEnv, portMappings }));
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await result.current.updatePortMappings("env-1", portMappings);
    });
    expect(result.current.allEnvironments[0]?.portMappings).toEqual(portMappings);

    mockUpdatePortMappings.mockImplementation(() => Promise.reject(new Error("port update failed")));
    let thrownError: Error | undefined;
    try {
      await act(async () => {
        await result.current.updatePortMappings("env-1", []);
      });
    } catch (error) {
      thrownError = error as Error;
    }
    expect(thrownError?.message).toBe("port update failed");
    expect(result.current.error).toBe("port update failed");
  });

  test("exposes direct environment updates", () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "before" });
    useEnvironmentStore.setState({ environments: [existingEnv] });
    const { result } = renderHook(() => useEnvironments(null));

    act(() => {
      result.current.updateEnvironment("env-1", { name: "after" });
    });

    expect(result.current.allEnvironments[0]?.name).toBe("after");
  });

  test("getEnvironmentsByProjectId filters environments correctly", async () => {
    const envs: Environment[] = [
      createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env-1" }),
      createMockEnvironment({ id: "env-2", projectId: "project-2", name: "test-env-2" }),
    ];

    useEnvironmentStore.setState({
      environments: envs,
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation((projectId) =>
      Promise.resolve(envs.filter((e) => e.projectId === projectId))
    );

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // environments should only show project-1's environments
    expect(result.current.environments).toHaveLength(1);
    expect(result.current.environments[0]?.projectId).toBe("project-1");

    // allEnvironments should show all
    expect(result.current.allEnvironments).toHaveLength(2);

    // getEnvironmentsByProjectId should filter correctly
    const project1Envs = result.current.getEnvironmentsByProjectId("project-1");
    expect(project1Envs).toHaveLength(1);
    expect(project1Envs[0]?.id).toBe("env-1");
  });

  test("useEnvironments alone registers no setup lifecycle or reconnect listeners", async () => {
    const eventNames: string[] = [];
    mockListen.mockImplementation((eventName: string) => {
      eventNames.push(eventName);
      return Promise.resolve(() => {});
    });

    renderHook(() => useEnvironments(null));

    await waitFor(() => expect(eventNames).toContain("environment-renamed"));
    expect(eventNames).not.toContain("environment-setup-started");
    expect(eventNames).not.toContain("environment-setup-complete");
    expect(eventNames).not.toContain("native-event-stream-connected");
  });

  test("handles load error gracefully", async () => {
    mockGetEnvironments.mockImplementation(() => Promise.reject(new Error("Network error")));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");
    expect(result.current.environments).toEqual([]);
  });

  test("applies backend-owned setup start and completion events", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      environmentType: "local",
      setupScriptsComplete: false,
    });
    useEnvironmentStore.setState({ environments: [environment] });
    const callbacks = new Map<string, (event: { payload: any }) => void>();
    mockListen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      callbacks.set(eventName, callback);
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironmentLifecycleService());

    await waitFor(() => {
      expect(callbacks.has("environment-setup-started")).toBe(true);
      expect(callbacks.has("environment-setup-complete")).toBe(true);
    });

    act(() => {
      callbacks.get("environment-setup-started")?.({
        payload: { environment_id: "env-1", session_id: "setup-1", environment },
      });
    });
    let state = useEnvironmentStore.getState();
    expect(state.isSetupCommandsResolved("env-1")).toBe(true);
    expect(state.isSetupScriptsRunning("env-1")).toBe(true);
    expect(state.isWorkspaceReady("env-1")).toBe(false);

    const completedEnvironment = { ...environment, setupScriptsComplete: true };
    act(() => {
      callbacks.get("environment-setup-complete")?.({
        payload: { environment_id: "env-1", success: true, environment: completedEnvironment },
      });
    });
    state = useEnvironmentStore.getState();
    expect(state.getEnvironmentById("env-1")?.setupScriptsComplete).toBe(true);
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(true);
  });

  test("reconciles a missed setup-completion event from the backend snapshot", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupCommandsResolved: new Set(["env-1"]),
      setupScriptsRunning: new Set(["env-1"]),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue({
      ...environment,
      setupScriptsComplete: true,
    });

    await reconcileEnvironmentSetupSnapshots();

    const state = useEnvironmentStore.getState();
    expect(mockGetEnvironment).toHaveBeenCalledWith("env-1");
    expect(state.getEnvironmentById("env-1")?.setupScriptsComplete).toBe(true);
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(true);
    expect(mockGetEnvironmentSetupSession).not.toHaveBeenCalled();
  });

  test("rehydrates a late background-start failure from the authoritative snapshot", async () => {
    const environment = createMockEnvironment({
      id: "env-late-background-failure",
      projectId: "project-1",
      status: "creating",
      setupScriptsComplete: false,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      pendingSetupCommands: new Map([[environment.id, []]]),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set([environment.id]),
      workspaceReadyEnvironments: new Set([environment.id]),
    });
    mockGetEnvironment.mockResolvedValue({
      ...environment,
      status: "error",
      lifecycleError: "Docker provisioning failed",
    });

    await reconcileEnvironmentSetupSnapshots();

    const state = useEnvironmentStore.getState();
    expect(state.getEnvironmentById(environment.id)).toMatchObject({
      status: "error",
      lifecycleError: "Docker provisioning failed",
    });
    expect(state.pendingSetupCommands.has(environment.id)).toBe(false);
    expect(state.isSetupCommandsResolved(environment.id)).toBe(true);
    expect(state.isSetupScriptsRunning(environment.id)).toBe(false);
    expect(state.isWorkspaceReady(environment.id)).toBe(false);
    expect(state.error).toBe("Docker provisioning failed");
    expect(mockToastError).toHaveBeenCalledTimes(1);
    const toastOptions = mockToastError.mock.calls[0]?.[1] as {
      action?: { onClick?: () => void };
    };
    act(() => {
      toastOptions.action?.onClick?.();
    });
    expect(useErrorDialogStore.getState().error).toMatchObject({
      title: "Failed to start environment",
      message: "Docker provisioning failed",
    });
  });

  test("reports each persisted lifecycle failure once and rearms after it clears", async () => {
    const environment = createMockEnvironment({
      id: "env-repeated-background-failure",
      projectId: "project-1",
      status: "error",
      lifecycleError: "Git worktree creation failed",
    });
    mockGetEnvironmentSnapshots.mockResolvedValue([environment]);
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });
    expect(mockToastError).toHaveBeenCalledTimes(1);

    mockGetEnvironmentSnapshots.mockResolvedValue([
      { ...environment, lifecycleError: null },
    ]);
    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });

    mockGetEnvironmentSnapshots.mockResolvedValue([environment]);
    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });
    expect(mockToastError).toHaveBeenCalledTimes(2);
  });

  test("reports a foreground start failure once when the backend persists it too", async () => {
    const environment = createMockEnvironment({
      id: "env-foreground-start-failure",
      projectId: "project-1",
      status: "stopped",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    mockStartEnvironment.mockRejectedValue(new Error("Docker daemon is not running"));
    // The backend persists its own sanitized wording for the very same failure,
    // and announcing it drives a silent list refetch.
    mockGetEnvironmentSnapshots.mockResolvedValue([
      { ...environment, status: "error", lifecycleError: "Environment start failed." },
    ]);
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await expect(result.current.startEnvironment(environment.id)).rejects.toThrow(
        "Docker daemon is not running",
      );
    });
    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0]?.[0]).toBe("Failed to start environment");

    // A later failure for a different reason is a new thing to say.
    mockGetEnvironmentSnapshots.mockResolvedValue([
      { ...environment, status: "error", lifecycleError: "Git worktree creation failed" },
    ]);
    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });
    expect(mockToastError).toHaveBeenCalledTimes(2);
  });

  test("reports a foreground restart failure once, under the restart title", async () => {
    const environment = createMockEnvironment({
      id: "env-foreground-restart-failure",
      projectId: "project-1",
      status: "running",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    mockStartEnvironment.mockRejectedValue(new Error("container start failed"));
    mockGetEnvironmentSnapshots.mockResolvedValue([
      { ...environment, status: "error", lifecycleError: "Environment start failed." },
    ]);
    const { result } = renderHook(() => useEnvironments(null));

    await act(async () => {
      await expect(result.current.restartEnvironment(environment.id)).rejects.toThrow(
        "container start failed",
      );
    });
    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });

    // One actionable toast for one failure: not "start", "restart" and "start".
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0]?.[0]).toBe("Failed to restart environment");
  });

  test("forgets reported failures for environments that no longer exist", async () => {
    const environment = createMockEnvironment({
      id: "env-pruned-failure",
      projectId: "project-1",
      status: "error",
      lifecycleError: "Git worktree creation failed",
    });
    const refresh = (result: { current: ReturnType<typeof useEnvironments> }) =>
      act(async () => {
        await result.current.loadEnvironments("project-1", {
          silent: true,
          reconcileStatus: false,
        });
      });
    mockGetEnvironmentSnapshots.mockResolvedValue([environment]);
    const { result } = renderHook(() => useEnvironments(null));

    await refresh(result);
    expect(mockToastError).toHaveBeenCalledTimes(1);

    // The report map is module-global and lives for the process lifetime, so a
    // deleted environment must take its entry with it.
    mockGetEnvironmentSnapshots.mockResolvedValue([]);
    await refresh(result);

    mockGetEnvironmentSnapshots.mockResolvedValue([environment]);
    await refresh(result);
    expect(mockToastError).toHaveBeenCalledTimes(2);
  });

  test("clears a stale lifecycle failure from a snapshot that omits the field", async () => {
    const environment = createMockEnvironment({
      id: "env-cleared-lifecycle-error",
      projectId: "project-1",
      status: "error",
      lifecycleError: "Docker provisioning failed",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    // A cleared failure is normalized to undefined, and JSON.stringify drops
    // undefined keys, so the healthy snapshot arrives with the key absent.
    const healthy: Environment = { ...environment, status: "stopped" };
    delete (healthy as { lifecycleError?: string | null }).lifecycleError;
    mockGetEnvironment.mockResolvedValue(healthy);

    await reconcileEnvironmentSetupSnapshots();

    expect(mockGetEnvironment).toHaveBeenCalledWith(environment.id);
    expect(
      useEnvironmentStore.getState().getEnvironmentById(environment.id)?.lifecycleError,
    ).toBeNull();

    // Left stale, the environment would stay a reconciliation target forever.
    mockGetEnvironment.mockClear();
    await reconcileEnvironmentSetupSnapshots();
    expect(mockGetEnvironment).not.toHaveBeenCalled();
  });

  test("targets a failed environment that is neither creating nor running", async () => {
    const environment = createMockEnvironment({
      id: "env-error-status-target",
      projectId: "project-1",
      status: "error",
      lifecycleError: "Environment start failed.",
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue(environment);

    await reconcileEnvironmentSetupSnapshots();

    expect(mockGetEnvironment).toHaveBeenCalledWith(environment.id);
    // A failed start has no setup plan, so nothing reads a setup session.
    expect(mockGetEnvironmentSetupSession).not.toHaveBeenCalled();
    expect(
      useEnvironmentStore.getState().isSetupCommandsResolved(environment.id),
    ).toBe(true);
  });

  test("drops the pending agent launch when a start failure is reconciled", async () => {
    const environment = createMockEnvironment({
      id: "env-failed-launch-intent",
      projectId: "project-1",
      status: "creating",
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({ environments: [environment] });
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        [environment.id]: {
          containerId: null,
          environmentId: environment.id,
          targetPaneId: "default",
          agentType: "claude",
          launchMode: "native",
        } as any,
      },
    });
    mockGetEnvironment.mockResolvedValue({
      ...environment,
      status: "error",
      lifecycleError: "Docker provisioning failed",
    });

    await reconcileEnvironmentSetupSnapshots();

    // A launch that can never happen must not survive, in either store, or it
    // auto-dispatches the original prompt the next time this env is started.
    expect(
      useEnvironmentStore.getState().getEnvironmentById(environment.id)?.pendingAgentLaunch,
    ).toBe(false);
    expect(
      useClaudeOptionsStore.getState().pendingNativeLaunches[environment.id],
    ).toBeUndefined();
  });

  test("reports a lifecycle failure carried by a setup-started event", async () => {
    const environment = createMockEnvironment({
      id: "env-setup-started-failure",
      projectId: "project-1",
      status: "creating",
    });
    useEnvironmentStore.setState({ environments: [environment] });
    const callbacks = new Map<string, (event: { payload: any }) => void>();
    mockListen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      callbacks.set(eventName, callback);
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironmentLifecycleService());
    await waitFor(() => expect(callbacks.has("environment-setup-started")).toBe(true));

    act(() => {
      callbacks.get("environment-setup-started")?.({
        payload: {
          environment_id: environment.id,
          session_id: "setup-1",
          environment: {
            ...environment,
            status: "error",
            lifecycleError: "Docker provisioning failed",
          },
        },
      });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError.mock.calls[0]?.[0]).toBe("Failed to start environment");
    expect(useEnvironmentStore.getState().error).toBe("Docker provisioning failed");
  });

  test("reports a lifecycle failure carried by a setup-complete event", async () => {
    const environment = createMockEnvironment({
      id: "env-setup-complete-failure",
      projectId: "project-1",
      status: "creating",
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      workspaceReadyEnvironments: new Set([environment.id]),
    });
    let completeCallback: ((event: { payload: any }) => void) | undefined;
    mockListen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      if (eventName === "environment-setup-complete") completeCallback = callback;
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironmentLifecycleService());
    await waitFor(() => expect(completeCallback).toBeDefined());

    act(() => {
      completeCallback?.({
        payload: {
          environment_id: environment.id,
          success: false,
          environment: {
            ...environment,
            status: "error",
            lifecycleError: "Docker provisioning failed",
          },
        },
      });
    });

    const state = useEnvironmentStore.getState();
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(state.isSetupCommandsResolved(environment.id)).toBe(true);
    expect(state.isWorkspaceReady(environment.id)).toBe(false);
    expect(state.getEnvironmentById(environment.id)?.pendingAgentLaunch).toBe(false);
  });

  test("does not report a persisted failure until an authoritative read delivers it", async () => {
    const environment = createMockEnvironment({
      id: "env-mount-time-failure",
      projectId: "project-1",
      status: "error",
      lifecycleError: "Environment start failed.",
    });
    // The environment store has no persisted state, so in the real app this
    // array is still empty when the service mounts. Reporting is owned by the
    // reads that deliver environments, not by mounting.
    useEnvironmentStore.setState({ environments: [environment] });
    mockGetEnvironmentSnapshots.mockResolvedValue([environment]);

    const { result } = renderHook(() => {
      useEnvironmentLifecycleService();
      return useEnvironments(null);
    });
    await waitFor(() => expect(mockListen).toHaveBeenCalled());
    expect(mockToastError).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.loadEnvironments("project-1", {
        silent: true,
        reconcileStatus: false,
      });
    });
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  test("does not mark the workspace ready after a failed setup completion event", async () => {
    const environment = createMockEnvironment({ id: "env-1", projectId: "project-1" });
    useEnvironmentStore.setState({ environments: [environment] });
    let completeCallback: ((event: { payload: any }) => void) | undefined;
    mockListen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      if (eventName === "environment-setup-complete") completeCallback = callback;
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironmentLifecycleService());
    await waitFor(() => expect(completeCallback).toBeDefined());

    act(() => {
      completeCallback?.({ payload: { environment_id: "env-1", success: false, error: "setup failed" } });
    });

    const state = useEnvironmentStore.getState();
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(false);
  });

  test("clears the durable agent launch when setup fails", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({ environments: [environment] });
    let completeCallback: ((event: { payload: any }) => void) | undefined;
    mockListen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      if (eventName === "environment-setup-complete") completeCallback = callback;
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironmentLifecycleService());
    await waitFor(() => expect(completeCallback).toBeDefined());

    act(() => {
      completeCallback?.({ payload: { environment_id: "env-1", success: false, error: "setup failed" } });
    });

    // A launch that can never happen must not survive as durable state, or it
    // auto-dispatches the original prompt the next time this env is started.
    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.pendingAgentLaunch).toBe(false);
  });

  test("keeps the durable agent launch when setup succeeds", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({ environments: [environment] });
    let completeCallback: ((event: { payload: any }) => void) | undefined;
    mockListen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      if (eventName === "environment-setup-complete") completeCallback = callback;
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironmentLifecycleService());
    await waitFor(() => expect(completeCallback).toBeDefined());

    act(() => {
      completeCallback?.({ payload: { environment_id: "env-1", success: true } });
    });

    expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.pendingAgentLaunch).toBe(true);
  });

  test("skips reconciliation entirely when no environment is awaiting setup or a launch", async () => {
    useEnvironmentStore.setState({
      environments: [createMockEnvironment({ id: "env-1", projectId: "project-1", status: "running" })],
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });

    await reconcileEnvironmentSetupSnapshots();

    expect(mockGetEnvironment).not.toHaveBeenCalled();
  });

  test("skips a stopped environment that still carries a durable launch", async () => {
    useEnvironmentStore.setState({
      environments: [createMockEnvironment({
        id: "env-1",
        projectId: "project-1",
        status: "stopped",
        pendingAgentLaunch: true,
      })],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });

    await reconcileEnvironmentSetupSnapshots();

    expect(mockGetEnvironment).not.toHaveBeenCalled();
  });

  test("reconciles an environment targeted only by a transient pending native launch", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    useClaudeOptionsStore.setState({
      options: {},
      pendingNativeLaunches: {
        "env-1": {
          containerId: null,
          environmentId: "env-1",
          targetPaneId: "default",
          agentType: "claude",
          launchMode: "native",
        } as any,
      },
    });
    mockGetEnvironment.mockResolvedValue({ ...environment, setupScriptsComplete: true });

    await reconcileEnvironmentSetupSnapshots();

    expect(mockGetEnvironment).toHaveBeenCalledWith("env-1");
    expect(useEnvironmentStore.getState().isWorkspaceReady("env-1")).toBe(true);
  });

  test("reconciles an environment targeted only by running setup scripts", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(["env-1"]),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue({ ...environment, setupScriptsComplete: true });

    await reconcileEnvironmentSetupSnapshots();

    expect(mockGetEnvironment).toHaveBeenCalledWith("env-1");
  });

  test("leaves the store untouched when the snapshot read returns nothing", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue(null);

    await reconcileEnvironmentSetupSnapshots();

    const state = useEnvironmentStore.getState();
    expect(state.isSetupCommandsResolved("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(false);
    expect(mockGetEnvironmentSetupSession).not.toHaveBeenCalled();
  });

  test("survives a rejected snapshot read and stays usable afterwards", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    const originalWarn = console.warn;
    console.warn = mock(() => undefined);
    try {
      mockGetEnvironment.mockRejectedValueOnce(new Error("offline"));
      await reconcileEnvironmentSetupSnapshots();
      expect(console.warn).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }

    // The singleton must have been released, or reconciliation is wedged for the
    // rest of the session.
    mockGetEnvironment.mockResolvedValue({ ...environment, setupScriptsComplete: true });
    await reconcileEnvironmentSetupSnapshots();
    expect(useEnvironmentStore.getState().isWorkspaceReady("env-1")).toBe(true);
  });

  test("marks the workspace ready from a setup session that already succeeded", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue(environment);
    mockGetEnvironmentSetupSession.mockResolvedValue({
      sessionId: "setup-1",
      running: false,
      success: true,
    } as any);

    await reconcileEnvironmentSetupSnapshots();

    const state = useEnvironmentStore.getState();
    expect(state.isSetupCommandsResolved("env-1")).toBe(true);
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(true);
  });

  test("keeps the setup gate closed for a setup session still running", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue(environment);
    mockGetEnvironmentSetupSession.mockResolvedValue({
      sessionId: "setup-1",
      running: true,
    } as any);

    await reconcileEnvironmentSetupSnapshots();

    const state = useEnvironmentStore.getState();
    expect(state.isSetupScriptsRunning("env-1")).toBe(true);
    expect(state.isWorkspaceReady("env-1")).toBe(false);
  });

  test("does not unblock the workspace for a setup session that finished unsuccessfully", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(["env-1"]),
      workspaceReadyEnvironments: new Set(["env-1"]),
    });
    mockGetEnvironment.mockResolvedValue(environment);
    mockGetEnvironmentSetupSession.mockResolvedValue({
      sessionId: "setup-1",
      running: false,
      success: false,
    } as any);

    await reconcileEnvironmentSetupSnapshots();

    const state = useEnvironmentStore.getState();
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(false);
  });

  test("returns without touching gates when no setup session exists", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue(environment);
    mockGetEnvironmentSetupSession.mockResolvedValue(null);

    await reconcileEnvironmentSetupSnapshots();

    expect(useEnvironmentStore.getState().isSetupCommandsResolved("env-1")).toBe(false);
  });

  test("does not let a stale snapshot reopen a locally-completed setup", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: true,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    // An out-of-order response can carry an older view of the flag.
    mockGetEnvironment.mockResolvedValue({ ...environment, setupScriptsComplete: false });

    await reconcileEnvironmentSetupSnapshots();

    const state = useEnvironmentStore.getState();
    expect(state.getEnvironmentById("env-1")?.setupScriptsComplete).toBe(true);
    expect(state.isWorkspaceReady("env-1")).toBe(true);
    expect(mockGetEnvironmentSetupSession).not.toHaveBeenCalled();
  });

  test("reconciles every awaiting environment in one pass", async () => {
    const first = createMockEnvironment({
      id: "env-1", projectId: "project-1", status: "running", pendingAgentLaunch: true,
    });
    const second = createMockEnvironment({
      id: "env-2", projectId: "project-1", status: "running", pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [first, second],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockImplementation((id: string) =>
      Promise.resolve({ ...(id === "env-1" ? first : second), setupScriptsComplete: true })
    );

    await reconcileEnvironmentSetupSnapshots();

    expect(mockGetEnvironment).toHaveBeenCalledWith("env-1");
    expect(mockGetEnvironment).toHaveBeenCalledWith("env-2");
    const state = useEnvironmentStore.getState();
    expect(state.isWorkspaceReady("env-1")).toBe(true);
    expect(state.isWorkspaceReady("env-2")).toBe(true);
  });

  test("coalesces concurrent reconciles but still runs one more pass for the later trigger", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    const firstRead = createDeferred<Environment | null>();
    mockGetEnvironment.mockImplementationOnce(() => firstRead.promise);
    mockGetEnvironment.mockImplementation(() =>
      Promise.resolve({ ...environment, setupScriptsComplete: true })
    );

    const first = reconcileEnvironmentSetupSnapshots();
    const second = reconcileEnvironmentSetupSnapshots();
    // Both callers share the in-flight pass rather than issuing duplicate reads.
    expect(second).toBe(first);
    expect(mockGetEnvironment).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstRead.resolve(environment);
      await first;
      await Promise.resolve();
    });

    // The second trigger arrived after the first pass had already read, so it must
    // be answered by a fresh read rather than the stale snapshot.
    await waitFor(() => {
      expect(mockGetEnvironment).toHaveBeenCalledTimes(2);
      expect(useEnvironmentStore.getState().isWorkspaceReady("env-1")).toBe(true);
    });
  });

  test("reconciles when the gateway stream reconnects and when the page becomes visible", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue({ ...environment, setupScriptsComplete: true });
    const listened: string[] = [];
    let connectedCallback: (() => void) | undefined;
    mockListen.mockImplementation((eventName: string, callback: () => void) => {
      listened.push(eventName);
      if (eventName === "native-event-stream-connected") connectedCallback = callback;
      return Promise.resolve(() => {});
    });

    const { unmount } = renderHook(() => useEnvironmentLifecycleService());
    await waitFor(() => expect(listened).toContain("native-event-stream-connected"));
    expect(connectedCallback).toBeDefined();

    await act(async () => {
      connectedCallback?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetEnvironment).toHaveBeenCalledWith("env-1"));

    // pageshow and online are the mobile-resume signals; visibilitychange only
    // reconciles when the document actually became visible again.
    for (const eventName of ["pageshow", "online"] as const) {
      mockGetEnvironment.mockClear();
      await act(async () => {
        window.dispatchEvent(new Event(eventName));
        await Promise.resolve();
      });
      await waitFor(() => expect(mockGetEnvironment).toHaveBeenCalledWith("env-1"));
    }

    mockGetEnvironment.mockClear();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetEnvironment).toHaveBeenCalledWith("env-1"));

    // After unmount the DOM listeners must be gone.
    await act(async () => {
      await reconcileEnvironmentSetupSnapshots();
    });
    unmount();
    mockGetEnvironment.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(mockGetEnvironment).not.toHaveBeenCalled();
  });

  test("does not reconcile when the document is being hidden", async () => {
    const environment = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      status: "running",
      setupScriptsComplete: false,
      pendingAgentLaunch: true,
    });
    useEnvironmentStore.setState({
      environments: [environment],
      setupScriptsRunning: new Set(),
      workspaceReadyEnvironments: new Set(),
    });
    mockGetEnvironment.mockResolvedValue({ ...environment, setupScriptsComplete: true });
    mockListen.mockImplementation(() => Promise.resolve(() => {}));

    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      renderHook(() => useEnvironmentLifecycleService());
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
      // Backgrounding is not a resume signal; reading snapshots there would burn
      // requests on a page that is about to be suspended.
      expect(mockGetEnvironment).not.toHaveBeenCalled();
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (visibility) Object.defineProperty(Document.prototype, "visibilityState", visibility);
    }
  });

  test("can disable rename events while keeping setup lifecycle listeners", async () => {
    const eventNames: string[] = [];
    mockListen.mockImplementation((eventName: string) => {
      eventNames.push(eventName);
      return Promise.resolve(() => {});
    });
    // Setup lifecycle listeners are registered once by the app-root service
    // hook; useEnvironments only owns the optional rename listener.
    renderHook(() => {
      useEnvironmentLifecycleService();
      useEnvironments(null, { listenForRenameEvents: false });
    });

    await waitFor(() => expect(eventNames).toContain("environment-setup-complete"));
    expect(eventNames).not.toContain("environment-renamed");
  });

  test("disposes listeners that finish registering after unmount", async () => {
    const resolvers: Array<(unlisten: () => void) => void> = [];
    const unlisteners = [
      mock(() => {}),
      mock(() => {}),
      mock(() => {}),
      mock(() => {}),
    ];
    mockListen.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const { unmount } = renderHook(() => {
      useEnvironmentLifecycleService();
      useEnvironments(null);
    });
    await waitFor(() => expect(resolvers).toHaveLength(3));

    unmount();
    await act(async () => {
      resolvers[0]?.(unlisteners[0]!);
      resolvers[1]?.(unlisteners[1]!);
      resolvers[2]?.(unlisteners[2]!);
      await Promise.resolve();
      resolvers[3]?.(unlisteners[3]!);
      await Promise.resolve();
    });

    expect(unlisteners[0]).toHaveBeenCalledTimes(1);
    expect(unlisteners[1]).toHaveBeenCalledTimes(1);
    expect(unlisteners[2]).toHaveBeenCalledTimes(1);
    expect(unlisteners[3]).toHaveBeenCalledTimes(1);
  });

  // --- environment-renamed event listener tests ---

  test("environment-renamed event updates name and branch in store", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "old-name",
      branch: "old-name",
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    // Capture the listener callback when listen is called
    let capturedCallback: ((event: unknown) => void) | null = null;
    mockListen.mockImplementation((eventName: string, cb: (event: unknown) => void) => {
      if (eventName === "environment-renamed") {
        capturedCallback = cb;
      }
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // The listener should have been registered
    expect(capturedCallback).not.toBeNull();

    // Fire the event
    act(() => {
      capturedCallback!({
        payload: {
          environment_id: "env-1",
          new_name: "new-name",
          new_branch: "new-name",
        },
      });
    });

    // The store should be updated
    const updated = result.current.allEnvironments.find((e) => e.id === "env-1");
    expect(updated?.name).toBe("new-name");
    expect(updated?.branch).toBe("new-name");
  });

  test("environment-renamed event clears PR state when branch changes", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "old-name",
      branch: "old-branch",
      prUrl: "https://github.com/test/repo/pull/42",
      prState: "open" as Environment["prState"],
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    let capturedCallback: ((event: unknown) => void) | null = null;
    mockListen.mockImplementation((eventName: string, cb: (event: unknown) => void) => {
      if (eventName === "environment-renamed") {
        capturedCallback = cb;
      }
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(capturedCallback).not.toBeNull();

    // Fire renamed event with a different branch
    act(() => {
      capturedCallback!({
        payload: {
          environment_id: "env-1",
          new_name: "new-name",
          new_branch: "new-branch",
        },
      });
    });

    // PR state should be cleared
    const updated = result.current.allEnvironments.find((e) => e.id === "env-1");
    expect(updated?.prUrl).toBeNull();
    expect(updated?.prState).toBeNull();

    // clearEnvironmentPr should have been called
    expect(mockClearEnvironmentPr).toHaveBeenCalledWith("env-1");
  });

  test("environment-renamed event does not clear PR state when branch unchanged", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "old-name",
      branch: "same-branch",
      prUrl: "https://github.com/test/repo/pull/42",
      prState: "open" as Environment["prState"],
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    let capturedCallback: ((event: unknown) => void) | null = null;
    mockListen.mockImplementation((eventName: string, cb: (event: unknown) => void) => {
      if (eventName === "environment-renamed") {
        capturedCallback = cb;
      }
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Fire renamed event with the same branch (only name changed)
    act(() => {
      capturedCallback!({
        payload: {
          environment_id: "env-1",
          new_name: "new-name",
          new_branch: "same-branch",
        },
      });
    });

    // PR state should be preserved
    const updated = result.current.allEnvironments.find((e) => e.id === "env-1");
    expect(updated?.prUrl).toBe("https://github.com/test/repo/pull/42");
    expect(updated?.prState).toBe("open");

    // clearEnvironmentPr should NOT have been called
    expect(mockClearEnvironmentPr).not.toHaveBeenCalled();
  });

  test("environment-renamed event does not clear PR state when no existing PR", async () => {
    const existingEnv = createMockEnvironment({
      id: "env-1",
      projectId: "project-1",
      name: "old-name",
      branch: "old-branch",
      prUrl: null,
      prState: null,
    });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    let capturedCallback: ((event: unknown) => void) | null = null;
    mockListen.mockImplementation((eventName: string, cb: (event: unknown) => void) => {
      if (eventName === "environment-renamed") {
        capturedCallback = cb;
      }
      return Promise.resolve(() => {});
    });

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Fire renamed event with a different branch but no existing PR
    act(() => {
      capturedCallback!({
        payload: {
          environment_id: "env-1",
          new_name: "new-name",
          new_branch: "new-branch",
        },
      });
    });

    // clearEnvironmentPr should NOT have been called (no PR to clear)
    expect(mockClearEnvironmentPr).not.toHaveBeenCalled();
  });
});
