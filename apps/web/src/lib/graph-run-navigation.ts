/**
 * "Open this graph run" requests: the one path every launch surface uses to
 * show a run it started (item 213's Mock run, item 214's launches through
 * `openLaunchedGraphRun`). A launch surface asks; the environment's terminal
 * container (the active environment's pane) answers by opening the run's
 * `graph-run` tab (item 211). A request no listener handled (no listener
 * yet, or the run's environment is not the one on screen) is kept, the
 * latest one only, and handled by that environment's container when it next
 * becomes active ({@link takePendingGraphRunView}).
 */

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

const listeners = new Set<Listener>();
let pending: GraphRunViewRequest | null = null;

/** Asks the run view to open a run; returns whether a listener opened it. */
export function requestGraphRunView(request: GraphRunViewRequest): boolean {
  let handled = false;
  for (const listener of listeners) {
    if (listener({ ...request }) === true) handled = true;
  }
  pending = handled ? null : { ...request };
  return handled;
}

/** Registers a run view opener; returns the unsubscribe function. */
export function onGraphRunViewRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The request no listener handled, once. With `environmentId`, only a
 * request for that environment is taken; another stays pending.
 */
export function takePendingGraphRunView(environmentId?: string): GraphRunViewRequest | null {
  const request = pending;
  if (!request || (environmentId !== undefined && request.environmentId !== environmentId)) {
    return null;
  }
  pending = null;
  return request;
}
