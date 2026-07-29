import type { StructuredReviewReport } from "./structured-review.js";

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
  /** Stable structured-output key for review and verification turns. */
  structuredRequestId?: string;
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
  createdAt: string;
  taskTitle: string;
  taskSnapshot: TaskSnapshot;
  source?: BuildPipelineSource;
  /** Optional feature-plan association maintained by the backend supervisor. */
  featurePlanId?: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
    && typeof value.startedAt === "string"
    && typeof value.label === "string"
    && (value.messages === undefined || Array.isArray(value.messages));
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
    || !isNonNegativeInteger(value.backendRevision)
    || typeof value.createdAt !== "string"
    || typeof value.taskTitle !== "string"
    || !isTaskSnapshot(value.taskSnapshot)
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
      && value.issueIdentifier.length > 0;
  }
  return value.type === "github"
    && typeof value.repositoryOwner === "string"
    && value.repositoryOwner.length > 0
    && typeof value.repositoryName === "string"
    && value.repositoryName.length > 0
    && Number.isSafeInteger(value.issueNumber)
    && (value.issueNumber as number) > 0
    && typeof value.issueUrl === "string"
    && typeof value.status === "string";
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
        && (value.maxIterations as number) <= 10
      ));
}
