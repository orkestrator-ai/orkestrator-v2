import { useEffect, useRef, useCallback, useState, type MouseEvent } from "react";
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
import { useTerminalContext, MAX_TABS, type CreatableTabType, type TerminalTabType, type CreateTabOptions, type CreateFileTabOptions } from "@/contexts";
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
import { cn } from "@/lib/utils";
import { markSetupScriptsComplete, shouldAutoResolveSetupCommands } from "@/lib/setup-commands";
import * as backend from "@/lib/backend";
import {
  buildInitialPromptWithAttachmentReferences,
  saveInitialPromptAttachments,
} from "@/lib/initial-prompt-attachments";
import { resolveClaudeConfig } from "@/lib/claude-mode-resolver";
import { reconcilePersistedLayout } from "@/lib/pane-layout-restore";
import { listenForTerminalBrowserTabRequests } from "@/lib/terminal-links";
import { createOrkestratorScriptPrompt } from "@/prompts";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { PaneTree } from "@/components/pane-layout";
import { TerminalPortalHost } from "./TerminalPortalHost";
import { InitializationLogs } from "./InitializationLogs";
import {
  parseDraggableTabId,
  parseEdgeDroppableId,
  isGitFileStatus,
  type EdgeDirection,
  type PaneLeaf,
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
export const customCollisionDetection: CollisionDetection = (args) => {
  // First, check if the pointer is directly over any droppable
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) {
    // Prioritize tabbars and tabs over edge zones
    const tabCollisions = pointerCollisions.filter(isTabOrTabbar);
    if (tabCollisions.length > 0) {
      return tabCollisions;
    }
    return pointerCollisions;
  }

  // Try rect intersection for nearby targets
  const rectCollisions = rectIntersection(args);
  if (rectCollisions.length > 0) {
    // Prioritize tabbars and tabs over edge zones
    const tabCollisions = rectCollisions.filter(isTabOrTabbar);
    if (tabCollisions.length > 0) {
      return tabCollisions;
    }
    return rectCollisions;
  }

  // Last resort: use closestCenter to find the nearest target
  return closestCenter(args);
};

let tabIdCounter = 0;

