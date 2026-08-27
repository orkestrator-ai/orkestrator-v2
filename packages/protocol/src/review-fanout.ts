/**
 * The reviewer fan-out shared by standalone Multi Review and the build
 * pipeline's multi-model review stage.
 *
 * Both surfaces run the same shape of work: N independent reviewers each
 * answering the structured-review contract against one pinned worktree state,
 * then a single consolidation turn that merges their reports into one. Only
 * what happens *after* consolidation differs — Multi Review offers the report
 * to a fix session the user drives, while the pipeline hands it to its own
 * address stage — so everything up to and including the consolidated report
 * lives here rather than in either owner.
 *
 * The records are deliberately storage-shaped: a reviewer's dispatch state,
 * schema-repair budget and stall clock all have to survive a backend restart,
 * because the turn they describe keeps running inside the environment whether
 * or not this process is alive to watch it.
 */
import { isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";
import { isStructuredReviewReport, type StructuredReviewReport } from "./structured-review.js";

export const REVIEW_FANOUT_MIN_REVIEWERS = 1;
export const REVIEW_FANOUT_MAX_REVIEWERS = 32;
export const REVIEW_FANOUT_MAX_SNAPSHOT_PATHS = 10_000;
/** Bounds the durable correction budget for a rejected structured report. */
export const REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS = 3;
/** Bounds how long a settled session may be polled for a missing result. */
export const REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS = 5;

export interface ReviewerModelSelection {
  agent: AgentPlatform;
  model: string;
  reasoningEffort?: string;
}

export type ReviewerStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** How far a prompt got before the process could have died mid-flight. */
export type ReviewDispatchState = "prepared" | "dispatching" | "sent";

export interface ReviewerRecord extends ReviewerModelSelection {
  id: string;
  status: ReviewerStatus;
  sessionKey?: string;
  providerSessionId?: string;
  requestId?: string;
  dispatchState?: ReviewDispatchState;
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

/** Durable identity shared by every reviewer and the consolidation turn. */
export interface ReviewWorktreeSnapshotRecord {
  status: "clean" | "dirty";
  head: string;
  paths: string[];
  fingerprint: string;
  capturedAt: string;
}

/**
 * The consolidation turn, when it owns a session of its own.
 *
 * Multi Review runs consolidation as the first request on its fix session, so
 * it keeps its own `activeRequest` instead. The build pipeline has no such
 * session to reuse, so it records one here.
 */
export interface ReviewConsolidationSession {
  sessionKey: string;
  providerSessionId: string;
  requestId: string;
  state: ReviewDispatchState;
  createdAt: string;
  agent: AgentPlatform;
  model?: string;
  reasoningEffort?: string;
  schemaRepairAttempts?: number;
  schemaRepairPrompt?: string;
  idleResultPolls?: number;
  progressAt?: string;
  progressDigest?: string;
  stalledSince?: string;
}

/** Everything a fan-out owner persists between supervisor ticks. */
export interface ReviewFanoutState {
  reviewers: ReviewerRecord[];
  snapshot?: ReviewWorktreeSnapshotRecord;
  /** Set when the worktree changed before all reports could be consolidated. */
  snapshotStale?: boolean;
  consolidation?: ReviewConsolidationSession;
  /** The merged report. Present once consolidation has been certified. */
  report?: StructuredReviewReport;
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

function optionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function optionalDate(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function optionalPollCount(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS)
  );
}

function optionalProgressDigest(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

function optionalRepairAttempts(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS)
  );
}

/** Field-level check, for records that carry a selection plus their own keys. */
export function isReviewerModelSelectionFields(value: Record<string, unknown>): boolean {
  if (!isAgentPlatform(value.agent) || !nonBlank(value.model)) return false;
  return value.reasoningEffort === undefined || nonBlank(value.reasoningEffort, 128);
}

export function isReviewerModelSelection(value: unknown): value is ReviewerModelSelection {
  if (!record(value) || !hasOnlyKeys(value, ["agent", "model", "reasoningEffort"])) return false;
  return isReviewerModelSelectionFields(value);
}

const REVIEWER_STATUSES = new Set<ReviewerStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const REVIEWER_KEYS = [
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
] as const;

function isDispatchState(value: unknown): boolean {
  return value === "prepared" || value === "dispatching" || value === "sent";
}

export function isReviewerRecord(value: unknown): value is ReviewerRecord {
  return (
    record(value) &&
    hasOnlyKeys(value, REVIEWER_KEYS) &&
    isReviewerModelSelectionFields(value) &&
    nonBlank(value.id) &&
    REVIEWER_STATUSES.has(value.status as ReviewerStatus) &&
    (value.sessionKey === undefined || nonBlank(value.sessionKey)) &&
    (value.providerSessionId === undefined || nonBlank(value.providerSessionId)) &&
    (value.requestId === undefined || nonBlank(value.requestId)) &&
    (value.dispatchState === undefined || isDispatchState(value.dispatchState)) &&
    optionalRepairAttempts(value.schemaRepairAttempts) &&
    optionalString(value.schemaRepairPrompt, 100_000) &&
    optionalPollCount(value.idleResultPolls) &&
    optionalString(value.error, 4_096) &&
    optionalDate(value.progressAt) &&
    optionalProgressDigest(value.progressDigest) &&
    optionalDate(value.stalledSince) &&
    optionalDate(value.startedAt) &&
    optionalDate(value.completedAt) &&
    (value.report === undefined || isStructuredReviewReport(value.report))
  );
}

/**
 * A reviewer list that could actually be consolidated.
 *
 * Duplicate ids would make two reviewers indistinguishable in the provenance
 * the consolidated report carries, and a `completed` reviewer without a report
 * would be counted as a usable input that has nothing in it.
 */
export function isReviewerRecordList(value: unknown): value is ReviewerRecord[] {
  if (
    !Array.isArray(value) ||
    value.length < REVIEW_FANOUT_MIN_REVIEWERS ||
    value.length > REVIEW_FANOUT_MAX_REVIEWERS ||
    !value.every(isReviewerRecord)
  ) {
    return false;
  }
  if (new Set(value.map((entry) => entry.id)).size !== value.length) return false;
  return !value.some((entry) => entry.status === "completed" && entry.report === undefined);
}

export function isReviewWorktreeSnapshotRecord(
  value: unknown,
): value is ReviewWorktreeSnapshotRecord {
  return (
    record(value) &&
    hasOnlyKeys(value, ["status", "head", "paths", "fingerprint", "capturedAt"]) &&
    (value.status === "clean" || value.status === "dirty") &&
    typeof value.head === "string" &&
    /^[0-9a-f]{40,64}$/i.test(value.head) &&
    Array.isArray(value.paths) &&
    value.paths.length <= REVIEW_FANOUT_MAX_SNAPSHOT_PATHS &&
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

export function isReviewConsolidationSession(value: unknown): value is ReviewConsolidationSession {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "sessionKey",
      "providerSessionId",
      "requestId",
      "state",
      "createdAt",
      "agent",
      "model",
      "reasoningEffort",
      "schemaRepairAttempts",
      "schemaRepairPrompt",
      "idleResultPolls",
      "progressAt",
      "progressDigest",
      "stalledSince",
    ]) &&
    nonBlank(value.sessionKey) &&
    nonBlank(value.providerSessionId) &&
    nonBlank(value.requestId) &&
    isDispatchState(value.state) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    isAgentPlatform(value.agent) &&
    (value.model === undefined || nonBlank(value.model)) &&
    (value.reasoningEffort === undefined || nonBlank(value.reasoningEffort, 128)) &&
    optionalRepairAttempts(value.schemaRepairAttempts) &&
    optionalString(value.schemaRepairPrompt, 100_000) &&
    optionalPollCount(value.idleResultPolls) &&
    optionalDate(value.progressAt) &&
    optionalProgressDigest(value.progressDigest) &&
    optionalDate(value.stalledSince)
  );
}

export function isReviewFanoutState(value: unknown): value is ReviewFanoutState {
  return (
    record(value) &&
    hasOnlyKeys(value, ["reviewers", "snapshot", "snapshotStale", "consolidation", "report"]) &&
    isReviewerRecordList(value.reviewers) &&
    (value.snapshot === undefined || isReviewWorktreeSnapshotRecord(value.snapshot)) &&
    (value.snapshotStale === undefined || typeof value.snapshotStale === "boolean") &&
    (value.consolidation === undefined || isReviewConsolidationSession(value.consolidation)) &&
    (value.report === undefined || isStructuredReviewReport(value.report))
  );
}

/** True once no reviewer can still produce a report. */
export function reviewersSettled(reviewers: readonly ReviewerRecord[]): boolean {
  return !reviewers.some(
    (reviewer) => reviewer.status === "pending" || reviewer.status === "running",
  );
}

/** The reviewers whose reports are usable inputs to consolidation. */
export function usableReviewerReports(reviewers: readonly ReviewerRecord[]): ReviewerRecord[] {
  return reviewers.filter(
    (reviewer) => reviewer.status === "completed" && reviewer.report !== undefined,
  );
}
