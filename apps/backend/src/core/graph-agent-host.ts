/**
 * One graph agent activation as the shared agent branch runner's host
 * (item 204): identity and interaction context, the activation's compiled
 * policy, its per-request result slots and credential, the prompt, result
 * acceptance into artifacts (with the runtime-filled `workspace@1` outputs),
 * and persistence through the pass's journal. Built per executor call by
 * `graph-node-agent.ts`; it holds nothing across calls.
 */
import { randomUUID } from "node:crypto";
import type { GraphPlanAgentNode } from "@orkestrator/protocol/graphs/compile";
import {
  GRAPH_COMMIT_PATTERN,
  type GraphActivationBaseline,
  type GraphActivationWorktree,
  type GraphActivationSession,
  type GraphGuardResult,
  type GraphAgentProgressItem,
  type GraphAgentQuestion,
  type GraphAgentTurnMode,
  type GraphModelBinding,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  graphOutputResultInstruction,
  type GraphResultTools,
} from "@orkestrator/protocol/graphs/prompts";
import { GraphTypeLibrary, type GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { ReviewContractValidationIssue } from "@orkestrator/protocol/structured-review";
import {
  resolveUnattendedReviewerInteractions,
  unattendedBranchInteraction,
} from "./agent-branch-runner.js";
import type {
  AgentBranchFailureKind,
  AgentBranchHost,
  AgentBranchParsedResult,
  AgentBranchPollGate,
  AgentBranchRecord,
  AgentBranchResultTurn,
  AgentBranchWording,
} from "./agent-branch-types.js";
import { readProviderStatus } from "./agent-provider-contract.js";
import type { AgentToolConnection } from "./agent-tools.js";
import { structuredReportRepairPrompt } from "./build-pipeline-prompts.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  GraphAgentGuardError,
  mergeGraphGuardResults,
  type GraphAgentGuards,
} from "./graph-agent-guards.js";
import { graphAgentPolicy } from "./graph-agent-policy.js";
import { graphBranchAbsolutePath, graphBranchRoot } from "./graph-branch-worktrees.js";
import {
  graphAgentArtifactSources,
  graphAgentItemBinding,
  graphInputItemIds,
  loadGraphAgentInputs,
  renderGraphAgentPrompt,
  type GraphAgentInputs,
} from "./graph-agent-prompt.js";
import { GraphAgentResults, graphAgentItemIds } from "./graph-agent-results.js";
import {
  graphAgentSession,
  graphAgentSessionKey,
  graphAgentUsageDelta,
  type GraphAgentSessionExtras,
} from "./graph-agent-state.js";
import type { GraphActivationReport, GraphExecutorContext } from "./graph-run-executors.js";
import type { Environment } from "./models.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";

import type { GraphAgentExecutorDependencies } from "./graph-node-agent.js";

export const GRAPH_AGENT_WORDING: AgentBranchWording = Object.freeze({
  subject: "agent",
  resultLabel: "results",
  workLabel: "step",
  validResult: "valid results",
  stallStopReason: "so the run could continue",
});

/** The backend stopped mid-call: the runner stops and the pass reports nothing. */
class GraphAgentStoppedFenceError extends Error {
  constructor() {
    super("The backend is stopping");
    this.name = "GraphAgentStoppedFenceError";
  }
}

export function graphAgentFailureCause(kind: AgentBranchFailureKind | undefined): GraphErrorCause {
  switch (kind) {
    case "provider":
      return "provider-error";
    case "result":
      return "invalid-result";
    default:
      return "system-error";
  }
}

/** Mutable per-call facts the session keeps beside the branch. */
export interface GraphAgentCallState {
  resultKeys: Record<string, string>;
  question?: GraphAgentQuestion;
  questionsAsked?: number;
  continuedFrom?: string;
  turnMode: GraphAgentTurnMode;
  transcript?: GraphActivationSession["transcript"];
  progress?: GraphAgentProgressItem[];
}

export interface GraphAgentCallFacts {
  policy: NativeAgentExecutionPolicy;
  enforcement: NonNullable<NodeActivation["enforcement"]>;
  enforcementReason?: string;
  baseline?: GraphActivationBaseline;
  /** An isolated branch's own worktree (item 403). */
  worktree?: GraphActivationWorktree;
  /** The activation's guard results (item 209), newest per guard. */
  guards?: GraphGuardResult[];
}

