/**
 * The graph run record and its artifacts (plan P2.1, report §5.2, §5.4,
 * §5.11, §8.1): the shapes every runtime item (202–213) reads and writes.
 *
 * A run is one durable record per launch, saved with revision
 * compare-and-swap. It freezes the compiled plan at launch (invariant 2), so
 * editing or deleting a template never changes a run. Its activations are the
 * node executions, keyed `node#iter=…#branch=…#attempt=…`, and its rewinds the
 * restarts that superseded some of them. Nothing is deleted while the run
 * exists: a retry or rewind adds activations and artifacts and marks old ones
 * superseded (invariant 3), so every history here is bounded explicitly.
 *
 * Artifacts are the typed values on the edges (D8). They are immutable: the
 * envelope's identity covers its content, its producer and its lineage, and
 * only the `live`/`superseded` mark ever changes. A value artifact is stored
 * inline; a reference artifact is a sealed file in the environment under
 * `.orkestrator/graph-artifacts/<run-id>/`, hash-verified before each consumer.
 *
 * Browser-safe: no `node:`/`bun:` imports.
 */
import type { AgentPlatform } from "../agent-platforms.js";
import type { PipelineTranscriptReference } from "../build-pipeline.js";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import { GRAPH_TEMPLATE_BOUNDS } from "./grammar.js";
import type { CompiledGraphPlan } from "./plan.js";
import type { GraphEnforcementTier, GraphScalarValue } from "./template-model.js";
import type { GraphErrorCause } from "./types.js";
import type { GraphAgentSessionState } from "./run-agent-session.js";

const KIB = 1024;
const MIB = 1024 * KIB;

export const GRAPH_RUN_FORMAT = "orkestrator.graph-run";
/** Bumped only with a record upgrade (see `storage-record-upgrades.ts`). */
export const GRAPH_RUN_FORMAT_VERSION = 1;
export const GRAPH_ARTIFACT_FORMAT_VERSION = 1;

/** Every count and length a run record may reach (report §5.11, plan P2.1). */
export const GRAPH_RUN_BOUNDS = Object.freeze({
  /**
   * Activations that are not superseded: the per-run hard cap the compiler
   * checks the worst case against (`limit-activations`).
   */
  maxActivations: GRAPH_TEMPLATE_BOUNDS.maxAgentSessions,
  /** Every activation the record keeps, superseded ones included. */
  maxActivationHistory: 2_000,
  maxRewinds: 50,
  /** Activation and run errors, as today's pipeline sessions bound theirs. */
  maxErrorChars: 2_000,
  maxGuardResults: 8,
  maxGuardDetailChars: 512,
  maxGuardPaths: 32,
  /**
   * Uncommitted paths a baseline keeps by name (item 209). A larger set is
   * kept as its digest and count only, so the guard still detects a change
   * but cannot name the paths it touched.
   */
  maxBaselinePaths: 64,
  maxBaselinePathChars: 1_024,
  /** Remotes the remote-ref guard watches per activation. */
  maxBaselineUpstreamRefs: 8,
  /** Serialized UTF-8 size of a whole record, frozen plan included. */
  maxRecordBytes: 16 * MIB,
  /** Run, rewind and request ids. */
  maxIdChars: 128,
  maxActivationKeyChars: 256,
  maxBranchKeyChars: 96,
  /** An attempt number: retries plus restarts of one node position. */
  maxAttempt: 1_000,
  /** Short provider-facing strings: model, effort, transport, session id. */
  maxShortTextChars: 256,
  maxResultKeyChars: 128,
  /** Ports per activation and direction (template `maxPortsPerDirection`). */
  maxPorts: GRAPH_TEMPLATE_BOUNDS.maxPortsPerDirection,
  /** Artifact ids one list input may carry: a fan-in of at most 32 branches, each with retries. */
  maxPortArtifacts: 256,
  maxRoleBindings: GRAPH_TEMPLATE_BOUNDS.maxRoles,
  maxPanelBindings: GRAPH_TEMPLATE_BOUNDS.maxBranches,
  maxParams: GRAPH_TEMPLATE_BOUNDS.maxParameters,
  maxParamStringBytes: GRAPH_TEMPLATE_BOUNDS.maxStringParameterBytes,
  maxInputs: GRAPH_TEMPLATE_BOUNDS.maxRunInputs,
  maxLoops: GRAPH_TEMPLATE_BOUNDS.maxLoops,
  maxIteration: GRAPH_TEMPLATE_BOUNDS.maxLoopIterations,
} as const);

