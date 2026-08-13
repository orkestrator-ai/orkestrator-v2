import {
  isStructuredReviewReport,
  type StructuredReviewReport,
} from "./structured-review.js";
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

export const BUILD_PIPELINE_VERSION = 2;

export type BuildPipelineAgent = "claude" | "opencode" | "codex" | "cursor" | "grok";

/** The one list every agent check is built from. */
export const BUILD_PIPELINE_AGENTS: readonly BuildPipelineAgent[] =
  Object.freeze(["claude", "opencode", "codex", "cursor", "grok"]);

export type BuildPipelineEnvironmentType = "containerized" | "local";

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

export type ResumableBuildPhase = Exclude<
  BuildPhase,
  "paused" | "complete" | "failed"
>;
export type PipelineSessionPhase =
  | "build"
  | "review"
  | "address"
  | "verify"
  | "fix"
  | "pr"
  | "resolve-conflicts";

/** The steps a launcher can configure independently. */
export type BuildStepKey =
  | "build"
  | "review"
  | "address"
  | "verify"
  | "pr"
  | "resolve-conflicts";

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
}

export type BuildStepConfigs = Partial<Record<BuildStepKey, BuildStepConfig>>;

/**
 * Which configured step owns a session phase.
 *
 * Every phase maps to its own step except `fix`: it re-implements against
 * verification feedback, which is build work, and it has no launcher control of
 * its own. Falling back to a repository default there would ignore the harness
 * the user just chose for the build.
 */
export function stepKeyForSessionPhase(
  phase: PipelineSessionPhase,
): BuildStepKey {
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
type VerificationVerdictFieldType<T extends "boolean" | "string"> =
  T extends "boolean" ? boolean : string;

/**
 * The verification turn's answer: did the committed branch meet the ticket?
 *
 * Shared rather than declared at the point of use so the supervisor that
 * enforces the schema and the transcript that renders the answer cannot drift
 * apart — a renderer guessing at the shape would silently fall back to raw JSON
 * the day a field is added.
 */
export type VerificationVerdict = {
  -readonly [Field in VerificationVerdictField]:
    VerificationVerdictFieldType<(typeof VERIFICATION_VERDICT_FIELDS)[Field]>;
};

const VERIFICATION_VERDICT_FIELD_ENTRIES = Object.entries(
  VERIFICATION_VERDICT_FIELDS,
) as [VerificationVerdictField, "boolean" | "string"][];

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
    VERIFICATION_VERDICT_FIELD_ENTRIES.map(([field, type]) => [
      field,
      Object.freeze({ type }),
    ]),
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
export function isVerificationVerdict(
  value: unknown,
): value is VerificationVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== VERIFICATION_VERDICT_FIELD_ENTRIES.length) {
    return false;
  }
  return VERIFICATION_VERDICT_FIELD_ENTRIES.every(
    ([field, type]) => typeof record[field] === type,
  );
}

