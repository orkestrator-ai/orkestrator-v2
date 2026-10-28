import { isReviewValidationRun, type ReviewValidationRun } from "./review-validation.js";
import { isStructuredReviewReport, type StructuredReviewReport } from "./structured-review.js";
import { isPersistedReviewPackage, type PersistedReviewPackage } from "./review-workflow.js";
import {
  REVIEW_FANOUT_MAX_REVIEWERS,
  REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS,
  REVIEW_FANOUT_MIN_REVIEWERS,
  isReviewFanoutState,
  isReviewPanelOverlap,
  type ReviewFanoutState,
  type ReviewPanelOverlapV1,
} from "./review-fanout.js";
import {
  AGENT_INTERACTION_KINDS,
  AGENT_INTERACTION_LIMITS,
  AGENT_INTERACTION_PROVIDERS,
  isAgentInteractionPolicy,
  isAgentInteractionWorkflowSummary,
  isWithinTextLowerBound,
  type AgentInteractionKind,
  type AgentInteractionProvider,
  type AgentInteractionWorkflowSummary,
} from "./agent-interactions.js";
import { isWorkflowResultSubmissionState } from "./workflow-results.js";
import { isNativeAgentModelSubstitution } from "./native-agent.js";

export const BUILD_PIPELINE_VERSION = 2;

export type BuildPipelineAgent = "claude" | "opencode" | "codex" | "cursor" | "grok" | "pi";

/** The one list every agent check is built from. */
export const BUILD_PIPELINE_AGENTS: readonly BuildPipelineAgent[] = Object.freeze([
  "claude",
  "opencode",
  "codex",
  "cursor",
  "grok",
  "pi",
]);

export type BuildPipelineEnvironmentType = "containerized" | "local";

export type BuildPipelineNetworkAccessMode = "restricted" | "full";

export interface BuildPipelinePortMapping {
  containerPort: number;
  hostPort: number;
  protocol: "tcp" | "udp";
}

/**
 * Environment shaping a launcher chose before the pipeline existed.
 *
 * The pipeline creates its own environment, so a launcher that also collects a
 * name, a network mode or port mappings has nowhere else to put them. Absent
 * fields keep the pipeline's own defaults: a name derived from the task title,
 * and a restricted network for containers.
 */
export interface BuildPipelineEnvironmentOptions {
  name?: string;
  networkAccessMode?: BuildPipelineNetworkAccessMode;
  portMappings?: BuildPipelinePortMapping[];
}

export const MAX_BUILD_PIPELINE_PORT_MAPPINGS = 64;

export type TaskSnapshotImage = {
  filename: string;
  data: string;
};

export type TaskSnapshot = {
  title: string;
  description: string;
  acceptanceCriteria: string;
  comments: Array<{ text: string }>;
  images: TaskSnapshotImage[];
};

export type BuildPhase =
  | "creating-environment"
  | "starting-environment"
  | "waiting-for-setup"
  | "building"
  | "reviewing"
  | "addressing"
  | "verifying"
  | "fixing"
  | "creating-pr"
  | "resolving-conflicts"
  | "paused"
  | "complete"
  | "failed";

export type ResumableBuildPhase = Exclude<BuildPhase, "paused" | "complete" | "failed">;
export type PipelineSessionPhase =
  "build" | "review" | "address" | "verify" | "fix" | "pr" | "resolve-conflicts";

/** Durable handoff from an explicit UI restart to the background supervisor. */
export type PipelineRestartRequest =
  | { kind: "session"; phase: PipelineSessionPhase }
  | { kind: "review-package"; implementationPhase: "build" | "fix" }
  | { kind: "validation"; implementationPhase: "build" | "fix" };

/**
 * Durable handoff from an explicit UI skip to the background supervisor: the
 * stage that was stopped, whose successor the supervisor opens next.
 */
export type PipelineSkipRequest = {
  phase: Exclude<PipelineSessionPhase, "pr" | "resolve-conflicts">;
};

/**
 * One restart that rewound the pipeline to an earlier point of its loop.
 *
 * Restarting a step returns the pipeline to that step's own round
 * (`iteration`) and phase. Every session at or after that point is kept but
 * marked with this rewind's {@link id} in {@link PipelineSession.supersededBy}:
 * it is history, readable but excluded from the live loop, results and
 * verdicts. The code is not rewound; the new run continues on the current
 * worktree.
 */
export interface PipelineRewind {
  /** Named by {@link PipelineSession.supersededBy} on every session it superseded. */
  id: string;
  at: string;
  /** Where the pipeline was when the restart was requested. */
  fromPhase: BuildPhase;
  fromIteration: number;
  /** The round the pipeline rewound to. */
  iteration: number;
  /** The step that runs again; an earlier step of the same round when its inputs were gone. */
  step: PipelineRestartRequest;
  /** The session the restart named, when it named one. */
  sessionKey?: string;
  /** How many sessions this rewind superseded. */
  supersededSessions: number;
  /** Validation evidence invalidated by this rewind, retained with its history. */
  validationRun?: ReviewValidationRun;
  /** Replacement generation used to deduplicate current-step validation restarts. */
  replacementValidationRunId?: string;
}

/** The newest rewinds a record keeps; older entries are dropped, their sessions stay superseded. */
export const MAX_PIPELINE_REWINDS = 50;
/** The longest verification rationale copied onto a verify session. */
export const MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH = 16_000;

/** Whether a rewind superseded this session: history, never the live run. */
export function isSupersededPipelineSession(
  session: Pick<PipelineSession, "supersededBy"> | undefined,
): boolean {
  return session?.supersededBy !== undefined;
}

/** The sessions of the live run, in the order they started. */
export function livePipelineSessions(pipeline: Pick<BuildPipeline, "sessions">): PipelineSession[] {
  return pipeline.sessions.filter((session) => !isSupersededPipelineSession(session));
}

/** The steps a launcher can configure independently. */
export type BuildStepKey = "build" | "review" | "address" | "verify" | "pr" | "resolve-conflicts";

export const BUILD_STEP_KEYS: readonly BuildStepKey[] = Object.freeze([
  "build",
  "review",
  "address",
  "verify",
  "pr",
  "resolve-conflicts",
]);

/**
 * The harness, model and reasoning effort one step runs under.
 *
 * Held per step rather than per pipeline because a build may run one agent and
 * its review another. {@link BuildPipeline.agentType} stays the build step's
 * agent: that is the one the environment's default is configured for.
 */
export interface BuildStepConfig {
  agent: BuildPipelineAgent;
  model?: string;
  reasoningEffort?: string;
  /** Fast/Normal choice retained for exact prompt recovery. */
  fastMode?: boolean;
}

export type BuildStepConfigs = Partial<Record<BuildStepKey, BuildStepConfig>>;

/**
 * The reviewers the review step fans out to.
 *
 * One entry is the single-reviewer pipeline this has always been. More than one
 * turns the review stage into the same fan-out Multi Review runs: every
 * reviewer answers the structured-review contract independently against one
 * pinned worktree state, and a consolidation turn merges their reports into the
 * single {@link BuildPipeline.structuredReview} the address stage already
 * consumes. Nothing downstream of the review stage learns that there was more
 * than one reviewer.
 *
 * Held apart from `steps.review` because a step is one decision and this is a
 * list. `steps.review` remains the first reviewer, so a launcher that knows
 * nothing about fan-out still configures reviewer one.
 */
export const MAX_BUILD_PIPELINE_REVIEWERS = REVIEW_FANOUT_MAX_REVIEWERS;

/**
 * The effective reviewer list for a pipeline.
 *
 * A pipeline started before fan-out existed has no `reviewers`, so its review
 * step is the whole list. Reading it through here means no caller has to decide
 * what an absent list means.
 */
export function pipelineReviewerConfigs(
  pipeline: Pick<BuildPipeline, "reviewers" | "steps" | "agentType">,
): BuildStepConfig[] {
  if (pipeline.reviewers && pipeline.reviewers.length > 0) return pipeline.reviewers;
  return [pipeline.steps?.review ?? { agent: pipeline.agentType }];
}

/** True when the review stage has to run the shared reviewer fan-out. */
export function usesReviewFanout(
  pipeline: Pick<BuildPipeline, "reviewers" | "steps" | "agentType">,
): boolean {
  return pipelineReviewerConfigs(pipeline).length > 1;
}

/**
 * Backend label for one independent fan-out reviewer.
 *
 * Classic one-model reviews keep the distinct `Review Session` label, so the
 * build tab can tell the two apart without an extra session field.
 */
export function pipelineIndependentReviewLabel(index: number): string {
  return `Review ${index + 1}`;
}

const INDEPENDENT_REVIEW_LABEL = /^Review (\d+)$/;

/**
 * Zero-based reviewer slot encoded in {@link pipelineIndependentReviewLabel}.
 *
 * Identity stays attached to that slot even when an earlier reviewer never
 * created a session, or when a retry leaves leftover tiles in the same
 * iteration.
 */
