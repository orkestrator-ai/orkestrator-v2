/**
 * One `ask_agents` call as the shared agent branch runner's host: each target
 * is one branch, so a subork gets the same session creation, dispatch journal,
 * proof-based recovery, unattended interactions, stall bounds, result reminder,
 * repair turns and metering as a reviewer. What is its own is small: the prompt
 * is only what the caller wrote, the session is read-only, and the call's row in
 * storage is the durable record that a later process resumes from.
 */
import {
  renderSuborkPrompt,
  SUBORK_LIMITS,
  SUBORK_RESULT_KIND,
  suborkOneLine,
} from "@orkestrator/protocol/suborks";
import { boundedUtf8Head } from "@orkestrator/protocol/native-agent-goal";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { ReviewContractValidationIssue } from "@orkestrator/protocol/structured-review";
import {
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultInstruction,
  workflowResultToolName,
  type WorkflowResultSubmissionState,
} from "@orkestrator/protocol/workflow-results";
import {
  resolveUnattendedReviewerInteractions,
  unattendedBranchInteraction,
} from "./agent-branch-runner.js";
import type {
  AgentBranchHost,
  AgentBranchParsedResult,
  AgentBranchPollGate,
  AgentBranchResultTurn,
  AgentBranchWording,
} from "./agent-branch-types.js";
import type { AgentToolConnection } from "./agent-tools.js";
import { structuredReportRepairPrompt } from "./build-pipeline-prompts.js";
import { readProviderStatus, type BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { GraphAgentProviders } from "./graph-agent-providers.js";
import type { GraphRunTranscriptCapture } from "./graph-run-transcripts.js";
import type { Environment } from "./models.js";
import type { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { resolveEnvironmentExecutionPolicy } from "./native-agent-execution-policy.js";
import type { RecordUsageTurnsInput } from "./usage-history-store.js";
import type { PersistedSuborkBatch, PersistedSuborkBranch } from "./storage-suborks.js";
import type { WorkflowResultService } from "./workflow-result-service.js";
import { LAST_ASSISTANT_TEXT_READ_LIMIT, lastAssistantText } from "./workflow-result-missing.js";

const SUBMIT_TOOL = workflowResultToolName(SUBORK_RESULT_KIND);
/** A running subork's latest action is read at most this often. */
const ACTION_READ_INTERVAL_MS = 5_000;
/** Enough rows to reach the latest action past a turn's closing tool results. */
const ACTION_READ_MESSAGES = 4;

const WORDING: AgentBranchWording = Object.freeze({
  subject: "subork",
  resultLabel: "answer",
  workLabel: "work",
  validResult: "a valid answer",
  stallStopReason: "so the other answers could be returned",
});

/** This process no longer owns the call: it was stopped, or the backend is stopping. */
export class SuborkFenceError extends Error {
  constructor(message = "The subork call is no longer running") {
    super(message);
    this.name = "SuborkFenceError";
  }
}

export type SuborkResultService = Pick<
  WorkflowResultService,
  | "prepare"
  | "projection"
  | "heldValidation"
  | "claimCommitNudge"
  | "structured"
  | "consume"
  | "close"
>;

export interface SuborkHostDependencies {
  providers: GraphAgentProviders;
  workflowResults: SuborkResultService;
  agentTools: {
    workflowResultConnection(
      environmentId: string,
      projectId: string,
      target: "host" | "container",
      resultKey: string,
      provider?: PersistedSuborkBranch["agent"],
    ): AgentToolConnection;
  };
  assertAgentToolsReachable?(environmentId: string, stage: string): Promise<void>;
  /** Saves the row when it is still at the batch's revision; throws a fence error when not. */
  save(batch: PersistedSuborkBatch): PersistedSuborkBatch;
  /** Throws a fence error when the call is no longer running. */
  assertRunning(batch: PersistedSuborkBatch): void;
  captureTranscript: GraphRunTranscriptCapture;
  recordUsage?(input: RecordUsageTurnsInput): void;
  deferConsumption(requestId: string): void;
  finishConsumption(requestId: string): void;
  progress: MultiReviewProgressTracker;
  pollGate?: AgentBranchPollGate;
  stallWarningMs?: number;
  stallAbandonMs?: number;
}

/** The argument of a tool call that says the most about what it is doing. */
function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * One line saying what a transcript's newest row is doing, from the normalized
 * transcript shape every provider's messages share. Undefined when the rows say
 * nothing yet, so a row keeps its previous line rather than going blank.
 */
export function suborkLatestAction(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; parts?: unknown } | null;
    if (!message || message.role === "user" || !Array.isArray(message.parts)) continue;
    for (let at = message.parts.length - 1; at >= 0; at -= 1) {
      const part = message.parts[at] as {
        type?: unknown;
        content?: unknown;
        toolName?: unknown;
        toolTitle?: unknown;
        toolArgs?: unknown;
      } | null;
      if (!part) continue;
      if (part.type === "thinking") return "Thinking";
      if (typeof part.toolName === "string" && part.toolName) {
        const name =
          typeof part.toolTitle === "string" && part.toolTitle ? part.toolTitle : part.toolName;
        const detail = toolDetail(part.toolArgs);
        return suborkOneLine(detail ? `${name}: ${detail}` : name);
      }
      if (part.type === "text" && typeof part.content === "string" && part.content.trim()) {
        return suborkOneLine(part.content);
      }
    }
  }
  return undefined;
}

