/**
 * The compiled graph plan (report §4.1, plan P1.7): what `compile` produces
 * from a template and a run freezes at launch.
 *
 * A plan is plain JSON: no `undefined`, no class instances, no shared
 * references into the template, so it can be stored, frozen and hashed as
 * is. It is normalised: nodes in topological order (ties by id), edges and
 * loops by id, custom types by reference, and every default filled in. The
 * digest is SHA-256 over the canonical JSON of the plan without its `digest`
 * field, so it does not depend on key order, on the order of nodes or edges
 * in the template, or on the designer layout (which the plan does not carry).
 */
import { canonicalJson } from "../canonical-json.js";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import type { ArtifactTypeBudgets, ArtifactTypeDef, GraphJsonSchema } from "./artifact-type-def.js";
import type {
  AgentEnforcementTier,
  CompiledGraphCapabilities,
  GraphCapabilityCeiling,
  GraphGrantedActions,
} from "./capability-profiles.js";
import type { GraphPredicate } from "./predicate-shape.js";
import { sha256Hex } from "./sha256.js";
import type {
  GraphAcknowledgementKind,
  GraphCapabilitySpec,
  GraphCollectPolicy,
  GraphEdgeSource,
  GraphEdgeTransform,
  GraphFailurePolicy,
  GraphGateBranch,
  GraphHumanForm,
  GraphLens,
  GraphMergeStrategy,
  GraphNodeKind,
  GraphParameter,
  GraphParameterBinding,
  GraphPortRef,
  GraphPortTarget,
  GraphPromptSpec,
  GraphProvenanceMode,
  GraphRenderMode,
  GraphRetryCause,
  GraphRole,
  GraphSessionSpec,
  GraphSystemAction,
  GraphSystemParamValue,
  GraphTemplateEngine,
  GraphTemplateRef,
  GraphTemplateV1,
  GraphWorkspaceAccess,
  GraphWorkspaceSpec,
} from "./template-model.js";
import type { GraphValueType } from "./types.js";

export const GRAPH_PLAN_FORMAT = "orkestrator.graph-plan";
export const GRAPH_PLAN_FORMAT_VERSION = 1;
/** Bumped when the compiler changes what a plan means; part of the digest. */
export const GRAPH_COMPILER_VERSION = 1;

// ---------------------------------------------------------------- types

/**
 * A resolved value type as plain data. `named` refers to a built-in type or
 * one of `plan.types`; `shape` is an edge transform's anonymous projection
 * and carries its schema and budgets, so the runtime can validate it.
 */
export type GraphPlanValueType =
  | { kind: "named"; ref: string }
  | { kind: "shape"; origin: string; schema: GraphJsonSchema; budgets: ArtifactTypeBudgets }
  | { kind: "list"; element: GraphPlanValueType };

export function graphPlanValueType(type: GraphValueType): GraphPlanValueType {
  switch (type.kind) {
    case "named":
      return { kind: "named", ref: type.definition.ref };
    case "shape":
      return {
        kind: "shape",
        origin: type.origin,
        schema: structuredClone(type.schema),
        budgets: { ...type.budgets },
      };
    case "list":
      return { kind: "list", element: graphPlanValueType(type.element) };
  }
}

/** `review-report@1`, `list<finding@1>`, or a shape's origin. */
export function graphPlanValueTypeLabel(type: GraphPlanValueType): string {
  switch (type.kind) {
    case "named":
      return type.ref;
    case "shape":
      return type.origin;
    case "list":
      return `list<${graphPlanValueTypeLabel(type.element)}>`;
  }
}

// ---------------------------------------------------------------- ports

