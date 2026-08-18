import { createSessionKey } from "@/lib/utils";
import { create } from "zustand";
import type { PaneNode, PaneLeaf, PaneSplit, TabInfo, EdgeDirection } from "@/types/paneLayout";
import { getNativeAgentData, isPaneLeaf, MAX_SPLIT_DEPTH } from "@/types/paneLayout";
import {
  useTerminalSessionStore,
  // Distinct from the native `createSessionKey`: terminal keys also carry the
  // container id.
  createSessionKey as createTerminalSessionKey,
} from "./terminalSessionStore";
import { useTerminalPortalStore } from "./terminalPortalStore";
import { useClaudeStore } from "./claudeStore";
import { createClaudeTmuxStateKey, useClaudeTmuxStore } from "./claudeTmuxStore";
import { useCodexStore } from "./codexStore";
import { useOpenCodeStore } from "./openCodeStore";
import { useNativeComposeStore } from "./nativeComposeStore";
import * as backend from "@/lib/backend";
import { boundBrowserHistory, sanitizeBrowserHistoryForPersistence } from "@/lib/browser-history";
import { createUuid } from "@/lib/uuid";
import { destroyBrowserPreview } from "@/lib/native/browser-preview";
import { forgetAgentHandoff } from "@/lib/agent-handoff";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

/**
 * Per-environment state for pane layout
 */
export interface EnvironmentPaneState {
  root: PaneNode;
  activePaneId: string;
  containerId: string | null;
  /** Last backend revision incorporated into this renderer's pane tree. */
  backendRevision?: number;
}

interface NativePlatformLockOptions {
  initialPrompt?: string;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  initialConversationMode?: "build" | "plan";
  initialFastMode?: boolean;
  initialExecutionProfileId?: string;
}

export type PaneLayoutHydrationStatus = "pending" | "done";

// Generate unique IDs across desktop and secure/insecure browser contexts.
function generateId(prefix: string): string {
  return `${prefix}-${createUuid()}`;
}

// Tree helper functions
function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (isPaneLeaf(node)) {
    return node.id === paneId ? node : null;
  }
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

function findParentSplit(
  node: PaneNode,
  targetId: string,
  parent: PaneSplit | null = null,
): PaneSplit | null {
  if (isPaneLeaf(node)) {
    return node.id === targetId ? parent : null;
  }

  for (const child of node.children) {
    if (child.id === targetId) {
      return node;
    }
    const found = findParentSplit(child, targetId, node);
    if (found) return found;
  }
  return null;
}

function findFirstLeaf(node: PaneNode): PaneLeaf {
  if (isPaneLeaf(node)) return node;
  // Defensive check: ensure children array has elements
  const firstChild = node.children[0];
  if (!firstChild) {
    throw new Error("[PaneLayout] Invalid tree structure: split node has no children");
  }
  return findFirstLeaf(firstChild);
}

/**
 * Find which pane contains a tab with the given ID
 * Returns the pane leaf if found, null otherwise
 */
function findPaneWithTab(node: PaneNode, tabId: string): PaneLeaf | null {
  if (isPaneLeaf(node)) {
    return node.tabs.some((t) => t.id === tabId) ? node : null;
  }
  for (const child of node.children) {
    const found = findPaneWithTab(child, tabId);
    if (found) return found;
  }
  return null;
}

function mergeTabsAddedDuringHydration(
  current: EnvironmentPaneState | undefined,
  restored: EnvironmentPaneState,
): EnvironmentPaneState {
  if (!current) return restored;

  const restoredTabIds = new Set(
    getAllLeaves(restored.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.id)),
  );
  const addedTabs = getAllLeaves(current.root)
    .flatMap((leaf) => leaf.tabs)
    .filter((tab) => !restoredTabIds.has(tab.id));
  if (addedTabs.length === 0) return restored;

  const restoredTarget =
    findLeaf(restored.root, current.activePaneId) ?? findFirstLeaf(restored.root);
  const currentActiveTabId = findLeaf(current.root, current.activePaneId)?.activeTabId;
  const activeTabId =
    currentActiveTabId && addedTabs.some((tab) => tab.id === currentActiveTabId)
      ? currentActiveTabId
      : restoredTarget.activeTabId;
  return {
    ...restored,
    root: updateLeaf(restored.root, restoredTarget.id, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, ...addedTabs],
      activeTabId,
    })),
    activePaneId: activeTabId === currentActiveTabId ? restoredTarget.id : restored.activePaneId,
  };
}

function getDepth(node: PaneNode): number {
  if (isPaneLeaf(node)) return 0;
  return 1 + Math.max(getDepth(node.children[0]), getDepth(node.children[1]));
}

function replaceNode(root: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (root.id === targetId) {
    return replacement;
  }
  if (isPaneLeaf(root)) {
    return root;
  }
  return {
    ...root,
    children: [
      replaceNode(root.children[0], targetId, replacement),
      replaceNode(root.children[1], targetId, replacement),
    ] as [PaneNode, PaneNode],
  };
}

function updateLeaf(
  root: PaneNode,
  paneId: string,
  updater: (leaf: PaneLeaf) => PaneLeaf,
): PaneNode {
  if (isPaneLeaf(root)) {
    return root.id === paneId ? updater(root) : root;
  }
  return {
    ...root,
    children: [
      updateLeaf(root.children[0], paneId, updater),
      updateLeaf(root.children[1], paneId, updater),
    ] as [PaneNode, PaneNode],
  };
}

/**
 * Recursively collects all leaf panes from a pane tree.
 * Useful for getting all tabs across all panes.
 */
export function getAllLeaves(node: PaneNode): PaneLeaf[] {
  if (isPaneLeaf(node)) return [node];
  return [...getAllLeaves(node.children[0]), ...getAllLeaves(node.children[1])];
}

