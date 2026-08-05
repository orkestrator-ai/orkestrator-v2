import { createSessionKey } from "@/lib/utils";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TabInfo } from "@/types/paneLayout";

const closeLocalTerminalSession = mock(async (_sessionId: string) => {});
const detachTerminal = mock(async (_sessionId: string) => {});
const updateSessionStatus = mock(async (_sessionId: string, _status: string) => ({}));
const teardownTab = mock(async (_input: unknown) => ({ completed: true }));
const stopTmuxSession = mock(async (_tabId: string, _environmentId?: string) => {});
const deleteClaudeSession = mock(async (_client: unknown, _sessionId: string) => true);
const deleteCodexSession = mock(async (_client: unknown, _sessionId: string) => true);
const deleteOpenCodeSession = mock(async (_client: unknown, _sessionId: string) => true);
const deleteAgentHandoff = mock(
  async (_handoffId: string, _environmentId: string) => true,
);
const getAgentHandoff = mock(async (_handoffId: string) => null);
const pruneAgentHandoffs = mock(
  async (_environmentId: string, _referencedHandoffIds: string[]) => [] as string[],
);
let consoleDebugSpy: ReturnType<typeof spyOn> | undefined;
let consoleErrorSpy: ReturnType<typeof spyOn> | undefined;
const originalOrkestrator = window.orkestrator;

const realBackend = await import("@/lib/backend");
const realBackendSnapshot = { ...realBackend };
const realClaudeTmuxClient = await import("@/lib/claude-tmux-client");
const realClaudeTmuxClientSnapshot = { ...realClaudeTmuxClient };
const realClaudeClient = await import("@/lib/claude-client");
const realClaudeClientSnapshot = { ...realClaudeClient };
const realCodexClient = await import("@/lib/codex-client");
const realCodexClientSnapshot = { ...realCodexClient };
const realOpenCodeClient = await import("@/lib/opencode-client");
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  closeLocalTerminalSession,
  detachTerminal,
  createSession: mock(async () => ({})),
  updateSessionStatus,
  teardownTab,
  updateSessionActivity: mock(async () => ({})),
  deleteSession: mock(async () => {}),
  deleteSessionsByEnvironment: mock(async () => []),
  disconnectEnvironmentSessions: mock(async () => {}),
  getSessionsByEnvironment: mock(async () => []),
  saveSessionBuffer: mock(async () => {}),
  loadSessionBuffer: mock(async () => null),
  deleteAgentHandoff,
  getAgentHandoff,
  pruneAgentHandoffs,
  syncSessionsWithContainer: mock(async () => []),
  renameSession: mock(async () => ({})),
  reorderSessions: mock(async () => []),
  openInBrowser: mock(async () => {}),
}));

mock.module("@/lib/claude-tmux-client", () => ({
  ...realClaudeTmuxClientSnapshot,
  stopSession: stopTmuxSession,
}));

mock.module("@/lib/claude-client", () => ({
  ...realClaudeClientSnapshot,
  deleteSession: deleteClaudeSession,
}));

mock.module("@/lib/codex-client", () => ({
  ...realCodexClientSnapshot,
  deleteSession: deleteCodexSession,
}));

mock.module("@/lib/opencode-client", () => ({
  ...realOpenCodeClientSnapshot,
  deleteSession: deleteOpenCodeSession,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/claude-tmux-client", () => realClaudeTmuxClientSnapshot);
  mock.module("@/lib/claude-client", () => realClaudeClientSnapshot);
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
});

afterEach(() => {
  window.orkestrator = originalOrkestrator;
  consoleDebugSpy?.mockRestore();
  consoleErrorSpy?.mockRestore();
  consoleDebugSpy = undefined;
  consoleErrorSpy = undefined;
});

const { getAllLeaves, usePaneLayoutStore } = await import("./paneLayoutStore");
const {
  loadAgentHandoff,
  rememberAgentHandoff,
  resetAgentHandoffCache,
} = await import("@/lib/agent-handoff");
const { useTerminalSessionStore, createSessionKey: createTerminalSessionKey } = await import("./terminalSessionStore");
const { useClaudeStore } = await import("./claudeStore");
const { useCodexStore } = await import("./codexStore");
const { useOpenCodeStore } = await import("./openCodeStore");
const { useEnvironmentStore } = await import("./environmentStore");
const {
  createTerminalKey,
  useTerminalPortalStore,
} = await import("./terminalPortalStore");
const {
  createClaudeTmuxStateKey,
  useClaudeTmuxStore,
} = await import("./claudeTmuxStore");

function resetStores() {
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useTerminalSessionStore.setState({
    sessions: new Map(),
    composeDraftText: new Map(),
    composeDraftImages: new Map(),
  });
  useClaudeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    messageQueue: new Map(),
  });
  useCodexStore.setState({
    clients: new Map(),
    sessions: new Map(),
    messageQueue: new Map(),
  });
  useOpenCodeStore.setState({
    clients: new Map(),
    sessions: new Map(),
    messageQueue: new Map(),
  });
  useEnvironmentStore.setState({
  });
  useTerminalPortalStore.setState({
    paneHosts: new Map(),
    terminals: new Map(),
  });
  useClaudeTmuxStore.setState({
    tabs: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
    effortLevels: new Map(),
  });
  resetAgentHandoffCache();

  closeLocalTerminalSession.mockClear();
  detachTerminal.mockClear();
  updateSessionStatus.mockClear();
  teardownTab.mockClear();
  teardownTab.mockImplementation(async () => ({ completed: true }));
  stopTmuxSession.mockClear();
  deleteClaudeSession.mockClear();
  deleteCodexSession.mockClear();
  deleteOpenCodeSession.mockClear();
  deleteAgentHandoff.mockClear();
  getAgentHandoff.mockClear();
  pruneAgentHandoffs.mockClear();
  deleteAgentHandoff.mockImplementation(async () => true);
  getAgentHandoff.mockImplementation(async () => null);
}

function seedSingleTabEnvironment(
  environmentId: string,
  containerId: string | null,
  tab: Pick<TabInfo, "id" | "type"> & Partial<TabInfo>,
) {
  usePaneLayoutStore.setState({
    activeEnvironmentId: environmentId,
    environments: new Map([
      [
        environmentId,
        {
          containerId,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [tab as any],
            activeTabId: tab.id,
          },
        },
      ],
    ]),
  });
}

function seedPaneTree(
  root: any,
  activePaneId: string,
  environmentId = "env-pane",
) {
  usePaneLayoutStore.setState({
    activeEnvironmentId: environmentId,
    environments: new Map([
      [environmentId, {
        containerId: null,
        activePaneId,
        root,
      }],
    ]),
  });
}

