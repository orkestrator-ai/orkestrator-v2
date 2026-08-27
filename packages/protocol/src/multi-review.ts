import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import { isStructuredReviewReport, type StructuredReviewReport } from "./structured-review.js";
import { getReviewInstructionValidationError } from "./review-prompt.js";
import { isSafeLoopedReviewTargetBranch } from "./review-workflow.js";

export const MULTI_REVIEW_WORKFLOW_VERSION = 1 as const;
export const MULTI_REVIEW_MIN_REVIEWERS = 1;
export const MULTI_REVIEW_MAX_REVIEWERS = 32;
export const MULTI_REVIEW_MAX_SNAPSHOT_PATHS = 10_000;
export const MULTI_REVIEW_ADDRESS_PROMPT =
  "Please address all the issues and coverage gaps. Do not go into plan mode. Please implement the fixes.";
/** Stable pane label for current Multi Review fix tabs. */
export const MULTI_REVIEW_FIX_TAB_TITLE = "Fix";
/** Former pane title retained for restored layouts and backend session metadata. */
export const MULTI_REVIEW_LEGACY_FIX_TAB_TITLE = "Multi Review · Fix";

export interface MultiReviewModelSelection {
  agent: AgentPlatform;
  model: string;
  reasoningEffort?: string;
}

