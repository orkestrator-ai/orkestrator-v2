import {
  pointerWithin,
  rectIntersection,
  closestCenter,
  type CollisionDetection,
  type Collision,
} from "@dnd-kit/core";
import { getAllLeaves, usePaneLayoutStore } from "@/stores";
import type { TabType } from "@/contexts";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { createSessionKey as createNativeSessionKey } from "@/lib/utils";
import {
  parseDraggableTabId,
  parseEdgeDroppableId,
  type EdgeDirection,
  type PaneLeaf,
  type PaneNode,
  type TabInfo,
} from "@/types/paneLayout";
import type { ClaudeNativeBackend } from "@/types";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

export const SETUP_SESSION_BIND_RETRY_DELAY_MS = 250;
export const MAX_SETUP_SESSION_BIND_ATTEMPTS = 3;

export interface TerminalContainerProps {
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

export function createUniqueTabId(prefix: string): string {
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
export const STARTUP_AGENT_TAB_ID = "startup-agent";

/**
 * Which tab types count as "the agent a post-setup launch was asking for".
 *
 * Exhaustive over `TabType` on purpose: this table decides when a durable
 * `pendingAgentLaunch` is considered satisfied and can be cleared. A new tab type
 * that silently defaulted to `false` here would make the launch effect open a
 * duplicate agent forever, so adding one must be a compile error rather than a
 * behaviour change.
 */
export const STARTUP_AGENT_TAB_TYPES: Record<TabType, boolean> = {
  claude: true,
  "agent-native": true,
  "claude-tmux": true,
  codex: true,
  opencode: true,
  cursor: true,
  grok: true,
  pi: true,
  // Not startup agents: pipeline/review surfaces and non-agent tabs.
  "claude-build": false,
  "looped-review": false,
  "multi-review": false,
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
export function findStartupAgentTabId(state: { root: PaneNode }): string | null {
  const candidates = getAllLeaves(state.root)
    .flatMap((leaf) => leaf.tabs)
    .filter((tab) => STARTUP_AGENT_TAB_TYPES[tab.type] === true);
  if (candidates.length === 0) return null;
  return candidates.some((tab) => tab.id === STARTUP_AGENT_TAB_ID)
    ? STARTUP_AGENT_TAB_ID
    : candidates[0]!.id;
}

/** True when a pane is still showing the setup terminal, or nothing valid. */
export function paneSelectionIsSetupHandoffSource(leaf: PaneLeaf): boolean {
  const selected = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
  return !selected || selected.isSetupTab === true;
}

/**
 * After setup finishes, move focus from the setup terminal onto the startup
 * agent. The backend publishes that tab while setup is still running, and the
 * renderer keeps the setup tab selected so the user can watch it; without this
 * handoff the agent tab exists but stays unselected.
 *
 * A user who already clicked a non-setup tab is left alone — in either the
 * startup agent's own pane or the pane they are actually looking at, and an
 * unresolvable focused pane fails closed. Returns whether selection changed so
 * callers can treat the handoff as one-shot.
 */
export function handoffSetupFocusToStartupAgent(
  environmentId: string,
  state: { root: PaneNode; activePaneId: string },
  startupTabId: string,
): boolean {
  const leaves = getAllLeaves(state.root);
  const agentLeaf = leaves.find((leaf) => leaf.tabs.some((tab) => tab.id === startupTabId));
  if (!agentLeaf) return false;
  const focusedLeaf = leaves.find((leaf) => leaf.id === state.activePaneId);
  if (!focusedLeaf) return false;

  if (!paneSelectionIsSetupHandoffSource(agentLeaf)) return false;
  if (focusedLeaf !== agentLeaf && !paneSelectionIsSetupHandoffSource(focusedLeaf)) {
    return false;
  }
  if (agentLeaf.activeTabId === startupTabId && state.activePaneId === agentLeaf.id) {
    return false;
  }

  usePaneLayoutStore.getState().setActiveTab(agentLeaf.id, startupTabId, environmentId);
  return true;
}

export type TerminalTabDragEndAction =
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

export function createClaudeNativeLikeTab({
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
  initialConversationMode,
  sessionId,
  requireExistingResumeSession,
  deferPlatform = false,
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
  initialConversationMode?: "build" | "plan";
  sessionId?: string;
  requireExistingResumeSession?: boolean;
  deferPlatform?: boolean;
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
    type: "agent-native",
    nativeAgentData: {
      platform: deferPlatform ? undefined : "claude",
      containerId: isLocal ? undefined : containerId,
      environmentId,
      isLocal,
      sessionId,
      requireExistingResumeSession,
    },
    initialPrompt,
    displayTitle,
    isReviewTab,
    initialAgentModel,
    initialReasoningEffort,
    initialConversationMode,
  };
}

export function createAgentNativeTab({
  id,
  platform,
  containerId,
  environmentId,
  isLocal,
  sessionId,
  requireExistingResumeSession,
  initialPrompt,
  displayTitle,
  isReviewTab,
  initialAgentModel,
  initialReasoningEffort,
  initialConversationMode,
}: {
  id: string;
  platform: AgentPlatform | undefined;
  containerId?: string;
  environmentId: string;
  isLocal: boolean;
  sessionId?: string;
  requireExistingResumeSession?: boolean;
  initialPrompt?: string;
  displayTitle?: string;
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  initialConversationMode?: "build" | "plan";
}): TabInfo {
  return {
    id,
    type: "agent-native",
    nativeAgentData: {
      platform,
      containerId: isLocal ? undefined : containerId,
      environmentId,
      isLocal,
      sessionId,
      requireExistingResumeSession,
    },
    initialPrompt,
    displayTitle,
    isReviewTab,
    initialAgentModel,
    initialReasoningEffort,
    initialConversationMode,
  };
}

/**
 * Empty native tabs stay durably unassigned until their first dispatch, but a
 * provider-specific launcher still has to seed the neutral composer with the
 * provider the user clicked. Otherwise the composer falls back to the global
 * default and a Grok/Cursor/Codex/OpenCode button can silently launch Claude.
 */
export function seedDeferredNativePlatform(tab: TabInfo, platform: AgentPlatform): void {
  const data = tab.nativeAgentData;
  if (tab.type !== "agent-native" || !data || data.platform) return;
  useNativeComposeStore
    .getState()
    .updateDraft(createNativeSessionKey(data.environmentId, tab.id), { platform });
}