describe("paneLayoutStore tab cleanup", () => {
  beforeEach(() => {
    resetStores();
  });

  test("closing a local terminal tab records backend teardown intent", () => {
    seedSingleTabEnvironment("env-local", null, { id: "tab-terminal", type: "plain" });
    const sessionKey = createTerminalSessionKey(null, "tab-terminal", "env-local");
    useTerminalSessionStore.getState().setSession(sessionKey, { sessionId: "pty-local" });

    usePaneLayoutStore.getState().removeTab("default", "tab-terminal");

    expect(teardownTab).toHaveBeenCalledWith({
      environmentId: "env-local",
      tabId: "tab-terminal",
      kind: "terminal",
      sessionId: "pty-local",
      persistentSessionId: undefined,
    });
    expect(useTerminalSessionStore.getState().sessions.has(sessionKey)).toBe(false);
  });

  test("closing a terminal tab includes its persistent session in teardown intent", () => {
    seedSingleTabEnvironment("env-local", null, { id: "tab-terminal", type: "plain" });
    const sessionKey = createTerminalSessionKey(null, "tab-terminal", "env-local");
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "pty-local",
      persistentSessionId: "persistent-1",
    });

    usePaneLayoutStore.getState().removeTab("default", "tab-terminal");

    expect(teardownTab).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "pty-local",
      persistentSessionId: "persistent-1",
    }));
  });

  test("closing a container terminal tab delegates detachment to the backend", () => {
    seedSingleTabEnvironment("env-container", "container-1", { id: "tab-terminal", type: "plain" });
    const sessionKey = createTerminalSessionKey("container-1", "tab-terminal", "env-container");
    useTerminalSessionStore.getState().setSession(sessionKey, { sessionId: "pty-container" });

    usePaneLayoutStore.getState().removeTab("default", "tab-terminal");

    expect(teardownTab).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env-container",
      sessionId: "pty-container",
      kind: "terminal",
    }));
  });

  test("closing a Claude tmux tab records backend teardown intent", () => {
    seedSingleTabEnvironment("env-local", null, { id: "tab-tmux", type: "claude-tmux" });

    usePaneLayoutStore.getState().removeTab("default", "tab-tmux");

    expect(teardownTab).toHaveBeenCalledWith({
      environmentId: "env-local",
      tabId: "tab-tmux",
      kind: "claude-tmux",
    });
  });

  test("closing a browser tab destroys its main-process preview", () => {
    const destroy = mock(async () => {});
    window.orkestrator = {
      browserPreview: { destroy },
    } as never;
    seedSingleTabEnvironment("env-browser", null, { id: "browser-tab", type: "browser" });

    usePaneLayoutStore.getState().removeTab("default", "browser-tab");

    expect(destroy).toHaveBeenCalledWith("browser-tab");
  });

  test("logs browser-preview destruction failures after removing local state", async () => {
    consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const destroy = mock(async () => { throw new Error("destroy failed"); });
    window.orkestrator = { browserPreview: { destroy } } as never;
    seedSingleTabEnvironment("env-browser", null, { id: "browser-tab", type: "browser" });

    usePaneLayoutStore.getState().removeTab("default", "browser-tab");
    await Promise.resolve();

    expect(usePaneLayoutStore.getState().getAllTabs("env-browser")).toEqual([]);
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      "[PaneLayout] Error destroying browser preview:",
      expect.objectContaining({ message: "destroy failed" }),
    );
  });

  test("deletes and evicts an unreferenced handoff when its tab is explicitly closed", async () => {
    seedSingleTabEnvironment("env-handoff", null, {
      id: "handoff-tab",
      type: "plain",
      agentHandoffId: "handoff-1",
    });
    rememberAgentHandoff({ id: "handoff-1" } as never);

    usePaneLayoutStore.getState().removeTab("default", "handoff-tab", "env-handoff");

    expect(deleteAgentHandoff).toHaveBeenCalledWith("handoff-1", "env-handoff");
    await expect(loadAgentHandoff("handoff-1")).resolves.toBeNull();
    expect(getAgentHandoff).toHaveBeenCalledWith("handoff-1");
  });

  test("does not call handoff deletion for a tab without a handoff", () => {
    seedSingleTabEnvironment("env-plain", null, {
      id: "plain-tab",
      type: "plain",
    });

    usePaneLayoutStore.getState().removeTab("default", "plain-tab", "env-plain");

    expect(deleteAgentHandoff).not.toHaveBeenCalled();
  });

  test("retains a handoff until its last referencing tab is closed", () => {
    usePaneLayoutStore.setState({
      activeEnvironmentId: "env-shared",
      environments: new Map([[
        "env-shared",
        {
          containerId: null,
          activePaneId: "default",
          root: {
            kind: "leaf",
            id: "default",
            tabs: [
              { id: "first", type: "plain", agentHandoffId: "handoff-shared" },
              { id: "second", type: "plain", agentHandoffId: "handoff-shared" },
            ],
            activeTabId: "first",
          },
        },
      ]]),
    } as never);

    usePaneLayoutStore.getState().removeTab("default", "first", "env-shared");
    expect(deleteAgentHandoff).not.toHaveBeenCalled();

    usePaneLayoutStore.getState().removeTab("default", "second", "env-shared");
    expect(deleteAgentHandoff).toHaveBeenCalledTimes(1);
    expect(deleteAgentHandoff).toHaveBeenCalledWith("handoff-shared", "env-shared");
  });

  test("deletes only unreferenced handoffs when a whole pane is closed", () => {
    seedPaneTree({
      kind: "split",
      id: "split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "closing",
          tabs: [
            { id: "unique", type: "plain", agentHandoffId: "handoff-unique" },
            { id: "shared-left", type: "plain", agentHandoffId: "handoff-shared" },
          ],
          activeTabId: "unique",
        },
        {
          kind: "leaf",
          id: "remaining",
          tabs: [
            { id: "shared-right", type: "plain", agentHandoffId: "handoff-shared" },
          ],
          activeTabId: "shared-right",
        },
      ],
    }, "closing", "env-close-pane");

    usePaneLayoutStore.getState().closePane("closing", "env-close-pane");

    expect(deleteAgentHandoff).toHaveBeenCalledTimes(1);
    expect(deleteAgentHandoff).toHaveBeenCalledWith("handoff-unique", "env-close-pane");
  });

  test("keeps tab removal successful when handoff deletion fails", async () => {
    consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});
    deleteAgentHandoff.mockRejectedValueOnce(new Error("storage unavailable"));
    seedSingleTabEnvironment("env-handoff", null, {
      id: "handoff-tab",
      type: "plain",
      agentHandoffId: "handoff-1",
    });

    usePaneLayoutStore.getState().removeTab("default", "handoff-tab", "env-handoff");
    await Promise.resolve();

    expect(usePaneLayoutStore.getState().getAllTabs("env-handoff")).toEqual([]);
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      "[PaneLayout] Error deleting agent handoff:",
      expect.objectContaining({ message: "storage unavailable" }),
    );
  });

  test("closing native agent tabs delegates provider cleanup to the backend", () => {
    const tabs = [
      { id: "claude-tab", type: "claude-native" },
      { id: "codex-tab", type: "codex-native" },
      { id: "opencode-tab", type: "opencode-native" },
    ];
    usePaneLayoutStore.setState({
      activeEnvironmentId: "env-native",
      environments: new Map([
        [
          "env-native",
          {
            containerId: null,
            activePaneId: "default",
            root: {
              kind: "leaf",
              id: "default",
              tabs: tabs as any,
              activeTabId: "claude-tab",
            },
          },
        ],
      ]),
    });

    const claudeKey = createSessionKey("env-native", "claude-tab");
    useClaudeStore.getState().setClient("env-native", {} as any);
    useClaudeStore.getState().setSession(claudeKey, {
      sessionId: "claude-session",
      messages: [],
      isLoading: true,
    });

    const codexKey = createSessionKey("env-native", "codex-tab");
    useCodexStore.getState().setClient("env-native", {} as any);
    useCodexStore.getState().setSession(codexKey, {
      sessionId: "codex-session",
      messages: [],
      isLoading: true,
    });

    const openCodeKey = createSessionKey("env-native", "opencode-tab");
    useOpenCodeStore.getState().setClient("env-native", {} as any);
    useOpenCodeStore.getState().setSession(openCodeKey, {
      sessionId: "opencode-session",
      messages: [],
      isLoading: true,
    });

    usePaneLayoutStore.getState().removeTab("default", "claude-tab");
    usePaneLayoutStore.getState().removeTab("default", "codex-tab");
    usePaneLayoutStore.getState().removeTab("default", "opencode-tab");

    expect(teardownTab).toHaveBeenCalledWith({
      environmentId: "env-native", tabId: "claude-tab", kind: "claude-native", sessionId: "claude-session",
    });
    expect(teardownTab).toHaveBeenCalledWith({
      environmentId: "env-native", tabId: "codex-tab", kind: "codex-native", sessionId: "codex-session",
    });
    expect(teardownTab).toHaveBeenCalledWith({
      environmentId: "env-native", tabId: "opencode-tab", kind: "opencode-native", sessionId: "opencode-session",
    });
    expect(useClaudeStore.getState().sessions.has(claudeKey)).toBe(false);
    expect(useCodexStore.getState().sessions.has(codexKey)).toBe(false);
    expect(useOpenCodeStore.getState().sessions.has(openCodeKey)).toBe(false);
  });

  test("reset cleans up all tab resources for the environment", () => {
    const destroy = mock(async () => {});
    window.orkestrator = { browserPreview: { destroy } } as never;
    usePaneLayoutStore.setState({
      activeEnvironmentId: "env-reset",
      environments: new Map([
        [
          "env-reset",
          {
            containerId: null,
            activePaneId: "default",
            root: {
              kind: "leaf",
              id: "default",
              tabs: [
                { id: "terminal-tab", type: "plain" },
                { id: "tmux-tab", type: "claude-tmux" },
                { id: "codex-tab", type: "codex-native" },
                { id: "browser-tab", type: "browser" },
              ] as any,
              activeTabId: "terminal-tab",
            },
          },
        ],
      ]),
    });
    const terminalKey = createTerminalSessionKey(null, "terminal-tab", "env-reset");
    useTerminalSessionStore.getState().setSession(terminalKey, { sessionId: "pty-reset" });
    const codexKey = createSessionKey("env-reset", "codex-tab");
    useCodexStore.getState().setClient("env-reset", {} as any);
    useCodexStore.getState().setSession(codexKey, {
      sessionId: "codex-session",
      messages: [],
      isLoading: false,
    });

    usePaneLayoutStore.getState().reset("env-reset");

    expect(teardownTab).toHaveBeenCalledTimes(3);
    expect(teardownTab).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env-reset", tabId: "terminal-tab", sessionId: "pty-reset",
    }));
    expect(teardownTab).toHaveBeenCalledWith({
      environmentId: "env-reset", tabId: "tmux-tab", kind: "claude-tmux",
    });
    expect(teardownTab).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env-reset", tabId: "codex-tab", sessionId: "codex-session",
    }));
    expect(destroy).toHaveBeenCalledWith("browser-tab");
    expect(usePaneLayoutStore.getState().getAllTabs("env-reset")).toEqual([]);
  });

  test("closing a populated pane cleans up every resource in that pane", () => {
    const destroy = mock(async () => {});
    window.orkestrator = { browserPreview: { destroy } } as never;
    seedPaneTree({
      kind: "split",
      id: "split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "closing-pane",
          tabs: [
            { id: "browser-tab", type: "browser" },
            { id: "terminal-tab", type: "plain" },
          ],
          activeTabId: "browser-tab",
        },
        {
          kind: "leaf",
          id: "remaining-pane",
          tabs: [{ id: "remaining-tab", type: "plain" }],
          activeTabId: "remaining-tab",
        },
      ],
    }, "closing-pane", "env-close-pane");
    const terminalKey = createTerminalSessionKey(null, "terminal-tab", "env-close-pane");
    useTerminalSessionStore.getState().setSession(terminalKey, { sessionId: "pty-close-pane" });
    const terminalDispose = mock(() => {});
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey("env-close-pane", "terminal-tab"),
        {
          environmentId: "env-close-pane",
          tabId: "terminal-tab",
          terminal: { dispose: terminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });

    usePaneLayoutStore.getState().closePane("closing-pane", "env-close-pane");

    expect(destroy).toHaveBeenCalledWith("browser-tab");
    expect(teardownTab).toHaveBeenCalledWith(expect.objectContaining({
      environmentId: "env-close-pane", tabId: "terminal-tab", sessionId: "pty-close-pane",
    }));
    expect(useTerminalSessionStore.getState().sessions.has(terminalKey)).toBe(false);
    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(
      useTerminalPortalStore.getState().hasTerminal("env-close-pane", "terminal-tab"),
    ).toBe(false);
    expect(usePaneLayoutStore.getState().getRoot("env-close-pane")).toMatchObject({
      kind: "leaf",
      id: "remaining-pane",
    });
    expect(usePaneLayoutStore.getState().getActivePaneId("env-close-pane")).toBe("remaining-pane");
  });

  test("removing the last tab in the root pane keeps an empty leaf", () => {
    seedSingleTabEnvironment("env-root", null, { id: "tab-only", type: "plain" });

    usePaneLayoutStore.getState().removeTab("default", "tab-only");

    const envState = usePaneLayoutStore.getState().environments.get("env-root");
    expect(envState).toBeDefined();
    const root = envState!.root as { kind: "leaf"; id: string; tabs: unknown[]; activeTabId: string | null };
    expect(root.kind).toBe("leaf");
    expect(root.id).toBe("default");
    expect(root.tabs).toEqual([]);
    expect(root.activeTabId).toBeNull();
  });

  test("clears local and native state when asynchronous cleanup operations reject", async () => {
    consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    const tabs = [
      { id: "terminal-tab", type: "plain" },
      { id: "tmux-tab", type: "claude-tmux" },
      { id: "claude-tab", type: "claude-native" },
      { id: "codex-tab", type: "codex-native" },
      { id: "opencode-tab", type: "opencode-native" },
    ];
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs,
      activeTabId: "terminal-tab",
    }, "default", "env-cleanup-errors");

    const terminalKey = createTerminalSessionKey(null, "terminal-tab", "env-cleanup-errors");
    useTerminalSessionStore.getState().setSession(terminalKey, {
      sessionId: "pty-cleanup-errors",
      persistentSessionId: "persistent-cleanup-errors",
    });

    const claudeKey = createSessionKey("env-cleanup-errors", "claude-tab");
    useClaudeStore.getState().setClient("env-cleanup-errors", {} as any);
    useClaudeStore.getState().setSession(claudeKey, {
      sessionId: "claude-cleanup-errors",
      messages: [],
      isLoading: true,
    });

    const codexKey = createSessionKey("env-cleanup-errors", "codex-tab");
    useCodexStore.getState().setClient("env-cleanup-errors", {} as any);
    useCodexStore.getState().setSession(codexKey, {
      sessionId: "codex-cleanup-errors",
      messages: [],
      isLoading: true,
    });

    const openCodeKey = createSessionKey("env-cleanup-errors", "opencode-tab");
    useOpenCodeStore.getState().setClient("env-cleanup-errors", {} as any);
    useOpenCodeStore.getState().setSession(openCodeKey, {
      sessionId: "opencode-cleanup-errors",
      messages: [],
      isLoading: true,
    });

    teardownTab.mockRejectedValue(new Error("backend teardown unavailable"));

    const store = usePaneLayoutStore.getState();
    for (const tab of tabs) {
      store.removeTab("default", tab.id, "env-cleanup-errors");
    }
    await Promise.resolve();

    expect(usePaneLayoutStore.getState().getAllTabs("env-cleanup-errors")).toEqual([]);
    expect(useTerminalSessionStore.getState().sessions.has(terminalKey)).toBe(false);
    expect(useClaudeStore.getState().sessions.has(claudeKey)).toBe(false);
    expect(useCodexStore.getState().sessions.has(codexKey)).toBe(false);
    expect(useOpenCodeStore.getState().sessions.has(openCodeKey)).toBe(false);
    expect(consoleDebugSpy).toHaveBeenCalled();
  });

  test("closing a native tab drops its drafts and selections, not just its session", () => {
    /**
     * Cleanup used to call `clearQueue` + `setSession(null)` only, leaving the
     * draft, model and attachments behind. Tab ids are UUIDs, so those entries
     * were never reclaimed for the life of the process.
     */
    const tabs = [
      { id: "claude-tab", type: "claude-native" },
      { id: "codex-tab", type: "codex-native" },
      { id: "opencode-tab", type: "opencode-native" },
    ];
    seedPaneTree(
      { kind: "leaf", id: "default", tabs, activeTabId: "claude-tab" },
      "default",
      "env-leak",
    );

    const claudeKey = createSessionKey("env-leak", "claude-tab");
    const codexKey = createSessionKey("env-leak", "codex-tab");
    const openCodeKey = createSessionKey("env-leak", "opencode-tab");

    useClaudeStore.getState().setDraftText(claudeKey, "claude draft");
    useClaudeStore.getState().setSelectedModel(claudeKey, "opus");
    useCodexStore.getState().setDraftText(codexKey, "codex draft");
    useCodexStore.getState().setSelectedModel(codexKey, "gpt-5");
    useOpenCodeStore.getState().setDraftText(openCodeKey, "opencode draft");
    useOpenCodeStore.getState().setSelectedModel(openCodeKey, "gpt-5");

    const store = usePaneLayoutStore.getState();
    for (const tab of tabs) {
      store.removeTab("default", tab.id, "env-leak");
    }

    expect(useClaudeStore.getState().getDraftText(claudeKey)).toBe("");
    expect(useClaudeStore.getState().selectedModel.has(claudeKey)).toBe(false);
    expect(useCodexStore.getState().getDraftText(codexKey)).toBe("");
    expect(useCodexStore.getState().selectedModel.has(codexKey)).toBe(false);
    expect(useOpenCodeStore.getState().getDraftText(openCodeKey)).toBe("");
    expect(useOpenCodeStore.getState().selectedModel.has(openCodeKey)).toBe(false);
  });

  test("clears setup state and closes a child pane when its last tab is removed", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "setup-pane",
          tabs: [{ id: "setup-tab", type: "plain", isSetupTab: true }],
          activeTabId: "setup-tab",
        },
        {
          kind: "leaf",
          id: "remaining-pane",
          tabs: [{ id: "remaining-tab", type: "plain" }],
          activeTabId: "remaining-tab",
        },
      ],
    }, "setup-pane", "env-setup-close");

    usePaneLayoutStore.getState().removeTab("setup-pane", "setup-tab", "env-setup-close");

    expect(usePaneLayoutStore.getState().getRoot("env-setup-close")).toMatchObject({
      kind: "leaf",
      id: "remaining-pane",
    });
  });

  test("clears setup state when the root pane's last setup tab is removed", () => {
    // The root leaf has no parent split, so removeTab empties it in place
    // instead of delegating to closePane. That branch owns the flag reset.
    const terminalDispose = mock(() => {});
    seedSingleTabEnvironment("env-setup-root", null, {
      id: "setup-tab",
      type: "plain",
      isSetupTab: true,
    });
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey("env-setup-root", "setup-tab"),
        {
          environmentId: "env-setup-root",
          tabId: "setup-tab",
          terminal: { dispose: terminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });

    usePaneLayoutStore.getState().removeTab("default", "setup-tab", "env-setup-root");

    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(
      useTerminalPortalStore.getState().hasTerminal("env-setup-root", "setup-tab"),
    ).toBe(false);
    expect(usePaneLayoutStore.getState().getRoot("env-setup-root")).toMatchObject({
      kind: "leaf",
      id: "default",
      tabs: [],
      activeTabId: null,
    });
  });

  test("clears setup state when a setup tab is removed from a pane with other tabs", () => {
    const terminalDispose = mock(() => {});
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "setup-tab", type: "plain", isSetupTab: true },
        { id: "other-tab", type: "plain" },
      ],
      activeTabId: "setup-tab",
    }, "default", "env-setup-siblings");
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey("env-setup-siblings", "setup-tab"),
        {
          environmentId: "env-setup-siblings",
          tabId: "setup-tab",
          terminal: { dispose: terminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });

    usePaneLayoutStore.getState().removeTab(
      "default",
      "setup-tab",
      "env-setup-siblings",
    );

    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(
      useTerminalPortalStore.getState().hasTerminal("env-setup-siblings", "setup-tab"),
    ).toBe(false);
    expect(usePaneLayoutStore.getState().getRoot("env-setup-siblings")).toMatchObject({
      kind: "leaf",
      id: "default",
      tabs: [{ id: "other-tab" }],
      activeTabId: "other-tab",
    });
  });

  test("closing a pane clears setup state when it held the tree's last setup tab", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "closing",
          tabs: [
            { id: "plain-tab", type: "plain" },
            { id: "setup-tab", type: "plain", isSetupTab: true },
          ],
          activeTabId: "setup-tab",
        },
        {
          kind: "leaf",
          id: "remaining",
          tabs: [{ id: "remaining-tab", type: "plain" }],
          activeTabId: "remaining-tab",
        },
      ],
    }, "closing", "env-close-last-setup");

    usePaneLayoutStore.getState().closePane("closing", "env-close-last-setup");

  });

  test("closing a pane keeps setup state while another pane still runs setup", () => {
    // Setup scripts can be split across panes; the flag is environment-wide, so
    // it may only clear once the last setup tab in the tree is gone.
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "closing",
          tabs: [{ id: "setup-closing", type: "plain", isSetupTab: true }],
          activeTabId: "setup-closing",
        },
        {
          kind: "leaf",
          id: "remaining",
          tabs: [{ id: "setup-remaining", type: "plain", isSetupTab: true }],
          activeTabId: "setup-remaining",
        },
      ],
    }, "closing", "env-close-other-setup");

    usePaneLayoutStore.getState().closePane("closing", "env-close-other-setup");

    expect(usePaneLayoutStore.getState().getRoot("env-close-other-setup")).toMatchObject({
      kind: "leaf",
      id: "remaining",
    });
  });

  test("destroys a sole child browser preview only once", () => {
    const destroy = mock(async () => undefined);
    window.orkestrator = { browserPreview: { destroy } } as never;
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "closing",
          tabs: [{ id: "browser", type: "browser" }],
          activeTabId: "browser",
        },
        {
          kind: "leaf",
          id: "remaining",
          tabs: [{ id: "file", type: "file" }],
          activeTabId: "file",
        },
      ],
    }, "closing", "env-browser-once");

    usePaneLayoutStore.getState().removeTab(
      "closing",
      "browser",
      "env-browser-once",
    );

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith("browser");
  });

  test("records a sole child tmux teardown only once", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "closing",
          tabs: [{ id: "tmux", type: "claude-tmux" }],
          activeTabId: "tmux",
        },
        {
          kind: "leaf",
          id: "remaining",
          tabs: [{ id: "file", type: "file" }],
          activeTabId: "file",
        },
      ],
    }, "closing", "env-tmux-once");

    usePaneLayoutStore.getState().removeTab(
      "closing",
      "tmux",
      "env-tmux-once",
    );

    expect(teardownTab).toHaveBeenCalledTimes(1);
    expect(teardownTab).toHaveBeenCalledWith({
      environmentId: "env-tmux-once", tabId: "tmux", kind: "claude-tmux",
    });
  });
});