export interface GraphPlanInputPort {
  name: string;
  /** The declared type reference. */
  type: string;
  label?: string;
  description?: string;
  required: boolean;
  /** Agent nodes: the effective render mode (item 105's default when unset). */
  render?: GraphRenderMode;
  /** Fan-in ports: the policy, defaults filled (all-settled, 1, include failures). */
  collect?: GraphCollectPolicy;
  firstIterationFrom?: GraphEdgeSource;
  /** What the producers deliver after edge transforms; null when no producer type-checks. */
  deliveredType: GraphPlanValueType | null;
  /** The input an `items` node replicates over: each branch sees one element. */
  perBranch: boolean;
  /** A replicated producer feeds it without zip (fan-in). */
  fanIn: boolean;
  /** Edge ids feeding the port, in plan edge order. */
  edges: string[];
  /** Loop carries feeding the port, as `<loopId>#<index>`. */
  carries: string[];
}

export interface GraphPlanOutputPort {
  name: string;
  type: string;
  label?: string;
  description?: string;
  required: boolean;
  provenance?: GraphProvenanceMode;
  choices?: string[];
  /** The type consumers see: `list<T>` when the node is replicated. */
  valueType: GraphPlanValueType | null;
}

// ---------------------------------------------------------------- nodes

export interface GraphPlanBranches {
  /** Fewest branches the node can run with (0 for an empty `items` list). */
  min: number;
  max: number;
}

export interface GraphPlanReplicate {
  /** The axes in order, lens roles filled with the node's role. */
  axes: Array<
    | { over: "panel"; role: string }
    | { over: "lenses"; lenses: Array<Required<Pick<GraphLens, "role">> & GraphLens> }
    | { over: "items"; input: string; maxBranches: number }
    | { over: "samples"; count: number }
  >;
  branches: GraphPlanBranches;
  /** Equal signatures zip branch k to branch k (report §5.8). */
  signature: string;
}

export const GRAPH_TAINT_SOURCE_REASONS = ["web-search", "network", "external-checks"] as const;
export type GraphTaintSourceReason = (typeof GRAPH_TAINT_SOURCE_REASONS)[number];
export const GRAPH_SIDE_EFFECT_REASONS = [
  "shell-and-network",
  "remote-write",
  "push",
  "pull-request",
  "validation-commands",
  "subgraph",
] as const;
export type GraphSideEffectReason = (typeof GRAPH_SIDE_EFFECT_REASONS)[number];

/** Taint (report §5.13), computed over edges and carries. */
export interface GraphPlanTaint {
  /** Untrusted content can reach this node. */
  tainted: boolean;
  /** The node itself reads untrusted content. */
  source?: GraphTaintSourceReason;
  /** The node has side effects untrusted content must not steer. */
  sideEffect?: GraphSideEffectReason;
  /** Source nodes whose content can reach this node, sorted. */
  sources: string[];
}

interface GraphPlanNodeBase {
  id: string;
  kind: GraphNodeKind;
  label?: string;
  description?: string;
  /** Index in `plan.order`. */
  order: number;
  /** The loop the node belongs to. */
  loop?: string;
  inputs: GraphPlanInputPort[];
  outputs: GraphPlanOutputPort[];
  when?: GraphPredicate;
  /** Agent nodes declare it; system nodes by action; others none. */
  workspaceAccess: GraphWorkspaceAccess;
  /** Default `fail-run`; `skip` for replicated nodes, whose collect policy decides. */
  onFailure: GraphFailurePolicy;
  /** Default one attempt. */
  retry: { attempts: number; on: GraphRetryCause[] };
  timeoutMs?: number;
  /** Branch counts: `{1, 1}` unless replicated. */
  fanOut: GraphPlanBranches;
  /** Some run can skip the node (`when`, a gate or human outlet, an absent input). */
  skippable: boolean;
  taint: GraphPlanTaint;
}

export interface GraphPlanCapabilities extends CompiledGraphCapabilities {
  /** The node's spec, overrides sorted. */
  spec: Required<Pick<GraphCapabilitySpec, "profile" | "allow" | "deny">>;
}

export interface GraphPlanAgentNode extends GraphPlanNodeBase {
  kind: "agent";
  role: string;
  prompt: GraphPromptSpec;
  capabilities: GraphPlanCapabilities;
  /** The floor that applies: the node's own, or the profile's default (D4). */
  minEnforcement?: AgentEnforcementTier;
  /** The node lowered its profile's floor (acknowledged, or the plan has an error). */
  floorLowered: boolean;
  session: GraphSessionSpec;
  replicate?: GraphPlanReplicate;
  askHuman: boolean;
  grantedActions: GraphGrantedActions;
}

