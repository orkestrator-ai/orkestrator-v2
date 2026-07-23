import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realSessionStore from "@/stores/sessionStore";
import * as realClipboardImagePaste from "@/hooks/useClipboardImagePaste";
import { mockReadText, mockWriteText } from "../../../../../tests/mocks/clipboard";

// Mock modules that require a real backend runtime or have side effects.
// IMPORTANT: Do NOT mock @/stores (barrel) or @/lib/backend here — doing so
// pollutes the Bun module cache and breaks other test files that share
// those modules.  Instead we use the real stores with controlled state and
// let @/lib/backend fall through to the global @/lib/native/backend mock
// registered in tests/setup.ts.

// @/lib/native/clipboard is centrally mocked in tests/setup.ts.

const resizeMock = mock(async () => {});
const connectMock = mock(async () => {});
const writeMock = mock(async () => {});
let terminalOnData: ((data: Uint8Array) => void) | undefined;
let terminalOscHandler: ((data: string) => boolean) | undefined;
let terminalInputDisposables: Array<{ dispose: ReturnType<typeof mock> }> = [];
let terminalKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
type MockUseTerminalOptions = {
  onData?: (data: Uint8Array) => void;
  user?: string;
  existingSessionId?: string | null;
  replayOutputBuffer?: boolean;
  attachExistingOnly?: boolean;
  trackEnvironmentActivity?: boolean;
};
let lastUseTerminalOptions: MockUseTerminalOptions | undefined;
let useTerminalOptionsHistory: MockUseTerminalOptions[] = [];
let clipboardImagePasteOptions: { onImageSaved: (filePath: string) => Promise<void> } | undefined;

mock.module("@/hooks/useTerminal", () => ({
  useTerminal: (options: MockUseTerminalOptions) => {
    lastUseTerminalOptions = options;
    useTerminalOptionsHistory.push(options);
    terminalOnData = options.onData;
    return {
      sessionId: "session-1",
      isConnected: true,
      isConnecting: false,
      error: null,
      connect: connectMock,
      disconnect: mock(async () => {}),
      resize: resizeMock,
      write: writeMock,
    };
  },
}));

mock.module("@/hooks/useAgentState", () => ({
  useAgentState: () => {},
}));

const realClipboardImagePasteSnapshot = { ...realClipboardImagePaste };
mock.module("@/hooks/useClipboardImagePaste", () => ({
  useClipboardImagePaste: (options: { onImageSaved: (filePath: string) => Promise<void> }) => {
    clipboardImagePasteOptions = options;
  },
}));

// @/lib/terminal-paste is NOT mocked — let the real module load.
// Its clipboard dependency is centrally mocked in tests/setup.ts.

// --- Stores that need custom mock behavior (unique paths, no conflicts) ---

const persistentSessionStore = {
  createSession: mock(async () => ({ id: "persistent-1" })),
  updateSessionActivity: mock(async () => {}),
  getSessionsByEnvironment: (_envId: string): Record<string, unknown>[] => [],
  updateSessionStatus: mock(async () => {}),
  isLoadingEnvironment: () => false,
  loadSessionsForEnvironment: mock(async () => {}),
  // Functions used by useEnvironments.ts (must be present to avoid undefined errors)
  disconnectEnvironmentSessions: mock(async () => {}),
  deleteSessionsByEnvironment: mock(async () => {}),
  deleteSession: mock(async () => {}),
  saveSessionBuffer: mock(async () => {}),
  loadSessionBuffer: mock(async (): Promise<string | null> => null),
  syncSessionsWithContainer: mock(async () => {}),
  renameSession: mock(async () => {}),
  reorderSessions: mock(async () => {}),
  clearAllSessions: mock(() => {}),
  setError: mock(() => {}),
  addSession: mock(() => {}),
  updateSession: mock(() => {}),
  removeSession: mock(() => {}),
  getSession: mock(() => undefined),
  sessions: new Map(),
  loadingEnvironments: new Set(),
  error: null,
};

const realSessionStoreSnapshot = { ...realSessionStore };
mock.module("@/stores/sessionStore", () => ({
  useSessionStore: () => persistentSessionStore,
}));

