import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createOpenCodeSessionKey, useOpenCodeStore } from "@/stores/openCodeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realOpenCodeClient from "@/lib/opencode-client";

// Snapshot the real sibling modules before we install stubs so we can restore
// them when this file finishes. Without this, Bun's global mock.module cache
// would leak these stubs into other test files (notably OpenCodeComposeBar.test.tsx
// and slash-command-{directory,registry}.test.ts) and cause them to receive
// stub modules instead of the real ones.
import * as realOpenCodeComposeBar from "./OpenCodeComposeBar";
import * as realOpenCodePermissionCard from "./OpenCodePermissionCard";
import * as realOpenCodeQuestionCard from "./OpenCodeQuestionCard";
import * as realOpenCodeResumeSessionDialog from "./OpenCodeResumeSessionDialog";
import * as realSlashCommandDirectory from "./slash-command-directory";
import * as realSlashCommandRegistry from "./slash-command-registry";
const realOpenCodeComposeBarSnapshot = { ...realOpenCodeComposeBar };
const realOpenCodePermissionCardSnapshot = { ...realOpenCodePermissionCard };
const realOpenCodeQuestionCardSnapshot = { ...realOpenCodeQuestionCard };
const realOpenCodeResumeSessionDialogSnapshot = { ...realOpenCodeResumeSessionDialog };
const realSlashCommandDirectorySnapshot = { ...realSlashCommandDirectory };
const realSlashCommandRegistrySnapshot = { ...realSlashCommandRegistry };
const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;
let lastVirtualizedMessages: any[] = [];

const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockSendPrompt = mock(async () => ({ success: true }));
const mockAbortSession = mock(async () => true);
const mockCreateSession = mock(async () => ({
  id: "session-1",
  createdAt: "2026-04-15T10:00:00.000Z",
}));
const mockGetSessionMessages = mock<
  (_client: unknown, _sessionId: string, _options?: unknown) => Promise<NativeMessage[]>
>(async () => []);
const mockGetSessionStatus = mock(
  async () => null as "idle" | "busy" | "retry" | null,
);
const mockGetPendingQuestions = mock(async (): Promise<QuestionRequest[]> => []);
const mockGetPendingPermissions = mock(async (): Promise<PermissionRequest[]> => []);
const mockListSessions = mock(async () => [
  { id: "session-1", createdAt: "2026-04-15T10:00:00.000Z" },
]);
const mockSubscribeToEvents = mock(
  async () => (async function* () {})() as AsyncGenerator<any>,
);
const mockGetAvailableSlashCommands = mock(async () => [] as any[]);
const mockCreateClient = mock(() => MOCK_CLIENT as any);
const mockStartOpenCodeServer = mock(async () => ({ hostPort: 9999 }));
const mockGetOpenCodeServerStatus = mock(async () => ({ running: true, hostPort: 9999 }));
const mockGetOpenCodeServerLog = mock(async () => "");
const mockStartLocalOpencodeServer = mock(async () => ({ running: true, port: 9999, pid: 1234 }));
const mockGetLocalOpencodeServerStatus = mock(async () => ({ running: true, port: 9999, pid: 1234 }));
const mockResolveSlashCommandDirectory = mock(() => undefined as string | undefined);
const mockShouldLoadSlashCommands = mock(() => false);
const mockGetNativeSlashCommands = mock((commands: any[]) => commands);
import type {
  OpenCodeModel,
  OpenCodeModelDefaults,
  OpenCodeModelsResponse,
  PermissionRequest,
  QuestionRequest,
} from "@/lib/opencode-client";
import type {
  OpenCodeModelRef,
  OpenCodeModelPreferences,
} from "@/lib/backend";

const mockGetModelsWithDefaults = mock<() => Promise<OpenCodeModelsResponse>>(
  async () => ({ models: [] as OpenCodeModel[], defaults: {} as OpenCodeModelDefaults }),
);
const mockGetOpencodeModelPreferences = mock<
  () => Promise<OpenCodeModelPreferences>
>(async () => ({
  recent: [] as OpenCodeModelRef[],
  favorite: [] as OpenCodeModelRef[],
  variant: {} as Record<string, string>,
}));

mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClientSnapshot,
  createClient: mockCreateClient,
  getModelsWithDefaults: mockGetModelsWithDefaults,
  createSession: mockCreateSession,
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mockGetSessionStatus,
  listSessions: mockListSessions,
  getPendingPermissions: mockGetPendingPermissions,
  getPendingQuestions: mockGetPendingQuestions,
  getAvailableSlashCommands: mockGetAvailableSlashCommands,
  sendPrompt: mockSendPrompt,
  formatOpenCodeError: mock((error) => String(error)),
  abortSession: mockAbortSession,
  subscribeToEvents: mockSubscribeToEvents,
  ERROR_MESSAGE_PREFIX: "error-",
  SYSTEM_MESSAGE_PREFIX: "system-",
}));

mock.module("@/lib/backend", () => ({
  startOpenCodeServer: mockStartOpenCodeServer,
  getOpenCodeServerStatus: mockGetOpenCodeServerStatus,
  getOpenCodeServerLog: mockGetOpenCodeServerLog,
  getOpencodeModelPreferences: mockGetOpencodeModelPreferences,
  startLocalOpencodeServer: mockStartLocalOpencodeServer,
  getLocalOpencodeServerStatus: mockGetLocalOpencodeServerStatus,
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
}));

let composeText = "Rename the environment";
let composeAttachments: Array<{
  id: string;
  type: "file" | "image";
  path: string;
  previewUrl?: string;
  name: string;
}> = [];

