/**
 * Shared state of one compile: the template indexed by id, the type
 * library, the diagnostics, and what each pass computes for the next.
 *
 * Passes (compile-refs, compile-graph, compile-ports, compile-agents,
 * compile-workspace, compile-taint, cost, lint) read and fill this object in
 * a fixed order; `compile.ts` runs them and assembles the plan.
 */
import { AGENT_PLATFORMS, type AgentPlatform } from "../agent-platforms.js";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import type { ArtifactTypeDef } from "./artifact-type-def.js";
import {
  type AgentEnforcementHost,
  type CompiledGraphCapabilities,
  DEFAULT_GRAPH_CAPABILITY_CEILING,
  type GraphCapabilityCeiling,
} from "./capability-profiles.js";
import {
  type GraphCompileDiagnosticCode,
  GraphCompileDiagnostics,
  type GraphDiagnosticLocation,
} from "./compile-diagnostics.js";
import {
  type GraphPlanAcknowledgementRef,
  type GraphPlanBranches,
  type GraphPlanEdgeIterations,
  graphWarningDigest,
} from "./plan.js";
import { GRAPH_PROMPT_INPUT_CEILING_BYTES } from "./prompt-size.js";
import {
  type GraphAcknowledgementKind,
  type GraphEdgeSource,
  type GraphEdgeSpec,
  type GraphLoopCarry,
  type GraphLoopRegion,
  type GraphNodeSpec,
  type GraphRole,
  type GraphRunInputSpec,
  type GraphSystemAction,
  type GraphTemplateV1,
  type GraphWorkspaceAccess,
  isGraphRunInputRef,
} from "./template-model.js";
import { GraphTypeLibrary, type GraphValueType } from "./types.js";

// ---------------------------------------------------------------- options

export interface GraphCompileOptions {
  /**
   * Custom types from outside the template (a user's type library). The
   * template's own `types` come first; a library type with the same
   * reference must be identical (`type-conflict`). Types the plan uses are
   * copied into it either way.
   */
  types?: readonly ArtifactTypeDef[];
  /**
   * The agent platforms the user has enabled. A node whose enforcement floor
   * none of them meets is an error. Default: every platform.
   */
  providers?: readonly AgentPlatform[];
  /** The project's capability ceiling (D18). Default: no extra denials. */
  ceiling?: GraphCapabilityCeiling;
  /**
   * The environment's resolved execution policy, which capability profiles
   * narrow. Default {@link GRAPH_COMPILE_DEFAULT_ENVIRONMENT}: a workflow
   * session that denies nothing, for compiling at design time.
   */
  environment?: NativeAgentExecutionPolicy;
  /**
   * What the host offers providers' sandboxes, for the enforcement matrix.
   * Default {@link GRAPH_COMPILE_DEFAULT_HOST}: no Claude command sandbox,
   * the conservative answer when nobody has probed.
   */
  host?: AgentEnforcementHost;
  /** Nominal rendered-input bytes per prompt before a warning; default 160 KiB. */
  promptCeilingBytes?: number;
}

export const GRAPH_COMPILE_DEFAULT_ENVIRONMENT: Readonly<NativeAgentExecutionPolicy> =
  Object.freeze({
    id: "pipeline",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: true,
    networkAccess: "full",
  });

export const GRAPH_COMPILE_DEFAULT_HOST: Readonly<AgentEnforcementHost> = Object.freeze({
  claudeSandbox: false,
});

export interface ResolvedGraphCompileOptions {
  types: readonly ArtifactTypeDef[];
  providers: readonly AgentPlatform[];
  ceiling: GraphCapabilityCeiling;
  environment: NativeAgentExecutionPolicy;
  host: AgentEnforcementHost;
  promptCeilingBytes: number;
}

export function resolveGraphCompileOptions(
  options: GraphCompileOptions = {},
): ResolvedGraphCompileOptions {
  return {
    types: options.types ?? [],
    providers: options.providers ?? AGENT_PLATFORMS,
    ceiling: options.ceiling ?? DEFAULT_GRAPH_CAPABILITY_CEILING,
    environment: options.environment ?? GRAPH_COMPILE_DEFAULT_ENVIRONMENT,
    host: options.host ?? GRAPH_COMPILE_DEFAULT_HOST,
    promptCeilingBytes: options.promptCeilingBytes ?? GRAPH_PROMPT_INPUT_CEILING_BYTES,
  };
}

// ---------------------------------------------------------------- entries

