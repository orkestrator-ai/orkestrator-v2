import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCreateClient = mock(() => ({ session: {}, event: {} }));
const mockCreateSession = mock(async () => ({ id: "review-session", createdAt: "2026-04-15T00:00:00.000Z" }));
const mockGetSessionMessages = mock(async (): Promise<any[]> => []);
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
import type { NativeMessage } from "@/lib/chat/native-message-types";

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

function seedVerifyPipeline(
  feedback: string,
  options: { complete: boolean; iteration?: number; maxIterations?: number },
) {
  const iteration = options.iteration ?? 0;
  const verificationMessage: NativeMessage = {
    id: "verification-message",
    role: "assistant",
    content: JSON.stringify({ complete: options.complete, rationale: feedback }),
    parts: [{ type: "text", content: JSON.stringify({ complete: options.complete, rationale: feedback }) }],
    createdAt: "2026-04-15T00:00:01.000Z",
  };
  seedPipeline("building", "running");
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
  seedOpenCodeStore(false);
  setOpenCodeBuildMessages([verificationMessage]);
  mockGetSessionMessages.mockResolvedValue([verificationMessage]);
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

function setOpenCodeBuildMessages(messages: NativeMessage[]) {
  useOpenCodeStore.setState((state) => ({
    sessions: new Map(state.sessions).set(SESSION_KEY, {
      sessionId: SESSION_ID,
      messages,
      isLoading: false,
    }),
  }));
}

function expectTextOrder(...labels: string[]) {
  const text = document.body.textContent ?? "";
  const positions = labels.map((label) => text.indexOf(label));
  expect(positions.every((position) => position >= 0)).toBe(true);
  for (let index = 1; index < positions.length; index += 1) {
    expect(positions[index - 1]!).toBeLessThan(positions[index]!);
  }
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

  test("pins active OpenCode build subagents below later messages and releases them on success", async () => {
    seedPipeline("building", "running");
    seedOpenCodeStore(false);

    const activeMessage: NativeMessage = {
      id: "assistant-agent",
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "Parent started" },
        {
          type: "subagent",
          content: "Build worker",
          subagentId: "agent-1",
          subagentName: "Build worker",
          toolState: "pending",
          subagentActions: [],
        },
        { type: "text", content: "Parent continued" },
      ],
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    const laterMessage: NativeMessage = {
      id: "assistant-later",
      role: "assistant",
      content: "Later response",
      parts: [{ type: "text", content: "Later response" }],
      createdAt: "2026-04-15T00:00:30.000Z",
    };
    setOpenCodeBuildMessages([activeMessage, laterMessage]);
    mockGetSessionMessages.mockImplementation(async () => [activeMessage, laterMessage]);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expectTextOrder("Parent started", "Later response", "Build worker");
    });

    const completedMessage: NativeMessage = {
      ...activeMessage,
      parts: activeMessage.parts.map((part) =>
        part.type === "subagent"
          ? { ...part, toolState: "success" as const }
          : part
      ),
    };

    act(() => {
      setOpenCodeBuildMessages([completedMessage, laterMessage]);
    });

    await waitFor(() => {
      expectTextOrder("Parent started", "Build worker", "Parent continued", "Later response");
    });
  });

  test("resuming after stop during session creation starts the intended opencode build stage", async () => {
    let resolveCreate: ((value: { id: string; createdAt: string }) => void) | undefined;
    mockCreateSession.mockImplementationOnce(
      () => new Promise<{ id: string; createdAt: string }>((resolve) => {
        resolveCreate = resolve;
      }),
    );
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
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Stop")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Stop"));

    await waitFor(() => {
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("paused");
    });

    await act(async () => {
      resolveCreate?.({ id: "late-session", createdAt: "2026-04-15T00:00:00.000Z" });
    });

    await waitFor(() => {
      expect(mockAbortSession).toHaveBeenCalledWith(expect.anything(), "late-session");
    });
    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions).toHaveLength(0);

    fireEvent.click(await screen.findByText("Resume"));

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
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
    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions[0]?.phase).toBe("build");
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
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.at(-1)?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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

    expect(await screen.findByText("Connection Failed")).toBeTruthy();
    const reconnectButton = screen.getByRole("button", { name: "Reconnect now" });
    // The error screen overlays a Stop control (pipeline still running) but no
    // duplicate top-right Reconnect — the centered "Reconnect now" covers that.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
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

  test("surfaces the error screen when the opencode event stream disconnects mid-run", async () => {
    // Connection is healthy at init (cached client) but the event subscription
    // fails, simulating the bridge dropping the stream while the pipeline runs.
    mockSubscribeToEvents.mockImplementationOnce(async () => {
      throw new Error("event stream disconnected");
    });
    seedPipeline("building", "running");
    seedOpenCodeStore(true);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    expect(await screen.findByText("Connection Failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  test("shows an inline reconnect button when the opencode event stream ends while running", async () => {
    // The default subscribeToEvents mock resolves to an immediately-completed
    // stream, so the shared subscription ends and hasActiveEventSubscription()
    // flips to false while the pipeline is still running.
    seedPipeline("building", "running");
    seedOpenCodeStore(true);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    // Inline header Reconnect appears, distinct from the full-screen "Reconnect now".
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeTruthy();
    // Still the connected chat view, not the error screen.
    expect(screen.queryByText("Connection Failed")).toBeNull();
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

  test("advances an idle build session into review", async () => {
    seedPipeline("building", "running");
    seedOpenCodeStore(false);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("reviewing");
      expect(pipeline?.sessions.at(-1)?.phase).toBe("review");
    });
    expect(mockCreateSession).toHaveBeenCalled();
    expect(mockSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "review-session",
      expect.stringContaining("review"),
      expect.objectContaining({ model: "openai/gpt-5", mode: "build" }),
    );
  });

  test("starts PR creation after successful verification", async () => {
    seedVerifyPipeline("All acceptance criteria are satisfied", { complete: true });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("creating-pr");
      expect(pipeline?.verificationResult).toBe("pass");
      expect(pipeline?.sessions.at(-1)?.phase).toBe("pr");
    });
  });

  test("starts a fix session after failed verification below the iteration limit", async () => {
    seedVerifyPipeline("Tests still fail", { complete: false, iteration: 0, maxIterations: 3 });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("fixing");
      expect(pipeline?.verificationResult).toBe("fail");
      expect(pipeline?.iteration).toBe(1);
      expect(pipeline?.sessions.at(-1)?.phase).toBe("fix");
    });
  });

  test("fails verification at the maximum iteration", async () => {
    seedVerifyPipeline("Still incomplete", { complete: false, iteration: 3, maxIterations: 3 });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toContain("Max iterations (3) reached");
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});