describe("paneLayoutStore authoritative cleanup", () => {
  beforeEach(() => {
    resetStores();
  });

  test("reclaims removed renderer resources and closes a PTY owned by this renderer", () => {
    const environmentId = "env-authoritative";
    const containerId = "container-authoritative";
    const tabs = [
      { id: "removed-terminal", type: "plain", isSetupTab: true },
      { id: "removed-browser", type: "browser", browserData: { url: "http://localhost:3000" } },
      { id: "removed-tmux", type: "claude-tmux" },
      { id: "removed-claude", type: "claude-native" },
      { id: "removed-codex", type: "codex-native" },
      { id: "removed-opencode", type: "opencode-native" },
      { id: "retained-terminal", type: "plain" },
    ] as TabInfo[];
    seedPaneTree({
      kind: "leaf",
      id: "old-pane",
      tabs,
      activeTabId: "removed-terminal",
    }, "old-pane", environmentId);
    usePaneLayoutStore.setState((state) => {
      const environments = new Map(state.environments);
      environments.set(environmentId, {
        ...environments.get(environmentId)!,
        containerId,
      });
      return {
        environments,
        hydration: new Map([[environmentId, "done"]]),
      };
    });

    const removedTerminalKey = createTerminalSessionKey(
      containerId,
      "removed-terminal",
      environmentId,
    );
    const retainedTerminalKey = createTerminalSessionKey(
      containerId,
      "retained-terminal",
      environmentId,
    );
    const terminalStore = useTerminalSessionStore.getState();
    terminalStore.setSession(removedTerminalKey, {
      sessionId: "pty-removed",
      persistentSessionId: "persistent-removed",
    });
    terminalStore.setComposeDraftText(removedTerminalKey, "discard me");
    terminalStore.setSession(retainedTerminalKey, { sessionId: "pty-retained" });

    const removedTerminalDispose = mock(() => {});
    const retainedTerminalDispose = mock(() => {});
    const portalElement = () => document.createElement("div");
    useTerminalPortalStore.setState({
      terminals: new Map([
        [
          createTerminalKey(environmentId, "removed-terminal"),
          {
            environmentId,
            tabId: "removed-terminal",
            terminal: { dispose: removedTerminalDispose },
            portalElement: portalElement(),
          } as never,
        ],
        [
          createTerminalKey(environmentId, "retained-terminal"),
          {
            environmentId,
            tabId: "retained-terminal",
            terminal: { dispose: retainedTerminalDispose },
            portalElement: portalElement(),
          } as never,
        ],
      ]),
    });

    const seedNativeSession = (
      tabId: string,
      sessionId: string,
      store: typeof useClaudeStore | typeof useCodexStore | typeof useOpenCodeStore,
    ) => {
      const sessionKey = createSessionKey(environmentId, tabId);
      store.getState().setClient(environmentId, {} as never);
      store.getState().setSession(sessionKey, {
        sessionId,
        messages: [],
        isLoading: true,
      });
      store.getState().setDraftText(sessionKey, "discard me");
      store.getState().setSelectedModel(sessionKey, "model");
      return sessionKey;
    };
    const claudeKey = seedNativeSession(
      "removed-claude",
      "claude-session",
      useClaudeStore,
    );
    const codexKey = seedNativeSession(
      "removed-codex",
      "codex-session",
      useCodexStore,
    );
    const openCodeKey = seedNativeSession(
      "removed-opencode",
      "opencode-session",
      useOpenCodeStore,
    );

    const scopedTmuxKey = createClaudeTmuxStateKey(environmentId, "removed-tmux");
    const tmuxStore = useClaudeTmuxStore.getState();
    tmuxStore.setRunning(scopedTmuxKey, true, {
      environmentId,
      sessionId: "tmux-session",
    });
    tmuxStore.setDraftText(scopedTmuxKey, "discard me");
    tmuxStore.setRunning("removed-tmux", true, {
      environmentId,
      sessionId: "legacy-tmux-session",
    });

    const destroy = mock(async () => {});
    window.orkestrator = { browserPreview: { destroy } } as never;

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
      containerId,
      activePaneId: "new-pane",
      root: {
        kind: "leaf",
        id: "new-pane",
        tabs: [{ id: "retained-terminal", type: "plain" }],
        activeTabId: "retained-terminal",
      },
    });

    expect(usePaneLayoutStore.getState().getAllTabs(environmentId)).toEqual([
      { id: "retained-terminal", type: "plain" },
    ]);
    expect(useTerminalSessionStore.getState().sessions.has(removedTerminalKey)).toBe(false);
    expect(useTerminalSessionStore.getState().getComposeDraftText(removedTerminalKey)).toBe("");
    expect(useTerminalSessionStore.getState().sessions.has(retainedTerminalKey)).toBe(true);
    expect(removedTerminalDispose).toHaveBeenCalledTimes(1);
    expect(retainedTerminalDispose).not.toHaveBeenCalled();
    expect(useTerminalPortalStore.getState().hasTerminal(
      environmentId,
      "removed-terminal",
    )).toBe(false);
    expect(useTerminalPortalStore.getState().hasTerminal(
      environmentId,
      "retained-terminal",
    )).toBe(true);
    expect(destroy).toHaveBeenCalledWith("removed-browser");
    expect(useClaudeStore.getState().sessions.has(claudeKey)).toBe(false);
    expect(useCodexStore.getState().sessions.has(codexKey)).toBe(false);
    expect(useOpenCodeStore.getState().sessions.has(openCodeKey)).toBe(false);
    expect(useClaudeStore.getState().getDraftText(claudeKey)).toBe("");
    expect(useCodexStore.getState().getDraftText(codexKey)).toBe("");
    expect(useOpenCodeStore.getState().getDraftText(openCodeKey)).toBe("");
    expect(useClaudeTmuxStore.getState().getTab(scopedTmuxKey).running).toBe(false);
    expect(useClaudeTmuxStore.getState().getDraftText(scopedTmuxKey)).toBe("");
    expect(useClaudeTmuxStore.getState().getTab("removed-tmux").running).toBe(false);

    expect(teardownTab).toHaveBeenCalledWith(expect.objectContaining({
      environmentId,
      tabId: "removed-terminal",
      sessionId: "pty-removed",
      persistentSessionId: "persistent-removed",
    }));
    expect(stopTmuxSession).not.toHaveBeenCalled();
    expect(deleteClaudeSession).not.toHaveBeenCalled();
    expect(deleteCodexSession).not.toHaveBeenCalled();
    expect(deleteOpenCodeSession).not.toHaveBeenCalled();
    expect(deleteAgentHandoff).not.toHaveBeenCalled();
  });

  test("records a locally owned PTY teardown after authoritative tab removal", () => {
    const environmentId = "env-authoritative-local-pty";
    seedSingleTabEnvironment(environmentId, null, {
      id: "terminal",
      type: "plain",
    });
    usePaneLayoutStore.setState({ hydration: new Map([[environmentId, "done"]]) });
    const sessionKey = createTerminalSessionKey(null, "terminal", environmentId);
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "pty-local-authoritative",
      persistentSessionId: "persistent-local-authoritative",
    });

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [],
        activeTabId: null,
      },
    });

    expect(teardownTab).toHaveBeenCalledWith(expect.objectContaining({
      environmentId,
      tabId: "terminal",
      sessionId: "pty-local-authoritative",
      persistentSessionId: "persistent-local-authoritative",
    }));
    expect(useTerminalSessionStore.getState().sessions.has(sessionKey)).toBe(false);
  });

  test("authoritative removal evicts only handoffs with no remaining tab reference", async () => {
    const environmentId = "env-authoritative-handoffs";
    const uniqueHandoff = { id: "handoff-unique" };
    const sharedHandoff = { id: "handoff-shared" };
    rememberAgentHandoff(uniqueHandoff as never);
    rememberAgentHandoff(sharedHandoff as never);
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        {
          id: "unique",
          type: "plain",
          agentHandoffId: uniqueHandoff.id,
        },
        {
          id: "shared-removed",
          type: "plain",
          agentHandoffId: sharedHandoff.id,
        },
        {
          id: "shared-retained",
          type: "plain",
          agentHandoffId: sharedHandoff.id,
        },
      ],
      activeTabId: "unique",
    }, "default", environmentId);
    usePaneLayoutStore.setState({ hydration: new Map([[environmentId, "done"]]) });

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{
          id: "shared-retained",
          type: "plain",
          agentHandoffId: sharedHandoff.id,
        }],
        activeTabId: "shared-retained",
      },
    });

    await expect(loadAgentHandoff(uniqueHandoff.id)).resolves.toBeNull();
    await expect(loadAgentHandoff(sharedHandoff.id)).resolves.toBe(
      sharedHandoff as never,
    );
    expect(getAgentHandoff).toHaveBeenCalledTimes(1);
    expect(getAgentHandoff).toHaveBeenCalledWith(uniqueHandoff.id);
    expect(deleteAgentHandoff).not.toHaveBeenCalled();
    expect(pruneAgentHandoffs).toHaveBeenCalledWith(
      environmentId,
      [sharedHandoff.id],
    );
  });

  test("authoritative handoff replacement evicts the old retained-tab cache entry", async () => {
    const environmentId = "env-authoritative-handoff-replacement";
    const oldHandoff = { id: "handoff-old" };
    const newHandoff = { id: "handoff-new" };
    rememberAgentHandoff(oldHandoff as never);
    rememberAgentHandoff(newHandoff as never);
    seedSingleTabEnvironment(environmentId, null, {
      id: "retained-tab",
      type: "plain",
      agentHandoffId: oldHandoff.id,
    });
    usePaneLayoutStore.setState({
      hydration: new Map([[environmentId, "done"]]),
    });

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{
          id: "retained-tab",
          type: "plain",
          agentHandoffId: newHandoff.id,
        }],
        activeTabId: "retained-tab",
      },
    });

    await expect(loadAgentHandoff(oldHandoff.id)).resolves.toBeNull();
    await expect(loadAgentHandoff(newHandoff.id)).resolves.toBe(
      newHandoff as never,
    );
    expect(getAgentHandoff).toHaveBeenCalledTimes(1);
    expect(getAgentHandoff).toHaveBeenCalledWith(oldHandoff.id);
  });

  test("preserves resources for a tab moved to another pane", () => {
    const environmentId = "env-authoritative-move";
    seedPaneTree({
      kind: "split",
      id: "old-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "old-left",
          tabs: [{ id: "moving", type: "plain" }],
          activeTabId: "moving",
        },
        {
          kind: "leaf",
          id: "old-right",
          tabs: [{ id: "other", type: "file" }],
          activeTabId: "other",
        },
      ],
    }, "old-left", environmentId);
    usePaneLayoutStore.setState({ hydration: new Map([[environmentId, "done"]]) });
    const sessionKey = createTerminalSessionKey(null, "moving", environmentId);
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "pty-moving",
    });
    const terminalDispose = mock(() => {});
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey(environmentId, "moving"),
        {
          environmentId,
          tabId: "moving",
          terminal: { dispose: terminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
      containerId: null,
      activePaneId: "new-right",
      root: {
        kind: "leaf",
        id: "new-right",
        tabs: [
          { id: "other", type: "file" },
          { id: "moving", type: "plain" },
        ],
        activeTabId: "moving",
      },
    });

    expect(useTerminalSessionStore.getState().sessions.has(sessionKey)).toBe(true);
    expect(useTerminalPortalStore.getState().hasTerminal(environmentId, "moving")).toBe(true);
    expect(terminalDispose).not.toHaveBeenCalled();
    expect(closeLocalTerminalSession).not.toHaveBeenCalled();
    expect(detachTerminal).not.toHaveBeenCalled();
  });

  test("keeps setup state when the authoritative layout still holds a setup tab", () => {
    const environmentId = "env-authoritative-setup-retained";
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "setup-removed", type: "plain", isSetupTab: true },
        { id: "setup-retained", type: "plain", isSetupTab: true },
      ],
      activeTabId: "setup-removed",
    }, "default", environmentId);
    usePaneLayoutStore.setState({ hydration: new Map([[environmentId, "done"]]) });

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "setup-retained", type: "plain", isSetupTab: true }],
        activeTabId: "setup-retained",
      },
    });

    expect(
      usePaneLayoutStore.getState().getAllTabs(environmentId).map((tab) => tab.id),
    ).toEqual(["setup-retained"]);
  });

  test("disposes the portal terminal for removed tab types with no other cleanup", () => {
    // `file` and `looped-review` match none of the type branches, so the
    // unconditional portal disposal is the only reclaim they get.
    const environmentId = "env-authoritative-plain-types";
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "file-tab", type: "file", fileData: { filePath: "/repo/a.ts" } },
        { id: "review-tab", type: "looped-review" },
      ],
      activeTabId: "file-tab",
    }, "default", environmentId);
    usePaneLayoutStore.setState({ hydration: new Map([[environmentId, "done"]]) });
    const fileDispose = mock(() => {});
    const reviewDispose = mock(() => {});
    useTerminalPortalStore.setState({
      terminals: new Map([
        [
          createTerminalKey(environmentId, "file-tab"),
          {
            environmentId,
            tabId: "file-tab",
            terminal: { dispose: fileDispose },
            portalElement: document.createElement("div"),
          } as never,
        ],
        [
          createTerminalKey(environmentId, "review-tab"),
          {
            environmentId,
            tabId: "review-tab",
            terminal: { dispose: reviewDispose },
            portalElement: document.createElement("div"),
          } as never,
        ],
      ]),
    });

    expect(() => {
      usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [],
          activeTabId: null,
        },
      });
    }).not.toThrow();

    expect(fileDispose).toHaveBeenCalledTimes(1);
    expect(reviewDispose).toHaveBeenCalledTimes(1);
    expect(useTerminalPortalStore.getState().hasTerminal(environmentId, "file-tab"))
      .toBe(false);
    expect(useTerminalPortalStore.getState().hasTerminal(environmentId, "review-tab"))
      .toBe(false);
    expect(usePaneLayoutStore.getState().getAllTabs(environmentId)).toEqual([]);
    expect(closeLocalTerminalSession).not.toHaveBeenCalled();
    expect(detachTerminal).not.toHaveBeenCalled();
    expect(stopTmuxSession).not.toHaveBeenCalled();
  });

  test("does not clean up or install an authoritative layout before hydration", () => {
    const environmentId = "env-authoritative-pending";
    seedSingleTabEnvironment(environmentId, null, {
      id: "existing",
      type: "plain",
    });
    usePaneLayoutStore.setState({ hydration: new Map([[environmentId, "pending"]]) });
    const sessionKey = createTerminalSessionKey(null, "existing", environmentId);
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "pty-existing",
    });
    const originalRoot = usePaneLayoutStore.getState().getRoot(environmentId);
    const replacement = {
      containerId: null,
      activePaneId: "replacement",
      root: {
        kind: "leaf" as const,
        id: "replacement",
        tabs: [],
        activeTabId: null,
      },
    };

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, replacement);
    usePaneLayoutStore.getState().applyAuthoritativeLayout("missing-env", replacement);

    expect(usePaneLayoutStore.getState().getRoot(environmentId)).toBe(originalRoot);
    expect(useTerminalSessionStore.getState().sessions.has(sessionKey)).toBe(true);
    expect(closeLocalTerminalSession).not.toHaveBeenCalled();
    expect(detachTerminal).not.toHaveBeenCalled();
    expect(pruneAgentHandoffs).not.toHaveBeenCalled();
  });

  test("contains browser cleanup failures while installing the authoritative layout", async () => {
    const environmentId = "env-authoritative-browser-error";
    consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const destroy = mock(async () => {
      throw new Error("destroy failed");
    });
    window.orkestrator = { browserPreview: { destroy } } as never;
    seedSingleTabEnvironment(environmentId, null, {
      id: "browser",
      type: "browser",
    });
    usePaneLayoutStore.setState({ hydration: new Map([[environmentId, "done"]]) });

    usePaneLayoutStore.getState().applyAuthoritativeLayout(environmentId, {
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [],
        activeTabId: null,
      },
    });
    await Promise.resolve();

    expect(usePaneLayoutStore.getState().getAllTabs(environmentId)).toEqual([]);
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      "[PaneLayout] Error destroying browser preview:",
      expect.objectContaining({ message: "destroy failed" }),
    );
  });
});

