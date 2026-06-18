import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const closeLocalTerminalSession = mock(async (_sessionId: string) => {});
const detachTerminal = mock(async (_sessionId: string) => {});
const updateSessionStatus = mock(async (_sessionId: string, _status: string) => ({}));
const stopTmuxSession = mock(async (_tabId: string, _environmentId?: string) => {});
const deleteClaudeSession = mock(async (_client: unknown, _sessionId: string) => true);
const deleteCodexSession = mock(async (_client: unknown, _sessionId: string) => true);
const deleteOpenCodeSession = mock(async (_client: unknown, _sessionId: string) => true);

const realTauri = await import("@/lib/tauri");
const realTauriSnapshot = { ...realTauri };
const realClaudeTmuxClient = await import("@/lib/claude-tmux-client");
const realClaudeTmuxClientSnapshot = { ...realClaudeTmuxClient };
const realClaudeClient = await import("@/lib/claude-client");
const realClaudeClientSnapshot = { ...realClaudeClient };
const realCodexClient = await import("@/lib/codex-client");
const realCodexClientSnapshot = { ...realCodexClient };
const realOpenCodeClient = await import("@/lib/opencode-client");
const realOpenCodeClientSnapshot = { ...realOpenCodeClient };

mock.module("@/lib/tauri", () => ({
  ...realTauriSnapshot,
  closeLocalTerminalSession,
  detachTerminal,
  createSession: mock(async () => ({})),
  updateSessionStatus,
  updateSessionActivity: mock(async () => ({})),
  deleteSession: mock(async () => {}),
  deleteSessionsByEnvironment: mock(async () => []),
  disconnectEnvironmentSessions: mock(async () => {}),
  getSessionsByEnvironment: mock(async () => []),
  saveSessionBuffer: mock(async () => {}),
  loadSessionBuffer: mock(async () => null),
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
  mock.module("@/lib/tauri", () => realTauriSnapshot);
  mock.module("@/lib/claude-tmux-client", () => realClaudeTmuxClientSnapshot);
  mock.module("@/lib/claude-client", () => realClaudeClientSnapshot);
  mock.module("@/lib/codex-client", () => realCodexClientSnapshot);
  mock.module("@/lib/opencode-client", () => realOpenCodeClientSnapshot);
});

const { usePaneLayoutStore } = await import("./paneLayoutStore");
const { useTerminalSessionStore, createSessionKey } = await import("./terminalSessionStore");
const { useClaudeStore, createClaudeSessionKey } = await import("./claudeStore");
const { useCodexStore, createCodexSessionKey } = await import("./codexStore");
const { useOpenCodeStore, createOpenCodeSessionKey } = await import("./openCodeStore");

function resetStores() {
  usePaneLayoutStore.setState({
    environments: new Map(),
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

  closeLocalTerminalSession.mockClear();
  detachTerminal.mockClear();
  updateSessionStatus.mockClear();
  stopTmuxSession.mockClear();
  deleteClaudeSession.mockClear();
  deleteCodexSession.mockClear();
  deleteOpenCodeSession.mockClear();
}

function seedSingleTabEnvironment(
  environmentId: string,
  containerId: string | null,
  tab: { id: string; type: string },
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

describe("paneLayoutStore tab cleanup", () => {
  beforeEach(() => {
    resetStores();
  });

  test("closing a local terminal tab calls the local PTY close command", () => {
    seedSingleTabEnvironment("env-local", null, { id: "tab-terminal", type: "plain" });
    const sessionKey = createSessionKey(null, "tab-terminal", "env-local");
    useTerminalSessionStore.getState().setSession(sessionKey, { sessionId: "pty-local" });

    usePaneLayoutStore.getState().removeTab("default", "tab-terminal");

    expect(closeLocalTerminalSession).toHaveBeenCalledWith("pty-local");
    expect(detachTerminal).not.toHaveBeenCalled();
    expect(useTerminalSessionStore.getState().sessions.has(sessionKey)).toBe(false);
  });

  test("closing a terminal tab marks its persistent session disconnected", () => {
    seedSingleTabEnvironment("env-local", null, { id: "tab-terminal", type: "plain" });
    const sessionKey = createSessionKey(null, "tab-terminal", "env-local");
    useTerminalSessionStore.getState().setSession(sessionKey, {
      sessionId: "pty-local",
      persistentSessionId: "persistent-1",
    });

    usePaneLayoutStore.getState().removeTab("default", "tab-terminal");

    expect(updateSessionStatus).toHaveBeenCalledWith("persistent-1", "disconnected");
  });

  test("closing a container terminal tab calls the Docker detach command", () => {
    seedSingleTabEnvironment("env-container", "container-1", { id: "tab-terminal", type: "plain" });
    const sessionKey = createSessionKey("container-1", "tab-terminal", "env-container");
    useTerminalSessionStore.getState().setSession(sessionKey, { sessionId: "pty-container" });

    usePaneLayoutStore.getState().removeTab("default", "tab-terminal");

    expect(detachTerminal).toHaveBeenCalledWith("pty-container");
    expect(closeLocalTerminalSession).not.toHaveBeenCalled();
  });

  test("closing a Claude tmux tab stops its tmux session", () => {
    seedSingleTabEnvironment("env-local", null, { id: "tab-tmux", type: "claude-tmux" });

    usePaneLayoutStore.getState().removeTab("default", "tab-tmux");

    expect(stopTmuxSession).toHaveBeenCalledWith("tab-tmux", "env-local");
  });

  test("closing native agent tabs deletes their backend sessions", () => {
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

    const claudeKey = createClaudeSessionKey("env-native", "claude-tab");
    useClaudeStore.getState().setClient("env-native", {} as any);
    useClaudeStore.getState().setSession(claudeKey, {
      sessionId: "claude-session",
      messages: [],
      isLoading: true,
    });

    const codexKey = createCodexSessionKey("env-native", "codex-tab");
    useCodexStore.getState().setClient("env-native", {} as any);
    useCodexStore.getState().setSession(codexKey, {
      sessionId: "codex-session",
      messages: [],
      isLoading: true,
    });

    const openCodeKey = createOpenCodeSessionKey("env-native", "opencode-tab");
    useOpenCodeStore.getState().setClient("env-native", {} as any);
    useOpenCodeStore.getState().setSession(openCodeKey, {
      sessionId: "opencode-session",
      messages: [],
      isLoading: true,
    });

    usePaneLayoutStore.getState().removeTab("default", "claude-tab");
    usePaneLayoutStore.getState().removeTab("default", "codex-tab");
    usePaneLayoutStore.getState().removeTab("default", "opencode-tab");

    expect(deleteClaudeSession).toHaveBeenCalledWith(expect.anything(), "claude-session");
    expect(deleteCodexSession).toHaveBeenCalledWith(expect.anything(), "codex-session");
    expect(deleteOpenCodeSession).toHaveBeenCalledWith(expect.anything(), "opencode-session");
    expect(useClaudeStore.getState().sessions.has(claudeKey)).toBe(false);
    expect(useCodexStore.getState().sessions.has(codexKey)).toBe(false);
    expect(useOpenCodeStore.getState().sessions.has(openCodeKey)).toBe(false);
  });

  test("reset cleans up all tab resources for the environment", () => {
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
              ] as any,
              activeTabId: "terminal-tab",
            },
          },
        ],
      ]),
    });
    const terminalKey = createSessionKey(null, "terminal-tab", "env-reset");
    useTerminalSessionStore.getState().setSession(terminalKey, { sessionId: "pty-reset" });
    const codexKey = createCodexSessionKey("env-reset", "codex-tab");
    useCodexStore.getState().setClient("env-reset", {} as any);
    useCodexStore.getState().setSession(codexKey, {
      sessionId: "codex-session",
      messages: [],
      isLoading: false,
    });

    usePaneLayoutStore.getState().reset("env-reset");

    expect(closeLocalTerminalSession).toHaveBeenCalledWith("pty-reset");
    expect(stopTmuxSession).toHaveBeenCalledWith("tmux-tab", "env-reset");
    expect(deleteCodexSession).toHaveBeenCalledWith(expect.anything(), "codex-session");
    expect(usePaneLayoutStore.getState().getAllTabs("env-reset")).toEqual([]);
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
