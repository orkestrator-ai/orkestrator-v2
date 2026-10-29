/**
 * The graph template model, version 1 (plan P1.1, report §4.5).
 *
 * A template is what a user designs: parameters, roles, custom types, run
 * inputs, nodes with typed ports, typed edges, loop regions, limits and a
 * designer layout. The compiler (item 107) turns it into a frozen plan. Import
 * these names through `@orkestrator/protocol/graphs/template`, which re-exports
 * this module beside the guard.
 */
import type { ActionDefaultKey } from "../action-defaults.js";
import { NATIVE_AGENT_CAPABILITIES } from "../native-agent.js";
import type { ArtifactTypeDef } from "./artifact-type-def.js";
import type { GraphPredicate } from "./predicate-shape.js";

export const GRAPH_TEMPLATE_FORMAT = "orkestrator.graph";
export const GRAPH_TEMPLATE_FORMAT_VERSION = 1;

/** Where a template lives (D2). */
export const GRAPH_TEMPLATE_SCOPES = ["builtin", "user", "project"] as const;
export type GraphTemplateScope = (typeof GRAPH_TEMPLATE_SCOPES)[number];

/** Built-in templates that describe a flow running on its own engine (D5, P1.8). */
export const GRAPH_TEMPLATE_ENGINES = ["multi-review", "build-pipeline", "looped-review"] as const;
export type GraphTemplateEngine = (typeof GRAPH_TEMPLATE_ENGINES)[number];

// ---------------------------------------------------------------- parameters

export const GRAPH_PARAMETER_TYPES = ["boolean", "integer", "number", "string", "enum"] as const;
export type GraphParameterType = (typeof GRAPH_PARAMETER_TYPES)[number];

interface GraphParameterBase {
  /** Identifier; prompts and predicates read it as `params.<key>`. */
  key: string;
  label?: string;
  description?: string;
}

export interface GraphBooleanParameter extends GraphParameterBase {
  type: "boolean";
  default?: boolean;
}

export interface GraphIntegerParameter extends GraphParameterBase {
  type: "integer";
  default?: number;
  min?: number;
  max?: number;
}

export interface GraphNumberParameter extends GraphParameterBase {
  type: "number";
  default?: number;
  min?: number;
  max?: number;
}

export interface GraphStringParameter extends GraphParameterBase {
  type: "string";
  default?: string;
  /** At most `maxStringParameterBytes`; the launcher enforces it on input. */
  maxBytes?: number;
}

export interface GraphEnumParameter extends GraphParameterBase {
  type: "enum";
  options: string[];
  default?: string;
}

/** A launch-time knob. Without a `default`, the launcher must ask for a value. */
export type GraphParameter =
  | GraphBooleanParameter
  | GraphIntegerParameter
  | GraphNumberParameter
  | GraphStringParameter
  | GraphEnumParameter;

// --------------------------------------------------------------------- roles

export const GRAPH_ROLE_MULTIPLICITIES = ["one", "panel"] as const;
export type GraphRoleMultiplicity = (typeof GRAPH_ROLE_MULTIPLICITIES)[number];

/** The saved action defaults a role may start from (plan P1.1). */
export const GRAPH_ROLE_DEFAULT_ACTION_KEYS = [
  "review",
  "review2",
  "reviewPreparation",
  "fixReviewIssues",
  "verify",
  "pr",
  "resolve",
] as const satisfies readonly ActionDefaultKey[];
export type GraphRoleDefaultActionKey = (typeof GRAPH_ROLE_DEFAULT_ACTION_KEYS)[number];

/**
 * Panel-only default source: positions beyond the ones named by action keys
 * come from `MultiReviewAgentSettings.additionalReviewers`. It may appear only
 * last, and only on a panel role.
 */
