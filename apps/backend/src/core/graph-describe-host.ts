/**
 * One "Describe a graph" job as the shared agent branch runner's host
 * (item 215): a read-only, unattended session in the designer's environment
 * whose one result slot is a `graph-template`. The runner owns the session,
 * the dispatch journal, recovery, observation, the result reminder and the
 * bounded repair turns; this host supplies the prompt, the slot, the
 * persistence (the job's row) and the fence. Built per pass by
 * `graph-describe-service.ts`; it holds nothing across passes.
 *
 * Two repair loops bound the corrections, as for review reports: inside a
 * turn, every refused submission returns the guard and compiler issues and
 * counts against the slot's rejection budget; a slot that exhausts its budget
 * becomes a contract failure here, and the runner sends a repair turn with a
 * fresh slot (at most `AGENT_BRANCH_MAX_SCHEMA_REPAIR_ATTEMPTS`).
 */
import {
  GRAPH_TEMPLATE_RESULT_KIND,
  graphTemplateJsonSchema,
  graphTemplateResultIssues,
} from "@orkestrator/protocol/graphs/describe";
import { renderGraphDescribePrompt } from "@orkestrator/protocol/graphs/describe-prompt";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { ReviewContractValidationIssue } from "@orkestrator/protocol/structured-review";
import {
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultInstruction,
  workflowResultToolName,
  type WorkflowResultSubmissionState,
  type WorkflowResultValidationIssue,
} from "@orkestrator/protocol/workflow-results";
import {
  resolveUnattendedReviewerInteractions,
  unattendedBranchInteraction,
} from "./agent-branch-runner.js";
import type {
  AgentBranchHost,
  AgentBranchParsedResult,
  AgentBranchPollGate,
  AgentBranchRecord,
  AgentBranchResultTurn,
  AgentBranchWording,
} from "./agent-branch-types.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { GraphAgentProviders } from "./graph-agent-providers.js";
import type { Environment } from "./models.js";
import type { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { resolveEnvironmentExecutionPolicy } from "./native-agent-execution-policy.js";
import type { PersistedGraphDescribeJob } from "./storage-graph-describe.js";
import type { WorkflowResultService } from "./workflow-result-service.js";

export const GRAPH_DESCRIBE_WORDING: AgentBranchWording = Object.freeze({
  subject: "designer agent",
  resultLabel: "graph template",
  workLabel: "draft",
  validResult: "a graph template that compiles",
  stallStopReason: "so the request could finish",
});

const SUBMIT_TOOL = workflowResultToolName(GRAPH_TEMPLATE_RESULT_KIND);

/** This process no longer owns the job: it was cancelled, replaced or the backend is stopping. */
export class GraphDescribeFenceError extends Error {
  constructor(message = "The describe job is no longer current") {
    super(message);
    this.name = "GraphDescribeFenceError";
  }
}

/** The workflow result calls a describe job makes. */
export type GraphDescribeResultService = Pick<
  WorkflowResultService,
  | "prepare"
  | "projection"
  | "heldValidation"
  | "claimCommitNudge"
  | "structured"
  | "consume"
  | "close"
>;

export interface GraphDescribeHostDependencies {
  providers: GraphAgentProviders;
  workflowResults: GraphDescribeResultService;
  agentTools: {
    workflowResultConnection(
      environmentId: string,
      projectId: string,
      target: "host" | "container",
      resultKey: string,
      provider?: AgentBranchRecord["agent"],
    ): AgentToolConnection;
  };
  assertAgentToolsReachable?(environmentId: string, stage: string): Promise<void>;
  /** Persists the job when its stored revision is still `job.revision`; returns the stored job. */
  save(job: PersistedGraphDescribeJob): PersistedGraphDescribeJob;
  /** Throws a fence error when `job` is no longer the environment's current job. */
  assertCurrent(job: PersistedGraphDescribeJob): void;
  /** Result slots whose consumption must be retried on a later pass. */
  deferConsumption(requestId: string): void;
  finishConsumption(requestId: string): void;
  progress: MultiReviewProgressTracker;
  pollGate?: AgentBranchPollGate;
  stallWarningMs?: number;
  stallAbandonMs?: number;
}

function contractIssues(
  issues: readonly WorkflowResultValidationIssue[],
): readonly ReviewContractValidationIssue[] {
  // The runner quotes path, code and message; compiler codes are not review codes.
  return issues as unknown as readonly ReviewContractValidationIssue[];
}

/**
 * The repair turn after a slot's correction budget ran out (or an accepted
 * draft no longer compiles): the diagnostics, and how to check before
 * submitting again.
 */
export function graphDescribeRepairPrompt(
  issues: readonly { path: string; code: string; message: string }[],
  attempt: number,
  maxAttempts: number,
): string {
  const listed = issues
    .slice(0, 16)
    .map((entry) => `- ${entry.code} at ${entry.path}: ${entry.message}`)
    .join("\n");
  return [
    `Your graph template was not accepted (repair ${attempt} of ${maxAttempts}). The backend checks every draft with the template guard and the compiler, and these problems remain:`,
    listed || "- The draft was refused after the allowed corrections in one turn.",
    `Fix each problem, then call \`${WORKFLOW_RESULT_VALIDATION_TOOL_NAME}\` with the complete template: it lists every remaining problem (code, path, message) without spending a correction. When it accepts the draft, submit that exact template with \`${SUBMIT_TOOL}\`. Keep everything the user asked for; change only what the problems require.`,
  ].join("\n\n");
}

export class GraphDescribeBranchHost implements AgentBranchHost<AgentBranchRecord> {
  readonly workflowId: string;
  readonly sessionPhase = "review";
  readonly mode = "plan" as const;
  readonly wording = GRAPH_DESCRIBE_WORDING;
  readonly progress: MultiReviewProgressTracker;
  readonly captureUsage = false;
  readonly pollGate?: AgentBranchPollGate;
  readonly stallWarningMs?: number;
  readonly stallAbandonMs?: number;

  constructor(
    private readonly dependencies: GraphDescribeHostDependencies,
    /** Mutated in place: the runner writes `job.branch`, and each save refreshes the revision. */
    readonly job: PersistedGraphDescribeJob,
    private readonly environment: Environment,
  ) {
    this.workflowId = `graph-describe:${job.id}`;
    this.progress = dependencies.progress;
    if (dependencies.pollGate) this.pollGate = dependencies.pollGate;
    if (dependencies.stallWarningMs !== undefined)
      this.stallWarningMs = dependencies.stallWarningMs;
    if (dependencies.stallAbandonMs !== undefined)
      this.stallAbandonMs = dependencies.stallAbandonMs;
  }

  // ------------------------------------------------------------ identity

  sessionKeyFor(branch: AgentBranchRecord): string {
    return branch.sessionKey ?? `graph-describe:${this.job.id}`;
  }

  sessionLabelFor(): string {
    return "Graphs · Describe a graph";
  }

  reviewerSession(): boolean {
    return true;
  }

  interactionContext(branch: AgentBranchRecord, fence: string | undefined) {
    return unattendedBranchInteraction({
      origin: "automated-review",
      reviewerSession: true,
      phase: this.sessionPhase,
      workflowId: this.workflowId,
      provider: branch.agent,
      fence,
    });
  }

  provider(branch: AgentBranchRecord): Promise<BuildPipelineProvider> {
    return this.dependencies.providers.get(this.environment, branch.agent, this.job.id);
  }

  async providerUnavailable(branch: AgentBranchRecord, provider: BuildPipelineProvider) {
    this.dependencies.providers.unavailable(this.environment.id, branch.agent, provider);
  }

  async executionPolicy(): Promise<NativeAgentExecutionPolicy> {
    return resolveEnvironmentExecutionPolicy(this.environment, "automated-review");
  }

  // ------------------------------------------------------------ results

  supportsToolResult(): boolean {
    // The start command admits a job only when the rollout allows the kind.
    return true;
  }

  async agentMcp(branch: AgentBranchRecord, requestId: string): Promise<AgentToolConnection> {
    const local = this.environment.environmentType === "local";
    if (!local) {
      await this.dependencies.assertAgentToolsReachable?.(this.environment.id, "Describe a graph");
    }
    return this.dependencies.agentTools.workflowResultConnection(
      this.environment.id,
      this.job.projectId,
      local ? "host" : "container",
      requestId,
      branch.agent,
    );
  }

  async prepareResult(branch: AgentBranchRecord, requestId: string): Promise<void> {
    await this.dependencies.workflowResults.prepare({
      resultKey: requestId,
      kind: GRAPH_TEMPLATE_RESULT_KIND,
      environmentId: this.environment.id,
      projectId: this.job.projectId,
      provider: branch.agent,
      context: this.job.context,
    });
  }

  resultSchema(): JsonSchema {
    return graphTemplateJsonSchema();
  }

  resultInstruction(
    _branch: AgentBranchRecord,
    requestId: string,
    agentMcp: AgentToolConnection | undefined,
  ): string {
    const capability = agentMcp?.workflowResultCapability;
    return workflowResultInstruction(
      GRAPH_TEMPLATE_RESULT_KIND,
      requestId,
      capability ? { capability } : {},
    );
  }

  resultTurn(_branch: AgentBranchRecord, requestId: string): AgentBranchResultTurn {
    return {
      toolName: SUBMIT_TOOL,
      prepare: { workflowResultTool: SUBMIT_TOOL },
      send: { workflowResultTool: SUBMIT_TOOL, workflowResultKey: requestId },
    };
  }

  projectResult(requestId: string): Promise<WorkflowResultSubmissionState | undefined> {
    return this.dependencies.workflowResults.projection(requestId);
  }

  /**
   * The accepted draft; or, once the slot spent its correction budget, a
   * failure the runner turns into a repair turn with a fresh slot.
   */
  async readResult<T>(requestId: string): Promise<StructuredOutputResult<T> | null> {
    const results = this.dependencies.workflowResults;
    const accepted = await results.structured<T>(requestId);
    if (accepted) return accepted;
    if ((await results.projection(requestId)) !== "needs-attention") return null;
    return {
      ok: false,
      provider: this.job.branch.agent,
      requestId,
      error: {
        code: "schema_retry_exhausted",
        message: "Every draft submitted in the last turn was refused by the template checks.",
        provider: this.job.branch.agent,
        retryable: true,
      },
    };
  }

  /** Only an accepted draft proves a recovered request reached the provider. */
  dispatchProof<T>(requestId: string): Promise<StructuredOutputResult<T> | null> {
    return this.dependencies.workflowResults.structured<T>(requestId);
  }

  heldResult(requestId: string) {
    return this.dependencies.workflowResults.heldValidation(requestId);
  }

  claimResultNudge(requestId: string): boolean {
    return this.dependencies.workflowResults.claimCommitNudge(requestId);
  }

  consumeResult(requestId: string): Promise<void> {
    return this.dependencies.workflowResults.consume(requestId);
  }

  stageResultConsumption(requestId: string): void {
    this.dependencies.deferConsumption(requestId);
  }

  finishResultConsumption(requestId: string): void {
    this.dependencies.finishConsumption(requestId);
  }

  closeResult(requestId: string): Promise<void> {
    return this.dependencies.workflowResults.close(requestId, "superseded");
  }

  parseResult(
    _branch: AgentBranchRecord,
    result: StructuredOutputResult<unknown>,
  ): AgentBranchParsedResult {
    if (!result.ok) {
      if (result.error.code === "schema_retry_exhausted") {
        return {
          success: false,
          error: {
            message: result.error.message,
            issues: contractIssues([
              { path: "$", code: "correction_budget_exhausted", message: result.error.message },
            ]),
          },
        };
      }
      throw new Error(result.error.message);
    }
    // The slot validated the draft at submission; the compiler is checked
    // again so a draft never completes a job that does not compile now.
    const issues = graphTemplateResultIssues(result.value, this.job.context);
    if (issues.length > 0) {
      return {
        success: false,
        error: { message: "The graph template does not compile.", issues: contractIssues(issues) },
      };
    }
    return { success: true, data: result.value };
  }

  repairPrompt(
    _branch: AgentBranchRecord,
    issues: readonly ReviewContractValidationIssue[],
    attempt: number,
    maxAttempts: number,
  ): string {
    return graphDescribeRepairPrompt(issues, attempt, maxAttempts);
  }

  acceptResult(_branch: AgentBranchRecord, data: unknown): void {
    this.job.template = data as GraphTemplateV1;
  }

  commitNudgeText(_branch: AgentBranchRecord, requestId: string, digest: string): string {
    return `Your graph template already passed \`${WORKFLOW_RESULT_VALIDATION_TOOL_NAME}\`. If it is final, commit it now by calling \`${SUBMIT_TOOL}\` with resultKey ${JSON.stringify(requestId)} (and the capability from your instructions, if one was given) and \`validatedDigest\` ${JSON.stringify(digest)}; leave \`result\` out so the large object is not sent again. If a call is rejected as unparseable, the brace count is off by one: recount and call again without shortening the template.`;
  }

  // ------------------------------------------------------------ prompt

  async branchPrompt(): Promise<string> {
    return renderGraphDescribePrompt({
      description: this.job.description,
      ...(this.job.baseDraft ? { baseDraft: this.job.baseDraft } : {}),
      ...(this.job.context.ceiling?.deny.length
        ? { deniedCapabilities: this.job.context.ceiling.deny }
        : {}),
    });
  }

  // ------------------------------------------------------------ persistence

  async save(): Promise<void> {
    const stored = this.dependencies.save(this.job);
    this.job.revision = stored.revision;
    this.job.updatedAt = stored.updatedAt;
  }

  async assertFence(): Promise<void> {
    this.dependencies.assertCurrent(this.job);
  }

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
      // Best-effort: the job is ending either way.
    }
  }
}
