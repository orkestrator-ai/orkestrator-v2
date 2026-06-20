import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useEffect, useImperativeHandle, useRef as useReactRef } from "react";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} from "@/stores/claudeTmuxStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import { useUIStore } from "@/stores/uiStore";
import { clearPersistedVirtuosoState } from "@/hooks/useVirtuosoScrollState";
import * as realTmuxClient from "@/lib/claude-tmux-client";
import * as realTauri from "@/lib/tauri";
import type {
  ClaudeMessage as ClaudeMessageType,
  ClaudeModel,
} from "@/lib/claude-client";
import * as realInteractiveTerminal from "@/components/claude/ClaudeTmuxInteractiveTerminal";
import * as realFileMentionMenu from "@/components/chat/FileMentionMenu";
import * as realReactVirtuoso from "react-virtuoso";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { mockReadImage } from "../../mocks/clipboard";
import type { Environment, FileCandidate } from "@/types";

const realTmuxClientSnapshot = { ...realTmuxClient };
const realTauriSnapshot = { ...realTauri };
const realInteractiveTerminalSnapshot = { ...realInteractiveTerminal };
const realFileMentionMenuSnapshot = { ...realFileMentionMenu };
const realReactVirtuosoSnapshot = { ...realReactVirtuoso };
const VIRTUOSO_WINDOW_SIZE = 25;
let lastVirtuosoProps: Record<string, any> | null = null;
const virtuosoScrollToIndexMock = mock(() => {});
const virtuosoScrollToMock = mock(() => {});
const virtuosoGetStateMock = mock((callback: (snapshot: any) => void) => {
  callback({ ranges: [], scrollTop: 0 });
});
const getFileTreeMock = mock(async () => []);
const getLocalFileTreeMock = mock(async () => []);
const writeContainerFileMock = mock(async () => {});
const writeLocalFileMock = mock(async () => "/tmp/worktrees/env/.orkestrator/clipboard/test.png");
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
const switchEffortMock = mock(async () => {});
const answerPreToolUseMock = mock(async () => {});
const listPreviousSessionsMock = mock(async () => [
  {
    session_id: "resume-1",
    title: "Previous audit",
    last_activity_unix: Math.floor(Date.now() / 1000),
    message_count: 7,
  },
]);
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
  switchEffort: (tabId: string, effort: string, environmentId?: string) =>
    switchEffortMock(tabId, effort, environmentId),
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

mock.module("@/components/claude/ClaudeTmuxInteractiveTerminal", () => ({
  ClaudeTmuxInteractiveTerminal: interactiveTerminalRenderMock,
}));

mock.module("@/lib/tauri", () => ({
  getFileTree: getFileTreeMock,
  getLocalFileTree: getLocalFileTreeMock,
  writeContainerFile: writeContainerFileMock,
  writeLocalFile: writeLocalFileMock,
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

mock.module("react-virtuoso", () => ({
  ...realReactVirtuosoSnapshot,
  Virtuoso: forwardRef<any, any>((props, ref) => {
    lastVirtuosoProps = props;
    const scrollerRef = useReactRef<HTMLDivElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        scrollToIndex: virtuosoScrollToIndexMock,
        scrollTo: virtuosoScrollToMock,
        getState: virtuosoGetStateMock,
      }),
      [],
    );

    useEffect(() => {
      props.scrollerRef?.(scrollerRef.current);
      props.atBottomStateChange?.(true);
      return () => props.scrollerRef?.(null);
    }, [props.scrollerRef, props.atBottomStateChange]);

    const data = props.data ?? [];
    const offset = Math.max(0, data.length - VIRTUOSO_WINDOW_SIZE);
    const visibleData = data.slice(offset);
    const Footer = props.components?.Footer;
    const EmptyPlaceholder = props.components?.EmptyPlaceholder;

    return (
      <div data-testid="virtuoso-mock" ref={scrollerRef}>
        {data.length === 0 && EmptyPlaceholder ? (
          <EmptyPlaceholder context={props.context} />
        ) : (
          visibleData.map((item: any, localIndex: number) => {
            const index = offset + localIndex;
            return (
              <div key={props.computeItemKey?.(index, item) ?? index}>
                {props.itemContent(index, item)}
              </div>
            );
          })
        )}
        {Footer ? <Footer context={props.context} /> : null}
      </div>
    );
  }),
}));

