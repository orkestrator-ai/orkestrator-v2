import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import * as realTauri from "@/lib/tauri";
import type { ClaudeMessage as ClaudeMessageType } from "@/lib/claude-client";
import * as realClaudeMessage from "@/components/claude/ClaudeMessage";
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import type { FileCandidate } from "@/types";

const realTmuxClientSnapshot = { ...realTmuxClient };
const realTauriSnapshot = { ...realTauri };
const realClaudeMessageSnapshot = { ...realClaudeMessage };
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const getFileTreeMock = mock(async () => []);
const getLocalFileTreeMock = mock(async () => []);

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
const capturePaneMock = mock(async () => "");
const sendKeysMock = mock(async () => {});
const replyHookMock = mock(async () => {});
const submitMock = mock(async () => {});
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
    >
      {message.content}
    </div>
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
  capturePane: capturePaneMock,
  sendKeys: sendKeysMock,
  replyHook: replyHookMock,
  submit: submitMock,
  answerPreToolUse: answerPreToolUseMock,
  listPreviousSessions: listPreviousSessionsMock,
}));

mock.module("@/components/claude/ClaudeMessage", () => ({
  ...realClaudeMessageSnapshot,
  ClaudeMessage: claudeMessageRenderMock,
}));

mock.module("@/lib/tauri", () => ({
  getFileTree: getFileTreeMock,
  getLocalFileTree: getLocalFileTreeMock,
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

describe("ClaudeTmuxChatTab", () => {
  afterAll(() => {
    mock.module("@/lib/claude-tmux-client", () => realTmuxClientSnapshot);
    mock.module("@/lib/tauri", () => realTauriSnapshot);
    mock.module("@/components/claude/ClaudeMessage", () => realClaudeMessageSnapshot);
    mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
  });

  beforeEach(() => {
    cleanup();
    getFileTreeMock.mockReset();
    getFileTreeMock.mockResolvedValue([]);
    getLocalFileTreeMock.mockReset();
    getLocalFileTreeMock.mockResolvedValue([]);
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
    capturePaneMock.mockClear();
    sendKeysMock.mockClear();
    replyHookMock.mockClear();
    submitMock.mockClear();
    answerPreToolUseMock.mockClear();
    listPreviousSessionsMock.mockClear();
    claudeMessageRenderMock.mockClear();
    capturePaneMock.mockImplementation(async () => "");
    submitMock.mockImplementation(async () => {});
    listPreviousSessionsMock.mockImplementation(async () => [
      {
        session_id: "resume-1",
        title: "Previous audit",
        last_activity_unix: Math.floor(Date.now() / 1000),
        message_count: 7,
      },
    ]);
    useClaudeTmuxStore.setState({ tabs: new Map() });
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

  test("starts once with tabId+envId and clears the tab initialPrompt after launch succeeds", async () => {
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

    await waitFor(() => {
      const tab = usePaneLayoutStore.getState().getAllTabs("env-1")[0];
      expect(tab?.initialPrompt).toBeUndefined();
    });
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
    expect(startSessionMock).not.toHaveBeenCalled();
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
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "/model claude-opus-4-7",
      );
    });
    expect(screen.getByRole("button", { name: /Opus 4\.7/ })).toBeTruthy();
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

  test("locks compose and model controls while a model switch is in flight", async () => {
    let resolveSubmit!: () => void;
    submitMock.mockImplementationOnce(
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
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "/model claude-opus-4-7",
      );
      expect(textarea.disabled).toBe(true);
      expect(
        screen.getByRole("button", { name: /Sonnet 4\.6/ }),
      ).toHaveProperty("disabled", true);
    });

    fireEvent.click(screen.getByTitle("Send (↵)"));
    expect(submitMock).toHaveBeenCalledTimes(1);

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

  test("stops the running tmux session from the header", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(stopSessionMock).toHaveBeenCalledWith("tab-1");
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

  test("shows controls for Claude Code selection prompts and answers through tmux keys", async () => {
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

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["Down", "Enter"]);
    });
  });

  test("answers confirmation prompts by sending the selected number", async () => {
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

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["2", "Enter"]);
    });
  });

  test("moves confirmation prompt selection in the overlay before confirming", async () => {
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

    fireEvent.click(screen.getByTitle("Move selection down"));
    expect(sendKeysMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("Select highlighted option"));

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["2", "Enter"]);
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

  test("clamps the number-mode local highlight at the option list bounds", async () => {
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

    // Up at index 0 is a no-op.
    fireEvent.click(screen.getByTitle("Move selection up"));
    fireEvent.click(screen.getByTitle("Select highlighted option"));
    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenLastCalledWith("tab-1", ["1", "Enter"]);
    });

    sendKeysMock.mockClear();

    // Down twice should stop at the last option (index 1).
    fireEvent.click(screen.getByTitle("Move selection down"));
    fireEvent.click(screen.getByTitle("Move selection down"));
    fireEvent.click(screen.getByTitle("Select highlighted option"));
    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenLastCalledWith("tab-1", ["2", "Enter"]);
    });
  });

  test("splits multi-digit option numbers into individual digit keys", async () => {
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

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["1", "0", "Enter"]);
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

    // Clicking the already-selected option should send only Enter (delta = 0).
    fireEvent.click(
      screen.getByRole("button", { name: /Always kill before launch/ }),
    );

    await waitFor(() => {
      expect(sendKeysMock).toHaveBeenCalledWith("tab-1", ["Enter"]);
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
      });
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
      });
    });
  });
});
