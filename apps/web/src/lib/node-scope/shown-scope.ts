/**
 * The node the window shows, as a scope (plan item 5002, report §9).
 *
 * The window's one selection names its node (plan item 3006). When the window
 * has a scope for that node (its own command node, or another node shown in
 * its own tree, plan item 4001), that scope is the one window-level features
 * act on: the pull request opener opens in its files panel, the title bar
 * reads its meters and draws its popovers. A node whose scope is still
 * opening has none yet.
 */

import { getWindowScope } from "./app-window-scope";
import type { NodeScope } from "./node-scope";
import type { WindowScope } from "./window-scope";

/**
 * The scope of the node `windowScope` shows: the selection's node when the
 * window has a scope for it, the command scope while nothing is selected,
 * and `null` while the window shows a node it has no scope for (yet).
 */
export function shownNodeScope(windowScope: WindowScope = getWindowScope()): NodeScope | null {
  const selection = windowScope.selection.get();
  if (!selection) return windowScope.commandScope();
  return windowScope.get(selection.nodeId);
}
