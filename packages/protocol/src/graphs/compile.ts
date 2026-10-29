/**
 * The graph compiler (plan P1.7, report §4.1, §7.4): a pure function from a
 * template to a frozen-friendly, hashed plan, or an exact account of what is
 * wrong with it.
 *
 * `compile(template, options)` guards the template (item 101), inlines its
 * sub-graphs (compile-subgraphs, item 402), then runs the passes in order on
 * the flat template: references and types (compile-refs), topology and loops
 * (compile-graph), ports and edges (compile-ports), conditions
 * (compile-conditions), agent nodes (compile-agents), workspace rules
 * (compile-workspace), taint (compile-taint), cost and limits (cost), and
 * lints (lint). With no errors it assembles the plan (compile-plan).
 */
import type { AgentPlatform } from "../agent-platforms.js";
import { checkGraphAgents } from "./compile-agents.js";
import { checkGraphConditions } from "./compile-conditions.js";
import type { GraphCompileDiagnostic } from "./compile-diagnostics.js";
import {
  checkGraphFirstIteration,
  checkGraphLoopRegions,
  computeGraphConditions,
  computeGraphLaterOnly,
  computeGraphSkippable,
  computeGraphTopology,
} from "./compile-graph.js";
import { assembleGraphPlan } from "./compile-plan.js";
import { inlineGraphSubgraphs } from "./compile-subgraphs.js";
import {
  checkGraphEdgeTypes,
  checkGraphInputs,
  checkGraphMerges,
  checkGraphRunOutputs,
  computeGraphBranches,
} from "./compile-ports.js";
import {
  addGraphGuardDiagnostics,
  checkGraphLibraryTypes,
  checkGraphNodeRules,
  checkGraphReferences,
  checkGraphRoles,
  resolveGraphPortTypes,
} from "./compile-refs.js";
import {
  GraphCompileState,
  type GraphCompileOptions,
  resolveGraphCompileOptions,
} from "./compile-state.js";
import { checkGraphSystemNodes } from "./compile-system.js";
import { computeGraphTaint } from "./compile-taint.js";
import { checkGraphWorkspace } from "./compile-workspace.js";
import { checkGraphLimits, computeGraphCost } from "./cost.js";
import { lintGraphTemplate } from "./lint.js";
import type { CompiledGraphPlan, GraphCompileCost, GraphPlanAcknowledgementRef } from "./plan.js";
import { GraphCompileDiagnostics } from "./compile-diagnostics.js";
import { validateGraphTemplate } from "./template.js";

export * from "./compile-diagnostics.js";
export * from "./plan.js";
export {
  GRAPH_COMPILE_DEFAULT_ENVIRONMENT,
  GRAPH_COMPILE_DEFAULT_HOST,
  GRAPH_SYSTEM_ACTION_WORKSPACE,
  type GraphCompileOptions,
  graphNodeWorkspaceAccess,
} from "./compile-state.js";
export { GRAPH_RESERVED_OUTPUT_PORT_NAMES, isGraphReservedOutputPortName } from "./compile-refs.js";
export { GRAPH_DEFAULT_COLLECT_POLICY } from "./compile-plan.js";
export { graphMaxWeightAntichain } from "./cost.js";
export { sha256Hex } from "./sha256.js";
export type {
  GraphTemplateResolution,
  GraphTemplateResolver,
  GraphSubgraphMissingReason,
} from "./subgraphs.js";

export interface GraphCompileResult {
  /** No error diagnostics. */
  ok: boolean;
  /** `ok`, and no warning waits for an acknowledgement: the plan may launch. */
  launchable: boolean;
  /** The plan; null when there are errors. */
  plan: CompiledGraphPlan | null;
  /** Errors first, then warnings, then info. */
  diagnostics: GraphCompileDiagnostic[];
  /** Diagnostics beyond the cap (500), counted only. */
  omittedDiagnostics: number;
  /** Null only when the template fails its schema guard. */
  cost: GraphCompileCost | null;
  /** Warnings that need an acknowledgement and have none. */
  pendingAcknowledgements: GraphPlanAcknowledgementRef[];
}

/** The providers a result was judged against, for messages and tests. */
export type GraphCompileProviders = readonly AgentPlatform[];

/** Compile a template (any JSON value; it is guarded first). Never throws on bad input. */
export function compile(template: unknown, options: GraphCompileOptions = {}): GraphCompileResult {
  const guard = validateGraphTemplate(template);
  if (!guard.ok) {
    const diagnostics = new GraphCompileDiagnostics();
    addGraphGuardDiagnostics(template, guard.errors, guard.omittedErrors, diagnostics);
    return {
      ok: false,
      launchable: false,
      plan: null,
      diagnostics: diagnostics.sorted(),
      omittedDiagnostics: diagnostics.omitted,
      cost: null,
      pendingAcknowledgements: [],
    };
  }
  const resolved = resolveGraphCompileOptions(options);
  const inlined = inlineGraphSubgraphs(guard.value, resolved.resolveTemplate);
  const state = new GraphCompileState(inlined.template, resolved, {
    source: guard.value,
    result: inlined,
  });
  for (const diagnostic of inlined.diagnostics) state.diagnostics.adopt(diagnostic);
  state.diagnostics.mapPath = inlined.mapPath;

  checkGraphLibraryTypes(state);
  resolveGraphPortTypes(state);
  checkGraphReferences(state);
  checkGraphRoles(state);
  checkGraphNodeRules(state);
  checkGraphSystemNodes(state);

  computeGraphTopology(state);
  checkGraphLoopRegions(state);
  checkGraphFirstIteration(state);
  computeGraphLaterOnly(state);
  computeGraphConditions(state);
  computeGraphSkippable(state);

  computeGraphBranches(state);
  checkGraphEdgeTypes(state);
  checkGraphInputs(state);
  checkGraphMerges(state);
  checkGraphRunOutputs(state);
  checkGraphConditions(state);

  checkGraphAgents(state);
  checkGraphWorkspace(state);
  const taint = computeGraphTaint(state);

  const cost = computeGraphCost(state);
  checkGraphLimits(state, cost);
  lintGraphTemplate(state);
  state.reportStaleAcknowledgements();

  const ok = state.diagnostics.errorCount === 0;
  const pending = state.acknowledgements.pending;
  return {
    ok,
    launchable: ok && pending.length === 0,
    plan: ok ? assembleGraphPlan(state, cost, taint) : null,
    diagnostics: state.diagnostics.sorted(),
    omittedDiagnostics: state.diagnostics.omitted,
    cost,
    pendingAcknowledgements: [...pending],
  };
}

/** {@link compile} under a descriptive name. */
export const compileGraphTemplate = compile;