export function pipelineIndependentReviewSlot(label: string): number | null {
  const match = INDEPENDENT_REVIEW_LABEL.exec(label);
  if (!match) return null;
  const slot = Number(match[1]) - 1;
  return Number.isInteger(slot) && slot >= 0 ? slot : null;
}

export function isPipelineIndependentReviewLabel(label: string): boolean {
  return pipelineIndependentReviewSlot(label) !== null;
}

/**
 * Which configured step owns a session phase.
 *
 * Every phase maps to its own step except `fix`: it re-implements against
 * verification feedback, which is build work, and it has no launcher control of
 * its own. Falling back to a repository default there would ignore the harness
 * the user just chose for the build.
 */
export function stepKeyForSessionPhase(phase: PipelineSessionPhase): BuildStepKey {
  if (phase === "fix") return "build";
  return phase;
}

/** How much of the workspace a stage may touch. */
export type BuildExecutionMode = "plan" | "build";

/**
 * The execution mode a session phase runs under on one harness.
 *
 * Validation in any phase may write compiler output, snapshots, coverage data,
 * generated artifacts, or tool caches. Every unattended pipeline session
 * therefore runs in build mode on every harness. Phase prompts remain
 * responsible for forbidding source edits and commits in review-only stages.
 */
export function executionModeForSessionPhase(
  _phase: PipelineSessionPhase,
  _agent: BuildPipelineAgent,
): BuildExecutionMode {
  return "build";
}

/**
 * The one declaration both the schema and the guard are built from.
 *
 * Sharing the *schema object* alone would not have prevented drift: a guard
 * that hardcoded its own field list would still fall silently out of step the
 * day a field is added here. Deriving both from this map is what makes the
 * contract single-sourced.
 */
const VERIFICATION_VERDICT_FIELDS = {
  complete: "boolean",
  rationale: "string",
} as const satisfies Record<string, "boolean" | "string">;

type VerificationVerdictField = keyof typeof VERIFICATION_VERDICT_FIELDS;
type VerificationVerdictFieldType<T extends "boolean" | "string"> = T extends "boolean"
  ? boolean
  : string;

/**
 * The verification turn's answer: did the committed branch meet the ticket?
 *
 * Shared rather than declared at the point of use so the supervisor that
 * enforces the schema and the transcript that renders the answer cannot drift
 * apart — a renderer guessing at the shape would silently fall back to raw JSON
 * the day a field is added.
 */
export type VerificationVerdict = {
  -readonly [Field in VerificationVerdictField]: VerificationVerdictFieldType<
    (typeof VERIFICATION_VERDICT_FIELDS)[Field]
  >;
};

const VERIFICATION_VERDICT_FIELD_ENTRIES = Object.entries(VERIFICATION_VERDICT_FIELDS) as [
  VerificationVerdictField,
  "boolean" | "string",
][];

/**
 * Frozen because the supervisor hands this exact object to the provider that
 * constrains the turn; a consumer mutating it would change what the model is
 * asked for everywhere at once.
 */
const VERIFICATION_VERDICT_REQUIRED = Object.freeze(
  VERIFICATION_VERDICT_FIELD_ENTRIES.map(([field]) => field),
);
const VERIFICATION_VERDICT_PROPERTIES = Object.freeze(
  Object.fromEntries(
    VERIFICATION_VERDICT_FIELD_ENTRIES.map(([field, type]) => [field, Object.freeze({ type })]),
  ),
);

export const VERIFICATION_VERDICT_SCHEMA: Record<string, unknown> = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: VERIFICATION_VERDICT_REQUIRED,
  properties: VERIFICATION_VERDICT_PROPERTIES,
});

/**
 * Exactly the contract fields and nothing else, so an unrelated payload that
 * happens to carry a `complete` flag is not mistaken for a verification
 * verdict. The key count mirrors the schema's `additionalProperties: false`.
 */
export function isVerificationVerdict(value: unknown): value is VerificationVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== VERIFICATION_VERDICT_FIELD_ENTRIES.length) {
    return false;
  }
  return VERIFICATION_VERDICT_FIELD_ENTRIES.every(([field, type]) => typeof record[field] === type);
}

/**
 * Display label the backend assigns to the dedicated review-package session.
 *
 * Fan-out and review-preparation pipelines create a session with this label.
 * Single-review pipelines reuse the build or fix session instead, so callers
 * that need to recognize every preparation turn should use
 * {@link isReviewPackagePreparationSession}.
 */
export const REVIEW_PACKAGE_SESSION_LABEL = "Package Preparation Session";

export const PIPELINE_TRANSCRIPT_REFERENCE_VERSION = 1;

/**
 * Control-record pointer to a session's separately stored display transcript.
 *
 * The transcript chunks and their manifest are committed before the workflow
 * record that references them, so a reference always names a manifest
 * revision that was durable when the reference was written. Everything here is
 * small and content-free; the body is read on demand.
 */
export interface PipelineTranscriptReference {
  version: typeof PIPELINE_TRANSCRIPT_REFERENCE_VERSION;
  /** Provider session whose display transcript the stored record holds. */
  sdkSessionId: string;
  /** Committed manifest revision this workflow record points at. */
  manifestRevision: number;
  /** Display revision of that manifest; equals the session's `messageRevision`. */
  revision: number;
  /** Messages retained in the stored transcript. */
  messageCount: number;
  /** Serialized bytes retained in the stored transcript. */
  bytes: number;
  /**
   * False when some messages could not be retained (one message beyond the
   * chunk bound, or history beyond the per-session bound). The workflow record
   * and its dispatch evidence are saved either way.
   */
  complete: boolean;
  /** Messages the stored transcript omits when {@link complete} is false. */
  omittedMessages?: number;
  committedAt: string;
}

export function isPipelineTranscriptReference(
  value: unknown,
): value is PipelineTranscriptReference {
  return (
    isRecord(value) &&
    value.version === PIPELINE_TRANSCRIPT_REFERENCE_VERSION &&
    typeof value.sdkSessionId === "string" &&
    value.sdkSessionId.length > 0 &&
    Number.isSafeInteger(value.manifestRevision) &&
    (value.manifestRevision as number) >= 1 &&
    isNonNegativeInteger(value.revision) &&
    isNonNegativeInteger(value.messageCount) &&
    isNonNegativeInteger(value.bytes) &&
    typeof value.complete === "boolean" &&
    (value.omittedMessages === undefined || isNonNegativeInteger(value.omittedMessages)) &&
    isIsoDate(value.committedAt)
  );
}

