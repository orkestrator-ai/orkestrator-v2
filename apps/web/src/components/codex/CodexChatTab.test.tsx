import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createCodexSessionKey, useCodexStore } from "@/stores/codexStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realHooks from "@/hooks";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";

// Snapshot the real sibling modules before we install stubs so we can restore
// them when this file finishes. Without this, Bun's global mock.module cache
// would leak these stubs into other test files (notably CodexComposeBar.test.tsx)
// and cause them to receive the stub component instead of the real one.
import * as realCodexComposeBar from "./CodexComposeBar";
import * as realCodexPlanModeCard from "./CodexPlanModeCard";
import * as realCodexResumeSessionDialog from "./CodexResumeSessionDialog";
const realCodexComposeBarSnapshot = { ...realCodexComposeBar };
const realCodexPlanModeCardSnapshot = { ...realCodexPlanModeCard };
const realCodexResumeSessionDialogSnapshot = { ...realCodexResumeSessionDialog };
const realHooksSnapshot = { ...realHooks };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;
let lastVirtualizedMessages: any[] = [];

const MOCK_MODELS = [
  {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "gpt-5.4-codex",
    name: "gpt-5.4-codex",
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
  },
];

type TestCodexMessage = NativeMessage & {
  role: "assistant";
  planReview?: boolean;
};

const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockSendPrompt = mock(async () => true);
const mockGetSessionMessages = mock(async (): Promise<TestCodexMessage[]> => []);
const mockSubscribeToEvents = mock(() => (async function* () {})());
const mockUpdateSessionConfig = mock(async () => true);
const mockAbortSession = mock(async () => true);
const mockCreateSession = mock(async () => ({ sessionId: "session-1", title: "Test session" }));
const mockGetSessionStatus = mock<
  (
    _client: unknown,
    _sessionId: string,
    _options?: { throwOnError?: boolean },
  ) => Promise<{ status: string; title?: string; error?: string } | null>
>(async () => ({ status: "idle" }));
const mockResumeSession = mock(async () => null as null | {
  session: { sessionId: string; title?: string };
  messages: TestCodexMessage[];
});
const mockCheckHealth = mock(async () => true);
const mockGetCodexServerLog = mock(async () => "");
const mockGetCodexServerStatus = mock(async () => ({ running: true, hostPort: 9999 }));
const mockGetLocalCodexServerStatus = mock(async () => ({ running: true, port: 9999, pid: 1234 }));
const mockStartCodexServer = mock(async () => ({ hostPort: 9999 }));
const mockStartLocalCodexServer = mock(async () => ({ port: 9999, pid: 1234 }));
const mockUpdateGlobalConfig = mock(async (config: any) => ({
  ...useConfigStore.getState().config,
  global: config,
}));

// NOTE: Do NOT mock @/hooks/useScrollLock here — it pollutes the global
// module cache and breaks useScrollLock.test.ts. The real hook returns
// safe defaults (isAtBottom: true) when no viewport is found in happy-dom.

mock.module("@/lib/backend", () => ({
  getCodexServerLog: mockGetCodexServerLog,
  getCodexServerStatus: mockGetCodexServerStatus,
  getLocalCodexServerStatus: mockGetLocalCodexServerStatus,
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
  startCodexServer: mockStartCodexServer,
  startLocalCodexServer: mockStartLocalCodexServer,
  updateGlobalConfig: mockUpdateGlobalConfig,
}));

mock.module("@/lib/codex-client", () => ({
  CODEX_MODELS: MOCK_MODELS,
  DEFAULT_CODEX_MODEL: MOCK_MODELS[0]!.id,
  abortSession: mockAbortSession,
  checkHealth: mockCheckHealth,
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  createSession: mockCreateSession,
  getModels: mock(async () => ({ models: MOCK_MODELS, source: "fallback" })),
  getSlashCommands: mock(async () => []),
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mockGetSessionStatus,
  resumeSession: mockResumeSession,
  sendPrompt: mockSendPrompt,
  subscribeToEvents: mockSubscribeToEvents,
  updateSessionConfig: mockUpdateSessionConfig,
}));

let composeText = "Rename the environment";
let composeAttachments: Array<{
  id: string;
  type: "image";
  path: string;
  previewUrl?: string;
  name: string;
}> = [];

mock.module("./CodexComposeBar", () => ({
  CodexComposeBar: ({
    onSend,
    onStop,
    onModeChange,
    onFastModeChange,
    onModelChange,
    onReasoningEffortChange,
    onQueue,
    disabled,
    isLoading,
    showAddressAll,
    layout,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    onStop?: () => Promise<void>;
    onModeChange?: (mode: "build" | "plan") => Promise<void>;
    onFastModeChange?: (enabled: boolean) => void;
    onModelChange?: (model: string) => Promise<void>;
    onReasoningEffortChange?: (effort: "low" | "medium" | "high") => Promise<void>;
    onQueue?: (text: string, attachments: typeof composeAttachments) => void;
    disabled?: boolean;
    isLoading?: boolean;
    showAddressAll?: boolean;
    layout?: "bottom" | "centered";
  }) => (
    <>
      <div data-testid="codex-address-all-state">
        {showAddressAll ? "shown" : "hidden"}
      </div>
      <div data-testid="codex-compose-layout">{layout ?? "bottom"}</div>
      <button
        type="button"
        data-testid="codex-send"
        disabled={disabled}
        onClick={() => {
          void onSend(composeText, composeAttachments);
        }}
      >
        Send
      </button>
      <button
        type="button"
        data-testid="codex-model-change"
        onClick={() => {
          void onModelChange?.("gpt-5.4-codex");
        }}
      >
        Change model
      </button>
      <button
        type="button"
        data-testid="codex-effort-change"
        onClick={() => {
          void onReasoningEffortChange?.("low");
        }}
      >
        Change effort
      </button>
      <button type="button" data-testid="codex-queue" onClick={() => onQueue?.(composeText, composeAttachments)}>
        Queue
      </button>
      {isLoading ? (
        <button
          type="button"
          data-testid="codex-stop"
          disabled={disabled}
          onClick={() => {
            void onStop?.();
          }}
        >
          Stop
        </button>
      ) : null}
      <button
        type="button"
        data-testid="codex-fast-mode-on"
        onClick={() => onFastModeChange?.(true)}
      >
        Fast on
      </button>
      <button
        type="button"
        data-testid="codex-fast-mode-off"
        onClick={() => onFastModeChange?.(false)}
      >
        Fast off
      </button>
      <button
        type="button"
        data-testid="codex-mode-build"
        onClick={() => {
          void onModeChange?.("build");
        }}
      >
        Build mode
      </button>
      <button
        type="button"
        data-testid="codex-mode-plan"
        onClick={() => {
          void onModeChange?.("plan");
        }}
      >
        Plan mode
      </button>
    </>
  ),
}));