describe("paneLayoutStore environment scoping", () => {
  beforeEach(() => {
    resetStores();
  });

  test("initializes a hidden environment without changing the active environment", () => {
    const store = usePaneLayoutStore.getState();

    store.setActiveEnvironment("env-visible");
    store.initialize("container-visible", "env-visible");
    store.initialize("container-hidden", "env-hidden");

    const state = usePaneLayoutStore.getState();
    expect(state.activeEnvironmentId).toBe("env-visible");
    expect(state.environments.get("env-visible")?.containerId).toBe("container-visible");
    expect(state.environments.get("env-hidden")?.containerId).toBe("container-hidden");
  });

  test("updates tabs for an explicit environment even when another environment is active", () => {
    const store = usePaneLayoutStore.getState();

    store.initialize("container-a", "env-a");
    store.initialize("container-b", "env-b");
    store.addTab("default", { id: "a-1", type: "plain" }, "env-a");
    store.addTab("default", { id: "a-2", type: "claude" }, "env-a");
    store.addTab("default", { id: "b-1", type: "plain" }, "env-b");
    store.setActiveEnvironment("env-b");

    store.setActiveTab("default", "a-1", "env-a");

    const envA = usePaneLayoutStore.getState().environments.get("env-a");
    expect(envA?.root.kind).toBe("leaf");
    if (!envA || envA.root.kind !== "leaf") {
      throw new Error("env-a root should be a leaf");
    }

    expect(envA.root.activeTabId).toBe("a-1");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });

  test("reads environment-scoped getters without relying on the active environment", () => {
    const store = usePaneLayoutStore.getState();

    store.initialize("container-a", "env-a");
    store.initialize("container-b", "env-b");
    store.addTab("default", {
      id: "file-a",
      type: "file",
      fileData: {
        filePath: "/tmp/env-a.txt",
        isLocalEnvironment: true,
      },
    }, "env-a");
    store.addTab("default", { id: "plain-b", type: "plain" }, "env-b");
    store.setActiveEnvironment("env-b");

    expect(store.getContainerId("env-a")).toBe("container-a");
    expect(store.getAllTabs("env-a").map((tab) => tab.id)).toEqual(["file-a"]);
    expect(store.getOpenFilePaths("env-a")).toEqual(["/tmp/env-a.txt"]);
    expect(store.findPaneWithTab("file-a", "env-a")?.id).toBe("default");
    expect(store.getPane("default", "env-a")?.id).toBe("default");
    expect(store.getActivePane("env-a")?.activeTabId).toBe("file-a");
    expect(store.getRoot("env-a").kind).toBe("leaf");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });

  test("writes and clears native session ids on the owning tab", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.addTab("default", {
      id: "claude-a",
      type: "claude-native",
      claudeNativeData: {
        environmentId: "env-a",
        containerId: "container-a",
      },
    }, "env-a");

    store.updateTabNativeSessionId("claude-a", "session-1", "env-a");
    expect(usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.claudeNativeData?.sessionId).toBe("session-1");

    usePaneLayoutStore.getState().updateTabNativeSessionId("claude-a", undefined, "env-a");
    expect(usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.claudeNativeData?.sessionId).toBeUndefined();
  });

  test("persists browser addresses on the owning environment only", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.initialize("container-b", "env-b");
    store.addTab("default", {
      id: "browser-a",
      type: "browser",
      browserData: { url: "" },
    }, "env-a");
    store.addTab("default", { id: "plain-b", type: "plain" }, "env-b");
    store.setActiveEnvironment("env-b");

    store.updateTabBrowserUrl("browser-a", "http://localhost:3000/", "env-a");

    expect(usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.browserData?.url).toBe(
      "http://localhost:3000/",
    );
    expect(usePaneLayoutStore.getState().getAllTabs("env-b")).toEqual([
      { id: "plain-b", type: "plain" },
    ]);
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });

  test("bounds persisted browser history and rebases its cursor", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.addTab("default", {
      id: "browser-a",
      type: "browser",
      browserData: { url: "" },
    }, "env-a");
    const history = Array.from({ length: 125 }, (_, index) => `http://localhost/${index}`);

    store.updateTabBrowserUrl("browser-a", history[120]!, "env-a", history, 120);

    const data = usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.browserData;
    expect(data?.history).toHaveLength(100);
    expect(data?.history?.[0]).toBe("http://localhost/25");
    expect(data?.historyIndex).toBe(95);
  });

  test("clamps malformed browser cursors to the bounded history", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.addTab("default", {
      id: "browser-a",
      type: "browser",
      browserData: { url: "" },
    }, "env-a");

    store.updateTabBrowserUrl("browser-a", "b", "env-a", ["a", "b"], 99);
    expect(usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.browserData?.historyIndex).toBe(1);

    store.updateTabBrowserUrl("browser-a", "a", "env-a", ["a", "b"], -10);
    expect(usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.browserData?.historyIndex).toBe(0);
  });

  test("updates browser addresses through the active environment fallback", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.addTab("default", {
      id: "browser-a",
      type: "browser",
      browserData: { url: "" },
    }, "env-a");
    store.setActiveEnvironment("env-a");

    usePaneLayoutStore.getState().updateTabBrowserUrl("browser-a", "http://localhost:3000/");
    expect(usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.browserData?.url).toBe(
      "http://localhost:3000/",
    );
  });

  test("ignores unchanged, missing, and non-browser URL updates", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.addTab("default", {
      id: "browser-a",
      type: "browser",
      browserData: { url: "http://localhost:3000/" },
    }, "env-a");
    store.addTab("default", { id: "plain-a", type: "plain" }, "env-a");
    store.setActiveEnvironment("env-a");
    const originalEnvironments = usePaneLayoutStore.getState().environments;

    store.updateTabBrowserUrl("browser-a", "http://localhost:3000/", "env-a");
    store.updateTabBrowserUrl("missing", "http://localhost:4000/", "env-a");
    store.updateTabBrowserUrl("plain-a", "http://localhost:4000/", "env-a");
    store.updateTabBrowserUrl("browser-a", "http://localhost:4000/", "missing-env");

    expect(usePaneLayoutStore.getState().environments).toBe(originalEnvironments);
    expect(usePaneLayoutStore.getState().getAllTabs("env-a")[0]?.browserData?.url).toBe(
      "http://localhost:3000/",
    );
  });

  test("installs restored state and completes hydration", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.beginHydration("env-a");
    const restored = {
      containerId: "container-a",
      activePaneId: "restored",
      root: {
        kind: "leaf" as const,
        id: "restored",
        tabs: [{ id: "restored-tab", type: "plain" as const }],
        activeTabId: "restored-tab",
      },
    };

    usePaneLayoutStore.getState().finishHydration("env-a", restored);

    expect(usePaneLayoutStore.getState().hydration.get("env-a")).toBe("done");
    expect(usePaneLayoutStore.getState().environments.get("env-a")).toEqual(restored);
    usePaneLayoutStore.getState().beginHydration("env-a");
    expect(usePaneLayoutStore.getState().hydration.get("env-a")).toBe("done");
  });

  test("preserves and focuses a tab added before late hydration begins", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize(null, "env-pending-tab");
    store.addTab("default", {
      id: "build-pipeline-1",
      type: "claude-build",
      buildTabData: {
        pipelineId: "pipeline-1",
        environmentId: "env-pending-tab",
        taskId: "task-1",
        isLocal: true,
      },
    }, "env-pending-tab");
    // TerminalContainer can mount after the build handoff. Its hydration must
    // merge, not replace, the tab that was created in that undefined state.
    store.beginHydration("env-pending-tab");

    store.finishHydration("env-pending-tab", {
      containerId: null,
      activePaneId: "restored",
      root: {
        kind: "leaf",
        id: "restored",
        tabs: [{ id: "restored-tab", type: "plain" }],
        activeTabId: "restored-tab",
      },
    });

    const hydrated = usePaneLayoutStore
      .getState()
      .environments.get("env-pending-tab");
    expect(hydrated?.activePaneId).toBe("restored");
    expect(hydrated && getAllLeaves(hydrated.root)[0]?.tabs.map((tab) => tab.id))
      .toEqual(["restored-tab", "build-pipeline-1"]);
    expect(hydrated && getAllLeaves(hydrated.root)[0]?.activeTabId)
      .toBe("build-pipeline-1");
  });

  test("updates Codex and OpenCode session ids and ignores unsupported or unchanged updates", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-a");
    store.addTab("default", {
      id: "codex",
      type: "codex-native",
      codexNativeData: { environmentId: "env-a" },
    }, "env-a");
    store.addTab("default", {
      id: "opencode",
      type: "opencode-native",
      openCodeNativeData: { environmentId: "env-a" },
    }, "env-a");
    store.addTab("default", { id: "plain", type: "plain" }, "env-a");

    store.updateTabNativeSessionId("codex", "codex-1", "env-a");
    usePaneLayoutStore.getState().updateTabNativeSessionId("opencode", "open-1", "env-a");
    expect(usePaneLayoutStore.getState().getAllTabs("env-a")).toMatchObject([
      { codexNativeData: { sessionId: "codex-1" } },
      { openCodeNativeData: { sessionId: "open-1" } },
      { id: "plain" },
    ]);

    const beforeNoOps = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().updateTabNativeSessionId("codex", "codex-1", "env-a");
    usePaneLayoutStore.getState().updateTabNativeSessionId("plain", "ignored", "env-a");
    usePaneLayoutStore.getState().updateTabNativeSessionId("missing", "ignored", "env-a");
    expect(usePaneLayoutStore.getState().environments).toBe(beforeNoOps);
  });

  test("sets and resets a hidden environment without changing the active environment", () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-a", {
          root: {
            kind: "leaf",
            id: "pane-a",
            tabs: [{ id: "tab-a", type: "plain" }],
            activeTabId: "tab-a",
          },
          activePaneId: "stale-pane",
          containerId: "container-a",
        }],
        ["env-b", {
          root: {
            kind: "leaf",
            id: "default",
            tabs: [{ id: "tab-b", type: "plain" }],
            activeTabId: "tab-b",
          },
          activePaneId: "default",
          containerId: "container-b",
        }],
      ]),
      activeEnvironmentId: "env-b",
    });

    const store = usePaneLayoutStore.getState();
    store.setActivePane("pane-a", "env-a");

    expect(usePaneLayoutStore.getState().environments.get("env-a")?.activePaneId).toBe("pane-a");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");

    store.reset("env-a");

    const envA = usePaneLayoutStore.getState().environments.get("env-a");
    expect(envA?.containerId).toBeNull();
    expect(envA?.activePaneId).toBe("default");
    expect(envA?.root.kind).toBe("leaf");
    if (!envA || envA.root.kind !== "leaf") {
      throw new Error("env-a root should be reset to a leaf");
    }

    expect(envA.root.tabs).toEqual([]);
    expect(envA.root.activeTabId).toBeNull();
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });

  test("removes a tab from an explicit environment without touching the active environment", () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-a", {
          root: {
            kind: "leaf",
            id: "pane-a",
            tabs: [
              { id: "tab-a-1", type: "plain" },
              { id: "tab-a-2", type: "plain" },
            ],
            activeTabId: "tab-a-2",
          },
          activePaneId: "pane-a",
          containerId: "container-a",
        }],
        ["env-b", {
          root: {
            kind: "leaf",
            id: "pane-b",
            tabs: [{ id: "tab-b", type: "plain" }],
            activeTabId: "tab-b",
          },
          activePaneId: "pane-b",
          containerId: "container-b",
        }],
      ]),
      activeEnvironmentId: "env-b",
    });

    usePaneLayoutStore.getState().removeTab("pane-a", "tab-a-2", "env-a");

    const envA = usePaneLayoutStore.getState().environments.get("env-a");
    expect(envA?.root.kind).toBe("leaf");
    if (!envA || envA.root.kind !== "leaf") {
      throw new Error("env-a root should be a leaf");
    }
    expect(envA.root.tabs.map((tab) => tab.id)).toEqual(["tab-a-1"]);
    expect(envA.root.activeTabId).toBe("tab-a-1");
    expect(usePaneLayoutStore.getState().environments.get("env-b")?.activePaneId).toBe("pane-b");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });

  test("moves a tab inside an explicit environment without relying on the active environment", () => {
    usePaneLayoutStore.setState({
      environments: new Map([
        ["env-a", {
          root: {
            kind: "split",
            id: "split-a",
            direction: "horizontal",
            sizes: [50, 50],
            depth: 1,
            children: [
              {
                kind: "leaf",
                id: "pane-a-left",
                tabs: [
                  { id: "tab-a", type: "plain" },
                  { id: "tab-a-left-other", type: "plain" },
                ],
                activeTabId: "tab-a",
              },
              {
                kind: "leaf",
                id: "pane-a-right",
                tabs: [{ id: "tab-a-right", type: "plain" }],
                activeTabId: "tab-a-right",
              },
            ],
          },
          activePaneId: "pane-a-left",
          containerId: "container-a",
        }],
        ["env-b", {
          root: {
            kind: "leaf",
            id: "pane-b",
            tabs: [{ id: "tab-b", type: "plain" }],
            activeTabId: "tab-b",
          },
          activePaneId: "pane-b",
          containerId: "container-b",
        }],
      ]),
      activeEnvironmentId: "env-b",
    });

    usePaneLayoutStore
      .getState()
      .moveTab("pane-a-left", "pane-a-right", "tab-a", undefined, "env-a");

    const envA = usePaneLayoutStore.getState().environments.get("env-a");
    expect(envA?.root.kind).toBe("split");
    if (!envA || envA.root.kind !== "split") {
      throw new Error("env-a root should be a split");
    }
    const rightPane = envA.root.children[1];
    expect(rightPane.kind).toBe("leaf");
    if (rightPane.kind !== "leaf") {
      throw new Error("right pane should be a leaf");
    }
    expect(rightPane.tabs.map((tab) => tab.id)).toEqual(["tab-a-right", "tab-a"]);
    expect(envA.activePaneId).toBe("pane-a-right");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-b");
  });
});

