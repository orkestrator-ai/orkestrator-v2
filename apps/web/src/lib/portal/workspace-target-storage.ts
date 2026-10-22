import { realmWorkspaceId } from "@/lib/federation/workspace-realm";
import type { LeafWorkspace } from "./workspaces";

/**
 * Browser and iOS: the leaf workspaces this tab's realms work on (see
 * `lib/federation/workspace-realm.ts`). The window opens each grant and
 * keeps it in the tab's session storage under the workspace's ID, which is
 * all the realm's URL carries: the grant never goes into a URL, and it never
 * reaches another tab. The window itself is always on its command node.
 */
const REALM_KEY_PREFIX = "orkestrator.workspace-realm:";
/** Where a whole tab used to move to a leaf; such a tab now comes back to its command node. */
const LEGACY_TARGET_KEY = "orkestrator.workspace-target";

function parseWorkspace(text: string | null): LeafWorkspace | null {
  if (!text) return null;
  try {
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

/** The workspace this realm works on; `null` in the window itself. */
export function readStoredWorkspace(): LeafWorkspace | null {
  const workspaceId = realmWorkspaceId();
  if (!workspaceId) return null;
  try {
    const workspace = parseWorkspace(window.sessionStorage.getItem(REALM_KEY_PREFIX + workspaceId));
    return workspace?.workspaceId === workspaceId ? workspace : null;
  } catch {
    return null;
  }
}

export function writeRealmWorkspace(workspace: LeafWorkspace): void {
  try {
    window.sessionStorage.setItem(
      REALM_KEY_PREFIX + workspace.workspaceId,
      JSON.stringify(workspace),
    );
  } catch {
    throw new Error("Could not keep the workspace connection in this tab");
  }
}

export function removeRealmWorkspace(workspaceId: string): void {
  try {
    window.sessionStorage.removeItem(REALM_KEY_PREFIX + workspaceId);
  } catch {
    // The grant is revoked on the command node either way.
  }
}

/** A tab that moved to a leaf before the window stayed on its command node. */
export function clearLegacyWorkspaceTarget(): void {
  try {
    window.sessionStorage.removeItem(LEGACY_TARGET_KEY);
  } catch {
    // Nothing reads it any more.
  }
}