afterAll(() => {
  mock.module("@/stores/sessionStore", () => realSessionStoreSnapshot);
  mock.module("@/hooks/useClipboardImagePaste", () => realClipboardImagePasteSnapshot);
});

let storedContainerElement: HTMLDivElement;

const portalStoreActions = {
  markTerminalOpened: mock(() => {}),
  setTerminalContainer: mock(() => {}),
  setTerminalPane: mock(() => {}),
  recreateTerminal: mock(() => null),
  clearTerminalsForEnvironment: mock(() => {}),
  disposeTerminal: mock(() => {}),
};

const useTerminalPortalStoreMock = (<T,>(selector?: (state: {
    terminals: Map<string, { containerElement: HTMLDivElement | null; isOpened: boolean }>;
  }) => T) => {
    if (!selector) {
      return portalStoreActions;
    }

    return selector({
      terminals: new Map([
        ["env-1::tab-1", { containerElement: storedContainerElement, isOpened: true }],
      ]),
    });
  }) as any;

useTerminalPortalStoreMock.getState = () => ({
  ...portalStoreActions,
  terminals: new Map(),
});

mock.module("@/stores/terminalPortalStore", () => ({
  createTerminalKey: (environmentId: string, tabId: string) => `${environmentId}::${tabId}`,
  useTerminalPortalStore: useTerminalPortalStoreMock,
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSeparator: () => null,
}));

mock.module("@/components/terminal/ComposeBar", () => ({
  ComposeBar: ({
    showAddressAll,
    onAddressAll,
  }: {
    showAddressAll?: boolean;
    onAddressAll?: () => void;
  }) =>
    showAddressAll ? (
      <button type="button" onClick={onAddressAll}>
        Address all
      </button>
    ) : null,
}));

