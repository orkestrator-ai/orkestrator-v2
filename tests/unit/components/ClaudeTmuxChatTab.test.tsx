import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { clearPersistedScrollState } from "@/hooks/useScrollLock";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import * as realTauri from "@/lib/tauri";
import type { ClaudeMessage as ClaudeMessageType } from "@/lib/claude-client";
import * as realClaudeMessage from "@/components/claude/ClaudeMessage";
import * as realInteractiveTerminal from "@/components/claude/ClaudeTmuxInteractiveTerminal";
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import type { Environment, FileCandidate } from "@/types";

const realTmuxClientSnapshot = { ...realTmuxClient };
const realTauriSnapshot = { ...realTauri };
const realClaudeMessageSnapshot = { ...realClaudeMessage };
const realInteractiveTerminalSnapshot = { ...realInteractiveTerminal };
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const getFileTreeMock = mock(async () => []);
const getLocalFileTreeMock = mock(async () => []);
const renameEnvironmentFromPromptMock = mock(async () => {});
const updateGlobalConfigMock = mock(async (global: any) => ({
  version: "1.0",
  global,
  repositories: {},
}));

const startSessionMock = mock(async () => ({
  tab_id: "tab-1",
  environment_id: "env-1",
  session_id: "session-1",
  tmux_session: "orkestrator-env1-tab1",
  running: true,
  transcript_path: null,
  resumed: false,
  busy: false,
}));
const getStatusMock = mock(async () => null);
const getTranscriptMock = mock(async () => []);
const getPendingHooksMock = mock(async () => []);
let subscribedHandler: ((event: realTmuxClient.TmuxEvent) => void) | null = null;
const subscribeMock = mock(async (handler: (event: realTmuxClient.TmuxEvent) => void) => {
  subscribedHandler = handler;
  return () => {
    subscribedHandler = null;
  };
});
const stopSessionMock = mock(async () => {});
const interruptSessionMock = mock(async () => {});
const capturePaneMock = mock(async () => "");
const sendKeysMock = mock(async () => {});
const replyHookMock = mock(async () => {});
const submitMock = mock(async () => {});
const switchModelMock = mock(async () => {});
const answerPreToolUseMock = mock(async () => {});
const listPreviousSessionsMock = mock(async () => [
  {
    session_id: "resume-1",
    title: "Previous audit",
    last_activity_unix: Math.floor(Date.now() / 1000),
    message_count: 7,
  },
]);
const claudeMessageRenderMock = mock(
  ({
    message,
    previousMessage,
  }: {
    message: ClaudeMessageType;
    previousMessage?: ClaudeMessageType | null;
  }) => (
    <div
      data-testid="claude-message"
      data-message-id={message.id}
      data-previous-id={previousMessage?.id ?? ""}
      data-part-types={message.parts.map((part) => part.type).join(",")}
      data-tool-names={message.parts.map((part) => part.toolName ?? "").join(",")}
      data-tool-args={JSON.stringify(message.parts.map((part) => part.toolArgs ?? null))}
    >
      {message.content}
    </div>
  ),
);
const interactiveTerminalRenderMock = mock(
  ({
    tabId,
    isActive,
    className,
    containerId,
    worktreePath,
  }: {
    tabId: string;
    isActive: boolean;
    className?: string;
    containerId?: string | null;
    worktreePath?: string | null;
  }) => (
    <div
      data-testid="tmux-interactive-terminal"
      data-tab-id={tabId}
      data-active={String(isActive)}
      data-container-id={containerId ?? ""}
      data-worktree-path={worktreePath ?? ""}
      className={className}
    />
  ),
);

mock.module("@/lib/claude-tmux-client", () => ({
  ...realTmuxClientSnapshot,
  startSession: startSessionMock,
  getStatus: getStatusMock,
  getTranscript: getTranscriptMock,
  getPendingHooks: getPendingHooksMock,
  subscribe: subscribeMock,
  stopSession: stopSessionMock,
  interruptSession: (tabId: string, environmentId?: string) =>
    interruptSessionMock(tabId, environmentId),
  capturePane: (tabId: string, environmentId?: string) =>
    capturePaneMock(tabId, environmentId),
  sendKeys: (tabId: string, keys: string[], environmentId?: string) =>
    sendKeysMock(tabId, keys, environmentId),
  switchModel: (tabId: string, model: string, environmentId?: string) =>
    switchModelMock(tabId, model, environmentId),
  replyHook: (
    tabId: string,
    eventKind: realTmuxClient.HookEventKind,
    eventId: string,
    response: unknown,
    environmentId?: string,
  ) => replyHookMock(tabId, eventKind, eventId, response, environmentId),
  submit: (tabId: string, text: string, environmentId?: string) =>
    submitMock(tabId, text, environmentId),
  answerPreToolUse: (
    tabId: string,
    eventId: string,
    decision: "approve" | "block",
    reason?: string,
    environmentId?: string,
  ) => answerPreToolUseMock(tabId, eventId, decision, reason, environmentId),
  listPreviousSessions: listPreviousSessionsMock,
}));

mock.module("@/components/claude/ClaudeMessage", () => ({
  ...realClaudeMessageSnapshot,
  ClaudeMessage: claudeMessageRenderMock,
}));

mock.module("@/components/claude/ClaudeTmuxInteractiveTerminal", () => ({
  ClaudeTmuxInteractiveTerminal: interactiveTerminalRenderMock,
}));

mock.module("@/lib/tauri", () => ({
  getFileTree: getFileTreeMock,
  getLocalFileTree: getLocalFileTreeMock,
  renameEnvironmentFromPrompt: renameEnvironmentFromPromptMock,
  updateGlobalConfig: updateGlobalConfigMock,
}));

mock.module("@/components/chat/FileMentionMenu", () => ({
  FileMentionMenu: ({ files }: { files: FileCandidate[] }) => (
    <div>
      {files.map((file) => (
        <div key={file.relativePath}>{file.filename}</div>
      ))}
    </div>
  ),
}));