describe("paneLayoutStore splitting", () => {
  beforeEach(() => {
    resetStores();
  });

  test.each([
    ["left", "horizontal", 0],
    ["right", "horizontal", 1],
    ["top", "vertical", 0],
    ["bottom", "vertical", 1],
  ] as const)("moves a tab into a same-pane %s edge split", (edge, direction, newPaneIndex) => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "tab-one", type: "plain" },
        { id: "tab-two", type: "plain" },
      ],
      activeTabId: "tab-two",
    }, "default", "env-split");

    usePaneLayoutStore.getState().splitPaneAtEdge(
      "default",
      edge,
      "tab-two",
      "default",
      "env-split",
    );

    const root = usePaneLayoutStore.getState().getRoot("env-split");
    expect(root.kind).toBe("split");
    if (root.kind !== "split") {
      throw new Error("root should be split");
    }

    expect(root.direction).toBe(direction);
    expect(root.children[newPaneIndex]).toMatchObject({
      kind: "leaf",
      tabs: [{ id: "tab-two" }],
      activeTabId: "tab-two",
    });
    expect(root.children[newPaneIndex === 0 ? 1 : 0]).toMatchObject({
      kind: "leaf",
      id: "default",
      tabs: [{ id: "tab-one" }],
    });
  });

  test("moves a tab across panes and preserves the non-empty source pane", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "source",
          tabs: [
            { id: "source-stays", type: "plain" },
            { id: "tab-moving", type: "plain" },
          ],
          activeTabId: "tab-moving",
        },
        {
          kind: "leaf",
          id: "target",
          tabs: [{ id: "target-tab", type: "plain" }],
          activeTabId: "target-tab",
        },
      ],
    }, "source", "env-cross-split");

    usePaneLayoutStore.getState().splitPaneAtEdge(
      "target",
      "top",
      "tab-moving",
      "source",
      "env-cross-split",
    );

    const root = usePaneLayoutStore.getState().getRoot("env-cross-split");
    expect(root.kind).toBe("split");
    if (root.kind !== "split") throw new Error("root should remain split");
    expect(root.children[0]).toMatchObject({
      kind: "leaf",
      id: "source",
      tabs: [{ id: "source-stays" }],
      activeTabId: "source-stays",
    });
    expect(root.children[1]).toMatchObject({
      kind: "split",
      direction: "vertical",
      children: [
        { kind: "leaf", tabs: [{ id: "tab-moving" }] },
        { kind: "leaf", id: "target", tabs: [{ id: "target-tab" }] },
      ],
    });
  });

  test("closes an emptied source pane after a cross-pane split", async () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "source",
          tabs: [{ id: "tab-moving", type: "plain" }],
          activeTabId: "tab-moving",
        },
        {
          kind: "leaf",
          id: "target",
          tabs: [{ id: "target-tab", type: "plain" }],
          activeTabId: "target-tab",
        },
      ],
    }, "source", "env-empty-source");

    usePaneLayoutStore.getState().splitPaneAtEdge(
      "target",
      "right",
      "tab-moving",
      "source",
      "env-empty-source",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const root = usePaneLayoutStore.getState().getRoot("env-empty-source");
    expect(root.kind).toBe("split");
    expect(getAllLeaves(root).map((leaf) => leaf.id)).not.toContain("source");
    expect(getAllLeaves(root).flatMap((leaf) => leaf.tabs.map((tab) => tab.id))).toEqual([
      "target-tab",
      "tab-moving",
    ]);
  });

  test("does not split when the tree has reached the maximum depth", () => {
    let root: any = {
      kind: "leaf",
      id: "deep-target",
      tabs: [
        { id: "tab-one", type: "plain" },
        { id: "tab-two", type: "plain" },
      ],
      activeTabId: "tab-two",
    };
    for (let depth = 1; depth <= 9; depth += 1) {
      root = {
        kind: "split",
        id: `split-${depth}`,
        direction: "horizontal",
        sizes: [50, 50],
        depth,
        children: [
          root,
          {
            kind: "leaf",
            id: `filler-${depth}`,
            tabs: [],
            activeTabId: null,
          },
        ],
      };
    }
    seedPaneTree(root, "deep-target", "env-max-depth");

    const store = usePaneLayoutStore.getState();
    store.splitPaneAtEdge(
      "deep-target",
      "right",
      "tab-two",
      "deep-target",
      "env-max-depth",
    );
    store.splitPane("deep-target", "horizontal", "tab-two", "env-max-depth");

    expect(usePaneLayoutStore.getState().getRoot("env-max-depth")).toBe(root);
  });

  test("leaves state unchanged for missing environments, panes, and tabs", () => {
    const storeWithoutEnvironment = usePaneLayoutStore.getState();
    storeWithoutEnvironment.splitPaneAtEdge("target", "right", "tab", "source");
    storeWithoutEnvironment.splitPaneAtEdge("target", "right", "tab", "source", "missing-env");

    seedSingleTabEnvironment("env-invalid-split", null, { id: "tab-one", type: "plain" });
    const store = usePaneLayoutStore.getState();
    const originalRoot = store.getRoot("env-invalid-split");

    store.splitPaneAtEdge("missing-target", "right", "tab-one", "default", "env-invalid-split");
    store.splitPaneAtEdge("default", "right", "tab-one", "missing-source", "env-invalid-split");
    store.splitPaneAtEdge("default", "right", "missing-tab", "default", "env-invalid-split");

    expect(usePaneLayoutStore.getState().getRoot("env-invalid-split")).toBe(originalRoot);
  });
});