export const GRAPH_ROLE_PANEL_DEFAULT_SOURCES = ["additionalReviewers"] as const;
export type GraphRolePanelDefaultSource = (typeof GRAPH_ROLE_PANEL_DEFAULT_SOURCES)[number];
export type GraphRoleDefaultSource = GraphRoleDefaultActionKey | GraphRolePanelDefaultSource;

/** A model slot bound at launch. */
export interface GraphRole {
  key: string;
  label?: string;
  description?: string;
  multiplicity: GraphRoleMultiplicity;
  /** Panel roles only; at most `maxBranches` (32, today's reviewer cap). */
  maxPanel?: number;
  /** In order: one position per action key, then `additionalReviewers`. */
  defaultsFrom?: GraphRoleDefaultSource[];
}

// --------------------------------------------------------------------- ports

/** How an input reaches the prompt (report §5.6, D13). */
export const GRAPH_RENDER_MODES = [
  "json-frame",
  "markdown",
  "summary",
  "file",
  "on-demand",
] as const;
export type GraphRenderMode = (typeof GRAPH_RENDER_MODES)[number];

export const GRAPH_COLLECT_WAITS = ["all-settled", "quorum", "first"] as const;
export type GraphCollectWait = (typeof GRAPH_COLLECT_WAITS)[number];

/** Fan-in wait policy on a `list<T>` input fed by a replicated node (report §4.4). */
export interface GraphCollectPolicy {
  /** `first` cancels the remaining branches once `count` have succeeded. */
  wait: GraphCollectWait;
  /** Required for `quorum`; optional for `first` (default 1); absent for `all-settled`. */
  count?: number;
  /** Fewer successful branches fail the port. */
  minSuccessful: number;
  /** Pass failure markers downstream. */
  includeFailures: boolean;
}

export const GRAPH_PROVENANCE_MODES = ["cite", "accountForAll"] as const;
export type GraphProvenanceMode = (typeof GRAPH_PROVENANCE_MODES)[number];

/** A run input: `{ input: "target" }`. */
export interface GraphRunInputRef {
  input: string;
}

/**
 * A node's output port. `outlet` selects one outlet of a gate or human node:
 * the port is then one of that node's *inputs*, forwarded when the outlet is
 * taken (`{ node: "has-issues", outlet: "clean", port: "code" }`).
 */
export interface GraphPortRef {
  node: string;
  port: string;
  outlet?: string;
}

/** The producing end of an edge: a node port or a run input. */
export type GraphEdgeSource = GraphPortRef | GraphRunInputRef;

/** The consuming end of an edge: a node's input port. */
export interface GraphPortTarget {
  node: string;
  port: string;
}

export interface GraphInputPortSpec {
  /** Identifier; the prompt partial is `{{> input.<name>}}`. */
  name: string;
  /** `name@major`, or `list<name@major>` for fan-in. */
  type: string;
  label?: string;
  description?: string;
  /** Default true. An optional input may stay unbound. */
  required?: boolean;
  render?: GraphRenderMode;
  /** List-typed inputs only. */
  collect?: GraphCollectPolicy;
  /**
   * Inside a loop: iteration 1 reads the edge from this source, later
   * iterations read the other edge into this port (report §9.2).
   */
  firstIterationFrom?: GraphEdgeSource;
}

export interface GraphOutputPortSpec {
  /** Identifier; the result tool is `submit_<name>`. */
  name: string;
  type: string;
  label?: string;
  /** Shown to the model in the submit tool's description. */
  description?: string;
  /** Default true: the node completes when every required output is accepted. */
  required?: boolean;
  /** Outputs of a consolidating node (report §5.9). */
  provenance?: GraphProvenanceMode;
  /**
   * `decision@N` outputs only: the options `choice` must be one of (report
   * §5.3), such as a gate's branch values or the lens keys being judged.
   */
  choices?: string[];
}

// ----------------------------------------------------------------- execution

export const GRAPH_RETRY_CAUSES = ["provider-error", "invalid-result", "timeout"] as const;
export type GraphRetryCause = (typeof GRAPH_RETRY_CAUSES)[number];