export interface PipelineSession {
  /** One durable continuation after a provider restart cut the turn short. */
  restartContinuationSent?: boolean;
  /**
   * The one automatic reminder to submit a missing tool-mode result was
   * already spent, so a stage that ignores it fails instead of looping.
   */
  resultReminderSent?: boolean;
  phase: PipelineSessionPhase;
  /**
   * The harness this session was created on.
   *
   * Recorded because steps may run different agents: status, transcript and
   * abort calls have to reach the provider that actually owns the session, and
   * `agentType` alone only describes the build step. Absent on snapshots written
   * before per-step harnesses existed, which fall back to `agentType`.
   */
  agent?: BuildPipelineAgent;
  /** True when an absent model is deliberately unpinned, rather than legacy metadata. */
  modelSelectionResolved?: boolean;
  /** Exact prompt-level selection, retained so ambiguous dispatch can retry faithfully. */
  model?: string;
  /**
   * Set when {@link model} replaced a configured default the runtime reported
   * it cannot serve, such as an OpenCode provider this login has not
   * connected. Shown on the stage so the substitution is never silent.
   */
  modelSubstitution?: import("./native-agent.js").NativeAgentModelSubstitution;
  reasoningEffort?: string;
  /** Fast/Normal choice retained for exact prompt recovery. */
  fastMode?: boolean;
  /** Persisted interaction authority for backend-owned workflow sessions. */
  origin?: import("./agent-interactions.js").AgentInteractionOrigin;
  interactionPolicy?: import("./agent-interactions.js").AgentInteractionPolicy;
  iteration: number;
  sessionKey: string;
  sdkSessionId: string;
  status: "running" | "idle" | "error";
  startedAt: string;
  /** End of this stage attempt, retained for settled runtime presentation. */
  completedAt?: string;
  /**
   * Cumulative provider-session token usage, the latest the provider reported.
   * Written while the turn runs, on the transcript persist cadence, and at turn
   * end, for every stage session: reviewers mirror their fan-out record, every
   * other stage is metered from the pipeline's own status observation.
   */
  tokenCount?: number;
  /** Bounded terminal observations waiting for delayed cumulative usage. */
  usageFinalizationPolls?: number;
  /** The reviewer's prompt-cache read count; see `ReviewerRecord.cacheReadTokens`. */
  cacheReadTokens?: number;
  label: string;
  /**
   * Display transcript body.
   *
   * The backend no longer keeps it in the workflow control record: bodies live
   * in separately stored chunks named by {@link transcript}. A record written
   * before that split still carries the array inline and is read through the
   * backend's legacy adapter until it is migrated. Clients attach the body they
   * fetched here for rendering only.
   */
  messages?: unknown[];
  /** Display revision of the committed transcript; bumps on every checkpoint. */
  messageRevision?: number;
  /**
   * Cheap change detector for the committed transcript: a fixed-size digest of
   * the length plus the tail entry, which is what an append-or-stream-the-last-
   * entry transcript actually varies. Records written before the digest form
   * carry the raw key, which the backend normalizes to the same digest.
   */
  messagesFingerprint?: string;
  /** Versioned reference to the separately stored display transcript. */
  transcript?: PipelineTranscriptReference;
  /**
   * Content-free reason (for example `quota`) the newest observed transcript
   * could not be stored, so {@link transcript} is older than the provider's.
   * The workflow still advanced; the next successful checkpoint clears it.
   */
  transcriptCheckpointError?: string;
  /**
   * Structured request identity recovered from a legacy inline transcript for
   * a session that predates {@link structuredRequestId}. Persisted when the
   * transcript moves out of the control record so recovery never needs to read
   * transcript bodies. Deliberately separate from `structuredRequestId`, whose
   * presence also classifies review-package preparation turns.
   */
  legacyStructuredRequestId?: string;
  /** Last time a transcript-only delta was persisted, used to throttle writes. */
  messagesPersistedAt?: string;
  /** Start of the current provider turn, used by liveness and stall timing. */
  turnStartedAt?: string;
  /** Stable structured-output key for review and verification turns. */
  structuredRequestId?: string;
  /** Result channel selected when this session's structured attempt was admitted. */
  resultTransport?: import("./workflow-results.js").WorkflowResultTransport;
  /** Bounded backend-projected delivery state for the tool-mode result slot. */
  resultSubmission?: import("./workflow-results.js").WorkflowResultSubmissionState;
  /**
   * Accepted report produced by this review session.
   *
   * Kept on the session so a multi-model build can render every independent
   * reviewer and its consolidation after the live fan-out record is retired.
   * The backend discards these copies when the next review attempt starts, so
   * report payloads do not accumulate across retries and fix-loop iterations.
   * Optional for snapshots written before per-session reports existed.
   */
  reviewReport?: StructuredReviewReport;
  /**
   * Reviewer overlap in a consolidation session's {@link reviewReport}. Kept
   * here because the fan-out record that computed it is dropped afterwards,
   * and, like {@link tokenCount}, kept when the report copy is discarded.
   */
  reviewOverlap?: ReviewPanelOverlapV1;
  /**
   * Issues by severity in the report this session filed. Unlike
   * {@link reviewReport}, it is kept when the report copy is discarded, so a
   * superseded review pass still says what it found. Optional: absent for a
   * session that filed no report and for snapshots written before it existed.
   */
  reviewIssueCounts?: PipelineReviewIssueCounts;
  /**
   * How a fan-out reviewer's attempt ended. The live fan-out record holds the
   * reviewer's status only while its pass runs; this keeps the outcome once
   * that record is retired. Absent while the reviewer runs, for non-reviewer
   * sessions, and for snapshots written before it existed.
   */
  reviewerOutcome?: PipelineReviewerOutcome;
  /** Identity of a full fan-out launch, shared by its reviewers and consolidation. */
  reviewPassId?: string;
  /** Failed reviewers that never acquired a provider session, retained on consolidation. */
  sessionlessReviewers?: PipelineSessionlessReviewer[];
  /** This consolidation was discarded by a reviewer retry; its result is no longer usable. */
  superseded?: boolean;
  /** The user skipped this stage; the pipeline moved on without its result. */
  skipped?: boolean;
  /**
   * The {@link PipelineRewind.id} of the restart that superseded this session.
   *
   * Set on the restarted step's old session and on every session after it
   * when a restart rewinds the pipeline. The session stays in the record so
   * its transcript is readable, but the live loop, results, verdicts and
   * late tool submissions ignore it. Absent on live sessions and on records
   * written before rewinds existed. Distinct from {@link superseded}, which
   * only marks a consolidation a reviewer retry replaced inside one pass.
   */
  supersededBy?: string;
  /** When {@link supersededBy} was set. */
  supersededAt?: string;
  /**
   * The verdict this verify session returned, kept so a rewind to the fix
   * that followed it can hand that fix its own round's feedback. The pipeline
   * fields hold only the newest verdict. Absent on other phases and on
   * records written before it existed.
   */
  verificationResult?: "pass" | "fail";
  /** At most {@link MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH} characters. */
  verificationFeedback?: string;
  /**
   * Why this session's attempt failed, at most
   * {@link MAX_PIPELINE_SESSION_ERROR_LENGTH} characters. Set for a fan-out
   * reviewer or stage that failed, retained when the pipeline moves on.
   */
  error?: string;
  /**
   * Whether the backend is still waiting for this request's schema result or
   * has validated and accepted it.
   *
   * Provider activity cannot answer this: pause and cancellation both leave a
   * session idle without making its last schema-shaped progress message
   * authoritative. Optional so snapshots written before this field still load.
   */
  structuredResultStatus?: "pending" | "accepted";
  /**
   * Immutable Git state captured before a writable verification turn starts.
   *
   * Verification may write ignored compiler output and caches, but its result
   * is certified only if HEAD and the set of Git-visible uncommitted paths stay
   * unchanged. Addressing can leave paths in this baseline; verification must
   * preserve them. Persisting it keeps the guard valid across backend restarts.
   * Packaged review reads an immutable package and has no live-worktree baseline.
   */
  validationHeadAtStart?: string;
  validationWorktreeStatusAtStart?: "clean" | "dirty" | "unknown";
  validationUncommittedPathsAtStart?: string[];
  /**
   * Content fingerprint of the worktree (HEAD, status, diff and untracked
   * files) taken when the first fix attempt in this iteration started and
   * carried across retries and restarts of that stage.
   *
   * A fix that leaves the worktree byte-identical would send the same code
   * back through review and verification, which repeats the same verdict until
   * the iteration cap. Comparing against this at the end of the turn lets the
   * supervisor pause instead. All attempts' copies are cleared once compared,
   * and absent when the initial probe could not establish a fingerprint, which
   * disables the check for that stage.
   */
  fixWorktreeFingerprintAtStart?: string;
  /**
   * First tick at which this session was idle with no structured result yet.
   * A turn that ends without ever producing one would otherwise poll forever.
   */
  structuredWaitStartedAt?: string;
  /**
   * How many times this session has been asked to re-emit a structured report
   * that failed contract validation.
   *
   * Counted on the session rather than the pipeline because a repair replaces
   * one session's report: a retried or later review stage opens a new session
   * and starts from zero, while a model that cannot satisfy the contract inside
   * this one is stopped after a bounded number of attempts.
   */
  structuredReportRepairAttempts?: number;
  /** Durable, content-free interaction totals for this stage attempt. */
  interactionSummary?: AgentInteractionWorkflowSummary;
  /** Convenience projection used by stage badges and completion summaries. */
  autoDeclineCount?: number;
  /** Reviewer-visible history owned by the workflow, not by provider cards. */
  interactionTranscript?: PipelineInteractionTranscriptEntry[];
  /**
   * Sticky record that this session produced, or is producing, the review-package
   * plan. Live `structuredRequestId` / `structuredResultStatus` are cleared when
   * a queued user message is dispatched and are also stamped on resume of an
   * ordinary build, so they cannot be the durable classification.
   */
  producedReviewPackagePlan?: boolean;
}

/** Issue counts by severity, as a review session's report filed them. */
export interface PipelineReviewIssueCounts {
  P0: number;
  P1: number;
  P2: number;
}

export type PipelineReviewerOutcome = "completed" | "failed" | "cancelled";

/** Bounded history for a reviewer whose provider session could not be created. */
export interface PipelineSessionlessReviewer {
  id: string;
  slot: number;
  agent: BuildPipelineAgent;
  model?: string;
  reasoningEffort?: string;
  error: string;
}

function isPipelineSessionlessReviewer(value: unknown): value is PipelineSessionlessReviewer {
  return (
    isRecord(value) &&
    isNonBlankString(value.id) &&
    value.id.length <= 128 &&
    isNonNegativeInteger(value.slot) &&
    value.slot < MAX_BUILD_PIPELINE_REVIEWERS &&
    BUILD_PIPELINE_AGENTS.includes(value.agent as BuildPipelineAgent) &&
    (value.model === undefined || (isNonBlankString(value.model) && value.model.length <= 256)) &&
    (value.reasoningEffort === undefined ||
      (isNonBlankString(value.reasoningEffort) && value.reasoningEffort.length <= 128)) &&
    isNonBlankString(value.error) &&
    value.error.length <= MAX_PIPELINE_SESSION_ERROR_LENGTH
  );
}