/** What the host needs from its executor across calls. */
export interface GraphAgentHostOwner {
  readonly progressTracker: MultiReviewProgressTracker;
  readonly guards: GraphAgentGuards;
  deferConsumption(key: string, consume: () => Promise<void>): void;
  finishConsumption(key: string): void;
}

export interface GraphAgentHostInput {
  context: GraphExecutorContext;
  node: GraphPlanAgentNode;
  binding: GraphModelBinding;
  environment: Environment;
  facts: GraphAgentCallFacts;
  state: GraphAgentCallState;
  compiled: ReturnType<typeof graphAgentPolicy>["compiled"];
  /** The session usage was last reported against (the continued source's, at first). */
  snapshot: GraphActivationSession | undefined;
}

/** One activation's branch, as the shared runner sees it. */
export class GraphAgentBranchHost implements AgentBranchHost<AgentBranchRecord> {
  readonly workflowId: string;
  readonly sessionPhase: string;
  readonly mode: "plan" | "build";
  readonly wording = GRAPH_AGENT_WORDING;
  readonly progress: MultiReviewProgressTracker;
  readonly captureUsage = true;
  readonly persistUsageImmediately = true;
  readonly pollGate?: AgentBranchPollGate;
  readonly stallWarningMs?: number;
  readonly stallAbandonMs?: number;
  readonly artifactTurns?: AgentBranchHost["artifactTurns"];
  /** Output port → accepted artifact id, filled on acceptance. */
  readonly outputs: Record<string, string> = {};
  private failure: AgentBranchFailureKind | undefined;
  /** A guard failed the turn when its result was consumed (item 209). */
  private guardViolated = false;
  private results: GraphAgentResults | undefined;
  private inputs: GraphAgentInputs | undefined;
  private lightSources:
    Promise<{ sources: Record<string, string>; criterionIds?: string[] }> | undefined;

  constructor(
    private readonly executor: GraphAgentHostOwner,
    private readonly dependencies: GraphAgentExecutorDependencies,
    private readonly input: GraphAgentHostInput,
  ) {
    const { context, state } = input;
    this.workflowId = context.run.id;
    const readOnly = state.turnMode === "read-only";
    this.sessionPhase = readOnly ? "review" : "build";
    this.mode = readOnly ? "plan" : "build";
    this.progress = executor.progressTracker;
    if (dependencies.pollGate) this.pollGate = dependencies.pollGate;
    if (dependencies.stallWarningMs !== undefined)
      this.stallWarningMs = dependencies.stallWarningMs;
    if (dependencies.stallAbandonMs !== undefined)
      this.stallAbandonMs = dependencies.stallAbandonMs;
    if (
      dependencies.artifactDispatch &&
      input.node.grantedActions.orkestrator.some((entry) => entry.group === "artifacts")
    ) {
      this.artifactTurns = {
        dispatch: dependencies.artifactDispatch,
        environmentId: context.environmentId,
        projectId: context.run.projectId,
      };
    }
  }

  private get context() {
    return this.input.context;
  }

  /** Loads what the synchronous host calls read (the result slots). */
  async ready(): Promise<void> {
    await this.slots();
  }

  private get broker(): boolean {
    return this.input.binding.platform === "opencode";
  }

  private async slots(): Promise<GraphAgentResults> {
    if (this.results) return this.results;
    const light = await this.light();
    this.results = new GraphAgentResults({
      run: this.context.run,
      node: this.input.node,
      activation: this.context.activation,
      service: this.dependencies.workflowResults,
      sources: light.sources,
      ...(light.criterionIds ? { criterionIds: light.criterionIds } : {}),
    });
    return this.results;
  }

