/**
 * The contract of the shared agent branch runner (`agent-branch-runner.ts`).
 *
 * A *branch* is one unattended agent turn sequence a workflow owns: a Multi
 * Review or pipeline reviewer, or a graph agent activation (item 204). The
 * runner drives it through session creation, the dispatch journal
 * (`prepared → dispatching → sent`), proof-based recovery, observation,
 * result reading, bounded schema repair, the one result reminder, the one
 * restart continuation, token metering and transcript capture.
 *
 * What a branch *is* — its prompt, its result contract, how an accepted
 * result is kept, where the record is persisted and which lease fences it —
 * belongs to its owner, behind {@link AgentBranchHost}. The runner holds no
 * state of its own beyond the host: every field it writes on the record is a
 * durable one, because the turn it describes runs inside the environment and
 * outlives this process.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { ProviderSessionRegistration } from "./agent-provider-contract.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { ReviewContractValidationIssue } from "@orkestrator/protocol/structured-review";
import type {
  WorkflowResultSubmissionState,
  WorkflowResultTransport,
} from "@orkestrator/protocol/workflow-results";
import type { AgentToolConnection } from "./agent-tools.js";
import type {
  BuildPipelineProvider,
  ProviderPrepareDispatchOptions,
  ProviderSendOptions,
} from "./build-pipeline-provider.js";
import type {
  EfficiencyOwner,
  EfficiencyPhase,
  MultiReviewEfficiencyObserver,
} from "./multi-review-efficiency.js";
import type { MultiReviewProgressTracker } from "./multi-review-progress.js";
import type { ReviewFanoutConcurrency } from "./review-fanout-scheduler.js";
import type { ArtifactTurnDispatch } from "./workflow-artifact-turns.js";

export type AgentBranchStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type AgentBranchDispatchState = "prepared" | "dispatching" | "sent";

/**
 * The durable fields of one branch the runner reads and writes. A Multi
 * Review `ReviewerRecord` is one (it adds the review's own fields); a graph
 * activation keeps them in its session (`graph-agent-state.ts`).
 */
export interface AgentBranchRecord {
  /** Stable within the owner; scopes poll gates. */
  id: string;
  agent: AgentPlatform;
  model?: string;
  /** The owner pinned no model, and `model` is a display placeholder. */
  modelUnpinned?: boolean;
  reasoningEffort?: string;
  fastMode?: boolean;
  status: AgentBranchStatus;
  sessionKey?: string;
  providerSessionId?: string;
  requestId?: string;
  dispatchState?: AgentBranchDispatchState;
  resultTransport?: WorkflowResultTransport;
  resultSubmission?: WorkflowResultSubmissionState;
  schemaRepairAttempts?: number;
  schemaRepairPrompt?: string;
  /** A continuation turn sent in the same session (reminder, restart, answer). */
  continuationPrompt?: string;
  resultReminderSent?: boolean;
  restartContinuationSent?: boolean;
  idleResultPolls?: number;
  progressAt?: string;
  progressDigest?: string;
  stalledSince?: string;
  error?: string;
  /** Failed before its first agent turn was accepted: the agent could not be started. */
  startFailed?: boolean;
  /** Whether this session has accepted an agent turn (allocation alone is insufficient). */
  agentStarted?: boolean;
  tokenCount?: number;
  cacheReadTokens?: number;
  usageFinalizationPolls?: number;
  commandSandboxOff?: string;
  startedAt?: string;
  completedAt?: string;
}

export type AgentBranchFailureKind = "provider" | "result" | "system";

/** A result that failed its contract: the repair turn quotes `issues`. */
export interface AgentBranchContractFailure {
  message: string;
  issues: readonly ReviewContractValidationIssue[];
}

export type AgentBranchParsedResult =
  { success: true; data: unknown } | { success: false; error: AgentBranchContractFailure };

/** See {@link AgentBranchHost.pollGate}. Scopes are process-local identifiers. */
export interface AgentBranchPollGate {
  count(scope: string): boolean;
  exhausted(scope: string, count: number, limit: number): boolean;
  clear(scope: string): void;
}

/**
 * Words the runner puts in user-facing failure text. A reviewer's owner
 * passes `reviewer`, `structured report`, `review`; a graph node its own.
 */
