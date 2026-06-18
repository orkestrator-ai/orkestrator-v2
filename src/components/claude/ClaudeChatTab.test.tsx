import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createClaudeSessionKey, useClaudeStore } from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { ClaudeMessage as ClaudeMessageType } from "@/lib/claude-client";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";

import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const mockScrollToBottom = mock(() => {});
const mockCreateSession = mock(async () => ({ sessionId: "session-1" }));
const mockGetModels = mock(async () => []);
const mockGetSessionMessages = mock(async (): Promise<ClaudeMessageType[]> => []);
const mockCheckHealth = mock(async () => true);
const mockSendPrompt = mock(async () => {});
const mockAbortSession = mock(async () => true);
const mockReadFileBase64 = mock(async () => "chat-local-base64");
const mockReadContainerFileBase64 = mock(async () => "chat-container-base64");

mock.module("@/hooks", () => ({
  ...realHooksSnapshot,
  useVirtuosoScrollState: mock(() => ({
    isAtBottom: true,
    isAtBottomRef: { current: true },
    scrollToBottom: mockScrollToBottom,
    virtuosoRef: { current: null },
    scrollProps: {},
  })),
}));

mock.module("@/components/chat/VirtualizedMessageList", () => ({
  VirtualizedMessageList: ({ messages, renderMessage, emptyState, footer }: any) => (
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
  ),
}));

mock.module("@/lib/claude-client", () => ({
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  getModels: mockGetModels,
  createSession: mockCreateSession,
  getSession: mock(async () => null),
  getSessionMessages: mockGetSessionMessages,
  sendPrompt: mockSendPrompt,
  abortSession: mockAbortSession,
  subscribeToEvents: mock(() => (async function* () {})()),
  checkHealth: mockCheckHealth,
  getSlashCommands: mock(async () => []),
  ERROR_MESSAGE_PREFIX: "error-",
  SYSTEM_MESSAGE_PREFIX: "system-",
  SessionNotFoundError: class SessionNotFoundError extends Error {},
}));

mock.module("@/lib/tauri", () => ({
  startClaudeServer: mock(async () => ({ hostPort: 9999 })),
  getClaudeServerStatus: mock(async () => ({ running: true, hostPort: 9999 })),
  getClaudeServerLog: mock(async () => ""),
  startLocalClaudeServer: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  getLocalClaudeServerStatus: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  renameEnvironmentFromPrompt: mock(async () => {}),
  readFileBase64: mockReadFileBase64,
  readContainerFileBase64: mockReadContainerFileBase64,
  // Needed by ClaudeComposeBar/useFileSearch rendered inside ClaudeChatTab
  writeContainerFile: mock(async () => {}),
  writeLocalFile: mock(async () => "/tmp/file.png"),
  getFileTree: mock(async () => []),
  getLocalFileTree: mock(async () => []),
}));

// Sibling component stubs (ClaudeComposeBar, ClaudeQuestionCard, etc.) were
// removed: Bun's mock.module is global, so stubbing `./ClaudeComposeBar` here
// replaces the real module in the cache and leaks into ClaudeComposeBar.test.tsx,
// causing that test to receive a `() => null` component.

import { ClaudeChatTab } from "./ClaudeChatTab";
import type { ClaudeNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const SESSION_KEY = createClaudeSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;

let mockedNow = 0;
let intervalCallback: (() => void) | null = null;
let clearIntervalCalls = 0;

function createData(overrides: Partial<ClaudeNativeData> = {}): ClaudeNativeData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
    ...overrides,
  };
}

function resetStores() {
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
    fastMode: new Map(),
  });

  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name: "review-table",
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
}

describe("ClaudeChatTab", () => {
  afterAll(() => {
    mock.module("@/hooks", () => realHooksSnapshot);
    mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
  });

  beforeEach(() => {
    cleanup();
    resetStores();
    mockScrollToBottom.mockClear();
    mockCreateSession.mockClear();
    mockGetModels.mockReset();
    mockGetModels.mockImplementation(async () => []);
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockImplementation(async () => []);
    mockCheckHealth.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
    mockReadContainerFileBase64.mockReset();
    mockReadContainerFileBase64.mockImplementation(async () => "chat-container-base64");
    mockReadFileBase64.mockReset();
    mockReadFileBase64.mockImplementation(async () => "chat-local-base64");
  });

  afterEach(() => {
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
      expect(messages.some((message) => message.content === "Query stopped by user.")).toBe(true);
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
  intervalCallback = null;
  clearIntervalCalls = 0;
  Date.now = () => mockedNow;
  globalThis.setInterval = (((callback: TimerHandler) => {
    intervalCallback = callback as () => void;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown) as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearIntervalCalls += 1;
  }) as typeof clearInterval;
}
