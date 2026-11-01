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
import {
  STRUCTURED_REVIEW_MAX_TEXT_BYTES,
  isStructuredReviewReport,
  safeParseStructuredReviewFindings,
  utf8Bytes,
  type ReviewIssue,
  type StructuredReviewReport,
} from "./structured-review.js";
import { isReviewLens, type ReviewLens } from "./review-lens.js";
import { isWorkflowResultSubmissionState } from "./workflow-results.js";
import { isWorkspaceGitBaseline, type WorkspaceGitBaseline } from "./workspace-guard.js";
import {
  isNativeAgentModelSubstitution,
  READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS,
  type NativeAgentModelSubstitution,
} from "./native-agent.js";

export const REVIEW_FANOUT_MIN_REVIEWERS = 1;
export const REVIEW_FANOUT_MAX_REVIEWERS = 32;
export const REVIEW_FANOUT_MAX_SNAPSHOT_PATHS = 10_000;
/** Bounds the durable correction budget for a rejected structured report. */
export const REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS = 3;
/** Bounds how long a settled session may be polled for a missing result. */
export const REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS = 5;
export const REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS = 12;

export interface ReviewerModelSelection {
  agent: AgentPlatform;
  model: string;
  reasoningEffort?: string;
  /** Fast/Normal choice pinned when this durable reviewer was admitted. */
  fastMode?: boolean;
  /**
   * This reviewer's focus (`review-lens.ts`). The launcher copies the text, so
   * the record keeps what the reviewer ran with. Only reviewer rows carry one:
   * the guards for preparation, consolidation and fix selections refuse it.
   */
  lens?: ReviewLens;
}

export type ReviewerStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** How far a prompt got before the process could have died mid-flight. */
export type ReviewDispatchState = "prepared" | "dispatching" | "sent";

/**
 * Findings one reviewer may report through `report_finding` while it runs.
 * Later calls are refused, so the first ones reported are the ones kept.
 */
export const REVIEW_PROVISIONAL_FINDINGS_MAX = 50;
/**
 * Encoded bytes of one provisional finding: one prose field's budget, so a
 * reviewer's provisional findings together stay inside one report's budget.
 */
export const REVIEW_PROVISIONAL_FINDING_MAX_BYTES = STRUCTURED_REVIEW_MAX_TEXT_BYTES;

/**
 * A finding a running reviewer reported before its report was accepted.
 *
 * It is progress, not a result: the user sees it marked provisional, it never
 * reaches consolidation, and the accepted report replaces all of them.
 */
export interface ReviewerProvisionalFinding {
  /** Digest of the finding, so a retried call cannot add it twice. */
  id: string;
  reportedAt: string;
  issue: ReviewIssue;
}

/**
 * Where a pending reviewer stands in the admission queue: `queued` while it
 * waits for an admission slot, `admitting` while its session is created and
 * its prompt sent.
 */
export type ReviewerAdmissionState = "queued" | "admitting";

