import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  TEST_CLEAN_STRUCTURED_REVIEW_OUTPUT,
  TEST_LEGACY_STRUCTURED_REVIEW_REPORT,
  TEST_STRUCTURED_REVIEW_OUTPUT,
  TEST_STRUCTURED_REVIEW_REPORT,
} from "./structured-review-test-fixture";

const mockCreateClient = mock(() => ({ session: {}, event: {} }));
const mockCreateSession = mock(async () => ({ id: "review-session", createdAt: "2026-04-15T00:00:00.000Z" }));
const mockGetSessionMessages = mock(async (): Promise<any[]> => []);
const mockSendPrompt = mock(async (
  _client: unknown,
  _sessionId: string,
  _text: string,
  _options: unknown,
): Promise<{ success: boolean; error?: string }> => ({ success: true }));
const mockAbortSession = mock(async () => true);
const mockGetStructuredOutput = mock(async () => TEST_STRUCTURED_REVIEW_OUTPUT);
const mockSubscribeToEvents = mock(async () => (async function* () {})());
const mockReplyToPermission = mock(async () => true);
const mockRejectQuestion = mock(async () => true);
const mockGetProjectNotes = mock(async () => ({ content: "" }));
const mockDetectPr = mock(async () => null as {
  url: string;
  state: "open" | "closed" | "merged";
  hasMergeConflicts: boolean;
} | null);
const mockDetectPrLocal = mockDetectPr;
// Named so the local/container server-start branches can be asserted on.
const mockGetLocalOpencodeServerStatus = mock(async (_environmentId: string) => ({
  running: true,
  port: 9999 as number | null,
  pid: 1234 as number | undefined,
}));
const mockStartLocalOpencodeServer = mock(async (_environmentId: string) => ({
  port: 9999,
  pid: 1234,
}));
const mockGetOpenCodeServerStatus = mock(async (_containerId: string) => ({
  running: true,
  hostPort: 9999 as number | null,
}));
const mockStartOpenCodeServer = mock(async (_containerId: string) => ({ hostPort: 9999 }));
const originalFetch = globalThis.fetch;

mock.module("@/lib/opencode-client", () => ({
  ERROR_MESSAGE_PREFIX: "error-",
  abortSession: mockAbortSession,
  createClient: mockCreateClient,
  createSession: mockCreateSession,
  getSessionMessages: mockGetSessionMessages,
  getStructuredOutput: mockGetStructuredOutput,
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

mock.module("@/lib/backend", () => ({
  detectPr: mockDetectPr,
  detectPrLocal: mockDetectPrLocal,
  getLocalOpencodeServerStatus: mockGetLocalOpencodeServerStatus,
  getOpenCodeServerStatus: mockGetOpenCodeServerStatus,
  getProjectNotes: mockGetProjectNotes,
  startLocalOpencodeServer: mockStartLocalOpencodeServer,
  startOpenCodeServer: mockStartOpenCodeServer,
}));

import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { createSessionKey as createOpenCodeSessionKey } from "@/lib/utils";
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

function createLocalData(): BuildTabData {
  return { ...createData(), isLocal: true };
}

/**
 * Local worktree environment with setup finished: no container id, setup
 * commands resolved and nothing running.
 */
function seedLocalEnvironment() {
  useEnvironmentStore.setState({
    environments: [
      {
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
        environmentType: "local",
        worktreePath: "/tmp/worktree",
      },
    ],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set([ENV_ID]),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set([ENV_ID]),
    setupScriptsRunning: new Set(),
  });
}

function setPipelinePhase(phase: string) {
  useBuildPipelineStore.setState((state) => {
    const pipeline = state.pipelines.get(PIPELINE_ID)!;
    return {
      pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
        ...pipeline,
        phase: phase as typeof pipeline.phase,
      }),
    };
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
          backendRevision: 0,
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
      backendRevision: 0,
      sessions: [{ ...pipeline.sessions[0]!, phase: "verify", iteration, label: "Verification Session" }],
    });
    return { pipelines };
  });
  seedOpenCodeStore(false);
  setOpenCodeBuildMessages([verificationMessage]);
  mockGetSessionMessages.mockResolvedValue([verificationMessage]);
}

