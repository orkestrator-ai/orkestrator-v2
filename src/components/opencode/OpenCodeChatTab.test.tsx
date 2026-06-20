import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createOpenCodeSessionKey, useOpenCodeStore } from "@/stores/openCodeStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import * as realHooks from "@/hooks";

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
const mockScrollToBottom = mock(() => {});
let mockIsAtBottom = true;

const mockRenameEnvironmentFromPrompt = mock(async () => {});
const mockSendPrompt = mock(async () => ({ success: true }));
const mockAbortSession = mock(async () => true);
import type {
  OpenCodeModel,
  OpenCodeModelDefaults,
  OpenCodeModelsResponse,
} from "@/lib/opencode-client";
import type {
  OpenCodeModelRef,
  OpenCodeModelPreferences,
} from "@/lib/tauri";

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
  createClient: mock(() => ({ baseUrl: "http://127.0.0.1:9999" })),
  getModelsWithDefaults: mockGetModelsWithDefaults,
  createSession: mock(async () => ({ id: "session-1", createdAt: "2026-04-15T10:00:00.000Z" })),
  getSessionMessages: mock(async () => []),
  getPendingPermissions: mock(async () => []),
  getPendingQuestions: mock(async () => []),
  getAvailableSlashCommands: mock(async () => []),
  sendPrompt: mockSendPrompt,
  formatOpenCodeError: mock((error) => String(error)),
  abortSession: mockAbortSession,
  subscribeToEvents: mock(() => (async function* () {})()),
  ERROR_MESSAGE_PREFIX: "error-",
  SYSTEM_MESSAGE_PREFIX: "system-",
}));

mock.module("@/lib/tauri", () => ({
  startOpenCodeServer: mock(async () => ({ hostPort: 9999 })),
  getOpenCodeServerStatus: mock(async () => ({ running: true, hostPort: 9999 })),
  getOpenCodeServerLog: mock(async () => ""),
  getOpencodeModelPreferences: mockGetOpencodeModelPreferences,
  startLocalOpencodeServer: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
  getLocalOpencodeServerStatus: mock(async () => ({ running: true, port: 9999, pid: 1234 })),
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
    disabled,
    isLoading,
    showAddressAll,
    layout,
  }: {
    onSend: (text: string, attachments: typeof composeAttachments) => Promise<void>;
    onStop?: () => Promise<void>;
    onRefreshModels?: () => void | Promise<void>;
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
  OpenCodeResumeSessionDialog: () => null,
}));

mock.module("./slash-command-directory", () => ({
  resolveSlashCommandDirectory: mock(() => undefined),
  shouldLoadSlashCommands: mock(() => false),
}));

mock.module("./slash-command-registry", () => ({
  getNativeSlashCommands: mock(() => []),
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
}

// Restore the real sibling modules once this file's tests finish so later
// test files see the real modules.
afterAll(() => {
  mock.module("./OpenCodeComposeBar", () => realOpenCodeComposeBarSnapshot);
  mock.module("./OpenCodePermissionCard", () => realOpenCodePermissionCardSnapshot);
  mock.module("./OpenCodeQuestionCard", () => realOpenCodeQuestionCardSnapshot);
  mock.module("./OpenCodeResumeSessionDialog", () => realOpenCodeResumeSessionDialogSnapshot);
  mock.module("./slash-command-directory", () => realSlashCommandDirectorySnapshot);
  mock.module("./slash-command-registry", () => realSlashCommandRegistrySnapshot);
  mock.module("@/hooks", () => realHooksSnapshot);
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
    resetStores();
  });

  afterEach(() => {
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
            parts: [{ type: "text", text: "Existing response" }],
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

    resolveRename?.();

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalled();
    });

    await waitFor(() => {
      const messages = useOpenCodeStore.getState().getSession(SESSION_KEY)?.messages ?? [];
      expect(messages.some((message) => message.content === "Naming environment...")).toBe(false);
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
            parts: [{ type: "text", text: "Review complete" }],
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
      />,
    );

    await waitFor(() => {
      expect(mockSendPrompt).toHaveBeenCalledWith(
        MOCK_CLIENT,
        "session-1",
        initialPrompt,
        expect.objectContaining({ model: "openai/gpt-5", mode: "build" }),
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