export interface ReviewerRecord extends ReviewerModelSelection {
  id: string;
  status: ReviewerStatus;
  /**
   * The owner pinned no model, and `model` is a display placeholder.
   *
   * A record has to name a model — provenance, the session label and the tab
   * all read it — but "no selection" is a real state for an owner whose
   * reviewers come from step configuration rather than from a launcher's model
   * picker. It cannot be inferred from the placeholder itself: `"default"` is
   * a genuine Claude catalog id, so a Claude reviewer that pinned nothing and
   * one that pinned `default` collapse onto the same string. Dispatch reads
   * this rather than the string, so an unpinned reviewer sends no model and
   * gets the harness default, exactly as a single-reviewer review step does.
   */
  modelUnpinned?: boolean;
  /**
   * Set when `model` replaced a configured default the runtime reported it
   * cannot serve, so the reviewer's row can say so.
   */
  modelSubstitution?: NativeAgentModelSubstitution;
  /**
   * The scheduler's view of a `pending` reviewer during a review pass. It is
   * an observation, staged and written with the pass's other observations,
   * and absent once the reviewer leaves `pending`.
   */
  admissionState?: ReviewerAdmissionState;
  /**
   * One-based place among the queued reviewers, in the order the scheduler
   * will start them. Set only while {@link admissionState} is `queued`.
   */
  queuePosition?: number;
  sessionKey?: string;
  providerSessionId?: string;
  requestId?: string;
  dispatchState?: ReviewDispatchState;
  resultTransport?: import("./workflow-results.js").WorkflowResultTransport;
  /** Bounded backend-projected delivery state for the tool-mode result slot. */
  resultSubmission?: import("./workflow-results.js").WorkflowResultSubmissionState;
  /** Durable correction turn for a rejected structured report. */
  schemaRepairAttempts?: number;
  schemaRepairPrompt?: string;
  /**
   * Continuation turn sent in the same session: user-requested after aborting a
   * wedged reviewer, or the automatic result reminder.
   */
  continuationPrompt?: string;
  /**
   * The one automatic reminder to call the result tool was already spent. It
   * survives a restart so a reviewer that ignores it fails instead of looping.
   */
  resultReminderSent?: boolean;
  /**
   * The one automatic continuation after a provider restart cut the turn short
   * was already spent. Durable for the same reason as `resultReminderSent`: a
   * second restart fails the reviewer instead of looping.
   */
  restartContinuationSent?: boolean;
  /** Times this turn was resent after the weekly limit stopped it. */
  usageLimitResends?: number;
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
  /**
   * The reviewer failed before its first agent turn was accepted: its bridge, CLI or
   * provider could not be started on this host, so `error` is why the agent
   * could not start rather than anything it reviewed. Its panel says so, and
   * the review carries on with the reviewers that did start. Read it only on
   * a `failed` reviewer.
   */
  startFailed?: boolean;
  /** Whether this session has accepted an agent turn (allocation alone is insufficient). */
  agentStarted?: boolean;
  /**
   * Findings reported through `report_finding` while the reviewer runs, oldest
   * first. Dropped when its report is accepted; kept, unconfirmed, when it
   * fails or is stopped.
   */
  provisionalFindings?: ReviewerProvisionalFinding[];
  /** Cumulative tokens consumed by this reviewer's provider session. */
  tokenCount?: number;
  /**
   * Prompt-cache read tokens the provider reported for this reviewer's
   * session, a count only. Claude, Codex and OpenCode report a session total;
   * Pi and Cursor report their latest turn, so this is the largest value seen.
   * It is what measures whether a panel's shared prompt prefix is cached.
   */
  cacheReadTokens?: number;
  /** Bounded terminal polls while a provider reconciles its exact cumulative total. */
  usageFinalizationPolls?: number;
  /**
   * Why this reviewer's read-only turn ran its commands without the provider's
   * command sandbox, as its provider reported it: the sandbox
   * cannot run where the reviewer runs, so the read-only command filter was
   * the whole boundary. The reviewer's card says so.
   */
  commandSandboxOff?: string;
  startedAt?: string;
  turnStartedAt?: string;
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
  /** One durable continuation after a provider restart cut the turn short. */
  restartContinuationSent?: boolean;
  /** Times this turn was resent after the weekly limit stopped it. */
  usageLimitResends?: number;
  /** The one durable reminder to submit a missing tool-mode report was spent. */
  resultReminderSent?: boolean;
  continuationPrompt?: string;
  sessionKey: string;
  providerSessionId: string;
  requestId: string;
  state: ReviewDispatchState;
  createdAt: string;
  agent: AgentPlatform;
  model?: string;
  /** Set when `model` replaced a configured default the runtime cannot serve. */
  modelSubstitution?: NativeAgentModelSubstitution;
  reasoningEffort?: string;
  fastMode?: boolean;
  resultTransport?: import("./workflow-results.js").WorkflowResultTransport;
  /** Bounded backend-projected delivery state for the tool-mode result slot. */
  resultSubmission?: import("./workflow-results.js").WorkflowResultSubmissionState;
  schemaRepairAttempts?: number;
  schemaRepairPrompt?: string;
  idleResultPolls?: number;
  progressAt?: string;
  progressDigest?: string;
  stalledSince?: string;
}

/**
 * How much a panel's reviewers overlapped, from the source IDs a certified
 * consolidated report cited. IDs are resolved to counts here and nothing else
 * is kept: no finding text, file, model or reviewer ID.
 *
 * The certified report keeps model labels but not source IDs, so these counts
 * are computed when consolidation is accepted and stored beside the report.
 */
