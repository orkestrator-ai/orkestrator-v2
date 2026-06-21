import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useClaudeOptionsStore } from "@/stores/claudeOptionsStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useUIStore } from "@/stores/uiStore";
import type { ClaudeMode, CodexMode, DefaultAgent, Environment, OpenCodeMode } from "@/types";

const mockCreateEnvironment = mock<() => Promise<Environment>>(async () => ({
  id: "env-build",
  projectId: "project-1",
  name: "Build task",
  branch: "main",
  containerId: "container-build",
  status: "stopped",
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  networkAccessMode: "restricted" as const,
  order: 0,
  environmentType: "containerized" as const,
}));
const mockStartEnvironment = mock(async () => ({ setupCommands: undefined }));
const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockGetEnvironment = mock(async (): Promise<Environment | null> => ({
  id: "env-build",
  projectId: "project-1",
  name: "build-task",
  branch: "build-task",
  containerId: "container-build",
  status: "running" as const,
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  networkAccessMode: "restricted" as const,
  order: 0,
  environmentType: "containerized" as const,
}));
const mockUpdateEnvironmentAgentSettings = mock<(
  environmentId: string,
  defaultAgent: DefaultAgent | null,
  claudeMode: ClaudeMode | null,
  _claudeNativeBackend: string | null,
  opencodeMode: OpenCodeMode | null,
  codexMode: CodexMode | null,
) => Promise<Environment>>(async (
  environmentId: string,
  defaultAgent: DefaultAgent | null,
  claudeMode: ClaudeMode | null,
  _claudeNativeBackend: string | null,
  opencodeMode: OpenCodeMode | null,
  codexMode: CodexMode | null,
) => ({
  id: environmentId,
  projectId: "project-1",
  name: "Build task",
  branch: "main",
  containerId: "container-build",
  status: "running" as const,
  prUrl: null,
  prState: null,
  hasMergeConflicts: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  networkAccessMode: "restricted" as const,
  order: 0,
  environmentType: "containerized" as const,
  defaultAgent: defaultAgent ?? undefined,
  claudeMode: claudeMode ?? undefined,
  opencodeMode: opencodeMode ?? undefined,
  codexMode: codexMode ?? undefined,
}));
const mockToastSuccess = mock(() => {});
const mockToastError = mock(() => {});
const actualBackend = await import("../lib/backend");

mock.module("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  createEnvironment: mockCreateEnvironment,
  startEnvironment: mockStartEnvironment,
  getEnvironments: mock(async () => []),
  getEnvironment: mockGetEnvironment,
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
  deleteEnvironment: mock(async () => {}),
  stopEnvironment: mock(async () => {}),
  syncEnvironmentStatus: mock(async () => ({
    id: "env-build",
    projectId: "project-1",
    name: "Build task",
    branch: "main",
    containerId: "container-build",
    status: "running" as const,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    networkAccessMode: "restricted" as const,
    order: 0,
    environmentType: "containerized" as const,
  })),
  updateKanbanTask: mock(async (
    taskId: string,
    title?: string,
    description?: string,
    acceptanceCriteria?: string,
    status?: string,
    environmentId?: string,
    buildPipelineId?: string,
    prUrl?: string,
    prState?: string,
    prMergeCommented?: boolean,
  ) => ({
    id: taskId,
    projectId: "project-1",
    title: title ?? "Build task",
    description: description ?? "Ship the feature",
    acceptanceCriteria: acceptanceCriteria ?? "All checks green",
    status: (status ?? "backlog") as "backlog",
    comments: [],
    images: [],
    environmentId,
    buildPipelineId,
    prUrl: prUrl ?? null,
    prState: (prState as "open" | "closed" | "merged" | undefined) ?? null,
    prMergeCommented: prMergeCommented ?? false,
    createdAt: "2024-01-01T00:00:00.000Z",
    order: 0,
  })),
  getKanbanImageData: mock(async () => "data:image/png;base64,ZmFrZQ=="),
  updateEnvironmentAgentSettings: mockUpdateEnvironmentAgentSettings,
}));

const { useBuildPipeline } = await import("./useBuildPipeline");