// --- Real stores: import directly and control via setState in beforeEach ---
import { createSessionKey, useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { ROOT_TERMINAL_USER } from "@/constants/terminal";

const { PersistentTerminal } = await import("./PersistentTerminal");

type MockTerminal = {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  refresh: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  hasSelection: ReturnType<typeof mock>;
  getSelection: ReturnType<typeof mock>;
  selectAll: ReturnType<typeof mock>;
  onSelectionChange: ReturnType<typeof mock>;
  onData: ReturnType<typeof mock>;
  attachCustomKeyEventHandler: ReturnType<typeof mock>;
  clear: ReturnType<typeof mock>;
  write: ReturnType<typeof mock>;
  scrollToBottom: ReturnType<typeof mock>;
  parser: {
    registerOscHandler: ReturnType<typeof mock>;
  };
};

function createMockTerminal(): MockTerminal {
  return {
    cols: 80,
    rows: 24,
    options: {
      fontSize: 14,
      theme: {},
      scrollback: 5000,
      fontFamily: "Fira Code",
    },
    refresh: mock(() => {}),
    focus: mock(() => {}),
    hasSelection: mock(() => false),
    getSelection: mock(() => ""),
    selectAll: mock(() => {}),
    onSelectionChange: mock(() => ({ dispose: mock(() => {}) })),
    onData: mock(() => {
      const disposable = { dispose: mock(() => {}) };
      terminalInputDisposables.push(disposable);
      return disposable;
    }),
    attachCustomKeyEventHandler: mock((handler: (event: KeyboardEvent) => boolean) => {
      terminalKeyHandler = handler;
    }),
    clear: mock(() => {}),
    write: mock(() => {}),
    scrollToBottom: mock(() => {}),
    parser: {
      registerOscHandler: mock((_: number, handler: (data: string) => boolean) => {
        terminalOscHandler = handler;
        return { dispose: mock(() => {}) };
      }),
    },
  };
}

/**
 * Creates mock terminal data. Uses structural typing — the mock satisfies the
 * PersistentTerminalData interface shape without importing the real xterm types.
 */
function createTerminalData(options?: {
  containerId?: string | null;
  environmentId?: string;
  serializedBuffer?: string;
}) {
  storedContainerElement = document.createElement("div");
  const xtermNode = document.createElement("div");
  xtermNode.className = "xterm";
  storedContainerElement.appendChild(xtermNode);

  return {
    tabId: "tab-1",
    containerId: options?.containerId ?? "container-1",
    environmentId: options?.environmentId ?? "env-1",
    terminal: createMockTerminal(),
    fitAddon: { fit: mock(() => {}) },
    serializeAddon: { serialize: mock(() => options?.serializedBuffer ?? "") },
    webLinksAddon: {},
    portalElement: document.createElement("div"),
    containerElement: storedContainerElement,
    currentPaneId: "pane-1",
    isOpened: true,
  } as unknown as Parameters<typeof PersistentTerminal>[0]["terminalData"];
}

describe("PersistentTerminal", () => {
  beforeEach(() => {
    cleanup();
    resizeMock.mockClear();
    connectMock.mockClear();
    writeMock.mockClear();
    terminalOnData = undefined;
    terminalOscHandler = undefined;
    terminalInputDisposables = [];
    terminalKeyHandler = undefined;
    lastUseTerminalOptions = undefined;
    useTerminalOptionsHistory = [];
    clipboardImagePasteOptions = undefined;
    mockReadText.mockReset();
    mockReadText.mockImplementation(() => Promise.resolve(""));
    mockWriteText.mockClear();
    portalStoreActions.markTerminalOpened.mockClear();
    portalStoreActions.setTerminalContainer.mockClear();
    portalStoreActions.setTerminalPane.mockClear();
    portalStoreActions.recreateTerminal.mockClear();
    persistentSessionStore.createSession.mockClear();
    persistentSessionStore.updateSessionActivity.mockClear();
    persistentSessionStore.updateSessionStatus.mockClear();
    persistentSessionStore.loadSessionsForEnvironment.mockClear();
    persistentSessionStore.saveSessionBuffer.mockClear();
    persistentSessionStore.loadSessionBuffer.mockImplementation(async (): Promise<string | null> => null);
    persistentSessionStore.getSessionsByEnvironment = () => [];

    // Reset real stores to controlled state
    useTerminalSessionStore.setState({
      sessions: new Map(),
      composeDraftText: new Map(),
      composeDraftImages: new Map(),
    });

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          defaultAgent: "claude",
          opencodeModel: "",
          codexModel: "",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          claudeNativeBackend: "sdk",
          codexMode: "native",
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
        },
        repositories: {},
      },
    });

    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "test-env",
          branch: "main",
          containerId: "container-1",
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "containerized",
        },
      ],
      isLoading: false,
      error: null,
      workspaceReadyEnvironments: new Set<string>(),
      deletingEnvironments: new Set<string>(),
      pendingSetupCommands: new Map<string, string[]>(),
      setupCommandsResolved: new Set<string>(),
      setupScriptsRunning: new Set<string>(),
    });

    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-1", {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [{ id: "tab-1", type: "claude" }],
            activeTabId: "tab-1",
          },
          activePaneId: "stale-pane",
          containerId: "container-1",
        }],
        ["env-2", {
          root: {
            kind: "leaf",
            id: "pane-2",
            tabs: [{ id: "tab-2", type: "plain" }],
            activeTabId: "tab-2",
          },
          activePaneId: "pane-2",
          containerId: "container-2",
        }],
      ]),
      activeEnvironmentId: "env-2",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not force a redraw on initial mount when already visible", async () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      const resizeCalls = resizeMock.mock.calls as unknown as Array<[number, number]>;
      expect(resizeCalls.some(([cols, rows]) => cols === 80 && rows === 25)).toBe(false);
    });
  });

  it("forces a redraw when the environment becomes visible again", async () => {
    const terminalData = createTerminalData();
    const view = render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={false}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(resizeMock).toHaveBeenCalled();
    });

    resizeMock.mockClear();

    view.rerender(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(resizeMock).toHaveBeenCalledWith(80, 25);
      expect(resizeMock).toHaveBeenCalledWith(80, 24);
    });
  });

  it("clicking the terminal updates the active pane for its own environment", async () => {
    const { container } = render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    fireEvent.click(container.querySelector("div[style]") as HTMLElement);

    expect(usePaneLayoutStore.getState().environments.get("env-1")?.activePaneId).toBe("pane-1");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-2");
  });

  it("keeps only one input handler attached to a persistent xterm instance", async () => {
    const terminalData = createTerminalData();

    const view = render(
      <>
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType="claude"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible={true}
          isActive={true}
          isFocused={true}
          isFirstTab={false}
          paneId="pane-1"
        />
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType="claude"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible={true}
          isActive={true}
          isFocused={true}
          isFirstTab={false}
          paneId="pane-1"
        />
      </>
    );

    await waitFor(() => {
      expect(terminalInputDisposables.length).toBeGreaterThanOrEqual(2);
    });

    const activeDisposable = terminalInputDisposables.at(-1);
    expect(activeDisposable).toBeDefined();
    for (const staleDisposable of terminalInputDisposables.slice(0, -1)) {
      expect(staleDisposable.dispose).toHaveBeenCalledTimes(1);
    }
    expect(activeDisposable!.dispose).not.toHaveBeenCalled();

    view.unmount();

    expect(activeDisposable!.dispose).toHaveBeenCalledTimes(1);
  });

  it("passes the root terminal user to the terminal hook for root tabs", async () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="root"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(lastUseTerminalOptions?.user).toBe(ROOT_TERMINAL_USER);
    });
  });

  it.each([
    ["claude", true],
    ["opencode", true],
    ["codex", true],
    ["plain", false],
    ["root", false],
  ] as const)("sets environment activity tracking for %s terminal tabs", async (tabType, expected) => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType={tabType}
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(lastUseTerminalOptions?.trackEnvironmentActivity).toBe(expected);
    });
  });

  it("replays backend setup output even when a setup tab has a serialized xterm buffer", async () => {
    const setupSessionKey = createSessionKey(null, "tab-1", "env-1");
    useTerminalSessionStore.getState().setSession(setupSessionKey, {
      sessionId: "env-1:setup",
      serializedBuffer: "\u001b[?25h",
    });
    useEnvironmentStore.setState((state) => ({
      environments: state.environments.map((environment) =>
        environment.id === "env-1"
          ? {
              ...environment,
              containerId: null,
              environmentType: "local",
              worktreePath: "/tmp/worktree",
            }
          : environment,
      ),
    }));

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId={null}
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        isSetupTab
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(
        useTerminalOptionsHistory.some(
          (options) =>
            options.existingSessionId === "env-1:setup" &&
            options.attachExistingOnly === true &&
            options.replayOutputBuffer === true,
        ),
      ).toBe(true);
    });
  });

  it("handles terminal copy, select-all, and paste shortcuts", async () => {
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;
    terminal.hasSelection.mockImplementation(() => true);
    terminal.getSelection.mockImplementation(() => "selected text");
    mockReadText.mockImplementation(() => Promise.resolve("pasted text"));

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => expect(terminalKeyHandler).toBeDefined());

    expect(terminalKeyHandler!(
      new KeyboardEvent("keydown", { key: "c", metaKey: true })
    )).toBe(false);
    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("selected text");
    });

    expect(terminalKeyHandler!(
      new KeyboardEvent("keydown", { key: "a", metaKey: true })
    )).toBe(false);
    expect(terminal.selectAll).toHaveBeenCalled();

    const pasteEvent = new KeyboardEvent("keydown", { key: "v", metaKey: true });
    const preventDefault = mock(() => {});
    Object.defineProperty(pasteEvent, "preventDefault", { value: preventDefault });
    expect(terminalKeyHandler!(pasteEvent)).toBe(false);

    await waitFor(() => {
      expect(preventDefault).toHaveBeenCalled();
      expect(writeMock).toHaveBeenCalledWith("pasted text");
    });
  });

  it("writes escaped local image paths from the image paste hook", async () => {
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "local-env",
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
          worktreePath: "/tmp/local-env",
        },
      ],
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData({ containerId: null })}
        tabId="tab-1"
        tabType="plain"
        containerId={null}
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => expect(clipboardImagePasteOptions).toBeDefined());
    await act(async () => {
      await clipboardImagePasteOptions!.onImageSaved("/tmp/local env/image one.png");
    });

    expect(writeMock).toHaveBeenCalledWith("/tmp/local\\ env/image\\ one.png ");
  });

  it("restores the serialized buffer when a terminal moves panes", async () => {
    const terminalData = createTerminalData({ serializedBuffer: "pane-buffer" });
    const terminal = terminalData.terminal as unknown as MockTerminal;
    const view = render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    view.rerender(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-2"
      />
    );

    await waitFor(() => {
      expect(terminal.clear).toHaveBeenCalled();
      expect(terminal.write).toHaveBeenCalledWith("pane-buffer");
      expect(terminal.scrollToBottom).toHaveBeenCalled();
    });
  });

  it("recreates the terminal when the persisted container has lost xterm DOM", async () => {
    const terminalData = createTerminalData();
    storedContainerElement.textContent = "";

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(portalStoreActions.recreateTerminal).toHaveBeenCalledWith("env-1", "tab-1");
    });
  });

  it("launches Codex terminal mode with one-shot model, effort, and prompt", async () => {
    usePaneLayoutStore.setState((state) => {
      const environments = new Map(state.environments);
      const environment = environments.get("env-1")!;
      if (environment.root.kind !== "leaf") throw new Error("expected leaf");
      environments.set("env-1", {
        ...environment,
        root: {
          ...environment.root,
          tabs: environment.root.tabs.map((tab) => ({
            ...tab,
            initialAgentModel: "gpt-review",
            initialReasoningEffort: "high",
          })),
        },
      });
      return { environments };
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="codex"
        containerId="container-1"
        environmentId="env-1"
        initialPrompt={"Fix the failing tests"}
        initialAgentModel="gpt-review"
        initialReasoningEffort="high"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith(
        'codex --model "gpt-review" --config "model_reasoning_effort=\\"high\\"" "Fix the failing tests"\n',
      );
    });
    expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]).toMatchObject({
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
    });
  });

  it("creates persistent sessions for local terminals with an empty container id", async () => {
    useEnvironmentStore.setState({
      environments: [
        {
          id: "env-1",
          projectId: "project-1",
          name: "local-env",
          branch: "main",
          containerId: null,
          status: "running",
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          createdAt: "2024-01-01T00:00:00.000Z",
          networkAccessMode: "restricted",
          order: 0,
          environmentType: "local",
          worktreePath: "/tmp/local-env",
        },
      ],
    });

    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-1", {
          root: {
            kind: "leaf",
            id: "pane-1",
            tabs: [{ id: "tab-1", type: "claude" }],
            activeTabId: "tab-1",
          },
          activePaneId: "pane-1",
          containerId: null,
        }],
      ]),
      activeEnvironmentId: "env-1",
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData({ containerId: null })}
        tabId="tab-1"
        tabType="claude"
        containerId={null}
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(persistentSessionStore.createSession).toHaveBeenCalledWith(
        "env-1",
        "",
        "tab-1",
        "claude",
      );
    });
  });

  it("marks a reused container as ready when setup reports it is already set up", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {}
    );

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        onReady={onReady}
      />
    );

    await act(async () => {
      terminalOnData?.(new TextEncoder().encode("Workspace already set up.\n"));
    });

    await waitFor(() => {
      expect(onReady).toHaveBeenCalled();
    });

    expect(onReady).toHaveBeenCalledWith({
      persistSetupComplete: true,
      workspaceReady: true,
    });
  });

  it("does not persist completion when container setup fails", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {}
    );

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        onReady={onReady}
      />
    );

    await act(async () => {
      terminalOnData?.(new TextEncoder().encode("=== Workspace Setup Failed ===\n=== Workspace Ready ===\n"));
    });

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: false,
        workspaceReady: true,
      });
    });
  });

  it("marks workspace ready when a reconnected first tab buffer contains setup completion", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {}
    );
    useTerminalSessionStore.setState({
      sessions: new Map([
        [
          "container-1:tab-1",
          {
            sessionId: "existing-session-1",
            hasLaunchedCommand: false,
            serializedBuffer: "Container setup completed successfully!\n=== Workspace Ready ===\n",
          },
        ],
      ]),
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        onReady={onReady}
      />
    );

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: true,
        workspaceReady: true,
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("keeps setup detection active when reconnecting an unfinished first tab", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {}
    );
    useTerminalSessionStore.setState({
      sessions: new Map([
        [
          "container-1:tab-1",
          {
            sessionId: "existing-session-1",
            hasLaunchedCommand: false,
            serializedBuffer: "Installing dependencies...\n",
          },
        ],
      ]),
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        onReady={onReady}
      />
    );

    await act(async () => {
      terminalOnData?.(new TextEncoder().encode("=== Workspace Ready ===\n"));
    });

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: true,
        workspaceReady: true,
      });
    });
  });

  it("stores a replacement PTY session id over a stale existing id", async () => {
    useTerminalSessionStore.setState({
      sessions: new Map([
        [
          "container-1:tab-1",
          {
            sessionId: "stale-session",
            hasLaunchedCommand: false,
          },
        ],
      ]),
      composeDraftText: new Map(),
      composeDraftImages: new Map(),
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(useTerminalSessionStore.getState().sessions.get("container-1:tab-1")?.sessionId).toBe("session-1");
    });
  });

  it("only signals setup completion when the OSC success marker arrives", async () => {
    const onSetupComplete = mock((_payload: { persistSetupComplete: boolean }) => {});

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        isSetupTab={true}
        onSetupComplete={onSetupComplete}
      />
    );

    await act(async () => {
      expect(terminalOscHandler?.("unexpected")).toBe(true);
    });
    expect(onSetupComplete).not.toHaveBeenCalled();

    await act(async () => {
      expect(terminalOscHandler?.("setup_done")).toBe(true);
    });
    expect(onSetupComplete).toHaveBeenCalledWith({ persistSetupComplete: true });
  });

  it("signals completion without persistence when the OSC failure marker arrives", async () => {
    const onSetupComplete = mock((_payload: { persistSetupComplete: boolean }) => {});

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        isSetupTab={true}
        onSetupComplete={onSetupComplete}
      />
    );

    await act(async () => {
      expect(terminalOscHandler?.("setup_failed")).toBe(true);
    });
    expect(onSetupComplete).toHaveBeenCalledWith({ persistSetupComplete: false });
  });

  it("treats the manual setup-complete button as a runtime-only override", async () => {
    const onSetupComplete = mock((_payload: { persistSetupComplete: boolean }) => {});
    const view = render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        isSetupTab={true}
        onSetupComplete={onSetupComplete}
      />
    );

    await act(async () => {
      fireEvent.click(view.getByText("Mark setup complete"));
    });

    expect(onSetupComplete).toHaveBeenCalledWith({ persistSetupComplete: false });
  });

  it("emits success and failure OSC markers for setup completion", async () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        initialCommands={["false", "echo ok"]}
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
        isSetupTab={true}
      />
    );

    let setupWrite: string | undefined;
    await waitFor(() => {
      const writes = (writeMock as any).mock.calls.map((call: unknown[]) => call[0]);
      setupWrite = writes.find((entry: unknown) =>
        typeof entry === "string" && entry.includes("(false && echo ok) && printf")
      );
      expect(setupWrite).toBeDefined();
    });

    expect(setupWrite).toBeDefined();
    expect(setupWrite).toContain("setup_done");
    expect(setupWrite).toContain("|| printf");
    expect(setupWrite).toContain("setup_failed");
  });

  it("launches first container setup commands without waiting for workspace-ready output", async () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        initialCommands={["/usr/local/bin/workspace-setup.sh"]}
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        isSetupTab={true}
      />
    );

    await waitFor(() => {
      const writes = (writeMock as any).mock.calls.map((call: unknown[]) => call[0]);
      expect(writes.some((entry: unknown) =>
        typeof entry === "string" &&
        entry.includes("/usr/local/bin/workspace-setup.sh") &&
        entry.includes("setup_done")
      )).toBe(true);
    });
  });

  it("persists serialized buffers for persistent sessions on cleanup", async () => {
    const view = render(
      <PersistentTerminal
        terminalData={createTerminalData({ serializedBuffer: "persisted-buffer" })}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(persistentSessionStore.createSession).toHaveBeenCalled();
    });

    view.unmount();

    await waitFor(() => {
      expect(persistentSessionStore.saveSessionBuffer).toHaveBeenCalledWith(
        "persistent-1",
        "persisted-buffer",
      );
    });
  });

  it("loads persistent buffer when restoring an existing session", async () => {
    persistentSessionStore.loadSessionBuffer.mockImplementation(async () => "restored-buffer");
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "existing-persistent-1",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "claude",
        status: "disconnected",
        hasLaunchedCommand: true,
        lastActivityAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      },
    ];
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(persistentSessionStore.loadSessionBuffer).toHaveBeenCalledWith(
        "existing-persistent-1",
      );
    });

    await waitFor(() => {
      const sessions = useTerminalSessionStore.getState().sessions;
      const session = sessions.get("container-1:tab-1");
      expect(session?.serializedBuffer).toBe("restored-buffer");
    });
  });

  it("marks workspace ready when an asynchronously restored first-tab buffer contains setup completion", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {}
    );
    persistentSessionStore.loadSessionBuffer.mockImplementation(async () =>
      "Container setup completed successfully!\n=== Workspace Ready ===\n"
    );
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "existing-setup-session-1",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "disconnected",
        hasLaunchedCommand: false,
        lastActivityAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        onReady={onReady}
      />
    );

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: true,
        workspaceReady: true,
      });
    });
  });

  it("does not persist completion when an asynchronously restored first-tab buffer contains setup failure", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {}
    );
    persistentSessionStore.loadSessionBuffer.mockImplementation(async () =>
      "=== Workspace Setup Failed ===\n=== Workspace Ready ===\n"
    );
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "existing-failed-setup-session-1",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "disconnected",
        hasLaunchedCommand: false,
        lastActivityAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
        onReady={onReady}
      />
    );

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: false,
        workspaceReady: true,
      });
    });
  });

  it("updates session status to connected when reconnecting a disconnected session", async () => {
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "disconnected-session-1",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "claude",
        status: "disconnected",
        hasLaunchedCommand: false,
        lastActivityAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(persistentSessionStore.updateSessionStatus).toHaveBeenCalledWith(
        "disconnected-session-1",
        "connected",
      );
    });
  });

  it("does not update session status when existing session is already connected", async () => {
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "connected-session-1",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "claude",
        status: "connected",
        hasLaunchedCommand: false,
        lastActivityAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    // Wait for session creation effect to settle
    await waitFor(() => {
      expect(persistentSessionStore.loadSessionsForEnvironment).toHaveBeenCalled();
    });

    expect(persistentSessionStore.updateSessionStatus).not.toHaveBeenCalled();
  });

  it("restores hasLaunchedCommand from persistent session", async () => {
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "launched-session-1",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "claude",
        status: "connected",
        hasLaunchedCommand: true,
        lastActivityAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      const sessions = useTerminalSessionStore.getState().sessions;
      const session = sessions.get("container-1:tab-1");
      expect(session?.hasLaunchedCommand).toBe(true);
    });
  });

  it("shows Address all for launched review tabs and writes the shared prompt", async () => {
    useTerminalSessionStore.setState({
      sessions: new Map([
        ["container-1:tab-1", { sessionId: "session-1", hasLaunchedCommand: true }],
      ]),
      composeDraftText: new Map(),
      composeDraftImages: new Map(),
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        isReviewTab
        paneId="pane-1"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Address all" }));

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith(ADDRESS_ALL_REVIEW_PROMPT);
      expect(writeMock).toHaveBeenCalledWith("\r");
    });
  });

  it("launches Codex terminal mode without an initial prompt", async () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="codex"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith("codex\n");
    });
  });

  it("escapes quotes and dollar signs in Codex prompts", async () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="codex"
        containerId="container-1"
        environmentId="env-1"
        initialPrompt={'Use "$HOME" for the config path'}
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith('codex "Use \\"\\$HOME\\" for the config path"\n');
    });
  });

  it("preserves newlines in Codex prompts", async () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="codex"
        containerId="container-1"
        environmentId="env-1"
        initialPrompt={"Fix line one\nand line two"}
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
      />
    );

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith('codex "Fix line one\nand line two"\n');
    });
  });
});
