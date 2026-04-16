import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createClaudeSessionKey, useClaudeStore } from "@/stores/claudeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";

mock.module("@/lib/claude-client", () => ({
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  getModels: mock(async () => []),
  createSession: mock(async () => ({ sessionId: "session-1" })),
  getSession: mock(async () => null),
  getSessionMessages: mock(async () => []),
  sendPrompt: mock(async () => {}),
  abortSession: mock(async () => {}),
  subscribeToEvents: mock(() => (async function* () {})()),
  checkHealth: mock(async () => true),
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
  beforeEach(() => {
    cleanup();
    resetStores();
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