function createUniqueTabId(prefix: string): string {
  tabIdCounter = (tabIdCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now()}-${tabIdCounter}`;
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

  // Get Claude options for this environment
  const {
    getOptions,
    clearOptions,
    setOptions,
    setPendingNativeLaunch,
    clearPendingNativeLaunch,
  } = useClaudeOptionsStore();
  const claudeOptions = getOptions(environmentId);
  const pendingNativeLaunch = useClaudeOptionsStore(
    (state) => state.pendingNativeLaunches[environmentId]
  );
  const [hasAppliedClaudeOptions, setHasAppliedClaudeOptions] = useState(false);

  // Get config for agent modes - per-environment overrides take precedence over global
  const { config } = useConfigStore();
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

  // Get workspace ready state - needed early for native OpenCode launch
  const setWorkspaceReady = useEnvironmentStore((state) => state.setWorkspaceReady);
  const consumePendingSetupCommands = useEnvironmentStore((state) => state.consumePendingSetupCommands);
  const setSetupCommandsResolved = useEnvironmentStore((state) => state.setSetupCommandsResolved);
  const setSetupScriptsRunning = useEnvironmentStore((state) => state.setSetupScriptsRunning);
  const setupCommandsResolved = useEnvironmentStore(
    (state) => state.setupCommandsResolved.has(environmentId)
  );
  const setupScriptsRunning = useEnvironmentStore(
    (state) => state.setupScriptsRunning.has(environmentId)
  );
  const workspaceReady = useEnvironmentStore(
    (state) => state.workspaceReadyEnvironments.has(environmentId)
  );
  const hasPendingSetupCommands = useEnvironmentStore(
    (state) => state.pendingSetupCommands.has(environmentId)
  );

  // Check if this is a local environment (no container)
  const environment = useEnvironmentStore(
    (state) => state.environments.find((env) => env.id === environmentId)
  );
  const isLocalEnvironment = environment?.environmentType === "local";
  const createScriptPrompt = createOrkestratorScriptPrompt(isLocalEnvironment);
  // For local environments, worktreePath must be set before terminal can work
  const worktreePath = environment?.worktreePath;
  // Local environment is ready when it has a worktree path (created during start_environment)
  const isLocalEnvironmentReady = isLocalEnvironment && !!worktreePath;
  const isEnvironmentRunning = isContainerRunning || isLocalEnvironmentReady;

  const startInactiveBackendSetup = useCallback(() => {
    if (inactiveBackendSetupInFlightRef.current) {
      return;
    }

    inactiveBackendSetupInFlightRef.current = true;
    console.log("[TerminalContainer] Ensuring environment setup is running in backend:", environmentId);
    setWorkspaceReady(environmentId, false);
    void backend.ensureEnvironmentSetup(environmentId)
      .then((result) => {
        if (!result) {
          console.warn("[setup-terminal] ensureEnvironmentSetup returned no result", {
            environmentId,
          });
          rerunSetupFetchFailedRef.current = true;
          const store = useEnvironmentStore.getState();
          store.setSetupCommandsResolved(environmentId, true);
          store.setSetupScriptsRunning(environmentId, false);
          return;
        }
        console.info("[setup-terminal] ensureEnvironmentSetup result", {
          environmentId,
          setupStarted: result.setupStarted,
          setupSessionId: result.setupSessionId ?? null,
          setupScriptsComplete: result.environment.setupScriptsComplete ?? false,
          environmentType: result.environment.environmentType,
          containerId: result.environment.containerId ?? null,
        });
        const store = useEnvironmentStore.getState();
        const currentEnvironment = store.getEnvironmentById(environmentId);
        const safeEnvironment =
          currentEnvironment?.setupScriptsComplete && result.environment.setupScriptsComplete === false
            ? { ...result.environment, setupScriptsComplete: true }
            : result.environment;
        store.updateEnvironment(environmentId, safeEnvironment);
        if (result.setupSessionId) {
          const key = createSessionKey(safeEnvironment.containerId ?? null, "default", environmentId);
          const terminalStore = useTerminalSessionStore.getState();
          const existing = terminalStore.sessions.get(key);
          console.info("[setup-terminal] binding setup session from ensure result", {
            environmentId,
            key,
            previousSessionId: existing?.sessionId ?? null,
            nextSessionId: result.setupSessionId,
          });
          terminalStore.setSession(key, {
            ...existing,
            sessionId: result.setupSessionId,
          });
          setSetupSessionBindNonce((value) => value + 1);
        }
        const latestStore = useEnvironmentStore.getState();
        const setupComplete =
          safeEnvironment.setupScriptsComplete === true ||
          latestStore.getEnvironmentById(environmentId)?.setupScriptsComplete === true;
        const completionEventAlreadyHandled =
          result.setupStarted &&
          latestStore.isSetupCommandsResolved(environmentId) &&
          !latestStore.isSetupScriptsRunning(environmentId);
        if (setupComplete || latestStore.isWorkspaceReady(environmentId)) {
          latestStore.setSetupScriptsRunning(environmentId, false);
          latestStore.setWorkspaceReady(environmentId, true);
        } else if (result.setupStarted && !completionEventAlreadyHandled) {
          latestStore.setSetupScriptsRunning(environmentId, true);
          latestStore.setWorkspaceReady(environmentId, false);
        } else {
          // Reached when either no setup ran (!setupStarted) or a completion
          // event was already handled while we awaited
          // (completionEventAlreadyHandled). Both mean setup is effectively
          // done, so mark the workspace ready. Forcing readiness to false here
          // (the old `!result.setupStarted`) stranded a just-completed env in a
          // "not running, not ready" state.
          latestStore.setSetupScriptsRunning(environmentId, false);
          latestStore.setWorkspaceReady(environmentId, true);
        }
        latestStore.setSetupCommandsResolved(environmentId, true);
      })
      .catch((error) => {
        console.error("[TerminalContainer] Backend setup failed:", error);
        rerunSetupFetchFailedRef.current = true;
        const store = useEnvironmentStore.getState();
        store.setSetupCommandsResolved(environmentId, true);
        store.setSetupScriptsRunning(environmentId, false);
      })
      .finally(() => {
        inactiveBackendSetupInFlightRef.current = false;
      });
  }, [environmentId, setSetupCommandsResolved, setSetupScriptsRunning, setWorkspaceReady]);

  // Pane layout store - use selectors for reactive state
  const environments = usePaneLayoutStore((state) => state.environments);
  const hydrationStatus = usePaneLayoutStore((state) => state.hydration.get(environmentId));

  // Get derived state for THIS environment (not the globally active one)
  // Each TerminalContainer should render its own environment's tabs
  const currentEnvState = environments.get(environmentId);
  const root = currentEnvState?.root ?? { kind: "leaf" as const, id: "default", tabs: [], activeTabId: null };
  const activePaneId = currentEnvState?.activePaneId ?? "default";

  // Pane layout actions
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
  } = usePaneLayoutStore();

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
  const rerunSetupFetchFailedRef = useRef(false);
  const isSavingInitialPromptAttachmentsRef = useRef(false);
  const setupPlanFetchInFlightRef = useRef(false);
  const inactiveBackendSetupInFlightRef = useRef(false);
  const setupSessionBindInFlightRef = useRef(false);
  const [setupSessionBindNonce, setSetupSessionBindNonce] = useState(0);

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
      if (setupSessionBindInFlightRef.current) {
        const alreadyBound = hasBoundSetupSession(tabId);
        console.info("[setup-terminal] setup session bind skipped: already in flight", {
          environmentId,
          tabId,
          alreadyBound,
        });
        return alreadyBound;
      }
      setupSessionBindInFlightRef.current = true;
      try {
        console.info("[setup-terminal] requesting backend setup session", {
          environmentId,
          tabId,
          key: setupSessionKeyForTab(tabId),
        });
        const setupSession = await backend.getEnvironmentSetupSession(environmentId);
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
        setSetupSessionBindNonce((value) => value + 1);
        return true;
      } catch (error) {
        console.error("[TerminalContainer] Failed to bind backend setup session:", error);
        return false;
      } finally {
        setupSessionBindInFlightRef.current = false;
      }
    },
    [environmentId, hasBoundSetupSession, setupSessionKeyForTab],
  );

  useEffect(() => {
    if (!currentEnvState) return;

    const setupTabs = getAllLeaves(currentEnvState.root)
      .flatMap((leaf) => leaf.tabs)
      .filter((tab) => tab.isSetupTab && (!tab.initialCommands || tab.initialCommands.length === 0));

    const unboundSetupTab = setupTabs.find((tab) => !hasBoundSetupSession(tab.id));
    if (!unboundSetupTab) return;

    console.info("[setup-terminal] found unbound backend-managed setup tab; rebinding", {
      environmentId,
      tabId: unboundSetupTab.id,
      setupScriptsRunning,
      setupScriptsComplete: environment?.setupScriptsComplete ?? false,
      tabCount: setupTabs.length,
    });
    void bindBackendSetupSession(unboundSetupTab.id);
  }, [
    bindBackendSetupSession,
    currentEnvState,
    environment?.setupScriptsComplete,
    environmentId,
    hasBoundSetupSession,
    setupScriptsRunning,
    setupSessionBindNonce,
  ]);

  useEffect(() => {
    if (!currentEnvState || !environment?.setupScriptsComplete || setupScriptsRunning) {
      return;
    }

    const leaves = getAllLeaves(currentEnvState.root);
    for (const leaf of leaves) {
      const staleSetupTab = leaf.tabs.find((tab) => {
        if (!tab.isSetupTab || (tab.initialCommands && tab.initialCommands.length > 0)) {
          return false;
        }
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
    environment?.setupScriptsComplete,
    environmentId,
    removeTab,
    setupScriptsRunning,
    setupSessionKeyForTab,
  ]);

  // Set active environment when this container becomes active
  useEffect(() => {
    if (isActive) {
      setActiveEnvironment(environmentId);
    }
  }, [isActive, environmentId, setActiveEnvironment]);

  // Decide setup-resolution for a running local environment on first activation
  // this app session. Handles three cases:
  //   1. Setup was marked complete in a prior session -> auto-resolve, no re-run.
  //   2. Setup was incomplete in a prior session -> fetch setup commands and
  //      re-populate pendingSetupCommands so the init effect runs them. Guarded
  //      by sessionActivated so re-selecting the env within the same session
  //      does not re-trigger.
  //   3. No pending commands and not first activation -> resolve (the normal
  //      start-env flow already covered setup within this session).
  useEffect(() => {
    const store = useEnvironmentStore.getState();

    if (
      !shouldAutoResolveSetupCommands({
        isLocalEnvironment,
        isLocalEnvironmentReady,
        setupCommandsResolved,
        hasPendingCommands: hasPendingSetupCommands,
      })
    ) {
      return;
    }

    const env = store.getEnvironmentById(environmentId);
    const firstActivation = store.markSessionActivated(environmentId);
    rerunSetupFetchFailedRef.current = false;

    if (!firstActivation || env?.setupScriptsComplete) {
      console.log(
        "[TerminalContainer] Auto-resolving setup commands for local environment:",
        environmentId,
        { firstActivation, persistedComplete: env?.setupScriptsComplete },
      );
      setSetupCommandsResolved(environmentId, true);
      return;
    }

    console.log(
      "[TerminalContainer] Requesting backend setup for previously-incomplete local environment:",
      environmentId,
    );
    startInactiveBackendSetup();
  }, [
    isLocalEnvironment,
    isLocalEnvironmentReady,
    setupCommandsResolved,
    hasPendingSetupCommands,
    environmentId,
    setSetupCommandsResolved,
    startInactiveBackendSetup,
  ]);

  // Running container environments can be rehydrated after app reload without
  // going through `startEnvironment` in this React session. Ask Electron to
  // ensure setup is running instead of fetching commands for React to execute.
  useEffect(() => {
    if (
      isLocalEnvironment ||
      !isEnvironmentRunning ||
      setupCommandsResolved ||
      hasPendingSetupCommands ||
      environment?.setupScriptsComplete ||
      setupPlanFetchInFlightRef.current
    ) {
      return;
    }

    setupPlanFetchInFlightRef.current = true;
    console.log(
      "[TerminalContainer] Requesting backend setup for container environment:",
      environmentId,
    );
    startInactiveBackendSetup();
    setupPlanFetchInFlightRef.current = false;
  }, [
    environment?.setupScriptsComplete,
    environmentId,
    hasPendingSetupCommands,
    isEnvironmentRunning,
    isLocalEnvironment,
    setupCommandsResolved,
    startInactiveBackendSetup,
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

  // Initialize pane layout when container starts running (or local environment starts)
  // For local environments, wait for setupCommandsResolved to know if there are setup commands
  useEffect(() => {
    if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return;

    // Wait until the backend setup command plan has been resolved. This is
    // required for containers too because running environments can rehydrate
    // without going through startEnvironment in this React session.
    if (!setupCommandsResolved && !environment?.setupScriptsComplete) {
      console.log("[TerminalContainer] Environment waiting for setup commands to be resolved");
      return;
    }

    // Check if we need to initialize (no tabs yet for THIS environment)
    const currentTabs = currentEnvState
      ? getAllLeaves(currentEnvState.root).flatMap((leaf) => leaf.tabs)
      : [];

    if (currentTabs.length === 0) {
      const backendSetupRunning = setupScriptsRunning && !environment?.setupScriptsComplete;
      console.info("[setup-terminal] initial terminal layout decision", {
        environmentId,
        backendSetupRunning,
        setupScriptsRunning,
        setupScriptsComplete: environment?.setupScriptsComplete ?? false,
        setupCommandsResolved,
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
      } else if (hydrationStatus === "pending") {
        return;
      } else if (hydrationStatus === undefined) {
        beginHydration(environmentId);
        void backend.getPaneLayout(environmentId)
          .then((saved) => {
            const paneStore = usePaneLayoutStore.getState();
            if (paneStore.hydration.get(environmentId) !== "pending") return;

            const latestEnvironment = useEnvironmentStore
              .getState()
              .getEnvironmentById(environmentId);
            if (!latestEnvironment) {
              paneStore.finishHydration(environmentId);
              return;
            }

            const latestIsLocal = latestEnvironment.environmentType === "local";
            const latestContainerId = latestIsLocal ? null : latestEnvironment.containerId;
            const restored = reconcilePersistedLayout(saved, {
              environmentId,
              containerId: latestContainerId,
              isLocal: latestIsLocal,
              worktreePath: latestEnvironment.worktreePath,
              hasBuildPipeline: (pipelineId) =>
                useBuildPipelineStore.getState().pipelines.has(pipelineId),
            });
            paneStore.finishHydration(environmentId, restored ?? undefined);
          })
          .catch((error) => {
            console.warn("[TerminalContainer] Failed to restore pane layout:", error);
            const paneStore = usePaneLayoutStore.getState();
            if (paneStore.hydration.get(environmentId) === "pending") {
              paneStore.finishHydration(environmentId);
            }
          });
        return;
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

              setOptions(environmentId, {
                ...currentOptions,
                initialPrompt: buildInitialPromptWithAttachmentReferences(
                  currentOptions.initialPrompt,
                  savedAttachments,
                ),
                initialPromptAttachments: [],
              });
            } catch (error) {
              console.error("[TerminalContainer] Failed to save initial prompt attachments:", error);
              const currentOptions = useClaudeOptionsStore.getState().getOptions(environmentId);
              if (currentOptions) {
                setOptions(environmentId, {
                  ...currentOptions,
                  initialPromptAttachments: [],
                });
              }
            } finally {
              isSavingInitialPromptAttachmentsRef.current = false;
            }
          })();
        }
        return;
      }

      initialize(containerId, environmentId);

      // Determine initial tab type based on agent options
      let initialTabType: TerminalTabType = "plain";
      let pendingInitialPrompt: string | undefined;
      const launchAgent = claudeOptions?.launchAgent ?? false;
      if (launchAgent) {
        initialTabType = claudeOptions!.agentType;
        setHasAppliedClaudeOptions(true);
        if (claudeOptions!.initialPrompt?.trim()) {
          pendingInitialPrompt = claudeOptions!.initialPrompt.trim();
          initialPromptRef.current = pendingInitialPrompt;
        }
      }

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
        setWorkspaceReady(environmentId, false);
        if (launchAgent && initialTabType !== "plain") {
          setPendingNativeLaunch(environmentId, {
            containerId: isLocalEnvironment ? null : containerId,
            environmentId,
            initialPrompt: pendingInitialPrompt,
            targetPaneId: "default",
            agentType: initialTabType,
            launchMode: useNativeOpenCode || useNativeClaude || useNativeCodex ? "native" : "terminal",
            claudeNativeBackend: useNativeClaude ? claudeNativeBackend : undefined,
          });
        }

        const setupTab: TabInfo = {
          id: "default",
          type: "plain",
          isSetupTab: true,
        };
        addTab("default", setupTab, environmentId);
        return;
      }

      // Setup commands are supplied by the backend start/get-setup-commands flow.
      const setupCommands = consumePendingSetupCommands(environmentId);
      const hasSetupCommands = setupCommands && setupCommands.length > 0;

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
        hasSetupCommands,
        setupCommandsResolved,
      });

      // Handle local environments
      if (isLocalEnvironment) {
        if (hasSetupCommands && launchAgent) {
          // Local + Claude ON + setup commands: create setup tab first, then agent tab (active)
          console.log("[TerminalContainer] Local environment with setup commands and agent - creating setup tab then agent tab");
          setSetupScriptsRunning(environmentId, true);

          // Create setup tab first
          const setupTab: TabInfo = {
            id: createUniqueTabId("setup"),
            type: "plain",
            initialCommands: setupCommands,
            isSetupTab: true,
          };
          addTab("default", setupTab, environmentId);

          // Then create agent tab (which becomes active)
          if (useNativeClaude) {
            const agentTab = createClaudeNativeLikeTab({
              id: "default",
              nativeBackend: claudeNativeBackend,
              environmentId,
              isLocal: true,
              initialPrompt: pendingInitialPrompt,
            });
            addTab("default", agentTab, environmentId);
          } else if (useNativeCodex) {
            const agentTab: TabInfo = {
              id: "default",
              type: "codex-native",
              codexNativeData: { containerId: undefined, environmentId, isLocal: true },
              initialPrompt: pendingInitialPrompt,
            };
            addTab("default", agentTab, environmentId);
          } else if (useNativeOpenCode) {
            const agentTab: TabInfo = {
              id: "default",
              type: "opencode-native",
              openCodeNativeData: { containerId: undefined, environmentId, isLocal: true },
              initialPrompt: pendingInitialPrompt,
            };
            addTab("default", agentTab, environmentId);
          } else {
            // Terminal mode agent (claude or opencode)
            const agentTab: TabInfo = {
              id: "default",
              type: initialTabType,
              initialPrompt: pendingInitialPrompt,
            };
            addTab("default", agentTab, environmentId);
          }
        } else if (hasSetupCommands && !launchAgent) {
          // Local + Claude OFF + setup commands: single terminal with setup commands
          console.log("[TerminalContainer] Local environment with setup commands, no agent - creating terminal with setup commands");
          setSetupScriptsRunning(environmentId, true);
          const initialTab: TabInfo = {
            id: "default",
            type: "plain",
            initialCommands: setupCommands,
            isSetupTab: true,
          };
          addTab("default", initialTab, environmentId);
        } else if (useNativeOpenCode || useNativeClaude || useNativeCodex) {
          // Local + native mode + no setup commands: directly create native tab.
          // No setup to run means setup is trivially "complete" for this env.
          if (!rerunSetupFetchFailedRef.current) {
            markSetupScriptsComplete(environmentId);
          }
          console.log(
            "[TerminalContainer] Local environment - directly creating native",
            useNativeClaude ? "Claude" : useNativeCodex ? "Codex" : "OpenCode",
            "tab",
          );
          if (useNativeClaude) {
            const initialTab = createClaudeNativeLikeTab({
              id: "default",
              nativeBackend: claudeNativeBackend,
              environmentId,
              isLocal: true,
              initialPrompt: pendingInitialPrompt,
            });
            addTab("default", initialTab, environmentId);
          } else if (useNativeCodex) {
            const initialTab: TabInfo = {
              id: "default",
              type: "codex-native",
              codexNativeData: { containerId: undefined, environmentId, isLocal: true },
              initialPrompt: pendingInitialPrompt,
            };
            addTab("default", initialTab, environmentId);
          } else {
            const initialTab: TabInfo = {
              id: "default",
              type: "opencode-native",
              openCodeNativeData: { containerId: undefined, environmentId, isLocal: true },
              initialPrompt: pendingInitialPrompt,
            };
            addTab("default", initialTab, environmentId);
          }
        } else {
          // Local + terminal mode + no setup commands: create terminal tab.
          // No setup to run means setup is trivially "complete" for this env.
          if (!rerunSetupFetchFailedRef.current) {
            markSetupScriptsComplete(environmentId);
          }
          console.log("[TerminalContainer] Local environment - creating terminal tab with initial type:", initialTabType);
          const initialTab: TabInfo = {
            id: "default",
            type: initialTabType,
            initialPrompt: pendingInitialPrompt,
          };
          addTab("default", initialTab, environmentId);
        }
      } else if (!hasSetupCommands && environment?.setupScriptsComplete) {
        setWorkspaceReady(environmentId, true);
        if (useNativeClaude) {
          const initialTab = createClaudeNativeLikeTab({
            id: "default",
            nativeBackend: claudeNativeBackend,
            containerId: containerId ?? undefined,
            environmentId,
            isLocal: false,
            initialPrompt: pendingInitialPrompt,
          });
          addTab("default", initialTab, environmentId);
        } else if (useNativeCodex) {
          const initialTab: TabInfo = {
            id: "default",
            type: "codex-native",
            codexNativeData: { containerId: containerId ?? undefined, environmentId, isLocal: false },
            initialPrompt: pendingInitialPrompt,
          };
          addTab("default", initialTab, environmentId);
        } else if (useNativeOpenCode) {
          const initialTab: TabInfo = {
            id: "default",
            type: "opencode-native",
            openCodeNativeData: { containerId: containerId ?? undefined, environmentId, isLocal: false },
            initialPrompt: pendingInitialPrompt,
          };
          addTab("default", initialTab, environmentId);
        } else {
          const initialTab: TabInfo = {
            id: "default",
            type: initialTabType,
            initialPrompt: pendingInitialPrompt,
          };
          addTab("default", initialTab, environmentId);
        }
      } else if (!hasSetupCommands && rerunSetupFetchFailedRef.current) {
        setSetupScriptsRunning(environmentId, false);
        const initialTab: TabInfo = {
          id: "default",
          type: "plain",
          initialPrompt: pendingInitialPrompt,
        };
        addTab("default", initialTab, environmentId);
      } else if (useNativeOpenCode || useNativeClaude || useNativeCodex) {
        // Container + native mode: start with plain terminal for setup scripts
        setWorkspaceReady(environmentId, false);
        setSetupScriptsRunning(environmentId, true);
        setPendingNativeLaunch(environmentId, {
          containerId,
          environmentId,
          initialPrompt: pendingInitialPrompt,
          targetPaneId: "default",
          agentType: useNativeClaude ? "claude" : useNativeCodex ? "codex" : "opencode",
          launchMode: "native",
          claudeNativeBackend: useNativeClaude ? claudeNativeBackend : undefined,
        });
        console.log(
          "[TerminalContainer] Pending native",
          useNativeClaude ? "Claude" : useNativeCodex ? "Codex" : "OpenCode",
          "launch stored for environment:",
          environmentId,
        );
        const initialTab: TabInfo = {
          id: "default",
          type: "plain",
          initialCommands: setupCommands ?? [],
          isSetupTab: true,
        };
        addTab("default", initialTab, environmentId);
      } else {
        // Container + terminal mode: run workspace setup before opening an agent tab.
        setWorkspaceReady(environmentId, false);
        setSetupScriptsRunning(environmentId, true);

        if (initialTabType !== "plain") {
          setPendingNativeLaunch(environmentId, {
            containerId,
            environmentId,
            initialPrompt: pendingInitialPrompt,
            targetPaneId: "default",
            agentType: initialTabType,
            launchMode: "terminal",
          });
        }
        const initialTab: TabInfo = {
          id: "default",
          type: "plain",
          initialCommands: setupCommands ?? [],
          isSetupTab: true,
        };
        addTab("default", initialTab, environmentId);
      }
    }
  }, [isEnvironmentRunning, containerId, isLocalEnvironmentReady, isLocalEnvironment, setupCommandsResolved, setupScriptsRunning, environment?.setupScriptsComplete, claudeOptions, initialize, addTab, environmentId, currentEnvState, hydrationStatus, beginHydration, finishHydration, opencodeMode, claudeMode, claudeNativeBackend, codexMode, setWorkspaceReady, consumePendingSetupCommands, setSetupScriptsRunning, setPendingNativeLaunch, setOptions, worktreePath, startInactiveBackendSetup, hasBoundSetupSession, bindBackendSetupSession, setupSessionBindNonce]);

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

  // Reset pane layout and workspace ready state when container stops
  // This clears all terminals and tabs since their backend sessions are destroyed
  useEffect(() => {
    if (!isContainerRunning && containerId) {
      console.debug("[TerminalContainer] Container stopped, resetting panes for environment:", environmentId);
      setWorkspaceReady(environmentId, false);
      reset(environmentId);
      // Clear pending native OpenCode launch on container stop
      clearPendingNativeLaunch(environmentId);
    }
  }, [isContainerRunning, environmentId, containerId, setWorkspaceReady, reset, clearPendingNativeLaunch]);

  // Launch native tab after workspace setup completes
  useEffect(() => {
    const setupComplete = environment?.setupScriptsComplete === true;
    const canLaunchPendingNative = (workspaceReady || setupComplete) && pendingNativeLaunch && (containerId || isLocalEnvironmentReady);
    console.log("[TerminalContainer] Native tab effect check - workspaceReady:", workspaceReady, "setupComplete:", setupComplete, "hasPending:", !!pendingNativeLaunch, "containerId:", !!containerId, "isLocalEnvironmentReady:", isLocalEnvironmentReady);

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
        if (setupComplete && !workspaceReady) {
          setWorkspaceReady(environmentId, true);
        }
        const isClaudeNative = pending.agentType === "claude";
        const isCodexNative = pending.agentType === "codex";
        const launchMode = pending.launchMode ?? "native";
        setSetupScriptsRunning(environmentId, false);
        console.log(
          "[TerminalContainer] Workspace ready, launching",
          launchMode,
          isClaudeNative ? "Claude" : isCodexNative ? "Codex" : "OpenCode",
          "tab for environment:",
          environmentId,
        );

        if (launchMode === "terminal") {
          const newTabId = createUniqueTabId(pending.agentType);
          const newTab: TabInfo = {
            id: newTabId,
            type: pending.agentType,
            initialPrompt: pending.initialPrompt,
          };
          addTab(pending.targetPaneId, newTab, environmentId);
        } else if (isClaudeNative) {
          const backend = pending.claudeNativeBackend ?? claudeNativeBackend;
          const newTabId = createUniqueTabId(`claude-${backend}`);
          const newTab = createClaudeNativeLikeTab({
            id: newTabId,
            nativeBackend: backend,
            containerId: pending.containerId ?? undefined,
            environmentId: pending.environmentId,
            isLocal: isLocalEnvironment,
            initialPrompt: pending.initialPrompt,
          });
          addTab(pending.targetPaneId, newTab, environmentId);
        } else if (isCodexNative) {
          const newTabId = createUniqueTabId("codex-native");
          const newTab: TabInfo = {
            id: newTabId,
            type: "codex-native",
            codexNativeData: {
              containerId: isLocalEnvironment ? undefined : pending.containerId ?? undefined,
              environmentId: pending.environmentId,
              isLocal: isLocalEnvironment,
            },
            initialPrompt: pending.initialPrompt,
          };
          addTab(pending.targetPaneId, newTab, environmentId);
        } else {
          // Create OpenCode native tab
          const newTabId = createUniqueTabId("opencode-native");
          const newTab: TabInfo = {
            id: newTabId,
            type: "opencode-native",
            openCodeNativeData: {
              containerId: isLocalEnvironment ? undefined : pending.containerId ?? undefined,
              environmentId: pending.environmentId,
              isLocal: isLocalEnvironment,
            },
            initialPrompt: pending.initialPrompt,
          };
          addTab(pending.targetPaneId, newTab, environmentId);
        }

        // Clear the pending launch
        clearPendingNativeLaunch(environmentId);
        clearOptions(environmentId);
      }
    }
  }, [
    workspaceReady,
    pendingNativeLaunch,
    containerId,
    environmentId,
    environment?.setupScriptsComplete,
    isLocalEnvironment,
    isLocalEnvironmentReady,
    addTab,
    clearPendingNativeLaunch,
    clearOptions,
    setSetupScriptsRunning,
    setWorkspaceReady,
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
    (type: CreatableTabType, options?: CreateTabOptions) => {
      // For local environments, we don't need a containerId but do need worktreePath to be set
      if (!isEnvironmentRunning || (!containerId && !isLocalEnvironmentReady)) return;

      const allTabs = getAllTabs(environmentId);
      if (allTabs.length >= MAX_TABS) {
        console.debug("[TerminalContainer] Maximum tab limit reached:", MAX_TABS);
        return;
      }

      if (type === "browser") {
        createBrowserTab(
          options?.initialUrl,
          activePaneId,
          options?.displayTitle,
        );
        return;
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
          },
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
        };
        console.debug("[TerminalContainer] Creating opencode-native tab:", newTabId, "for environment:", environmentId, "isLocal:", isLocalEnvironment, "initialPrompt:", !!options?.initialPrompt);
        addTab(activePaneId, newTab, environmentId);
        return;
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
        });
        console.debug("[TerminalContainer] Creating", newTab.type, "tab:", newTabId, "for environment:", environmentId, "isLocal:", isLocalEnvironment, "initialPrompt:", !!options?.initialPrompt);
        addTab(activePaneId, newTab, environmentId);
        return;
      }

      if (shouldUseCodexNative) {
        const newTab: TabInfo = {
          id: newTabId,
          type: "codex-native",
          codexNativeData: {
            containerId: isLocalEnvironment ? undefined : containerId ?? undefined,
            environmentId,
            isLocal: isLocalEnvironment,
          },
          initialPrompt: options?.initialPrompt,
          displayTitle: options?.displayTitle,
          isReviewTab: options?.isReviewTab,
          initialAgentModel: options?.initialAgentModel,
          initialReasoningEffort: options?.initialReasoningEffort,
        };
        console.debug("[TerminalContainer] Creating codex-native tab:", newTabId, "for environment:", environmentId, "isLocal:", isLocalEnvironment, "initialPrompt:", !!options?.initialPrompt);
        addTab(activePaneId, newTab, environmentId);
        return;
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
    },
    [containerId, isEnvironmentRunning, activePaneId, addTab, getAllTabs, environmentId, opencodeMode, claudeMode, claudeNativeBackend, codexMode, isLocalEnvironmentReady, createBrowserTab]
  );

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
    </div>
  );
}
