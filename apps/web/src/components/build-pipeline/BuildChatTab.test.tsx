import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the component under test
// ---------------------------------------------------------------------------

// backend commands
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
const mockDetectPr = mock(() => Promise.resolve(null as {
  url: string;
  state: "open" | "merged" | "closed";
  hasMergeConflicts: boolean;
} | null));
const mockDetectPrLocal = mock(() => Promise.resolve(null as {
  url: string;
  state: "open" | "merged" | "closed";
  hasMergeConflicts: boolean;
} | null));

mock.module("@/lib/backend", () => ({
  startClaudeServer: mockStartClaudeServer,
  getClaudeServerStatus: mockGetClaudeServerStatus,
  startLocalClaudeServer: mockStartLocalClaudeServer,
  getLocalClaudeServerStatus: mockGetLocalClaudeServerStatus,
  getProjectNotes: mockGetProjectNotes,
  detectPr: mockDetectPr,
  detectPrLocal: mockDetectPrLocal,
}));

// Claude client
const mockCreateClient = mock(() => ({ baseUrl: "http://127.0.0.1:9999" }));
const mockCheckHealth = mock(() => Promise.resolve(true));
const mockGetModels = mock(() => Promise.resolve([]));
const mockSubscribeToEvents = mock(() => (async function* () {})());
const mockCreateSession = mock(() => Promise.resolve({ sessionId: "session-1" }));
const mockGetSessionMessages = mock(() => Promise.resolve([] as ClaudeMessage[]));
const mockSendPrompt = mock(() => Promise.resolve(true));
const mockAbortSession = mock(() => Promise.resolve(true));

mock.module("@/lib/claude-client", () => ({
  createClient: mockCreateClient,
  checkHealth: mockCheckHealth,
  getModels: mockGetModels,
  createSession: mockCreateSession,
  getSessionMessages: mockGetSessionMessages,
  sendPrompt: mockSendPrompt,
  abortSession: mockAbortSession,
  subscribeToEvents: mockSubscribeToEvents,
  ERROR_MESSAGE_PREFIX: "[ERROR]",
  SYSTEM_MESSAGE_PREFIX: "[SYSTEM]",
}));

// NOTE: Do NOT mock @/hooks or @/hooks/useScrollLock here — it pollutes the
// global bun module cache and breaks useScrollLock.test.ts. The real hook
// returns safe defaults (isAtBottom: true) when no viewport is found.

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

import { createClaudeSessionKey, useClaudeStore } from "@/stores/claudeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { createAddressIssuesPrompt } from "@/prompts/build-pipeline";
import { BuildChatTab } from "./BuildChatTab";
import type { BuildTabData } from "@/types/paneLayout";
import type { ClaudeMessage } from "@/lib/claude-client";

const realKanbanActions = {
  moveTask: useKanbanStore.getState().moveTask,
  addComment: useKanbanStore.getState().addComment,
  updateTask: useKanbanStore.getState().updateTask,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_ID = "env-1";
const PIPELINE_ID = "pipeline-1";
const TASK_ID = "task-1";
const CONTAINER_ID = "container-123";
const SESSION_ID = "session-1";
const SESSION_KEY = createClaudeSessionKey(ENV_ID, "build-tab");

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

function seedPipelineWithBuildSession(phase: "building" | "paused", sessionStatus: "running" | "idle") {
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
          phase,
          sessions: [
            {
              phase: "build" as const,
              iteration: 0,
              sessionKey: SESSION_KEY,
              sdkSessionId: SESSION_ID,
              status: sessionStatus,
              startedAt: "2026-06-22T00:00:00.000Z",
              label: "Build Session",
            },
          ],
          currentSessionIndex: 0,
          iteration: 0,
          maxIterations: 3,
          createdAt: "2026-06-22T00:00:00.000Z",
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

function seedClaudeReviewPipeline(phase: "reviewing" | "addressing" = "reviewing") {
  seedPipelineWithBuildSession("building", "running");
  useBuildPipelineStore.setState((state) => {
    const pipelines = new Map(state.pipelines);
    const pipeline = pipelines.get(PIPELINE_ID)!;
    pipelines.set(PIPELINE_ID, {
      ...pipeline,
      phase,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          phase: "review",
          label: "Review Session",
        },
      ],
    });
    return { pipelines };
  });
  seedClaudeSession(false);
}