interface PaneLayoutState {
  // Per-environment state (keyed by environmentId)
  environments: Map<string, EnvironmentPaneState>;
  // Restore-on-connect state (keyed by environmentId)
  hydration: Map<string, PaneLayoutHydrationStatus>;
  // Currently active environment ID
  activeEnvironmentId: string | null;

  // Actions
  setActiveEnvironment: (environmentId: string) => void;
  initialize: (containerId: string | null, environmentId?: string) => void;
  reset: (environmentId?: string) => void;
  beginHydration: (environmentId: string) => void;
  finishHydration: (environmentId: string, restored?: EnvironmentPaneState) => void;
  applyAuthoritativeLayout: (environmentId: string, restored: EnvironmentPaneState) => void;

  // Tab management
  addTab: (paneId: string, tab: TabInfo, environmentId?: string) => void;
  removeTab: (paneId: string, tabId: string, environmentId?: string) => void;
  setActiveTab: (paneId: string, tabId: string, environmentId?: string) => void;
  moveTab: (
    fromPaneId: string,
    toPaneId: string,
    tabId: string,
    toIndex?: number,
    environmentId?: string,
  ) => void;
  reorderTabs: (paneId: string, fromIndex: number, toIndex: number, environmentId?: string) => void;
  clearTabInitialPrompt: (tabId: string, environmentId?: string) => void;
  clearTabInitialAgentOptions: (tabId: string, environmentId?: string) => void;
  clearTabAgentHandoff: (tabId: string, environmentId?: string) => void;
  updateTabNativeSessionId: (
    tabId: string,
    sessionId: string | undefined,
    environmentId?: string,
  ) => void;
  lockTabNativePlatform: (
    tabId: string,
    platform: AgentPlatform,
    environmentId?: string,
    initial?: string | NativePlatformLockOptions,
  ) => AgentPlatform | null;
  updateTabBrowserUrl: (
    tabId: string,
    url: string,
    environmentId?: string,
    history?: string[],
    historyIndex?: number,
  ) => void;

  // Pane management
  splitPane: (
    paneId: string,
    direction: "horizontal" | "vertical",
    tabId: string,
    environmentId?: string,
  ) => void;
  splitPaneAtEdge: (
    targetPaneId: string,
    edge: EdgeDirection,
    tabId: string,
    fromPaneId: string,
    environmentId?: string,
  ) => void;
  closePane: (paneId: string, environmentId?: string) => void;
  setActivePane: (paneId: string, environmentId?: string) => void;
  updateSizes: (splitId: string, sizes: [number, number], environmentId?: string) => void;

  // Getters for current environment state
  getRoot: (environmentId?: string) => PaneNode;
  getActivePaneId: (environmentId?: string) => string;
  getContainerId: (environmentId?: string) => string | null;
  getPane: (paneId: string, environmentId?: string) => PaneLeaf | null;
  getActivePane: (environmentId?: string) => PaneLeaf | null;
  getAllTabs: (environmentId?: string) => TabInfo[];
  getOpenFilePaths: (environmentId?: string) => string[];
  findPaneWithTab: (tabId: string, environmentId?: string) => PaneLeaf | null;
}

// Create initial single-pane layout
function createInitialLayout(): PaneLeaf {
  return {
    kind: "leaf",
    id: "default",
    tabs: [],
    activeTabId: null,
  };
}

// Helper to get current environment state or default
function getEnvironmentPaneState(
  state: PaneLayoutState,
  environmentId?: string | null,
): EnvironmentPaneState {
  const envId = environmentId ?? state.activeEnvironmentId;
  if (!envId) {
    return {
      root: createInitialLayout(),
      activePaneId: "default",
      containerId: null,
    };
  }
  return (
    state.environments.get(envId) ?? {
      root: createInitialLayout(),
      activePaneId: "default",
      containerId: null,
    }
  );
}

const TERMINAL_TAB_TYPES = new Set(["plain", "claude", "opencode", "codex", "root"]);

function cleanupTerminalTab(envId: string, containerId: string | null, tabId: string) {
  const sessionStore = useTerminalSessionStore.getState();
  const sessionKey = createTerminalSessionKey(containerId, tabId, envId);
  const sessionData = sessionStore.sessions.get(sessionKey);
  if (sessionData) {
    console.debug(
      "[PaneLayout] Cleaning up terminal session for closed tab:",
      sessionKey,
      sessionData.sessionId,
    );
  }
  void backend
    .teardownTab({
      environmentId: envId,
      tabId,
      kind: "terminal",
      sessionId: sessionData?.sessionId,
      persistentSessionId: sessionData?.persistentSessionId,
    })
    .catch((err) => {
      console.debug("[PaneLayout] Terminal teardown remains pending:", err);
    });
  if (sessionData) sessionStore.removeSession(sessionKey);
}

function cleanupClaudeNativeTab(envId: string, tabId: string) {
  const store = useClaudeStore.getState();
  const sessionKey = createSessionKey(envId, tabId);
  const session = store.sessions.get(sessionKey);
  // Drops every session-keyed map for this tab, not just the queue and session:
  // tab ids are UUIDs, so anything left behind is never reclaimed.
  store.clearSession(sessionKey);
  void backend
    .teardownTab({
      environmentId: envId,
      tabId,
      kind: "claude-native",
      sessionId: session?.sessionId,
    })
    .catch((err) => console.debug("[PaneLayout] Claude teardown remains pending:", err));
}

