/**
 * A graph run as a flow graph (plan P2.11, report §7.7): one generic
 * projection, `graphRunFlowModel(plan, run)`, over the shared `flow-graph/`
 * renderer (D16), in place of a projection per workflow.
 *
 * Everything here is a pure reading of the run's frozen plan and its
 * activations; nothing comes from a transcript or from view state other than
 * which previous attempts the reader expanded.
 *
 * - Each node position is one flow node: a plan node at one loop iteration
 *   and, for a replicated node, one branch. Its face shows the newest live
 *   attempt; retries of the position stay readable in the inspector.
 * - Columns are the longest path through the positions, so a node sits to
 *   the right of everything it consumes. The branches of one replicated
 *   activation share a column (an `items` node's once it expanded, one per
 *   item, with the fan-out's truncation on each; item 401), and each loop
 *   iteration unrolls to the right of the one before (a loop carry feeds the
 *   next iteration).
 * - Positions not reached yet are drawn faded ahead of the work, the next
 *   loop iteration only once it is entered.
 * - A gate shows the outlet it took; edges out of the outlets it did not take
 *   stay pending, and the nodes behind them show as skipped.
 * - A node an agent paused on `ask_human`, or a human node, is highlighted as
 *   waiting for the user.
 * - Activations a restart or retry superseded collapse into one "Previous
 *   attempt" node per rewind, in the column of the node the rewind restarted;
 *   expanded, its activations follow it in their own columns, greyed.
 */
import type {
  CompiledGraphPlan,
  GraphPlanEdge,
  GraphPlanNode,
} from "@orkestrator/protocol/graphs/compile";
import {
  graphActivationSlot,
  graphLiveItemFanOut,
  graphRunNodeBranches,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphNodeKind } from "@orkestrator/protocol/graphs/template";
import {
  flowEdgeState,
  latestActivityAt,
  type FlowEdgeState,
  type FlowNodeState,
} from "@/components/flow-graph/flow-graph-model";

export type GraphRunFlowNodeKind = "position" | "inputs" | "attempt" | "superseded";

export interface GraphRunFlowNode {
  /**
   * Stable across snapshots: the position's slot (`node#iter=…[#branch=…]`),
   * {@link GRAPH_RUN_INPUTS_NODE_ID}, `attempt:<rewind id>`, or a superseded
   * activation's key.
   */
  id: string;
  kind: GraphRunFlowNodeKind;
  /** The plan node's kind, for positions and superseded activations. */
  nodeKind?: GraphNodeKind;
  nodeId?: string;
  iteration?: number;
  branchKey?: string;
  title: string;
  state: FlowNodeState;
  /** Not reached yet: drawn faded. */
  placeholder: boolean;
  /** The runtime skipped it (a `when`, an outlet not taken, an absent input) or the user did. */
  skipped: boolean;
  /** An agent's `ask_human` question or a human node waits for the user. */
  waitingForHuman: boolean;
  /** Gate and human nodes: the outlet the activation took. */
  outlet?: string;
  /** The newest live activation of the position (or the superseded activation shown). */
  activation?: NodeActivation;
  /** Every live attempt of the position, oldest first (retries). */
  attempts: NodeActivation[];
  error?: string;
  /** Activity time, for the default selection. */
  activityAt?: number;
  /**
   * An `items` node position's fan-out (item 401): the items that run and the
   * input's total; more in `total` than `running` means items were truncated.
   */
  fanOut?: { running: number; total: number };
  /** An `items` branch: its item's 1-based index and stable id. */
  item?: { index: number; id: string };
  /** History a rewind replaced: kept readable, drawn greyed, out of the live run. */
  superseded?: boolean;
  /** The rewind a previous-attempt node (or a superseded activation) belongs to. */
  attemptId?: string;
  /** On a previous-attempt node: the activations it holds, in record order. */
  attemptActivationKeys?: string[];
  /** On a previous-attempt node: whether its activations are shown. */
  attemptExpanded?: boolean;
}

export interface GraphRunFlowColumn {
  key: string;
  label: string;
  nodeIds: string[];
}

export interface GraphRunFlowEdge {
  id: string;
  from: string;
  to: string;
  state: FlowEdgeState;
  /** Out of a gate or human outlet the activation did not take. */
  untaken?: boolean;
}