describe("useBuildPipeline", () => {
  beforeEach(() => {
    mockCreateEnvironment.mockClear();
    mockStartEnvironment.mockClear();
    mockRenameEnvironmentFromPrompt.mockClear();
    mockGetEnvironment.mockClear();
    mockUpdateEnvironmentAgentSettings.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();

    usePaneLayoutStore.setState({
      environments: new Map(),
      activeEnvironmentId: "env-visible",
    });

    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });

    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          defaultAgent: "codex",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          codexMode: "native",
        },
        repositories: {},
      },
    }));

    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
    });

    useClaudeOptionsStore.setState({
      options: {},
    });

    useKanbanStore.setState((state) => ({
      ...state,
      tasks: [],
      isLoading: false,
      currentProjectId: null,
      notes: "",
      notesLoading: false,
      currentNotesProjectId: null,
    }));

    useUIStore.setState({
      selectedProjectId: null,
      selectedEnvironmentId: null,
      collapsedProjects: ["project-1"],
      selectedEnvironmentIds: [],
      expandedSessionsEnvironments: [],
      sidebarWidth: 280,
      zoomLevel: 100,
    });
  });

  test("navigateToBuild activates the build tab for the target environment without switching pane store focus", async () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-hidden", {
          root: {
            kind: "leaf",
            id: "pane-hidden",
            tabs: [{
              id: "build-tab",
              type: "claude-build",
              buildTabData: {
                environmentId: "env-hidden",
                pipelineId: "pipeline-1",
                taskId: "task-1",
                isLocal: false,
              },
            }],
            activeTabId: null,
          },
          activePaneId: "pane-hidden",
          containerId: "container-hidden",
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToBuild({
        id: "task-1",
        projectId: "project-1",
        title: "Build task",
        description: "",
        acceptanceCriteria: "",
        status: "backlog",
        comments: [],
        images: [],
        environmentId: "env-hidden",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      });
    });

    expect(useUIStore.getState().selectedProjectId).toBe("project-1");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-hidden");
    expect(useUIStore.getState().collapsedProjects).not.toContain("project-1");

    const envHidden = usePaneLayoutStore.getState().environments.get("env-hidden");
    expect(envHidden?.root.kind).toBe("leaf");
    if (!envHidden || envHidden.root.kind !== "leaf") {
      throw new Error("env-hidden root should be a leaf");
    }

    expect(envHidden.root.activeTabId).toBe("build-tab");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-visible");
  });

  test("startBuild propagates codexMode to environment agent settings", async () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-build", {
          root: {
            kind: "leaf",
            id: "pane-build",
            tabs: [],
            activeTabId: null,
          },
          activePaneId: "pane-build",
          containerId: "container-build",
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild({
        id: "task-codex",
        projectId: "project-1",
        title: "Build task",
        description: "Ship the feature",
        acceptanceCriteria: "All checks green",
        status: "backlog",
        comments: [],
        images: [],
        environmentId: undefined,
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      }, "containerized");
    });

    await waitFor(() => {
      expect(mockUpdateEnvironmentAgentSettings).toHaveBeenCalledWith(
        "env-build",
        "codex",
        null,
        null,
        null,
        "native",
      );
    });

    expect(mockCreateEnvironment).toHaveBeenCalledWith(
      "project-1",
      undefined,
      "restricted",
      undefined,
      undefined,
      "containerized",
      undefined,
    );
    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        "env-build",
        "Build task\n\nShip the feature\n\nAll checks green",
      );
    });
    expect(useClaudeOptionsStore.getState().options["env-build"]).toBeUndefined();
  });

  test("startBuild starts local environments and adds the build tab when there are no setup commands", async () => {
    const localCreatedEnvironment: Environment = {
      id: "env-build",
      projectId: "project-1",
      name: "Build task",
      branch: "main",
      containerId: null,
      status: "stopped",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
    };
    const localStartedEnvironment: Environment = {
      ...localCreatedEnvironment,
      status: "running",
      name: "build-task",
      branch: "build-task",
      worktreePath: "/tmp/env-build-worktree",
      defaultAgent: "codex",
      codexMode: "native",
    };
    const localRenamedEnvironment: Environment = {
      ...localStartedEnvironment,
      status: "stopped",
      worktreePath: undefined,
    };

    mockCreateEnvironment.mockImplementationOnce(async () => localCreatedEnvironment);
    mockUpdateEnvironmentAgentSettings.mockImplementationOnce(async () => ({
      ...localCreatedEnvironment,
      defaultAgent: "codex",
      codexMode: "native",
    }));
    mockStartEnvironment.mockImplementationOnce(async () => ({ setupCommands: undefined }));
    mockGetEnvironment
      .mockImplementationOnce(async () => localRenamedEnvironment)
      .mockImplementationOnce(async () => localStartedEnvironment);

    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-build", {
          root: {
            kind: "leaf",
            id: "pane-build",
            tabs: [],
            activeTabId: null,
          },
          activePaneId: "pane-build",
          containerId: null,
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild({
        id: "task-local",
        projectId: "project-1",
        title: "Build local task",
        description: "",
        acceptanceCriteria: "",
        status: "backlog",
        comments: [],
        images: [],
        environmentId: undefined,
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      }, "local");
    });

    expect(mockCreateEnvironment).toHaveBeenCalledWith(
      "project-1",
      undefined,
      "full",
      undefined,
      undefined,
      "local",
      undefined,
    );
    expect(mockStartEnvironment).toHaveBeenCalledWith("env-build");

    const envState = usePaneLayoutStore.getState().environments.get("env-build");
    expect(envState?.root.kind).toBe("leaf");
    if (!envState || envState.root.kind !== "leaf") {
      throw new Error("env-build root should be a leaf");
    }

    const buildTab = envState.root.tabs.find((tab) => tab.type === "claude-build");
    expect(buildTab?.buildTabData).toMatchObject({
      environmentId: "env-build",
      taskId: "task-local",
      isLocal: true,
    });
    expect(useEnvironmentStore.getState().pendingSetupCommands.has("env-build")).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalledWith("Build pipeline started");
  });

  test("startBuild continues when prompt rename fails", async () => {
    const originalConsoleWarn = console.warn;
    const consoleWarnMock = mock(() => undefined);
    console.warn = consoleWarnMock as unknown as typeof console.warn;
    mockRenameEnvironmentFromPrompt.mockImplementationOnce(async () => {
      throw new Error("rename failed");
    });
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-build", {
          root: {
            kind: "leaf",
            id: "pane-build",
            tabs: [],
            activeTabId: null,
          },
          activePaneId: "pane-build",
          containerId: "container-build",
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    try {
      const { result } = renderHook(() => useBuildPipeline());

      await act(async () => {
        await result.current.startBuild({
          id: "task-rename-fail",
          projectId: "project-1",
          title: "Build task",
          description: "Ship the feature",
          acceptanceCriteria: "All checks green",
          status: "backlog",
          comments: [],
          images: [],
          environmentId: undefined,
          createdAt: "2024-01-01T00:00:00.000Z",
          order: 0,
        }, "containerized");
      });

      expect(mockStartEnvironment).toHaveBeenCalledWith("env-build");
      expect(mockToastSuccess).toHaveBeenCalledWith("Build pipeline started");
      await waitFor(() => {
        expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
          "env-build",
          "Build task\n\nShip the feature\n\nAll checks green",
        );
        expect(consoleWarnMock).toHaveBeenCalledWith(
          "[useBuildPipeline] Failed to rename environment from task prompt:",
          expect.any(Error),
        );
      });
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  test("startBuild tolerates a missing environment refresh after prompt rename", async () => {
    mockGetEnvironment.mockImplementationOnce(async () => null);
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-build", {
          root: {
            kind: "leaf",
            id: "pane-build",
            tabs: [],
            activeTabId: null,
          },
          activePaneId: "pane-build",
          containerId: "container-build",
        }],
      ]),
      activeEnvironmentId: "env-visible",
    });

    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild({
        id: "task-null-refresh",
        projectId: "project-1",
        title: "Build task",
        description: "Ship the feature",
        acceptanceCriteria: "All checks green",
        status: "backlog",
        comments: [],
        images: [],
        environmentId: undefined,
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      }, "containerized");
    });

    expect(mockStartEnvironment).toHaveBeenCalledWith("env-build");
    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        "env-build",
        "Build task\n\nShip the feature\n\nAll checks green",
      );
      expect(mockGetEnvironment).toHaveBeenCalledWith("env-build");
      expect(mockGetEnvironment).toHaveBeenCalledTimes(2);
      expect(useEnvironmentStore.getState().getEnvironmentById("env-build")?.name).toBe("build-task");
    });
  });
});