export interface PipelineSession {
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
  /** Persisted interaction authority for backend-owned workflow sessions. */
  origin?: import("./agent-interactions.js").AgentInteractionOrigin;
  interactionPolicy?: import("./agent-interactions.js").AgentInteractionPolicy;
  iteration: number;
  sessionKey: string;
  sdkSessionId: string;
  status: "running" | "idle" | "error";
  startedAt: string;
  label: string;
  /** Provider transcript snapshot. The backend refreshes it; clients only render it. */
  messages?: unknown[];
  messageRevision?: number;
  /**
   * Cheap change detector for {@link messages}. Comparing two full transcript
   * serializations on every supervisor tick is O(transcript) twice per pass;
   * this collapses that to the length plus the tail entry, which is what an
   * append-or-stream-the-last-entry transcript actually varies.
   */
  messagesFingerprint?: string;
  /** Last time a transcript-only delta was persisted, used to throttle writes. */
  messagesPersistedAt?: string;
  /** Start of the current provider turn, used by liveness and stall timing. */
  turnStartedAt?: string;
  /** Stable structured-output key for review and verification turns. */
  structuredRequestId?: string;
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
   * Immutable Git state captured before a writable validation turn starts.
   *
   * Review and verification may write ignored compiler output and caches, but
   * the backend refuses to accept their result if HEAD moves or the set of
   * Git-visible uncommitted paths changes. The baseline is a *set*, not a
   * cleanliness flag: the build stage is only asked to commit, so a review can
   * legitimately start on a dirty tree, and only the paths validation itself
   * adds or removes are a violation. Persisting it keeps the guard valid across
   * backend restarts.
   */
  validationHeadAtStart?: string;
  validationWorktreeStatusAtStart?: "clean" | "dirty" | "unknown";
  validationUncommittedPathsAtStart?: string[];
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
export type PipelineFailureKind =
  | "prompt-dispatch"
  | "stage-transition"
  | "interactive-request";

export interface PipelineFailureContext {
  phase: ResumableBuildPhase;
  kind: PipelineFailureKind;
  sessionId?: string;
  prompt?: string;
  useTaskImages?: boolean;
  requestId?: string;
  structuredReview?: boolean;
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
  id: string;
  sessionId: string;
  requestId: string;
  phase: ResumableBuildPhase;
  prompt: string;
  useTaskImages: boolean;
  structuredReview?: boolean;
  startedAt: string;
}

export interface BuildPipeline {
  id: string;
  taskId: string;
  projectId: string;
  environmentId: string;
  environmentType: BuildPipelineEnvironmentType;
  agentType: BuildPipelineAgent;
  /**
   * Per-step launch configuration. A missing step, or a missing field within
   * one, falls back to the repository and global defaults.
   */
  steps?: BuildStepConfigs;
  phase: BuildPhase;
  sessions: PipelineSession[];
  currentSessionIndex: number;
  iteration: number;
  maxIterations: number;
  verificationResult?: "pass" | "fail";
  verificationFeedback?: string;
  structuredReview?: StructuredReviewReport;
  structuredReviewRequestId?: string;
  pausedFromPhase?: ResumableBuildPhase;
  error?: string;
  failureContext?: PipelineFailureContext;
  reconnectAttempt?: PipelineReconnectAttempt;
  pendingPromptAttempt?: PipelinePromptAttempt;
  activePromptContext?: PipelineFailureContext;
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
  agentType: BuildPipelineAgent;
  /** Per-step harness, model and reasoning chosen in the build launcher. */
  steps?: BuildStepConfigs;
  taskTitle: string;
  taskSnapshot: TaskSnapshot;
  source?: BuildPipelineSource;
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
const ENVIRONMENT_TYPES = new Set<BuildPipelineEnvironmentType>([
  "containerized",
  "local",
]);
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
const INTERACTION_KINDS: ReadonlySet<AgentInteractionKind> = new Set(
  AGENT_INTERACTION_KINDS,
);

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
function interactionPresentationTextLength(
  value: Record<string, unknown>,
): number {
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
    return INTERACTION_PAYLOAD_ENCODER.encode(JSON.stringify(value)).byteLength
      <= AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes;
  } catch {
    return false;
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNonBlankString(value: unknown): value is string | undefined {
  return value === undefined
    || (typeof value === "string" && value.length > 0);
}

/**
 * Every timestamp in a snapshot is produced by {@link Date.toISOString}, so the
 * guard requires that shape rather than whatever `Date.parse` happens to accept.
 * A bare `Date.parse` check passes strings like "March 5 2020", which would let
 * a hand-edited or legacy record through and then compare wrongly against the
 * deadlines the supervisor derives from these fields.
 */
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoDate(value: unknown): value is string {
  return typeof value === "string"
    && ISO_DATE_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function isBuildStepConfig(value: unknown): value is BuildStepConfig {
  if (!isRecord(value)) return false;
  return AGENTS.has(value.agent as BuildPipelineAgent)
    && isOptionalNonBlankString(value.model)
    && isOptionalNonBlankString(value.reasoningEffort);
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
    paths !== undefined
    && (!Array.isArray(paths) || paths.some((entry) => typeof entry !== "string"))
  ) {
    return false;
  }
  if (head === undefined) {
    return (status === undefined || status === "unknown") && paths === undefined;
  }
  return typeof head === "string"
    && /^[0-9a-f]{40,64}$/i.test(head)
    && (status === "clean" || status === "dirty");
}

/**
 * Only the keys in {@link BUILD_STEP_KEYS} are accepted. An unknown key would be
 * carried through the snapshot and silently never consulted, which reads as a
 * setting that was applied when it was not.
 */
export function isBuildStepConfigs(value: unknown): value is BuildStepConfigs {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, config]) =>
    BUILD_STEP_KEYS.includes(key as BuildStepKey)
    && (config === undefined || isBuildStepConfig(config)));
}

