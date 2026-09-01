import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useCallback, useState } from "react";
import * as realSessionStore from "@/stores/sessionStore";
import * as realClipboardImagePaste from "@/hooks/useClipboardImagePaste";
import { invoke } from "@/lib/native/backend";
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
const markBootstrappedMock = mock((_sessionId: string) => true);
const invokeMock = invoke as ReturnType<typeof mock>;
const bootstrapWrites = (): string[] =>
  invokeMock.mock.calls
    .filter(([command]) => command === "bootstrap_terminal_session")
    .map(([, args]) => (args as { data: string }).data);
let terminalOnData: ((data: Uint8Array) => void) | undefined;
let terminalInputHandler: ((data: string) => void) | undefined;
let terminalOscHandler: ((data: string) => boolean) | undefined;
let terminalInputDisposables: Array<{ dispose: ReturnType<typeof mock> }> = [];
let terminalKeyHandler: ((event: KeyboardEvent) => boolean) | undefined;
type MockUseTerminalOptions = {
  containerId?: string | null;
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
let useTerminalIsConnecting = false;
let useTerminalBootstrapped = false;
let clipboardImagePasteOptions:
  | {
      onImageSaved: (filePath: string) => Promise<void>;
      onError: (message: string) => void;
    }
  | undefined;
const composeBarPropsMock = mock(
  (_props: { environmentId?: string; sessionKey: string; className?: string }) => {},
);
let composeBarOptions:
  | {
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
    }
  | undefined;

mock.module("@/hooks/useTerminal", () => ({
  useTerminal: (options: MockUseTerminalOptions) => {
    const [locallyBootstrapped, setLocallyBootstrapped] = useState(false);
    const markBootstrapped = useCallback((sessionId: string) => {
      const accepted = markBootstrappedMock(sessionId);
      if (accepted) setLocallyBootstrapped(true);
      return accepted;
    }, []);
    lastUseTerminalOptions = options;
    useTerminalOptionsHistory.push(options);
    terminalOnData = options.onData;
    return {
      sessionId: useTerminalSessionId,
      bootstrapped: useTerminalBootstrapped || locallyBootstrapped,
      isConnected: useTerminalIsConnected,
      isConnecting: useTerminalIsConnecting,
      error: null,
      connect: connectMock,
      disconnect: mock(async () => {}),
      markBootstrapped,
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
  loadSessionsForEnvironment: mock(async (environmentId: string) => {
    const current = persistentSessionStore.sessionSnapshotGenerations.get(environmentId) ?? 0;
    const generations = new Map(persistentSessionStore.sessionSnapshotGenerations);
    generations.set(environmentId, current + 1);
    persistentSessionStore.sessionSnapshotGenerations = generations;
  }),
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
  sessionSnapshotGenerations: new Map([["env-1", 1]]),
  error: null,
};

const realSessionStoreSnapshot = { ...realSessionStore };
// The component reads the store through narrow selectors, so the mock has to
// honor them — and through `getState()`, which the session-list retry uses to
// ask whether a snapshot actually landed.
const useSessionStoreMock = Object.assign(
  (selector?: (state: typeof persistentSessionStore) => unknown) =>
    selector ? selector(persistentSessionStore) : persistentSessionStore,
  { getState: () => persistentSessionStore },
);
mock.module("@/stores/sessionStore", () => ({
  useSessionStore: useSessionStoreMock,
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
  setTerminalContainer: mock(
    (_environmentId: string, _tabId: string, containerElement: HTMLDivElement) => {
      storedContainerElement = containerElement;
    },
  ),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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
  input: ReturnType<typeof mock>;
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
    input: mock((data: string) => terminalInputHandler?.(data)),
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
    connectMock.mockReset();
    connectMock.mockImplementation(async () => {});
    writeMock.mockClear();
    markBootstrappedMock.mockClear();
    markBootstrappedMock.mockImplementation(() => true);
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) =>
      command === "bootstrap_terminal_session"
        ? { bootstrapped: true, delivered: true, duplicate: false }
        : undefined,
    );
    terminalOnData = undefined;
    terminalInputHandler = undefined;
    terminalOscHandler = undefined;
    terminalInputDisposables = [];
    terminalKeyHandler = undefined;
    lastUseTerminalOptions = undefined;
    useTerminalOptionsHistory = [];
    useTerminalSessionId = "session-1";
    useTerminalIsConnected = true;
    useTerminalIsConnecting = false;
    useTerminalBootstrapped = false;
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
    // mockClear leaves the implementation in place, and the retry tests below
    // install a failing one, so reset it rather than leaking it into siblings.
    persistentSessionStore.loadSessionsForEnvironment.mockImplementation(async (environmentId) => {
      const current = persistentSessionStore.sessionSnapshotGenerations.get(environmentId) ?? 0;
      const generations = new Map(persistentSessionStore.sessionSnapshotGenerations);
      generations.set(environmentId, current + 1);
      persistentSessionStore.sessionSnapshotGenerations = generations;
    });
    persistentSessionStore.saveSessionBuffer.mockClear();
    persistentSessionStore.loadSessionBuffer.mockClear();
    persistentSessionStore.loadSessionBuffer.mockImplementation(
      async (): Promise<string | null> => null,
    );
    persistentSessionStore.getSessionsByEnvironment = () => [];
    persistentSessionStore.sessionSnapshotGenerations = new Map([["env-1", 1]]);

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
          agentSettings: {
            defaultAgent: "claude",
            platforms: {
              opencode: { model: "", mode: "terminal" },
              codex: { model: "", reasoningEffort: "medium", mode: "native" },
              claude: { mode: "terminal", claudeNativeBackend: "sdk" },
            },
          },
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
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "pane-1",
              tabs: [{ id: "tab-1", type: "claude" }],
              activeTabId: "tab-1",
            },
            activePaneId: "stale-pane",
            containerId: "container-1",
          },
        ],
        [
          "env-2",
          {
            root: {
              kind: "leaf",
              id: "pane-2",
              tabs: [{ id: "tab-2", type: "plain" }],
              activeTabId: "tab-2",
            },
            activePaneId: "pane-2",
            containerId: "container-2",
          },
        ],
      ]),
      activeEnvironmentId: "env-2",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not force a redraw when opening a fresh terminal already visible", async () => {
    portalTerminalIsOpened = false;
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
      />,
    );

    await waitFor(() => {
      const resizeCalls = resizeMock.mock.calls as unknown as Array<[number, number]>;
      expect(resizeCalls.some(([cols, rows]) => cols === 80 && rows === 25)).toBe(false);
    });
  });

  it("forces a redraw when an opened terminal DOM is reattached on mount", async () => {
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
      />,
    );

    await waitFor(() => {
      expect(resizeMock).toHaveBeenCalledWith(80, 25);
      expect(resizeMock).toHaveBeenCalledWith(80, 24);
    });
  });

  it("forces a redraw when the DOM node is reattached without a remount", async () => {
    const props = {
      terminalData: createTerminalData(),
      tabId: "tab-1",
      tabType: "claude" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);

    await waitFor(() => {
      expect(resizeMock).toHaveBeenCalledWith(80, 25);
    });
    resizeMock.mockClear();

    // A pane move recreates the portal target: the xterm container is detached
    // and the tab is handed a new pane id, with no unmount in between. None of
    // the visibility inputs change, so only the reattach can trigger the redraw.
    storedContainerElement.remove();
    view.rerender(<PersistentTerminal {...props} paneId="pane-2" />);

    await waitFor(() => {
      expect(resizeMock).toHaveBeenCalledWith(80, 25);
      expect(resizeMock).toHaveBeenCalledWith(80, 24);
    });
  });

  it("does not repeat the redraw while the DOM node stays put", async () => {
    const props = {
      terminalData: createTerminalData(),
      tabId: "tab-1",
      tabType: "claude" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);

    await waitFor(() => {
      expect(resizeMock).toHaveBeenCalledWith(80, 25);
    });
    resizeMock.mockClear();

    view.rerender(<PersistentTerminal {...props} isFocused={false} />);
    await act(async () => {
      await Promise.resolve();
    });

    const bounced = (resizeMock.mock.calls as unknown as Array<[number, number]>).some(
      ([cols, rows]) => cols === 80 && rows === 25,
    );
    expect(bounced).toBe(false);
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
      expect(portalStoreActions.setTerminalContainer).toHaveBeenCalledWith(
        "env-1",
        "tab-1",
        expect.any(HTMLDivElement),
      );
      expect(connectMock).toHaveBeenCalledTimes(1);
    });
    const openedContainer = terminal.open.mock.calls[0]?.[0] as HTMLElement;
    expect(openedContainer.parentElement).toBe(
      Array.from(view.container.querySelectorAll("div")).find((element) =>
        element.className.includes("absolute inset-x-0 top-0"),
      ) ?? null,
    );
  });

  it("retries the terminal connection after the Strict Mode mount probe cancels it", async () => {
    portalTerminalIsOpened = false;
    useTerminalIsConnected = false;
    let resolveFirstAttempt: () => void = () => {};
    let resolveSecondAttempt: () => void = () => {};
    connectMock
      .mockImplementationOnce(
        async () =>
          new Promise<void>((resolve) => {
            resolveFirstAttempt = resolve;
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Promise<void>((resolve) => {
            resolveSecondAttempt = resolve;
          }),
      );

    render(
      <StrictMode>
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
        />
      </StrictMode>,
    );

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2));

    // The cancelled probe and its replacement have the same target string. A
    // target-only completion guard would let the stale first promise clear the
    // second attempt's in-flight marker and start an overlapping third call.
    await act(async () => {
      resolveFirstAttempt();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(connectMock).toHaveBeenCalledTimes(2);

    useTerminalIsConnected = true;
    await act(async () => {
      resolveSecondAttempt();
      await Promise.resolve();
    });
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

  it("cancels a pending retry when the terminal target changes", async () => {
    useTerminalIsConnected = false;
    connectMock.mockImplementation(async () => {
      if (connectMock.mock.calls.length >= 2) {
        useTerminalIsConnected = true;
      }
    });
    const terminalData = createTerminalData();
    const props = {
      terminalData,
      tabId: "tab-1",
      tabType: "plain" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));

    // useTerminal sets this true while probing the backend, then false when the
    // attempt settles. The retry is delayed, so changing targets first must
    // cancel it and spend the next call on the replacement target.
    useTerminalIsConnecting = true;
    view.rerender(<PersistentTerminal {...props} />);
    useTerminalIsConnecting = false;
    view.rerender(<PersistentTerminal {...props} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectMock).toHaveBeenCalledTimes(1);

    useTerminalSessionId = "replacement-session";
    act(() => {
      useTerminalSessionStore
        .getState()
        .setSession(createSessionKey("container-1", "tab-1", "env-1"), {
          sessionId: "replacement-session",
        });
    });
    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("recovers from a transient failure against the same terminal target", async () => {
    useTerminalIsConnected = false;
    let attempt = 0;
    connectMock.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        return;
      }
      useTerminalIsConnected = true;
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

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(useTerminalIsConnected).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("bounds automatic retries when the same terminal target keeps failing", async () => {
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

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(3), { timeout: 2_000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(connectMock).toHaveBeenCalledTimes(3);
  });

  it("adopts a freshly published session id without probing again, then reconnects once", async () => {
    // The real hook reports no session until it has resolved one, so the very
    // first attempt is made against a null session. Starting the mock there is
    // what makes the adoption transition below observable at all.
    useTerminalSessionId = null;
    useTerminalIsConnected = false;
    const terminalData = createTerminalData();
    const props = {
      terminalData,
      tabId: "tab-1",
      tabType: "plain" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));

    // The hook resolves a session and reports itself connected. The component
    // publishes that id into the terminal store, which feeds straight back in
    // as existingSessionId. That is this connection being adopted, not a second
    // target, so it must not start another probe.
    useTerminalSessionId = "session-1";
    useTerminalIsConnected = true;
    view.rerender(<PersistentTerminal {...props} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(
      useTerminalSessionStore
        .getState()
        .sessions.get(createSessionKey("container-1", "tab-1", "env-1"))?.sessionId,
    ).toBe("session-1");

    // Losing that connection is a genuine reason to attach again, and the
    // fallback effect is the only automatic path that will do it.
    useTerminalIsConnected = false;
    view.rerender(<PersistentTerminal {...props} />);
    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2));

    // Once. A failure that settles against the same session must not loop.
    useTerminalIsConnecting = true;
    view.rerender(<PersistentTerminal {...props} />);
    useTerminalIsConnecting = false;
    view.rerender(<PersistentTerminal {...props} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("stops probing a dead attach-only setup session instead of looping", async () => {
    // A backend-managed setup tab attaches to an existing PTY and never creates
    // a replacement. When that PTY is gone useTerminal settles by returning --
    // it sets an error, leaves isConnected false and flips isConnecting back to
    // false -- rather than throwing, which is the shape that flooded the log.
    act(() => {
      useTerminalSessionStore
        .getState()
        .setSession(createSessionKey("container-1", "tab-1", "env-1"), {
          sessionId: "dead-setup-session",
        });
    });
    useTerminalSessionId = null;
    useTerminalIsConnected = false;
    const terminalData = createTerminalData();
    const props = {
      terminalData,
      tabId: "tab-1",
      tabType: "plain" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
      isSetupTab: true,
    };
    const view = render(<PersistentTerminal {...props} />);

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    expect(lastUseTerminalOptions?.attachExistingOnly).toBe(true);

    useTerminalIsConnecting = true;
    view.rerender(<PersistentTerminal {...props} />);
    useTerminalIsConnecting = false;
    view.rerender(<PersistentTerminal {...props} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("treats backend-managed agent terminals as attach-only and never bootstraps them", async () => {
    useTerminalSessionId = "backend-job-session";
    useTerminalIsConnected = true;
    useTerminalBootstrapped = false;
    const terminalData = createTerminalData();
    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="startup-agent"
        tabType="codex"
        containerId="container-1"
        environmentId="env-1"
        isEnvironmentVisible={true}
        isActive={true}
        isFocused={true}
        isFirstTab={false}
        paneId="pane-1"
        backendManagedTerminal={true}
      />,
    );

    await waitFor(() => expect(lastUseTerminalOptions?.attachExistingOnly).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(bootstrapWrites()).toEqual([]);
  });

  it("rearms the connection gate for a new container while already disconnected", async () => {
    useTerminalIsConnected = false;
    useTerminalSessionId = null;
    const terminalData = createTerminalData();
    const props = {
      terminalData,
      tabId: "tab-1",
      tabType: "plain" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));

    useTerminalIsConnecting = true;
    view.rerender(<PersistentTerminal {...props} />);
    useTerminalIsConnecting = false;
    view.rerender(<PersistentTerminal {...props} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(connectMock).toHaveBeenCalledTimes(1);

    // A recreated container is a different backend PTY. Nothing else the
    // fallback effect watches changes here -- it is already disconnected and
    // not connecting -- so the target itself has to be what rearms it.
    view.rerender(<PersistentTerminal {...props} containerId="container-2" />);
    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2));
    expect(lastUseTerminalOptions?.containerId).toBe("container-2");
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

    expect(screen.queryByRole("toolbar", { name: "Terminal keys" }) === null).toBe(true);
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

    expect(screen.queryByRole("toolbar", { name: "Terminal keys" }) === null).toBe(true);

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
      element.className.includes("absolute inset-x-0 top-0"),
    );
    expect(terminalHost?.className).toContain("bottom-[calc(3rem+env(safe-area-inset-bottom))]");
    expect(composeBarOptions?.className).toBe("bottom-[calc(3.5rem+env(safe-area-inset-bottom))]");
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

    await waitFor(() => expect(screen.getByRole("button", { name: "Up arrow" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Up arrow" }));
    fireEvent.click(screen.getByRole("button", { name: "Down arrow" }));

    await waitFor(() =>
      expect(persistentSessionStore.updateSessionActivity).toHaveBeenCalledWith(
        "connected-session",
      ),
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
      />,
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
      />,
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
      />,
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
      </>,
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
      />,
    );

    await waitFor(() => {
      expect(lastUseTerminalOptions?.user).toBe(ROOT_TERMINAL_USER);
    });
  });

  it.each([
    ["claude", true],
    ["opencode", true],
    ["codex", true],
    ["pi", true],
    ["plain", false],
    ["root", false],
  ] as const)(
    "sets environment activity tracking for %s terminal tabs",
    async (tabType, expected) => {
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
        />,
      );

      await waitFor(() => {
        expect(lastUseTerminalOptions?.trackEnvironmentActivity).toBe(expected);
        expect(lastUseTerminalOptions?.terminalKey).toBe("tab-1");
        expect(lastUseTerminalOptions?.replayOutputBuffer).toBe(true);
      });
    },
  );

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
      />,
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
      lastUseTerminalOptions!.onReplay!(new TextEncoder().encode("replacement output\r\n"), {
        preserveExisting: true,
      });
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
      () =>
        new Promise<string | null>((resolve) => {
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
      lastUseTerminalOptions!.onReplay!(new TextEncoder().encode("replacement output\r\n"), {
        preserveExisting: true,
      });
    });
    expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array)).toBe(
      "replacement output\r\n",
    );

    act(() => {
      terminalOnData?.(new TextEncoder().encode("interim live output\r\n"));
    });
    expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array)).toBe(
      "interim live output\r\n",
    );

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
    expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array)).toBe(
      "\u001b[32mdurable terminal view\u001b[0m\r\n",
    );
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
    const arbitraryTail = new Uint8Array([0x9b, 0x33, 0x31, 0x6d, 0xf0, 0x9f, 0x99]);

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
    expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array)).toBe(
      "\u001b[?25hvalid \u{1F642} checkpoint\r\n",
    );
    expect(terminal.write).not.toHaveBeenCalledWith(arbitraryTail);
    expect(screen.getByRole("status").textContent).toContain("Terminal history was truncated");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss terminal warning" }));

    expect(screen.queryByRole("status") === null).toBe(true);
  });

  describe("warning dismissal", () => {
    const renderForWarnings = (tabType: "plain" | "claude" = "plain") => {
      const terminalData = createTerminalData();
      render(
        <PersistentTerminal
          terminalData={terminalData}
          tabId="tab-1"
          tabType={tabType}
          containerId="container-1"
          environmentId="env-1"
          isEnvironmentVisible
          isActive
          isFocused
          isFirstTab={false}
          paneId="pane-1"
        />,
      );
      return terminalData.terminal as unknown as MockTerminal;
    };

    const replay = (degraded: "truncated" | "snapshot-error") => {
      act(() => {
        lastUseTerminalOptions!.onReplay!(new Uint8Array(), {
          preserveExisting: true,
          degraded,
        });
      });
    };

    const dismiss = () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss terminal warning" }));
    };

    it("keeps the replay warning dismissed when the same degradation is observed again", async () => {
      renderForWarnings();
      await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());

      replay("truncated");
      expect(screen.getByRole("status").textContent).toContain("Terminal history was truncated");
      dismiss();
      expect(screen.queryByRole("status") === null).toBe(true);

      // A truncated backend ring is re-reported by every later reconciliation.
      // The banner must not come back for a warning the user already closed.
      replay("truncated");
      replay("truncated");

      expect(screen.queryByRole("status") === null).toBe(true);
    });

    it("surfaces a different degradation after an earlier warning was dismissed", async () => {
      renderForWarnings();
      await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());

      replay("truncated");
      dismiss();
      expect(screen.queryByRole("status") === null).toBe(true);

      replay("snapshot-error");

      expect(screen.getByRole("status").textContent).toContain(
        "Terminal history could not be synchronized",
      );
    });

    it("returns focus to the terminal when a warning is dismissed", async () => {
      const terminal = renderForWarnings();
      await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());

      replay("truncated");
      terminal.focus.mockClear();
      dismiss();

      expect(terminal.focus).toHaveBeenCalledTimes(1);
    });

    it("exposes the dismiss control as a focusable button named for its action", async () => {
      renderForWarnings();
      await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());

      replay("truncated");
      const control = screen.getByRole("button", { name: "Dismiss terminal warning" });
      control.focus();

      // A real button carries native Enter/Space activation, so naming and
      // focusability are what the keyboard path actually depends on.
      expect(control.tagName).toBe("BUTTON");
      expect(control.getAttribute("type")).toBe("button");
      expect(document.activeElement === control).toBe(true);
    });

    it("dismisses the bootstrap warning independently and then reveals the replay warning", async () => {
      invokeMock.mockImplementation(async (command: string) =>
        command === "bootstrap_terminal_session"
          ? { bootstrapped: false, delivered: false, duplicate: false }
          : undefined,
      );
      renderForWarnings("claude");
      await waitFor(() => expect(lastUseTerminalOptions?.onReplay).toBeDefined());

      replay("truncated");
      act(() => {
        terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
      });

      // The bootstrap warning takes the bounded retry budget to appear, and it
      // takes precedence over the replay warning already on screen.
      await waitFor(
        () =>
          expect(screen.getByRole("status").textContent).toContain(
            "launch command could not start",
          ),
        { timeout: 2_000 },
      );

      dismiss();

      // Dismissing the bootstrap warning must uncover the replay warning it was
      // covering, not suppress both.
      expect(screen.getByRole("status").textContent).toContain("Terminal history was truncated");

      dismiss();

      expect(screen.queryByRole("status") === null).toBe(true);
    });
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
    expect(screen.getByRole("status").textContent).toContain("Earlier output may be unavailable");
  });

  it("replaces a truncated tail with late durable history plus post-snapshot live output", async () => {
    let resolvePersistentBuffer: ((buffer: string | null) => void) | undefined;
    persistentSessionStore.loadSessionBuffer.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
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
      expect(new TextDecoder().decode(terminal.write.mock.calls.at(-1)?.[0] as Uint8Array)).toBe(
        "durable checkpoint\r\nlive after snapshot\r\n",
      );
    });
    expect(screen.getByRole("status").textContent).toContain("Terminal history was truncated");
  });

  it.each(["null", "reject"] as const)(
    "retains interim output when a delayed durable buffer resolves with %s",
    async (outcome) => {
      let resolvePersistentBuffer: ((buffer: string | null) => void) | undefined;
      let rejectPersistentBuffer: ((error: Error) => void) | undefined;
      persistentSessionStore.loadSessionBuffer.mockImplementation(
        () =>
          new Promise<string | null>((resolve, reject) => {
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
      () =>
        new Promise<string | null>((resolve) => {
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

    expect(screen.getByRole("status").textContent).toContain("Current output was retained");
    const resetCountBeforeResolution = terminal.reset.mock.calls.length;

    await act(async () => {
      resolvePersistentBuffer!("late history");
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        useTerminalSessionStore.getState().sessions.get("container-1:tab-1")?.serializedBuffer,
      ).toBe("late history");
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
      lastUseTerminalOptions!.onReplay!(new TextEncoder().encode("$ "), {
        preserveExisting: false,
      });
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
    expect(bootstrapWrites()).not.toContain("echo non-first-ready\n");
    act(() => terminalOnData?.(new TextEncoder().encode(output)));
    await waitFor(() => {
      expect(bootstrapWrites()).toContain("echo non-first-ready\n");
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
      />,
    );

    await waitFor(() => expect(terminalKeyHandler).toBeDefined());

    expect(terminalKeyHandler!(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(
      false,
    );
    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("selected text");
    });

    expect(terminalKeyHandler!(new KeyboardEvent("keydown", { key: "a", metaKey: true }))).toBe(
      false,
    );
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

  it("sends Shift+Enter as LF without letting xterm submit the prompt", async () => {
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;

    render(
      <PersistentTerminal
        terminalData={terminalData}
        tabId="tab-1"
        tabType="codex"
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
    const preventDefault = mock(() => {});
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true });
    Object.defineProperty(event, "preventDefault", { value: preventDefault });

    expect(terminalKeyHandler!(event)).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(terminal.input).toHaveBeenCalledWith("\n");
    expect(writeMock).toHaveBeenCalledWith("\n");

    writeMock.mockClear();
    expect(terminalKeyHandler!(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
    expect(writeMock).not.toHaveBeenCalled();
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
      expect(terminalKeyHandler!(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(
        false,
      );
      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith(
          "[PersistentTerminal] Failed to copy selection:",
          expect.objectContaining({ message: "clipboard unavailable" }),
        ),
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

    expect(terminalKeyHandler!(new KeyboardEvent("keyup", { key: "v", metaKey: true }))).toBe(true);
    expect(terminalKeyHandler!(new KeyboardEvent("keydown", { key: "w", metaKey: true }))).toBe(
      false,
    );
    expect(
      terminalKeyHandler!(
        new KeyboardEvent("keydown", { key: "2", code: "Digit2", ctrlKey: true }),
      ),
    ).toBe(false);
    expect(terminalKeyHandler!(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(
      true,
    );
    expect(
      terminalKeyHandler!(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(true);
    expect(
      terminalKeyHandler!(new KeyboardEvent("keydown", { key: "c", metaKey: true, altKey: true })),
    ).toBe(true);

    act(() => {
      expect(terminalKeyHandler!(new KeyboardEvent("keydown", { key: "i", metaKey: true }))).toBe(
        false,
      );
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
    await waitFor(() => expect(bootstrapWrites()).toContain("echo ready\n"), { timeout: 1_000 });

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
    await waitFor(() => expect(bootstrapWrites()).toContain("echo ready\n"), { timeout: 1_000 });
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
      />,
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
      />,
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
      />,
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
      />,
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
      />,
    );

    await waitFor(() => {
      expect(bootstrapWrites()).toContain(
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
      />,
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
      expect(bootstrapWrites()).toContain(
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
        [
          "env-1",
          {
            root: {
              kind: "leaf",
              id: "pane-1",
              tabs: [{ id: "tab-1", type: "claude" }],
              activeTabId: "tab-1",
            },
            activePaneId: "pane-1",
            containerId: null,
          },
        ],
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
      />,
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
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
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
      />,
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
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
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
      />,
    );

    await act(async () => {
      terminalOnData?.(
        new TextEncoder().encode("=== Workspace Setup Failed ===\n=== Workspace Ready ===\n"),
      );
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
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
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
      />,
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
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
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
      />,
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
      />,
    );

    await waitFor(() => {
      expect(useTerminalSessionStore.getState().sessions.get("container-1:tab-1")?.sessionId).toBe(
        "session-1",
      );
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
      />,
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
      />,
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
      />,
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
        environment.id === "env-1" ? { ...environment, setupScriptsComplete: true } : environment,
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
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByText("Mark setup complete") === null).toBe(true);
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
      />,
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
      />,
    );

    let setupWrite: string | undefined;
    await waitFor(() => {
      const writes = bootstrapWrites();
      setupWrite = writes.find(
        (entry: unknown) =>
          typeof entry === "string" && entry.includes("(false && echo ok) && printf"),
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
      />,
    );

    await waitFor(() => {
      const writes = bootstrapWrites();
      expect(
        writes.some(
          (entry: unknown) =>
            typeof entry === "string" &&
            entry.includes("/usr/local/bin/workspace-setup.sh") &&
            entry.includes("setup_done"),
        ),
      ).toBe(true);
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
      />,
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

    expect(useTerminalSessionStore.getState().sessions.get(sessionKey)?.serializedBuffer).toBe(
      durableBuffer,
    );
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
      />,
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

  it("waits for session hydration and paints a saved setup terminal without a live PTY", async () => {
    useTerminalSessionId = null;
    useTerminalIsConnected = false;
    persistentSessionStore.sessionSnapshotGenerations = new Map();
    const hydration = deferred<void>();
    persistentSessionStore.loadSessionsForEnvironment.mockImplementationOnce(
      async () => hydration.promise,
    );
    persistentSessionStore.loadSessionBuffer.mockResolvedValue(
      "saved setup output\r\n\u001b[32m❯\u001b[0m ",
    );
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "saved-setup-session",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
        status: "connected",
        hasLaunchedCommand: false,
        lastActivityAt: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
        order: 0,
      },
    ];
    const terminalData = createTerminalData();
    const terminal = terminalData.terminal as unknown as MockTerminal;
    const props = {
      terminalData,
      tabId: "tab-1",
      tabType: "plain" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: true,
      paneId: "pane-1",
      isSetupTab: true,
    };
    const view = render(<PersistentTerminal {...props} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(persistentSessionStore.loadSessionBuffer).not.toHaveBeenCalled();
    expect(lastUseTerminalOptions?.attachExistingOnly).toBe(true);

    persistentSessionStore.sessionSnapshotGenerations = new Map([["env-1", 1]]);
    await act(async () => {
      hydration.resolve();
      await hydration.promise;
    });

    await waitFor(() => {
      expect(persistentSessionStore.loadSessionBuffer).toHaveBeenCalledWith("saved-setup-session");
      const writes = terminal.write.mock.calls.map(([data]) =>
        data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data),
      );
      expect(writes).toContain("saved setup output\r\n\u001b[32m❯\u001b[0m ");
    });

    // A later checkpoint must not re-clear a terminal that has already painted.
    // Periodic buffer saves keep republishing serializedBuffer, and the direct
    // paint resets the parser, so repeating it would wipe the visible output.
    const resetsAfterPaint = terminal.reset.mock.calls.length;
    act(() => {
      useTerminalSessionStore
        .getState()
        .setSerializedBuffer(
          createSessionKey("container-1", "tab-1", "env-1"),
          "saved setup output\r\nnewer checkpoint\r\n",
        );
    });
    view.rerender(<PersistentTerminal {...props} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(terminal.reset.mock.calls.length).toBe(resetsAfterPaint);
    const writesAfter = terminal.write.mock.calls.map(([data]) =>
      data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data),
    );
    expect(writesAfter).not.toContain("saved setup output\r\nnewer checkpoint\r\n");
  });

  it("marks workspace ready when an asynchronously restored first-tab buffer contains setup completion", async () => {
    const onReady = mock(
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
    );
    persistentSessionStore.loadSessionBuffer.mockImplementation(
      async () => "Container setup completed successfully!\n=== Workspace Ready ===\n",
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
      />,
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
      (_payload: { persistSetupComplete: boolean; workspaceReady?: boolean }) => {},
    );
    persistentSessionStore.loadSessionBuffer.mockImplementation(
      async () => "=== Workspace Setup Failed ===\n=== Workspace Ready ===\n",
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
      />,
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
      />,
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
      />,
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

  it("retries the session list until the store publishes a snapshot", async () => {
    // Everything downstream gates on a successful snapshot newer than the one
    // observed at mount. Without a retry a failed list wedges the terminal for
    // the rest of its mount: no persistent session, so the buffer is never saved.
    persistentSessionStore.sessionSnapshotGenerations = new Map();
    let attempts = 0;
    persistentSessionStore.loadSessionsForEnvironment.mockImplementation(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("list failed");
      }
      persistentSessionStore.sessionSnapshotGenerations = new Map([["env-1", 1]]);
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

    await waitFor(
      () => {
        expect(persistentSessionStore.sessionSnapshotGenerations.has("env-1")).toBe(true);
      },
      { timeout: 3000 },
    );

    // The retry chain stops once a snapshot lands: the next attempt would have
    // been ~500ms after the second call, so a quiet window proves it stopped.
    const callsAtSnapshot = persistentSessionStore.loadSessionsForEnvironment.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(persistentSessionStore.loadSessionsForEnvironment.mock.calls.length).toBe(
      callsAtSnapshot,
    );
  });

  it("does not reuse an old snapshot while the current hydration is pending or failed", async () => {
    persistentSessionStore.sessionSnapshotGenerations = new Map([["env-1", 7]]);
    const initialHydration = deferred<void>();
    let attempts = 0;
    persistentSessionStore.loadSessionsForEnvironment.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        return initialHydration.promise;
      }
      persistentSessionStore.sessionSnapshotGenerations = new Map([["env-1", 8]]);
    });
    persistentSessionStore.getSessionsByEnvironment = () => [
      {
        id: "fresh-persistent-session",
        environmentId: "env-1",
        containerId: "container-1",
        tabId: "tab-1",
        sessionType: "plain",
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
      expect(persistentSessionStore.loadSessionsForEnvironment).toHaveBeenCalledTimes(1);
    });
    expect(persistentSessionStore.createSession).not.toHaveBeenCalled();
    expect(persistentSessionStore.loadSessionBuffer).not.toHaveBeenCalled();

    await act(async () => {
      initialHydration.reject(new Error("fresh list failed"));
      try {
        await initialHydration.promise;
      } catch {
        // The component contains the failure and retries it.
      }
    });

    await waitFor(
      () => {
        expect(persistentSessionStore.loadSessionsForEnvironment).toHaveBeenCalledTimes(2);
        expect(persistentSessionStore.loadSessionBuffer).toHaveBeenCalledWith(
          "fresh-persistent-session",
        );
      },
      { timeout: 3000 },
    );
    expect(persistentSessionStore.createSession).not.toHaveBeenCalled();
  });

  it("stops retrying the session list after unmount", async () => {
    persistentSessionStore.sessionSnapshotGenerations = new Map();
    persistentSessionStore.loadSessionsForEnvironment.mockImplementation(async () => {
      throw new Error("list failed");
    });

    const view = render(
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

    await waitFor(
      () => {
        expect(
          persistentSessionStore.loadSessionsForEnvironment.mock.calls.length,
        ).toBeGreaterThanOrEqual(2);
      },
      { timeout: 3000 },
    );

    view.unmount();
    const callsAtUnmount = persistentSessionStore.loadSessionsForEnvironment.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(persistentSessionStore.loadSessionsForEnvironment.mock.calls.length).toBe(
      callsAtUnmount,
    );
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
      expect(persistentSessionStore.updateSessionStatus).toHaveBeenCalledWith(
        "disconnected-session",
        "connected",
      );
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
      expect(persistentSessionStore.updateSessionActivity).toHaveBeenCalledWith(
        "connected-session",
      );
    });
  });

  it("restores the persistent session identity without a renderer launch latch", async () => {
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
      />,
    );

    await waitFor(() => {
      const sessions = useTerminalSessionStore.getState().sessions;
      const session = sessions.get("container-1:tab-1");
      expect(session?.persistentSessionId).toBe("launched-session-1");
    });
  });

  it("shows Address all for launched review tabs and writes the shared prompt", async () => {
    useTerminalBootstrapped = true;
    useTerminalSessionStore.setState({
      sessions: new Map([["container-1:tab-1", { sessionId: "session-1" }]]),
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
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Address all" }));

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith(ADDRESS_ALL_REVIEW_PROMPT);
      expect(writeMock).toHaveBeenCalledWith("\r");
    });
  });

  it("shows Address all in the same mount after backend bootstrap succeeds", async () => {
    let attempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "bootstrap_terminal_session") return undefined;
      attempts += 1;
      return attempts === 1
        ? { bootstrapped: false, delivered: false, duplicate: false }
        : { bootstrapped: true, delivered: true, duplicate: false };
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
      />,
    );

    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });

    expect(
      await screen.findByRole("button", { name: "Address all" }, { timeout: 2_000 }),
    ).toBeTruthy();
    expect(attempts).toBe(2);
    expect(markBootstrappedMock).toHaveBeenCalledWith("session-1");
  });

  it("retries a rejected bootstrap request and publishes the later success", async () => {
    let attempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "bootstrap_terminal_session") return undefined;
      attempts += 1;
      if (attempts === 1) throw new Error("PTY is still starting");
      return { bootstrapped: true, delivered: true, duplicate: false };
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
      />,
    );
    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });

    await screen.findByRole("button", { name: "Address all" }, { timeout: 2_000 });
    expect(attempts).toBe(2);
    expect(markBootstrappedMock).toHaveBeenCalledWith("session-1");
  });

  it("surfaces a launch warning after bounded unsuccessful bootstrap attempts", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === "bootstrap_terminal_session"
        ? { bootstrapped: false, delivered: false, duplicate: false }
        : undefined,
    );

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
      />,
    );

    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });

    const warning = await screen.findByRole("status", {}, { timeout: 2_000 });
    expect(warning.textContent).toContain("launch command could not start");
    expect(bootstrapWrites()).toHaveLength(3);
    expect(markBootstrappedMock).not.toHaveBeenCalled();
  });

  it("cancels a scheduled bootstrap retry when the terminal unmounts", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === "bootstrap_terminal_session"
        ? { bootstrapped: false, delivered: false, duplicate: false }
        : undefined,
    );

    const view = render(
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
      />,
    );

    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });
    await waitFor(() => expect(bootstrapWrites()).toHaveLength(1));
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(bootstrapWrites()).toHaveLength(1);
    expect(markBootstrappedMock).not.toHaveBeenCalled();
  });

  it("ignores a bootstrap completion from a replaced terminal session", async () => {
    let resolveFirst!: (result: {
      bootstrapped: boolean;
      delivered: boolean;
      duplicate: boolean;
    }) => void;
    let attempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "bootstrap_terminal_session") return undefined;
      attempts += 1;
      if (attempts === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { bootstrapped: true, delivered: true, duplicate: false };
    });

    const props = {
      terminalData: createTerminalData(),
      tabId: "tab-1",
      tabType: "claude" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);
    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });
    await waitFor(() => expect(bootstrapWrites()).toHaveLength(1));

    useTerminalSessionId = "session-2";
    view.rerender(<PersistentTerminal {...props} />);
    await act(async () => {
      resolveFirst({ bootstrapped: true, delivered: true, duplicate: false });
    });

    await waitFor(() => expect(markBootstrappedMock).toHaveBeenCalledWith("session-2"), {
      timeout: 2_000,
    });
    expect(markBootstrappedMock).not.toHaveBeenCalledWith("session-1");
  });

  it("does not re-issue the launch when an equal initialCommands array is cloned", async () => {
    /*
     * Every authoritative pane-layout refresh hands down a fresh copy of
     * `initialCommands`. Depending on that identity re-armed the bootstrap
     * effect while the first request was still in flight, and only the
     * backend's own dedup stopped the command running twice.
     */
    let resolveFirst!: (result: {
      bootstrapped: boolean;
      delivered: boolean;
      duplicate: boolean;
    }) => void;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "bootstrap_terminal_session") return undefined;
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });

    const terminalData = createTerminalData();
    const props = (initialCommands: string[]) => ({
      terminalData,
      tabId: "tab-1",
      tabType: "plain" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      initialCommands,
      paneId: "pane-1",
    });

    const view = render(<PersistentTerminal {...props(["echo ready"])} />);
    act(() => terminalOnData?.(new TextEncoder().encode("workspace $ ")));
    await waitFor(() => expect(bootstrapWrites()).toHaveLength(1));

    // Equal contents, brand new array — exactly what `pane-layout-restore`
    // produces on every refresh.
    view.rerender(<PersistentTerminal {...props(["echo ready"])} />);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(bootstrapWrites()).toEqual(["echo ready\n"]);

    await act(async () => {
      resolveFirst({ bootstrapped: true, delivered: true, duplicate: false });
    });
    await waitFor(() => expect(markBootstrappedMock).toHaveBeenCalledWith("session-1"));
    expect(bootstrapWrites()).toHaveLength(1);
  });

  it("treats a duplicate backend bootstrap as delivered", async () => {
    // The backend answers a repeat request with `delivered: false` because it
    // wrote nothing — but `bootstrapped: true` because the launch is already
    // recorded. Reading `delivered` here would retry a command that ran.
    invokeMock.mockImplementation(async (command: string) =>
      command === "bootstrap_terminal_session"
        ? { bootstrapped: true, delivered: false, duplicate: true }
        : undefined,
    );

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
      />,
    );
    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });

    await waitFor(() => expect(markBootstrappedMock).toHaveBeenCalledWith("session-1"), {
      timeout: 2_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bootstrapWrites()).toHaveLength(1);
    expect(screen.queryByRole("status") === null).toBe(true);
  });

  it("stops retrying once a bootstrap attempt succeeds", async () => {
    let attempts = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== "bootstrap_terminal_session") return undefined;
      attempts += 1;
      return attempts === 1
        ? { bootstrapped: false, delivered: false, duplicate: false }
        : { bootstrapped: true, delivered: true, duplicate: false };
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
        paneId="pane-1"
      />,
    );
    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });

    await waitFor(() => expect(markBootstrappedMock).toHaveBeenCalledWith("session-1"), {
      timeout: 2_000,
    });
    // The bound is three attempts; without a stop the chain would reach it.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(attempts).toBe(2);
    expect(bootstrapWrites()).toHaveLength(2);
    expect(screen.queryByRole("status") === null).toBe(true);
  });

  it("stays quiet when a mid-flight disconnect rejects the bootstrap publish", async () => {
    /*
     * `markBootstrapped` returns false when the terminal disconnected or moved
     * to another session while the request was in flight. The launch itself
     * landed, so there is nothing to warn about — and the reconnect rehydrates
     * `bootstrapped` from the backend.
     */
    markBootstrappedMock.mockImplementation(() => false);
    invokeMock.mockImplementation(async (command: string) =>
      command === "bootstrap_terminal_session"
        ? { bootstrapped: true, delivered: true, duplicate: false }
        : undefined,
    );

    const props = {
      terminalData: createTerminalData(),
      tabId: "tab-1",
      tabType: "claude" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);
    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });

    await waitFor(() => expect(markBootstrappedMock).toHaveBeenCalledWith("session-1"), {
      timeout: 2_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(screen.queryByRole("status") === null).toBe(true);
    expect(bootstrapWrites()).toHaveLength(1);

    // The reconnect reads `bootstrapped` back from the backend session record,
    // so the tab settles without ever launching again.
    useTerminalBootstrapped = true;
    view.rerender(<PersistentTerminal {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bootstrapWrites()).toHaveLength(1);
    expect(screen.queryByRole("status") === null).toBe(true);
  });

  it("clears a stale launch warning when the terminal moves to a new session", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === "bootstrap_terminal_session"
        ? { bootstrapped: false, delivered: false, duplicate: false }
        : undefined,
    );

    const props = {
      terminalData: createTerminalData(),
      tabId: "tab-1",
      tabType: "claude" as const,
      containerId: "container-1",
      environmentId: "env-1",
      isEnvironmentVisible: true,
      isActive: true,
      isFocused: true,
      isFirstTab: false,
      paneId: "pane-1",
    };
    const view = render(<PersistentTerminal {...props} />);
    act(() => {
      terminalOnData?.(new TextEncoder().encode("shell output ".repeat(12)));
    });

    const warning = await screen.findByRole("status", {}, { timeout: 2_000 });
    expect(warning.textContent).toContain("launch command could not start");

    // The warning names a session that no longer exists; leaving it up would
    // report a failure against a terminal that has not tried yet.
    useTerminalSessionId = "session-2";
    view.rerender(<PersistentTerminal {...props} />);
    expect(screen.queryByRole("status") === null).toBe(true);
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
      />,
    );

    await waitFor(() => {
      expect(bootstrapWrites()).toContain("codex\n");
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
      />,
    );

    await waitFor(() => {
      expect(bootstrapWrites()).toContain('codex "Use \\"\\$HOME\\" for the config path"\n');
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
      />,
    );

    await waitFor(() => {
      expect(bootstrapWrites()).toContain('codex "Fix line one\nand line two"\n');
    });
  });
});
