/**
 * Keeping the Linear tab current without making the user press Refresh.
 *
 * Two things went stale. The tab lives in a project view that unmounts when
 * the user switches to another project tab, so reopening it waited on a full
 * load with nothing on screen. And a node's workspace stays mounted while
 * another node is shown (`InTreeWorkspace`), so switching back showed the
 * tickets as they were when the user left, however long ago that was.
 *
 * So the tab remembers the board it last read, per node and project, and
 * paints that at once when it mounts; then it reads Linear again in the
 * background (on mount, when its node is shown again, and when the window
 * regains focus) and replaces only the tickets that changed.
 */

import { defineScopedSlot } from "@/lib/node-scope-slots";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { WindowScope } from "@/lib/node-scope/window-scope";
import { selectionOnScope } from "@/stores/windowSelectionStore";
import type {
  LinearBoardLink,
  LinearConnectionStatus,
  LinearIssueListItem,
  LinearWorkflowState,
} from "@/types/linear";

/**
 * The project's Linear board: `unsupported` is a node from before board
 * links, which lists every issue the key can see, as it always did.
 */
export type LinearBoardState = "unknown" | "linked" | "unlinked" | "unsupported";

/** What the tab last read for one project, to paint before the next read lands. */
export interface LinearBoardSnapshot {
  readonly connection: LinearConnectionStatus;
  readonly boardLink: LinearBoardLink | null;
  readonly boardState: LinearBoardState;
  readonly issues: readonly LinearIssueListItem[];
  readonly boardStates: readonly LinearWorkflowState[];
}

/** Projects remembered per node; the least recently read goes first. */
export const LINEAR_BOARD_SNAPSHOT_LIMIT = 12;

/**
 * The shortest gap between two refreshes the window's focus starts, so
 * focusing and the visibility change that comes with it read Linear once.
 */
export const LINEAR_FOCUS_REFRESH_INTERVAL_MS = 10_000;

const snapshots = defineScopedSlot(
  "linear-board-snapshots",
  () => new Map<string, LinearBoardSnapshot>(),
);

export function readLinearBoardSnapshot(
  scope: NodeScope,
  projectId: string,
): LinearBoardSnapshot | undefined {
  return snapshots(scope).get(projectId);
}

export function rememberLinearBoardSnapshot(
  scope: NodeScope,
  projectId: string,
  snapshot: LinearBoardSnapshot,
): void {
  const map = snapshots(scope);
  // Re-inserting moves the project to the newest end.
  map.delete(projectId);
  map.set(projectId, snapshot);
  while (map.size > LINEAR_BOARD_SNAPSHOT_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Forgets one project's board, or every project's on `scope` when none is named. */
export function forgetLinearBoardSnapshot(scope: NodeScope, projectId?: string): void {
  if (projectId === undefined) snapshots(scope).clear();
  else snapshots(scope).delete(projectId);
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `next`, keeping each item of `current` that did not change (same `key`,
 * same content), and `current` itself when nothing changed at all. A
 * background read that finds nothing new then renders nothing new, and one
 * that finds a relabelled ticket redraws only that ticket.
 */
export function reconcileByKey<T>(
  current: readonly T[],
  next: readonly T[],
  key: (item: T) => string,
): T[] {
  const previous = new Map(current.map((item) => [key(item), item]));
  let changed = current.length !== next.length;
  const merged = next.map((item, index) => {
    const before = previous.get(key(item));
    if (before !== undefined && sameJson(before, item)) {
      if (current[index] !== before) changed = true;
      return before;
    }
    changed = true;
    return item;
  });
  return changed ? merged : (current as T[]);
}

/**
 * Whether the window shows `scope`'s node. A window with no selection shows
 * its command node.
 */
export function isNodeShown(scope: NodeScope, windowScope: WindowScope): boolean {
  const selection = windowScope.selection.get();
  if (selection === null) return scope.role === "command";
  return selectionOnScope(scope, selection) !== null;
}

/**
 * Calls `refresh` when the user comes back to the board without it
 * remounting: its node is shown again after another node was, or the window
 * regains focus (at most once per `LINEAR_FOCUS_REFRESH_INTERVAL_MS`) while
 * the node is shown. Returns the stop, which the caller's effect cleanup calls.
 */
export function watchLinearBoardReturns(
  scope: NodeScope,
  windowScope: WindowScope,
  refresh: () => void,
  now: () => number = Date.now,
): () => void {
  let shown = isNodeShown(scope, windowScope);
  let lastRefresh = now();
  const run = () => {
    lastRefresh = now();
    refresh();
  };
  const stopSelection = windowScope.selection.subscribe(() => {
    const shownNow = isNodeShown(scope, windowScope);
    const returned = shownNow && !shown;
    shown = shownNow;
    if (returned) run();
  });
  const onReturn = () => {
    if (!shown || document.visibilityState === "hidden") return;
    if (now() - lastRefresh < LINEAR_FOCUS_REFRESH_INTERVAL_MS) return;
    run();
  };
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", onReturn);
  return () => {
    stopSelection();
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
  };
}
