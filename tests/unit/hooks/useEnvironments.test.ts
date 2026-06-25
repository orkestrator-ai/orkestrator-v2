import { describe, test, expect, beforeEach, mock } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useConfigStore } from "../../../src/stores/configStore";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";
import type { Environment, EnvironmentType, NetworkAccessMode, PortMapping, StartEnvironmentResult } from "../../../src/types";
import { createMockEnvironment } from "../utils/testFactories";

// Mock backend module BEFORE importing the hook
const mockGetEnvironments = mock<(projectId: string) => Promise<Environment[]>>(() => Promise.resolve([]));
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
const mockClearEnvironmentPr = mock<(environmentId: string) => Promise<void>>(() => Promise.resolve());

mock.module("@/lib/backend", () => ({
  getEnvironments: mockGetEnvironments,
  getEnvironment: mockGetEnvironment,
  createEnvironment: mockCreateEnvironment,
  deleteEnvironment: mockDeleteEnvironment,
  startEnvironment: mockStartEnvironment,
  stopEnvironment: mockStopEnvironment,
  syncEnvironmentStatus: mockSyncEnvironmentStatus,
  clearEnvironmentPr: mockClearEnvironmentPr,
}));

// Capture the event listener callback registered via listen()
import { listen } from "@/lib/native/events";
const mockListen = listen as ReturnType<typeof mock>;

// Import hook AFTER mocking
import { useEnvironments } from "../../../src/hooks/useEnvironments";

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
    mockGetEnvironment.mockClear();
    mockCreateEnvironment.mockClear();
    mockDeleteEnvironment.mockClear();
    mockStartEnvironment.mockClear();
    mockStopEnvironment.mockClear();
    mockSyncEnvironmentStatus.mockClear();
    mockClearEnvironmentPr.mockClear();
    mockListen.mockClear();

    // Reset to default implementations
    mockGetEnvironments.mockImplementation(() => Promise.resolve([]));
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