  /** Item ids and ticket criteria of the inputs, from the store (no file hashing). */
  private light(): Promise<{ sources: Record<string, string>; criterionIds?: string[] }> {
    this.lightSources ??= (async () => {
      const sources: Record<string, string> = {};
      let criterionIds: string[] | undefined;
      const { run, node, activation } = this.context;
      const inputs = node.inputs.flatMap((port) => {
        const bound = activation.inputs[port.name];
        const ids = bound === undefined ? [] : Array.isArray(bound) ? bound : [bound];
        return ids.map((id) => ({ id, port }));
      });
      const ticketInput = run.plan.inputs.find((input) => input.type.startsWith("ticket@"));
      const ticketId = ticketInput ? run.bindings.inputs[ticketInput.name] : undefined;
      const library = new GraphTypeLibrary(run.plan.types);
      // An `items` branch cites its own item on the replicated port (item 401).
      const binding =
        node.kind === "agent" ? graphAgentItemBinding(run, node, activation) : undefined;
      const entries: { id: string; port?: (typeof inputs)[number]["port"] }[] = ticketId
        ? [...inputs, { id: ticketId }]
        : inputs;
      for (const { id, port } of entries) {
        const artifact = await this.context.artifacts.get(run.id, id);
        if (!artifact) continue;
        // The ids the prompt showed (`graphAgentArtifactSources`), recorded or derived.
        const itemIds = port
          ? graphAgentArtifactSources(library, port, artifact, binding)
          : graphInputItemIds(library, artifact);
        for (const itemId of itemIds) sources[itemId] = artifact.type;
        if (!criterionIds && artifact.type.startsWith("ticket@") && "value" in artifact.body) {
          const criteria = (artifact.body.value as { criteria?: unknown })?.criteria;
          if (Array.isArray(criteria)) {
            const found = criteria
              .map((entry) => (entry as { id?: unknown })?.id)
              .filter((id): id is string => typeof id === "string");
            if (found.length > 0) criterionIds = found;
          }
        }
      }
      return { sources, ...(criterionIds ? { criterionIds } : {}) };
    })();
    return this.lightSources;
  }

  private async loadedInputs(): Promise<GraphAgentInputs> {
    this.inputs ??= await loadGraphAgentInputs(
      this.context.run,
      this.input.node,
      this.context.activation,
      this.context.artifacts,
    );
    return this.inputs;
  }

  /** Starts the branch inside the continued activation's provider session. */
  continueSession(branch: AgentBranchRecord, source: NodeActivation): void {
    const session = source.session!;
    branch.status = "running";
    branch.providerSessionId = session.providerSessionId!;
    if (session.sessionKey !== undefined) branch.sessionKey = session.sessionKey;
    branch.requestId = randomUUID();
    branch.dispatchState = "prepared";
    branch.resultTransport =
      this.prepareResult && (this.supportsToolResult(branch) ?? true)
        ? "tool-v1"
        : "structured-output-v1";
    if (branch.resultTransport === "tool-v1") branch.resultSubmission = "preparing";
    branch.startedAt = this.context.now().toISOString();
    if (session.tokenCount !== undefined) branch.tokenCount = session.tokenCount;
    if (session.cacheReadTokens !== undefined) branch.cacheReadTokens = session.cacheReadTokens;
  }

  // ------------------------------------------------------------ identity

  sessionKeyFor(branch: AgentBranchRecord): string {
    return (
      branch.sessionKey ?? graphAgentSessionKey(this.context.run.id, this.context.activation.key)
    );
  }

  sessionLabelFor(): string {
    const node = this.input.node;
    const branchKey = this.context.activation.branchKey;
    return `Graph · ${node.label ?? node.id}${branchKey ? ` · ${branchKey}` : ""}`.slice(0, 200);
  }

  reviewerSession(): boolean {
    // OpenCode's durable reviewer marker admits a constrained read-only shell.
    return this.mode === "plan" && !this.input.compiled.denied.includes("shell");
  }

  interactionContext(branch: AgentBranchRecord, fence: string | undefined) {
    return unattendedBranchInteraction({
      origin: this.mode === "plan" ? "automated-review" : "build-pipeline",
      reviewerSession: this.reviewerSession(),
      phase: this.sessionPhase,
      workflowId: this.context.run.id,
      provider: branch.agent,
      fence,
    });
  }

  provider(branch: AgentBranchRecord): Promise<BuildPipelineProvider> {
    return this.dependencies.providers.get(
      this.input.environment,
      branch.agent,
      this.context.activation.key,
    );
  }

