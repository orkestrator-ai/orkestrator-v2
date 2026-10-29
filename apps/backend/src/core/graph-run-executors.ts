/**
 * The node executor contract of the graph runtime (plan P2.3–P2.8).
 *
 * The scheduler pass (`graph-run-pass.ts`) decides *which* activation runs
 * and *when*: the ready set, workspace locks, admission caps, observation
 * cadence, retries, timeouts, cancellation and the run's status. An executor
 * decides *how* one activation of its node kind runs: an agent session (204),
 * a backend action (207), a predicate (gate, 206), a deterministic merge
 * (206) or a person (208). Executors never touch the run record; they return
 * a {@link GraphActivationReport} and the pass applies it with the pure
 * `applyGraphActivationReport` under the run lock, then saves the record with
 * compare-and-swap. New node kinds therefore plug in without editing the pass.
 *
 * ## Lifecycle
 *
 * - `start` is called for an activation the pass has durably moved to
 *   `admitting` (the journal point: the save happens before the call). It may
 *   be called again for the same activation after a crash or a lost save,
 *   because an `admitting` activation is always handed to `recover` (or, when
 *   an executor has none, to `start`) until it reports a state. It must
 *   therefore be idempotent per activation key: derive request ids from the
 *   key and check your own dispatch journal before sending anything twice.
 * - `observe` is called for a `running` or `awaiting-human` activation on the
 *   observation cadence (3 s plus a stable per-run spread), sooner when the
 *   run is woken for it (an accepted result slot, an answer), and at most
 *   once per pass.
 * - `recover` is called once per backend process for every activation found
 *   `admitting`, `running` or `awaiting-human` (startup recovery), before any
 *   `observe`. Without it the pass calls `start` for `admitting` and
 *   `observe` otherwise.
 * - `cancel` is called for admitted activations when the run is cancelled or
 *   fails, or the activation times out. Report `cancelled` once the work has
 *   stopped (or the terminal state it reached first); `unchanged` asks to be
 *   called again on a later pass. A restart (item 210) calls it too, outside
 *   a pass but under the run's lock, for admitted activations it supersedes
 *   (`restarted`), a few times before it supersedes them regardless.
 *
 * Every call gets the pass's `AbortSignal` (aborted when the backend stops)
 * and, under the keyed driver, the pass's `workflow-provider` admission
 * lease: pass it as `holding` to nested acquisitions of the same pool so
 * they hand off instead of queueing behind their own pass.
 *
 * ## Reports
 *
 * `unchanged` (plus optional facts) keeps the state; `running`,
 * `awaiting-human`, `complete`, `failed` and `cancelled` move it. A
 * completing activation names the accepted artifact id of each output port it
 * produced (artifacts are stored through `context.artifacts` first, so they
 * are validated against their type, invariant 4); a gate or human node also
 * names its `outlet` and forwards the taken outlet's input artifact ids as its
 * outputs. A failing one names a {@link GraphErrorCause}; with
 * `onFailure: route` it also names its `error` output. Throwing from any call
 * fails the activation with `system-error` and the thrown message (bounded,
 * so never put a payload in it); return `unchanged` for a transient problem
 * instead.
 *
 * Reports carry facts the record keeps: the session, the policy and
 * enforcement tier actually applied (required together, and before a session
 * is recorded), the guard baseline and results, and token usage since the
 * previous report (added to the run's usage). Logs and metrics derived from a
 * report hold counts, ids and states only.
 *
 * ## The journal
 *
 * A fact that must be durable *before* the call goes on — the agent
 * executor's dispatch journal, where `dispatching` must be saved before the
 * prompt is sent (item 204) — goes through `context.journal(facts)`: the pass
 * applies it to the activation without moving its state and saves the record
 * at once, serialized with every other journal write of the pass. Usage and
 * `observeAfterMs` are not journaled; report them. A journal write that
 * cannot be saved rejects with a `GraphActivationJournalFenceError`, and the
 * call should stop and report `unchanged`: the next pass starts from the
 * stored record.
 */
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import type {
  GraphActivationBaseline,
  GraphActivationSession,
  GraphGuardResult,
  GraphHumanWait,
  GraphModelBinding,
  GraphRun,
  NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphEnforcementTier } from "@orkestrator/protocol/graphs/template";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import type { AdmissionLease } from "./work-admission.js";

/** Node kinds a plan can hold and an executor can run (`subgraph` is inlined by item 402). */
export const GRAPH_EXECUTABLE_NODE_KINDS = ["agent", "system", "gate", "merge", "human"] as const;
export type GraphExecutableNodeKind = (typeof GRAPH_EXECUTABLE_NODE_KINDS)[number];

export function isGraphExecutableNodeKind(kind: string): kind is GraphExecutableNodeKind {
  return (GRAPH_EXECUTABLE_NODE_KINDS as readonly string[]).includes(kind);
}

/** Why the pass asks an executor to stop an admitted activation. */
export const GRAPH_CANCEL_REASONS = [
  /** The user or the coordinator cancelled the run. */
  "run-cancelled",
  /** Another activation failed with `onFailure: fail-run`, or the run hit a bound. */
  "run-failed",
  /** The activation ran past its node's `timeoutMs`. */
  "timeout",
  /** A `first` fan-in collected enough branches; this one is no longer needed (item 205). */
  "surplus",
  /** A restart or code rewind supersedes the activation (item 210); a new attempt replaces it. */
  "restarted",
] as const;
export type GraphCancelReason = (typeof GRAPH_CANCEL_REASONS)[number];

/** The error a surplus branch is cancelled with (a `first` fan-in no longer needs it). */
export const GRAPH_SURPLUS_BRANCH_ERROR =
  "Not needed: the fan-in collecting the first results already has them";

