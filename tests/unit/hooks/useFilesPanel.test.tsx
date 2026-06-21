import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { useConfigStore } from "../../../src/stores/configStore";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";
import { useFilesPanelStore } from "../../../src/stores/filesPanelStore";
import { useUIStore } from "../../../src/stores/uiStore";
import type { FileNode, GitFileChange } from "../../../src/lib/backend";
import type { Environment, RepositoryConfig } from "../../../src/types";
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

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getGitStatus: mockGetGitStatus,
  getLocalGitStatus: mockGetLocalGitStatus,
  getFileTree: mockGetFileTree,
  getLocalFileTree: mockGetLocalFileTree,
}));

const { useFilesPanel } = await import("../../../src/hooks/useFilesPanel");

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
    mockGetGitStatus.mockImplementation(() => Promise.resolve([]));
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([]));
    mockGetFileTree.mockImplementation(() => Promise.resolve([]));
    mockGetLocalFileTree.mockImplementation(() => Promise.resolve([]));
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

    const { result } = renderHook(() => useFilesPanel());

    await waitFor(() => {
      expect(mockGetFileTree).toHaveBeenCalledWith("container-1");
      expect(useFilesPanelStore.getState().fileTree).toEqual(tree);
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

  test("manual changes load failure clears stale changes and resets loading", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    resetStores(environment);
    useFilesPanelStore.setState({ changes: [change] });
    mockGetGitStatus.mockImplementation(() => Promise.reject(new Error("git failed")));

    const { result } = renderHook(() => useFilesPanel());

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
    useFilesPanelStore.setState({ changes: [change] });
    mockGetGitStatus.mockImplementation(() => Promise.reject(new Error("git failed")));

    const { result } = renderHook(() => useFilesPanel());

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
    useFilesPanelStore.setState({ fileTree: tree });
    mockGetLocalFileTree.mockImplementation(() => Promise.reject(new Error("tree failed")));

    const { result } = renderHook(() => useFilesPanel());

    await act(async () => {
      await result.current.loadFileTree();
    });

    expect(useFilesPanelStore.getState().fileTree).toEqual([]);
    expect(useFilesPanelStore.getState().isLoadingTree).toBe(false);
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
