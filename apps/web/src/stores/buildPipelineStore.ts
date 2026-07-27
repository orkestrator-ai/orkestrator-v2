import { create } from "zustand";
import type { DefaultAgent, EnvironmentType } from "@/types";
import type { TaskSnapshot } from "@/prompts";
import { createUuid } from "@/lib/uuid";
import {
  isStructuredReviewReport,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";

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

export type PipelineSessionPhase = "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";

export interface PipelineSession {
  phase: PipelineSessionPhase;
  iteration: number;
  sessionKey: string;
  sdkSessionId: string;
  status: "running" | "idle" | "error";
  startedAt: string;
  label: string;
}

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

export interface PipelineReconnectAttempt {
  id: string;
  phase: ResumableBuildPhase;
  kind: PipelineFailureKind;
  sessionId?: string;
  prompt?: string;
  useTaskImages?: boolean;
  requestId?: string;
  structuredReview?: boolean;
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
  environmentType: EnvironmentType;
  agentType: DefaultAgent;
  phase: BuildPhase;
  sessions: PipelineSession[];
  currentSessionIndex: number;
  iteration: number;
  maxIterations: number;
  verificationResult?: "pass" | "fail";
  verificationFeedback?: string;
  /** Last validated report from the authoritative provider structured channel. */
  structuredReview?: StructuredReviewReport;
  /** Stable provider request key, persisted for reconnect/retry recovery. */
  structuredReviewRequestId?: string;
  pausedFromPhase?: ResumableBuildPhase;
  error?: string;
  failureContext?: PipelineFailureContext;
  reconnectAttempt?: PipelineReconnectAttempt;
  pendingPromptAttempt?: PipelinePromptAttempt;
  activePromptContext?: PipelineFailureContext;
  createdAt: string;
  taskTitle: string;
  taskSnapshot: TaskSnapshot;
  source?: BuildPipelineSource;
  completionCommentStatus?: CompletionCommentStatus;
  completionCommentError?: string;
  completionCommentId?: string;
  completionCommentPostedAt?: string;
  /**
   * Highest backend revision this snapshot is known to descend from. The
   * persistence layer uses it as the compare-and-swap expectation, which is what
   * stops two clients driving the same pipeline from both winning a write.
   */
  backendRevision: number;
}

interface BuildPipelineState {
  pipelines: Map<string, BuildPipeline>;
  /** Derived set of environment IDs associated with any pipeline, for O(1) lookups */
  buildEnvironmentIds: Set<string>;

  // Actions
  createPipeline: (params: {
    taskId: string;
    projectId: string;
    environmentType: EnvironmentType;
    agentType: DefaultAgent;
    taskTitle: string;
    taskSnapshot: TaskSnapshot;
    source?: BuildPipelineSource;
  }) => string;
  setPipelineEnvironment: (pipelineId: string, environmentId: string) => void;
  addSession: (pipelineId: string, session: PipelineSession) => void;
  setPhase: (pipelineId: string, phase: BuildPhase) => void;
  markSessionIdle: (pipelineId: string, sdkSessionId: string) => void;
  setCurrentSessionIndex: (pipelineId: string, index: number) => void;
  setVerificationResult: (pipelineId: string, result: "pass" | "fail", feedback: string) => void;
  beginStructuredReview: (pipelineId: string, requestId: string) => void;
  setStructuredReview: (pipelineId: string, report: StructuredReviewReport) => void;
  incrementIteration: (pipelineId: string) => void;
  setPipelineError: (pipelineId: string, error: string, context?: PipelineFailureContext | null) => void;
  beginReconnect: (pipelineId: string, attempt: PipelineReconnectAttempt) => boolean;
  completeReconnect: (pipelineId: string, attemptId: string) => boolean;
  failReconnect: (pipelineId: string, attemptId: string, error: string) => boolean;
  beginPromptAttempt: (pipelineId: string, attempt: PipelinePromptAttempt) => boolean;
  completePromptAttempt: (pipelineId: string, attemptId: string) => boolean;
  pausePipeline: (pipelineId: string) => void;
  resumePipeline: (pipelineId: string, fallbackPhase?: ResumableBuildPhase) => ResumableBuildPhase | undefined;
  markSessionRunning: (pipelineId: string, sdkSessionId: string) => void;
  setCompletionCommentStatus: (
    pipelineId: string,
    status: CompletionCommentStatus,
    details?: { commentId?: string; postedAt?: string; error?: string },
  ) => void;
  clearCompletionCommentStatus: (pipelineId: string) => void;
  removePipeline: (pipelineId: string) => void;
  removePipelinesForTask: (taskId: string) => void;
  removePipelinesForEnvironment: (environmentId: string) => void;
  reconcilePipelinesForProject: (
    projectId: string,
    environments: ReadonlySet<string> | readonly {
      id: string;
      buildPipelineId?: string;
    }[],
    options?: {
      /** Remove nonterminal pipelines whose linked environment is missing. */
      removeMissingActive?: boolean;
      /** Remove an unlinked creation reservation not recovered by the snapshot. */
      removeUnresolvedCreating?: boolean;
    },
  ) => void;

  /** Installs an authoritative backend snapshot, replacing any local copy. */
  replacePipeline: (pipeline: BuildPipeline) => void;
  /** Records the revision a successful write landed at. */
  setBackendRevision: (pipelineId: string, revision: number) => void;

  // Selectors
  getPipelineByTaskId: (taskId: string) => BuildPipeline | undefined;
  getPipelineForGitHubIssue: (
    repositoryOwner: string,
    repositoryName: string,
    issueNumber: number,
    activeOnly?: boolean,
  ) => BuildPipeline | undefined;
  getPipelineById: (id: string) => BuildPipeline | undefined;
  getActivePipelineForEnvironment: (environmentId: string) => BuildPipeline | undefined;
  isBuildEnvironment: (environmentId: string) => boolean;
  /** Rebuild the buildEnvironmentIds set from current pipelines */
  _rebuildBuildEnvironmentIds: () => Set<string>;
}

/**
 * Snapshot schema version. Bump when a change would make an older persisted
 * snapshot misread rather than merely incomplete; the backend stores it
 * alongside each record so a stale snapshot can be recognised, not guessed at.
 */
export const BUILD_PIPELINE_VERSION = 1;

/**
 * Whether a build phase represents an in-progress build (a running, abortable
 * pipeline) as opposed to a terminal ("complete"/"failed") or "paused" phase.
 * Active builds must be stopped before their status is cleared so the underlying
 * agent session can be aborted rather than orphaned.
 */
export function isActiveBuildPhase(phase: BuildPhase): boolean {
  return phase !== "paused" && phase !== "complete" && phase !== "failed";
}

function isResumableBuildPhase(phase: BuildPhase): phase is ResumableBuildPhase {
  return isActiveBuildPhase(phase);
}

/**
 * Runtime validation for a snapshot arriving from the backend.
 *
 * The backend stores the snapshot opaquely, so this is the only boundary that
 * can reject a record written by a different application version. A pipeline
 * that fails validation is dropped rather than partially applied: half a state
 * machine would advance a build in a way nobody wrote.
 */
export function isBuildPipeline(value: unknown): value is BuildPipeline {
  if (!isRecord(value)) return false;
  const candidate = value as Record<string, unknown>;

  if (
    !isNonEmptyString(candidate.id)
    || !isNonEmptyString(candidate.taskId)
    || !isNonEmptyString(candidate.projectId)
    || typeof candidate.environmentId !== "string"
    || !ENVIRONMENT_TYPES.has(candidate.environmentType)
    || !AGENT_TYPES.has(candidate.agentType)
    || !isBuildPhaseValue(candidate.phase)
    || !Array.isArray(candidate.sessions)
    || !candidate.sessions.every(isPipelineSession)
    || !isNonNegativeSafeInteger(candidate.iteration)
    || !isPositiveSafeInteger(candidate.maxIterations)
    || candidate.iteration > candidate.maxIterations
    || !isNonNegativeSafeInteger(candidate.backendRevision)
    || !isValidDateString(candidate.createdAt)
    || typeof candidate.taskTitle !== "string"
    || !isTaskSnapshot(candidate.taskSnapshot)
    || !isOptional(candidate.verificationResult, (entry) =>
      entry === "pass" || entry === "fail")
    || !isOptionalString(candidate.verificationFeedback)
    || !isOptional(candidate.structuredReview, isStructuredReviewReport)
    || !isOptionalNonEmptyString(candidate.structuredReviewRequestId)
    || !isOptional(candidate.pausedFromPhase, isResumableBuildPhaseValue)
    || !isOptionalString(candidate.error)
    || !isOptional(candidate.failureContext, isPipelineFailureContext)
    || !isOptional(candidate.reconnectAttempt, isPipelineReconnectAttempt)
    || !isOptional(candidate.pendingPromptAttempt, isPipelinePromptAttempt)
    || !isOptional(candidate.activePromptContext, isPipelineFailureContext)
    || !isOptional(candidate.source, isBuildPipelineSource)
    || !isOptional(candidate.completionCommentStatus, (entry) =>
      COMPLETION_COMMENT_STATUSES.has(entry))
    || !isOptionalString(candidate.completionCommentError)
    || !isOptionalString(candidate.completionCommentId)
    || !isOptional(candidate.completionCommentPostedAt, isValidDateString)
  ) {
    return false;
  }

  const currentSessionIndex = candidate.currentSessionIndex;
  if (
    typeof currentSessionIndex !== "number"
    || !Number.isSafeInteger(currentSessionIndex)
    || candidate.sessions.some((session) =>
      session.iteration > (candidate.maxIterations as number))
  ) {
    return false;
  }
  if (candidate.sessions.length === 0) return currentSessionIndex === -1;
  return currentSessionIndex >= 0 && currentSessionIndex < candidate.sessions.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isOptional(
  value: unknown,
  predicate: (entry: unknown) => boolean,
): boolean {
  return value === undefined || predicate(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isValidDateString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isResumableBuildPhaseValue(value: unknown): value is ResumableBuildPhase {
  return isBuildPhaseValue(value)
    && value !== "paused"
    && value !== "complete"
    && value !== "failed";
}

function isPipelineSession(value: unknown): value is PipelineSession {
  if (!isRecord(value)) return false;
  return (
    PIPELINE_SESSION_PHASES.has(value.phase)
    && isNonNegativeSafeInteger(value.iteration)
    && isNonEmptyString(value.sessionKey)
    && isNonEmptyString(value.sdkSessionId)
    && PIPELINE_SESSION_STATUSES.has(value.status)
    && isValidDateString(value.startedAt)
    && typeof value.label === "string"
  );
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.title === "string"
    && typeof value.description === "string"
    && typeof value.acceptanceCriteria === "string"
    && Array.isArray(value.comments)
    && value.comments.every((comment) =>
      isRecord(comment) && typeof comment.text === "string")
    && Array.isArray(value.images)
    && value.images.every((image) =>
      isRecord(image)
      && isNonEmptyString(image.filename)
      && typeof image.data === "string")
  );
}

function isPipelineFailureContext(value: unknown): value is PipelineFailureContext {
  if (!isRecord(value)) return false;
  return (
    isResumableBuildPhaseValue(value.phase)
    && PIPELINE_FAILURE_KINDS.has(value.kind)
    && isOptionalNonEmptyString(value.sessionId)
    && isOptionalString(value.prompt)
    && (value.useTaskImages === undefined || typeof value.useTaskImages === "boolean")
    && isOptionalNonEmptyString(value.requestId)
    && (value.structuredReview === undefined || typeof value.structuredReview === "boolean")
  );
}

const BUILD_PHASES: ReadonlySet<string> = new Set<BuildPhase>([
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

function isPipelineReconnectAttempt(value: unknown): value is PipelineReconnectAttempt {
  return isRecord(value)
    && isPipelineFailureContext(value)
    && isNonEmptyString(value.id)
    && isValidDateString(value.startedAt);
}

function isPipelinePromptAttempt(value: unknown): value is PipelinePromptAttempt {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.requestId)
    && isResumableBuildPhaseValue(value.phase)
    && typeof value.prompt === "string"
    && typeof value.useTaskImages === "boolean"
    && (value.structuredReview === undefined || typeof value.structuredReview === "boolean")
    && isValidDateString(value.startedAt)
  );
}

function isBuildPipelineSource(value: unknown): value is BuildPipelineSource {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "kanban":
      return isNonEmptyString(value.taskId);
    case "linear":
      return (
        isNonEmptyString(value.issueId)
        && isNonEmptyString(value.issueIdentifier)
        && isOptionalString(value.issueUrl)
        && isOptionalString(value.status)
        && isOptionalString(value.teamKey)
        && isOptional(value.updatedAt, isValidDateString)
      );
    case "github":
      return (
        isNonEmptyString(value.repositoryOwner)
        && isNonEmptyString(value.repositoryName)
        && isPositiveSafeInteger(value.issueNumber)
        && isNonEmptyString(value.issueUrl)
        && typeof value.status === "string"
        && isOptional(value.updatedAt, isValidDateString)
      );
    default:
      return false;
  }
}

const ENVIRONMENT_TYPES: ReadonlySet<unknown> = new Set(["containerized", "local"]);
const AGENT_TYPES: ReadonlySet<unknown> = new Set(["claude", "opencode", "codex"]);
const PIPELINE_SESSION_PHASES: ReadonlySet<unknown> = new Set([
  "build",
  "review",
  "verify",
  "fix",
  "pr",
  "resolve-conflicts",
]);
const PIPELINE_SESSION_STATUSES: ReadonlySet<unknown> = new Set(["running", "idle", "error"]);
const PIPELINE_FAILURE_KINDS: ReadonlySet<unknown> = new Set([
  "prompt-dispatch",
  "stage-transition",
]);
const COMPLETION_COMMENT_STATUSES: ReadonlySet<unknown> = new Set([
  "posting",
  "posted",
  "failed",
]);

function isBuildPhaseValue(value: unknown): value is BuildPhase {
  return typeof value === "string" && BUILD_PHASES.has(value);
}

export const useBuildPipelineStore = create<BuildPipelineState>()((set, get) => ({
  pipelines: new Map(),
  buildEnvironmentIds: new Set<string>(),

  createPipeline: ({ taskId, projectId, environmentType, agentType, taskTitle, taskSnapshot, source }) => {
    const id = createUuid();
    const pipeline: BuildPipeline = {
      id,
      taskId,
      projectId,
      environmentId: "",
      environmentType,
      agentType,
      phase: "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: new Date().toISOString(),
      taskTitle,
      taskSnapshot,
      source: source ?? { type: "kanban", taskId },
      // 0 means "never persisted": the first save must find no prior record.
      backendRevision: 0,
    };

    set((state) => {
      const newMap = new Map(state.pipelines);
      newMap.set(id, pipeline);
      return { pipelines: newMap };
    });

    return id;
  },

  setPipelineEnvironment: (pipelineId, environmentId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, environmentId });
      // Rebuild from the NEW map — get() still points at the old state inside set()
      const ids = new Set<string>();
      for (const p of newMap.values()) {
        if (p.environmentId) {
          ids.add(p.environmentId);
        }
      }
      return { pipelines: newMap, buildEnvironmentIds: ids };
    }),

  addSession: (pipelineId, session) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...pipeline,
        sessions: [...pipeline.sessions, session],
        currentSessionIndex: pipeline.sessions.length,
      });
      return { pipelines: newMap };
    }),

  setPhase: (pipelineId, phase) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      // A paused pipeline is intentionally locked for user intervention. Normal
      // stage detection must not move it forward until resumePipeline unlocks it.
      if (pipeline.phase === "paused" && phase !== "paused") return state;
      const newMap = new Map(state.pipelines);
      const pausedFromPhase = phase === "paused"
        ? isResumableBuildPhase(pipeline.phase)
          ? pipeline.phase
          : pipeline.pausedFromPhase
        : undefined;
      const preservesReconnect = pipeline.reconnectAttempt?.phase === phase;
      const preservesFailureContext = pipeline.phase === phase || preservesReconnect;
      newMap.set(pipelineId, {
        ...pipeline,
        phase,
        pausedFromPhase,
        failureContext: preservesFailureContext ? pipeline.failureContext : undefined,
        reconnectAttempt: preservesReconnect ? pipeline.reconnectAttempt : undefined,
        pendingPromptAttempt: pipeline.pendingPromptAttempt?.phase === phase
          ? pipeline.pendingPromptAttempt
          : undefined,
        activePromptContext: pipeline.activePromptContext?.phase === phase
          ? pipeline.activePromptContext
          : undefined,
      });
      return { pipelines: newMap };
    }),

  markSessionIdle: (pipelineId, sdkSessionId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const session = pipeline.sessions.find((candidate) => candidate.sdkSessionId === sdkSessionId);
      if (!session) return state;
      const clearsPromptContext = pipeline.activePromptContext?.sessionId === sdkSessionId;
      const clearsPendingAttempt = pipeline.pendingPromptAttempt?.sessionId === sdkSessionId;
      const clearsFailureContext = pipeline.failureContext?.kind === "prompt-dispatch"
        && pipeline.failureContext.sessionId === sdkSessionId;
      if (session.status === "idle" && !clearsPromptContext && !clearsPendingAttempt && !clearsFailureContext) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      const sessions = pipeline.sessions.map((s) =>
        s.sdkSessionId === sdkSessionId ? { ...s, status: "idle" as const } : s
      );
      newMap.set(pipelineId, {
        ...pipeline,
        sessions,
        activePromptContext: pipeline.activePromptContext?.sessionId === sdkSessionId
          ? undefined
          : pipeline.activePromptContext,
        pendingPromptAttempt: clearsPendingAttempt ? undefined : pipeline.pendingPromptAttempt,
        failureContext: clearsFailureContext ? undefined : pipeline.failureContext,
      });
      return { pipelines: newMap };
    }),

  setCurrentSessionIndex: (pipelineId, index) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (pipeline.currentSessionIndex === index) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, currentSessionIndex: index });
      return { pipelines: newMap };
    }),

  setVerificationResult: (pipelineId, result, feedback) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (pipeline.verificationResult === result && pipeline.verificationFeedback === feedback) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, verificationResult: result, verificationFeedback: feedback });
      return { pipelines: newMap };
    }),

  beginStructuredReview: (pipelineId, requestId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...pipeline,
        structuredReview: undefined,
        structuredReviewRequestId: requestId,
      });
      return { pipelines: newMap };
    }),

  setStructuredReview: (pipelineId, report) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, structuredReview: report });
      return { pipelines: newMap };
    }),

  incrementIteration: (pipelineId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, iteration: pipeline.iteration + 1 });
      return { pipelines: newMap };
    }),

  setPipelineError: (pipelineId, error, context) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (
        pipeline.phase === "complete"
        || (pipeline.phase === "paused" && context !== null)
      ) {
        return state;
      }
      if (
        context
        && pipeline.phase !== "failed"
        && pipeline.phase !== context.phase
      ) {
        return state;
      }
      if (
        context
        && pipeline.phase === "failed"
        && pipeline.failureContext
        && (
          pipeline.failureContext.phase !== context.phase
          || pipeline.failureContext.kind !== context.kind
          || pipeline.failureContext.sessionId !== context.sessionId
          || pipeline.failureContext.prompt !== context.prompt
          || pipeline.failureContext.useTaskImages !== context.useTaskImages
          || pipeline.failureContext.requestId !== context.requestId
          || pipeline.failureContext.structuredReview !== context.structuredReview
        )
      ) {
        return state;
      }
      const failureContext = context === null
        ? undefined
        : context
          ?? pipeline.activePromptContext
          ?? (isResumableBuildPhase(pipeline.phase)
            ? { phase: pipeline.phase, kind: "stage-transition" as const }
            : pipeline.failureContext);
      // No-op if already failed with the same error, so subscribers don't
      // re-render in a loop (prevents "Maximum update depth exceeded").
      if (
        pipeline.phase === "failed"
        && pipeline.error === error
        && pipeline.failureContext?.phase === failureContext?.phase
        && pipeline.failureContext?.kind === failureContext?.kind
        && pipeline.failureContext?.sessionId === failureContext?.sessionId
        && pipeline.failureContext?.prompt === failureContext?.prompt
        && pipeline.failureContext?.useTaskImages === failureContext?.useTaskImages
        && pipeline.failureContext?.requestId === failureContext?.requestId
        && pipeline.failureContext?.structuredReview === failureContext?.structuredReview
        && !pipeline.reconnectAttempt
        && !pipeline.pendingPromptAttempt
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...pipeline,
        phase: "failed",
        error,
        pausedFromPhase: undefined,
        failureContext,
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
      });
      return { pipelines: newMap };
    }),

  beginReconnect: (pipelineId, attempt) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (
      !pipeline
      || pipeline.phase !== "failed"
      || pipeline.reconnectAttempt
      || !pipeline.failureContext
      || pipeline.failureContext.phase !== attempt.phase
      || pipeline.failureContext.kind !== attempt.kind
      || pipeline.failureContext.sessionId !== attempt.sessionId
      || pipeline.failureContext.prompt !== attempt.prompt
      || pipeline.failureContext.useTaskImages !== attempt.useTaskImages
      || pipeline.failureContext.requestId !== attempt.requestId
      || pipeline.failureContext.structuredReview !== attempt.structuredReview
    ) {
      return false;
    }

    let started = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (
        !latest
        || latest.phase !== "failed"
        || latest.reconnectAttempt
        || !latest.failureContext
        || latest.failureContext.phase !== attempt.phase
        || latest.failureContext.kind !== attempt.kind
        || latest.failureContext.sessionId !== attempt.sessionId
        || latest.failureContext.prompt !== attempt.prompt
        || latest.failureContext.useTaskImages !== attempt.useTaskImages
        || latest.failureContext.requestId !== attempt.requestId
        || latest.failureContext.structuredReview !== attempt.structuredReview
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        phase: attempt.phase,
        error: undefined,
        pausedFromPhase: undefined,
        reconnectAttempt: attempt,
        activePromptContext: attempt.kind === "prompt-dispatch"
          ? {
              phase: attempt.phase,
              kind: attempt.kind,
              sessionId: attempt.sessionId,
              prompt: attempt.prompt,
              useTaskImages: attempt.useTaskImages,
              requestId: attempt.requestId,
              ...(attempt.structuredReview ? { structuredReview: true } : {}),
            }
          : undefined,
      });
      started = true;
      return { pipelines: newMap };
    });

    return started;
  },

  completeReconnect: (pipelineId, attemptId) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.reconnectAttempt?.id !== attemptId) return false;

    let completed = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.reconnectAttempt?.id !== attemptId) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        reconnectAttempt: undefined,
      });
      completed = true;
      return { pipelines: newMap };
    });

    return completed;
  },

  failReconnect: (pipelineId, attemptId, error) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.reconnectAttempt?.id !== attemptId) return false;

    let failed = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.reconnectAttempt?.id !== attemptId) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        phase: "failed",
        error,
        pausedFromPhase: undefined,
        failureContext: latest.activePromptContext ?? latest.failureContext ?? {
          phase: latest.reconnectAttempt.phase,
          kind: latest.reconnectAttempt.kind,
          sessionId: latest.reconnectAttempt.sessionId,
          prompt: latest.reconnectAttempt.prompt,
          useTaskImages: latest.reconnectAttempt.useTaskImages,
          requestId: latest.reconnectAttempt.requestId,
          ...(latest.reconnectAttempt.structuredReview
            ? { structuredReview: true }
            : {}),
        },
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
      });
      failed = true;
      return { pipelines: newMap };
    });

    return failed;
  },

  beginPromptAttempt: (pipelineId, attempt) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (
      !pipeline
      || pipeline.phase !== attempt.phase
      || pipeline.pendingPromptAttempt
    ) {
      return false;
    }

    let started = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (
        !latest
        || latest.phase !== attempt.phase
        || latest.pendingPromptAttempt
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        pendingPromptAttempt: attempt,
        failureContext: undefined,
        activePromptContext: {
          phase: attempt.phase,
          kind: "prompt-dispatch",
          sessionId: attempt.sessionId,
          prompt: attempt.prompt,
          useTaskImages: attempt.useTaskImages,
          requestId: attempt.requestId,
          ...(attempt.structuredReview ? { structuredReview: true } : {}),
        },
      });
      started = true;
      return { pipelines: newMap };
    });

    return started;
  },

  completePromptAttempt: (pipelineId, attemptId) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.pendingPromptAttempt?.id !== attemptId) return false;

    let completed = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.pendingPromptAttempt?.id !== attemptId) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        pendingPromptAttempt: undefined,
      });
      completed = true;
      return { pipelines: newMap };
    });

    return completed;
  },

  pausePipeline: (pipelineId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      const pausedFromPhase = isResumableBuildPhase(pipeline.phase)
        ? pipeline.phase
        : pipeline.pausedFromPhase;
      newMap.set(pipelineId, {
        ...pipeline,
        phase: "paused",
        pausedFromPhase,
        error: undefined,
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
      });
      return { pipelines: newMap };
    }),

  resumePipeline: (pipelineId, fallbackPhase) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.phase !== "paused") return undefined;

    const resumePhase = pipeline.pausedFromPhase ?? fallbackPhase;
    if (!resumePhase) return undefined;

    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.phase !== "paused") return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        phase: resumePhase,
        pausedFromPhase: undefined,
        error: undefined,
        failureContext: undefined,
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
      });
      return { pipelines: newMap };
    });

    return resumePhase;
  },

  markSessionRunning: (pipelineId, sdkSessionId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const session = pipeline.sessions.find((candidate) => candidate.sdkSessionId === sdkSessionId);
      if (!session || session.status === "running") return state;
      const newMap = new Map(state.pipelines);
      const sessions = pipeline.sessions.map((s) =>
        s.sdkSessionId === sdkSessionId ? { ...s, status: "running" as const } : s
      );
      newMap.set(pipelineId, { ...pipeline, sessions });
      return { pipelines: newMap };
    }),

  setCompletionCommentStatus: (pipelineId, status, details) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const completionCommentId = details?.commentId ?? pipeline.completionCommentId;
      const completionCommentPostedAt = details?.postedAt ?? pipeline.completionCommentPostedAt;
      const completionCommentError = status === "failed" ? details?.error : undefined;
      if (
        pipeline.completionCommentStatus === status
        && pipeline.completionCommentId === completionCommentId
        && pipeline.completionCommentPostedAt === completionCommentPostedAt
        && pipeline.completionCommentError === completionCommentError
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...pipeline,
        completionCommentStatus: status,
        completionCommentId,
        completionCommentPostedAt,
        completionCommentError,
      });
      return { pipelines: newMap };
    }),

  clearCompletionCommentStatus: (pipelineId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (
        pipeline.completionCommentStatus === undefined
        && pipeline.completionCommentError === undefined
        && pipeline.completionCommentId === undefined
        && pipeline.completionCommentPostedAt === undefined
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      const nextPipeline = { ...pipeline };
      delete nextPipeline.completionCommentStatus;
      delete nextPipeline.completionCommentError;
      delete nextPipeline.completionCommentId;
      delete nextPipeline.completionCommentPostedAt;
      newMap.set(pipelineId, nextPipeline);
      return { pipelines: newMap };
    }),

  removePipeline: (pipelineId) =>
    set((state) => {
      if (!state.pipelines.has(pipelineId)) return state;
      const newMap = new Map(state.pipelines);
      newMap.delete(pipelineId);
      const ids = new Set<string>();
      for (const pipeline of newMap.values()) {
        if (pipeline.environmentId) {
          ids.add(pipeline.environmentId);
        }
      }
      return { pipelines: newMap, buildEnvironmentIds: ids };
    }),

  removePipelinesForTask: (taskId) =>
    set((state) => {
      const newMap = new Map(state.pipelines);
      let removed = false;
      for (const [pipelineId, pipeline] of newMap.entries()) {
        if (pipeline.taskId === taskId) {
          newMap.delete(pipelineId);
          removed = true;
        }
      }
      if (!removed) return state;

      const ids = new Set<string>();
      for (const pipeline of newMap.values()) {
        if (pipeline.environmentId) {
          ids.add(pipeline.environmentId);
        }
      }
      return { pipelines: newMap, buildEnvironmentIds: ids };
    }),

  removePipelinesForEnvironment: (environmentId) =>
    set((state) => {
      const pipelines = new Map(state.pipelines);
      let removed = false;
      for (const [pipelineId, pipeline] of pipelines) {
        if (pipeline.environmentId === environmentId) {
          pipelines.delete(pipelineId);
          removed = true;
        }
      }
      if (!removed) return state;
      const buildEnvironmentIds = new Set<string>();
      for (const pipeline of pipelines.values()) {
        if (pipeline.environmentId) buildEnvironmentIds.add(pipeline.environmentId);
      }
      return { pipelines, buildEnvironmentIds };
    }),

  reconcilePipelinesForProject: (projectId, environments, options = {}) =>
    set((state) => {
      const {
        removeMissingActive = true,
        removeUnresolvedCreating = true,
      } = options;
      const snapshots = Array.isArray(environments) ? environments : null;
      const environmentIds = snapshots
        ? new Set(snapshots.map((environment) => environment.id))
        : environments as ReadonlySet<string>;
      const environmentByPipelineId = new Map<string, string>();
      for (const environment of snapshots ?? []) {
        if (environment.buildPipelineId) {
          environmentByPipelineId.set(environment.buildPipelineId, environment.id);
        }
      }
      const pipelines = new Map(state.pipelines);
      let changed = false;
      for (const [pipelineId, pipeline] of pipelines) {
        if (pipeline.projectId !== projectId) continue;

        if (!pipeline.environmentId && snapshots) {
          const recoveredEnvironmentId = environmentByPipelineId.get(pipelineId);
          if (recoveredEnvironmentId) {
            pipelines.set(pipelineId, { ...pipeline, environmentId: recoveredEnvironmentId });
            changed = true;
          } else if (
            removeUnresolvedCreating
            && pipeline.phase === "creating-environment"
          ) {
            // An authoritative environment snapshot without the durable
            // association means creation did not complete. Clear the local
            // reservation so the source issue can start another build.
            pipelines.delete(pipelineId);
            changed = true;
          }
          continue;
        }

        if (
          removeMissingActive
          &&
          pipeline.environmentId
          && !environmentIds.has(pipeline.environmentId)
          && pipeline.phase !== "complete"
          && pipeline.phase !== "failed"
        ) {
          pipelines.delete(pipelineId);
          changed = true;
        }
      }
      if (!changed) return state;
      const buildEnvironmentIds = new Set<string>();
      for (const pipeline of pipelines.values()) {
        if (pipeline.environmentId) buildEnvironmentIds.add(pipeline.environmentId);
      }
      return { pipelines, buildEnvironmentIds };
    }),

  getPipelineByTaskId: (taskId) => {
    for (const pipeline of get().pipelines.values()) {
      if (pipeline.taskId === taskId) return pipeline;
    }
    return undefined;
  },

  getPipelineForGitHubIssue: (repositoryOwner, repositoryName, issueNumber, activeOnly = false) => {
    const normalizedOwner = repositoryOwner.toLowerCase();
    const normalizedName = repositoryName.toLowerCase();
    let latest: BuildPipeline | undefined;
    for (const pipeline of get().pipelines.values()) {
      const source = pipeline.source;
      if (
        source?.type !== "github"
        || source.repositoryOwner.toLowerCase() !== normalizedOwner
        || source.repositoryName.toLowerCase() !== normalizedName
        || source.issueNumber !== issueNumber
        || (activeOnly && (pipeline.phase === "complete" || pipeline.phase === "failed"))
      ) {
        continue;
      }
      if (!latest || pipeline.createdAt > latest.createdAt) latest = pipeline;
    }
    return latest;
  },

  getPipelineById: (id) => get().pipelines.get(id),

  getActivePipelineForEnvironment: (environmentId) => {
    for (const pipeline of get().pipelines.values()) {
      if (pipeline.environmentId === environmentId && pipeline.phase !== "complete" && pipeline.phase !== "failed") {
        return pipeline;
      }
    }
    return undefined;
  },

  isBuildEnvironment: (environmentId) => get().buildEnvironmentIds.has(environmentId),

  _rebuildBuildEnvironmentIds: () => {
    const ids = new Set<string>();
    for (const pipeline of get().pipelines.values()) {
      if (pipeline.environmentId) {
        ids.add(pipeline.environmentId);
      }
    }
    return ids;
  },

  replacePipeline: (pipeline) =>
    set((state) => {
      const newMap = new Map(state.pipelines);
      newMap.set(pipeline.id, pipeline);
      const ids = new Set<string>();
      for (const candidate of newMap.values()) {
        if (candidate.environmentId) ids.add(candidate.environmentId);
      }
      return { pipelines: newMap, buildEnvironmentIds: ids };
    }),

  setBackendRevision: (pipelineId, revision) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      // Never move the revision backwards: a slow write landing after a faster
      // one would otherwise re-arm a compare-and-swap against a stale value and
      // lose the newer transition on the next save.
      if (!pipeline || pipeline.backendRevision >= revision) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, backendRevision: revision });
      return { pipelines: newMap };
    }),
}));
