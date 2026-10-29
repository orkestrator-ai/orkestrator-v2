/**
 * Plan assembly: turns a compile state with no errors into the normalised
 * `CompiledGraphPlan` (plan.ts), with every default filled and the digest.
 */
import type { CompiledGraphCapabilities } from "./capability-profiles.js";
import { type GraphCompileState, graphNodeWorkspaceAccess, portKey } from "./compile-state.js";
import { graphLoopEntries, graphLoopMembers } from "./compile-graph.js";
import { graphSourceType } from "./compile-ports.js";
import { graphPromptContextFor } from "./lint.js";
import {
  type CompiledGraphPlan,
  compareStrings,
  type GraphCompileCost,
  GRAPH_COMPILER_VERSION,
  GRAPH_PLAN_FORMAT,
  GRAPH_PLAN_FORMAT_VERSION,
  type GraphPlanInputPort,
  type GraphPlanNode,
  type GraphPlanOutputPort,
  type GraphPlanReplicate,
  type GraphPlanTaint,
  graphPlainJson,
  graphPlanDigest,
  graphPlanValueType,
  graphTemplateDigest,
} from "./plan.js";
import { graphPromptEffectiveMode } from "./prompt-render.js";
import { graphPromptScope } from "./prompt-scope.js";
import { graphNodeGrantedActions } from "./system-contract.js";
import {
  type GraphCollectPolicy,
  type GraphNodeSpec,
  type GraphReplicate,
  graphHumanRoutesFailures,
  graphNodeOutlets,
} from "./template-model.js";
import { graphListType, type GraphValueType } from "./types.js";

/** Report §4.4: today's consolidation rule. */
export const GRAPH_DEFAULT_COLLECT_POLICY: Readonly<GraphCollectPolicy> = Object.freeze({
  wait: "all-settled",
  minSuccessful: 1,
  includeFailures: true,
});

function filledCollect(policy: GraphCollectPolicy | undefined): GraphCollectPolicy {
  if (!policy) return { ...GRAPH_DEFAULT_COLLECT_POLICY };
  return {
    wait: policy.wait,
    ...(policy.count !== undefined
      ? { count: policy.count }
      : policy.wait === "first"
        ? { count: 1 }
        : {}),
    minSuccessful: policy.minSuccessful,
    includeFailures: policy.includeFailures,
  };
}

const plan = (type: GraphValueType | null | undefined) => (type ? graphPlanValueType(type) : null);

function planReplicate(
  state: GraphCompileState,
  node: GraphNodeSpec & { replicate?: GraphReplicate },
  role: string | undefined,
): GraphPlanReplicate | undefined {
  if (!node.replicate) return undefined;
  const axes = node.replicate.over === "cross" ? node.replicate.axes : [node.replicate];
  return {
    axes: axes.map((axis) => {
      switch (axis.over) {
        case "lenses":
          return {
            over: "lenses" as const,
            lenses: axis.lenses.map((lens) => ({ ...lens, role: lens.role ?? role ?? "" })),
          };
        case "items":
          return {
            over: "items" as const,
            input: axis.input,
            maxBranches: axis.maxBranches,
            truncate: axis.truncate ?? "first",
          };
        default:
          return { ...axis };
      }
    }),
    branches: state.branches.get(node.id)!,
    signature: state.replicateSignatures.get(node.id) ?? "",
  };
}

function planCapabilities(
  node: GraphNodeSpec & { kind: "agent" },
  compiled: CompiledGraphCapabilities,
) {
  return {
    ...structuredClone(compiled),
    spec: {
      profile: node.capabilities.profile,
      allow: [...(node.capabilities.allow ?? [])].sort(compareStrings),
      deny: [...(node.capabilities.deny ?? [])].sort(compareStrings),
    },
  };
}