export type MultiReviewReviewerStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface MultiReviewReviewer extends MultiReviewModelSelection {
  id: string;
  status: MultiReviewReviewerStatus;
  sessionKey?: string;
  providerSessionId?: string;
  requestId?: string;
  dispatchState?: "prepared" | "dispatching" | "sent";
  /** Durable correction turn for a rejected structured report. */
  schemaRepairAttempts?: number;
  schemaRepairPrompt?: string;
  idleResultPolls?: number;
  /** Last time the supervisor observed this reviewer's transcript change. */
  progressAt?: string;
  /**
   * SHA-256 of the last progress probe. Survives a backend restart so the next
   * probe can compare against known state instead of inventing a new baseline.
   */
  progressDigest?: string;
  /** Set once the reviewer has produced no transcript activity for too long. */
  stalledSince?: string;
  report?: StructuredReviewReport;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Authoritative read model for one reviewer's provider transcript. */
export interface MultiReviewReviewerTranscript {
  workflowId: string;
  reviewerId: string;
  agent: AgentPlatform;
  model: string;
  reasoningEffort?: string;
  status: MultiReviewReviewerStatus;
  messages: unknown[];
  report?: StructuredReviewReport;
  error?: string;
  progressAt?: string;
  stalledSince?: string;
  startedAt?: string;
  completedAt?: string;
}

export type MultiReviewPhase =
  | "reviewing"
  | "consolidating"
  | "ready"
  | "fixing"
  | "interactive"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

export interface MultiReviewFixSession extends MultiReviewModelSelection {
  sessionKey: string;
  providerSessionId: string;
  requestIds: string[];
  status: "running" | "idle" | "failed" | "cancelled";
  startedAt: string;
  /** Last time the supervisor observed this session's transcript change. */
  progressAt?: string;
  /**
   * SHA-256 of the last progress probe. Survives a backend restart so the next
   * probe can compare against known state instead of inventing a new baseline.
   */
  progressDigest?: string;
  /** Set once the session has produced no transcript activity for too long. */
  stalledSince?: string;
  completedAt?: string;
  error?: string;
}

/** Durable identity shared by every reviewer and the consolidation turn. */
export interface MultiReviewWorktreeSnapshot {
  status: "clean" | "dirty";
  head: string;
  paths: string[];
  fingerprint: string;
  capturedAt: string;
}

export interface MultiReviewWorkflow {
  version: typeof MULTI_REVIEW_WORKFLOW_VERSION;
  controller: "backend";
  /** Backend-only storage lease fence. Renderer responses omit it. */
  controllerFence?: string;
  id: string;
  environmentId: string;
  projectId: string;
  targetBranch: string;
  reviewInstruction?: string;
  reviewers: MultiReviewReviewer[];
  fixModel: MultiReviewModelSelection;
  fixSession?: MultiReviewFixSession;
  reviewWorktreeSnapshot?: MultiReviewWorktreeSnapshot;
  /** Set when the worktree changed before all reports could be consolidated. */
  reviewSnapshotStale?: boolean;
  phase: MultiReviewPhase;
  consolidatedReport?: StructuredReviewReport;
  fixResult?: {
    complete: boolean;
    summary: string;
    filesChanged: string[];
    commandsRun: Array<{ command: string; result: "passed" | "failed"; summary: string }>;
    notes: string[];
    limitations: string[];
  };
  /** The interactive address prompt still needs durable backend dispatch. */
  addressPromptPending?: boolean;
  /** Persisted failed delivery attempts so backend restarts cannot reset the retry budget. */
  addressPromptAttempts?: number;
  activeRequest?: {
    kind: "consolidate" | "fix";
    requestId: string;
    state: "prepared" | "dispatching" | "sent";
    createdAt: string;
    /** Durable correction turn for a rejected consolidated report. */
    schemaRepairAttempts?: number;
    schemaRepairPrompt?: string;
    idleResultPolls?: number;
  };
  cancellingSince?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  backendRevision: number;
}

export interface StartMultiReviewInput {
  environmentId: string;
  projectId: string;
  targetBranch: string;
  reviewInstruction?: string;
  reviewers: MultiReviewModelSelection[];
  fixModel: MultiReviewModelSelection;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonBlank(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function isMultiReviewModelSelection(value: unknown): value is MultiReviewModelSelection {
  if (!record(value) || !hasOnlyKeys(value, ["agent", "model", "reasoningEffort"])) return false;
  return isMultiReviewModelSelectionFields(value);
}

function isMultiReviewModelSelectionFields(value: Record<string, unknown>): boolean {
  if (!isAgentPlatform(value.agent) || !nonBlank(value.model)) return false;
  return value.reasoningEffort === undefined || nonBlank(value.reasoningEffort, 128);
}

export function isStartMultiReviewInput(value: unknown): value is StartMultiReviewInput {
  if (
    !record(value) ||
    !hasOnlyKeys(value, [
      "environmentId",
      "projectId",
      "targetBranch",
      "reviewInstruction",
      "reviewers",
      "fixModel",
    ]) ||
    !nonBlank(value.environmentId) ||
    !nonBlank(value.projectId) ||
    !isSafeLoopedReviewTargetBranch(value.targetBranch) ||
    getReviewInstructionValidationError(value.reviewInstruction) !== null ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length < MULTI_REVIEW_MIN_REVIEWERS ||
    value.reviewers.length > MULTI_REVIEW_MAX_REVIEWERS ||
    !value.reviewers.every(isMultiReviewModelSelection) ||
    !isMultiReviewModelSelection(value.fixModel)
  ) {
    return false;
  }
  return true;
}

const PHASES = new Set<MultiReviewPhase>([
  "reviewing",
  "consolidating",
  "ready",
  "fixing",
  "interactive",
  "completed",
  "cancelling",
  "cancelled",
  "failed",
]);
const REVIEWER_STATUSES = new Set<MultiReviewReviewerStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

function optionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function optionalDate(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function isMultiReviewWorktreeSnapshot(value: unknown): value is MultiReviewWorktreeSnapshot {
  return (
    record(value) &&
    hasOnlyKeys(value, ["status", "head", "paths", "fingerprint", "capturedAt"]) &&
    (value.status === "clean" || value.status === "dirty") &&
    typeof value.head === "string" &&
    /^[0-9a-f]{40,64}$/i.test(value.head) &&
    Array.isArray(value.paths) &&
    value.paths.length <= MULTI_REVIEW_MAX_SNAPSHOT_PATHS &&
    value.paths.every(
      (entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4_096,
    ) &&
    (value.status === "clean" ? value.paths.length === 0 : value.paths.length > 0) &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/i.test(value.fingerprint) &&
    // `Date.parse` coerces, so the string check cannot be left to the cast:
    // a numeric 0 stringifies to "0" and parses as a valid date.
    typeof value.capturedAt === "string" &&
    Number.isFinite(Date.parse(value.capturedAt))
  );
}

function optionalPollCount(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 5)
  );
}

function optionalProgressDigest(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function optionalRepairAttempts(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 3)
  );
}

function isFixSession(value: unknown): boolean {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "agent",
      "model",
      "reasoningEffort",
      "sessionKey",
      "providerSessionId",
      "requestIds",
      "status",
      "startedAt",
      "progressAt",
      "progressDigest",
      "stalledSince",
      "completedAt",
      "error",
    ]) &&
    isMultiReviewModelSelectionFields(value) &&
    nonBlank(value.sessionKey) &&
    nonBlank(value.providerSessionId) &&
    Array.isArray(value.requestIds) &&
    value.requestIds.length <= 256 &&
    value.requestIds.every((requestId) => nonBlank(requestId)) &&
    ["running", "idle", "failed", "cancelled"].includes(value.status as string) &&
    optionalDate(value.startedAt) &&
    typeof value.startedAt === "string" &&
    optionalDate(value.progressAt) &&
    optionalProgressDigest(value.progressDigest) &&
    optionalDate(value.stalledSince) &&
    optionalDate(value.completedAt) &&
    optionalString(value.error, 4_096)
  );
}