  async providerUnavailable(branch: AgentBranchRecord, provider: BuildPipelineProvider) {
    this.dependencies.providers.unavailable(this.context.environmentId, branch.agent, provider);
  }

  async executionPolicy(): Promise<NativeAgentExecutionPolicy> {
    return this.input.facts.policy;
  }

  // ------------------------------------------------------------ results

  supportsToolResult(branch: AgentBranchRecord): boolean {
    if (!this.dependencies.workflowResults) return false;
    // A step with nothing to submit completes when its turn does.
    if (this.input.node.outputs.every((port) => port.type.startsWith("workspace@"))) return true;
    if (!this.dependencies.agentTools) return false;
    return this.dependencies.toolResultsEnabled?.(branch.agent) ?? true;
  }

  get prepareResult() {
    return this.dependencies.workflowResults ? this.prepareSlots : undefined;
  }

  private readonly prepareSlots = async (
    branch: AgentBranchRecord,
    requestId: string,
  ): Promise<void> => {
    const results = await this.slots();
    this.input.state.resultKeys = results.keys(requestId);
    await results.prepare(requestId, branch.agent);
  };

  private capability(keys: readonly string[]): string | undefined {
    const service = this.dependencies.workflowResults;
    if (!this.broker || !service || keys.length === 0) return undefined;
    const scope = {
      environmentId: this.context.environmentId,
      projectId: this.context.run.projectId,
    };
    return keys.length === 1
      ? service.capabilityToken(scope, keys[0]!)
      : service.activationCapabilityToken(scope, keys);
  }

  async agentMcp(
    branch: AgentBranchRecord,
    requestId: string,
  ): Promise<AgentToolConnection | undefined> {
    const tools = this.dependencies.agentTools;
    const results = await this.slots();
    const keys = results.keyList(requestId);
    if (!tools || keys.length === 0) return undefined;
    const local = this.input.environment.environmentType === "local";
    if (!local) {
      await this.dependencies.assertAgentToolsReachable?.(this.context.environmentId, "Graph step");
    }
    const target = local ? "host" : "container";
    const { environmentId } = this.context;
    const projectId = this.context.run.projectId;
    if (this.broker) {
      const connection = tools.workflowResultConnection(
        environmentId,
        projectId,
        target,
        keys[0]!,
        branch.agent,
      );
      const capability = this.capability(keys);
      return capability ? { ...connection, workflowResultCapability: capability } : connection;
    }
    return keys.length === 1
      ? tools.workflowResultConnection(environmentId, projectId, target, keys[0]!)
      : tools.workflowResultActivationConnection(environmentId, projectId, target, keys);
  }

  private resultTools(): GraphResultTools {
    return this.broker ? "broker" : "port";
  }

  private extraTools(): string[] {
    const actions = this.input.node.grantedActions;
    return [
      ...(actions.reportProgress.length > 0 ? ["report_progress"] : []),
      ...(actions.readArtifact ? ["read_artifact"] : []),
      ...(actions.askHuman ? ["ask_human"] : []),
    ];
  }

  resultTurn(_branch: AgentBranchRecord, requestId: string): AgentBranchResultTurn {
    const results = this.results;
    const keys = results ? results.keys(requestId) : this.input.state.resultKeys;
    const slots = (results?.slots ?? []).map((slot) => ({
      tool: this.broker ? "submit_graph_output" : `submit_${slot.port.name}`,
      resultKey: keys[slot.port.name]!,
    }));
    const first = slots[0];
    const extra = this.extraTools();
    const toolName = this.broker
      ? "submit_graph_output"
      : (results?.missingTool() ?? "the result tools");
    if (!first) return { toolName, prepare: { workflowResultTool: toolName }, send: {} };
    return {
      toolName,
      prepare: {
        workflowResultTool: first.tool,
        workflowResultSlots: slots,
        ...(extra.length > 0 ? { workflowResultExtraTools: extra } : {}),
      },
      send: {
        workflowResultTool: first.tool,
        workflowResultKey: first.resultKey,
        workflowResultSlots: slots,
        ...(extra.length > 0 ? { workflowResultExtraTools: extra } : {}),
      },
    };
  }