function isPipelineSession(value: unknown): value is PipelineSession {
  if (!isRecord(value)) return false;
  return SESSION_PHASES.has(value.phase as PipelineSessionPhase)
    && (value.agent === undefined
      || AGENTS.has(value.agent as BuildPipelineAgent))
    && (
      (value.origin === undefined && value.interactionPolicy === undefined)
      || (
        value.origin === "build-pipeline"
        && isAgentInteractionPolicy(value.interactionPolicy)
        && value.interactionPolicy.mode === "unattended"
      )
    )
    && isNonNegativeInteger(value.iteration)
    && typeof value.sessionKey === "string"
    && value.sessionKey.length > 0
    && typeof value.sdkSessionId === "string"
    && value.sdkSessionId.length > 0
    && (value.status === "running"
      || value.status === "idle"
      || value.status === "error")
    && isIsoDate(value.startedAt)
    && typeof value.label === "string"
    && (value.messages === undefined || Array.isArray(value.messages))
    && (value.messageRevision === undefined
      || isNonNegativeInteger(value.messageRevision))
    && isOptionalNonBlankString(value.messagesFingerprint)
    && (value.messagesPersistedAt === undefined
      || isIsoDate(value.messagesPersistedAt))
    && (value.turnStartedAt === undefined
      || isIsoDate(value.turnStartedAt))
    && isOptionalNonBlankString(value.structuredRequestId)
    && (value.structuredResultStatus === undefined
      || value.structuredResultStatus === "pending"
      || value.structuredResultStatus === "accepted")
    && hasValidValidationWorktreeBaseline(value)
    && (value.structuredWaitStartedAt === undefined
      || isIsoDate(value.structuredWaitStartedAt))
    && (value.structuredReportRepairAttempts === undefined
      || isNonNegativeInteger(value.structuredReportRepairAttempts))
    && (value.interactionSummary === undefined
      || isAgentInteractionWorkflowSummary(value.interactionSummary))
    && (value.autoDeclineCount === undefined
      || isNonNegativeInteger(value.autoDeclineCount))
    && (value.interactionTranscript === undefined
      || (Array.isArray(value.interactionTranscript)
        && value.interactionTranscript.length <= AGENT_INTERACTION_LIMITS.maxWorkflowSummaries
        && value.interactionTranscript.every(isPipelineInteractionTranscriptEntry)
        // Cheap lower bound first: the per-field maximums permit a structurally
        // valid transcript far larger than the byte budget, and serializing one
        // to find that out is the amplification this guard exists to prevent.
        && isWithinTextLowerBound(value.interactionTranscript.reduce(
          (total: number, entry: unknown) => total + (isRecord(entry)
            ? interactionPresentationTextLength(entry)
            : 0),
          0,
        ))
        && isWithinInteractionPayloadLimit(value.interactionTranscript)));
}

function isPipelineInteractionQuestion(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "prompt" || key === "options")
    && typeof value.prompt === "string"
    && value.prompt.length > 0
    && value.prompt.length <= AGENT_INTERACTION_LIMITS.maxTextLength
    && Array.isArray(value.options)
    && value.options.length <= AGENT_INTERACTION_LIMITS.maxOptionsPerQuestion
    && value.options.every((option) =>
      typeof option === "string"
      && option.length > 0
      && option.length <= AGENT_INTERACTION_LIMITS.maxTextLength);
}