export interface GraphRetryPolicy {
  /** Total attempts, the first included. */
  attempts: number;
  on: GraphRetryCause[];
}

/** `route` emits `error@1` on the node's `error` port. */
export const GRAPH_FAILURE_POLICIES = ["fail-run", "skip", "route"] as const;
export type GraphFailurePolicy = (typeof GRAPH_FAILURE_POLICIES)[number];

// -------------------------------------------------------------- capabilities

export const GRAPH_WORKSPACE_ACCESS = ["none", "read", "write"] as const;
export type GraphWorkspaceAccess = (typeof GRAPH_WORKSPACE_ACCESS)[number];

export const GRAPH_ENFORCEMENT_TIERS = ["enforced", "provider-configured", "advisory"] as const;
export type GraphEnforcementTier = (typeof GRAPH_ENFORCEMENT_TIERS)[number];

/** Capability profiles (report §6.2). There is no `shipper` (D12). */
export const GRAPH_CAPABILITY_PROFILES = [
  "observer",
  "reviewer",
  "verifier",
  "researcher",
  "builder",
  "custom",
] as const;
export type GraphCapabilityProfileId = (typeof GRAPH_CAPABILITY_PROFILES)[number];

/**
 * Plain capability names: today's native set plus the additions of report
 * §6.3. The schema accepts `git.push` and `github.write` so the compiler can
 * reject them on agent nodes with a pinned diagnostic (D12).
 */
export const GRAPH_CAPABILITIES = [
  ...new Set([
    ...NATIVE_AGENT_CAPABILITIES,
    "git.commit",
    "git.push",
    "github.write",
    "subagents",
  ] as const),
];
export type GraphPlainCapability =
  | (typeof NATIVE_AGENT_CAPABILITIES)[number]
  | "git.commit"
  | "git.push"
  | "github.write"
  | "subagents";

/** Backend-enforced Orkestrator tool groups: `orkestrator:<group>`. */
export const GRAPH_ORKESTRATOR_CAPABILITY_GROUPS = [
  "tickets.read",
  "tickets.write",
  "mail",
  "artifacts",
  "schedules",
] as const;
export type GraphOrkestratorCapabilityGroup = (typeof GRAPH_ORKESTRATOR_CAPABILITY_GROUPS)[number];

/** `mcp:<server>` (deny only until item 404) and `orkestrator:<group>`. */
export type GraphCapabilityName =
  GraphPlainCapability | `mcp:${string}` | `orkestrator:${GraphOrkestratorCapabilityGroup}`;

/** A profile plus node overrides; overrides only narrow (`allow` carves from a denial). */
export interface GraphCapabilitySpec {
  profile: GraphCapabilityProfileId;
  allow?: GraphCapabilityName[];
  deny?: GraphCapabilityName[];
}

// --------------------------------------------------------------------- nodes

export const GRAPH_NODE_KINDS = ["agent", "system", "gate", "merge", "human", "subgraph"] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

interface GraphNodeCommon {
  /** Kebab-case id, unique in the template. */
  id: string;
  label?: string;
  description?: string;
  inputs?: GraphInputPortSpec[];
  /** Skip unless true; a skipped node emits a `skipped` marker. */
  when?: GraphPredicate;
}

interface GraphNodeExecution {
  retry?: GraphRetryPolicy;
  timeoutMs?: number;
  onFailure?: GraphFailurePolicy;
}

/** A user template, or a built-in prompt by id (resolved by item 105). */
export type GraphPromptSpec = { builtIn: string } | { template: string };

export type GraphSessionSpec = { mode: "fresh" } | { mode: "continue"; from: string };

export interface GraphLens {
  key: string;
  label: string;
  instruction: string;
  /** A per-lens role; otherwise the node's role. */
  role?: string;
}