mock.module("./OpenCodeComposeBar", () => ({
  OpenCodeComposeBar: ({
    onSend,
    onStop,
    onRefreshModels,
    onQueue,
    disabled,
    isLoading,
    showAddressAll,
    layout,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    onStop?: () => Promise<void>;
    onRefreshModels?: () => void | Promise<void>;
    onQueue?: (text: string, attachments: typeof composeAttachments) => void;
    disabled?: boolean;
    isLoading?: boolean;
    showAddressAll?: boolean;
    layout?: "bottom" | "centered";
  }) => (
    <>
      <div data-testid="opencode-compose-layout">{layout}</div>
      <div data-testid="opencode-address-all-state">
        {showAddressAll ? "shown" : "hidden"}
      </div>
      <button
        type="button"
        data-testid="opencode-send"
        disabled={disabled}
        onClick={() => {
          void onSend(composeText, composeAttachments);
        }}
      >
        Send
      </button>
      <button type="button" data-testid="opencode-queue" onClick={() => onQueue?.(composeText, composeAttachments)}>
        Queue
      </button>
      {isLoading ? (
        <button
          type="button"
          data-testid="opencode-stop"
          disabled={disabled}
          onClick={() => {
            void onStop?.();
          }}
        >
          Stop
        </button>
      ) : null}
      {onRefreshModels ? (
        <button
          type="button"
          data-testid="opencode-refresh-models"
          onClick={() => {
            void onRefreshModels();
          }}
        >
          Refresh
        </button>
      ) : null}
    </>
  ),
}));

mock.module("./OpenCodePermissionCard", () => ({
  OpenCodePermissionCard: () => null,
}));

mock.module("./OpenCodeQuestionCard", () => ({
  OpenCodeQuestionCard: () => null,
}));

mock.module("./OpenCodeResumeSessionDialog", () => ({
  OpenCodeResumeSessionDialog: ({
    open,
    onResume,
  }: {
    open: boolean;
    onResume: (sessionId: string) => void;
  }) => open ? (
    <button type="button" data-testid="opencode-resume-choice" onClick={() => onResume("resumed-opencode")}>
      Resume previous OpenCode session
    </button>
  ) : null,
}));

mock.module("./slash-command-directory", () => ({
  resolveSlashCommandDirectory: mockResolveSlashCommandDirectory,
  shouldLoadSlashCommands: mockShouldLoadSlashCommands,
}));

mock.module("./slash-command-registry", () => ({
  getNativeSlashCommands: mockGetNativeSlashCommands,
}));

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

import { OpenCodeChatTab } from "./OpenCodeChatTab";
import type { OpenCodeNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const TAB_ID = "tab-1";
const SESSION_KEY = createOpenCodeSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;

let mockedNow = 0;
let intervalCallback: (() => void) | null = null;
let clearIntervalCalls = 0;

function createData(overrides: Partial<OpenCodeNativeData> = {}): OpenCodeNativeData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: "container-1",
    isLocal: false,
    ...overrides,
  };
}

function seedPaneLayout(sessionId?: string) {
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
                type: "opencode-native",
                openCodeNativeData: createData({ sessionId }),
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

function resetStores(name = "20260415-123456") {
  useOpenCodeStore.setState({
    serverStatus: new Map(),
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
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as any]]),
    models: new Map(),
    slashCommands: new Map(),
    selectedModel: new Map([[ENVIRONMENT_ID, "openai/gpt-5"]]),
    selectedVariant: new Map(),
    selectedMode: new Map([[SESSION_KEY, "build"]]),
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
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nativeMessage(id: string, content = id): NativeMessage {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt: "2026-07-16T12:00:00.000Z",
  };
}

