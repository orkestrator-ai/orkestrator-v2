import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { useConfigStore } from "../../../apps/web/src/stores/configStore";
import { useEnvironmentDiffStore } from "../../../apps/web/src/stores/environmentDiffStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import type { GitFileChange } from "../../../apps/web/src/lib/backend";
import type { Environment, RepositoryConfig } from "../../../apps/web/src/types";
import { createMockEnvironment } from "../utils/testFactories";

const realBackendSnapshot = { ...realBackend };

const mockGetGitStatus = mock<(containerId: string, targetBranch?: string, includeUncommitted?: boolean) => Promise<GitFileChange[]>>(
  () => Promise.resolve([]),
);
const mockGetLocalGitStatus = mock<(worktreePath: string, targetBranch?: string, includeUncommitted?: boolean) => Promise<GitFileChange[]>>(
  () => Promise.resolve([]),
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getGitStatus: mockGetGitStatus,
  getLocalGitStatus: mockGetLocalGitStatus,
}));

const { useEnvironmentDiffStats } = await import("../../../apps/web/src/hooks/useEnvironmentDiffStats");

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

function capturePollInterval(intervalId: number) {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalCallback: (() => void) | undefined;

  globalThis.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 15000) {
      intervalCallback = callback as () => void;
      return intervalId as unknown as ReturnType<typeof setInterval>;
    }
    return originalSetInterval(callback, timeout, ...args);
  }) as typeof setInterval;
  globalThis.clearInterval = ((currentIntervalId: Parameters<typeof clearInterval>[0]) => {
    if (currentIntervalId === (intervalId as unknown as Parameters<typeof clearInterval>[0])) {
      return;
    }
    originalClearInterval(currentIntervalId);
  }) as typeof clearInterval;

  return {
    tick() {
      if (!intervalCallback) throw new Error("Diff poll interval was not installed");
      intervalCallback();
    },
    restore() {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
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
    mock.module("@/lib/backend", () => realBackendSnapshot);
  });

  test("polls available environments including working-tree changes and stores aggregate diff stats", async () => {
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

    expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "release", true);
    expect(mockGetGitStatus).toHaveBeenCalledWith("container-1", "release", true);
    expect(mockGetGitStatus).not.toHaveBeenCalledWith("container-2", "release", true);
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
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "abc123def456", true);
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

  test("prunes stale stats when existing environments become unpollable", async () => {
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
    resetStores([localEnvironment, containerEnvironment]);
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([{
      path: "local.ts",
      filename: "local.ts",
      directory: "",
      status: "M",
      additions: 2,
      deletions: 0,
    }]));
    mockGetGitStatus.mockImplementation(() => Promise.resolve([{
      path: "container.ts",
      filename: "container.ts",
      directory: "",
      status: "M",
      additions: 3,
      deletions: 1,
    }]));

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.size).toBe(2);
    });

    act(() => {
      useEnvironmentStore.setState({
        environments: [
          { ...localEnvironment, worktreePath: undefined },
          { ...containerEnvironment, status: "stopped" },
        ],
      });
    });

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.size).toBe(0);
    });
    expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1);
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);
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
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "release", true);
    });

    expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
      additions: 7,
      deletions: 2,
      filesChanged: 3,
    });
  });

  test("retries a failed poll on the next interval", async () => {
    const pollInterval = capturePollInterval(9);
    try {
      const environment = createMockEnvironment({
        id: "env-local",
        projectId: "project-1",
        environmentType: "local",
        worktreePath: "/tmp/worktree",
        status: "stopped",
      });
      resetStores([environment]);
      let rejectRequest: (error: Error) => void = () => {};
      mockGetLocalGitStatus
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }))
        .mockImplementationOnce(() => Promise.resolve([{
          path: "recovered.ts",
          filename: "recovered.ts",
          directory: "",
          status: "M",
          additions: 5,
          deletions: 2,
        }]));

      renderHook(() => useEnvironmentDiffStats());
      await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1));

      await act(async () => {
        rejectRequest(new Error("git failed"));
        await Promise.resolve();
      });
      act(() => pollInterval.tick());

      await waitFor(() => {
        expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(2);
        expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
          additions: 5,
          deletions: 2,
          filesChanged: 1,
        });
      });
    } finally {
      pollInterval.restore();
    }
  });

  test("refetches the latest snapshot after an earlier snapshot fails", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment]);
    let rejectRequest: (error: Error) => void = () => {};
    mockGetLocalGitStatus
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }))
      .mockImplementationOnce(() => Promise.resolve([]));

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1));

    const latestCommit = "d".repeat(40);
    act(() => {
      useEnvironmentStore.setState({
        environments: [{ ...environment, createdFromCommit: latestCommit }],
      });
    });
    expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectRequest(new Error("git failed"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(2);
      expect(mockGetLocalGitStatus.mock.calls[1]?.[1]).toBe(latestCommit);
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
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "main", true);
      expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
        additions: 1,
        deletions: 0,
        filesChanged: 1,
      });
    });
  });

  test("immediately uses updated repository baseline configuration", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment], {
      "project-1": {
        defaultBranch: "trunk",
        prBaseBranch: "",
      },
    });

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "main", true);
    });

    act(() => {
      const config = useConfigStore.getState().config;
      if (!config) throw new Error("Expected test config");
      useConfigStore.setState({
        config: {
          ...config,
          repositories: {
            ...config.repositories,
            "project-1": {
              defaultBranch: "trunk",
              prBaseBranch: "develop",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(mockGetLocalGitStatus).toHaveBeenCalledWith("/tmp/worktree", "develop", true);
    });
  });

  test("discards an in-flight result after repository baseline configuration changes", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment]);

    const pending: Array<(changes: GitFileChange[]) => void> = [];
    mockGetLocalGitStatus.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1));
    expect(mockGetLocalGitStatus.mock.calls[0]?.[1]).toBe("release");

    act(() => {
      const config = useConfigStore.getState().config;
      if (!config) throw new Error("Expected test config");
      useConfigStore.setState({
        config: {
          ...config,
          repositories: {
            ...config.repositories,
            "project-1": {
              defaultBranch: "main",
              prBaseBranch: "develop",
            },
          },
        },
      });
    });
    expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0]?.([{
        path: "stale.ts",
        filename: "stale.ts",
        directory: "",
        status: "M",
        additions: 99,
        deletions: 0,
      }]);
      await Promise.resolve();
    });

    expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toBeUndefined();
    await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(2));
    expect(mockGetLocalGitStatus.mock.calls[1]?.[1]).toBe("develop");

    await act(async () => {
      pending[1]?.([{
        path: "fresh.ts",
        filename: "fresh.ts",
        directory: "",
        status: "M",
        additions: 4,
        deletions: 1,
      }]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
        additions: 4,
        deletions: 1,
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

  test("skips running container environments without a container id", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: undefined,
      status: "running",
    });
    resetStores([environment]);

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.size).toBe(0);
    });
    expect(mockGetLocalGitStatus).not.toHaveBeenCalled();
    expect(mockGetGitStatus).not.toHaveBeenCalled();
  });

  test("replaces existing stats with zeroes when a poll finds no changes", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment]);
    useEnvironmentDiffStore.setState({
      stats: new Map([["env-local", {
        additions: 7,
        deletions: 2,
        filesChanged: 3,
      }]]),
    });
    mockGetLocalGitStatus.mockImplementation(() => Promise.resolve([]));

    renderHook(() => useEnvironmentDiffStats());

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
        additions: 0,
        deletions: 0,
        filesChanged: 0,
      });
    });
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

  test("does not overlap polls for the same environment snapshot", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let intervalCallback: (() => void) | null = null;

    globalThis.setInterval = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 15000) {
        intervalCallback = callback as () => void;
        return 8 as unknown as ReturnType<typeof setInterval>;
      }
      return originalSetInterval(callback, timeout, ...args);
    }) as typeof setInterval;
    globalThis.clearInterval = ((intervalId: Parameters<typeof clearInterval>[0]) => {
      if (intervalId !== (8 as unknown as Parameters<typeof clearInterval>[0])) {
        originalClearInterval(intervalId);
      }
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
      let resolveRequest: (changes: GitFileChange[]) => void = () => {};
      mockGetLocalGitStatus.mockImplementation(() => new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      renderHook(() => useEnvironmentDiffStats());
      await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1));

      act(() => {
        intervalCallback?.();
        intervalCallback?.();
      });
      expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRequest([]);
        await Promise.resolve();
      });
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("does not restore stats when an environment is removed while its poll is in flight", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment]);
    useEnvironmentDiffStore.setState({
      stats: new Map([["env-local", { additions: 1, deletions: 1, filesChanged: 1 }]]),
    });
    let resolveRequest: (changes: GitFileChange[]) => void = () => {};
    mockGetLocalGitStatus.mockImplementation(() => new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1));

    act(() => {
      useEnvironmentStore.setState({ environments: [] });
    });
    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.has("env-local")).toBe(false);
    });

    await act(async () => {
      resolveRequest([{
        path: "late.ts",
        filename: "late.ts",
        directory: "",
        status: "M",
        additions: 99,
        deletions: 0,
      }]);
      await Promise.resolve();
    });

    expect(useEnvironmentDiffStore.getState().stats.has("env-local")).toBe(false);
  });

  // The snapshot key exists for this case, not just for removal: the baseline
  // commit being recorded changes the ref the stats are measured against, so a
  // result computed before that lands describes a comparison nobody asked for.
  test("discards an in-flight result when the environment's snapshot changes", async () => {
    const environment = createMockEnvironment({
      id: "env-local",
      projectId: "project-1",
      environmentType: "local",
      worktreePath: "/tmp/worktree",
      status: "stopped",
    });
    resetStores([environment]);

    const pending: Array<(changes: GitFileChange[]) => void> = [];
    const refs: Array<string | undefined> = [];
    mockGetLocalGitStatus.mockImplementation((_worktreePath, targetBranch) => {
      refs.push(targetBranch);
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    });

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1));
    expect(refs[0]).toBe("release");

    // The baseline arrives while the first request is still open.
    act(() => {
      useEnvironmentStore.setState({
        environments: [{ ...environment, createdFromCommit: "a".repeat(40) }],
      });
    });
    // Still one request: polls are serialised per environment, so the snapshot
    // change must not open a second concurrent request against the same worktree.
    expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0]?.([{
        path: "stale.ts",
        filename: "stale.ts",
        directory: "",
        status: "M",
        additions: 99,
        deletions: 0,
      }]);
      await Promise.resolve();
    });

    // The stale result is dropped, and a fresh request goes out for the new
    // baseline rather than waiting out the remaining poll interval.
    expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toBeUndefined();
    await waitFor(() => expect(mockGetLocalGitStatus).toHaveBeenCalledTimes(2));
    expect(refs[1]).toBe("a".repeat(40));

    await act(async () => {
      pending[1]?.([{
        path: "fresh.ts",
        filename: "fresh.ts",
        directory: "",
        status: "M",
        additions: 4,
        deletions: 1,
      }]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useEnvironmentDiffStore.getState().stats.get("env-local")).toEqual({
        additions: 4,
        deletions: 1,
        filesChanged: 1,
      });
    });
  });

  test("serialises polls per environment even as the snapshot changes", async () => {
    const environment = createMockEnvironment({
      id: "env-container",
      projectId: "project-1",
      environmentType: "docker",
      containerId: "container-1",
      status: "running",
    });
    resetStores([environment]);

    const pending: Array<(changes: GitFileChange[]) => void> = [];
    mockGetGitStatus.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));

    renderHook(() => useEnvironmentDiffStats());
    await waitFor(() => expect(mockGetGitStatus).toHaveBeenCalledTimes(1));

    // Each request runs a `git fetch` inside the container, so repeated snapshot
    // churn must not fan out into concurrent execs against the same container.
    act(() => {
      useEnvironmentStore.setState({
        environments: [{ ...environment, createdFromCommit: "b".repeat(40) }],
      });
    });
    act(() => {
      useEnvironmentStore.setState({
        environments: [{ ...environment, createdFromCommit: "c".repeat(40) }],
      });
    });
    expect(mockGetGitStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending[0]?.([]);
      await Promise.resolve();
    });

    await waitFor(() => expect(mockGetGitStatus).toHaveBeenCalledTimes(2));
    expect(mockGetGitStatus.mock.calls[1]?.[1]).toBe("c".repeat(40));
  });
});
