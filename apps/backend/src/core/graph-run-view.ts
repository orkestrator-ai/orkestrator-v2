/**
 * An indexed, read-only view of one graph run for the scheduler's pure
 * functions (plan P2.3): plan lookups, replication branches, the latest live
 * activation of each node position, loop iterations, and the value cache the
 * pass fills for `when` and `until`.
 *
 * Built once per planning round from the record; nothing here mutates the
 * run. `add` records an activation the round just created so downstream
 * nodes see it in the same round (a skip propagates in one pass).
 *
 * An `items` node's branches exist once it expanded: the view reads the
 * run's fan-out records and those the round adds (item 401), so a
 * position's branch set is {@link GraphRunView.branchesAt} per iteration.
 *
 * Artifacts the runtime itself makes (an edge's transformed values, a routed
 * failure's `error@1`; item 206) are asked for through {@link
 * GraphRunView.requests} and remembered in the pass's {@link
 * GraphArtifactOutcomes}, keyed by what they are made from, so planning
 * stays pure and the pass does the storing between planning calls.
 */
import type {
  CompiledGraphPlan,
  GraphPlanEdge,
  GraphPlanInputPort,
  GraphPlanLoop,
  GraphPlanLoopCarry,
  GraphPlanNode,
} from "@orkestrator/protocol/graphs/compile";
import {
  graphActivationSlot,
  graphNodeBranches,
  graphNodeItemsAxis,
  type GraphArtifactProducer,
  type GraphBranch,
  type GraphItemFanOut,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  GraphTypeLibrary,
  type GraphErrorCause,
  type GraphTypeDefinition,
} from "@orkestrator/protocol/graphs/types";

/**
 * What planning knows of an artifact besides its value (item 401): enough to
 * derive its items' ids and the upstream item it stands for.
 */
export interface GraphLoadedArtifact {
  type: string;
  producer: GraphArtifactProducer;
  itemIds?: readonly string[];
  sourceItem?: string;
}

/** A loaded artifact value (`undefined` value when it could not be read), with its envelope facts. */
export interface GraphLoadedValue {
  value: unknown;
  artifact?: GraphLoadedArtifact;
}

/** Loaded artifact values by id. */
export type GraphValueCache = ReadonlyMap<string, GraphLoadedValue>;

/** Value artifacts planning asks the pass to store (one request, one or more values). */
export interface GraphArtifactRequest {
  /** The outcome key: what the artifacts are made from. */
  key: string;
  purpose: "delivery" | "error";
  producer: GraphArtifactProducer;
  /** A non-list type reference of the run's plan. */
  type: string;
  values: unknown[];
  /** Lineage: the artifact ids the values were made from. */
  inputs: string[];
  /** Per value, the upstream item it stands for (item 401), parallel to `values`. */
  sourceItems?: (string | undefined)[];
  /** Deliveries: the edge and input port, for a failure message. */
  edgeId?: string;
  port?: string;
}

/** What became of a request (or a delivery decided without one), by key. */
export type GraphArtifactOutcome =
  { ok: true; ids: string[] } | { ok: false; message: string; cause: GraphErrorCause };

/** Outcomes the pass keeps for its planning calls (mutable; planning memoises into it). */
export type GraphArtifactOutcomes = Map<string, GraphArtifactOutcome>;

function position(nodeId: string, iteration: number): string {
  return `${nodeId}#iter=${iteration}`;
}

export class GraphRunView {
  readonly plan: CompiledGraphPlan;
  private readonly nodes = new Map<string, GraphPlanNode>();
  private readonly edges = new Map<string, GraphPlanEdge>();
  private readonly loops = new Map<string, GraphPlanLoop>();
  /** `node#iter` → the position's branches (`items` nodes differ per iteration). */
  private readonly branches = new Map<string, GraphBranch[] | null>();
  /** `node#iter` → the live `items` fan-out of the position (item 401). */
  private readonly fanOuts = new Map<string, GraphItemFanOut>();
  /** Slot → latest live (not superseded) activation. */
  private readonly latest = new Map<string, NodeActivation>();
  /** Slot → live activations (retries count against `retry.attempts`). */
  private readonly liveCount = new Map<string, number>();
  /** Slot → highest attempt ever used, superseded included. */
  private readonly maxAttempt = new Map<string, number>();
  private library: GraphTypeLibrary | undefined;

  /** Artifacts this round asked the pass to store, by outcome key. */
  readonly requests = new Map<string, GraphArtifactRequest>();
  /** Artifact values this round needs loaded (edge deliveries). */
  readonly missingValues = new Set<string>();

  constructor(
    readonly run: GraphRun,
    readonly values: GraphValueCache = new Map(),
    readonly outcomes: GraphArtifactOutcomes = new Map(),
  ) {
    this.plan = run.plan;
    for (const node of run.plan.nodes) this.nodes.set(node.id, node);
    for (const edge of run.plan.edges) this.edges.set(edge.id, edge);
    for (const loop of run.plan.loops) this.loops.set(loop.id, loop);
    for (const activation of run.activations) this.index(activation);
    for (const fanOut of run.fanOuts ?? []) {
      if (fanOut.supersededBy === undefined) {
        this.fanOuts.set(position(fanOut.nodeId, fanOut.iteration), fanOut);
      }
    }
  }

