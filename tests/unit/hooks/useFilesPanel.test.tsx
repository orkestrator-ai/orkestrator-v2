import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { useConfigStore } from "../../../apps/web/src/stores/configStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import { useFilesPanelStore } from "../../../apps/web/src/stores/filesPanelStore";
import { useUIStore } from "../../../apps/web/src/stores/uiStore";
import type { FileNode, GitFileChange } from "../../../apps/web/src/lib/backend";
import type { Environment, RepositoryConfig } from "../../../apps/web/src/types";
import { createMockEnvironment } from "../utils/testFactories";

const realBackendSnapshot = { ...realBackend };
const realConsoleError = console.error;

const mockGetGitStatus = mock<(containerId: string, targetBranch?: string) => Promise<GitFileChange[]>>(
  () => Promise.resolve([]),
);
const mockGetLocalGitStatus = mock<(worktreePath: string, targetBranch?: string) => Promise<GitFileChange[]>>(
  () => Promise.resolve([]),
);
const mockGetFileTree = mock<(containerId: string) => Promise<FileNode[]>>(() => Promise.resolve([]));
const mockGetLocalFileTree = mock<(worktreePath: string) => Promise<FileNode[]>>(() => Promise.resolve([]));
const mockRevertContainerFile = mock<(environmentId: string, filePath: string, targetBranch: string) => Promise<string>>(
  (_environmentId, filePath) => Promise.resolve(filePath),
);
const mockDeleteContainerFile = mock<(environmentId: string, filePath: string) => Promise<string>>(
  (_environmentId, filePath) => Promise.resolve(filePath),
);
const mockRevertLocalFile = mock<(environmentId: string, filePath: string, targetBranch: string) => Promise<string>>(
  (_environmentId, filePath) => Promise.resolve(filePath),
);
const mockDeleteLocalFile = mock<(environmentId: string, filePath: string) => Promise<string>>(
  (_environmentId, filePath) => Promise.resolve(filePath),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getGitStatus: mockGetGitStatus,
  getLocalGitStatus: mockGetLocalGitStatus,
  getFileTree: mockGetFileTree,
  getLocalFileTree: mockGetLocalFileTree,
  revertContainerFile: mockRevertContainerFile,
  deleteContainerFile: mockDeleteContainerFile,
  revertLocalFile: mockRevertLocalFile,
  deleteLocalFile: mockDeleteLocalFile,
}));

const { useFilesPanel } = await import("../../../apps/web/src/hooks/useFilesPanel");

const change: GitFileChange = {
  path: "src/App.tsx",
  filename: "App.tsx",
  directory: "src",
  status: "M",
  additions: 5,
  deletions: 2,
};

const tree: FileNode[] = [
  {
    name: "src",
    path: "src",
    isDirectory: true,
    children: [{ name: "App.tsx", path: "src/App.tsx", isDirectory: false }],
  },
];

function resetStores(
  environment: Environment | null = null,
  repositoryConfig: RepositoryConfig | null = environment
    ? {
        defaultBranch: "main",
        prBaseBranch: "develop",
      }
    : null,
) {
  useEnvironmentStore.setState({
    environments: environment ? [environment] : [],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set(),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
    sessionActivated: new Set(),
  });

  useUIStore.setState({
    selectedProjectId: environment?.projectId ?? null,
    selectedEnvironmentId: environment?.id ?? null,
    selectedEnvironmentIds: [],
  });

  useFilesPanelStore.setState({
    isOpen: false,
    activeTab: "changes",
    changes: [],
    isLoadingChanges: false,
    fileTree: [],
    isLoadingTree: false,
    targetBranch: "main",
  });

  useConfigStore.setState({
    config: {
      version: "1.0",
      global: {
        containerResources: { cpuCores: 2, memoryGb: 4 },
        envFilePatterns: [".env.local", ".env"],
        allowedDomains: [],
        defaultAgent: "claude",
        opencodeModel: "opencode/grok-code",
        codexModel: "gpt-5.3-codex",
        codexReasoningEffort: "medium",
        opencodeMode: "terminal",
        claudeMode: "terminal",
        claudeNativeBackend: "sdk",
        claudeNativeFastModeDefault: false,
        codexMode: "native",
        codexNativeFastModeDefault: false,
        experimentalCodexRawEventLogging: true,
      },
      repositories: environment && repositoryConfig
        ? {
            [environment.projectId]: repositoryConfig,
          }
        : {},
    },
    isLoading: false,
    error: null,
  });
}