export const GRAPH_REPLICATE_SOURCES = ["panel", "lenses", "items", "samples"] as const;
export type GraphReplicateSource = (typeof GRAPH_REPLICATE_SOURCES)[number];

/** One fan-out source (report §4.4, D9). */
export type GraphReplicateAxis =
  | { over: "panel"; role: string }
  | { over: "lenses"; lenses: GraphLens[] }
  | { over: "items"; input: string; maxBranches: number }
  | { over: "samples"; count: number };

/** Combined sources: the branch set is the product, keys joined in axis order. */
export interface GraphReplicateCross {
  over: "cross";
  axes: GraphReplicateAxis[];
}

export type GraphReplicate = GraphReplicateAxis | GraphReplicateCross;

export interface GraphAgentNode extends GraphNodeCommon, GraphNodeExecution {
  kind: "agent";
  outputs?: GraphOutputPortSpec[];
  role: string;
  prompt: GraphPromptSpec;
  capabilities: GraphCapabilitySpec;
  workspaceAccess: GraphWorkspaceAccess;
  minEnforcement?: GraphEnforcementTier;
  session?: GraphSessionSpec;
  replicate?: GraphReplicate;
  /** Opt into the `ask_human` tool (D15); otherwise the node runs unattended. */
  askHuman?: boolean;
}

/** System actions, version 1 (plan P2.7), plus `run-validation` (report §9.4). */
export const GRAPH_SYSTEM_ACTIONS = [
  "prepare-environment",
  "run-validation",
  "run-validation-and-seal",
  "push-branch",
  "open-pull-request",
  "wait-for-checks",
  "update-ticket",
  "notify",
] as const;
export type GraphSystemAction = (typeof GRAPH_SYSTEM_ACTIONS)[number];

export type GraphScalarValue = string | number | boolean | null;
/** System action params; each action's own rules belong to its executor (item 207). */
export type GraphSystemParamValue = GraphScalarValue | GraphScalarValue[];

export interface GraphSystemNode extends GraphNodeCommon, GraphNodeExecution {
  kind: "system";
  outputs?: GraphOutputPortSpec[];
  action: GraphSystemAction;
  params?: Record<string, GraphSystemParamValue>;
}

export interface GraphGateBranch {
  /** The outlet taken when `when` holds; branches are tried in order. */
  to: string;
  when: GraphPredicate;
  label?: string;
}

/**
 * Routes on a predicate. Each outlet forwards every input of the gate, so an
 * edge reads `{ node, outlet, port }`; untaken outlets mark their consumers
 * skipped. A gate declares no outputs of its own.
 */
export interface GraphGateNode extends GraphNodeCommon {
  kind: "gate";
  branches: GraphGateBranch[];
  otherwise?: string;
}

export const GRAPH_MERGE_STRATEGIES = ["concat", "dedupe", "vote", "best", "collect"] as const;
export type GraphMergeStrategyKind = (typeof GRAPH_MERGE_STRATEGIES)[number];

export const GRAPH_VOTE_TIE_POLICIES = ["fail", "first"] as const;
export type GraphVoteTiePolicy = (typeof GRAPH_VOTE_TIE_POLICIES)[number];

export type GraphMergeStrategy =
  | { kind: "concat" }
  /** Items with the same key fold together, keeping every source id. */
  | { kind: "dedupe"; key: string[] }
  /** Majority over decisions; `path` defaults to `choice`. */
  | { kind: "vote"; tie: GraphVoteTiePolicy; path?: string }
  | { kind: "best"; score: string; prefer?: "highest" | "lowest" }
  | { kind: "collect" };

export interface GraphMergeNode extends GraphNodeCommon {
  kind: "merge";
  outputs?: GraphOutputPortSpec[];
  strategy: GraphMergeStrategy;
  onFailure?: GraphFailurePolicy;
}

export const GRAPH_HUMAN_FORMS = ["approve", "edit", "choose"] as const;
export type GraphHumanFormKind = (typeof GRAPH_HUMAN_FORMS)[number];

