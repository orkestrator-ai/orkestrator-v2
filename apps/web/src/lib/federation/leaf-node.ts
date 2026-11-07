/**
 * Whether a node scope's node is a leaf, whose coordination happens on its
 * command node (plan item 3006).
 *
 * A leaf scope is one by its role. The page's own facts describe only the
 * app window's command scope: a workspace realm document shows a leaf
 * (until plan item 6002 retires realms), and a window connected directly to
 * a leaf learns it from the command node's federation status. A test's own
 * window scope never reads them.
 */

import { isAppCommandScope } from "@/lib/node-scope-slots";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { workspaceTarget } from "@/lib/portal/portal-transport";

export function scopeNodeIsLeaf(scope: NodeScope): boolean {
  if (scope.role === "leaf") return true;
  if (!isAppCommandScope(scope)) return false;
  return workspaceTarget() !== null || portalStore.getState().status?.mode === "leaf";
}