export interface ReviewPanelOverlapV1 {
  version: 1;
  /** Reviewers whose reports were consolidated. */
  reviewers: number;
  /** Issues and coverage gaps the reviewers reported. */
  sourceFindings: number;
  /** Source findings at least one consolidated finding cited. The rest were dropped. */
  citedSourceFindings: number;
  /** Issues and coverage gaps in the consolidated report. */
  consolidatedFindings: number;
  /** Consolidated findings that only one reviewer substantiated. */
  singleSourceFindings: number;
  /** One entry per consolidated reviewer, in configuration order. */
  positions: ReviewPanelOverlapPosition[];
}

export interface ReviewPanelOverlapPosition {
  /** One-based configured reviewer position. It carries no priority. */
  position: number;
  sourceFindings: number;
  citedSourceFindings: number;
  /** Consolidated findings citing at least one of this reviewer's findings. */
  consolidatedFindings: number;
  /** Consolidated findings this reviewer alone substantiated. */
  singleSourceFindings: number;
  /**
   * Consolidated findings no earlier-positioned reviewer substantiated: what
   * this position added to a panel of the positions before it.
   */
  novelFindings: number;
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
  /**
   * Build pipeline only: the read-only guard's Git baseline for the whole pass,
   * captured before any reviewer is dispatched. Every reviewer and the
   * consolidation turn are checked against it. Absent on Multi Review records
   * and on pipeline passes started before the guard existed.
   */
  workspaceBaseline?: WorkspaceGitBaseline;
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

function optionalFinalUsagePollCount(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      (value as number) >= 0 &&
      (value as number) <= REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS)
  );
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalCount(value: unknown): boolean {
  return value === undefined || count(value);
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
  return (
    (value.reasoningEffort === undefined || nonBlank(value.reasoningEffort, 128)) &&
    (value.fastMode === undefined || typeof value.fastMode === "boolean") &&
    (value.lens === undefined || isReviewLens(value.lens))
  );
}

/** A reviewer row: a model selection that may carry the reviewer's lens. */
export function isReviewerModelSelection(value: unknown): value is ReviewerModelSelection {
  if (
    !record(value) ||
    !hasOnlyKeys(value, ["agent", "model", "reasoningEffort", "fastMode", "lens"])
  )
    return false;
  return isReviewerModelSelectionFields(value);
}

/**
 * A selection for a single-session step (preparation, consolidation, fix). A
 * lens means nothing there, so it is refused rather than silently dropped.
 */