function seedClaudePrPipeline(phase: "creating-pr" | "resolving-conflicts" = "creating-pr") {
  seedPipelineWithBuildSession("building", "running");
  useBuildPipelineStore.setState((state) => {
    const pipelines = new Map(state.pipelines);
    const pipeline = pipelines.get(PIPELINE_ID)!;
    pipelines.set(PIPELINE_ID, {
      ...pipeline,
      phase,
      sessions: [
        {
          ...pipeline.sessions[0]!,
          phase: phase === "creating-pr" ? "pr" : "resolve-conflicts",
          label: phase === "creating-pr" ? "PR Creation Session" : "Conflict Resolution Session",
        },
      ],
    });
    return { pipelines };
  });
  seedClaudeSession(false);
}

function seedClaudeSession(isLoading: boolean) {
  useClaudeStore.setState({
    clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
    serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: SESSION_ID,
          messages: [],
          isLoading,
        },
      ],
    ]),
  });
}

function setClaudeBuildMessages(messages: ClaudeMessage[]) {
  useClaudeStore.setState((state) => ({
    sessions: new Map(state.sessions).set(SESSION_KEY, {
      sessionId: SESSION_ID,
      messages,
      isLoading: false,
    }),
  }));
}

function seedClaudeVerifyPipeline(
  feedback: string,
  options: { complete: boolean; iteration?: number; maxIterations?: number },
) {
  const iteration = options.iteration ?? 0;
  const verificationMessage: ClaudeMessage = {
    id: "verification-message",
    role: "assistant",
    content: JSON.stringify({ complete: options.complete, rationale: feedback }),
    parts: [{ type: "text", content: JSON.stringify({ complete: options.complete, rationale: feedback }) }],
    timestamp: "2026-06-22T00:00:01.000Z",
  };
  seedPipelineWithBuildSession("building", "running");
  useBuildPipelineStore.setState((state) => {
    const pipelines = new Map(state.pipelines);
    const pipeline = pipelines.get(PIPELINE_ID)!;
    pipelines.set(PIPELINE_ID, {
      ...pipeline,
      phase: "verifying",
      iteration,
      maxIterations: options.maxIterations ?? 3,
      sessions: [{ ...pipeline.sessions[0]!, phase: "verify", iteration, label: "Verification Session" }],
    });
    return { pipelines };
  });
  seedClaudeSession(false);
  setClaudeBuildMessages([verificationMessage]);
  mockGetSessionMessages.mockResolvedValue([verificationMessage]);
}

