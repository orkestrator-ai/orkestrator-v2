/**
 * "Open this graph run" requests (item 213 for mock runs; item 214's Run
 * button uses it too). A launch surface asks; the graph-run view (item 211)
 * registers the listener that opens its tab. Until a listener exists the
 * request is kept (the latest one only), so a view that mounts a moment
 * later still picks it up with {@link takePendingGraphRunView}.
 */

export interface GraphRunViewRequest {
  runId: string;
  projectId: string;
  /** The environment whose pane should show the run (the run may have none: mock runs). */
  environmentId: string;
  mock: boolean;
}

type Listener = (request: GraphRunViewRequest) => void;

const listeners = new Set<Listener>();
let pending: GraphRunViewRequest | null = null;

/** Asks the run view to open a run; returns whether a listener took it. */
export function requestGraphRunView(request: GraphRunViewRequest): boolean {
  if (listeners.size === 0) {
    pending = { ...request };
    return false;
  }
  pending = null;
  for (const listener of listeners) listener({ ...request });
  return true;
}

/** Registers the run view's opener; returns the unsubscribe function. */
export function onGraphRunViewRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The request made while no listener existed, once. */
export function takePendingGraphRunView(): GraphRunViewRequest | null {
  const request = pending;
  pending = null;
  return request;
}
