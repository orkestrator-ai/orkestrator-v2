import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";

// Mock modules that require a real Tauri runtime or have side effects.
// IMPORTANT: Do NOT mock @/stores (barrel) or @/lib/tauri here — doing so
// pollutes the Bun module cache and breaks other test files that share
// those modules.  Instead we use the real stores with controlled state and
// let @/lib/tauri fall through to the global @tauri-apps/api/core mock
// registered in tests/setup.ts.

// @tauri-apps/plugin-clipboard-manager is centrally mocked in tests/setup.ts.
// @/hooks/useClipboardImagePaste is NOT mocked — it loads the real module
// whose clipboard dependencies are satisfied by the central mock above.

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

mock.module("@/hooks/useAgentState", () => ({
  useAgentState: () => {},
}));

// @/lib/terminal-paste is NOT mocked — let the real module load.
// Its dependencies (@tauri-apps/plugin-clipboard-manager and
// @/hooks/useClipboardImagePaste) are centrally mocked in tests/setup.ts.

// --- Stores that need custom mock behavior (unique paths, no conflicts) ---

const persistentSessionStore = {
  createSession: mock(async () => ({ id: "persistent-1" })),
  updateSessionActivity: mock(async () => {}),
  getSessionsByEnvironment: () => [],
  updateSessionStatus: mock(async () => {}),
  isLoadingEnvironment: () => false,
  loadSessionsForEnvironment: mock(async () => {}),
  // Functions used by useEnvironments.ts (must be present to avoid undefined errors)
  disconnectEnvironmentSessions: mock(async () => {}),
  deleteSessionsByEnvironment: mock(async () => {}),
  deleteSession: mock(async () => {}),
  saveSessionBuffer: mock(async () => {}),
  loadSessionBuffer: mock(async () => null),
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

// --- Real stores: import directly and control via setState in beforeEach ---
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";

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