const { ClaudeTmuxChatTab, parseTmuxSelectionPrompt } = await import(
  "@/components/claude/ClaudeTmuxChatTab"
);

if (typeof globalThis.ImageData === "undefined") {
  (globalThis as Record<string, unknown>).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;

    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
const originalActiveElementDescriptor = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "activeElement",
);
const putImageDataMock = mock(() => {});

function setActiveElement(element: Element) {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => element,
  });
}

function mockRunningTmuxStatus() {
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
}

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
    mock.module("@/components/claude/ClaudeTmuxInteractiveTerminal", () => realInteractiveTerminalSnapshot);
    mock.module("@/components/chat/FileMentionMenu", () => realFileMentionMenuSnapshot);
    mock.module("react-virtuoso", () => realReactVirtuosoSnapshot);
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    delete (document as { activeElement?: Element }).activeElement;
    if (originalActiveElementDescriptor) {
      Object.defineProperty(
        Document.prototype,
        "activeElement",
        originalActiveElementDescriptor,
      );
    }
  });

  beforeEach(() => {
    cleanup();
    getFileTreeMock.mockReset();
    getFileTreeMock.mockResolvedValue([]);
    getLocalFileTreeMock.mockReset();
    getLocalFileTreeMock.mockResolvedValue([]);
    delete (document as { activeElement?: Element }).activeElement;
    if (originalActiveElementDescriptor) {
      Object.defineProperty(
        Document.prototype,
        "activeElement",
        originalActiveElementDescriptor,
      );
    }
    writeContainerFileMock.mockReset();
    writeContainerFileMock.mockImplementation(async () => {});
    writeLocalFileMock.mockReset();
    writeLocalFileMock.mockImplementation(
      async () => "/tmp/worktrees/env/.orkestrator/clipboard/test.png",
    );
    mockReadImage.mockReset();
    mockReadImage.mockImplementation(async () => ({
      rgba: async () => new Uint8Array([255, 0, 0, 255]),
      size: async () => ({ width: 1, height: 1 }),
    }));
    putImageDataMock.mockReset();
    HTMLCanvasElement.prototype.getContext = (() => ({
      putImageData: putImageDataMock,
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = (() =>
      "data:image/png;base64,QUJD") as typeof HTMLCanvasElement.prototype.toDataURL;
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
    lastVirtuosoProps = null;
    virtuosoScrollToIndexMock.mockClear();
    virtuosoScrollToMock.mockClear();
    virtuosoGetStateMock.mockClear();
    virtuosoGetStateMock.mockImplementation((callback: (snapshot: any) => void) => {
      callback({ ranges: [], scrollTop: 0 });
    });
    subscribeMock.mockClear();
    stopSessionMock.mockClear();
    interruptSessionMock.mockClear();
    capturePaneMock.mockClear();
    sendKeysMock.mockClear();
    replyHookMock.mockClear();
    submitMock.mockClear();
    switchModelMock.mockClear();
    switchEffortMock.mockClear();
    answerPreToolUseMock.mockClear();
    listPreviousSessionsMock.mockClear();
    interactiveTerminalRenderMock.mockClear();
    capturePaneMock.mockImplementation(async () => "");
    submitMock.mockImplementation(async () => {});
    switchModelMock.mockImplementation(async () => {});
    switchEffortMock.mockImplementation(async () => {});
    listPreviousSessionsMock.mockImplementation(async () => [
      {
        session_id: "resume-1",
        title: "Previous audit",
        last_activity_unix: Math.floor(Date.now() / 1000),
        message_count: 7,
      },
    ]);
    useClaudeTmuxStore.setState({
      tabs: new Map(),
      attachments: new Map(),
      draftText: new Map(),
      draftMentions: new Map(),
      messageQueue: new Map(),
      effortLevels: new Map(),
    });
    // The tmux tab prefers the live SDK model list shared via the claude
    // store; keep it empty by default so tests exercise the fallback list.
    useClaudeStore.setState({ models: [] });
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
    clearPersistedVirtuosoState("claude-tmux-tab-1");
    clearPersistedVirtuosoState("claude-tmux-env:env-1:tab:tab-1");
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
    useUIStore.setState({ selectedEnvironmentId: "env-1" });
    seedPane("Run the audit");
  });

  test("jumps to the bottom when reactivated after an environment switch", async () => {
    const { rerender } = render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const scroller = await screen.findByTestId("virtuoso-mock");
    act(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
    });

    const callsBeforeSwitch = virtuosoScrollToIndexMock.mock.calls.length;
    act(() => {
      useUIStore.setState({ selectedEnvironmentId: "env-2" });
    });
    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive={false}
      />,
    );
    act(() => {
      useUIStore.setState({ selectedEnvironmentId: "env-1" });
    });
    rerender(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(virtuosoScrollToIndexMock.mock.calls.length).toBeGreaterThan(
        callsBeforeSwitch,
      );
    });
    expect(virtuosoScrollToMock.mock.calls.at(-1)).toEqual([
      { top: 10_000_000, behavior: "auto" },
    ]);
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
        model: "sonnet",
        effort: "high",
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
      expect(useClaudeTmuxStore.getState().getTab("tab-1").busy).toBe(true);
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

  test("attaches pasted clipboard images in the tmux compose bar and submits their paths", async () => {
    mockRunningTmuxStatus();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(writeContainerFileMock).toHaveBeenCalledTimes(1);
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.change(input, { target: { value: "what is this?" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
    expect(submitMock.mock.calls[0]).toEqual([
      "tab-1",
      expect.stringMatching(
        /^what is this\?\n\nAttached images have been saved in the workspace\. Use these image paths as task context:\n- clipboard-.*\.png: \/workspace\/\.orkestrator\/clipboard\/clipboard-.*\.png$/,
      ),
      "env-1",
    ]);
    expect(screen.queryByAltText(/clipboard-/)).toBeNull();
  });

  test("submits a pasted tmux image without text as a single prompt", async () => {
    mockRunningTmuxStatus();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
    expect(submitMock.mock.calls[0]).toEqual([
      "tab-1",
      expect.stringMatching(
        /^Attached images have been saved in the workspace\. Use these image paths as task context:\n- clipboard-.*\.png: \/workspace\/\.orkestrator\/clipboard\/clipboard-.*\.png$/,
      ),
      "env-1",
    ]);
  });

  test("submits pasted local worktree images with escaped paths", async () => {
    mockRunningTmuxStatus();
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
          worktreePath: "/tmp/local repo",
        },
      ],
    });
    writeLocalFileMock.mockImplementationOnce(
      async () => "/tmp/local repo/.orkestrator/clipboard/test image.png",
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", isLocal: true }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(writeLocalFileMock).toHaveBeenCalledWith(
        "/tmp/local repo",
        expect.stringMatching(/^\.orkestrator\/clipboard\/clipboard-.*\.png$/),
        "QUJD",
      );
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledTimes(1);
    });
    expect(submitMock.mock.calls[0]).toEqual([
      "tab-1",
      expect.stringContaining(
        "/tmp/local\\ repo/.orkestrator/clipboard/test\\ image.png",
      ),
      "env-1",
    ]);
  });

  test("keeps pasted tmux attachments and draft text when submission fails", async () => {
    mockRunningTmuxStatus();
    submitMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    const input = await screen.findByPlaceholderText(
      "Ask Claude anything… (@ to mention, / for commands)",
    );
    setActiveElement(input);

    document.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );

    await waitFor(() => {
      expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    });

    fireEvent.change(input, { target: { value: "what is this?" } });
    fireEvent.click(screen.getByTitle("Send (↵)"));

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    expect(screen.getByAltText(/clipboard-/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("what is this?");
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  test("shows a scroll down button when Virtuoso reports the transcript is off-bottom", async () => {
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
      expect(lastVirtuosoProps).toBeTruthy();
    });

    act(() => {
      lastVirtuosoProps?.atBottomStateChange(false);
    });

    const scrollButton = await screen.findByRole("button", {
      name: /scroll to bottom of conversation/i,
    });
    expect(scrollButton).toBeTruthy();

    fireEvent.click(scrollButton);

    await waitFor(() => {
      expect(virtuosoScrollToIndexMock).toHaveBeenCalledWith({
        index: "LAST",
        align: "end",
      });
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

    await waitFor(() => {
      expect(lastVirtuosoProps).toBeTruthy();
    });

    act(() => {
      lastVirtuosoProps?.atBottomStateChange(false);
    });
    await screen.findByRole("button", { name: /scroll to bottom of conversation/i });

    // Switch into interactive terminal mode — the Virtuoso transcript unmounts and the
    // scroll-down affordance must disappear with it.
    fireEvent.click(await screen.findByRole("button", { name: /terminal/i }));

    await waitFor(() => {
      expect(screen.getByTestId("tmux-interactive-terminal")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /scroll to bottom of conversation/i }),
      ).toBeNull();
    });
  });

  test("passes transcript updates through the virtualized message window", async () => {
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

    await waitFor(() => {
      expect(lastVirtuosoProps?.data.map((message: any) => message.content)).toContain(
        "Streaming chunk",
      );
    });
    expect(lastVirtuosoProps?.followOutput(true)).toBe("smooth");
  });

  test("windows large tmux transcripts through Virtuoso instead of rendering every message", async () => {
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
    getTranscriptMock.mockImplementation(async () =>
      Array.from({ length: 100 }, (_, index) => ({
        type: index % 2 === 0 ? "user" : "assistant",
        uuid: `msg-${index}`,
        timestamp: `2026-05-15T12:${String(index).padStart(2, "0")}:00.000Z`,
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Message ${index}`,
        },
      })),
    );

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(lastVirtuosoProps?.data).toHaveLength(100);
    });
    expect(screen.getAllByText(/^Message \d+$/)).toHaveLength(VIRTUOSO_WINDOW_SIZE);
    expect(screen.queryByText("Message 0")).toBeNull();
    expect(screen.getByText("Message 99")).toBeTruthy();
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

  test("serializes tmux @ file references to full environment paths before submit", async () => {
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

    submitMock.mockClear();
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Review /workspace/src/components/Button.tsx",
        "env-1",
      );
    });
  });

  test("does not rewrite non-file @ references in tmux prompts", async () => {
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
        value: "Install @opencode-ai/sdk and contact @example.com",
        selectionStart: "Install @opencode-ai/sdk and contact @example.com".length,
        selectionEnd: "Install @opencode-ai/sdk and contact @example.com".length,
      },
    });

    submitMock.mockClear();
    fireEvent.click(screen.getByTitle("Send (↵)"));

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "Install @opencode-ai/sdk and contact @example.com",
        "env-1",
      );
    });
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
      name: /Sonnet/,
    }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(false);

    fireEvent.pointerDown(modelButton);
    const fableOption = await screen.findByText("Fable");
    await act(async () => {
      fireEvent.click(fableOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchModelMock).toHaveBeenCalledWith(
        "tab-1",
        "claude-fable-5[1m]",
        "env-1",
      );
    });
    expect(screen.getByRole("button", { name: /Fable/ })).toBeTruthy();
  });

  test("persists the launch-only Default model sentinel without switching a running tmux session", async () => {
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

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const defaultOption = (await screen.findByText("Default (recommended)")).closest(
      "[role='menuitem']",
    );

    expect(defaultOption).toBeTruthy();
    expect(
      defaultOption?.getAttribute("aria-disabled") === "true" ||
        defaultOption?.hasAttribute("data-disabled"),
    ).toBe(false);

    await act(async () => {
      fireEvent.click(defaultOption!);
      await Promise.resolve();
    });

    expect(switchModelMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(updateGlobalConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ claudeModel: "default" }),
      );
      expect(useConfigStore.getState().config.global.claudeModel).toBe("default");
    });
    expect(screen.getByRole("button", { name: /Default/ })).toBeTruthy();
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
      name: /Sonnet/,
    }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(false);

    fireEvent.pointerDown(modelButton);
    const haikuOption = await screen.findByText("Haiku");
    await act(async () => {
      fireEvent.click(haikuOption);
    });
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "haiku",
        effort: undefined,
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
          claudeModel: "haiku",
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
    expect(screen.getByRole("button", { name: /Haiku/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "haiku",
        effort: undefined,
        planMode: false,
        resumeSessionId: undefined,
      });
    });
  });

  test("maps a legacy persisted opus model id onto the Default sentinel", async () => {
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
    expect(screen.getByRole("button", { name: /Default/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(
        "tab-1",
        "env-1",
        expect.objectContaining({ model: undefined }),
      );
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
        effort: "high",
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

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const haikuOption = await screen.findByText("Haiku");
    await act(async () => {
      fireEvent.click(haikuOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(updateGlobalConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ claudeModel: "haiku" }),
      );
      expect(useConfigStore.getState().config.global.claudeModel).toBe(
        "haiku",
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

    expect(await screen.findByRole("button", { name: /Haiku/ })).toBeTruthy();
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

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const haikuOption = await screen.findByText("Haiku");
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
      name: /Sonnet/,
    }) as HTMLButtonElement;
    fireEvent.pointerDown(modelButton);
    const fableOption = await screen.findByText("Fable");
    await act(async () => {
      fireEvent.click(fableOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchModelMock).toHaveBeenCalledWith(
        "tab-1",
        "claude-fable-5[1m]",
        "env-1",
      );
      expect(textarea.disabled).toBe(true);
      expect(
        screen.getByRole("button", { name: /Sonnet/ }),
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
      expect(screen.getByRole("button", { name: /Fable/ })).toHaveProperty(
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
      name: /Sonnet/,
    }) as HTMLButtonElement;
    fireEvent.pointerDown(modelButton);
    const fableOption = await screen.findByText("Fable");
    await act(async () => {
      fireEvent.click(fableOption);
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Sonnet/ })).toHaveProperty(
        "disabled",
        false,
      );
    });
    expect(screen.queryByRole("button", { name: /Fable/ })).toBeNull();
  });

  test("passes the selected reasoning effort to the tmux launch", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "High" }));
    const maxOption = await screen.findByText("Max");
    await act(async () => {
      fireEvent.click(maxOption);
    });

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith("tab-1", "env-1", {
        initialPrompt: undefined,
        model: "sonnet",
        effort: "max",
        planMode: false,
        resumeSessionId: undefined,
      });
    });
  });

  test("switches the running session effort through Claude's /effort command", async () => {
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

    const effortButton = screen.getByRole("button", {
      name: "High",
    }) as HTMLButtonElement;
    expect(effortButton.disabled).toBe(false);

    fireEvent.pointerDown(effortButton);
    const lowOption = await screen.findByText("Low");
    await act(async () => {
      fireEvent.click(lowOption);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(switchEffortMock).toHaveBeenCalledWith("tab-1", "low", "env-1");
    });
    expect(screen.getByRole("button", { name: "Low" })).toBeTruthy();
  });

  test("keeps the previous effort and shows an error when effort switching fails", async () => {
    switchEffortMock.mockImplementationOnce(async () => {
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

    fireEvent.pointerDown(screen.getByRole("button", { name: "High" }));
    const lowOption = await screen.findByText("Low");
    await act(async () => {
      fireEvent.click(lowOption);
      await Promise.resolve();
    });

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "High" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Low" })).toBeNull();
  });

  test("hides the effort control for models without effort support", async () => {
    seedPane();

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "High" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Sonnet/ }));
    const haikuOption = await screen.findByText("Haiku");
    await act(async () => {
      fireEvent.click(haikuOption);
    });

    expect(screen.queryByRole("button", { name: "High" })).toBeNull();
  });

  test("resets effort to the default when the new model doesn't support the chosen level", async () => {
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

    fireEvent.pointerDown(screen.getByRole("button", { name: "High" }));
    const xhighOption = await screen.findByText("Extra High");
    await act(async () => {
      fireEvent.click(xhighOption);
    });
    expect(screen.getByRole("button", { name: "Extra High" })).toBeTruthy();

    // Sonnet has no xhigh level, so the preference snaps back to the default.
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default/ }));
    const sonnetOption = await screen.findByText("Sonnet");
    await act(async () => {
      fireEvent.click(sonnetOption);
    });

    expect(screen.getByRole("button", { name: "High" })).toBeTruthy();
  });

  test("prefers the live SDK model list and prepends the Default sentinel when missing", async () => {
    seedPane();
    const sdkModels: ClaudeModel[] = [
      {
        id: "claude-newer-opus",
        name: "Newer Opus",
        description: "from the SDK",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
      { id: "claude-newer-haiku", name: "Newer Haiku", description: "from the SDK" },
    ];
    useClaudeStore.setState({ models: sdkModels });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    // The persisted "claude-sonnet-4-6" preference resolves to "sonnet",
    // which the SDK list doesn't know, so the selection snaps to the
    // prepended Default sentinel.
    fireEvent.pointerDown(screen.getByRole("button", { name: /Default/ }));

    expect(await screen.findByText("Newer Opus")).toBeTruthy();
    expect(screen.getByText("Newer Haiku")).toBeTruthy();
    // Fallback-only entries are replaced by the live list.
    expect(screen.queryByText("Sonnet (1M context)")).toBeNull();
    expect(screen.queryByText("Fable")).toBeNull();
  });

  test("uses the SDK list as-is when it already includes the Default sentinel", async () => {
    seedPane();
    useClaudeStore.setState({
      models: [
        {
          id: "default",
          name: "Default (SDK)",
          description: "from the SDK",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        { id: "claude-newer-haiku", name: "Newer Haiku" },
      ] as ClaudeModel[],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();
    // The SDK's own default entry wins over the fallback sentinel.
    expect(screen.getByRole("button", { name: /Default \(SDK\)/ })).toBeTruthy();
  });

  test("falls back to the first supported level when a model's levels exclude the default", async () => {
    seedPane();
    useClaudeStore.setState({
      models: [
        {
          id: "default",
          name: "Default (recommended)",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "claude-mini",
          name: "Mini",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium"],
        },
      ] as ClaudeModel[],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByRole("button", { name: "Start fresh" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: /Default/ }));
    const miniOption = await screen.findByText("Mini");
    await act(async () => {
      fireEvent.click(miniOption);
    });

    // "high" isn't in Mini's level list, so the stored preference snaps to
    // the first supported level instead of an unsupported default.
    expect(screen.getByRole("button", { name: "Low" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "High" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));

    await waitFor(() => {
      expect(startSessionMock).toHaveBeenCalledWith(
        "tab-1",
        "env-1",
        expect.objectContaining({ model: "claude-mini", effort: "low" }),
      );
    });
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
        model: "sonnet",
        effort: "high",
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

  test("queues a compose draft while busy and drains it after the tmux Stop hook", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    useClaudeTmuxStore.getState().setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    useClaudeTmuxStore.getState().setBusy(stateKey, true);

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

    fireEvent.click(screen.getByTitle("Add to queue"));

    await waitFor(() => {
      expect(useClaudeTmuxStore.getState().messageQueue.get(stateKey)?.map((m) => m.text)).toEqual([
        "continue with this",
      ]);
      expect(textarea.value).toBe("");
    });
    expect(submitMock).not.toHaveBeenCalled();
    expect(screen.getByText("+1 queued")).toBeTruthy();

    await waitFor(() => expect(subscribedHandler).not.toBeNull());

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

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "continue with this",
        "env-1",
      );
      expect(useClaudeTmuxStore.getState().messageQueue.get(stateKey)).toEqual([]);
    });
  });

  test("does not drain queued tmux prompts while a draft exists", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.addToQueue(stateKey, {
      id: "queue-1",
      text: "queued behind draft",
      attachments: [],
    });
    store.setDraftText(stateKey, "draft in progress");

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(
      (screen.getByPlaceholderText(/Ask Claude anything/) as HTMLTextAreaElement).value,
    ).toBe("draft in progress");
    await Promise.resolve();
    expect(submitMock).not.toHaveBeenCalled();

    act(() => {
      useClaudeTmuxStore.getState().setDraftText(stateKey, "");
    });

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "queued behind draft",
        "env-1",
      );
    });
  });

  test("does not drain queued tmux prompts while an attachment is staged", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.addToQueue(stateKey, {
      id: "queue-1",
      text: "queued behind attachment",
      attachments: [],
    });
    store.addAttachment(stateKey, {
      id: "att-staged",
      type: "image",
      path: "/workspace/blocking.png",
      previewUrl: "data:image/png;base64,blocking",
      name: "blocking.png",
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await screen.findByAltText("blocking.png");
    expect(submitMock).not.toHaveBeenCalled();

    act(() => {
      useClaudeTmuxStore.getState().clearAttachments(stateKey);
    });

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        "queued behind attachment",
        "env-1",
      );
    });
  });

  test("reorders and removes queued tmux prompts from the queue dialog", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    store.addToQueue(stateKey, { id: "queue-1", text: "first queued", attachments: [] });
    store.addToQueue(stateKey, { id: "queue-2", text: "second queued", attachments: [] });
    store.addToQueue(stateKey, { id: "queue-3", text: "third queued", attachments: [] });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByText("+3 queued"));
    await screen.findByText("first queued");

    fireEvent.click(screen.getAllByTitle("Move down")[0]!);
    await waitFor(() => {
      expect(
        useClaudeTmuxStore
          .getState()
          .getQueuedMessages(stateKey)
          .map((message) => message.text),
      ).toEqual(["second queued", "first queued", "third queued"]);
    });

    fireEvent.click(screen.getAllByTitle("Remove queued prompt")[1]!);
    await waitFor(() => {
      expect(
        useClaudeTmuxStore
          .getState()
          .getQueuedMessages(stateKey)
          .map((message) => message.text),
      ).toEqual(["second queued", "third queued"]);
    });
    expect(screen.queryByText("first queued")).toBeNull();
  });

  test("clicking a queued tmux prompt restores its text and attachments for editing", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    store.addToQueue(stateKey, {
      id: "queue-image",
      text: "edit queued with image",
      attachments: [
        {
          id: "att-1",
          type: "image",
          path: "/workspace/diagram.png",
          previewUrl: "data:image/png;base64,diagram",
          name: "diagram.png",
        },
      ],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByText("+1 queued"));
    fireEvent.click(await screen.findByText("edit queued with image"));

    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText(/Ask Claude anything/) as HTMLTextAreaElement).value,
      ).toBe("edit queued with image");
      expect(screen.getByAltText("diagram.png")).toBeTruthy();
      expect(useClaudeTmuxStore.getState().getQueuedMessages(stateKey)).toEqual([]);
    });
  });

  test("drains queued tmux prompts with saved image attachment paths", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.addToQueue(stateKey, {
      id: "queue-image",
      text: "use this screenshot",
      attachments: [
        {
          id: "att-1",
          type: "image",
          path: "/workspace/diagram.png",
          previewUrl: "data:image/png;base64,diagram",
          name: "diagram.png",
        },
      ],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    await waitFor(() => {
      expect(submitMock).toHaveBeenCalledWith(
        "tab-1",
        expect.stringContaining("/workspace/diagram.png"),
        "env-1",
      );
      expect(useClaudeTmuxStore.getState().getQueuedMessages(stateKey)).toEqual([]);
    });
  });

  test("removes a failed queued tmux prompt and reports the send error", async () => {
    submitMock.mockImplementationOnce(async () => {
      throw new Error("tmux unavailable");
    });
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.addToQueue(stateKey, {
      id: "queue-fail",
      text: "will fail",
      attachments: [],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    expect(await screen.findByText("Error: tmux unavailable")).toBeTruthy();
    expect(useClaudeTmuxStore.getState().getQueuedMessages(stateKey)).toEqual([]);
    expect(useClaudeTmuxStore.getState().getTab(stateKey).busy).toBe(false);
  });

  test("interrupt promotes the next queued tmux prompt to the draft", async () => {
    const stateKey = createClaudeTmuxStateKey("env-1", "tab-1");
    const store = useClaudeTmuxStore.getState();
    store.setRunning(stateKey, true, {
      environmentId: "env-1",
      sessionId: "session-1",
    });
    store.setBusy(stateKey, true);
    store.addToQueue(stateKey, {
      id: "queue-first",
      text: "edit after interrupt",
      attachments: [],
    });
    store.addToQueue(stateKey, {
      id: "queue-second",
      text: "stay queued",
      attachments: [],
    });

    render(
      <ClaudeTmuxChatTab
        tabId="tab-1"
        data={{ environmentId: "env-1", containerId: "container-1" }}
        isActive
      />,
    );

    fireEvent.click(screen.getByTitle("Interrupt current response"));

    await waitFor(() => {
      expect(
        (screen.getByPlaceholderText(/Ask Claude anything/) as HTMLTextAreaElement).value,
      ).toBe("edit after interrupt");
      expect(useClaudeTmuxStore.getState().getQueuedMessages(stateKey).map((m) => m.text)).toEqual([
        "stay queued",
      ]);
      expect(useClaudeTmuxStore.getState().getTab(stateKey).busy).toBe(false);
    });
    expect(interruptSessionMock).toHaveBeenCalledWith("tab-1", "env-1");
    expect(submitMock).not.toHaveBeenCalled();
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

    const renderedMessages = lastVirtuosoProps?.data ?? [];
    expect(renderedMessages).toHaveLength(2);
    expect(renderedMessages[1]!.id).toBe("a1");
    expect(renderedMessages[0]!.id).toBe("u1");
    expect(renderedMessages[1]!.parts.map((part: ClaudeMessageType["parts"][number]) => part.type)).toEqual([
      "tool-invocation",
      "tool-invocation",
      "text",
    ]);
    expect(screen.getAllByText("Read").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Grep").length).toBeGreaterThan(0);
    expect(screen.getByText("done")).toBeTruthy();
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

    const renderedMessages = lastVirtuosoProps?.data ?? [];
    expect(renderedMessages).toHaveLength(1);
    expect(renderedMessages[0]!.parts.map((part: ClaudeMessageType["parts"][number]) => part.toolName)).toEqual([
      "TaskList",
    ]);
    expect(renderedMessages[0]!.parts.map((part: ClaudeMessageType["parts"][number]) => part.toolArgs)).toEqual([
      {
        todos: [
          { content: "Inspect renderer", status: "completed" },
          { content: "Add UI tests", status: "pending" },
        ],
      },
    ]);
    expect(screen.getByText("Task List")).toBeTruthy();
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