  private index(activation: NodeActivation): void {
    const slot = graphActivationSlot(activation);
    this.maxAttempt.set(slot, Math.max(this.maxAttempt.get(slot) ?? 0, activation.attempt));
    if (activation.state === "superseded") return;
    this.liveCount.set(slot, (this.liveCount.get(slot) ?? 0) + 1);
    const current = this.latest.get(slot);
    if (!current || activation.attempt > current.attempt) this.latest.set(slot, activation);
  }

  /** Records an activation created in this round. */
  add(activation: NodeActivation): void {
    this.index(activation);
  }

  node(id: string): GraphPlanNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error("The plan has no such node");
    return node;
  }

  edge(id: string): GraphPlanEdge {
    const edge = this.edges.get(id);
    if (!edge) throw new Error("The plan has no such edge");
    return edge;
  }

  loop(id: string): GraphPlanLoop {
    const loop = this.loops.get(id);
    if (!loop) throw new Error("The plan has no such loop");
    return loop;
  }

  /** `<loopId>#<index>` → the carry. */
  carry(id: string): { loop: GraphPlanLoop; carry: GraphPlanLoopCarry } {
    const separator = id.lastIndexOf("#");
    const loop = this.loop(id.slice(0, separator));
    const carry = loop.carry[Number(id.slice(separator + 1))];
    if (!carry) throw new Error("The plan has no such carry");
    return { loop, carry };
  }

  /** A named, non-list type of the plan, or undefined. */
  typeDefinition(ref: string): GraphTypeDefinition | undefined {
    this.library ??= new GraphTypeLibrary(this.plan.types);
    const resolution = this.library.resolve(ref);
    return resolution.ok && resolution.type.kind === "named"
      ? resolution.type.definition
      : undefined;
  }

  inputPort(nodeId: string, port: string): GraphPlanInputPort | undefined {
    return this.node(nodeId).inputs.find((input) => input.name === port);
  }

  /** Records an `items` fan-out created in this round (item 401). */
  addFanOut(fanOut: GraphItemFanOut): void {
    const key = position(fanOut.nodeId, fanOut.iteration);
    this.fanOuts.set(key, fanOut);
    this.branches.delete(key);
  }

  /** The live `items` fan-out of a node position, if it expanded. */
  fanOutAt(nodeId: string, iteration: number): GraphItemFanOut | undefined {
    return this.fanOuts.get(position(nodeId, iteration));
  }

  /**
   * The node's branches at one position, or null when the position is one
   * unbranched activation: an unreplicated node, or an `items` node that has
   * not expanded, or expanded to no items (item 401).
   */
  branchesAt(node: GraphPlanNode, iteration: number): GraphBranch[] | null {
    const items = graphNodeItemsAxis(node) !== undefined;
    const key = items ? position(node.id, iteration) : node.id;
    if (!this.branches.has(key)) {
      let branches: GraphBranch[] | null;
      if (items) {
        const fanOut = this.fanOutAt(node.id, iteration);
        branches =
          fanOut && fanOut.items.length > 0
            ? graphNodeBranches(node, this.run.bindings.roles, fanOut.items)
            : null;
      } else {
        branches = graphNodeBranches(node, this.run.bindings.roles);
      }
      this.branches.set(key, branches);
    }
    return this.branches.get(key)!;
  }

  /** Branch keys of a node position; `[undefined]` for one unbranched activation. */
  branchKeysAt(node: GraphPlanNode, iteration: number): (string | undefined)[] {
    const branches = this.branchesAt(node, iteration);
    return branches ? branches.map((branch) => branch.key) : [undefined];
  }

  /** One branch of a node position. */
  branchAt(node: GraphPlanNode, iteration: number, branchKey: string): GraphBranch | undefined {
    return this.branchesAt(node, iteration)?.find((branch) => branch.key === branchKey);
  }

  /** The loop's current 1-based iteration. */
  iteration(loopId: string): number {
    return this.run.loopIterations[loopId] ?? 1;
  }

  /** The iteration a node is on: its loop's, or 1 outside loops. */
  nodeIteration(node: GraphPlanNode): number {
    return node.loop ? this.iteration(node.loop) : 1;
  }

  latestAt(nodeId: string, iteration: number, branchKey?: string): NodeActivation | undefined {
    return this.latest.get(graphActivationSlot({ nodeId, iteration, branchKey }));
  }

  liveAttempts(activation: Pick<NodeActivation, "nodeId" | "iteration" | "branchKey">): number {
    return this.liveCount.get(graphActivationSlot(activation)) ?? 0;
  }

  nextAttempt(nodeId: string, iteration: number, branchKey?: string): number {
    return (this.maxAttempt.get(graphActivationSlot({ nodeId, iteration, branchKey })) ?? 0) + 1;
  }

  /** Every latest live activation, one per slot. */
  latestActivations(): NodeActivation[] {
    return [...this.latest.values()];
  }
}
