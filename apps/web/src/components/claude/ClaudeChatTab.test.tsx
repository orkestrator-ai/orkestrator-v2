import { createSessionKey } from "@/lib/utils";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {useClaudeStore} from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type {
  ClaudeEvent,
  ClaudeMessage as ClaudeMessageType,
  ClaudeModel,
  ClaudePlanApprovalRequest,
  ClaudeQuestionRequest,
} from "@/lib/claude-client";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { mockToastError, mockToastWarning } from "../../../../../tests/mocks/sonner";

import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realResumeSessionDialog from "./ResumeSessionDialog";
// The SSE and metadata paths run payloads through the real helpers, so the
// module mock hands back the genuine module and overrides only what it must.
import * as realClaudeClient from "@/lib/claude-client";

const realClaudeClientSnapshot = { ...realClaudeClient };
const mockForkClaudeSession = mock<
  (
    _client: unknown,
    _sessionId: string,
    _options?: { upToMessageId?: string },
  ) => Promise<{ sessionId: string; title?: string }>
>(async () => ({ sessionId: "claude-fork", title: "Claude fork" }));

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realResumeSessionDialogSnapshot = { ...realResumeSessionDialog };
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;
let lastVirtualizedMessages: any[] = [];
let lastVirtualizedFind: {
  isActive: boolean;
  getSearchText: (message: ClaudeMessageType) => string;
} | null = null;
// Typed from `createSession`'s real signature rather than inferred from the
// default factory, so a test that stubs a title is not an excess-property error.
type MockCreatedSession = { sessionId: string; title?: string } | null;
const createDefaultSession = async (): Promise<MockCreatedSession> => ({
  sessionId: "session-1",
});
const mockCreateSession = mock(createDefaultSession);
const mockGetModels = mock(async (): Promise<ClaudeModel[]> => []);
const mockGetClaudeModelCatalog = mock(async () => ({
  environmentId: "env-1",
  models: await mockGetModels(),
  source: "sdk" as const,
  fetchedAt: "2026-07-25T12:00:00.000Z",
  stale: false,
}));
const mockGetSessionMessages = mock<
  (_client: unknown, _sessionId: string) => Promise<ClaudeMessageType[]>
>(async () => []);
const mockGetSession = mock<
  (_client: unknown, _sessionId: string) => Promise<any>
>(async () => null);
const mockGetPendingQuestions = mock(
  async (): Promise<ClaudeQuestionRequest[]> => [],
);
const mockGetPendingPlanApprovals = mock(
  async (): Promise<ClaudePlanApprovalRequest[]> => [],
);
const mockCheckHealth = mock(async () => true);
const mockGetSlashCommands = mock(async (): Promise<string[]> => []);
const mockSendPrompt = mock<
  (
    _client: unknown,
    _sessionId: string,
    _prompt: string,
    _options?: { requestId?: string; outputSchema?: unknown },
  ) => Promise<boolean>
>(async () => true);
const mockGetStructuredOutput = mock<
  (
    _client: unknown,
    _sessionId: string,
    _requestId?: string,
  ) => Promise<any>
>(async () => null);
const mockAbortSession = mock(async () => true);
const mockUpdateSessionPreferences = mock(
  async (
    _client: unknown,
    _sessionId: string,
    _preferences: { planMode?: boolean },
  ): Promise<void> => undefined,
);
const mockSubscribeToEvents = mock(
  (_client: unknown, _signal?: AbortSignal): AsyncIterable<ClaudeEvent> =>
    abortableEmptyEventStream(_signal),
);
// The tab refuses to build a client without a bridge token, so every server
// mock hands one back exactly as the real commands do.
const BRIDGE_AUTH_TOKEN = "claude-bridge-token";
const mockStartClaudeServer = mock(
  async (): Promise<{ hostPort: number; authToken?: string }> => ({
    hostPort: 9999,
    authToken: BRIDGE_AUTH_TOKEN,
  }),
);
const mockGetClaudeServerStatus = mock(
  async (): Promise<{
    running: boolean;
    hostPort: number | null;
    authToken?: string;
  }> => ({
    running: true,
    hostPort: 9999,
    authToken: BRIDGE_AUTH_TOKEN,
  }),
);
const mockGetClaudeServerLog = mock(async () => "");
const mockStartLocalClaudeServer = mock(
  async (): Promise<{
    running: boolean;
    port: number;
    pid: number;
    authToken?: string;
  }> => ({
    running: true,
    port: 9999,
    pid: 1234,
    authToken: BRIDGE_AUTH_TOKEN,
  }),
);
const mockGetLocalClaudeServerStatus = mock(
  async (): Promise<{
    running: boolean;
    port: number | null;
    pid: number | null;
    authToken?: string;
  }> => ({
    running: true,
    port: 9999,
    pid: 1234,
    authToken: BRIDGE_AUTH_TOKEN,
  }),
);
const mockReadFileBase64 = mock(async () => "chat-local-base64");
const mockReadContainerFileBase64 = mock(async () => "chat-container-base64");
const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockGetAgentHandoff = mock(async (_handoffId: string): Promise<any> => null);

class MockSessionNotFoundError extends Error {}

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: mock(() => ({
    isAtBottom: mockIsAtBottom,
    isAtBottomRef: { current: mockIsAtBottom },
    scrollToBottom: mockScrollToBottom,
    virtuosoRef: { current: null },
    scrollProps: {},
  })),
}));

mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, footer, find }: any) => {
    lastVirtualizedMessages = messages;
    lastVirtualizedFind = find;
    return (
      <div>
        {messages.length > 0
          ? messages.map((message: any, index: number) => (
            <div key={message.id}>
              {renderMessage(index, message, index > 0 ? messages[index - 1] : null)}
            </div>
          ))
          : emptyState}
        {footer}
      </div>
    );
  },
}));

mock.module("@/lib/claude-client", () => ({
  // Spread first so every helper the tab imports (patch application, usage
  // constants, error classes) exists; the explicit keys below still win.
  ...realClaudeClientSnapshot,
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  forkClaudeSession: mockForkClaudeSession,
  getModels: mockGetModels,
  createSession: mockCreateSession,
  getSession: mockGetSession,
  getSessionMessages: mockGetSessionMessages,
  getPendingQuestions: mockGetPendingQuestions,
  getPendingPlanApprovals: mockGetPendingPlanApprovals,
  sendPrompt: mockSendPrompt,
  getStructuredOutput: mockGetStructuredOutput,
  abortSession: mockAbortSession,
  updateSessionPreferences: mockUpdateSessionPreferences,
  subscribeToEvents: mockSubscribeToEvents,
  checkHealth: mockCheckHealth,
  getSlashCommands: mockGetSlashCommands,
  ERROR_MESSAGE_PREFIX: "error-",
  SYSTEM_MESSAGE_PREFIX: "system-",
  SessionNotFoundError: MockSessionNotFoundError,
}));

mock.module("@/lib/backend", () => ({
  claimPromptQueueHead: mock(async (
    queueKey: string,
    environmentId: string,
    _expectedMessageId: string,
    candidateMessages: Array<{ id: string }>,
  ) => ({
    claimed: candidateMessages[0] ?? null,
    queue: {
      queueKey,
      environmentId,
      messages: candidateMessages.slice(1),
      updatedAt: "2026-01-01T00:00:00.000Z",
      revision: 1,
    },
  })),
  getAgentHandoff: mockGetAgentHandoff,
  startClaudeServer: mockStartClaudeServer,
  getClaudeServerStatus: mockGetClaudeServerStatus,
  getClaudeServerLog: mockGetClaudeServerLog,
  startLocalClaudeServer: mockStartLocalClaudeServer,
  getLocalClaudeServerStatus: mockGetLocalClaudeServerStatus,
  getClaudeModelCatalog: mockGetClaudeModelCatalog,
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
  readFileBase64: mockReadFileBase64,
  readContainerFileBase64: mockReadContainerFileBase64,
  // Needed by ClaudeComposeBar/useFileSearch rendered inside ClaudeChatTab
  writeContainerFile: mock(async () => {}),
  writeLocalFile: mock(async () => "/tmp/file.png"),
  getFileTree: mock(async () => []),
  getLocalFileTree: mock(async () => []),
}));

mock.module("./ResumeSessionDialog", () => ({
  ResumeSessionDialog: ({
    open,
    onResume,
  }: {
    open: boolean;
    onResume: (sessionId: string) => void;
  }) => open ? (
    <button type="button" data-testid="claude-resume-choice" onClick={() => onResume("resumed-claude")}>
      Resume previous Claude session
    </button>
  ) : null,
}));

// Keep broad sibling components real. The narrow resume-dialog stub above is
// restored from its snapshot in afterAll so it cannot leak through Bun's
// global module cache into that component's own tests.

import { ClaudeChatTab } from "./ClaudeChatTab";
import { createAgentHandoffSnapshot } from "@/lib/agent-handoff";
import type { ClaudeNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;
const ORIGINAL_WINDOW_SET_TIMEOUT = window.setTimeout;

let mockedNow = 0;
let intervalCallback: (() => void) | null = null;
let intervalCallbacks: Array<() => void> = [];
let clearIntervalCalls = 0;

function createData(overrides: Partial<ClaudeNativeData> = {}): ClaudeNativeData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
    ...overrides,
  };
}

function agentHandoffRecord(id: string, bootstrapPrompt: string) {
  const createdAt = "2026-07-27T12:00:00.000Z";
  return {
    version: 1,
    id,
    environmentId: ENVIRONMENT_ID,
    createdAt,
    snapshot: {
      version: 1,
      id,
      environmentId: ENVIRONMENT_ID,
      sourceProvider: "codex",
      destinationProvider: "claude",
      sourceSessionId: "source-codex-session",
      createdAt,
      messages: [{
        id: "source-message",
        role: "user",
        content: "Continue the transferred task",
        parts: [{ type: "text", content: "Continue the transferred task" }],
        createdAt,
      }],
      bootstrapPrompt,
      stats: {
        messageCount: 1,
        toolCallCount: 0,
        includedMessageCount: 1,
        omittedMessageCount: 0,
        promptCharacters: bootstrapPrompt.length,
        droppedMessageCount: 0,
      },
    },
  };
}

function seedPaneLayout(
  sessionId?: string,
  initialPrompt?: string,
  launchOptions?: { initialAgentModel?: string; initialReasoningEffort?: string },
) {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        ENVIRONMENT_ID,
        {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              {
                id: TAB_ID,
                type: "claude-native",
                claudeNativeData: createData({ sessionId }),
                initialPrompt,
                initialAgentModel: launchOptions?.initialAgentModel,
                initialReasoningEffort: launchOptions?.initialReasoningEffort,
              },
            ],
            activeTabId: TAB_ID,
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    hydration: new Map([[ENVIRONMENT_ID, "done"]]),
    activeEnvironmentId: ENVIRONMENT_ID,
  });
}

function resetStores(environmentName = "review-table") {
  useConfigStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      global: {
        ...state.config.global,
        claudeModel: "claude-sonnet-4-6",
        claudeNativeFastModeDefault: false,
      },
    },
  }));

  useClaudeStore.setState({
    serverStatus: new Map(),
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as any]]),
    eventSubscriptions: new Map(),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: "session-1",
          messages: [],
          isLoading: false,
        },
      ],
    ]),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    isComposing: new Map(),
    effort: new Map(),
    planMode: new Map(),
    selectedModel: new Map(),
    messageQueue: new Map(),
    sessionInitData: new Map(),
    contextUsage: new Map(),
    pendingQuestions: new Map(),
    pendingPlanApprovals: new Map(),
    models: [],
    modelCatalogs: new Map(),
    fastMode: new Map(),
    promptSuggestions: new Map(),
    dismissedPromptSuggestions: new Map(),
    promptSuggestionOptIn: new Map(),
    includeLocalSettings: new Map(),
    selectedAgent: new Map(),
    backgroundTasks: new Map(),
  });

  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name: environmentName,
        branch: "main",
        containerId: "container-1",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-04-15T10:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "containerized",
      },
    ],
    isLoading: false,
    error: null,
    workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
  });
  seedPaneLayout();
}

/**
 * Let queued promise work settle. Used instead of `waitFor` in tests that stub
 * `setInterval`, where the library's own polling never fires.
 */
