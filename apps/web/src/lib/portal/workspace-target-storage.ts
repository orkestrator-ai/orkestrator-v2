import type { LeafWorkspace } from "./workspaces";

/**
 * Browser and iOS: the leaf workspace this tab works on. Kept in the tab's
 * session storage, so it survives the reload into the node and a refresh,
 * but never another tab, and the grant never goes into a URL.
 */
const TARGET_KEY = "orkestrator.workspace-target";

export function readStoredWorkspace(): LeafWorkspace | null {
  try {
    const text = window.sessionStorage.getItem(TARGET_KEY);
    if (!text) return null;
    const value = JSON.parse(text) as Partial<LeafWorkspace>;
    if (
      typeof value.workspaceId !== "string" ||
      typeof value.nodeId !== "string" ||
      typeof value.baseUrl !== "string" ||
      typeof value.nodeName !== "string" ||
      (value.path !== "direct" && value.path !== "relay")
    ) {
      return null;
    }
    return value as LeafWorkspace;
  } catch {
    return null;
  }
}

export function writeStoredWorkspace(workspace: LeafWorkspace | null): void {
  try {
    if (workspace) window.sessionStorage.setItem(TARGET_KEY, JSON.stringify(workspace));
    else window.sessionStorage.removeItem(TARGET_KEY);
  } catch {
    throw new Error("Could not save the workspace target in this tab");
  }
}