  resultSchema(): JsonSchema {
    const results = this.results;
    return results && results.slots.length > 0
      ? results.combinedSchema()
      : ({ type: "object", properties: {}, additionalProperties: false } as JsonSchema);
  }

  resultInstruction(
    branch: AgentBranchRecord,
    requestId: string,
    agentMcp: AgentToolConnection | undefined,
  ): string {
    // The original prompt's system contract already carries the instruction
    // for its request; follow-up turns (repair, reminder, continuation, an
    // answer) get the instruction for their own new request.
    if (branch.schemaRepairPrompt === undefined && branch.continuationPrompt === undefined)
      return "";
    const results = this.results;
    if (!results || results.slots.length === 0) return "";
    const keys = results.keys(requestId);
    const capability = agentMcp?.workflowResultCapability ?? this.capability(Object.values(keys));
    return graphOutputResultInstruction({
      slots: results.slots.map((slot) => ({
        port: slot.port.name,
        type: slot.port.type,
        required: slot.required,
        resultKey: keys[slot.port.name]!,
      })),
      ...(capability ? { capability } : {}),
      tools: this.resultTools(),
    });
  }

  async projectResult(requestId: string) {
    return (await this.slots()).project(requestId);
  }

  async readResult<T>(requestId: string): Promise<StructuredOutputResult<T> | null> {
    const results = await this.slots();
    if (results.slots.length === 0) return this.turnCompletion<T>(requestId);
    return (await results.read(requestId)) as StructuredOutputResult<T> | null;
  }

  async dispatchProof<T>(requestId: string): Promise<StructuredOutputResult<T> | null> {
    const results = await this.slots();
    if (results.slots.length === 0) return null;
    return (await results.proof(requestId)) as StructuredOutputResult<T> | null;
  }

  /** A step with nothing to submit: its result is its turn ending normally. */
  private async turnCompletion<T>(requestId: string): Promise<StructuredOutputResult<T> | null> {
    const session = this.context.activation.session;
    const providerSessionId = session?.providerSessionId;
    if (!providerSessionId) return null;
    const provider = await this.dependencies.providers.get(
      this.input.environment,
      session!.agent,
      this.context.activation.key,
    );
    const observation = await readProviderStatus(provider, providerSessionId, requestId);
    if (observation.status !== "idle" || observation.turnSettled === false) return null;
    if (observation.interruption === "restart") return null;
    return { ok: true, provider: session!.agent, requestId, value: {} as T };
  }

  heldResult(requestId: string) {
    const held = this.results?.held(requestId);
    return held ? { digest: held.digest, ageMs: held.ageMs } : undefined;
  }

  claimResultNudge(requestId: string): boolean {
    return this.results?.claimNudge(requestId) ?? false;
  }

  async consumeResult(requestId: string): Promise<void> {
    await (await this.slots()).consume(requestId);
  }

  stageResultConsumption(requestId: string): void {
    const results = this.results;
    if (!results || results.slots.length === 0) return;
    this.executor.deferConsumption(`${this.context.run.id}\0${requestId}`, () =>
      results.consume(requestId),
    );
  }

  finishResultConsumption(requestId: string): void {
    this.executor.finishConsumption(`${this.context.run.id}\0${requestId}`);
  }

  async closeResult(requestId: string): Promise<void> {
    const results = await this.slots();
    if (results.slots.length > 0) await results.close(requestId);
  }

  parseResult(
    branch: AgentBranchRecord,
    result: StructuredOutputResult<unknown>,
  ): AgentBranchParsedResult {
    if (!this.results || this.results.slots.length === 0) return { success: true, data: {} };
    return this.results.parse(branch.resultTransport, result);
  }

  repairPrompt(
    _branch: AgentBranchRecord,
    issues: readonly ReviewContractValidationIssue[],
    attempt: number,
    maxAttempts: number,
  ): string {
    return structuredReportRepairPrompt(issues, attempt, maxAttempts, {
      schema: this.resultSchema(),
      resultLabel: "results",
      workLabel: "work",
      stageLabel: "step",
    });
  }

