import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const closeLocalTerminalSession = mock(async (_sessionId: string) => {});
const detachTerminal = mock(async (_sessionId: string) => {});
const updateSessionStatus = mock(async (_sessionId: string, _status: string) => ({}));
const stopTmuxSession = mock(async (_tabId: string, _environmentId?: string) => {});
const deleteClaudeSession = mock(async (_client: unknown, _sessionId: string) => true);
const deleteCodexSession = mock(async (_client: unknown, _sessionId: string) => true);
const deleteOpenCodeSession = mock(async (_client: unknown, _sessionId: string) => true);
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
const { useTerminalSessionStore, createSessionKey } = await import("./terminalSessionStore");
const { useClaudeStore, createClaudeSessionKey } = await import("./claudeStore");
const { useCodexStore, createCodexSessionKey } = await import("./codexStore");
const { useOpenCodeStore, createOpenCodeSessionKey } = await import("./openCodeStore");
const { useEnvironmentStore } = await import("./environmentStore");

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
    setupScriptsRunning: new Set(),
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
    const terminalKey = createSessionKey(null, "terminal-tab", "env-close-pane");
    useTerminalSessionStore.getState().setSession(terminalKey, { sessionId: "pty-close-pane" });

    usePaneLayoutStore.getState().closePane("closing-pane", "env-close-pane");

    expect(destroy).toHaveBeenCalledWith("browser-tab");
    expect(closeLocalTerminalSession).toHaveBeenCalledWith("pty-close-pane");
    expect(useTerminalSessionStore.getState().sessions.has(terminalKey)).toBe(false);
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

    const terminalKey = createSessionKey(null, "terminal-tab", "env-cleanup-errors");
    useTerminalSessionStore.getState().setSession(terminalKey, {
      sessionId: "pty-cleanup-errors",
      persistentSessionId: "persistent-cleanup-errors",
    });

    const claudeKey = createClaudeSessionKey("env-cleanup-errors", "claude-tab");
    useClaudeStore.getState().setClient("env-cleanup-errors", {} as any);
    useClaudeStore.getState().setSession(claudeKey, {
      sessionId: "claude-cleanup-errors",
      messages: [],
      isLoading: true,
    });

    const codexKey = createCodexSessionKey("env-cleanup-errors", "codex-tab");
    useCodexStore.getState().setClient("env-cleanup-errors", {} as any);
    useCodexStore.getState().setSession(codexKey, {
      sessionId: "codex-cleanup-errors",
      messages: [],
      isLoading: true,
    });

    const openCodeKey = createOpenCodeSessionKey("env-cleanup-errors", "opencode-tab");
    useOpenCodeStore.getState().setClient("env-cleanup-errors", {} as any);
    useOpenCodeStore.getState().setSession(openCodeKey, {
      sessionId: "opencode-cleanup-errors",
      messages: [],
      isLoading: true,
    });

    closeLocalTerminalSession.mockRejectedValueOnce(new Error("local close failed"));
    updateSessionStatus.mockRejectedValueOnce(new Error("status update failed"));
    stopTmuxSession.mockRejectedValueOnce(new Error("tmux stop failed"));
    deleteClaudeSession.mockRejectedValueOnce(new Error("Claude delete failed"));
    deleteCodexSession.mockRejectedValueOnce(new Error("Codex delete failed"));
    deleteOpenCodeSession.mockRejectedValueOnce(new Error("OpenCode delete failed"));

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
    expect(consoleErrorSpy).toHaveBeenCalled();
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
    useEnvironmentStore.getState().setSetupScriptsRunning("env-setup-close", true);

    usePaneLayoutStore.getState().removeTab("setup-pane", "setup-tab", "env-setup-close");

    expect(useEnvironmentStore.getState().setupScriptsRunning.has("env-setup-close")).toBe(false);
    expect(usePaneLayoutStore.getState().getRoot("env-setup-close")).toMatchObject({
      kind: "leaf",
      id: "remaining-pane",
    });
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
