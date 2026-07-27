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
import { mockToastError } from "../../../../../tests/mocks/sonner";

import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realResumeSessionDialog from "./ResumeSessionDialog";

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realResumeSessionDialogSnapshot = { ...realResumeSessionDialog };
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;
let lastVirtualizedMessages: any[] = [];
const mockCreateSession = mock(async () => ({ sessionId: "session-1" }));
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
const mockGetSession = mock(async () => null as null | {
  status: "idle" | "running" | "error";
  title?: string;
  error?: string;
});
const mockGetPendingQuestions = mock(
  async (): Promise<ClaudeQuestionRequest[]> => [],
);
const mockGetPendingPlanApprovals = mock(
  async (): Promise<ClaudePlanApprovalRequest[]> => [],
);
const mockCheckHealth = mock(async () => true);
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
const mockSubscribeToEvents = mock(
  (_client: unknown, _signal?: AbortSignal): AsyncIterable<ClaudeEvent> =>
    abortableEmptyEventStream(_signal),
);
const mockStartClaudeServer = mock(async () => ({ hostPort: 9999 as number }));
const mockGetClaudeServerStatus = mock(async () => ({
  running: true,
  hostPort: 9999 as number | null,
}));
const mockGetClaudeServerLog = mock(async () => "");
const mockStartLocalClaudeServer = mock(async () => ({
  running: true,
  port: 9999 as number,
  pid: 1234,
}));
const mockGetLocalClaudeServerStatus = mock(async () => ({
  running: true,
  port: 9999 as number | null,
  pid: 1234 as number | null,
}));
const mockReadFileBase64 = mock(async () => "chat-local-base64");
const mockReadContainerFileBase64 = mock(async () => "chat-container-base64");
const mockRenameEnvironmentFromPrompt = mock(async () => {});

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
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, footer }: any) => {
    lastVirtualizedMessages = messages;
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
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  getModels: mockGetModels,
  createSession: mockCreateSession,
  getSession: mockGetSession,
  getSessionMessages: mockGetSessionMessages,
  getPendingQuestions: mockGetPendingQuestions,
  getPendingPlanApprovals: mockGetPendingPlanApprovals,
  sendPrompt: mockSendPrompt,
  getStructuredOutput: mockGetStructuredOutput,
  abortSession: mockAbortSession,
  subscribeToEvents: mockSubscribeToEvents,
  checkHealth: mockCheckHealth,
  getSlashCommands: mock(async () => []),
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
import type { ClaudeNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const SESSION_KEY = createSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;

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

function seedPaneLayout(sessionId?: string, initialPrompt?: string) {
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
    mockCreateSession.mockClear();
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
    mockSendPrompt.mockReset();
    mockSendPrompt.mockResolvedValue(true);
    mockGetStructuredOutput.mockReset();
    mockGetStructuredOutput.mockResolvedValue(null);
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
    mockSubscribeToEvents.mockReset();
    mockSubscribeToEvents.mockImplementation(
      (_client: unknown, _signal?: AbortSignal): AsyncIterable<ClaudeEvent> =>
        abortableEmptyEventStream(_signal),
    );
    mockRenameEnvironmentFromPrompt.mockClear();
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {});
    mockStartClaudeServer.mockReset();
    mockStartClaudeServer.mockImplementation(async () => ({ hostPort: 9999 }));
    mockGetClaudeServerStatus.mockReset();
    mockGetClaudeServerStatus.mockImplementation(async () => ({
      running: true,
      hostPort: 9999,
    }));
    mockGetClaudeServerLog.mockReset();
    mockGetClaudeServerLog.mockImplementation(async () => "");
    mockStartLocalClaudeServer.mockReset();
    mockStartLocalClaudeServer.mockImplementation(async () => ({
      running: true,
      port: 9999,
      pid: 1234,
    }));
    mockGetLocalClaudeServerStatus.mockReset();
    mockGetLocalClaudeServerStatus.mockImplementation(async () => ({
      running: true,
      port: 9999,
      pid: 1234,
    }));
    mockReadContainerFileBase64.mockReset();
    mockReadContainerFileBase64.mockImplementation(async () => "chat-container-base64");
    mockReadFileBase64.mockReset();
    mockReadFileBase64.mockImplementation(async () => "chat-local-base64");
    mockToastError.mockClear();
    lastVirtualizedMessages = [];
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
          },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().pendingQuestions.get("question-sse")).toMatchObject({
            sessionId: "session-1",
            toolUseId: "question-tool",
          });
          expect(useClaudeStore.getState().isPlanMode(SESSION_KEY)).toBe(true);
          expect(useClaudeStore.getState().pendingPlanApprovals.get("approval-sse")).toMatchObject({
            sessionId: "session-1",
            toolUseId: "approval-tool",
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
          },
        });
        await waitFor(() => {
          expect(useClaudeStore.getState().sessionInitData.get(ENVIRONMENT_ID)).toEqual({
            mcpServers: [{ name: "filesystem", status: "connected" }],
            plugins: [{ name: "review", status: "loaded" }],
            slashCommands: ["/eager - Eagerly discovered"],
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
    useClaudeStore.setState((state) => ({ ...state, sessions: new Map() }));
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
        expect.not.objectContaining({ outputSchema: expect.anything() }),
      );
    });
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

  describe("cold start server bring-up", () => {
    beforeEach(() => {
      useClaudeStore.setState((state) => ({
        ...state,
        clients: new Map(),
        sessions: new Map(),
      }));
      seedPaneLayout();
    });

    test("starts a stopped local server and connects to its port", async () => {
      useEnvironmentStore.setState({ setupCommandsResolved: new Set([ENVIRONMENT_ID]) });
      mockGetLocalClaudeServerStatus.mockResolvedValue({
        running: false,
        port: null,
        pid: null,
      });
      mockStartLocalClaudeServer.mockResolvedValue({ running: true, port: 5432, pid: 99 });

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
