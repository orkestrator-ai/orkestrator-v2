import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createClaudeSessionKey, useClaudeStore } from "@/stores/claudeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";

import * as realHooks from "@/hooks";
const realHooksSnapshot = { ...realHooks };
const mockScrollToBottom = mock(() => {});
const mockCreateSession = mock(async () => ({ sessionId: "session-1" }));
const mockCheckHealth = mock(async () => true);
const mockSendPrompt = mock(async () => {});
const mockAbortSession = mock(async () => true);

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

mock.module("@/lib/claude-client", () => ({
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  getModels: mock(async () => []),
  createSession: mockCreateSession,
  getSession: mock(async () => null),
  getSessionMessages: mock(async () => []),
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
  });

  beforeEach(() => {
    cleanup();
    resetStores();
    mockScrollToBottom.mockClear();
    mockCreateSession.mockClear();
    mockCheckHealth.mockClear();
    mockSendPrompt.mockClear();
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
  });

  afterEach(() => {
    cleanup();
    Date.now = ORIGINAL_DATE_NOW;
    globalThis.setInterval = ORIGINAL_SET_INTERVAL;
    globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
    mock.restore();
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

  test("drains queued prompts when the session is idle", async () => {
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

  test("stop immediately clears loading and queued prompts while abort is in flight", async () => {
    useClaudeStore.getState().setSessionLoading(SESSION_KEY, true);
    useClaudeStore.getState().addToQueue(SESSION_KEY, {
      id: "queue-1",
      text: "Queued Claude prompt",
      attachments: [],
      effort: "high",
      planModeEnabled: false,
      fastModeEnabled: false,
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
      expect(state.messageQueue.get(SESSION_KEY)).toEqual([]);
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
