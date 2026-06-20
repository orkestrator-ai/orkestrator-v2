import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createCodexSessionKey, useCodexStore } from "@/stores/codexStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import * as realHooks from "@/hooks";

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
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;

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
  planReview?: boolean;
};

const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockSendPrompt = mock(async () => true);
const mockGetSessionMessages = mock(async (): Promise<TestCodexMessage[]> => []);
const mockSubscribeToEvents = mock(() => (async function* () {})());
const mockUpdateSessionConfig = mock(async () => true);
const mockAbortSession = mock(async () => true);
const mockCreateSession = mock(async () => ({ sessionId: "session-1", title: "Test session" }));

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
  abortSession: mockAbortSession,
  checkHealth: mock(async () => true),
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  createSession: mockCreateSession,
  getModels: mock(async () => ({ models: MOCK_MODELS, source: "fallback" })),
  getSlashCommands: mock(async () => []),
  getSessionMessages: mockGetSessionMessages,
  getSessionStatus: mock(async () => ({ status: "idle" })),
  resumeSession: mock(async () => null),
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
    disabled,
    isLoading,
    showAddressAll,
    layout,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    onStop?: () => Promise<void>;
    onModeChange?: (mode: "build" | "plan") => Promise<void>;
    onFastModeChange?: (enabled: boolean) => void;
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
  CodexResumeSessionDialog: () => null,
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
    mockScrollToBottom.mockClear();
    mockUpdateSessionConfig.mockClear();
    mockUpdateSessionConfig.mockImplementation(async () => true);
    mockAbortSession.mockClear();
    mockAbortSession.mockImplementation(async () => true);
    mockCreateSession.mockClear();
    mockCreateSession.mockImplementation(async () => ({ sessionId: "session-1", title: "Test session" }));
    mockIsAtBottom = true;
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
    expect(scrollButton.closest(".absolute")).not.toBeNull();

    fireEvent.click(scrollButton);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
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
    const composeDock = screen.getByTestId("codex-compose-layout").closest(".absolute");
    expect(composeDock?.contains(planCard)).toBe(true);
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
