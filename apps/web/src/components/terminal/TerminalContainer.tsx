import { useEffect, useRef, useCallback, useState, type MouseEvent } from "react";
import type { BrowserPreviewOpenLinkEvent } from "@orkestrator/protocol/browser-preview";
import {
  DndContext,
  pointerWithin,
  rectIntersection,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  type CollisionDetection,
  type Collision,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useTerminalContext, MAX_TABS, type CreatableTabType, type TabType, type TerminalTabType, type CreateTabOptions, type CreateFileTabOptions } from "@/contexts";
import { createSessionKey, useClaudeOptionsStore, usePaneLayoutStore, useEnvironmentStore, useConfigStore, useTerminalSessionStore, getAllLeaves } from "@/stores";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FilePlus2, Play, Terminal as TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import * as backend from "@/lib/backend";
import {
  buildInitialPromptWithAttachmentReferences,
  saveInitialPromptAttachments,
} from "@/lib/initial-prompt-attachments";
import { resolveClaudeConfig } from "@/lib/claude-mode-resolver";
import { reconcilePersistedLayout } from "@/lib/pane-layout-restore";
import { createPersistedPaneLayoutInput, flushPaneLayoutNow } from "@/lib/pane-layout-persistence";
import {
  applyStoredPaneSelection,
  clearStoredPaneSelection,
  readStoredPaneSelection,
} from "@/lib/pane-selection-storage";
import { listenForTerminalBrowserTabRequests } from "@/lib/terminal-links";
import { createOrkestratorScriptPrompt } from "@/prompts";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useLoopedReviewStore } from "@/stores/loopedReviewStore";
import { hydrateLoopedReviewWorkflowsForEnvironment } from "@/lib/looped-review-persistence";
import { PaneTree } from "@/components/pane-layout";
import { TerminalPortalHost } from "./TerminalPortalHost";
import { InitializationLogs } from "./InitializationLogs";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import {
  parseDraggableTabId,
  parseEdgeDroppableId,
  isGitFileStatus,
  LEGACY_PANE_LAYOUT_VERSION,
  PANE_LAYOUT_VERSION,
  type EdgeDirection,
  type PaneLeaf,
  type PaneNode,
  type TabInfo,
} from "@/types/paneLayout";
import type { ClaudeNativeBackend } from "@/types";

interface TerminalContainerProps {
  environmentId: string;
  containerId: string | null;
  isContainerRunning?: boolean;
  isContainerCreating?: boolean;
  isActive?: boolean;
  className?: string;
  onStartContainer?: (initialPrompt?: string) => void;
  onCreateScript?: (initialPrompt: string) => void;
}

/**
 * Backoff between retries of a failed backend setup-session lookup, and the
 * point at which the tab is given up on and retired instead of retried forever.
 */
const SETUP_SESSION_BIND_RETRY_DELAY_MS = 2_000;
const SETUP_SESSION_BIND_MAX_ATTEMPTS = 3;

/**
 * Check if a collision ID represents a tab bar or tab (not an edge zone).
 */
const isTabOrTabbar = (collision: Collision): boolean => {
  const id = String(collision.id);
  return id.startsWith("tabbar:") || id.startsWith("tab:");
};

/**
 * Custom collision detection that prioritizes tab bars and tabs over edge zones.
 * Uses multiple strategies:
 * 1. First try pointer-based detection (most accurate when pointer is directly over target)
 * 2. Fall back to rect intersection for nearby targets
 * 3. Use closestCenter as last resort
 *
 * When multiple collisions are found, prioritize tabbars/tabs over edge zones
 * to prevent accidental splits when trying to combine tabs.
 */
export function createTerminalCollisionDetection({
  pointerDetection = pointerWithin,
  rectangleDetection = rectIntersection,
  nearestDetection = closestCenter,
}: {
  pointerDetection?: CollisionDetection;
  rectangleDetection?: CollisionDetection;
  nearestDetection?: CollisionDetection;
} = {}): CollisionDetection {
  return (args) => {
    // First, check if the pointer is directly over any droppable
    const pointerCollisions = pointerDetection(args);
    if (pointerCollisions.length > 0) {
      // Prioritize tabbars and tabs over edge zones
      const tabCollisions = pointerCollisions.filter(isTabOrTabbar);
      if (tabCollisions.length > 0) {
        return tabCollisions;
      }
      return pointerCollisions;
    }

    // Try rect intersection for nearby targets
    const rectCollisions = rectangleDetection(args);
    if (rectCollisions.length > 0) {
      // Prioritize tabbars and tabs over edge zones
      const tabCollisions = rectCollisions.filter(isTabOrTabbar);
      if (tabCollisions.length > 0) {
        return tabCollisions;
      }
      return rectCollisions;
    }

    // Last resort: use closestCenter to find the nearest target
    return nearestDetection(args);
  };
}

export const customCollisionDetection = createTerminalCollisionDetection();

let tabIdCounter = 0;

