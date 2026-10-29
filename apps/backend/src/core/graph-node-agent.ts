/**
 * The graph agent node executor (plan P2.4, report §5.5, §6.5, §8.3; D12,
 * D15).
 *
 * One activation is one branch of the shared agent branch runner
 * (`agent-branch-runner.ts`): the same session creation, dispatch journal,
 * proof-based recovery, observation, repair, reminder, continuation and
 * metering Multi Review's reviewers run on. What this executor adds:
 *
 * - **Policy first.** The node's capabilities are compiled against the
 *   environment's real policy and the project ceiling, the enforcement tier
 *   is judged for the binding's provider, and both are recorded on the
 *   activation before the session exists (`graph-agent-policy.ts`). A
 *   read-only policy runs as a read-only turn (researchers on Claude are the
 *   documented exception). The node's enforcement floor is re-checked here.
 * - **The journal is the run record.** Every runner write goes through the
 *   pass's `context.journal`, so `dispatching` is durable before the prompt is
 *   sent and a restart recovers from the stored activation.
 * - **Per-activation result slots and tools** (`graph-agent-results.ts`,
 *   `graph-agent-tools.ts`): `submit_<port>`/`validate_<port>` and the status
 *   tool per request, `report_progress`, `read_artifact`, `ask_human` and the
 *   opted-in Orkestrator groups. Keys are unique across runs.
 * - **Completion** when every required port has an accepted result: values
 *   become artifacts with lineage (the consumed inputs) and the workspace
 *   commit; `workspace@1` ports are filled from Git after the turn.
 * - **`ask_human`** pauses the activation (`awaiting-human`, the run
 *   `waiting`); an answer the waiting call could not carry is sent as the
 *   next turn once the asking turn has settled (`graph-agent-questions.ts`).
 * - **`session: "continue"`** sends the turn into the provider session of the
 *   activation it continues (the compiler proved the §5.2 constraints).
 */