export function isReviewStepModelSelection(value: unknown): value is ReviewerModelSelection {
  return isReviewerModelSelection(value) && value.lens === undefined;
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
  "fastMode",
  "lens",
  "id",
  "status",
  "modelUnpinned",
  "modelSubstitution",
  "admissionState",
  "queuePosition",
  "sessionKey",
  "providerSessionId",
  "requestId",
  "dispatchState",
  "resultTransport",
  "resultSubmission",
  "idleResultPolls",
  "report",
  "provisionalFindings",
  "schemaRepairAttempts",
  "schemaRepairPrompt",
  "continuationPrompt",
  "resultReminderSent",
  "restartContinuationSent",
  "usageLimitResends",
  "error",
  "startFailed",
  "agentStarted",
  "tokenCount",
  "cacheReadTokens",
  "usageFinalizationPolls",
  "commandSandboxOff",
  "progressAt",
  "progressDigest",
  "stalledSince",
  "startedAt",
  "turnStartedAt",
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
    (value.modelUnpinned === undefined || typeof value.modelUnpinned === "boolean") &&
    (value.modelSubstitution === undefined ||
      isNativeAgentModelSubstitution(value.modelSubstitution)) &&
    (value.admissionState === undefined ||
      value.admissionState === "queued" ||
      value.admissionState === "admitting") &&
    (value.queuePosition === undefined ||
      (Number.isSafeInteger(value.queuePosition) &&
        (value.queuePosition as number) >= 1 &&
        (value.queuePosition as number) <= REVIEW_FANOUT_MAX_REVIEWERS)) &&
    (value.sessionKey === undefined || nonBlank(value.sessionKey)) &&
    (value.providerSessionId === undefined || nonBlank(value.providerSessionId)) &&
    (value.requestId === undefined || nonBlank(value.requestId)) &&
    (value.dispatchState === undefined || isDispatchState(value.dispatchState)) &&
    (value.resultTransport === undefined ||
      value.resultTransport === "tool-v1" ||
      value.resultTransport === "structured-output-v1") &&
    (value.resultSubmission === undefined ||
      isWorkflowResultSubmissionState(value.resultSubmission)) &&
    optionalRepairAttempts(value.schemaRepairAttempts) &&
    optionalString(value.schemaRepairPrompt, 100_000) &&
    optionalString(value.continuationPrompt, 4_096) &&
    (value.resultReminderSent === undefined || typeof value.resultReminderSent === "boolean") &&
    (value.restartContinuationSent === undefined ||
      typeof value.restartContinuationSent === "boolean") &&
    optionalCount(value.usageLimitResends) &&
    optionalPollCount(value.idleResultPolls) &&
    optionalString(value.error, 4_096) &&
    (value.agentStarted === undefined || typeof value.agentStarted === "boolean") &&
    (value.startFailed === undefined || typeof value.startFailed === "boolean") &&
    optionalCount(value.tokenCount) &&
    optionalCount(value.cacheReadTokens) &&
    optionalFinalUsagePollCount(value.usageFinalizationPolls) &&
    optionalString(value.commandSandboxOff, READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS) &&
    optionalDate(value.progressAt) &&
    optionalProgressDigest(value.progressDigest) &&
    optionalDate(value.stalledSince) &&
    optionalDate(value.startedAt) &&
    optionalDate(value.turnStartedAt) &&
    optionalDate(value.completedAt) &&
    (value.report === undefined || isStructuredReviewReport(value.report)) &&
    (value.provisionalFindings === undefined ||
      isReviewerProvisionalFindingList(value.provisionalFindings))
  );
}

const PROVISIONAL_FINDING_ID = /^[0-9a-f]{24}$/;

/** One finding as `report_finding` accepts it: an issue within its byte bound. */
export function isProvisionalReviewIssue(value: unknown): value is ReviewIssue {
  if (!record(value) || value.reviewModels !== undefined || value.reviewSourceIds !== undefined) {
    return false;
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return false;
  }
  return (
    encoded !== undefined &&
    utf8Bytes(encoded) <= REVIEW_PROVISIONAL_FINDING_MAX_BYTES &&
    safeParseStructuredReviewFindings({ issues: [value], testCoverageGaps: [] }).success
  );
}

export function isReviewerProvisionalFinding(value: unknown): value is ReviewerProvisionalFinding {
  return (
    record(value) &&
    hasOnlyKeys(value, ["id", "reportedAt", "issue"]) &&
    typeof value.id === "string" &&
    PROVISIONAL_FINDING_ID.test(value.id) &&
    typeof value.reportedAt === "string" &&
    Number.isFinite(Date.parse(value.reportedAt)) &&
    isProvisionalReviewIssue(value.issue)
  );
}

function isReviewerProvisionalFindingList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= REVIEW_PROVISIONAL_FINDINGS_MAX &&
    value.every(isReviewerProvisionalFinding) &&
    new Set(value.map((finding: ReviewerProvisionalFinding) => finding.id)).size === value.length
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
      "restartContinuationSent",
      "usageLimitResends",
      "resultReminderSent",
      "continuationPrompt",
      "sessionKey",
      "providerSessionId",
      "requestId",
      "state",
      "createdAt",
      "agent",
      "model",
      "modelSubstitution",
      "reasoningEffort",
      "fastMode",
      "resultTransport",
      "resultSubmission",
      "schemaRepairAttempts",
      "schemaRepairPrompt",
      "idleResultPolls",
      "progressAt",
      "progressDigest",
      "stalledSince",
    ]) &&
    (value.restartContinuationSent === undefined ||
      typeof value.restartContinuationSent === "boolean") &&
    optionalCount(value.usageLimitResends) &&
    (value.resultReminderSent === undefined || typeof value.resultReminderSent === "boolean") &&
    optionalString(value.continuationPrompt, 100_000) &&
    nonBlank(value.sessionKey) &&
    nonBlank(value.providerSessionId) &&
    nonBlank(value.requestId) &&
    isDispatchState(value.state) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    isAgentPlatform(value.agent) &&
    (value.model === undefined || nonBlank(value.model)) &&
    (value.modelSubstitution === undefined ||
      isNativeAgentModelSubstitution(value.modelSubstitution)) &&
    (value.reasoningEffort === undefined || nonBlank(value.reasoningEffort, 128)) &&
    (value.fastMode === undefined || typeof value.fastMode === "boolean") &&
    (value.resultTransport === undefined ||
      value.resultTransport === "tool-v1" ||
      value.resultTransport === "structured-output-v1") &&
    (value.resultSubmission === undefined ||
      isWorkflowResultSubmissionState(value.resultSubmission)) &&
    optionalRepairAttempts(value.schemaRepairAttempts) &&
    optionalString(value.schemaRepairPrompt, 100_000) &&
    optionalPollCount(value.idleResultPolls) &&
    optionalDate(value.progressAt) &&
    optionalProgressDigest(value.progressDigest) &&
    optionalDate(value.stalledSince)
  );
}

