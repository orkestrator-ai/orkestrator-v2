import {
  isStructuredReviewReport,
  type StructuredReviewReport,
} from "./structured-review.js";

export const BUILD_PIPELINE_VERSION = 2;

export type BuildPipelineAgent = "claude" | "opencode" | "codex";
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
  | "verify"
  | "fix"
  | "pr"
  | "resolve-conflicts";

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
  /** Stable structured-output key for review and verification turns. */
  structuredRequestId?: string;
  /**
   * First tick at which this session was idle with no structured result yet.
   * A turn that ends without ever producing one would otherwise poll forever.
   */
  structuredWaitStartedAt?: string;
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
export type PipelineFailureKind = "prompt-dispatch" | "stage-transition";

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
const AGENTS = new Set<BuildPipelineAgent>(["claude", "codex", "opencode"]);
const ENVIRONMENT_TYPES = new Set<BuildPipelineEnvironmentType>([
  "containerized",
  "local",
]);
const SESSION_PHASES = new Set<PipelineSessionPhase>([
  "build",
  "review",
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
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

function isPipelineSession(value: unknown): value is PipelineSession {
  if (!isRecord(value)) return false;
  return SESSION_PHASES.has(value.phase as PipelineSessionPhase)
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
    && isOptionalNonBlankString(value.structuredRequestId)
    && (value.structuredWaitStartedAt === undefined
      || isIsoDate(value.structuredWaitStartedAt));
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
  return isNonBlankString(value.id) && isIsoDate(value.startedAt);
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
