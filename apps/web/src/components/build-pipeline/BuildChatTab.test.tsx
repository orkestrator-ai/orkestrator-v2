import { createSessionKey } from "@/lib/utils";
import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  TEST_CLEAN_STRUCTURED_REVIEW_OUTPUT,
  TEST_LEGACY_STRUCTURED_REVIEW_REPORT,
  TEST_STRUCTURED_REVIEW_OUTPUT,
  TEST_STRUCTURED_REVIEW_REPORT,
} from "./structured-review-test-fixture";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the component under test
// ---------------------------------------------------------------------------

// backend commands
const CLAUDE_AUTH_TOKEN = "claude-build-secret";
const mockStartClaudeServer = mock(() =>
  Promise.resolve({ hostPort: 9999, authToken: CLAUDE_AUTH_TOKEN })
);
const mockGetClaudeServerStatus = mock(() =>
  Promise.resolve({ running: false, hostPort: null, authToken: undefined })
);
const mockStartLocalClaudeServer = mock(() =>
  Promise.resolve({ port: 8888, pid: 1234, authToken: CLAUDE_AUTH_TOKEN })
);
const mockGetLocalClaudeServerStatus = mock(() =>
  Promise.resolve({ running: false, port: null, pid: null, authToken: undefined })
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
const mockCreateClient = mock((baseUrl: string, authToken?: string) => ({
  baseUrl,
  authToken,
}));
const mockCheckHealth = mock(() => Promise.resolve(true));
const mockGetModels = mock(() => Promise.resolve([]));
const mockSubscribeToEvents = mock(() => (async function* () {})());
const mockCreateSession = mock(() => Promise.resolve({ sessionId: "session-1" }));
const mockGetSession = mock(() => Promise.resolve({
  id: SESSION_ID,
  title: "Build Session",
  status: "idle" as const,
  createdAt: "2026-06-22T00:00:00.000Z",
  lastActivity: "2026-06-22T00:00:01.000Z",
}));
const mockGetSessionMessages = mock(() => Promise.resolve([] as ClaudeMessage[]));
const mockGetPendingQuestions = mock(() => Promise.resolve([]));
const mockGetPendingPlanApprovals = mock(() => Promise.resolve([]));
const mockSendPrompt = mock(() => Promise.resolve(true));
const mockAbortSession = mock(() => Promise.resolve(true));
const mockGetStructuredOutput = mock(() =>
  Promise.resolve(TEST_STRUCTURED_REVIEW_OUTPUT)
);

mock.module("@/lib/claude-client", () => ({
  createClient: mockCreateClient,
  checkHealth: mockCheckHealth,
  getModels: mockGetModels,
  createSession: mockCreateSession,
  getSession: mockGetSession,
  getSessionMessages: mockGetSessionMessages,
  getPendingQuestions: mockGetPendingQuestions,
  getPendingPlanApprovals: mockGetPendingPlanApprovals,
  sendPrompt: mockSendPrompt,
  abortSession: mockAbortSession,
  getStructuredOutput: mockGetStructuredOutput,
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

import {useClaudeStore} from "@/stores/claudeStore";
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
const SESSION_KEY = createSessionKey(ENV_ID, "build-tab");

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
          backendRevision: 0,
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
          backendRevision: 0,
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

/**
 * A review round that completed on the provider but failed the transition into
 * the next phase, with the durable request id recorded and no report consumed
 * yet — the state "Retry Review" is allowed to recover from.
 */
function seedFailedClaudeReviewTransition(requestId: string) {
  seedClaudeReviewPipeline();
  useBuildPipelineStore.setState((state) => {
    const pipelines = new Map(state.pipelines);
    const pipeline = pipelines.get(PIPELINE_ID)!;
    pipelines.set(PIPELINE_ID, {
      ...pipeline,
      phase: "failed",
      error:
        "Invalid structured-review-report: 1 validation issue. $.testResults.notRun: Required field \"notRun\" is missing.",
      structuredReviewRequestId: requestId,
      failureContext: {
        phase: "reviewing",
        kind: "stage-transition",
      },
      sessions: pipeline.sessions.map((session) => ({
        ...session,
        status: "idle" as const,
      })),
    });
    return { pipelines };
  });
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
      backendRevision: 0,
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
    mockGetSession.mockClear();
    mockGetSessionMessages.mockClear();
    mockGetPendingQuestions.mockClear();
    mockGetPendingPlanApprovals.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();
    mockGetStructuredOutput.mockClear();

    // Reset default implementations
    mockGetClaudeServerStatus.mockImplementation(() =>
      Promise.resolve({ running: false, hostPort: null, authToken: undefined })
    );
    mockStartClaudeServer.mockImplementation(() =>
      Promise.resolve({ hostPort: 9999, authToken: CLAUDE_AUTH_TOKEN })
    );
    mockGetLocalClaudeServerStatus.mockImplementation(() =>
      Promise.resolve({ running: false, port: null, pid: null, authToken: undefined })
    );
    mockStartLocalClaudeServer.mockImplementation(() =>
      Promise.resolve({ port: 8888, pid: 1234, authToken: CLAUDE_AUTH_TOKEN })
    );
    mockCheckHealth.mockImplementation(() => Promise.resolve(true));
    mockGetModels.mockImplementation(() => Promise.resolve([]));
    mockGetSession.mockImplementation(() => Promise.resolve({
      id: SESSION_ID,
      title: "Build Session",
      status: "idle" as const,
      createdAt: "2026-06-22T00:00:00.000Z",
      lastActivity: "2026-06-22T00:00:01.000Z",
    }));
    mockGetSessionMessages.mockImplementation(() => Promise.resolve([]));
    mockGetPendingQuestions.mockImplementation(() => Promise.resolve([]));
    mockGetPendingPlanApprovals.mockImplementation(() => Promise.resolve([]));
    mockSendPrompt.mockImplementation(() => Promise.resolve(true));
    mockAbortSession.mockImplementation(() => Promise.resolve(true));
    mockGetStructuredOutput.mockImplementation(() =>
      Promise.resolve(TEST_STRUCTURED_REVIEW_OUTPUT)
    );
    mockDetectPr.mockImplementation(() => Promise.resolve(null));
    mockDetectPrLocal.mockImplementation(() => Promise.resolve(null));
  });

  afterEach(() => {
    cleanup();
  });

  test("renders a friendly catalog label for the build assistant's confirmed model", async () => {
    const catalogModel = {
      id: "sonnet",
      resolvedModel: "claude-sonnet-5",
      name: "Claude Sonnet",
    };
    const assistantMessage: ClaudeMessage = {
      id: "assistant-with-model",
      role: "assistant",
      content: "Catalog-attributed build response",
      parts: [{ type: "text", content: "Catalog-attributed build response" }],
      timestamp: "2026-07-28T12:00:00.000Z",
      modelId: "claude-sonnet-5",
    };
    seedPipelineWithBuildSession("paused", "idle");
    seedEnvironment({ workspaceReady: true });
    seedClaudeSession(false);
    setClaudeBuildMessages([assistantMessage]);
    mockGetModels.mockResolvedValue([catalogModel] as any);
    mockGetSessionMessages.mockResolvedValue([assistantMessage]);
    useClaudeStore.setState({
      models: [catalogModel],
      modelCatalogs: new Map([
        [
          ENV_ID,
          {
            environmentId: ENV_ID,
            models: [catalogModel],
            source: "sdk",
            fetchedAt: "2026-07-28T12:00:00.000Z",
            stale: false,
          },
        ],
      ]),
    });

    render(<BuildChatTab data={createContainerBuildData()} isActive />);

    expect(await screen.findByTitle("Claude Sonnet")).toBeTruthy();
    expect(screen.queryByText("claude-sonnet-5")).toBeNull();
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
    test("refetches the transcript for incremental part patches", async () => {
      // This tab never applies an event payload, it refetches. The bridge
      // sends one full frame per message and patches the rest of the turn, so
      // ignoring patches would freeze the build transcript mid-turn and only
      // let it catch up at session.idle.
      const queue: unknown[] = [];
      let closed = false;
      let wake: () => void = () => {};
      let wakePromise = new Promise<void>((resolve) => {
        wake = resolve;
      });
      mockSubscribeToEvents.mockImplementation(() =>
        (async function* () {
          while (!closed) {
            if (queue.length === 0) await wakePromise;
            while (queue.length > 0) yield queue.shift() as never;
          }
        })(),
      );

      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      try {
        render(<BuildChatTab data={createContainerBuildData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

        // The pipeline creates its session lazily once a stage runs; seed one
        // so the event loop has a session to match this frame against.
        act(() => {
          useClaudeStore.getState().setSession(SESSION_KEY, {
            sessionId: SESSION_ID,
            messages: [],
            isLoading: true,
          });
        });
        mockGetSessionMessages.mockClear();

        queue.push({
          type: "message.patched",
          sessionId: SESSION_ID,
          data: {
            messageId: "assistant-1",
            partCount: 1,
            changedParts: [{ index: 0, part: { type: "text", content: "streaming" } }],
            timestamp: "2026-07-20T12:00:00.000Z",
            revision: 2,
          },
        });
        wake();
        wakePromise = new Promise<void>((resolve) => {
          wake = resolve;
        });

        await waitFor(() => {
          expect(mockGetSessionMessages).toHaveBeenCalled();
        });
      } finally {
        closed = true;
        wake();
        useClaudeStore.getState().closeEventSubscription(ENV_ID);
        // `mockClear` in beforeEach resets calls but not implementations, so
        // this stream would otherwise be handed to every later test.
        mockSubscribeToEvents.mockImplementation(() => (async function* () {})());
      }
    });

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
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:9999",
        CLAUDE_AUTH_TOKEN,
      );
    });

    test("reuses existing server if already running", async () => {
      mockGetClaudeServerStatus.mockImplementation(() =>
        Promise.resolve({
          running: true,
          hostPort: 7777,
          authToken: CLAUDE_AUTH_TOKEN,
        } as any)
      );
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetClaudeServerStatus).toHaveBeenCalledWith(CONTAINER_ID);
      });

      // Should NOT try to start a new server
      expect(mockStartClaudeServer).not.toHaveBeenCalled();
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:7777",
        CLAUDE_AUTH_TOKEN,
      );
    });

    test("restarts a reachable tokenless server instead of reusing it", async () => {
      mockGetClaudeServerStatus.mockResolvedValue({
        running: true,
        hostPort: 7777,
        authToken: undefined,
      } as any);
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockStartClaudeServer).toHaveBeenCalledWith(CONTAINER_ID);
      });
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:9999",
        CLAUDE_AUTH_TOKEN,
      );
    });

    test("fails closed when startup cannot provide a bridge token", async () => {
      mockStartClaudeServer.mockResolvedValue({
        hostPort: 9999,
        authToken: undefined,
      } as any);
      seedPipeline("waiting-for-setup");
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      expect(await screen.findByText("Connection Failed")).toBeTruthy();
      expect(mockCreateClient).not.toHaveBeenCalled();
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
      expect(mockCreateClient).toHaveBeenCalledWith(
        "http://127.0.0.1:8888",
        CLAUDE_AUTH_TOKEN,
      );
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
        Promise.resolve({
          running: true,
          hostPort: 9999,
          authToken: CLAUDE_AUTH_TOKEN,
        } as any)
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
        expect(mockAbortSession).toHaveBeenCalledWith(
          expect.objectContaining({ baseUrl: "http://127.0.0.1:9999" }),
          "late-session",
        );
      });
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions).toHaveLength(0);

      fireEvent.click(await screen.findByText("Resume"));

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledTimes(2);
        expect(mockSendPrompt).toHaveBeenCalledWith(
          expect.objectContaining({ baseUrl: "http://127.0.0.1:9999" }),
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

    test("resuming a paused Claude review starts a fresh constrained review request", async () => {
      seedClaudeReviewPipeline();
      useBuildPipelineStore.setState((state) => {
        const pipeline = state.pipelines.get(PIPELINE_ID)!;
        return {
          pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
            ...pipeline,
            phase: "paused",
            pausedFromPhase: "reviewing",
            structuredReviewRequestId: "stale-review-request",
            sessions: pipeline.sessions.map((session) => ({
              ...session,
              status: "idle" as const,
            })),
          }),
        };
      });
      mockCreateSession.mockResolvedValueOnce({ sessionId: "fresh-review-session" });
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);
      fireEvent.click(await screen.findByText("Resume"));

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          expect.anything(),
          "fresh-review-session",
          expect.stringContaining("provider-enforced output schema"),
          expect.objectContaining({
            outputSchema: expect.objectContaining({ type: "object" }),
            requestId: expect.any(String),
          }),
        );
      });
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.structuredReviewRequestId).not.toBe("stale-review-request");
      expect(pipeline?.sessions.at(-1)?.sdkSessionId).toBe("fresh-review-session");
    });

    test("hides a raw structured review carrier from the Claude build transcript", async () => {
      seedClaudeReviewPipeline();
      const rawReport = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
      useBuildPipelineStore.setState((state) => {
        const pipeline = state.pipelines.get(PIPELINE_ID)!;
        return {
          pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
            ...pipeline,
            phase: "paused",
            pausedFromPhase: "reviewing",
            sessions: pipeline.sessions.map((session) => ({
              ...session,
              status: "idle" as const,
            })),
          }),
        };
      });
      useClaudeStore.getState().setMessages(SESSION_KEY, [{
        id: "raw-structured-review",
        role: "assistant",
        content: rawReport,
        parts: [{ type: "text", content: rawReport }],
        timestamp: "2026-07-25T00:00:00.000Z",
      }]);
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      expect(await screen.findByText("Resume")).toBeTruthy();
      expect(document.body.textContent).not.toContain('"reviewScope"');
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
    test("authoritatively reconciles a replay gap and advances an idle build", async () => {
      const reconciledMessage: ClaudeMessage = {
        id: "reconciled-message",
        role: "assistant",
        content: "Build finished while the tab was away",
        parts: [{ type: "text", content: "Build finished while the tab was away" }],
        timestamp: "2026-06-22T00:00:01.000Z",
      };
      const pendingQuestion = {
        id: "question-live",
        sessionId: SESSION_ID,
        questions: [],
      };
      const pendingApproval = {
        id: "approval-live",
        sessionId: SESSION_ID,
      };
      mockGetSessionMessages.mockResolvedValueOnce([reconciledMessage]);
      mockGetPendingQuestions.mockResolvedValueOnce([pendingQuestion] as never);
      mockGetPendingPlanApprovals.mockResolvedValueOnce([pendingApproval] as never);
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield { type: "replay.required", data: {} } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("building", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);
      useClaudeStore.setState({
        pendingQuestions: new Map([[
          "question-stale",
          { id: "question-stale", sessionId: SESSION_ID, questions: [] } as never,
        ]]),
        pendingPlanApprovals: new Map([[
          "approval-stale",
          { id: "approval-stale", sessionId: SESSION_ID } as never,
        ]]),
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetSession).toHaveBeenCalledWith(
          { baseUrl: "http://127.0.0.1:9999" },
          SESSION_ID,
        );
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
          messages: [reconciledMessage],
          isLoading: false,
          title: "Build Session",
        });
        expect(useClaudeStore.getState().pendingQuestions.has("question-live")).toBe(true);
        expect(useClaudeStore.getState().pendingQuestions.has("question-stale")).toBe(false);
        expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-live")).toBe(true);
        expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-stale")).toBe(false);
      });

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.sessions[0]?.status).toBe("idle");
        expect(pipeline?.sessions.some((session) => session.phase === "review")).toBe(true);
      });
    });

    test("restores idle status when an optional interaction endpoint fails", async () => {
      const pendingApproval = {
        id: "approval-live",
        sessionId: SESSION_ID,
      };
      mockGetPendingQuestions.mockRejectedValueOnce(new Error("questions unavailable"));
      mockGetPendingPlanApprovals.mockResolvedValueOnce([pendingApproval] as never);
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield { type: "replay.required", data: {} } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);
      useClaudeStore.setState({
        pendingQuestions: new Map([[
          "question-preserved",
          { id: "question-preserved", sessionId: SESSION_ID, questions: [] } as never,
        ]]),
        pendingPlanApprovals: new Map([[
          "approval-stale",
          { id: "approval-stale", sessionId: SESSION_ID } as never,
        ]]),
      });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useClaudeStore.getState().pendingQuestions.has("question-preserved")).toBe(true);
        expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-live")).toBe(true);
        expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-stale")).toBe(false);
      });
    });

    test("waits for final reconciliation and ignores an older fallback response", async () => {
      let resolveFallback!: (messages: ClaudeMessage[]) => void;
      const fallback = new Promise<ClaudeMessage[]>((resolve) => {
        resolveFallback = resolve;
      });
      const authoritative: ClaudeMessage = {
        id: "authoritative",
        role: "assistant",
        content: "Final snapshot",
        parts: [{ type: "text", content: "Final snapshot" }],
        timestamp: "2026-06-22T00:00:02.000Z",
      };
      let call = 0;
      mockGetSessionMessages.mockImplementation(() => {
        call += 1;
        return call === 1 ? fallback : Promise.resolve([authoritative]);
      });
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield {
            type: "message.updated",
            sessionId: SESSION_ID,
            data: {},
          } as any;
          yield {
            type: "session.idle",
            sessionId: SESSION_ID,
            data: {},
          } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalledTimes(2);
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
          messages: [authoritative],
          isLoading: false,
        });
      });

      const stale: ClaudeMessage = {
        ...authoritative,
        id: "stale",
        content: "Stale fallback",
        parts: [{ type: "text", content: "Stale fallback" }],
      };
      resolveFallback([stale]);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages)
        .toEqual([authoritative]);
    });

    test("refreshes messages on session.idle and records context usage from session events", async () => {
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
          // Metadata-only frame: applied incrementally (usage), no refetch.
          yield {
            type: "session.updated",
            sessionId: SESSION_ID,
            data: {
              model: "anthropic/claude-sonnet",
              contextUsage: { usedTokens: 2_500, totalContextTokens: 10_000 },
            },
          } as any;
          // Final frame: the authoritative full-transcript reconcile.
          yield {
            type: "session.idle",
            sessionId: SESSION_ID,
            data: {},
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
        const usage = useClaudeStore.getState().contextUsage.get(SESSION_KEY);
        expect(usage).toEqual({
          usedTokens: 2_500,
          totalTokens: 10_000,
          percentUsed: 25,
          modelId: "anthropic/claude-sonnet",
          estimated: true,
          source: "heuristic",
          updatedAt: expect.any(String),
        });
        // `toEqual` ignores keys whose value is `undefined`, so it cannot catch a
        // field silently disappearing from the snapshot. Pin the key set too —
        // this is the shape the agent information panel renders from.
        expect(Object.keys(usage ?? {}).sort()).toEqual([
          "estimated",
          "modelId",
          "percentUsed",
          "source",
          "totalTokens",
          "updatedAt",
          "usedTokens",
        ]);
        expect(Number.isNaN(Date.parse(usage?.updatedAt ?? ""))).toBe(false);
      });
      // Only the final event refetched; the metadata frame was applied in place.
      expect(mockGetSessionMessages).toHaveBeenCalledTimes(1);
    });

    test("applies message.updated payloads in place and refetches only on unappliable patches", async () => {
      const streamedMessage: ClaudeMessage = {
        id: "streamed-message",
        role: "assistant",
        content: "Streamed via event payload",
        parts: [{ type: "text", content: "Streamed via event payload" }],
        timestamp: "2026-06-22T00:00:01.000Z",
        revision: 1,
      } as ClaudeMessage;
      const refetchedMessage: ClaudeMessage = {
        id: "streamed-message",
        role: "assistant",
        content: "Authoritative transcript",
        parts: [{ type: "text", content: "Authoritative transcript" }],
        timestamp: "2026-06-22T00:00:02.000Z",
        revision: 7,
      } as ClaudeMessage;
      mockGetSessionMessages.mockResolvedValue([refetchedMessage]);
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          // Full message payload: upserted directly, no refetch.
          yield {
            type: "message.updated",
            sessionId: SESSION_ID,
            data: { message: streamedMessage },
          } as any;
          // Patch that skips revisions: cannot apply, must refetch.
          yield {
            type: "message.patched",
            sessionId: SESSION_ID,
            data: {
              messageId: "streamed-message",
              partCount: 1,
              changedParts: [
                { index: 0, part: { type: "text", content: "lost frame" } },
              ],
              timestamp: "2026-06-22T00:00:03.000Z",
              revision: 5,
            },
          } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "idle");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        // The out-of-order patch forced exactly one authoritative refetch.
        expect(mockGetSessionMessages).toHaveBeenCalledTimes(1);
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
          refetchedMessage,
        ]);
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

    test("clears the spinner when the final transcript reconcile fails", async () => {
      // `getSessionMessages` rejects on any network-layer failure, so "the
      // bridge died right after emitting session.idle" lands here. The turn is
      // still over and no second `session.idle` will ever arrive, so gating the
      // loading flag on the refetch wedges the pipeline (it bails on isLoading)
      // until the user hits Stop.
      mockGetSessionMessages.mockRejectedValueOnce(new Error("bridge gone"));
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield {
            type: "session.idle",
            sessionId: SESSION_ID,
            data: {},
          } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalled();
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
      });
    });

    test("keeps dispatching frames for other sessions while a final reconcile is in flight", async () => {
      // The subscription is environment-wide: awaiting one session's transcript
      // inside the frame loop stalls every other session in the environment.
      const OTHER_SESSION_ID = "session-2";
      const OTHER_SESSION_KEY = createSessionKey(ENV_ID, "other-tab");
      let releaseTranscript!: (messages: ClaudeMessage[]) => void;
      const stalledTranscript = new Promise<ClaudeMessage[]>((resolve) => {
        releaseTranscript = resolve;
      });
      mockGetSessionMessages.mockImplementation(() => stalledTranscript);
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield {
            type: "session.idle",
            sessionId: SESSION_ID,
            data: {},
          } as any;
          yield {
            type: "session.error",
            sessionId: OTHER_SESSION_ID,
            data: { error: "second session failed" },
          } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);
      useClaudeStore.setState((state) => ({
        sessions: new Map(state.sessions).set(OTHER_SESSION_KEY, {
          sessionId: OTHER_SESSION_ID,
          messages: [],
          isLoading: true,
        }),
      }));

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const other = useClaudeStore.getState().sessions.get(OTHER_SESSION_KEY);
        expect(other?.isLoading).toBe(false);
        expect(other?.messages.at(-1)?.content).toBe("second session failed");
      });

      releaseTranscript([]);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    });

    test("appends the replay error bubble once across repeated replay gaps", async () => {
      // Error bubbles are client-only: they are never in the server transcript,
      // so de-duping against the fetched response always passes and every
      // replay appends another message carrying the same React key.
      mockGetSession.mockImplementation(() => Promise.resolve({
        id: SESSION_ID,
        title: "Build Session",
        status: "error",
        error: "bridge exploded",
        createdAt: "2026-06-22T00:00:00.000Z",
        lastActivity: "2026-06-22T00:00:02.000Z",
      } as never));
      mockSubscribeToEvents.mockImplementationOnce(() =>
        (async function* () {
          yield { type: "replay.required", data: {} } as any;
          yield { type: "replay.required", data: {} } as any;
        })() as unknown as AsyncGenerator<never, void, unknown>,
      );
      seedPipelineWithBuildSession("paused", "running");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      seedClaudeSession(true);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        expect(mockGetSession).toHaveBeenCalledTimes(2);
        expect(mockGetSessionMessages).toHaveBeenCalledTimes(2);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      const messages = useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      const errorMessages = messages.filter((message) => message.id.startsWith("[ERROR]"));
      expect(errorMessages).toHaveLength(1);
      expect(errorMessages[0]?.content).toBe("bridge exploded");
      // Duplicate ids are duplicate React keys in the rendered transcript.
      expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
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
          createAddressIssuesPrompt(TEST_STRUCTURED_REVIEW_REPORT),
          { permissionMode: "bypassPermissions" },
        );
      });

      const prompt = createAddressIssuesPrompt(TEST_STRUCTURED_REVIEW_REPORT);
      expect(prompt).toContain(
        "Stage only files that clearly belong to the review fixes and test coverage changes you made",
      );
      expect(prompt).toContain("Do NOT add secrets, credentials, `.env*` files");
      expect(prompt).toContain("leave them uncommitted and report them");

      await act(async () => {
        resolvePrompt?.(true);
      });
    });

    test("skips addressing and proceeds directly to verification for a clean report", async () => {
      mockGetStructuredOutput.mockResolvedValueOnce({
        ok: true,
        provider: "claude",
        value: {
          ...TEST_STRUCTURED_REVIEW_REPORT,
          issues: [],
          testCoverageGaps: [],
          verdict: {
            ready: "yes",
            reasoning: "No findings remain.",
          },
        },
      });
      mockCreateSession.mockResolvedValueOnce({ sessionId: "verify-session" });
      seedClaudeReviewPipeline();
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("verifying");
        expect(pipeline?.structuredReview?.issues).toEqual([]);
        expect(pipeline?.sessions.at(-1)?.sdkSessionId).toBe("verify-session");
      });
      expect(mockSendPrompt).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        "verify-session",
        expect.stringContaining("Verify the changes"),
        expect.objectContaining({ permissionMode: "bypassPermissions" }),
      );
    });

    test("pauses on an invalid structured report instead of advancing", async () => {
      mockGetStructuredOutput.mockResolvedValueOnce({
        ok: true,
        provider: "claude",
        value: { reviewSummary: "plaintext-like incomplete result" } as any,
      });
      seedClaudeReviewPipeline();
      seedEnvironment({ isLocal: false, workspaceReady: true });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("failed");
        expect(pipeline?.error).toContain("Invalid structured-review-report");
      });
      expect(mockSendPrompt).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();

      mockCreateSession.mockResolvedValueOnce({ sessionId: "retry-review-session" });
      fireEvent.click(screen.getByRole("button", { name: "Retry Review" }));
      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          expect.anything(),
          "retry-review-session",
          expect.any(String),
          expect.objectContaining({
            outputSchema: expect.objectContaining({ type: "object" }),
            requestId: expect.any(String),
          }),
        );
      });
      expect(
        useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)
          ?.structuredReviewRequestId,
      ).toBeTruthy();
    });

    test("retrying a review reuses a legacy completed result with skipped tests", async () => {
      seedFailedClaudeReviewTransition("review-request-with-skips");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      mockGetStructuredOutput.mockResolvedValueOnce({
        ...TEST_STRUCTURED_REVIEW_OUTPUT,
        value: TEST_LEGACY_STRUCTURED_REVIEW_REPORT,
      } as any);

      render(<BuildChatTab data={createContainerBuildData()} isActive />);
      fireEvent.click(await screen.findByRole("button", { name: "Retry Review" }));

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("addressing");
        expect(pipeline?.structuredReview?.testResults.notRun).toBe(13);
      });

      expect(mockGetStructuredOutput).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        SESSION_ID,
        "review-request-with-skips",
      );
      expect(mockCreateSession).not.toHaveBeenCalled();
      const recovered = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)
        ?.structuredReview;
      expect(mockSendPrompt).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        SESSION_ID,
        createAddressIssuesPrompt(recovered!),
        { permissionMode: "bypassPermissions" },
      );
    });

    test("retrying a review reuses a findings-free result and verifies instead", async () => {
      seedFailedClaudeReviewTransition("clean-review-request");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      mockGetStructuredOutput.mockResolvedValueOnce(
        TEST_CLEAN_STRUCTURED_REVIEW_OUTPUT,
      );
      mockCreateSession.mockResolvedValueOnce({ sessionId: "recovered-verify-session" });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);
      fireEvent.click(await screen.findByRole("button", { name: "Retry Review" }));

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("verifying");
        expect(pipeline?.structuredReview?.issues).toEqual([]);
        expect(pipeline?.sessions.at(-1)?.sdkSessionId).toBe("recovered-verify-session");
      });
      expect(mockSendPrompt).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        "recovered-verify-session",
        expect.stringContaining("Verify the changes"),
        expect.objectContaining({ permissionMode: "bypassPermissions" }),
      );
    });

    test("retrying a review starts a fresh one when the durable read rejects", async () => {
      seedFailedClaudeReviewTransition("unreadable-review-request");
      seedEnvironment({ isLocal: false, workspaceReady: true });
      mockGetStructuredOutput.mockImplementationOnce(() =>
        Promise.reject(new Error("structured output store unavailable"))
      );
      mockCreateSession.mockResolvedValueOnce({ sessionId: "fallback-review-session" });

      render(<BuildChatTab data={createContainerBuildData()} isActive />);
      fireEvent.click(await screen.findByRole("button", { name: "Retry Review" }));

      await waitFor(() => {
        const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
        expect(pipeline?.phase).toBe("reviewing");
        expect(pipeline?.sessions.at(-1)?.sdkSessionId).toBe("fallback-review-session");
      });
      expect(mockGetStructuredOutput).toHaveBeenCalledTimes(1);
      expect(mockSendPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "fallback-review-session",
        expect.any(String),
        expect.objectContaining({
          outputSchema: expect.objectContaining({ type: "object" }),
          requestId: expect.any(String),
        }),
      );
      expect(
        useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)
          ?.structuredReview,
      ).toBeUndefined();
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
      expect(reviewSession?.messages.at(-1)?.content).toBe(
        createAddressIssuesPrompt(TEST_STRUCTURED_REVIEW_REPORT),
      );
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
