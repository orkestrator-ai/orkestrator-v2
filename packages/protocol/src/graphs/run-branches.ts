/**
 * Replication branches of a node in a run (plan P2.3, P2.5; report §4.4, §5.8).
 *
 * A replicated node runs once per branch: per model of a panel role, per
 * lens, per sample, or per element of their product. Branch keys are stable
 * across retries and restarts because they derive from the plan and the
 * run's frozen bindings only (`panel.2`, `lens.security`, `sample.3`, and
 * `panel.1+lens.tests` for a product, axes in plan order). They appear in
 * activation keys, so they never contain `#` or `=`.
 *
 * A lens branch runs on its lens's role (the plan fills it with the node's
 * role); in a product with a panel axis the panel model wins. A node runs at
 * most 32 branches (`GRAPH_TEMPLATE_BOUNDS.maxBranches`): the compiler
 * multiplies the axes' bounds, and the runtime refuses a binding that would
 * exceed it anyway.
 *
 * `items` replication (one branch per element of a list input) arrives with
 * item 401; the compiler refuses it until then.
 *
 * Browser-safe: the run view draws a replicated node's branches from here.
 */
import { GRAPH_TEMPLATE_BOUNDS } from "./grammar.js";
import type { CompiledGraphPlan, GraphPlanNode } from "./plan.js";
import { isGraphBranchKey } from "./run-identity.js";
import type { GraphModelBinding, GraphRunBindings } from "./run-model.js";

export interface GraphBranch {
  /** The stable branch key. */
  key: string;
  /** Zero-based model index in the panel role's bindings, for a panel axis. */
  panelIndex?: number;
  /** The lens key, for a lens axis. */
  lens?: string;
  /** One-based sample number, for a samples axis. */
  sample?: number;
  /** The role whose binding runs this branch: a lens's own role, else the node's. */
  role: string;
}

export class GraphBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphBranchError";
  }
}

/** How many models a role is bound to (a single binding counts as one). */
function boundModels(bindings: GraphRunBindings["roles"], role: string): number {
  const binding = bindings[role];
  if (binding === undefined) return 0;
  return Array.isArray(binding) ? binding.length : 1;
}

/**
 * The node's branches in plan order, or `null` when the node is not
 * replicated. Throws {@link GraphBranchError} for `items` replication (item
 * 401), more than 32 branches, or a key outside the branch grammar.
 */
export function graphNodeBranches(
  node: GraphPlanNode,
  bindings: GraphRunBindings["roles"],
): GraphBranch[] | null {
  const replicate = node.kind === "agent" || node.kind === "subgraph" ? node.replicate : undefined;
  if (!replicate) return null;
  const role = node.kind === "agent" ? node.role : "";
  let branches: GraphBranch[] = [{ key: "", role }];
  for (const axis of replicate.axes) {
    const next: GraphBranch[] = [];
    for (const branch of branches) {
      const join = (part: string) => (branch.key === "" ? part : `${branch.key}+${part}`);
      switch (axis.over) {
        case "panel": {
          const count = boundModels(bindings, axis.role);
          for (let index = 0; index < count; index++) {
            next.push({
              ...branch,
              key: join(`panel.${index + 1}`),
              panelIndex: index,
              role: axis.role,
            });
          }
          break;
        }
        case "lenses":
          for (const lens of axis.lenses) {
            next.push({
              ...branch,
              key: join(`lens.${lens.key}`),
              lens: lens.key,
              // A panel axis already chose the model; a lens role applies otherwise.
              role: branch.panelIndex === undefined ? lens.role : branch.role,
            });
          }
          break;
        case "samples":
          for (let sample = 1; sample <= axis.count; sample++) {
            next.push({ ...branch, key: join(`sample.${sample}`), sample });
          }
          break;
        case "items":
          throw new GraphBranchError("Replication over list items arrives with item 401");
      }
    }
    branches = next;
    if (branches.length > GRAPH_TEMPLATE_BOUNDS.maxBranches) {
      throw new GraphBranchError(
        `${node.id} would run ${branches.length} branches; a node runs at most ${GRAPH_TEMPLATE_BOUNDS.maxBranches}`,
      );
    }
  }
  for (const branch of branches) {
    if (!isGraphBranchKey(branch.key)) {
      throw new GraphBranchError("A branch key is outside the branch key grammar");
    }
  }
  return branches;
}

/** The model a branch (or an unreplicated agent node) runs on, from the run's bindings. */
export function graphBranchBinding(
  bindings: GraphRunBindings["roles"],
  role: string,
  branch?: Pick<GraphBranch, "panelIndex">,
): GraphModelBinding | undefined {
  const binding = bindings[role];
  if (binding === undefined) return undefined;
  if (!Array.isArray(binding)) return binding;
  return binding[branch?.panelIndex ?? 0];
}

/** Every branch key of every replicated node, for callers that index a whole plan. */
export function graphPlanBranches(
  plan: Pick<CompiledGraphPlan, "nodes">,
  bindings: GraphRunBindings["roles"],
): Map<string, GraphBranch[] | null> {
  return new Map(plan.nodes.map((node) => [node.id, graphNodeBranches(node, bindings)]));
}