/** Facts any report may carry; the pass merges them into the activation. */
export interface GraphActivationFacts {
  session?: GraphActivationSession;
  /** The policy actually applied; required together with `enforcement`, and before `session`. */
  policy?: NativeAgentExecutionPolicy;
  enforcement?: GraphEnforcementTier;
  enforcementReason?: string;
  baseline?: GraphActivationBaseline;
  /** Replaces the activation's guard results (at most 8). */
  guards?: GraphGuardResult[];
  /** Human nodes (item 208): the wait the activation keeps until a person answers. */
  human?: GraphHumanWait;
  /** Usage since the previous report; added to the run's usage. */
  usage?: { tokens: number; cacheReadTokens?: number };
  /**
   * When to observe this activation next. Default: the observation cadence.
   * `null`: only when the run is woken (a human answer, an accepted slot).
   */
  observeAfterMs?: number | null;
}

export type GraphActivationReport =
  | (GraphActivationFacts & { state: "unchanged" })
  | (GraphActivationFacts & { state: "running" })
  | (GraphActivationFacts & { state: "awaiting-human" })
  | (GraphActivationFacts & {
      state: "complete";
      /** Output port → accepted artifact id (a gate's forwarded input ids). */
      outputs: Record<string, string>;
      /** Gate and human nodes: the outlet taken. */
      outlet?: string;
    })
  | (GraphActivationFacts & {
      state: "failed";
      /** Content-free, bounded to 2,000 characters by the pass. */
      error: string;
      cause: GraphErrorCause;
      /** `onFailure: route`: the `error@1` artifact on the `error` port. */
      outputs?: Record<string, string>;
    })
  | (GraphActivationFacts & { state: "cancelled"; error?: string });

export type GraphExecutorOperation = "start" | "observe" | "recover" | "cancel";

/** What one executor call sees. Read-only: changes go back as a report. */
export interface GraphExecutorContext {
  readonly operation: GraphExecutorOperation;
  /** The run as the pass holds it, before this call's report is applied. */
  readonly run: Readonly<GraphRun>;
  readonly node: GraphPlanNode;
  readonly activation: Readonly<NodeActivation>;
  /** Agent nodes: the model this activation runs on (its branch's panel member or lens role). */
  readonly binding?: GraphModelBinding;
  /**
   * The run's environment. Every admitted activation of a live run has one;
   * an environment-less mock run (item 213) passes "" to its mock executors.
   */
  readonly environmentId: string;
  /** Reads (with `verify`/`requireVerified`) and stores this run's artifacts. */
  readonly artifacts: GraphArtifactStore;
  /** Aborted when the backend stops; an in-flight provider call may still complete. */
  readonly signal: AbortSignal;
  /** The pass's `workflow-provider` lease, for nested acquisitions (`holding`). */
  readonly lease?: AdmissionLease;
  /** Wakes the run for another pass, e.g. after work this call started finishes elsewhere. */
  wake(): void;
  /**
   * Durably records facts for this activation now, before the call returns
   * (see "The journal" above). Resolves once saved.
   */
  journal(facts: Omit<GraphActivationFacts, "usage" | "observeAfterMs">): Promise<void>;
  now(): Date;
}

/** A journal write could not be saved; the call should stop and report `unchanged`. */
export class GraphActivationJournalFenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GraphActivationJournalFenceError";
  }
}

export interface GraphNodeExecutor {
  readonly kind: GraphExecutableNodeKind;
  start(context: GraphExecutorContext): Promise<GraphActivationReport>;
  observe(context: GraphExecutorContext): Promise<GraphActivationReport>;
  cancel(context: GraphExecutorContext, reason: GraphCancelReason): Promise<GraphActivationReport>;
  recover?(context: GraphExecutorContext): Promise<GraphActivationReport>;
}

export class GraphExecutorRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphExecutorRegistrationError";
  }
}

/**
 * One executor per node kind, plus optional mock executors for mock runs
 * (213). A mock run never falls back to a live `agent` or `system` executor:
 * it must create no provider session and cause no side effect. Gates and
 * merges are deterministic, so a mock run uses the live ones unless a mock is
 * registered.
 */
export class GraphNodeExecutorRegistry {
  private readonly live = new Map<GraphExecutableNodeKind, GraphNodeExecutor>();
  private readonly mock = new Map<GraphExecutableNodeKind, GraphNodeExecutor>();

  /** Registers an executor; returns the unregister function. Refuses a second one for a kind. */
  register(executor: GraphNodeExecutor, options: { mock?: boolean } = {}): () => void {
    if (!isGraphExecutableNodeKind(executor.kind)) {
      throw new GraphExecutorRegistrationError("Unknown node kind");
    }
    const table = options.mock ? this.mock : this.live;
    if (table.has(executor.kind)) {
      throw new GraphExecutorRegistrationError(
        `A ${options.mock ? "mock " : ""}${executor.kind} executor is already registered`,
      );
    }
    table.set(executor.kind, executor);
    return () => {
      if (table.get(executor.kind) === executor) table.delete(executor.kind);
    };
  }

  /** The executor for a node of `kind` in a live or mock run; undefined when none applies. */
  resolve(kind: string, options: { mock?: boolean } = {}): GraphNodeExecutor | undefined {
    if (!isGraphExecutableNodeKind(kind)) return undefined;
    if (!options.mock) return this.live.get(kind);
    const mock = this.mock.get(kind);
    if (mock) return mock;
    return kind === "agent" || kind === "system" ? undefined : this.live.get(kind);
  }

  kinds(options: { mock?: boolean } = {}): GraphExecutableNodeKind[] {
    return [...(options.mock ? this.mock : this.live).keys()].sort();
  }
}
