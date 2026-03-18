import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mock(async () => {}),
}));

const resizeMock = mock(async () => {});
const connectMock = mock(async () => {});

mock.module("@/hooks/useTerminal", () => ({
  useTerminal: () => ({
    sessionId: "session-1",
    isConnected: true,
    isConnecting: false,
    error: null,
    connect: connectMock,
    disconnect: mock(async () => {}),
    resize: resizeMock,
    write: mock(async () => {}),
  }),
}));

mock.module("@/hooks/useClaudeState", () => ({
  useClaudeState: () => {},
}));

mock.module("@/hooks/useClipboardImagePaste", () => ({
  useClipboardImagePaste: () => {},
}));

mock.module("@/lib/terminal-paste", () => ({
  handleTerminalPaste: mock(async () => {}),
}));

const sessionStoreState = {
  sessions: new Map<string, {
    sessionId?: string;
    serializedBuffer?: string;
    hasLaunchedCommand?: boolean;
    persistentSessionId?: string;
  }>(),
  setSession: mock(() => {}),
  setSerializedBuffer: mock(() => {}),
  setHasLaunchedCommand: mock(() => {}),
  setPersistentSessionId: mock(() => {}),
};

const useTerminalSessionStoreMock = Object.assign(
  <T,>(selector: (state: typeof sessionStoreState) => T) => selector(sessionStoreState),
  {
    getState: () => sessionStoreState,
  }
);

const configState = {
  config: {
    global: {
      terminalAppearance: {
        fontFamily: "Fira Code",
        fontSize: 14,
        backgroundColor: "#000000",
      },
      terminalScrollback: 5000,
    },
  },
};

const paneLayoutState = {
  setActivePane: mock(() => {}),
};

const environmentState = {
  getEnvironmentById: () => ({ environmentType: "container" as const }),
};

mock.module("@/stores", () => ({
  useTerminalSessionStore: useTerminalSessionStoreMock,
  createSessionKey: (containerId: string | null, tabId: string, environmentId: string) =>
    `${containerId ?? environmentId}:${tabId}`,
  useConfigStore: <T,>(selector: (state: typeof configState) => T) => selector(configState),
  usePaneLayoutStore: <T,>(selector: (state: typeof paneLayoutState) => T) => selector(paneLayoutState),
  useEnvironmentStore: <T,>(selector: (state: typeof environmentState) => T) => selector(environmentState),
}));

const persistentSessionStore = {
  createSession: mock(async () => ({ id: "persistent-1" })),
  updateSessionActivity: mock(async () => {}),
  getSessionsByEnvironment: () => [],
  updateSessionStatus: mock(async () => {}),
  isLoadingEnvironment: () => false,
  loadSessionsForEnvironment: mock(() => {}),
};

mock.module("@/stores/sessionStore", () => ({
  useSessionStore: () => persistentSessionStore,
}));

let storedContainerElement: HTMLDivElement;

const portalStoreActions = {
  markTerminalOpened: mock(() => {}),
  setTerminalContainer: mock(() => {}),
  setTerminalPane: mock(() => {}),
  recreateTerminal: mock(() => null),
};

mock.module("@/stores/terminalPortalStore", () => ({
  createTerminalKey: (environmentId: string, tabId: string) => `${environmentId}::${tabId}`,
  useTerminalPortalStore: <T,>(selector?: (state: {
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
  },
}));

mock.module("@/lib/tauri", () => ({
  loadSessionBuffer: mock(async () => null),
  setSessionHasLaunchedCommand: mock(async () => {}),
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSeparator: () => null,
}));

mock.module("@/components/terminal/ComposeBar", () => ({
  ComposeBar: () => null,
}));

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
    onData: mock(() => ({ dispose: mock(() => {}) })),
    attachCustomKeyEventHandler: mock(() => {}),
    clear: mock(() => {}),
    write: mock(() => {}),
    scrollToBottom: mock(() => {}),
  };
}

/**
 * Creates mock terminal data. Uses structural typing — the mock satisfies the
 * PersistentTerminalData interface shape without importing the real xterm types.
 */
function createTerminalData() {
  storedContainerElement = document.createElement("div");
  const xtermNode = document.createElement("div");
  xtermNode.className = "xterm";
  storedContainerElement.appendChild(xtermNode);

  return {
    tabId: "tab-1",
    containerId: "container-1",
    environmentId: "env-1",
    terminal: createMockTerminal(),
    fitAddon: { fit: mock(() => {}) },
    serializeAddon: { serialize: mock(() => "") },
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
    portalStoreActions.markTerminalOpened.mockClear();
    portalStoreActions.setTerminalContainer.mockClear();
    portalStoreActions.setTerminalPane.mockClear();
    portalStoreActions.recreateTerminal.mockClear();
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
});
