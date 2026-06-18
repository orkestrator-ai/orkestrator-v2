import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the component under test
// ---------------------------------------------------------------------------

// Tauri commands
const mockStartClaudeServer = mock(() =>
  Promise.resolve({ hostPort: 9999 })
);
const mockGetClaudeServerStatus = mock(() =>
  Promise.resolve({ running: false, hostPort: null })
);
const mockStartLocalClaudeServer = mock(() =>
  Promise.resolve({ port: 8888, pid: 1234 })
);
const mockGetLocalClaudeServerStatus = mock(() =>
  Promise.resolve({ running: false, port: null, pid: null })
);
const mockGetProjectNotes = mock(() =>
  Promise.resolve({ projectId: "project-1", notes: "" })
);

mock.module("@/lib/tauri", () => ({
  startClaudeServer: mockStartClaudeServer,
  getClaudeServerStatus: mockGetClaudeServerStatus,
  startLocalClaudeServer: mockStartLocalClaudeServer,
  getLocalClaudeServerStatus: mockGetLocalClaudeServerStatus,
  getProjectNotes: mockGetProjectNotes,
}));

// Claude client
const mockCreateClient = mock(() => ({ baseUrl: "http://127.0.0.1:9999" }));
const mockCheckHealth = mock(() => Promise.resolve(true));
const mockGetModels = mock(() => Promise.resolve([]));
const mockSubscribeToEvents = mock(() => (async function* () {})());

mock.module("@/lib/claude-client", () => ({
  createClient: mockCreateClient,
  checkHealth: mockCheckHealth,
  getModels: mockGetModels,
  createSession: mock(() => Promise.resolve({ sessionId: "session-1" })),
  getSessionMessages: mock(() => Promise.resolve([])),
  sendPrompt: mock(() => Promise.resolve()),
  abortSession: mock(() => Promise.resolve()),
  subscribeToEvents: mockSubscribeToEvents,
  ERROR_MESSAGE_PREFIX: "[ERROR]",
  SYSTEM_MESSAGE_PREFIX: "[SYSTEM]",
}));

// NOTE: Do NOT mock @/hooks or @/hooks/useScrollLock here — it pollutes the
// global bun module cache and breaks useScrollLock.test.ts. The real hook
// returns safe defaults (isAtBottom: true) when no viewport is found.

mock.module("@/lib/context-usage", () => ({
  extractContextUsage: () => null,
}));

// Mock sonner (toast) used by transitive UI deps.
mock.module("sonner", () => ({
  toast: { success: () => {}, error: () => {} },
}));

// Mock heavy UI components so rendering is fast.
// Snapshot the real modules first so afterAll can restore them — Bun caches
// mock.module factories globally, so without restoration these stubs leak
// into sibling test files that need the real ScrollArea viewport.
import * as realScrollAreaModule from "@/components/ui/scroll-area";
import * as realSeparatorModule from "@/components/ui/separator";
const realScrollAreaSnapshot = { ...realScrollAreaModule };
const realSeparatorSnapshot = { ...realSeparatorModule };

mock.module("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollBar: () => null,
}));

