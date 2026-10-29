/**
 * Sub-graphs (item 402, D5): one template used as a node of another.
 *
 * The compiler inlines a child template's nodes with namespaced ids
 * (`compile-subgraphs.ts`); this module holds what the rest of the system
 * shares about that:
 * - how a compile finds a child (`GraphTemplateResolver`, injected so the
 *   compiler stays pure and the browser and backend each supply their own);
 * - the ports a sub-graph node exposes for a child (`graphSubgraphPorts`);
 * - how the runtime reads an inlined node's parameters, which come from the
 *   child's scope in `plan.subgraphs` (`graphPlanNodeParams`).
 * Browser-safe.
 */
import { graphBuiltInTemplate } from "./builtins/index.js";
import type { CompiledGraphPlan, GraphPlanSubgraph } from "./plan.js";
import type {
  GraphInputPortSpec,
  GraphOutputPortSpec,
  GraphParameter,
  GraphScalarValue,
  GraphTemplateRef,
  GraphTemplateV1,
} from "./template-model.js";

/** Nesting below the top-level template. */
export const GRAPH_SUBGRAPH_MAX_DEPTH = 4;
/** Distinct child references one compile may resolve. */
export const GRAPH_SUBGRAPH_MAX_RESOLUTIONS = 64;

/** Why a child did not resolve. */
export const GRAPH_SUBGRAPH_MISSING_REASONS = [
  /** No template with that scope and id (or path). */
  "not-found",
  /** A project template that is not trusted at its current digest. */
  "untrusted",
  /** A project-scope id that names more than one file; pin a path. */
  "ambiguous",
  /** A project-scope reference compiled outside any project. */
  "no-project",
  /** The compile was given no resolver. */
  "no-resolver",
] as const;
export type GraphSubgraphMissingReason = (typeof GRAPH_SUBGRAPH_MISSING_REASONS)[number];

/** A resolved child, or why there is none. */
export type GraphTemplateResolution =
  | {
      template: GraphTemplateV1;
      /** The stored revision when the template's own `revision` field may lag it. */
      revision?: number;
      /** Project scope: the file it was read from. */
      path?: string;
    }
  | { missing: GraphSubgraphMissingReason };

/**
 * Finds a sub-graph's template. Synchronous and pure for one compile: the
 * backend pre-resolves references (project files are read asynchronously)
 * and the designer resolves from what it has loaded. `undefined` means
 * not found.
 */
export type GraphTemplateResolver = (ref: GraphTemplateRef) => GraphTemplateResolution | undefined;

/**
 * The resolver a compile uses when it is given none: built-ins resolve from
 * code (they ship with the app), user and project templates need a resolver
 * that can read them.
 */
export const graphBuiltinTemplateResolver: GraphTemplateResolver = (ref) => {
  if (ref.scope !== "builtin") return { missing: "no-resolver" };
  const builtIn = graphBuiltInTemplate(ref.id);
  return builtIn ? { template: builtIn.template } : { missing: "not-found" };
};

/** A stable key for a reference, for caches and recursion checks. */
export function graphSubgraphRefKey(ref: GraphTemplateRef): string {
  return ref.scope === "project" && ref.path !== undefined
    ? `project:${ref.path}`
    : `${ref.scope}:${ref.id}`;
}

/**
 * The ports a sub-graph node exposes for `child`: one input per run input and
 * one output per run output, same names, types and requiredness. The designer
 * writes these when the user picks a child; the compiler checks them.
 */
export function graphSubgraphPorts(child: GraphTemplateV1): {
  inputs: GraphInputPortSpec[];
  outputs: GraphOutputPortSpec[];
} {
  return {
    inputs: child.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.required === false ? { required: false } : {}),
    })),
    outputs: (child.outputs ?? []).map((output) => ({
      name: output.name,
      type: output.type,
      ...(output.label !== undefined ? { label: output.label } : {}),
      ...(output.description !== undefined ? { description: output.description } : {}),
      ...(output.required === false ? { required: false } : {}),
    })),
  };
}

// ---------------------------------------------------------------- runtime scope

type GraphParamValues = Readonly<Record<string, GraphScalarValue>>;

/** The sub-graph instance a plan node or loop was inlined from, innermost first. */
export function graphPlanSubgraph(
  plan: Pick<CompiledGraphPlan, "subgraphs">,
  id: string | undefined,
): GraphPlanSubgraph | undefined {
  if (id === undefined) return undefined;
  return plan.subgraphs?.find((instance) => instance.id === id);
}

/** Parameter values in an instance's scope; the plan's own values outside any sub-graph. */
export function graphPlanScopeParams(
  plan: Pick<CompiledGraphPlan, "subgraphs">,
  subgraph: string | undefined,
  runParams: GraphParamValues,
): Record<string, GraphScalarValue> {
  const instance = graphPlanSubgraph(plan, subgraph);
  if (!instance) return { ...runParams };
  const values: Record<string, GraphScalarValue> = {};
  for (const [key, source] of Object.entries(instance.params)) {
    const value = "value" in source ? source.value : runParams[source.param];
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/**
 * The parameter values a node's prompt, `when` and gate branches read: the
 * run's own for a node of the template itself, its child's scope for an
 * inlined node (literals the parent bound, or the parent's parameters it
 * passed through).
 */
export function graphPlanNodeParams(
  plan: Pick<CompiledGraphPlan, "subgraphs" | "nodes">,
  nodeId: string,
  runParams: GraphParamValues,
): Record<string, GraphScalarValue> {
  const node = plan.nodes.find((candidate) => candidate.id === nodeId);
  return graphPlanScopeParams(plan, node?.subgraph, runParams);
}

/** The parameter values a loop's `until` reads. */
export function graphPlanLoopParams(
  plan: Pick<CompiledGraphPlan, "subgraphs" | "loops">,
  loopId: string,
  runParams: GraphParamValues,
): Record<string, GraphScalarValue> {
  const loop = plan.loops.find((candidate) => candidate.id === loopId);
  return graphPlanScopeParams(plan, loop?.subgraph, runParams);
}

/** The parameter definitions in a node's scope (prompt rendering reads their types). */
export function graphPlanNodeParameters(
  plan: Pick<CompiledGraphPlan, "subgraphs" | "nodes" | "parameters">,
  nodeId: string,
): GraphParameter[] {
  const node = plan.nodes.find((candidate) => candidate.id === nodeId);
  return graphPlanSubgraph(plan, node?.subgraph)?.parameters ?? plan.parameters;
}