export class SuborkBranchHost implements AgentBranchHost<PersistedSuborkBranch> {
  readonly workflowId: string;
  readonly sessionPhase = "review";
  readonly logOwner = "subork";
  /** A plan turn is read-only: the runner adds the provider's read-only boundary. */
  readonly mode = "plan" as const;
  readonly wording = WORDING;
  readonly captureUsage = true;
  readonly environmentId: string;
  readonly progress: MultiReviewProgressTracker;
  readonly pollGate?: AgentBranchPollGate;
  readonly stallWarningMs?: number;
  readonly stallAbandonMs?: number;
  private readonly textAnswers = new Set<string>();
  private readonly actionReadAt: Map<string, number>;

  constructor(
    private readonly dependencies: SuborkHostDependencies,
    /** Mutated in place: the runner writes the branches, and each save refreshes the revision. */
    readonly batch: PersistedSuborkBatch,
    private readonly environment: Environment,
    actionReadAt: Map<string, number>,
  ) {
    this.workflowId = `subork:${batch.id}`;
    this.environmentId = batch.environmentId;
    this.progress = dependencies.progress;
    this.actionReadAt = actionReadAt;
    if (dependencies.pollGate) this.pollGate = dependencies.pollGate;
    if (dependencies.stallWarningMs !== undefined)
      this.stallWarningMs = dependencies.stallWarningMs;
    if (dependencies.stallAbandonMs !== undefined)
      this.stallAbandonMs = dependencies.stallAbandonMs;
  }

  /** A fresh key for every subork: no provider can resume someone else's conversation. */
  sessionKeyFor(branch: PersistedSuborkBranch): string {
    return branch.sessionKey ?? `subork:${this.batch.id}:${branch.id}`;
  }

  sessionLabelFor(branch: PersistedSuborkBranch): string {
    return `Subork · ${branch.name}`;
  }

  reviewerSession(): boolean {
    // OpenCode's durable reviewer marker admits its constrained read-only shell.
    return true;
  }

  interactionContext(branch: PersistedSuborkBranch, fence: string | undefined) {
    return unattendedBranchInteraction({
      origin: "automated-review",
      reviewerSession: true,
      phase: this.sessionPhase,
      workflowId: this.workflowId,
      provider: branch.agent,
      fence,
    });
  }

  provider(branch: PersistedSuborkBranch): Promise<BuildPipelineProvider> {
    return this.dependencies.providers.get(this.environment, branch.agent, branch.id);
  }

  async providerUnavailable(branch: PersistedSuborkBranch, provider: BuildPipelineProvider) {
    this.dependencies.providers.unavailable(this.environment.id, branch.agent, provider);
  }

  async executionPolicy(): Promise<NativeAgentExecutionPolicy> {
    return resolveEnvironmentExecutionPolicy(this.environment, "automated-review");
  }