export interface GraphNodeEntry {
  node: GraphNodeSpec;
  index: number;
  path: string;
}

/** An edge or a loop carry feeding an input port. */
export interface GraphProducer {
  kind: "edge" | "carry";
  /** Edge id, or `<loopId>#<index>` for a carry. */
  id: string;
  from: GraphEdgeSource;
  /** The producing node; undefined for a run input. */
  sourceNode?: string;
  /** The edge, for `kind: "edge"`. */
  edge?: GraphEdgeSpec;
  carry?: GraphLoopCarry;
  loopId?: string;
  /** Template path of the edge or carry. */
  path: string;
  at: GraphDiagnosticLocation;
}

/** What the port passes computed for one edge or carry. */
export interface GraphProducerTypes {
  source: GraphValueType | null;
  delivered: GraphValueType | null;
  budgetCheck: boolean;
  fanIn: boolean;
}

/** `node.port`: ids are kebab-case and ports identifiers, so the key is unambiguous. */
export const portKey = (node: string, port: string) => `${node}.${port}`;

/** Where a run input or node port is: for messages. */
export function graphSourceLabel(source: GraphEdgeSource): string {
  if (isGraphRunInputRef(source)) return `run input ${source.input}`;
  return source.outlet === undefined
    ? `${source.node}.${source.port}`
    : `${source.node}[${source.outlet}].${source.port}`;
}

/**
 * The workspace access of a system action (report §6.6, §6.7): preparing the
 * environment writes it; validation runs commands against it and pushes and
 * pull requests read the commit; the rest do not touch it.
 */
export const GRAPH_SYSTEM_ACTION_WORKSPACE: Readonly<
  Record<GraphSystemAction, GraphWorkspaceAccess>
> = Object.freeze({
  "prepare-environment": "write",
  "run-validation": "read",
  "run-validation-and-seal": "read",
  "push-branch": "read",
  "open-pull-request": "read",
  "wait-for-checks": "none",
  "update-ticket": "none",
  notify: "none",
});

export function graphNodeWorkspaceAccess(node: GraphNodeSpec): GraphWorkspaceAccess {
  switch (node.kind) {
    case "agent":
      return node.workspaceAccess;
    case "system":
      return GRAPH_SYSTEM_ACTION_WORKSPACE[node.action];
    // A sub-graph may hold writers; until item 402 inlines it, assume it does.
    case "subgraph":
      return "write";
    default:
      return "none";
  }
}

// ---------------------------------------------------------------- state

export class GraphCompileState {
  readonly diagnostics = new GraphCompileDiagnostics();
  readonly library: GraphTypeLibrary;
  /** Custom types by reference, template first. */
  readonly customTypes = new Map<string, ArtifactTypeDef>();
  readonly nodes = new Map<string, GraphNodeEntry>();
  readonly roles = new Map<string, GraphRole>();
  readonly runInputs = new Map<string, { spec: GraphRunInputSpec; index: number }>();
  readonly loops = new Map<string, { loop: GraphLoopRegion; index: number }>();
  /** Member → loop (the first loop that lists it; overlaps are errors). */
  readonly loopOf = new Map<string, string>();

  /** Edges whose endpoints resolve, in template order. */
  readonly edges: Array<{ edge: GraphEdgeSpec; index: number }> = [];
  /** Carries whose endpoints resolve. */
  readonly carries: GraphProducer[] = [];
  /** Producers per input port (`portKey`). */
  readonly producers = new Map<string, GraphProducer[]>();

  /** Declared port types (`portKey`); null when the reference does not resolve. */
  readonly inputTypes = new Map<string, GraphValueType | null>();
  readonly outputTypes = new Map<string, GraphValueType | null>();
  readonly runInputTypes = new Map<string, GraphValueType | null>();
  /** Per edge id or carry id. */
  readonly producerTypes = new Map<string, GraphProducerTypes>();
  /** Delivered type per input port (`portKey`). */
  readonly deliveredTypes = new Map<string, GraphValueType | null>();
  /** Input ports fed by a replicated producer without zip. */
  readonly fanInPorts = new Set<string>();

  readonly branches = new Map<string, GraphPlanBranches>();
  readonly replicateSignatures = new Map<string, string>();

  /** Topological order (ties by id); null when edges form a cycle. */
  order: string[] | null = null;
  /** Nodes reachable from each node over edges. */
  readonly descendants = new Map<string, Set<string>>();
  /** Gate and human outlets (`gate:outlet`) each node needs taken. */
  readonly conditions = new Map<string, Set<string>>();
  /** Loop members that cannot run on iteration 1. */
  readonly laterOnly = new Set<string>();
  readonly edgeIterations = new Map<string, GraphPlanEdgeIterations>();
  readonly skippable = new Set<string>();