describe("useFilesPanel", () => {
  beforeEach(() => {
    console.error = mock(() => {}) as typeof console.error;
    mockGetGitStatus.mockClear();
    mockGetLocalGitStatus.mockClear();
    mockGetFileTree.mockClear();
    mockGetLocalFileTree.mockClear();
    mockRevertContainerFile.mockClear();
    mockDeleteContainerFile.mockClear();
    mockRevertLocalFile.mockClear();
    mockDeleteLocalFile.mockClear();
    mockGetGitStatus.mockImplementation(() => Promise.resolve([]));
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([]));
    mockGetFileTree.mockImplementation(() => Promise.resolve([]));
    mockGetLocalFileTree.mockImplementation(() => Promise.resolve([]));
    mockRevertContainerFile.mockImplementation((_environmentId, filePath) => Promise.resolve(filePath));
    mockDeleteContainerFile.mockImplementation((_environmentId, filePath) => Promise.resolve(filePath));
    mockRevertLocalFile.mockImplementation((_environmentId, filePath) => Promise.resolve(filePath));
    mockDeleteLocalFile.mockImplementation((_environmentId, filePath) => Promise.resolve(filePath));
  });

  afterEach(() => {
    console.error = realConsoleError;
    cleanup();
    resetStores();
  });

  afterAll(() => {
    mock.module("@/lib/backend", () => realBackendSnapshot);
  });

  test("loads local changes against the repository PR base branch when the panel opens", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores(environment);
    useFilesPanelStore.setState({ isOpen: true, activeTab: "changes" });
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([change]));

    renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "develop");
      expect(useFilesPanelStore.getState().changes).toEqual([change]);
    });

    expect(mockGetGitStatus).not.toHaveBeenCalled();
    expect(useFilesPanelStore.getState().targetBranch).toBe("develop");
    expect(useFilesPanelStore.getState().isLoadingChanges).toBe(false);
  });

  test("loads local changes against the environment creation commit when available", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
      createdFromCommit: "abc123def456",
    });
    resetStores(environment);
    useFilesPanelStore.setState({ isOpen: true, activeTab: "changes" });
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([change]));

    renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "abc123def456");
      expect(useFilesPanelStore.getState().targetBranch).toBe("abc123def456");
    });
  });

  test("loads container file tree only when a container environment is running", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    useFilesPanelStore.setState({ isOpen: true, activeTab: "all-files" });
    mockGetFileTree.mockImplementation(() => Promise.resolve(tree));
    mockGetGitStatus.mockImplementation(() => Promise.resolve([change]));

    const { result } = renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetFileTree).toHaveBeenCalledWith("container-1");
      expect(useFilesPanelStore.getState().fileTree).toEqual(tree);
      expect(mockGetGitStatus).toHaveBeenCalledWith("container-1", "develop");
      expect(useFilesPanelStore.getState().changes).toEqual([change]);
    });

    expect(result.current.isAvailable).toBe(true);
    expect(mockGetLocalFileTree).not.toHaveBeenCalled();
    expect(useFilesPanelStore.getState().isLoadingTree).toBe(false);
  });

  test("loads container changes against the repository PR base branch", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    useFilesPanelStore.setState({ isOpen: true, activeTab: "changes" });
    mockGetGitStatus.mockImplementation(() => Promise.resolve([change]));

    renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetGitStatus).toHaveBeenCalledWith("container-1", "develop");
      expect(useFilesPanelStore.getState().changes).toEqual([change]);
    });

    expect(mockGetLocalGitStatus).not.toHaveBeenCalled();
    expect(useFilesPanelStore.getState().isLoadingChanges).toBe(false);
  });

  test("loads container changes against the environment creation commit when available", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
      createdFromCommit: "abc123def456",
    });
    resetStores(environment);
    useFilesPanelStore.setState({ isOpen: true, activeTab: "changes" });
    mockGetGitStatus.mockImplementation(() => Promise.resolve([change]));

    renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetGitStatus).toHaveBeenCalledWith("container-1", "abc123def456");
      expect(useFilesPanelStore.getState().changes).toEqual([change]);
    });
  });

  test("loads local file tree for available local environments", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores(environment);
    useFilesPanelStore.setState({ isOpen: true, activeTab: "all-files" });
    mockGetLocalFileTree.mockImplementation(() => Promise.resolve(tree));

    const { result } = renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetLocalFileTree).toHaveBeenCalledWith("/tmp/worktree");
      expect(useFilesPanelStore.getState().fileTree).toEqual(tree);
    });

    expect(result.current.isLocalEnvironment).toBe(true);
    expect(mockGetFileTree).not.toHaveBeenCalled();
    expect(useFilesPanelStore.getState().isLoadingTree).toBe(false);
  });

  test("falls back to main when repository config has no PR base branch", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores(environment, { defaultBranch: "main" });
    useFilesPanelStore.setState({ isOpen: true, activeTab: "changes" });
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([change]));

    renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "main");
      expect(useFilesPanelStore.getState().targetBranch).toBe("main");
    });
  });

  test("clears stale panel data when the selected environment is unavailable", () => {
    const environment = createMockEnvironment({
      id: "env-stopped",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "stopped",
    });
    resetStores(environment);
    useFilesPanelStore.setState({
      isOpen: true,
      activeTab: "changes",
      changes: [change],
      fileTree: tree,
    });

    const { result } = renderHook(() => useFilesPanel());

    expect(result.current.isAvailable).toBe(false);
    expect(useFilesPanelStore.getState().changes).toEqual([]);
    expect(useFilesPanelStore.getState().fileTree).toEqual([]);
    expect(mockGetGitStatus).not.toHaveBeenCalled();
    expect(mockGetFileTree).not.toHaveBeenCalled();
  });

  test("manual loads clear their snapshots without calling the backend when unavailable", async () => {
    resetStores();
    useFilesPanelStore.setState({ changes: [change], fileTree: tree });
    const { result } = renderHook(() => useFilesPanel());

    await act(async () => {
      await Promise.all([result.current.loadChanges(), result.current.loadFileTree()]);
    });

    expect(useFilesPanelStore.getState().changes).toEqual([]);
    expect(useFilesPanelStore.getState().fileTree).toEqual([]);
    expect(mockGetGitStatus).not.toHaveBeenCalled();
    expect(mockGetFileTree).not.toHaveBeenCalled();
  });

  test("prevents overlapping manual changes loads for the same selected environment", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);

    let resolveChanges: (changes: GitFileChange[]) => void = () => {};
    mockGetGitStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChanges = resolve;
        }),
    );

    const { result } = renderHook(() => useFilesPanel());

    let firstLoad: Promise<void>;
    let secondLoad: Promise<void>;
    act(() => {
      firstLoad = result.current.loadChanges();
      secondLoad = result.current.loadChanges();
    });

    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);
    expect(useFilesPanelStore.getState().isLoadingChanges).toBe(true);

    await act(async () => {
      resolveChanges([change]);
      await Promise.all([firstLoad, secondLoad]);
    });

    expect(useFilesPanelStore.getState().changes).toEqual([change]);
    expect(useFilesPanelStore.getState().isLoadingChanges).toBe(false);
  });

  test("prevents overlapping manual tree loads for the same selected environment", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    let resolveTree: (nodes: FileNode[]) => void = () => {};
    mockGetFileTree.mockImplementation(() => new Promise((resolve) => {
      resolveTree = resolve;
    }));
    const { result } = renderHook(() => useFilesPanel());

    let firstLoad: Promise<void>;
    let secondLoad: Promise<void>;
    act(() => {
      firstLoad = result.current.loadFileTree();
      secondLoad = result.current.loadFileTree();
    });

    expect(mockGetFileTree).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveTree(tree);
      await Promise.all([firstLoad, secondLoad]);
    });
    expect(useFilesPanelStore.getState().fileTree).toEqual(tree);
    expect(useFilesPanelStore.getState().isLoadingTree).toBe(false);
  });

  test("manual changes load failure clears stale changes and resets loading", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    mockGetGitStatus.mockImplementation(() => Promise.reject(new Error("git failed")));

    const { result } = renderHook(() => useFilesPanel());
    act(() => useFilesPanelStore.setState({ changes: [change] }));

    await act(async () => {
      await result.current.loadChanges();
    });

    expect(useFilesPanelStore.getState().changes).toEqual([]);
    expect(useFilesPanelStore.getState().isLoadingChanges).toBe(false);
  });

  test("silent changes load failure preserves existing changes and avoids loading indicator", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    mockGetGitStatus.mockImplementation(() => Promise.reject(new Error("git failed")));

    const { result } = renderHook(() => useFilesPanel());
    act(() => useFilesPanelStore.setState({ changes: [change] }));

    await act(async () => {
      await result.current.loadChanges(true);
    });

    expect(useFilesPanelStore.getState().changes).toEqual([change]);
    expect(useFilesPanelStore.getState().isLoadingChanges).toBe(false);
  });

  test("manual file tree load failure clears stale tree and resets loading", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores(environment);
    mockGetLocalFileTree.mockImplementation(() => Promise.reject(new Error("tree failed")));

    const { result } = renderHook(() => useFilesPanel());
    act(() => useFilesPanelStore.setState({ fileTree: tree }));

    await act(async () => {
      await result.current.loadFileTree();
    });

    expect(useFilesPanelStore.getState().fileTree).toEqual([]);
    expect(useFilesPanelStore.getState().isLoadingTree).toBe(false);
  });

  test("silent file tree load failure preserves the existing tree", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores(environment);
    mockGetLocalFileTree.mockImplementation(() => Promise.reject(new Error("tree failed")));

    const { result } = renderHook(() => useFilesPanel());
    act(() => useFilesPanelStore.setState({ fileTree: tree }));

    await act(async () => {
      await result.current.loadFileTree(true);
    });

    expect(useFilesPanelStore.getState().fileTree).toEqual(tree);
    expect(useFilesPanelStore.getState().isLoadingTree).toBe(false);
  });

  test("ignores stale snapshots and starts fresh loads after switching environments", async () => {
    const firstEnvironment = createMockEnvironment({
      id: "env-a",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-a",
      status: "running",
    });
    const secondEnvironment = createMockEnvironment({
      id: "env-b",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-b",
      status: "running",
    });
    const secondChange = { ...change, path: "src/Second.tsx", filename: "Second.tsx" };
    const secondTree: FileNode[] = [{ name: "Second.tsx", path: "src/Second.tsx", isDirectory: false }];
    let resolveFirstChanges: (changes: GitFileChange[]) => void = () => {};
    let resolveFirstTree: (tree: FileNode[]) => void = () => {};

    resetStores(firstEnvironment);
    useEnvironmentStore.setState({ environments: [firstEnvironment, secondEnvironment] });
    useFilesPanelStore.setState({ isOpen: true, activeTab: "all-files" });
    mockGetGitStatus.mockImplementation((containerId) => containerId === "container-a"
      ? new Promise((resolve) => { resolveFirstChanges = resolve; })
      : Promise.resolve([secondChange]));
    mockGetFileTree.mockImplementation((containerId) => containerId === "container-a"
      ? new Promise((resolve) => { resolveFirstTree = resolve; })
      : Promise.resolve(secondTree));

    const { result } = renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetGitStatus).toHaveBeenCalledWith("container-a", "develop");
      expect(mockGetFileTree).toHaveBeenCalledWith("container-a");
    });

    act(() => {
      useUIStore.setState({ selectedEnvironmentId: "env-b" });
    });

    await waitFor(() => {
      expect(mockGetGitStatus).toHaveBeenCalledWith("container-b", "develop");
      expect(mockGetFileTree).toHaveBeenCalledWith("container-b");
      expect(useFilesPanelStore.getState().changes).toEqual([secondChange]);
      expect(useFilesPanelStore.getState().fileTree).toEqual(secondTree);
      expect(result.current.environmentId).toBe("env-b");
    });

    await act(async () => {
      resolveFirstChanges([change]);
      resolveFirstTree(tree);
      await Promise.resolve();
    });

    expect(useFilesPanelStore.getState().changes).toEqual([secondChange]);
    expect(useFilesPanelStore.getState().fileTree).toEqual(secondTree);
  });

  test("reverts local files against the comparison ref and refreshes both snapshots", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
      createdFromCommit: "abc123def456",
    });
    resetStores(environment);
    const { result } = renderHook(() => useFilesPanel());

    await act(async () => {
      await result.current.revertFile("src/App.tsx");
    });

    expect(mockRevertLocalFile).toHaveBeenCalledWith(
      "env-local",
      "src/App.tsx",
      "abc123def456",
    );
    expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "abc123def456");
    expect(mockGetLocalFileTree).toHaveBeenCalledWith("/tmp/worktree");
    expect(result.current.fileActionPending).toBeNull();
  });

  test("deletes container files and refreshes both snapshots", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    const { result } = renderHook(() => useFilesPanel());

    await act(async () => {
      await result.current.deleteFile("src/App.tsx");
    });

    expect(mockDeleteContainerFile).toHaveBeenCalledWith("env-container", "src/App.tsx");
    expect(mockGetGitStatus).toHaveBeenCalledWith("container-1", "develop");
    expect(mockGetFileTree).toHaveBeenCalledWith("container-1");
    expect(result.current.fileActionPending).toBeNull();
  });

  test("routes the other mutation variants through the selected environment", async () => {
    const containerEnvironment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(containerEnvironment);
    const { result, unmount } = renderHook(() => useFilesPanel());

    await act(async () => {
      await result.current.revertFile("src/App.tsx");
    });
    expect(mockRevertContainerFile).toHaveBeenCalledWith("env-container", "src/App.tsx", "develop");
    unmount();

    const localEnvironment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores(localEnvironment);
    const localHook = renderHook(() => useFilesPanel());
    await act(async () => {
      await localHook.result.current.deleteFile("src/App.tsx");
    });
    expect(mockDeleteLocalFile).toHaveBeenCalledWith("env-local", "src/App.tsx");
  });

  test("keeps pending state while a mutation runs and clears it after failure", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    let rejectDelete: (error: Error) => void = () => {};
    mockDeleteContainerFile.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectDelete = reject;
    }));
    const { result } = renderHook(() => useFilesPanel());

    let mutation: Promise<void>;
    act(() => {
      mutation = result.current.deleteFile("src/App.tsx");
    });
    await waitFor(() => expect(result.current.fileActionPending).toBe("src/App.tsx"));

    await act(async () => {
      rejectDelete(new Error("delete failed"));
      await expect(mutation).rejects.toThrow("delete failed");
    });

    expect(result.current.fileActionPending).toBeNull();
    expect(mockGetGitStatus).not.toHaveBeenCalled();
    expect(mockGetFileTree).not.toHaveBeenCalled();
  });

  test("reports revert failures without refreshing stale snapshots", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores(environment);
    mockRevertLocalFile.mockRejectedValue(new Error("revert failed"));
    const { result } = renderHook(() => useFilesPanel());

    await act(async () => {
      await expect(result.current.revertFile("src/App.tsx")).rejects.toThrow("revert failed");
    });

    expect(result.current.fileActionPending).toBeNull();
    expect(mockGetLocalGitStatus).not.toHaveBeenCalled();
    expect(mockGetLocalFileTree).not.toHaveBeenCalled();
  });

  test("rejects mutations when the selected environment is unavailable", async () => {
    resetStores();
    const { result } = renderHook(() => useFilesPanel());

    await expect(result.current.revertFile("src/App.tsx")).rejects.toThrow(
      "The selected environment is not available",
    );
    await expect(result.current.deleteFile("src/App.tsx")).rejects.toThrow(
      "The selected environment is not available",
    );
    expect(mockRevertContainerFile).not.toHaveBeenCalled();
    expect(mockDeleteContainerFile).not.toHaveBeenCalled();
  });

  test("silent auto-refresh reloads the active tab without toggling loading state", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let intervalCallback: (() => void) | null = null;
    const clearIntervalMock = mock(() => {});

    globalThis.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 5000) {
        intervalCallback = callback as () => void;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }
      return originalSetInterval(callback, timeout, ...args);
    }) as typeof setInterval;
    globalThis.clearInterval = ((intervalId: Parameters<typeof clearInterval>[0]) => {
      if (intervalId === (1 as unknown as Parameters<typeof clearInterval>[0])) {
        clearIntervalMock(intervalId);
        return;
      }
      originalClearInterval(intervalId);
    }) as typeof clearInterval;

    try {
      const environment = createMockEnvironment({
        id: "env-container",
        projectId: "project-1",
        environmentType: "containerized",
        containerId: "container-1",
        status: "running",
      });
      resetStores(environment);
      useFilesPanelStore.setState({ isOpen: true, activeTab: "changes" });
      mockGetGitStatus.mockImplementationOnce(() => Promise.resolve([])).mockImplementationOnce(() => Promise.resolve([change]));

      const { unmount } = renderHook(() => useFilesPanel());

      await waitFor(() => {
        expect(mockGetGitStatus).toHaveBeenCalledTimes(1);
      });
      expect(intervalCallback).not.toBeNull();

      await act(async () => {
        intervalCallback?.();
      });

      await waitFor(() => {
        expect(mockGetGitStatus).toHaveBeenCalledTimes(2);
        expect(useFilesPanelStore.getState().changes).toEqual([change]);
      });
      expect(useFilesPanelStore.getState().isLoadingChanges).toBe(false);

      unmount();
      expect(clearIntervalMock).toHaveBeenCalledWith(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
