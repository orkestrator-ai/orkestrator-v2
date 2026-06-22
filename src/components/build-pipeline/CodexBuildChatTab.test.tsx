import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCheckHealth = mock(async () => true);
const mockCreateClient = mock(() => ({ baseUrl: "http://127.0.0.1:9999" }));
const mockCreateSession = mock(async () => ({ sessionId: "review-session", title: "Review Session" }));
const mockGetSessionMessages = mock(async (_client?: unknown, _sessionId?: string): Promise<any[]> => []);
const mockGetSessionStatus = mock(async (): Promise<{ status: "idle" | "running" | "error"; title?: string; error?: string }> => ({ status: "running" }));
const mockSendPrompt = mock(async () => true);
const mockAbortSession = mock(async () => true);
const mockDetectPr = mock(async (): Promise<any> => null);
const mockDetectPrLocal = mock(async (): Promise<any> => null);
const mockGetProjectNotes = mock(async () => ({ content: "" }));
const mockAddKanbanComment = mock(async () => ({ id: TASK_ID, comments: [] }));
const mockUpdateKanbanTask = mock(async () => ({ id: TASK_ID }));

mock.module("@/lib/codex-client", () => ({
  abortSession: mockAbortSession,
  checkHealth: mockCheckHealth,
  createClient: mockCreateClient,
  createSession: mockCreateSession,
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mockGetSessionStatus,
  sendPrompt: mockSendPrompt,
}));

// NOTE: Do NOT mock @/hooks or @/hooks/useScrollLock here — it pollutes the
// global bun module cache and breaks useScrollLock.test.ts. The real hook
// returns safe defaults (isAtBottom: true) when no viewport is found.

// Snapshot the real ScrollArea/Separator modules before stubbing so afterAll
// can restore them — Bun caches mock.module factories globally and would
// otherwise leak these stubs into sibling test files that need the real
// ScrollArea viewport.
import * as realScrollAreaModule from "@/components/ui/scroll-area";
import * as realSeparatorModule from "@/components/ui/separator";
const realScrollAreaSnapshot = { ...realScrollAreaModule };
const realSeparatorSnapshot = { ...realSeparatorModule };