mock.module("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useClaudeStore } from "@/stores/claudeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { BuildChatTab } from "./BuildChatTab";
import type { BuildTabData } from "@/types/paneLayout";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_ID = "env-1";
const PIPELINE_ID = "pipeline-1";
const TASK_ID = "task-1";
const CONTAINER_ID = "container-123";

function createContainerBuildData(overrides: Partial<BuildTabData> = {}): BuildTabData {
  return {
    environmentId: ENV_ID,
    pipelineId: PIPELINE_ID,
    taskId: TASK_ID,
    isLocal: undefined,
    ...overrides,
  };
}

function createLocalBuildData(overrides: Partial<BuildTabData> = {}): BuildTabData {
  return {
    environmentId: ENV_ID,
    pipelineId: PIPELINE_ID,
    taskId: TASK_ID,
    isLocal: true,
    ...overrides,
  };
}

function seedPipeline(phase = "waiting-for-setup" as string) {
  useBuildPipelineStore.setState({
    pipelines: new Map([
      [
        PIPELINE_ID,
        {
          id: PIPELINE_ID,
          taskId: TASK_ID,
          projectId: "project-1",
          environmentId: ENV_ID,
          environmentType: "containerized" as const,
          agentType: "claude" as const,
          phase: phase as any,
          sessions: [],
          currentSessionIndex: -1,
          iteration: 0,
          maxIterations: 3,
          createdAt: new Date().toISOString(),
          taskTitle: "Test task",
          taskSnapshot: {
            title: "Test task",
            description: "desc",
            acceptanceCriteria: "ac",
            comments: [],
            images: [],
          },
        },
      ],
    ]),
    buildEnvironmentIds: new Set([ENV_ID]),
  });
}

function seedEnvironment(opts: { isLocal?: boolean; workspaceReady?: boolean } = {}) {
  const envType = opts.isLocal ? "local" : "containerized";
  const workspaceReadySet = new Set<string>();
  if (opts.workspaceReady) workspaceReadySet.add(ENV_ID);

  useEnvironmentStore.setState({
    environments: [
      {
        id: ENV_ID,
        projectId: "project-1",
        name: "test-env",
        branch: "feat/test",
        containerId: opts.isLocal ? null : CONTAINER_ID,
        status: "running" as const,
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date().toISOString(),
        networkAccessMode: "restricted" as const,
        order: 0,
        environmentType: envType,
        worktreePath: opts.isLocal ? "/tmp/worktree" : undefined,
      },
    ],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: workspaceReadySet,
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
  });
}

function seedConfigStore() {
  useConfigStore.setState({
    config: {
      version: "1.0",
      global: {
        containerResources: { cpuCores: 2, memoryGb: 4 },
        envFilePatterns: [],
        allowedDomains: [],
        defaultAgent: "claude",
        opencodeModel: "gpt-4",
        codexModel: "codex",
        codexReasoningEffort: "medium",
        opencodeMode: "terminal",
        claudeMode: "native",
        terminalAppearance: {
          fontFamily: "Fira Code",
          fontSize: 14,
          backgroundColor: "#000000",
        },
        terminalScrollback: 5000,
      },
      repositories: {},
    } as any,
    isLoading: false,
  });
}

function resetStores() {
  // Reset only the state slices relevant to BuildChatTab
  useClaudeStore.setState({
    serverStatus: new Map(),
    clients: new Map(),
    eventSubscriptions: new Map(),
    sessions: new Map(),
    models: [],
  });

  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });

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

  useKanbanStore.setState({
    tasks: [],
    isLoading: false,
    currentProjectId: null,
    notes: "",
    notesLoading: false,
    currentNotesProjectId: null,
  });

  usePrMonitorStore.setState({
    monitoredEnvironments: {},
    activeEnvironmentId: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BuildChatTab", () => {
  afterAll(() => {
    mock.module("@/components/ui/scroll-area", () => realScrollAreaSnapshot);
    mock.module("@/components/ui/separator", () => realSeparatorSnapshot);
    mock.restore();
  });

  beforeEach(() => {
    cleanup();
    resetStores();
    seedConfigStore();

    // Clear all mocks
    mockStartClaudeServer.mockClear();
    mockGetClaudeServerStatus.mockClear();
    mockStartLocalClaudeServer.mockClear();
    mockGetLocalClaudeServerStatus.mockClear();
    mockGetProjectNotes.mockClear();
    mockCreateClient.mockClear();
    mockCheckHealth.mockClear();
    mockGetModels.mockClear();
    mockSubscribeToEvents.mockClear();

    // Reset default implementations
    mockGetClaudeServerStatus.mockImplementation(() =>
      Promise.resolve({ running: false, hostPort: null })
    );
    mockStartClaudeServer.mockImplementation(() =>
      Promise.resolve({ hostPort: 9999 })
    );
    mockGetLocalClaudeServerStatus.mockImplementation(() =>
      Promise.resolve({ running: false, port: null, pid: null })
    );
    mockStartLocalClaudeServer.mockImplementation(() =>
      Promise.resolve({ port: 8888, pid: 1234 })
    );
    mockCheckHealth.mockImplementation(() => Promise.resolve(true));
    mockGetModels.mockImplementation(() => Promise.resolve([]));
  });

  afterEach(() => {
    cleanup();
  });

  // -----------------------------------------------------------------------
  // Setup gating
  // -----------------------------------------------------------------------

  describe("setup gating", () => {
    test("shows setup-pending UI when container workspace is not ready", () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: false });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
      expect(screen.getByText("Build will start automatically once setup finishes")).toBeTruthy();
    });

    test("shows setup-pending UI when local setup scripts are running", () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: true, workspaceReady: true });
      useEnvironmentStore.setState({
        setupScriptsRunning: new Set([ENV_ID]),
      });

      render(<BuildChatTab data={createLocalBuildData()} isActive />);

      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    });

    test("does not call startClaudeServer while setup is pending", async () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: false });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      // Give effects time to run
      await new Promise((r) => setTimeout(r, 50));

      expect(mockStartClaudeServer).not.toHaveBeenCalled();
      expect(mockGetClaudeServerStatus).not.toHaveBeenCalled();
    });

    test("shows setup-pending UI when local setup commands are not yet resolved", () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: true, workspaceReady: true });
      // setupCommandsResolved is empty (not resolved), no pending commands, not running
      // => isSetupPending returns true because !setupCommandsResolved

      render(<BuildChatTab data={createLocalBuildData()} isActive />);

      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    });

    test("skip waiting button sets workspaceReady for container envs", async () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: false });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      const skipBtn = screen.getByText("Skip waiting");
      skipBtn.click();

      // workspaceReady should now be true for this environment
      expect(
        useEnvironmentStore.getState().workspaceReadyEnvironments.has(ENV_ID)
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Container bridge connection
  // -----------------------------------------------------------------------

  describe("container bridge connection", () => {
    test("starts Claude server when workspace becomes ready", async () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetClaudeServerStatus).toHaveBeenCalledWith(CONTAINER_ID);
      });

      await waitFor(() => {
        expect(mockStartClaudeServer).toHaveBeenCalledWith(CONTAINER_ID);
      });
    });

    test("reuses existing server if already running", async () => {
      mockGetClaudeServerStatus.mockImplementation(() =>
        Promise.resolve({ running: true, hostPort: 7777 } as any)
      );
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetClaudeServerStatus).toHaveBeenCalledWith(CONTAINER_ID);
      });

      // Should NOT try to start a new server
      expect(mockStartClaudeServer).not.toHaveBeenCalled();
    });

    test("throws when containerId is missing", async () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      // Clear the containerId
      useEnvironmentStore.setState({
        environments: [
          {
            ...useEnvironmentStore.getState().environments[0]!,
            containerId: null,
          },
        ],
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(screen.getByText("Connection Failed")).toBeTruthy();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Local bridge connection
  // -----------------------------------------------------------------------

  describe("local bridge connection", () => {
    test("starts local Claude server when setup completes", async () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: true, workspaceReady: true });
      // Mark setup as resolved (no pending commands)
      useEnvironmentStore.setState({
        setupCommandsResolved: new Set([ENV_ID]),
      });

      render(<BuildChatTab data={createLocalBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetLocalClaudeServerStatus).toHaveBeenCalledWith(ENV_ID);
      });

      await waitFor(() => {
        expect(mockStartLocalClaudeServer).toHaveBeenCalledWith(ENV_ID);
      });
    });

    test("does not start local server while setup scripts are running", async () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: true, workspaceReady: true });
      useEnvironmentStore.setState({
        setupScriptsRunning: new Set([ENV_ID]),
        setupCommandsResolved: new Set([ENV_ID]),
      });

      render(<BuildChatTab data={createLocalBuildData()} isActive />);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockStartLocalClaudeServer).not.toHaveBeenCalled();
      expect(mockGetLocalClaudeServerStatus).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Paused state UI
  // -----------------------------------------------------------------------

  describe("paused state", () => {
    test("does not show setup-pending UI when pipeline is paused", () => {
      seedPipeline("paused");
      seedEnvironment({ isLocal: false, workspaceReady: false });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      expect(screen.queryByText("Waiting for setup scripts to complete...")).toBeNull();
    });

    test("shows 'Review and continue' button when paused", async () => {
      seedPipeline("paused");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      // Pre-set client so the warm-path initialization succeeds
      useClaudeStore.setState({
        clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
        serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(screen.getByText("Review and continue")).toBeTruthy();
      });
    });

    test("shows jump-in compose bar when paused", async () => {
      seedPipeline("paused");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      useClaudeStore.setState({
        clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
        serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Send a message to the agent...")).toBeTruthy();
      });
    });

    test("does not show stop button when paused", async () => {
      seedPipeline("paused");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      useClaudeStore.setState({
        clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
        serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(screen.getByText("Paused")).toBeTruthy();
      });
      expect(screen.queryByText("Stop")).toBeNull();
    });

    test("shows 'Paused' in the status bar when paused", async () => {
      seedPipeline("paused");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      useClaudeStore.setState({
        clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
        serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(screen.getByText("Paused")).toBeTruthy();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Render guard ordering
  // -----------------------------------------------------------------------

  describe("render guard ordering", () => {
    test("shows setup-pending UI instead of connecting spinner when setup pending", () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: false });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      // Should show setup-pending, NOT "Connecting to Claude bridge server..."
      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
      expect(screen.queryByText("Connecting to Claude bridge server...")).toBeNull();
    });

    test("shows connecting UI after setup completes but before bridge connects", () => {
      seedPipeline("building");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      // No client exists yet, so connectionState remains "connecting"

      render(
        <BuildChatTab data={createContainerBuildData()} isActive />
      );

      // The component should not show setup-pending text since workspace is ready
      expect(screen.queryByText("Waiting for setup scripts to complete...")).toBeNull();
    });
  });
});