  /** Admission already checked the rollout, so a running subork keeps its tools. */
  supportsToolResult(): boolean {
    return true;
  }

  async agentMcp(branch: PersistedSuborkBranch, requestId: string): Promise<AgentToolConnection> {
    const local = this.environment.environmentType === "local";
    if (!local) await this.dependencies.assertAgentToolsReachable?.(this.environment.id, "Subork");
    return this.dependencies.agentTools.workflowResultConnection(
      this.environment.id,
      this.environment.projectId,
      local ? "host" : "container",
      requestId,
      branch.agent,
    );
  }

  async prepareResult(branch: PersistedSuborkBranch, requestId: string): Promise<void> {
    await this.dependencies.workflowResults.prepare({
      resultKey: requestId,
      kind: SUBORK_RESULT_KIND,
      environmentId: this.environment.id,
      projectId: this.environment.projectId,
      provider: branch.agent,
    });
  }

  resultSchema(): JsonSchema {
    return {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string", minLength: 1 } },
    } as JsonSchema;
  }

  resultInstruction(
    _branch: PersistedSuborkBranch,
    requestId: string,
    agentMcp: AgentToolConnection | undefined,
  ): string {
    const capability = agentMcp?.workflowResultCapability;
    return workflowResultInstruction(
      SUBORK_RESULT_KIND,
      requestId,
      capability ? { capability } : {},
    );
  }

  resultTurn(_branch: PersistedSuborkBranch, requestId: string): AgentBranchResultTurn {
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
   * The accepted answer. Past the one reminder a turn that replied in prose has
   * still answered: a subork's result is text, so that text is the answer rather
   * than a reason to fail it. A slot that spent its corrections asks for a repair.
   */
  async readResult<T>(requestId: string): Promise<StructuredOutputResult<T> | null> {
    const results = this.dependencies.workflowResults;
    const accepted = await results.structured<T>(requestId);
    if (accepted) return accepted;
    const branch = this.batch.suborks.find((candidate) => candidate.requestId === requestId);
    if ((await results.projection(requestId)) === "needs-attention") {
      return {
        ok: false,
        provider: branch?.agent ?? "claude",
        requestId,
        error: {
          code: "schema_retry_exhausted",
          message: "Every answer submitted in the last turn was refused.",
          provider: branch?.agent ?? "claude",
          retryable: true,
        },
      };
    }
    if (!branch?.resultReminderSent || !branch.providerSessionId) return null;
    const provider = await this.provider(branch);
    const text = lastAssistantText(
      await provider
        .messages(branch.providerSessionId, {
          limit: Math.min(
            LAST_ASSISTANT_TEXT_READ_LIMIT,
            provider.messageReadLimit ?? LAST_ASSISTANT_TEXT_READ_LIMIT,
          ),
        })
        .catch(() => undefined),
    );
    if (!text?.trim()) return null;
    this.textAnswers.add(requestId);
    return { ok: true, provider: branch.agent, requestId, value: { answer: text } as T };
  }

  /** Only an accepted answer proves a recovered request reached the provider. */
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
    const results = this.dependencies.workflowResults;
    // An answer taken from the transcript leaves its slot open with nothing in it.
    return this.textAnswers.delete(requestId)
      ? results.close(requestId, "superseded")
      : results.consume(requestId);
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
    _branch: PersistedSuborkBranch,
    result: StructuredOutputResult<unknown>,
  ): AgentBranchParsedResult {
    const refused = (message: string): AgentBranchParsedResult => ({
      success: false,
      error: {
        message,
        issues: [
          { path: "$", code: "invalid_value", message },
        ] as unknown as ReviewContractValidationIssue[],
      },
    });
    if (!result.ok) {
      if (
        result.error.code === "schema_retry_exhausted" ||
        result.error.code === "malformed_output"
      ) {
        return refused(result.error.message);
      }
      throw new Error(result.error.message);
    }
    const answer = (result.value as { answer?: unknown } | null)?.answer;
    if (typeof answer !== "string" || !answer.trim()) {
      return refused("The answer must be a non-empty string.");
    }
    return { success: true, data: { answer } };
  }