// Restore the real sibling modules once this file's tests finish so later
// test files see the real modules.
afterAll(() => {
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
  mock.module("./OpenCodeComposeBar", () => realOpenCodeComposeBarSnapshot);
  mock.module("./OpenCodePermissionCard", () => realOpenCodePermissionCardSnapshot);
  mock.module("./OpenCodeQuestionCard", () => realOpenCodeQuestionCardSnapshot);
  mock.module("./OpenCodeResumeSessionDialog", () => realOpenCodeResumeSessionDialogSnapshot);
  mock.module("./slash-command-directory", () => realSlashCommandDirectorySnapshot);
  mock.module("./slash-command-registry", () => realSlashCommandRegistrySnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

describe("OpenCodeChatTab", () => {
  beforeEach(() => {
    cleanup();
    composeText = "Rename the environment";
    composeAttachments = [];
    mockRenameEnvironmentFromPrompt.mockClear();
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {});
    mockSendPrompt.mockClear();
    mockSendPrompt.mockImplementation(async () => ({ success: true }));
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(async () => ({
      id: "session-1",
      createdAt: "2026-04-15T10:00:00.000Z",
    }));
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(async () => []);
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockResolvedValue(null);
    mockGetPendingQuestions.mockReset();
    mockGetPendingQuestions.mockResolvedValue([]);
    mockGetPendingPermissions.mockReset();
    mockGetPendingPermissions.mockResolvedValue([]);
    mockListSessions.mockClear();
    mockListSessions.mockImplementation(async () => [
      { id: "session-1", createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockSubscribeToEvents.mockReset();
    mockSubscribeToEvents.mockImplementation(
      async () => (async function* () {})() as AsyncGenerator<any>,
    );
    mockGetAvailableSlashCommands.mockReset();
    mockGetAvailableSlashCommands.mockResolvedValue([]);
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => MOCK_CLIENT as any);
    mockStartOpenCodeServer.mockReset();
    mockStartOpenCodeServer.mockResolvedValue({ hostPort: 9999 });
    mockGetOpenCodeServerStatus.mockReset();
    mockGetOpenCodeServerStatus.mockResolvedValue({ running: true, hostPort: 9999 });
    mockGetOpenCodeServerLog.mockReset();
    mockGetOpenCodeServerLog.mockResolvedValue("");
    mockStartLocalOpencodeServer.mockReset();
    mockStartLocalOpencodeServer.mockResolvedValue({ running: true, port: 9999, pid: 1234 });
    mockGetLocalOpencodeServerStatus.mockReset();
    mockGetLocalOpencodeServerStatus.mockResolvedValue({ running: true, port: 9999, pid: 1234 });
    mockResolveSlashCommandDirectory.mockReset();
    mockResolveSlashCommandDirectory.mockReturnValue(undefined);
    mockShouldLoadSlashCommands.mockReset();
    mockShouldLoadSlashCommands.mockReturnValue(false);
    mockGetNativeSlashCommands.mockReset();
    mockGetNativeSlashCommands.mockImplementation((commands) => commands);
    mockGetModelsWithDefaults.mockClear();
    mockGetModelsWithDefaults.mockImplementation(async () => ({
      models: [],
      defaults: {},
    }));
    mockGetOpencodeModelPreferences.mockClear();
    mockGetOpencodeModelPreferences.mockImplementation(async () => ({
      recent: [],
      favorite: [],
      variant: {},
    }));
    mockScrollToBottom.mockClear();
    mockIsAtBottom = true;
    lastVirtualizedMessages = [];
    resetStores();
  });

  afterEach(() => {
    useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
    cleanup();
    Date.now = ORIGINAL_DATE_NOW;
    globalThis.setInterval = ORIGINAL_SET_INTERVAL;
    globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
    mock.restore();
  });

  test("centers the compose bar with the ready title until message history exists", async () => {
    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByText("Ready to build!")).toBeTruthy();
    expect(screen.getByTestId("opencode-compose-layout").textContent).toBe("centered");

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      expect(screen.getByTestId("opencode-compose-layout").textContent).toBe("bottom");
    });
  });

  test("refresh requests pull the latest transcript, status, and pending prompts", async () => {
    const { rerender } = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    const serverMessage: NativeMessage = {
      id: "server-message",
      role: "assistant",
      content: "Updated by another client",
      parts: [{ type: "text", content: "Updated by another client" }],
      createdAt: "2026-07-16T12:00:00.000Z",
    };
    mockGetSessionMessages.mockResolvedValue([serverMessage]);
    mockGetSessionStatus.mockResolvedValue("busy");
    mockGetPendingQuestions.mockResolvedValue([
      { id: "question-1", sessionID: "session-1", questions: [] },
    ]);
    mockGetPendingPermissions.mockResolvedValue([
      {
        id: "permission-1",
        sessionID: "session-1",
        permission: "edit",
        patterns: [],
        metadata: {},
        always: [],
      },
    ]);
    useOpenCodeStore.setState((state) => ({
      ...state,
      pendingQuestions: new Map([
        ["stale-question", { id: "stale-question", sessionID: "session-1", questions: [] }],
      ]),
      pendingPermissions: new Map([
        [
          "stale-permission",
          {
            id: "stale-permission",
            sessionID: "session-1",
            permission: "edit",
            patterns: [],
            metadata: {},
            always: [],
          },
        ],
      ]),
    }));

    rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [serverMessage],
        isLoading: true,
      });
      expect(useOpenCodeStore.getState().pendingQuestions.has("question-1")).toBe(true);
      expect(useOpenCodeStore.getState().pendingPermissions.has("permission-1")).toBe(true);
      expect(useOpenCodeStore.getState().pendingQuestions.has("stale-question")).toBe(false);
      expect(useOpenCodeStore.getState().pendingPermissions.has("stale-permission")).toBe(false);
    });
  });

  test("failed refreshes preserve the current session snapshot", async () => {
    const currentMessage: NativeMessage = {
      id: "current-message",
      role: "assistant",
      content: "Keep this message",
      parts: [{ type: "text", content: "Keep this message" }],
      createdAt: "2026-07-16T12:00:00.000Z",
    };
    useOpenCodeStore.getState().setMessages(SESSION_KEY, [currentMessage]);

    const { rerender } = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    mockGetSessionMessages.mockRejectedValue(new Error("server unavailable"));
    rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
    expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      currentMessage,
    ]);
  });

  test("does not overwrite a live event with an older refresh snapshot", async () => {
    let resolveMessages!: (messages: NativeMessage[]) => void;
    const messagesPromise = new Promise<NativeMessage[]>((resolve) => {
      resolveMessages = resolve;
    });
    const liveMessage: NativeMessage = {
      id: "live-message",
      role: "assistant",
      content: "Arrived while refreshing",
      parts: [{ type: "text", content: "Arrived while refreshing" }],
      createdAt: "2026-07-16T12:00:01.000Z",
    };

    const { rerender } = render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );
    mockGetSessionMessages.mockImplementation(() => messagesPromise);
    mockGetSessionStatus.mockResolvedValue("idle");

    rerender(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    act(() => {
      useOpenCodeStore.getState().addMessage(SESSION_KEY, liveMessage);
    });
    await act(async () => {
      resolveMessages([]);
      await messagesPromise;
    });

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
        liveMessage,
      ]);
    });
  });

  describe("fast reconnect hydration", () => {
    test("hydrates a non-empty transcript and busy status", async () => {
      const serverMessage = nativeMessage("server-reconnect");
      mockGetSessionMessages.mockResolvedValue([serverMessage]);
      mockGetSessionStatus.mockResolvedValue("busy");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
          messages: [serverMessage],
          isLoading: true,
        });
      });
    });

    test("preserves existing messages when the server returns an empty snapshot", async () => {
      const existingMessage = nativeMessage("existing-reconnect");
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [existingMessage]);
      mockGetSessionMessages.mockResolvedValue([]);
      mockGetSessionStatus.mockResolvedValue("idle");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => expect(mockGetSessionStatus).toHaveBeenCalled());
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [existingMessage],
        isLoading: false,
      });
    });

    test("does not replace a live mutation with an older non-empty snapshot", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      mockGetSessionStatus.mockResolvedValue("busy");
      const liveMessage = nativeMessage("live-during-reconnect");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
      act(() => useOpenCodeStore.getState().addMessage(SESSION_KEY, liveMessage));

      await act(async () => {
        snapshot.resolve([nativeMessage("stale-reconnect")]);
        await snapshot.promise;
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
          liveMessage,
        ]);
      });
    });

    test("ignores a reconnect response after unmount", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      mockGetSessionStatus.mockResolvedValue("busy");
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      view.unmount();
      await act(async () => {
        snapshot.resolve([nativeMessage("after-unmount")]);
        await snapshot.promise;
      });

      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [],
        isLoading: false,
      });
    });

    test("ignores a response after the client is replaced", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      act(() => {
        useOpenCodeStore.setState((state) => ({
          clients: new Map(state.clients).set(ENVIRONMENT_ID, { baseUrl: "replacement" } as any),
        }));
      });
      await act(async () => {
        snapshot.resolve([nativeMessage("wrong-client")]);
        await snapshot.promise;
      });
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([]);
    });

    test("ignores a response after the session is replaced", async () => {
      const snapshot = deferred<NativeMessage[]>();
      mockGetSessionMessages.mockImplementation(() => snapshot.promise);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

      act(() => {
        useOpenCodeStore.getState().setSession(SESSION_KEY, {
          sessionId: "replacement-session",
          messages: [],
          isLoading: false,
        });
      });
      await act(async () => {
        snapshot.resolve([nativeMessage("wrong-session")]);
        await snapshot.promise;
      });
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "replacement-session",
        messages: [],
      });
    });

    test("logs a rejected reconnect without changing the snapshot", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      mockGetSessionMessages.mockRejectedValue(new Error("reconnect unavailable"));

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => {
          expect(consoleWarn).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Fast reconnect rehydration failed:",
            expect.any(Error),
          );
        });
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([]);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  test("rehydrates the session id saved in a restored pane tab", async () => {
    const restoredSessionId = "restored-opencode-session";
    useOpenCodeStore.setState({ sessions: new Map() });
    seedPaneLayout(restoredSessionId);
    mockListSessions.mockResolvedValue([
      { id: restoredSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, restoredSessionId);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(
        restoredSessionId,
      );
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    const restoredRoot = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)?.root;
    expect(restoredRoot?.kind).toBe("leaf");
    if (!restoredRoot || restoredRoot.kind !== "leaf") throw new Error("Expected pane leaf");
    const restoredTab = restoredRoot.tabs.find((tab) => tab.id === TAB_ID);
    expect(restoredTab?.openCodeNativeData?.sessionId).toBe(restoredSessionId);
  });

  test("cold-restores a persisted session with its transcript", async () => {
    const restoredSessionId = "cold-restored-opencode";
    const restoredMessage: NativeMessage = {
      id: "restored-message",
      role: "assistant",
      content: "Persisted OpenCode transcript",
      parts: [{ type: "text", content: "Persisted OpenCode transcript" }],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout(restoredSessionId);
    mockListSessions.mockResolvedValue([
      { id: restoredSessionId, createdAt: "2026-04-15T10:00:00.000Z" },
    ]);
    mockGetSessionMessages.mockResolvedValue([restoredMessage]);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: restoredSessionId,
        messages: [restoredMessage],
      });
    });
    expect(mockGetSessionMessages).toHaveBeenCalledWith(expect.anything(), restoredSessionId);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("replaces a missing restored session and persists the replacement id", async () => {
    const missingSessionId = "missing-opencode";
    useOpenCodeStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout(missingSessionId);
    mockListSessions.mockResolvedValue([]);

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: missingSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledWith(MOCK_CLIENT);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.openCodeNativeData?.sessionId)
        .toBe("session-1");
    });
  });

  test("retries a failed cold initialization and writes the created session id", async () => {
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout();
    mockGetModelsWithDefaults.mockRejectedValueOnce(new Error("model load failed"));

    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    await screen.findByText("Error: model load failed");
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.openCodeNativeData?.sessionId)
        .toBe("session-1");
    });
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  describe("cold server startup", () => {
    beforeEach(() => {
      useOpenCodeStore.setState((state) => ({
        ...state,
        clients: new Map(),
        sessions: new Map(),
      }));
      seedPaneLayout();
    });

    test("starts a stopped container server and connects to its mapped port", async () => {
      mockGetOpenCodeServerStatus.mockResolvedValue({ running: false, hostPort: null } as any);
      mockStartOpenCodeServer.mockResolvedValue({ hostPort: 4321 });

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => expect(mockCreateClient).toHaveBeenCalledWith("http://127.0.0.1:4321"));
      expect(mockStartOpenCodeServer).toHaveBeenCalledWith("container-1");
      expect(useOpenCodeStore.getState().serverStatus.get(ENVIRONMENT_ID)).toEqual({
        running: true,
        hostPort: 4321,
      });
    });

    test("starts a stopped local server and connects to its port", async () => {
      useEnvironmentStore.setState({ setupCommandsResolved: new Set([ENVIRONMENT_ID]) });
      mockGetLocalOpencodeServerStatus.mockResolvedValue({ running: false, port: null, pid: null } as any);
      mockStartLocalOpencodeServer.mockResolvedValue({ running: true, port: 5432, pid: 99 } as any);

      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData({ isLocal: true, containerId: undefined })}
          isActive
        />,
      );

      await waitFor(() => expect(mockCreateClient).toHaveBeenCalledWith("http://127.0.0.1:5432"));
      expect(mockStartLocalOpencodeServer).toHaveBeenCalledWith(ENVIRONMENT_ID);
      expect(mockGetOpenCodeServerStatus).not.toHaveBeenCalled();
    });

    test("reports a local server that starts without a port", async () => {
      useEnvironmentStore.setState({ setupCommandsResolved: new Set([ENVIRONMENT_ID]) });
      mockGetLocalOpencodeServerStatus.mockResolvedValue({ running: false, port: null, pid: null } as any);
      mockStartLocalOpencodeServer.mockResolvedValue({ running: true, port: 0, pid: 99 } as any);

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData({ isLocal: true })} isActive />);

      expect(await screen.findByText("Error: Local server started but no port available")).toBeTruthy();
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("reports a container server that starts without a port", async () => {
      mockGetOpenCodeServerStatus.mockResolvedValue({ running: false, hostPort: null } as any);
      mockStartOpenCodeServer.mockResolvedValue({ hostPort: 0 });

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      expect(await screen.findByText("Error: Server started but no port available")).toBeTruthy();
      expect(mockCreateClient).not.toHaveBeenCalled();
    });

    test("rejects a container environment without a container id", async () => {
      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData({ containerId: undefined })}
          isActive
        />,
      );

      expect(await screen.findByText("Error: Container ID is required for containerized environments")).toBeTruthy();
      expect(mockGetOpenCodeServerStatus).not.toHaveBeenCalled();
    });

    test("loads and reveals container logs for timeout failures", async () => {
      mockGetOpenCodeServerStatus.mockRejectedValue(new Error("timeout waiting for OpenCode"));
      mockGetOpenCodeServerLog.mockResolvedValue("redacted server diagnostics");

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await screen.findByText("Error: timeout waiting for OpenCode");
      const showLog = await screen.findByRole("button", { name: "Show Log" });
      fireEvent.click(showLog);
      expect(screen.getByText("redacted server diagnostics")).toBeTruthy();
      expect(mockGetOpenCodeServerLog).toHaveBeenCalledWith("container-1");
    });

    test("keeps the timeout error visible when fetching container logs fails", async () => {
      const originalError = console.error;
      const consoleError = mock(() => {});
      console.error = consoleError as unknown as typeof console.error;
      mockGetOpenCodeServerStatus.mockRejectedValue(new Error("timeout waiting for OpenCode"));
      mockGetOpenCodeServerLog.mockRejectedValue(new Error("log unavailable"));

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        expect(await screen.findByText("Error: timeout waiting for OpenCode")).toBeTruthy();
        await waitFor(() => {
          expect(consoleError).toHaveBeenCalledWith(
            "[OpenCodeChatTab] Failed to fetch server log:",
            expect.any(Error),
          );
        });
        expect(screen.queryByRole("button", { name: "Show Log" })).toBeNull();
      } finally {
        console.error = originalError;
      }
    });
  });

  test("writes a manually resumed session id and transcript to both stores", async () => {
    const resumedMessage: NativeMessage = {
      id: "resumed-message",
      role: "assistant",
      content: "Resumed OpenCode transcript",
      parts: [{ type: "text", content: "Resumed OpenCode transcript" }],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
      sessionId === "resumed-opencode" ? [resumedMessage] : []
    );
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(await screen.findByTestId("opencode-resume-choice"));

    await waitFor(() => {
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "resumed-opencode",
        messages: [resumedMessage],
      });
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.openCodeNativeData?.sessionId)
        .toBe("resumed-opencode");
    });
  });

  test("shows the scroll down accessory and scrolls to the bottom when clicked", () => {
    mockIsAtBottom = false;
    useOpenCodeStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [
          {
            id: "message-1",
            role: "assistant",
            content: "Existing response",
            parts: [{ type: "text", content: "Existing response" }],
            createdAt: "2026-04-15T10:00:00.000Z",
          } as any,
        ],
        isLoading: false,
      });
      return { sessions };
    });

    render(
      <OpenCodeChatTab
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

  test("pins active subagents to the rendered bottom and releases them on success", async () => {
    const activeMessage: NativeMessage = {
      id: "assistant-agent",
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "Parent started" },
        {
          type: "subagent",
          content: "Worker agent",
          subagentId: "agent-1",
          subagentName: "Worker agent",
          toolState: "pending",
          subagentActions: [],
        },
        { type: "text", content: "Parent continued" },
      ],
      createdAt: "2026-04-15T10:00:00.000Z",
    };
    const laterMessage: NativeMessage = {
      id: "assistant-later",
      role: "assistant",
      content: "Later response",
      parts: [{ type: "text", content: "Later response" }],
      createdAt: "2026-04-15T10:00:30.000Z",
    };

    useOpenCodeStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [activeMessage, laterMessage],
        isLoading: false,
      });
      return { sessions };
    });

    render(
      <OpenCodeChatTab
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

    const completedMessage: NativeMessage = {
      ...activeMessage,
      parts: activeMessage.parts.map((part) =>
        part.type === "subagent"
          ? { ...part, toolState: "success" as const }
          : part
      ),
    };

    act(() => {
      useOpenCodeStore.setState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(SESSION_KEY, {
          sessionId: "session-1",
          messages: [completedMessage, laterMessage],
          isLoading: false,
        });
        return { sessions };
      });
    });

    await waitFor(() => {
      expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
        "assistant-agent",
        "assistant-later",
      ]);
      expect(lastVirtualizedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
        "text",
        "subagent",
        "text",
      ]);
    });
  });

  test("shows the first prompt and naming feedback before the rename completes", async () => {
    composeText = "Audit the flaky reconnect flow";

    let resolveRename: (() => void) | undefined;
    mockRenameEnvironmentFromPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        }),
    );

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === composeText)).toBe(true);
      expect(messages.some((message) => message.content === "Naming environment...")).toBe(true);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });
    const messagesDuringRename = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
    expect(messagesDuringRename.find((message) => message.content === composeText)?.id).toMatch(
      /^optimistic-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(messagesDuringRename.find((message) => message.content === "Naming environment...")?.id).toMatch(
      /^system-naming-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    resolveRename?.();

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === "Naming environment...")).toBe(false);
    });
  });

  test("queues prompts with a generated UUID", async () => {
    composeText = "Queue this OpenCode prompt";
    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("opencode-queue"));
    await waitFor(() => {
      const queued = useOpenCodeStore.getState().messageQueue.get(SESSION_KEY)?.[0];
      expect(queued?.text).toBe(composeText);
      expect(queued?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  test("renames compact Electron timestamp environments on the first prompt", async () => {
    resetStores("202604151234567");
    composeText = "Audit the flaky reconnect flow";

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalled();
    });
  });

  test("enables the review follow-up action after a review session has messages", () => {
    useOpenCodeStore.setState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(SESSION_KEY, {
        sessionId: "session-1",
        messages: [
          {
            id: "message-1",
            role: "assistant",
            content: "Review complete",
            parts: [{ type: "text", content: "Review complete" }],
            createdAt: "2026-04-15T10:00:00.000Z",
          } as any,
        ],
        isLoading: false,
      });
      return { sessions };
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        isReviewTab
      />,
    );

    expect(screen.getByTestId("opencode-address-all-state").textContent).toBe("shown");
  });

  test("removes the optimistic message and shows an error when sendPrompt fails", async () => {
    composeText = "This should not stick around";
    mockSendPrompt.mockImplementation(async () => ({
      success: false,
      error: "Prompt rejected",
    }));
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const session = useOpenCodeStore.getState().getSession(SESSION_KEY);
      expect(session?.messages.some((message) => message.content === composeText)).toBe(false);
      expect(session?.messages.some((message) => message.content === "Prompt rejected")).toBe(true);
      expect(session?.isLoading).toBe(false);
    });
  });

  test("stores optimistic attachment parts and forwards attachments to sendPrompt", async () => {
    composeText = "Please inspect the screenshot";
    composeAttachments = [
      {
        id: "attachment-1",
        type: "image",
        path: "/workspace/screenshot.png",
        previewUrl: "data:image/png;base64,abc123",
        name: "screenshot.png",
      },
    ];
    resetStores("review-table");

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-send"));

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      const userMessage = messages.find((message) => message.role === "user");
      expect(userMessage?.parts).toEqual([
        { type: "text", content: composeText },
        {
          type: "file",
          content: "screenshot.png",
          fileUrl: "data:image/png;base64,abc123",
        },
      ]);
    });

    expect(mockSendPrompt).toHaveBeenCalledWith(
      MOCK_CLIENT,
      "session-1",
      composeText,
      {
        model: "openai/gpt-5",
        variant: undefined,
        mode: "build",
        attachments: [
          {
            type: "image",
            path: "/workspace/screenshot.png",
            dataUrl: "data:image/png;base64,abc123",
            filename: "screenshot.png",
          },
        ],
      },
    );
  });

  test("renders timer states from the real elapsed timer hook", async () => {
    installTimerHarness(1_000_000);
    act(() => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    });

    render(
      <OpenCodeChatTab
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
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, false);
    });

    await waitFor(() => {
      expect(screen.queryByText("OpenCode is thinking...")).toBeNull();
      expect(screen.queryByText("Completed in 1s")).not.toBeNull();
    });

    expect(clearIntervalCalls).toBeGreaterThan(0);
  });

  test("drains queued prompts when the session is idle", async () => {
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Handle the queued prompt",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        "Handle the queued prompt",
        expect.objectContaining({
          model: "openai/gpt-5",
          mode: "build",
          attachments: undefined,
        }),
      );
    });
  });

  test("removes a queued prompt and records an error when queued send fails", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    resetStores("review-table");
    mockSendPrompt.mockImplementation(async () => ({
      success: false,
      error: "OpenCode unavailable",
    }));
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued OpenCode failure",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    try {
      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          "Queued OpenCode failure",
          expect.objectContaining({ model: "openai/gpt-5", mode: "build" }),
        );
      });

      await waitFor(() => {
        const state = useOpenCodeStore.getState();
        const messages = state.sessions.get(SESSION_KEY)?.messages ?? [];
        expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(state.messageQueue.get(SESSION_KEY)).toEqual([]);
        expect(messages.some((message) => message.content === "OpenCode unavailable")).toBe(true);
      });
    } finally {
      console.error = originalError;
    }
  });

  test("does not drain queued prompts while a draft exists", async () => {
    resetStores("review-table");
    useOpenCodeStore.getState().setDraftText(SESSION_KEY, "Keep this OpenCode draft");
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind OpenCode draft",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useOpenCodeStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.draftText.get(SESSION_KEY)).toBe("Keep this OpenCode draft");
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind OpenCode draft",
    ]);
  });

  test("does not drain queued prompts while an attachment is staged", async () => {
    resetStores("review-table");
    useOpenCodeStore.getState().addAttachment(SESSION_KEY, {
      id: "staged-attachment",
      type: "image" as const,
      path: "/workspace/staged.png",
      previewUrl: "data:image/png;base64,staged",
      name: "staged.png",
    });
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind OpenCode attachment",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useOpenCodeStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.attachments.get(SESSION_KEY)?.map((attachment) => attachment.name)).toEqual([
      "staged.png",
    ]);
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind OpenCode attachment",
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

    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued OpenCode prompt",
      attachments: [queuedAttachment],
      model: "openai/gpt-5",
      variant: "fast",
      mode: "build",
    });
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-2",
      text: "Second queued OpenCode prompt",
      attachments: [],
      model: "anthropic/claude-sonnet-4.5",
      mode: "plan",
    });

    let resolveAbort: ((value: boolean) => void) | undefined;
    mockAbortSession.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAbort = resolve;
        }),
    );

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("opencode-stop"));

    await waitFor(() => {
      const state = useOpenCodeStore.getState();
      expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
      expect(state.draftText.get(SESSION_KEY)).toBe("Queued OpenCode prompt");
      expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
        "Second queued OpenCode prompt",
      ]);
      expect(state.attachments.get(SESSION_KEY)).toEqual([queuedAttachment]);
      expect(state.selectedModel.get(ENVIRONMENT_ID)).toBe("openai/gpt-5");
      expect(state.selectedVariant.get(ENVIRONMENT_ID)).toBe("fast");
      expect(state.selectedMode.get(SESSION_KEY)).toBe("build");
    });
    expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1");

    resolveAbort?.(true);
  });

  test("dispatches the initialPrompt while the OpenCode tab is inactive", async () => {
    const initialPrompt = "Run the background OpenCode dispatch";
    composeText = initialPrompt;

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
        initialAgentModel="openai/gpt-5.6-sol"
        initialReasoningEffort="xhigh"
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({
          model: "openai/gpt-5.6-sol",
          variant: "xhigh",
          mode: "build",
        }),
      );
    });
  });

  test("initializes and drains a queued prompt while the OpenCode tab is inactive", async () => {
    useOpenCodeStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run the hidden queued OpenCode prompt",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(
      <OpenCodeChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        "Run the hidden queued OpenCode prompt",
        expect.objectContaining({ model: "openai/gpt-5", mode: "build" }),
      );
    });
  });

  test("waits for setup readiness before draining a queued prompt while inactive", async () => {
    useEnvironmentStore.setState({
      workspaceReadyEnvironments: new Set(),
    });
    useOpenCodeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run after OpenCode setup",
      attachments: [],
      model: "openai/gpt-5",
      mode: "build",
    });

    render(
      <OpenCodeChatTab
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
        "Run after OpenCode setup",
        expect.objectContaining({ model: "openai/gpt-5", mode: "build" }),
      );
    });
  });

  test("stop logs a failed abort after clearing local loading state", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockAbortSession.mockImplementation(async () => false);
    useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(
        <OpenCodeChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("opencode-stop"));

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(consoleError).toHaveBeenCalledWith("[OpenCodeChatTab] Failed to abort session");
      });
    } finally {
      console.error = originalError;
    }
  });

  describe("shared SSE event handling", () => {
    function seedSubagent(state: "pending" | "success" | "failure" = "pending") {
      const parent: NativeMessage = {
        ...nativeMessage("parent-agent", ""),
        parts: [
          {
            type: "subagent",
            content: "Worker",
            subagentId: "child-session",
            subagentName: "Worker",
            toolState: state,
            subagentActions: [],
          },
        ],
      };
      useOpenCodeStore.getState().setMessages(SESSION_KEY, [parent]);
    }

    function childMessage(content: string): NativeMessage {
      return {
        ...nativeMessage(`child-${content}`, content),
        parts: [{ type: "text", content }],
      };
    }

    test("applies streaming parts, parent refreshes, idle state, errors, and context usage", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      channel.push({
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            messageID: "stream-message",
            sessionID: "session-1",
            type: "text",
            text: "Streaming response",
          },
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]).toMatchObject({
          id: "stream-message",
          content: "Streaming response",
        });
      });

      const refreshed = nativeMessage("authoritative-parent");
      mockGetSessionMessages.mockResolvedValue([refreshed]);
      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "session-1" } },
      });
      await waitFor(() => {
        expect(mockGetSessionMessages).toHaveBeenCalledWith(
          MOCK_CLIENT,
          "session-1",
          { throwOnError: true },
        );
      });

      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true));
      channel.push({
        type: "session.idle",
        properties: {
          sessionID: "session-1",
          usage: { inputTokens: 30, outputTokens: 20 },
          maxContextTokens: 1_000,
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useOpenCodeStore.getState().contextUsage.get(SESSION_KEY)).toEqual({
          usedTokens: 50,
          totalTokens: 1_000,
          percentUsed: 5,
          modelId: "openai/gpt-5",
        });
      });

      channel.push({
        type: "session.error",
        properties: { sessionID: "session-1", error: new Error("event failed") },
      });
      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages.some(
            (message) => message.id.startsWith("error-") && message.content === "Error: event failed",
          ),
        ).toBe(true);
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("adds and removes permission and question requests", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "permission.asked",
        properties: {
          id: "permission-sse",
          sessionID: "session-1",
          permission: "edit",
          patterns: ["src/**"],
          metadata: { source: "tool" },
          always: ["src/generated/**"],
          tool: { messageID: "message-1", callID: "call-1" },
        },
      });
      channel.push({
        type: "question.asked",
        properties: {
          id: "question-sse",
          sessionID: "session-1",
          questions: [{ question: "Continue?", header: "Confirm", options: [] }],
        },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().pendingPermissions.get("permission-sse")).toMatchObject({
          sessionID: "session-1",
          permission: "edit",
          patterns: ["src/**"],
        });
        expect(useOpenCodeStore.getState().pendingQuestions.has("question-sse")).toBe(true);
      });

      channel.push({ type: "permission.replied", properties: { requestID: "permission-sse" } });
      channel.push({ type: "question.replied", properties: { requestID: "question-sse" } });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().pendingPermissions.has("permission-sse")).toBe(false);
        expect(useOpenCodeStore.getState().pendingQuestions.has("question-sse")).toBe(false);
      });

      useOpenCodeStore.getState().addPendingQuestion({
        id: "question-rejected",
        sessionID: "session-1",
        questions: [],
      });
      channel.push({ type: "question.rejected", properties: { requestID: "question-rejected" } });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().pendingQuestions.has("question-rejected")).toBe(false);
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("refreshes a Task child and records success and failure terminal states", async () => {
      seedSubagent();
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "child-session" ? [childMessage("child action")] : []
      );
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({
        type: "message.updated",
        properties: { info: { sessionID: "child-session" } },
      });
      await waitFor(() => {
        const part = useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0];
        expect(part).toMatchObject({
          type: "subagent",
          toolState: "pending",
          subagentActions: [{ type: "text", content: "child action" }],
        });
      });

      channel.push({ type: "session.idle", properties: { sessionID: "child-session" } });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0]).toMatchObject({
          toolState: "success",
        });
      });

      channel.push({
        type: "session.error",
        properties: { sessionID: "child-session", error: new Error("child failed") },
      });
      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0]).toMatchObject({
          toolState: "failure",
        });
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("refreshes child transcripts after message and part removals", async () => {
      seedSubagent();
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) =>
        sessionId === "child-session" ? [childMessage("after removal")] : []
      );
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      mockGetSessionMessages.mockClear();

      for (const type of ["message.part.removed", "message.removed"]) {
        channel.push({ type, properties: { sessionID: "child-session" } });
        await waitFor(() => {
          expect(mockGetSessionMessages.mock.calls.filter((call) => call[1] === "child-session").length)
            .toBe(type === "message.part.removed" ? 1 : 2);
        });
      }
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("discards an older overlapping child refresh that resolves last", async () => {
      seedSubagent();
      const channel = eventChannel();
      const first = deferred<NativeMessage[]>();
      const second = deferred<NativeMessage[]>();
      let childCall = 0;
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      mockGetSessionMessages.mockImplementation(async (_client, sessionId) => {
        if (sessionId !== "child-session") return [];
        childCall += 1;
        return childCall === 1 ? first.promise : second.promise;
      });
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());

      channel.push({ type: "message.updated", properties: { info: { sessionID: "child-session" } } });
      await waitFor(() => expect(childCall).toBe(1));
      channel.push({ type: "session.idle", properties: { sessionID: "child-session" } });
      await waitFor(() => expect(childCall).toBe(2));

      await act(async () => {
        second.resolve([childMessage("newest child")]);
        await second.promise;
      });
      await act(async () => {
        first.resolve([childMessage("stale child")]);
        await first.promise;
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages[0]?.parts[0]).toMatchObject({
          toolState: "success",
          subagentActions: [{ type: "text", content: "newest child" }],
        });
      });
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.close();
    });

    test("stops applying events after the shared subscription is aborted", async () => {
      const channel = eventChannel();
      mockSubscribeToEvents.mockResolvedValue(channel.stream);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockSubscribeToEvents).toHaveBeenCalled());
      useOpenCodeStore.getState().closeEventSubscription(ENVIRONMENT_ID);
      channel.push({ type: "session.error", properties: { sessionID: "session-1", error: "late" } });
      channel.close();

      await act(async () => await Promise.resolve());
      expect(useOpenCodeStore.getState().eventSubscriptions.has(ENVIRONMENT_ID)).toBe(false);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([]);
    });
  });

  describe("slash command loading", () => {
    beforeEach(() => {
      mockResolveSlashCommandDirectory.mockReturnValue("/workspace");
      mockShouldLoadSlashCommands.mockReturnValue(true);
      mockGetNativeSlashCommands.mockImplementation((commands) => [
        { name: "/native", description: "Built in" },
        ...commands,
      ]);
    });

    test("stores discovered and native slash commands", async () => {
      mockGetAvailableSlashCommands.mockResolvedValue([
        { name: "/project", description: "Project command" },
      ]);

      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(useOpenCodeStore.getState().slashCommands.get(ENVIRONMENT_ID)).toEqual([
          { name: "/native", description: "Built in" },
          { name: "/project", description: "Project command" },
        ]);
      });
      expect(mockGetAvailableSlashCommands).toHaveBeenCalledWith(MOCK_CLIENT, "/workspace");
    });

    test("falls back to native commands when discovery rejects", async () => {
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;
      mockGetAvailableSlashCommands.mockRejectedValue(new Error("command endpoint unavailable"));

      try {
        render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
        await waitFor(() => {
          expect(useOpenCodeStore.getState().slashCommands.get(ENVIRONMENT_ID)).toEqual([
            { name: "/native", description: "Built in" },
          ]);
        });
        expect(consoleWarn).toHaveBeenCalledWith(
          "[OpenCodeChatTab] Failed to load slash commands:",
          expect.any(Error),
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    test("does not store commands after the loading effect is cancelled", async () => {
      const commands = deferred<any[]>();
      mockGetAvailableSlashCommands.mockImplementation(() => commands.promise);
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await waitFor(() => expect(mockGetAvailableSlashCommands).toHaveBeenCalled());

      view.unmount();
      await act(async () => {
        commands.resolve([{ name: "/late", description: "Late" }]);
        await commands.promise;
      });

      expect(useOpenCodeStore.getState().slashCommands.has(ENVIRONMENT_ID)).toBe(false);
    });

    test("skips discovery when the environment has no usable directory", async () => {
      mockShouldLoadSlashCommands.mockReturnValue(false);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      await act(async () => await Promise.resolve());
      expect(mockGetAvailableSlashCommands).not.toHaveBeenCalled();
    });
  });

  describe("Escape stop shortcut", () => {
    test("stops an active loading session and prevents the browser action", async () => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

      act(() => window.dispatchEvent(event));

      await waitFor(() => expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, "session-1"));
      expect(event.defaultPrevented).toBe(true);
      expect(useOpenCodeStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
    });

    test("ignores Escape when inactive, modified, repeated, composing, or already prevented", async () => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      view.rerender(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);

      const ignored = [
        new KeyboardEvent("keydown", { key: "Enter" }),
        new KeyboardEvent("keydown", { key: "Escape", repeat: true }),
        new KeyboardEvent("keydown", { key: "Escape", metaKey: true }),
        new KeyboardEvent("keydown", { key: "Escape", ctrlKey: true }),
        new KeyboardEvent("keydown", { key: "Escape", altKey: true }),
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true }),
      ];
      const prevented = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      prevented.preventDefault();
      ignored.push(prevented);
      act(() => ignored.forEach((event) => window.dispatchEvent(event)));

      await act(async () => await Promise.resolve());
      expect(mockAbortSession).not.toHaveBeenCalled();
    });

    test("removes the key listener after loading ends and after unmount", async () => {
      useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, true);
      const view = render(<OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive />);
      act(() => useOpenCodeStore.getState().setSessionLoading(SESSION_KEY, false));
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      view.unmount();
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await act(async () => await Promise.resolve());
      expect(mockAbortSession).not.toHaveBeenCalled();
    });
  });

  describe("refreshModels", () => {
    test("writes the latest models into the store", async () => {
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
        { id: "openai/gpt-5", name: "GPT-5", provider: "openai", variants: ["low", "high"] },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
          refreshedModels,
        );
      });
    });

    test("falls back to the first available model when the selected one is gone", async () => {
      useOpenCodeStore.getState().setSelectedModel(ENVIRONMENT_ID, "openai/gpt-5");
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSelectedModel(ENVIRONMENT_ID),
        ).toBe("anthropic/claude-sonnet");
      });
    });

    test("prefers the recent model from preferences when current is invalid", async () => {
      useOpenCodeStore.getState().setSelectedModel(ENVIRONMENT_ID, "openai/gpt-5");
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
        { id: "openai/gpt-4", name: "GPT-4", provider: "openai" },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: { modelId: "openai/gpt-4" },
      }));
      mockGetOpencodeModelPreferences.mockImplementation(async () => ({
        recent: [{ providerID: "anthropic", modelID: "claude-sonnet" }],
        favorite: [],
        variant: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSelectedModel(ENVIRONMENT_ID),
        ).toBe("anthropic/claude-sonnet");
      });
    });

    test("clears the variant when it is no longer available on the selected model", async () => {
      useOpenCodeStore.getState().setSelectedModel(ENVIRONMENT_ID, "openai/gpt-5");
      useOpenCodeStore.getState().setSelectedVariant(ENVIRONMENT_ID, "high");
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: [
          { id: "openai/gpt-5", name: "GPT-5", provider: "openai", variants: ["low"] },
        ],
        defaults: {},
      }));

      render(
        <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
      );

      await act(async () => {
        fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
      });

      await waitFor(() => {
        expect(
          useOpenCodeStore.getState().getSelectedVariant(ENVIRONMENT_ID),
        ).toBeUndefined();
      });
    });

    test("logs and recovers when the SDK fetch fails", async () => {
      mockGetModelsWithDefaults.mockImplementation(async () => {
        throw new Error("network down");
      });
      const originalError = console.error;
      const consoleError = mock(() => {});
      console.error = consoleError as unknown as typeof console.error;

      try {
        render(
          <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
        );

        await act(async () => {
          fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
        });

        await waitFor(() => {
          expect(consoleError).toHaveBeenCalled();
        });
      } finally {
        console.error = originalError;
      }
    });

    test("falls back to empty preferences when preference loading rejects", async () => {
      const refreshedModels = [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
      ];
      mockGetModelsWithDefaults.mockImplementation(async () => ({
        models: refreshedModels,
        defaults: {},
      }));
      mockGetOpencodeModelPreferences.mockImplementation(async () => {
        throw new Error("disk read failed");
      });
      const originalWarn = console.warn;
      const consoleWarn = mock(() => {});
      console.warn = consoleWarn as unknown as typeof console.warn;

      try {
        render(
          <OpenCodeChatTab tabId={TAB_ID} data={createData()} isActive={false} />,
        );

        await act(async () => {
          fireEvent.click(await screen.findByTestId("opencode-refresh-models"));
        });

        await waitFor(() => {
          expect(useOpenCodeStore.getState().models.get(ENVIRONMENT_ID)).toEqual(
            refreshedModels,
          );
        });
      } finally {
        console.warn = originalWarn;
      }
    });
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
