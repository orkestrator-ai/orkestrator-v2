import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCreateClient = mock(() => ({ session: {}, event: {} }));
const mockCreateSession = mock(async () => ({ id: "review-session", createdAt: "2026-04-15T00:00:00.000Z" }));
const mockGetSessionMessages = mock(async () => []);
const mockSendPrompt = mock(async () => ({ success: true }));
const mockAbortSession = mock(async () => true);
const mockSubscribeToEvents = mock(async () => (async function* () {})());
const mockReplyToPermission = mock(async () => true);
const mockRejectQuestion = mock(async () => true);
const originalFetch = globalThis.fetch;

mock.module("@/lib/opencode-client", () => ({
  ERROR_MESSAGE_PREFIX: "error-",
  abortSession: mockAbortSession,
  createClient: mockCreateClient,
  createSession: mockCreateSession,
  getSessionMessages: mockGetSessionMessages,
  rejectQuestion: mockRejectQuestion,
  replyToPermission: mockReplyToPermission,
  sendPrompt: mockSendPrompt,
  subscribeToEvents: mockSubscribeToEvents,
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

mock.module("@/lib/context-usage", () => ({
  extractContextUsage: () => null,
}));

mock.module("@/lib/backend", () => ({
  detectPr: mock(async () => null),
  detectPrLocal: mock(async () => null),
  getLocalOpencodeServerStatus: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  getOpenCodeServerStatus: mock(async () => ({ running: true, hostPort: 9999 })),
  getProjectNotes: mock(async () => ({ content: "" })),
  startLocalOpencodeServer: mock(async () => ({ port: 9999, pid: 1234 })),
  startOpenCodeServer: mock(async () => ({ hostPort: 9999 })),
}));

import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { createOpenCodeSessionKey, useOpenCodeStore } from "@/stores/openCodeStore";
import { usePrMonitorStore } from "@/stores/prMonitorStore";
import { OpenCodeBuildChatTab } from "./OpenCodeBuildChatTab";
import type { BuildTabData } from "@/types/paneLayout";

const ENV_ID = "env-1";
const PIPELINE_ID = "pipeline-1";
const TASK_ID = "task-1";
const SESSION_ID = "session-1";
const SESSION_KEY = createOpenCodeSessionKey(ENV_ID, "build-tab");

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
        defaultAgent: "opencode",
        opencodeModel: "openai/gpt-5",
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
          agentType: "opencode",
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

function seedPendingPipeline() {
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
          agentType: "opencode",
          phase: "waiting-for-setup",
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

function seedOpenCodeStore(isLoading: boolean) {
  useOpenCodeStore.setState({
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
    clients: new Map([[ENV_ID, mockCreateClient() as any]]),
    models: new Map(),
    slashCommands: new Map(),
    selectedModel: new Map(),
    selectedVariant: new Map(),
    selectedMode: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    isComposing: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
    eventSubscriptions: new Map(),
    contextUsage: new Map(),
  });
}

function resetStores() {
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
  useOpenCodeStore.setState({
    serverStatus: new Map(),
    sessions: new Map(),
    clients: new Map(),
    models: new Map(),
    slashCommands: new Map(),
    selectedModel: new Map(),
    selectedVariant: new Map(),
    selectedMode: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    isComposing: new Map(),
    pendingQuestions: new Map(),
    pendingPermissions: new Map(),
    eventSubscriptions: new Map(),
    contextUsage: new Map(),
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

describe("OpenCodeBuildChatTab", () => {
  afterAll(() => {
    mock.module("@/components/ui/scroll-area", () => realScrollAreaSnapshot);
    mock.module("@/components/ui/separator", () => realSeparatorSnapshot);
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  beforeEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    delete window.orkestratorGateway;
    resetStores();
    seedConfigStore();
    seedEnvironmentStore();
    mockCreateClient.mockClear();
    mockCreateSession.mockClear();
    mockGetSessionMessages.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();
    mockSubscribeToEvents.mockClear();
    mockReplyToPermission.mockClear();
    mockRejectQuestion.mockClear();
  });

  afterEach(() => {
    cleanup();
    delete window.orkestratorGateway;
  });

  test("stopping a running pipeline pauses it instead of failing it", async () => {
    let resolveAbort: ((value: boolean) => void) | undefined;
    mockAbortSession.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => {
        resolveAbort = resolve;
      }),
    );
    seedPipeline("building", "running");
    seedOpenCodeStore(true);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    const stopButton = await screen.findByText("Stop");
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("paused");
    });

    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.error).toBeUndefined();
    expect(mockAbortSession).toHaveBeenCalled();
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    expect(await screen.findByText("Resume")).toBeTruthy();
    resolveAbort?.(true);
  });

  test("paused pipelines expose jump-in controls and send messages to the active opencode session", async () => {
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    expect(await screen.findByText("Resume")).toBeTruthy();

    const textarea = await screen.findByPlaceholderText("Send a message to the agent...");
    fireEvent.change(textarea, { target: { value: "Please tighten the verification pass." } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        expect.anything(),
        SESSION_ID,
        "Please tighten the verification pass.",
        {
          model: "openai/gpt-5",
          variant: undefined,
          mode: "build",
        },
      );
    });

    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions[0]?.status).toBe("running");
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
  });

  test("resuming a paused pipeline continues the stopped stage", async () => {
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    const resumeButton = await screen.findByText("Resume");
    fireEvent.click(resumeButton);

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        expect.anything(),
        SESSION_ID,
        expect.stringContaining("Resume the build pipeline from where you left off"),
        {
          model: "openai/gpt-5",
          variant: undefined,
          mode: "build",
        },
      );
    });

    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("building");
    expect(pipeline?.sessions[0]?.status).toBe("running");
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
  });

  test("starts a build session automatically once setup is complete", async () => {
    seedPendingPipeline();
    useOpenCodeStore.setState({
      serverStatus: new Map([[ENV_ID, { running: true, hostPort: 9999 }]]),
      sessions: new Map(),
      clients: new Map([[ENV_ID, mockCreateClient() as any]]),
      models: new Map(),
      slashCommands: new Map(),
      selectedModel: new Map(),
      selectedVariant: new Map(),
      selectedMode: new Map(),
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      messageQueue: new Map(),
      isComposing: new Map(),
      pendingQuestions: new Map(),
      pendingPermissions: new Map(),
      eventSubscriptions: new Map(),
      contextUsage: new Map(),
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "review-session",
        expect.stringContaining("Test task"),
        {
          model: "openai/gpt-5",
          variant: undefined,
          mode: "build",
          attachments: undefined,
        },
      );
    });

    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("building");
    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions).toHaveLength(1);
  });

  test("routes startup health checks through the remote gateway proxy when enabled", async () => {
    seedPendingPipeline();
    window.orkestratorGateway = { enabled: true };
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${window.location.origin}/__orkestrator/proxy/loopback/9999/global/health`,
      );
    });
  });

  test("reconnect action retries opencode initialization after a connection failure", async () => {
    seedPendingPipeline();
    useEnvironmentStore.setState({
      environments: [{
        ...useEnvironmentStore.getState().environments[0]!,
        containerId: null,
      }],
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    const reconnectButton = await screen.findByText("Reconnect now");
    useEnvironmentStore.setState({
      environments: [{
        ...useEnvironmentStore.getState().environments[0]!,
        containerId: "container-1",
      }],
    });
    mockCreateClient.mockClear();
    globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    fireEvent.click(reconnectButton);

    await waitFor(() => {
      expect(mockCreateClient).toHaveBeenCalledWith("http://127.0.0.1:9999");
    });
  });

  test("auto-approves permissions with always and rejects questions for unattended runs", async () => {
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);
    mockSubscribeToEvents.mockImplementationOnce(async () => ((async function* () {
      yield {
        type: "permission.asked",
        properties: { id: "perm-1", always: ["tool"], sessionID: SESSION_ID },
      } as any;
      yield {
        type: "question.asked",
        properties: {
          id: "question-1",
          questions: [{ header: "Need approval", question: "Need approval" }],
          sessionID: SESSION_ID,
        },
      } as any;
    })() as any));

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(mockReplyToPermission).toHaveBeenCalledWith(expect.anything(), "perm-1", "always");
      expect(mockRejectQuestion).toHaveBeenCalledWith(expect.anything(), "question-1");
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("failed");
    });
  });
});