mock.module("./CodexPlanModeCard", () => ({
  CodexPlanModeCard: ({
    onDismiss,
    onSwitchToBuild,
    onApproveAndBuild,
  }: {
    onDismiss?: () => void;
    onSwitchToBuild?: () => Promise<void>;
    onApproveAndBuild?: () => Promise<void>;
  }) => (
    <div data-testid="codex-plan-mode-card">
      <button
        type="button"
        data-testid="codex-plan-dismiss"
        onClick={() => onDismiss?.()}
      >
        Dismiss
      </button>
      <button
        type="button"
        data-testid="codex-plan-switch-build"
        onClick={() => {
          void onSwitchToBuild?.();
        }}
      >
        Switch to build
      </button>
      <button
        type="button"
        data-testid="codex-plan-approve"
        onClick={() => {
          void onApproveAndBuild?.();
        }}
      >
        Approve
      </button>
    </div>
  ),
}));

mock.module("./CodexResumeSessionDialog", () => ({
  CodexResumeSessionDialog: ({
    open,
    onResume,
  }: {
    open: boolean;
    onResume: (threadId: string) => void;
  }) => open ? (
    <button type="button" data-testid="codex-resume-choice" onClick={() => onResume("resumed-thread")}>
      Resume previous Codex session
    </button>
  ) : null,
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

import { CodexChatTab } from "./CodexChatTab";
import type { CodexNativeData } from "@/types/paneLayout";

const ENVIRONMENT_ID = "env-1";
const CONTAINER_ID = "container-1";
const TAB_ID = "tab-1";
const SESSION_ID = "session-1";
const SESSION_KEY = createCodexSessionKey(ENVIRONMENT_ID, TAB_ID);
const MOCK_CLIENT = { baseUrl: "http://127.0.0.1:9999" } as const;
const ORIGINAL_DATE_NOW = Date.now;
const ORIGINAL_SET_INTERVAL = globalThis.setInterval;
const ORIGINAL_CLEAR_INTERVAL = globalThis.clearInterval;

let mockedNow = 0;
let intervalCallbacks: Array<() => void> = [];
let intervalCallback: (() => void) | null = null;
let clearIntervalCalls = 0;

function createMessage(
  id: string,
  content: string,
  options: Pick<TestCodexMessage, "planReview"> = {},
): TestCodexMessage {
  return {
    id,
    role: "assistant" as const,
    content,
    parts: [{ type: "text" as const, content }],
    createdAt: "2026-04-15T00:00:00.000Z",
    ...options,
  };
}

function createData(overrides: Partial<CodexNativeData> = {}): CodexNativeData {
  return {
    environmentId: ENVIRONMENT_ID,
    containerId: CONTAINER_ID,
    isLocal: false,
    ...overrides,
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
        opencodeModel: "gpt-4",
        codexModel: MOCK_MODELS[0]!.id,
        codexReasoningEffort: "medium",
        opencodeMode: "terminal",
        claudeMode: "terminal",
        claudeNativeBackend: "sdk",
        claudeNativeFastModeDefault: false,
        codexMode: "native",
        codexNativeFastModeDefault: false,
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

function seedEnvironment(name = "20260415-123456") {
  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "project-1",
        name,
        branch: "main",
        containerId: CONTAINER_ID,
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
    workspaceReadyEnvironments: new Set([ENVIRONMENT_ID]),
    deletingEnvironments: new Set(),
    pendingSetupCommands: new Map(),
    setupCommandsResolved: new Set(),
    setupScriptsRunning: new Set(),
  });
}

function seedPaneLayout(initialPrompt?: string) {
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
                type: "codex-native" as any,
                codexNativeData: createData(),
                initialPrompt,
              },
            ],
            activeTabId: TAB_ID,
          },
          activePaneId: "default",
          containerId: CONTAINER_ID,
        },
      ],
    ]),
    activeEnvironmentId: ENVIRONMENT_ID,
  });
}

function seedCodexStore(messages: ReturnType<typeof createMessage>[] = []) {
  useCodexStore.setState({
    models: MOCK_MODELS as any,
    serverStatus: new Map(),
    clients: new Map([[ENVIRONMENT_ID, MOCK_CLIENT as any]]),
    sessions: new Map([
      [
        SESSION_KEY,
        {
          sessionId: SESSION_ID,
          messages,
          isLoading: false,
          title: "Test session",
        },
      ],
    ]),
    slashCommands: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    selectedModel: new Map([[SESSION_KEY, MOCK_MODELS[0]!.id]]),
    selectedMode: new Map([[SESSION_KEY, "build"]]),
    selectedReasoningEffort: new Map([[SESSION_KEY, "medium"]]),
    fastMode: new Map(),
  });
}

function resetStores() {
  seedConfigStore();
  seedEnvironment();
  seedPaneLayout();
  seedCodexStore();
}

