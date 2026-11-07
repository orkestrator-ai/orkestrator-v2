/**
 * "Open this graph run" requests: the one path every launch surface uses to
 * show a run it started (item 213's Mock run, item 214's launches through
 * `openLaunchedGraphRun`). A launch surface asks; the environment's terminal
 * container (the active environment's pane) answers by opening the run's
 * `graph-run` tab (item 211). A request no listener handled (no listener
 * yet, or the run's environment is not the one on screen) is kept, the
 * latest one only, and handled by that environment's container when it next
 * becomes active ({@link takePendingGraphRunView}).
 *
 * Requests are per node scope (plan item 4007): a run started in one node's
 * workspace opens in that node's pane layout, never in another node's
 * environment that happens to be on screen. Every function takes an optional
 * trailing `scope`, the app's command scope when omitted (3003's convention).
 */

import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedSlot } from "@/lib/node-scope-slots";

export interface GraphRunViewRequest {
  runId: string;
  projectId: string;
  /** The environment whose pane should show the run (the run may have none: mock runs). */
  environmentId: string;
  mock: boolean;
  /** The tab's title (the template's name). */
  title?: string;
}

/** Returns true when it opened the run (its environment is the one it serves). */
type Listener = (request: GraphRunViewRequest) => boolean | void;

/** One node's openers and its one unhandled request. */
const scopeRequests = defineScopedSlot("graph-run-view-requests", () => ({
  listeners: new Set<Listener>(),
  pending: null as GraphRunViewRequest | null,
}));

/** Asks `scope`'s run view to open a run; returns whether a listener opened it. */
export function requestGraphRunView(request: GraphRunViewRequest, scope?: NodeScope): boolean {
  const state = scopeRequests(scope);
  let handled = false;
  for (const listener of Array.from(state.listeners)) {
    if (listener({ ...request }) === true) handled = true;
  }
  state.pending = handled ? null : { ...request };
  return handled;
}

/** Registers a run view opener on `scope`; returns the unsubscribe function. */
export function onGraphRunViewRequested(listener: Listener, scope?: NodeScope): () => void {
  const { listeners } = scopeRequests(scope);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `scope`'s request no listener handled, once. With `environmentId`, only a
 * request for that environment is taken; another stays pending.
 */
export function takePendingGraphRunView(
  environmentId?: string,
  scope?: NodeScope,
): GraphRunViewRequest | null {
  const state = scopeRequests(scope);
  const request = state.pending;
  if (!request || (environmentId !== undefined && request.environmentId !== environmentId)) {
    return null;
  }
  state.pending = null;
  return request;
}