function isPipelineInteractionPresentation(value: Record<string, unknown>): boolean {
  return typeof value.interactionId === "string"
    && value.interactionId.length > 0
    && value.interactionId.length <= AGENT_INTERACTION_LIMITS.maxIdLength
    && INTERACTION_PROVIDERS.has(value.provider as AgentInteractionProvider)
    && INTERACTION_KINDS.has(value.kind as AgentInteractionKind)
    && SESSION_PHASES.has(value.phase as PipelineSessionPhase)
    && isRenderableEpoch(value.requestedAt)
    && typeof value.title === "string"
    && value.title.length > 0
    && value.title.length <= AGENT_INTERACTION_LIMITS.maxTextLength
    && (value.body === undefined
      || (typeof value.body === "string"
        && value.body.length > 0
        && value.body.length <= AGENT_INTERACTION_LIMITS.maxTextLength))
    && Array.isArray(value.questions)
    && value.questions.length <= AGENT_INTERACTION_LIMITS.maxQuestionsPerRequest
    && value.questions.every(isPipelineInteractionQuestion);
}

function isPipelineInteractionTranscriptEntry(
  value: unknown,
): value is PipelineInteractionTranscriptEntry {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "id", "provider", "kind", "phase", "requestedAt", "resolvedAt",
      "outcome", "title", "body", "questions",
    ].includes(key))
    && isNonBlankString(value.id)
    && value.id.length <= AGENT_INTERACTION_LIMITS.maxIdLength
    && isPipelineInteractionPresentation({ ...value, interactionId: value.id })
    // Deliberately *not* cross-checked against the live unattended policy. This
    // is an immutable record of something that already happened; reclassifying
    // a kind (say, making `mcp-url` an authorization) would otherwise make every
    // snapshot that recorded it unparseable, which the supervisor reads as a
    // pipeline to skip and the renderer as a pipeline to delete. The recorded
    // `outcome` below is what pins the entry's meaning.
    && isRenderableEpoch(value.resolvedAt)
    && (value.resolvedAt as number) >= (value.requestedAt as number)
    && value.outcome === "auto-declined-headless";
}

function isPendingPipelineInteractionResolution(
  value: unknown,
): value is PendingPipelineInteractionResolution {
  return isRecord(value)
    && Object.keys(value).every((key) => [
      "journalId", "sessionKey", "interactionId", "provider", "kind", "phase",
      "sessionId", "requestedAt", "claimedAt", "action", "title", "body", "questions",
    ].includes(key))
    && isPipelineInteractionPresentation(value)
    && isNonBlankString(value.journalId)
    && value.journalId.length <= AGENT_INTERACTION_LIMITS.maxIdLength
    && isNonBlankString(value.sessionKey)
    && value.sessionKey.length <= AGENT_INTERACTION_LIMITS.maxIdLength
    && isNonBlankString(value.sessionId)
    && value.sessionId.length <= AGENT_INTERACTION_LIMITS.maxIdLength
    && isRenderableEpoch(value.claimedAt)
    && (value.claimedAt as number) >= (value.requestedAt as number)
    // Same reasoning as the transcript entry: an in-flight envelope written
    // before a policy change must still parse after the upgrade, or the
    // pipeline it belongs to disappears instead of finishing its interaction.
    && (value.action === "decline-and-continue" || value.action === "deny-and-fail")
    && isWithinTextLowerBound(interactionPresentationTextLength(value))
    && isWithinInteractionPayloadLimit(value);
}

function isUserMessage(value: unknown): value is PipelineUserMessage {
  if (!isRecord(value)) return false;
  return isNonBlankString(value.id)
    && typeof value.text === "string"
    && value.text.length > 0
    && value.text.length <= MAX_PIPELINE_USER_MESSAGE_LENGTH
    && isIsoDate(value.createdAt);
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!isRecord(value)) return false;
  return typeof value.title === "string"
    && typeof value.description === "string"
    && typeof value.acceptanceCriteria === "string"
    && Array.isArray(value.comments)
    && value.comments.every((comment) =>
      isRecord(comment) && typeof comment.text === "string")
    && Array.isArray(value.images)
    && value.images.every((image) =>
      isRecord(image)
      && typeof image.filename === "string"
      && typeof image.data === "string");
}