/** Per-run artifact budgets (report §5.2, §5.11). */
export const GRAPH_ARTIFACT_BUDGETS = Object.freeze({
  /** Inline bytes of every artifact of a run: values and reference descriptors. */
  maxInlineBytesPerRun: 32 * MIB,
  /** Sealed file bytes of every reference artifact of a run. */
  maxDiskBytesPerRun: 256 * MIB,
  /** One value artifact: the workflow-result cap. */
  maxValueBytes: GRAPH_TEMPLATE_BOUNDS.maxValueArtifactBytes,
  /** One reference artifact's file: the per-stream log cap. */
  maxReferenceBytes: GRAPH_TEMPLATE_BOUNDS.maxReferenceArtifactBytes,
  /** Artifacts per run, superseded ones included. */
  maxArtifactsPerRun: 8_192,
  /** Lineage entries of one artifact. */
  maxInputs: 256,
  maxItemIds: GRAPH_TEMPLATE_BOUNDS.maxArtifactItems,
  maxItemIdChars: 128,
} as const);

/**
 * Codes for a refused overrun, one per bound. The backend's typed storage
 * error carries one, with the limit and the amount asked for.
 */
export const GRAPH_RUN_LIMIT_CODES = [
  "activations",
  "activation-history",
  "rewinds",
  "record-bytes",
  "error-length",
  "inline-budget",
  "disk-budget",
  "value-bytes",
  "reference-bytes",
  "artifact-count",
  "artifact-inputs",
  "artifact-items",
] as const;
export type GraphRunLimitCode = (typeof GRAPH_RUN_LIMIT_CODES)[number];

export interface GraphRunLimitViolation {
  code: GraphRunLimitCode;
  limit: number;
  actual: number;
  message: string;
}

// ---------------------------------------------------------------- run

/**
 * `waiting`: a person must act (a human node, or an `ask_human` question);
 * the run is paused rather than failed (P2.8). `paused`: the user paused it.
 */
export const GRAPH_RUN_STATUSES = [
  "provisioning",
  "running",
  "waiting",
  "paused",
  "complete",
  "failed",
  "cancelling",
  "cancelled",
] as const;
export type GraphRunStatus = (typeof GRAPH_RUN_STATUSES)[number];
export const GRAPH_RUN_TERMINAL_STATUSES = [
  "complete",
  "failed",
  "cancelled",
] as const satisfies readonly GraphRunStatus[];

/** Where the launched template came from (D2). */
export const GRAPH_TEMPLATE_SCOPES = ["built-in", "user", "project"] as const;
export type GraphTemplateScope = (typeof GRAPH_TEMPLATE_SCOPES)[number];

export interface GraphRunTemplateRef {
  id: string;
  revision: number;
  /** `graphTemplateDigest` of the launched template; the plan carries it too. */
  digest: string;
  scope?: GraphTemplateScope;
}

