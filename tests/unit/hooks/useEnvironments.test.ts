import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConfigStore } from "../../../apps/web/src/stores/configStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import { useUIStore } from "../../../apps/web/src/stores/uiStore";
import type { Environment, EnvironmentType, NetworkAccessMode, PortMapping, StartEnvironmentResult } from "../../../apps/web/src/types";
import { createMockEnvironment } from "../utils/testFactories";

// Mock backend module BEFORE importing the hook
const mockGetEnvironments = mock<(projectId: string) => Promise<Environment[]>>(() => Promise.resolve([]));
const mockGetEnvironmentSnapshots = mock<(projectId: string) => Promise<Environment[]>>(() => Promise.resolve([]));
const mockGetEnvironment = mock<(environmentId: string) => Promise<Environment | null>>(() => Promise.resolve(null));
const mockCreateEnvironment = mock<(
  projectId: string,
  name?: string,
  networkAccessMode?: NetworkAccessMode,
  initialPrompt?: string,
  portMappings?: PortMapping[],
  environmentType?: EnvironmentType,
  namingPrompt?: string,
) => Promise<Environment>>((projectId) =>
  Promise.resolve(createMockEnvironment({ id: "new-env-id", projectId, name: "test-env" }))
);
const mockDeleteEnvironment = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());
const mockStartEnvironment = mock<(environmentId: string) => Promise<StartEnvironmentResult>>(() => Promise.resolve({ setupCommands: undefined }));
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
  createEnvironment: mockCreateEnvironment,
  deleteEnvironment: mockDeleteEnvironment,
  startEnvironment: mockStartEnvironment,
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
import { useEnvironments } from "../../../apps/web/src/hooks/useEnvironments";

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
    mockCreateEnvironment.mockClear();
    mockDeleteEnvironment.mockClear();
    mockStartEnvironment.mockClear();
    mockStopEnvironment.mockClear();
    mockSyncEnvironmentStatus.mockClear();
    mockReorderEnvironments.mockClear();
    mockUpdatePortMappings.mockClear();
    mockClearEnvironmentPr.mockClear();
    mockListen.mockClear();

    // Reset to default implementations
    mockGetEnvironments.mockImplementation(() => Promise.resolve([]));
    mockGetEnvironmentSnapshots.mockImplementation(() => Promise.resolve([]));
    mockGetEnvironment.mockImplementation(() => Promise.resolve(null));
    mockCreateEnvironment.mockImplementation((projectId) =>
      Promise.resolve(createMockEnvironment({ id: "new-env-id", projectId, name: "test-env" }))
    );
    mockDeleteEnvironment.mockImplementation(() => Promise.resolve());
    mockStartEnvironment.mockImplementation(() => Promise.resolve({ setupCommands: undefined }));
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
  });

  test("deleteEnvironment prunes the deleted environment's unread activity marker", async () => {
    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env" });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });
    useUIStore.setState({ unreadEnvironmentIds: ["env-1", "env-keep"] });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.deleteEnvironment("env-1");
    });

    expect(useUIStore.getState().unreadEnvironmentIds).toEqual(["env-keep"]);
  });

  test("deleteEnvironment keeps the unread marker when the backend delete fails", async () => {
    mockDeleteEnvironment.mockImplementation(() => Promise.reject(new Error("Failed to delete")));

    const existingEnv = createMockEnvironment({ id: "env-1", projectId: "project-1", name: "test-env" });

    useEnvironmentStore.setState({
      environments: [existingEnv],
      isLoading: false,
      error: null,
    });
    useUIStore.setState({ unreadEnvironmentIds: ["env-1"] });

    mockGetEnvironments.mockImplementation(() => Promise.resolve([existingEnv]));

    const { result } = renderHook(() => useEnvironments("project-1"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await expect(result.current.deleteEnvironment("env-1")).rejects.toThrow("Failed to delete");
    });

    expect(useUIStore.getState().unreadEnvironmentIds).toEqual(["env-1"]);
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
    renderHook(() => useEnvironments(null));

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

  test("does not mark the workspace ready after a failed setup completion event", async () => {
    const environment = createMockEnvironment({ id: "env-1", projectId: "project-1" });
    useEnvironmentStore.setState({ environments: [environment] });
    let completeCallback: ((event: { payload: any }) => void) | undefined;
    mockListen.mockImplementation((eventName: string, callback: (event: { payload: any }) => void) => {
      if (eventName === "environment-setup-complete") completeCallback = callback;
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironments(null));
    await waitFor(() => expect(completeCallback).toBeDefined());

    act(() => {
      completeCallback?.({ payload: { environment_id: "env-1", success: false, error: "setup failed" } });
    });

    const state = useEnvironmentStore.getState();
    expect(state.isSetupScriptsRunning("env-1")).toBe(false);
    expect(state.isWorkspaceReady("env-1")).toBe(false);
  });

  test("can disable rename events while keeping setup lifecycle listeners", async () => {
    const eventNames: string[] = [];
    mockListen.mockImplementation((eventName: string) => {
      eventNames.push(eventName);
      return Promise.resolve(() => {});
    });
    renderHook(() => useEnvironments(null, { listenForRenameEvents: false }));

    await waitFor(() => expect(eventNames).toContain("environment-setup-complete"));
    expect(eventNames).not.toContain("environment-renamed");
  });

  test("disposes listeners that finish registering after unmount", async () => {
    const resolvers: Array<(unlisten: () => void) => void> = [];
    const unlisteners = [mock(() => {}), mock(() => {}), mock(() => {})];
    mockListen.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const { unmount } = renderHook(() => useEnvironments(null));
    await waitFor(() => expect(resolvers).toHaveLength(2));

    unmount();
    await act(async () => {
      resolvers[0]?.(unlisteners[0]!);
      resolvers[1]?.(unlisteners[1]!);
      await Promise.resolve();
      resolvers[2]?.(unlisteners[2]!);
      await Promise.resolve();
    });

    expect(unlisteners[0]).toHaveBeenCalledTimes(1);
    expect(unlisteners[1]).toHaveBeenCalledTimes(1);
    expect(unlisteners[2]).toHaveBeenCalledTimes(1);
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