function planNode(
  state: GraphCompileState,
  node: GraphNodeSpec,
  order: number,
  taint: GraphPlanTaint,
  edgeOrder: Map<string, number>,
): GraphPlanNode {
  const promptPorts =
    node.kind === "agent" ? graphPromptScope(graphPromptContextFor(state, node)).ports : undefined;
  const itemsInput =
    (node.kind === "agent" || node.kind === "subgraph") && node.replicate
      ? (node.replicate.over === "cross" ? node.replicate.axes : [node.replicate]).find(
          (axis) => axis.over === "items",
        )
      : undefined;
  const inputs: GraphPlanInputPort[] = (node.inputs ?? []).map((port) => {
    const key = portKey(node.id, port.name);
    const producers = state.producersOf(node.id, port.name);
    const fanIn = state.fanInPorts.has(key);
    const promptPort = promptPorts?.get(port.name);
    return {
      name: port.name,
      type: port.type,
      ...(port.label !== undefined ? { label: port.label } : {}),
      ...(port.description !== undefined ? { description: port.description } : {}),
      required: port.required !== false,
      ...(promptPort ? { render: graphPromptEffectiveMode(promptPort) } : {}),
      ...(fanIn ? { collect: filledCollect(port.collect) } : {}),
      ...(port.firstIterationFrom ? { firstIterationFrom: port.firstIterationFrom } : {}),
      deliveredType: plan(state.deliveredTypes.get(key)),
      perBranch: itemsInput?.over === "items" && itemsInput.input === port.name,
      fanIn,
      edges: producers
        .filter((producer) => producer.kind === "edge")
        .map((producer) => producer.id)
        .sort((a, b) => edgeOrder.get(a)! - edgeOrder.get(b)!),
      carries: producers.filter((producer) => producer.kind === "carry").map((p) => p.id),
    };
  });
  const replicated = state.isReplicated(node.id);
  const outputs: GraphPlanOutputPort[] = ("outputs" in node ? (node.outputs ?? []) : []).map(
    (port) => {
      const declared = state.outputTypes.get(portKey(node.id, port.name)) ?? null;
      return {
        name: port.name,
        type: port.type,
        ...(port.label !== undefined ? { label: port.label } : {}),
        ...(port.description !== undefined ? { description: port.description } : {}),
        required: port.required !== false,
        ...(port.provenance !== undefined ? { provenance: port.provenance } : {}),
        ...(port.choices !== undefined ? { choices: [...port.choices] } : {}),
        valueType: plan(declared && replicated ? graphListType(declared) : declared),
      };
    },
  );
  if (graphHumanRoutesFailures(node)) {
    // The implicit `error` port a human node's timeout routes to (P2.8).
    outputs.push({
      name: "error",
      type: "error@1",
      required: false,
      valueType: plan(state.outputTypes.get(portKey(node.id, "error")) ?? null),
    });
  }
  const execution = "retry" in node ? node : undefined;
  const subgraph = state.nodeSubgraph.get(node.id);
  const base = {
    id: node.id,
    ...(subgraph !== undefined ? { subgraph } : {}),
    ...(node.label !== undefined ? { label: node.label } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    order,
    ...(state.loopOf.has(node.id) ? { loop: state.loopOf.get(node.id)! } : {}),
    inputs,
    outputs,
    ...(node.when !== undefined ? { when: node.when } : {}),
    workspaceAccess: graphNodeWorkspaceAccess(node),
    // `fail-run` is the default for writers (P2.6), replicated or not: an
    // isolated replicated writer's failed branch is not quietly dropped.
    // Replicated readers default to `skip`, so one failed reviewer does not
    // sink the panel.
    onFailure: graphHumanRoutesFailures(node)
      ? "route"
      : (("onFailure" in node ? node.onFailure : undefined) ??
        (replicated && graphNodeWorkspaceAccess(node) !== "write" ? "skip" : "fail-run")),
    retry: execution?.retry
      ? { attempts: execution.retry.attempts, on: [...execution.retry.on] }
      : { attempts: 1, on: [] },
    ...("timeoutMs" in node && node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
    fanOut: state.branches.get(node.id) ?? { min: 1, max: 1 },
    skippable: state.skippable.has(node.id) || state.laterOnly.has(node.id),
    taint,
  };
  switch (node.kind) {
    case "agent": {
      const compiled = state.capabilities.get(node.id)!;
      const floor = state.floors.get(node.id);
      const replicate = planReplicate(state, node, node.role);
      return {
        ...base,
        kind: "agent",
        role: node.role,
        prompt: node.prompt,
        capabilities: planCapabilities(node, compiled),
        ...(floor !== undefined ? { minEnforcement: floor } : {}),
        floorLowered: state.floorLowered.has(node.id),
        ...(node.isolation ? { isolation: node.isolation } : {}),
        session: node.session ?? { mode: "fresh" },
        ...(replicate ? { replicate } : {}),
        askHuman: node.askHuman === true,
        grantedActions: graphNodeGrantedActions(node, state.library, compiled),
      };
    }
    case "system":
      return { ...base, kind: "system", action: node.action, params: node.params ?? {} };
    case "gate":
      return {
        ...base,
        kind: "gate",
        branches: node.branches,
        ...(node.otherwise !== undefined ? { otherwise: node.otherwise } : {}),
        outlets: graphNodeOutlets(node)!,
      };
    case "merge":
      return { ...base, kind: "merge", strategy: node.strategy };
    case "human":
      return { ...base, kind: "human", form: node.form, outlets: graphNodeOutlets(node)! };
    case "subgraph": {
      const replicate = planReplicate(state, node, undefined);
      return {
        ...base,
        kind: "subgraph",
        template: node.template,
        params: node.params ?? {},
        roles: node.roles ?? {},
        ...(replicate ? { replicate } : {}),
      };
    }
  }
}

function collectRefs(type: GraphValueType | null | undefined, into: Set<string>): void {
  if (!type) return;
  if (type.kind === "named") into.add(type.definition.ref);
  else if (type.kind === "list") collectRefs(type.element, into);
}

/** The normalised plan; call only when the compile found no errors. */
export function assembleGraphPlan(
  state: GraphCompileState,
  cost: GraphCompileCost,
  taint: Map<string, GraphPlanTaint>,
): CompiledGraphPlan {
  const { template, source } = state;
  const order = state.order!;
  const edges = [...state.edges].sort((a, b) => compareStrings(a.edge.id, b.edge.id));
  const edgeOrder = new Map(edges.map(({ edge }, index) => [edge.id, index]));

  const refs = new Set<string>();
  for (const type of [
    ...state.inputTypes.values(),
    ...state.outputTypes.values(),
    ...state.runInputTypes.values(),
    ...state.deliveredTypes.values(),
  ]) {
    collectRefs(type, refs);
  }
  for (const output of template.outputs ?? []) {
    const resolved = state.library.resolve(output.type);
    if (resolved.ok) collectRefs(resolved.type, refs);
  }
  const typeRefs = [...refs].sort(compareStrings);

  const draft: Omit<CompiledGraphPlan, "digest"> = {
    format: GRAPH_PLAN_FORMAT,
    formatVersion: GRAPH_PLAN_FORMAT_VERSION,
    compilerVersion: GRAPH_COMPILER_VERSION,
    // The author's template, not the flat one the passes checked (item 402).
    templateDigest: graphTemplateDigest(source),
    template: {
      id: source.id,
      revision: source.revision,
      name: source.name,
      ...(source.description !== undefined ? { description: source.description } : {}),
      ...(source.engine !== undefined ? { engine: source.engine } : {}),
    },
    parameters: template.parameters,
    roles: template.roles,
    types: typeRefs.flatMap((ref) => {
      const def = state.customTypes.get(ref);
      return def ? [def] : [];
    }),
    typeRefs,
    inputs: template.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      required: input.required !== false,
    })),
    outputs: (template.outputs ?? []).map((output) => ({
      name: output.name,
      type: output.type,
      ...(output.label !== undefined ? { label: output.label } : {}),
      ...(output.description !== undefined ? { description: output.description } : {}),
      required: output.required !== false,
      from: output.from,
    })),
    workspace: template.workspace,
    order,
    nodes: order.map((id, index) =>
      planNode(state, state.nodes.get(id)!.node, index, taint.get(id)!, edgeOrder),
    ),
    edges: edges.map(({ edge }) => {
      const types = state.producerTypes.get(edge.id);
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        transform: edge.transform ?? [],
        zip: edge.zip === true,
        iterations: state.edgeIterations.get(edge.id) ?? "all",
        sourceType: plan(types?.source),
        deliveredType: plan(types?.delivered),
        budgetCheck: types?.budgetCheck ?? false,
        fanIn: types?.fanIn ?? false,
      };
    }),
    loops: [...state.loops.values()]
      .sort((a, b) => compareStrings(a.loop.id, b.loop.id))
      .map(({ loop }) => ({
        id: loop.id,
        ...(state.loopSubgraph.has(loop.id) ? { subgraph: state.loopSubgraph.get(loop.id)! } : {}),
        ...(loop.label !== undefined ? { label: loop.label } : {}),
        members: graphLoopMembers(state, loop.id),
        entry: graphLoopEntries(state, loop.id),
        laterOnly: graphLoopMembers(state, loop.id).filter((id) => state.laterOnly.has(id)),
        until: loop.until,
        maxIterations: loop.maxIterations,
        carry: loop.carry.map((carry) => ({
          from: carry.from,
          to: carry.to,
          type: plan(graphSourceType(state, carry.from)),
        })),
      })),
    ...(state.subgraphs.length > 0
      ? {
          subgraphs: state.subgraphs.map((instance) => ({
            ...instance,
            nodes: order.filter((id) => id.startsWith(`${instance.id}/`)),
          })),
        }
      : {}),
    limits: { ...template.limits },
    cost,
    acknowledgements: {
      accepted: [...state.acknowledgements.accepted],
      pending: [...state.acknowledgements.pending],
    },
    context: { ceiling: state.options.ceiling, environment: state.options.environment },
  };
  const plain = graphPlainJson(draft);
  return { ...plain, digest: graphPlanDigest(plain) } as CompiledGraphPlan;
}