export interface GraphPlanSystemNode extends GraphPlanNodeBase {
  kind: "system";
  action: GraphSystemAction;
  params: Record<string, GraphSystemParamValue>;
}

export interface GraphPlanGateNode extends GraphPlanNodeBase {
  kind: "gate";
  branches: GraphGateBranch[];
  otherwise?: string;
  outlets: string[];
}

export interface GraphPlanMergeNode extends GraphPlanNodeBase {
  kind: "merge";
  strategy: GraphMergeStrategy;
}

export interface GraphPlanHumanNode extends GraphPlanNodeBase {
  kind: "human";
  form: GraphHumanForm;
  outlets: string[];
}

/** Never in a successful plan until item 402; kept so the shape is complete. */
export interface GraphPlanSubgraphNode extends GraphPlanNodeBase {
  kind: "subgraph";
  template: GraphTemplateRef;
  params: Record<string, GraphParameterBinding>;
  roles: Record<string, string>;
  replicate?: GraphPlanReplicate;
}

export type GraphPlanNode =
  | GraphPlanAgentNode
  | GraphPlanSystemNode
  | GraphPlanGateNode
  | GraphPlanMergeNode
  | GraphPlanHumanNode
  | GraphPlanSubgraphNode;

// ---------------------------------------------------------------- edges, loops

/** When an edge delivers: every iteration, or a loop entry's first or later ones (§9.2). */
export type GraphPlanEdgeIterations = "all" | "first" | "later";

export interface GraphPlanEdge {
  id: string;
  from: GraphEdgeSource;
  to: GraphPortTarget;
  transform: GraphEdgeTransform[];
  zip: boolean;
  iterations: GraphPlanEdgeIterations;
  /** The producer's type (lifted to a list for a replicated producer without zip). */
  sourceType: GraphPlanValueType | null;
  /** After transforms. */
  deliveredType: GraphPlanValueType | null;
  /** Budgets could not be proven to fit: the runtime checks the target's budgets. */
  budgetCheck: boolean;
  /** A replicated producer feeds a list port (fan-in). */
  fanIn: boolean;
}

export interface GraphPlanLoopCarry {
  from: GraphPortRef;
  to: GraphPortTarget;
  type: GraphPlanValueType | null;
}

export interface GraphPlanLoop {
  id: string;
  label?: string;
  /** In plan order. */
  members: string[];
  /** Members no other member feeds: where an iteration starts. */
  entry: string[];
  /** Members that cannot run on iteration 1 (their inputs are carried or later-only). */
  laterOnly: string[];
  until: GraphPredicate;
  maxIterations: number;
  carry: GraphPlanLoopCarry[];
}

// ---------------------------------------------------------------- the plan

export interface GraphPlanRunInput {
  name: string;
  type: string;
  label?: string;
  description?: string;
  required: boolean;
}

export interface GraphPlanRunOutput extends GraphPlanRunInput {
  from: GraphPortRef;
}

export interface GraphPlanAcknowledgementRef {
  kind: GraphAcknowledgementKind;
  digest: string;
  code: string;
  nodeId: string;
}

export interface GraphCompileCostNode {
  nodeId: string;
  kind: GraphNodeKind;
  branches: GraphPlanBranches;
  attempts: number;
  /** `maxIterations` of the node's loop, else 1. */
  iterations: number;
  skippable: boolean;
  agentSessions: { best: number; worst: number };
  activations: { best: number; worst: number };
}

/** Report §7.4's cost estimate. */
export interface GraphCompileCost {
  agentSessions: { best: number; worst: number };
  /** Every node execution, agent or not (the 200-per-run hard cap). */
  activations: { best: number; worst: number };
  /** The most agent sessions that can run at once (an upper bound). */
  peakParallelism: number;
  /** Sub-graph nodes are not counted until item 402 inlines them. */
  incomplete: boolean;
  nodes: GraphCompileCostNode[];
}

