/**
 * The cost estimate (report §7.4): best- and worst-case agent sessions and
 * activations, and peak parallelism, plus the limit checks built on them.
 *
 * - Worst case: every node runs, every loop runs `maxIterations`, every
 *   replicated node runs its most branches, every attempt fails but the last.
 * - Best case: one loop iteration, one attempt, the fewest branches, and every
 *   node some run can skip (a `when`, a gate or human outlet, an absent
 *   input, or a loop member that only runs from iteration 2) skipped.
 * - Peak parallelism: the heaviest set of agent nodes no ordering separates,
 *   each weighted by its most branches. Exact over the "finishes before"
 *   relation (a maximum-weight antichain, by Dilworth's theorem as a flow);
 *   an upper bound because mutually exclusive branches are counted together.
 */
import { graphNodeBefore } from "./compile-graph.js";
import type { GraphCompileState } from "./compile-state.js";
import { GRAPH_TEMPLATE_BOUNDS } from "./grammar.js";
import type { GraphCompileCost, GraphCompileCostNode } from "./plan.js";

/** Maximum flow on a small dense network (Dinic). */
class FlowNetwork {
  private readonly heads: number[];
  private readonly to: number[] = [];
  private readonly next: number[] = [];
  private readonly capacity: number[] = [];

  constructor(private readonly size: number) {
    this.heads = Array.from({ length: size }, () => -1);
  }

  add(from: number, to: number, capacity: number): void {
    for (const [a, b, c] of [
      [from, to, capacity],
      [to, from, 0],
    ] as const) {
      this.to.push(b);
      this.capacity.push(c);
      this.next.push(this.heads[a]!);
      this.heads[a] = this.to.length - 1;
    }
  }

  maxFlow(source: number, sink: number): number {
    let total = 0;
    for (;;) {
      const level = Array.from({ length: this.size }, () => -1);
      level[source] = 0;
      const queue = [source];
      for (let head = 0; head < queue.length; head++) {
        const node = queue[head]!;
        for (let edge = this.heads[node]!; edge !== -1; edge = this.next[edge]!) {
          if (this.capacity[edge]! > 0 && level[this.to[edge]!] === -1) {
            level[this.to[edge]!] = level[node]! + 1;
            queue.push(this.to[edge]!);
          }
        }
      }
      if (level[sink] === -1) return total;
      const cursor = this.heads.slice();
      const push = (node: number, limit: number): number => {
        if (node === sink) return limit;
        for (; cursor[node] !== -1; cursor[node] = this.next[cursor[node]!]!) {
          const edge = cursor[node]!;
          const target = this.to[edge]!;
          if (this.capacity[edge]! <= 0 || level[target] !== level[node]! + 1) continue;
          const pushed = push(target, Math.min(limit, this.capacity[edge]!));
          if (pushed > 0) {
            this.capacity[edge]! -= pushed;
            this.capacity[edge ^ 1]! += pushed;
            return pushed;
          }
        }
        return 0;
      };
      for (let pushed = push(source, Infinity); pushed > 0; pushed = push(source, Infinity)) {
        total += pushed;
      }
    }
  }
}

/**
 * The heaviest antichain of a partial order: total weight minus the most
 * chain links the order allows (min chain cover with multiplicities).
 */
export function graphMaxWeightAntichain(
  weights: readonly number[],
  before: (a: number, b: number) => boolean,
): number {
  const n = weights.length;
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (n === 0) return 0;
  // Transitive closure, so chains may skip over nodes.
  const order = weights.map((_, a) => weights.map((__, b) => a !== b && before(a, b)));
  for (let k = 0; k < n; k++) {
    for (let a = 0; a < n; a++) {
      if (!order[a]![k]) continue;
      for (let b = 0; b < n; b++) if (order[k]![b]) order[a]![b] = true;
    }
  }
  const source = 2 * n;
  const sink = 2 * n + 1;
  const network = new FlowNetwork(2 * n + 2);
  for (let a = 0; a < n; a++) {
    network.add(source, a, weights[a]!);
    network.add(n + a, sink, weights[a]!);
    for (let b = 0; b < n; b++) if (order[a]![b]) network.add(a, n + b, total);
  }
  return total - network.maxFlow(source, sink);
}

export function computeGraphCost(state: GraphCompileState): GraphCompileCost {
  const nodes: GraphCompileCostNode[] = [];
  const ids = state.order ?? [...state.nodes.keys()];
  let incomplete = false;
  for (const id of ids) {
    const { node } = state.nodes.get(id)!;
    const branches = state.branches.get(id) ?? { min: 1, max: 1 };
    const attempts = "retry" in node && node.retry ? node.retry.attempts : 1;
    const loop = state.loopOf.get(id);
    const iterations = loop === undefined ? 1 : state.loops.get(loop)!.loop.maxIterations;
    const skippable = state.skippable.has(id) || state.laterOnly.has(id);
    const agent = node.kind === "agent";
    if (node.kind === "subgraph") incomplete = true;
    const worst = branches.max * attempts * iterations;
    const best = skippable ? 0 : branches.min;
    nodes.push({
      nodeId: id,
      kind: node.kind,
      branches,
      attempts,
      iterations,
      skippable,
      agentSessions: { best: agent ? best : 0, worst: agent ? worst : 0 },
      activations: { best, worst },
    });
  }
  const sum = (pick: (entry: GraphCompileCostNode) => number) =>
    nodes.reduce((total, entry) => total + pick(entry), 0);

  const agents = nodes.filter((entry) => entry.kind === "agent" && entry.branches.max > 0);
  const peakParallelism = state.order
    ? graphMaxWeightAntichain(
        agents.map((entry) => entry.branches.max),
        (a, b) => graphNodeBefore(state, agents[a]!.nodeId, agents[b]!.nodeId),
      )
    : agents.reduce((total, entry) => total + entry.branches.max, 0);

  return {
    agentSessions: {
      best: sum((entry) => entry.agentSessions.best),
      worst: sum((entry) => entry.agentSessions.worst),
    },
    activations: {
      best: sum((entry) => entry.activations.best),
      worst: sum((entry) => entry.activations.worst),
    },
    peakParallelism,
    incomplete,
    nodes,
  };
}

/** Limits against the estimate (report §5.11). */
export function checkGraphLimits(state: GraphCompileState, cost: GraphCompileCost): void {
  const { limits } = state.template;
  if (cost.agentSessions.worst > limits.maxAgentSessions) {
    state.diagnostics.add(
      "limit-agent-sessions",
      `The worst case runs ${cost.agentSessions.worst} agent sessions; limits.maxAgentSessions is ${limits.maxAgentSessions}. Raise the limit (at most ${GRAPH_TEMPLATE_BOUNDS.maxAgentSessions}) or reduce loops, branches or retries`,
      { path: "limits.maxAgentSessions" },
    );
  }
  if (cost.activations.worst > GRAPH_TEMPLATE_BOUNDS.maxAgentSessions) {
    state.diagnostics.add(
      "limit-activations",
      `The worst case runs ${cost.activations.worst} node activations; a run allows at most ${GRAPH_TEMPLATE_BOUNDS.maxAgentSessions}`,
      { path: "limits" },
    );
  }
  if (cost.peakParallelism > limits.maxConcurrentAgents) {
    state.diagnostics.add(
      "concurrency-capped",
      `Up to ${cost.peakParallelism} agent sessions could run at once; limits.maxConcurrentAgents admits ${limits.maxConcurrentAgents}, so the rest wait`,
      { path: "limits.maxConcurrentAgents" },
    );
  }
}