export interface GraphRunFlowModel {
  nodes: GraphRunFlowNode[];
  columns: GraphRunFlowColumn[];
  edges: GraphRunFlowEdge[];
}

export interface GraphRunFlowOptions {
  /** Previous attempts (rewind ids) shown activation by activation; the rest are one node. */
  expandedAttempts?: ReadonlySet<string>;
}

/** Prefixed so no slot can collide with it. */
export const GRAPH_RUN_INPUTS_NODE_ID = "flow:inputs";
export const GRAPH_RUN_ATTEMPT_PREFIX = "attempt:";
/** Superseded activations no rewind names (should not happen; kept readable anyway). */
const UNNAMED_ATTEMPT = "earlier";

const TERMINAL_RUN = new Set(["complete", "failed", "cancelled"]);

/** "panel.2+lens.security" → "Panel 2 · security". */
export function graphBranchLabel(branchKey: string): string {
  return branchKey
    .split("+")
    .map((part) => {
      const [axis, ...rest] = part.split(".");
      const value = rest.join(".");
      if (axis === "panel") return `Panel ${value}`;
      if (axis === "sample") return `Sample ${value}`;
      if (axis === "lens") return value;
      // An `items` branch key encodes its item's id (`/` as `:`; item 401).
      if (axis === "item") return `Item ${value.replaceAll(":", "/")}`;
      return part;
    })
    .join(" · ");
}

/** An `items` fan-out that ran fewer branches than its input held items (item 401). */
export function graphRunTruncationText(fanOut: { running: number; total: number }): string {
  return `${fanOut.running} of ${fanOut.total} items run; ${fanOut.total - fanOut.running} truncated`;
}

export function graphPlanNodeTitle(node: Pick<GraphPlanNode, "id" | "label">): string {
  return node.label?.trim() || node.id;
}

/** How an activation's state reads on the graph. */
export function graphActivationFlowState(
  activation: NodeActivation | undefined,
  run: Pick<GraphRun, "status">,
): FlowNodeState {
  if (!activation) return "not-started";
  switch (activation.state) {
    case "waiting":
    case "ready":
      return "not-started";
    case "admitting":
    case "running":
      return run.status === "cancelling" ? "cancelling" : "running";
    case "awaiting-human":
      return run.status === "cancelling" ? "cancelling" : "paused";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    case "skipped":
    case "cancelled":
    case "superseded":
      return "cancelled";
  }
}

interface Position {
  slot: string;
  node: GraphPlanNode;
  iteration: number;
  branchKey?: string;
  /** Live attempts, oldest first. */
  attempts: NodeActivation[];
}

/** `node#iter` — the column unit: every branch of one activation shares it. */
function groupKey(nodeId: string, iteration: number): string {
  return `${nodeId}#iter=${iteration}`;
}

function plannedBranchKeys(
  node: GraphPlanNode,
  run: GraphRun,
  iteration: number,
): (string | undefined)[] {
  try {
    // An `items` node has branches once its position expanded (item 401).
    const branches = graphRunNodeBranches(run, node, iteration);
    if (!branches) return [undefined];
    return branches.length > 0 ? branches.map((branch) => branch.key) : [undefined];
  } catch {
    // Bindings that no longer build branches (a retained record) show one position.
    return [undefined];
  }
}

/**
 * The iterations each loop is drawn for: up to the one it is on, or the
 * newest an activation reached (a rewind may have moved the counter back).
 */
function loopIterations(plan: CompiledGraphPlan, run: GraphRun): Map<string, number> {
  const loops = new Map<string, number>();
  for (const loop of plan.loops) loops.set(loop.id, Math.max(1, run.loopIterations[loop.id] ?? 1));
  const loopOf = new Map(plan.nodes.map((node) => [node.id, node.loop] as const));
  for (const activation of run.activations) {
    if (activation.state === "superseded") continue;
    const loop = loopOf.get(activation.nodeId);
    if (loop && activation.iteration > (loops.get(loop) ?? 1)) {
      loops.set(loop, activation.iteration);
    }
  }
  return loops;
}

/** Iterations an edge delivers at its consumer, given the consumer's drawn iterations. */
function edgeIterationAllowed(edge: GraphPlanEdge, iteration: number): boolean {
  if (edge.iterations === "first") return iteration === 1;
  if (edge.iterations === "later") return iteration > 1;
  return true;
}

