/**
 * The shared model behind every workflow flow graph (Multi Review, the build
 * pipeline): one state vocabulary for nodes and edges, the default selection,
 * and the geometry helpers the renderer draws with.
 *
 * Everything here is pure. A workflow's own module decides what state each of
 * its nodes is in and where they sit; this module only says what those states
 * mean on the graph.
 */

/**
 * One state vocabulary for every node. A queued reviewer and a step that has
 * not started look the same on the graph, so both are `not-started`.
 */
export type FlowNodeState =
  | "not-started"
  | "running"
  | "paused"
  | "complete"
  | "failed"
  | "cancelling"
  | "cancelled";

/**
 * What an edge says about the work flowing along it.
 *
 * - `complete`: the source's output was consumed by a finished target.
 * - `active`: the target is working on it now.
 * - `ready`: the output exists and the target is waiting for its other inputs
 *   (a finished report before consolidation, a report before Fix).
 * - `pending`: nothing has flowed, or the source produced nothing usable.
 * - `failed`: the target failed while working on it.
 */
export type FlowEdgeState = "complete" | "active" | "ready" | "pending" | "failed";

/**
 * An edge carries its source's output, so an unfinished source flows nothing,
 * whatever the target is doing. A failed or stopped reviewer therefore never
 * lights the edge into consolidation: its report was not part of it.
 */
export function flowEdgeState(
  from: FlowNodeState,
  to: FlowNodeState,
  { waitingIsReady }: { waitingIsReady: boolean },
): FlowEdgeState {
  if (from !== "complete") return "pending";
  switch (to) {
    case "running":
      return "active";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    case "paused":
    case "not-started":
      return waitingIsReady ? "ready" : "pending";
    default:
      return "pending";
  }
}

/**
 * One connector standing for a whole group of edges, for the stacked layout
 * where reviewers share a single line in and a single line out.
 */
export function summarizeFlowEdges(edges: readonly FlowEdgeState[]): FlowEdgeState {
  for (const state of ["active", "failed", "complete", "ready"] as const) {
    if (edges.includes(state)) return state;
  }
  return "pending";
}

/**
 * The node shown in the inspector when the user has not picked one: whatever
 * is running, else what is paused, else the node that was active most
 * recently. The pipeline runs in order, so the furthest stage that has been
 * reached is the most recent; among parallel nodes the latest timestamp
 * decides, with ties going to the later node. A step that was cancelled
 * before it ever ran has not been reached.
 */
export function defaultFlowSelection(
  nodes: readonly {
    id: string;
    state: FlowNodeState;
    /** Pipeline column, left to right. */
    stage: number;
    activityAt?: number;
  }[],
): string | null {
  for (const state of ["running", "paused"] as const) {
    const match = nodes.find((node) => node.state === state);
    if (match) return match.id;
  }
  const reached = nodes.filter(
    (node) =>
      node.state !== "not-started" &&
      !(
        (node.state === "cancelled" || node.state === "cancelling") &&
        node.activityAt === undefined
      ),
  );
  if (reached.length === 0) return nodes[0]?.id ?? null;
  const stage = Math.max(...reached.map((node) => node.stage));
  let latest = reached.find((node) => node.stage === stage)!;
  for (const node of reached) {
    if (node.stage !== stage) continue;
    if ((node.activityAt ?? -Infinity) >= (latest.activityAt ?? -Infinity)) latest = node;
  }
  return latest.id;
}

/** The latest moment a timing record shows activity, or undefined if none. */
export function latestActivityAt(
  ...timings: Array<{ startedAt?: string; completedAt?: string } | undefined>
): number | undefined {
  let latest: number | undefined;
  for (const timing of timings) {
    for (const value of [timing?.startedAt, timing?.completedAt]) {
      if (!value) continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && (latest === undefined || parsed > latest)) latest = parsed;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Below this width the graph stacks into a single column. */
export const FLOW_GRAPH_STACK_BELOW = 960;
export const FLOW_GRAPH_MIN_HEIGHT = 460;
export const FLOW_NODE_HEIGHT = 64;

export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A connector from the right edge of one node to the left edge of the next: a
 * cubic bézier that leaves and arrives horizontally, or a straight line when
 * the two are level.
 */
export function flowEdgePath(from: FlowRect, to: FlowRect): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  if (y1 === y2) return `M${x1} ${y1} L${x2} ${y2}`;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

/** Route an edge above the nodes it skips, from one node to a later one. */
export function bypassEdgePath(from: FlowRect, to: FlowRect): string {
  const start = from.x + from.width;
  const y = from.y + from.height / 2;
  const endY = to.y + to.height / 2;
  const bypassY = Math.min(from.y, to.y) - 24;
  return `M${start} ${y} C${start + 24} ${y} ${start + 24} ${bypassY} ${start + 48} ${bypassY} L${to.x - 48} ${bypassY} C${to.x - 24} ${bypassY} ${to.x - 24} ${endY} ${to.x} ${endY}`;
}

/**
 * Where a laid-out graph puts its nodes and column labels. A workflow's own
 * layout function produces it from the measured width; the renderer only
 * places what it is given.
 */
export interface FlowGraphGeometry {
  width: number;
  height: number;
  /** Node rectangles by node id, in canvas coordinates. */
  rects: ReadonlyMap<string, FlowRect>;
  /** Column labels, each at the left edge of its column. */
  labels: readonly { key: string; x: number; text: string; title?: string }[];
}