const { ClaudeTmuxChatTab, parseTmuxSelectionPrompt } = await import(
  "@/components/claude/ClaudeTmuxChatTab"
);

function seedPane(initialPrompt?: string) {
  usePaneLayoutStore.setState({
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "leaf",
            id: "default",
            activeTabId: "tab-1",
            tabs: [
              {
                id: "tab-1",
                type: "claude-tmux",
                initialPrompt,
                claudeTmuxData: { environmentId: "env-1" },
              },
            ],
          },
          activePaneId: "default",
          containerId: "container-1",
        },
      ],
    ]),
    activeEnvironmentId: "env-1",
  });
}

function seedEnvironment(overrides: Partial<Environment> = {}) {
  useEnvironmentStore.setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "20260528-123456",
        branch: "20260528-123456",
        containerId: "container-1",
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-05-28T12:34:56.000Z",
        networkAccessMode: "full",
        order: 0,
        environmentType: "containerized",
        ...overrides,
      },
    ],
  });
}

describe("ClaudeTmuxChatTab", () => {
  afterAll(() => {
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
    mock.module("@/lib/tauri", () => realTauriSnapshot);
    mock.module("@/components/claude/ClaudeMessage", () => realClaudeMessageSnapshot);
    mock.module("@/components/claude/ClaudeTmuxInteractiveTerminal", () => realInteractiveTerminalSnapshot);
    mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
  });

  beforeEach(() => {
    cleanup();
    getFileTreeMock.mockReset();
    getFileTreeMock.mockResolvedValue([]);
    getLocalFileTreeMock.mockReset();
    getLocalFileTreeMock.mockResolvedValue([]);
    renameEnvironmentFromPromptMock.mockReset();
    renameEnvironmentFromPromptMock.mockImplementation(async () => {});
    updateGlobalConfigMock.mockReset();
    updateGlobalConfigMock.mockImplementation(async (global: any) => ({
      version: "1.0",
      global,
      repositories: {},
    }));
    startSessionMock.mockClear();
    getStatusMock.mockClear();
    getStatusMock.mockImplementation(async () => null);
    getTranscriptMock.mockClear();
    getTranscriptMock.mockImplementation(async () => []);
    getPendingHooksMock.mockClear();
    getPendingHooksMock.mockImplementation(async () => []);
    subscribedHandler = null;
    subscribeMock.mockClear();
    stopSessionMock.mockClear();
    interruptSessionMock.mockClear();
    capturePaneMock.mockClear();
    sendKeysMock.mockClear();
    replyHookMock.mockClear();
    submitMock.mockClear();
    switchModelMock.mockClear();
    answerPreToolUseMock.mockClear();
    listPreviousSessionsMock.mockClear();
    claudeMessageRenderMock.mockClear();
    interactiveTerminalRenderMock.mockClear();
    capturePaneMock.mockImplementation(async () => "");
    submitMock.mockImplementation(async () => {});
    switchModelMock.mockImplementation(async () => {});
    listPreviousSessionsMock.mockImplementation(async () => [
      {
        session_id: "resume-1",
        title: "Previous audit",
        last_activity_unix: Math.floor(Date.now() / 1000),
        message_count: 7,
      },
    ]);
    useClaudeTmuxStore.setState({ tabs: new Map() });
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "claude-sonnet-4-6",
        },
        repositories: {},
      },
    }));
    clearPersistedScrollState("claude-tmux-tab-1");
    clearPersistedScrollState("claude-tmux-env:env-1:tab:tab-1");
    useEnvironmentStore.setState({
      environments: [],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set(),
      deletingEnvironments: new Set(),
      pendingSetupCommands: new Map(),
      setupCommandsResolved: new Set(),
      setupScriptsRunning: new Set(),
      sessionActivated: new Set(),
    });
    seedPane("Run the audit");
  });

  test("starts once with tabId+envId and clears the tab initialPrompt after the backend sends it", async () => {
    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => expect(startSessionMock).toHaveBeenCalledTimes(1));
    expect(startSessionMock.mock.calls[0]).toEqual([
      "tab-1",
      "env-1",
      {
        initialPrompt: "Run the audit",
        model: "claude-sonnet-4-6",
        planMode: false,
        resumeSessionId: undefined,
      },
    ]);

    expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]?.initialPrompt).toBe(
      "Run the audit",
    );

    act(() => {
      subscribedHandler?.({
        kind: "initial-prompt-sent",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
      });
    });

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs("env-1")[0];
      expect(tab?.initialPrompt).toBeUndefined();
    });
  });

  test("toggles between native transcript and interactive terminal mode while running", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const terminalButton = await waitFor(() => {
      const button = screen.getByRole("button", { name: /terminal/i });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button;
    });

    fireEvent.click(terminalButton);

    const terminal = screen.getByTestId("tmux-interactive-terminal");
    expect(terminal.getAttribute("data-tab-id")).toBe("tab-1");
    expect(terminal.getAttribute("data-active")).toBe("true");
    // Container/worktree props must be forwarded so clipboard paste targets
    // the right environment.
    expect(terminal.getAttribute("data-container-id")).toBe("container-1");
    // Pinned: useScrollLock's isActive/mountTrigger flip on the interactive
    // toggle causes one extra render on top of the initial mount.
    expect(interactiveTerminalRenderMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: /native/i }));

    expect(screen.queryByTestId("tmux-interactive-terminal")).toBeNull();
    expect(screen.getByRole("button", { name: /terminal/i })).toBeTruthy();
  });

  test("forwards the worktree path to the interactive terminal for local environments", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Local env",
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: new Date().toISOString(),
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
          worktreePath: "/tmp/local-repo",
        },
      ],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", isLocal: true }}
        isActive
      />,
    );

    const terminalButton = await waitFor(() => {
      const button = screen.getByRole("button", { name: /terminal/i });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button;
    });

    fireEvent.click(terminalButton);

    const terminal = screen.getByTestId("tmux-interactive-terminal");
    expect(terminal.getAttribute("data-worktree-path")).toBe("/tmp/local-repo");
    expect(terminal.getAttribute("data-container-id")).toBe("");
  });

  test("shows a scroll down button after the user scrolls up in native tmux transcript mode", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const viewport = await waitFor(() => {
      const element = document.querySelector('[data-slot="scroll-area-viewport"]');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });

    let scrollTop = 100;
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
      configurable: true,
    });
    Object.defineProperty(viewport, "scrollHeight", {
      get: () => 1000,
      configurable: true,
    });
    Object.defineProperty(viewport, "clientHeight", {
      get: () => 400,
      configurable: true,
    });

    fireEvent.scroll(viewport);

    const scrollButton = await screen.findByRole("button", {
      name: /scroll to bottom of conversation/i,
    });
    expect(scrollButton).toBeTruthy();

    viewport.scrollTo = mock(() => {});
    fireEvent.click(scrollButton);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: /scroll to bottom of conversation/i,
        }),
      ).toBeNull();
    });
  });

  test("hides the scroll down button while interactive terminal mode is active", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const viewport = await waitFor(() => {
      const element = document.querySelector('[data-slot="scroll-area-viewport"]');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });

    let scrollTop = 100;
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
      configurable: true,
    });
    Object.defineProperty(viewport, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { get: () => 400, configurable: true });

    fireEvent.scroll(viewport);
    await screen.findByRole("button", { name: /scroll to bottom of conversation/i });

    // Switch into interactive terminal mode — the ScrollArea unmounts and the
    // scroll-down affordance must disappear with it.
    fireEvent.click(await screen.findByRole("button", { name: /terminal/i }));

    await waitFor(() => {
      expect(screen.getByTestId("tmux-interactive-terminal")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /scroll to bottom of conversation/i }),
      ).toBeNull();
    });
  });

  test("auto-scrolls to bottom when new transcript content arrives while at the bottom", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const viewport = await waitFor(() => {
      const element = document.querySelector('[data-slot="scroll-area-viewport"]');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });

    let scrollTop = 0;
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
      configurable: true,
    });
    Object.defineProperty(viewport, "scrollHeight", { get: () => 1200, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { get: () => 400, configurable: true });

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "transcript-line",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-existing",
        line: {
          type: "assistant",
          uuid: "a-new",
          timestamp: "2026-05-15T12:02:00.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Streaming chunk" }],
          },
        },
      });
    });

    await waitFor(() => expect(scrollTop).toBe(1200));
  });

  test("restores scroll position after the tab is hidden and shown again", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    const { rerender } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const viewport = await waitFor(() => {
      const element = document.querySelector('[data-slot="scroll-area-viewport"]');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });

    let scrollTop = 250;
    Object.defineProperty(viewport, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
      configurable: true,
    });
    Object.defineProperty(viewport, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(viewport, "clientHeight", { get: () => 400, configurable: true });

    // Scroll up so the persisted state should remember a non-bottom position.
    fireEvent.scroll(viewport);
    await screen.findByRole("button", { name: /scroll to bottom of conversation/i });

    // Deactivate the tab (e.g., user switched panes); hook persists state.
    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive={false}
      />,
    );

    // Simulate the viewport scrolling away while inactive (other tab work),
    // then reactivate and assert the persisted scrollTop is restored.
    scrollTop = 0;
    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(scrollTop).toBe(250));
    expect(
      screen.queryByRole("button", { name: /scroll to bottom of conversation/i }),
    ).not.toBeNull();
  });

  test("keeps interactive terminal mode disabled until a tmux session is running", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const terminalButton = screen.getByRole("button", { name: /terminal/i });
    expect((terminalButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(terminalButton);

    expect(screen.queryByTestId("tmux-interactive-terminal")).toBeNull();
  });

  test("hydrates a running backend session and replays missed transcript before auto-starting", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));
    getTranscriptMock.mockImplementation(async () => [
      {
        type: "user",
        uuid: "u-1",
        timestamp: "2026-05-15T12:00:00.000Z",
        message: { role: "user", content: "Run the audit" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        timestamp: "2026-05-15T12:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final result: tests pass." }],
        },
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.sessionId).toBe("session-existing");
      expect(tab.messages.map((m) => m.content)).toEqual([
        "Run the audit",
        "Final result: tests pass.",
      ]);
      expect(tab.busy).toBe(false);
    });

    expect(startSessionMock).not.toHaveBeenCalled();
  });

  test("hydrates backend busy state and pending hook prompts", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: true,
    }));
    getPendingHooksMock.mockImplementation(async () => [
      {
        id: "q-hook",
        kind: "PreToolUse",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
        },
      },
      {
        id: "perm-hook",
        kind: "PermissionRequest",
        payload: {
          tool_name: "Bash",
          tool_input: { command: "bun test" },
          permission_suggestions: [],
        },
      },
      {
        id: "question-permission-hook",
        kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        initialPrompt="Run the audit"
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.busy).toBe(true);
      expect(tab.pendingQuestions).toHaveLength(1);
      expect(tab.pendingQuestions[0]!.eventId).toBe("q-hook");
      expect(tab.pendingPermissions).toHaveLength(1);
      expect(tab.pendingPermissions[0]!.eventId).toBe("perm-hook");
    });
    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "question-permission-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PermissionRequest",
            decision: expect.objectContaining({
              behavior: "allow",
            }),
          }),
        }),
        "env-1",
      );
    });
    expect(startSessionMock).not.toHaveBeenCalled();
  });

  test("auto-allows AskUserQuestion PermissionRequest hooks without rendering the legacy permission card", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "question-permission-hook",
        event_kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      });
    });

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "question-permission-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PermissionRequest",
            decision: expect.objectContaining({
              behavior: "allow",
            }),
          }),
        }),
        "env-1",
      );
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingPermissions).toEqual([]);
    expect(screen.queryByText("Claude needs permission")).toBeNull();
  });

  test("keeps a recoverable permission card when hydrated AskUserQuestion PermissionRequest auto-allow fails", async () => {
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));
    getPendingHooksMock.mockImplementation(async () => [
      {
        id: "question-permission-hook",
        kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      },
    ]);
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge unavailable");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingPermissions).toHaveLength(1);
      expect(tab.pendingPermissions[0]!.eventId).toBe("question-permission-hook");
    });
    expect(await screen.findByText("Claude needs permission")).toBeTruthy();
  });

  test("keeps a recoverable permission card when live AskUserQuestion PermissionRequest auto-allow fails", async () => {
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge unavailable");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "question-permission-hook",
        event_kind: "PermissionRequest",
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [{ label: "React" }],
                multiSelect: false,
              },
            ],
          },
          permission_suggestions: [],
        },
      });
    });

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingPermissions).toHaveLength(1);
      expect(tab.pendingPermissions[0]!.eventId).toBe("question-permission-hook");
    });
    expect(await screen.findByText("Claude needs permission")).toBeTruthy();
  });

  test("hydrates pending hook snapshot as authoritative and clears stale prompts", async () => {
    useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
      eventId: "stale",
      toolName: "Bash",
      toolInput: {},
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    getStatusMock.mockImplementation(async () => ({
      tab_id: "tab-1",
      environment_id: "env-1",
      session_id: "session-existing",
      tmux_session: "orkestrator-env1-tab1",
      running: true,
      transcript_path: "/tmp/session-existing.jsonl",
      resumed: false,
      busy: false,
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      const tab = useClaudeTmuxStore.getState().getTab("tab-1");
      expect(tab.pendingApprovals).toEqual([]);
    });
  });

  test("keeps busy during SubagentStop and clears it on top-level Stop", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setBusy("tab-1", true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "subagent-stop",
        event_kind: "SubagentStop",
        payload: {},
      });
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(true);

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "stop",
        event_kind: "Stop",
        payload: {},
      });
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(false);
  });

  test("does not render non-actionable hook notifications above the transcript", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

    act(() => {
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "session-start",
        event_kind: "SessionStart",
        payload: {},
      });
      subscribedHandler?.({
        kind: "hook",
        tab_id: "tab-1",
        environment_id: "env-1",
        session_id: "session-1",
        event_id: "notification",
        event_kind: "Notification",
        payload: { message: "Background note" },
      });
    });

    expect(useClaudeTmuxStore.getState().getTab("tab-1").infoEvents).toEqual([]);
    expect(screen.queryByText("SessionStart")).toBeNull();
    expect(screen.queryByText("Background note")).toBeNull();
  });

  test("typing / opens the built-in slash command menu and selecting one fills the input", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/" } });

    // Menu opens with the builtin list visible.
    const slashHeader = await screen.findByText("Slash Commands");
    expect(slashHeader).toBeTruthy();
    expect(screen.getByText("/clear")).toBeTruthy();
    expect(screen.getByText("/model")).toBeTruthy();

    // Filtering narrows the list.
    fireEvent.change(textarea, { target: { value: "/com" } });
    await waitFor(() => {
      expect(screen.queryByText("/clear")).toBeNull();
      expect(screen.getByText("/compact")).toBeTruthy();
    });

    // Clicking inserts the command and a trailing space.
    fireEvent.click(screen.getByText("/compact"));
    expect(textarea.value).toBe("/compact ");
  });

  test("supports slash command keyboard selection and Escape dismissal", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/" } });
    await screen.findByText("Slash Commands");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea.value).toBe("/bug ");

    fireEvent.change(textarea, { target: { value: "/" } });
    await screen.findByText("Slash Commands");
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByText("Slash Commands")).toBeNull();
  });

  test("inserts a selected @ file mention into the tmux compose input", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    getFileTreeMock.mockResolvedValue([
      {
        name: "src",
        path: "src",
        isDirectory: true,
        children: [
          {
            name: "Button.tsx",
            path: "src/components/Button.tsx",
            isDirectory: false,
            extension: ".tsx",
          },
        ],
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;

    const cursorPosition = "Review @".length;
    fireEvent.change(textarea, {
      target: {
        value: "Review @",
        selectionStart: cursorPosition,
        selectionEnd: cursorPosition,
      },
    });
    textarea.setSelectionRange(cursorPosition, cursorPosition);
    fireEvent.click(textarea);

    await screen.findByText("Button.tsx");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(textarea.value).toBe("Review @src/components/Button.tsx ");
    });
    expect(screen.queryByText("Button.tsx")).toBeNull();
  });

  test("loads @ file suggestions from a local worktree when no container is present", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "Local env",
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: new Date().toISOString(),
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
          worktreePath: "/tmp/local-repo",
        },
      ],
    });
    getLocalFileTreeMock.mockResolvedValue([
      {
        name: "local.ts",
        path: "src/local.ts",
        isDirectory: false,
        extension: ".ts",
      },
    ]);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", isLocal: true }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "@",
        selectionStart: 1,
        selectionEnd: 1,
      },
    });

    await waitFor(() => {
      expect(getLocalFileTreeMock).toHaveBeenCalledWith("/tmp/local-repo");
    });
    expect(await screen.findByText("local.ts")).toBeTruthy();
    expect(getFileTreeMock).not.toHaveBeenCalled();
  });

  test("keeps Enter from submitting while an empty @ file mention menu is open", async () => {
    useClaudeTmuxStore.getState().setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = await screen.findByPlaceholderText(/@ to mention/) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: {
        value: "@missing",
        selectionStart: "@missing".length,
        selectionEnd: "@missing".length,
      },
    });

    submitMock.mockClear();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(submitMock).not.toHaveBeenCalled();
    expect(textarea.value).toBe("@missing");
  });

  test("switches the running tmux model through Claude's slash command", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const modelButton = screen.getByRole("button", {
      name: /Sonnet 4\.6/,
    }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(false);

    fireEvent.pointerDown(modelButton);
    const opusOption = await screen.findByText("Opus 4.7");
    await act(async () => {
      fireEvent.click(opusOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchModelMock).toHaveBeenCalledWith(
        "tab-1",
        "claude-opus-4-7",
        "env-1",
      );
    });
    expect(screen.getByRole("button", { name: /Opus 4\.7/ })).toBeTruthy();
  });

  test("does not send the launch-only Default model sentinel to a running tmux session", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet 4\.6/ }));
    const defaultOption = (await screen.findByText("Default")).closest(
      "[role='menuitem']",
    );

    expect(defaultOption).toBeTruthy();
    expect(
      defaultOption?.getAttribute("aria-disabled") === "true" ||
        defaultOption?.hasAttribute("data-disabled"),
    ).toBe(true);

    fireEvent.click(defaultOption!);
    expect(switchModelMock).not.toHaveBeenCalledWith("tab-1", "default");
    expect(updateGlobalConfigMock).not.toHaveBeenCalled();
  });

  test("uses the pre-launch model selection when starting fresh", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    const modelButton = screen.getByRole("button", {
      name: /Sonnet 4\.6/,
    }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(false);

    fireEvent.pointerDown(modelButton);
    const haikuOption = await screen.findByText("Haiku 4.5");
    await act(async () => {
      fireEvent.click(haikuOption);
    });
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "claude-haiku-4-5",
        planMode: false,
        resumeSessionId: undefined,
      });
    });
  });

  test("seeds fresh tmux sessions from the persisted Claude model default", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "claude-opus-4-7",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Opus 4\.7/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "claude-opus-4-7",
        planMode: false,
        resumeSessionId: undefined,
      });
    });
  });

  test("uses Claude Code's own model default when persisted tmux model is Default", async () => {
    seedPane();
    useConfigStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        global: {
          ...state.config.global,
          claudeModel: "default",
        },
      },
    }));

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Default/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: undefined,
        planMode: false,
        resumeSessionId: undefined,
      });
    });
  });

  test("persists selected tmux model as the default for later sessions", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet 4\.6/ }));
    const haikuOption = await screen.findByText("Haiku 4.5");
    await act(async () => {
      fireEvent.click(haikuOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(updateGlobalConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ claudeModel: "claude-haiku-4-5" }),
      );
      expect(useConfigStore.getState().config.global.claudeModel).toBe(
        "claude-haiku-4-5",
      );
    });

    cleanup();
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-2"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: /Haiku 4\.5/ })).toBeTruthy();
  });

  test("rolls back the persisted tmux model preference when saving fails", async () => {
    seedPane();
    updateGlobalConfigMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet 4\.6/ }));
    const haikuOption = await screen.findByText("Haiku 4.5");
    await act(async () => {
      fireEvent.click(haikuOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useConfigStore.getState().config.global.claudeModel).toBe(
        "claude-sonnet-4-6",
      );
    });
    expect(await screen.findByText("Failed to save Claude model default")).toBeTruthy();
  });

  test("locks compose and model controls while a model switch is in flight", async () => {
    let resolveSubmit!: () => void;
    switchModelMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello after switch" } });

    const modelButton = screen.getByRole("button", {
      name: /Sonnet 4\.6/,
    }) as HTMLButtonElement;
    fireEvent.pointerDown(modelButton);
    const opusOption = await screen.findByText("Opus 4.7");
    await act(async () => {
      fireEvent.click(opusOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchModelMock).toHaveBeenCalledWith(
        "tab-1",
        "claude-opus-4-7",
        "env-1",
      );
      expect(textarea.disabled).toBe(true);
      expect(
        screen.getByRole("button", { name: /Sonnet 4\.6/ }),
      ).toHaveProperty("disabled", true);
    });

    fireEvent.click(screen.getByTitle("Send (↵)"));
    expect(switchModelMock).toHaveBeenCalledTimes(1);
    expect(submitMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveSubmit();
    });

    await waitFor(() => {
      expect(textarea.disabled).toBe(false);
      expect(screen.getByRole("button", { name: /Opus 4\.7/ })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });

  test("shows an error and keeps the previous model when model switching fails", async () => {
    switchModelMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const modelButton = screen.getByRole("button", {
      name: /Sonnet 4\.6/,
    }) as HTMLButtonElement;
    fireEvent.pointerDown(modelButton);
    const opusOption = await screen.findByText("Opus 4.7");
    await act(async () => {
      fireEvent.click(opusOption);
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Sonnet 4\.6/ })).toHaveProperty(
        "disabled",
        false,
      );
    });
    expect(screen.queryByRole("button", { name: /Opus 4\.7/ })).toBeNull();
  });

  test("keeps plan mode launch-only once the session is running", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const planButton = screen.getByRole("button", {
      name: /Build/,
    }) as HTMLButtonElement;

    expect(planButton.disabled).toBe(true);
  });

  test("starts a previous session from the resume picker", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Resume previous session/ }));
    expect(await screen.findByText("Previous audit")).toBeTruthy();
    fireEvent.click(screen.getByText("Previous audit"));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "claude-sonnet-4-6",
        planMode: false,
        resumeSessionId: "resume-1",
      });
    });
  });

  test("interrupts the running tmux session from the header", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));

    expect(interruptSessionMock).toHaveBeenCalledWith("tab-1", "env-1");
    expect(stopSessionMock).not.toHaveBeenCalled();
  });

  test("shows an enabled interrupt button in the compose bar while busy and keeps draft editable", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setBusy("tab-1", true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "continue with this" } });
    expect(textarea.value).toBe("continue with this");

    fireEvent.click(screen.getByTitle("Interrupt current response"));

    await waitFor(() => {
      expect(interruptSessionMock).toHaveBeenCalledWith("tab-1", "env-1");
    });
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(false);
  });

  test("shows interrupt errors without clearing busy state", async () => {
    interruptSessionMock.mockImplementationOnce(async () => {
      throw new Error("interrupt failed");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().setBusy("tab-1", true);

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByTitle("Interrupt current response"));

    expect(await screen.findByText("Error: interrupt failed")).toBeTruthy();
    expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(true);
  });

  test("shows submit errors and re-enables compose after a failed prompt", async () => {
    submitMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    await waitFor(() => expect(textarea.disabled).toBe(false));
  });

  test("review tabs submit the shared Address all follow-up prompt", async () => {
    const message: ClaudeMessageType = {
      id: "msg-review-complete",
      role: "assistant" as const,
      content: "Review complete",
      parts: [{ type: "text" as const, content: "Review complete" }],
      timestamp: "2026-03-07T12:00:00.000Z",
    };
    const store = useClaudeTmuxStore.getState();
    const current = store.getTab("tab-1");
    useClaudeTmuxStore.setState({
      tabs: new Map([
        [
          "tab-1",
          {
            ...current,
            environmentId: "env-1",
            sessionId: "session-1",
            running: true,
            busy: false,
            messages: [message],
          },
        ],
      ]),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
        isReviewTab
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Address all" }));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        ADDRESS_ALL_REVIEW_PROMPT,
        "env-1",
      );
    });
  });

  test("renames a timestamp-named environment before submitting the first tmux prompt", async () => {
    const callOrder: string[] = [];
    renameEnvironmentFromPromptMock.mockImplementationOnce(async () => {
      callOrder.push("rename");
    });
    submitMock.mockImplementationOnce(async () => {
      callOrder.push("submit");
    });
    seedEnvironment();
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Implement the billing export" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(renameEnvironmentFromPromptMock).toHaveBeenCalledWith(
        "env-1",
        "Implement the billing export",
      );
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Implement the billing export",
        "env-1",
      );
    });
    expect(callOrder).toEqual(["rename", "submit"]);
  });

  test("does not rename a custom-named environment before submitting a tmux prompt", async () => {
    seedEnvironment({ name: "custom-env", branch: "custom-env" });
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const textarea = screen.getByPlaceholderText(
      /Ask Claude anything/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Keep this branch name" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Keep this branch name",
        "env-1",
      );
    });
    expect(renameEnvironmentFromPromptMock).not.toHaveBeenCalled();
  });

  test("renders compacted assistant messages and passes compacted previousMessage", async () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.applyTranscriptLine("tab-1", {
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "inspect" },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
      },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "a2",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu2", name: "Grep", input: {} }],
      },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "a3",
      timestamp: "2026-01-01T00:00:03Z",
      message: { role: "assistant", content: "done" },
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const renderedMessages = screen.getAllByTestId("claude-message");
    expect(renderedMessages).toHaveLength(2);
    expect(renderedMessages[1]!.dataset.messageId).toBe("a1");
    expect(renderedMessages[1]!.dataset.previousId).toBe("u1");
    expect(renderedMessages[1]!.dataset.partTypes).toBe(
      "tool-invocation,tool-invocation,text",
    );
  });

  test("renders repeated task tools as one current TaskList snapshot", async () => {
    const store = useClaudeTmuxStore.getState();
    store.setRunning("tab-1", true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "task-create-1",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-create-1",
            name: "TaskCreate",
            input: { subject: "Inspect renderer" },
          },
        ],
      },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "task-create-2",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-create-2",
            name: "TaskCreate",
            input: { subject: "Add UI tests" },
          },
        ],
      },
    });
    store.applyTranscriptLine("tab-1", {
      type: "assistant",
      uuid: "task-update-1",
      timestamp: "2026-01-01T00:00:03Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "task-update-1",
            name: "TaskUpdate",
            input: { taskId: "1", status: "completed" },
          },
        ],
      },
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const renderedMessages = screen.getAllByTestId("claude-message");
    expect(renderedMessages).toHaveLength(1);
    expect(renderedMessages[0]!.dataset.toolNames).toBe("TaskList");
    expect(JSON.parse(renderedMessages[0]!.dataset.toolArgs ?? "[]")).toEqual([
      {
        todos: [
          { content: "Inspect renderer", status: "completed" },
          { content: "Add UI tests", status: "pending" },
        ],
      },
    ]);
  });

  test("parses Claude Code in-TUI selection prompts from a tmux pane snapshot", () => {
    const prompt = parseTmuxSelectionPrompt(`
› 1. Kill stale tmux before launch (Recommended)
  2. Always kill before launch
  3. Randomize tmux session name

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);

    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "Kill stale tmux before launch (Recommended)",
      "Always kill before launch",
      "Randomize tmux session name",
    ]);
  });

  test("parses only the active TUI option block and shows its question", () => {
    const prompt = parseTmuxSelectionPrompt(`
1. Run \`git diff origin/main...HEAD\` to see all changes that will be in the PR
2. Run \`git log main..HEAD --oneline\` to see all commits
3. Create the PR using: \`gh pr create --base main --fill\`

Two staged files look like they shouldn't be in the PR. How should I handle them?

› 1. Unstage & add to .gitignore (Recommended)
     .codex/hooks.json has session-specific /tmp paths and tsconfig.tsbuildinfo is generated.
  2. Commit them as-is
  3. Unstage only (no .gitignore change)
  4. Type something.
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);

    expect(prompt?.question).toBe(
      "Two staged files look like they shouldn't be in the PR. How should I handle them?",
    );
    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "Unstage & add to .gitignore (Recommended) .codex/hooks.json has session-specific /tmp paths and tsconfig.tsbuildinfo is generated.",
      "Commit them as-is",
      "Unstage only (no .gitignore change)",
      "Type something.",
      "Chat about this",
    ]);
  });

  test("shows controls for Claude Code selection prompts and answers through tmux keys on submit", async () => {
    capturePaneMock.mockImplementation(async () => `
  1. Kill stale tmux before launch (Recommended)
› 2. Always kill before launch
  3. Randomize tmux session name

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Randomize tmux session name/ }),
    );
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["Down", "Enter"], "env-1");
    });
  });

  test("does not render a parsed TUI selection prompt while a native hook question is pending", async () => {
    capturePaneMock.mockImplementation(async () => `
Which framework?

› 1. React
  2. Vue

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude needs your input")).toBeTruthy();
    expect(screen.queryByText("Claude is asking for a choice")).toBeNull();
  });

  test("answers confirmation prompts by sending only the selected option number", async () => {
    capturePaneMock.mockImplementation(async () => `
WARNING: Claude Code running in Bypass Permissions mode

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Yes, I accept/ }));
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["2"], "env-1");
    });
  });

  test("submits the highlighted confirmation option by sending its number", async () => {
    capturePaneMock.mockImplementation(async () => `
WARNING: Claude Code running in Bypass Permissions mode

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["1"], "env-1");
    });
  });

  test("renders the active TUI question without stale numbered transcript lines", async () => {
    capturePaneMock.mockImplementation(async () => `
1. Run \`git diff origin/main...HEAD\` to see all changes that will be in the PR
2. Run \`git log main..HEAD --oneline\` to see all commits

Two staged files look like they shouldn't be in the PR. How should I handle them?

› 1. Unstage & add to .gitignore (Recommended)
  2. Commit them as-is
  3. Unstage only (no .gitignore change)

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(
      await screen.findByText(
        "Two staged files look like they shouldn't be in the PR. How should I handle them?",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /git diff origin\/main/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /Unstage & add to \.gitignore \(Recommended\)/,
      }),
    ).toBeTruthy();
  });

  test("parses confirmation prompts with the full context instead of only the URL", () => {
    const prompt = parseTmuxSelectionPrompt(`
------------------------------------------------------------
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.

By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe(
      [
        "WARNING: Claude Code running in Bypass Permissions mode",
        "",
        "In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.",
        "This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.",
        "",
        "By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.",
        "",
        "https://code.claude.com/docs/en/security",
      ].join("\n"),
    );
    expect(prompt?.selectedOptionIndex).toBe(0);
    expect(prompt?.options.map((o) => o.label)).toEqual([
      "No, exit",
      "Yes, I accept",
    ]);
  });

  test("submitting a different confirmation answer types its number before enter", async () => {
    capturePaneMock.mockImplementation(async () => `
WARNING: Claude Code running in Bypass Permissions mode

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Yes, I accept/ }));
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenLastCalledWith("tab-1", ["2"], "env-1");
    });
  });

  test("duplicate labels still submit the clicked numbered option", async () => {
    capturePaneMock.mockImplementation(async () => `
Choose the retry scope

› 1. Retry
  2. Retry

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    const retryButtons = screen.getAllByRole("button", { name: "Retry" });
    fireEvent.click(retryButtons[1]!);
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["2"], "env-1");
    });
  });

  test("navigates upward when selecting an option above the highlighted TUI option", async () => {
    capturePaneMock.mockImplementation(async () => `
Choose an action

  1. Allow once
  2. Allow this session
› 3. Deny

Enter to confirm · ↑/↓ to navigate · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", [
        "Up",
        "Up",
        "Enter",
      ], "env-1");
    });
  });

  test("selection prompts do not show a Dismiss button", async () => {
    capturePaneMock.mockImplementation(async () => `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  test("keeps selection prompt controls disabled while tmux keys are pending", async () => {
    let resolveSendKeys: (() => void) | null = null;
    sendKeysMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSendKeys = resolve;
        }),
    );
    capturePaneMock.mockImplementation(async () => `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    const noButton = screen.getByRole("button", { name: /No, exit/ }) as HTMLButtonElement;
    const yesButton = screen.getByRole("button", { name: /Yes, I accept/ }) as HTMLButtonElement;
    fireEvent.click(yesButton);
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledTimes(1);
      expect(yesButton.disabled).toBe(true);
    });

    fireEvent.click(noButton);
    expect(sendKeysMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSendKeys?.();
    });
  });

  test("shows an error and re-enables selection controls when tmux key submission fails", async () => {
    sendKeysMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    capturePaneMock.mockImplementation(async () => `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    const yesButton = screen.getByRole("button", {
      name: /Yes, I accept/,
    }) as HTMLButtonElement;
    fireEvent.click(yesButton);
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    await waitFor(() => {
      expect(yesButton.disabled).toBe(false);
    });
  });

  test("shows an error when refreshing the TUI snapshot after tmux key submission fails", async () => {
    capturePaneMock.mockImplementation(async () => `
› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    capturePaneMock.mockImplementationOnce(async () => {
      throw new Error("capture failed");
    });

    fireEvent.click(screen.getByRole("button", { name: /Yes, I accept/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["2"], "env-1");
    });
    expect(await screen.findByText("Error: capture failed")).toBeTruthy();
  });

  test("sends each digit for multi-digit numbered confirmation options", async () => {
    let pane = "";
    for (let i = 1; i <= 10; i++) {
      pane += `${i === 1 ? "› " : "  "}${i}. Option ${i}\n`;
    }
    pane += "\nEnter to confirm · Esc to cancel\n";
    capturePaneMock.mockImplementation(async () => pane);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Option 10/ }));
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["1", "0"], "env-1");
    });
  });

  test("defaults to navigate mode when no input-mode hint is present", async () => {
    capturePaneMock.mockImplementation(async () => `
  1. Kill stale tmux before launch (Recommended)
› 2. Always kill before launch

Enter to select · Esc to cancel
`);
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Claude is asking for a choice")).toBeTruthy();

    // Submitting the already-selected option should send only Enter (delta = 0).
    fireEvent.click(
      screen.getByRole("button", { name: /Always kill before launch/ }),
    );
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["Enter"], "env-1");
    });
  });

  test("does not absorb a prior numbered option list into a URL-only question", () => {
    const prompt = parseTmuxSelectionPrompt(`
1. Some earlier listed step
2. Another earlier step
3. A third earlier step

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("does not absorb a bracketed log prefix paragraph into a URL-only question", () => {
    const prompt = parseTmuxSelectionPrompt(`
[INFO] background task complete

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("does not absorb a bare shell prompt paragraph into a URL-only question", () => {
    const prompt = parseTmuxSelectionPrompt(`
node@host$

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("stops question expansion at a ------ boundary line", () => {
    const prompt = parseTmuxSelectionPrompt(`
This earlier paragraph is before the boundary and should not appear.

------------------------------------------------------------

https://code.claude.com/docs/en/security

› 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`);

    expect(prompt?.question).toBe("https://code.claude.com/docs/en/security");
  });

  test("answers AskUserQuestion hooks with PreToolUse updatedInput", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "q-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: expect.objectContaining({
              answers: { "Which framework?": "React" },
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("maps multi-question and multi-select AskUserQuestion answers", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which frameworks?",
          header: "Frameworks",
          options: [{ label: "React" }, { label: "Vue" }],
          multiSelect: true,
        },
        {
          question: "Any notes?",
          header: "Notes",
          options: [],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which frameworks?",
            header: "Frameworks",
            options: [{ label: "React" }, { label: "Vue" }],
            multiSelect: true,
          },
          {
            question: "Any notes?",
            header: "Notes",
            options: [],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    fireEvent.click(screen.getByRole("button", { name: /Vue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByPlaceholderText(/Type your answer/i), {
      target: { value: "Prefer TypeScript-first tooling" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "q-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            updatedInput: expect.objectContaining({
              answers: {
                "Which frameworks?": "React, Vue",
                "Any notes?": "Prefer TypeScript-first tooling",
              },
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("keeps AskUserQuestion pending when replyHook fails", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    replyHookMock.mockImplementationOnce(async () => {
      throw new Error("bridge down");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /React/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByText("Error: bridge down")).toBeTruthy();
      expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingQuestions).toHaveLength(1);
    });
  });

  test("dismisses AskUserQuestion hooks with a PreToolUse denial", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingQuestion("tab-1", {
      eventId: "q-hook",
      questions: [
        {
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React" }],
          multiSelect: false,
        },
      ],
      toolInput: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [{ label: "React" }],
            multiSelect: false,
          },
        ],
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "q-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
            permissionDecisionReason: "User declined to answer the question.",
          }),
        }),
        "env-1",
      );
      expect(useClaudeTmuxStore.getState().getTab("tab-1").pendingQuestions).toEqual([]);
    });
  });

  test("answers plan approvals and change requests", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPlan("tab-1", {
      eventId: "plan-hook",
      plan: "Update the tests",
      planFilePath: "/tmp/plan.md",
      allowedPrompts: [],
      toolInput: { plan: "Update the tests" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    useClaudeTmuxStore.getState().addPendingPlan("tab-1", {
      eventId: "plan-hook-2",
      plan: "Ship it",
      planFilePath: null,
      allowedPrompts: [],
      toolInput: { plan: "Ship it" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Request changes" })[0]!);
    fireEvent.change(screen.getByPlaceholderText("What should Claude change?"), {
      target: { value: "Add edge cases" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Request changes" })[0]!);

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "plan-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "deny",
            permissionDecisionReason: "Add edge cases",
          }),
        }),
        "env-1",
      );
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Approve plan" })).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PreToolUse",
        "plan-hook-2",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            permissionDecision: "allow",
            updatedInput: { plan: "Ship it" },
          }),
        }),
        "env-1",
      );
    });
  });

  test("answers legacy PreToolUse approval cards", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingApproval("tab-1", {
      eventId: "approval-hook",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => {
      expect(answerPreToolUseMock).toHaveBeenCalledWith(
        "tab-1",
        "approval-hook",
        "approve",
        undefined,
        "env-1",
      );
    });
  });

  test("answers PermissionRequest hooks with nested permission decision", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPermission("tab-1", {
      eventId: "perm-hook",
      toolName: "Bash",
      toolInput: { command: "bun test", description: "Run tests" },
      permissionSuggestions: [],
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "perm-hook",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            hookEventName: "PermissionRequest",
            decision: expect.objectContaining({
              behavior: "allow",
              updatedInput: { command: "bun test", description: "Run tests" },
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("answers PermissionRequest suggestions as persistent permission updates", async () => {
    const suggestion = { tool: "Bash", command: "bun test" };
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingPermission("tab-1", {
      eventId: "perm-suggestion",
      toolName: "Bash",
      toolInput: { command: "bun test" },
      permissionSuggestions: [suggestion],
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "PermissionRequest",
        "perm-suggestion",
        expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({
            decision: expect.objectContaining({
              behavior: "allow",
              updatedPermissions: [suggestion],
            }),
          }),
        }),
        "env-1",
      );
    });
  });

  test("answers MCP Elicitation hooks with form content", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-hook",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: {
        type: "object",
        properties: {
          username: { type: "string", title: "Username" },
        },
      },
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith(
        "tab-1",
        "Elicitation",
        "elicit-hook",
        {
          hookSpecificOutput: {
            hookEventName: "Elicitation",
            action: "accept",
            content: { username: "alice" },
          },
        },
        "env-1",
      );
    });
  });

  test("declines and cancels MCP Elicitation hooks", async () => {
    useClaudeTmuxStore
      .getState()
      .setRunning("tab-1", true, {
        environmentId: "env-1",
        sessionId: "session-1",
      });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-decline",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: null,
      payload: {},
      receivedAt: new Date().toISOString(),
    });
    useClaudeTmuxStore.getState().addPendingElicitation("tab-1", {
      eventId: "elicit-cancel",
      mcpServerName: "docs-mcp",
      message: "Provide credentials",
      mode: "form",
      url: null,
      requestedSchema: null,
      payload: {},
      receivedAt: new Date().toISOString(),
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Decline" })[0]!);

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith("tab-1", "Elicitation", "elicit-decline", {
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "decline",
        },
      }, "env-1");
    });

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(replyHookMock).toHaveBeenCalledWith("tab-1", "Elicitation", "elicit-cancel", {
        hookSpecificOutput: {
          hookEventName: "Elicitation",
          action: "cancel",
        },
      }, "env-1");
    });
  });
});