export interface AgentBranchWording {
  /** Lower-case noun: "reviewer". Sentences read "The reviewer …". */
  subject: string;
  /** "structured report". */
  resultLabel: string;
  /** "review": what a restart continuation continues. */
  workLabel: string;
  /** "a valid report": what repair attempts failed to produce. */
  validResult: string;
  /** Why a stalled branch is stopped: "so the rest of the review could continue". */
  stallStopReason: string;
}

/** The result tool a turn exposes, as attach and send pass it to the provider. */
export interface AgentBranchResultTurn {
  /** The submission tool named in reminders and continuations. */
  toolName: string;
  /** Spread into `prepareDispatch` options when the turn has a result connection. */
  prepare: Pick<ProviderPrepareDispatchOptions, "workflowResultTool"> &
    Partial<ProviderPrepareDispatchOptions>;
  /** Spread into `send` options when the turn has a result connection. */
  send: Partial<ProviderSendOptions>;
}

export interface AgentBranchHost<B extends AgentBranchRecord = AgentBranchRecord> {
  /** Identifies the owner in poll-gate scopes. */
  readonly workflowId: string;
  /** The provider session phase (`createSession`'s first argument). */
  readonly sessionPhase: string;
  /** Prefix of the runner's log lines for this host; default `[review-fanout]`. */
  readonly logPrefix?: string;
  /** Plan turns are read-only (the runner adds the read-only boundary). */
  readonly mode?: "plan" | "build";
  readonly wording: AgentBranchWording;
  /** Durable session key for one branch. Must be stable across restarts. */
  sessionKeyFor(branch: B, index: number): string;
  sessionLabelFor(branch: B, index: number): string;
  /** OpenCode's durable reviewer marker for this branch's session. */
  reviewerSession?(branch: B): boolean;
  interactionContext(branch: B, fence: string | undefined): ProviderSessionRegistration;
  provider(branch: B): Promise<BuildPipelineProvider>;
  /** See `ReviewFanoutHost.providerUnavailable`. */
  providerUnavailable?(branch: B, provider: BuildPipelineProvider): Promise<void>;
  /** Trusted policy for the branch's session, never provider defaults. */
  executionPolicy(branch: B): Promise<NativeAgentExecutionPolicy>;
  agentMcp?(branch: B, requestId: string): Promise<AgentToolConnection | undefined>;
  prepareResult?(branch: B, requestId: string, schema: JsonSchema): Promise<void>;
  supportsToolResult?(branch: B): boolean;
  readResult?<T>(requestId: string): Promise<StructuredOutputResult<T> | null>;
  /**
   * A result that proves a recovered request reached the provider (it can
   * only have come from that request's own turn). Defaults to {@link readResult}.
   */
  dispatchProof?<T>(requestId: string): Promise<StructuredOutputResult<T> | null>;
  projectResult?(requestId: string): Promise<WorkflowResultSubmissionState | undefined>;
  heldResult?(requestId: string): { digest: string; ageMs: number } | undefined;
  claimResultNudge?(requestId: string): boolean;
  consumeResult?(requestId: string): Promise<void>;
  stageResultConsumption?(requestId: string): void;
  finishResultConsumption?(requestId: string): void;
  closeResult?(requestId: string): Promise<void>;
  /** Persists the owner's record. The runner serializes every call. */
  save(): Promise<void>;
  /** Throws if this process no longer owns the branch. */
  assertFence(): Promise<void>;
  /** The branch's original, evidence-bearing prompt. */
  branchPrompt(branch: B, index: number, count: number): Promise<string>;
  /** The result contract, for slot preparation and structured output. */
  resultSchema(branch: B): JsonSchema;
  /** The result-tool instruction appended to a tool-transport turn; empty appends nothing. */
  resultInstruction(
    branch: B,
    requestId: string,
    agentMcp: AgentToolConnection | undefined,
  ): string;
  resultTurn(branch: B, requestId: string): AgentBranchResultTurn;
  /** Reads a result as data or a contract failure; throws for a provider fault. */
  parseResult(branch: B, result: StructuredOutputResult<unknown>): AgentBranchParsedResult;
  repairPrompt(
    branch: B,
    issues: readonly ReviewContractValidationIssue[],
    attempt: number,
    maxAttempts: number,
  ): string;
  /** Keeps an accepted result on the branch before it is committed `completed`. */
  acceptResult(branch: B, data: unknown): void | Promise<void>;
  /** Text of the one steer that asks a live turn to commit a validated result. */
  commitNudgeText(branch: B, requestId: string, digest: string): string;
  /** Drops owner-side queue fields when a branch leaves `pending` or fails. */
  clearAdmission?(branch: B): void;
  resolveUnattendedInteractions(
    provider: BuildPipelineProvider,
    providerSessionId: string,
  ): Promise<void>;
  /** Best-effort abort of a session the owner is discarding. */
  abandonSession(branch: B, providerSessionId: string): Promise<void>;
  /** Errors that end the whole pass instead of failing one branch. */
  isPassFatal?(error: unknown): boolean;
  /**
   * Told why a branch failed, as it is committed `failed`: the provider or
   * session (`provider`), its result contract (`result`: repairs spent, or no
   * result after the reminder), or anything else (`system`). Owners that
   * classify failures (graph retry causes) use it; it changes nothing.
   */
  branchFailed?(branch: B, kind: AgentBranchFailureKind): void;
  readonly pollGate?: AgentBranchPollGate;
  /** Whether provider-session usage is persisted on the branch. */
  readonly captureUsage?: boolean;
  readonly persistUsageImmediately?: boolean;
  readonly artifactTurns?: {
    dispatch: ArtifactTurnDispatch;
    environmentId: string;
    projectId: string;
  };
  /** See `ReviewFanoutHost.onReviewerObserved`. */
  onObserved?(
    branch: B,
    index: number,
    provider: BuildPipelineProvider,
    readTranscript: () => Promise<readonly unknown[]>,
    settling: boolean,
  ): Promise<void>;
  readonly progress: MultiReviewProgressTracker;
  readonly stallWarningMs?: number;
  readonly stallAbandonMs?: number;
  readonly concurrency?: Partial<ReviewFanoutConcurrency>;
  readonly efficiency?: MultiReviewEfficiencyObserver;
  readonly efficiencyOwner?: EfficiencyOwner;
  readonly efficiencyPhase?: EfficiencyPhase;
}

