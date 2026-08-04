import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realSessionStore from "@/stores/sessionStore";
import * as realClipboardImagePaste from "@/hooks/useClipboardImagePaste";
import { mockReadText, mockWriteText } from "../../../../../tests/mocks/clipboard";
import {
  emitViewportChange,
  restoreMatchMedia,
  setMobileViewport,
} from "../../../../../tests/mocks/match-media";

// Mock modules that require a real backend runtime or have side effects.
// IMPORTANT: Do NOT mock @/stores (barrel) or @/lib/backend here — doing so
// pollutes the Bun module cache and breaks other test files that share
// those modules.  Instead we use the real stores with controlled state and
// let @/lib/backend fall through to the global @/lib/native/backend mock
// registered in tests/setup.ts.

// @/lib/native/clipboard is centrally mocked in tests/setup.ts.

const resizeMock = mock(async () => {});
const connectMock = mock(async () => {});
const writeMock = mock(async (_data: string) => {});
let terminalOnData: ((data: Uint8Array) => void) | undefined;
let terminalInputHandler: ((data: string) => void) | undefined;
let terminalOscHandler: ((data: string) => boolean) | undefined;
let terminalInputDisposables: Array<{ dispose: ReturnType<typeof mock> }> = [];
let terminalKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
type MockUseTerminalOptions = {
  onData?: (data: Uint8Array) => void;
  onReplay?: (
    data: Uint8Array,
    metadata: {
      preserveExisting: boolean;
      degraded?: "snapshot-error" | "truncated";
      error?: string;
    },
  ) => void;
  terminalKey?: string;
  user?: string;
  existingSessionId?: string | null;
  replayOutputBuffer?: boolean;
  attachExistingOnly?: boolean;
  trackEnvironmentActivity?: boolean;
};
let lastUseTerminalOptions: MockUseTerminalOptions | undefined;
let useTerminalOptionsHistory: MockUseTerminalOptions[] = [];
let useTerminalSessionId: string | null = "session-1";
let useTerminalIsConnected = true;
let clipboardImagePasteOptions: {
  onImageSaved: (filePath: string) => Promise<void>;
  onError: (message: string) => void;
} | undefined;
const composeBarPropsMock = mock((_props: {
  environmentId?: string;
  sessionKey: string;
  className?: string;
}) => {});
let composeBarOptions: {
  isOpen: boolean;
  onSend: (
    images: Array<{
      id: string;
      dataUrl: string;
      base64Data: string;
      width: number;
      height: number;
    }>,
    text: string,
  ) => Promise<void>;
  showAddressAll?: boolean;
  onAddressAll?: () => void;
  className?: string;
} | undefined;

