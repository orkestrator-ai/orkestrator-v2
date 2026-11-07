/**
 * Whether a node scope's node is a leaf, whose coordination happens on its
 * command node (plan item 3006).
 *
 * A leaf scope is one by its role. The app window's command scope is a leaf
 * when the window is connected directly to a leaf: it learns that from the
 * command node's federation status. A test's own window scope never reads it.
 */

import { isAppCommandScope } from "@/lib/node-scope-slots";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { portalStore } from "@/lib/portal/portal-store";

export function scopeNodeIsLeaf(scope: NodeScope): boolean {
  if (scope.role === "leaf") return true;
  if (!isAppCommandScope(scope)) return false;
  return portalStore.getState().status?.mode === "leaf";
}