  /**
   * Certifies the turn (item 209), then stores each accepted value and the
   * runtime-filled `workspace@1` outputs. A guard that fails throws before
   * any artifact exists; the runner fails the branch with its message and the
   * evidence stays in the activation's guard results.
   */
  async acceptResult(_branch: AgentBranchRecord, data: unknown): Promise<void> {
    await this.certifyGuards();
    const results = await this.slots();
    const values = (data ?? {}) as Record<string, unknown>;
    const { run, activation } = this.context;
    const lineage = [
      ...new Set(
        Object.values(activation.inputs).flatMap((ids) => (Array.isArray(ids) ? ids : [ids])),
      ),
    ];
    const workspace =
      this.input.node.workspaceAccess === "none" ? undefined : await this.workspaceAfterTurn();
    const artifactWorkspace = workspace
      ? { headRef: workspace.headRef, ...(workspace.baseRef ? { baseRef: workspace.baseRef } : {}) }
      : undefined;
    // An `items` branch's outputs stand for its item (item 401).
    const sourceItem = graphAgentItemBinding(run, this.input.node, activation)?.item.id;
    for (const slot of results.slots) {
      if (!Object.hasOwn(values, slot.port.name)) continue;
      const value = values[slot.port.name];
      const itemIds = graphAgentItemIds(slot.definition, value, activation);
      const validation = results.validation(slot);
      const artifact = await this.context.artifacts.putValue({
        runId: run.id,
        type: slot.port.type,
        producer: { nodeId: activation.nodeId, activation: activation.key, port: slot.port.name },
        inputs: lineage,
        ...(artifactWorkspace ? { workspace: artifactWorkspace } : {}),
        ...(itemIds ? { itemIds } : {}),
        ...(sourceItem !== undefined ? { sourceItem } : {}),
        ...(validation ? { validation } : {}),
        value,
      });
      this.outputs[slot.port.name] = artifact.id;
    }
    for (const port of results.workspacePorts) {
      if (!workspace) {
        throw new Error(`Output ${port.name} is a workspace commit, but the step has no workspace`);
      }
      const artifact = await this.context.artifacts.putValue({
        runId: run.id,
        type: port.type,
        producer: { nodeId: activation.nodeId, activation: activation.key, port: port.name },
        inputs: lineage,
        workspace: artifactWorkspace!,
        ...(sourceItem !== undefined ? { sourceItem } : {}),
        value: {
          branch: workspace.branch,
          headRef: workspace.headRef,
          baseRef: workspace.baseRef ?? null,
        },
      });
      this.outputs[port.name] = artifact.id;
    }
  }

  private async certifyGuards(): Promise<void> {
    const facts = this.input.facts;
    try {
      const results = await this.executor.guards.certify({
        environment: this.input.environment,
        node: this.input.node,
        baseline: facts.baseline,
        runId: this.context.run.id,
        activationKey: this.context.activation.key,
        ...(facts.worktree ? { worktree: facts.worktree } : {}),
      });
      facts.guards = mergeGraphGuardResults(facts.guards, results);
    } catch (error) {
      if (error instanceof GraphAgentGuardError) {
        facts.guards = mergeGraphGuardResults(facts.guards, error.results);
        this.guardViolated = true;
      }
      throw error;
    }
  }