export interface CompiledGraphPlan {
  format: typeof GRAPH_PLAN_FORMAT;
  formatVersion: typeof GRAPH_PLAN_FORMAT_VERSION;
  compilerVersion: typeof GRAPH_COMPILER_VERSION;
  /** SHA-256 hex over the canonical JSON of every other field. */
  digest: string;
  /** SHA-256 hex of the template itself, layout excluded (see `graphTemplateDigest`). */
  templateDigest: string;
  template: {
    id: string;
    revision: number;
    name: string;
    description?: string;
    engine?: GraphTemplateEngine;
  };
  parameters: GraphParameter[];
  roles: GraphRole[];
  /** The custom types the plan uses, by reference: runs keep them (report §5.12). */
  types: ArtifactTypeDef[];
  /** Every type reference the plan uses, built-in or custom, sorted. */
  typeRefs: string[];
  inputs: GraphPlanRunInput[];
  outputs: GraphPlanRunOutput[];
  workspace: GraphWorkspaceSpec;
  /** Node ids in topological order, ties by id. */
  order: string[];
  nodes: GraphPlanNode[];
  edges: GraphPlanEdge[];
  loops: GraphPlanLoop[];
  limits: {
    maxAgentSessions: number;
    maxConcurrentAgents: number;
    maxTokens?: number;
    maxWallClockMs?: number;
  };
  cost: GraphCompileCost;
  acknowledgements: {
    /** Warnings the template acknowledged. */
    accepted: GraphPlanAcknowledgementRef[];
    /** Warnings still waiting for an acknowledgement; launch needs none. */
    pending: GraphPlanAcknowledgementRef[];
  };
  /** What the capability policies were compiled over. */
  context: {
    ceiling: GraphCapabilityCeiling;
    environment: NativeAgentExecutionPolicy;
  };
}

// ---------------------------------------------------------------- digests

/** A deep copy without `undefined` values: what a plan may contain. */
export function graphPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The plan digest: SHA-256 over the canonical JSON of the plan without `digest`. */
export function graphPlanDigest(
  plan: Omit<CompiledGraphPlan, "digest"> | CompiledGraphPlan,
): string {
  const { digest: _digest, ...rest } = plan as CompiledGraphPlan;
  return sha256Hex(canonicalJson(rest, 128));
}

/** Whether a stored plan still matches its digest. */
export function verifyGraphPlanDigest(plan: CompiledGraphPlan): boolean {
  try {
    return plan.digest === graphPlanDigest(plan);
  } catch {
    return false;
  }
}

/**
 * The template's own digest: canonical JSON without the designer data
 * (`layout`, `mockPins`), with nodes, edges and loops sorted by id and types
 * by reference, so reordering them, moving nodes on the canvas or pinning
 * mock outputs keeps it. Independent of compile options, so
 * it suits trust records (item 109).
 */
export function graphTemplateDigest(template: GraphTemplateV1): string {
  const { layout: _layout, mockPins: _mockPins, ...rest } = template;
  const byId = <T extends { id: string }>(list: readonly T[] | undefined) =>
    list === undefined ? undefined : [...list].sort((a, b) => compareStrings(a.id, b.id));
  const sorted = graphPlainJson({
    ...rest,
    nodes: byId(rest.nodes),
    edges: byId(rest.edges),
    loops: byId(rest.loops),
    types:
      rest.types === undefined
        ? undefined
        : [...rest.types].sort((a, b) =>
            compareStrings(`${a.name}@${a.version}`, `${b.name}@${b.version}`),
          ),
  });
  return sha256Hex(canonicalJson(sorted, 128));
}

/** A warning's digest: what an acknowledgement records (template `acknowledgements`). */
export function graphWarningDigest(facts: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(graphPlainJson(facts)));
}

/** Code-unit order, as canonical JSON sorts keys. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deep-freeze a plan, for callers that keep it in memory. */
export function freezeCompiledGraphPlan(plan: CompiledGraphPlan): Readonly<CompiledGraphPlan> {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(plan);
  return plan;
}