function isFailureContext(value: unknown): value is PipelineFailureContext {
  if (!isRecord(value)) return false;
  return RESUMABLE_PHASES.has(value.phase as ResumableBuildPhase)
    && FAILURE_KINDS.has(value.kind as PipelineFailureKind)
    && isOptionalNonBlankString(value.sessionId)
    && isOptionalString(value.prompt)
    && (value.useTaskImages === undefined
      || typeof value.useTaskImages === "boolean")
    && isOptionalNonBlankString(value.requestId)
    && (value.structuredReview === undefined
      || typeof value.structuredReview === "boolean");
}

function isReconnectAttempt(value: unknown): value is PipelineReconnectAttempt {
  if (!isRecord(value) || !isFailureContext(value)) return false;
  return isNonBlankString(value.id)
    && isIsoDate(value.startedAt)
    && (value.agent === undefined
      || AGENTS.has(value.agent as BuildPipelineAgent));
}

function isPromptAttempt(value: unknown): value is PipelinePromptAttempt {
  if (!isRecord(value)) return false;
  return isNonBlankString(value.id)
    && isNonBlankString(value.sessionId)
    && isNonBlankString(value.requestId)
    && RESUMABLE_PHASES.has(value.phase as ResumableBuildPhase)
    && typeof value.prompt === "string"
    && typeof value.useTaskImages === "boolean"
    && (value.structuredReview === undefined
      || typeof value.structuredReview === "boolean")
    && isIsoDate(value.startedAt);
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
    value.controller !== "backend"
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.taskId !== "string"
    || value.taskId.length === 0
    || typeof value.projectId !== "string"
    || value.projectId.length === 0
    || typeof value.environmentId !== "string"
    || !ENVIRONMENT_TYPES.has(value.environmentType as BuildPipelineEnvironmentType)
    || !AGENTS.has(value.agentType as BuildPipelineAgent)
    || (value.steps !== undefined && !isBuildStepConfigs(value.steps))
    || !BUILD_PHASES.has(value.phase as BuildPhase)
    || !Array.isArray(value.sessions)
    || !value.sessions.every(isPipelineSession)
    || !isNonNegativeInteger(value.iteration)
    || !Number.isSafeInteger(value.maxIterations)
    || (value.maxIterations as number) < 1
    // Kept in step with isStartBuildPipelineInput: no legitimate record can
    // exceed the bound the gateway enforces on the way in.
    || (value.maxIterations as number) > MAX_BUILD_PIPELINE_ITERATIONS
    || !isNonNegativeInteger(value.backendRevision)
    || !isIsoDate(value.createdAt)
    || typeof value.taskTitle !== "string"
    || !isTaskSnapshot(value.taskSnapshot)
    || (value.verificationResult !== undefined
      && value.verificationResult !== "pass"
      && value.verificationResult !== "fail")
    || !isOptionalString(value.verificationFeedback)
    || (value.structuredReview !== undefined
      && !isStructuredReviewReport(value.structuredReview))
    || !isOptionalNonBlankString(value.structuredReviewRequestId)
    || (value.pausedFromPhase !== undefined
      && !RESUMABLE_PHASES.has(value.pausedFromPhase as ResumableBuildPhase))
    || !isOptionalString(value.error)
    || (value.failureContext !== undefined
      && !isFailureContext(value.failureContext))
    || (value.reconnectAttempt !== undefined
      && !isReconnectAttempt(value.reconnectAttempt))
    || (value.pendingPromptAttempt !== undefined
      && !isPromptAttempt(value.pendingPromptAttempt))
    || (value.activePromptContext !== undefined
      && !isFailureContext(value.activePromptContext))
    || (value.pendingInteractionResolution !== undefined
      && !isPendingPipelineInteractionResolution(value.pendingInteractionResolution))
    || (value.interactionSummary !== undefined
      && !isAgentInteractionWorkflowSummary(value.interactionSummary))
    || (value.autoDeclineCount !== undefined
      && !isNonNegativeInteger(value.autoDeclineCount))
    || (value.stallWarning !== undefined
      && (!isRecord(value.stallWarning)
        || !isNonBlankString(value.stallWarning.sessionId)
        || !isIsoDate(value.stallWarning.detectedAt)))
    || (value.interactionRetryRequested !== undefined
      && typeof value.interactionRetryRequested !== "boolean")
    || (value.stageRetryRequested !== undefined
      && typeof value.stageRetryRequested !== "boolean")
    || (value.pendingUserMessages !== undefined
      && (
        !Array.isArray(value.pendingUserMessages)
        || value.pendingUserMessages.length > MAX_PIPELINE_USER_MESSAGES
        || !value.pendingUserMessages.every(isUserMessage)
      ))
    || (value.reviewRetryRequested !== undefined
      && typeof value.reviewRetryRequested !== "boolean")
    || (value.source !== undefined && !isPipelineSource(value.source))
    || !isOptionalNonBlankString(value.featurePlanId)
    || !isOptionalNonBlankString(value.admissionKey)
    || (value.sourceLinkedAt !== undefined && !isIsoDate(value.sourceLinkedAt))
    || (value.completionCommentStatus !== undefined
      && value.completionCommentStatus !== "posting"
      && value.completionCommentStatus !== "posted"
      && value.completionCommentStatus !== "failed")
    || !isOptionalString(value.completionCommentError)
    || !isOptionalNonBlankString(value.completionCommentId)
    || (value.completionCommentPostedAt !== undefined
      && !isIsoDate(value.completionCommentPostedAt))
  ) {
    return false;
  }
  const index = value.currentSessionIndex;
  return Number.isSafeInteger(index)
    && (value.sessions.length === 0
      ? index === -1
      : (index as number) >= 0 && (index as number) < value.sessions.length);
}