const OVERLAP_POSITION_KEYS = [
  "position",
  "sourceFindings",
  "citedSourceFindings",
  "consolidatedFindings",
  "singleSourceFindings",
  "novelFindings",
] as const;

/**
 * Structural check only. A count that is internally inconsistent is a
 * measurement bug, and it must not make the workflow holding it unreadable.
 */
export function isReviewPanelOverlap(value: unknown): value is ReviewPanelOverlapV1 {
  if (
    !record(value) ||
    !hasOnlyKeys(value, [
      "version",
      "reviewers",
      "sourceFindings",
      "citedSourceFindings",
      "consolidatedFindings",
      "singleSourceFindings",
      "positions",
    ]) ||
    value.version !== 1 ||
    !count(value.reviewers) ||
    value.reviewers > REVIEW_FANOUT_MAX_REVIEWERS ||
    !count(value.sourceFindings) ||
    !count(value.citedSourceFindings) ||
    !count(value.consolidatedFindings) ||
    !count(value.singleSourceFindings) ||
    !Array.isArray(value.positions) ||
    value.positions.length !== value.reviewers
  ) {
    return false;
  }
  let previous = 0;
  return value.positions.every((entry: unknown) => {
    if (
      !record(entry) ||
      !hasOnlyKeys(entry, OVERLAP_POSITION_KEYS) ||
      !OVERLAP_POSITION_KEYS.every((key) => count(entry[key])) ||
      (entry.position as number) <= previous ||
      (entry.position as number) > REVIEW_FANOUT_MAX_REVIEWERS
    ) {
      return false;
    }
    previous = entry.position as number;
    return true;
  });
}

export function isReviewFanoutState(value: unknown): value is ReviewFanoutState {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "reviewers",
      "snapshot",
      "snapshotStale",
      "consolidation",
      "report",
      "workspaceBaseline",
    ]) &&
    isReviewerRecordList(value.reviewers) &&
    (value.snapshot === undefined || isReviewWorktreeSnapshotRecord(value.snapshot)) &&
    (value.snapshotStale === undefined || typeof value.snapshotStale === "boolean") &&
    (value.consolidation === undefined || isReviewConsolidationSession(value.consolidation)) &&
    (value.report === undefined || isStructuredReviewReport(value.report)) &&
    (value.workspaceBaseline === undefined || isWorkspaceGitBaseline(value.workspaceBaseline))
  );
}

/** True once no reviewer can still produce a report. */
export function reviewersSettled(reviewers: readonly ReviewerRecord[]): boolean {
  return !reviewers.some(
    (reviewer) => reviewer.status === "pending" || reviewer.status === "running",
  );
}

/** A failed reviewer whose agent never started; see {@link ReviewerRecord.startFailed}. */
export function reviewerCouldNotStart(
  reviewer: Pick<ReviewerRecord, "status" | "startFailed">,
): boolean {
  return reviewer.status === "failed" && reviewer.startFailed === true;
}

/** The reviewers whose reports are usable inputs to consolidation. */
export function usableReviewerReports(reviewers: readonly ReviewerRecord[]): ReviewerRecord[] {
  return reviewers.filter(
    (reviewer) => reviewer.status === "completed" && reviewer.report !== undefined,
  );
}
