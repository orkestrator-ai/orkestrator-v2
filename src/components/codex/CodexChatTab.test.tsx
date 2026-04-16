import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createCodexSessionKey, useCodexStore } from "@/stores/codexStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";

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

const MOCK_MODELS = [
  {
    id: "gpt-5.3-codex",
    name: "gpt-5.3-codex",
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
  },
];

type TestCodexMessage = {
  id: string;
  role: "assistant";
  content: string;
  parts: Array<{ type: "text"; content: string }>;
  createdAt: string;
};

const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockSendPrompt = mock(async () => true);
const mockGetSessionMessages = mock(async (): Promise<TestCodexMessage[]> => []);
const mockSubscribeToEvents = mock(() => (async function* () {})());

// NOTE: Do NOT mock @/hooks/useScrollLock here — it pollutes the global
// module cache and breaks useScrollLock.test.ts. The real hook returns
// safe defaults (isAtBottom: true) when no viewport is found in happy-dom.

mock.module("@/lib/tauri", () => ({
  getCodexServerLog: mock(async () => ""),
  getCodexServerStatus: mock(async () => ({ running: true, hostPort: 9999 })),
  getLocalCodexServerStatus: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  renameEnvironmentFromPrompt: mockRenameEnvironmentFromPrompt,
  startCodexServer: mock(async () => ({ hostPort: 9999 })),
  startLocalCodexServer: mock(async () => ({ port: 9999, pid: 1234 })),
  updateGlobalConfig: mock(async (config) => config),
}));

mock.module("@/lib/codex-client", () => ({
  CODEX_MODELS: MOCK_MODELS,
  DEFAULT_CODEX_MODEL: MOCK_MODELS[0]!.id,
  abortSession: mock(async () => {}),
  checkHealth: mock(async () => true),
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  createSession: mock(async () => ({ sessionId: "session-1", title: "Test session" })),
  getModels: mock(async () => ({ models: MOCK_MODELS, source: "fallback" })),
  getSlashCommands: mock(async () => []),
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mock(async () => ({ status: "idle" })),
  resumeSession: mock(async () => null),
  sendPrompt: mockSendPrompt,
  subscribeToEvents: mockSubscribeToEvents,
  updateSessionConfig: mock(async () => true),
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
    disabled,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    disabled?: boolean;
  }) => (
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
  ),
}));

mock.module("./CodexPlanModeCard", () => ({
  CodexPlanModeCard: () => null,
}));

mock.module("./CodexResumeSessionDialog", () => ({
  CodexResumeSessionDialog: () => null,
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
let intervalCallback: (() => void) | null = null;
let clearIntervalCalls = 0;

function createMessage(id: string, content: string): TestCodexMessage {
  return {
    id,
    role: "assistant" as const,
    content,
    parts: [{ type: "text" as const, content }],
    createdAt: "2026-04-15T00:00:00.000Z",
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
      expect(screen.queryByText(composeText)).not.toBeNull();
      expect(screen.queryByText("Naming environment...")).not.toBeNull();
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
      expect(screen.queryByText("Naming environment...")).toBeNull();
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

function restoreTimerHarness() {
  Date.now = ORIGINAL_DATE_NOW;
  globalThis.setInterval = ORIGINAL_SET_INTERVAL;
  globalThis.clearInterval = ORIGINAL_CLEAR_INTERVAL;
  intervalCallback = null;
  clearIntervalCalls = 0;
}