/** Outlets of `approve` and `edit` forms. */
export const GRAPH_HUMAN_APPROVAL_OUTLETS = ["approved", "rejected"] as const;

export interface GraphHumanChoice {
  /** The outlet this choice takes. */
  to: string;
  label: string;
  description?: string;
}

export type GraphHumanForm =
  | { kind: "approve"; instructions?: string }
  /** `edit` names the input the user may edit; `approved` carries the edited value. */
  | { kind: "edit"; edit: string; instructions?: string }
  | { kind: "choose"; options: GraphHumanChoice[]; instructions?: string };

/**
 * A person approves, edits or chooses (P2.8). Outlets forward the inputs as a
 * gate's do. Without `timeoutMs` the run waits, paused rather than failed.
 */
export interface GraphHumanNode extends GraphNodeCommon {
  kind: "human";
  form: GraphHumanForm;
  timeoutMs?: number;
  onFailure?: GraphFailurePolicy;
}

export interface GraphTemplateRef {
  scope: GraphTemplateScope;
  id: string;
  /** Pin a revision; otherwise the latest at compile time. */
  revision?: number;
}

/** A literal, or pass-through of one of this template's parameters. */
export type GraphParameterBinding = GraphScalarValue | { param: string };

/**
 * Another template as one node (Phase 4, item 402). Its inputs and outputs
 * name the inner template's run inputs and outputs. The schema accepts it;
 * the compiler rejects it until 402 ships.
 */
export interface GraphSubgraphNode extends GraphNodeCommon, GraphNodeExecution {
  kind: "subgraph";
  outputs?: GraphOutputPortSpec[];
  template: GraphTemplateRef;
  /** Inner parameter key → value or `{ param }` of this template. */
  params?: Record<string, GraphParameterBinding>;
  /** Inner role key → this template's role key. */
  roles?: Record<string, string>;
  replicate?: GraphReplicate;
}

export type GraphNodeSpec =
  | GraphAgentNode
  | GraphSystemNode
  | GraphGateNode
  | GraphMergeNode
  | GraphHumanNode
  | GraphSubgraphNode;

// --------------------------------------------------------------------- edges

export const GRAPH_EDGE_TRANSFORM_OPS = ["pick", "filter", "limit", "flatten", "adapt"] as const;
export type GraphEdgeTransformOp = (typeof GRAPH_EDGE_TRANSFORM_OPS)[number];

/** Declarative, bounded edge transforms (report §5.7, D14), applied in order. */
export type GraphEdgeTransform =
  | { op: "pick"; fields: string[] }
  /** Keep list elements matching an element-relative predicate. */
  | { op: "filter"; where: GraphPredicate }
  | { op: "limit"; count: number }
  /** Concatenate the list at `path` of every element (or of a single value). */
  | { op: "flatten"; path: string }
  /** A named built-in adapter (item 102), such as `review-report-to-finding-list`. */
  | { op: "adapt"; adapter: string };

/** Every edge is typed by its ports and carries an artifact (D8). */
export interface GraphEdgeSpec {
  id: string;
  from: GraphEdgeSource;
  to: GraphPortTarget;
  transform?: GraphEdgeTransform[];
  /** Replicated → replicated over the same branch keys: branch k feeds branch k. */
  zip?: boolean;
}

// --------------------------------------------------------------------- loops

export interface GraphLoopCarry {
  from: GraphPortRef;
  to: GraphPortTarget;
}

/** A bounded loop region (report §4.4). */
export interface GraphLoopRegion {
  id: string;
  label?: string;
  nodes: string[];
  until: GraphPredicate;
  maxIterations: number;
  /** Back edges from one iteration into the next. */
  carry: GraphLoopCarry[];
}

// ----------------------------------------------------------- run inputs/outputs

export interface GraphRunInputSpec {
  name: string;
  type: string;
  label?: string;
  description?: string;
  /** Default true. */
  required?: boolean;
}

