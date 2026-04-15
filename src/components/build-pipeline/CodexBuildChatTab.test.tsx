import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCheckHealth = mock(async () => true);
const mockCreateClient = mock(() => ({ baseUrl: "http://127.0.0.1:9999" }));
const mockCreateSession = mock(async () => ({ sessionId: "review-session", title: "Review Session" }));
const mockGetSessionMessages = mock(async () => []);
const mockGetSessionStatus = mock(async () => ({ status: "running" as const }));
const mockSendPrompt = mock(async () => true);
const mockAbortSession = mock(async () => true);

mock.module("@/lib/codex-client", () => ({
  abortSession: mockAbortSession,
  checkHealth: mockCheckHealth,
  createClient: mockCreateClient,
  createSession: mockCreateSession,
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mockGetSessionStatus,
  sendPrompt: mockSendPrompt,
}));

mock.module("@/hooks", () => ({
  useScrollLock: () => ({ isAtBottom: true, scrollToBottom: () => {} }),
}));

mock.module("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

mock.module("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

mock.module("@/lib/tauri", () => ({
  detectPr: mock(async () => null),
  detectPrLocal: mock(async () => null),
  getCodexServerStatus: mock(async () => ({ running: true, hostPort: 9999 })),
  getLocalCodexServerStatus: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  getProjectNotes: mock(async () => ({ content: "" })),
  startCodexServer: mock(async () => ({ hostPort: 9999 })),
  startLocalCodexServer: mock(async () => ({ port: 9999, pid: 1234 })),
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
  });

  test("paused pipelines expose jump-in controls and send messages to the active codex session", async () => {
    seedPipeline("paused", "idle");
    seedCodexStore(false);
    mockSendPrompt.mockImplementationOnce(async () => {
      useCodexStore.getState().setSessionLoading(SESSION_KEY, false);
      return true;
    });

    render(<CodexBuildChatTab data={createData()} isActive />);

    expect(await screen.findByText("Review and continue")).toBeTruthy();

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

    expect(await screen.findByText("Retry")).toBeTruthy();
  });
});