function seedPipelineSessionPhase(
  pipelinePhase: "reviewing" | "addressing",
  sessionStatus: "running" | "idle",
  isLoading: boolean,
) {
  seedPipeline("building", sessionStatus);
  useBuildPipelineStore.setState((state) => {
    const pipelines = new Map(state.pipelines);
    const pipeline = pipelines.get(PIPELINE_ID)!;
    pipelines.set(PIPELINE_ID, {
      ...pipeline,
      phase: pipelinePhase,
      sessions: [{
        ...pipeline.sessions[0]!,
        phase: "review",
        label: "Review Session",
        status: sessionStatus,
      }],
    });
    return { pipelines };
  });
  seedOpenCodeStore(isLoading);
}

/**
 * A review round that completed on the provider but failed the transition into
 * the next phase, with the durable request id recorded and no report consumed
 * yet — the state "Retry Review" is allowed to recover from.
 */
function seedFailedReviewTransition(requestId: string) {
  seedPipelineSessionPhase("reviewing", "idle", false);
  useBuildPipelineStore.setState((state) => {
    const pipeline = state.pipelines.get(PIPELINE_ID)!;
    return {
      pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
        ...pipeline,
        phase: "failed",
        error:
          "Invalid structured-review-report: 1 validation issue. $.testResults.notRun: Required field \"notRun\" is missing.",
        structuredReviewRequestId: requestId,
        failureContext: {
          phase: "reviewing",
          kind: "stage-transition",
        },
      }),
    };
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
          backendRevision: 0,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventChannel() {
  const queue: any[] = [];
  let wake = deferred<void>();
  let closed = false;
  const stream = (async function* () {
    while (!closed) {
      if (queue.length === 0) await wake.promise;
      while (queue.length > 0) yield queue.shift();
    }
  })();
  return {
    stream,
    push(event: any) {
      queue.push(event);
      wake.resolve();
      wake = deferred<void>();
    },
    close() {
      closed = true;
      wake.resolve();
    },
  };
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
    mockGetStructuredOutput.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();
    mockSubscribeToEvents.mockClear();
    mockReplyToPermission.mockClear();
    mockRejectQuestion.mockClear();
    mockGetProjectNotes.mockClear();
    mockDetectPr.mockClear();
    mockGetLocalOpencodeServerStatus.mockClear();
    mockStartLocalOpencodeServer.mockClear();
    mockGetOpenCodeServerStatus.mockClear();
    mockStartOpenCodeServer.mockClear();
    mockGetLocalOpencodeServerStatus.mockImplementation(async () => ({
      running: true,
      port: 9999,
      pid: 1234,
    }));
    mockStartLocalOpencodeServer.mockImplementation(async () => ({ port: 9999, pid: 1234 }));
    mockGetOpenCodeServerStatus.mockImplementation(async () => ({ running: true, hostPort: 9999 }));
    mockStartOpenCodeServer.mockImplementation(async () => ({ hostPort: 9999 }));
    mockCreateSession.mockImplementation(async () => ({
      id: "review-session",
      createdAt: "2026-04-15T00:00:00.000Z",
    }));
    mockGetSessionMessages.mockImplementation(async () => []);
    mockSendPrompt.mockImplementation(async () => ({ success: true }));
    mockAbortSession.mockImplementation(async () => true);
    mockSubscribeToEvents.mockImplementation(async () => (async function* () {})());
    mockGetProjectNotes.mockImplementation(async () => ({ content: "" }));
    mockDetectPr.mockImplementation(async () => null);
  });

  afterEach(() => {
    cleanup();
    delete window.orkestratorGateway;
  });

  test("renders a friendly catalog label for the build assistant's confirmed model", async () => {
    const assistantMessage: NativeMessage = {
      id: "assistant-with-model",
      role: "assistant",
      content: "Catalog-attributed build response",
      parts: [{ type: "text", content: "Catalog-attributed build response" }],
      createdAt: "2026-07-28T12:00:00.000Z",
      modelId: "openai/gpt-5-review",
    };
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);
    setOpenCodeBuildMessages([assistantMessage]);
    useOpenCodeStore.setState((state) => ({
      models: new Map(state.models).set(ENV_ID, [
        {
          id: "openai/gpt-5-review",
          name: "GPT-5 Review",
          provider: "openai",
        },
      ]),
    }));
    mockGetSessionMessages.mockResolvedValue([assistantMessage]);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    expect(await screen.findByTitle("GPT-5 Review")).toBeTruthy();
    expect(screen.queryByText("openai/gpt-5-review")).toBeNull();
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

  test("rehydrates messages and context usage from events and fails on a session error", async () => {
    const channel = eventChannel();
    mockSubscribeToEvents.mockResolvedValueOnce(channel.stream as any);
    seedPipeline("building", "running");
    seedOpenCodeStore(true);
    const refreshedMessage: NativeMessage = {
      id: "refreshed-message",
      role: "assistant",
      content: "Authoritative streamed response",
      parts: [{ type: "text", content: "Authoritative streamed response" }],
      createdAt: "2026-04-15T00:00:01.000Z",
    };
    mockGetSessionMessages.mockResolvedValue([refreshedMessage]);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);
    await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

    channel.push({
      type: "message.part.updated",
      properties: {
        part: { sessionID: SESSION_ID },
        usage: { inputTokens: 30, outputTokens: 20 },
        maxContextTokens: 1_000,
        model: "openai/gpt-5",
      },
    });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([refreshedMessage]);
      const usage = useOpenCodeStore.getState().contextUsage.get(SESSION_KEY);
      expect(usage).toEqual({
        usedTokens: 50,
        totalTokens: 1_000,
        percentUsed: 5,
        modelId: "openai/gpt-5",
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

    channel.push({
      type: "session.error",
      properties: { sessionID: SESSION_ID, error: "stream execution failed" },
    });

    await waitFor(() => {
      const session = useOpenCodeStore.getState().sessions.get(SESSION_KEY);
      expect(session?.isLoading).toBe(false);
      expect(session?.messages.at(-1)?.content).toBe("stream execution failed");
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("stream execution failed");
    });
    act(() => {
      useOpenCodeStore.getState().closeEventSubscription(ENV_ID);
      channel.close();
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

  test("dispatches and records scoped address-issues commit instructions", async () => {
    seedPipelineSessionPhase("reviewing", "running", false);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    });

    const dispatchedPrompt = mockSendPrompt.mock.calls[0]?.[2] as string;
    const transcriptPrompt = useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.at(-1)?.content;
    for (const prompt of [dispatchedPrompt, transcriptPrompt]) {
      expect(prompt).toContain("git status --porcelain");
      expect(prompt).toContain("Stage only files that clearly belong to the review fixes");
      expect(prompt).toContain(".env*");
      expect(prompt).toContain("leave them uncommitted and report them");
      expect(prompt).toContain("Do not use `--no-verify`");
      expect(prompt).not.toContain("do not finish until `git status --porcelain` is clean");
      expect(prompt).not.toContain("If there are any uncommitted changes, stage and commit them");
    }

    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.phase).toBe("addressing");
    expect(pipeline?.sessions).toHaveLength(1);
    expect(pipeline?.sessions[0]?.status).toBe("running");
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(true);
  });

  test("does not start verification while the address-issues prompt is being accepted", async () => {
    seedPipelineSessionPhase("reviewing", "running", false);
    let resolvePrompt: ((value: { success: boolean }) => void) | undefined;
    mockSendPrompt.mockImplementationOnce(
      () => new Promise<{ success: boolean }>((resolve) => {
        resolvePrompt = resolve;
      }),
    );

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

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

    await act(async () => {
      resolvePrompt?.({ success: true });
    });
  });

  test("fails the pipeline when the address-issues prompt is rejected", async () => {
    seedPipelineSessionPhase("reviewing", "running", false);
    mockSendPrompt.mockResolvedValueOnce({ success: false, error: "address prompt rejected" });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    });

    const addressSession = useOpenCodeStore.getState().sessions.get(SESSION_KEY);
    expect(addressSession?.messages.at(-1)?.content).toBe("address prompt rejected");
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("fails without starting verification when addressing ends with a session error", async () => {
    seedPipelineSessionPhase("addressing", "running", false);
    setOpenCodeBuildMessages([{
      id: "error-addressing",
      role: "assistant",
      content: "addressing session failed",
      parts: [{ type: "text", content: "addressing session failed" }],
      createdAt: "2026-04-15T00:00:01.000Z",
    }]);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("addressing session failed");
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  test("starts read-only verification with notes and task image after addressing completes", async () => {
    seedPipelineSessionPhase("addressing", "running", false);
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          taskSnapshot: {
            ...pipeline.taskSnapshot,
            images: [{ filename: "acceptance.webp", data: "aW1hZ2U=" }],
          },
        }),
      };
    });
    mockGetProjectNotes.mockResolvedValueOnce({ content: "Keep verification scoped to the ticket." });
    mockCreateSession.mockResolvedValueOnce({
      id: "verify-session",
      createdAt: "2026-04-15T00:00:02.000Z",
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("verifying");
      expect(pipeline?.sessions.at(-1)?.phase).toBe("verify");
    });

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "verify-session",
      expect.stringContaining("Verification is read-only"),
      {
        model: "openai/gpt-5",
        variant: undefined,
        mode: "build",
        attachments: [{
          type: "image",
          path: "acceptance.webp",
          dataUrl: "data:image/webp;base64,aW1hZ2U=",
          filename: "acceptance.webp",
        }],
      },
    );
    const verificationPrompt = mockSendPrompt.mock.calls[0]?.[2] as string;
    expect(verificationPrompt).toContain("Keep verification scoped to the ticket.");
    expect(verificationPrompt).toContain("Leave secrets, credentials, `.env*` files");
    expect(verificationPrompt).not.toContain("stage and commit them before continuing");
  });

  test("falls back to empty project notes when starting verification", async () => {
    seedPipelineSessionPhase("addressing", "running", false);
    mockGetProjectNotes.mockRejectedValueOnce(new Error("notes unavailable"));
    mockCreateSession.mockResolvedValueOnce({
      id: "verify-session",
      createdAt: "2026-04-15T00:00:02.000Z",
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    });

    const verificationPrompt = mockSendPrompt.mock.calls[0]?.[2] as string;
    expect(verificationPrompt).toContain("Verify the changes on the current branch");
    expect(verificationPrompt).not.toContain("**Project Notes**");
    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("verifying");
  });

  test("fails the pipeline when verification session creation is rejected", async () => {
    seedPipelineSessionPhase("addressing", "running", false);
    mockCreateSession.mockRejectedValueOnce(new Error("session creation unavailable"));

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("Failed to create verification session");
    });
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  test("fails the pipeline when the verification prompt is rejected", async () => {
    seedPipelineSessionPhase("addressing", "running", false);
    mockCreateSession.mockResolvedValueOnce({
      id: "verify-session",
      createdAt: "2026-04-15T00:00:02.000Z",
    });
    mockSendPrompt.mockResolvedValueOnce({ success: false, error: "verification prompt rejected" });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("Failed to send verification prompt");
    });
    const verifySession = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.sessions.at(-1);
    expect(useOpenCodeStore.getState().sessions.get(verifySession!.sessionKey)?.messages.at(-1)?.content).toBe(
      "verification prompt rejected",
    );
  });

  test("resuming verification with an incompatible session starts a new verify session", async () => {
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          pausedFromPhase: "verifying",
        }),
      };
    });
    mockCreateSession.mockResolvedValueOnce({
      id: "verify-session",
      createdAt: "2026-04-15T00:00:02.000Z",
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);
    fireEvent.click(await screen.findByText("Resume"));

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("verifying");
      expect(pipeline?.sessions).toHaveLength(2);
      expect(pipeline?.sessions.at(-1)?.phase).toBe("verify");
    });
    expect(mockSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "verify-session",
      expect.stringContaining("Verification is read-only"),
      expect.objectContaining({ mode: "build" }),
    );
  });

  test("resuming a paused OpenCode review starts a fresh constrained review request", async () => {
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          pausedFromPhase: "reviewing",
          structuredReviewRequestId: "stale-review-request",
          sessions: pipeline.sessions.map((session) => ({
            ...session,
            phase: "review" as const,
            label: "Review Session",
          })),
        }),
      };
    });
    mockCreateSession.mockResolvedValueOnce({
      id: "fresh-review-session",
      createdAt: "2026-04-15T00:00:02.000Z",
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);
    fireEvent.click(await screen.findByText("Resume"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        expect.anything(),
        "fresh-review-session",
        expect.stringContaining("provider-enforced output schema"),
        expect.objectContaining({
          outputSchema: expect.objectContaining({ type: "object" }),
          requestId: expect.any(String),
          mode: "build",
        }),
      );
    });
    const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
    expect(pipeline?.structuredReviewRequestId).not.toBe("stale-review-request");
    expect(pipeline?.sessions.at(-1)?.sdkSessionId).toBe("fresh-review-session");
  });

  test("hides a raw structured review carrier from the OpenCode build transcript", async () => {
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);
    const rawReport = JSON.stringify(TEST_STRUCTURED_REVIEW_REPORT);
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          pausedFromPhase: "reviewing",
          sessions: pipeline.sessions.map((session) => ({
            ...session,
            phase: "review" as const,
            label: "Review Session",
          })),
        }),
      };
    });
    setOpenCodeBuildMessages([{
      id: "raw-structured-review",
      role: "assistant",
      content: rawReport,
      parts: [{ type: "text", content: rawReport }],
      createdAt: "2026-07-25T00:00:00.000Z",
    }]);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    expect(await screen.findByText("Resume")).toBeTruthy();
    expect(document.body.textContent).not.toContain('"reviewScope"');
  });

  test("offers a fresh structured retry after an invalid OpenCode review result", async () => {
    seedPipelineSessionPhase("reviewing", "running", false);
    mockGetStructuredOutput.mockResolvedValueOnce({
      ok: true,
      provider: "opencode",
      value: { reviewSummary: "incomplete" },
    } as any);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    expect(await screen.findByRole("button", { name: "Retry Review" })).toBeTruthy();
    mockCreateSession.mockResolvedValueOnce({
      id: "retry-review-session",
      createdAt: "2026-04-15T00:00:03.000Z",
    });
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
    seedFailedReviewTransition("review-request-with-skips");
    mockGetStructuredOutput.mockResolvedValueOnce({
      ...TEST_STRUCTURED_REVIEW_OUTPUT,
      provider: "opencode",
      value: TEST_LEGACY_STRUCTURED_REVIEW_REPORT,
    } as any);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry Review" }));

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("addressing");
      expect(pipeline?.structuredReview?.testResults.notRun).toBe(13);
    });

    expect(mockGetStructuredOutput).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      "review-request-with-skips",
    );
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendPrompt).toHaveBeenCalledTimes(1);
    expect(mockSendPrompt.mock.calls[0]?.[1]).toBe(SESSION_ID);
    expect(mockSendPrompt.mock.calls[0]?.[2]).toContain(
      "Stage only files that clearly belong to the review fixes",
    );
  });

  test("retrying a review reuses a findings-free result and verifies instead", async () => {
    seedFailedReviewTransition("clean-review-request");
    mockGetStructuredOutput.mockResolvedValueOnce({
      ...TEST_CLEAN_STRUCTURED_REVIEW_OUTPUT,
      provider: "opencode",
    } as any);
    mockCreateSession.mockResolvedValueOnce({
      id: "recovered-verify-session",
      createdAt: "2026-04-15T00:00:04.000Z",
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry Review" }));

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("verifying");
      expect(pipeline?.structuredReview?.issues).toEqual([]);
      expect(pipeline?.sessions.at(-1)?.sdkSessionId).toBe("recovered-verify-session");
    });

    expect(mockSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "recovered-verify-session",
      expect.stringContaining("Verification is read-only"),
      expect.objectContaining({ mode: "build" }),
    );
  });

  test("retrying a review starts a fresh one when the durable read rejects", async () => {
    seedFailedReviewTransition("unreadable-review-request");
    mockGetStructuredOutput.mockImplementationOnce(() =>
      Promise.reject(new Error("structured output store unavailable"))
    );
    mockCreateSession.mockResolvedValueOnce({
      id: "fallback-review-session",
      createdAt: "2026-04-15T00:00:05.000Z",
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);
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
      useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.structuredReview,
    ).toBeUndefined();
  });

  test("restores the paused jump-in state when sending a message fails", async () => {
    seedPipeline("paused", "idle");
    seedOpenCodeStore(false);
    mockSendPrompt.mockResolvedValueOnce({ success: false, error: "jump-in rejected" });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    const textarea = await screen.findByPlaceholderText("Send a message to the agent...");
    fireEvent.change(textarea, { target: { value: "Try one more focused check." } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("paused");
      expect(pipeline?.sessions[0]?.status).toBe("idle");
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    });
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.at(-1)?.content).toBe(
      "jump-in rejected",
    );
  });

  test("aborts an in-flight paused jump-in without resuming the pipeline", async () => {
    seedPipeline("paused", "running");
    seedOpenCodeStore(true);

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    const stopIcon = await waitFor(() => {
      const icon = document.querySelector("button svg.lucide-circle-stop");
      expect(icon).toBeTruthy();
      return icon!;
    });
    fireEvent.click(stopIcon.closest("button")!);

    await waitFor(() => {
      expect(mockAbortSession).toHaveBeenCalledWith(expect.anything(), SESSION_ID);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    });
    expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("paused");
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

  test("starts conflict resolution when the created PR has merge conflicts", async () => {
    seedPipeline("building", "running");
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          phase: "creating-pr",
          sessions: [{
            ...pipeline.sessions[0]!,
            phase: "pr",
            label: "PR Creation Session",
          }],
        }),
      };
    });
    seedOpenCodeStore(false);
    mockDetectPr.mockResolvedValueOnce({
      url: "https://github.com/example/repo/pull/42",
      state: "open",
      hasMergeConflicts: true,
    });
    mockCreateSession.mockResolvedValueOnce({
      id: "conflict-session",
      createdAt: "2026-04-15T00:00:02.000Z",
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("resolving-conflicts");
      expect(pipeline?.sessions.at(-1)?.phase).toBe("resolve-conflicts");
    });
    expect(mockDetectPr).toHaveBeenCalledWith("container-1", "feature/test");
    expect(mockSendPrompt).toHaveBeenCalledWith(
      expect.anything(),
      "conflict-session",
      expect.stringContaining("resolve"),
      expect.objectContaining({ mode: "build" }),
    );
  });

  test("fails when conflicts remain after the conflict-resolution session", async () => {
    seedPipeline("building", "running");
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          phase: "resolving-conflicts",
          sessions: [{
            ...pipeline.sessions[0]!,
            phase: "resolve-conflicts",
            label: "Conflict Resolution Session",
          }],
        }),
      };
    });
    seedOpenCodeStore(false);
    mockDetectPr.mockResolvedValueOnce({
      url: "https://github.com/example/repo/pull/42",
      state: "open",
      hasMergeConflicts: true,
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      const pipeline = useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID);
      expect(pipeline?.phase).toBe("failed");
      expect(pipeline?.error).toBe("Merge conflicts could not be fully resolved automatically");
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSendPrompt).not.toHaveBeenCalled();
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

  describe("local bridge connection", () => {
    test("starts the local OpenCode server when setup completes", async () => {
      seedPendingPipeline();
      seedLocalEnvironment();
      mockGetLocalOpencodeServerStatus.mockImplementationOnce(async () => ({
        running: false,
        port: null,
        pid: undefined,
      }));
      globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

      render(<OpenCodeBuildChatTab data={createLocalData()} isActive />);

      await waitFor(() => {
        expect(mockGetLocalOpencodeServerStatus).toHaveBeenCalledWith(ENV_ID);
      });
      await waitFor(() => {
        expect(mockStartLocalOpencodeServer).toHaveBeenCalledWith(ENV_ID);
      });
      // The local branch resolves the port from the started server, never the
      // container status API.
      expect(mockGetOpenCodeServerStatus).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(mockCreateClient).toHaveBeenCalledWith("http://127.0.0.1:9999");
      });
    });

    test("reuses an already running local OpenCode server", async () => {
      seedPendingPipeline();
      seedLocalEnvironment();
      globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

      render(<OpenCodeBuildChatTab data={createLocalData()} isActive />);

      await waitFor(() => {
        expect(mockGetLocalOpencodeServerStatus).toHaveBeenCalledWith(ENV_ID);
      });
      expect(mockStartLocalOpencodeServer).not.toHaveBeenCalled();
    });

    test("does not start the local server while setup scripts are running", async () => {
      seedPendingPipeline();
      seedLocalEnvironment();
      useEnvironmentStore.setState({
        setupScriptsRunning: new Set([ENV_ID]),
        setupCommandsResolved: new Set([ENV_ID]),
      });

      render(<OpenCodeBuildChatTab data={createLocalData()} isActive />);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockGetLocalOpencodeServerStatus).not.toHaveBeenCalled();
      expect(mockStartLocalOpencodeServer).not.toHaveBeenCalled();
      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    });

    test("does not start the local server while setup commands are unresolved", async () => {
      seedPendingPipeline();
      seedLocalEnvironment();
      // setupCommandsResolved intentionally left empty.
      useEnvironmentStore.setState({ setupCommandsResolved: new Set() });

      render(<OpenCodeBuildChatTab data={createLocalData()} isActive />);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockGetLocalOpencodeServerStatus).not.toHaveBeenCalled();
      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    });
  });

  describe("container bridge connection", () => {
    test("fails the connection when the environment has no container id", async () => {
      seedPendingPipeline();
      useEnvironmentStore.setState({
        environments: [{
          ...useEnvironmentStore.getState().environments[0]!,
          containerId: null,
        }],
      });

      render(<OpenCodeBuildChatTab data={createData()} isActive />);

      expect(await screen.findByText("Connection Failed")).toBeTruthy();
      expect(
        screen.getByText("Container ID is required for containerized OpenCode environments"),
      ).toBeTruthy();
      expect(mockGetOpenCodeServerStatus).not.toHaveBeenCalled();
      expect(mockStartOpenCodeServer).not.toHaveBeenCalled();
    });

    test("starts the container OpenCode server when none is running", async () => {
      seedPendingPipeline();
      mockGetOpenCodeServerStatus.mockImplementationOnce(async () => ({
        running: false,
        hostPort: null,
      }));
      globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

      render(<OpenCodeBuildChatTab data={createData()} isActive />);

      await waitFor(() => {
        expect(mockGetOpenCodeServerStatus).toHaveBeenCalledWith("container-1");
      });
      await waitFor(() => {
        expect(mockStartOpenCodeServer).toHaveBeenCalledWith("container-1");
      });
      expect(mockGetLocalOpencodeServerStatus).not.toHaveBeenCalled();
    });
  });

  describe("setup gating", () => {
    test("shows the setup-pending screen while the container workspace is not ready", () => {
      seedPendingPipeline();
      useEnvironmentStore.setState({ workspaceReadyEnvironments: new Set() });

      render(<OpenCodeBuildChatTab data={createData()} isActive />);

      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
      expect(screen.getByText("Build will start automatically once setup finishes")).toBeTruthy();
    });

    for (const phase of ["complete", "failed", "paused"] as const) {
      test(`does not gate a ${phase} pipeline behind setup`, () => {
        seedPendingPipeline();
        setPipelinePhase(phase);
        useEnvironmentStore.setState({ workspaceReadyEnvironments: new Set() });

        render(<OpenCodeBuildChatTab data={createData()} isActive />);

        // Setup is still pending, but a pipeline in a terminal or paused phase
        // is never held behind the waiting screen — it falls through to the
        // normal connection UI.
        expect(screen.queryByText("Waiting for setup scripts to complete...")).toBeNull();
        expect(screen.getByText("Connecting to OpenCode server...")).toBeTruthy();
      });
    }

    test("still gates a running pipeline behind setup", () => {
      seedPendingPipeline();
      setPipelinePhase("building");
      useEnvironmentStore.setState({ workspaceReadyEnvironments: new Set() });

      render(<OpenCodeBuildChatTab data={createData()} isActive />);

      expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
    });
  });

  test("skips PR conflict detection when the environment has no container id", async () => {
    seedPipeline("building", "running");
    useBuildPipelineStore.setState((state) => {
      const pipeline = state.pipelines.get(PIPELINE_ID)!;
      return {
        pipelines: new Map(state.pipelines).set(PIPELINE_ID, {
          ...pipeline,
          phase: "creating-pr",
          sessions: [{
            ...pipeline.sessions[0]!,
            phase: "pr",
            label: "PR Creation Session",
          }],
        }),
      };
    });
    seedOpenCodeStore(false);
    // The cached client keeps the connection healthy, so only the conflict
    // check sees the missing container id.
    useEnvironmentStore.setState({
      environments: [{
        ...useEnvironmentStore.getState().environments[0]!,
        containerId: null,
      }],
    });

    render(<OpenCodeBuildChatTab data={createData()} isActive />);

    await waitFor(() => {
      expect(useBuildPipelineStore.getState().pipelines.get(PIPELINE_ID)?.phase).toBe("complete");
    });
    // No container id means no way to ask GitHub, so the pipeline treats the PR
    // as conflict-free rather than calling detectPr with an empty id.
    expect(mockDetectPr).not.toHaveBeenCalled();
  });
});