/** A template output: what a run returns, and what a subgraph node exposes. */
export interface GraphRunOutputSpec {
  name: string;
  type: string;
  label?: string;
  description?: string;
  /** Default true. An optional output may come from a skipped node. */
  required?: boolean;
  from: GraphPortRef;
}

// ------------------------------------------------------- workspace and limits

export const GRAPH_ENVIRONMENT_KINDS = ["worktree", "container"] as const;
export type GraphEnvironmentKind = (typeof GRAPH_ENVIRONMENT_KINDS)[number];

/** One environment per run (D7), or none. `create` is the launcher's default. */
export type GraphWorkspaceSpec =
  { kind: "environment"; create?: { kind: GraphEnvironmentKind } } | { kind: "none" };

export interface GraphLimits {
  /** The compile-time worst case must fit; at most 200. */
  maxAgentSessions: number;
  /** Runtime admission; at most the fan-out cap (32). */
  maxConcurrentAgents: number;
  /** Soft runtime meter. */
  maxTokens?: number;
  maxWallClockMs?: number;
}

export interface GraphLayoutPoint {
  x: number;
  y: number;
}

// ------------------------------------------------------------ acknowledgements

/**
 * Warnings a user accepted: taint reaching a side effect (§5.13) and a lowered
 * enforcement floor (D4). Each is keyed by the compiler's warning digest, so a
 * change that alters the warning needs a new acknowledgement.
 */
export const GRAPH_ACKNOWLEDGEMENT_KINDS = ["taint", "enforcement-floor"] as const;
export type GraphAcknowledgementKind = (typeof GRAPH_ACKNOWLEDGEMENT_KINDS)[number];

export interface GraphAcknowledgement {
  kind: GraphAcknowledgementKind;
  /** Lower-case SHA-256 hex of the warning, as the compiler prints it. */
  digest: string;
  /** RFC 3339 UTC timestamp. */
  acknowledgedAt: string;
  /** The diagnostic code acknowledged, for display. */
  code?: string;
  note?: string;
}

// ------------------------------------------------------------------ template

export interface GraphTemplateV1 {
  format: typeof GRAPH_TEMPLATE_FORMAT;
  formatVersion: typeof GRAPH_TEMPLATE_FORMAT_VERSION;
  /** Stable kebab-case slug: `multi-review`, `design-bake-off`. */
  id: string;
  /** Compare-and-swap revision; 0 for a template never saved. */
  revision: number;
  name: string;
  description?: string;
  /** Built-in descriptions of a flow that runs on its own engine. */
  engine?: GraphTemplateEngine;
  parameters: GraphParameter[];
  roles: GraphRole[];
  types?: ArtifactTypeDef[];
  inputs: GraphRunInputSpec[];
  outputs?: GraphRunOutputSpec[];
  workspace: GraphWorkspaceSpec;
  nodes: GraphNodeSpec[];
  edges: GraphEdgeSpec[];
  loops?: GraphLoopRegion[];
  limits: GraphLimits;
  /** Designer positions by node id; ignored by the compiler and digest. */
  layout?: Record<string, GraphLayoutPoint>;
  acknowledgements?: GraphAcknowledgement[];
}

/** The outlets a gate or human node exposes; undefined for other kinds. */
export function graphNodeOutlets(node: GraphNodeSpec): string[] | undefined {
  switch (node.kind) {
    case "gate":
      return [
        ...node.branches.map((branch) => branch.to),
        ...(node.otherwise === undefined ? [] : [node.otherwise]),
      ];
    case "human":
      return node.form.kind === "choose"
        ? node.form.options.map((option) => option.to)
        : [...GRAPH_HUMAN_APPROVAL_OUTLETS];
    default:
      return undefined;
  }
}

export function isGraphRunInputRef(source: GraphEdgeSource): source is GraphRunInputRef {
  return "input" in source;
}