function cleanupOpenCodeNativeTab(envId: string, tabId: string) {
  const store = useOpenCodeStore.getState();
  const sessionKey = createSessionKey(envId, tabId);
  const session = store.sessions.get(sessionKey);
  // Drops every session-keyed map for this tab, not just the queue and session:
  // tab ids are UUIDs, so anything left behind is never reclaimed.
  store.clearSession(sessionKey);
  void backend
    .teardownTab({
      environmentId: envId,
      tabId,
      kind: "opencode-native",
      sessionId: session?.sessionId,
    })
    .catch((err) => console.debug("[PaneLayout] OpenCode teardown remains pending:", err));
}

function cleanupCodexNativeTab(envId: string, tabId: string) {
  const store = useCodexStore.getState();
  const sessionKey = createSessionKey(envId, tabId);
  const session = store.sessions.get(sessionKey);
  // Drops every session-keyed map for this tab, not just the queue and session:
  // tab ids are UUIDs, so anything left behind is never reclaimed.
  store.clearSession(sessionKey);
  void backend
    .teardownTab({
      environmentId: envId,
      tabId,
      kind: "codex-native",
      sessionId: session?.sessionId,
    })
    .catch((err) => console.debug("[PaneLayout] Codex teardown remains pending:", err));
}

function cleanupAcpNativeTab(envId: string, tab: TabInfo) {
  const data = getNativeAgentData(tab);
  if (data?.platform !== "cursor" && data?.platform !== "grok") return;
  void backend
    .teardownTab({
      environmentId: envId,
      tabId: tab.id,
      kind: `${data.platform}-native`,
      sessionId: data.sessionId,
    })
    .catch((err) => console.debug("[PaneLayout] ACP teardown remains pending:", err));
}

function cleanupClaudeTmuxTab(envId: string, tabId: string) {
  const store = useClaudeTmuxStore.getState();
  store.resetTab(createClaudeTmuxStateKey(envId, tabId));
  // Also clear any legacy bare-key state that may exist from before the
  // (envId, tabId) composite key migration.
  store.resetTab(tabId);
  void backend
    .teardownTab({ environmentId: envId, tabId, kind: "claude-tmux" })
    .catch((err) => console.debug("[PaneLayout] tmux teardown remains pending:", err));
}

function cleanupTabResources(envId: string, containerId: string | null, tab: TabInfo) {
  if (tab.type === "browser") {
    destroyBrowserPreview(tab.id).catch((err) => {
      console.debug("[PaneLayout] Error destroying browser preview:", err);
    });
    return;
  }

  if (TERMINAL_TAB_TYPES.has(tab.type)) {
    cleanupTerminalTab(envId, containerId, tab.id);
    return;
  }

  if (tab.type === "agent-native") {
    useNativeComposeStore.getState().clearDraft(createSessionKey(envId, tab.id));
    const platform = getNativeAgentData(tab)?.platform;
    if (platform === "claude") cleanupClaudeNativeTab(envId, tab.id);
    else if (platform === "opencode") cleanupOpenCodeNativeTab(envId, tab.id);
    else if (platform === "codex") cleanupCodexNativeTab(envId, tab.id);
    else if (platform === "cursor" || platform === "grok") cleanupAcpNativeTab(envId, tab);
    return;
  }

  if (tab.type === "claude-tmux") {
    cleanupClaudeTmuxTab(envId, tab.id);
  }
}

/**
 * Reclaims renderer-owned state after an authoritative layout removes a tab.
 *
 * Native provider sessions are only evicted locally because the initiating
 * client owns their deletion. Terminal PTYs are different: only the renderer
 * with the live terminal-session entry knows the exact PTY id, so that owner
 * closes/detaches it and records the persistent session as disconnected.
 */
function cleanupLocalTabResources(envId: string, containerId: string | null, tab: TabInfo): void {
  useTerminalPortalStore.getState().disposeTerminal(envId, tab.id);

  if (tab.type === "browser") {
    destroyBrowserPreview(tab.id).catch((err) => {
      console.debug("[PaneLayout] Error destroying browser preview:", err);
    });
    return;
  }

  if (TERMINAL_TAB_TYPES.has(tab.type)) {
    cleanupTerminalTab(envId, containerId, tab.id);
    return;
  }

  const sessionKey = createSessionKey(envId, tab.id);
  if (tab.type === "agent-native") {
    const platform = getNativeAgentData(tab)?.platform;
    if (platform === "claude") useClaudeStore.getState().clearSession(sessionKey);
    else if (platform === "opencode") useOpenCodeStore.getState().clearSession(sessionKey);
    else if (platform === "codex") useCodexStore.getState().clearSession(sessionKey);
    return;
  }
  if (tab.type === "claude-tmux") {
    const store = useClaudeTmuxStore.getState();
    store.resetTab(createClaudeTmuxStateKey(envId, tab.id));
    store.resetTab(tab.id);
  }
}

function tabHandoffIds(tab: TabInfo): string[] {
  return tab.agentHandoffId ? [tab.agentHandoffId] : [];
}

function deleteUnreferencedAgentHandoffs(
  envId: string,
  removedTabs: TabInfo[],
  remainingRoot: PaneNode,
): void {
  const remainingHandoffIds = new Set(
    getAllLeaves(remainingRoot)
      .flatMap((leaf) => leaf.tabs)
      .flatMap(tabHandoffIds),
  );
  const removedHandoffIds = new Set(removedTabs.flatMap(tabHandoffIds));
  for (const handoffId of removedHandoffIds) {
    if (remainingHandoffIds.has(handoffId)) continue;
    forgetAgentHandoff(handoffId);
    backend.deleteAgentHandoff(handoffId, envId).catch((error) => {
      console.debug("[PaneLayout] Error deleting agent handoff:", error);
    });
  }
}

