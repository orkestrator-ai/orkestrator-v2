/**
 * "Open full conversation": focus a chat tab and ask it to scroll to the
 * message that carried a web annotation request.
 *
 * The request is parked in `conversationScrollTargetStore` rather than applied
 * directly, because the destination chat may not be mounted, active, or
 * loaded yet. The native chat (`useConversationScrollTarget`) consumes it once
 * the message is rendered, highlights the row briefly, and drops a request it
 * cannot place after a bounded wait — leaving the reader at the bottom.
 *
 * Target ids come from `WebAnnotationTranscriptRef`: `messageId` is the native
 * projection id of the user message carrying the request marker (rendered
 * unchanged as `NativeMessage.id`), and `turnId` is the matching
 * `turnBoundaries` entry's turn. See `resolveConversationScrollIndex` for the
 * full mapping.
 */
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import {
  useConversationScrollTargetStore,
  type ConversationScrollTarget,
  type ConversationScrollTargetRef,
} from "@/stores/conversationScrollTargetStore";

/**
 * Activates the tab in its pane and requests a scroll to `target` there.
 * Returns false (and parks nothing) when the tab is not in its environment's
 * layout on `ref.nodeId`. With neither id the tab is still focused and any
 * earlier pending request for it is dropped.
 *
 * The request is parked for `ref.nodeId`, so only that node's chat consumes
 * it. The pane layout is `scope`'s, the node scope `ref.nodeId` names (the
 * app's command scope when omitted).
 */
export function openConversationAtMessage(
  ref: ConversationScrollTargetRef,
  target: ConversationScrollTarget,
  scope: NodeScope = appCommandScope(),
): boolean {
  const { environmentId, tabId } = ref;
  const panes = scope.store(paneLayoutStore).getState();
  const pane = panes.findPaneWithTab(tabId, environmentId);
  if (!pane) return false;
  // Park before activating so the chat sees the request in the same commit
  // that makes it active, and never performs a stale bottom-only activation.
  useConversationScrollTargetStore.getState().request(ref, target);
  panes.setActiveTab(pane.id, tabId, environmentId);
  panes.setActivePane(pane.id, environmentId);
  return true;
}