/** A pre-dispatch policy read can be retried because no provider request ran. */
export class AgentBranchPolicyUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Reviewer execution policy is temporarily unavailable", { cause });
    this.name = "ReviewerPolicyUnavailableError";
  }
}

/** Broker or permission setup failed before the prompt request was written. */
export class AgentBranchDispatchSetupError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : "Reviewer dispatch setup is temporarily unavailable",
      { cause },
    );
    this.name = "ReviewerDispatchSetupError";
  }
}

/** The result contract could not be met within the repair budget. */
export class AgentBranchResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBranchResultError";
  }
}

/** The runner's log prefix when the host names none (review fan-outs). */
export const AGENT_BRANCH_LOG_PREFIX = "[review-fanout]";

export function agentBranchNowIso(): string {
  return new Date().toISOString();
}

export function agentBranchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function agentBranchSettled(branch: Pick<AgentBranchRecord, "status">): boolean {
  return (
    branch.status === "completed" || branch.status === "failed" || branch.status === "cancelled"
  );
}

/** A branch whose next step is session creation or prompt dispatch. */
export function agentBranchNeedsDispatch(
  branch: Pick<AgentBranchRecord, "status" | "dispatchState">,
): boolean {
  return (
    branch.status === "pending" ||
    branch.dispatchState === "prepared" ||
    branch.dispatchState === "dispatching"
  );
}

/**
 * The model to dispatch a branch's turn under, or `undefined` for "unset".
 *
 * A branch that pinned nothing says so explicitly, because the placeholder
 * cannot: `"default"` is a real Claude catalog id — the bridge resolves it to
 * Opus with a 1M context — so for Claude it is a selection to be forwarded,
 * while for every other harness it is only the launcher's stand-in for a
 * catalogue it does not have yet. This is the same line `stepModel` draws for
 * a single-reviewer review step.
 */
export function agentBranchModel(
  branch: Pick<AgentBranchRecord, "agent" | "model" | "modelUnpinned">,
): string | undefined {
  if (branch.modelUnpinned) return undefined;
  return branch.model === "default" && branch.agent !== "claude" ? undefined : branch.model;
}
