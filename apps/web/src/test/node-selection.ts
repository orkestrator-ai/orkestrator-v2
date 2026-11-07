import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { startRemoteWorkspaceSelectionSync } from "@/stores/remoteWorkspaceStore";
import { noteNodeSelectionRecents } from "@/stores/windowSelectionStore";

/**
 * Another node's own selection changing in its workspace, as the window sees
 * it: the node's `uiStore` moves the window's one selection, its host adds
 * the Home flag and the window's recents (`NodeWorkspaceHost`), and the
 * region keeps `remoteWorkspaceStore.active` derived from it
 * (`startRemoteWorkspaceSelectionSync`). A node the window does not show
 * moves nothing: its selection is its own. For suites that render neither.
 */
export function selectOnNode(
  nodeId: string,
  selection: { projectId: string | null; environmentId: string | null; projectHome?: boolean },
): void {
  if (getWindowScope().selection.get()?.nodeId !== nodeId) return;
  const next = {
    nodeId: nodeId as BackendId,
    projectId: selection.projectId,
    environmentId: selection.environmentId,
    ...(selection.projectHome ? { projectHome: true } : {}),
  };
  const stop = startRemoteWorkspaceSelectionSync();
  try {
    getWindowScope().select(next);
    noteNodeSelectionRecents(next);
  } finally {
    stop();
  }
}
