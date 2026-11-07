import type { BackendId } from "@orkestrator/protocol/federation";
import { create } from "zustand";
import type { NativeAgentData, TabInfo } from "@/types/paneLayout";
import type { ProjectBoardTab } from "./uiStore";

/** The conversation in a coordinator page's focused group, as the window's chrome sees it. */
export interface ActiveCoordinatorConversation {
  /** The node the coordinator page's project is on. */
  nodeId: BackendId;
  projectId: string;
  /** The conversation's own tab id, which its session key is built from. */
  tabId: string;
  data: NativeAgentData;
}

interface ActiveCoordinatorConversationState {
  active: ActiveCoordinatorConversation | null;
  publish: (conversation: ActiveCoordinatorConversation) => void;
  /** Clears only the page's own entry, so a remounting page cannot erase its successor's. */
  clear: (nodeId: BackendId, projectId: string, tabId?: string) => void;
}

function sameConversation(
  a: ActiveCoordinatorConversation | null,
  b: ActiveCoordinatorConversation,
): boolean {
  return (
    a !== null &&
    a.nodeId === b.nodeId &&
    a.projectId === b.projectId &&
    a.tabId === b.tabId &&
    a.data.platform === b.data.platform &&
    a.data.environmentId === b.data.environmentId &&
    a.data.sessionId === b.data.sessionId &&
    a.data.isLocal === b.data.isLocal &&
    a.data.containerId === b.data.containerId
  );
}

/**
 * A coordinator conversation is not a pane-layout tab: the coordinator page
 * owns its own groups and has no Environment record behind it. The window's
 * agent information button reads the active tab from the pane layout, so the
 * coordinator page publishes its focused conversation here while it is shown,
 * and the button treats it exactly like a native agent tab.
 *
 * Presentation only. The conversation, its provider session and its usage all
 * live in the backend; an entry exists only while a coordinator page is
 * mounted, and a missing one simply means "no coordinator conversation shown".
 */
export const useActiveCoordinatorConversationStore = create<ActiveCoordinatorConversationState>()(
  (set, get) => ({
    active: null,
    publish: (conversation) => {
      if (sameConversation(get().active, conversation)) return;
      set({ active: conversation });
    },
    clear: (nodeId, projectId, tabId) => {
      const current = get().active;
      if (!current || current.nodeId !== nodeId || current.projectId !== projectId) return;
      if (tabId !== undefined && current.tabId !== tabId) return;
      set({ active: null });
    },
  }),
);

/**
 * The tab the agent information button reads while a coordinator page is
 * shown: its focused conversation, as a native agent tab. Null when the
 * selected project's coordinator page is not the one on screen (including
 * the same project id on another node), so the window falls back to the
 * environment's own active tab.
 */
export function coordinatorConversationTab(
  conversation: ActiveCoordinatorConversation | null,
  selected: { nodeId: BackendId; projectId: string | null },
  projectBoardTab: ProjectBoardTab,
): TabInfo | null {
  if (
    !conversation ||
    projectBoardTab !== "coordinator" ||
    conversation.nodeId !== selected.nodeId ||
    conversation.projectId !== selected.projectId
  ) {
    return null;
  }
  return {
    id: conversation.tabId,
    type: "agent-native",
    nativeAgentData: { ...conversation.data },
  };
}