function forgetUnreferencedAgentHandoffs(previousRoot: PaneNode, remainingRoot: PaneNode): void {
  const previousHandoffIds = new Set(
    getAllLeaves(previousRoot)
      .flatMap((leaf) => leaf.tabs)
      .flatMap(tabHandoffIds),
  );
  const remainingHandoffIds = new Set(
    getAllLeaves(remainingRoot)
      .flatMap((leaf) => leaf.tabs)
      .flatMap(tabHandoffIds),
  );
  for (const handoffId of previousHandoffIds) {
    if (!remainingHandoffIds.has(handoffId)) forgetAgentHandoff(handoffId);
  }
}

/**
 * Reclaims handoffs the restored layout no longer references.
 *
 * The per-tab delete is fire-and-forget; if it is dropped (backend restart, lock
 * timeout, app kill) the reference is already gone from the layout, so nothing
 * retries and a sensitive transcript is stranded on disk forever. Hydration is
 * the one moment the full reference set for an environment is authoritative.
 */
function pruneUnreferencedAgentHandoffs(envId: string, root: PaneNode): void {
  const referenced = getAllLeaves(root)
    .flatMap((leaf) => leaf.tabs)
    .flatMap(tabHandoffIds);
  backend.pruneAgentHandoffs(envId, referenced).catch((error) => {
    console.debug("[PaneLayout] Error pruning agent handoffs:", error);
  });
}