describe("paneLayoutStore pane and tab actions", () => {
  beforeEach(() => {
    resetStores();
  });

  test("returns default getters and ignores initialization without an environment", () => {
    const store = usePaneLayoutStore.getState();

    store.initialize(null);
    store.reset();

    expect(store.getRoot()).toEqual({
      kind: "leaf",
      id: "default",
      tabs: [],
      activeTabId: null,
    });
    expect(store.getActivePaneId()).toBe("default");
    expect(store.getContainerId()).toBeNull();
    expect(store.getActivePane()?.id).toBe("default");
  });

  test("activates an existing tab instead of adding a duplicate", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [{ id: "left-tab", type: "plain" }],
          activeTabId: "left-tab",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [
            { id: "right-tab", type: "plain" },
            { id: "existing-tab", type: "plain" },
          ],
          activeTabId: "right-tab",
        },
      ],
    }, "left", "env-duplicate");

    usePaneLayoutStore.getState().addTab(
      "left",
      { id: "existing-tab", type: "plain" },
      "env-duplicate",
    );

    const store = usePaneLayoutStore.getState();
    expect(store.getAllTabs("env-duplicate").filter((tab) => tab.id === "existing-tab")).toHaveLength(1);
    expect(store.getPane("right", "env-duplicate")?.activeTabId).toBe("existing-tab");
    expect(store.getActivePaneId("env-duplicate")).toBe("right");
    expect(store.getPane("missing-pane", "env-duplicate")).toBeNull();
    expect(store.findPaneWithTab("missing-tab", "env-duplicate")).toBeNull();
  });

  test("reorders tabs and ignores invalid indexes", () => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "tab-a", type: "plain" },
        { id: "tab-b", type: "plain" },
        { id: "tab-c", type: "plain" },
      ],
      activeTabId: "tab-a",
    }, "default", "env-reorder");

    const store = usePaneLayoutStore.getState();
    store.reorderTabs("default", 0, 2, "env-reorder");
    expect(store.getAllTabs("env-reorder").map((tab) => tab.id)).toEqual(["tab-b", "tab-c", "tab-a"]);

    store.reorderTabs("default", -1, 0, "env-reorder");
    store.reorderTabs("default", 0, 3, "env-reorder");
    store.reorderTabs("default", 0.5, 1, "env-reorder");
    expect(store.getAllTabs("env-reorder").map((tab) => tab.id)).toEqual(["tab-b", "tab-c", "tab-a"]);
  });

  test("moves tabs within a pane and inserts at a requested cross-pane index", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [
            { id: "tab-a", type: "plain" },
            { id: "tab-b", type: "plain" },
            { id: "tab-c", type: "plain" },
          ],
          activeTabId: "tab-c",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [
            { id: "tab-x", type: "plain" },
            { id: "tab-y", type: "plain" },
          ],
          activeTabId: "tab-x",
        },
      ],
    }, "left", "env-indexed-move");

    const store = usePaneLayoutStore.getState();
    store.moveTab("left", "left", "tab-c", 0, "env-indexed-move");
    expect(store.getPane("left", "env-indexed-move")?.tabs.map((tab) => tab.id)).toEqual([
      "tab-c",
      "tab-a",
      "tab-b",
    ]);

    store.moveTab("left", "right", "tab-b", 1, "env-indexed-move");
    expect(store.getPane("left", "env-indexed-move")?.tabs.map((tab) => tab.id)).toEqual([
      "tab-c",
      "tab-a",
    ]);
    expect(store.getPane("right", "env-indexed-move")?.tabs.map((tab) => tab.id)).toEqual([
      "tab-x",
      "tab-b",
      "tab-y",
    ]);
  });

  test("collapses an emptied source pane after moving its last tab", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [{ id: "tab-moving", type: "plain" }],
          activeTabId: "tab-moving",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [{ id: "tab-target", type: "plain" }],
          activeTabId: "tab-target",
        },
      ],
    }, "left", "env-empty-move");

    usePaneLayoutStore.getState().moveTab(
      "left",
      "right",
      "tab-moving",
      0,
      "env-empty-move",
    );

    expect(usePaneLayoutStore.getState().getRoot("env-empty-move")).toMatchObject({
      kind: "leaf",
      id: "right",
      tabs: [{ id: "tab-moving" }, { id: "tab-target" }],
      activeTabId: "tab-moving",
    });
  });

  test("preserves a live terminal when moving the last source tab", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [{ id: "terminal-moving", type: "plain" }],
          activeTabId: "terminal-moving",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [{ id: "tab-target", type: "plain" }],
          activeTabId: "tab-target",
        },
      ],
    }, "left", "env-live-move");
    const sessionKey = createTerminalSessionKey(
      null,
      "terminal-moving",
      "env-live-move",
    );
    useTerminalSessionStore.getState().setSession(
      sessionKey,
      { sessionId: "pty-live-move" },
    );

    usePaneLayoutStore.getState().moveTab(
      "left",
      "right",
      "terminal-moving",
      undefined,
      "env-live-move",
    );

    expect(closeLocalTerminalSession).not.toHaveBeenCalled();
    expect(detachTerminal).not.toHaveBeenCalled();
    expect(
      useTerminalSessionStore.getState().sessions.get(sessionKey)?.sessionId,
    ).toBe("pty-live-move");
  });

  test("keeps the moved tab's portal terminal instance alive across panes", () => {
    // A move is not a close: disposing the xterm instance here would blank the
    // terminal the user just dragged into another pane.
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [
            { id: "terminal-moving", type: "plain" },
            { id: "left-stays", type: "plain" },
          ],
          activeTabId: "terminal-moving",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [{ id: "tab-target", type: "plain" }],
          activeTabId: "tab-target",
        },
      ],
    }, "left", "env-move-portal");
    const terminalDispose = mock(() => {});
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey("env-move-portal", "terminal-moving"),
        {
          environmentId: "env-move-portal",
          tabId: "terminal-moving",
          terminal: { dispose: terminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });

    usePaneLayoutStore.getState().moveTab(
      "left",
      "right",
      "terminal-moving",
      undefined,
      "env-move-portal",
    );

    expect(terminalDispose).not.toHaveBeenCalled();
    expect(
      useTerminalPortalStore.getState().hasTerminal("env-move-portal", "terminal-moving"),
    ).toBe(true);
    expect(
      usePaneLayoutStore.getState().getPane("right", "env-move-portal")
        ?.tabs.map((tab) => tab.id),
    ).toEqual(["tab-target", "terminal-moving"]);
  });

  test("keeps the portal terminal alive when the emptied source pane collapses", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [{ id: "terminal-moving", type: "plain" }],
          activeTabId: "terminal-moving",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [{ id: "tab-target", type: "plain" }],
          activeTabId: "tab-target",
        },
      ],
    }, "left", "env-move-portal-collapse");
    const terminalDispose = mock(() => {});
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey("env-move-portal-collapse", "terminal-moving"),
        {
          environmentId: "env-move-portal-collapse",
          tabId: "terminal-moving",
          terminal: { dispose: terminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });

    usePaneLayoutStore.getState().moveTab(
      "left",
      "right",
      "terminal-moving",
      undefined,
      "env-move-portal-collapse",
    );

    expect(terminalDispose).not.toHaveBeenCalled();
    expect(
      useTerminalPortalStore.getState()
        .hasTerminal("env-move-portal-collapse", "terminal-moving"),
    ).toBe(true);
    expect(usePaneLayoutStore.getState().getRoot("env-move-portal-collapse"))
      .toMatchObject({ kind: "leaf", id: "right" });
  });

  test("moving the only tab of a root-level leaf leaves the store untouched", () => {
    // A root leaf has no parent split to collapse into, so there is nowhere to
    // move the tab to and nothing may be written.
    seedSingleTabEnvironment("env-root-leaf-move", null, {
      id: "only-tab",
      type: "plain",
    });
    const seeded = usePaneLayoutStore.getState().environments;
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-root-leaf-move");

    usePaneLayoutStore.getState().moveTab(
      "default",
      "default",
      "only-tab",
      undefined,
      "env-root-leaf-move",
    );

    expect(usePaneLayoutStore.getState().environments).toBe(seeded);
    expect(usePaneLayoutStore.getState().getRoot("env-root-leaf-move")).toBe(originalRoot);
  });

  test("does not mutate state for invalid move requests", () => {
    usePaneLayoutStore.getState().moveTab("left", "right", "tab");
    usePaneLayoutStore.getState().moveTab("left", "right", "tab", undefined, "missing-env");

    seedSingleTabEnvironment("env-invalid-move", null, { id: "tab-one", type: "plain" });
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-invalid-move");
    const store = usePaneLayoutStore.getState();
    store.moveTab("missing", "default", "tab-one", undefined, "env-invalid-move");
    store.moveTab("default", "missing", "tab-one", undefined, "env-invalid-move");
    store.moveTab("default", "default", "missing-tab", undefined, "env-invalid-move");

    expect(usePaneLayoutStore.getState().getRoot("env-invalid-move")).toBe(originalRoot);
  });

  test("clears a tab initial prompt without changing its other data", () => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [{
        id: "prompt-tab",
        type: "plain",
        initialPrompt: "Run the checks",
        initialCommands: ["bun test"],
      }],
      activeTabId: "prompt-tab",
    }, "default", "env-prompt");

    usePaneLayoutStore.getState().clearTabInitialPrompt("prompt-tab", "env-prompt");

    expect(usePaneLayoutStore.getState().getAllTabs("env-prompt")).toEqual([{
      id: "prompt-tab",
      type: "plain",
      initialPrompt: undefined,
      initialCommands: ["bun test"],
    }]);
  });

  test("clears, deletes and evicts a consumed handoff reference", async () => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [{
        id: "handoff-tab",
        type: "codex-native",
        agentHandoffId: "handoff-1",
        displayTitle: "Codex · from Claude",
        codexNativeData: { environmentId: "env-handoff" },
      }],
      activeTabId: "handoff-tab",
    }, "default", "env-handoff");
    rememberAgentHandoff({ id: "handoff-1" } as never);

    usePaneLayoutStore.getState().clearTabAgentHandoff("handoff-tab", "env-handoff");

    expect(usePaneLayoutStore.getState().getAllTabs("env-handoff")[0]).toMatchObject({
      id: "handoff-tab",
      agentHandoffId: undefined,
      // Retained so the bootstrap prompt keeps being hidden. The imported
      // transcript is gone, but that prompt is still the destination session's
      // first message and would otherwise render as a raw JSON frame.
      consumedAgentHandoffId: "handoff-1",
      displayTitle: "Codex · from Claude",
      codexNativeData: { environmentId: "env-handoff" },
    });
    expect(deleteAgentHandoff).toHaveBeenCalledWith("handoff-1", "env-handoff");
    await expect(loadAgentHandoff("handoff-1")).resolves.toBeNull();
    expect(getAgentHandoff).toHaveBeenCalledWith("handoff-1");
  });

  test("clearing an already-consumed handoff is a no-op", () => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [{
        id: "handoff-tab",
        type: "codex-native",
        consumedAgentHandoffId: "handoff-1",
      }],
      activeTabId: "handoff-tab",
    }, "default", "env-handoff");

    usePaneLayoutStore.getState().clearTabAgentHandoff("handoff-tab", "env-handoff");

    expect(deleteAgentHandoff).not.toHaveBeenCalled();
    expect(usePaneLayoutStore.getState().getAllTabs("env-handoff")[0])
      .toMatchObject({ consumedAgentHandoffId: "handoff-1" });
  });

  test("hydration reconciles stored handoffs against the restored layout", () => {
    /*
     * The per-tab delete is fire-and-forget. If it is dropped — backend restart,
     * lock timeout, app kill — the reference is already gone from the layout, so
     * nothing ever retries and the transcript is stranded on disk. Hydration is
     * the one moment the environment's full reference set is authoritative.
     */
    usePaneLayoutStore.getState().finishHydration("env-restored", {
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "live", type: "codex-native", agentHandoffId: "handoff-live" },
          { id: "consumed", type: "claude-native", consumedAgentHandoffId: "handoff-old" },
          { id: "plain", type: "plain" },
        ],
        activeTabId: "live",
      },
    });

    // Only ids a tab still renders from are referenced. A consumed id names a
    // record that was already deleted, so it must not keep one alive.
    expect(pruneAgentHandoffs).toHaveBeenCalledWith("env-restored", ["handoff-live"]);
  });

  test("hydration with nothing to restore prunes every stored handoff", () => {
    usePaneLayoutStore.getState().finishHydration("env-empty");

    expect(pruneAgentHandoffs).toHaveBeenCalledWith("env-empty", []);
  });

  test("a failed hydration prune is logged without breaking hydration", async () => {
    consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});
    pruneAgentHandoffs.mockRejectedValueOnce(new Error("prune failed"));

    usePaneLayoutStore.getState().finishHydration("env-prune-fail");
    await Promise.resolve();
    await Promise.resolve();

    expect(usePaneLayoutStore.getState().hydration.get("env-prune-fail")).toBe("done");
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      "[PaneLayout] Error pruning agent handoffs:",
      expect.objectContaining({ message: "prune failed" }),
    );
  });

  test("clearing one of multiple handoff references preserves backend storage", () => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "first", type: "plain", agentHandoffId: "handoff-shared" },
        { id: "second", type: "plain", agentHandoffId: "handoff-shared" },
      ],
      activeTabId: "first",
    }, "default", "env-handoff");

    usePaneLayoutStore.getState().clearTabAgentHandoff("first", "env-handoff");

    expect(deleteAgentHandoff).not.toHaveBeenCalled();
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-handoff")
        .find((tab) => tab.id === "second")?.agentHandoffId,
    ).toBe("handoff-shared");
  });

  test("consumes one-shot agent options without clearing the pending prompt", () => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [{
        id: "review-tab",
        type: "codex-native",
        initialPrompt: "Review the diff",
        initialAgentModel: "gpt-5.6-sol",
        initialReasoningEffort: "xhigh",
      }],
      activeTabId: "review-tab",
    }, "default", "env-review");

    usePaneLayoutStore.getState().clearTabInitialAgentOptions("review-tab", "env-review");

    expect(usePaneLayoutStore.getState().getAllTabs("env-review")).toEqual([{
      id: "review-tab",
      type: "codex-native",
      initialPrompt: "Review the diff",
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
    }]);
  });

  test("splits a pane and activates the pane containing the moved tab", () => {
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "tab-one", type: "plain" },
        { id: "tab-two", type: "plain" },
      ],
      activeTabId: "tab-two",
    }, "default", "env-split-action");

    usePaneLayoutStore.getState().splitPane(
      "default",
      "vertical",
      "tab-two",
      "env-split-action",
    );

    const store = usePaneLayoutStore.getState();
    const root = store.getRoot("env-split-action");
    expect(root).toMatchObject({
      kind: "split",
      direction: "vertical",
      children: [
        { kind: "leaf", id: "default", tabs: [{ id: "tab-one" }] },
        { kind: "leaf", tabs: [{ id: "tab-two" }], activeTabId: "tab-two" },
      ],
    });
    expect(getAllLeaves(root).map((leaf) => leaf.id)).toContain(store.getActivePaneId("env-split-action"));
    expect(store.getActivePane("env-split-action")?.activeTabId).toBe("tab-two");
  });

  test("updates nested split sizes and collapses nested panes", () => {
    seedPaneTree({
      kind: "split",
      id: "outer",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [{ id: "left-tab", type: "plain" }],
          activeTabId: "left-tab",
        },
        {
          kind: "split",
          id: "inner",
          direction: "vertical",
          sizes: [50, 50],
          depth: 2,
          children: [
            {
              kind: "leaf",
              id: "middle",
              tabs: [{ id: "middle-tab", type: "plain" }],
              activeTabId: "middle-tab",
            },
            {
              kind: "leaf",
              id: "right",
              tabs: [{ id: "right-tab", type: "plain" }],
              activeTabId: "right-tab",
            },
          ],
        },
      ],
    }, "middle", "env-nested");

    const store = usePaneLayoutStore.getState();
    store.closePane("missing-pane", "env-nested");
    store.updateSizes("inner", [30, 70], "env-nested");
    const resizedRoot = store.getRoot("env-nested");
    expect(resizedRoot.kind).toBe("split");
    if (resizedRoot.kind !== "split") throw new Error("root should be split");
    expect(resizedRoot.children[1]).toMatchObject({ kind: "split", id: "inner", sizes: [30, 70] });

    store.closePane("middle", "env-nested");
    expect(store.getRoot("env-nested")).toMatchObject({
      kind: "split",
      id: "outer",
      children: [
        { kind: "leaf", id: "left" },
        { kind: "leaf", id: "right" },
      ],
    });
    expect(store.getActivePaneId("env-nested")).toBe("right");

    store.closePane("left", "env-nested");
    const singlePaneRoot = store.getRoot("env-nested");
    expect(singlePaneRoot).toMatchObject({ kind: "leaf", id: "right" });
    store.closePane("right", "env-nested");
    expect(store.getRoot("env-nested")).toBe(singlePaneRoot);
  });
});