/** One model a role is bound to at launch: the action-default shape with the platform resolved. */
export interface GraphModelBinding {
  platform: AgentPlatform;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export interface GraphRunBindings {
  /** Role key → its model, or the panel's models (multiplicity `panel`). */
  roles: Record<string, GraphModelBinding | GraphModelBinding[]>;
  /** Launch parameter values (defaults filled in by the launcher). */
  params: Record<string, GraphScalarValue>;
  /** Run input name → the artifact id the launcher stored for it. */
  inputs: Record<string, string>;
}

export interface GraphRunUsage {
  agentSessions: number;
  tokens: number;
  cacheReadTokens?: number;
}

export interface GraphRun {
  format: typeof GRAPH_RUN_FORMAT;
  formatVersion: typeof GRAPH_RUN_FORMAT_VERSION;
  id: string;
  projectId: string;
  /** Absent only while a run that creates its environment provisions it (D7). */
  environmentId?: string;
  template: GraphRunTemplateRef;
  /** Frozen at launch; `verifyGraphPlanDigest` must hold on every load. */
  plan: CompiledGraphPlan;
  bindings: GraphRunBindings;
  status: GraphRunStatus;
  /** A mock run (P2.13): canned outputs, no provider sessions, no side effects. */
  mock: boolean;
  /** Bounded history, superseded activations included. */
  activations: NodeActivation[];
  /** At most {@link GRAPH_RUN_BOUNDS.maxRewinds}. */
  rewinds: GraphRewind[];
  /** Loop id → the iteration it is on (1-based); a restart inside a loop rewinds it. */
  loopIterations: Record<string, number>;
  usage: GraphRunUsage;
  /** Compare-and-swap revision; the store bumps it on every save. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string;
  /** Why the run failed, bounded like activation errors; never a payload. */
  error?: string;
  errorCause?: GraphErrorCause;
}

// ---------------------------------------------------------------- activations

/**
 * `waiting`: inputs not yet live. `awaiting-human`: a human node, or an
 * agent paused on `ask_human`, waits for the user (P2.8, D15).
 */
export const GRAPH_ACTIVATION_STATES = [
  "waiting",
  "ready",
  "admitting",
  "running",
  "awaiting-human",
  "complete",
  "failed",
  "skipped",
  "cancelled",
  "superseded",
] as const;
export type GraphActivationState = (typeof GRAPH_ACTIVATION_STATES)[number];
export const GRAPH_ACTIVATION_TERMINAL_STATES = [
  "complete",
  "failed",
  "skipped",
  "cancelled",
  "superseded",
] as const satisfies readonly GraphActivationState[];

/** The dispatch journal of today's sessions (`prepared → dispatching → sent`). */
export const GRAPH_DISPATCH_STATES = ["prepared", "dispatching", "sent"] as const;
export type GraphDispatchState = (typeof GRAPH_DISPATCH_STATES)[number];

/**
 * An agent activation's session: its identity, the dispatch journal and, from
 * {@link GraphAgentSessionState}, the agent branch runner's durable state
 * (repair, reminder, continuation, stall clocks) and an `ask_human` question.
 */
export interface GraphActivationSession extends GraphAgentSessionState {
  agent: AgentPlatform;
  model?: string;
  effort?: string;
  providerSessionId?: string;
  /** The dispatch request id (proof-based recovery). */
  requestId: string;
  dispatchState: GraphDispatchState;
  /** `tool-call-v1`, `structured-output-v1`, … (the workflow-result transport). */
  resultTransport: string;
  /** Output port → its workflow-result slot key. */
  resultKeys?: Record<string, string>;
  tokenCount?: number;
  cacheReadTokens?: number;
  transcript?: PipelineTranscriptReference;
}

/** Guards that run around an activation (P0.1, P2.9). */
export const GRAPH_GUARD_KINDS = ["read-only", "remote-ref", "enforcement"] as const;
export type GraphGuardKind = (typeof GRAPH_GUARD_KINDS)[number];
export const GRAPH_GUARD_OUTCOMES = ["passed", "violated", "unavailable"] as const;
export type GraphGuardOutcome = (typeof GRAPH_GUARD_OUTCOMES)[number];

export interface GraphGuardResult {
  guard: GraphGuardKind;
  outcome: GraphGuardOutcome;
  at: string;
  /** Content-free description, at most 512 characters. */
  detail?: string;
  /** Workspace paths the guard names as evidence, at most 32. */
  paths?: string[];
}

/** One watched upstream ref before dispatch (the remote-ref guard, item 209). */
export interface GraphUpstreamRef {
  /** A configured remote's name. */
  remote: string;
  /** `refs/heads/<run branch>`. */
  ref: string;
  /** Null when the remote has no such ref. */
  sha: string | null;
}

/**
 * The workspace and upstream state an agent activation started from (items
 * 204, 209), captured before dispatch. The guards compare against it.
 */
export interface GraphActivationBaseline {
  headRef: string;
  /** SHA-256 over the uncommitted path set: sorted, each path followed by NUL. */
  pathsDigest: string;
  /** Size of the uncommitted path set (item 209). */
  pathCount?: number;
  /**
   * The uncommitted paths themselves, sorted, when there are at most
   * {@link GRAPH_RUN_BOUNDS.maxBaselinePaths}; otherwise only the digest and
   * count. Kept for `read` and `none` nodes only.
   */
  paths?: string[];
  /**
   * When it was captured (item 209). The HEAD reflog after it is the
   * activation's own; a baseline without it predates the guards.
   */
  capturedAt?: string;
  /** The run branch on each watched remote (item 209). */
  upstream?: GraphUpstreamRef[];
}

export interface NodeActivation {
  /** `graphActivationKey({nodeId, iteration, branchKey, attempt})`. */
  key: string;
  nodeId: string;
  /** 1-based; 1 outside loops. */
  iteration: number;
  /** Stable across retries (P2.5); absent unless the node is replicated. */
  branchKey?: string;
  /** 1-based. */
  attempt: number;
  state: GraphActivationState;
  /** Input port → artifact id, or ids for a list port. */
  inputs: Record<string, string | string[]>;
  /**
   * Output port → the accepted artifact id. A gate or human node forwards its
   * inputs: the taken outlet's ports map to the input artifact ids.
   */
  outputs: Record<string, string>;
  /** Gate and human nodes: the outlet taken (consumers on other outlets are skipped). */
  outlet?: string;
  session?: GraphActivationSession;
  /**
   * The policy the activation actually ran under, recorded before dispatch
   * (required once `session` exists, so a dispatched activation always says
   * what it got).
   */
  policy?: NativeAgentExecutionPolicy;
  /** The enforcement tier actually applied (P2.9); required with `policy`. */
  enforcement?: GraphEnforcementTier;
  /** Why the tier is not `enforced`, as the matrix states it. */
  enforcementReason?: string;
  /** Workspace state before dispatch, for the guards. */
  baseline?: GraphActivationBaseline;
  guards?: GraphGuardResult[];
  /** At most {@link GRAPH_RUN_BOUNDS.maxErrorChars}; content-free. */
  error?: string;
  errorCause?: GraphErrorCause;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The rewind that superseded it. */
  supersededBy?: string;
}

// ---------------------------------------------------------------- rewinds

/** `restart`: rerun a node with the same inputs; `rewind-code`: reset the workspace first. */
export const GRAPH_REWIND_KINDS = ["restart", "rewind-code"] as const;
export type GraphRewindKind = (typeof GRAPH_REWIND_KINDS)[number];
export const GRAPH_REWIND_REQUESTERS = ["user", "coordinator", "runtime"] as const;
export type GraphRewindRequester = (typeof GRAPH_REWIND_REQUESTERS)[number];

export interface GraphRewind {
  id: string;
  kind: GraphRewindKind;
  nodeId: string;
  /** The restarted activation's key. */
  activation: string;
  /** The loop iteration the counter was rewound to (1 outside loops). */
  iteration: number;
  requestedAt: string;
  requestedBy: GraphRewindRequester;
  /** Exactly what it superseded: the lineage descendants (P2.10). */
  superseded: { activations: string[]; artifacts: string[] };
  /** A code rewind's target commit and what it reset (see {@link GraphRewindCode}). */
  code?: GraphRewindCode;
}

/**
 * What a code rewind did to the branch (P2.10). Item 210 records it before
 * the reset, as `build-pipeline-code-rewind.ts` does for the pipeline. The
 * upstream fields decide the next push (item 207): a rewind that dropped
 * commits the upstream already had makes the next push of the run's branch
 * use `--force-with-lease`, once; every other push is a plain push.
 */
export interface GraphRewindCode {
  /** The commit the branch was reset to. */
  headRef: string;
  /** The ref that keeps the old tip reachable. */
  backupRef?: string;
  /** The tip the reset moved away from. */
  from?: string;
  /** The branch's upstream (`origin/feature`), when it had one. */
  upstream?: string;
  /** Commits on the upstream that the reset dropped; above 0 means a forced push is due. */
  upstreamCommitsDropped?: number;
  /**
   * The rewind is recorded but the reset has not been confirmed yet. Item
   * 210 journals the intent first and finishes the reset before the run
   * plans anything again (after a crash, at the next pass), as the pipeline
   * does with its pending code rewinds.
   */
  pending?: true;
}

// ---------------------------------------------------------------- artifacts

/** Producer node id of a run input's artifact (node ids are kebab-case, so it never clashes). */
export const GRAPH_RUN_INPUT_PRODUCER = "$input";

export interface GraphArtifactProducer {
  nodeId: string;
  /** The activation key, or {@link GRAPH_RUN_INPUT_PRODUCER} for a run input. */
  activation: string;
  /** The output port, or the run input's name. */
  port: string;
}

export interface GraphArtifactFile {
  /** `.orkestrator/graph-artifacts/<run-id>/<sha256>[.<ext>]`, workspace-relative. */
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * A value artifact carries its value. A reference artifact carries its sealed
 * file and, for types whose value is a descriptor of it (`review-package@2`),
 * that descriptor.
 */
export type GraphArtifactBody = { value: unknown } | { file: GraphArtifactFile; value?: unknown };

export const GRAPH_ARTIFACT_STATES = ["live", "superseded"] as const;
export type GraphArtifactState = (typeof GRAPH_ARTIFACT_STATES)[number];

export interface GraphArtifactWorkspace {
  headRef: string;
  baseRef?: string;
}

export interface GraphArtifact {
  formatVersion: typeof GRAPH_ARTIFACT_FORMAT_VERSION;
  /** `graphArtifactId`: SHA-256 over the digest, run, producer, lineage and workspace. */
  id: string;
  /** `graphArtifactDigest`: SHA-256 over the type and the canonical payload. */
  digest: string;
  /** The type reference (`review-report@1`, a custom `name@N`). */
  type: string;
  runId: string;
  producer: GraphArtifactProducer;
  /** Artifact ids the producer consumed: the lineage. */
  inputs: string[];
  /** The code state it describes. */
  workspace?: GraphArtifactWorkspace;
  createdAt: string;
  /** Payload bytes: the value's canonical JSON, or the sealed file's size. */
  bytes: number;
  body: GraphArtifactBody;
  /** Stable per-item source ids (report §5.9). */
  itemIds?: string[];
  /**
   * A merge node's output (item 206): for each item, in `itemIds` order, the
   * source item ids folded into it. `dedupe` keeps every one (D11); at most
   * `maxItemIds` ids in all.
   */
  itemSources?: string[][];
  state: GraphArtifactState;
  /** The rewind that superseded it. */
  supersededBy?: string;
}