import { createHash } from "node:crypto";
import type {
  AgentEnforcementHost,
  GraphCapabilityCeiling,
} from "@orkestrator/protocol/graphs/capability-profiles";
import type { GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_COMMIT_PATTERN,
  isGraphAgentAnswerUndelivered,
  isGraphAgentQuestionOpen,
  type GraphActivationSession,
  type GraphModelBinding,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import { isAgentBranchFenceError } from "./agent-branch-commits.js";
import { AgentBranchRunner } from "./agent-branch-runner.js";
import type { AgentBranchPollGate, AgentBranchRecord } from "./agent-branch-types.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import { defaultCoordinatorHostCapabilities } from "./coordinator-providers.js";
import { graphAgentFloorProblem, graphAgentPolicy } from "./graph-agent-policy.js";
import type { GraphAgentProviders } from "./graph-agent-providers.js";
import { graphAnswerTurnPrompt, type GraphAgentQuestions } from "./graph-agent-questions.js";
import { GraphAgentResults, type GraphAgentResultService } from "./graph-agent-results.js";
import { graphAgentBranch } from "./graph-agent-state.js";
import { appendGraphAgentProgress, type GraphAgentProgressInbox } from "./graph-agent-tools.js";
import {
  GRAPH_SURPLUS_BRANCH_ERROR,
  type GraphActivationReport,
  type GraphCancelReason,
  type GraphExecutorContext,
  type GraphNodeExecutor,
} from "./graph-run-executors.js";
import type { Environment } from "./models.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import type { ArtifactTurnDispatch } from "./workflow-artifact-turns.js";
import type { WorkflowResultService } from "./workflow-result-service.js";
import {
  GraphAgentBranchHost,
  type GraphAgentCallFacts,
  type GraphAgentCallState,
} from "./graph-agent-host.js";

/** Result slots whose consumption failed, retried on later calls (bounded). */
const MAX_PENDING_CONSUMPTIONS = 256;

export interface GraphAgentExecutorDependencies {
  storage: { getEnvironment(environmentId: string): Promise<Environment | null> };
  providers: GraphAgentProviders;
  questions: GraphAgentQuestions;
  progress: GraphAgentProgressInbox;
  /** Without it agents return results through structured output only. */
  workflowResults?: GraphAgentResultService &
    Pick<WorkflowResultService, "capabilityToken" | "activationCapabilityToken">;
  /** Mints the per-activation credential. */
  agentTools?: {
    workflowResultConnection(
      environmentId: string,
      projectId: string,
      target: "host" | "container",
      resultKey: string,
      provider?: GraphModelBinding["platform"],
    ): AgentToolConnection;
    workflowResultActivationConnection(
      environmentId: string,
      projectId: string,
      target: "host" | "container",
      resultKeys: readonly string[],
    ): AgentToolConnection;
  };
  assertAgentToolsReachable?(environmentId: string, stage: string): Promise<void>;
  /** Whether the result-tool rollout admits graph outputs for an agent (default yes). */
  toolResultsEnabled?(agent: GraphModelBinding["platform"]): boolean;
  /** Refreshes what {@link toolResultsEnabled} reads, before a transport is chosen. */
  refreshToolResults?(): Promise<void>;
  /** The project's capability ceiling (D18). */
  ceiling?(projectId: string): Promise<GraphCapabilityCeiling | undefined>;
  /** What the enforcement matrix may assume about the host (Claude's sandbox). */
  enforcementHost?(environment: Environment): AgentEnforcementHost;
  /** Reads Git in the environment (baselines, `workspace@1` outputs). */
  environmentGit?: EnvironmentGit;
  /** The branch the work targets (built-in prompts). Default the environment's base branch. */
  targetBranch?(environment: Environment): string;
  projectNotes?(projectId: string): Promise<string | undefined>;
  /** Per-turn transcript artifact grants for nodes that opt into the artifacts group. */
  artifactDispatch?: ArtifactTurnDispatch;
  /**
   * Captures a settling turn's transcript (the run view, item 211). Returns
   * the stored reference for the session, or undefined.
   */
  captureTranscript?(input: {
    runId: string;
    activationKey: string;
    providerSessionId: string;
    readTranscript: () => Promise<readonly unknown[]>;
  }): Promise<GraphActivationSession["transcript"] | undefined>;
  pollGate?: AgentBranchPollGate;
  progressTracker?: MultiReviewProgressTracker;
  stallWarningMs?: number;
  stallAbandonMs?: number;
}

function failed(
  error: string,
  cause: GraphErrorCause,
  facts: Partial<GraphActivationReport> = {},
): GraphActivationReport {
  return { ...facts, state: "failed", error, cause } as GraphActivationReport;
}

/** The source activation a `session: "continue"` node continues: the producer of one of its inputs. */
export function graphContinuedSource(
  activations: readonly NodeActivation[],
  node: GraphPlanAgentNode,
  activation: Readonly<NodeActivation>,
): NodeActivation | undefined {
  if (node.session.mode !== "continue") return undefined;
  const from = node.session.from;
  const consumed = new Set(
    Object.values(activation.inputs).flatMap((ids) => (Array.isArray(ids) ? ids : [ids])),
  );
  return activations.find(
    (candidate) =>
      candidate.nodeId === from &&
      candidate.state === "complete" &&
      Object.values(candidate.outputs).some((id) => consumed.has(id)),
  );
}

export class GraphAgentNodeExecutor implements GraphNodeExecutor {
  readonly kind = "agent" as const;
  readonly progressTracker: MultiReviewProgressTracker;
  private readonly pendingConsumptions = new Map<string, () => Promise<void>>();

  constructor(private readonly dependencies: GraphAgentExecutorDependencies) {
    this.progressTracker = dependencies.progressTracker ?? new MultiReviewProgressTracker();
  }

  start(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return this.run(context);
  }

  observe(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return this.run(context);
  }

  recover(context: GraphExecutorContext): Promise<GraphActivationReport> {
    return this.run(context);
  }

  async cancel(
    context: GraphExecutorContext,
    reason: GraphCancelReason,
  ): Promise<GraphActivationReport> {
    const session = context.activation.session;
    if (session?.question) this.dependencies.questions.release(session.question.id);
    const binding = context.binding;
    const environment = await this.dependencies.storage
      .getEnvironment(context.environmentId)
      .catch(() => null);
    if (session?.providerSessionId && binding && environment) {
      try {
        const provider = await this.dependencies.providers.get(
          environment,
          session.agent,
          context.activation.key,
        );
        await provider.abort(session.providerSessionId);
      } catch {
        // Best-effort, as every abandon: the record says the step stopped.
      }
      this.progressTracker.forget(session.providerSessionId);
    }
    if (session && context.node.kind === "agent") {
      try {
        const results = new GraphAgentResults({
          run: context.run,
          node: context.node,
          activation: context.activation,
          service: this.dependencies.workflowResults,
          sources: {},
        });
        if (results.slots.length > 0 && this.dependencies.workflowResults) {
          await results.close(session.requestId);
        }
      } catch {
        // A slot that cannot be closed now is superseded by the step's end.
      }
    }
    if (session) {
      this.dependencies.providers.release(
        context.environmentId,
        session.agent,
        context.activation.key,
      );
    }
    return {
      state: "cancelled",
      ...(reason === "timeout"
        ? { error: "The step ran past its time limit" }
        : reason === "surplus"
          ? { error: GRAPH_SURPLUS_BRANCH_ERROR }
          : {}),
    };
  }

  private async run(context: GraphExecutorContext): Promise<GraphActivationReport> {
    await this.retryConsumptions();
    try {
      return await this.advance(context);
    } catch (error) {
      if (isAgentBranchFenceError(error) || context.signal.aborted) return { state: "unchanged" };
      throw error;
    }
  }

  private async retryConsumptions(): Promise<void> {
    for (const [key, consume] of [...this.pendingConsumptions].slice(0, 8)) {
      try {
        await consume();
        this.pendingConsumptions.delete(key);
      } catch {
        // Kept for a later call; bounded.
      }
    }
  }

  deferConsumption(key: string, consume: () => Promise<void>): void {
    if (this.pendingConsumptions.size >= MAX_PENDING_CONSUMPTIONS) return;
    this.pendingConsumptions.set(key, consume);
  }

  finishConsumption(key: string): void {
    this.pendingConsumptions.delete(key);
  }

  private async advance(context: GraphExecutorContext): Promise<GraphActivationReport> {
    const node = context.node;
    if (node.kind !== "agent") throw new Error("The agent executor runs agent nodes only");
    const binding = context.binding;
    if (!binding) return failed("No model is bound to this step's role", "system-error");
    const environment = await this.dependencies.storage.getEnvironment(context.environmentId);
    if (!environment) return failed("The run's environment no longer exists", "system-error");
    const activation = context.activation;
    const session = activation.session;
    if (!session || session.dispatchState === "prepared")
      await this.dependencies.refreshToolResults?.();

    // Policy and tier before anything else (recorded before the session).
    const ceiling = await this.dependencies.ceiling?.(context.run.projectId);
    const decision = graphAgentPolicy({
      node,
      environment,
      ...(ceiling ? { ceiling } : {}),
      platform: session?.agent ?? binding.platform,
      host: this.enforcementHost(environment),
    });
    const facts: GraphAgentCallFacts =
      activation.policy && activation.enforcement
        ? {
            policy: activation.policy,
            enforcement: activation.enforcement,
            ...(activation.enforcementReason !== undefined
              ? { enforcementReason: activation.enforcementReason }
              : {}),
            ...(activation.baseline ? { baseline: activation.baseline } : {}),
          }
        : {
            policy: decision.compiled.policy,
            enforcement: decision.enforcement,
            ...(decision.enforcementReason
              ? { enforcementReason: decision.enforcementReason }
              : {}),
          };
    if (!session) {
      const floor = graphAgentFloorProblem(node, facts.enforcement);
      if (floor) {
        return failed(floor, "guard-violation", {
          policy: facts.policy,
          enforcement: facts.enforcement,
          ...(facts.enforcementReason ? { enforcementReason: facts.enforcementReason } : {}),
        });
      }
      if (!facts.baseline && node.workspaceAccess !== "none") {
        const baseline = await this.baseline(context.environmentId);
        if (baseline) facts.baseline = baseline;
      }
    }

    // `session: "continue"`: the turn goes into the source activation's session.
    let continued: NodeActivation | undefined;
    if (node.session.mode === "continue" && !session) {
      continued = graphContinuedSource(context.run.activations, node, activation);
      if (!continued?.session?.providerSessionId) {
        return failed("The session this step continues is not available", "system-error", facts);
      }
      if (continued.session.agent !== binding.platform) {
        return failed(
          "The session this step continues runs on another agent",
          "system-error",
          facts,
        );
      }
    }

    const branch = graphAgentBranch(activation, binding);
    const state: GraphAgentCallState = {
      resultKeys: { ...session?.resultKeys },
      ...(session?.question ? { question: session.question } : {}),
      ...(session?.questionsAsked !== undefined ? { questionsAsked: session.questionsAsked } : {}),
      ...(session?.continuedFrom !== undefined
        ? { continuedFrom: session.continuedFrom }
        : continued
          ? { continuedFrom: continued.key }
          : {}),
      turnMode: session?.turnMode ?? decision.turnMode,
      ...(session?.transcript ? { transcript: session.transcript } : {}),
      ...(session?.progress ? { progress: session.progress } : {}),
    };
    const reported = this.dependencies.progress.take(context.run.id, activation.key);
    state.progress = appendGraphAgentProgress(state.progress, reported) ?? state.progress;

    const host = new GraphAgentBranchHost(this, this.dependencies, {
      context,
      node,
      binding,
      environment,
      facts,
      state,
      compiled: decision.compiled,
      snapshot: session ?? continued?.session,
    });
    host.track(branch);
    // The slots are read synchronously by the runner (parse, result turns).
    await host.ready();
    if (continued) host.continueSession(branch, continued);
    const runner = new AgentBranchRunner(host);

    // An open question pauses the activation until it is answered, unless
    // every required output arrived anyway (the agent finished regardless).
    if (branch.status === "running" && isGraphAgentQuestionOpen(state.question)) {
      if (!(await host.requiredAccepted(branch.requestId!))) {
        return host.report(branch, "awaiting-human", { observeAfterMs: null });
      }
    }
    // An answer the waiting call could not carry goes as the next turn, once
    // the asking turn has settled.
    if (branch.status === "running" && isGraphAgentAnswerUndelivered(state.question)) {
      if (!(await host.turnSettled(branch))) return host.report(branch, "running");
      const question = state.question!;
      state.question = { ...question, delivered: "turn" };
      await runner.prepareContinuation(branch, graphAnswerTurnPrompt(question, question.answer!));
    }

    await runner.advanceIsolated(branch, 0, 1);

    switch (branch.status) {
      case "completed": {
        delete state.progress;
        this.release(context, branch);
        return host.report(branch, "complete");
      }
      case "failed":
        this.release(context, branch);
        return host.report(branch, "failed");
      case "cancelled":
        this.release(context, branch);
        return host.report(branch, "cancelled");
      case "pending":
        // A retryable setup fault before the session existed: start again soon.
        return host.report(branch, "unchanged");
      default:
        return host.report(
          branch,
          "running",
          branch.dispatchState === "prepared" ? { observeAfterMs: 0 } : {},
        );
    }
  }

  private release(context: GraphExecutorContext, branch: AgentBranchRecord): void {
    if (branch.providerSessionId) this.progressTracker.forget(branch.providerSessionId);
    this.dependencies.providers.release(
      context.environmentId,
      branch.agent,
      context.activation.key,
    );
  }

  private enforcementHost(environment: Environment): AgentEnforcementHost {
    if (this.dependencies.enforcementHost) return this.dependencies.enforcementHost(environment);
    // A container's own command sandbox is not probed from the host: assume
    // none, which never overstates the tier.
    return environment.environmentType === "local"
      ? defaultCoordinatorHostCapabilities()
      : { claudeSandbox: false };
  }

  /** The workspace state before dispatch, for the guards (item 209) and `baseRef`. */
  private async baseline(
    environmentId: string,
  ): Promise<{ headRef: string; pathsDigest: string } | undefined> {
    const git = this.dependencies.environmentGit;
    if (!git) return undefined;
    try {
      const headRef = (await git(environmentId, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      if (!GRAPH_COMMIT_PATTERN.test(headRef)) return undefined;
      const status = await git(environmentId, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      return { headRef, pathsDigest: createHash("sha256").update(status).digest("hex") };
    } catch {
      // Best-effort here; item 209's guards fail closed where they need one.
      return undefined;
    }
  }
}