function expectTextOrder(...labels: string[]) {
  const text = document.body.textContent ?? "";
  const positions = labels.map((label) => text.indexOf(label));
  expect(positions.every((position) => position >= 0)).toBe(true);
  for (let index = 1; index < positions.length; index += 1) {
    expect(positions[index - 1]!).toBeLessThan(positions[index]!);
  }
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
    ...realKanbanActions,
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
    mockDetectPr.mockClear();
    mockDetectPrLocal.mockClear();
    mockCreateClient.mockClear();
    mockCheckHealth.mockClear();
    mockGetModels.mockClear();
    mockSubscribeToEvents.mockClear();
    mockCreateSession.mockClear();
    mockGetSessionMessages.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();

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
    mockGetSessionMessages.mockImplementation(() => Promise.resolve([]));
    mockSendPrompt.mockImplementation(() => Promise.resolve(true));
    mockAbortSession.mockImplementation(() => Promise.resolve(true));
    mockDetectPr.mockImplementation(() => Promise.resolve(null));
    mockDetectPrLocal.mockImplementation(() => Promise.resolve(null));
  });

  afterEach(() => {
    cleanup();
  });

  test.each([
    ["codex", "Codex"],
    ["opencode", "OpenCode"],
  ] as const)("routes %s pipelines through the lazy build runner", (agentType, label) => {
    seedPipeline("waiting-for-setup");
    seedEnvironment({ workspaceReady: false });
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          agentType,
        }),
      };
    });

    render(<BuildChatTab data={createContainerBuildData()} isActive />);

    expect(screen.getByText(`Loading ${label} build runner...`)).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Setup gating
  // -----------------------------------------------------------------------

  test("does not mutate Kanban when a Linear-backed pipeline phase changes", async () => {
    const moveTaskMock = mock(async () => undefined);
    const addCommentMock = mock(async () => undefined);

    seedPipeline("waiting-for-setup");
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID);
      if (!pipeline) return state;
      const pipelines = new Map(state.pipelines);
      pipelines.set(PIPELINE_ID, {
        ...pipeline,
        source: {
          type: "linear",
          issueId: "issue-1",
          issueIdentifier: "ENG-123",
        },
      });
      return { pipelines };
    });
    useKanbanStore.setState({
      moveTask: moveTaskMock as unknown as ReturnType<typeof useKanbanStore.getState>["moveTask"],
      addComment: addCommentMock as unknown as ReturnType<typeof useKanbanStore.getState>["addComment"],
    });
    seedEnvironment({ isLocal: true, workspaceReady: true });

    render(<BuildChatTab data={createLocalBuildData()} isActive />);

    await act(async () => {
      useBuildPipelineStore.getState().setPhase(PIPELINE_ID, "building");
      await Promise.resolve();
    });

    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("building");
    expect(moveTaskMock).not.toHaveBeenCalled();
    expect(addCommentMock).not.toHaveBeenCalled();
  });

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

    test("reconnect action retries initialization after a connection failure", async () => {
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      useEnvironmentStore.setState({
        environments: [
          {
            ...useEnvironmentStore.getState().environments[0]!,
            containerId: null,
          },
        ],
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      expect(await screen.findByText("Connection Failed")).toBeTruthy();

      useEnvironmentStore.setState({
        environments: [
          {
            ...useEnvironmentStore.getState().environments[0]!,
            containerId: CONTAINER_ID,
          },
        ],
      });
      mockGetClaudeServerStatus.mockClear();
      mockStartClaudeServer.mockClear();
      mockCreateClient.mockClear();

      fireEvent.click(screen.getByText("Reconnect now"));

      await waitFor(() => {
        expect(mockGetClaudeServerStatus).toHaveBeenCalledWith(CONTAINER_ID);
      });
      expect(mockStartClaudeServer).toHaveBeenCalledWith(CONTAINER_ID);
      expect(mockCreateClient).toHaveBeenCalled();
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

    test("shows Resume button when paused", async () => {
      seedPipeline("paused");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      // Pre-set client so the warm-path initialization succeeds
      useClaudeStore.setState({
        clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
        serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(screen.getByText("Resume")).toBeTruthy();
      });
    });

    test("stopping a running Claude pipeline pauses before abort finishes", async () => {
      let resolveAbort: ((value: boolean) => void) | undefined;
      mockAbortSession.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => {
          resolveAbort = resolve;
        }),
      );
      seedPipelineWithBuildSession("building", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      fireEvent.click(await screen.findByText("Stop"));

      await waitFor(() => {
        expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("paused");
      });

      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.error).toBeUndefined();
      expect(mockAbortSession).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:9999" }, SESSION_ID);
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
      expect(await screen.findByText("Resume")).toBeTruthy();
      resolveAbort?.(true);
    });

    test("resuming after stop during Claude session creation starts the intended build stage", async () => {
      let resolveCreate: ((value: { sessionId: string }) => void) | undefined;
      mockCreateSession.mockImplementationOnce(
        () => new Promise<{ sessionId: string }>((resolve) => {
          resolveCreate = resolve;
        }),
      );
      mockGetClaudeServerStatus.mockImplementation(() =>
        Promise.resolve({ running: true, hostPort: 9999 } as any)
      );
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Stop")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Stop"));

      await waitFor(() => {
        expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("paused");
      });

      await act(async () => {
        resolveCreate?.({ sessionId: "late-session" });
      });

      await waitFor(() => {
        expect(mockAbortSession).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:9999" }, "late-session");
      });
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions).toHaveLength(0);

      fireEvent.click(await screen.findByText("Resume"));

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledTimes(2);
        expect(mockSendPrompt).toHaveBeenCalledWith(
          { baseUrl: "http://127.0.0.1:9999" },
          SESSION_ID,
          expect.stringContaining("Test task"),
          {
            permissionMode: "bypassPermissions",
            attachments: undefined,
          },
        );
      });
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions[0]?.phase).toBe("build");
    });

    test("resuming a paused pipeline continues the stopped Claude stage", async () => {
      seedPipelineWithBuildSession("paused", "idle");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      fireEvent.click(await screen.findByText("Resume"));

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          { baseUrl: "http://127.0.0.1:9999" },
          SESSION_ID,
          expect.stringContaining("Resume the build pipeline from where you left off"),
          {
            permissionMode: "bypassPermissions",
          },
        );
      });

      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("building");
      expect(pipeline?.sessions[0]?.status).toBe("running");
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages.at(-1)?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    test("failed Claude resume returns the pipeline to paused", async () => {
      seedPipelineWithBuildSession("paused", "idle");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);
      mockSendPrompt.mockImplementationOnce(() => Promise.resolve(false));

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      fireEvent.click(await screen.findByText("Resume"));

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("paused");
        expect(pipeline?.sessions[0]?.status).toBe("idle");
      });

      const session = useClaudeStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(false);
      expect(session?.messages.at(-1)?.content).toBe("Failed to resume build pipeline");
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

    test("sends a trimmed jump-in message on Enter but not Shift+Enter", async () => {
      seedPipelineWithBuildSession("paused", "idle");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      const textarea = await screen.findByPlaceholderText("Send a message to the agent...");
      fireEvent.change(textarea, { target: { value: "  inspect the edge case  " } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
      expect(mockSendPrompt).not.toHaveBeenCalled();

      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          { baseUrl: "http://127.0.0.1:9999" },
          SESSION_ID,
          "inspect the edge case",
          { permissionMode: "bypassPermissions" },
        );
      });
      expect((textarea as HTMLTextAreaElement).value).toBe("");
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages.at(-1)?.content).toBe(
        "inspect the edge case",
      );
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    });

    test("restores the paused session to idle and surfaces an error when jump-in send fails", async () => {
      mockSendPrompt.mockResolvedValueOnce(false);
      seedPipelineWithBuildSession("paused", "idle");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      const textarea = await screen.findByPlaceholderText("Send a message to the agent...");
      fireEvent.change(textarea, { target: { value: "retry this" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.sessions[0]?.status).toBe("idle");
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages.at(-1)?.content).toBe(
          "Failed to send message to the agent",
        );
      });
    });

    test("aborts an in-flight jump-in message", async () => {
      seedPipelineWithBuildSession("paused", "idle");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      const textarea = await screen.findByPlaceholderText("Send a message to the agent...");
      fireEvent.change(textarea, { target: { value: "long-running request" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
      });
      const stopButton = document.querySelector("button.h-9.w-9");
      expect(stopButton).toBeTruthy();
      fireEvent.click(stopButton!);

      await waitFor(() => {
        expect(mockAbortSession).toHaveBeenCalledWith(
          { baseUrl: "http://127.0.0.1:9999" },
          SESSION_ID,
        );
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
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

  test("pins active Claude build agents below later messages and releases them on success", async () => {
    seedPipelineWithBuildSession("building", "running");
    seedEnvironment({ isLocal: false, workspaceReady: true });
    seedClaudeSession(false);

    const activeMessage: ClaudeMessage = {
      id: "assistant-agent",
      role: "assistant",
      content: "",
      timestamp: "2026-06-22T00:00:01.000Z",
      parts: [
        { type: "text", content: "Parent started" },
        {
          type: "tool-invocation",
          toolName: "Agent",
          content: "Run worker",
          toolUseId: "agent-1",
          toolState: "pending",
          toolArgs: { description: "Build worker" },
        },
        { type: "text", content: "Parent continued" },
      ],
    };
    const laterMessage: ClaudeMessage = {
      id: "assistant-later",
      role: "assistant",
      content: "Later response",
      timestamp: "2026-06-22T00:00:30.000Z",
      parts: [{ type: "text", content: "Later response" }],
    };
    setClaudeBuildMessages([activeMessage, laterMessage]);
    mockGetSessionMessages.mockImplementation(async () => [activeMessage, laterMessage]);

    render(<BuildChatTab data={createContainerBuildData()} isActive />);

    await waitFor(() => {
      expectTextOrder("Parent started", "Later response", "Build worker");
    });

    const completedMessage: ClaudeMessage = {
      ...activeMessage,
      parts: activeMessage.parts.map((part) =>
        part.type === "tool-invocation"
          ? { ...part, toolState: "success" as const }
          : part
      ),
    };

    act(() => {
      setClaudeBuildMessages([completedMessage, laterMessage]);
    });

    await waitFor(() => {
      expectTextOrder("Parent started", "Build worker", "Parent continued", "Later response");
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

  // -----------------------------------------------------------------------
  // Event stream disconnection
  // -----------------------------------------------------------------------

  describe("event stream disconnection", () => {
    test("refreshes messages and records context usage from session events", async () => {
      const refreshedMessage: ClaudeMessage = {
        id: "refreshed-message",
        role: "assistant",
        content: "Fresh response",
        parts: [{ type: "text", content: "Fresh response" }],
        timestamp: "2026-06-22T00:00:01.000Z",
      };
      mockGetSessionMessages.mockResolvedValueOnce([refreshedMessage]);
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield {
            type: "session.updated",
            sessionId: SESSION_ID,
            data: {
              model: "anthropic/claude-sonnet",
              contextUsage: { usedTokens: 2_500, totalContextTokens: 10_000 },
            },
          } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "idle");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
          refreshedMessage,
        ]);
        expect(useClaudeStore.getState().contextUsage.get(SESSION_KEY)).toEqual({
          usedTokens: 2_500,
          totalTokens: 10_000,
          percentUsed: 25,
          modelId: "anthropic/claude-sonnet",
        });
      });
    });

    test("turns a session error event into an idle error message", async () => {
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield {
            type: "session.error",
            sessionId: SESSION_ID,
            data: { error: "tool execution failed" },
          } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const session = useClaudeStore.getState().sessions.get(SESSION_KEY);
        expect(session?.isLoading).toBe(false);
        expect(session?.messages.at(-1)?.content).toBe("tool execution failed");
        expect(session?.messages.at(-1)?.id.startsWith("[ERROR]")).toBe(true);
      });
    });

    test("event subscription failure surfaces the error screen with reconnect controls", async () => {
      // Init succeeds (cached client + healthy), then the SSE subscription
      // throws, simulating the bridge dropping the stream mid-run.
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          throw new Error("bridge connection lost");
        })()
      );
      seedPipelineWithBuildSession("building", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      expect(await screen.findByText("Connection Failed")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reconnect now" })).toBeTruthy();
      // Running pipeline → Stop overlay is available on the error screen, but the
      // redundant top-right Reconnect is not (the centered one covers it).
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    });

    test("does not show the error screen when the subscription is aborted intentionally", async () => {
      // A normal teardown aborts the subscription; the catch is abort-gated, so
      // no false "Connection Failed" should appear.
      seedPipelineWithBuildSession("building", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      // Wait for the connected view to settle, then confirm no error UI.
      await waitFor(() => {
        expect(mockSubscribeToEvents).toHaveBeenCalled();
      });
      expect(screen.queryByText("Connection Failed")).toBeNull();
    });

    test("shows an inline reconnect button when the event stream ends while running", async () => {
      // The default subscribeToEvents mock returns an immediately-completed
      // stream, so the shared subscription ends and hasActiveEventSubscription()
      // flips false while the pipeline is still running.
      seedPipelineWithBuildSession("building", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      // Inline header Reconnect (distinct from the full-screen "Reconnect now").
      expect(await screen.findByRole("button", { name: "Reconnect" })).toBeTruthy();
      // Still in the connected chat view, not the error screen.
      expect(screen.queryByText("Connection Failed")).toBeNull();
    });
  });

  describe("automatic phase advancement", () => {
    test("maps task images to WebP Claude attachments for the initial build prompt", async () => {
      seedPipeline("waiting-for-setup");
      useBuildPipelineStore.setState((state) => {
        const pipelines = new Map(state.pipelines);
        const pipeline = pipelines.get(PIPELINE_ID)!;
        pipelines.set(PIPELINE_ID, {
          ...pipeline,
          taskSnapshot: {
            ...pipeline.taskSnapshot,
            images: [{ filename: "wireframe.png", data: "YWJjMTIz" }],
          },
        });
        return { pipelines };
      });
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          { baseUrl: "http://127.0.0.1:9999" },
          SESSION_ID,
          expect.stringContaining("Test task"),
          {
            permissionMode: "bypassPermissions",
            attachments: [
              {
                type: "image",
                path: "wireframe.png",
                filename: "wireframe.png",
                dataUrl: "data:image/webp;base64,YWJjMTIz",
              },
            ],
          },
        );
      });
    });

    test("advances an idle build session into review", async () => {
      seedPipelineWithBuildSession("building", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("reviewing");
        expect(pipeline?.sessions.at(-1)?.phase).toBe("review");
      });
      expect(mockSendPrompt).toHaveBeenCalledWith(
        expect.anything(),
        SESSION_ID,
        expect.stringContaining("review"),
        expect.objectContaining({ permissionMode: "bypassPermissions" }),
      );
    });

    test("fails the pipeline when review-session creation rejects", async () => {
      mockCreateSession.mockImplementationOnce(() =>
        Promise.reject(new Error("review bridge unavailable")),
      );
      seedPipelineWithBuildSession("building", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(false);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("failed");
        expect(pipeline?.error).toBe("Failed to create review session");
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("dispatches the shared safely-scoped address-issues prompt when review becomes idle", async () => {
      let resolvePrompt: ((value: boolean) => void) | undefined;
      mockSendPrompt.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolvePrompt = resolve;
          }),
      );
      seedClaudeReviewPipeline();
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          { baseUrl: "http://127.0.0.1:9999" },
          SESSION_ID,
          createAddressIssuesPrompt(),
          { permissionMode: "bypassPermissions" },
        );
      });

      const prompt = createAddressIssuesPrompt();
      expect(prompt).toContain(
        "Stage only files that clearly belong to the review fixes and test coverage changes you made",
      );
      expect(prompt).toContain("Do NOT add secrets, credentials, `.env*` files");
      expect(prompt).toContain("leave them uncommitted and report them");

      await act(async () => {
        resolvePrompt?.(true);
      });
    });

    test("keeps the successful address-issues follow-up in the review session until it idles", async () => {
      seedClaudeReviewPipeline();
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("addressing");
        expect(pipeline?.sessions).toHaveLength(1);
        expect(pipeline?.sessions[0]?.phase).toBe("review");
        expect(pipeline?.sessions[0]?.status).toBe("running");
      });

      const reviewSession = useClaudeStore.getState().sessions.get(SESSION_KEY);
      expect(reviewSession?.isLoading).toBe(true);
      expect(reviewSession?.messages.at(-1)?.content).toBe(createAddressIssuesPrompt());
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    test("fails the pipeline when the address-issues follow-up is rejected", async () => {
      mockSendPrompt.mockResolvedValueOnce(false);
      seedClaudeReviewPipeline();
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("failed");
        expect(pipeline?.error).toBe("Failed to send address issues prompt");
      });
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    test("starts verification after the addressing review session idles", async () => {
      mockCreateSession.mockResolvedValueOnce({ sessionId: "verify-session" });
      seedClaudeReviewPipeline("addressing");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("verifying");
        expect(pipeline?.sessions.at(-1)?.phase).toBe("verify");
        expect(pipeline?.sessions.at(-1)?.sdkSessionId).toBe("verify-session");
      });
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendPrompt).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        "verify-session",
        expect.stringContaining("Verify the changes"),
        expect.objectContaining({ permissionMode: "bypassPermissions" }),
      );
    });

    test("fails the pipeline when verification-session creation fails", async () => {
      mockCreateSession.mockImplementationOnce(() =>
        Promise.reject(new Error("verification bridge unavailable")),
      );
      seedClaudeReviewPipeline("addressing");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("failed");
        expect(pipeline?.error).toBe("Failed to create verification session");
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    test("fails the pipeline when the verification prompt is rejected", async () => {
      mockCreateSession.mockResolvedValueOnce({ sessionId: "verify-session" });
      mockSendPrompt.mockResolvedValueOnce(false);
      seedClaudeReviewPipeline("addressing");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("failed");
        expect(pipeline?.error).toBe("Failed to send verification prompt");
      });
      expect(
        useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions.at(-1)?.phase,
      ).toBe("verify");
    });

    test("starts PR creation after successful verification", async () => {
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeVerifyPipeline("All acceptance criteria are satisfied", { complete: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("creating-pr");
        expect(pipeline?.verificationResult).toBe("pass");
        expect(pipeline?.sessions.at(-1)?.phase).toBe("pr");
      });
    });

    test("starts a fix session after failed verification below the iteration limit", async () => {
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeVerifyPipeline("Tests still fail", { complete: false, iteration: 0, maxIterations: 3 });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("fixing");
        expect(pipeline?.verificationResult).toBe("fail");
        expect(pipeline?.iteration).toBe(1);
        expect(pipeline?.sessions.at(-1)?.phase).toBe("fix");
      });
    });

    test("fails verification at the maximum iteration", async () => {
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeVerifyPipeline("Still incomplete", { complete: false, iteration: 3, maxIterations: 3 });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("failed");
        expect(pipeline?.error).toContain("Max iterations (3) reached");
      });
    });

    test("detects PR conflicts and starts a conflict-resolution session", async () => {
      mockDetectPr.mockResolvedValueOnce({
        url: "https://example.test/pull/42",
        state: "open",
        hasMergeConflicts: true,
      });
      mockCreateSession.mockResolvedValueOnce({ sessionId: "conflict-session" });
      seedClaudePrPipeline();
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("resolving-conflicts");
        expect(pipeline?.sessions.at(-1)?.phase).toBe("resolve-conflicts");
      });
      expect(mockDetectPr).toHaveBeenCalledWith(CONTAINER_ID, "feat/test");
      expect(useEnvironmentStore.getState().environments[0]).toMatchObject({
        prUrl: "https://example.test/pull/42",
        prState: "open",
        hasMergeConflicts: true,
      });
      expect(mockSendPrompt).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        "conflict-session",
        expect.stringContaining("merge conflict"),
        { permissionMode: "bypassPermissions" },
      );
    });

    test("completes PR creation when conflict detection reports no conflicts", async () => {
      mockDetectPr.mockResolvedValueOnce({
        url: "https://example.test/pull/43",
        state: "open",
        hasMergeConflicts: false,
      });
      seedClaudePrPipeline();
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("complete");
      });
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    test("fails when conflicts remain after a conflict-resolution session", async () => {
      mockDetectPr.mockResolvedValueOnce({
        url: "https://example.test/pull/44",
        state: "open",
        hasMergeConflicts: true,
      });
      seedClaudePrPipeline("resolving-conflicts");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("failed");
        expect(pipeline?.error).toBe("Merge conflicts could not be fully resolved automatically");
      });
    });

    test("completes when conflict detection confirms the resolution succeeded", async () => {
      mockDetectPr.mockResolvedValueOnce({
        url: "https://example.test/pull/45",
        state: "open",
        hasMergeConflicts: false,
      });
      seedClaudePrPipeline("resolving-conflicts");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("complete");
      });
      expect(mockDetectPr).toHaveBeenCalledWith(CONTAINER_ID, "feat/test");
    });
  });
});