  readonly capabilities = new Map<string, CompiledGraphCapabilities>();
  /** Effective enforcement floor per agent node. */
  readonly floors = new Map<string, "enforced" | "provider-configured" | "advisory">();
  readonly floorLowered = new Set<string>();

  /** Warnings that need an acknowledgement, by outcome. */
  readonly acknowledgements: {
    accepted: GraphPlanAcknowledgementRef[];
    pending: GraphPlanAcknowledgementRef[];
  } = { accepted: [], pending: [] };

  constructor(
    readonly template: GraphTemplateV1,
    readonly options: ResolvedGraphCompileOptions,
  ) {
    const defs: ArtifactTypeDef[] = [];
    for (const def of [...(template.types ?? []), ...options.types]) {
      const ref = `${def.name}@${def.version}`;
      if (this.customTypes.has(ref)) continue;
      this.customTypes.set(ref, def);
      defs.push(def);
    }
    this.library = new GraphTypeLibrary(defs);
    template.nodes.forEach((node, index) =>
      this.nodes.set(node.id, { node, index, path: `nodes[${index}]` }),
    );
    for (const role of template.roles) this.roles.set(role.key, role);
    template.inputs.forEach((spec, index) => this.runInputs.set(spec.name, { spec, index }));
    (template.loops ?? []).forEach((loop, index) => this.loops.set(loop.id, { loop, index }));
  }

  nodeAt(id: string): GraphDiagnosticLocation {
    const entry = this.nodes.get(id);
    return entry ? { nodeId: id, path: entry.path } : { nodeId: id };
  }

  /** Producers into one input port. */
  producersOf(node: string, port: string): GraphProducer[] {
    return this.producers.get(portKey(node, port)) ?? [];
  }

  addProducer(node: string, port: string, producer: GraphProducer): void {
    const key = portKey(node, port);
    const list = this.producers.get(key);
    if (list) list.push(producer);
    else this.producers.set(key, [producer]);
  }

  isReplicated(node: string): boolean {
    const entry = this.nodes.get(node)?.node;
    return (entry?.kind === "agent" || entry?.kind === "subgraph") && entry.replicate !== undefined;
  }

  /**
   * Report a warning the user must acknowledge (D4, report §5.13). Its digest
   * is SHA-256 over the canonical JSON of `facts` with the kind and code, so
   * an unrelated edit keeps it and a change to what is warned about needs a
   * new acknowledgement. An acknowledged warning is reported as `info`.
   */
  requireAcknowledgement(
    kind: GraphAcknowledgementKind,
    code: GraphCompileDiagnosticCode,
    message: string,
    at: GraphDiagnosticLocation & { nodeId: string },
    facts: Record<string, unknown>,
  ): void {
    const digest = graphWarningDigest({ kind, code, ...facts });
    const accepted = (this.template.acknowledgements ?? []).some(
      (entry) => entry.kind === kind && entry.digest === digest,
    );
    const ref = { kind, digest, code, nodeId: at.nodeId };
    (accepted ? this.acknowledgements.accepted : this.acknowledgements.pending).push(ref);
    this.diagnostics.add(
      code,
      accepted
        ? `${message} (acknowledged)`
        : `${message} Acknowledge it (${kind}, digest ${digest}) to launch.`,
      { ...at, acknowledgement: { kind, digest, accepted } },
      accepted ? "info" : undefined,
    );
  }

  /** Acknowledgements that match no current warning. */
  reportStaleAcknowledgements(): void {
    const live = new Set(
      [...this.acknowledgements.accepted].map((ref) => `${ref.kind}:${ref.digest}`),
    );
    (this.template.acknowledgements ?? []).forEach((entry, index) => {
      if (live.has(`${entry.kind}:${entry.digest}`)) return;
      this.diagnostics.add(
        "acknowledgement-stale",
        `The ${entry.kind} acknowledgement ${entry.digest.slice(0, 12)}… matches no current warning; the warning changed or went away`,
        { path: `acknowledgements[${index}]` },
      );
    });
  }

  /** Whether `a` reaches `b` over edges (false when the graph is cyclic). */
  reaches(a: string, b: string): boolean {
    return this.descendants.get(a)?.has(b) ?? false;
  }
}