export const usePaneLayoutStore = create<PaneLayoutState>()((set, get) => ({
  environments: new Map(),
  hydration: new Map(),
  activeEnvironmentId: null,

  // Getter functions for current environment state
  getRoot: (environmentId) => getEnvironmentPaneState(get(), environmentId).root,
  getActivePaneId: (environmentId) => getEnvironmentPaneState(get(), environmentId).activePaneId,
  getContainerId: (environmentId) => getEnvironmentPaneState(get(), environmentId).containerId,

  setActiveEnvironment: (environmentId: string) => {
    const state = get();
    if (state.activeEnvironmentId === environmentId) return;

    console.debug("[PaneLayout] Setting active environment:", environmentId);

    // Ensure the environment has state (create if not exists)
    if (!state.environments.has(environmentId)) {
      const newEnvs = new Map(state.environments);
      newEnvs.set(environmentId, {
        root: createInitialLayout(),
        activePaneId: "default",
        containerId: null,
        backendRevision: 0,
      });
      set({ environments: newEnvs, activeEnvironmentId: environmentId });
    } else {
      set({ activeEnvironmentId: environmentId });
    }
  },

  initialize: (containerId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) {
      console.warn("[PaneLayout] initialize called without active environment");
      return;
    }

    console.debug(
      "[PaneLayout] Initializing environment:",
      envId,
      "with containerId:",
      containerId,
    );

    const existing = state.environments.get(envId);
    const existingTabs = existing ? getAllLeaves(existing.root).flatMap((leaf) => leaf.tabs) : [];
    const newEnvs = new Map(state.environments);
    // A tab can already be here: the build supervisor inserts its tab as soon
    // as the backend returns a pipeline, which is before this container mounts.
    // Replacing the root wholesale would drop it, and nothing re-adds it.
    // Adopting the existing layout still records the containerId, which is what
    // the terminal session keys are built from.
    newEnvs.set(
      envId,
      existingTabs.length > 0
        ? { ...existing!, containerId }
        : {
            root: createInitialLayout(),
            activePaneId: "default",
            containerId,
            backendRevision: 0,
          },
    );
    set({ environments: newEnvs });
  },

  reset: (environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const terminalPortalStore = useTerminalPortalStore.getState();
    const containerId = envState.containerId;

    const envTabs = getAllLeaves(envState.root).flatMap((leaf) => leaf.tabs);
    envTabs.forEach((tab) => {
      cleanupTabResources(envId, containerId, tab);
    });

    // Clear all terminal instances from portal store for this environment
    console.debug("[PaneLayout] Clearing terminal instances for environment on reset:", envId);
    terminalPortalStore.clearTerminalsForEnvironment(envId);

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, {
      root: createInitialLayout(),
      activePaneId: "default",
      containerId: null,
      backendRevision: 0,
    });
    set({ environments: newEnvs });
  },

  beginHydration: (environmentId) => {
    const state = get();
    if (state.hydration.has(environmentId)) return;
    const hydration = new Map(state.hydration);
    hydration.set(environmentId, "pending");
    set({ hydration });
  },

  finishHydration: (environmentId, restored) => {
    const state = get();
    const hydration = new Map(state.hydration);
    hydration.set(environmentId, "done");

    if (!restored) {
      set({ hydration });
      // Nothing was restored, so no tab in this environment references a
      // handoff. Any stored record is orphaned.
      pruneUnreferencedAgentHandoffs(
        environmentId,
        state.environments.get(environmentId)?.root ?? createInitialLayout(),
      );
      return;
    }

    const environments = new Map(state.environments);
    const reconciled = mergeTabsAddedDuringHydration(
      state.environments.get(environmentId),
      restored,
    );
    environments.set(environmentId, reconciled);
    set({ environments, hydration });
    pruneUnreferencedAgentHandoffs(environmentId, reconciled.root);
  },

  applyAuthoritativeLayout: (environmentId, restored) => {
    const state = get();
    // Hydration must have settled so a snapshot cannot clobber an in-flight
    // restore. A missing local record is still installable: a backend-owned
    // native launch can finish hydrating to null, then a later pane-layout
    // announcement has to be able to create the environment rather than
    // no-op forever.
    if (state.hydration.get(environmentId) !== "done") {
      return;
    }

    const current = state.environments.get(environmentId);
    const restoredTabs = getAllLeaves(restored.root).flatMap((leaf) => leaf.tabs);
    const restoredTabIds = new Set(restoredTabs.map((tab) => tab.id));
    if (current) {
      const removedTabs = getAllLeaves(current.root)
        .flatMap((leaf) => leaf.tabs)
        .filter((tab) => !restoredTabIds.has(tab.id));
      for (const tab of removedTabs) {
        cleanupLocalTabResources(environmentId, current.containerId, tab);
      }
    }

    const environments = new Map(state.environments);
    environments.set(environmentId, restored);
    set({ environments });
    if (current) {
      forgetUnreferencedAgentHandoffs(current.root, restored.root);
    }
    pruneUnreferencedAgentHandoffs(environmentId, restored.root);
  },

  addTab: (paneId, tab, environmentId) => {
    const state = get();
    // Use explicit environmentId if provided, otherwise fall back to activeEnvironmentId
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    // Check if a tab with this ID already exists in any pane
    const existingPane = findPaneWithTab(envState.root, tab.id);
    if (existingPane) {
      // Tab already exists - just activate it instead of duplicating
      console.debug(
        "[PaneLayout] Tab already exists, activating:",
        tab.id,
        "in pane:",
        existingPane.id,
      );
      const newRoot = updateLeaf(envState.root, existingPane.id, (leaf) => ({
        ...leaf,
        activeTabId: tab.id,
      }));
      const newEnvs = new Map(state.environments);
      newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: existingPane.id });
      set({ environments: newEnvs });
      return;
    }

    // Every newly-created native tab immediately carries the canonical
    // provider-neutral identity, even while legacy fields remain for callers
    // restored from older pane records.
    const nativeAgentData = getNativeAgentData(tab);
    const canonicalTab = nativeAgentData ? { ...tab, nativeAgentData } : tab;

    // Tab doesn't exist - add it to the specified pane
    const newRoot = updateLeaf(envState.root, paneId, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, canonicalTab],
      activeTabId: tab.id,
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
  },

  removeTab: (paneId, tabId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const leaf = findLeaf(envState.root, paneId);
    if (!leaf) return;

    const closedTab = leaf.tabs.find((t) => t.id === tabId);
    if (!closedTab) return;

    const remainingTabs = leaf.tabs.filter((t) => t.id !== tabId);

    // If this was the last tab, close the pane
    if (remainingTabs.length === 0) {
      const parentSplit = findParentSplit(envState.root, paneId);
      if (parentSplit) {
        get().closePane(paneId, envId);
      } else {
        cleanupTabResources(envId, envState.containerId, closedTab);
        useTerminalPortalStore.getState().disposeTerminal(envId, tabId);
        const newRoot = updateLeaf(envState.root, paneId, () => ({
          ...leaf,
          tabs: [],
          activeTabId: null,
        }));
        const newEnvs = new Map(state.environments);
        newEnvs.set(envId, { ...envState, root: newRoot });
        set({ environments: newEnvs });
        deleteUnreferencedAgentHandoffs(envId, [closedTab], newRoot);
      }
      return;
    }

    cleanupTabResources(envId, envState.containerId, closedTab);
    useTerminalPortalStore.getState().disposeTerminal(envId, tabId);

    // Update the leaf with remaining tabs
    const newActiveTabId =
      leaf.activeTabId === tabId
        ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
        : leaf.activeTabId;

    const newRoot = updateLeaf(envState.root, paneId, () => ({
      ...leaf,
      tabs: remainingTabs,
      activeTabId: newActiveTabId,
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
    deleteUnreferencedAgentHandoffs(envId, [closedTab], newRoot);
  },

  setActiveTab: (paneId, tabId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;
    const pane = findLeaf(envState.root, paneId);
    if (!pane || !pane.tabs.some((tab) => tab.id === tabId)) return;

    const newRoot = updateLeaf(envState.root, paneId, (leaf) => ({
      ...leaf,
      activeTabId: tabId,
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: paneId });
    set({ environments: newEnvs });
  },

  moveTab: (fromPaneId, toPaneId, tabId, toIndex, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) {
      console.warn("[paneLayoutStore] moveTab failed: no activeEnvironmentId");
      return;
    }

    const envState = state.environments.get(envId);
    if (!envState) {
      console.warn("[paneLayoutStore] moveTab failed: no envState for", envId);
      return;
    }

    const fromLeaf = findLeaf(envState.root, fromPaneId);
    const toLeaf = findLeaf(envState.root, toPaneId);
    if (!fromLeaf || !toLeaf) {
      console.warn("[paneLayoutStore] moveTab failed: pane not found", {
        fromPaneId,
        toPaneId,
        fromLeaf: !!fromLeaf,
        toLeaf: !!toLeaf,
      });
      return;
    }

    const tab = fromLeaf.tabs.find((t) => t.id === tabId);
    if (!tab) {
      console.warn("[paneLayoutStore] moveTab failed: tab not found", {
        tabId,
        availableTabs: fromLeaf.tabs.map((t) => t.id),
      });
      return;
    }

    console.debug("[paneLayoutStore] moveTab executing", { fromPaneId, toPaneId, tabId });

    // If moving within the same pane, just reorder
    if (fromPaneId === toPaneId) {
      const fromIndex = fromLeaf.tabs.findIndex((t) => t.id === tabId);
      if (toIndex !== undefined && fromIndex !== toIndex) {
        get().reorderTabs(fromPaneId, fromIndex, toIndex, envId);
      }
      return;
    }

    // Remove from source
    const remainingTabs = fromLeaf.tabs.filter((t) => t.id !== tabId);

    // If source pane will be empty, we need to close it
    if (remainingTabs.length === 0) {
      // Remove the tab before collapsing the source so moving a live tab does
      // not look like closing it and trigger resource cleanup.
      let newRoot = updateLeaf(envState.root, fromPaneId, (leaf) => ({
        ...leaf,
        tabs: [],
        activeTabId: null,
      }));
      newRoot = updateLeaf(newRoot, toPaneId, (leaf) => {
        const newTabs = [...leaf.tabs];
        if (toIndex !== undefined) {
          newTabs.splice(toIndex, 0, tab);
        } else {
          newTabs.push(tab);
        }
        return {
          ...leaf,
          tabs: newTabs,
          activeTabId: tab.id,
        };
      });
      const sourceParent = findParentSplit(newRoot, fromPaneId);
      if (!sourceParent) return;
      const siblingIndex = sourceParent.children[0].id === fromPaneId ? 1 : 0;
      newRoot = replaceNode(newRoot, sourceParent.id, sourceParent.children[siblingIndex]);

      const newEnvs = new Map(state.environments);
      newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: toPaneId });
      set({ environments: newEnvs });
      return;
    }

    // Both panes will have tabs after the move
    // Remove from source
    let newRoot = updateLeaf(envState.root, fromPaneId, (leaf) => ({
      ...leaf,
      tabs: remainingTabs,
      activeTabId:
        leaf.activeTabId === tabId
          ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
          : leaf.activeTabId,
    }));

    // Add to target
    newRoot = updateLeaf(newRoot, toPaneId, (leaf) => {
      const newTabs = [...leaf.tabs];
      if (toIndex !== undefined) {
        newTabs.splice(toIndex, 0, tab);
      } else {
        newTabs.push(tab);
      }
      return {
        ...leaf,
        tabs: newTabs,
        activeTabId: tab.id,
      };
    });

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: toPaneId });
    set({ environments: newEnvs });
  },

  reorderTabs: (paneId, fromIndex, toIndex, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const newRoot = updateLeaf(envState.root, paneId, (leaf) => {
      const hasValidIndexes =
        Number.isInteger(fromIndex) &&
        Number.isInteger(toIndex) &&
        fromIndex >= 0 &&
        fromIndex < leaf.tabs.length &&
        toIndex >= 0 &&
        toIndex < leaf.tabs.length;
      if (!hasValidIndexes || fromIndex === toIndex) {
        return leaf;
      }

      const newTabs = [...leaf.tabs];
      const [moved] = newTabs.splice(fromIndex, 1);
      if (moved) {
        newTabs.splice(toIndex, 0, moved);
      }
      return {
        ...leaf,
        tabs: newTabs,
      };
    });

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
  },

  clearTabInitialPrompt: (tabId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    // Find the pane containing this tab
    const paneWithTab = findPaneWithTab(envState.root, tabId);
    if (!paneWithTab) return;

    // Update the tab to remove initialPrompt
    const newRoot = updateLeaf(envState.root, paneWithTab.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((tab) => (tab.id === tabId ? { ...tab, initialPrompt: undefined } : tab)),
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
    console.debug("[PaneLayout] Cleared initialPrompt for tab:", tabId);
  },

  clearTabInitialAgentOptions: (tabId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const paneWithTab = findPaneWithTab(envState.root, tabId);
    if (!paneWithTab) return;

    const newRoot = updateLeaf(envState.root, paneWithTab.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              initialAgentModel: undefined,
              initialReasoningEffort: undefined,
              initialConversationMode: undefined,
              initialFastMode: undefined,
              initialExecutionProfileId: undefined,
            }
          : tab,
      ),
    }));

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
    console.debug("[PaneLayout] Cleared initial agent options for tab:", tabId);
  },

  clearTabAgentHandoff: (tabId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;
    const paneWithTab = findPaneWithTab(envState.root, tabId);
    if (!paneWithTab) return;
    const tabWithHandoff = paneWithTab.tabs.find((tab) => tab.id === tabId);
    if (!tabWithHandoff?.agentHandoffId) return;

    // Retain the id as consumed. The snapshot is deleted below, but the
    // bootstrap prompt it produced is still the destination session's first
    // message; forgetting the id entirely would render that raw JSON frame.
    const consumedAgentHandoffId = tabWithHandoff.agentHandoffId;
    const newRoot = updateLeaf(envState.root, paneWithTab.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, agentHandoffId: undefined, consumedAgentHandoffId } : tab,
      ),
    }));
    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
    deleteUnreferencedAgentHandoffs(envId, [tabWithHandoff], newRoot);
  },

  updateTabNativeSessionId: (tabId, sessionId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;
    const paneWithTab = findPaneWithTab(envState.root, tabId);
    const existingTab = paneWithTab?.tabs.find((tab) => tab.id === tabId);
    if (!paneWithTab || !existingTab) return;

    const nativeAgentData = getNativeAgentData(existingTab);
    if (!nativeAgentData) return;

    const currentSessionId = nativeAgentData.sessionId;
    if (currentSessionId === sessionId) return;

    const newRoot = updateLeaf(envState.root, paneWithTab.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const nextNativeAgentData = getNativeAgentData(tab);
        return nextNativeAgentData
          ? { ...tab, nativeAgentData: { ...nextNativeAgentData, sessionId } }
          : tab;
      }),
    }));

    const environments = new Map(state.environments);
    environments.set(envId, { ...envState, root: newRoot });
    set({ environments });
  },

  lockTabNativePlatform: (tabId, platform, environmentId, initial) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return null;
    const envState = state.environments.get(envId);
    if (!envState) return null;
    const pane = findPaneWithTab(envState.root, tabId);
    const tab = pane?.tabs.find((candidate) => candidate.id === tabId);
    const data = tab ? getNativeAgentData(tab) : null;
    if (!pane || !data) return null;
    if (data.platform) return data.platform;
    const initialOptions =
      typeof initial === "string" ? { initialPrompt: initial } : (initial ?? {});

    const root = updateLeaf(envState.root, pane.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((candidate) =>
        candidate.id === tabId
          ? {
              ...candidate,
              nativeAgentData: { ...data, platform },
              ...(initialOptions.initialPrompt !== undefined
                ? { initialPrompt: initialOptions.initialPrompt }
                : {}),
              ...(initialOptions.initialAgentModel !== undefined
                ? { initialAgentModel: initialOptions.initialAgentModel }
                : {}),
              ...(initialOptions.initialReasoningEffort !== undefined
                ? { initialReasoningEffort: initialOptions.initialReasoningEffort }
                : {}),
              ...(initialOptions.initialConversationMode !== undefined
                ? { initialConversationMode: initialOptions.initialConversationMode }
                : {}),
              ...(initialOptions.initialFastMode !== undefined
                ? { initialFastMode: initialOptions.initialFastMode }
                : {}),
              ...(initialOptions.initialExecutionProfileId !== undefined
                ? { initialExecutionProfileId: initialOptions.initialExecutionProfileId }
                : {}),
            }
          : candidate,
      ),
    }));
    const environments = new Map(state.environments);
    environments.set(envId, { ...envState, root });
    set({ environments });
    return platform;
  },

  updateTabBrowserUrl: (tabId, url, environmentId, history, historyIndex) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;
    const paneWithTab = findPaneWithTab(envState.root, tabId);
    const existingTab = paneWithTab?.tabs.find((tab) => tab.id === tabId);
    if (!paneWithTab || existingTab?.type !== "browser" || !existingTab.browserData) return;
    if (existingTab.browserData.url === url && history === undefined && historyIndex === undefined)
      return;

    // A cursor without a new array still has to be clamped: it addresses the
    // history already stored on the tab.
    const { history: boundedHistory, historyIndex: boundedHistoryIndex } = boundBrowserHistory(
      history
        ? sanitizeBrowserHistoryForPersistence(history)
        : existingTab.browserData.history
          ? sanitizeBrowserHistoryForPersistence(existingTab.browserData.history)
          : undefined,
      historyIndex ?? (history === undefined ? existingTab.browserData.historyIndex : undefined),
    );

    const newRoot = updateLeaf(envState.root, paneWithTab.id, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map((tab) =>
        tab.id === tabId && tab.type === "browser" && tab.browserData
          ? {
              ...tab,
              browserData: {
                ...tab.browserData,
                url,
                ...(boundedHistory !== undefined ? { history: boundedHistory } : {}),
                ...(boundedHistoryIndex !== undefined ? { historyIndex: boundedHistoryIndex } : {}),
              },
            }
          : tab,
      ),
    }));

    const environments = new Map(state.environments);
    environments.set(envId, { ...envState, root: newRoot });
    set({ environments });
  },

  splitPane: (paneId, direction, tabId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const leaf = findLeaf(envState.root, paneId);
    if (!leaf) return;

    // Check depth limit
    const currentDepth = getDepth(envState.root);
    if (currentDepth >= MAX_SPLIT_DEPTH) {
      console.debug("[PaneLayout] Max split depth reached");
      return;
    }

    // Find the tab to move to the new pane
    const tab = leaf.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Remove the tab from the original pane
    const remainingTabs = leaf.tabs.filter((t) => t.id !== tabId);

    // Create the new pane with the moved tab
    const newPaneId = generateId("pane");
    const newPane: PaneLeaf = {
      kind: "leaf",
      id: newPaneId,
      tabs: [tab],
      activeTabId: tab.id,
    };

    // Update the original pane
    const updatedOriginalPane: PaneLeaf = {
      ...leaf,
      tabs: remainingTabs,
      activeTabId:
        remainingTabs.length > 0 ? (remainingTabs[remainingTabs.length - 1]?.id ?? null) : null,
    };

    // Create the split - new pane goes to the right/bottom
    const newSplit: PaneSplit = {
      kind: "split",
      id: generateId("split"),
      direction,
      children: [updatedOriginalPane, newPane],
      sizes: [50, 50],
      depth: currentDepth + 1,
    };

    // Replace the original pane with the split
    const newRoot = replaceNode(envState.root, paneId, newSplit);
    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: newPaneId });
    set({ environments: newEnvs });
  },

  splitPaneAtEdge: (targetPaneId, edge, tabId, fromPaneId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: no activeEnvironmentId");
      return;
    }

    const envState = state.environments.get(envId);
    if (!envState) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: no envState for", envId);
      return;
    }

    const targetLeaf = findLeaf(envState.root, targetPaneId);
    if (!targetLeaf) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: target pane not found", targetPaneId);
      return;
    }

    const sourceLeaf = findLeaf(envState.root, fromPaneId);
    if (!sourceLeaf) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: source pane not found", fromPaneId);
      return;
    }

    // Check depth limit
    const currentDepth = getDepth(envState.root);
    if (currentDepth >= MAX_SPLIT_DEPTH) {
      console.debug("[PaneLayout] Max split depth reached");
      return;
    }

    // Find the tab in the SOURCE pane
    const tab = sourceLeaf.tabs.find((t) => t.id === tabId);
    if (!tab) {
      console.warn("[paneLayoutStore] splitPaneAtEdge failed: tab not found in source pane", {
        tabId,
        fromPaneId,
      });
      return;
    }

    console.debug("[paneLayoutStore] splitPaneAtEdge executing", {
      targetPaneId,
      edge,
      tabId,
      fromPaneId,
    });

    // Create the new pane with the moved tab
    const newPaneId = generateId("pane");
    const newPane: PaneLeaf = {
      kind: "leaf",
      id: newPaneId,
      tabs: [tab],
      activeTabId: tab.id,
    };

    // Determine split direction and child order based on edge
    const direction: "horizontal" | "vertical" =
      edge === "left" || edge === "right" ? "horizontal" : "vertical";

    // Check if we're splitting within the same pane (source === target)
    const isSamePaneSplit = fromPaneId === targetPaneId;

    let newRoot: PaneNode;

    if (isSamePaneSplit) {
      // When splitting within the same pane, we need to:
      // 1. Create updated target leaf WITHOUT the moved tab
      // 2. Create the split with the updated target leaf
      const remainingTabs = targetLeaf.tabs.filter((t) => t.id !== tabId);
      const updatedTargetLeaf: PaneLeaf = {
        ...targetLeaf,
        tabs: remainingTabs,
        activeTabId:
          targetLeaf.activeTabId === tabId
            ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
            : targetLeaf.activeTabId,
      };

      // For left/top edges, new pane comes first; for right/bottom, updated target comes first
      const children: [PaneNode, PaneNode] =
        edge === "left" || edge === "top"
          ? [newPane, updatedTargetLeaf]
          : [updatedTargetLeaf, newPane];

      const newSplit: PaneSplit = {
        kind: "split",
        id: generateId("split"),
        direction,
        children,
        sizes: [50, 50],
        depth: currentDepth + 1,
      };

      // Replace the pane with the split (no need to update source separately since it's the same pane)
      newRoot = replaceNode(envState.root, targetPaneId, newSplit);
    } else {
      // Different panes: remove from source, then create split at target
      // For left/top edges, new pane comes first; for right/bottom, target comes first
      const children: [PaneNode, PaneNode] =
        edge === "left" || edge === "top" ? [newPane, targetLeaf] : [targetLeaf, newPane];

      const newSplit: PaneSplit = {
        kind: "split",
        id: generateId("split"),
        direction,
        children,
        sizes: [50, 50],
        depth: currentDepth + 1,
      };

      // First, remove the tab from the source pane
      newRoot = updateLeaf(envState.root, fromPaneId, (leaf) => {
        const remainingTabs = leaf.tabs.filter((t) => t.id !== tabId);
        return {
          ...leaf,
          tabs: remainingTabs,
          activeTabId:
            leaf.activeTabId === tabId
              ? (remainingTabs[remainingTabs.length - 1]?.id ?? null)
              : leaf.activeTabId,
        };
      });

      // Then, replace the target pane with the split
      newRoot = replaceNode(newRoot, targetPaneId, newSplit);
    }

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: newPaneId });
    set({ environments: newEnvs });

    // If the source pane is now empty, close it (only for cross-pane splits)
    // For same-pane splits, the source pane was replaced by the split, so it doesn't exist anymore
    if (!isSamePaneSplit) {
      const updatedSourceLeaf = findLeaf(newRoot, fromPaneId);
      if (updatedSourceLeaf && updatedSourceLeaf.tabs.length === 0) {
        // Use a timeout to avoid state update conflicts
        setTimeout(() => get().closePane(fromPaneId, envId), 0);
      }
    }
  },

  closePane: (paneId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const parentSplit = findParentSplit(envState.root, paneId);

    // If no parent, this is the only pane - can't close it
    if (!parentSplit) {
      console.debug("[PaneLayout] Cannot close the only pane");
      return;
    }

    const pane = findLeaf(envState.root, paneId);
    if (!pane) return;

    pane.tabs.forEach((tab) => {
      cleanupTabResources(envId, envState.containerId, tab);
      useTerminalPortalStore.getState().disposeTerminal(envId, tab.id);
    });

    // Find the sibling
    const siblingIndex = parentSplit.children[0].id === paneId ? 1 : 0;
    const sibling = parentSplit.children[siblingIndex];

    // Replace parent split with sibling
    const newRoot = replaceNode(envState.root, parentSplit.id, sibling);
    // Update active pane if needed
    let newActivePaneId = envState.activePaneId;
    if (envState.activePaneId === paneId) {
      const firstLeaf = findFirstLeaf(sibling);
      newActivePaneId = firstLeaf.id;
    }

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot, activePaneId: newActivePaneId });
    set({ environments: newEnvs });
    deleteUnreferencedAgentHandoffs(envId, pane.tabs, newRoot);
  },

  setActivePane: (paneId, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;
    if (!findLeaf(envState.root, paneId)) return;

    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, activePaneId: paneId });
    set({ environments: newEnvs });
  },

  updateSizes: (splitId, sizes, environmentId) => {
    const state = get();
    const envId = environmentId ?? state.activeEnvironmentId;
    if (!envId) return;

    const envState = state.environments.get(envId);
    if (!envState) return;

    const update = (node: PaneNode): PaneNode => {
      if (isPaneLeaf(node)) return node;
      if (node.id === splitId) {
        return { ...node, sizes };
      }
      return {
        ...node,
        children: [update(node.children[0]), update(node.children[1])] as [PaneNode, PaneNode],
      };
    };

    const newRoot = update(envState.root);
    const newEnvs = new Map(state.environments);
    newEnvs.set(envId, { ...envState, root: newRoot });
    set({ environments: newEnvs });
  },

  getPane: (paneId, environmentId) => {
    const state = get();
    const envState = getEnvironmentPaneState(state, environmentId);
    return findLeaf(envState.root, paneId);
  },

  getActivePane: (environmentId) => {
    const state = get();
    const envState = getEnvironmentPaneState(state, environmentId);
    return findLeaf(envState.root, envState.activePaneId);
  },

  getAllTabs: (environmentId) => {
    const state = get();
    const envState = getEnvironmentPaneState(state, environmentId);
    const leaves = getAllLeaves(envState.root);
    return leaves.flatMap((leaf) => leaf.tabs);
  },

  getOpenFilePaths: (environmentId) => {
    const tabs = get().getAllTabs(environmentId);
    return tabs
      .filter((t) => t.type === "file" && t.fileData?.filePath)
      .map((t) => t.fileData!.filePath);
  },

  findPaneWithTab: (tabId: string, environmentId) => {
    const state = get();
    const envState = getEnvironmentPaneState(state, environmentId);
    return findPaneWithTab(envState.root, tabId);
  },
}));