function isPipelineSource(value: unknown): value is BuildPipelineSource {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "kanban") {
    return typeof value.taskId === "string" && value.taskId.length > 0;
  }
  if (value.type === "linear") {
    return typeof value.issueId === "string"
      && value.issueId.length > 0
      && typeof value.issueIdentifier === "string"
      && value.issueIdentifier.length > 0
      && isOptionalString(value.issueUrl)
      && isOptionalString(value.status)
      && isOptionalString(value.teamKey)
      && (value.updatedAt === undefined || isIsoDate(value.updatedAt));
  }
  return value.type === "github"
    && typeof value.repositoryOwner === "string"
    && value.repositoryOwner.length > 0
    && typeof value.repositoryName === "string"
    && value.repositoryName.length > 0
    && Number.isSafeInteger(value.issueNumber)
    && (value.issueNumber as number) > 0
    && typeof value.issueUrl === "string"
    && typeof value.status === "string"
    && (value.updatedAt === undefined || isIsoDate(value.updatedAt));
}

/** Strict gateway guard for starting backend-owned work. */
export function isStartBuildPipelineInput(
  value: unknown,
): value is StartBuildPipelineInput {
  if (!isRecord(value)) return false;
  return typeof value.taskId === "string"
    && value.taskId.length > 0
    && typeof value.projectId === "string"
    && value.projectId.length > 0
    && typeof value.taskTitle === "string"
    && value.taskTitle.length > 0
    && ENVIRONMENT_TYPES.has(
      value.environmentType as BuildPipelineEnvironmentType,
    )
    && AGENTS.has(value.agentType as BuildPipelineAgent)
    && (value.steps === undefined || isBuildStepConfigs(value.steps))
    && isTaskSnapshot(value.taskSnapshot)
    && (value.source === undefined || isPipelineSource(value.source))
    && (value.namingPrompt === undefined
      || typeof value.namingPrompt === "string")
    && (value.existingEnvironmentId === undefined
      || (
        typeof value.existingEnvironmentId === "string"
        && value.existingEnvironmentId.length > 0
      ))
    && (value.featurePlanId === undefined
      || (
        typeof value.featurePlanId === "string"
        && value.featurePlanId.length > 0
      ))
    && (value.maxIterations === undefined
      || (
        Number.isSafeInteger(value.maxIterations)
        && (value.maxIterations as number) >= 1
        && (value.maxIterations as number) <= MAX_BUILD_PIPELINE_ITERATIONS
      ));
}
