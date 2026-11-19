/**
 * Where the palette's message and past-session History rows go, on the node
 * scope that owns them. Both reuse existing paths: a message opens through
 * the scroll request "Open full conversation" parks
 * (`conversationScrollTargetStore`), and a past session opens a new agent tab
 * that resumes it through the tab's own resume handler
 * (`native-agent-resume-requests`).
 */
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import {
  clearNativeAgentResumeRequest,
  parkNativeAgentResumeRequest,
} from "@/lib/native-agent-resume-requests";
import { createPersistedPaneLayoutInput, flushPaneLayoutNow } from "@/lib/pane-layout-persistence";
import { createUuid } from "@/lib/uuid";
import { useConversationScrollTargetStore } from "@/stores/conversationScrollTargetStore";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import type { TabInfo } from "@/types/paneLayout";
import type { MessageHistoryResult, SessionHistoryResult } from "./history";

/**
 * Asks the message's chat to scroll to it once it is shown. The caller then
 * opens the tab; the request is parked first so the chat sees it in the same
 * commit that makes it active, and it expires if the message cannot be placed.
 */
export function requestMessageScroll(scope: NodeScope, result: MessageHistoryResult): void {
  useConversationScrollTargetStore.getState().request(
    {
      nodeId: scope.nodeId as BackendId,
      environmentId: result.environmentId,
      tabId: result.tabId,
    },
    { messageId: result.messageId },
  );
}

/**
 * Adds an agent tab for `result`'s platform to its environment's layout on
 * `scope`, parks the resume request the tab reads when it mounts, and saves
 * the layout; the tab resumes the conversation once the save succeeds.
 * Returns the new tab's id, or null when the environment is not in this
 * scope's stores or its layout refused the tab (nothing is left behind then).
 */
export function openPastSessionTab(
  scope: NodeScope,
  result: SessionHistoryResult,
  /** This window's own record of the environment, when the scope's store has none yet. */
  fallback?: Pick<Environment, "id" | "environmentType" | "containerId">,
): string | null {
  const { environmentId } = result;
  const environment =
    scope.store(environmentStore).getState().getEnvironmentById(environmentId) ??
    (fallback?.id === environmentId ? fallback : undefined);
  const panes = scope.store(paneLayoutStore).getState();
  if (!environment || !panes.environments.get(environmentId)) return null;
  const isLocal = environment.environmentType === "local";
  const tabId = createUuid();
  let settle: (saved: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  parkNativeAgentResumeRequest(
    { nodeId: scope.nodeId, environmentId, tabId },
    { platform: result.platform, sessionId: result.sessionId, ready },
  );
  const tab: TabInfo = {
    id: tabId,
    type: "agent-native",
    nativeAgentData: {
      platform: result.platform,
      containerId: isLocal ? undefined : (environment.containerId ?? undefined),
      environmentId,
      isLocal,
    },
  };
  panes.addTab(panes.getActivePaneId(environmentId), tab, environmentId);
  const after = scope.store(paneLayoutStore).getState();
  const saved = after.environments.get(environmentId);
  // The layout refused the tab (its limit): nothing to open or resume.
  if (!saved || !after.findPaneWithTab(tabId, environmentId)) {
    clearNativeAgentResumeRequest({ nodeId: scope.nodeId, environmentId, tabId });
    return null;
  }
  flushPaneLayoutNow(
    environmentId,
    createPersistedPaneLayoutInput(saved),
    undefined,
    undefined,
    scope,
  ).then(
    () => settle(true),
    () => settle(false),
  );
  return tabId;
}