// Restore the real sibling modules once this file's tests finish so later
// test files (e.g. CodexComposeBar.test.tsx) see the real components.
afterAll(() => {
  mock.module("./CodexComposeBar", () => realCodexComposeBarSnapshot);
  mock.module("./CodexPlanModeCard", () => realCodexPlanModeCardSnapshot);
  mock.module("./CodexResumeSessionDialog", () => realCodexResumeSessionDialogSnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

describe("CodexChatTab", () => {
  beforeEach(() => {
    cleanup();
    composeText = "Rename the environment";
    composeAttachments = [];

    mockRenameEnvironmentFromPrompt.mockClear();
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {});
    mockSendPrompt.mockClear();
    mockSendPrompt.mockImplementation(async () => true);
    mockGetSessionMessages.mockClear();
    mockGetSessionMessages.mockImplementation(async () => []);
    mockSubscribeToEvents.mockClear();
    mockSubscribeToEvents.mockImplementation(() => (async function* () {})());
    mockScrollToBottom.mockClear();
    mockUpdateSessionConfig.mockClear();
    mockUpdateSessionConfig.mockImplementation(async () => true);
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(async () => ({ sessionId: "session-1", title: "Test session" }));
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockImplementation(async () => ({ status: "idle" }));
    mockResumeSession.mockReset();
    mockResumeSession.mockResolvedValue(null);
    mockCheckHealth.mockReset();
    mockCheckHealth.mockResolvedValue(true);
    mockGetCodexServerLog.mockReset();
    mockGetCodexServerLog.mockResolvedValue("");
    mockGetCodexServerStatus.mockReset();
    mockGetCodexServerStatus.mockResolvedValue({ running: true, hostPort: 9999 });
    mockGetLocalCodexServerStatus.mockReset();
    mockGetLocalCodexServerStatus.mockResolvedValue({ running: true, port: 9999, pid: 1234 });
    mockStartCodexServer.mockReset();
    mockStartCodexServer.mockResolvedValue({ hostPort: 9999 });
    mockStartLocalCodexServer.mockReset();
    mockStartLocalCodexServer.mockResolvedValue({ port: 9999, pid: 1234 });
    mockUpdateGlobalConfig.mockReset();
    mockUpdateGlobalConfig.mockImplementation(async (global) => ({
      ...useConfigStore.getState().config,
      global,
    }));
    mockIsAtBottom = true;
    lastVirtualizedMessages = [];
    restoreTimerHarness();

    resetStores();
  });

  afterEach(() => {
    cleanup();
    restoreTimerHarness();
    mock.restore();
  });

  test("renames timestamp environments before sending the first prompt", async () => {
    composeText = "Build a dashboard for pull request triage";

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        { attachments: undefined },
      );
    });
    const optimistic = useCodexStore.getState().getSession(SESSION_KEY)?.messages.find(
      (message) => message.role === "user" && message.content === composeText,
    );
    expect(optimistic?.id).toMatch(/^optimistic-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("refresh requests pull the latest transcript and session status", async () => {
    const { rerender } = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalled();
      expect(mockGetSessionMessages).toHaveBeenCalled();
    });
    mockGetSessionStatus.mockReset();
    mockGetSessionMessages.mockReset();

    const serverMessage = createMessage(
      "server-message",
      "Updated by another client",
    );
    mockGetSessionStatus.mockResolvedValue({
      status: "running",
      title: "Server title",
    });
    mockGetSessionMessages.mockResolvedValue([serverMessage]);

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [serverMessage],
        isLoading: true,
        title: "Server title",
      });
    });
    expect(mockGetSessionStatus).toHaveBeenCalledWith(
      MOCK_CLIENT,
      SESSION_ID,
      { throwOnError: true },
    );
  });

  test("failed manual refreshes preserve the current transcript", async () => {
    const currentMessage = createMessage("current-message", "Keep the current transcript");
    const { rerender } = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalled();
      expect(mockGetSessionMessages).toHaveBeenCalled();
    });
    act(() => {
      useCodexStore.getState().setMessages(SESSION_KEY, [currentMessage]);
    });
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockResolvedValue({ status: "idle" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages.mockRejectedValue(new Error("message fetch failed"));

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );

    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      currentMessage,
    ]);
  });

  test("an older overlapping refresh cannot overwrite the newer request", async () => {
    const currentMessage = createMessage("current-message", "Current transcript");
    const staleMessage = createMessage("stale-message", "Stale server snapshot");
    const newerMessage = createMessage("newer-message", "Newer server snapshot");
    let resolveFirstMessages!: (messages: TestCodexMessage[]) => void;
    const firstMessagesPromise = new Promise<TestCodexMessage[]>((resolve) => {
      resolveFirstMessages = resolve;
    });
    const { rerender } = render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={0}
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalled();
      expect(mockGetSessionMessages).toHaveBeenCalled();
    });
    act(() => {
      useCodexStore.getState().setMessages(SESSION_KEY, [currentMessage]);
    });
    mockGetSessionStatus.mockReset();
    mockGetSessionStatus.mockResolvedValue({ status: "idle" });
    mockGetSessionMessages.mockReset();
    mockGetSessionMessages
      .mockImplementationOnce(() => firstMessagesPromise)
      .mockResolvedValue([newerMessage]);

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={1}
      />,
    );
    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalledTimes(1));

    rerender(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        refreshRequestId={2}
      />,
    );
    await waitFor(() => {
      expect(mockGetSessionStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
        newerMessage,
      ]);
    });
    await act(async () => {
      resolveFirstMessages([staleMessage]);
      await firstMessagesPromise;
    });

    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([
      newerMessage,
    ]);
  });

  test("rehydrates the session id saved in a restored pane tab", async () => {
    const restoredSessionId = "restored-codex-session";
    useCodexStore.setState({ sessions: new Map() });
    usePaneLayoutStore
      .getState()
      .updateTabNativeSessionId(TAB_ID, restoredSessionId, ENVIRONMENT_ID);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionMessages).toHaveBeenCalledWith(MOCK_CLIENT, restoredSessionId);
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(
        restoredSessionId,
      );
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
    const restoredRoot = usePaneLayoutStore.getState().environments.get(ENVIRONMENT_ID)?.root;
    expect(restoredRoot?.kind).toBe("leaf");
    if (!restoredRoot || restoredRoot.kind !== "leaf") throw new Error("Expected pane leaf");
    const restoredTab = restoredRoot.tabs.find((tab) => tab.id === TAB_ID);
    expect(restoredTab?.codexNativeData?.sessionId).toBe(restoredSessionId);
  });

  test("cold-restores a persisted session with its transcript", async () => {
    const restoredSessionId = "cold-restored-codex";
    const restoredMessage = createMessage("restored-message", "Persisted Codex transcript");
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    seedPaneLayout();
    usePaneLayoutStore.getState().updateTabNativeSessionId(TAB_ID, restoredSessionId, ENVIRONMENT_ID);
    mockGetSessionMessages.mockResolvedValue([restoredMessage]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalledWith(
        expect.anything(),
        restoredSessionId,
        { throwOnError: true },
      );
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages).toEqual([restoredMessage]);
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("keeps a restored session on transient status failure and succeeds on retry", async () => {
    const restoredSessionId = "transient-codex";
    useCodexStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout();
    usePaneLayoutStore.getState().updateTabNativeSessionId(TAB_ID, restoredSessionId, ENVIRONMENT_ID);
    mockGetSessionStatus.mockRejectedValueOnce(new Error("status transport failed"));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: restoredSessionId })}
        isActive
      />,
    );

    await screen.findByText("status transport failed");
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.codexNativeData?.sessionId)
      .toBe(restoredSessionId);

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(restoredSessionId);
    });
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test("replaces a confirmed-missing restored session and writes the new id to the pane", async () => {
    const missingSessionId = "missing-codex";
    useCodexStore.setState((state) => ({ ...state, sessions: new Map() }));
    seedPaneLayout();
    usePaneLayoutStore.getState().updateTabNativeSessionId(TAB_ID, missingSessionId, ENVIRONMENT_ID);
    mockGetSessionStatus.mockResolvedValueOnce(null);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData({ sessionId: missingSessionId })}
        isActive
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe("session-1");
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.codexNativeData?.sessionId)
        .toBe("session-1");
    });
  });

  test("writes a manually resumed session id and transcript to both stores", async () => {
    const resumedMessage = createMessage("resumed-message", "Resumed Codex transcript");
    mockResumeSession.mockResolvedValue({
      session: { sessionId: "resumed-codex", title: "Resumed" },
      messages: [resumedMessage],
    });
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
    fireEvent.click(await screen.findByTestId("codex-resume-choice"));

    await waitFor(() => {
      expect(mockResumeSession).toHaveBeenCalledWith(MOCK_CLIENT, expect.objectContaining({ threadId: "resumed-thread" }));
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        sessionId: "resumed-codex",
        messages: [resumedMessage],
      });
      expect(usePaneLayoutStore.getState().getAllTabs(ENVIRONMENT_ID)[0]?.codexNativeData?.sessionId)
        .toBe("resumed-codex");
    });
  });

  test("keeps the resume dialog open and logs when a manual resume fails", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockResumeSession.mockResolvedValue(null);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
      fireEvent.click(screen.getByRole("button", { name: "Resume Session" }));
      fireEvent.click(await screen.findByTestId("codex-resume-choice"));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith("[CodexChatTab] Failed to resume session");
      });
      expect(screen.getByTestId("codex-resume-choice")).toBeTruthy();
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(SESSION_ID);
    } finally {
      console.error = originalError;
    }
  });

  test("surfaces cold initialization errors with the container bridge log and retries", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    mockGetCodexServerStatus.mockRejectedValueOnce(new Error("container bridge unavailable"));
    mockGetCodexServerLog.mockResolvedValueOnce("sanitized bridge diagnostics");

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByText("container bridge unavailable")).toBeTruthy();
    expect(screen.getByText("sanitized bridge diagnostics")).toBeTruthy();
    expect(mockGetCodexServerLog).toHaveBeenCalledWith(CONTAINER_ID);

    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.sessionId).toBe(SESSION_ID);
  });

  test("reports local initialization errors without requesting a container log", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    useEnvironmentStore.setState({
      setupCommandsResolved: new Set([ENVIRONMENT_ID]),
    });
    mockGetLocalCodexServerStatus.mockRejectedValueOnce("local bridge offline");

    render(<CodexChatTab tabId={TAB_ID} data={createData({ isLocal: true })} isActive />);

    expect(await screen.findByText("local bridge offline")).toBeTruthy();
    expect(screen.getByText("Local Codex bridge error: local bridge offline")).toBeTruthy();
    expect(mockGetCodexServerLog).not.toHaveBeenCalled();
  });

  test("turns a failed cached-client health check into a reconnectable error", async () => {
    mockCheckHealth.mockResolvedValue(false);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    expect(await screen.findByText("Codex bridge server disconnected. Click retry to reconnect.")).toBeTruthy();
    expect(useCodexStore.getState().clients.has(ENVIRONMENT_ID)).toBe(false);
    expect(screen.getByRole("button", { name: /Retry/i })).toBeTruthy();
  });

  test("queues prompts with a generated UUID", async () => {
    composeText = "Queue this prompt";
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("codex-queue"));
    await waitFor(() => {
      const queued = useCodexStore.getState().messageQueue.get(SESSION_KEY)?.[0];
      expect(queued?.text).toBe(composeText);
      expect(queued?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  test("centers the compose bar with the ready title until message history exists", async () => {
    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByText("Ready to build!")).toBeTruthy();
    expect(screen.getByTestId("codex-compose-layout").textContent).toBe("centered");

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(screen.getByTestId("codex-compose-layout").textContent).toBe("bottom");
    });
  });

  test("shows the scroll down accessory and scrolls to the bottom when clicked", () => {
    mockIsAtBottom = false;
    seedCodexStore([createMessage("message-1", "Existing response")]);

    render(
      <CodexChatTab
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

  test("keeps active subagents inline at their transcript position", async () => {
    const activeMessage: TestCodexMessage = {
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
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    const laterMessage = createMessage("assistant-later", "Later response");

    seedCodexStore([activeMessage, laterMessage]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(lastVirtualizedMessages.map((message) => message.id)).toEqual([
      "assistant-agent",
      "assistant-later",
    ]);
    expect(lastVirtualizedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
      "text",
      "subagent",
      "text",
    ]);

    const completedMessage: TestCodexMessage = {
      ...activeMessage,
      parts: activeMessage.parts.map((part) =>
        part.type === "subagent"
          ? { ...part, toolState: "success" as const }
          : part
      ),
    };

    act(() => {
      seedCodexStore([completedMessage, laterMessage]);
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

  test("groups adjacent streaming subagents without moving them out of the message", () => {
    const activeMessage: TestCodexMessage = {
      id: "assistant-agent-group",
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "Delegating" },
        {
          type: "subagent",
          content: "First worker",
          subagentId: "agent-1",
          subagentName: "First worker",
          toolState: "pending",
          subagentActions: [],
        },
        {
          type: "subagent",
          content: "Second worker",
          subagentId: "agent-2",
          subagentName: "Second worker",
          toolState: "pending",
          subagentActions: [],
        },
        { type: "text", content: "Parent continues" },
      ],
      createdAt: "2026-04-15T00:00:00.000Z",
    };
    seedCodexStore([activeMessage]);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    expect(lastVirtualizedMessages).toHaveLength(1);
    expect(lastVirtualizedMessages[0]?.parts.map((part: any) => part.type)).toEqual([
      "text",
      "agent-group",
      "text",
    ]);
    expect(lastVirtualizedMessages[0]?.parts[1].parts.map((part: any) => part.subagentId)).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  test("applies direct SSE message updates only to the current session", async () => {
    const currentMessage = createMessage("current-event", "Current session event");
    const foreignMessage = createMessage("foreign-event", "Foreign session event");
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield { type: "message.updated", sessionId: "other-session", data: { message: foreignMessage } };
      yield { type: "message.updated", sessionId: SESSION_ID, data: { message: currentMessage } };
      yield { type: "session.error", sessionId: SESSION_ID, data: { error: "turn failed" } };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    await waitFor(() => {
      const state = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(state?.messages.map((message) => message.id)).toEqual(["current-event"]);
      expect(state?.error).toBe("turn failed");
      expect(state?.isLoading).toBe(false);
    });
  });

  test("skips malformed SSE events and refreshes fallback updates, titles, and generic errors", async () => {
    const refreshedMessage = createMessage("fallback-event", "Fetched after sparse event");
    const originalWarn = console.warn;
    const warn = mock(() => {});
    console.warn = warn as unknown as typeof console.warn;
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockGetSessionMessages.mockResolvedValue([refreshedMessage]);
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield null;
      yield { type: "message.updated", sessionId: SESSION_ID, data: {} };
      yield { type: "session.updated", sessionId: SESSION_ID, data: {} };
      yield { type: "session.title-updated", sessionId: SESSION_ID, data: { title: "  Event title  " } };
      yield { type: "session.error", sessionId: SESSION_ID, data: {} };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        const state = useCodexStore.getState().sessions.get(SESSION_KEY);
        expect(state?.messages).toEqual([refreshedMessage]);
        expect(state?.title).toBe("  Event title  ");
        expect(state?.error).toBe("Codex session failed");
      });
      expect(warn).toHaveBeenCalledWith("[CodexChatTab] Received malformed event, skipping");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("session idle SSE refreshes the transcript and adopts a non-empty title", async () => {
    const finalMessage = createMessage("idle-message", "Turn completed");
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockGetSessionMessages.mockResolvedValue([finalMessage]);
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      yield { type: "session.idle", sessionId: SESSION_ID, data: { title: "Completed turn" } };
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    useCodexStore.getState().setSessionError(SESSION_KEY, "old error");

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    await waitFor(() => {
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)).toMatchObject({
        messages: [finalMessage],
        title: "Completed turn",
        isLoading: false,
      });
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.error).toBeUndefined();
    });
  });

  test("reconciles the session after an SSE subscription failure", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockGetSessionStatus.mockResolvedValue({ status: "idle", title: "Recovered title" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      throw new Error("event stream closed");
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    try {
      render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[CodexChatTab] Event subscription error:",
          expect.any(Error),
        );
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.title).toBe("Recovered title");
      });
    } finally {
      console.error = originalError;
    }
  });

  test("watchdog refreshes a loading turn after activity becomes stale", async () => {
    installTimerHarness(10_000);
    let finishEvents!: () => void;
    const finishPromise = new Promise<void>((resolve) => {
      finishEvents = resolve;
    });
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    mockSubscribeToEvents.mockImplementation(() => (async function* () {
      await finishPromise;
    })() as any);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);
    await waitFor(() => expect(mockGetSessionStatus).toHaveBeenCalled());
    mockGetSessionStatus.mockClear();
    mockGetSessionMessages.mockClear();

    mockedNow = 11_600;
    act(() => intervalCallback?.());

    await waitFor(() => {
      expect(mockGetSessionStatus).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID, {
        throwOnError: undefined,
      });
    });
    finishEvents();
  });

  test("Escape aborts only an active foreground turn without modifiers", async () => {
    mockGetSessionStatus.mockResolvedValue({ status: "running" });
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive />);

    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    fireEvent.keyDown(window, { key: "Escape", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Escape", altKey: true });
    fireEvent.keyDown(window, { key: "Escape", metaKey: true });
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    const preventedEvent = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    preventedEvent.preventDefault();
    window.dispatchEvent(preventedEvent);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(mockAbortSession).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID));
  });

  test("enables the review follow-up action after a review session has messages", () => {
    seedCodexStore([createMessage("message-1", "Review complete")]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        isReviewTab
      />,
    );

    expect(screen.getByTestId("codex-address-all-state").textContent).toBe("shown");
  });

  test("does not show plan approval for a non-plan assistant message after entering plan mode", () => {
    seedCodexStore([createMessage("build-message", "Implementation finished")]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("shows plan approval after a completed plan-review assistant message", () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Inspect the current flow", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    const planCard = screen.getByTestId("codex-plan-mode-card");
    const composeDock = screen.getByTestId("codex-compose-layout").closest('[data-testid="compose-dock"]');
    expect(composeDock?.contains(planCard)).toBe(true);
  });

  test("approves a reviewed plan by switching mode and sending the implementation prompt", async () => {
    seedEnvironment("review-table");
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Implement the requested change", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("codex-plan-approve"));

    await waitFor(() => {
      expect(mockUpdateSessionConfig).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        expect.objectContaining({ mode: "build" }),
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        "The plan is approved. Exit plan mode and implement it.",
        { attachments: undefined },
      );
    });
    expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("build");
    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("does not send an approval when switching the reviewed plan to build fails", async () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Implement the requested change", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));
    mockUpdateSessionConfig.mockResolvedValue(false);

    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);
    fireEvent.click(screen.getByTestId("codex-plan-approve"));

    await waitFor(() => expect(mockUpdateSessionConfig).toHaveBeenCalled());
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("plan");
  });

  test("does not show plan approval for an empty plan-review assistant message", () => {
    seedCodexStore([
      createMessage("empty-plan-message", "", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("does not show plan approval while the session has an error", () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Inspect the current flow", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => {
      const session = state.sessions.get(SESSION_KEY)!;
      return {
        selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...session,
          error: "Codex session failed",
        }),
      };
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("keeps a plan review dismissed after manually switching to build and back to plan", async () => {
    seedCodexStore([
      createMessage("plan-message", "Plan:\n1. Inspect the current flow", {
        planReview: true,
      }),
    ]);
    useCodexStore.setState((state) => ({
      selectedMode: new Map(state.selectedMode).set(SESSION_KEY, "plan"),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.getByTestId("codex-plan-mode-card")).toBeTruthy();

    fireEvent.click(screen.getByTestId("codex-mode-build"));

    await waitFor(() => {
      expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("build");
    });

    fireEvent.click(screen.getByTestId("codex-mode-plan"));

    await waitFor(() => {
      expect(useCodexStore.getState().selectedMode.get(SESSION_KEY)).toBe("plan");
    });
    expect(screen.queryByTestId("codex-plan-mode-card")).toBeNull();
  });

  test("skips renaming when the environment already has a non-timestamp name", async () => {
    composeText = "Add pagination to the review table";
    seedEnvironment("review-table");

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    expect(mockRenameEnvironmentFromPrompt).not.toHaveBeenCalled();
  });

  test("renames compact Electron timestamp environments on the first prompt", async () => {
    composeText = "Add pagination to the review table";
    seedEnvironment("202604151234567");

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalled();
    });
  });

  test("continues sending the prompt when renaming fails", async () => {
    composeText = "Investigate the failing setup flow";
    mockRenameEnvironmentFromPrompt.mockImplementation(async () => {
      throw new Error("rename failed");
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        composeText,
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        { attachments: undefined },
      );
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
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const messages =
        useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(
        messages.some((message) => message.content === composeText),
      ).toBe(true);
      expect(
        messages.some((message) => message.content === "Naming environment..."),
      ).toBe(true);
      expect(mockSendPrompt).not.toHaveBeenCalled();
    });

    resolveRename?.();

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        { attachments: undefined },
      );
    });

    await waitFor(() => {
      const messages =
        useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(
        messages.some((message) => message.content === "Naming environment..."),
      ).toBe(false);
    });
  });

  test("auto-sends initialPrompt through the same rename path and clears it from pane state", async () => {
    const initialPrompt = "Set up the environment for release automation";
    seedPaneLayout(initialPrompt);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledWith(
        ENVIRONMENT_ID,
        initialPrompt,
      );
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        initialPrompt,
        { attachments: undefined },
      );
    });

    await waitFor(() => {
      const pane = usePaneLayoutStore.getState().findPaneWithTab(TAB_ID, ENVIRONMENT_ID);
      const tab = pane?.tabs.find((candidate) => candidate.id === TAB_ID);
      expect(tab?.initialPrompt).toBeUndefined();
    });
  });

  test("initializes and sends initialPrompt while the Codex tab is inactive", async () => {
    const initialPrompt = "Run the background setup audit";
    seedPaneLayout(initialPrompt);
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
        initialPrompt={initialPrompt}
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        initialPrompt,
        { attachments: undefined },
      );
    });
  });

  test("uses one-shot review model and effort when creating a native session", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      sessions: new Map(),
      selectedModel: new Map(),
      selectedReasoningEffort: new Map(),
    }));

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive
        initialAgentModel="gpt-5.4-codex"
        initialReasoningEffort="high"
      />,
    );

    await waitFor(() => expect(mockCreateSession).toHaveBeenCalled());
    const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
    expect(lastCall?.[1]).toMatchObject({
      model: "gpt-5.4-codex",
      modelReasoningEffort: "high",
    });
  });

  test("initializes and drains a queued prompt while the Codex tab is inactive", async () => {
    useCodexStore.setState((state) => ({
      ...state,
      clients: new Map(),
      sessions: new Map(),
    }));
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run the hidden queued Codex prompt",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        "Run the hidden queued Codex prompt",
        { attachments: undefined },
      );
    });
  });

  test("waits for setup readiness before draining a queued prompt while inactive", async () => {
    useEnvironmentStore.setState({
      workspaceReadyEnvironments: new Set(),
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Run after Codex setup",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
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
        SESSION_ID,
        "Run after Codex setup",
        { attachments: undefined },
      );
    });
  });

  test("starts the SSE event subscription while the Codex tab is inactive but loading", async () => {
    seedCodexStore();
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockSubscribeToEvents).toHaveBeenCalled();
    });
  });

  test("only renames on the first prompt once the session has messages", async () => {
    mockGetSessionMessages.mockImplementation(async () => [createMessage("assistant-1", "Ready")]);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    composeText = "First prompt";
    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledTimes(1);
      expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.messages?.some((message) => message.content === "First prompt")).toBe(true);
    });

    composeText = "Second prompt";
    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledTimes(2);
    });

    expect(mockRenameEnvironmentFromPrompt).toHaveBeenCalledTimes(1);
  });

  test("keeps the optimistic first prompt visible until Codex returns messages", async () => {
    composeText = "Investigate why the first message disappears";
    mockGetSessionMessages.mockImplementation(async () => []);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        composeText,
        { attachments: undefined },
      );
    });

    await waitFor(() => {
      const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.role === "user" && message.content === composeText)).toBe(true);
    });
  });

  test("removes the optimistic prompt when Codex fails to send it", async () => {
    composeText = "This should not stick around";
    mockSendPrompt.mockImplementation(async () => false);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    await waitFor(() => {
      const session = useCodexStore.getState().sessions.get(SESSION_KEY);
      expect(session?.messages.some((message) => message.content === composeText)).toBe(false);
      expect(session?.error).toBe("Failed to send prompt");
    });
  });

  test("includes attachment parts in the optimistic prompt", async () => {
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
    mockGetSessionMessages.mockImplementation(async () => []);

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-send"));

    await waitFor(() => {
      const messages = useCodexStore.getState().sessions.get(SESSION_KEY)?.messages ?? [];
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
  });

  test("renders timer states from the real elapsed timer hook", async () => {
    installTimerHarness(1_000_000);
    act(() => {
      useCodexStore.setState((state) => ({
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...state.sessions.get(SESSION_KEY)!,
          isLoading: true,
        }),
      }));
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText(/Completed in/)).toBeNull();

    mockedNow = 1_000_999;
    act(() => {
      intervalCallback?.();
    });

    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText("Codex is thinking...")).not.toBeNull();
    expect(screen.queryByText(/Completed in/)).toBeNull();

    mockedNow = 1_001_500;
    act(() => {
      intervalCallback?.();
    });

    await waitFor(() => {
      expect(screen.queryByText("1s")).not.toBeNull();
    });

    act(() => {
      useCodexStore.setState((state) => ({
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...state.sessions.get(SESSION_KEY)!,
          isLoading: false,
        }),
      }));
    });

    await waitFor(() => {
      expect(screen.queryByText("Codex is thinking...")).toBeNull();
      expect(screen.queryByText("Completed in 1s")).not.toBeNull();
    });

    expect(clearIntervalCalls).toBeGreaterThan(0);

    mockedNow = 1_002_000;
    act(() => {
      useCodexStore.setState((state) => ({
        sessions: new Map(state.sessions).set(SESSION_KEY, {
          ...state.sessions.get(SESSION_KEY)!,
          isLoading: true,
        }),
      }));
    });

    await waitFor(() => {
      expect(screen.queryByText(/Completed in/)).toBeNull();
      expect(screen.queryByText("Codex is thinking...")).not.toBeNull();
    });
  });

  test("drains queued prompts when the session is idle", async () => {
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Handle the queued codex prompt",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        SESSION_ID,
        "Handle the queued codex prompt",
        { attachments: undefined },
      );
    });
  });

  test("removes a queued prompt and logs an error when queued send throws", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    seedEnvironment("review-table");
    mockSendPrompt.mockImplementation(async () => {
      throw new Error("bridge offline");
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued Codex failure",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    try {
      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      await waitFor(() => {
        expect(mockSendPrompt).toHaveBeenCalledWith(
          MOCK_CLIENT,
          SESSION_ID,
          "Queued Codex failure",
          { attachments: undefined },
        );
      });

      await waitFor(() => {
        const state = useCodexStore.getState();
        expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
        expect(state.messageQueue.get(SESSION_KEY)).toEqual([]);
        expect(consoleError).toHaveBeenCalledWith(
          "[CodexChatTab] Failed to send queued prompt:",
          expect.any(Error),
        );
      });
    } finally {
      console.error = originalError;
    }
  });

  test("does not drain queued prompts while a draft exists", async () => {
    seedEnvironment("review-table");
    useCodexStore.getState().setDraftText(SESSION_KEY, "Keep this Codex draft");
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind Codex draft",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useCodexStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.draftText.get(SESSION_KEY)).toBe("Keep this Codex draft");
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind Codex draft",
    ]);
  });

  test("does not drain queued prompts while an attachment is staged", async () => {
    seedEnvironment("review-table");
    useCodexStore.getState().addAttachment(SESSION_KEY, {
      id: "staged-attachment",
      type: "image" as const,
      path: "/workspace/staged.png",
      previewUrl: "data:image/png;base64,staged",
      name: "staged.png",
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued behind Codex attachment",
      attachments: [],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const state = useCodexStore.getState();
    expect(mockSendPrompt).not.toHaveBeenCalled();
    expect(state.attachments.get(SESSION_KEY)?.map((attachment) => attachment.name)).toEqual([
      "staged.png",
    ]);
    expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
      "Queued behind Codex attachment",
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

    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued prompt",
      attachments: [queuedAttachment],
      model: MOCK_MODELS[0]!.id,
      mode: "build",
      reasoningEffort: "medium",
      fastMode: false,
    });
    useCodexStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-2",
      text: "Second queued prompt",
      attachments: [],
      model: MOCK_MODELS[1]?.id ?? MOCK_MODELS[0]!.id,
      mode: "plan",
      reasoningEffort: "high",
      fastMode: true,
    });

    let resolveAbort: ((value: boolean) => void) | undefined;
    mockAbortSession.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAbort = resolve;
        }),
    );

    render(
      <CodexChatTab
        tabId={TAB_ID}
        data={createData()}
        isActive={false}
      />,
    );

    fireEvent.click(screen.getByTestId("codex-stop"));

    await waitFor(() => {
      const state = useCodexStore.getState();
      expect(state.sessions.get(SESSION_KEY)?.isLoading).toBe(false);
      expect(state.draftText.get(SESSION_KEY)).toBe("Queued prompt");
      expect(state.messageQueue.get(SESSION_KEY)?.map((message) => message.text)).toEqual([
        "Second queued prompt",
      ]);
      expect(state.attachments.get(SESSION_KEY)).toEqual([queuedAttachment]);
      expect(state.selectedModel.get(SESSION_KEY)).toBe(MOCK_MODELS[0]!.id);
      expect(state.selectedMode.get(SESSION_KEY)).toBe("build");
      expect(state.selectedReasoningEffort.get(SESSION_KEY)).toBe("medium");
      expect(state.fastMode.get(SESSION_KEY)).toBe(false);
    });
    expect(mockAbortSession).toHaveBeenCalledWith(MOCK_CLIENT, SESSION_ID);

    resolveAbort?.(true);
  });

  test("stop logs a failed abort after clearing local loading state", async () => {
    const originalError = console.error;
    const consoleError = mock(() => {});
    console.error = consoleError as unknown as typeof console.error;
    mockAbortSession.mockImplementation(async () => false);
    useCodexStore.getState().setSessionLoading(SESSION_KEY, true);
    useCodexStore.getState().setSessionError(SESSION_KEY, "Previous error");

    try {
      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("codex-stop"));

      await waitFor(() => {
        const session = useCodexStore.getState().sessions.get(SESSION_KEY);
        expect(session?.isLoading).toBe(false);
        expect(session?.error).toBeUndefined();
        expect(consoleError).toHaveBeenCalledWith("[CodexChatTab] Failed to abort session");
      });
    } finally {
      console.error = originalError;
    }
  });

  test("persists accepted model and reasoning changes as global Codex defaults", async () => {
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    fireEvent.click(screen.getByTestId("codex-model-change"));
    await waitFor(() => {
      expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe("gpt-5.4-codex");
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("high");
      expect(mockUpdateGlobalConfig).toHaveBeenCalledWith(expect.objectContaining({
        codexModel: "gpt-5.4-codex",
        codexReasoningEffort: "high",
      }));
    });

    fireEvent.click(screen.getByTestId("codex-effort-change"));
    await waitFor(() => {
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("low");
      expect(mockUpdateGlobalConfig).toHaveBeenLastCalledWith(expect.objectContaining({
        codexModel: "gpt-5.4-codex",
        codexReasoningEffort: "low",
      }));
    });
  });

  test("rolls back rejected model changes and keeps the previous persisted defaults", async () => {
    mockUpdateSessionConfig.mockResolvedValue(false);
    render(<CodexChatTab tabId={TAB_ID} data={createData()} isActive={false} />);

    fireEvent.click(screen.getByTestId("codex-model-change"));

    await waitFor(() => {
      expect(useCodexStore.getState().selectedModel.get(SESSION_KEY)).toBe(MOCK_MODELS[0]!.id);
      expect(useCodexStore.getState().selectedReasoningEffort.get(SESSION_KEY)).toBe("medium");
    });
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
    expect(useCodexStore.getState().sessions.get(SESSION_KEY)?.error).toBe(
      "Failed to update Codex session settings",
    );
  });

  describe("fast mode toggle", () => {
    test("uses configured fast mode default when warm path creates a new session", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            codexNativeFastModeDefault: true,
          },
        },
      }));
      useCodexStore.setState((state) => ({
        ...state,
        sessions: new Map(),
        fastMode: new Map(),
      }));

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={true}
        />,
      );

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalled();
      });
      const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[1]).toMatchObject({ fastMode: true });
      expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);
    });

    test("uses configured fast mode default when cold path creates a new session", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            codexNativeFastModeDefault: true,
          },
        },
      }));
      useCodexStore.setState((state) => ({
        ...state,
        clients: new Map(),
        sessions: new Map(),
        fastMode: new Map(),
      }));

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={true}
        />,
      );

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalled();
      });
      const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[1]).toMatchObject({ fastMode: true });
      expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);
    });

    test("preserves an existing per-session fast mode value over the global default", async () => {
      useConfigStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          global: {
            ...state.config.global,
            codexNativeFastModeDefault: true,
          },
        },
      }));
      useCodexStore.setState((state) => ({
        ...state,
        sessions: new Map(),
        fastMode: new Map([[SESSION_KEY, false]]),
      }));

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={true}
        />,
      );

      await waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalled();
      });
      const lastCall = mockCreateSession.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[1]).toMatchObject({ fastMode: false });
      expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
    });

    test("persists fast mode in the store when the bridge accepts the config change", async () => {
      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("codex-fast-mode-on"));

      await waitFor(() => {
        expect(mockUpdateSessionConfig).toHaveBeenCalled();
      });
      const lastCall = mockUpdateSessionConfig.mock.calls.at(-1) as unknown as unknown[] | undefined;
      expect(lastCall?.[2]).toMatchObject({ fastMode: true });

      await waitFor(() => {
        expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(true);
      });
    });

    test("rolls back fast mode when the bridge rejects the config change", async () => {
      mockUpdateSessionConfig.mockImplementation(async () => false);

      render(
        <CodexChatTab
          tabId={TAB_ID}
          data={createData()}
          isActive={false}
        />,
      );

      fireEvent.click(screen.getByTestId("codex-fast-mode-on"));

      await waitFor(() => {
        expect(mockUpdateSessionConfig).toHaveBeenCalled();
      });

      // The optimistic update should be reverted to the previous value (false).
      await waitFor(() => {
        expect(useCodexStore.getState().isFastMode(SESSION_KEY)).toBe(false);
      });
    });
  });

});

function installTimerHarness(startTime: number) {
  mockedNow = startTime;
  intervalCallbacks = [];
  // Fires every interval registered with the harness. The component creates
  // multiple intervals (elapsed timer, watchdog poll); ticking all of them
  // keeps the elapsed timer test stable as new intervals are added.
  intervalCallback = () => {
    for (const callback of [...intervalCallbacks]) {
      callback();
    }
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

function restoreTimerHarness() {
  Date.now = ORIGINAL_DATE_NOW;
  globalThis.setInterval = ORIGINAL_SET_INTERVAL;
  globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
  intervalCallbacks = [];
  intervalCallback = null;
  clearIntervalCalls = 0;
}