export function graphRunFlowModel(
  plan: CompiledGraphPlan,
  run: GraphRun,
  options: GraphRunFlowOptions = {},
): GraphRunFlowModel {
  const nodesById = new Map(plan.nodes.map((node) => [node.id, node] as const));
  const iterations = loopIterations(plan, run);
  const iterationsOf = (node: GraphPlanNode) => (node.loop ? (iterations.get(node.loop) ?? 1) : 1);
  const terminal = TERMINAL_RUN.has(run.status);

  // ---- positions: live attempts by slot, then the planned ones not reached.
  const live = new Map<string, NodeActivation[]>();
  for (const activation of run.activations) {
    if (activation.state === "superseded") continue;
    const slot = graphActivationSlot(activation);
    const list = live.get(slot);
    if (list) list.push(activation);
    else live.set(slot, [activation]);
  }
  /** Group (node, iteration) → the live slots of that group. */
  const liveByGroup = new Map<string, [string, NodeActivation[]][]>();
  for (const [slot, list] of live) {
    list.sort((left, right) => left.attempt - right.attempt);
    const key = groupKey(list[0]!.nodeId, list[0]!.iteration);
    const entries = liveByGroup.get(key);
    if (entries) entries.push([slot, list]);
    else liveByGroup.set(key, [[slot, list]]);
  }

  const positions = new Map<string, Position>();
  /** Group (node, iteration) → its positions' slots, in branch order. */
  const groups = new Map<string, string[]>();
  const addPosition = (node: GraphPlanNode, iteration: number, branchKey: string | undefined) => {
    const slot = graphActivationSlot({
      nodeId: node.id,
      iteration,
      ...(branchKey !== undefined ? { branchKey } : {}),
    });
    if (positions.has(slot)) return;
    positions.set(slot, {
      slot,
      node,
      iteration,
      ...(branchKey !== undefined ? { branchKey } : {}),
      attempts: live.get(slot) ?? [],
    });
    const group = groupKey(node.id, iteration);
    const slots = groups.get(group);
    if (slots) slots.push(slot);
    else groups.set(group, [slot]);
  };
  for (const nodeId of plan.order) {
    const node = nodesById.get(nodeId);
    if (!node) continue;
    for (let iteration = 1; iteration <= iterationsOf(node); iteration++) {
      // The branches the bindings name, in plan order, then any that ran
      // without being named (a binding changed under a retained record).
      const reached = liveByGroup.get(groupKey(node.id, iteration)) ?? [];
      const planned = plannedBranchKeys(node, run, iteration);
      // A replicated node whose branches only exist once it runs (`items`)
      // has no planned key worth a placeholder beside the ones that ran.
      const unknownBranches = planned.length === 1 && planned[0] === undefined;
      const replicated = (node.kind === "agent" || node.kind === "subgraph") && node.replicate;
      if (!(replicated && unknownBranches && reached.length > 0)) {
        for (const key of planned) addPosition(node, iteration, key);
      }
      for (const [slot, attempts] of reached) {
        if (!positions.has(slot)) addPosition(node, iteration, attempts[0]!.branchKey);
      }
    }
  }

  // ---- group edges: who feeds whom, for the columns and the drawn edges.
  interface GroupEdge {
    id: string;
    from: { node: string; iteration: number } | "inputs";
    to: { node: string; iteration: number };
    outlet?: string;
    zip: boolean;
  }
  const groupEdges: GroupEdge[] = [];
  const hasInputs = plan.inputs.length > 0;
  for (const edge of plan.edges) {
    const target = nodesById.get(edge.to.node);
    if (!target) continue;
    for (let iteration = 1; iteration <= iterationsOf(target); iteration++) {
      if (!edgeIterationAllowed(edge, iteration)) continue;
      if ("input" in edge.from) {
        if (hasInputs) {
          groupEdges.push({
            id: `${edge.id}@${iteration}`,
            from: "inputs",
            to: { node: target.id, iteration },
            zip: false,
          });
        }
        continue;
      }
      const source = nodesById.get(edge.from.node);
      if (!source) continue;
      let fromIteration: number;
      if (source.loop && source.loop === target.loop) fromIteration = iteration;
      else if (source.loop) fromIteration = iterationsOf(source);
      else fromIteration = 1;
      if (fromIteration < 1 || fromIteration > iterationsOf(source)) continue;
      groupEdges.push({
        id: `${edge.id}@${iteration}`,
        from: { node: source.id, iteration: fromIteration },
        to: { node: target.id, iteration },
        ...(edge.from.outlet !== undefined ? { outlet: edge.from.outlet } : {}),
        zip: edge.zip,
      });
    }
  }
  for (const loop of plan.loops) {
    const count = iterations.get(loop.id) ?? 1;
    loop.carry.forEach((carry, index) => {
      for (let iteration = 2; iteration <= count; iteration++) {
        groupEdges.push({
          id: `${loop.id}#carry${index}@${iteration}`,
          from: { node: carry.from.node, iteration: iteration - 1 },
          to: { node: carry.to.node, iteration },
          zip: false,
        });
      }
    });
  }

  // ---- columns: longest path over the groups (they form a DAG: edges run
  // forward in plan order within an iteration, and carries to the next one).
  const depth = new Map<string, number>();
  const orderIndex = new Map(plan.order.map((id, index) => [id, index] as const));
  const inputsDepth = hasInputs ? 0 : -1;
  const groupOrder = [...groups.keys()].sort((left, right) => {
    const [leftNode, leftIteration] = splitGroup(left);
    const [rightNode, rightIteration] = splitGroup(right);
    const leftLoop = nodesById.get(leftNode)?.loop;
    const rightLoop = nodesById.get(rightNode)?.loop;
    if (leftLoop && leftLoop === rightLoop && leftIteration !== rightIteration) {
      return leftIteration - rightIteration;
    }
    return (orderIndex.get(leftNode) ?? 0) - (orderIndex.get(rightNode) ?? 0);
  });
  const incoming = new Map<string, GroupEdge[]>();
  for (const edge of groupEdges) {
    const key = groupKey(edge.to.node, edge.to.iteration);
    const list = incoming.get(key);
    if (list) list.push(edge);
    else incoming.set(key, [edge]);
  }
  // Relax to a fixpoint; bounded by the group count (a cycle cannot occur, but
  // a malformed plan must not hang the view).
  for (let round = 0; round <= groupOrder.length; round++) {
    let changed = false;
    for (const group of groupOrder) {
      let value = inputsDepth + 1;
      for (const edge of incoming.get(group) ?? []) {
        const from =
          edge.from === "inputs"
            ? inputsDepth
            : (depth.get(groupKey(edge.from.node, edge.from.iteration)) ?? 0);
        value = Math.max(value, from + 1);
      }
      if (depth.get(group) !== value) {
        depth.set(group, value);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ---- flow nodes.
  const flowNodes: GraphRunFlowNode[] = [];
  const byId = new Map<string, GraphRunFlowNode>();
  const columnOf = new Map<string, number>();
  const push = (node: GraphRunFlowNode, column: number) => {
    flowNodes.push(node);
    byId.set(node.id, node);
    columnOf.set(node.id, column);
  };

  if (hasInputs) {
    const given = Object.keys(run.bindings.inputs).length;
    push(
      {
        id: GRAPH_RUN_INPUTS_NODE_ID,
        kind: "inputs",
        title: "Inputs",
        state: given > 0 || run.status !== "provisioning" ? "complete" : "not-started",
        placeholder: false,
        skipped: false,
        waitingForHuman: false,
        attempts: [],
        activityAt: latestActivityAt({ startedAt: run.createdAt }),
      },
      0,
    );
  }

  for (const group of groupOrder) {
    const column = depth.get(group) ?? 0;
    for (const slot of groups.get(group) ?? []) {
      const position = positions.get(slot)!;
      const latest = position.attempts[position.attempts.length - 1];
      const fanOut = graphLiveItemFanOut(run, position.node.id, position.iteration);
      const item =
        position.branchKey !== undefined
          ? fanOut?.items.find((entry) => position.branchKey!.split("+").includes(entry.key))
          : undefined;
      const title =
        position.branchKey !== undefined
          ? `${graphPlanNodeTitle(position.node)} · ${graphBranchLabel(position.branchKey)}`
          : graphPlanNodeTitle(position.node);
      push(
        {
          id: slot,
          kind: "position",
          nodeKind: position.node.kind,
          nodeId: position.node.id,
          iteration: position.iteration,
          ...(position.branchKey !== undefined ? { branchKey: position.branchKey } : {}),
          title,
          ...(fanOut ? { fanOut: { running: fanOut.items.length, total: fanOut.total } } : {}),
          ...(item ? { item: { index: item.index, id: item.id } } : {}),
          state: graphActivationFlowState(latest, run),
          // Not reached: faded ahead of the work, or left behind by a finished run.
          placeholder:
            !latest || ((latest.state === "waiting" || latest.state === "ready") && terminal),
          skipped: latest?.state === "skipped",
          waitingForHuman: latest?.state === "awaiting-human" && run.status !== "cancelling",
          ...(latest?.outlet !== undefined ? { outlet: latest.outlet } : {}),
          ...(latest ? { activation: latest } : {}),
          attempts: position.attempts,
          ...(latest?.error ? { error: latest.error } : {}),
          ...(latest
            ? {
                activityAt: latestActivityAt({
                  startedAt: latest.startedAt,
                  completedAt: latest.finishedAt,
                }),
              }
            : {}),
        },
        column,
      );
    }
  }

  // ---- previous attempts: one node per rewind, in the restarted node's column.
  const supersededByAttempt = new Map<string, NodeActivation[]>();
  for (const activation of run.activations) {
    if (activation.state !== "superseded") continue;
    const id = activation.supersededBy ?? UNNAMED_ATTEMPT;
    const list = supersededByAttempt.get(id);
    if (list) list.push(activation);
    else supersededByAttempt.set(id, [activation]);
  }
  const rewindOrder = new Map(run.rewinds.map((rewind, index) => [rewind.id, index] as const));
  const attemptIds = [...supersededByAttempt.keys()].sort(
    (left, right) =>
      (rewindOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (rewindOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
  const columnOfActivation = (activation: NodeActivation) =>
    depth.get(groupKey(activation.nodeId, activation.iteration)) ?? 0;
  for (const attemptId of attemptIds) {
    const activations = supersededByAttempt.get(attemptId)!;
    const rewind = run.rewinds.find((entry) => entry.id === attemptId);
    const root =
      activations.find((activation) => activation.key === rewind?.activation) ?? activations[0]!;
    const expanded = options.expandedAttempts?.has(attemptId) ?? false;
    const id = `${GRAPH_RUN_ATTEMPT_PREFIX}${attemptId}`;
    push(
      {
        id,
        kind: "attempt",
        title: "Previous attempt",
        state: "cancelled",
        placeholder: false,
        skipped: false,
        waitingForHuman: false,
        attempts: [],
        superseded: true,
        attemptId,
        attemptActivationKeys: activations.map((activation) => activation.key),
        attemptExpanded: expanded,
        activityAt: latestActivityAt(
          ...activations.map((activation) => ({
            startedAt: activation.startedAt,
            completedAt: activation.finishedAt,
          })),
        ),
      },
      columnOfActivation(root),
    );
    if (!expanded) continue;
    for (const activation of activations) {
      const node = nodesById.get(activation.nodeId);
      const base = node ? graphPlanNodeTitle(node) : activation.nodeId;
      push(
        {
          id: activation.key,
          kind: "superseded",
          ...(node ? { nodeKind: node.kind } : {}),
          nodeId: activation.nodeId,
          iteration: activation.iteration,
          ...(activation.branchKey !== undefined ? { branchKey: activation.branchKey } : {}),
          title:
            activation.branchKey !== undefined
              ? `${base} · ${graphBranchLabel(activation.branchKey)}`
              : base,
          // What it had reached before the rewind: the record keeps only `superseded`.
          state: activation.finishedAt
            ? activation.error
              ? "failed"
              : "complete"
            : activation.startedAt
              ? "cancelled"
              : "not-started",
          placeholder: false,
          skipped: false,
          waitingForHuman: false,
          ...(activation.outlet !== undefined ? { outlet: activation.outlet } : {}),
          activation,
          attempts: [activation],
          ...(activation.error ? { error: activation.error } : {}),
          superseded: true,
          attemptId,
          activityAt: latestActivityAt({
            startedAt: activation.startedAt,
            completedAt: activation.finishedAt,
          }),
        },
        columnOfActivation(activation),
      );
    }
  }

  // ---- edges between positions.
  const edges: GraphRunFlowEdge[] = [];
  const seenEdges = new Set<string>();
  for (const edge of groupEdges) {
    const toSlots = groups.get(groupKey(edge.to.node, edge.to.iteration)) ?? [];
    const fromSlots =
      edge.from === "inputs"
        ? [GRAPH_RUN_INPUTS_NODE_ID]
        : (groups.get(groupKey(edge.from.node, edge.from.iteration)) ?? []);
    for (const from of fromSlots) {
      for (const to of toSlots) {
        const source = byId.get(from);
        const target = byId.get(to);
        if (!source || !target) continue;
        if (edge.zip && source.branchKey !== target.branchKey) continue;
        const pair = `${from}\u0000${to}`;
        const untaken =
          edge.outlet !== undefined &&
          source.outlet !== undefined &&
          source.state === "complete" &&
          source.outlet !== edge.outlet;
        if (seenEdges.has(pair)) {
          // Two ports between the same pair: one line, taken if either is.
          if (!untaken) {
            const existing = edges.find((candidate) => candidate.id === `edge:${pair}`);
            if (existing?.untaken) {
              delete existing.untaken;
              existing.state = flowEdgeState(source.state, target.state, { waitingIsReady: true });
            }
          }
          continue;
        }
        seenEdges.add(pair);
        edges.push({
          id: `edge:${pair}`,
          from,
          to,
          state: untaken
            ? "pending"
            : flowEdgeState(source.state, target.state, { waitingIsReady: true }),
          ...(untaken ? { untaken: true } : {}),
        });
      }
    }
  }

  // ---- columns, left to right; empty depths are dropped.
  const depths = [...new Set(columnOf.values())].sort((left, right) => left - right);
  const columns: GraphRunFlowColumn[] = depths.map((value) => {
    const nodeIds = flowNodes
      .filter((node) => columnOf.get(node.id) === value)
      .map((node) => node.id);
    return {
      key: `column-${value}`,
      label: columnLabel(
        nodeIds.map((id) => byId.get(id)!),
        plan,
        iterations,
      ),
      nodeIds,
    };
  });
  // Nodes in column order (the order the arrow keys walk).
  const ordered = columns.flatMap((column) => column.nodeIds.map((id) => byId.get(id)!));
  return { nodes: ordered, columns, edges };
}

function splitGroup(group: string): [string, number] {
  const separator = group.lastIndexOf("#iter=");
  return [group.slice(0, separator), Number(group.slice(separator + "#iter=".length))];
}

/**
 * A column's heading: the plan nodes it holds, with the round of a loop drawn
 * more than once ("Review 2"), and progress over a replicated node's branches.
 */
function columnLabel(
  nodes: readonly GraphRunFlowNode[],
  plan: CompiledGraphPlan,
  iterations: ReadonlyMap<string, number>,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "inputs") {
      if (!seen.has("inputs")) parts.push("Inputs");
      seen.add("inputs");
      continue;
    }
    if (node.kind === "attempt" || node.kind === "superseded" || !node.nodeId) continue;
    const key = `${node.nodeId}#${node.iteration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const planNode = plan.nodes.find((candidate) => candidate.id === node.nodeId);
    let label = planNode ? graphPlanNodeTitle(planNode) : node.nodeId;
    if (planNode?.loop && (iterations.get(planNode.loop) ?? 1) > 1) {
      label = `${label} ${node.iteration}`;
    }
    const branches = nodes.filter(
      (candidate) =>
        candidate.kind === "position" &&
        candidate.nodeId === node.nodeId &&
        candidate.iteration === node.iteration,
    );
    if (node.branchKey !== undefined && branches.length > 1) {
      const done = branches.filter((candidate) => candidate.state === "complete").length;
      label = `${label} · ${done}/${branches.length}`;
    }
    parts.push(label);
  }
  if (parts.length === 0)
    return nodes.some((node) => node.kind === "attempt") ? "Previous attempt" : "";
  return parts.length > 2
    ? `${parts.slice(0, 2).join(" · ")} +${parts.length - 2}`
    : parts.join(" · ");
}