async function flushAsyncWork(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function flushMicrotaskWork(rounds = 12) {
  await act(async () => {
    for (let round = 0; round < rounds; round += 1) {
      await Promise.resolve();
    }
  });
}

function installRetryTimeoutQueue() {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let nextHandle = 20_000;
  const retryDelays = new Set([500, 1_000, 2_000, 4_000]);
  const schedule = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const delay = timeout ?? 0;
    if (!retryDelays.has(delay)) {
      return ORIGINAL_SET_TIMEOUT(handler, delay, ...args);
    }
    timers.push({
      callback: () => {
        if (typeof handler === "function") handler(...args);
      },
      delay,
    });
    return nextHandle++ as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.setTimeout = schedule;
  window.setTimeout = schedule as typeof window.setTimeout;
  return {
    timers,
    async runNextRetry() {
      const timer = timers.shift();
      if (!timer) throw new Error("Expected a queued retry timer");
      await act(async () => {
        timer.callback();
        for (let round = 0; round < 12; round += 1) await Promise.resolve();
      });
      return timer.delay;
    },
  };
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

async function* abortableEmptyEventStream(signal?: AbortSignal) {
  if (!signal?.aborted) {
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

function eventChannel() {
  const queue: ClaudeEvent[] = [];
  let wake = deferred<void>();
  let closed = false;
  const stream = (async function* () {
    while (!closed) {
      if (queue.length === 0) await wake.promise;
      while (queue.length > 0) {
        const event = queue.shift();
        if (event) yield event;
      }
    }
  })();

  return {
    stream,
    push(event: ClaudeEvent) {
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

describe("ClaudeChatTab", () => {
  afterAll(() => {
    mock.module("@/hooks", () => realHooksSnapshot);
    mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
    mock.module("./ResumeSessionDialog", () => realResumeSessionDialogSnapshot);
  });

  beforeEach(() => {
    cleanup();
    resetStores();
    mockIsAtBottom = true;
    mockScrollToBottom.mockClear();
    // `mockClear` only drops call history. Without restoring the factory too, a
    // single test's `mockResolvedValue` silently becomes the default for every
    // test after it in this file.
    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(createDefaultSession);
    mockGetModels.mockReset();
    mockGetModels.mockImplementation(async () => []);
    mockGetClaudeModelCatalog.mockReset();
    mockGetClaudeModelCatalog.mockImplementation(async () => ({
      environmentId: ENVIRONMENT_ID,
      models: await mockGetModels(),
      source: "sdk" as const,
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    }));
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockImplementation(async () => []);
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(null);
    mockGetPendingQuestions.mockReset();
    mockGetPendingQuestions.mockResolvedValue([]);
    mockGetPendingPlanApprovals.mockReset();
    mockGetPendingPlanApprovals.mockResolvedValue([]);
    mockCheckHealth.mockClear();
    mockCheckHealth.mockImplementation(async () => true);
    mockGetSlashCommands.mockReset();
    mockGetSlashCommands.mockResolvedValue([]);
    mockSendPrompt.mockReset();
    mockSendPrompt.mockResolvedValue(true);
    mockGetStructuredOutput.mockReset();
    mockGetStructuredOutput.mockResolvedValue(null);
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
    mockUpdateSessionPreferences.mockReset();
    mockUpdateSessionPreferences.mockResolvedValue(undefined);
    mockSubscribeToEvents.mockReset();
    mockSubscribeToEvents.mockImplementation(
      (_client: unknown, _signal?: AbortSignal): AsyncIterable<ClaudeEvent> =>
        abortableEmptyEventStream(_signal),
    );
    mockRenameEnvironmentFromPrompt.mockClear();
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {});
    mockGetAgentHandoff.mockReset();
    mockGetAgentHandoff.mockResolvedValue(null);
    mockStartClaudeServer.mockReset();
    mockStartClaudeServer.mockImplementation(async () => ({
      hostPort: 9999,
      authToken: BRIDGE_AUTH_TOKEN,
    }));
    mockGetClaudeServerStatus.mockReset();
    mockGetClaudeServerStatus.mockImplementation(async () => ({
      running: true,
      hostPort: 9999,
      authToken: BRIDGE_AUTH_TOKEN,
    }));
    mockGetClaudeServerLog.mockReset();
    mockGetClaudeServerLog.mockImplementation(async () => "");
    mockStartLocalClaudeServer.mockReset();
    mockStartLocalClaudeServer.mockImplementation(async () => ({
      running: true,
      port: 9999,
      pid: 1234,
      authToken: BRIDGE_AUTH_TOKEN,
    }));
    mockGetLocalClaudeServerStatus.mockReset();
    mockGetLocalClaudeServerStatus.mockImplementation(async () => ({
      running: true,
      port: 9999,
      pid: 1234,
      authToken: BRIDGE_AUTH_TOKEN,
    }));
    mockForkClaudeSession.mockClear();
    mockForkClaudeSession.mockImplementation(async () => ({
      sessionId: "claude-fork",
      title: "Claude fork",
    }));
    mockReadContainerFileBase64.mockReset();
    mockReadContainerFileBase64.mockImplementation(async () => "chat-container-base64");
    mockReadFileBase64.mockReset();
    mockReadFileBase64.mockImplementation(async () => "chat-local-base64");
    mockToastError.mockClear();
    mockToastWarning.mockClear();
    lastVirtualizedMessages = [];
    lastVirtualizedFind = null;
  });

  test("renders a friendly catalog label for the backend-confirmed assistant model", async () => {
    const catalogModel: ClaudeModel = {
      id: "sonnet",
      resolvedModel: "claude-sonnet-5",
      name: "Claude Sonnet",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    };
    const assistantMessage: ClaudeMessageType = {
      id: "assistant-with-model",
      role: "assistant",
      content: "Catalog-attributed response",
      parts: [{ type: "text", content: "Catalog-attributed response" }],
      timestamp: "2026-07-28T12:00:00.000Z",
      modelId: "claude-sonnet-5",
    };
    mockGetModels.mockResolvedValue([catalogModel]);
    mockGetSessionMessages.mockResolvedValue([assistantMessage]);
    useClaudeStore.setState((state) => ({
      sessions: new Map(state.sessions).set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [assistantMessage],
        isLoading: false,
      }),
      models: [catalogModel],
    }));

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByTitle("Claude Sonnet")).toBeTruthy();
    expect(screen.queryByText("claude-sonnet-5")).toBeNull();
  });

  test("blocks sending until a restored agent handoff finishes loading", async () => {
    const handoffId = "claude-delayed-handoff";
    const bootstrapPrompt = `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`;
    const pending = deferred<any>();
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );

    const input = document.querySelector('[data-placeholder="Ask Claude anything..."]');
    expect(input?.getAttribute("contenteditable")).toBe("false");
    expect(screen.getByTitle("Send message").hasAttribute("disabled")).toBe(true);
    expect(mockSendPrompt).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(agentHandoffRecord(handoffId, bootstrapPrompt));
      await pending.promise;
    });

    await waitFor(() =>
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        expect.stringContaining(`"id": "${handoffId}"`),
        expect.any(Object),
      ),
    );
  });

  test("stores the handoff bootstrap before the SSE subscription can overwrite it", async () => {
    /*
     * Initialization adds the first prompt to the store and only then subscribes,
     * so an inbound event cannot wipe the locally added message before it syncs.
     * Reading the prompt from a stale closure made that branch unreachable for
     * handoff tabs and pushed every bootstrap onto the post-SSE path instead.
     */
    const handoffId = "claude-ordered-handoff";
    useClaudeStore.setState({ clients: new Map(), sessions: new Map() });

    let messagesWhenSubscribed: string[] | null = null;
    mockSubscribeToEvents.mockImplementation(
      (_client: unknown, signal?: AbortSignal) => {
        messagesWhenSubscribed = (
          useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages ?? []
        ).map((message) => message.content);
        return abortableEmptyEventStream(signal);
      },
    );
    const pending = deferred<any>();
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );

    // Nothing may start while the transferred conversation is still loading.
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockSubscribeToEvents).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(agentHandoffRecord(
        handoffId,
        `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`,
      ));
      await pending.promise;
    });

    await waitFor(() => expect(mockSendPrompt).toHaveBeenCalled());
    expect(messagesWhenSubscribed).not.toBeNull();
    expect(messagesWhenSubscribed!.some((content) => content.includes(handoffId)))
      .toBe(true);
    expect(mockSendPrompt).toHaveBeenCalledTimes(1);
  });

  test("initializes once when the handoff resolves mid-mount", async () => {
    const handoffId = "claude-single-init";
    useClaudeStore.setState({ clients: new Map(), sessions: new Map() });
    const pending = deferred<any>();
    mockGetAgentHandoff.mockImplementation(async () => pending.promise);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        agentHandoffId={handoffId}
      />,
    );
    expect(mockCreateSession).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(agentHandoffRecord(
        handoffId,
        `<orkestrator-handoff id="${handoffId}">continue</orkestrator-handoff>`,
      ));
      await pending.promise;
    });
    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());

    // Gating on readiness rather than depending on the prompt value keeps the
    // effect from tearing down and restarting the moment the load resolves.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  test("shows a transcript error and clears loading when an initial prompt is rejected", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(undefined, "Run the initial Claude task");
    mockSendPrompt.mockResolvedValue(false);

    try {
      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
          initialPrompt="Run the initial Claude task"
        />,
      );

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          expect.any(Object),
          "session-1",
          "Run the initial Claude task",
          expect.any(Object),
        );
      });
      await waitFor(() => {
        const session = useClaudeStore.getState().sessions.get(SESSION_KEY);
        expect(session?.isLoading).toBe(false);
        expect(session?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: "Failed to send message. Please try again.",
          }),
        ]));
      });
      expect(
        usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.initialPrompt,
      ).toBeUndefined();
      expect(screen.getByText("Failed to send message. Please try again.")).toBeTruthy();
    } finally {
      console.error = originalError;
    }
  });

  test("keeps a resumed session's bootstrap prompt hidden after the snapshot is deleted", async () => {
    const handoffId = "claude-consumed-handoff";
    const snapshot = createAgentHandoffSnapshot({
      id: handoffId,
      environmentId: ENVIRONMENT_ID,
      sourceProvider: "codex",
      destinationProvider: "claude",
      sourceSessionId: "codex-session",
      messages: [{
        id: "source-1",
        role: "user",
        content: "original request",
        parts: [{ type: "text", content: "original request" }],
        createdAt: "2026-07-27T09:00:00.000Z",
      }],
    });
    useClaudeStore.getState().setSession(SESSION_KEY, {
      sessionId: "session-1",
      isLoading: false,
      messages: [
        {
          id: "bootstrap",
          role: "user",
          content: snapshot.bootstrapPrompt,
          parts: [{ type: "text", content: snapshot.bootstrapPrompt }],
          timestamp: "2026-07-27T10:00:00.000Z",
        },
        {
          id: "answer",
          role: "assistant",
          content: "Continuing the work.",
          parts: [{ type: "text", content: "Continuing the work." }],
          timestamp: "2026-07-27T10:01:00.000Z",
        },
      ],
    } as never);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        consumedAgentHandoffId={handoffId}
      />,
    );

    await waitFor(() =>
      expect(lastVirtualizedMessages.some(
        (message) => message.content === "Continuing the work.",
      )).toBe(true),
    );
    /*
     * The snapshot is gone — resume deleted it — but the prompt it produced is
     * still the session's first message. Rendering it raw would dump the whole
     * JSON frame into the transcript.
     */
    expect(lastVirtualizedMessages.some(
      (message) => message.content.includes("orkestrator-handoff"),
    )).toBe(false);
    expect(mockGetAgentHandoff).not.toHaveBeenCalled();
  });

  test("retains one-shot launch options while the model catalog is empty", async () => {
    // The tab is the durable carrier of the create dialog's model choice once
    // `TerminalContainer` has flushed the layout, so it must not discard the
    // options before it could apply them: an empty catalog means "nothing to
    // apply yet", and a later mount (or a Retry) has to be able to try again.
    useClaudeStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      selectedModel: new Map(),
      models: [],
    }));
    seedPaneLayout(undefined, undefined, {
      initialAgentModel: "claude-review",
      initialReasoningEffort: "xhigh",
    });
    mockGetModels.mockResolvedValueOnce([]);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="claude-review"
        initialReasoningEffort="xhigh"
      />,
    );

    // The effort is applied regardless — it needs no catalog to validate it.
    await waitFor(() => {
      expect(useClaudeStore.getState().effort.get(SESSION_KEY)).toBe("xhigh");
    });
    const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
      .find((candidate) => candidate.id === TAB_ID);
    expect(tab?.initialAgentModel).toBe("claude-review");
    expect(tab?.initialReasoningEffort).toBe("xhigh");
  });

  test("clears one-shot launch options once the catalog resolves them", async () => {
    useClaudeStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      selectedModel: new Map(),
      models: [],
    }));
    seedPaneLayout(undefined, undefined, {
      initialAgentModel: "claude-review",
      initialReasoningEffort: "xhigh",
    });
    mockGetModels.mockResolvedValueOnce([{
      id: "claude-review",
      name: "Claude Review",
      description: "Review model",
      supportsEffort: true,
      supportedEffortLevels: ["low", "xhigh"],
    } as any]);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="claude-review"
        initialReasoningEffort="xhigh"
      />,
    );

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)
        .find((candidate) => candidate.id === TAB_ID);
      expect(tab?.initialAgentModel).toBeUndefined();
      expect(tab?.initialReasoningEffort).toBeUndefined();
    });
    expect(useClaudeStore.getState().selectedModel.get(SESSION_KEY)).toBe("claude-review");
  });

  test("does not reapply one-shot review options after the tab remounts", async () => {
    const firstMount = render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="claude-review"
        initialReasoningEffort="xhigh"
      />,
    );

    await waitFor(() => {
      expect(useClaudeStore.getState().effort.get(SESSION_KEY)).toBe("xhigh");
    });
    useClaudeStore.getState().setSelectedModel(SESSION_KEY, "claude-user-choice");
    useClaudeStore.getState().setEffort(SESSION_KEY, "low");
    firstMount.unmount();

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useClaudeStore.getState().selectedModel.get(SESSION_KEY)).toBe("claude-user-choice");
      expect(useClaudeStore.getState().effort.get(SESSION_KEY)).toBe("low");
    });
  });

  test("applies a valid one-shot review model and effort to a new session", async () => {
    useClaudeStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      selectedModel: new Map(),
    }));
    mockGetModels.mockResolvedValueOnce([{
      id: "claude-review",
      name: "Claude Review",
      description: "Review model",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
    } as any]);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="claude-review"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => {
      expect(useClaudeStore.getState().selectedModel.get(SESSION_KEY)).toBe("claude-review");
      expect(useClaudeStore.getState().effort.get(SESSION_KEY)).toBe("high");
      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  afterEach(() => {
    useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
    cleanup();
    Date.now = ORIGINAL_DATE_NOW;
    globalThis.setInterval = ORIGINAL_SET_INTERVAL;
    globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
    globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
    window.setTimeout = ORIGINAL_WINDOW_SET_TIMEOUT;
    mock.restore();
  });

  test("shows the shared ready title before message history exists", () => {
    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByText("Ready to build!")).toBeTruthy();
    expect(screen.queryByText("No messages yet. Start a conversation with Claude!")).toBeNull();
  });

  test("forwards transcript search text and dedicated shortcut ownership to the virtualized list", () => {
    const message: ClaudeMessageType = {
      id: "searchable-message",
      role: "assistant",
      content: "Search the complete Claude transcript",
      parts: [{ type: "text", content: "Search the complete Claude transcript" }],
      timestamp: "2026-07-28T10:00:00.000Z",
    };
    useClaudeStore.getState().setMessages(SESSION_KEY, [message]);

    const view = render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        ownsGlobalShortcuts={false}
      />,
    );

    // A visible split-pane tab must not capture Cmd/Ctrl+F unless its pane
    // currently owns the document-level shortcuts.
    expect(lastVirtualizedFind?.isActive).toBe(false);
    expect(lastVirtualizedFind?.getSearchText(message)).toBe(message.content);

    view.rerender(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        ownsGlobalShortcuts
      />,
    );

    expect(lastVirtualizedFind?.isActive).toBe(true);
    expect(lastVirtualizedFind?.getSearchText(message)).toBe(message.content);
  });

  test("refresh requests replace the transcript and reconcile server state", async () => {
    const { rerender } = render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    mockGetSessionMessages.mockReset();
    mockGetSession.mockReset();

    const serverMessage: ClaudeMessageType = {
      id: "server-message",
      role: "assistant",
      content: "Updated by another client",
      parts: [{ type: "text", content: "Updated by another client" }],
      timestamp: "2026-07-16T12:00:00.000Z",
    };
    mockGetSessionMessages.mockResolvedValue([serverMessage]);
    mockGetSession.mockResolvedValue({ status: "running", title: "Server title" });
    mockGetPendingQuestions.mockResolvedValue([
      { id: "question-1", sessionId: "session-1", questions: [] },
    ]);
    mockGetPendingPlanApprovals.mockResolvedValue([
      { id: "approval-1", sessionId: "session-1" },
    ]);
    useClaudeStore.getState().addPendingQuestion({
      id: "stale-question",
      sessionId: "session-1",
      questions: [],
    });
    useClaudeStore.getState().addPendingPlanApproval({
      id: "stale-approval",
      sessionId: "session-1",
    });

    rerender(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => {
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [serverMessage],
        isLoading: true,
        title: "Server title",
      });
      expect(useClaudeStore.getState().pendingQuestions.has("question-1")).toBe(true);
      expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-1")).toBe(true);
      expect(useClaudeStore.getState().pendingQuestions.has("stale-question")).toBe(false);
      expect(useClaudeStore.getState().pendingPlanApprovals.has("stale-approval")).toBe(false);
    });
  });

  test("does not let a stale session snapshot undo a persisted plan-mode toggle", async () => {
    const { container, rerender } = render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    mockGetSession.mockReset();
    mockGetSessionMessages.mockResolvedValue([]);
    mockGetPendingQuestions.mockResolvedValue([]);
    mockGetPendingPlanApprovals.mockResolvedValue([]);

    const input = container.querySelector<HTMLElement>("[contenteditable=true]");
    expect(input).not.toBeNull();
    fireEvent.keyDown(input!, { key: "Tab", shiftKey: true });
    await waitFor(() =>
      expect(mockUpdateSessionPreferences).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        { planMode: true },
      ),
    );
    expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(true);

    // This response represents a GET that began before the successful PUT.
    mockGetSession.mockResolvedValue({ status: "idle", planMode: false });
    rerender(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(true);

    // A matching snapshot acknowledges the desired value and returns normal
    // authority to subsequent server snapshots.
    mockGetSession.mockClear();
    mockGetSession.mockResolvedValue({ status: "idle", planMode: true });
    rerender(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={2}
      />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

    mockGetSession.mockClear();
    mockGetSession.mockResolvedValue({ status: "idle", planMode: false });
    rerender(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={3}
      />,
    );
    await waitFor(() =>
      expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(false),
    );
  });

  test("reconciles plan mode from the server when preference persistence fails", async () => {
    mockUpdateSessionPreferences.mockRejectedValueOnce(
      new Error("preference store unavailable"),
    );
    const { container } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue({ status: "idle", planMode: false });

    const input = container.querySelector<HTMLElement>("[contenteditable=true]");
    expect(input).not.toBeNull();
    fireEvent.keyDown(input!, { key: "Tab", shiftKey: true });

    await waitFor(() =>
      expect(mockUpdateSessionPreferences).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        { planMode: true },
      ),
    );
    await waitFor(() =>
      expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(false),
    );
  });

  test("failed and missing-session refreshes preserve the current transcript", async () => {
    const { rerender } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

    const currentMessage: ClaudeMessageType = {
      id: "current-message",
      role: "assistant",
      content: "Keep this message",
      parts: [{ type: "text", content: "Keep this message" }],
      timestamp: "2026-07-16T12:00:00.000Z",
    };
    act(() => useClaudeStore.getState().setMessages(SESSION_KEY, [currentMessage]));
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue({ status: "idle" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockRejectedValue(new Error("offline"));

    rerender(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
    );
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      currentMessage,
    ]);

    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockResolvedValue([]);
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue(null);
    rerender(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={2} />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      currentMessage,
    ]);
  });

  test("abandons a refresh if its bridge client is replaced before requests begin", async () => {
    const { rerender } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    mockGetSession.mockClear();
    mockGetSessionMessages.mockClear();

    const originalGetState = useClaudeStore.getState;
    let refreshStateReads = 0;
    (useClaudeStore as any).getState = () => {
      const state = originalGetState();
      refreshStateReads += 1;
      if (refreshStateReads === 2) {
        return { ...state, clients: new Map() };
      }
      return state;
    };
    try {
      rerender(
        <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
      );
      await flushAsyncWork();

      expect(refreshStateReads).toBeGreaterThanOrEqual(2);
      expect(mockGetSession).not.toHaveBeenCalled();
      expect(mockGetSessionMessages).not.toHaveBeenCalled();
    } finally {
      (useClaudeStore as any).getState = originalGetState;
    }
  });

  test("abandons a completed refresh when the tab switches sessions in flight", async () => {
    const { rerender } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

    const serverGate = deferred<any>();
    const staleMessage: ClaudeMessageType = {
      id: "stale-refresh-message",
      role: "assistant",
      content: "Do not apply this snapshot",
      parts: [{ type: "text", content: "Do not apply this snapshot" }],
      timestamp: "2026-07-28T12:00:00.000Z",
    };
    const replacementMessage: ClaudeMessageType = {
      ...staleMessage,
      id: "replacement-session-message",
      content: "Keep the replacement session",
      parts: [{ type: "text", content: "Keep the replacement session" }],
    };
    mockGetSession.mockReset();
    mockGetSession.mockImplementation(() => serverGate.promise);
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockResolvedValue([staleMessage]);

    rerender(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
    act(() => {
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "replacement-session",
        messages: [replacementMessage],
        isLoading: false,
      });
    });
    await act(async () => {
      serverGate.resolve({ status: "running" });
      await serverGate.promise;
    });
    await flushAsyncWork();

    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
      sessionId: "replacement-session",
      messages: [replacementMessage],
      isLoading: false,
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("an older overlapping refresh cannot overwrite the newer request", async () => {
    const currentMessage: ClaudeMessageType = {
      id: "current-message",
      role: "assistant",
      content: "Current transcript",
      parts: [{ type: "text", content: "Current transcript" }],
      timestamp: "2026-07-16T12:00:00.000Z",
    };
    const staleMessage: ClaudeMessageType = {
      ...currentMessage,
      id: "stale-message",
      content: "Stale server snapshot",
      parts: [{ type: "text", content: "Stale server snapshot" }],
    };
    const newerMessage: ClaudeMessageType = {
      ...currentMessage,
      id: "newer-message",
      content: "Newer server snapshot",
      parts: [{ type: "text", content: "Newer server snapshot" }],
    };
    let resolveFirstMessages!: (messages: ClaudeMessageType[]) => void;
    const firstMessagesPromise = new Promise<ClaudeMessageType[]>((resolve) => {
      resolveFirstMessages = resolve;
    });
    const { rerender } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

    act(() => {
      useClaudeStore.getState().setMessages(SESSION_KEY, [currentMessage]);
    });
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue({ status: "idle" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages
      .mockImplementationOnce(() => firstMessagesPromise)
      .mockResolvedValue([newerMessage]);
    mockGetPendingQuestions.mockReset();
    mockGetPendingQuestions.mockResolvedValue([]);
    mockGetPendingPlanApprovals.mockReset();
    mockGetPendingPlanApprovals.mockResolvedValue([]);

    rerender(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
    );
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalledTimes(1));
    rerender(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={2} />,
    );
    await waitFor(() => {
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
        newerMessage,
      ]);
    });

    await act(async () => {
      resolveFirstMessages([staleMessage]);
      await firstMessagesPromise;
    });
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      newerMessage,
    ]);
  });

  test("does not replace a live SSE update with an older refresh snapshot", async () => {
    const { rerender } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
    );
    await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

    let resolveSnapshot!: (messages: ClaudeMessageType[]) => void;
    mockGetSession.mockReset();
    mockGetSession.mockResolvedValue({ status: "running" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockImplementation(
      () => new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    rerender(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
    );
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    const liveMessage: ClaudeMessageType = {
      id: "live-message",
      role: "assistant",
      content: "Arrived over SSE",
      parts: [{ type: "text", content: "Arrived over SSE" }],
      timestamp: "2026-07-16T12:00:01.000Z",
    };
    act(() => useClaudeStore.getState().upsertMessage(SESSION_KEY, liveMessage));
    await act(async () => {
      resolveSnapshot([]);
      await Promise.resolve();
    });

    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toContainEqual(
      liveMessage,
    );
  });

  test("shows the scroll down accessory in the compose dock and scrolls to the bottom when clicked", () => {
    mockIsAtBottom = false;
    const message: ClaudeMessageType = {
      id: "msg-existing-response",
      role: "assistant" as const,
      content: "Existing response",
      parts: [{ type: "text" as const, content: "Existing response" }],
      timestamp: "2026-03-07T12:00:00.000Z",
    };

    act(() => {
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-1",
        isLoading: false,
        messages: [message],
      });
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    const scrollButton = screen.getByRole("button", { name: "Scroll to bottom of conversation" });
    expect(scrollButton.closest('[data-testid="compose-dock"]')).not.toBeNull();

    fireEvent.click(scrollButton);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  test("renders timer states from the real elapsed timer hook", async () => {
    installTimerHarness(1_000_000);
    act(() => {
      useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Claude is thinking...");
    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText(/Completed in/)).toBeNull();

    mockedNow = 1_001_500;
    act(() => {
      intervalCallback?.();
    });

    await waitFor(() => {
      expect(screen.queryByText("1s")).not.toBeNull();
    });

    act(() => {
      useClaudeStore.getState().setSessionLoading(SESSION_KEY, false);
    });

    await waitFor(() => {
      expect(screen.queryByText("Claude is thinking...")).toBeNull();
      expect(screen.queryByText("Completed in 1s")).not.toBeNull();
    });

    expect(clearIntervalCalls).toBeGreaterThan(0);
  });

  test("keeps the status row the same fixed-height box across the end-of-turn swap", async () => {
    // The status row is the last thing in the transcript, so any height change
    // there shifts everything above it. Both states must share the class that
    // pins the height; a bare py-3 → py-1.5 swap jolts the whole view.
    installTimerHarness(1_000_000);
    act(() => {
      useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);
    });

    const { container } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
    );

    const thinkingRow = container.querySelector(".chat-status-row");
    expect(thinkingRow).not.toBeNull();
    expect(thinkingRow?.textContent).toContain("Claude is thinking...");

    mockedNow = 1_001_500;
    act(() => {
      intervalCallback?.();
    });
    act(() => {
      useClaudeStore.getState().setSessionLoading(SESSION_KEY, false);
    });

    await waitFor(() => {
      expect(screen.queryByText("Completed in 1s")).not.toBeNull();
    });

    const completedRows = container.querySelectorAll(".chat-status-row");
    expect(completedRows).toHaveLength(1);
    expect(completedRows[0]?.textContent).toContain("Completed in 1s");
    // No residual vertical padding on the wrapper — the class owns the height.
    expect(completedRows[0]?.parentElement?.className).not.toContain("py-");
  });

  describe("shared SSE event handling", () => {
    test("rehydrates transcript, status, questions, and approvals after a replay gap", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockImplementation(() => channel.stream);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      const replayedMessage: ClaudeMessageType = {
        id: "replayed-message",
        role: "assistant",
        content: "Recovered from snapshot",
        parts: [{ type: "text", content: "Recovered from snapshot" }],
        timestamp: "2026-07-20T12:00:00.000Z",
      };
      mockGetSession.mockReset();
      mockGetSession.mockResolvedValue({
        sessionId: "session-1",
        status: "running",
        title: "Recovered session",
      });
      mockGetSessionMessages.mockReset();
      mockGetSessionMessages.mockResolvedValue([replayedMessage]);
      mockGetPendingQuestions.mockReset();
      mockGetPendingQuestions.mockResolvedValue([{
        id: "fresh-question",
        sessionId: "session-1",
        questions: [],
      }]);
      mockGetPendingPlanApprovals.mockReset();
      mockGetPendingPlanApprovals.mockResolvedValue([{
        id: "fresh-approval",
        sessionId: "session-1",
      }]);
      act(() => {
        useClaudeStore.getState().addPendingQuestion({
          id: "stale-question",
          sessionId: "session-1",
          questions: [],
        });
        useClaudeStore.getState().addPendingPlanApproval({
          id: "stale-approval",
          sessionId: "session-1",
        });
      });

      channel.push({ type: "replay.required", data: {} });

      await waitFor(() => {
        const state = useClaudeStore.getState();
        expect(state.sessions.get(SESSION_KEY)).toMatchObject({
          messages: [replayedMessage],
          isLoading: true,
          title: "Recovered session",
        });
        expect(state.pendingQuestions.has("fresh-question")).toBe(true);
        expect(state.pendingQuestions.has("stale-question")).toBe(false);
        expect(state.pendingPlanApprovals.has("fresh-approval")).toBe(true);
        expect(state.pendingPlanApprovals.has("stale-approval")).toBe(false);
      });
      expect(mockGetSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
      expect(mockGetSessionMessages).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        { throwOnError: true },
      );

      useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("still reconciles the replay gap when an optional interaction endpoint fails", async () => {
      // The two interaction lists are optional. Letting a transient 500 on
      // `/questions` reject the whole reconcile leaves transcript, status,
      // title *and* the approvals list stale, with no retry and no watchdog —
      // `useStalledTurnWatchdog` is gated on `isLoading`, which a skipped
      // reconcile leaves false.
      const channel = eventChannel();
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      mockSubscribeToEvents.mockImplementation(() => channel.stream);

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

        const replayedMessage: ClaudeMessageType = {
          id: "replayed-message",
          role: "assistant",
          content: "Recovered from snapshot",
          parts: [{ type: "text", content: "Recovered from snapshot" }],
          timestamp: "2026-07-20T12:00:00.000Z",
        };
        mockGetSession.mockReset();
        mockGetSession.mockResolvedValue({
          sessionId: "session-1",
          status: "running",
          title: "Recovered session",
        });
        mockGetSessionMessages.mockReset();
        mockGetSessionMessages.mockResolvedValue([replayedMessage]);
        mockGetPendingQuestions.mockReset();
        mockGetPendingQuestions.mockRejectedValue(new Error("questions unavailable"));
        mockGetPendingPlanApprovals.mockReset();
        mockGetPendingPlanApprovals.mockResolvedValue([{
          id: "fresh-approval",
          sessionId: "session-1",
        }]);
        act(() => {
          useClaudeStore.getState().addPendingQuestion({
            id: "preserved-question",
            sessionId: "session-1",
            questions: [],
          });
          useClaudeStore.getState().addPendingPlanApproval({
            id: "stale-approval",
            sessionId: "session-1",
          });
        });

        channel.push({ type: "replay.required", data: {} });

        await waitFor(() => {
          const state = useClaudeStore.getState();
          expect(state.sessions.get(SESSION_KEY)).toMatchObject({
            messages: [replayedMessage],
            isLoading: true,
            title: "Recovered session",
          });
          // The approvals list that *did* answer is still applied, and the
          // questions list that failed is left untouched rather than cleared.
          expect(state.pendingPlanApprovals.has("fresh-approval")).toBe(true);
          expect(state.pendingPlanApprovals.has("stale-approval")).toBe(false);
          expect(state.pendingQuestions.has("preserved-question")).toBe(true);
        });

        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      } finally {
        console.warn = originalWarn;
      }
    });

    test("applies assistant updates, titles, usage, idle refreshes, and error payloads", async () => {
      const channel = eventChannel();
      const originalError = console.error;
      const consoleError = mock(() => {});
      console.error = consoleError as unknown as typeof console.error;
      mockSubscribeToEvents.mockImplementation(() => channel.stream);
      useClaudeStore.getState().setSelectedModel(SESSION_KEY, "claude-fallback-model");
      useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => {
          expect(mockSubscribeToEvents).toHaveBeenCalledWith(
            MOCK_CLIENT,
            expect.any(AbortSignal),
          );
        });
        mockGetSessionMessages.mockClear();

        const streamingMessage: ClaudeMessageType = {
          id: "sse-assistant",
          role: "assistant",
          content: "Streaming from Claude",
          parts: [{ type: "text", content: "Streaming from Claude" }],
          timestamp: "2026-07-20T12:00:00.000Z",
        };
        channel.push({
          type: "message.updated",
          sessionId: "session-1",
          data: { message: streamingMessage },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toContainEqual(
            streamingMessage,
          );
        });

        channel.push({
          type: "session.title-updated",
          sessionId: "session-1",
          data: {
            title: "Live Claude title",
            usage: { inputTokens: 25, outputTokens: 15 },
            maxContextTokens: 1_000,
          },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.title).toBe(
            "Live Claude title",
          );
          expect(useClaudeStore.getState().contextUsage.get(SESSION_KEY)).toEqual({
            usedTokens: 40,
            totalTokens: 1_000,
            percentUsed: 4,
            modelId: "claude-fallback-model",
            estimated: true,
            source: "heuristic",
            updatedAt: expect.any(String),
          });
        });

        const completedMessage: ClaudeMessageType = {
          ...streamingMessage,
          id: "sse-completed",
          content: "Claude completed",
          parts: [{ type: "text", content: "Claude completed" }],
        };
        mockGetSessionMessages.mockResolvedValue([completedMessage]);
        channel.push({
          type: "session.idle",
          sessionId: "session-1",
        });
        await waitFor(() => {
          expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
            messages: [completedMessage],
            isLoading: false,
          });
        });

        channel.push({
          type: "session.error",
          sessionId: "session-1",
          data: { error: "string failure" },
        });
        channel.push({
          type: "session.error",
          sessionId: "session-1",
          data: { error: { message: "object failure" } },
        });
        channel.push({
          type: "session.error",
          sessionId: "session-1",
          data: {},
        });
        await waitFor(() => {
          const contents = useClaudeStore
            .getState()
            .sessions.get(SESSION_KEY)
            ?.messages.map((message) => message.content);
          expect(contents).toContain("string failure");
          expect(contents).toContain("object failure");
          expect(contents).toContain("An unknown error occurred");
        });
        expect(consoleError).toHaveBeenCalledWith(
          "[ClaudeChatTab] Session error:",
          "string failure",
        );
      } finally {
        console.error = originalError;
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("authoritatively refetches non-assistant and payload-less message updates", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockImplementation(() => channel.stream);

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => {
          expect(mockSubscribeToEvents).toHaveBeenCalled();
        });
        mockGetSessionMessages.mockClear();

        const firstRefetch: ClaudeMessageType = {
          id: "sse-system-refetch",
          role: "system",
          content: "Server-originated system response",
          parts: [{ type: "text", content: "Server-originated system response" }],
          timestamp: "2026-07-20T12:00:00.000Z",
        };
        mockGetSessionMessages.mockResolvedValue([firstRefetch]);
        channel.push({
          type: "message.updated",
          sessionId: "session-1",
          data: {
            message: {
              ...firstRefetch,
              id: "raw-system-event",
            },
          },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
            firstRefetch,
          ]);
        });

        const secondRefetch: ClaudeMessageType = {
          ...firstRefetch,
          id: "sse-payloadless-refetch",
          content: "Fetched after payload-less update",
          parts: [{ type: "text", content: "Fetched after payload-less update" }],
        };
        mockGetSessionMessages.mockResolvedValue([secondRefetch]);
        channel.push({
          type: "message.updated",
          sessionId: "session-1",
          data: {},
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
            secondRefetch,
          ]);
        });
      } finally {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("applies incremental part patches and refetches when it has no base message", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockImplementation(() => channel.stream);

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
        mockGetSessionMessages.mockClear();

        const streamed: ClaudeMessageType = {
          id: "patched-assistant",
          role: "assistant",
          content: "Reading",
          parts: [
            { type: "text", content: "Reading" },
            { type: "tool-invocation", toolName: "Read", toolUseId: "t-1", toolState: "pending" },
          ],
          timestamp: "2026-07-20T12:00:00.000Z",
          revision: 1,
        };
        channel.push({
          type: "message.updated",
          sessionId: "session-1",
          data: { message: streamed },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toContainEqual(
            streamed,
          );
        });

        // A patch touching only the text block must leave the tool part — the
        // payload the bridge no longer resends — exactly as it was.
        channel.push({
          type: "message.patched",
          sessionId: "session-1",
          data: {
            messageId: "patched-assistant",
            partCount: 2,
            changedParts: [{ index: 0, part: { type: "text", content: "Reading the file" } }],
            timestamp: "2026-07-20T12:00:01.000Z",
            revision: 2,
          },
        });
        await waitFor(() => {
          const message = useClaudeStore
            .getState()
            .sessions.get(SESSION_KEY)
            ?.messages.find((candidate) => candidate.id === "patched-assistant");
          expect(message?.content).toBe("Reading the file");
          expect(message?.parts[1]).toEqual(streamed.parts[1]);
        });
        expect(mockGetSessionMessages).not.toHaveBeenCalled();

        // A patch for a message this tab never received cannot be applied, so
        // it must fall back to the authoritative transcript rather than being
        // dropped on the floor.
        const refetched: ClaudeMessageType = {
          id: "arrived-mid-turn",
          role: "assistant",
          content: "Recovered from the server",
          parts: [{ type: "text", content: "Recovered from the server" }],
          timestamp: "2026-07-20T12:00:02.000Z",
          revision: 3,
        };
        mockGetSessionMessages.mockResolvedValue([refetched]);
        channel.push({
          type: "message.patched",
          sessionId: "session-1",
          data: {
            messageId: "arrived-mid-turn",
            partCount: 1,
            changedParts: [{ index: 0, part: { type: "text", content: "unseen" } }],
            timestamp: "2026-07-20T12:00:02.000Z",
            revision: 4,
          },
        });
        await waitFor(() => {
          expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toContainEqual(
            refetched,
          );
        });
      } finally {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("refetches instead of corrupting the transcript when patch frames were missed", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockImplementation(() => channel.stream);

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
        mockGetSessionMessages.mockClear();

        const streamed: ClaudeMessageType = {
          id: "gap-assistant",
          role: "assistant",
          content: "Working",
          parts: [
            { type: "text", content: "Working" },
            { type: "tool-invocation", toolName: "Read", toolUseId: "t-1", toolState: "pending" },
          ],
          timestamp: "2026-07-20T12:00:00.000Z",
          revision: 1,
        };
        channel.push({
          type: "message.updated",
          sessionId: "session-1",
          data: { message: streamed },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toContainEqual(
            streamed,
          );
        });

        // The SSE socket drops and reconnects mid-turn. The bridge does not
        // replay, and it keeps patching because it has already published this
        // message in full — so the next frame this tab sees is several
        // revisions ahead of the copy it holds, addressing indices it has
        // never seen. Applying it would fill 2..4 with blank blocks and lose
        // whatever really happened there, permanently: the bridge only sends
        // what changed since *its* last frame, so it will never re-send them.
        const recovered: ClaudeMessageType = {
          id: "gap-assistant",
          role: "assistant",
          content: "Working and done",
          parts: [
            { type: "text", content: "Working" },
            { type: "tool-invocation", toolName: "Read", toolUseId: "t-1", toolState: "success" },
            { type: "thinking", content: "considering" },
            { type: "tool-invocation", toolName: "Grep", toolUseId: "t-2", toolState: "success" },
            { type: "text", content: " and done" },
          ],
          timestamp: "2026-07-20T12:00:05.000Z",
          revision: 6,
        };
        mockGetSessionMessages.mockResolvedValue([recovered]);
        channel.push({
          type: "message.patched",
          sessionId: "session-1",
          data: {
            messageId: "gap-assistant",
            partCount: 5,
            changedParts: [{ index: 4, part: { type: "text", content: " and done" } }],
            timestamp: "2026-07-20T12:00:05.000Z",
            revision: 6,
          },
        });

        await waitFor(() => {
          expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
        });
        await waitFor(() => {
          const message = useClaudeStore
            .getState()
            .sessions.get(SESSION_KEY)
            ?.messages.find((candidate) => candidate.id === "gap-assistant");
          expect(message).toEqual(recovered);
        });

        // Nothing blank was ever rendered into the transcript on the way.
        const message = useClaudeStore
          .getState()
          .sessions.get(SESSION_KEY)!
          .messages.find((candidate) => candidate.id === "gap-assistant")!;
        expect(message.parts.some((part) => part.type === "text" && part.content === "")).toBe(
          false,
        );

        // And the refetched revision is a valid base again, so the tab rejoins
        // the patch stream rather than refetching for the rest of the turn.
        mockGetSessionMessages.mockClear();
        channel.push({
          type: "message.patched",
          sessionId: "session-1",
          data: {
            messageId: "gap-assistant",
            partCount: 5,
            changedParts: [{ index: 4, part: { type: "text", content: " and finished" } }],
            timestamp: "2026-07-20T12:00:06.000Z",
            revision: 7,
          },
        });
        await waitFor(() => {
          const patched = useClaudeStore
            .getState()
            .sessions.get(SESSION_KEY)
            ?.messages.find((candidate) => candidate.id === "gap-assistant");
          expect(patched?.content).toBe("Working and finished");
        });
        expect(mockGetSessionMessages).not.toHaveBeenCalled();
      } finally {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("survives a malformed patch payload without dropping the subscription", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockImplementation(() => channel.stream);

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
        mockGetSessionMessages.mockClear();

        const streamed: ClaudeMessageType = {
          id: "malformed-assistant",
          role: "assistant",
          content: "Working",
          parts: [{ type: "text", content: "Working" }],
          timestamp: "2026-07-20T12:00:00.000Z",
          revision: 1,
        };
        channel.push({
          type: "message.updated",
          sessionId: "session-1",
          data: { message: streamed },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toContainEqual(
            streamed,
          );
        });

        mockGetSessionMessages.mockResolvedValue([streamed]);
        // A frame with no `changedParts` would throw out of the `for await`
        // loop and tear down the shared subscription for every tab in this
        // environment. It must degrade to a refetch instead.
        channel.push({
          type: "message.patched",
          sessionId: "session-1",
          data: {
            messageId: "malformed-assistant",
            partCount: 2,
            timestamp: "2026-07-20T12:00:01.000Z",
            revision: 2,
          },
        });
        await waitFor(() => {
          expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
        });

        // The stream is still live: a later well-formed frame is still applied.
        const later: ClaudeMessageType = {
          ...streamed,
          content: "Working still",
          parts: [{ type: "text", content: "Working still" }],
          revision: 4,
        };
        channel.push({
          type: "message.updated",
          sessionId: "session-1",
          data: { message: later },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toContainEqual(
            later,
          );
        });
      } finally {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("reconciles questions, plan state, approvals, initialization, and system notices", async () => {
      const channel = eventChannel();
      const questionExpiresAt = Date.now() + 120_000;
      const approvalExpiresAt = Date.now() + 180_000;
      mockSubscribeToEvents.mockImplementation(() => channel.stream);
      useClaudeStore.getState().setSessionInitData(ENVIRONMENT_ID, {
        mcpServers: [],
        plugins: [],
        slashCommands: ["/eager - Eagerly discovered"],
      });

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

        channel.push({
          type: "question.asked",
          sessionId: "session-1",
          data: {
            id: "question-sse",
            questions: [{
              question: "Continue?",
              header: "Confirm",
              options: [],
            }],
            toolUseId: "question-tool",
            expiresAt: questionExpiresAt,
          },
        });
        channel.push({
          type: "plan.enter-requested",
          sessionId: "session-1",
        });
        channel.push({
          type: "plan.approval-requested",
          sessionId: "session-1",
          data: {
            id: "approval-sse",
            toolUseId: "approval-tool",
            expiresAt: approvalExpiresAt,
          },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().pendingQuestions.get("question-sse")).toMatchObject({
            sessionId: "session-1",
            toolUseId: "question-tool",
            expiresAt: questionExpiresAt,
          });
          expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(true);
          expect(useClaudeStore.getState().pendingPlanApprovals.get("approval-sse")).toMatchObject({
            sessionId: "session-1",
            toolUseId: "approval-tool",
            expiresAt: approvalExpiresAt,
          });
        });

        channel.push({
          type: "question.answered",
          data: { requestId: "question-sse" },
        });
        channel.push({
          type: "plan.exit-requested",
          sessionId: "session-1",
        });
        channel.push({
          type: "plan.approval-responded",
          data: { requestId: "approval-sse", approved: true },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().pendingQuestions.has("question-sse")).toBe(false);
          expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(false);
          expect(useClaudeStore.getState().pendingPlanApprovals.has("approval-sse")).toBe(false);
        });

        channel.push({
          type: "session.init",
          sessionId: "session-1",
          data: {
            mcpServers: [{ name: "filesystem", status: "connected" }],
            plugins: [{ name: "review", status: "loaded" }],
            slashCommands: ["/sdk-only"],
            agents: [{ name: "reviewer", model: "claude-opus" }],
          },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessionInitData.get(ENVIRONMENT_ID)).toEqual({
            mcpServers: [{ name: "filesystem", status: "connected" }],
            plugins: [{ name: "review", status: "loaded" }],
            slashCommands: ["/eager - Eagerly discovered"],
            // A non-empty list: `agents: []` passed for three different
            // implementations of the init merge.
            agents: [{ name: "reviewer", model: "claude-opus" }],
          });
        });
        act(() => {
          useClaudeStore.getState().setSessionInitData(ENVIRONMENT_ID, null);
        });
        channel.push({
          type: "session.init",
          sessionId: "session-1",
          data: {
            mcpServers: [],
            plugins: [],
            slashCommands: ["/sdk-only"],
          },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessionInitData.get(ENVIRONMENT_ID)?.slashCommands)
            .toEqual(["/sdk-only"]);
        });

        channel.push({
          type: "system.compact",
          sessionId: "session-1",
          data: { preTokens: 900, postTokens: 300 },
        });
        channel.push({
          type: "system.message",
          sessionId: "session-1",
          data: { subtype: "clear" },
        });
        channel.push({
          type: "system.message",
          sessionId: "session-1",
          data: { subtype: "status" },
        });
        await waitFor(() => {
          const systemMessages = useClaudeStore
            .getState()
            .sessions.get(SESSION_KEY)
            ?.messages.filter((message) => message.role === "system")
            .map((message) => message.content);
          expect(systemMessages).toEqual([
            "Conversation compacted.",
            "Conversation cleared.",
          ]);
        });
      } finally {
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        channel.close();
      }
    });

    test("logs a dropped stream and reconnects the shared subscription", async () => {
      const replacementChannel = eventChannel();
      const originalError = console.error;
      const consoleError = mock(() => {});
      console.error = consoleError as unknown as typeof console.error;
      mockSubscribeToEvents
        .mockImplementationOnce(() => (async function* () {
          throw new Error("Claude SSE dropped");
        })())
        .mockImplementationOnce(() => replacementChannel.stream);

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

        await waitFor(() => {
          expect(consoleError).toHaveBeenCalledWith(
            "[ClaudeChatTab] Event subscription error:",
            expect.objectContaining({ message: "Claude SSE dropped" }),
          );
        });
        await waitFor(() => {
          expect(mockSubscribeToEvents).toHaveBeenCalledTimes(2);
        }, { timeout: 4_000 });
      } finally {
        console.error = originalError;
        useClaudeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
        replacementChannel.close();
      }
    });

    test("stops reconnecting after the SSE retry budget is exhausted", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      let reconnectTimers = 0;
      globalThis.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if ((timeout ?? 0) >= 3_000) {
          reconnectTimers += 1;
          queueMicrotask(() => {
            if (typeof handler === "function") handler(...args);
          });
          return (10_000 + reconnectTimers) as unknown as ReturnType<typeof setTimeout>;
        }
        return ORIGINAL_SET_TIMEOUT(handler, timeout, ...args);
      }) as typeof setTimeout;
      mockSubscribeToEvents.mockImplementation(() => (async function* () {})());

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

        await waitFor(() =>
          expect(consoleWarn).toHaveBeenCalledWith(
            "[ClaudeChatTab] SSE reconnect limit reached for",
            ENVIRONMENT_ID,
          ),
        );
        expect(reconnectTimers).toBe(10);
        expect(mockSubscribeToEvents).toHaveBeenCalledTimes(11);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  test("fast reconnect reuses the existing session instead of creating a new one", async () => {
    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockCheckHealth).toHaveBeenCalledWith(MOCK_CLIENT);
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("turns an unhealthy fast reconnect into a reconnectable error", async () => {
    mockCheckHealth.mockResolvedValueOnce(false);

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(
      await screen.findByText("Bridge server disconnected. Click retry to reconnect."),
    ).toBeTruthy();
    expect(useClaudeStore.getState().clients.has(ENVIRONMENT_ID)).toBe(false);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  test("clears stale loading state after a healthy fast reconnect reads an idle session", async () => {
    act(() => useClaudeStore.getState().setSessionLoading(SESSION_KEY, true));
    mockGetSession.mockResolvedValueOnce({ status: "idle" });

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() =>
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false),
    );
    expect(mockGetSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
  });

  test("warns distinctly for unmatched ordinary and plan-mode events", async () => {
    const channel = eventChannel();
    const originalWarn = console.warn;
    const consoleWarn = mock(() => {});
    console.warn = consoleWarn as unknown as typeof console.warn;
    mockSubscribeToEvents.mockImplementation(() => channel.stream);

    try {
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      channel.push({
        type: "session.error",
        sessionId: "unknown-session",
        data: { error: "old session failed" },
      });
      channel.push({
        type: "plan.enter-requested",
        sessionId: "unknown-session",
      });

      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[ClaudeChatTab] No session matched event",
          expect.objectContaining({
            eventType: "session.error",
            eventSessionId: "unknown-session",
          }),
        );
        expect(consoleWarn).toHaveBeenCalledWith(
          "[ClaudeChatTab] Could not find session key for plan.enter-requested event, sessionId:",
          "unknown-session",
        );
      });
    } finally {
      console.warn = originalWarn;
      channel.close();
    }
  });

  test("turns a rejected background health re-sync into a reconnectable error", async () => {
    mockCheckHealth.mockRejectedValueOnce(new Error("health transport failed"));

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(
      await screen.findByText("Bridge server disconnected. Click retry to reconnect."),
    ).toBeTruthy();
    expect(useClaudeStore.getState().clients.has(ENVIRONMENT_ID)).toBe(false);
  });

  test("merges eager slash commands case-insensitively with existing SDK commands", async () => {
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
      sessionInitData: new Map([
        [
          ENVIRONMENT_ID,
          {
            mcpServers: [],
            plugins: [],
            slashCommands: ["/review - SDK description"],
            agents: [],
          },
        ],
      ]),
    }));
    mockGetSlashCommands.mockResolvedValue([
      "/REVIEW - plugin duplicate",
      "/audit - plugin command",
    ]);

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      expect(useClaudeStore.getState().sessionInitData.get(ENVIRONMENT_ID)?.slashCommands)
        .toEqual(["/review - SDK description", "/audit - plugin command"]);
    });
  });

  test("logs eager slash-command discovery errors without failing initialization", async () => {
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    const originalDebug = console.debug;
    const consoleDebug = mock(() => {});
    const slashError = new Error("plugin scan unavailable");
    console.debug = consoleDebug as unknown as typeof console.debug;
    mockGetSlashCommands.mockRejectedValueOnce(slashError);

    try {
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => {
        expect(consoleDebug).toHaveBeenCalledWith(
          "[ClaudeChatTab] Failed to eagerly load slash commands:",
          slashError,
        );
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
          .toBe("session-1");
      });
    } finally {
      console.debug = originalDebug;
    }
  });

  test("rehydrates the session id saved in a restored pane tab", async () => {
    const restoredSessionId = "restored-claude-session";
    useClaudeStore.setState({ sessions: new Map() });
    seedPaneLayout(restoredSessionId);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, restoredSessionId);
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(
        restoredSessionId,
      );
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    const restoredRoot = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)?.root;
    expect(restoredRoot?.kind).toBe("leaf");
    if (!restoredRoot || restoredRoot.kind !== "leaf") throw new Error("Expected pane leaf");
    const restoredTab = restoredRoot.tabs.find((tab) => tab.id === TAB_ID);
    expect(restoredTab?.claudeNativeData?.sessionId).toBe(restoredSessionId);
  });

  test("replaces a restored session that the bridge confirms has expired", async () => {
    const expiredSessionId = "expired-claude-session";
    useClaudeStore.setState({ sessions: new Map() });
    seedPaneLayout(expiredSessionId);
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) => {
      if (sessionId === expiredSessionId) throw new MockSessionNotFoundError();
      return [];
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: expiredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
        .toBe("session-1");
      expect(
        usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.claudeNativeData?.sessionId,
      ).toBe("session-1");
    });
  });

  test("keeps a stored transcript when cold reconnect refresh fails transiently", async () => {
    const retainedMessage: ClaudeMessageType = {
      id: "retained",
      role: "assistant",
      content: "Keep this transcript",
      parts: [{ type: "text", content: "Keep this transcript" }],
      timestamp: "2026-04-15T10:00:00.000Z",
    };
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map([
        [
          SESSION_KEY,
          {
            sessionId: "session-1",
            messages: [retainedMessage],
            isLoading: false,
          },
        ],
      ]),
    }));
    const originalWarn = console.warn;
    const consoleWarn = mock(() => {});
    const refreshError = new Error("temporary transcript failure");
    console.warn = consoleWarn as unknown as typeof console.warn;
    mockGetSessionMessages.mockRejectedValueOnce(refreshError);

    try {
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => {
        expect(consoleWarn).toHaveBeenCalledWith(
          "[ClaudeChatTab] Failed to refresh messages on reconnect:",
          refreshError,
        );
      });
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages)
        .toEqual([retainedMessage]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("cold-restores a persisted session with its transcript", async () => {
    const restoredSessionId = "cold-restored-claude";
    const restoredMessage: ClaudeMessageType = {
      id: "restored-message",
      role: "assistant",
      content: "Persisted Claude transcript",
      parts: [{ type: "text", content: "Persisted Claude transcript" }],
      timestamp: "2026-04-15T10:00:00.000Z",
    };
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(restoredSessionId);
    mockGetSessionMessages.mockResolvedValue([restoredMessage]);
    mockGetSession.mockResolvedValue({ status: "idle" });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: restoredSessionId,
        messages: [restoredMessage],
        isLoading: false,
      });
    });
    expect(mockGetSessionMessages).toHaveBeenCalledWith(expect.anything(), restoredSessionId);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("replaces an expired restored session and persists the replacement id", async () => {
    const expiredSessionId = "expired-claude";
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(expiredSessionId);
    mockGetSessionMessages.mockRejectedValueOnce(new MockSessionNotFoundError("expired"));

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: expiredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(MOCK_CLIENT);
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.claudeNativeData?.sessionId)
        .toBe("session-1");
    });
  });

  test("retries a failed cold initialization and writes the created session id", async () => {
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout();
    mockGetModels
      .mockRejectedValueOnce(new Error("model load failed"))
      .mockRejectedValueOnce(new Error("model load failed"));

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

    await screen.findByText("model load failed");
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.claudeNativeData?.sessionId)
        .toBe("session-1");
    });
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  test("writes a manually resumed session id and transcript to both stores", async () => {
    const resumedMessage: ClaudeMessageType = {
      id: "resumed-message",
      role: "assistant",
      content: "Resumed Claude transcript",
      parts: [{ type: "text", content: "Resumed Claude transcript" }],
      timestamp: "2026-04-15T10:00:00.000Z",
    };
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
      sessionId === "resumed-claude" ? [resumedMessage] : []
    );
    mockGetSession.mockImplementation(async (_client, sessionId) =>
      sessionId === "resumed-claude"
        ? {
            id: sessionId,
            status: "idle",
            createdAt: "2026-04-15T10:00:00.000Z",
            lastActivity: "2026-04-15T10:00:00.000Z",
          }
        : null
    );
    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

    fireEvent.click(screen.getAllByRole("button", { name: "Resume Session" })[0]!);
    fireEvent.click(await screen.findByTestId("claude-resume-choice"));

    await waitFor(() => {
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "resumed-claude",
        messages: [resumedMessage],
      });
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.claudeNativeData?.sessionId)
        .toBe("resumed-claude");
    });
  });

  test("atomically replaces stale metadata when resuming another session", async () => {
    useClaudeStore.getState().setContextUsage(SESSION_KEY, {
      usedTokens: 9_000,
      totalTokens: 10_000,
      percentUsed: 90,
    });
    useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "stale suggestion");
    useClaudeStore.getState().setBackgroundTasks(SESSION_KEY, {
      old: { id: "old", status: "running" },
    });
    mockGetSession.mockImplementation(async (_client, sessionId) =>
      sessionId === "resumed-claude"
        ? {
            id: sessionId,
            title: "Resumed",
            status: "idle",
            createdAt: "2026-04-15T10:00:00.000Z",
            lastActivity: "2026-04-15T10:00:00.000Z",
          }
        : null
    );

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
    fireEvent.click(screen.getAllByRole("button", { name: "Resume Session" })[0]!);
    fireEvent.click(await screen.findByTestId("claude-resume-choice"));

    await waitFor(() =>
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
        .toBe("resumed-claude"),
    );
    const state = useClaudeStore.getState();
    expect(state.contextUsage.has(SESSION_KEY)).toBe(false);
    expect(state.promptSuggestions.has(SESSION_KEY)).toBe(false);
    expect(state.backgroundTasks.has(SESSION_KEY)).toBe(false);
  });

  test("replaces an optimistic plan preference with the resumed session mode", async () => {
    mockGetSession.mockImplementation(async (_client, sessionId) =>
      sessionId === "resumed-claude"
        ? {
            id: sessionId,
            status: "idle",
            planMode: false,
            createdAt: "2026-04-15T10:00:00.000Z",
            lastActivity: "2026-04-15T10:00:00.000Z",
          }
        : null
    );

    const { container } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />,
    );
    const input = container.querySelector<HTMLElement>("[contenteditable=true]");
    expect(input).not.toBeNull();
    fireEvent.keyDown(input!, { key: "Tab", shiftKey: true });
    await waitFor(() =>
      expect(mockUpdateSessionPreferences).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        { planMode: true },
      ),
    );
    expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Resume Session" })[0]!);
    fireEvent.click(await screen.findByTestId("claude-resume-choice"));

    await waitFor(() =>
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
        .toBe("resumed-claude"),
    );
    expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(false);
  });

  test("keeps the resume dialog open and logs when loading a resumed session fails", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    const resumeError = new Error("resume transcript unavailable");
    console.error = consoleError as unknown as typeof console.error;
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) => {
      if (sessionId === "resumed-claude") throw resumeError;
      return [];
    });

    try {
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      fireEvent.click(screen.getAllByRole("button", { name: "Resume Session" })[0]!);
      fireEvent.click(await screen.findByTestId("claude-resume-choice"));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[ClaudeChatTab] Failed to resume session:",
          resumeError,
        );
      });
      expect(screen.getByTestId("claude-resume-choice")).toBeTruthy();
      expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(
        usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.claudeNativeData?.sessionId,
      ).not.toBe("resumed-claude");
    } finally {
      console.error = originalError;
    }
  });

  test.each([
    ["missing", null],
    [
      "mismatched",
      {
        id: "different-claude-session",
        status: "idle",
        createdAt: "2026-04-15T10:00:00.000Z",
        lastActivity: "2026-04-15T10:00:00.000Z",
      },
    ],
  ] as const)(
    "rejects a %s selected server session without replacing the current session",
    async (_kind, selectedServerSession) => {
      const originalError = console.error;
      const consoleError = mock(() => {});
      console.error = consoleError as unknown as typeof console.error;
      mockGetSession.mockImplementation(async (_client, sessionId) =>
        sessionId === "resumed-claude" ? selectedServerSession : null
      );
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "resumed-claude"
          ? [{
              id: "untrusted-resume-message",
              role: "assistant",
              content: "Do not publish this transcript",
              parts: [{ type: "text", content: "Do not publish this transcript" }],
              timestamp: "2026-04-15T10:00:00.000Z",
            }]
          : []
      );

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
        fireEvent.click(screen.getAllByRole("button", { name: "Resume Session" })[0]!);
        fireEvent.click(await screen.findByTestId("claude-resume-choice"));

        await waitFor(() => {
          expect(consoleError).toHaveBeenCalledWith(
            "[ClaudeChatTab] Failed to resume session:",
            expect.objectContaining({
              message: "The selected Claude session is no longer available",
            }),
          );
        });
        expect(screen.getByTestId("claude-resume-choice")).toBeTruthy();
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
        expect(
          useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
            (message) => message.id === "untrusted-resume-message",
          ),
        ).toBe(false);
        expect(
          usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.claudeNativeData?.sessionId,
        ).not.toBe("resumed-claude");
      } finally {
        console.error = originalError;
      }
    },
  );

  describe("pending prompt rehydration", () => {
    /**
     * A question or plan approval blocks the turn until someone answers it, and
     * the SSE frame that announced it is delivered exactly once. A tab that was
     * unmounted (the user was in another environment), reconnecting, or resuming
     * a session never saw that frame and resubscribes without a cursor, so the
     * bridge replays nothing. `GET /session/:id/questions` and `/plan-approvals`
     * are the authoritative snapshot, and every path that re-establishes a view
     * of a session has to read them.
     *
     * These assert on the store rather than on the rendered card: the store is
     * what the cards render from, and what survives the unmount.
     */
    const awayQuestion: ClaudeQuestionRequest = {
      id: "question-raised-while-away",
      sessionId: "session-1",
      questions: [
        {
          question: "Which config should I edit?",
          header: "Configuration",
          options: [],
          multiSelect: false,
        },
      ],
    };

    test("a question raised while the tab was unmounted appears after remount", async () => {
      mockGetSession.mockResolvedValue({ status: "running" });
      const view = render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());
      expect(useClaudeStore.getState().pendingQuestions.size).toBe(0);

      // The user switches to another environment; Claude asks while nobody is
      // listening, so the `question.asked` frame is lost.
      view.unmount();
      mockGetPendingQuestions.mockResolvedValue([awayQuestion]);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useClaudeStore.getState().pendingQuestions.get(awayQuestion.id))
          .toMatchObject({ id: awayQuestion.id, sessionId: "session-1" }),
      );
    });

    test("a plan approval outstanding across a resume appears after the resume", async () => {
      const outstandingApproval: ClaudePlanApprovalRequest = {
        id: "approval-outstanding",
        sessionId: "resumed-claude",
        toolUseId: "tool-exit-plan",
      };
      mockGetSession.mockImplementation(async (_client, sessionId) =>
        sessionId === "resumed-claude"
          ? {
              id: sessionId,
              status: "running",
              createdAt: "2026-04-15T10:00:00.000Z",
              lastActivity: "2026-04-15T10:00:00.000Z",
            }
          : null,
      );
      mockGetPendingPlanApprovals.mockImplementation(async () => []);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      // Only the resumed session is parked on an approval.
      mockGetPendingPlanApprovals.mockResolvedValue([outstandingApproval]);

      fireEvent.click(screen.getAllByRole("button", { name: "Resume Session" })[0]!);
      fireEvent.click(await screen.findByTestId("claude-resume-choice"));

      await waitFor(() =>
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
          .toBe("resumed-claude"),
      );
      await waitFor(() =>
        expect(useClaudeStore.getState().pendingPlanApprovals.get(outstandingApproval.id))
          .toMatchObject({ id: outstandingApproval.id, sessionId: "resumed-claude" }),
      );
    });

    test("a question answered while the tab was away is not shown after remount", async () => {
      mockGetSession.mockResolvedValue({ status: "running" });
      mockGetPendingQuestions.mockResolvedValue([awayQuestion]);

      const view = render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() =>
        expect(useClaudeStore.getState().pendingQuestions.has(awayQuestion.id)).toBe(true),
      );

      // Answered from another window while this tab was unmounted: the server no
      // longer lists it, and nothing else would ever clear the card.
      view.unmount();
      mockGetPendingQuestions.mockResolvedValue([]);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useClaudeStore.getState().pendingQuestions.has(awayQuestion.id)).toBe(false),
      );
    });

    test("a superseded session's answer never lands on the session now on screen", async () => {
      /*
       * The snapshot is fetched against one session id; by the time it resolves
       * the tab may have resumed another. Applying it would show a card for a
       * conversation the user is no longer looking at.
       */
      const gate = deferred<ClaudeQuestionRequest[]>();
      mockGetSession.mockResolvedValue({ status: "running" });
      mockGetPendingQuestions.mockImplementation(() => gate.promise);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

      act(() => {
        useClaudeStore.getState().setSession(SESSION_KEY, {
          sessionId: "some-other-session",
          messages: [],
          isLoading: false,
        });
      });

      await act(async () => {
        gate.resolve([awayQuestion]);
        await gate.promise;
      });
      await flushAsyncWork();

      expect(useClaudeStore.getState().pendingQuestions.has(awayQuestion.id)).toBe(false);
    });

    test("keeps existing cards when background pending-prompt rehydration fails", async () => {
      const existingQuestion: ClaudeQuestionRequest = {
        ...awayQuestion,
        id: "question-already-visible",
      };
      act(() => useClaudeStore.getState().addPendingQuestion(existingQuestion));
      mockGetSession.mockResolvedValue({ status: "running" });
      mockGetPendingQuestions.mockRejectedValueOnce(new Error("questions temporarily unavailable"));

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());
      await flushAsyncWork();
      expect(useClaudeStore.getState().pendingQuestions.get(existingQuestion.id))
        .toEqual(existingQuestion);
      expect(screen.queryByText("Connection Failed")).toBeNull();
    });

    test("does not apply a pending-prompt snapshot from a replaced bridge client", async () => {
      const gate = deferred<ClaudeQuestionRequest[]>();
      mockGetSession.mockResolvedValue({ status: "running" });
      mockGetPendingQuestions.mockImplementation(() => gate.promise);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

      act(() => {
        useClaudeStore.setState((state) => ({
          clients: new Map(state.clients).set(
            ENVIRONMENT_ID,
            { baseUrl: "http://127.0.0.1:10000" } as any,
          ),
        }));
      });
      await act(async () => {
        gate.resolve([awayQuestion]);
        await gate.promise;
      });
      await flushAsyncWork();

      expect(useClaudeStore.getState().pendingQuestions.has(awayQuestion.id)).toBe(false);
    });

    test("silently keeps a live pending card when background rehydration becomes stale", async () => {
      const gate = deferred<ClaudeQuestionRequest[]>();
      mockGetSession.mockResolvedValue({ status: "running" });
      mockGetPendingQuestions.mockImplementation(() => gate.promise);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

      const liveQuestion: ClaudeQuestionRequest = {
        ...awayQuestion,
        id: "question-arrived-during-background-sync",
      };
      act(() => useClaudeStore.getState().addPendingQuestion(liveQuestion));
      await act(async () => {
        gate.resolve([]);
        await gate.promise;
      });
      await flushAsyncWork();

      expect(useClaudeStore.getState().pendingQuestions.get(liveQuestion.id))
        .toEqual(liveQuestion);
      expect(mockToastError).not.toHaveBeenCalled();
    });

    test("reports a manual refresh whose pending-prompt snapshot races a live card", async () => {
      mockGetSession.mockResolvedValue({ status: "idle" });
      const { rerender } = render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive
          refreshRequestId={0}
        />,
      );
      await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

      const gate = deferred<ClaudeQuestionRequest[]>();
      mockGetPendingQuestions.mockReset();
      mockGetPendingQuestions.mockImplementation(() => gate.promise);
      mockToastError.mockClear();
      rerender(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive
          refreshRequestId={1}
        />,
      );
      await waitFor(() => expect(mockGetPendingQuestions).toHaveBeenCalled());

      const liveQuestion: ClaudeQuestionRequest = {
        ...awayQuestion,
        id: "question-from-live-frame",
      };
      act(() => useClaudeStore.getState().addPendingQuestion(liveQuestion));
      await act(async () => {
        gate.resolve([]);
        await gate.promise;
      });

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "Failed to refresh Claude tab",
          {
            description: "Claude session changed while refreshing; try again",
          },
        ),
      );
      expect(useClaudeStore.getState().pendingQuestions.get(liveQuestion.id))
        .toEqual(liveQuestion);
    });
  });

  test("review tabs show Address all after messages exist and send the shared prompt", async () => {
    const message: ClaudeMessageType = {
      id: "msg-review-complete",
      role: "assistant" as const,
      content: "Review complete",
      parts: [{ type: "text" as const, content: "Review complete" }],
      timestamp: "2026-03-07T12:00:00.000Z",
    };

    act(() => {
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-1",
        isLoading: false,
        messages: [message],
      });
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        isReviewTab
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Address all" }));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        ADDRESS_ALL_REVIEW_PROMPT,
        expect.objectContaining({ attachments: undefined }),
      );
    });
    const sentMessage = useClaudeStore.getState().getSession(SESSION_KEY)?.messages.find(
      (candidate) => candidate.role === "user" && candidate.content === ADDRESS_ALL_REVIEW_PROMPT,
    );
    expect(sentMessage?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("sends a normal review as Markdown without a structured output schema", async () => {
    const reviewPrompt = "## Review Scope\n\nReturn the review in Markdown.";
    seedPaneLayout(undefined, reviewPrompt);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        isReviewTab
        initialPrompt={reviewPrompt}
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        reviewPrompt,
        expect.objectContaining({
          requestId: "initial-prompt:env-1:tab-1",
        }),
      );
    });
    expect(mockSendPrompt.mock.calls.at(-1)?.[3]).not.toHaveProperty(
      "outputSchema",
    );
    expect(mockGetStructuredOutput).not.toHaveBeenCalled();
  });

  test("queues prompts with a generated UUID while Claude is busy", async () => {
    useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);
    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
    const textarea = document.querySelector<HTMLElement>('[data-placeholder="Ask Claude anything..."]');
    expect(textarea).toBeTruthy();
    textarea!.textContent = "Queue this Claude prompt";
    fireEvent.input(textarea!);
    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      const queued = useClaudeStore.getState().messageQueue.get(SESSION_KEY)?.[0];
      expect(queued?.text).toBe("Queue this Claude prompt");
      expect(queued?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  test("passes the container id to rendered message attachment previews", async () => {
    const message: ClaudeMessageType = {
      id: "msg-container-attachment",
      role: "user" as const,
      content: 'Preview this\n\n<attached-files>\n<attachment type="image" path="/workspace/.orkestrator/clipboard/clipboard.png" filename="clipboard.png" />\n</attached-files>',
      parts: [
        {
          type: "text" as const,
          content: 'Preview this\n\n<attached-files>\n<attachment type="image" path="/workspace/.orkestrator/clipboard/clipboard.png" filename="clipboard.png" />\n</attached-files>',
        },
      ],
      timestamp: "2026-03-07T12:00:00.000Z",
    };
    mockGetSessionMessages.mockImplementation(async () => [message]);

    act(() => {
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-1",
        isLoading: false,
        messages: [message],
      });
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData({ containerId: "container-preview" })}
        isActive={false}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /clipboard\.png/i }));

    const preview = await screen.findByAltText("clipboard.png") as HTMLImageElement;
    expect(preview.src).toBe("data:image/png;base64,chat-container-base64");
    expect(mockReadContainerFileBase64).toHaveBeenCalledWith(
      "container-preview",
      "/workspace/.orkestrator/clipboard/clipboard.png",
    );
    expect(mockReadFileBase64).not.toHaveBeenCalled();
  });

  test("pins active agent task groups to the rendered bottom and releases them on success", async () => {
    const activeMessage: ClaudeMessageType = {
      id: "assistant-agent",
      role: "assistant" as const,
      content: "",
      parts: [
        { type: "text" as const, content: "Parent started" },
        {
          type: "tool-invocation" as const,
          toolName: "Agent",
          content: "Run worker",
          toolUseId: "agent-1",
          toolState: "pending",
          toolArgs: { description: "Worker agent" },
        },
        { type: "text" as const, content: "Parent continued" },
      ],
      timestamp: "2026-03-07T12:00:00.000Z",
    };
    const laterMessage: ClaudeMessageType = {
      id: "assistant-later",
      role: "assistant" as const,
      content: "Later response",
      parts: [{ type: "text" as const, content: "Later response" }],
      timestamp: "2026-03-07T12:00:30.000Z",
    };

    act(() => {
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-1",
        isLoading: false,
        messages: [activeMessage, laterMessage],
      });
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
      "assistant-agent",
      "assistant-later",
      "assistant-agent:active-agent:agent-1",
    ]);

    const completedMessage: ClaudeMessageType = {
      ...activeMessage,
      parts: activeMessage.parts.map((part) =>
        part.type === "tool-invocation"
          ? { ...part, toolState: "success" as const }
          : part
      ),
    };

    act(() => {
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-1",
        isLoading: false,
        messages: [completedMessage, laterMessage],
      });
    });

    await waitFor(() => {
      expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
        "assistant-agent",
        "assistant-later",
      ]);
      expect(lastVirtualizedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
        "text",
        "task-group",
        "text",
      ]);
    });
  });

  test("splits delayed Claude text before pinning active agent task groups", () => {
    const delayedMessage: ClaudeMessageType = {
      id: "assistant-delayed-agent",
      role: "assistant",
      content: "Parent startedParent resumed later",
      parts: [
        {
          type: "text",
          content: "Parent started",
          timestamp: "2026-03-07T12:00:30.000Z",
        },
        {
          type: "tool-invocation",
          toolName: "Agent",
          content: "Run worker",
          toolUseId: "agent-delayed-1",
          toolState: "pending",
          toolArgs: { description: "Worker agent" },
        },
        {
          type: "text",
          content: "Parent resumed later",
          timestamp: "2026-03-07T12:03:01.000Z",
        },
      ],
      timestamp: "2026-03-07T12:00:00.000Z",
    };

    act(() => {
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-1",
        isLoading: false,
        messages: [delayedMessage],
      });
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
      "assistant-delayed-agent",
      "assistant-delayed-agent:text-block:2",
      "assistant-delayed-agent:active-agent:agent-delayed-1",
    ]);
    expect(
      lastVirtualizedMessages.map((message) =>
        message.parts.map((part: any) => part.type)
      ),
    ).toEqual([
      ["text"],
      ["text"],
      ["task-group"],
    ]);
    expect(lastVirtualizedMessages.map((message) => message.content)).toEqual([
      "Parent started",
      "Parent resumed later",
      "",
    ]);
  });

  test("seeds configured fast mode default when warm path creates a new session", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeNativeFastModeDefault: true,
        },
      },
    }));
    useClaudeStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      fastMode: new Map(),
    }));

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(MOCK_CLIENT);
      expect(useClaudeStore.getState().isFastMode(SESSION_KEY)).toBe(true);
    });
  });

  test("prefers the persisted Claude model when warm path creates a new session", async () => {
    mockGetModels.mockResolvedValue([
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
    ] as any);
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "sonnet",
        },
      },
    }));
    useClaudeStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      selectedModel: new Map(),
      models: [
        { id: "opus", name: "Opus" },
        { id: "sonnet", name: "Sonnet" },
      ] as any,
    }));

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(MOCK_CLIENT);
      expect(useClaudeStore.getState().getSelectedModel(SESSION_KEY)).toBe("sonnet");
    });
  });

  test("falls back to the first available model when persisted Claude model is unavailable", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "missing-model",
        },
      },
    }));
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
      selectedModel: new Map(),
      models: [],
    }));
    mockGetModels.mockImplementation(async () => [
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
    ] as any);

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockGetModels).toHaveBeenCalled();
      expect(mockCreateSession).toHaveBeenCalled();
      expect(useClaudeStore.getState().getSelectedModel(SESSION_KEY)).toBe("opus");
    });
  });

  test("falls back to direct bridge discovery when the authoritative catalog is unavailable", async () => {
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: { ...state.config.global, claudeModel: "sonnet" },
      },
    }));
    useClaudeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
      selectedModel: new Map(),
      models: [],
      modelCatalogs: new Map(),
    }));
    // The backend-owned catalog is unreachable, so the tab must recover through
    // the direct bridge discovery path.
    mockGetClaudeModelCatalog.mockRejectedValue(new Error("catalog unavailable"));
    mockGetModels.mockImplementation(async () => [
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
    ] as any);

    render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
    );

    await waitFor(() => {
      expect(mockGetClaudeModelCatalog).toHaveBeenCalled();
      expect(mockGetModels).toHaveBeenCalled();
      // Direct discovery results are cached in the environment-scoped catalog,
      // not the legacy global list, and still drive selection.
      expect(
        useClaudeStore.getState().getModels(ENVIRONMENT_ID).map((m) => m.id),
      ).toEqual(["opus", "sonnet"]);
      expect(useClaudeStore.getState().getSelectedModel(SESSION_KEY)).toBe("sonnet");
    });
    expect(
      useClaudeStore.getState().getModelCatalog(ENVIRONMENT_ID)?.models.map((m) => m.id),
    ).toEqual(["opus", "sonnet"]);
    // The global fallback list stays empty; scoping is per environment.
    expect(useClaudeStore.getState().models).toEqual([]);
  });

  test("drains queued prompts when the session is idle", async () => {
    mockSendPrompt.mockImplementation(async () => true as any);
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run the queued review",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        "Run the queued review",
        expect.objectContaining({
          attachments: undefined,
          effort: "high",
          permissionMode: "bypassPermissions",
        }),
      );
    });
  });

  test("renames compact Electron timestamp environments before draining the first queued prompt", async () => {
    resetStores("202604151234567");
    mockSendPrompt.mockImplementation(async () => true as any);
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run the queued rename",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        "Run the queued rename",
      );
      expect(mockSendPrompt).toHaveBeenCalled();
    });
  });

  test("waits for setup readiness before draining a queued prompt while inactive", async () => {
    mockSendPrompt.mockImplementation(async () => true as any);
    useEnvironmentStore.setState({
      workspaceReadyEnvironments: new Set(),
    });
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run after Claude setup",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockSendPrompt).not.toHaveBeenCalled();

    act(() => {
      useEnvironmentStore.setState({
        workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
      });
    });

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        "Run after Claude setup",
        expect.objectContaining({
          attachments: undefined,
          effort: "high",
          permissionMode: "bypassPermissions",
        }),
      );
    });
  });

  test("removes a queued prompt and clears loading when queued send fails", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockSendPrompt.mockImplementation(async () => false as any);
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued Claude failure",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    try {
      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          "Queued Claude failure",
          expect.any(Object),
        );
      });

      await waitFor(() => {
        const state = useClaudeStore.getState();
        expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(state.messageQueue.get(SESSION_KEY)).toEqual([]);
      });
    } finally {
      console.error = originalError;
    }
  });

  test("records the rejected queued send error and clears the loading state", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    const sendError = new Error("Claude bridge rejected the queued prompt");
    console.error = consoleError as unknown as typeof console.error;
    mockSendPrompt.mockRejectedValue(sendError);
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-rejection",
      text: "Queued Claude rejection",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    try {
      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      await waitFor(() => {
        const state = useClaudeStore.getState();
        const errorMessage = state.sessions.get(SESSION_KEY)?.messages.find(
          (message) =>
            message.content
              === "Failed to send queued message: Claude bridge rejected the queued prompt",
        );
        expect(errorMessage).toMatchObject({
          role: "assistant",
          parts: [{
            type: "text",
            content: "Failed to send queued message: Claude bridge rejected the queued prompt",
          }],
        });
        expect(errorMessage?.id).toMatch(
          /^error-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(state.messageQueue.get(SESSION_KEY)).toEqual([]);
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[ClaudeChatTab] Failed to send queued prompt:",
        sendError,
      );
    } finally {
      console.error = originalError;
    }
  });

  test("does not drain queued prompts while a draft exists", async () => {
    useClaudeStore.getState().setDraftText(SESSION_KEY, "Keep this Claude draft");
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind Claude draft",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useClaudeStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.draftText.get(SESSION_KEY)).toBe("Keep this Claude draft");
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind Claude draft",
    ]);
  });

  test("does not drain queued prompts while an attachment is staged", async () => {
    useClaudeStore.getState().addAttachment(SESSION_KEY, {
      id: "staged-attachment",
      type: "image" as const,
      path: "/workspace/staged.png",
      previewUrl: "data:image/png;base64,staged",
      name: "staged.png",
    });
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind Claude attachment",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useClaudeStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.attachments.get(SESSION_KEY)?.map((attachment) => attachment.name)).toEqual([
      "staged.png",
    ]);
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind Claude attachment",
    ]);
  });

  test("stop immediately clears loading and promotes the next queued prompt to draft", async () => {
    const queuedAttachment = {
      id: "queued-attachment",
      type: "image" as const,
      path: "/workspace/queued.png",
      previewUrl: "data:image/png;base64,queued",
      name: "queued.png",
    };

    useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued Claude prompt",
      attachments: [queuedAttachment],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
    });
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-2",
      text: "Second queued Claude prompt",
      attachments: [],
      effort: "medium",
      planModeEnabled: true,
      fastModeEnabled: true,
    });

    let resolveAbort: ((value: boolean) => void) | undefined;
    mockAbortSession.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAbort = resolve;
        }),
    );

    render(
      <ClaudeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTitle("Stop current query"));

    await waitFor(() => {
      const state = useClaudeStore.getState();
      expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
      expect(state.draftText.get(SESSION_KEY)).toBe("Queued Claude prompt");
      expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
        "Second queued Claude prompt",
      ]);
      expect(state.attachments.get(SESSION_KEY)).toEqual([queuedAttachment]);
      expect(state.effort.get(SESSION_KEY)).toBe("high");
      expect(state.planMode.get(SESSION_KEY)).toBe(false);
      expect(state.fastMode.get(SESSION_KEY)).toBe(false);
    });
    expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");

    resolveAbort?.(true);

    await waitFor(() => {
      const messages = useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(messages.find((message) => message.content === "Query stopped by user.")?.id).toMatch(
        /^system-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });
  });

  test("parks the stalled-turn watchdog while the user's own refresh is running", async () => {
    /**
     * A manual refresh forces the model catalog, which makes the bridge respawn
     * model discovery plus a synchronous `claude --version`. A background
     * reconcile landing inside that window mutates the store under the manual
     * pass, which then fails with "Claude session changed while refreshing" and
     * toasts — and retrying reproduces it, because the watchdog keeps ticking
     * for as long as the turn is stalled.
     */
    installTimerHarness(1_000_000);
    const catalogGate = deferred<Awaited<ReturnType<typeof mockGetClaudeModelCatalog>>>();
    const serverMessage: ClaudeMessageType = {
      id: "server-message",
      role: "assistant",
      content: "Recovered by the refresh",
      parts: [{ type: "text", content: "Recovered by the refresh" }],
      timestamp: "2026-07-26T12:00:00.000Z",
    };
    mockGetSession.mockResolvedValue({ status: "running" });
    act(() => useClaudeStore.getState().setSessionLoading(SESSION_KEY, true));

    const { rerender } = render(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
    );
    await flushAsyncWork();

    mockGetSessionMessages.mockResolvedValue([serverMessage]);
    mockGetSession.mockClear();
    mockGetClaudeModelCatalog.mockImplementation(() => catalogGate.promise);
    mockToastError.mockClear();

    rerender(
      <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
    );
    await flushAsyncWork();
    const sessionReadsForManualRefresh = mockGetSession.mock.calls.length;
    expect(sessionReadsForManualRefresh).toBe(1);

    // Tick well past the staleness threshold while the manual pass is still
    // parked on the forced catalog reload.
    for (let tick = 0; tick < 4; tick += 1) {
      mockedNow += 5_000;
      await act(async () => {
        intervalCallback?.();
        await Promise.resolve();
      });
      await flushAsyncWork();
    }
    expect(mockGetSession.mock.calls.length).toBe(sessionReadsForManualRefresh);

    await act(async () => {
      catalogGate.resolve({
        environmentId: ENVIRONMENT_ID,
        models: [],
        source: "sdk" as const,
        fetchedAt: "2026-07-26T12:00:00.000Z",
        stale: false,
      });
      await catalogGate.promise;
    });
    await flushAsyncWork();

    expect(mockToastError).not.toHaveBeenCalled();
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      serverMessage,
    ]);

    // ...and the watchdog is genuinely armed again once the user's pass is done,
    // so the gate above throttled it rather than disabling it.
    mockedNow += 5_000;
    await act(async () => {
      intervalCallback?.();
      await Promise.resolve();
    });
    await flushAsyncWork();
    expect(mockGetSession.mock.calls.length).toBeGreaterThan(sessionReadsForManualRefresh);
  });

  test("a background watchdog refresh silently preserves a newer session update", async () => {
    installTimerHarness(2_000_000);
    mockGetSession.mockResolvedValue({ status: "running" });
    act(() => useClaudeStore.getState().setSessionLoading(SESSION_KEY, true));

    render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
    await flushAsyncWork();

    const transcriptGate = deferred<ClaudeMessageType[]>();
    const staleMessage: ClaudeMessageType = {
      id: "watchdog-stale-message",
      role: "assistant",
      content: "Stale watchdog snapshot",
      parts: [{ type: "text", content: "Stale watchdog snapshot" }],
      timestamp: "2026-07-28T12:00:00.000Z",
    };
    const liveMessage: ClaudeMessageType = {
      ...staleMessage,
      id: "watchdog-live-message",
      content: "Newer live update",
      parts: [{ type: "text", content: "Newer live update" }],
    };
    mockGetSession.mockClear();
    mockGetSession.mockResolvedValue({ status: "running" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockImplementation(() => transcriptGate.promise);
    mockToastError.mockClear();

    mockedNow += 20_000;
    await act(async () => {
      intervalCallback?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    act(() => useClaudeStore.getState().upsertMessage(SESSION_KEY, liveMessage));
    await act(async () => {
      transcriptGate.resolve([staleMessage]);
      await transcriptGate.promise;
    });
    await flushAsyncWork();

    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages)
      .toContainEqual(liveMessage);
    expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages)
      .not.toContainEqual(staleMessage);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  describe("cold start server bring-up", () => {
    beforeEach(() => {
      useClaudeStore.setState((state) => ({
        ...state,
        clients: new Map(),
        sessions: new Map(),
      }));
      seedPaneLayout();
    });

    test("automatically retries a transient bridge startup failure for a new environment", async () => {
      useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
        createdAt: new Date().toISOString(),
      });
      mockGetClaudeServerStatus
        .mockRejectedValueOnce(new Error("bridge is still starting"))
        .mockResolvedValueOnce({
          running: true,
          hostPort: 9999,
          authToken: BRIDGE_AUTH_TOKEN,
        });

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      expect(await screen.findByText("Connecting to Claude...")).toBeTruthy();
      expect(screen.queryByText("Connection Failed")).toBeNull();
      await waitFor(
        () => expect(mockCreateSession).toHaveBeenCalledTimes(1),
        { timeout: 1_500 },
      );
      expect(screen.queryByText("Connection Failed")).toBeNull();
    });

    test("shows the terminal error after exhausting retries and manual retry resets the budget", async () => {
      const retryTimers = installRetryTimeoutQueue();
      useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
        createdAt: new Date().toISOString(),
      });
      mockGetClaudeServerStatus.mockRejectedValue(new Error("bridge is still starting"));

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await flushMicrotaskWork();
      expect(retryTimers.timers.map((timer) => timer.delay)).toEqual([500]);

      expect(await retryTimers.runNextRetry()).toBe(500);
      expect(retryTimers.timers.map((timer) => timer.delay)).toEqual([1_000]);
      expect(await retryTimers.runNextRetry()).toBe(1_000);
      expect(retryTimers.timers.map((timer) => timer.delay)).toEqual([2_000]);
      expect(await retryTimers.runNextRetry()).toBe(2_000);
      expect(retryTimers.timers.map((timer) => timer.delay)).toEqual([4_000]);
      expect(await retryTimers.runNextRetry()).toBe(4_000);

      expect(screen.getByText("bridge is still starting")).toBeTruthy();
      expect(mockGetClaudeServerStatus).toHaveBeenCalledTimes(5);
      expect(retryTimers.timers).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
      await flushMicrotaskWork();

      expect(mockGetClaudeServerStatus).toHaveBeenCalledTimes(6);
      expect(retryTimers.timers.map((timer) => timer.delay)).toEqual([500]);
      expect(screen.queryByText("Connection Failed")).toBeNull();
    });

    test("does not reconnect after unmounting with an automatic retry pending", async () => {
      const retryTimers = installRetryTimeoutQueue();
      useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
        createdAt: new Date().toISOString(),
      });
      mockGetClaudeServerStatus.mockRejectedValue(new Error("bridge is still starting"));

      const view = render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await flushMicrotaskWork();
      expect(retryTimers.timers.map((timer) => timer.delay)).toEqual([500]);

      view.unmount();
      await retryTimers.runNextRetry();

      expect(mockGetClaudeServerStatus).toHaveBeenCalledTimes(1);
      expect(retryTimers.timers).toHaveLength(0);
    });

    test("retries after slow setup using a window that starts at the first connection failure", async () => {
      const retryTimers = installRetryTimeoutQueue();
      useEnvironmentStore.setState({ workspaceReadyEnvironments: new Set() });
      mockGetClaudeServerStatus
        .mockRejectedValueOnce(new Error("bridge is still starting"))
        .mockResolvedValueOnce({
          running: true,
          hostPort: 9999,
          authToken: BRIDGE_AUTH_TOKEN,
        });

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      expect(screen.getByText(/Waiting for setup/i)).toBeTruthy();
      expect(mockGetClaudeServerStatus).not.toHaveBeenCalled();

      act(() => {
        useEnvironmentStore.setState({
          workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
        });
      });
      await flushMicrotaskWork();
      expect(retryTimers.timers.map((timer) => timer.delay)).toEqual([500]);

      await retryTimers.runNextRetry();
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Connection Failed")).toBeNull();
    });

    test("starts a stopped local server and connects to its port", async () => {
      useEnvironmentStore.setState({ setupCommandsResolved: new Set([ENVIRONMENT_ID]) });
      mockGetLocalClaudeServerStatus.mockResolvedValue({
        running: false,
        port: null,
        pid: null,
      });
      mockStartLocalClaudeServer.mockResolvedValue({
        running: true,
        port: 5432,
        pid: 99,
        authToken: BRIDGE_AUTH_TOKEN,
      });

      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData({ isLocal: true, containerId: undefined })}
          isActive
        />,
      );

      await waitFor(() =>
        expect(useClaudeStore.getState().serverStatus.get(ENVIRONMENT_ID)).toEqual({
          running: true,
          hostPort: 5432,
        }),
      );
      expect(mockGetLocalClaudeServerStatus).toHaveBeenCalledWith(ENVIRONMENT_ID);
      expect(mockStartLocalClaudeServer).toHaveBeenCalledWith(ENVIRONMENT_ID);
      expect(mockGetClaudeServerStatus).not.toHaveBeenCalled();
      expect(mockCreateSession).toHaveBeenCalled();
    });

    test("reuses an already running local server without restarting it", async () => {
      useEnvironmentStore.setState({ setupCommandsResolved: new Set([ENVIRONMENT_ID]) });
      mockGetLocalClaudeServerStatus.mockResolvedValue({
        running: true,
        port: 6543,
        pid: 42,
        authToken: BRIDGE_AUTH_TOKEN,
      });

      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData({ isLocal: true, containerId: undefined })}
          isActive
        />,
      );

      await waitFor(() =>
        expect(useClaudeStore.getState().serverStatus.get(ENVIRONMENT_ID)).toEqual({
          running: true,
          hostPort: 6543,
        }),
      );
      expect(mockStartLocalClaudeServer).not.toHaveBeenCalled();
    });

    test("reports a local server that starts without a port", async () => {
      useEnvironmentStore.setState({ setupCommandsResolved: new Set([ENVIRONMENT_ID]) });
      mockGetLocalClaudeServerStatus.mockResolvedValue({
        running: false,
        port: null,
        pid: null,
      });
      mockStartLocalClaudeServer.mockResolvedValue({ running: true, port: 0, pid: 99 });

      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData({ isLocal: true, containerId: undefined })}
          isActive
        />,
      );

      expect(await screen.findByText("Local server started but no port available")).toBeTruthy();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    test("reports a container server that starts without a port", async () => {
      mockGetClaudeServerStatus.mockResolvedValue({ running: false, hostPort: null });
      mockStartClaudeServer.mockResolvedValue({ hostPort: 0 });

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      expect(await screen.findByText("Server started but no port available")).toBeTruthy();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    test("reports missing bridge authentication without creating a session", async () => {
      mockGetClaudeServerStatus.mockResolvedValue({
        running: true,
        hostPort: 9999,
      });
      mockStartClaudeServer.mockResolvedValue({ hostPort: 9999 });

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      expect(
        await screen.findByText("Failed to resolve Claude bridge authentication"),
      ).toBeTruthy();
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    test("reports a null cold-start session result", async () => {
      useClaudeStore.setState({
        clients: new Map(),
        sessions: new Map(),
      });
      mockCreateSession.mockResolvedValueOnce(null);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      expect(await screen.findByText("Failed to create session")).toBeTruthy();
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });

    test("does not retry an ambiguous session-creation failure", async () => {
      useEnvironmentStore.getState().updateEnvironment(ENVIRONMENT_ID, {
        createdAt: new Date().toISOString(),
      });
      mockCreateSession.mockRejectedValue(new Error("create response was lost"));

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      expect(await screen.findByText("create response was lost")).toBeTruthy();
      await new Promise((resolve) => ORIGINAL_SET_TIMEOUT(resolve, 600));
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });

    test("reports a null warm-path session result", async () => {
      useClaudeStore.setState({
        clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as any]]),
        sessions: new Map(),
      });
      mockCreateSession.mockResolvedValueOnce(null);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      expect(await screen.findByText("Failed to create session")).toBeTruthy();
      expect(mockGetClaudeServerStatus).not.toHaveBeenCalled();
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });

    test("rejects a containerized environment without a container id", async () => {
      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData({ containerId: undefined })}
          isActive
        />,
      );

      expect(
        await screen.findByText("Container ID is required for containerized environments"),
      ).toBeTruthy();
      expect(mockGetClaudeServerStatus).not.toHaveBeenCalled();
    });

    test("loads and reveals the container log for a timeout failure", async () => {
      mockGetClaudeServerStatus.mockRejectedValue(new Error("timeout waiting for Claude"));
      mockGetClaudeServerLog.mockResolvedValue("bridge diagnostics");

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await screen.findByText("timeout waiting for Claude");
      fireEvent.click(await screen.findByRole("button", { name: "Show Log" }));
      expect(screen.getByText("bridge diagnostics")).toBeTruthy();
      expect(mockGetClaudeServerLog).toHaveBeenCalledWith("container-1");
    });

    test("keeps the timeout error visible when the container log cannot be read", async () => {
      const originalError = console.error;
      const consoleError = mock(() => {});
      console.error = consoleError as unknown as typeof console.error;
      mockGetClaudeServerStatus.mockRejectedValue(new Error("timeout waiting for Claude"));
      mockGetClaudeServerLog.mockRejectedValue(new Error("log unavailable"));

      try {
        render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

        expect(await screen.findByText("timeout waiting for Claude")).toBeTruthy();
        await waitFor(() =>
          expect(consoleError).toHaveBeenCalledWith(
            "[ClaudeChatTab] Failed to fetch server log:",
            expect.any(Error),
          ),
        );
        expect(screen.queryByRole("button", { name: "Show Log" })).toBeNull();
      } finally {
        console.error = originalError;
      }
    });

    test("does not read a container log for a local timeout failure", async () => {
      useEnvironmentStore.setState({ setupCommandsResolved: new Set([ENVIRONMENT_ID]) });
      mockGetLocalClaudeServerStatus.mockRejectedValue(
        new Error("timeout waiting for the local Claude server"),
      );

      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData({ isLocal: true, containerId: undefined })}
          isActive
        />,
      );

      expect(
        await screen.findByText("timeout waiting for the local Claude server"),
      ).toBeTruthy();
      expect(mockGetClaudeServerLog).not.toHaveBeenCalled();
    });
  });

  test("stop logs a failed abort without adding a stopped system message", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockAbortSession.mockImplementation(async () => false);
    useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTitle("Stop current query"));

      await waitFor(() => {
        expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");
        expect(consoleError).toHaveBeenCalledWith("[ClaudeChatTab] Failed to abort session");
      });

      const messages = useClaudeStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === "Query stopped by user.")).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  describe("server session metadata", () => {
    function serverSession(overrides: Record<string, unknown> = {}) {
      return {
        status: "idle" as const,
        contextUsage: {
          usedTokens: 1_000,
          totalTokens: 10_000,
          percentUsed: 10,
          estimated: false,
          source: "claude" as const,
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
        promptSuggestion: "Add tests for the new branch",
        backgroundTasks: {
          "task-1": { id: "task-1", description: "Run the suite", status: "running" as const },
        },
        ...overrides,
      };
    }

    test("adopts usage, the suggestion and background tasks on mount", async () => {
      mockGetSession.mockResolvedValue(serverSession() as any);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(useClaudeStore.getState().contextUsage.get(SESSION_KEY)?.usedTokens).toBe(1_000);
      });
      expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBe(
        "Add tests for the new branch",
      );
      expect(
        Object.keys(useClaudeStore.getState().backgroundTasks.get(SESSION_KEY) ?? {}),
      ).toEqual(["task-1"]);
    });

    test("clears usage, the suggestion and tasks when the snapshot omits them", async () => {
      useClaudeStore.getState().setContextUsage(SESSION_KEY, {
        usedTokens: 1,
        totalTokens: 2,
        percentUsed: 50,
      });
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "stale suggestion");
      useClaudeStore.getState().setBackgroundTasks(SESSION_KEY, {
        old: { id: "old", status: "running" },
      });
      mockGetSession.mockResolvedValue(
        serverSession({
          contextUsage: undefined,
          promptSuggestion: undefined,
          backgroundTasks: undefined,
        }) as any,
      );

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBeUndefined(),
      );
      expect(useClaudeStore.getState().contextUsage.has(SESSION_KEY)).toBe(false);
      // An empty task set is stored as "no entry" by the store.
      expect(useClaudeStore.getState().backgroundTasks.has(SESSION_KEY)).toBe(false);
    });

    test("re-applies the snapshot on a manual refresh", async () => {
      // The refresh path is one of the four call sites, and it is the one a
      // user reaches deliberately after a tab has been inactive.
      mockGetSession.mockResolvedValue(serverSession() as any);
      const { rerender } = render(
        <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={0} />,
      );
      await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

      act(() => {
        useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, undefined);
        useClaudeStore.getState().setContextUsage(SESSION_KEY, {
          usedTokens: 1,
          totalTokens: 2,
          percentUsed: 50,
          estimated: true,
          source: "heuristic",
          updatedAt: "2026-07-26T00:00:00.000Z",
        });
      });
      mockGetSession.mockResolvedValue(
        serverSession({ promptSuggestion: "Refreshed suggestion" }) as any,
      );
      rerender(
        <ClaudeChatTab tabId={TAB_ID} data={createData()} isActive refreshRequestId={1} />,
      );

      await waitFor(() =>
        expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBe(
          "Refreshed suggestion",
        ),
      );
      expect(useClaudeStore.getState().contextUsage.get(SESSION_KEY)?.usedTokens).toBe(1_000);
    });

    test("ignores a snapshot the server no longer has", async () => {
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "keep me");
      mockGetSession.mockResolvedValue(null);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
      expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBe("keep me");
    });

    test("preserves valid metadata when optional REST fields are malformed", async () => {
      useClaudeStore.getState().setContextUsage(SESSION_KEY, {
        usedTokens: 1,
        totalTokens: 10,
        percentUsed: 10,
      });
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "keep suggestion");
      useClaudeStore.getState().setBackgroundTasks(SESSION_KEY, {
        keep: { id: "keep", status: "running" },
      });
      mockGetSession.mockResolvedValue({
        status: "idle",
        invalidMetadataFields: [
          "contextUsage",
          "promptSuggestion",
          "backgroundTasks",
        ],
      });

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSession).toHaveBeenCalled());

      const state = useClaudeStore.getState();
      expect(state.contextUsage.get(SESSION_KEY)?.usedTokens).toBe(1);
      expect(state.promptSuggestions.get(SESSION_KEY)).toBe("keep suggestion");
      expect(Object.keys(state.backgroundTasks.get(SESSION_KEY) ?? {})).toEqual(["keep"]);
    });

    test("adopts a snapshot whose invalid fields are only dotted sub-paths", async () => {
      /*
       * `lookupSession` reports a whole rejected field by name
       * (`"contextUsage"`) and a dropped decoration or task inside an otherwise
       * valid field as a dotted path (`"contextUsage.rateLimits"`,
       * `"backgroundTasks.<taskId>"`). Only the former means "keep what you
       * had": treating a dotted path as a whole-field rejection would freeze
       * the meter on a stale snapshot for as long as one optional decoration
       * kept arriving malformed.
       */
      useClaudeStore.getState().setContextUsage(SESSION_KEY, {
        usedTokens: 1,
        totalTokens: 10,
        percentUsed: 10,
      });
      useClaudeStore.getState().setBackgroundTasks(SESSION_KEY, {
        stale: { id: "stale", status: "running" },
      });
      mockGetSession.mockResolvedValue(
        serverSession({
          invalidMetadataFields: ["contextUsage.rateLimits", "backgroundTasks.task-2"],
        }) as any,
      );

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() =>
        expect(useClaudeStore.getState().contextUsage.get(SESSION_KEY)?.usedTokens).toBe(1_000),
      );
      const state = useClaudeStore.getState();
      expect(state.promptSuggestions.get(SESSION_KEY)).toBe("Add tests for the new branch");
      expect(Object.keys(state.backgroundTasks.get(SESSION_KEY) ?? {})).toEqual(["task-1"]);
    });
  });

  describe("session.updated frames", () => {
    async function withChannel(
      run: (channel: ReturnType<typeof eventChannel>) => Promise<void>,
    ) {
      const channel = eventChannel();
      mockSubscribeToEvents.mockImplementation(() => channel.stream);
      useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      try {
        await run(channel);
      } finally {
        channel.close();
      }
    }

    test("stores usage, the suggestion and background tasks", async () => {
      await withChannel(async (channel) => {
        channel.push({
          type: "session.updated",
          sessionId: "session-1",
          data: {
            contextUsage: {
              usedTokens: 2_000,
              totalTokens: 8_000,
              percentUsed: 25,
              estimated: false,
              source: "claude",
              updatedAt: "2026-07-26T01:00:00.000Z",
            },
            promptSuggestion: "Try the failing case",
            backgroundTasks: {
              "bg-1": { id: "bg-1", status: "running", description: "Long build" },
            },
          },
        } as any);

        await waitFor(() =>
          expect(useClaudeStore.getState().contextUsage.get(SESSION_KEY)?.usedTokens).toBe(2_000),
        );
        expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBe(
          "Try the failing case",
        );
        expect(
          useClaudeStore.getState().backgroundTasks.get(SESSION_KEY)?.["bg-1"]?.description,
        ).toBe("Long build");
      });
    });

    test("ignores malformed metadata while retaining the last valid values", async () => {
      useClaudeStore.getState().setContextUsage(SESSION_KEY, {
        usedTokens: 1,
        totalTokens: 10,
        percentUsed: 10,
      });
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "keep suggestion");
      useClaudeStore.getState().setBackgroundTasks(SESSION_KEY, {
        keep: { id: "keep", status: "running" },
      });

      await withChannel(async (channel) => {
        channel.push({
          type: "session.updated",
          sessionId: "session-1",
          data: {
            contextUsage: {
              usedTokens: 5,
              totalTokens: 10,
              totalContextTokens: 10,
              percentUsed: Number.NaN,
            },
            promptSuggestion: { text: "bad" },
            backgroundTasks: {
              bad: { id: "different-id", status: "running" },
            },
          },
        } as any);

        await new Promise((resolve) => setTimeout(resolve, 0));
        const state = useClaudeStore.getState();
        expect(state.contextUsage.get(SESSION_KEY)?.usedTokens).toBe(1);
        expect(state.promptSuggestions.get(SESSION_KEY)).toBe("keep suggestion");
        expect(Object.keys(state.backgroundTasks.get(SESSION_KEY) ?? {})).toEqual(["keep"]);
      });
    });

    test("an explicit null suggestion clears it, a missing key leaves it alone", async () => {
      /*
       * The presence check (`"promptSuggestion" in data`) is the clear
       * mechanism: the bridge sends an explicit JSON null to retract a
       * suggestion, and omits it entirely when it has nothing to say.
       */
      await withChannel(async (channel) => {
        channel.push({
          type: "session.updated",
          sessionId: "session-1",
          data: { promptSuggestion: "first" },
        } as any);
        await waitFor(() =>
          expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBe("first"),
        );

        channel.push({
          type: "session.updated",
          sessionId: "session-1",
          data: {
            backgroundTasks: {
              "bg-2": { id: "bg-2", status: "running", description: "Other work" },
            },
          },
        } as any);
        await waitFor(() =>
          expect(useClaudeStore.getState().backgroundTasks.get(SESSION_KEY)?.["bg-2"]).toBeTruthy(),
        );
        // No `promptSuggestion` key at all: the previous value must survive.
        expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBe("first");

        channel.push({
          type: "session.updated",
          sessionId: "session-1",
          data: { promptSuggestion: null },
        } as any);
        await waitFor(() =>
          expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBeUndefined(),
        );
      });
    });
  });

  describe("prompt suggestions", () => {
    function chip() {
      return screen.queryByRole("button", { name: /^Suggested: / });
    }

    /** The chip lives in the compose dock's top accessory, which only renders
     * once the composer has left its centred empty state. */
    function seedTranscript() {
      const message: ClaudeMessageType = {
        id: "assistant-1",
        role: "assistant",
        content: "Done",
        parts: [{ type: "text", content: "Done" }],
        timestamp: "2026-07-26T00:00:00.000Z",
      };
      mockGetSessionMessages.mockImplementation(async () => [message]);
      useClaudeStore.getState().setSession(SESSION_KEY, {
        sessionId: "session-1",
        isLoading: false,
        messages: [message],
      });
    }

    test("appends to an existing draft rather than destroying it", async () => {
      // `draftText` is the composer's backing store: replacing it silently
      // threw away a half-written message.
      seedTranscript();
      useClaudeStore.getState().setDraftText(SESSION_KEY, "I was still typing this");
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "Add a regression test");

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      const suggestion = await screen.findByRole("button", { name: /^Suggested: / });
      fireEvent.click(suggestion);

      const draft = useClaudeStore.getState().getDraftText(SESSION_KEY);
      expect(draft).toContain("I was still typing this");
      expect(draft).toContain("Add a regression test");
      expect(chip()).toBeNull();
    });

    test("replaces an empty draft outright", async () => {
      seedTranscript();
      useClaudeStore.getState().setDraftText(SESSION_KEY, "   ");
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "Add a regression test");

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      fireEvent.click(await screen.findByRole("button", { name: /^Suggested: / }));

      expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe("Add a regression test");
    });

    test("a consumed suggestion is not resurrected by the next authoritative snapshot", async () => {
      /*
       * The bridge never clears `session.promptSuggestion`, so mount, restore,
       * reconnect and every `session.idle` re-deliver it. Without remembering
       * what was consumed, the chip the user just used comes straight back.
       */
      const suggestion = "Add a regression test";
      seedTranscript();
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, suggestion);
      const channel = eventChannel();
      mockSubscribeToEvents.mockImplementation(() => channel.stream);

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      fireEvent.click(await screen.findByRole("button", { name: /^Suggested: / }));
      expect(chip()).toBeNull();

      try {
        channel.push({
          type: "session.updated",
          sessionId: "session-1",
          data: { promptSuggestion: suggestion },
        } as any);
        // Give the frame a chance to land before asserting it changed nothing.
        await waitFor(() =>
          expect(useClaudeStore.getState().getDraftText(SESSION_KEY)).toBe(suggestion),
        );
        expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBeUndefined();
        expect(chip()).toBeNull();

        // A genuinely new suggestion still gets through.
        channel.push({
          type: "session.updated",
          sessionId: "session-1",
          data: { promptSuggestion: "Something else entirely" },
        } as any);
        await waitFor(() =>
          expect(screen.getByRole("button", { name: /^Suggested: Something else entirely/ }))
            .toBeTruthy(),
        );
      } finally {
        channel.close();
      }
    });

    test("a consumed suggestion stays gone after this tab unmounts and remounts", async () => {
      /*
       * Switching environments unmounts the tab, and `GET /session/:id` replays
       * `promptSuggestion` on the next mount because the bridge only clears it
       * when the following prompt runs. With the latch in a component ref the
       * chip the user had already used came straight back on return; it has to
       * live in the store, keyed by session.
       */
      const suggestion = "Add a regression test";
      seedTranscript();
      useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, suggestion);

      const view = render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      fireEvent.click(await screen.findByRole("button", { name: /^Suggested: / }));
      expect(chip()).toBeNull();
      expect(useClaudeStore.getState().dismissedPromptSuggestions.get(SESSION_KEY))
        .toBe(suggestion);

      // The environment the user switched to keeps its own latch.
      view.unmount();
      mockGetSession.mockImplementation(async (_client, sessionId) => ({
        id: sessionId,
        status: "idle",
        createdAt: "2026-07-26T00:00:00.000Z",
        lastActivity: "2026-07-26T00:00:00.000Z",
        promptSuggestion: suggestion,
      }));
      useClaudeStore.getState().setDraftText(SESSION_KEY, "");

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
      await waitFor(() =>
        expect(useClaudeStore.getState().promptSuggestions.get(SESSION_KEY)).toBeUndefined(),
      );
      expect(chip()).toBeNull();

      // A genuinely new suggestion still reaches the remounted tab.
      act(() => {
        useClaudeStore.getState().setPromptSuggestion(SESSION_KEY, "Something else entirely");
      });
      expect(
        screen.getByRole("button", { name: /^Suggested: Something else entirely/ }),
      ).toBeTruthy();
    });

    test("resuming another session forgets the previous session's consumed suggestion", async () => {
      // The latch belongs to the session that was replaced: keeping it would
      // suppress the resumed session's own suggestion if the strings matched.
      useClaudeStore.getState().setDismissedPromptSuggestion(SESSION_KEY, "stale consumption");
      mockGetSession.mockImplementation(async (_client, sessionId) =>
        sessionId === "resumed-claude"
          ? {
              id: sessionId,
              status: "idle",
              createdAt: "2026-04-15T10:00:00.000Z",
              lastActivity: "2026-04-15T10:00:00.000Z",
            }
          : null,
      );

      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      fireEvent.click(screen.getAllByRole("button", { name: "Resume Session" })[0]!);
      fireEvent.click(await screen.findByTestId("claude-resume-choice"));

      await waitFor(() =>
        expect(useClaudeStore.getState().sessions.get(SESSION_KEY)?.sessionId)
          .toBe("resumed-claude"),
      );
      expect(useClaudeStore.getState().dismissedPromptSuggestions.has(SESSION_KEY)).toBe(false);
    });

    test("no chip is rendered when there is no suggestion", async () => {
      seedTranscript();
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSession).toHaveBeenCalled());
      expect(chip()).toBeNull();
    });
  });

  describe("prompt options", () => {
    test("forwards the agent, local-settings and suggestion opt-in choices", async () => {
      /*
       * Asserted as a whole object: every existing assertion uses
       * `objectContaining` on unrelated keys, so all three of these could be
       * dropped or inverted without turning the suite red.
       */
      useClaudeStore.getState().setSelectedAgent(SESSION_KEY, "reviewer");
      useClaudeStore.getState().setIncludeLocalSettings(SESSION_KEY, true);
      useClaudeStore.getState().setPromptSuggestionOptIn(SESSION_KEY, true);

      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
          initialPrompt="Review the diff"
        />,
      );

      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalled());
      const options = mockSendPrompt.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(options.agent).toBe("reviewer");
      expect(options.includeLocalSettings).toBe(true);
      expect(options.promptSuggestions).toBe(true);
    });

    test("defaults all three off when nothing was chosen", async () => {
      render(
        <ClaudeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
          initialPrompt="Review the diff"
        />,
      );

      await waitFor(() => expect(mockSendPrompt).toHaveBeenCalled());
      const options = mockSendPrompt.mock.calls[0]?.[3] as Record<string, unknown>;
      expect(options.agent).toBeUndefined();
      expect(options.includeLocalSettings).toBe(false);
      // The opt-in gates the feature: anything other than an explicit `true`
      // must not switch it on.
      expect(options.promptSuggestions).toBe(false);
    });
  });

  describe("forking from a message", () => {
    function forkButtons() {
      return screen.getAllByRole("button", { name: "Fork Claude session from this prompt" });
    }

    async function renderWithUserTurn() {
      const messages: ClaudeMessageType[] = [
        {
          id: "assistant-0",
          role: "assistant",
          content: "Existing answer",
          parts: [{ type: "text", content: "Existing answer" }],
          timestamp: "2026-07-26T00:00:00.000Z",
        },
        {
          id: "user-1",
          role: "user",
          content: "Add pagination",
          parts: [{ type: "text", content: "Add pagination" }],
          timestamp: "2026-07-26T00:01:00.000Z",
        },
      ];
      mockGetSessionMessages.mockImplementation(async () => messages);
      act(() => {
        useClaudeStore.getState().setSession(SESSION_KEY, {
          sessionId: "session-1",
          isLoading: false,
          messages,
        });
      });
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));
    }

    test("forks before a prompt and restores that prompt as the new draft", async () => {
      await renderWithUserTurn();
      fireEvent.click(forkButtons()[0]!);

      await waitFor(() =>
        expect(mockForkClaudeSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1", {
          upToMessageId: "assistant-0",
        }),
      );
      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
      );
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      expect(forked.type).toBe("claude-native");
      expect(forked.displayTitle).toBe("Claude fork");
      expect(forked.claudeNativeData?.sessionId).toBe("claude-fork");
      expect(forked.initialPrompt).toBeUndefined();
      expect(
        useClaudeStore.getState().getDraftText(
          createSessionKey(ENVIRONMENT_ID, forked.id),
        ),
      ).toBe("Add pagination");
    });

    test("creates an empty fork when the selected prompt is the first message", async () => {
      const message: ClaudeMessageType = {
        id: "user-1",
        role: "user",
        content: "First prompt",
        parts: [{ type: "text", content: "First prompt" }],
        timestamp: "2026-07-26T00:00:00.000Z",
      };
      mockCreateSession.mockResolvedValue({
        sessionId: "empty-fork",
        title: "Empty fork",
      });
      mockGetSessionMessages.mockResolvedValue([message]);
      act(() => {
        useClaudeStore.getState().setSession(SESSION_KEY, {
          sessionId: "session-1",
          isLoading: false,
          messages: [message],
        });
      });
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      fireEvent.click(await screen.findByRole("button", {
        name: "Fork Claude session from this prompt",
      }));

      await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
      expect(mockForkClaudeSession).not.toHaveBeenCalled();
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      expect(forked.claudeNativeData?.sessionId).toBe("empty-fork");
      expect(
        useClaudeStore.getState().getDraftText(
          createSessionKey(ENVIRONMENT_ID, forked.id),
        ),
      ).toBe("First prompt");
    });

    test("forks a response inclusively and leaves the new composer empty", async () => {
      const messages: ClaudeMessageType[] = [
        {
          id: "user-1",
          role: "user",
          content: "Add pagination",
          parts: [{ type: "text", content: "Add pagination" }],
          timestamp: "2026-07-26T00:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Done",
          parts: [{ type: "text", content: "Done" }],
          timestamp: "2026-07-26T00:01:00.000Z",
        },
      ];
      act(() => {
        useClaudeStore.getState().setSession(SESSION_KEY, {
          sessionId: "session-1",
          isLoading: false,
          messages,
        });
      });
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      fireEvent.click(await screen.findByRole("button", {
        name: "Fork Claude session from this response",
      }));

      await waitFor(() =>
        expect(mockForkClaudeSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1", {
          upToMessageId: "assistant-1",
        }),
      );
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      // `getDraftText` returns "" for any unseen key, so asserting on it would
      // pass whether or not a draft was written. Assert on the backing map.
      expect(
        useClaudeStore.getState().draftText.has(
          createSessionKey(ENVIRONMENT_ID, forked.id),
        ),
      ).toBe(false);
    });

    test("forks a response at the persisted id of a timestamp-split row", async () => {
      /*
       * A long turn is displayed as several rows whose ids carry a
       * `:text-block:` suffix. Only the bottom row gets the action, and the
       * bridge resolves ids by identity — handing it a display id would fail
       * with "not a persisted fork boundary".
       */
      const messages: ClaudeMessageType[] = [
        {
          id: "user-1",
          role: "user",
          content: "Add pagination",
          parts: [{ type: "text", content: "Add pagination" }],
          timestamp: "2026-07-26T00:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          timestamp: "2026-07-26T00:01:00.000Z",
          parts: [
            {
              type: "text",
              content: "Starting",
              timestamp: "2026-07-26T00:01:00.000Z",
            },
            {
              type: "tool-invocation",
              content: "Bash",
              toolName: "Bash",
              timestamp: "2026-07-26T00:02:00.000Z",
            },
            {
              type: "text",
              content: "Finished",
              timestamp: "2026-07-26T00:20:00.000Z",
            },
          ],
        } as ClaudeMessageType,
      ];
      mockGetSessionMessages.mockImplementation(async () => messages);
      act(() => {
        useClaudeStore.getState().setSession(SESSION_KEY, {
          sessionId: "session-1",
          isLoading: false,
          messages,
        });
      });
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      // The fixture has to actually split, or this test would pass against a
      // `getClaudeSourceMessageId` that did nothing at all.
      await waitFor(() =>
        expect(
          lastVirtualizedMessages.filter((m) => m.role === "assistant").map((m) => m.id),
        ).toEqual(["assistant-1", "assistant-1:text-block:2"]),
      );

      // One action for the whole split turn, not one per row.
      const responseForks = await screen.findAllByRole("button", {
        name: "Fork Claude session from this response",
      });
      expect(responseForks).toHaveLength(1);
      fireEvent.click(responseForks[0]!);

      await waitFor(() =>
        expect(mockForkClaudeSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1", {
          upToMessageId: "assistant-1",
        }),
      );
    });

    test("forks before a prompt whose predecessor is a split row", async () => {
      // The boundary here is the *previous* message, and the row before this
      // prompt is the tail half of a split turn — its display id is not an id
      // the bridge can resolve.
      const messages: ClaudeMessageType[] = [
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          timestamp: "2026-07-26T00:01:00.000Z",
          parts: [
            {
              type: "text",
              content: "Starting",
              timestamp: "2026-07-26T00:01:00.000Z",
            },
            {
              type: "tool-invocation",
              content: "Bash",
              toolName: "Bash",
              timestamp: "2026-07-26T00:02:00.000Z",
            },
            {
              type: "text",
              content: "Finished",
              timestamp: "2026-07-26T00:20:00.000Z",
            },
          ],
        } as ClaudeMessageType,
        {
          id: "user-2",
          role: "user",
          content: "Now paginate",
          parts: [{ type: "text", content: "Now paginate" }],
          timestamp: "2026-07-26T00:30:00.000Z",
        },
      ];
      mockGetSessionMessages.mockImplementation(async () => messages);
      act(() => {
        useClaudeStore.getState().setSession(SESSION_KEY, {
          sessionId: "session-1",
          isLoading: false,
          messages,
        });
      });
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() =>
        expect(
          lastVirtualizedMessages.filter((m) => m.role === "assistant").map((m) => m.id),
        ).toEqual(["assistant-1", "assistant-1:text-block:2"]),
      );

      fireEvent.click((await screen.findAllByRole("button", {
        name: "Fork Claude session from this prompt",
      }))[0]!);

      await waitFor(() =>
        expect(mockForkClaudeSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1", {
          upToMessageId: "assistant-1",
        }),
      );
    });

    test("warns that a forked prompt's attachments did not come across", async () => {
      /*
       * A prompt fork branches *before* its prompt, so the attachments are in
       * neither the fork's history nor the restored draft. Saying so beats
       * losing them silently.
       */
      const messages: ClaudeMessageType[] = [
        {
          id: "assistant-0",
          role: "assistant",
          content: "Existing answer",
          parts: [{ type: "text", content: "Existing answer" }],
          timestamp: "2026-07-26T00:00:00.000Z",
        },
        {
          id: "user-1",
          role: "user",
          content:
            "Match this mock\n<attached-files>\n"
            + '<attachment type="image" path="/tmp/mock.png" filename="mock.png" />\n'
            + "</attached-files>",
          parts: [],
          timestamp: "2026-07-26T00:01:00.000Z",
        },
      ];
      mockGetSessionMessages.mockImplementation(async () => messages);
      act(() => {
        useClaudeStore.getState().setSession(SESSION_KEY, {
          sessionId: "session-1",
          isLoading: false,
          messages,
        });
      });
      render(<ClaudeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(forkButtons().length).toBeGreaterThan(0));

      fireEvent.click(forkButtons()[0]!);

      await waitFor(() =>
        expect(mockToastWarning).toHaveBeenCalledWith(
          "1 attachment was not carried into the fork. Re-attach it before sending.",
        ),
      );
      const forked = usePaneLayoutStore
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .find((tab) => tab.id !== TAB_ID)!;
      // The text still comes across; only the file did not.
      expect(
        useClaudeStore.getState().getDraftText(
          createSessionKey(ENVIRONMENT_ID, forked.id),
        ),
      ).toBe("Match this mock");
    });

    test("does not warn when the forked prompt had no attachments", async () => {
      await renderWithUserTurn();
      fireEvent.click(forkButtons()[0]!);

      await waitFor(() => expect(mockForkClaudeSession).toHaveBeenCalled());
      expect(mockToastWarning).not.toHaveBeenCalled();
    });

    test("rejects a stale fork action after its message leaves the current plan", async () => {
      await renderWithUserTurn();
      const staleButton = forkButtons()[0] as HTMLButtonElement & Record<string, any>;
      const reactPropsKey = Object.keys(staleButton).find((key) =>
        key.startsWith("__reactProps$")
      );
      if (!reactPropsKey) throw new Error("Expected React event props on fork button");
      const staleClick = staleButton[reactPropsKey]?.onClick as (() => void) | undefined;
      if (!staleClick) throw new Error("Expected fork click handler");

      act(() => useClaudeStore.getState().setMessages(SESSION_KEY, []));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Fork Claude session from this prompt" }),
        ).toBeNull(),
      );
      await act(async () => {
        staleClick();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(
          "The selected message is no longer in this session",
        ),
      );
      expect(mockForkClaudeSession).not.toHaveBeenCalled();
    });

    test("reports a fork the bridge refuses", async () => {
      mockForkClaudeSession.mockImplementation(async () => {
        throw new Error("Claude cannot fork this session");
      });
      await renderWithUserTurn();
      fireEvent.click(forkButtons()[0]!);

      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(1),
      );
    });

    test("a double click forks once", async () => {
      let release!: (value: { sessionId: string; title?: string }) => void;
      mockForkClaudeSession.mockImplementation(
        () => new Promise((resolve) => {
          release = resolve;
        }),
      );
      await renderWithUserTurn();

      fireEvent.click(forkButtons()[0]!);
      await waitFor(() => expect(forkButtons()[0]!.hasAttribute("disabled")).toBe(true));
      fireEvent.click(forkButtons()[0]!);

      await act(async () => {
        release({ sessionId: "claude-fork", title: "Claude fork" });
      });

      expect(mockForkClaudeSession).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)).toHaveLength(2),
      );
      await waitFor(() => expect(forkButtons()[0]!.hasAttribute("disabled")).toBe(false));
    });
  });


});

function installTimerHarness(startTime: number) {
  mockedNow = startTime;
  intervalCallbacks = [];
  // The component registers several intervals (elapsed timer, stalled-turn
  // watchdog). Keeping only the last one silently dropped whichever registered
  // first, so fire them all — the same shape Codex's harness uses.
  intervalCallback = () => {
    for (const callback of [...intervalCallbacks]) callback();
  };
  clearIntervalCalls = 0;
  Date.now = () => mockedNow;
  let nextHandle = 1;
  globalThis.setInterval = (((callback: TimerHandler) => {
    intervalCallbacks.push(callback as () => void);
    return nextHandle++ as unknown as ReturnType<typeof setInterval>;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearIntervalCalls += 1;
  }) as typeof clearInterval;
}