  repairPrompt(
    _branch: PersistedSuborkBranch,
    issues: readonly ReviewContractValidationIssue[],
    attempt: number,
    maxAttempts: number,
  ): string {
    return structuredReportRepairPrompt(issues, attempt, maxAttempts, {
      schema: this.resultSchema(),
      resultLabel: "answer",
      workLabel: "work",
      stageLabel: "subork",
    });
  }

  /** Keeps what fits; the marker on delivery says the rest is in the transcript. */
  acceptResult(branch: PersistedSuborkBranch, data: unknown): void {
    const answer = (data as { answer: string }).answer;
    const kept = boundedUtf8Head(answer, SUBORK_LIMITS.storedAnswerMaxBytes);
    branch.answer = kept;
    if (kept.length < answer.length) branch.answerBytes = Buffer.byteLength(answer, "utf8");
    delete branch.latestAction;
  }

  commitNudgeText(_branch: PersistedSuborkBranch, requestId: string, digest: string): string {
    return `Your answer already passed \`${WORKFLOW_RESULT_VALIDATION_TOOL_NAME}\`. If it is final, commit it now by calling \`${SUBMIT_TOOL}\` with resultKey ${JSON.stringify(requestId)} (and the capability from your instructions, if one was given) and \`validatedDigest\` ${JSON.stringify(digest)}; leave \`result\` out so it is not sent again.`;
  }

  /** The whole of what a subork is told, and the only place its prompt comes from. */
  async branchPrompt(branch: PersistedSuborkBranch): Promise<string> {
    return renderSuborkPrompt(branch.prompt);
  }

  async save(): Promise<void> {
    const stored = this.dependencies.save(this.batch);
    this.batch.revision = stored.revision;
    this.batch.updatedAt = stored.updatedAt;
  }

  async assertFence(): Promise<void> {
    this.dependencies.assertRunning(this.batch);
  }

  resolveUnattendedInteractions(provider: BuildPipelineProvider, providerSessionId: string) {
    return resolveUnattendedReviewerInteractions(provider, providerSessionId, () =>
      this.assertFence(),
    );
  }

  async abandonSession(branch: PersistedSuborkBranch, providerSessionId: string): Promise<void> {
    try {
      const provider = await this.provider(branch);
      await provider.abort(providerSessionId);
    } catch {
      // Best-effort: the subork is ending either way.
    }
  }

  /** Display data only: nothing here may fail the subork. */
  async onObserved(
    branch: PersistedSuborkBranch,
    _index: number,
    provider: BuildPipelineProvider,
    readTranscript: () => Promise<readonly unknown[]>,
    settling: boolean,
  ): Promise<void> {
    const sessionId = branch.providerSessionId;
    if (!sessionId) return;
    const transcript = await this.dependencies.captureTranscript({
      runId: this.batch.id,
      activationKey: branch.id,
      providerSessionId: sessionId,
      readTranscript,
      settling,
    });
    if (transcript) branch.transcript = transcript;
    const now = Date.now();
    if (!settling && now - (this.actionReadAt.get(branch.id) ?? 0) >= ACTION_READ_INTERVAL_MS) {
      this.actionReadAt.set(branch.id, now);
      const action = suborkLatestAction(
        await provider.messages(sessionId, { limit: ACTION_READ_MESSAGES }).catch(() => []),
      );
      if (action) branch.latestAction = action;
    }
    if (settling) await this.recordUsage(branch, provider, sessionId);
  }

  /** A subork's turns reach the usage panes under its own row, in the caller's environment. */
  private async recordUsage(
    branch: PersistedSuborkBranch,
    provider: BuildPipelineProvider,
    sessionId: string,
  ): Promise<void> {
    if (!this.dependencies.recordUsage) return;
    const status = await readProviderStatus(provider, sessionId).catch(() => undefined);
    const turns = status?.contextUsage?.turns;
    if (!turns || turns.length === 0) return;
    this.dependencies.recordUsage({
      sessionKey: `${this.batch.sessionKey}\0subork\0${branch.id}`,
      environmentId: this.environmentId,
      platform: branch.agent,
      providerSessionId: sessionId,
      turns,
    });
  }
}