mock.module("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

mock.module("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

mock.module("@/lib/backend", () => ({
  addKanbanComment: mockAddKanbanComment,
  detectPr: mockDetectPr,
  detectPrLocal: mockDetectPrLocal,
  getCodexServerStatus: mock(async () => ({ running: true, hostPort: 9999 })),
  getLocalCodexServerStatus: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  getProjectNotes: mockGetProjectNotes,
  startCodexServer: mock(async () => ({ hostPort: 9999 })),
  startLocalCodexServer: mock(async () => ({ port: 9999, pid: 1234 })),
  updateKanbanTask: mockUpdateKanbanTask,
}));

import { createCodexSessionKey, useCodexStore } from "@/stores/codexStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { CodexBuildChatTab } from "./CodexBuildChatTab";
import type { BuildTabData } from "@/types/paneLayout";

const ENV_ID = "env-1";
const PIPELINE_ID = "pipeline-1";
const TASK_ID = "task-1";
const SESSION_ID = "session-1";
const SESSION_KEY = createCodexSessionKey(ENV_ID, "build-tab");

function createData(): BuildTabData {
  return {
    environmentId: ENV_ID,
    pipelineId: PIPELINE_ID,
    taskId: TASK_ID,
    isLocal: false,
  };
}

function seedConfigStore() {
  useConfigStore.setState({
    config: {
      version: "1.0",
      global: {
        containerResources: { cpuCores: 2, memoryGb: 4 },
        envFilePatterns: [],
        allowedDomains: [],
        defaultAgent: "codex",
        opencodeModel: "openai/gpt-4.1",
        codexModel: "gpt-5.4",
        codexReasoningEffort: "medium",
        opencodeMode: "native",
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
    error: null,
  });
}

function seedEnvironmentStore() {
  useEnvironmentStore.setState({
    environments: [
      {
        id: ENV_ID,
        projectId: "project-1",
        name: "test-env",
        branch: "feature/test",
        containerId: "container-1",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-04-15T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      },
    ],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set([ENV_ID]),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
  });
}

function seedPipeline(phase: "building" | "paused", sessionStatus: "running" | "idle") {
  useBuildPipelineStore.setState({
    pipelines: new Map([
      [
        PIPELINE_ID,
        {
          id: PIPELINE_ID,
          taskId: TASK_ID,
          projectId: "project-1",
          environmentId: ENV_ID,
          environmentType: "containerized",
          agentType: "codex",
          phase,
          sessions: [
            {
              phase: "build",
              iteration: 0,
              sessionKey: SESSION_KEY,
              sdkSessionId: SESSION_ID,
              status: sessionStatus,
              startedAt: "2026-04-15T00:00:00.000Z",
              label: "Build Session",
            },
          ],
          currentSessionIndex: 0,
          iteration: 0,
          maxIterations: 3,
          createdAt: "2026-04-15T00:00:00.000Z",
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

function seedStartingPipeline() {
  useBuildPipelineStore.setState({
    pipelines: new Map([
      [
        PIPELINE_ID,
        {
          id: PIPELINE_ID,
          taskId: TASK_ID,
          projectId: "project-1",
          environmentId: ENV_ID,
          environmentType: "containerized",
          agentType: "codex",
          phase: "starting-environment",
          sessions: [],
          currentSessionIndex: -1,
          iteration: 0,
          maxIterations: 3,
          createdAt: "2026-04-15T00:00:00.000Z",
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

function seedReviewPipeline() {
  useBuildPipelineStore.setState({
    pipelines: new Map([
      [
        PIPELINE_ID,
        {
          id: PIPELINE_ID,
          taskId: TASK_ID,
          projectId: "project-1",
          environmentId: ENV_ID,
          environmentType: "containerized",
          agentType: "codex",
          phase: "reviewing",
          sessions: [
            {
              phase: "review",
              iteration: 0,
              sessionKey: SESSION_KEY,
              sdkSessionId: SESSION_ID,
              status: "running",
              startedAt: "2026-04-15T00:00:00.000Z",
              label: "Review Session",
            },
          ],
          currentSessionIndex: 0,
          iteration: 0,
          maxIterations: 3,
          createdAt: "2026-04-15T00:00:00.000Z",
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

function seedVerifyPipeline(
  feedback: string,
  options: { complete: boolean; iteration?: number; maxIterations?: number } = { complete: true },
) {
  const iteration = options.iteration ?? 0;
  const maxIterations = options.maxIterations ?? 3;
  const verificationMessage = {
    id: "verification-message",
    role: "assistant" as const,
    content: JSON.stringify({ complete: options.complete, rationale: feedback }),
    parts: [{ type: "text" as const, content: JSON.stringify({ complete: options.complete, rationale: feedback }) }],
    createdAt: "2026-04-15T00:00:01.000Z",
  };

  useBuildPipelineStore.setState({
    pipelines: new Map([
      [
        PIPELINE_ID,
        {
          id: PIPELINE_ID,
          taskId: TASK_ID,
          projectId: "project-1",
          environmentId: ENV_ID,
          environmentType: "containerized",
          agentType: "codex",
          phase: "verifying",
          sessions: [
            {
              phase: "verify",
              iteration,
              sessionKey: SESSION_KEY,
              sdkSessionId: SESSION_ID,
              status: "running",
              startedAt: "2026-04-15T00:00:00.000Z",
              label: "Verification Session",
            },
          ],
          currentSessionIndex: 0,
          iteration,
          maxIterations,
          createdAt: "2026-04-15T00:00:00.000Z",
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

  useCodexStore.setState({
    models: [],
    serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
    clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: SESSION_ID,
          messages: [verificationMessage],
          isLoading: false,
          title: "Verification Session",
        },
      ],
    ]),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map(),
    selectedMode: new Map(),
    selectedReasoningEffort: new Map(),
  });

  mockGetSessionMessages.mockImplementation(async (_client, sessionId?: string) =>
    sessionId === SESSION_ID ? [verificationMessage] : []
  );
}

function seedPrPipeline() {
  useBuildPipelineStore.setState({
    pipelines: new Map([
      [
        PIPELINE_ID,
        {
          id: PIPELINE_ID,
          taskId: TASK_ID,
          projectId: "project-1",
          environmentId: ENV_ID,
          environmentType: "containerized",
          agentType: "codex",
          phase: "creating-pr",
          sessions: [
            {
              phase: "pr",
              iteration: 0,
              sessionKey: SESSION_KEY,
              sdkSessionId: SESSION_ID,
              status: "running",
              startedAt: "2026-04-15T00:00:00.000Z",
              label: "PR Creation Session",
            },
          ],
          currentSessionIndex: 0,
          iteration: 0,
          maxIterations: 3,
          createdAt: "2026-04-15T00:00:00.000Z",
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

function seedCodexStore(isLoading: boolean) {
  useCodexStore.setState({
    models: [],
    serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
    clients: new Map([[ENV_ID, { baseUrl: "http://127.0.0.1:9999" } as any]]),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: SESSION_ID,
          messages: [],
          isLoading,
          title: "Build Session",
        },
      ],
    ]),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map(),
    selectedMode: new Map(),
    selectedReasoningEffort: new Map(),
  });
}

function resetStores() {
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
  useCodexStore.setState({
    models: [],
    serverStatus: new Map(),
    clients: new Map(),
    sessions: new Map(),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map(),
    selectedMode: new Map(),
    selectedReasoningEffort: new Map(),
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

describe("CodexBuildChatTab", () => {
  afterAll(() => {
    mock.module("@/components/ui/scroll-area", () => realScrollAreaSnapshot);
    mock.module("@/components/ui/separator", () => realSeparatorSnapshot);
    mock.restore();
  });

  beforeEach(() => {
    cleanup();
    resetStores();
    seedConfigStore();
    seedEnvironmentStore();
    mockCheckHealth.mockClear();
    mockCreateClient.mockClear();
    mockCreateSession.mockClear();
    mockGetSessionMessages.mockClear();
    mockGetSessionStatus.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();
    mockDetectPr.mockClear();
    mockDetectPrLocal.mockClear();
    mockGetProjectNotes.mockClear();
    mockAddKanbanComment.mockClear();
    mockUpdateKanbanTask.mockClear();

    mockCreateSession.mockImplementation(async () => ({ sessionId: "review-session", title: "Review Session" }));
    mockGetSessionMessages.mockImplementation(async () => []);
    mockGetSessionStatus.mockImplementation(async (): Promise<{ status: "idle" | "running" | "error"; title?: string; error?: string }> => ({ status: "running" }));
    mockSendPrompt.mockImplementation(async () => true);
    mockAbortSession.mockImplementation(async () => true);
    mockDetectPr.mockImplementation(async () => null);
    mockDetectPrLocal.mockImplementation(async () => null);
    mockGetProjectNotes.mockImplementation(async () => ({ content: "" }));
    mockAddKanbanComment.mockImplementation(async () => ({ id: TASK_ID, comments: [] }));
    mockUpdateKanbanTask.mockImplementation(async () => ({ id: TASK_ID }));
  });

  afterEach(() => {
    cleanup();
  });

  test("stopping a running pipeline pauses it instead of failing it", async () => {
    seedPipeline("building", "idle");
    seedCodexStore(false);

    render(<CodexBuildChatTab data={createData()} isActive />);

    const stopButton = await screen.findByText("Stop");
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("paused");
    });

    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.error).toBeUndefined();
    expect(mockAbortSession).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:9999" }, SESSION_ID);
    expect(await screen.findByText("Resume")).toBeTruthy();
  });

  test("polls a loading codex build session without immediately restarting the poll loop", async () => {
    seedPipeline("building", "running");
    seedCodexStore(true);
    mockGetSessionStatus.mockImplementation(async () => ({ status: "running" as const }));
    mockGetSessionMessages.mockImplementation(async () => []);

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(mockGetSessionStatus.mock.calls.length).toBeLessThanOrEqual(2);
    expect(mockGetSessionMessages.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("paused pipelines expose jump-in controls and send messages to the active codex session", async () => {
    seedPipeline("paused", "idle");
    seedCodexStore(false);
    mockSendPrompt.mockImplementationOnce(async () => {
      useCodexStore.getState().setSessionLoading(SESSION_KEY, false);
      return true;
    });

    render(<CodexBuildChatTab data={createData()} isActive />);

    expect(await screen.findByText("Resume")).toBeTruthy();

    const textarea = await screen.findByPlaceholderText("Send a message to the agent...");
    fireEvent.change(textarea, { target: { value: "Please also update the tests." } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        SESSION_ID,
        "Please also update the tests.",
      );
    });

    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages.at(-1)?.content).toBe("Please also update the tests.");
  });

  test("resuming a paused pipeline continues the stopped stage", async () => {
    seedPipeline("paused", "idle");
    seedCodexStore(false);

    render(<CodexBuildChatTab data={createData()} isActive />);

    const resumeButton = await screen.findByText("Resume");
    fireEvent.click(resumeButton);

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        { baseUrl: "http://127.0.0.1:9999" },
        SESSION_ID,
        expect.stringContaining("Resume the build pipeline from where you left off"),
        undefined,
      );
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("building");
    expect(pipeline?.sessions[0]?.status).toBe("running");
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
  });

  test("shows a retry action when codex initialization fails", async () => {
    seedStartingPipeline();
    useEnvironmentStore.setState({
      environments: [{
        id: ENV_ID,
        projectId: "project-1",
        name: "test-env",
        branch: "feature/test",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-04-15T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      }],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set([ENV_ID]),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
    });

    render(<CodexBuildChatTab data={createData()} isActive />);

    expect(await screen.findByText("Reconnect now")).toBeTruthy();
  });

  test("does not advance past a new review session before the review prompt is accepted", async () => {
    seedPipeline("building", "running");
    seedCodexStore(false);
    mockGetSessionStatus.mockImplementation(async () => ({ status: "idle" as const }));

    let resolvePrompt: ((value: boolean) => void) | undefined;
    mockSendPrompt.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        resolvePrompt = resolve;
      }),
    );

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("reviewing");
    expect(pipeline?.sessions.at(-1)?.phase).toBe("review");
    expect(mockSendPrompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePrompt?.(true);
    });
  });

  test("does not send the address-issues prompt while the codex bridge still reports the review session running", async () => {
    seedReviewPipeline();
    seedCodexStore(false);
    mockGetSessionStatus.mockImplementation(async () => ({ status: "running" as const }));

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("reviewing");
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  test("fails the pipeline when the bridge reports the session errored during advance", async () => {
    seedPipeline("building", "running");
    seedCodexStore(false);
    // The re-check before advancing reports an error rather than completion.
    mockGetSessionStatus.mockImplementation(async () => ({ status: "error" as const, error: "boom" }));

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("boom");
    });

    const session = useCodexStore.getState().sessions.get(SESSION_KEY);
    expect(session?.error).toBe("boom");
    expect(session?.isLoading).toBe(false);
    // The pipeline must not have advanced to a review session.
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions).toHaveLength(1);
  });

  test("uses a generic message when the errored session has no error text", async () => {
    seedPipeline("building", "running");
    seedCodexStore(false);
    mockGetSessionStatus.mockImplementation(async () => ({ status: "error" as const }));

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("Codex session failed");
    });
  });

  test("does not re-check or advance a pipeline already in the failed phase", async () => {
    // The advance effect guards on phase === "failed" so a terminal pipeline
    // never re-checks status or restarts work when the tab re-mounts.
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          PIPELINE_ID,
          {
            id: PIPELINE_ID,
            taskId: TASK_ID,
            projectId: "project-1",
            environmentId: ENV_ID,
            environmentType: "containerized",
            agentType: "codex",
            phase: "failed",
            error: "previous failure",
            sessions: [
              {
                phase: "build",
                iteration: 0,
                sessionKey: SESSION_KEY,
                sdkSessionId: SESSION_ID,
                status: "running",
                startedAt: "2026-04-15T00:00:00.000Z",
                label: "Build Session",
              },
            ],
            currentSessionIndex: 0,
            iteration: 0,
            maxIterations: 3,
            createdAt: "2026-04-15T00:00:00.000Z",
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
    seedCodexStore(false);

    render(<CodexBuildChatTab data={createData()} isActive />);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // Session is not loading, so polling never runs; the failed-phase guard
    // keeps the advance/verify effects from re-checking status.
    expect(mockGetSessionStatus).not.toHaveBeenCalled();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("failed");
    expect(pipeline?.error).toBe("previous failure");
  });

  test("does not start verification while the address-issues prompt is being accepted", async () => {
    seedReviewPipeline();
    seedCodexStore(false);
    mockGetSessionStatus.mockImplementation(async () => ({ status: "idle" as const }));

    let resolvePrompt: ((value: boolean) => void) | undefined;
    mockSendPrompt.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        resolvePrompt = resolve;
      }),
    );

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("addressing");
    expect(pipeline?.sessions).toHaveLength(1);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendPrompt).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePrompt?.(true);
    });
  });

  function seedAddressingPipeline() {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        [
          PIPELINE_ID,
          {
            id: PIPELINE_ID,
            taskId: TASK_ID,
            projectId: "project-1",
            environmentId: ENV_ID,
            environmentType: "containerized",
            agentType: "codex",
            phase: "addressing",
            sessions: [
              {
                phase: "review",
                iteration: 0,
                sessionKey: SESSION_KEY,
                sdkSessionId: SESSION_ID,
                status: "running",
                startedAt: "2026-04-15T00:00:00.000Z",
                label: "Review Session",
              },
            ],
            currentSessionIndex: 0,
            iteration: 0,
            maxIterations: 3,
            createdAt: "2026-04-15T00:00:00.000Z",
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

  test("does not start verification while the bridge still reports the addressing session running", async () => {
    seedAddressingPipeline();
    seedCodexStore(false);
    // The verify effect re-checks status before starting verification.
    mockGetSessionStatus.mockImplementation(async () => ({ status: "running" as const }));

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("addressing");
    // Still running, so no verification session is created.
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("fails the pipeline when the addressing session errors before verification", async () => {
    seedAddressingPipeline();
    seedCodexStore(false);
    mockGetSessionStatus.mockImplementation(async () => ({ status: "error" as const, error: "addressing blew up" }));

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("addressing blew up");
    });

    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("starts verification after the address-issues prompt is accepted and the review session idles", async () => {
    seedReviewPipeline();
    seedCodexStore(false);
    mockCreateSession.mockImplementationOnce(async () => ({ sessionId: "verify-session", title: "Verification Session" }));
    mockGetSessionStatus.mockImplementation(async () => undefined as any);

    mockSendPrompt.mockImplementationOnce(async () => {
      useCodexStore.getState().setSessionLoading(SESSION_KEY, false);
      expect(mockCreateSession).not.toHaveBeenCalled();
      window.setTimeout(() => {
        useCodexStore.getState().setSessionLoading(SESSION_KEY, false);
      }, 0);
      return true;
    });

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("verifying");
      expect(pipeline?.sessions.at(-1)?.phase).toBe("verify");
    });

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockSendPrompt).toHaveBeenCalledTimes(2);
  });

  test("starts PR creation when verification passes", async () => {
    seedVerifyPipeline("All acceptance criteria are satisfied", { complete: true });
    mockCreateSession.mockImplementationOnce(async () => ({ sessionId: "pr-session", title: "PR Creation Session" }));
    mockGetSessionStatus.mockImplementation(async () => undefined as any);

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("creating-pr");
      expect(pipeline?.verificationResult).toBe("pass");
      expect(pipeline?.sessions.at(-1)?.phase).toBe("pr");
    });

    expect(mockSendPrompt).toHaveBeenCalledTimes(1);
  });

  test("starts a fix session and increments iteration when verification fails below max iterations", async () => {
    seedVerifyPipeline("Tests still fail", { complete: false, iteration: 0, maxIterations: 3 });
    mockCreateSession.mockImplementationOnce(async () => ({ sessionId: "fix-session", title: "Fix Session" }));
    mockGetSessionStatus.mockImplementation(async () => undefined as any);

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("fixing");
      expect(pipeline?.verificationResult).toBe("fail");
      expect(pipeline?.iteration).toBe(1);
      expect(pipeline?.sessions.at(-1)?.phase).toBe("fix");
    });

    expect(mockSendPrompt).toHaveBeenCalledTimes(1);
  });

  test("fails the pipeline when verification fails at the max iteration", async () => {
    seedVerifyPipeline("Still incomplete", { complete: false, iteration: 3, maxIterations: 3 });
    mockGetSessionStatus.mockImplementation(async () => undefined as any);

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toContain("Max iterations (3) reached");
    });

    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("starts conflict resolution when a created PR still has merge conflicts", async () => {
    seedPrPipeline();
    seedCodexStore(false);
    mockGetSessionStatus.mockImplementation(async () => undefined as any);
    mockDetectPr.mockImplementation(async () => ({
      url: "https://github.com/orkestrator-ai/orkestrator-ai/pull/1",
      state: "open",
      hasMergeConflicts: true,
    }));
    mockCreateSession.mockImplementationOnce(async () => ({ sessionId: "conflict-session", title: "Conflict Resolution Session" }));

    render(<CodexBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("resolving-conflicts");
      expect(pipeline?.sessions.at(-1)?.phase).toBe("resolve-conflicts");
    });

    expect(mockDetectPr).toHaveBeenCalledWith("container-1", "feature/test");
    expect(mockSendPrompt).toHaveBeenCalledTimes(1);
  });
});