function isActiveRequest(
  value: unknown,
): value is NonNullable<MultiReviewWorkflow["activeRequest"]> {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "kind",
      "requestId",
      "state",
      "createdAt",
      "schemaRepairAttempts",
      "schemaRepairPrompt",
      "idleResultPolls",
    ]) &&
    (value.kind === "consolidate" || value.kind === "fix") &&
    nonBlank(value.requestId) &&
    (value.state === "prepared" || value.state === "dispatching" || value.state === "sent") &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    optionalRepairAttempts(value.schemaRepairAttempts) &&
    optionalString(value.schemaRepairPrompt, 100_000) &&
    optionalPollCount(value.idleResultPolls)
  );
}

function isFixResult(value: unknown): boolean {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "complete",
      "summary",
      "filesChanged",
      "commandsRun",
      "notes",
      "limitations",
    ]) &&
    typeof value.complete === "boolean" &&
    nonBlank(value.summary, 100_000) &&
    Array.isArray(value.filesChanged) &&
    value.filesChanged.length <= 512 &&
    value.filesChanged.every((entry) => nonBlank(entry, 4_096)) &&
    Array.isArray(value.commandsRun) &&
    value.commandsRun.length <= 512 &&
    value.commandsRun.every(
      (entry) =>
        record(entry) &&
        hasOnlyKeys(entry, ["command", "result", "summary"]) &&
        nonBlank(entry.command, 16_384) &&
        (entry.result === "passed" || entry.result === "failed") &&
        typeof entry.summary === "string" &&
        entry.summary.length <= 100_000,
    ) &&
    Array.isArray(value.notes) &&
    value.notes.length <= 512 &&
    value.notes.every((entry) => typeof entry === "string" && entry.length <= 100_000) &&
    Array.isArray(value.limitations) &&
    value.limitations.length <= 512 &&
    value.limitations.every((entry) => typeof entry === "string" && entry.length <= 100_000)
  );
}