function createUniqueTabId(prefix: string): string {
  tabIdCounter = (tabIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now()}-${tabIdCounter}`;
}

/**
 * The one-shot environment launch is shared backend intent, so every renderer
 * must materialize it as the same logical tab. A random id lets two clients
 * that observe `pendingAgentLaunch` together create distinct tabs, distinct
 * Codex sessions, and distinct initial-prompt request ids before either clears
 * the flag. The stable id makes pane-layout merging, bridge session creation,
 * and prompt dispatch all converge on one launch.
 */
const STARTUP_AGENT_TAB_ID = "startup-agent";

/**
 * Which tab types count as "the agent a post-setup launch was asking for".
 *
 * Exhaustive over `TabType` on purpose: this table decides when a durable
 * `pendingAgentLaunch` is considered satisfied and can be cleared. A new tab type
 * that silently defaulted to `false` here would make the launch effect open a
 * duplicate agent forever, so adding one must be a compile error rather than a
 * behaviour change.
 */
const STARTUP_AGENT_TAB_TYPES: Record<TabType, boolean> = {
  claude: true,
  "claude-native": true,
  "claude-tmux": true,
  codex: true,
  "codex-native": true,
  opencode: true,
  "opencode-native": true,
  // Not startup agents: pipeline/review surfaces and non-agent tabs.
  "claude-build": false,
  "looped-review": false,
  browser: false,
  file: false,
  plain: false,
  root: false,
};

/**
 * The id of the tab that already satisfies a startup agent launch, if any.
 *
 * Returns the id rather than a boolean because an environment carried over from
 * before {@link STARTUP_AGENT_TAB_ID} existed holds its agent tab under a
 * generated id. Insisting on the stable id there reported "no agent tab", so the
 * launch effect opened a second one and the backend re-dispatched the initial
 * prompt. The stable id still wins when both are present, so a converged launch
 * keeps binding its provider session to the canonical tab.
 */
function findStartupAgentTabId(state: { root: PaneNode }): string | null {
  const candidates = getAllLeaves(state.root)
    .flatMap((leaf) => leaf.tabs)
    .filter((tab) => STARTUP_AGENT_TAB_TYPES[tab.type] === true);
  if (candidates.length === 0) return null;
  return candidates.some((tab) => tab.id === STARTUP_AGENT_TAB_ID)
    ? STARTUP_AGENT_TAB_ID
    : candidates[0]!.id;
}


type TerminalTabDragEndAction =
  | { type: "none" }
  | {
      type: "split";
      targetPaneId: string;
      edge: EdgeDirection;
      tabId: string;
      fromPaneId: string;
    }
  | {
      type: "move";
      fromPaneId: string;
      toPaneId: string;
      tabId: string;
      toIndex?: number;
    }
  | {
      type: "reorder";
      paneId: string;
      fromIndex: number;
      toIndex: number;
    };

export function getTerminalTabDragEndAction({
  activeId,
  overId,
  lastDragOverPaneId,
  getPane,
}: {
  activeId: string;
  overId: string | null | undefined;
  lastDragOverPaneId: string | null;
  getPane: (paneId: string) => PaneLeaf | null;
}): TerminalTabDragEndAction {
  if (!overId) return { type: "none" };

  const draggedTab = parseDraggableTabId(activeId);
  if (!draggedTab) return { type: "none" };

  const edgeDrop = parseEdgeDroppableId(overId);
  if (edgeDrop) {
    return {
      type: "split",
      targetPaneId: edgeDrop.paneId,
      edge: edgeDrop.direction,
      tabId: draggedTab.tabId,
      fromPaneId: draggedTab.paneId,
    };
  }

  if (overId.startsWith("tabbar:")) {
    const targetPaneId = overId.replace("tabbar:", "");

    if (draggedTab.paneId === targetPaneId) {
      const pane = getPane(targetPaneId);
      if (!pane) return { type: "none" };

      const fromIndex = pane.tabs.findIndex((t) => t.id === draggedTab.tabId);
      const toIndex = pane.tabs.length - 1;
      if (fromIndex === -1 || fromIndex === toIndex) return { type: "none" };

      return { type: "reorder", paneId: draggedTab.paneId, fromIndex, toIndex };
    }

    if (!getPane(targetPaneId)) return { type: "none" };

    return {
      type: "move",
      fromPaneId: draggedTab.paneId,
      toPaneId: targetPaneId,
      tabId: draggedTab.tabId,
    };
  }

  const overTab = parseDraggableTabId(overId);
  if (!overTab) return { type: "none" };

  if (overTab.tabId === draggedTab.tabId && overTab.paneId === draggedTab.paneId) {
    if (lastDragOverPaneId && lastDragOverPaneId !== draggedTab.paneId) {
      return {
        type: "move",
        fromPaneId: draggedTab.paneId,
        toPaneId: lastDragOverPaneId,
        tabId: draggedTab.tabId,
      };
    }

    return { type: "none" };
  }

  if (draggedTab.paneId === overTab.paneId) {
    const pane = getPane(draggedTab.paneId);
    if (!pane) return { type: "none" };

    const fromIndex = pane.tabs.findIndex((t) => t.id === draggedTab.tabId);
    const toIndex = pane.tabs.findIndex((t) => t.id === overTab.tabId);
    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      return { type: "none" };
    }

    return { type: "reorder", paneId: draggedTab.paneId, fromIndex, toIndex };
  }

  const targetPane = getPane(overTab.paneId);
  if (!targetPane) return { type: "none" };
  const toIndex = targetPane.tabs.findIndex((t) => t.id === overTab.tabId);
  if (toIndex === -1) return { type: "none" };

  return {
    type: "move",
    fromPaneId: draggedTab.paneId,
    toPaneId: overTab.paneId,
    tabId: draggedTab.tabId,
    toIndex,
  };
}

function createClaudeNativeLikeTab({
  id,
  nativeBackend,
  containerId,
  environmentId,
  isLocal,
  initialPrompt,
  displayTitle,
  isReviewTab,
  initialAgentModel,
  initialReasoningEffort,
  sessionId,
}: {
  id: string;
  nativeBackend: ClaudeNativeBackend;
  containerId?: string;
  environmentId: string;
  isLocal: boolean;
  initialPrompt?: string;
  displayTitle?: string;
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  sessionId?: string;
}): TabInfo {
  if (nativeBackend === "tmux") {
    return {
      id,
      type: "claude-tmux",
      claudeTmuxData: {
        containerId: isLocal ? undefined : containerId,
        environmentId,
        isLocal,
      },
      initialPrompt,
      displayTitle,
      isReviewTab,
      initialAgentModel,
      initialReasoningEffort,
    };
  }

  return {
    id,
    type: "claude-native",
    claudeNativeData: {
      containerId: isLocal ? undefined : containerId,
      environmentId,
      isLocal,
      sessionId,
    },
    initialPrompt,
    displayTitle,
    isReviewTab,
    initialAgentModel,
    initialReasoningEffort,
  };
}

export function TerminalContainer({
  environmentId,
  containerId,
  isContainerRunning = false,
  isContainerCreating = false,
  isActive = true,
  className,
  onStartContainer,
  onCreateScript,
}: TerminalContainerProps) {
  const activeWriteRef = useRef<((data: string) => Promise<void>) | null>(null);

  // Track currently dragged tab ID for cross-pane visual feedback
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragOverPaneId, setDragOverPaneId] = useState<string | null>(null);

  // Get Claude options for this environment. Actions are stable references;
  // the options record is selected narrowly so writes for other environments
  // do not rerender this container.
  const clearOptions = useClaudeOptionsStore((state) => state.clearOptions);
  const setOptions = useClaudeOptionsStore((state) => state.setOptions);
  const setPendingNativeLaunch = useClaudeOptionsStore((state) => state.setPendingNativeLaunch);
  const clearPendingNativeLaunch = useClaudeOptionsStore((state) => state.clearPendingNativeLaunch);
  const claudeOptions = useClaudeOptionsStore(
    (state) => state.options[environmentId]
  );
  const pendingNativeLaunch = useClaudeOptionsStore(
    (state) => state.pendingNativeLaunches[environmentId]
  );
  const [hasAppliedClaudeOptions, setHasAppliedClaudeOptions] = useState(false);

  // Get config for agent modes - per-environment overrides take precedence over global
  const config = useConfigStore((state) => state.config);
  const {
    envOpencodeMode,
    envClaudeMode,
    envClaudeNativeBackend,
    envCodexMode,
    envProjectId,
  } = useEnvironmentStore(
    useShallow((state) => {
      const env = state.environments.find(e => e.id === environmentId);
      return {
        envOpencodeMode: env?.opencodeMode,
        envClaudeMode: env?.claudeMode,
        envClaudeNativeBackend: env?.claudeNativeBackend,
        envCodexMode: env?.codexMode,
        envProjectId: env?.projectId,
      };
    })
  );
  const opencodeMode = envOpencodeMode || config.global.opencodeMode || "terminal";
  const codexMode = envCodexMode || config.global.codexMode || "native";
  const resolvedClaudeConfig = resolveClaudeConfig(
    config.global,
    envProjectId ? config.repositories[envProjectId] : undefined,
    {
      claudeMode: envClaudeMode,
      claudeNativeBackend: envClaudeNativeBackend,
    },
  );
  const claudeMode = resolvedClaudeConfig.mode;
  const claudeNativeBackend = resolvedClaudeConfig.nativeBackend;

  // Check if this is a local environment (no container)
  const environment = useEnvironmentStore(
    (state) => state.environments.find((env) => env.id === environmentId)
  );
  const isLocalEnvironment = environment?.environmentType === "local";
  const setupPhase = environment?.setupPhase ?? "pending";
  const backendSetupRunning = setupPhase === "running";
  const setupReady = setupPhase === "ready";
  const createScriptPrompt = createOrkestratorScriptPrompt(isLocalEnvironment);
  // For local environments, worktreePath must be set before terminal can work
  const worktreePath = environment?.worktreePath;
  // Local environment is ready when it has a worktree path (created during start_environment)
  const isLocalEnvironmentReady = isLocalEnvironment && !!worktreePath;
  const isEnvironmentRunning = isContainerRunning || isLocalEnvironmentReady;

  // Pane layout store - use selectors for reactive state
  const hydrationStatus = usePaneLayoutStore((state) => state.hydration.get(environmentId));

  // Get derived state for THIS environment (not the globally active one).
  // Selected narrowly (the per-environment record has a stable reference) so
  // layout changes in OTHER environments do not rerender this container.
  const currentEnvState = usePaneLayoutStore(
    (state) => state.environments.get(environmentId)
  );
  const root = currentEnvState?.root ?? { kind: "leaf" as const, id: "default", tabs: [], activeTabId: null };
  const activePaneId = currentEnvState?.activePaneId ?? "default";

  // Pane layout actions (stable references, shallow-compared bundle)
  const {
    setActiveEnvironment,
    initialize,
    reset,
    beginHydration,
    finishHydration,
    addTab,
    removeTab,
    reorderTabs,
    moveTab,
    splitPaneAtEdge,
    getActivePane,
    getAllTabs,
    getOpenFilePaths,
    getPane,
  } = usePaneLayoutStore(
    useShallow((state) => ({
      setActiveEnvironment: state.setActiveEnvironment,
      initialize: state.initialize,
      reset: state.reset,
      beginHydration: state.beginHydration,
      finishHydration: state.finishHydration,
      addTab: state.addTab,
      removeTab: state.removeTab,
      reorderTabs: state.reorderTabs,
      moveTab: state.moveTab,
      splitPaneAtEdge: state.splitPaneAtEdge,
      getActivePane: state.getActivePane,
      getAllTabs: state.getAllTabs,
      getOpenFilePaths: state.getOpenFilePaths,
      getPane: state.getPane,
    }))
  );

  const {
    setTerminalWrite,
    setCreateTab,
    setSelectTab,
    setCloseActiveTab,
    setTabCount,
    setCreateFileTab,
    setOpenFilePaths,
  } = useTerminalContext();

  // Track the initial prompt to pass to the first tab
  const initialPromptRef = useRef<string | undefined>(undefined);
  const previousContainerIdRef = useRef<string | null>(null);
  const isSavingInitialPromptAttachmentsRef = useRef(false);
  const setupSessionBindInFlightRef = useRef(new Set<string>());
  const setupSessionBindSettledTabsRef = useRef(new Set<string>());
  const setupSessionBindAttemptsRef = useRef(new Map<string, number>());
  const setupSessionBindRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durableLaunchClearInFlightRef = useRef(false);
  const [setupSessionBindNonce, setSetupSessionBindNonce] = useState(0);
  const [setupSessionBindRetryNonce, setSetupSessionBindRetryNonce] = useState(0);

  // A rejected setup-session lookup leaves the tab neither bound nor settled,
  // and nothing else re-runs the rebind effect. Without a retry the tab renders
  // a permanently blank pane: it is backend-managed, so `attachExistingOnly`
  // suppresses PTY creation and no error surfaces anywhere.
  const scheduleSetupSessionBindRetry = useCallback(() => {
    if (setupSessionBindRetryTimerRef.current) return;
    setupSessionBindRetryTimerRef.current = setTimeout(() => {
      setupSessionBindRetryTimerRef.current = null;
      setSetupSessionBindRetryNonce((value) => value + 1);
    }, SETUP_SESSION_BIND_RETRY_DELAY_MS);
  }, []);

  useEffect(() => () => {
    if (!setupSessionBindRetryTimerRef.current) return;
    clearTimeout(setupSessionBindRetryTimerRef.current);
    setupSessionBindRetryTimerRef.current = null;
  }, []);

  const setupSessionKeyForTab = useCallback(
    (tabId: string) => createSessionKey(containerId ?? null, tabId, environmentId),
    [containerId, environmentId],
  );

  const hasBoundSetupSession = useCallback(
    (tabId: string) => !!useTerminalSessionStore.getState().sessions.get(setupSessionKeyForTab(tabId))?.sessionId,
    [setupSessionKeyForTab],
  );

  const bindBackendSetupSession = useCallback(
    async (tabId = "default") => {
      // Tracked per tab, not globally: a global latch made a second unbound
      // setup tab return early without ever settling, and a tab that never
      // settles is skipped by stale-tab cleanup forever — a pane that can
      // neither connect nor be retired.
      if (setupSessionBindInFlightRef.current.has(tabId)) {
        const alreadyBound = hasBoundSetupSession(tabId);
        console.info("[setup-terminal] setup session bind skipped: already in flight", {
          environmentId,
          tabId,
          alreadyBound,
        });
        return alreadyBound;
      }
      setupSessionBindInFlightRef.current.add(tabId);
      setupSessionBindSettledTabsRef.current.delete(tabId);
      let lookupSettled = false;
      try {
        console.info("[setup-terminal] requesting backend setup session", {
          environmentId,
          tabId,
          key: setupSessionKeyForTab(tabId),
        });
        const setupSession = await backend.getEnvironmentSetupSession(environmentId);
        lookupSettled = true;
        if (!setupSession?.sessionId) {
          console.info("[setup-terminal] no backend setup session available", {
            environmentId,
            tabId,
          });
          return false;
        }
        const key = setupSessionKeyForTab(tabId);
        const terminalStore = useTerminalSessionStore.getState();
        const existing = terminalStore.sessions.get(key);
        console.info("[setup-terminal] binding backend setup session", {
          environmentId,
          tabId,
          key,
          previousSessionId: existing?.sessionId ?? null,
          nextSessionId: setupSession.sessionId,
          setupSessionRunning: setupSession.running,
          terminalRunning: setupSession.terminalRunning ?? null,
          success: setupSession.success ?? null,
        });
        terminalStore.setSession(key, {
          ...existing,
          sessionId: setupSession.sessionId,
        });
        return true;
      } catch (error) {
        console.error("[TerminalContainer] Failed to bind backend setup session:", error);
        const attempts = (setupSessionBindAttemptsRef.current.get(tabId) ?? 0) + 1;
        setupSessionBindAttemptsRef.current.set(tabId, attempts);
        if (attempts < SETUP_SESSION_BIND_MAX_ATTEMPTS) {
          scheduleSetupSessionBindRetry();
        } else {
          // Out of retries. Settle the tab so stale-tab cleanup can retire this
          // dead placeholder and the initial-layout effect can seed a working
          // tab in its place, rather than leaving a pane that never connects.
          console.warn("[setup-terminal] giving up on backend setup session lookup", {
            environmentId,
            tabId,
            attempts,
          });
          setupSessionBindSettledTabsRef.current.add(tabId);
          setSetupSessionBindNonce((value) => value + 1);
        }
        return false;
      } finally {
        setupSessionBindInFlightRef.current.delete(tabId);
        if (lookupSettled) {
          setupSessionBindAttemptsRef.current.delete(tabId);
          setupSessionBindSettledTabsRef.current.add(tabId);
          // The terminal store update itself rerenders PersistentTerminal. This
          // local nonce lets stale-tab cleanup distinguish a completed lookup
          // (including "no session") from the initial empty renderer store.
          setSetupSessionBindNonce((value) => value + 1);
        }
      }
    },
    [environmentId, hasBoundSetupSession, scheduleSetupSessionBindRetry, setupSessionKeyForTab],
  );

  useEffect(() => {
    if (!currentEnvState) return;

    const setupTabs = getAllLeaves(currentEnvState.root)
      .flatMap((leaf) => leaf.tabs)
      .filter((tab) => tab.isSetupTab && (!tab.initialCommands || tab.initialCommands.length === 0));

    // Every unbound setup tab, not just the first. Binding one at a time relied
    // on this effect re-running to reach the next, and a tab it never reaches is
    // never settled either — which stale-tab cleanup treats as "still looking"
    // and skips indefinitely.
    const unboundSetupTabs = setupTabs.filter((tab) => !hasBoundSetupSession(tab.id));
    if (unboundSetupTabs.length === 0) return;

    console.info("[setup-terminal] found unbound backend-managed setup tabs; rebinding", {
      environmentId,
      tabIds: unboundSetupTabs.map((tab) => tab.id),
      setupPhase,
      tabCount: setupTabs.length,
    });
    for (const tab of unboundSetupTabs) void bindBackendSetupSession(tab.id);
  }, [
    bindBackendSetupSession,
    currentEnvState,
    environmentId,
    hasBoundSetupSession,
    // Re-runs this effect after a failed lookup's backoff elapses. Nothing else
    // changes when a lookup rejects, so without it a transient network failure
    // would strand the tab unbound forever.
    setupSessionBindRetryNonce,
    setupPhase,
  ]);

  useEffect(() => {
    if (
      !currentEnvState
      || environment?.pendingAgentLaunch
      || backendSetupRunning
    ) {
      return;
    }
    // `setupScriptsComplete` is deliberately not required here. Once a lookup
    // has settled and setup is not running, a backend-managed setup tab with no
    // `<environmentId>:setup` session to adopt is dead either way: it cannot
    // create its own PTY (`attachExistingOnly`) and `useTerminal` returns
    // silently rather than surfacing an error, so the pane just stays blank.
    // Removing it lets the initial-layout effect seed a working tab, which is
    // the same self-healing path the completed-setup case already relies on.
    //
    // The rebind effect above starts its backend lookup synchronously, but the
    // result is asynchronous. On a fresh renderer the terminal store is empty,
    // so treating that temporary absence as stale would remove the restored
    // setup tab and seed an ordinary PTY before iOS/web can adopt `:setup`.
    if (setupSessionBindInFlightRef.current.size > 0) return;

    const leaves = getAllLeaves(currentEnvState.root);
    for (const leaf of leaves) {
      const staleSetupTab = leaf.tabs.find((tab) => {
        if (!tab.isSetupTab || (tab.initialCommands && tab.initialCommands.length > 0)) {
          return false;
        }
        if (!setupSessionBindSettledTabsRef.current.has(tab.id)) return false;
        const session = useTerminalSessionStore.getState().sessions.get(setupSessionKeyForTab(tab.id));
        return session?.sessionId !== `${environmentId}:setup`;
      });

      if (staleSetupTab) {
        console.log("[TerminalContainer] Removing stale setup placeholder tab:", staleSetupTab.id);
        removeTab(leaf.id, staleSetupTab.id, environmentId);
        return;
      }
    }
  }, [
    currentEnvState,
    environment?.pendingAgentLaunch,
    environmentId,
    removeTab,
    setupSessionBindNonce,
    backendSetupRunning,
    setupSessionKeyForTab,
  ]);

  // Set active environment when this container becomes active
  useEffect(() => {
    if (isActive) {
      setActiveEnvironment(environmentId);
    }
  }, [isActive, environmentId, setActiveEnvironment]);

  // Report a failed startup launch. The backend records it durably and keeps
  // retrying, but nothing else renders it: without this the user gets a plain
  // terminal, no agent tab, and an initial prompt that never arrives.
  const reportedStartupErrorRef = useRef<string | null>(null);
  useEffect(() => {
    const startupSession = environment?.startupAgentSession;
    if (startupSession?.status !== "error") {
      reportedStartupErrorRef.current = null;
      return;
    }
    const reason = startupSession.error ?? "The agent could not be started.";
    // Keyed on the message so a repeated retry failure does not re-toast, but a
    // different failure still does.
    if (reportedStartupErrorRef.current === reason) return;
    reportedStartupErrorRef.current = reason;
    toast.error(`${startupSession.agent} could not start in ${environment?.name ?? "this environment"}`, {
      description: reason,
      duration: 10_000,
    });
  }, [
    environment?.name,
    environment?.startupAgentSession?.agent,
    environment?.startupAgentSession?.error,
    environment?.startupAgentSession?.status,
  ]);

  // Reconstruct the post-setup agent launch from backend-owned environment
  // state after a mobile page reload. The transient options store is only an
  // optimization for the uninterrupted creation path.
  useEffect(() => {
    if (!environment) return;
    const startupSession = environment.startupAgentSession;
    // A starting or failed launch is still owned by the backend. In particular,
    // pendingAgentLaunch is the backend's retry intent after an error, so a
    // renderer must not project an ordinary text-only launch and clear it.
    if (startupSession && startupSession.status !== "running") return;
    const backendLaunch = startupSession;
    if (
      (!environment.pendingAgentLaunch && !backendLaunch)
      || !currentEnvState
    ) {
      return;
    }

    const existingStartupTabId = findStartupAgentTabId(currentEnvState);
    if (existingStartupTabId) {
      if (durableLaunchClearInFlightRef.current) return;
      durableLaunchClearInFlightRef.current = true;
      if (backendLaunch?.providerSessionId) {
        // Bind the backend's session to whichever tab actually satisfies this
        // launch, including a legacy generated id.
        usePaneLayoutStore.getState().updateTabNativeSessionId(
          existingStartupTabId,
          backendLaunch.providerSessionId,
          environmentId,
        );
      }
      const durablePaneState =
        usePaneLayoutStore.getState().environments.get(environmentId)
        ?? currentEnvState;
      // Persist the tab before clearing the launch intent. If the page is
      // evicted between these operations, the still-pending flag retries; if
      // clearing succeeds, rehydration is guaranteed to find the agent tab.
      // The write goes through the persistence loop's per-environment chain so
      // it uses the latest revision and cannot conflict with an older debounced
      // write after the launch flag has already been cleared.
      //
      // This flush is also what makes it safe to drop the backend's one-shot
      // `initialAgentModel`/`initialReasoningEffort` here even though the agent
      // surface may still be resolving a live model catalog: the flushed layout
      // carries those options on the tab, and `pane-layout-restore` reads them
      // back, so the tab is the durable carrier from this point on. Blocking the
      // clear until a consumer acknowledged instead would strand
      // `pendingAgentLaunch` forever whenever a surface reaches a steady state
      // without applying them (background mount, empty catalog, init error),
      // which keeps the environment hidden-mounted and polled for the life of
      // the app.
      void flushPaneLayoutNow(
        environmentId,
        createPersistedPaneLayoutInput(durablePaneState),
      )
        .then(() =>
          backendLaunch
            ? backend.acknowledgeStartupAgentSession(environmentId, backendLaunch)
            : backend.setEnvironmentPendingAgentLaunch(environmentId, false)
        )
        .then((updatedEnvironment) => {
          useEnvironmentStore.getState().updateEnvironment(environmentId, updatedEnvironment);
        })
        .catch((error) => {
          console.warn(
            `[TerminalContainer] Failed to clear durable agent launch for ${environmentId}:`,
            error,
          );
        })
        .finally(() => {
          durableLaunchClearInFlightRef.current = false;
        });
      return;
    }

    // The uninterrupted create flow still owns this launch while its transient
    // options exist. In particular, it may be staging initial-prompt images and
    // rewriting the prompt with their workspace paths. Reconstructing the
    // backend intent at the same time queues the older text-only prompt; once
    // staging finishes, both paths create an agent tab. A renderer reload has no
    // transient options, so durable recovery continues through the branch below.
    if (!backendLaunch && claudeOptions?.launchAgent) return;
    if (backendLaunch && claudeOptions?.launchAgent) {
      // The backend has already created the provider session and consumed the
      // initial prompt (including attachments). Discard the renderer-only
      // launch copy so it cannot race a second direct dispatch.
      clearOptions(environmentId);
    }

    if (backendLaunch && pendingNativeLaunch) {
      if (
        pendingNativeLaunch.providerSessionId !== backendLaunch.providerSessionId
        || pendingNativeLaunch.initialPrompt !== undefined
        || pendingNativeLaunch.agentType !== backendLaunch.agent
        || pendingNativeLaunch.launchMode !== "native"
      ) {
        // A renderer can stage the old client-owned launch during the short
        // interval between setup completion and the backend publishing its
        // provider session. Replace that stale copy before the launch effect is
        // allowed to materialize it.
        setPendingNativeLaunch(environmentId, {
          ...pendingNativeLaunch,
          containerId: isLocalEnvironment ? null : containerId,
          environmentId,
          targetPaneId: currentEnvState.activePaneId,
          agentType: backendLaunch.agent,
          launchMode: "native",
          providerSessionId: backendLaunch.providerSessionId,
          initialPrompt: undefined,
          model: backendLaunch.model ?? pendingNativeLaunch.model,
          reasoningEffort:
            backendLaunch.reasoningEffort
            ?? pendingNativeLaunch.reasoningEffort,
        });
      }
      return;
    }

    if (!isEnvironmentRunning || pendingNativeLaunch) return;

    const agentType =
      backendLaunch?.agent
      ?? environment.defaultAgent
      ?? config.global.defaultAgent
      ?? "claude";
    const launchMode =
      (agentType === "claude" && claudeMode === "native")
      || (agentType === "codex" && codexMode === "native")
      || (agentType === "opencode" && opencodeMode === "native")
        ? "native"
        : "terminal";

    setPendingNativeLaunch(environmentId, {
      containerId: isLocalEnvironment ? null : containerId,
      environmentId,
      initialPrompt:
        backendLaunch
          ? undefined
          : environment.initialPrompt?.trim() || undefined,
      targetPaneId: currentEnvState.activePaneId,
      agentType,
      launchMode,
      claudeNativeBackend:
        agentType === "claude" && launchMode === "native"
          ? claudeNativeBackend
          : undefined,
      model: backendLaunch?.model ?? environment.initialAgentModel,
      reasoningEffort:
        backendLaunch?.reasoningEffort
        ?? environment.initialReasoningEffort,
      providerSessionId: backendLaunch?.providerSessionId,
    });
  }, [
    claudeMode,
    claudeNativeBackend,
    claudeOptions?.launchAgent,
    codexMode,
    config.global.defaultAgent,
    containerId,
    currentEnvState,
    environment,
    environmentId,
    isEnvironmentRunning,
    isLocalEnvironment,
    opencodeMode,
    pendingNativeLaunch,
    clearOptions,
    setPendingNativeLaunch,
  ]);

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Initialize pane layout from the backend-owned setup phase.
  useEffect(() => {
    if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return;
    if (setupPhase === "pending") return;

    // Check if we need to initialize (no tabs yet for THIS environment)
    const currentTabs = currentEnvState
      ? getAllLeaves(currentEnvState.root).flatMap((leaf) => leaf.tabs)
      : [];
    // A build tab is inserted by the pipeline supervisor as soon as the backend
    // returns, which is before this environment is running and therefore always
    // before this effect can run. It is not part of the layout seeded here, so
    // counting it would suppress the initial layout entirely: no setup tab, no
    // default terminal, and initialize() — which records the containerId the
    // terminal session keys derive from — would never run.
    const seededTabs = currentTabs.filter((tab) => tab.type !== "claude-build");
    // Hydration is authoritative even when another surface inserted a tab
    // before this container mounted (notably a backend-created build tab).
    // finishHydration reconciles tabs added during the request with the
    // restored snapshot, so start the restore before using tab count to decide
    // whether a default terminal needs to be seeded.
    if (!backendSetupRunning) {
      if (hydrationStatus === "pending") return;
      if (hydrationStatus === undefined) {
        beginHydration(environmentId);
        void Promise.allSettled([
          backend.getPaneLayout(environmentId),
          hydrateLoopedReviewWorkflowsForEnvironment(environmentId),
        ])
          .then(([layoutResult, workflowResult]) => {
            const paneStore = usePaneLayoutStore.getState();
            if (paneStore.hydration.get(environmentId) !== "pending") return;

            if (workflowResult.status === "rejected") {
              console.warn(
                "[TerminalContainer] Failed to restore looped reviews:",
                workflowResult.reason,
              );
            }
            if (layoutResult.status === "rejected") {
              console.warn(
                "[TerminalContainer] Failed to restore pane layout:",
                layoutResult.reason,
              );
              paneStore.finishHydration(environmentId);
              return;
            }

            const latestEnvironment = useEnvironmentStore
              .getState()
              .getEnvironmentById(environmentId);
            if (!latestEnvironment) {
              paneStore.finishHydration(environmentId);
              return;
            }

            const latestIsLocal = latestEnvironment.environmentType === "local";
            const latestContainerId = latestIsLocal
              ? null
              : latestEnvironment.containerId;
            const persisted = layoutResult.value;
            const restoredSnapshot = reconcilePersistedLayout(persisted, {
              environmentId,
              containerId: latestContainerId,
              isLocal: latestIsLocal,
              worktreePath: latestEnvironment.worktreePath,
              hasBuildPipeline: (pipelineId) =>
                useBuildPipelineStore.getState().pipelines.has(pipelineId),
              hasLoopedReview: (workflowId) =>
                // A failed workflow-list request means existence is unknown,
                // not that every persisted review was deleted. Preserve those
                // tabs so their own read-through view can retry hydration.
                workflowResult.status === "rejected"
                || useLoopedReviewStore.getState().workflows.has(workflowId),
            });
            const restored =
              restoredSnapshot && persisted?.version === LEGACY_PANE_LAYOUT_VERSION
                ? applyStoredPaneSelection(
                    restoredSnapshot,
                    environmentId,
                    readStoredPaneSelection(environmentId),
                  )
                : restoredSnapshot;
            paneStore.finishHydration(environmentId, restored ?? undefined);

            // A successful migration may have been performed by this renderer
            // on an earlier launch or by another client. Once v2 is observed,
            // the renderer-local v1 selection can no longer be useful.
            if (persisted?.version === PANE_LAYOUT_VERSION) {
              clearStoredPaneSelection(environmentId);
            }

            if (restored && persisted?.version === LEGACY_PANE_LAYOUT_VERSION) {
              // V1 stored canonical focus pointers and relied on renderer-local
              // storage for the user's actual selection. Install that selection
              // once, then upgrade the complete reconciled layout through the
              // normal per-environment CAS chain. The local record is retained
              // until the v2 write is durable so a transient failure can retry
              // on the next launch. Updated backends reject v1 writes, keeping a
              // still-running older renderer from downgrading the record again.
              const migrated = usePaneLayoutStore
                .getState()
                .environments.get(environmentId);
              if (migrated) {
                void flushPaneLayoutNow(
                  environmentId,
                  createPersistedPaneLayoutInput(migrated),
                )
                  .then(() => clearStoredPaneSelection(environmentId))
                  .catch((error) => {
                    console.warn(
                      "[TerminalContainer] Failed to migrate legacy pane selection:",
                      error,
                    );
                  });
              }
            }
          });
        return;
      }
    }

    if (seededTabs.length === 0) {
      console.info("[setup-terminal] initial terminal layout decision", {
        environmentId,
        backendSetupRunning,
        setupPhase,
        hasDefaultSetupSession: hasBoundSetupSession("default"),
        isLocalEnvironment,
        worktreePath: worktreePath ?? null,
        containerId,
      });
      if (backendSetupRunning && !hasBoundSetupSession("default")) {
        console.info("[setup-terminal] waiting for setup session before adding setup tab", {
          environmentId,
          tabId: "default",
        });
        void bindBackendSetupSession("default");
        return;
      }

      if (backendSetupRunning) {
        // Setup owns the temporary layout. Mark hydration complete without
        // restoring an older layout so the setup/default layout can persist.
        if (hydrationStatus !== "done") finishHydration(environmentId);
      }

      const pendingAttachments = claudeOptions?.initialPromptAttachments ?? [];
      if (claudeOptions?.launchAgent && pendingAttachments.length > 0) {
        if (!isSavingInitialPromptAttachmentsRef.current) {
          isSavingInitialPromptAttachmentsRef.current = true;
          void (async () => {
            try {
              const savedAttachments = await saveInitialPromptAttachments({
                attachments: pendingAttachments,
                containerId: isLocalEnvironment ? null : containerId,
                worktreePath,
              });
              const currentOptions = useClaudeOptionsStore.getState().getOptions(environmentId);
              if (!currentOptions) return;

              const promptWithReferences = buildInitialPromptWithAttachmentReferences(
                currentOptions.initialPrompt,
                savedAttachments,
              );
              setOptions(environmentId, {
                ...currentOptions,
                initialPrompt: promptWithReferences,
                initialPromptAttachments: [],
              });

              // The attachments now live in the workspace, but the references to
              // them only existed in this renderer's options store. Persist the
              // rewritten prompt so a launch recovered after page eviction reads
              // a prompt whose references still resolve, instead of the raw text
              // the user typed. (Eviction *before* this point still loses the
              // attachments themselves — they are never persisted.)
              if (
                promptWithReferences !== currentOptions.initialPrompt
                || pendingAttachments.length > 0
              ) {
                try {
                  const updatedEnvironment = await backend.setEnvironmentInitialPrompt(
                    environmentId,
                    promptWithReferences,
                    [],
                  );
                  useEnvironmentStore.getState().updateEnvironment(environmentId, updatedEnvironment);
                } catch (error) {
                  console.warn(
                    "[TerminalContainer] Failed to persist initial prompt attachment references:",
                    error,
                  );
                }
              }
            } catch (error) {
              console.error("[TerminalContainer] Failed to save initial prompt attachments:", error);
              // Keep both renderer and backend copies so a later retry can
              // recover the images rather than silently launching without
              // them.
            } finally {
              isSavingInitialPromptAttachmentsRef.current = false;
            }
          })();
        }
        return;
      }

      initialize(containerId, environmentId);
      // A restored/shared build-only layout can use a non-default pane id.
      // Seed the ordinary/setup tab into the pane that actually survived
      // hydration; targeting the literal "default" would be a no-op and make
      // this effect initialize forever because build tabs are excluded from
      // `seededTabs` above.
      const initialPaneId = usePaneLayoutStore
        .getState()
        .environments.get(environmentId)?.activePaneId ?? "default";

      // Determine initial tab type based on agent options
      let initialTabType: TerminalTabType = "plain";
      let pendingInitialPrompt: string | undefined;
      let initialAgentModel: string | undefined;
      let initialReasoningEffort: string | undefined;
      const launchAgent = claudeOptions?.launchAgent ?? false;
      if (launchAgent) {
        initialTabType = claudeOptions!.agentType;
        initialAgentModel = claudeOptions!.model;
        initialReasoningEffort = claudeOptions!.reasoningEffort;
        setHasAppliedClaudeOptions(true);
        if (claudeOptions!.initialPrompt?.trim()) {
          pendingInitialPrompt = claudeOptions!.initialPrompt.trim();
          initialPromptRef.current = pendingInitialPrompt;
        }
      }
      const initialTabId =
        launchAgent && initialTabType !== "plain"
          ? STARTUP_AGENT_TAB_ID
          : "default";

      // Check if we should use native mode instead of terminal
      const useNativeOpenCode = initialTabType === "opencode" && opencodeMode === "native";
      const useNativeClaude = initialTabType === "claude" && claudeMode === "native";
      const useNativeCodex = initialTabType === "codex" && codexMode === "native";

      if (backendSetupRunning) {
        console.info("[setup-terminal] adding backend-managed setup tab", {
          environmentId,
          tabId: "default",
          hasDefaultSetupSession: hasBoundSetupSession("default"),
        });
        if (launchAgent && initialTabType !== "plain") {
          setPendingNativeLaunch(environmentId, {
            containerId: isLocalEnvironment ? null : containerId,
            environmentId,
            initialPrompt: pendingInitialPrompt,
            targetPaneId: initialPaneId,
            agentType: initialTabType,
            launchMode: useNativeOpenCode || useNativeClaude || useNativeCodex ? "native" : "terminal",
            claudeNativeBackend: useNativeClaude ? claudeNativeBackend : undefined,
            model: initialAgentModel,
            reasoningEffort: initialReasoningEffort,
          });
        }

        const setupTab: TabInfo = {
          id: "default",
          type: "plain",
          isSetupTab: true,
        };
        addTab(initialPaneId, setupTab, environmentId);
        return;
      }

      console.log("[TerminalContainer] Initial tab decision:", {
        agentType: claudeOptions?.agentType,
        launchAgent,
        opencodeMode,
        claudeMode,
        codexMode,
        useNativeOpenCode,
        useNativeClaude,
        useNativeCodex,
        isLocalEnvironment,
        setupPhase,
      });
      if (useNativeClaude) {
        addTab(initialPaneId, createClaudeNativeLikeTab({
          id: initialTabId,
          nativeBackend: claudeNativeBackend,
          containerId: isLocalEnvironment ? undefined : containerId ?? undefined,
          environmentId,
          isLocal: isLocalEnvironment,
          initialPrompt: pendingInitialPrompt,
          initialAgentModel,
          initialReasoningEffort,
        }), environmentId);
      } else if (useNativeCodex) {
        addTab(initialPaneId, {
          id: initialTabId,
          type: "codex-native",
          codexNativeData: {
            containerId: isLocalEnvironment ? undefined : containerId ?? undefined,
            environmentId,
            isLocal: isLocalEnvironment,
          },
          initialPrompt: pendingInitialPrompt,
          initialAgentModel,
          initialReasoningEffort,
        }, environmentId);
      } else if (useNativeOpenCode) {
        addTab(initialPaneId, {
          id: initialTabId,
          type: "opencode-native",
          openCodeNativeData: {
            containerId: isLocalEnvironment ? undefined : containerId ?? undefined,
            environmentId,
            isLocal: isLocalEnvironment,
          },
          initialPrompt: pendingInitialPrompt,
          initialAgentModel,
          initialReasoningEffort,
        }, environmentId);
      } else {
        addTab(initialPaneId, {
          id: initialTabId,
          type: initialTabType,
          initialPrompt: pendingInitialPrompt,
          initialAgentModel,
          initialReasoningEffort,
        }, environmentId);
      }
    }
  }, [isEnvironmentRunning, containerId, isLocalEnvironmentReady, isLocalEnvironment, setupPhase, backendSetupRunning, claudeOptions, initialize, addTab, environmentId, currentEnvState, hydrationStatus, beginHydration, finishHydration, opencodeMode, claudeMode, claudeNativeBackend, codexMode, setPendingNativeLaunch, setOptions, worktreePath, hasBoundSetupSession, bindBackendSetupSession, setupSessionBindNonce]);

  // Reset pane layout when container changes within the same environment
  // (e.g., container was stopped and restarted with a new ID)
  useEffect(() => {
    if (previousContainerIdRef.current !== null && previousContainerIdRef.current !== containerId) {
      console.debug("[TerminalContainer] Container changed for environment:", environmentId, "resetting panes");
      reset(environmentId);
      setHasAppliedClaudeOptions(false);
      clearPendingNativeLaunch(environmentId);
    }
    previousContainerIdRef.current = containerId;
  }, [containerId, environmentId, reset, clearPendingNativeLaunch]);

  // Reset pane layout when the container stops.
  // This clears all terminals and tabs since their backend sessions are destroyed
  useEffect(() => {
    if (!isContainerRunning && containerId) {
      console.debug("[TerminalContainer] Container stopped, resetting panes for environment:", environmentId);
      reset(environmentId);
      // Clear pending native OpenCode launch on container stop
      clearPendingNativeLaunch(environmentId);
    }
  }, [isContainerRunning, environmentId, containerId, reset, clearPendingNativeLaunch]);

  // Launch native tab after workspace setup completes
  useEffect(() => {
    const canLaunchPendingNative =
      setupReady
      && pendingNativeLaunch
      && (containerId || isLocalEnvironmentReady);
    console.log("[TerminalContainer] Native tab effect check - setupPhase:", setupPhase, "hasPending:", !!pendingNativeLaunch, "containerId:", !!containerId, "isLocalEnvironmentReady:", isLocalEnvironmentReady);

    // Simple logic: when workspace is ready and we have a pending launch, create the tab
    // For local environments, containerId is null so we check isLocalEnvironmentReady (worktreePath exists)
    if (canLaunchPendingNative) {
      const pending = pendingNativeLaunch;

      // Only launch if this is for the current container/environment
      // For local envs, both containerId values are null, so we also check environmentId
      const containerMatch = isLocalEnvironment
        ? (pending.containerId === null && pending.environmentId === environmentId)
        : (pending.containerId === containerId && pending.environmentId === environmentId);

      if (containerMatch) {
        const isClaudeNative = pending.agentType === "claude";
        const isCodexNative = pending.agentType === "codex";
        const launchMode = pending.launchMode ?? "native";
        console.log(
          "[TerminalContainer] Workspace ready, launching",
          launchMode,
          isClaudeNative ? "Claude" : isCodexNative ? "Codex" : "OpenCode",
          "tab for environment:",
          environmentId,
        );

        const newTabId = STARTUP_AGENT_TAB_ID;
        const paneStore = usePaneLayoutStore.getState();
        const livePaneState = paneStore.environments.get(environmentId);
        const targetPaneId =
          (paneStore.getPane(pending.targetPaneId, environmentId)
            ? pending.targetPaneId
            : livePaneState
              && paneStore.getPane(livePaneState.activePaneId, environmentId)
              ? livePaneState.activePaneId
              : livePaneState
                ? getAllLeaves(livePaneState.root)[0]?.id
                : undefined);
        if (!targetPaneId) {
          console.warn(
            "[TerminalContainer] Deferred native launch because no pane is available:",
            environmentId,
          );
          return;
        }
        if (launchMode === "terminal") {
          const newTab: TabInfo = {
            id: newTabId,
            type: pending.agentType,
            initialPrompt: pending.initialPrompt,
            initialAgentModel: pending.model,
            initialReasoningEffort: pending.reasoningEffort,
          };
          addTab(targetPaneId, newTab, environmentId);
        } else if (isClaudeNative) {
          const backend = pending.claudeNativeBackend ?? claudeNativeBackend;
          const newTab = createClaudeNativeLikeTab({
            id: newTabId,
            nativeBackend: backend,
            containerId: pending.containerId ?? undefined,
            environmentId: pending.environmentId,
            isLocal: isLocalEnvironment,
            sessionId: pending.providerSessionId,
            initialPrompt: pending.initialPrompt,
            initialAgentModel: pending.model,
            initialReasoningEffort: pending.reasoningEffort,
          });
          addTab(targetPaneId, newTab, environmentId);
        } else if (isCodexNative) {
          const newTab: TabInfo = {
            id: newTabId,
            type: "codex-native",
            codexNativeData: {
              containerId: isLocalEnvironment ? undefined : pending.containerId ?? undefined,
              environmentId: pending.environmentId,
              isLocal: isLocalEnvironment,
              sessionId: pending.providerSessionId,
            },
            initialPrompt: pending.initialPrompt,
            initialAgentModel: pending.model,
            initialReasoningEffort: pending.reasoningEffort,
          };
          addTab(targetPaneId, newTab, environmentId);
        } else {
          // Create OpenCode native tab
          const newTab: TabInfo = {
            id: newTabId,
            type: "opencode-native",
            openCodeNativeData: {
              containerId: isLocalEnvironment ? undefined : pending.containerId ?? undefined,
              environmentId: pending.environmentId,
              isLocal: isLocalEnvironment,
              sessionId: pending.providerSessionId,
            },
            initialPrompt: pending.initialPrompt,
            initialAgentModel: pending.model,
            initialReasoningEffort: pending.reasoningEffort,
          };
          addTab(targetPaneId, newTab, environmentId);
        }

        // Clear the pending launch
        clearPendingNativeLaunch(environmentId);
        clearOptions(environmentId);
      }
    }
  }, [
    setupReady,
    setupPhase,
    pendingNativeLaunch,
    containerId,
    environmentId,
    isLocalEnvironment,
    isLocalEnvironmentReady,
    addTab,
    clearPendingNativeLaunch,
    clearOptions,
    claudeNativeBackend,
  ]);

  // Register terminal write function with context
  useEffect(() => {
    if (!isActive) return;

    if (activeWriteRef.current) {
      setTerminalWrite(activeWriteRef.current);
    } else {
      setTerminalWrite(null);
    }

    return () => {
      setTerminalWrite(null);
    };
  }, [isActive, setTerminalWrite, activePaneId]);

  const createBrowserTab = useCallback(
    (
      initialUrl: string | undefined,
      targetPaneId = activePaneId,
      displayTitle?: string,
    ) => {
      if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) {
        return false;
      }

      const allTabs = getAllTabs(environmentId);
      if (allTabs.length >= MAX_TABS) {
        console.debug("[TerminalContainer] Maximum tab limit reached:", MAX_TABS);
        return false;
      }

      if (!usePaneLayoutStore.getState().getPane(targetPaneId, environmentId)) {
        return false;
      }

      const newTabId = createUniqueTabId("tab");
      const newTab: TabInfo = {
        id: newTabId,
        type: "browser",
        browserData: { url: initialUrl?.trim() ?? "" },
        displayTitle,
      };
      console.debug(
        "[TerminalContainer] Creating browser tab:",
        newTabId,
        "for environment:",
        environmentId,
      );
      addTab(targetPaneId, newTab, environmentId);
      return true;
    },
    [
      activePaneId,
      addTab,
      containerId,
      environmentId,
      getAllTabs,
      isEnvironmentRunning,
      isLocalEnvironmentReady,
    ],
  );

  useEffect(
    () =>
      listenForTerminalBrowserTabRequests((request) => {
        if (request.environmentId !== environmentId) return;

        const pane = usePaneLayoutStore
          .getState()
          .findPaneWithTab(request.sourceTabId, environmentId);
        if (!pane) return;

        if (createBrowserTab(request.url, pane.id)) {
          usePaneLayoutStore.getState().setActivePane(pane.id, environmentId);
        }
      }),
    [createBrowserTab, environmentId],
  );

  // Handler for creating new terminal tabs
  const handleCreateTab = useCallback(
    (type: CreatableTabType, options?: CreateTabOptions): boolean => {
      // For local environments, we don't need a containerId but do need worktreePath to be set
      if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return false;

      const allTabs = getAllTabs(environmentId);
      if (allTabs.length >= MAX_TABS) {
        console.debug("[TerminalContainer] Maximum tab limit reached:", MAX_TABS);
        return false;
      }

      if (type === "browser") {
        return createBrowserTab(
          options?.initialUrl,
          activePaneId,
          options?.displayTitle,
        );
      }

      if (type === "looped-review") {
        if (!options?.loopedReviewId) {
          console.warn("[TerminalContainer] Refusing looped-review tab without workflow ID");
          return false;
        }
        const newTab: TabInfo = {
          id: createUniqueTabId("looped-review"),
          type: "looped-review",
          displayTitle: options.displayTitle ?? "Looped Review",
          loopedReviewTabData: {
            environmentId,
            workflowId: options.loopedReviewId,
            isLocal: isLocalEnvironment,
          },
        };
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      const newTabId = createUniqueTabId("tab");
      const launchModeOverride = options?.agentLaunchMode;
      const shouldUseOpenCodeNative =
        type === "opencode" &&
        (launchModeOverride === "native" || (!launchModeOverride && opencodeMode === "native"));
      const shouldUseClaudeNative =
        type === "claude" &&
        (launchModeOverride === "native" ||
          launchModeOverride === "tmux" ||
          (!launchModeOverride && claudeMode === "native"));
      const shouldUseCodexNative =
        type === "codex" &&
        (launchModeOverride === "native" || (!launchModeOverride && codexMode === "native"));

      // Check if we should create an opencode-native tab instead
      if (shouldUseOpenCodeNative) {
        const newTab: TabInfo = {
          id: newTabId,
          type: "opencode-native",
          openCodeNativeData: {
            containerId: isLocalEnvironment ? undefined : containerId ?? undefined,
            environmentId,
            isLocal: isLocalEnvironment,
            sessionId: options?.resumeSessionId,
          },
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
        };
        console.debug("[TerminalContainer] Creating opencode-native tab:", newTabId, "for environment:", environmentId, "isLocal:", isLocalEnvironment, "initialPrompt:", !!options?.initialPrompt);
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      // Native Claude mode → pick the backend (SDK or tmux) by 3-tier resolution.
      if (shouldUseClaudeNative) {
        const backend = launchModeOverride === "native"
          ? "sdk"
          : launchModeOverride === "tmux"
            ? "tmux"
            : claudeNativeBackend;

        const newTab = createClaudeNativeLikeTab({
          id: newTabId,
          nativeBackend: backend,
          containerId: containerId ?? undefined,
          environmentId,
          isLocal: isLocalEnvironment,
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
          sessionId: options?.resumeSessionId,
        });
        console.debug("[TerminalContainer] Creating", newTab.type, "tab:", newTabId, "for environment:", environmentId, "isLocal:", isLocalEnvironment, "initialPrompt:", !!options?.initialPrompt);
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      if (shouldUseCodexNative) {
        const newTab: TabInfo = {
          id: newTabId,
          type: "codex-native",
          codexNativeData: {
            containerId: isLocalEnvironment ? undefined : containerId ?? undefined,
            environmentId,
            isLocal: isLocalEnvironment,
            sessionId: options?.resumeSessionId,
          },
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
        };
        console.debug("[TerminalContainer] Creating codex-native tab:", newTabId, "for environment:", environmentId, "isLocal:", isLocalEnvironment, "initialPrompt:", !!options?.initialPrompt);
        addTab(activePaneId, newTab, environmentId);
        return true;
      }

      const newTab: TabInfo = {
        id: newTabId,
        type,
        initialPrompt: options?.initialPrompt,
        initialCommands: options?.initialCommands,
        displayTitle: options?.displayTitle,
        isReviewTab: options?.isReviewTab,
        initialAgentModel: options?.initialAgentModel,
        initialReasoningEffort: options?.initialReasoningEffort,
      };

      console.debug("[TerminalContainer] Creating new tab:", newTabId, "type:", type, "for environment:", environmentId);
      addTab(activePaneId, newTab, environmentId);
      return true;
    },
    [containerId, isEnvironmentRunning, activePaneId, addTab, getAllTabs, environmentId, opencodeMode, claudeMode, claudeNativeBackend, codexMode, isLocalEnvironmentReady, createBrowserTab]
  );

  useEffect(() => {
    if (!isActive || !window.orkestrator) return;

    return window.orkestrator.listen<BrowserPreviewOpenLinkEvent>(
      "browser-preview-open-link",
      ({ tabId, url }) => {
        const sourcePane = usePaneLayoutStore.getState().findPaneWithTab(tabId, environmentId);
        const sourceTab = sourcePane?.tabs.find((tab) => tab.id === tabId);
        if (!sourcePane || sourceTab?.type !== "browser") return;
        if (createBrowserTab(url, sourcePane.id)) {
          usePaneLayoutStore.getState().setActivePane(sourcePane.id, environmentId);
        }
      },
    );
  }, [createBrowserTab, environmentId, isActive]);

  // Handler for creating file viewer tabs
  const handleCreateFileTab = useCallback(
    (filePath: string, options?: CreateFileTabOptions) => {
      // For container environments, need containerId and running state
      // For local environments, need worktreePath
      const canCreateForContainer = containerId && isContainerRunning;
      const canCreateForLocal = isLocalEnvironment && worktreePath;
      if (!canCreateForContainer && !canCreateForLocal) return;

      const allTabs = getAllTabs(environmentId);
      if (allTabs.length >= MAX_TABS) {
        console.debug("[TerminalContainer] Maximum tab limit reached:", MAX_TABS);
        return;
      }

      // Check if file is already open - need to match both path AND diff mode
      // Note: This intentionally allows the same file to be open twice if one is in
      // diff mode and one is in regular file mode, as they serve different purposes
      const existingTab = allTabs.find(
        (t) => t.type === "file" &&
               t.fileData?.filePath === filePath &&
               t.fileData?.isDiff === (options?.isDiff ?? false)
      );
      if (existingTab) {
        // Activate the existing tab instead of creating a duplicate
        const pane = usePaneLayoutStore.getState().findPaneWithTab(existingTab.id, environmentId);
        if (pane) {
          usePaneLayoutStore.getState().setActiveTab(pane.id, existingTab.id, environmentId);
          console.debug("[TerminalContainer] Activated existing tab:", existingTab.id, "in pane:", pane.id);
        }
        return;
      }

      const newTabId = createUniqueTabId("file");
      // Validate gitStatus using type guard instead of unsafe cast
      const validatedGitStatus = isGitFileStatus(options?.gitStatus)
        ? options.gitStatus
        : undefined;
      const newTab: TabInfo = {
        id: newTabId,
        type: "file",
        fileData: {
          filePath,
          containerId: isLocalEnvironment ? undefined : containerId ?? undefined,
          worktreePath: isLocalEnvironment ? worktreePath : undefined,
          isLocalEnvironment,
          isDiff: options?.isDiff,
          gitStatus: validatedGitStatus,
          baseBranch: undefined,
        },
      };

      console.debug("[TerminalContainer] Creating file tab:", newTabId, "path:", filePath, "isDiff:", options?.isDiff, "isLocal:", isLocalEnvironment, "for environment:", environmentId);
      addTab(activePaneId, newTab, environmentId);
    },
    [containerId, isContainerRunning, isLocalEnvironment, worktreePath, activePaneId, addTab, getAllTabs, environmentId]
  );

  // Handler for selecting a tab by index (for Ctrl+1, Ctrl+2, etc.)
  // This now only affects the active pane
  const handleSelectTab = useCallback(
    (index: number) => {
      const activePane = getActivePane(environmentId);
      if (activePane && index >= 0 && index < activePane.tabs.length) {
        const tab = activePane.tabs[index];
        if (tab) {
          usePaneLayoutStore.getState().setActiveTab(activePaneId, tab.id, environmentId);
        }
      }
    },
    [activePaneId, environmentId, getActivePane]
  );

  // Handler for closing the active tab
  const handleCloseActiveTab = useCallback(() => {
    const activePane = getActivePane(environmentId);
    if (activePane && activePane.activeTabId) {
      removeTab(activePaneId, activePane.activeTabId, environmentId);
    }
  }, [activePaneId, environmentId, getActivePane, removeTab]);

  // Clear launch options after they've been applied to the first tab.
  useEffect(() => {
    if (hasAppliedClaudeOptions && claudeOptions) {
      // Give pending native launches time to be converted into tabs. Once the
      // tab exists, its initialPrompt lives in pane state until dispatched.
      const timer = setTimeout(() => {
        const pending = useClaudeOptionsStore
          .getState()
          .getPendingNativeLaunch(environmentId);
        if (!pending) {
          clearOptions(environmentId);
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [hasAppliedClaudeOptions, claudeOptions, environmentId, clearOptions]);

  // Register tab functions with context
  useEffect(() => {
    if (!isActive) return;

    if (isEnvironmentRunning && (containerId || isLocalEnvironmentReady)) {
      setCreateTab(handleCreateTab);
      setSelectTab(handleSelectTab);
      setCloseActiveTab(handleCloseActiveTab);
      const allTabs = getAllTabs(environmentId);
      setTabCount(allTabs.length);
      setCreateFileTab(handleCreateFileTab);
      setOpenFilePaths(getOpenFilePaths(environmentId));
    } else {
      setCreateTab(null);
      setSelectTab(null);
      setCloseActiveTab(null);
      setTabCount(0);
      setCreateFileTab(null);
      setOpenFilePaths([]);
    }

    return () => {
      setCreateTab(null);
      setSelectTab(null);
      setCloseActiveTab(null);
      setTabCount(0);
      setCreateFileTab(null);
      setOpenFilePaths([]);
    };
  }, [
    isActive,
    isEnvironmentRunning,
    containerId,
    isLocalEnvironmentReady,
    handleCreateTab,
    handleCreateFileTab,
    handleSelectTab,
    handleCloseActiveTab,
    getAllTabs,
    getOpenFilePaths,
    setCreateTab,
    setSelectTab,
    setCloseActiveTab,
    setTabCount,
    setCreateFileTab,
    setOpenFilePaths,
  ]);

  // Handle drag start - track which tab is being dragged
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  // Handle drag over - track which pane is being hovered
  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { over } = event;
      if (!over) {
        setDragOverPaneId(null);
        return;
      }

      const overId = over.id as string;

      // Check if hovering over a tabbar
      if (overId.startsWith("tabbar:")) {
        const targetPaneId = overId.replace("tabbar:", "");
        setDragOverPaneId(targetPaneId);
        return;
      }

      // Check if hovering over a tab
      const overTab = parseDraggableTabId(overId);
      if (overTab) {
        setDragOverPaneId(overTab.paneId);
        return;
      }

      setDragOverPaneId(null);
    },
    []
  );

  // Handle drag end for tab reordering and moving
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      // Capture drag state before clearing (needed for self-collision handling)
      const lastDragOverPaneId = dragOverPaneId;

      // Clear drag state
      setActiveDragId(null);
      setDragOverPaneId(null);

      const { active, over } = event;
      console.debug("[TerminalContainer] DragEnd - active:", active.id, "over:", over?.id ?? "null", "lastDragOverPaneId:", lastDragOverPaneId);
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const action = getTerminalTabDragEndAction({
        activeId,
        overId,
        lastDragOverPaneId,
        getPane,
      });

      if (action.type === "split") {
        console.debug("[TerminalContainer] Split at edge:", action.edge, "from pane:", action.fromPaneId);
        splitPaneAtEdge(action.targetPaneId, action.edge, action.tabId, action.fromPaneId, environmentId);
      } else if (action.type === "reorder") {
        console.debug("[TerminalContainer] Reordering tabs:", action.fromIndex, "->", action.toIndex);
        reorderTabs(action.paneId, action.fromIndex, action.toIndex, environmentId);
      } else if (action.type === "move") {
        console.debug("[TerminalContainer] Moving tab to pane:", action.toPaneId, "index:", action.toIndex);
        moveTab(action.fromPaneId, action.toPaneId, action.tabId, action.toIndex, environmentId);
      }
    },
    [dragOverPaneId, environmentId, getPane, moveTab, reorderTabs, splitPaneAtEdge]
  );

  const handleStartOverlayClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // Allow context-menu gestures (for example Ctrl+Click on macOS)
      // without triggering a normal start action.
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }

      onStartContainer?.();
    },
    [onStartContainer]
  );

  // Determine what overlay to show (if any)
  // For local environments, we don't have a containerId but can still show terminal
  const showNoEnvironmentOverlay = !containerId && !isLocalEnvironment;
  const showCreatingOverlay = isContainerCreating && (containerId || isLocalEnvironment);
  const showNotRunningOverlay = !isEnvironmentRunning && !isContainerCreating && (containerId || isLocalEnvironment);
  // Use THIS environment's tabs, not the global active environment's tabs
  const thisEnvTabs = currentEnvState ? getAllLeaves(currentEnvState.root).flatMap((leaf) => leaf.tabs) : [];
  // Local environments can show terminal without containerId, but need worktreePath
  const showTerminal = isEnvironmentRunning && (containerId || isLocalEnvironmentReady) && thisEnvTabs.length > 0;

  // Debug logging for local environment display issues (only in development)
  if (import.meta.env.DEV) {
    console.debug("[TerminalContainer] Display state:", {
      environmentId,
      isLocalEnvironment,
      isLocalEnvironmentReady,
      worktreePath,
      isContainerRunning,
      isEnvironmentRunning,
      containerId,
      tabsCount: thisEnvTabs.length,
      showTerminal,
      showNoEnvironmentOverlay,
      showCreatingOverlay,
      showNotRunningOverlay,
    });
  }

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col bg-background", className)}>
      {/* Main content with DnD context */}
      {showTerminal && (
        <DndContext
          sensors={sensors}
          collisionDetection={customCollisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
            <PaneTree
              node={root}
              containerId={containerId}
              environmentId={environmentId}
              isActive={isActive}
              activeDragId={activeDragId}
              dragOverPaneId={dragOverPaneId}
            />
            {/* Terminal portal host - renders all terminals via portals into pane targets */}
            <TerminalPortalHost
              containerId={containerId}
              environmentId={environmentId}
            />
          </div>
        </DndContext>
      )}

      {/* No environment selected overlay */}
      {showNoEnvironmentOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="text-center text-muted-foreground">
            <TerminalIcon className="mx-auto mb-4 h-12 w-12 opacity-50" />
            <p>Select an environment from the sidebar to get started.</p>
          </div>
        </div>
      )}

      {/* Container creating overlay - shows initialization logs (containerized only) */}
      {showCreatingOverlay && containerId && (
        <div className="absolute inset-0 bg-background">
          <InitializationLogs containerId={containerId} className="h-full" />
        </div>
      )}

      {/* Local environment creating overlay */}
      {showCreatingOverlay && isLocalEnvironment && !containerId && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="text-center text-muted-foreground">
            <TerminalIcon className="mx-auto mb-4 h-12 w-12 opacity-50 animate-pulse" />
            <p>Creating worktree...</p>
          </div>
        </div>
      )}

      {/* Environment not running overlay */}
      {showNotRunningOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-background">
          <div className="text-center">
            <TerminalIcon className="mx-auto mb-4 h-12 w-12 text-muted-foreground opacity-50" />
            <p className="mb-4 text-muted-foreground">
              {isLocalEnvironment ? "Environment not started" : "Container is not running"}
            </p>
            {onStartContainer && (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <span className="inline-flex">
                    <Button onClick={handleStartOverlayClick} variant="outline">
                      <Play className="mr-2 h-4 w-4" />
                      {isLocalEnvironment ? "Start Environment" : "Start Container"}
                    </Button>
                  </span>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => onStartContainer()}>
                    <Play className="mr-2 h-4 w-4" />
                    Start
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => onCreateScript?.(createScriptPrompt)}
                    disabled={!onCreateScript}
                  >
                    <FilePlus2 className="mr-2 h-4 w-4" />
                    Create Script
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )}
          </div>
        </div>
      )}

      {setupPhase === "failed" && isEnvironmentRunning && (
        <div className="absolute inset-0 bg-background">
          <SetupPendingOverlay
            environmentId={environmentId}
            setupPhase={setupPhase}
            subtext="Retry setup, or skip it to continue with the current workspace."
          />
        </div>
      )}
    </div>
  );
}
