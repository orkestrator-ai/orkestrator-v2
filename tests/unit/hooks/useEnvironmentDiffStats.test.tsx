import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as realTauri from "@/lib/tauri";
import { useConfigStore } from "../../../src/stores/configStore";
import { useEnvironmentDiffStore } from "../../../src/stores/environmentDiffStore";
import { useEnvironmentStore } from "../../../src/stores/environmentStore";
import type { GitFileChange } from "../../../src/lib/tauri";
import type { Environment, RepositoryConfig } from "../../../src/types";
import { createMockEnvironment } from "../utils/testFactories";

const realTauriSnapshot = { ...realTauri };

const mockGetGitStatus = mock<(containerId: string, targetBranch?: string) => Promise<GitFileChange[]>>(
  () => Promise.resolve([]),
);
const mockGetLocalGitStatus = mock<(worktreePath: string, targetBranch?: string) => Promise<GitFileChange[]>>(
  () => Promise.resolve([]),
);

mock.module("@/lib/tauri", () => ({
  ...realTauriSnapshot,
  getGitStatus: mockGetGitStatus,
  getLocalGitStatus: mockGetLocalGitStatus,
}));

const { useEnvironmentDiffStats } = await import("../../../src/hooks/useEnvironmentDiffStats");

function resetStores(
  environments: Environment[] = [],
  repositoryConfigByProject: Record<string, RepositoryConfig> = {
    "project-1": {
      defaultBranch: "main",
      prBaseBranch: "release",
    },
  },
) {
  useEnvironmentStore.setState({
    environments,
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set(),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
    sessionActivated: new Set(),
  });

  useEnvironmentDiffStore.setState({
    stats: new Map(),
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
      repositories: repositoryConfigByProject,
    },
    isLoading: false,
    error: null,
  });
}

describe("useEnvironmentDiffStats", () => {
  beforeEach(() => {
    mockGetGitStatus.mockClear();
    mockGetLocalGitStatus.mockClear();
    mockGetGitStatus.mockImplementation(() => Promise.resolve([]));
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([]));
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  afterAll(() => {
    mock.module("@/lib/tauri", () => realTauriSnapshot);
  });

  test("polls available local and container environments and stores aggregate diff stats", async () => {
    const localEnvironment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    const containerEnvironment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const stoppedContainer = createMockEnvironment({
      id: "env-stopped",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-2",
      status: "stopped",
    });
    resetStores([localEnvironment, containerEnvironment, stoppedContainer]);

    mockGetLocalGitStatus.mockImplementation(() =>
      Promise.resolve([
        {
          path: "src/local.ts",
          filename: "local.ts",
          directory: "src",
          status: "M",
          additions: 3,
          deletions: 1,
        },
      ]),
    );
    mockGetGitStatus.mockImplementation(() =>
      Promise.resolve([
        {
          path: "src/container.ts",
          filename: "container.ts",
          directory: "src",
          status: "A",
          additions: 10,
          deletions: 0,
        },
        {
          path: "README.md",
          filename: "README.md",
          directory: "",
          status: "M",
          additions: 2,
          deletions: 4,
        },
      ]),
    );

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      const stats = useEnvironmentDiffStore.getState().stats;
      expect(stats.get("env-local")).toEqual({
        additions: 3,
        deletions: 1,
        filesChanged: 1,
      });
      expect(stats.get("env-container")).toEqual({
        additions: 12,
        deletions: 4,
        filesChanged: 2,
      });
    });

    expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "release");
    expect(mockGetGitStatus).toHaveBeenCalledWith("container-1", "release");
    expect(mockGetGitStatus).not.toHaveBeenCalledWith("container-2", "release");
    expect(useEnvironmentDiffStore.getState().stats.has("env-stopped")).toBe(false);
  });

  test("polls diff stats against the environment creation commit when available", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
      createdFromCommit: "abc123def456",
    });
    resetStores([environment]);

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "abc123def456");
    });
  });

  test("prunes stale stats when environments disappear", async () => {
    const environment = createMockEnvironment({
      id: "env-current",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/current",
      status: "stopped",
    });
    resetStores([environment]);
    useEnvironmentDiffStore.setState({
      stats: new Map([
        ["env-current", { additions: 1, deletions: 1, filesChanged: 1 }],
        ["env-stale", { additions: 99, deletions: 99, filesChanged: 9 }],
      ]),
    });

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      const stats = useEnvironmentDiffStore.getState().stats;
      expect(stats.has("env-current")).toBe(true);
      expect(stats.has("env-stale")).toBe(false);
    });
  });

  test("does not clear existing stats when a non-critical diff request fails", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment]);
    useEnvironmentDiffStore.setState({
      stats: new Map([["env-local", { additions: 7, deletions: 2, filesChanged: 3 }]]),
    });
    mockGetLocalGitStatus.mockImplementation(() => Promise.reject(new Error("git failed")));

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "release");
    });

    expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
      additions: 7,
      deletions: 2,
      filesChanged: 3,
    });
  });

  test("falls back to main when repository config is missing", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-missing",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment], {});
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([{
      path: "README.md",
      filename: "README.md",
      directory: "",
      status: "M",
      additions: 1,
      deletions: 0,
    }]));

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "main");
      expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
        additions: 1,
        deletions: 0,
        filesChanged: 1,
      });
    });
  });

  test("skips local environments without a worktree path", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: undefined,
      status: "stopped",
    });
    resetStores([environment]);

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.size).toBe(0);
    });
    expect(mockGetLocalGitStatus).not.toHaveBeenCalled();
    expect(mockGetGitStatus).not.toHaveBeenCalled();
  });

  test("polling interval refreshes stats with the latest environment snapshot", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let intervalCallback: (() => void) | null = null;
    const clearIntervalMock = mock(() => {});

    globalThis.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15000) {
        intervalCallback = callback as () => void;
        return 7 as unknown as ReturnType<typeof setInterval>;
      }
      return originalSetInterval(callback, timeout, ...args);
    }) as typeof setInterval;
    globalThis.clearInterval = ((intervalId: Parameters<typeof clearInterval>[0]) => {
      if (intervalId === (7 as unknown as Parameters<typeof clearInterval>[0])) {
        clearIntervalMock(intervalId);
        return;
      }
      originalClearInterval(intervalId);
    }) as typeof clearInterval;

    try {
      const environment = createMockEnvironment({
        id: "env-local",
        projectId: "project-1",
        environmentType: "local",
        worktreePath: "/tmp/worktree",
        status: "stopped",
      });
      resetStores([environment]);
      mockGetLocalGitStatus
        .mockImplementationOnce(() => Promise.resolve([{
          path: "first.ts",
          filename: "first.ts",
          directory: "",
          status: "M",
          additions: 1,
          deletions: 0,
        }]))
        .mockImplementationOnce(() => Promise.resolve([{
          path: "second.ts",
          filename: "second.ts",
          directory: "",
          status: "M",
          additions: 4,
          deletions: 2,
        }]));

      const { unmount } = renderHook(() => useEnvironmentDiffStats());

      await waitFor(() => {
        expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
          additions: 1,
          deletions: 0,
          filesChanged: 1,
        });
      });
      expect(intervalCallback).not.toBeNull();

      intervalCallback?.();

      await waitFor(() => {
        expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
          additions: 4,
          deletions: 2,
          filesChanged: 1,
        });
      });
      expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(2);

      unmount();
      expect(clearIntervalMock).toHaveBeenCalledWith(7);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