mock.module("@/hooks/useTerminal", () => ({
  useTerminal: (options: MockUseTerminalOptions) => {
    lastUseTerminalOptions = options;
    useTerminalOptionsHistory.push(options);
    terminalOnData = options.onData;
    return {
      sessionId: useTerminalSessionId,
      isConnected: useTerminalIsConnected,
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
  useClipboardImagePaste: (options: {
    onImageSaved: (filePath: string) => Promise<void>;
    onError: (message: string) => void;
  }) => {
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
  // The component reads the store through narrow selectors, so the mock has to
  // honor them.
  useSessionStore: (selector?: (state: typeof persistentSessionStore) => unknown) =>
    selector ? selector(persistentSessionStore) : persistentSessionStore,
}));

afterAll(() => {
  mock.module("@/stores/sessionStore", () => realSessionStoreSnapshot);
  mock.module("@/hooks/useClipboardImagePaste", () => realClipboardImagePasteSnapshot);
  restoreMatchMedia();
});

let storedContainerElement: HTMLDivElement;
let portalTerminalIsOpened = true;

const portalStoreActions = {
  markTerminalOpened: mock(() => {
    portalTerminalIsOpened = true;
  }),
  setTerminalContainer: mock((
    _environmentId: string,
    _tabId: string,
    containerElement: HTMLDivElement,
  ) => {
    storedContainerElement = containerElement;
  }),
  setTerminalPane: mock(() => {}),
  recreateTerminal: mock(() => null),
  clearTerminalsForEnvironment: mock(() => {}),
  disposeTerminal: mock(() => {}),
};

/** The component selects actions as well as data, so both live in the state. */
const portalStoreState = () => ({
  ...portalStoreActions,
  terminals: new Map([
    [
      "env-1::tab-1",
      {
        containerElement: storedContainerElement,
        isOpened: portalTerminalIsOpened,
      },
    ],
  ]),
});

const useTerminalPortalStoreMock = (<T,>(
  selector?: (state: ReturnType<typeof portalStoreState>) => T,
) => {
    if (!selector) {
      return portalStoreActions;
    }

    return selector(portalStoreState());
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
    environmentId,
    sessionKey,
    isOpen,
    onSend,
    showAddressAll,
    onAddressAll,
    className,
  }: {
    environmentId?: string;
    sessionKey: string;
    isOpen: boolean;
    onSend: (
      images: Array<{
        id: string;
        dataUrl: string;
        base64Data: string;
        width: number;
        height: number;
      }>,
      text: string,
    ) => Promise<void>;
    showAddressAll?: boolean;
    onAddressAll?: () => void;
    className?: string;
  }) => {
    composeBarPropsMock({ environmentId, sessionKey, className });
    composeBarOptions = { isOpen, onSend, showAddressAll, onAddressAll, className };
    return showAddressAll ? (
      <button type="button" onClick={onAddressAll}>
        Address all
      </button>
    ) : null;
  },
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
  modes: {
    applicationCursorKeysMode: boolean;
  };
  options: Record<string, unknown>;
  refresh: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  hasSelection: ReturnType<typeof mock>;
  getSelection: ReturnType<typeof mock>;
  selectAll: ReturnType<typeof mock>;
  onSelectionChange: ReturnType<typeof mock>;
  onData: ReturnType<typeof mock>;
  attachCustomKeyEventHandler: ReturnType<typeof mock>;
  open: ReturnType<typeof mock>;
  clear: ReturnType<typeof mock>;
  reset: ReturnType<typeof mock>;
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
    modes: {
      applicationCursorKeysMode: false,
    },
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
    onData: mock((handler: (data: string) => void) => {
      terminalInputHandler = handler;
      const disposable = { dispose: mock(() => {}) };
      terminalInputDisposables.push(disposable);
      return disposable;
    }),
    attachCustomKeyEventHandler: mock((handler: (event: KeyboardEvent) => boolean) => {
      terminalKeyHandler = handler;
    }),
    open: mock(() => {}),
    clear: mock(() => {}),
    reset: mock(() => {}),
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
    composeBarPropsMock.mockClear();
    setMobileViewport(false);
    portalTerminalIsOpened = true;
    cleanup();
    resizeMock.mockClear();
    connectMock.mockClear();
    writeMock.mockClear();
    terminalOnData = undefined;
    terminalInputHandler = undefined;
    terminalOscHandler = undefined;
    terminalInputDisposables = [];
    terminalKeyHandler = undefined;
    lastUseTerminalOptions = undefined;
    useTerminalOptionsHistory = [];
    useTerminalSessionId = "session-1";
    useTerminalIsConnected = true;
    clipboardImagePasteOptions = undefined;
    composeBarOptions = undefined;
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
      deletingEnvironments: new Set<string>(),
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

  it("opens and registers a fresh xterm container before connecting", async () => {
    portalTerminalIsOpened = false;
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    const view = render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(terminal.open).toHaveBeenCalledTimes(1);
      expect(portalStoreActions.markTerminalOpened).toHaveBeenCalledWith("env-1", "tab-1");
      expect(portalStoreActions.setTerminalContainer)
        .toHaveBeenCalledWith("env-1", "tab-1", expect.any(HTMLDivElement));
      expect(connectMock).toHaveBeenCalledTimes(1);
    });
    const openedContainer = terminal.open.mock.calls[0]?.[0] as HTMLElement;
    expect(openedContainer.parentElement).toBe(
      Array.from(view.container.querySelectorAll("div")).find((element) =>
        element.className.includes("absolute inset-x-0 top-0")
      ) ?? null,
    );
  });

  it("uses the fallback connection for an already-open disconnected terminal", async () => {
    useTerminalIsConnected = false;

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
  });

  it("forwards the environment identity to terminal compose draft persistence", () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    expect(composeBarPropsMock).toHaveBeenCalledWith({
      environmentId: "env-1",
      sessionKey: "container-1:tab-1",
      className: undefined,
    });
  });

  it("fits without focusing the terminal when activated on mobile", async () => {
    setMobileViewport(true);
    const terminalData = createTerminalData();

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(terminalData.fitAddon.fit).toHaveBeenCalled();
    });
    expect(terminalData.terminal.focus).not.toHaveBeenCalled();
  });

  it("shows mobile terminal keys and sends their control sequences to the PTY", async () => {
    setMobileViewport(true);

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    const expectedKeys = [
      ["Escape", "\u001b"],
      ["Tab", "\t"],
      ["Control C", "\u0003"],
      ["Up arrow", "\u001b[A"],
      ["Down arrow", "\u001b[B"],
      ["Left arrow", "\u001b[D"],
      ["Right arrow", "\u001b[C"],
    ] as const;

    for (const [name] of expectedKeys) {
      fireEvent.click(screen.getByRole("button", { name }));
    }

    expect(writeMock.mock.calls.map(([data]) => data)).toEqual(
      expectedKeys.map(([, data]) => data),
    );
  });

  it("does not render the terminal key bar on desktop", () => {
    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();
  });

  it("uses application cursor sequences for mobile arrow keys when the terminal requests them", () => {
    setMobileViewport(true);
    const terminalData = createTerminalData();
    Object.defineProperty(terminalData.terminal.modes, "applicationCursorKeysMode", {
      value: true,
    });

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    for (const name of ["Up arrow", "Down arrow", "Left arrow", "Right arrow"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }

    expect(writeMock.mock.calls.map(([data]) => data)).toEqual([
      "\u001bOA",
      "\u001bOB",
      "\u001bOD",
      "\u001bOC",
    ]);
  });

  it("hides mobile keys while inactive and disables them while disconnected", () => {
    setMobileViewport(true);
    const terminalData = createTerminalData();
    const view = render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive={false}
        isFocused={false}
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    expect(screen.queryByRole("toolbar", { name: "Terminal keys" })).toBeNull();

    useTerminalIsConnected = false;
    view.rerender(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(7);
    expect(buttons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("reserves safe-area space and raises the compose bar above mobile keys", () => {
    setMobileViewport(true);
    const view = render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    const terminalHost = Array.from(view.container.querySelectorAll("div")).find((element) =>
      element.className.includes("absolute inset-x-0 top-0")
    );
    expect(terminalHost?.className).toContain(
      "bottom-[calc(3rem+env(safe-area-inset-bottom))]",
    );
    expect(composeBarOptions?.className).toBe(
      "bottom-[calc(3.5rem+env(safe-area-inset-bottom))]",
    );
  });

  it("records mobile-key activity once within the throttle window", async () => {
    setMobileViewport(true);
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "connected-session",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "connected",
        hasLaunchedCommand: false,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Up arrow" })).toBeTruthy()
    );
    fireEvent.click(screen.getByRole("button", { name: "Up arrow" }));
    fireEvent.click(screen.getByRole("button", { name: "Down arrow" }));

    await waitFor(() =>
      expect(persistentSessionStore.updateSessionActivity)
        .toHaveBeenCalledWith("connected-session")
    );
    expect(persistentSessionStore.updateSessionActivity).toHaveBeenCalledTimes(1);
  });

  it("publishes the write function only for connected terminals", async () => {
    const onWrite = mock((_write: (data: string) => Promise<void>) => {});
    const connectedView = render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
        onWrite={onWrite}
      />,
    );

    await waitFor(() => expect(onWrite).toHaveBeenCalledTimes(1));
    connectedView.unmount();
    onWrite.mockClear();
    useTerminalIsConnected = false;

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
        onWrite={onWrite}
      />,
    );

    await act(async () => {});
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("focuses the terminal when activated on desktop", async () => {
    const terminalData = createTerminalData();

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(terminalData.terminal.focus).toHaveBeenCalled();
    });
  });

  it("does not focus when the viewport widens past the mobile breakpoint", async () => {
    setMobileViewport(true);
    const terminalData = createTerminalData();

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(terminalData.fitAddon.fit).toHaveBeenCalled();
    });

    await act(async () => {
      emitViewportChange(false);
    });

    expect(terminalData.terminal.focus).not.toHaveBeenCalled();
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
      expect(lastUseTerminalOptions?.terminalKey).toBe("tab-1");
      expect(lastUseTerminalOptions?.replayOutputBuffer).toBe(true);
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

  it("replaces a plain terminal with an authoritative backend replay", async () => {
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    const replay = new TextEncoder().encode("authoritative output\r\n");

    act(() => {
      lastUseTerminalOptions!.onReplay!(replay, { preserveExisting: false });
    });

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith(replay);
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("treats an empty authoritative replay as a valid cleared transcript", async () => {
    const sessionKey = createSessionKey("container-1", "tab-1", "env-1");
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "existing-session",
      serializedBuffer: "durable history that must be replaced",
    });
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    const emptyReplay = new Uint8Array();

    act(() => {
      lastUseTerminalOptions!.onReplay!(emptyReplay, { preserveExisting: false });
    });

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith(emptyReplay);
    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(terminal.write.mock.calls[0]![0] as Uint8Array)).toBe("");
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("prepends durable history when replaying a newly-created replacement session", async () => {
    const sessionKey = createSessionKey("container-1", "tab-1", "env-1");
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "exited-session",
      serializedBuffer: "durable history\r\n",
    });
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());

    act(() => {
      lastUseTerminalOptions!.onReplay!(
        new TextEncoder().encode("replacement output\r\n"),
        { preserveExisting: true },
      );
    });

    const replayData = terminal.write.mock.calls.at(-1)?.[0];
    expect(replayData).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(replayData as Uint8Array)).toBe(
      "durable history\r\nreplacement output\r\n",
    );
    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("prepends late durable history without losing interim live output", async () => {
    let resolvePersistentBuffer: ((buffer: string | null) => void) | undefined;
    persistentSessionStore.loadSessionBuffer.mockImplementation(
      () => new Promise<string | null>((resolve) => {
        resolvePersistentBuffer = resolve;
      }),
    );
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "persistent-session",
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
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(lastUseTerminalOptions?.onReplay).toBeDefined();
      expect(resolvePersistentBuffer).toBeDefined();
    });
    act(() => {
      lastUseTerminalOptions!.onReplay!(
        new TextEncoder().encode("replacement output\r\n"),
        { preserveExisting: true },
      );
    });
    expect(
      new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array),
    ).toBe("replacement output\r\n");

    act(() => {
      terminalOnData?.(new TextEncoder().encode("interim live output\r\n"));
    });
    expect(
      new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array),
    ).toBe("interim live output\r\n");

    await act(async () => {
      resolvePersistentBuffer!("late durable history\r\n");
      await Promise.resolve();
    });

    await waitFor(() => {
      const replayData = terminal.write.mock.calls.at(-1)?.[0];
      expect(new TextDecoder().decode(replayData as Uint8Array)).toBe(
        "late durable history\r\nreplacement output\r\ninterim live output\r\n",
      );
    });
  });

  it("restores durable history and keeps live output visible when snapshot synchronization fails", async () => {
    const sessionKey = createSessionKey("container-1", "tab-1", "env-1");
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "existing-session",
      serializedBuffer: "\u001b[32mdurable terminal view\u001b[0m\r\n",
    });
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    act(() => {
      lastUseTerminalOptions!.onReplay!(new Uint8Array(), {
        preserveExisting: false,
        degraded: "snapshot-error",
        error: "backend detail that should not be exposed",
      });
    });

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array))
      .toBe("\u001b[32mdurable terminal view\u001b[0m\r\n");
    expect(screen.getByRole("status").textContent).toContain(
      "Terminal history could not be synchronized",
    );
    expect(screen.getByRole("status").textContent).not.toContain("backend detail");

    const live = new TextEncoder().encode("live after failure\r\n");
    act(() => terminalOnData?.(live));
    expect(terminal.write).toHaveBeenLastCalledWith(live);
  });

  it("preserves the current xterm parser when snapshot synchronization fails without durable history", async () => {
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    act(() => {
      lastUseTerminalOptions!.onReplay!(new Uint8Array(), {
        preserveExisting: false,
        degraded: "snapshot-error",
        error: "snapshot failed",
      });
    });

    expect(terminal.clear).not.toHaveBeenCalled();
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();

    const live = new TextEncoder().encode("post-failure live output\r\n");
    act(() => terminalOnData?.(live));
    expect(terminal.write).toHaveBeenLastCalledWith(live);
  });

  it("preserves newer rendered output when snapshot synchronization fails with an older durable checkpoint", async () => {
    const sessionKey = createSessionKey("container-1", "tab-1", "env-1");
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "existing-session",
      serializedBuffer: "older durable checkpoint\r\n",
    });
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    const currentOutput = new TextEncoder().encode("newer live terminal state\r\n");
    act(() => terminalOnData?.(currentOutput));

    terminal.clear.mockClear();
    terminal.reset.mockClear();
    act(() => {
      lastUseTerminalOptions!.onReplay!(new Uint8Array(), {
        preserveExisting: false,
        degraded: "snapshot-error",
        error: "snapshot failed",
      });
    });

    expect(terminal.clear).not.toHaveBeenCalled();
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenLastCalledWith(currentOutput);
  });

  it("uses only valid durable serialization when the backend snapshot is truncated", async () => {
    const sessionKey = createSessionKey("container-1", "tab-1", "env-1");
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "existing-session",
      serializedBuffer: "\u001b[?25hvalid \u{1F642} checkpoint\r\n",
    });
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;
    const arbitraryTail = new Uint8Array([
      0x9b, 0x33, 0x31, 0x6d, 0xf0, 0x9f, 0x99,
    ]);

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    act(() => {
      lastUseTerminalOptions!.onReplay!(arbitraryTail, {
        preserveExisting: false,
        degraded: "truncated",
      });
    });

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array))
      .toBe("\u001b[?25hvalid \u{1F642} checkpoint\r\n");
    expect(terminal.write).not.toHaveBeenCalledWith(arbitraryTail);
    expect(screen.getByRole("status").textContent).toContain(
      "Terminal history was truncated",
    );
  });

  it("preserves xterm parser state and discards a truncated tail when no durable history exists", async () => {
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;
    const arbitraryTail = new Uint8Array([0x9b, 0x33, 0x31, 0x6d, 0xf0, 0x9f]);

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    act(() => {
      lastUseTerminalOptions!.onReplay!(arbitraryTail, {
        preserveExisting: false,
        degraded: "truncated",
      });
    });

    expect(terminal.clear).not.toHaveBeenCalled();
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalledWith(arbitraryTail);
    expect(screen.getByRole("status").textContent).toContain(
      "Earlier output may be unavailable",
    );
  });

  it("replaces a truncated tail with late durable history plus post-snapshot live output", async () => {
    let resolvePersistentBuffer: ((buffer: string | null) => void) | undefined;
    persistentSessionStore.loadSessionBuffer.mockImplementation(
      () => new Promise<string | null>((resolve) => {
        resolvePersistentBuffer = resolve;
      }),
    );
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "persistent-session",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "disconnected",
        hasLaunchedCommand: false,
      },
    ];
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;
    const truncatedTail = new TextEncoder().encode("possibly overlapping tail\r\n");
    const live = new TextEncoder().encode("live after snapshot\r\n");

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(lastUseTerminalOptions?.onReplay).toBeDefined();
      expect(resolvePersistentBuffer).toBeDefined();
    });
    act(() => {
      lastUseTerminalOptions!.onReplay!(truncatedTail, {
        preserveExisting: false,
        degraded: "truncated",
      });
      terminalOnData?.(live);
    });

    await act(async () => {
      resolvePersistentBuffer!("durable checkpoint\r\n");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array))
        .toBe("durable checkpoint\r\nlive after snapshot\r\n");
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Terminal history was truncated",
    );
  });

  it.each(["null", "reject"] as const)(
    "retains interim output when a delayed durable buffer resolves with %s",
    async (outcome) => {
      let resolvePersistentBuffer: ((buffer: string | null) => void) | undefined;
      let rejectPersistentBuffer: ((error: Error) => void) | undefined;
      persistentSessionStore.loadSessionBuffer.mockImplementation(
        () => new Promise<string | null>((resolve, reject) => {
          resolvePersistentBuffer = resolve;
          rejectPersistentBuffer = reject;
        }),
      );
      persistentSessionStore.getSessionsByEnvironment = () => [
        {
          id: "persistent-session",
          environmentId: "env-1",
          containerId: "container-1",
          tabId: "tab-1",
          sessionType: "plain",
          status: "disconnected",
          hasLaunchedCommand: false,
        },
      ];
      const terminalData = createTerminalData();
      const terminal = terminalData.terminal as unknown as MockTerminal;

      render(
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType="plain"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible
          isActive
          isFocused
          isFirstTab={false}
          paneId="pane-1"
        />,
      );

      await waitFor(() => {
        expect(lastUseTerminalOptions?.onReplay).toBeDefined();
        expect(resolvePersistentBuffer).toBeDefined();
      });
      const replacement = new TextEncoder().encode("replacement\r\n");
      const interim = new TextEncoder().encode("interim\r\n");
      act(() => {
        lastUseTerminalOptions!.onReplay!(replacement, { preserveExisting: true });
        terminalOnData?.(interim);
      });

      await act(async () => {
        if (outcome === "null") {
          resolvePersistentBuffer!(null);
        } else {
          rejectPersistentBuffer!(new Error("storage unavailable"));
        }
        await Promise.resolve();
      });

      expect(terminal.clear).toHaveBeenCalledTimes(1);
      expect(terminal.reset).toHaveBeenCalledTimes(1);
      expect(terminal.write.mock.calls.map((call) => call[0])).toContain(replacement);
      expect(terminal.write.mock.calls.map((call) => call[0])).toContain(interim);
      if (outcome === "reject") {
        expect(screen.getByRole("status").textContent).toContain(
          "Saved terminal history could not be loaded",
        );
      }
    },
  );

  it("bounds output retained while a durable buffer load is hung", async () => {
    let resolvePersistentBuffer: ((buffer: string | null) => void) | undefined;
    persistentSessionStore.loadSessionBuffer.mockImplementation(
      () => new Promise<string | null>((resolve) => {
        resolvePersistentBuffer = resolve;
      }),
    );
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "persistent-session",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "disconnected",
        hasLaunchedCommand: false,
      },
    ];
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(lastUseTerminalOptions?.onReplay).toBeDefined();
      expect(resolvePersistentBuffer).toBeDefined();
    });
    act(() => {
      lastUseTerminalOptions!.onReplay!(new Uint8Array(), { preserveExisting: true });
      terminalOnData?.(new Uint8Array(600 * 1024));
      terminalOnData?.(new Uint8Array(600 * 1024));
    });

    expect(screen.getByRole("status").textContent).toContain(
      "Current output was retained",
    );
    const resetCountBeforeResolution = terminal.reset.mock.calls.length;

    await act(async () => {
      resolvePersistentBuffer!("late history");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useTerminalSessionStore.getState().sessions.get("container-1:tab-1")?.serializedBuffer)
        .toBe("late history");
    });
    expect(terminal.reset).toHaveBeenCalledTimes(resetCountBeforeResolution);
  });

  it("uses replayed plain-terminal output for local workspace readiness", async () => {
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
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
    );

    render(
      <PersistentTerminal
        terminalData={createTerminalData({ containerId: null })}
        tabId="tab-1"
        tabType="plain"
        containerId={null}
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab
        paneId="pane-1"
        onReady={onReady}
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    act(() => {
      lastUseTerminalOptions!.onReplay!(
        new TextEncoder().encode("$ "),
        { preserveExisting: false },
      );
    });

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: false,
        workspaceReady: true,
      });
    });
  });

  it.each([
    ["zsh arrow", "➜ "],
    ["alternate prompt", "❯ "],
    ["dollar prompt", "$ "],
    ["percent prompt", "% "],
    ["long completed startup output", `${"x".repeat(501)}\n`],
  ])("recognizes %s as first-tab local readiness", async (_label, output) => {
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
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
    );

    render(
      <PersistentTerminal
        terminalData={createTerminalData({ containerId: null })}
        tabId="tab-1"
        tabType="plain"
        containerId={null}
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab
        paneId="pane-1"
        onReady={onReady}
      />,
    );

    act(() => terminalOnData?.(new TextEncoder().encode(output)));
    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: false,
        workspaceReady: true,
      });
    });
  });

  it("keeps local readiness detection working after truncating noisy startup output", async () => {
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
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
    );

    render(
      <PersistentTerminal
        terminalData={createTerminalData({ containerId: null })}
        tabId="tab-1"
        tabType="plain"
        containerId={null}
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab
        paneId="pane-1"
        onReady={onReady}
      />,
    );

    act(() => {
      terminalOnData?.(new TextEncoder().encode("x".repeat(1500)));
      terminalOnData?.(new TextEncoder().encode("\n$ "));
    });
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["a zsh prompt", "➜ "],
    ["a workspace path", "ready in /workspace/project"],
    ["substantial shell output", "x".repeat(101)],
  ])("marks a non-first tab ready after %s", async (_label, output) => {
    useTerminalSessionId = null;

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        initialCommands={["echo non-first-ready"]}
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(terminalOnData).toBeDefined());
    expect(writeMock).not.toHaveBeenCalledWith("echo non-first-ready\n");
    act(() => terminalOnData?.(new TextEncoder().encode(output)));
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith("echo non-first-ready\n");
    });
  });

  it("uses replayed setup output for container workspace readiness", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
    );

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab
        isSetupTab
        paneId="pane-1"
        onReady={onReady}
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());
    act(() => {
      lastUseTerminalOptions!.onReplay!(
        new TextEncoder().encode(
          "Container setup completed successfully!\n=== Workspace Ready ===\n",
        ),
        { preserveExisting: false },
      );
    });

    await waitFor(() => {
      expect(onReady).toHaveBeenCalledWith({
        persistSetupComplete: true,
        workspaceReady: true,
      });
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

  it("contains clipboard copy failures", async () => {
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;
    terminal.hasSelection.mockImplementation(() => true);
    terminal.getSelection.mockImplementation(() => "selected text");
    mockWriteText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const consoleError = mock((_message?: unknown, _error?: unknown) => {});
    const originalError = console.error;
    console.error = consoleError as typeof console.error;

    try {
      render(
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType="plain"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible
          isActive
          isFocused
          isFirstTab={false}
          paneId="pane-1"
        />,
      );

      await waitFor(() => expect(terminalKeyHandler).toBeDefined());
      expect(terminalKeyHandler!(
        new KeyboardEvent("keydown", { key: "c", metaKey: true }),
      )).toBe(false);
      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "[PersistentTerminal] Failed to copy selection:",
          expect.objectContaining({ message: "clipboard unavailable" }),
        )
      );
    } finally {
      console.error = originalError;
    }
  });

  it("reports clipboard image errors without throwing", () => {
    const consoleError = mock((_message?: unknown, _error?: unknown) => {});
    const originalError = console.error;
    console.error = consoleError as typeof console.error;

    try {
      render(
        <PersistentTerminal
          terminalData={createTerminalData()}
          tabId="tab-1"
          tabType="plain"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible
          isActive
          isFocused
          isFirstTab={false}
          paneId="pane-1"
        />,
      );

      clipboardImagePasteOptions?.onError("image too large");
      expect(consoleError).toHaveBeenCalledWith(
        "[PersistentTerminal] Clipboard image error:",
        "image too large",
      );
    } finally {
      console.error = originalError;
    }
  });

  it("handles compose, tab-switch, signal, and modifier keyboard branches", async () => {
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;
    terminal.hasSelection.mockImplementation(() => false);

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(terminalKeyHandler).toBeDefined();
      expect(composeBarOptions).toBeDefined();
    });

    expect(terminalKeyHandler!(new KeyboardEvent("keyup", { key: "v", metaKey: true })))
      .toBe(true);
    expect(terminalKeyHandler!(
      new KeyboardEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true }),
    )).toBe(false);
    expect(terminalKeyHandler!(
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
    )).toBe(true);
    expect(terminalKeyHandler!(
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true }),
    )).toBe(true);
    expect(terminalKeyHandler!(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, altKey: true }),
    )).toBe(true);

    act(() => {
      expect(terminalKeyHandler!(
        new KeyboardEvent("keydown", { key: "i", metaKey: true }),
      )).toBe(false);
    });
    await waitFor(() => expect(composeBarOptions?.isOpen).toBe(true));

    const composePaste = new KeyboardEvent("keydown", { key: "v", metaKey: true });
    const preventDefault = mock(() => {});
    Object.defineProperty(composePaste, "preventDefault", { value: preventDefault });
    expect(terminalKeyHandler!(composePaste)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("resets launch readiness when the terminal moves to a replacement container", async () => {
    const terminalData = createTerminalData();
    const view = render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        initialCommands={["echo ready"]}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(terminalOnData).toBeDefined());
    act(() => terminalOnData?.(new TextEncoder().encode("workspace $ ")));
    await waitFor(
      () => expect(writeMock).toHaveBeenCalledWith("echo ready\n"),
      { timeout: 1_000 },
    );

    writeMock.mockClear();
    view.rerender(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-2"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        initialCommands={["echo ready"]}
        paneId="pane-1"
      />,
    );

    act(() => terminalOnData?.(new TextEncoder().encode("replacement $ ")));
    await waitFor(
      () => expect(writeMock).toHaveBeenCalledWith("echo ready\n"),
      { timeout: 1_000 },
    );
  });

  it("sends compose images sequentially before normalized single-line text", async () => {
    const terminalData = createTerminalData();

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(composeBarOptions).toBeDefined());
    writeMock.mockClear();

    const image = (id: string) => ({
      id,
      dataUrl: "",
      base64Data: "",
      width: 1,
      height: 1,
    });
    await act(async () => {
      await composeBarOptions!.onSend(
        [image("/tmp/one.png"), image("/tmp/two.png")],
        "  first line\nsecond line\r\nthird line  ",
      );
    });

    expect((writeMock as any).mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "/tmp/one.png",
      "\r",
      "/tmp/two.png",
      "\r",
      "first line second line third line",
      "\r",
    ]);
    expect(terminalData.terminal.focus).toHaveBeenCalled();
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

  it("recovers when pane buffer restoration throws", async () => {
    const terminalData = createTerminalData({ serializedBuffer: "pane-buffer" });
    const terminal = terminalData.terminal as unknown as MockTerminal;
    terminal.write.mockImplementationOnce(() => {
      throw new Error("parser unavailable");
    });
    const consoleError = mock((_message?: unknown, _error?: unknown) => {});
    const originalError = console.error;
    console.error = consoleError as typeof console.error;

    try {
      const view = render(
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType="plain"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible
          isActive
          isFocused
          isFirstTab={false}
          paneId="pane-1"
        />,
      );

      view.rerender(
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType="plain"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible
          isActive
          isFocused
          isFirstTab={false}
          paneId="pane-2"
        />,
      );

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          "[PersistentTerminal] Error restoring buffer for tab:tab-1:",
          expect.objectContaining({ message: "parser unavailable" }),
        );
        expect(terminal.refresh).toHaveBeenCalled();
      });
    } finally {
      console.error = originalError;
    }
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

  it("retains one-shot launch options until the environment is ready, then consumes them", async () => {
    // The whole point of the tab-level options is that they outlive a renderer
    // reload that happens before the agent command runs. A terminal tab waits on
    // a PTY readiness marker, so this is the longest-lived unconsumed window in
    // the app — and the one a test must pin, or the retention could be deleted
    // without any suite noticing.
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
        initialPrompt="Fix the failing tests"
        initialAgentModel="gpt-review"
        initialReasoningEffort="high"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={true}
        paneId="pane-1"
      />
    );

    // A first container tab with no prior session waits for the setup marker
    // before it is allowed to launch, so nothing has run yet.
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeMock).not.toHaveBeenCalled();
    expect(usePaneLayoutStore.getState().getAllTabs("env-1")[0]).toMatchObject({
      initialAgentModel: "gpt-review",
      initialReasoningEffort: "high",
    });

    await act(async () => {
      terminalOnData?.(new TextEncoder().encode("=== Workspace Ready ===\n"));
      await Promise.resolve();
    });

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

  it("hides the manual setup-complete button once the environment records setup as done", async () => {
    // `isSetupTab` now survives a pane-layout restore, and `setupCompleteRef` is
    // only ever set by a live OSC marker — so it resets to false on every mount.
    // Without the authoritative check, a reload would re-offer "Mark setup
    // complete" for setup that finished long ago.
    useEnvironmentStore.setState((state) => ({
      ...state,
      environments: state.environments.map((environment) =>
        environment.id === "env-1"
          ? { ...environment, setupScriptsComplete: true }
          : environment
      ),
    }));

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
        onSetupComplete={mock(() => {})}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByText("Mark setup complete")).toBeNull();
  });

  it("still offers the manual setup-complete button while setup is unfinished", async () => {
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
        onSetupComplete={mock(() => {})}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByText("Mark setup complete")).not.toBeNull();
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

  it("contains serialization failures during cleanup", async () => {
    const terminalData = createTerminalData();
    const serialize = terminalData.serializeAddon.serialize as unknown as ReturnType<typeof mock>;
    serialize.mockImplementation(() => {
      throw new Error("serializer unavailable");
    });
    const consoleError = mock((_message?: unknown, _error?: unknown) => {});
    const originalError = console.error;
    console.error = consoleError as typeof console.error;

    try {
      const view = render(
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType="claude"
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible
          isActive
          isFocused
          isFirstTab={false}
          paneId="pane-1"
        />,
      );
      await waitFor(() => expect(terminalInputHandler).toBeDefined());

      view.unmount();

      expect(consoleError).toHaveBeenCalledWith(
        "[PersistentTerminal] Cleanup - failed to serialize buffer:",
        expect.objectContaining({ message: "serializer unavailable" }),
      );
      expect(terminalInputDisposables[0]?.dispose).toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }
  });

  it("does not replace a durable buffer with a substantially shorter cleanup snapshot", async () => {
    const sessionKey = createSessionKey("container-1", "tab-1", "env-1");
    const durableBuffer = "x".repeat(100);
    useTerminalSessionStore.setState({
      sessions: new Map([
        [
          sessionKey,
          {
            sessionId: "session-existing",
            serializedBuffer: durableBuffer,
            hasLaunchedCommand: false,
          },
        ],
      ]),
    });
    const view = render(
      <PersistentTerminal
        terminalData={createTerminalData({ serializedBuffer: "too-short" })}
        tabId="tab-1"
        tabType="claude"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(persistentSessionStore.createSession).toHaveBeenCalled());
    view.unmount();

    expect(
      useTerminalSessionStore.getState().sessions.get(sessionKey)?.serializedBuffer,
    ).toBe(durableBuffer);
    expect(persistentSessionStore.saveSessionBuffer).not.toHaveBeenCalled();
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

  it("contains persistent-session list failures", async () => {
    persistentSessionStore.loadSessionsForEnvironment.mockImplementationOnce(async () => {
      throw new Error("list failed");
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(persistentSessionStore.loadSessionsForEnvironment).toHaveBeenCalledWith("env-1");
    });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("contains persistent-session creation failures", async () => {
    persistentSessionStore.createSession.mockImplementationOnce(async () => {
      throw new Error("create failed");
    });

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(persistentSessionStore.createSession).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("contains persistent-session status update failures", async () => {
    persistentSessionStore.updateSessionStatus.mockImplementationOnce(async () => {
      throw new Error("status failed");
    });
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "disconnected-session",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "disconnected",
        hasLaunchedCommand: false,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => {
      expect(persistentSessionStore.updateSessionStatus)
        .toHaveBeenCalledWith("disconnected-session", "connected");
    });
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("contains throttled persistent-session activity update failures", async () => {
    persistentSessionStore.updateSessionActivity.mockImplementationOnce(async () => {
      throw new Error("activity failed");
    });
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "connected-session",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "connected",
        hasLaunchedCommand: false,
      },
    ];

    render(
      <PersistentTerminal
        terminalData={createTerminalData()}
        tabId="tab-1"
        tabType="plain"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible
        isActive
        isFocused
        isFirstTab={false}
        paneId="pane-1"
      />,
    );

    await waitFor(() => expect(terminalInputHandler).toBeDefined());
    act(() => terminalInputHandler?.("input"));
    await waitFor(() => {
      expect(persistentSessionStore.updateSessionActivity)
        .toHaveBeenCalledWith("connected-session");
    });
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