export function isMultiReviewWorkflow(value: unknown): value is MultiReviewWorkflow {
  if (
    !record(value) ||
    !hasOnlyKeys(value, [
      "version",
      "controller",
      "controllerFence",
      "id",
      "environmentId",
      "projectId",
      "targetBranch",
      "reviewInstruction",
      "reviewers",
      "fixModel",
      "fixSession",
      "phase",
      "reviewWorktreeSnapshot",
      "reviewSnapshotStale",
      "consolidatedReport",
      "fixResult",
      "addressPromptPending",
      "addressPromptAttempts",
      "activeRequest",
      "cancellingSince",
      "error",
      "createdAt",
      "updatedAt",
      "backendRevision",
    ]) ||
    value.version !== MULTI_REVIEW_WORKFLOW_VERSION ||
    value.controller !== "backend" ||
    !nonBlank(value.id) ||
    !nonBlank(value.environmentId) ||
    !nonBlank(value.projectId) ||
    !isSafeLoopedReviewTargetBranch(value.targetBranch) ||
    getReviewInstructionValidationError(value.reviewInstruction) !== null ||
    !PHASES.has(value.phase as MultiReviewPhase) ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length < MULTI_REVIEW_MIN_REVIEWERS ||
    value.reviewers.length > MULTI_REVIEW_MAX_REVIEWERS ||
    !record(value.fixModel) ||
    !isMultiReviewModelSelection(value.fixModel) ||
    !Number.isFinite(Date.parse(value.createdAt as string)) ||
    !Number.isFinite(Date.parse(value.updatedAt as string)) ||
    !Number.isSafeInteger(value.backendRevision) ||
    (value.backendRevision as number) < 0 ||
    (value.controllerFence !== undefined && !nonBlank(value.controllerFence)) ||
    (value.fixSession !== undefined && !isFixSession(value.fixSession)) ||
    (value.reviewWorktreeSnapshot !== undefined &&
      !isMultiReviewWorktreeSnapshot(value.reviewWorktreeSnapshot)) ||
    (value.reviewSnapshotStale !== undefined && typeof value.reviewSnapshotStale !== "boolean") ||
    (value.activeRequest !== undefined && !isActiveRequest(value.activeRequest)) ||
    !optionalDate(value.cancellingSince) ||
    (value.fixResult !== undefined && !isFixResult(value.fixResult)) ||
    (value.addressPromptPending !== undefined && typeof value.addressPromptPending !== "boolean") ||
    (value.addressPromptAttempts !== undefined &&
      (!Number.isSafeInteger(value.addressPromptAttempts) ||
        (value.addressPromptAttempts as number) < 0)) ||
    !optionalString(value.error, 4_096) ||
    (value.consolidatedReport !== undefined && !isStructuredReviewReport(value.consolidatedReport))
  ) {
    return false;
  }
  if (
    !value.reviewers.every(
      (entry) =>
        record(entry) &&
        hasOnlyKeys(entry, [
          "agent",
          "model",
          "reasoningEffort",
          "id",
          "status",
          "sessionKey",
          "providerSessionId",
          "requestId",
          "dispatchState",
          "idleResultPolls",
          "report",
          "schemaRepairAttempts",
          "schemaRepairPrompt",
          "error",
          "progressAt",
          "progressDigest",
          "stalledSince",
          "startedAt",
          "completedAt",
        ]) &&
        isMultiReviewModelSelectionFields(entry) &&
        nonBlank(entry.id) &&
        REVIEWER_STATUSES.has(entry.status as MultiReviewReviewerStatus) &&
        (entry.sessionKey === undefined || nonBlank(entry.sessionKey)) &&
        (entry.providerSessionId === undefined || nonBlank(entry.providerSessionId)) &&
        (entry.requestId === undefined || nonBlank(entry.requestId)) &&
        (entry.dispatchState === undefined ||
          ["prepared", "dispatching", "sent"].includes(entry.dispatchState as string)) &&
        optionalRepairAttempts(entry.schemaRepairAttempts) &&
        optionalString(entry.schemaRepairPrompt, 100_000) &&
        optionalPollCount(entry.idleResultPolls) &&
        optionalString(entry.error, 4_096) &&
        optionalDate(entry.progressAt) &&
        optionalProgressDigest(entry.progressDigest) &&
        optionalDate(entry.stalledSince) &&
        optionalDate(entry.startedAt) &&
        optionalDate(entry.completedAt) &&
        (entry.report === undefined || isStructuredReviewReport(entry.report)),
    )
  ) {
    return false;
  }
  if (new Set(value.reviewers.map((entry) => entry.id)).size !== value.reviewers.length)
    return false;
  if (
    value.reviewers.some(
      (entry) => entry.status === "completed" && !isStructuredReviewReport(entry.report),
    )
  )
    return false;
  if (
    (value.phase === "ready" ||
      value.phase === "fixing" ||
      value.phase === "interactive" ||
      value.phase === "completed") &&
    (!isStructuredReviewReport(value.consolidatedReport) || !isFixSession(value.fixSession))
  ) {
    return false;
  }
  if (value.phase === "fixing") {
    const activeRequest = value.activeRequest;
    if (!isActiveRequest(activeRequest) || activeRequest.kind !== "fix") return false;
  }
  if (value.addressPromptPending === true && value.phase !== "interactive") return false;
  if (value.addressPromptAttempts !== undefined && value.addressPromptPending !== true)
    return false;
  if ((value.phase === "cancelling") !== (typeof value.cancellingSince === "string")) return false;
  return true;
}

export function isMultiReviewTerminalPhase(phase: MultiReviewPhase): boolean {
  return phase === "interactive" || phase === "completed" || phase === "cancelled";
}