  /** `{branch, headRef, baseRef?}` from Git after the turn (agents do not hand-write commits). */
  private async workspaceAfterTurn(): Promise<{
    branch: string;
    headRef: string;
    baseRef?: string;
  }> {
    const git = this.dependencies.environmentGit;
    if (!git) throw new Error("The environment's Git is unavailable");
    const environmentId = this.context.environmentId;
    const worktree = this.input.facts.worktree;
    if (worktree) {
      // An isolated branch's commit is its own worktree's HEAD, on its branch (item 403).
      const head = (
        await git(environmentId, ["-C", worktree.path, "rev-parse", "--verify", "HEAD^{commit}"])
      ).trim();
      if (!GRAPH_COMMIT_PATTERN.test(head))
        throw new Error("The branch worktree's HEAD is not a commit");
      return { branch: worktree.branch, headRef: head, baseRef: worktree.baseRef };
    }
    const headRef = (await git(environmentId, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    if (!GRAPH_COMMIT_PATTERN.test(headRef)) throw new Error("The workspace HEAD is not a commit");
    let branch = (
      await git(environmentId, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")
    ).trim();
    if (!branch) branch = this.input.environment.branch || "HEAD";
    const inputs = this.inputs;
    const baseRef =
      inputs?.inputWorkspace?.headRef ??
      (await this.inputWorkspaceHead()) ??
      this.input.facts.baseline?.headRef;
    return { branch, headRef, ...(baseRef ? { baseRef } : {}) };
  }

  /** The commit a `workspace@1` input names, read from the store. */
  private async inputWorkspaceHead(): Promise<string | undefined> {
    for (const port of this.input.node.inputs) {
      if (!port.type.startsWith("workspace@")) continue;
      const id = this.context.activation.inputs[port.name];
      if (typeof id !== "string") continue;
      const artifact = await this.context.artifacts.get(this.context.run.id, id);
      const value = artifact && "value" in artifact.body ? artifact.body.value : undefined;
      const headRef = (value as { headRef?: unknown } | undefined)?.headRef;
      if (typeof headRef === "string") return headRef;
    }
    return undefined;
  }

  commitNudgeText(_branch: AgentBranchRecord, requestId: string, digest: string): string {
    const held = this.results?.held(requestId);
    const port = held?.port ?? this.results?.slots[0]?.port.name ?? "result";
    const submit = this.broker ? "submit_graph_output" : `submit_${port}`;
    const validate = this.broker ? "validate_workflow_result" : `validate_${port}`;
    const key = held?.key ?? "";
    return `Your \`${port}\` result already passed \`${validate}\`. If it is final, commit it now by calling \`${submit}\` with resultKey ${JSON.stringify(key)} (and the capability from your instructions, if one was given) and \`validatedDigest\` ${JSON.stringify(digest)}; leave \`result\` out so the large object is not sent again. If a call is rejected as unparseable, the brace count is off by one: recount and call again without shortening the result.`;
  }

  // ------------------------------------------------------------ prompt

  async branchPrompt(branch: AgentBranchRecord): Promise<string> {
    const inputs = await this.loadedInputs();
    const results = await this.slots();
    const requestId = branch.requestId!;
    const keys = results.keys(requestId);
    const capability = this.capability(Object.values(keys));
    const environment = this.input.environment;
    return renderGraphAgentPrompt({
      run: this.context.run,
      node: this.input.node,
      activation: this.context.activation,
      inputs,
      compiled: this.input.compiled,
      actions: this.input.node.grantedActions,
      enforcement: this.input.facts.enforcement,
      resultKeys: keys,
      ...(capability ? { capability } : {}),
      resultTools: this.resultTools(),
      ...(this.input.facts.worktree
        ? {
            worktree: {
              directory: graphBranchAbsolutePath(environment, this.input.facts.worktree.path),
              branch: this.input.facts.worktree.branch,
              baseRef: this.input.facts.worktree.baseRef,
              root: graphBranchRoot(environment),
            },
          }
        : {}),
      targetBranch:
        this.dependencies.targetBranch?.(environment) ??
        (environment.prBaseBranch?.trim() || environment.delegationBaseBranch?.trim() || "main"),
      ...(await this.notes()),
    });
  }

  private async notes(): Promise<{ notes?: string }> {
    const notes = await this.dependencies.projectNotes?.(this.context.run.projectId);
    return notes ? { notes } : {};
  }

  // ------------------------------------------------------------ persistence

  async save(): Promise<void> {
    await this.context.journal(this.facts(this.currentBranch, true));
  }

  async assertFence(): Promise<void> {
    if (this.context.signal.aborted) throw new GraphAgentStoppedFenceError();
  }

  /** The branch the runner is moving (set by the first call that names it). */
  private currentBranch: AgentBranchRecord | undefined;

  private facts(branch: AgentBranchRecord | undefined, journal: boolean) {
    const { facts, state } = this.input;
    const extras: GraphAgentSessionExtras = {
      resultKeys: state.resultKeys,
      ...(state.question ? { question: state.question } : {}),
      ...(state.questionsAsked !== undefined ? { questionsAsked: state.questionsAsked } : {}),
      ...(state.continuedFrom !== undefined ? { continuedFrom: state.continuedFrom } : {}),
      turnMode: state.turnMode,
      ...(state.transcript ? { transcript: state.transcript } : {}),
    };
    let session = branch ? graphAgentSession(branch, extras) : null;
    if (session && state.progress) session = { ...session, progress: state.progress };
    if (session && journal) {
      // Usage is reported, not journaled: the run's usage adds the delta
      // against the stored counters once, when the call reports.
      const snapshot = this.input.snapshot;
      session = { ...session };
      if (snapshot?.tokenCount !== undefined) session.tokenCount = snapshot.tokenCount;
      else delete session.tokenCount;
      if (snapshot?.cacheReadTokens !== undefined)
        session.cacheReadTokens = snapshot.cacheReadTokens;
      else delete session.cacheReadTokens;
    }
    return {
      policy: facts.policy,
      enforcement: facts.enforcement,
      ...(facts.enforcementReason !== undefined
        ? { enforcementReason: facts.enforcementReason }
        : {}),
      ...(facts.baseline ? { baseline: facts.baseline } : {}),
      ...(facts.worktree ? { worktree: facts.worktree } : {}),
      ...(facts.guards ? { guards: facts.guards } : {}),
      ...(session ? { session } : {}),
    };
  }

  /** The report for this call's outcome. */
  report(
    branch: AgentBranchRecord,
    state: "unchanged" | "running" | "awaiting-human" | "complete" | "failed" | "cancelled",
    extra: { observeAfterMs?: number | null } = {},
  ): GraphActivationReport {
    const facts = this.facts(branch, false);
    const usage = graphAgentUsageDelta(this.input.snapshot, branch);
    const common = { ...facts, ...(usage ? { usage } : {}), ...extra };
    switch (state) {
      case "complete":
        return { ...common, state, outputs: { ...this.outputs } };
      case "failed":
        return {
          ...common,
          state,
          error: branch.error ?? "The step failed",
          cause: this.guardViolated ? "guard-violation" : graphAgentFailureCause(this.failure),
        };
      case "cancelled":
        return { ...common, state };
      default:
        return { ...common, state };
    }
  }

  // ------------------------------------------------------------ questions

  /** Whether every required output of the request was accepted. */
  async requiredAccepted(requestId: string): Promise<boolean> {
    const results = await this.slots();
    if (results.slots.length === 0) return false;
    return (await results.read(requestId)) !== null;
  }

  /** Whether the provider says the current request's turn has settled. */
  async turnSettled(branch: AgentBranchRecord): Promise<boolean> {
    if (!branch.providerSessionId || !branch.requestId) return true;
    const provider = await this.provider(branch);
    const observation = await readProviderStatus(
      provider,
      branch.providerSessionId,
      branch.requestId,
    );
    if (observation.status === "running" || observation.status === "blocked") return false;
    return observation.turnSettled !== false;
  }

  // ------------------------------------------------------------ the rest

  resolveUnattendedInteractions(provider: BuildPipelineProvider, providerSessionId: string) {
    return resolveUnattendedReviewerInteractions(provider, providerSessionId, () =>
      this.assertFence(),
    );
  }

  async abandonSession(branch: AgentBranchRecord, providerSessionId: string): Promise<void> {
    try {
      const provider = await this.provider(branch);
      await provider.abort(providerSessionId);
    } catch {
      // Best-effort: the step is being discarded either way.
    }
  }

  branchFailed(_branch: AgentBranchRecord, kind: AgentBranchFailureKind): void {
    this.failure = kind;
  }

  async onObserved(
    branch: AgentBranchRecord,
    _index: number,
    _provider: BuildPipelineProvider,
    readTranscript: () => Promise<readonly unknown[]>,
    settling: boolean,
  ): Promise<void> {
    this.currentBranch = branch;
    const capture = this.dependencies.captureTranscript;
    if (!capture || !branch.providerSessionId) return;
    const reference = await capture({
      runId: this.context.run.id,
      activationKey: this.context.activation.key,
      providerSessionId: branch.providerSessionId,
      readTranscript,
      settling,
    });
    if (reference) this.input.state.transcript = reference;
  }

  /** The runner hands every journal write the branch it moves. */
  track(branch: AgentBranchRecord): void {
    this.currentBranch = branch;
  }
}
