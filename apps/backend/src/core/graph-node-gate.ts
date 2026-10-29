/**
 * The `gate` node executor (plan P2.6, D10, report §4.4): routes on JSON
 * predicates, never on model judgement directly (a judge node's `decision`
 * output is data a gate reads).
 *
 * A gate's branches are tried in order with item 104's three-valued
 * evaluator over the gate's own inputs (by port name; a list input is the
 * list of its artifacts' values), the launch `params` and `run.iteration`.
 * The first branch whose predicate *definitely* holds names the outlet; an
 * unknown value (a missing field, a type mismatch) never holds, even under
 * `not`. With no branch holding, `otherwise` is taken; a gate without
 * `otherwise` then takes no outlet at all.
 *
 * The gate completes at once with the outlet it took (`NodeActivation.outlet`)
 * and forwards its single-value inputs as its outputs; the ready set delivers
 * a taken outlet's port from those (or from the gate's bound input, so a
 * list input passes on as a list). Every edge from an outlet not taken
 * delivers nothing, so the consumers whose required input it is are skipped,
 * and the skip propagates through the dataflow to everything fed only from
 * there; a node with another live producer (a single-value port fed by two
 * exclusive outlets, or a list port) still runs.
 *
 * Only the input values the branch predicates read are loaded (and
 * hash-verified when they are files). Evaluation is total and bounded, so a
 * gate fails only when an input artifact cannot be read.
 */
import type { GraphPlanGateNode } from "@orkestrator/protocol/graphs/compile";
import { graphPlanScopeParams } from "@orkestrator/protocol/graphs/subgraphs";
import {
  evaluateGraphPredicate,
  type GraphPredicateEnvironment,
} from "@orkestrator/protocol/graphs/predicates";
import type {
  GraphActivationReport,
  GraphExecutorContext,
  GraphNodeExecutor,
} from "./graph-run-executors.js";
import { graphPredicatePaths } from "./graph-run-ready-set.js";

export interface GraphGateDecision {
  /** The outlet taken; null when no branch held and the gate has no `otherwise`. */
  outlet: string | null;
  /** The index of the branch that held; null for `otherwise` or no outlet. */
  branch: number | null;
}

/** Chooses a gate's outlet: the first branch that definitely holds, else `otherwise`. */
export function chooseGraphGateOutlet(
  node: Pick<GraphPlanGateNode, "branches" | "otherwise">,
  environment: GraphPredicateEnvironment,
): GraphGateDecision {
  for (const [index, branch] of node.branches.entries()) {
    if (evaluateGraphPredicate(branch.when, environment).value) {
      return { outlet: branch.to, branch: index };
    }
  }
  return { outlet: node.otherwise ?? null, branch: null };
}

/** The input ports a gate's branch predicates read (path roots). */
export function graphGateInputRoots(node: GraphPlanGateNode): Set<string> {
  const ports = new Set(node.inputs.map((port) => port.name));
  const roots = new Set<string>();
  for (const branch of node.branches) {
    for (const path of graphPredicatePaths(branch.when)) {
      const root = path.split(".")[0]!;
      if (ports.has(root)) roots.add(root);
    }
  }
  return roots;
}

async function runGate(context: GraphExecutorContext): Promise<GraphActivationReport> {
  const { node, activation, run } = context;
  if (node.kind !== "gate") throw new Error("The gate executor runs gate nodes only");
  const values: Record<string, unknown> = {};
  const read = async (id: string) =>
    (await context.artifacts.requireVerified(run.id, id)).body.value;
  for (const port of graphGateInputRoots(node)) {
    const bound = activation.inputs[port];
    if (bound === undefined) continue;
    values[port] = Array.isArray(bound)
      ? await Promise.all(bound.map((id) => read(id)))
      : await read(bound);
  }
  const decision = chooseGraphGateOutlet(node, {
    values,
    // An inlined gate reads its sub-graph's parameters (item 402).
    params: graphPlanScopeParams(run.plan, node.subgraph, run.bindings.params),
    run: { iteration: activation.iteration },
  });
  const outputs = Object.fromEntries(
    Object.entries(activation.inputs).flatMap(([port, ids]) =>
      typeof ids === "string" ? [[port, ids]] : [],
    ),
  );
  return decision.outlet === null
    ? { state: "complete", outputs: {} }
    : { state: "complete", outlet: decision.outlet, outputs };
}

/**
 * The gate executor: decides at `start` (and again, identically, at
 * `recover` or `observe`). Register it once on `graphRuns.executors`.
 */
export function createGraphGateExecutor(): GraphNodeExecutor {
  return {
    kind: "gate",
    start: runGate,
    observe: runGate,
    recover: runGate,
    cancel: async () => ({ state: "cancelled" }),
  };
}