describe("paneLayoutStore guard branches", () => {
  beforeEach(() => {
    resetStores();
  });

  test("setActiveTab does nothing without an environment or for an unknown one", () => {
    const before = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().setActiveTab("default", "tab-one");
    expect(usePaneLayoutStore.getState().environments).toBe(before);

    seedSingleTabEnvironment("env-active-tab", null, { id: "tab-one", type: "plain" });
    const seeded = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().setActiveTab("default", "tab-one", "missing-env");
    expect(usePaneLayoutStore.getState().environments).toBe(seeded);
  });

  test("setActiveTab on an unknown pane leaves all selection untouched", () => {
    seedSingleTabEnvironment("env-active-tab", null, { id: "tab-one", type: "plain" });
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-active-tab");

    usePaneLayoutStore.getState().setActiveTab("missing-pane", "tab-one", "env-active-tab");

    const store = usePaneLayoutStore.getState();
    expect(store.getRoot("env-active-tab")).toBe(originalRoot);
    expect(store.getPane("default", "env-active-tab")?.activeTabId).toBe("tab-one");
    expect(store.getActivePaneId("env-active-tab")).toBe("default");
  });

  test("setActiveTab rejects a tab id that is not in the pane", () => {
    seedSingleTabEnvironment("env-ghost-tab", null, { id: "tab-one", type: "plain" });
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-ghost-tab");

    usePaneLayoutStore.getState().setActiveTab("default", "ghost-tab", "env-ghost-tab");

    const pane = usePaneLayoutStore.getState().getPane("default", "env-ghost-tab");
    expect(usePaneLayoutStore.getState().getRoot("env-ghost-tab")).toBe(
      originalRoot,
    );
    expect(pane?.tabs.map((tab) => tab.id)).toEqual(["tab-one"]);
    expect(pane?.activeTabId).toBe("tab-one");
  });

  test("getOpenFilePaths collects paths from every pane, duplicates included", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [
            { id: "file-a", type: "file", fileData: { filePath: "/repo/a.ts" } },
            { id: "plain-a", type: "plain" },
            { id: "file-empty", type: "file", fileData: { filePath: "" } },
          ],
          activeTabId: "file-a",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [
            // The same file opened in a second pane must still be reported so
            // callers can see it is open, hence duplicates are preserved.
            { id: "file-a-copy", type: "file", fileData: { filePath: "/repo/a.ts" } },
            { id: "file-b", type: "file", fileData: { filePath: "/repo/b.ts" } },
            { id: "file-no-data", type: "file" },
          ],
          activeTabId: "file-b",
        },
      ],
    }, "left", "env-open-files");

    expect(usePaneLayoutStore.getState().getOpenFilePaths("env-open-files")).toEqual([
      "/repo/a.ts",
      "/repo/a.ts",
      "/repo/b.ts",
    ]);
  });

  test("getOpenFilePaths returns nothing for an environment with no file tabs", () => {
    seedSingleTabEnvironment("env-no-files", null, { id: "tab-one", type: "plain" });

    expect(usePaneLayoutStore.getState().getOpenFilePaths("env-no-files")).toEqual([]);
  });

  test("splitPane leaves state unchanged for missing environments, panes, and tabs", () => {
    const storeWithoutEnvironment = usePaneLayoutStore.getState();
    const before = storeWithoutEnvironment.environments;
    storeWithoutEnvironment.splitPane("default", "horizontal", "tab-one");
    expect(usePaneLayoutStore.getState().environments).toBe(before);

    storeWithoutEnvironment.splitPane("default", "horizontal", "tab-one", "missing-env");

    seedSingleTabEnvironment("env-invalid-split", null, { id: "tab-one", type: "plain" });
    const store = usePaneLayoutStore.getState();
    const originalRoot = store.getRoot("env-invalid-split");
    const seededEnvironments = store.environments;

    store.splitPane("missing-pane", "horizontal", "tab-one", "env-invalid-split");
    store.splitPane("default", "horizontal", "missing-tab", "env-invalid-split");

    expect(usePaneLayoutStore.getState().getRoot("env-invalid-split")).toBe(originalRoot);
    expect(usePaneLayoutStore.getState().environments).toBe(seededEnvironments);
  });

  test("splitPane refuses to split once the tree is at the maximum depth", () => {
    let root: any = {
      kind: "leaf",
      id: "deep-target",
      tabs: [
        { id: "tab-one", type: "plain" },
        { id: "tab-two", type: "plain" },
      ],
      activeTabId: "tab-two",
    };
    // MAX_SPLIT_DEPTH is 9, so nine nested splits sit exactly at the limit.
    for (let depth = 1; depth <= 9; depth += 1) {
      root = {
        kind: "split",
        id: `split-${depth}`,
        direction: "horizontal",
        sizes: [50, 50],
        depth,
        children: [
          root,
          { kind: "leaf", id: `filler-${depth}`, tabs: [], activeTabId: null },
        ],
      };
    }
    seedPaneTree(root, "deep-target", "env-split-depth");

    usePaneLayoutStore.getState().splitPane(
      "deep-target",
      "horizontal",
      "tab-two",
      "env-split-depth",
    );

    expect(usePaneLayoutStore.getState().getRoot("env-split-depth")).toBe(root);
  });

  test("finishHydration with nothing restored only marks hydration done", () => {
    const store = usePaneLayoutStore.getState();
    store.initialize("container-a", "env-fresh");
    store.beginHydration("env-fresh");
    const existing = usePaneLayoutStore.getState().environments.get("env-fresh");
    expect(usePaneLayoutStore.getState().hydration.get("env-fresh")).toBe("pending");

    usePaneLayoutStore.getState().finishHydration("env-fresh");

    expect(usePaneLayoutStore.getState().hydration.get("env-fresh")).toBe("done");
    // The freshly initialized layout survives: nothing is installed over it.
    expect(usePaneLayoutStore.getState().environments.get("env-fresh")).toBe(existing);
  });

  test("finishHydration marks an environment done even if hydration never began", () => {
    usePaneLayoutStore.getState().finishHydration("env-never-began");

    expect(usePaneLayoutStore.getState().hydration.get("env-never-began")).toBe("done");
    expect(usePaneLayoutStore.getState().environments.has("env-never-began")).toBe(false);
  });

  test("updateSizes ignores unknown environments and unknown split ids", () => {
    const before = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().updateSizes("split-1", [30, 70]);
    expect(usePaneLayoutStore.getState().environments).toBe(before);

    seedPaneTree({
      kind: "split",
      id: "outer",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [{ id: "left-tab", type: "plain" }],
          activeTabId: "left-tab",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [{ id: "right-tab", type: "plain" }],
          activeTabId: "right-tab",
        },
      ],
    }, "left", "env-sizes");
    const seeded = usePaneLayoutStore.getState().environments;

    usePaneLayoutStore.getState().updateSizes("outer", [30, 70], "missing-env");
    expect(usePaneLayoutStore.getState().environments).toBe(seeded);

    usePaneLayoutStore.getState().updateSizes("missing-split", [30, 70], "env-sizes");
    expect(usePaneLayoutStore.getState().getRoot("env-sizes")).toMatchObject({
      id: "outer",
      sizes: [50, 50],
    });
  });

  test("updateSizes on a leaf-only layout leaves the tree alone", () => {
    seedSingleTabEnvironment("env-leaf-sizes", null, { id: "tab-one", type: "plain" });
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-leaf-sizes");

    usePaneLayoutStore.getState().updateSizes("default", [30, 70], "env-leaf-sizes");

    // A leaf carries no sizes, so the recursive update returns it untouched.
    expect(usePaneLayoutStore.getState().getRoot("env-leaf-sizes")).toBe(originalRoot);
  });

  test("clearTabInitialPrompt is a no-op for unknown environments and tabs", () => {
    const before = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().clearTabInitialPrompt("tab-one");
    expect(usePaneLayoutStore.getState().environments).toBe(before);

    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [{ id: "prompt-tab", type: "plain", initialPrompt: "Run the checks" }],
      activeTabId: "prompt-tab",
    }, "default", "env-clear-prompt");
    const seeded = usePaneLayoutStore.getState().environments;

    usePaneLayoutStore.getState().clearTabInitialPrompt("prompt-tab", "missing-env");
    usePaneLayoutStore.getState().clearTabInitialPrompt("missing-tab", "env-clear-prompt");

    expect(usePaneLayoutStore.getState().environments).toBe(seeded);
    expect(usePaneLayoutStore.getState().getAllTabs("env-clear-prompt")[0]?.initialPrompt)
      .toBe("Run the checks");
  });

  test("clearTabInitialAgentOptions is a no-op for unknown environments and tabs", () => {
    const before = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().clearTabInitialAgentOptions("tab-one");
    expect(usePaneLayoutStore.getState().environments).toBe(before);

    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [{
        id: "review-tab",
        type: "codex-native",
        initialAgentModel: "gpt-5.6-sol",
        initialReasoningEffort: "xhigh",
      }],
      activeTabId: "review-tab",
    }, "default", "env-clear-options");
    const seeded = usePaneLayoutStore.getState().environments;

    usePaneLayoutStore.getState().clearTabInitialAgentOptions("review-tab", "missing-env");
    usePaneLayoutStore.getState().clearTabInitialAgentOptions("missing-tab", "env-clear-options");

    expect(usePaneLayoutStore.getState().environments).toBe(seeded);
    expect(usePaneLayoutStore.getState().getAllTabs("env-clear-options")[0]).toMatchObject({
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "xhigh",
    });
  });

  test("clearTabAgentHandoff is a no-op for unknown environments and tabs", () => {
    const before = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().clearTabAgentHandoff("tab-one");
    expect(usePaneLayoutStore.getState().environments).toBe(before);

    seedSingleTabEnvironment("env-handoff-noop", null, {
      id: "handoff-tab",
      type: "plain",
      agentHandoffId: "handoff-1",
    });
    const seeded = usePaneLayoutStore.getState().environments;

    usePaneLayoutStore.getState().clearTabAgentHandoff("handoff-tab", "missing-env");
    usePaneLayoutStore.getState().clearTabAgentHandoff("missing-tab", "env-handoff-noop");

    expect(usePaneLayoutStore.getState().environments).toBe(seeded);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-handoff-noop")[0]?.agentHandoffId,
    ).toBe("handoff-1");
    expect(deleteAgentHandoff).not.toHaveBeenCalled();
  });
});