/** The longest per-session error kept on the record. */
export const MAX_PIPELINE_SESSION_ERROR_LENGTH = 2_000;

/** Counts a report's issues by severity. */
export function pipelineReviewIssueCounts(report: {
  issues: readonly { severity: "P0" | "P1" | "P2" }[];
}): PipelineReviewIssueCounts {
  const counts: PipelineReviewIssueCounts = { P0: 0, P1: 0, P2: 0 };
  for (const issue of report.issues) counts[issue.severity] += 1;
  return counts;
}

/** Normalizes an error to nonblank, bounded text for {@link PipelineSession.error}. */
export function boundedPipelineSessionError(error: string): string {
  const trimmed = error.trim() || "Provider failed without an error message";
  return trimmed.length <= MAX_PIPELINE_SESSION_ERROR_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_PIPELINE_SESSION_ERROR_LENGTH - 1)}…`;
}

function isPipelineReviewIssueCounts(value: unknown): value is PipelineReviewIssueCounts {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.P0) &&
    isNonNegativeInteger(value.P1) &&
    isNonNegativeInteger(value.P2)
  );
}

/**
 * Whether this session is the turn that produced the review-package plan.
 *
 * The dedicated session is labelled {@link REVIEW_PACKAGE_SESSION_LABEL}. The
 * default single-review path reuses a build or fix session and records that
 * with {@link PipelineSession.producedReviewPackagePlan}. Older snapshots
 * without that field still fall back to live structured-request bookkeeping,
 * but only on the single-review path: fan-out and explicit review-preparation
 * pipelines stamp those fields on resume of ordinary build turns.
 */
export function isReviewPackagePreparationSession(
  session:
    | Pick<
        PipelineSession,
        | "label"
        | "phase"
        | "producedReviewPackagePlan"
        | "structuredRequestId"
        | "structuredResultStatus"
      >
    | undefined,
  pipeline?: Pick<BuildPipeline, "reviewers" | "steps" | "agentType" | "reviewPreparation">,
): boolean {
  if (!session) return false;
  if (session.label === REVIEW_PACKAGE_SESSION_LABEL) return true;
  if (session.phase !== "build" && session.phase !== "fix") return false;
  if (session.producedReviewPackagePlan === true) return true;
  if (pipeline && (usesReviewFanout(pipeline) || pipeline.reviewPreparation)) {
    return false;
  }
  return session.structuredRequestId !== undefined || session.structuredResultStatus !== undefined;
}

/** The active work in a build/fix phase that still holds a validation run. */
export function reviewValidationStage(
  pipeline: Pick<
    BuildPipeline,
    "validationRun" | "reviewPackage" | "reviewRetryRequested" | "skippedValidationRunId"
  >,
  phase: ResumableBuildPhase | undefined,
): "validation" | "review-package" | null {
  if (
    !pipeline.validationRun ||
    pipeline.reviewPackage ||
    (phase !== "building" && phase !== "fixing")
  ) {
    return null;
  }
  if (pipeline.reviewRetryRequested) return "review-package";
  // A skipped run is sealed with the results it had, even once it is cancelled.
  if (pipeline.skippedValidationRunId === pipeline.validationRun.id) return "validation";
  return pipeline.validationRun.status === "cancelled" ? "review-package" : "validation";
}

export interface PipelineInteractionTranscriptQuestion {
  prompt: string;
  options: string[];
}

export interface PipelineInteractionTranscriptEntry {
  /** Stable provider interaction identity; also makes recording idempotent. */
  id: string;
  provider: AgentInteractionProvider;
  kind: AgentInteractionKind;
  phase: PipelineSessionPhase;
  requestedAt: number;
  resolvedAt: number;
  outcome: "auto-declined-headless";
  title: string;
  body?: string;
  questions: PipelineInteractionTranscriptQuestion[];
}

/**
 * Crash-recovery envelope written after the journal claim and before touching
 * the provider. It intentionally contains presentation labels only: exact
 * provider values, answers, commands, paths and form values never enter it.
 */
export interface PendingPipelineInteractionResolution {
  journalId: string;
  sessionKey: string;
  sessionId: string;
  interactionId: string;
  provider: AgentInteractionProvider;
  kind: AgentInteractionKind;
  phase: PipelineSessionPhase;
  requestedAt: number;
  claimedAt: number;
  action: "decline-and-continue" | "deny-and-fail";
  title: string;
  body?: string;
  questions: PipelineInteractionTranscriptQuestion[];
}

/** A message the user sent into a running pipeline, awaiting dispatch. */
export interface PipelineUserMessage {
  id: string;
  text: string;
  createdAt: string;
}

export const MAX_PIPELINE_USER_MESSAGES = 20;
export const MAX_PIPELINE_USER_MESSAGE_LENGTH = 16_000;
export const MAX_BUILD_PIPELINE_ITERATIONS = 10;

export type BuildPipelineSource =
  | { type: "kanban"; taskId: string }
  | {
      type: "linear";
      issueId: string;
      issueIdentifier: string;
      issueUrl?: string;
      status?: string;
      teamKey?: string;
      updatedAt?: string;
    }
  | {
      type: "github";
      repositoryOwner: string;
      repositoryName: string;
      issueNumber: number;
      issueUrl: string;
      status: string;
      updatedAt?: string;
    };

export type CompletionCommentStatus = "posting" | "posted" | "failed";
export type PipelineFailureKind = "prompt-dispatch" | "stage-transition" | "interactive-request";

export interface PipelineFailureContext {
  validationPlan?: boolean;
  phase: ResumableBuildPhase;
  kind: PipelineFailureKind;
  sessionId?: string;
  prompt?: string;
  useTaskImages?: boolean;
  requestId?: string;
  structuredReview?: boolean;
  resultTransport?: import("./workflow-results.js").WorkflowResultTransport;
}

export interface PipelineReconnectAttempt extends PipelineFailureContext {
  id: string;
  startedAt: string;
  /**
   * The harness that was unreachable.
   *
   * Recorded because steps may run different agents: a stage transition
   * resolves the *next* step's provider before it records that step's session,
   * so the failure belongs to a harness no session names yet. Without this the
   * supervisor clears the attempt as soon as the *previous* stage's still-healthy
   * harness answers, which restarts the reconnect deadline on every retry and
   * leaves the pipeline retrying an unreachable bridge forever. Absent on
   * attempts written before per-step harnesses existed.
   */
  agent?: BuildPipelineAgent;
}

export interface PipelinePromptAttempt {
  /** Version 1 distinguishes newly prepared attempts from legacy ambiguous sends. */
  dispatchVersion?: 1;
  /** Persist the preparation contract so a restart dispatches the same schema. */
  validationPlan?: boolean;
  id: string;
  sessionId: string;
  requestId: string;
  phase: ResumableBuildPhase;
  prompt: string;
  useTaskImages: boolean;
  structuredReview?: boolean;
  resultTransport?: import("./workflow-results.js").WorkflowResultTransport;
  startedAt: string;
  /**
   * Written durably just before the send, so a later pass knows the prompt may
   * have reached the provider and re-sends it under the same id only on the
   * provider's proof that it did not (`absent`). Only a versioned attempt
   * without this timestamp is known to be prepared and safe to send immediately.
   */
  dispatchingAt?: string;
}

export interface BuildPipeline {
  id: string;
  taskId: string;
  projectId: string;
  environmentId: string;
  environmentType: BuildPipelineEnvironmentType;
  /** Immutable source revision selected when a coordinator delegated the work. */
  delegationBaseBranch?: string;
  delegationBaseCommit?: string;
  agentType: BuildPipelineAgent;
  /**
   * Per-step launch configuration. A missing step, or a missing field within
   * one, falls back to the repository and global defaults.
   */
  steps?: BuildStepConfigs;
  /** Resolved at start. See {@link pipelineReviewerConfigs}. */
  reviewers?: BuildStepConfig[];
  /** One model used to prepare the immutable review package and consolidate fan-out reports. */
  reviewPreparation?: BuildStepConfig;
  /** Kept until the environment exists, then no longer consulted. */
  environmentOptions?: BuildPipelineEnvironmentOptions;
  /**
   * Live state of the reviewer fan-out, while the review stage is running it.
   *
   * Only present for a multi-reviewer pipeline. It is cleared when the stage
   * finishes, because everything downstream reads `structuredReview`.
   */
  reviewFanout?: ReviewFanoutState;
  phase: BuildPhase;
  sessions: PipelineSession[];
  currentSessionIndex: number;
  iteration: number;
  maxIterations: number;
  verificationResult?: "pass" | "fail";
  verificationFeedback?: string;
  structuredReview?: StructuredReviewReport;
  /** Backend projection of this iteration's environment-owned validation. */
  validationRun?: ReviewValidationRun;
  /** Immutable Git evidence shared by this iteration's reviewers. */
  reviewPackage?: PersistedReviewPackage;
  structuredReviewRequestId?: string;
  pausedFromPhase?: ResumableBuildPhase;
  pauseCause?: "requested" | "supervisor";
  error?: string;
  failureContext?: PipelineFailureContext;
  reconnectAttempt?: PipelineReconnectAttempt;
  pendingPromptAttempt?: PipelinePromptAttempt;
  activePromptContext?: PipelineFailureContext;
  /** Accepted result keys whose domain transition is durable but consumption is pending. */
  pendingResultConsumptions?: string[];
  /** One exact-once interaction currently crossing the provider boundary. */
  pendingInteractionResolution?: PendingPipelineInteractionResolution;
  /** Content-free totals across every stage attempt in this pipeline/ticket. */
  interactionSummary?: AgentInteractionWorkflowSummary;
  autoDeclineCount?: number;
  /** Warning only: the backend never aborts a long turn for transcript silence. */
  stallWarning?: { sessionId: string; detectedAt: string };
  /** Explicit safe retry for an interaction-triggered terminal failure. */
  interactionRetryRequested?: boolean;
  /** Starts a fresh session for the non-interactive stage that failed. */
  stageRetryRequested?: boolean;
  /**
   * User messages queued for the current session, dispatched one at a time by
   * the supervisor once the agent goes idle. Queued rather than sent directly
   * so a message survives an unmounted tab, a paused pipeline and a restart.
   */
  pendingUserMessages?: PipelineUserMessage[];
  /** Set by the retry-review control; consumed by the next supervisor pass. */
  reviewRetryRequested?: boolean;
  /** Selected historical stage to start again on the next supervisor pass. */
  restartRequest?: PipelineRestartRequest;
  /** Skipped stage whose successor opens on the next supervisor pass. */
  skipRequest?: PipelineSkipRequest;
  /**
   * The validation run the user skipped. The supervisor stops it and seals the
   * review package with the results it had, rather than preparing again.
   */
  skippedValidationRunId?: string;
  /** Retried independently of stage dispatch until the active ticket is reconciled. */
  pendingKanbanReactivation?: boolean;
  /** Earliest retry after a failed Kanban reactivation, persisted across reloads. */
  kanbanReactivationRetryAt?: string;
  /** Restarts that rewound the pipeline, oldest first, at most {@link MAX_PIPELINE_REWINDS}. */
  rewinds?: PipelineRewind[];
  createdAt: string;
  taskTitle: string;
  taskSnapshot: TaskSnapshot;
  source?: BuildPipelineSource;
  /** Optional feature-plan association maintained by the backend supervisor. */
  featurePlanId?: string;
  /** Stable backend admission identity for concurrent equivalent starts. */
  admissionKey?: string;
  /** Set after all source/task/feature associations have committed. */
  sourceLinkedAt?: string;
  completionCommentStatus?: CompletionCommentStatus;
  completionCommentError?: string;
  completionCommentId?: string;
  completionCommentPostedAt?: string;
  backendRevision: number;
  /** Identifies snapshots whose state machine is exclusively backend-owned. */
  controller: "backend";
}

export interface StartBuildPipelineInput {
  taskId: string;
  projectId: string;
  environmentType: BuildPipelineEnvironmentType;
  /** Coordinator-only delegation context, resolved before the workflow starts. */
  delegationBaseBranch?: string;
  delegationBaseCommit?: string;
  agentType: BuildPipelineAgent;
  /** Per-step harness, model and reasoning chosen in the build launcher. */
  steps?: BuildStepConfigs;
  /**
   * Reviewers for the review step. Absent or single-entry keeps the classic
   * one-reviewer stage; more than one runs the shared reviewer fan-out.
   */
  reviewers?: BuildStepConfig[];
  /** Preparation/consolidation model for a multi-reviewer stage. */
  reviewPreparation?: BuildStepConfig;
  taskTitle: string;
  taskSnapshot: TaskSnapshot;
  source?: BuildPipelineSource;
  /** Applied when the pipeline creates its own environment. */
  environmentOptions?: BuildPipelineEnvironmentOptions;
  namingPrompt?: string;
  existingEnvironmentId?: string;
  maxIterations?: number;
  featurePlanId?: string;
}

export function isActiveBuildPhase(phase: BuildPhase): boolean {
  return phase !== "paused" && phase !== "complete" && phase !== "failed";
}

const BUILD_PHASES = new Set<BuildPhase>([
  "creating-environment",
  "starting-environment",
  "waiting-for-setup",
  "building",
  "reviewing",
  "addressing",
  "verifying",
  "fixing",
  "creating-pr",
  "resolving-conflicts",
  "paused",
  "complete",
  "failed",
]);
const AGENTS = new Set<BuildPipelineAgent>(BUILD_PIPELINE_AGENTS);
const ENVIRONMENT_TYPES = new Set<BuildPipelineEnvironmentType>(["containerized", "local"]);
const SESSION_PHASES = new Set<PipelineSessionPhase>([
  "build",
  "review",
  "address",
  "verify",
  "fix",
  "pr",
  "resolve-conflicts",
]);
const RESUMABLE_PHASES = new Set<ResumableBuildPhase>(
  Array.from(BUILD_PHASES).filter(
    (phase): phase is ResumableBuildPhase =>
      phase !== "paused" && phase !== "complete" && phase !== "failed",
  ),
);
const FAILURE_KINDS = new Set<PipelineFailureKind>([
  "prompt-dispatch",
  "stage-transition",
  "interactive-request",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Largest epoch millisecond value accepted by `Date` and `toISOString`. */
const MAX_RENDERABLE_EPOCH_MS = 8.64e15;

function isRenderableEpoch(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_RENDERABLE_EPOCH_MS;
}

/** Reused rather than reallocated: this runs on every snapshot validation. */
const INTERACTION_PAYLOAD_ENCODER = new TextEncoder();

/**
 * Derived from the protocol vocabularies rather than restated.
 *
 * A literal copy silently rejects any provider or kind added upstream, and a
 * rejected entry fails the whole pipeline snapshot — which the supervisor then
 * skips and the renderer treats as a deletion.
 */
const INTERACTION_PROVIDERS: ReadonlySet<AgentInteractionProvider> = new Set(
  AGENT_INTERACTION_PROVIDERS,
);
const INTERACTION_KINDS: ReadonlySet<AgentInteractionKind> = new Set(AGENT_INTERACTION_KINDS);

/**
 * UTF-16 code units are never more numerous than UTF-8 bytes, so summing the
 * bounded text fields gives a lower bound on the serialized size.
 *
 * The per-field maximums alone permit a structurally valid transcript of
 * roughly 530 MB (64 entries x 16 questions x 32 options x 16 KB of text).
 * Serializing that just to discover it overflows a 256 KB budget allocates
 * ~1.6 GB, and the text arrives from a provider. This can never reject a value
 * that would have passed: anything within the byte limit is within the lower
 * bound too.
 */
function interactionPresentationTextLength(value: Record<string, unknown>): number {
  let total = (value.title as string | undefined)?.length ?? 0;
  total += (value.body as string | undefined)?.length ?? 0;
  const questions = value.questions;
  if (!Array.isArray(questions)) return total;
  for (const question of questions) {
    if (!isRecord(question)) continue;
    total += (question.prompt as string | undefined)?.length ?? 0;
    const options = question.options;
    if (!Array.isArray(options)) continue;
    for (const option of options) {
      if (typeof option === "string") total += option.length;
    }
  }
  return total;
}

function isWithinInteractionPayloadLimit(value: unknown): boolean {
  try {
    return (
      INTERACTION_PAYLOAD_ENCODER.encode(JSON.stringify(value)).byteLength <=
      AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
    );
  } catch {
    return false;
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNonBlankString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

/**
 * Every timestamp in a snapshot is produced by {@link Date.toISOString}, so the
 * guard requires that shape rather than whatever `Date.parse` happens to accept.
 * A bare `Date.parse` check passes strings like "March 5 2020", which would let
 * a hand-edited or legacy record through and then compare wrongly against the
 * deadlines the supervisor derives from these fields.
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" && ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))
  );
}

function isBuildStepConfig(value: unknown): value is BuildStepConfig {
  if (!isRecord(value)) return false;
  return (
    AGENTS.has(value.agent as BuildPipelineAgent) &&
    isOptionalNonBlankString(value.model) &&
    isOptionalNonBlankString(value.reasoningEffort) &&
    (value.fastMode === undefined || typeof value.fastMode === "boolean")
  );
}

/**
 * A baseline is either absent, unestablished, or complete — never half-written.
 *
 * The path list is optional even alongside a head so that a snapshot persisted
 * before the list existed still loads: `save` refuses to persist a pipeline
 * that fails validation, so tightening this further would strand a live
 * pipeline mid-upgrade rather than protect it.
 */
function hasValidValidationWorktreeBaseline(value: Record<string, unknown>): boolean {
  const head = value.validationHeadAtStart;
  const status = value.validationWorktreeStatusAtStart;
  const paths = value.validationUncommittedPathsAtStart;
  if (
    paths !== undefined &&
    (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }
  if (head === undefined) {
    return (status === undefined || status === "unknown") && paths === undefined;
  }
  return (
    typeof head === "string" &&
    /^[0-9a-f]{40,64}$/i.test(head) &&
    (status === "clean" || status === "dirty")
  );
}

/**
 * Only the keys in {@link BUILD_STEP_KEYS} are accepted. An unknown key would be
 * carried through the snapshot and silently never consulted, which reads as a
 * setting that was applied when it was not.
 */
function isPortNumber(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

export function isBuildPipelineEnvironmentOptions(
  value: unknown,
): value is BuildPipelineEnvironmentOptions {
  if (!isRecord(value)) return false;
  if (
    Object.keys(value).some((key) => !["name", "networkAccessMode", "portMappings"].includes(key))
  )
    return false;
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 256)) {
    return false;
  }
  if (
    value.networkAccessMode !== undefined &&
    value.networkAccessMode !== "restricted" &&
    value.networkAccessMode !== "full"
  ) {
    return false;
  }
  if (value.portMappings === undefined) return true;
  return (
    Array.isArray(value.portMappings) &&
    value.portMappings.length <= MAX_BUILD_PIPELINE_PORT_MAPPINGS &&
    value.portMappings.every(
      (entry) =>
        isRecord(entry) &&
        isPortNumber(entry.containerPort) &&
        isPortNumber(entry.hostPort) &&
        (entry.protocol === "tcp" || entry.protocol === "udp"),
    )
  );
}

export function isBuildStepConfigList(value: unknown): value is BuildStepConfig[] {
  return (
    Array.isArray(value) &&
    value.length >= REVIEW_FANOUT_MIN_REVIEWERS &&
    value.length <= REVIEW_FANOUT_MAX_REVIEWERS &&
    value.every(isBuildStepConfig)
  );
}

export function isBuildStepConfigs(value: unknown): value is BuildStepConfigs {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, config]) =>
      BUILD_STEP_KEYS.includes(key as BuildStepKey) &&
      (config === undefined || isBuildStepConfig(config)),
  );
}

function isPipelineSession(value: unknown): value is PipelineSession {
  if (!isRecord(value)) return false;
  return (
    SESSION_PHASES.has(value.phase as PipelineSessionPhase) &&
    (value.agent === undefined || AGENTS.has(value.agent as BuildPipelineAgent)) &&
    (value.model === undefined || isNonBlankString(value.model)) &&
    (value.modelSelectionResolved === undefined ||
      typeof value.modelSelectionResolved === "boolean") &&
    (value.modelSubstitution === undefined ||
      isNativeAgentModelSubstitution(value.modelSubstitution)) &&
    (value.reasoningEffort === undefined || isNonBlankString(value.reasoningEffort)) &&
    (value.fastMode === undefined || typeof value.fastMode === "boolean") &&
    ((value.origin === undefined && value.interactionPolicy === undefined) ||
      (value.origin === "build-pipeline" &&
        isAgentInteractionPolicy(value.interactionPolicy) &&
        value.interactionPolicy.mode === "unattended")) &&
    isNonNegativeInteger(value.iteration) &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    typeof value.sdkSessionId === "string" &&
    value.sdkSessionId.length > 0 &&
    (value.status === "running" || value.status === "idle" || value.status === "error") &&
    isIsoDate(value.startedAt) &&
    (value.completedAt === undefined || isIsoDate(value.completedAt)) &&
    (value.tokenCount === undefined || isNonNegativeInteger(value.tokenCount)) &&
    (value.usageFinalizationPolls === undefined ||
      (isNonNegativeInteger(value.usageFinalizationPolls) &&
        value.usageFinalizationPolls <= REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS)) &&
    (value.cacheReadTokens === undefined || isNonNegativeInteger(value.cacheReadTokens)) &&
    typeof value.label === "string" &&
    (value.messages === undefined || Array.isArray(value.messages)) &&
    (value.messageRevision === undefined || isNonNegativeInteger(value.messageRevision)) &&
    isOptionalNonBlankString(value.messagesFingerprint) &&
    (value.messagesPersistedAt === undefined || isIsoDate(value.messagesPersistedAt)) &&
    (value.transcript === undefined || isPipelineTranscriptReference(value.transcript)) &&
    (value.transcriptCheckpointError === undefined ||
      (isNonBlankString(value.transcriptCheckpointError) &&
        value.transcriptCheckpointError.length <= 128)) &&
    isOptionalNonBlankString(value.legacyStructuredRequestId) &&
    (value.turnStartedAt === undefined || isIsoDate(value.turnStartedAt)) &&
    isOptionalNonBlankString(value.structuredRequestId) &&
    (value.resultTransport === undefined ||
      value.resultTransport === "tool-v1" ||
      value.resultTransport === "structured-output-v1") &&
    (value.resultSubmission === undefined ||
      isWorkflowResultSubmissionState(value.resultSubmission)) &&
    (value.reviewReport === undefined ||
      (value.phase === "review" && isStructuredReviewReport(value.reviewReport))) &&
    (value.reviewOverlap === undefined || isReviewPanelOverlap(value.reviewOverlap)) &&
    (value.reviewIssueCounts === undefined ||
      isPipelineReviewIssueCounts(value.reviewIssueCounts)) &&
    (value.reviewerOutcome === undefined ||
      value.reviewerOutcome === "completed" ||
      value.reviewerOutcome === "failed" ||
      value.reviewerOutcome === "cancelled") &&
    isOptionalNonBlankString(value.reviewPassId) &&
    (value.sessionlessReviewers === undefined ||
      (value.phase === "review" &&
        Array.isArray(value.sessionlessReviewers) &&
        value.sessionlessReviewers.length <= MAX_BUILD_PIPELINE_REVIEWERS &&
        value.sessionlessReviewers.every(isPipelineSessionlessReviewer))) &&
    (value.superseded === undefined || typeof value.superseded === "boolean") &&
    (value.skipped === undefined || typeof value.skipped === "boolean") &&
    (value.supersededBy === undefined ||
      (isNonBlankString(value.supersededBy) && value.supersededBy.length <= 128)) &&
    (value.supersededAt === undefined || isIsoDate(value.supersededAt)) &&
    (value.verificationResult === undefined ||
      (value.phase === "verify" &&
        (value.verificationResult === "pass" || value.verificationResult === "fail"))) &&
    (value.verificationFeedback === undefined ||
      (value.phase === "verify" &&
        typeof value.verificationFeedback === "string" &&
        value.verificationFeedback.length <= MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH)) &&
    (value.error === undefined ||
      (isNonBlankString(value.error) && value.error.length <= MAX_PIPELINE_SESSION_ERROR_LENGTH)) &&
    (value.structuredResultStatus === undefined ||
      value.structuredResultStatus === "pending" ||
      value.structuredResultStatus === "accepted") &&
    (value.producedReviewPackagePlan === undefined ||
      typeof value.producedReviewPackagePlan === "boolean") &&
    hasValidValidationWorktreeBaseline(value) &&
    (value.fixWorktreeFingerprintAtStart === undefined ||
      (typeof value.fixWorktreeFingerprintAtStart === "string" &&
        /^[0-9a-f]{64}$/i.test(value.fixWorktreeFingerprintAtStart))) &&
    (value.structuredWaitStartedAt === undefined || isIsoDate(value.structuredWaitStartedAt)) &&
    (value.restartContinuationSent === undefined ||
      typeof value.restartContinuationSent === "boolean") &&
    (value.resultReminderSent === undefined || typeof value.resultReminderSent === "boolean") &&
    (value.structuredReportRepairAttempts === undefined ||
      isNonNegativeInteger(value.structuredReportRepairAttempts)) &&
    (value.interactionSummary === undefined ||
      isAgentInteractionWorkflowSummary(value.interactionSummary)) &&
    (value.autoDeclineCount === undefined || isNonNegativeInteger(value.autoDeclineCount)) &&
    (value.interactionTranscript === undefined ||
      (Array.isArray(value.interactionTranscript) &&
        value.interactionTranscript.length <= AGENT_INTERACTION_LIMITS.maxWorkflowSummaries &&
        value.interactionTranscript.every(isPipelineInteractionTranscriptEntry) &&
        // Cheap lower bound first: the per-field maximums permit a structurally
        // valid transcript far larger than the byte budget, and serializing one
        // to find that out is the amplification this guard exists to prevent.
        isWithinTextLowerBound(
          value.interactionTranscript.reduce(
            (total: number, entry: unknown) =>
              total + (isRecord(entry) ? interactionPresentationTextLength(entry) : 0),
            0,
          ),
        ) &&
        isWithinInteractionPayloadLimit(value.interactionTranscript)))
  );
}

function isPipelineInteractionQuestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "prompt" || key === "options") &&
    typeof value.prompt === "string" &&
    value.prompt.length > 0 &&
    value.prompt.length <= AGENT_INTERACTION_LIMITS.maxTextLength &&
    Array.isArray(value.options) &&
    value.options.length <= AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion &&
    value.options.every(
      (option) =>
        typeof option === "string" &&
        option.length > 0 &&
        option.length <= AGENT_INTERACTION_LIMITS.maxTextLength,
    )
  );
}

function isPipelineInteractionPresentation(value: Record<string, unknown>): boolean {
  return (
    typeof value.interactionId === "string" &&
    value.interactionId.length > 0 &&
    value.interactionId.length <= AGENT_INTERACTION_LIMITS.maxIdLength &&
    INTERACTION_PROVIDERS.has(value.provider as AgentInteractionProvider) &&
    INTERACTION_KINDS.has(value.kind as AgentInteractionKind) &&
    SESSION_PHASES.has(value.phase as PipelineSessionPhase) &&
    isRenderableEpoch(value.requestedAt) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= AGENT_INTERACTION_LIMITS.maxTextLength &&
    (value.body === undefined ||
      (typeof value.body === "string" &&
        value.body.length > 0 &&
        value.body.length <= AGENT_INTERACTION_LIMITS.maxTextLength)) &&
    Array.isArray(value.questions) &&
    value.questions.length <= AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest &&
    value.questions.every(isPipelineInteractionQuestion)
  );
}

function isPipelineInteractionTranscriptEntry(
  value: unknown,
): value is PipelineInteractionTranscriptEntry {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      [
        "id",
        "provider",
        "kind",
        "phase",
        "requestedAt",
        "resolvedAt",
        "outcome",
        "title",
        "body",
        "questions",
      ].includes(key),
    ) &&
    isNonBlankString(value.id) &&
    value.id.length <= AGENT_INTERACTION_LIMITS.maxIdLength &&
    isPipelineInteractionPresentation({ ...value, interactionId: value.id }) &&
    // Deliberately *not* cross-checked against the live unattended policy. This
    // is an immutable record of something that already happened; reclassifying
    // a kind (say, making `mcp-url` an authorization) would otherwise make every
    // snapshot that recorded it unparseable, which the supervisor reads as a
    // pipeline to skip and the renderer as a pipeline to delete. The recorded
    // `outcome` below is what pins the entry's meaning.
    isRenderableEpoch(value.resolvedAt) &&
    (value.resolvedAt as number) >= (value.requestedAt as number) &&
    value.outcome === "auto-declined-headless"
  );
}

function isPendingPipelineInteractionResolution(
  value: unknown,
): value is PendingPipelineInteractionResolution {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      [
        "journalId",
        "sessionKey",
        "interactionId",
        "provider",
        "kind",
        "phase",
        "sessionId",
        "requestedAt",
        "claimedAt",
        "action",
        "title",
        "body",
        "questions",
      ].includes(key),
    ) &&
    isPipelineInteractionPresentation(value) &&
    isNonBlankString(value.journalId) &&
    value.journalId.length <= AGENT_INTERACTION_LIMITS.maxIdLength &&
    isNonBlankString(value.sessionKey) &&
    value.sessionKey.length <= AGENT_INTERACTION_LIMITS.maxIdLength &&
    isNonBlankString(value.sessionId) &&
    value.sessionId.length <= AGENT_INTERACTION_LIMITS.maxIdLength &&
    isRenderableEpoch(value.claimedAt) &&
    (value.claimedAt as number) >= (value.requestedAt as number) &&
    // Same reasoning as the transcript entry: an in-flight envelope written
    // before a policy change must still parse after the upgrade, or the
    // pipeline it belongs to disappears instead of finishing its interaction.
    (value.action === "decline-and-continue" || value.action === "deny-and-fail") &&
    isWithinTextLowerBound(interactionPresentationTextLength(value)) &&
    isWithinInteractionPayloadLimit(value)
  );
}

function isUserMessage(value: unknown): value is PipelineUserMessage {
  if (!isRecord(value)) return false;
  return (
    isNonBlankString(value.id) &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= MAX_PIPELINE_USER_MESSAGE_LENGTH &&
    isIsoDate(value.createdAt)
  );
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.acceptanceCriteria === "string" &&
    Array.isArray(value.comments) &&
    value.comments.every((comment) => isRecord(comment) && typeof comment.text === "string") &&
    Array.isArray(value.images) &&
    value.images.every(
      (image) =>
        isRecord(image) && typeof image.filename === "string" && typeof image.data === "string",
    )
  );
}

function isFailureContext(value: unknown): value is PipelineFailureContext {
  if (!isRecord(value)) return false;
  return (
    RESUMABLE_PHASES.has(value.phase as ResumableBuildPhase) &&
    FAILURE_KINDS.has(value.kind as PipelineFailureKind) &&
    isOptionalNonBlankString(value.sessionId) &&
    isOptionalString(value.prompt) &&
    (value.useTaskImages === undefined || typeof value.useTaskImages === "boolean") &&
    isOptionalNonBlankString(value.requestId) &&
    (value.structuredReview === undefined || typeof value.structuredReview === "boolean") &&
    (value.resultTransport === undefined ||
      value.resultTransport === "tool-v1" ||
      value.resultTransport === "structured-output-v1") &&
    (value.validationPlan === undefined || typeof value.validationPlan === "boolean")
  );
}

function isReconnectAttempt(value: unknown): value is PipelineReconnectAttempt {
  if (!isRecord(value) || !isFailureContext(value)) return false;
  return (
    isNonBlankString(value.id) &&
    isIsoDate(value.startedAt) &&
    (value.agent === undefined || AGENTS.has(value.agent as BuildPipelineAgent))
  );
}

function isPromptAttempt(value: unknown): value is PipelinePromptAttempt {
  if (!isRecord(value)) return false;
  return (
    isNonBlankString(value.id) &&
    isNonBlankString(value.sessionId) &&
    isNonBlankString(value.requestId) &&
    RESUMABLE_PHASES.has(value.phase as ResumableBuildPhase) &&
    typeof value.prompt === "string" &&
    typeof value.useTaskImages === "boolean" &&
    (value.structuredReview === undefined || typeof value.structuredReview === "boolean") &&
    (value.resultTransport === undefined ||
      value.resultTransport === "tool-v1" ||
      value.resultTransport === "structured-output-v1") &&
    (value.validationPlan === undefined || typeof value.validationPlan === "boolean") &&
    isIsoDate(value.startedAt) &&
    (value.dispatchVersion === undefined || value.dispatchVersion === 1) &&
    (value.dispatchingAt === undefined || isIsoDate(value.dispatchingAt))
  );
}

function isPipelineRestartRequest(value: unknown): value is PipelineRestartRequest {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "session") {
    return (
      Object.keys(value).every((key) => key === "kind" || key === "phase") &&
      SESSION_PHASES.has(value.phase as PipelineSessionPhase)
    );
  }
  return (
    (value.kind === "review-package" || value.kind === "validation") &&
    Object.keys(value).every((key) => key === "kind" || key === "implementationPhase") &&
    (value.implementationPhase === "build" || value.implementationPhase === "fix")
  );
}

function isPipelineSkipRequest(value: unknown): value is PipelineSkipRequest {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "phase") &&
    SESSION_PHASES.has(value.phase as PipelineSessionPhase) &&
    value.phase !== "pr" &&
    value.phase !== "resolve-conflicts"
  );
}

function isPipelineRewind(value: unknown): value is PipelineRewind {
  return (
    isRecord(value) &&
    isNonBlankString(value.id) &&
    value.id.length <= 128 &&
    isIsoDate(value.at) &&
    BUILD_PHASES.has(value.fromPhase as BuildPhase) &&
    isNonNegativeInteger(value.fromIteration) &&
    isNonNegativeInteger(value.iteration) &&
    isPipelineRestartRequest(value.step) &&
    (value.sessionKey === undefined ||
      (isNonBlankString(value.sessionKey) && value.sessionKey.length <= 512)) &&
    isNonNegativeInteger(value.supersededSessions) &&
    (value.replacementValidationRunId === undefined ||
      (isNonBlankString(value.replacementValidationRunId) &&
        value.replacementValidationRunId.length <= 512)) &&
    (value.validationRun === undefined || isReviewValidationRun(value.validationRun))
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Runtime guard for snapshots crossing the backend/client boundary.
 *
 * It intentionally requires the backend controller marker. A client-authored
 * legacy snapshot cannot enter the current read model.
 */
export function isBuildPipeline(value: unknown): value is BuildPipeline {
  if (!isRecord(value)) return false;
  if (
    value.controller !== "backend" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0 ||
    typeof value.projectId !== "string" ||
    value.projectId.length === 0 ||
    typeof value.environmentId !== "string" ||
    !ENVIRONMENT_TYPES.has(value.environmentType as BuildPipelineEnvironmentType) ||
    !isOptionalNonBlankString(value.delegationBaseBranch) ||
    (value.delegationBaseCommit !== undefined &&
      (typeof value.delegationBaseCommit !== "string" ||
        !/^[0-9a-f]{40}$/i.test(value.delegationBaseCommit))) ||
    !AGENTS.has(value.agentType as BuildPipelineAgent) ||
    (value.steps !== undefined && !isBuildStepConfigs(value.steps)) ||
    !BUILD_PHASES.has(value.phase as BuildPhase) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(isPipelineSession) ||
    !isNonNegativeInteger(value.iteration) ||
    !Number.isSafeInteger(value.maxIterations) ||
    (value.maxIterations as number) < 1 ||
    // Kept in step with isStartBuildPipelineInput: no legitimate record can
    // exceed the bound the gateway enforces on the way in.
    (value.maxIterations as number) > MAX_BUILD_PIPELINE_ITERATIONS ||
    !isNonNegativeInteger(value.backendRevision) ||
    !isIsoDate(value.createdAt) ||
    typeof value.taskTitle !== "string" ||
    !isTaskSnapshot(value.taskSnapshot) ||
    (value.verificationResult !== undefined &&
      value.verificationResult !== "pass" &&
      value.verificationResult !== "fail") ||
    !isOptionalString(value.verificationFeedback) ||
    (value.structuredReview !== undefined && !isStructuredReviewReport(value.structuredReview)) ||
    (value.validationRun !== undefined && !isReviewValidationRun(value.validationRun)) ||
    (value.reviewPackage !== undefined && !isPersistedReviewPackage(value.reviewPackage)) ||
    !isOptionalNonBlankString(value.structuredReviewRequestId) ||
    (value.pausedFromPhase !== undefined &&
      !RESUMABLE_PHASES.has(value.pausedFromPhase as ResumableBuildPhase)) ||
    (value.pauseCause !== undefined &&
      value.pauseCause !== "requested" &&
      value.pauseCause !== "supervisor") ||
    !isOptionalString(value.error) ||
    (value.failureContext !== undefined && !isFailureContext(value.failureContext)) ||
    (value.reconnectAttempt !== undefined && !isReconnectAttempt(value.reconnectAttempt)) ||
    (value.pendingPromptAttempt !== undefined && !isPromptAttempt(value.pendingPromptAttempt)) ||
    (value.activePromptContext !== undefined && !isFailureContext(value.activePromptContext)) ||
    (value.pendingResultConsumptions !== undefined &&
      (!Array.isArray(value.pendingResultConsumptions) ||
        value.pendingResultConsumptions.length > 64 ||
        !value.pendingResultConsumptions.every(
          (key) => isNonBlankString(key) && key.length <= 512,
        ))) ||
    (value.pendingInteractionResolution !== undefined &&
      !isPendingPipelineInteractionResolution(value.pendingInteractionResolution)) ||
    (value.interactionSummary !== undefined &&
      !isAgentInteractionWorkflowSummary(value.interactionSummary)) ||
    (value.autoDeclineCount !== undefined && !isNonNegativeInteger(value.autoDeclineCount)) ||
    (value.stallWarning !== undefined &&
      (!isRecord(value.stallWarning) ||
        !isNonBlankString(value.stallWarning.sessionId) ||
        !isIsoDate(value.stallWarning.detectedAt))) ||
    (value.interactionRetryRequested !== undefined &&
      typeof value.interactionRetryRequested !== "boolean") ||
    (value.stageRetryRequested !== undefined && typeof value.stageRetryRequested !== "boolean") ||
    (value.pendingUserMessages !== undefined &&
      (!Array.isArray(value.pendingUserMessages) ||
        value.pendingUserMessages.length > MAX_PIPELINE_USER_MESSAGES ||
        !value.pendingUserMessages.every(isUserMessage))) ||
    (value.reviewRetryRequested !== undefined && typeof value.reviewRetryRequested !== "boolean") ||
    (value.restartRequest !== undefined && !isPipelineRestartRequest(value.restartRequest)) ||
    (value.skipRequest !== undefined && !isPipelineSkipRequest(value.skipRequest)) ||
    !isOptionalNonBlankString(value.skippedValidationRunId) ||
    (value.kanbanReactivationRetryAt !== undefined &&
      !isIsoDate(value.kanbanReactivationRetryAt)) ||
    (value.pendingKanbanReactivation !== undefined &&
      typeof value.pendingKanbanReactivation !== "boolean") ||
    (value.rewinds !== undefined &&
      (!Array.isArray(value.rewinds) ||
        value.rewinds.length > MAX_PIPELINE_REWINDS ||
        !value.rewinds.every(isPipelineRewind))) ||
    (value.reviewers !== undefined && !isBuildStepConfigList(value.reviewers)) ||
    (value.reviewPreparation !== undefined && !isBuildStepConfig(value.reviewPreparation)) ||
    (value.environmentOptions !== undefined &&
      !isBuildPipelineEnvironmentOptions(value.environmentOptions)) ||
    (value.reviewFanout !== undefined && !isReviewFanoutState(value.reviewFanout)) ||
    (value.source !== undefined && !isPipelineSource(value.source)) ||
    !isOptionalNonBlankString(value.featurePlanId) ||
    !isOptionalNonBlankString(value.admissionKey) ||
    (value.sourceLinkedAt !== undefined && !isIsoDate(value.sourceLinkedAt)) ||
    (value.completionCommentStatus !== undefined &&
      value.completionCommentStatus !== "posting" &&
      value.completionCommentStatus !== "posted" &&
      value.completionCommentStatus !== "failed") ||
    !isOptionalString(value.completionCommentError) ||
    !isOptionalNonBlankString(value.completionCommentId) ||
    (value.completionCommentPostedAt !== undefined && !isIsoDate(value.completionCommentPostedAt))
  ) {
    return false;
  }
  const index = value.currentSessionIndex;
  return (
    Number.isSafeInteger(index) &&
    (value.sessions.length === 0
      ? index === -1
      : (index as number) >= 0 && (index as number) < value.sessions.length)
  );
}

function isPipelineSource(value: unknown): value is BuildPipelineSource {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "kanban") {
    return typeof value.taskId === "string" && value.taskId.length > 0;
  }
  if (value.type === "linear") {
    return (
      typeof value.issueId === "string" &&
      value.issueId.length > 0 &&
      typeof value.issueIdentifier === "string" &&
      value.issueIdentifier.length > 0 &&
      isOptionalString(value.issueUrl) &&
      isOptionalString(value.status) &&
      isOptionalString(value.teamKey) &&
      (value.updatedAt === undefined || isIsoDate(value.updatedAt))
    );
  }
  return (
    value.type === "github" &&
    typeof value.repositoryOwner === "string" &&
    value.repositoryOwner.length > 0 &&
    typeof value.repositoryName === "string" &&
    value.repositoryName.length > 0 &&
    Number.isSafeInteger(value.issueNumber) &&
    (value.issueNumber as number) > 0 &&
    typeof value.issueUrl === "string" &&
    typeof value.status === "string" &&
    (value.updatedAt === undefined || isIsoDate(value.updatedAt))
  );
}

/** Strict gateway guard for starting backend-owned work. */
export function isStartBuildPipelineInput(value: unknown): value is StartBuildPipelineInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.taskId === "string" &&
    value.taskId.length > 0 &&
    typeof value.projectId === "string" &&
    value.projectId.length > 0 &&
    typeof value.taskTitle === "string" &&
    value.taskTitle.length > 0 &&
    ENVIRONMENT_TYPES.has(value.environmentType as BuildPipelineEnvironmentType) &&
    (value.delegationBaseBranch === undefined ||
      (typeof value.delegationBaseBranch === "string" && value.delegationBaseBranch.length > 0)) &&
    (value.delegationBaseCommit === undefined ||
      (typeof value.delegationBaseCommit === "string" &&
        /^[0-9a-f]{40}$/i.test(value.delegationBaseCommit))) &&
    AGENTS.has(value.agentType as BuildPipelineAgent) &&
    (value.steps === undefined || isBuildStepConfigs(value.steps)) &&
    (value.reviewers === undefined || isBuildStepConfigList(value.reviewers)) &&
    (value.reviewPreparation === undefined || isBuildStepConfig(value.reviewPreparation)) &&
    (value.environmentOptions === undefined ||
      isBuildPipelineEnvironmentOptions(value.environmentOptions)) &&
    isTaskSnapshot(value.taskSnapshot) &&
    (value.source === undefined || isPipelineSource(value.source)) &&
    (value.namingPrompt === undefined || typeof value.namingPrompt === "string") &&
    (value.existingEnvironmentId === undefined ||
      (typeof value.existingEnvironmentId === "string" &&
        value.existingEnvironmentId.length > 0)) &&
    (value.featurePlanId === undefined ||
      (typeof value.featurePlanId === "string" && value.featurePlanId.length > 0)) &&
    (value.maxIterations === undefined ||
      (Number.isSafeInteger(value.maxIterations) &&
        (value.maxIterations as number) >= 1 &&
        (value.maxIterations as number) <= MAX_BUILD_PIPELINE_ITERATIONS))
  );
}