describe("paneLayoutStore remaining branch coverage", () => {
  beforeEach(() => {
    resetStores();
  });

  test("selects the first nested sibling leaf when closing the active pane", () => {
    seedPaneTree({
      kind: "split",
      id: "outer",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "closing",
          tabs: [{ id: "closing-tab", type: "file" }],
          activeTabId: "closing-tab",
        },
        {
          kind: "split",
          id: "nested",
          direction: "vertical",
          sizes: [50, 50],
          depth: 2,
          children: [
            {
              kind: "leaf",
              id: "nested-first",
              tabs: [{ id: "first-tab", type: "file" }],
              activeTabId: "first-tab",
            },
            {
              kind: "leaf",
              id: "nested-second",
              tabs: [{ id: "second-tab", type: "file" }],
              activeTabId: "second-tab",
            },
          ],
        },
      ],
    }, "closing", "env-nested-sibling");

    usePaneLayoutStore.getState().closePane("closing", "env-nested-sibling");

    expect(usePaneLayoutStore.getState().getRoot("env-nested-sibling")).toMatchObject({
      kind: "split",
      id: "nested",
    });
    expect(usePaneLayoutStore.getState().getActivePaneId("env-nested-sibling"))
      .toBe("nested-first");
  });

  test("appends a sole source tab when no destination index is provided", () => {
    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "source",
          tabs: [{ id: "moving", type: "file" }],
          activeTabId: "moving",
        },
        {
          kind: "leaf",
          id: "target",
          tabs: [{ id: "target-tab", type: "file" }],
          activeTabId: "target-tab",
        },
      ],
    }, "source", "env-append-move");

    usePaneLayoutStore.getState().moveTab(
      "source",
      "target",
      "moving",
      undefined,
      "env-append-move",
    );

    expect(usePaneLayoutStore.getState().getRoot("env-append-move")).toMatchObject({
      kind: "leaf",
      id: "target",
      tabs: [{ id: "target-tab" }, { id: "moving" }],
      activeTabId: "moving",
    });
  });

  test("clears initial agent options without changing sibling tabs", () => {
    const sibling = {
      id: "sibling",
      type: "codex-native" as const,
      initialAgentModel: "keep-model",
      initialReasoningEffort: "high" as const,
    };
    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        {
          id: "target",
          type: "codex-native",
          initialAgentModel: "clear-model",
          initialReasoningEffort: "xhigh",
        },
        sibling,
      ],
      activeTabId: "target",
    }, "default", "env-clear-options-siblings");

    usePaneLayoutStore.getState().clearTabInitialAgentOptions(
      "target",
      "env-clear-options-siblings",
    );

    const tabs = usePaneLayoutStore.getState().getAllTabs("env-clear-options-siblings");
    expect(tabs[0]).toMatchObject({
      id: "target",
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
    });
    expect(tabs[1]).toBe(sibling);
  });

  test("resets both scoped and legacy Claude tmux tab state on removal", () => {
    const environmentId = "env-tmux-reset";
    const tabId = "tmux-tab";
    const scopedKey = createClaudeTmuxStateKey(environmentId, tabId);
    seedSingleTabEnvironment(environmentId, null, { id: tabId, type: "claude-tmux" });
    useClaudeTmuxStore.getState().setRunning(scopedKey, true, {
      environmentId,
      sessionId: "scoped-session",
    });
    useClaudeTmuxStore.getState().setRunning(tabId, true, {
      environmentId,
      sessionId: "legacy-session",
    });

    usePaneLayoutStore.getState().removeTab("default", tabId, environmentId);

    expect(useClaudeTmuxStore.getState().getTab(scopedKey)).toMatchObject({
      running: false,
      sessionId: null,
    });
    expect(useClaudeTmuxStore.getState().getTab(tabId)).toMatchObject({
      running: false,
      sessionId: null,
    });
  });

  test("reset clears only the target environment's portal terminals", () => {
    const targetDispose = mock(() => {});
    const retainedDispose = mock(() => {});
    usePaneLayoutStore.getState().initialize(null, "env-reset-portals");
    useTerminalPortalStore.setState({
      terminals: new Map([
        [
          createTerminalKey("env-reset-portals", "target"),
          {
            environmentId: "env-reset-portals",
            tabId: "target",
            terminal: { dispose: targetDispose },
            portalElement: document.createElement("div"),
          } as never,
        ],
        [
          createTerminalKey("env-retained", "retained"),
          {
            environmentId: "env-retained",
            tabId: "retained",
            terminal: { dispose: retainedDispose },
            portalElement: document.createElement("div"),
          } as never,
        ],
      ]),
    });

    usePaneLayoutStore.getState().reset("env-reset-portals");

    expect(targetDispose).toHaveBeenCalledTimes(1);
    expect(retainedDispose).not.toHaveBeenCalled();
    expect(useTerminalPortalStore.getState().hasTerminal("env-reset-portals", "target"))
      .toBe(false);
    expect(useTerminalPortalStore.getState().hasTerminal("env-retained", "retained"))
      .toBe(true);
  });

  test("removeTab disposes the removed tab's portal terminal", () => {
    const terminalDispose = mock(() => {});
    seedSingleTabEnvironment("env-remove-portal", null, {
      id: "terminal-tab",
      type: "plain",
    });
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey("env-remove-portal", "terminal-tab"),
        {
          environmentId: "env-remove-portal",
          tabId: "terminal-tab",
          terminal: { dispose: terminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });

    usePaneLayoutStore.getState().removeTab(
      "default",
      "terminal-tab",
      "env-remove-portal",
    );

    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(
      useTerminalPortalStore.getState().hasTerminal(
        "env-remove-portal",
        "terminal-tab",
      ),
    ).toBe(false);
  });

  test("addTab ignores missing environments and pane ids", () => {
    const initialEnvironments = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().addTab("default", { id: "tab", type: "file" });
    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "tab", type: "file" },
      "missing-env",
    );
    expect(usePaneLayoutStore.getState().environments).toBe(initialEnvironments);

    seedSingleTabEnvironment("env-add-guards", null, {
      id: "existing",
      type: "file",
    });
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-add-guards");

    usePaneLayoutStore.getState().addTab(
      "missing-pane",
      { id: "new-tab", type: "file" },
      "env-add-guards",
    );

    expect(usePaneLayoutStore.getState().getRoot("env-add-guards")).toBe(originalRoot);
    expect(usePaneLayoutStore.getState().getAllTabs("env-add-guards"))
      .toEqual([{ id: "existing", type: "file" }]);
  });

  test("removeTab ignores missing environments, panes, and pane-tab mismatches", () => {
    const initialEnvironments = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().removeTab("default", "tab");
    usePaneLayoutStore.getState().removeTab("default", "tab", "missing-env");
    expect(usePaneLayoutStore.getState().environments).toBe(initialEnvironments);

    seedPaneTree({
      kind: "split",
      id: "root-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "left",
          tabs: [{ id: "left-tab", type: "file" }],
          activeTabId: "left-tab",
        },
        {
          kind: "leaf",
          id: "right",
          tabs: [{ id: "right-tab", type: "plain" }],
          activeTabId: "right-tab",
        },
      ],
    }, "left", "env-remove-guards");
    const rightTerminalDispose = mock(() => {});
    useTerminalPortalStore.setState({
      terminals: new Map([[
        createTerminalKey("env-remove-guards", "right-tab"),
        {
          environmentId: "env-remove-guards",
          tabId: "right-tab",
          terminal: { dispose: rightTerminalDispose },
          portalElement: document.createElement("div"),
        } as never,
      ]]),
    });
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-remove-guards");

    usePaneLayoutStore.getState().removeTab(
      "missing-pane",
      "right-tab",
      "env-remove-guards",
    );
    usePaneLayoutStore.getState().removeTab(
      "left",
      "right-tab",
      "env-remove-guards",
    );

    expect(usePaneLayoutStore.getState().getRoot("env-remove-guards")).toBe(originalRoot);
    expect(rightTerminalDispose).not.toHaveBeenCalled();
    expect(
      useTerminalPortalStore.getState().hasTerminal("env-remove-guards", "right-tab"),
    ).toBe(true);
  });

  test("reorderTabs ignores missing scopes, panes, and unchanged indexes", () => {
    const initialEnvironments = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().reorderTabs("default", 0, 1);
    usePaneLayoutStore.getState().reorderTabs("default", 0, 1, "missing-env");
    expect(usePaneLayoutStore.getState().environments).toBe(initialEnvironments);

    seedPaneTree({
      kind: "leaf",
      id: "default",
      tabs: [
        { id: "first", type: "file" },
        { id: "second", type: "file" },
      ],
      activeTabId: "first",
    }, "default", "env-reorder-guards");
    const originalRoot = usePaneLayoutStore.getState().getRoot("env-reorder-guards");

    usePaneLayoutStore.getState().reorderTabs(
      "missing-pane",
      0,
      1,
      "env-reorder-guards",
    );
    usePaneLayoutStore.getState().reorderTabs(
      "default",
      1,
      1,
      "env-reorder-guards",
    );

    expect(usePaneLayoutStore.getState().getRoot("env-reorder-guards"))
      .toBe(originalRoot);
    expect(usePaneLayoutStore.getState().getAllTabs("env-reorder-guards")
      .map(({ id }) => id)).toEqual(["first", "second"]);
  });

  test("setActivePane ignores missing environments and pane ids", () => {
    const initialEnvironments = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().setActivePane("pane");
    usePaneLayoutStore.getState().setActivePane("pane", "missing-env");

    expect(usePaneLayoutStore.getState().environments).toBe(initialEnvironments);

    seedSingleTabEnvironment("env-active-pane-guard", null, {
      id: "tab",
      type: "plain",
    });
    const seeded = usePaneLayoutStore.getState().environments;
    usePaneLayoutStore.getState().setActivePane(
      "missing-pane",
      "env-active-pane-guard",
    );
    expect(usePaneLayoutStore.getState().environments).toBe(seeded);
    expect(
      usePaneLayoutStore.getState().getActivePaneId("env-active-pane-guard"),
    ).toBe("default");
  });
});
