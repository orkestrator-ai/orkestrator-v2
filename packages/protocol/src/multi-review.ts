import { isReviewValidationRun, type ReviewValidationRun } from "./review-validation.js";
import type { AgentPlatform } from "./agent-platforms.js";
import { isStructuredReviewReport, type StructuredReviewReport } from "./structured-review.js";
import { getReviewInstructionValidationError } from "./review-prompt.js";
import {
  MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX,
  MULTI_REVIEW_CUSTOM_FIX_PROMPT_CONTINUATION,
  STRUCTURED_REVIEW_FINDINGS_FRAME_CLOSE,
  STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION,
  STRUCTURED_REVIEW_FINDINGS_FRAME_OPEN,
  promptCarrierJson,
  wrapSystemInstructions,
} from "./review-evidence-frames.js";
import {
  isReviewPackageReference,
  type ReviewPackageReference,
  isSafeReviewTargetBranch,
} from "./review-workflow.js";
import {
  REVIEW_FANOUT_MAX_REVIEWERS,
  REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS,
  REVIEW_FANOUT_MAX_SNAPSHOT_PATHS,
  REVIEW_FANOUT_MIN_REVIEWERS,
  isReviewerModelSelection,
  isReviewerModelSelectionFields,
  isReviewStepModelSelection,
  isReviewerRecordList,
  isReviewWorktreeSnapshotRecord,
  isReviewPanelOverlap,
  type ReviewPanelOverlapV1,
  type ReviewerModelSelection,
  type ReviewerRecord,
  type ReviewDispatchState,
  type ReviewerStatus,
  type ReviewWorktreeSnapshotRecord,
} from "./review-fanout.js";
import { isWorkflowResultSubmissionState } from "./workflow-results.js";
import { READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS } from "./native-agent-policy-effects.js";

export const MULTI_REVIEW_WORKFLOW_VERSION = 1 as const;
export const MULTI_REVIEW_MIN_REVIEWERS = REVIEW_FANOUT_MIN_REVIEWERS;
export const MULTI_REVIEW_MAX_REVIEWERS = REVIEW_FANOUT_MAX_REVIEWERS;
export const MULTI_REVIEW_MAX_SNAPSHOT_PATHS = REVIEW_FANOUT_MAX_SNAPSHOT_PATHS;
export const MULTI_REVIEW_CUSTOM_FIX_INSTRUCTION_MAX_LENGTH = 100_000;
export const MULTI_REVIEW_PLAN_TOOL_PROHIBITION =
  "Do not invoke CreatePlan, create_plan, EnterPlanMode, or any equivalent planning or mode-switch tool, even if the provider offers one.";
export const MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION = `This is an implementation turn, not a planning turn. You are already in build mode: remain in build mode and begin editing the files now. Do not enter, propose, switch to, or imitate plan mode. ${MULTI_REVIEW_PLAN_TOOL_PROHIBITION} A plan, plan-review card, or approval request is not a valid response to this prompt. Do not ask the user to approve a plan or switch modes, and do not pause before implementation. Use the file-editing and command tools directly, complete the necessary edits, and run relevant validation in this turn.`;
/**
 * Ends the automated preparation/consolidation contract when their session
 * becomes an ordinary, user-facing Fix conversation.
 *
 * Multi Review deliberately reuses that session so the model retains the
 * review context. Provider settings are per turn, but earlier prompt
 * instructions remain in conversation history and can keep constraining the
 * model unless the interactive handoff supersedes them.
 */
export const MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION =
  "This is now a manual interactive Fix conversation, not an automated pipeline stage. " +
  "Any JSON-only or structured-output contract from earlier turns has ended and does not apply to this turn or later replies. " +
  "Earlier review-stage instructions not to edit files, run commands, or fix findings have also ended and no longer apply. " +
  "Implement the requested fixes, run relevant validation, and commit every relevant change. " +
  "When you finish, respond in ordinary Markdown prose with a concise summary and validation results. Do not return JSON unless the user explicitly asks for JSON.\n\n" +
  MULTI_REVIEW_IMPLEMENTATION_MODE_INSTRUCTION;
export const MULTI_REVIEW_ADDRESS_USER_INSTRUCTION =
  "Please address all the issues and coverage gaps.";
export const MULTI_REVIEW_ADDRESS_PROMPT = `${MULTI_REVIEW_ADDRESS_USER_INSTRUCTION}\n\n${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}`;
export const MULTI_REVIEW_UNSTICK_PROMPT = "Please continue";
/** Stable pane label for current Multi Review fix tabs. */
export const MULTI_REVIEW_FIX_TAB_TITLE = "Fix";
/** Stable pane label for the shared preparation and consolidation session. */
export const MULTI_REVIEW_REVIEW_TAB_TITLE = "Review preparation & consolidation";
/** Former pane title retained for restored layouts and backend session metadata. */
export const MULTI_REVIEW_LEGACY_FIX_TAB_TITLE = "Multi Review · Fix";
export const MULTI_REVIEW_REPLACED_FIX_SESSION_NOTICE =
  "The original consolidation conversation was no longer available. A fresh Fix session was created and seeded with the consolidated findings.";

/** Build the complete prompt for a fresh custom-fix session. */
export function multiReviewCustomFixPrompt(
  report: StructuredReviewReport,
  instruction: string,
): string {
  return `${MULTI_REVIEW_CUSTOM_FIX_INSTRUCTIONS_PREFIX}
${instruction}

${wrapSystemInstructions(MULTI_REVIEW_INTERACTIVE_RESPONSE_INSTRUCTION)}

${wrapSystemInstructions(STRUCTURED_REVIEW_FINDINGS_FRAME_INSTRUCTION)}

${STRUCTURED_REVIEW_FINDINGS_FRAME_OPEN}
${promptCarrierJson(report)}
${STRUCTURED_REVIEW_FINDINGS_FRAME_CLOSE}

${wrapSystemInstructions(MULTI_REVIEW_CUSTOM_FIX_PROMPT_CONTINUATION)}`;
}

/**
 * Aliases of the shared fan-out records.
 *
 * The reviewer machinery is the same program in Multi Review and in the build
 * pipeline's review stage, so its records live in `review-fanout` and both
 * owners embed them. These names stay because the Multi Review read model,
 * its storage and its tab all speak them.
 */
export type MultiReviewModelSelection = ReviewerModelSelection;

export type MultiReviewReviewerStatus = ReviewerStatus;

export type MultiReviewReviewer = ReviewerRecord;

/** Authoritative read model for one reviewer's provider transcript. */
export interface MultiReviewReviewerTranscript {
  workflowId: string;
  reviewerId: string;
  /** Authoritative parent state, used to offer recovery from this nested view. */
  workflowPhase: MultiReviewPhase;
  agent: AgentPlatform;
  model: string;
  reasoningEffort?: string;
  status: MultiReviewReviewerStatus;
  /** Current turn journal state, used to qualify the reviewer-level Unstick action. */
  dispatchState?: ReviewDispatchState;
  /**
   * The bounded transcript tail. Empty when {@link transcript} is
   * `"unchanged"`: the caller keeps the messages it already holds.
   */
  messages: unknown[];
  /**
   * `"unchanged"` answers a request whose `knownSourceToken` is still current.
   * Absent on responses from a backend that predates conditional reads, which
   * always carry a complete bounded snapshot.
   */
  transcript?: "snapshot" | "unchanged";
  /** Opaque, session-scoped token to send back as `knownSourceToken`. */
  sourceToken?: string;
  /** True when older messages were omitted to respect the count/byte bounds. */
  truncated?: boolean;
  /**
   * Opaque cursor for the history before `messages[0]`, sent to
   * `get_multi_review_reviewer_history_page`. Present only on snapshot answers
   * whose window omitted earlier history that can be paged; it is bound to
   * this reviewer, its provider session and {@link historyEpoch}.
   */
  historyCursor?: string;
  /**
   * History continuity epoch of a snapshot answer. A change means earlier
   * pages the caller holds belong to another history and must be dropped.
   */
  historyEpoch?: string;
  /**
   * Rows from before {@link messages} that changed recently, newest change
   * first. A row is one model response, so a late tool result can land on a
   * row newer ones pushed out of the tail; a caller replaces its own copy of
   * each (an earlier page it holds) and never inserts one it does not hold.
   */
  revisedMessages?: unknown[];
  /** Changed recovery signal invalidates retained history, which remains pageable. */
  historyReconciliationToken?: string;
  report?: StructuredReviewReport;
  error?: string;
  progressAt?: string;
  stalledSince?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Upper bound on a reviewer transcript source token, in characters. */
export const MULTI_REVIEW_TRANSCRIPT_TOKEN_MAX_LENGTH = 512;

export interface MultiReviewReviewerTranscriptRequest {
  workflowId: string;
  reviewerId: string;
  /** Token from the previous response; the backend ignores a stale or foreign one. */
  knownSourceToken?: string;
}

export function isMultiReviewReviewerTranscriptRequest(
  value: unknown,
): value is MultiReviewReviewerTranscriptRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      ["workflowId", "reviewerId", "knownSourceToken"].includes(key),
    ) &&
    typeof record.workflowId === "string" &&
    record.workflowId.trim().length > 0 &&
    typeof record.reviewerId === "string" &&
    record.reviewerId.trim().length > 0 &&
    (record.knownSourceToken === undefined ||
      (typeof record.knownSourceToken === "string" &&
        record.knownSourceToken.length > 0 &&
        record.knownSourceToken.length <= MULTI_REVIEW_TRANSCRIPT_TOKEN_MAX_LENGTH))
  );
}

/** Upper bound on a reviewer history cursor, in characters. */
export const MULTI_REVIEW_HISTORY_CURSOR_MAX_LENGTH = 1024;
/** Messages one reviewer history page may carry at most. */
export const MULTI_REVIEW_HISTORY_PAGE_MAX_MESSAGES = 200;
/** Byte target a reviewer history page request may ask for at most. */
export const MULTI_REVIEW_HISTORY_PAGE_MAX_TARGET_BYTES = 1024 * 1024;
/** Upper bound on a history epoch, in characters. */
export const MULTI_REVIEW_HISTORY_EPOCH_MAX_LENGTH = 128;

/** Request for the reviewer history immediately before `before`. */
export interface MultiReviewReviewerHistoryPageRequest {
  workflowId: string;
  reviewerId: string;
  /** `historyCursor` from a transcript snapshot, or `nextCursor` from a page. */
  before: string;
  limit?: number;
  targetBytes?: number;
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

export function isMultiReviewReviewerHistoryPageRequest(
  value: unknown,
): value is MultiReviewReviewerHistoryPageRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      ["workflowId", "reviewerId", "before", "limit", "targetBytes"].includes(key),
    ) &&
    typeof record.workflowId === "string" &&
    record.workflowId.trim().length > 0 &&
    typeof record.reviewerId === "string" &&
    record.reviewerId.trim().length > 0 &&
    typeof record.before === "string" &&
    record.before.length > 0 &&
    record.before.length <= MULTI_REVIEW_HISTORY_CURSOR_MAX_LENGTH &&
    (record.limit === undefined ||
      isBoundedPositiveInteger(record.limit, MULTI_REVIEW_HISTORY_PAGE_MAX_MESSAGES)) &&
    (record.targetBytes === undefined ||
      isBoundedPositiveInteger(record.targetBytes, MULTI_REVIEW_HISTORY_PAGE_MAX_TARGET_BYTES))
  );
}

/**
 * One page of reviewer history, or why the cursor can no longer be served.
 *
 * `expired` is never an empty page: the history the cursor described was
 * replaced (a restarted reviewer) or rewritten, so the caller drops the pages
 * it holds and re-reads the current transcript for a fresh cursor.
 */
export type MultiReviewReviewerHistoryPage =
  | {
      status: "page";
      /** Oldest first, immediately before the cursor's position. */
      messages: unknown[];
      historyEpoch: string;
      /** Cursor for the page before this one; absent when nothing more can be paged. */
      nextCursor?: string;
      /** True only when this page reaches the start of the reviewer's history. */
      complete: boolean;
      /** True when earlier history exists (pageable or not). */
      truncated: boolean;
    }
  | { status: "expired"; reason: "session-replaced" | "history-changed" };

export function isMultiReviewReviewerHistoryPage(
  value: unknown,
): value is MultiReviewReviewerHistoryPage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status === "expired") {
    return record.reason === "session-replaced" || record.reason === "history-changed";
  }
  return (
    record.status === "page" &&
    Array.isArray(record.messages) &&
    record.messages.length <= MULTI_REVIEW_HISTORY_PAGE_MAX_MESSAGES &&
    typeof record.historyEpoch === "string" &&
    record.historyEpoch.length > 0 &&
    record.historyEpoch.length <= MULTI_REVIEW_HISTORY_EPOCH_MAX_LENGTH &&
    (record.nextCursor === undefined ||
      (typeof record.nextCursor === "string" &&
        record.nextCursor.length > 0 &&
        record.nextCursor.length <= MULTI_REVIEW_HISTORY_CURSOR_MAX_LENGTH)) &&
    typeof record.complete === "boolean" &&
    typeof record.truncated === "boolean" &&
    // A complete page ends history; it cannot also offer a cursor.
    !(record.complete === true && record.nextCursor !== undefined)
  );
}

export type MultiReviewPhase =
  | "preparing"
  | "reviewing"
  | "consolidating"
  | "ready"
  | "fixing"
  | "interactive"
  | "paused"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

export type MultiReviewPausablePhase = "preparing" | "consolidating" | "fixing";

/** The preparation/consolidation turns plus the separate fix turn. */
export type MultiReviewStepKind = "prepare" | "consolidate" | "fix";

/**
 * One step's timing and consumption.
 *
 * The three steps share one provider session and every dispatch resets its
 * clock, so a settled step's numbers only survive if they are recorded here.
 */
export interface MultiReviewStepRuntime {
  startedAt: string;
  completedAt?: string;
  /** Tokens this step consumed: cumulative session usage minus its dispatch baseline. */
  tokenCount?: number;
  /** Cumulative session usage when the step was dispatched; bookkeeping for {@link tokenCount}. */
  tokenBaseline?: number;
  /**
   * Why this step's read-only turn (consolidation) ran its commands without
   * the provider's command sandbox, as its provider reported it.
   */
  commandSandboxOff?: string;
}

export type MultiReviewStepRuntimes = Partial<Record<MultiReviewStepKind, MultiReviewStepRuntime>>;

export interface MultiReviewSession extends MultiReviewModelSelection {
  sessionKey: string;
  providerSessionId: string;
  /** Step whose dispatch opened this provider session; absent on older records. */
  openedFor?: MultiReviewStepKind;
  requestIds: string[];
  status: "running" | "idle" | "failed" | "cancelled";
  startedAt: string;
  /** Cumulative provider tokens for this provider session. */
  tokenCount?: number;
  /** Bounded terminal polls while the provider finalizes cumulative usage. */
  usageFinalizationPolls?: number;
  /** Consecutive idle observations before an interactive dispatch is treated as settled. */
  idleResultPolls?: number;
  /** Positive activity evidence that the current interactive dispatch started. */
  observedRunning?: boolean;
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

export type MultiReviewFixSession = MultiReviewSession;

/** Durable identity shared by every reviewer and the consolidation turn. */
export type MultiReviewWorktreeSnapshot = ReviewWorktreeSnapshotRecord;

/**
 * Durable intent to open the ordinary PR tab after a Fix proves completion, or
 * after consolidation finds nothing to fix.
 *
 * Recorded atomically with the Fix completion or the clean report, so a
 * restart cannot lose the handoff; the supervisor retries delivery under the
 * same request id, which the native-agent layer deduplicates.
 */
export interface MultiReviewAutoPrLaunch {
  /**
   * `clean-review` when a consolidated report with no issues or coverage gaps
   * authorized the launch, so no Fix ran; absent when a Fix authorized it.
   */
  basis?: "clean-review";
  /** Fix attempt that authorized this launch; absent on legacy and clean-review records. */
  fixIdentity?: string;
  state: "pending" | "launched" | "skipped" | "failed";
  requestId: string;
  /** Failed delivery attempts, persisted so a restart cannot reset the budget. */
  attempts?: number;
  /** Pane tab that hosts the PR agent once launched. */
  tabId?: string;
  /** Why the launch was skipped or failed, or the last retryable error. */
  message?: string;
}

/**
 * Which runtime runs a Multi Review (item 301, plan Phase 3, D5).
 *
 * `bespoke`: `multi-review-service.ts` runs every step itself (the default).
 * `graph`: the service launches a graph run of the built-in Multi Review
 * template and projects that run onto this record, so every surface that reads
 * the record (the review-pass tab, the CLI, the coordinator) keeps working.
 */
export const MULTI_REVIEW_ENGINES = ["bespoke", "graph"] as const;
export type MultiReviewEngine = (typeof MULTI_REVIEW_ENGINES)[number];
/** The app setting's default until the graph runtime has soaked (Phase 3). */
export const MULTI_REVIEW_DEFAULT_ENGINE: MultiReviewEngine = "bespoke";
/** Testing override; wins over the app setting when it names an engine. */
export const MULTI_REVIEW_ENGINE_ENV = "ORKESTRATOR_MULTI_REVIEW_ENGINE";

export function isMultiReviewEngine(value: unknown): value is MultiReviewEngine {
  return typeof value === "string" && (MULTI_REVIEW_ENGINES as readonly string[]).includes(value);
}

/**
 * The engine a new Multi Review starts on: the environment override when it
 * names an engine, else the app setting, else {@link MULTI_REVIEW_DEFAULT_ENGINE}.
 * An unknown override is ignored rather than guessed at.
 */
export function resolveMultiReviewEngine(
  setting: unknown,
  override: string | undefined,
): MultiReviewEngine {
  const forced = override?.trim().toLowerCase();
  if (isMultiReviewEngine(forced)) return forced;
  return isMultiReviewEngine(setting) ? setting : MULTI_REVIEW_DEFAULT_ENGINE;
}

/**
 * The graph run behind a graph-engine Multi Review (`engine: "graph"`).
 *
 * `settled` is set once the run ended and its final state was projected; from
 * then on the record is an ordinary settled Multi Review, so the manual Fix
 * (`address`, `customFix`) works on it as on any other.
 */
export interface MultiReviewGraphRunLink {
  runId: string;
  /** The run revision the record was last projected from. */
  projectedRevision?: number;
  settled?: boolean;
}

export interface MultiReviewWorkflow {
  /** Launch the ordinary Fix handoff after successful consolidation; absent means off. */
  autoFix?: boolean;
  /**
   * Launch the ordinary PR tab once the Fix proves completion (a complete
   * structured result, or an interactive handoff turn that finished on its own
   * as the conversation's last turn), or straight after a consolidation that
   * found nothing to fix; absent means off.
   */
  autoPr?: boolean;
  /** Delivery state of the automatic PR launch; absent until a Fix completes or a clean report settles. */
  autoPrLaunch?: MultiReviewAutoPrLaunch;
  /**
   * `graph` when a graph run of the built-in Multi Review template runs this
   * review (item 301); absent on every bespoke record, old ones included.
   */
  engine?: "graph";
  /** The graph run a graph-engine review is projected from. */
  graphRun?: MultiReviewGraphRunLink;
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
  /** Model used for immutable-package preparation. */
  reviewModel?: MultiReviewModelSelection;
  /** Consolidation-only override; absent means use the preparation model. */
  consolidationModel?: MultiReviewModelSelection;
  /** Durable key for the preparation/consolidation provider session. */
  reviewSessionKey?: string;
  reviewSession?: MultiReviewSession;
  /**
   * The finished preparation session, kept so its transcript stays reachable
   * after consolidation moves to a session of its own.
   */
  preparationSession?: MultiReviewSession;
  fixModel: MultiReviewModelSelection;
  /** Durable key reserved for the next or current fix session. */
  fixSessionKey?: string;
  fixSession?: MultiReviewFixSession;
  /** Per-step timing and token consumption, kept once the shared session moves on. */
  stepRuntimes?: MultiReviewStepRuntimes;
  reviewWorktreeSnapshot?: MultiReviewWorktreeSnapshot;
  /** Backend projection of the environment-owned validation job. */
  validationRun?: ReviewValidationRun;
  /** User asked the supervisor to stop validation and package the partial evidence. */
  validationStopRequested?: boolean;
  /** Immutable evidence shared by all reviewers; absent on legacy workflows. */
  reviewPackage?: ReviewPackageReference;
  /** Set when the live worktree changed during review, or immutable package evidence went stale. */
  reviewSnapshotStale?: boolean;
  phase: MultiReviewPhase;
  /** Active backend-owned phase retained while its step is paused. */
  pausedFromPhase?: MultiReviewPausablePhase;
  /** Step whose context-menu action produced the paused state. */
  pausedStep?: MultiReviewStepKind;
  consolidatedReport?: StructuredReviewReport;
  /** Reviewer overlap in {@link consolidatedReport}; written and cleared with it. */
  consolidationOverlap?: ReviewPanelOverlapV1;
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
  /** Logical native-agent key reserved for the pending interactive handoff. */
  addressSessionKey?: string;
  /** At-most-once request identity reserved for the pending interactive handoff. */
  addressRequestId?: string;
  /** Pane tab identity reserved for the pending interactive handoff. */
  addressTabId?: string;
  /** User-authored instructions for a fresh interactive fix session. */
  customFixInstruction?: string;
  /** Model selection paired with {@link customFixInstruction} until delivery succeeds. */
  customFixModel?: MultiReviewModelSelection;
  /** Persisted failed delivery attempts so backend restarts cannot reset the retry budget. */
  addressPromptAttempts?: number;
  /** Tab that presents the current fix session, including provider-switch launches. */
  fixTabId?: string;
  /** Non-fatal failure to publish the current fix session into the pane layout. */
  presentationError?: string;
  /** How Fix was most recently launched, retained so an upstream restart can replay it. */
  fixLaunch?:
    { kind: "default" } | { kind: "custom"; instruction: string; model: MultiReviewModelSelection };
  /** Relaunch Fix after an explicitly restarted upstream step reconsolidates. */
  restartFixAfterConsolidation?: boolean;
  activeRequest?: {
    kind: MultiReviewStepKind;
    requestId: string;
    state: "prepared" | "dispatching" | "sent";
    resultTransport?: import("./workflow-results.js").WorkflowResultTransport;
    /** Bounded backend-projected delivery state for the tool-mode result slot. */
    resultSubmission?: import("./workflow-results.js").WorkflowResultSubmissionState;
    createdAt: string;
    /** Durable correction turn for a rejected consolidated report. */
    schemaRepairAttempts?: number;
    schemaRepairPrompt?: string;
    /** Same-session follow-up turn: the result reminder or a restart continuation. */
    continuationPrompt?: string;
    /** The step's one reminder to call its result tool was spent. */
    resultReminderSent?: boolean;
    /** The step's one continuation after a provider restart was spent. */
    restartContinuationSent?: boolean;
    /** Times this step turn was resent after the weekly limit stopped it. */
    usageLimitResends?: number;
    idleResultPolls?: number;
    /** Bounded terminal polls while the provider finalizes cumulative usage. */
    usageFinalizationPolls?: number;
  };
  /** Accepted result keys whose domain transition is durable but consumption is pending. */
  pendingResultConsumptions?: string[];
  cancellingSince?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  backendRevision: number;
}

export interface StartMultiReviewInput {
  /** Launch the ordinary Fix handoff after successful consolidation; absent means off. */
  autoFix?: boolean;
  /** Launch the ordinary PR tab after the Fix turn completes successfully; absent means off. */
  autoPr?: boolean;
  environmentId: string;
  projectId: string;
  targetBranch: string;
  reviewInstruction?: string;
  reviewers: MultiReviewModelSelection[];
  /** Absent only for compatibility with callers predating the separate review default. */
  reviewModel?: MultiReviewModelSelection;
  fixModel: MultiReviewModelSelection;
}

/** Complete environment button action. Selections are the launch dialog's exact rows. */
export interface LaunchMultiReviewActionInput {
  /** Launch the ordinary Fix handoff after successful consolidation; omitted uses saved defaults. */
  autoFix?: boolean;
  /** Launch the ordinary PR tab after the Fix turn completes; omitted uses saved defaults. */
  autoPr?: boolean;
  requestId: string;
  environmentId: string;
  /** Omitted model rows use the saved Multi Review defaults, as the button does. */
  reviewers?: MultiReviewModelSelection[];
  reviewModel?: MultiReviewModelSelection;
  fixModel?: MultiReviewModelSelection;
  /** Omitted values use saved defaults; an explicit blank instruction clears its default. */
  targetBranch?: string;
  reviewInstruction?: string;
}

export interface MultiReviewActionResult {
  workflow: MultiReviewWorkflow;
  outcome: "opened" | "partial" | "pending";
  reused: boolean;
  ui: {
    status: "opened" | "unavailable";
    tabId?: string;
    paneId?: string;
    layoutRevision?: number;
  };
  /** A saved workflow is retained whenever presentation or cancellation fails. */
  recovery?: string;
}

export function isLaunchMultiReviewActionInput(
  value: unknown,
): value is LaunchMultiReviewActionInput {
  const hasReviewInstruction = record(value) && Object.hasOwn(value, "reviewInstruction");
  const reviewInstruction = record(value) ? value.reviewInstruction : undefined;
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "requestId",
      "environmentId",
      "reviewers",
      "reviewModel",
      "fixModel",
      "targetBranch",
      "reviewInstruction",
      "autoFix",
      "autoPr",
    ]) &&
    nonBlank(value.requestId, 256) &&
    (!hasReviewInstruction ||
      (typeof reviewInstruction === "string" && reviewInstruction.length <= 100_000)) &&
    isStartMultiReviewInput({
      environmentId: value.environmentId,
      projectId: "validated-by-caller",
      targetBranch: value.targetBranch ?? "main",
      reviewInstruction:
        typeof reviewInstruction === "string" && reviewInstruction.trim().length === 0
          ? undefined
          : reviewInstruction,
      // An omitted row is filled from saved defaults by the backend, so only
      // a row the caller actually sent is checked here.
      reviewers:
        value.reviewers === undefined ? [DEFAULTED_SELECTION_PLACEHOLDER] : value.reviewers,
      reviewModel: value.reviewModel,
      fixModel: value.fixModel === undefined ? DEFAULTED_SELECTION_PLACEHOLDER : value.fixModel,
      autoFix: value.autoFix,
      autoPr: value.autoPr,
    })
  );
}

/** A well-formed stand-in used only to validate the rest of a launch payload. */
const DEFAULTED_SELECTION_PLACEHOLDER: MultiReviewModelSelection = {
  agent: "claude",
  model: "default",
};

export interface StartMultiReviewCustomFixInput {
  workflowId: string;
  fixModel: MultiReviewModelSelection;
  instruction: string;
}

export interface RestartMultiReviewStepInput {
  workflowId: string;
  kind: MultiReviewStepKind;
  /** Omitted for the ordinary restart, which keeps the step's configured model. */
  model?: MultiReviewModelSelection;
}

export interface MultiReviewStepControlInput {
  workflowId: string;
  kind: MultiReviewStepKind;
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

/**
 * A preparation, consolidation or fix selection. A lens is a reviewer's focus,
 * so these refuse one ({@link isMultiReviewReviewerSelection} accepts it).
 */
export const isMultiReviewModelSelection = isReviewStepModelSelection;

/** A reviewer row, which may carry the reviewer's lens. */
export const isMultiReviewReviewerSelection = isReviewerModelSelection;

const isMultiReviewModelSelectionFields = isReviewerModelSelectionFields;

export function isStartMultiReviewInput(value: unknown): value is StartMultiReviewInput {
  if (
    !record(value) ||
    !hasOnlyKeys(value, [
      "environmentId",
      "projectId",
      "targetBranch",
      "reviewInstruction",
      "autoFix",
      "autoPr",
      "reviewers",
      "reviewModel",
      "fixModel",
    ]) ||
    !nonBlank(value.environmentId) ||
    !nonBlank(value.projectId) ||
    !isSafeReviewTargetBranch(value.targetBranch) ||
    getReviewInstructionValidationError(value.reviewInstruction) !== null ||
    (value.autoFix !== undefined && typeof value.autoFix !== "boolean") ||
    (value.autoPr !== undefined && typeof value.autoPr !== "boolean") ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length < MULTI_REVIEW_MIN_REVIEWERS ||
    value.reviewers.length > MULTI_REVIEW_MAX_REVIEWERS ||
    !value.reviewers.every(isMultiReviewReviewerSelection) ||
    (value.reviewModel !== undefined && !isMultiReviewModelSelection(value.reviewModel)) ||
    !isMultiReviewModelSelection(value.fixModel)
  ) {
    return false;
  }
  return true;
}

export function isStartMultiReviewCustomFixInput(
  value: unknown,
): value is StartMultiReviewCustomFixInput {
  return (
    record(value) &&
    hasOnlyKeys(value, ["workflowId", "fixModel", "instruction"]) &&
    nonBlank(value.workflowId) &&
    isMultiReviewModelSelection(value.fixModel) &&
    nonBlank(value.instruction, MULTI_REVIEW_CUSTOM_FIX_INSTRUCTION_MAX_LENGTH)
  );
}

export const MULTI_REVIEW_STEP_KINDS = ["prepare", "consolidate", "fix"] as const;

export function isMultiReviewStepControlInput(
  value: unknown,
): value is MultiReviewStepControlInput {
  return (
    record(value) &&
    hasOnlyKeys(value, ["workflowId", "kind"]) &&
    nonBlank(value.workflowId) &&
    MULTI_REVIEW_STEP_KINDS.includes(value.kind as MultiReviewStepKind)
  );
}

export function isRestartMultiReviewStepInput(
  value: unknown,
): value is RestartMultiReviewStepInput {
  return (
    record(value) &&
    hasOnlyKeys(value, ["workflowId", "kind", "model"]) &&
    nonBlank(value.workflowId) &&
    MULTI_REVIEW_STEP_KINDS.includes(value.kind as MultiReviewStepKind) &&
    (value.model === undefined || isMultiReviewModelSelection(value.model))
  );
}

const PHASES = new Set<MultiReviewPhase>([
  "preparing",
  "reviewing",
  "consolidating",
  "ready",
  "fixing",
  "interactive",
  "paused",
  "completed",
  "cancelling",
  "cancelled",
  "failed",
]);
function optionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function optionalDate(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
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
      // A session record is spread from its whole selection, so every
      // selection key has to be allowed here. Omitting one rejects the entire
      // workflow snapshot and hides it from its own supervisor.
      "fastMode",
      "sessionKey",
      "providerSessionId",
      "openedFor",
      "requestIds",
      "status",
      "startedAt",
      "tokenCount",
      "usageFinalizationPolls",
      "idleResultPolls",
      "observedRunning",
      "progressAt",
      "progressDigest",
      "stalledSince",
      "completedAt",
      "error",
    ]) &&
    isMultiReviewModelSelectionFields(value) &&
    nonBlank(value.sessionKey) &&
    nonBlank(value.providerSessionId) &&
    (value.openedFor === undefined ||
      MULTI_REVIEW_STEP_KINDS.includes(value.openedFor as MultiReviewStepKind)) &&
    Array.isArray(value.requestIds) &&
    value.requestIds.length <= 256 &&
    value.requestIds.every((requestId) => nonBlank(requestId)) &&
    ["running", "idle", "failed", "cancelled"].includes(value.status as string) &&
    optionalDate(value.startedAt) &&
    typeof value.startedAt === "string" &&
    optionalTokenCount(value.tokenCount) &&
    (value.usageFinalizationPolls === undefined ||
      (Number.isSafeInteger(value.usageFinalizationPolls) &&
        (value.usageFinalizationPolls as number) >= 0 &&
        (value.usageFinalizationPolls as number) <= REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS)) &&
    optionalPollCount(value.idleResultPolls) &&
    (value.observedRunning === undefined || typeof value.observedRunning === "boolean") &&
    optionalDate(value.progressAt) &&
    optionalProgressDigest(value.progressDigest) &&
    optionalDate(value.stalledSince) &&
    optionalDate(value.completedAt) &&
    optionalString(value.error, 4_096)
  );
}

function optionalTokenCount(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isStepRuntime(value: unknown): value is MultiReviewStepRuntime {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "startedAt",
      "completedAt",
      "tokenCount",
      "tokenBaseline",
      "commandSandboxOff",
    ]) &&
    typeof value.startedAt === "string" &&
    optionalDate(value.startedAt) &&
    optionalDate(value.completedAt) &&
    optionalTokenCount(value.tokenCount) &&
    optionalTokenCount(value.tokenBaseline) &&
    optionalString(value.commandSandboxOff, READ_ONLY_COMMAND_SANDBOX_REASON_MAX_CHARS)
  );
}

function isStepRuntimes(value: unknown): value is MultiReviewStepRuntimes {
  return (
    record(value) &&
    hasOnlyKeys(value, MULTI_REVIEW_STEP_KINDS) &&
    Object.values(value).every((runtime) => isStepRuntime(runtime))
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
      "resultTransport",
      "resultSubmission",
      "createdAt",
      "schemaRepairAttempts",
      "schemaRepairPrompt",
      "continuationPrompt",
      "resultReminderSent",
      "restartContinuationSent",
      "usageLimitResends",
      "idleResultPolls",
      "usageFinalizationPolls",
    ]) &&
    MULTI_REVIEW_STEP_KINDS.includes(value.kind as MultiReviewStepKind) &&
    nonBlank(value.requestId) &&
    (value.state === "prepared" || value.state === "dispatching" || value.state === "sent") &&
    (value.resultTransport === undefined ||
      value.resultTransport === "tool-v1" ||
      value.resultTransport === "structured-output-v1") &&
    (value.resultSubmission === undefined ||
      isWorkflowResultSubmissionState(value.resultSubmission)) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    optionalRepairAttempts(value.schemaRepairAttempts) &&
    optionalString(value.schemaRepairPrompt, 100_000) &&
    optionalString(value.continuationPrompt, 4_096) &&
    (value.resultReminderSent === undefined || typeof value.resultReminderSent === "boolean") &&
    (value.restartContinuationSent === undefined ||
      typeof value.restartContinuationSent === "boolean") &&
    (value.usageLimitResends === undefined ||
      (Number.isSafeInteger(value.usageLimitResends) &&
        (value.usageLimitResends as number) >= 0)) &&
    optionalPollCount(value.idleResultPolls) &&
    (value.usageFinalizationPolls === undefined ||
      (Number.isSafeInteger(value.usageFinalizationPolls) &&
        (value.usageFinalizationPolls as number) >= 0 &&
        (value.usageFinalizationPolls as number) <= REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS))
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

const AUTO_PR_LAUNCH_STATES = new Set<MultiReviewAutoPrLaunch["state"]>([
  "pending",
  "launched",
  "skipped",
  "failed",
]);

function isGraphRunLink(value: unknown): value is MultiReviewGraphRunLink {
  return (
    record(value) &&
    hasOnlyKeys(value, ["runId", "projectedRevision", "settled"]) &&
    nonBlank(value.runId, 128) &&
    (value.projectedRevision === undefined ||
      (Number.isSafeInteger(value.projectedRevision) &&
        (value.projectedRevision as number) >= 0)) &&
    (value.settled === undefined || typeof value.settled === "boolean")
  );
}

function isAutoPrLaunch(value: unknown): value is MultiReviewAutoPrLaunch {
  return (
    record(value) &&
    hasOnlyKeys(value, [
      "state",
      "requestId",
      "attempts",
      "tabId",
      "message",
      "fixIdentity",
      "basis",
    ]) &&
    AUTO_PR_LAUNCH_STATES.has(value.state as MultiReviewAutoPrLaunch["state"]) &&
    (value.basis === undefined || value.basis === "clean-review") &&
    optionalProgressDigest(value.fixIdentity) &&
    nonBlank(value.requestId, 256) &&
    (value.attempts === undefined ||
      (Number.isSafeInteger(value.attempts) && (value.attempts as number) >= 0)) &&
    (value.tabId === undefined || nonBlank(value.tabId)) &&
    optionalString(value.message, 4_096)
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
      "autoFix",
      "autoPr",
      "autoPrLaunch",
      "engine",
      "graphRun",
      "reviewers",
      "reviewModel",
      "consolidationModel",
      "reviewSessionKey",
      "reviewSession",
      "preparationSession",
      "fixModel",
      "fixSessionKey",
      "fixSession",
      "stepRuntimes",
      "phase",
      "pausedFromPhase",
      "pausedStep",
      "reviewWorktreeSnapshot",
      "reviewPackage",
      "validationRun",
      "validationStopRequested",
      "reviewSnapshotStale",
      "consolidatedReport",
      "consolidationOverlap",
      "fixResult",
      "addressPromptPending",
      "addressSessionKey",
      "addressRequestId",
      "addressTabId",
      "customFixInstruction",
      "customFixModel",
      "addressPromptAttempts",
      "fixTabId",
      "presentationError",
      "fixLaunch",
      "restartFixAfterConsolidation",
      "activeRequest",
      "pendingResultConsumptions",
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
    !isSafeReviewTargetBranch(value.targetBranch) ||
    getReviewInstructionValidationError(value.reviewInstruction) !== null ||
    (value.autoFix !== undefined && typeof value.autoFix !== "boolean") ||
    (value.autoPr !== undefined && typeof value.autoPr !== "boolean") ||
    (value.autoPrLaunch !== undefined && !isAutoPrLaunch(value.autoPrLaunch)) ||
    (value.engine !== undefined && value.engine !== "graph") ||
    (value.engine === "graph") !== (value.graphRun !== undefined) ||
    (value.graphRun !== undefined && !isGraphRunLink(value.graphRun)) ||
    !PHASES.has(value.phase as MultiReviewPhase) ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length < MULTI_REVIEW_MIN_REVIEWERS ||
    value.reviewers.length > MULTI_REVIEW_MAX_REVIEWERS ||
    (value.reviewModel !== undefined && !isMultiReviewModelSelection(value.reviewModel)) ||
    (value.consolidationModel !== undefined &&
      !isMultiReviewModelSelection(value.consolidationModel)) ||
    (value.reviewSessionKey !== undefined && !nonBlank(value.reviewSessionKey)) ||
    (value.reviewSession !== undefined && !isFixSession(value.reviewSession)) ||
    (value.preparationSession !== undefined && !isFixSession(value.preparationSession)) ||
    !record(value.fixModel) ||
    !isMultiReviewModelSelection(value.fixModel) ||
    (value.fixSessionKey !== undefined && !nonBlank(value.fixSessionKey)) ||
    !Number.isFinite(Date.parse(value.createdAt as string)) ||
    !Number.isFinite(Date.parse(value.updatedAt as string)) ||
    !Number.isSafeInteger(value.backendRevision) ||
    (value.backendRevision as number) < 0 ||
    (value.controllerFence !== undefined && !nonBlank(value.controllerFence)) ||
    (value.fixSession !== undefined && !isFixSession(value.fixSession)) ||
    (value.stepRuntimes !== undefined && !isStepRuntimes(value.stepRuntimes)) ||
    (value.reviewWorktreeSnapshot !== undefined &&
      !isReviewWorktreeSnapshotRecord(value.reviewWorktreeSnapshot)) ||
    (value.validationRun !== undefined && !isReviewValidationRun(value.validationRun)) ||
    (value.validationStopRequested !== undefined &&
      typeof value.validationStopRequested !== "boolean") ||
    (value.reviewPackage !== undefined &&
      (!isReviewPackageReference(value.reviewPackage) ||
        value.reviewPackage.targetBranch !== value.targetBranch)) ||
    (value.reviewSnapshotStale !== undefined && typeof value.reviewSnapshotStale !== "boolean") ||
    (value.pausedFromPhase !== undefined &&
      value.pausedFromPhase !== "preparing" &&
      value.pausedFromPhase !== "consolidating" &&
      value.pausedFromPhase !== "fixing") ||
    (value.pausedStep !== undefined &&
      !MULTI_REVIEW_STEP_KINDS.includes(value.pausedStep as MultiReviewStepKind)) ||
    (value.activeRequest !== undefined && !isActiveRequest(value.activeRequest)) ||
    (value.pendingResultConsumptions !== undefined &&
      (!Array.isArray(value.pendingResultConsumptions) ||
        value.pendingResultConsumptions.length > 64 ||
        !value.pendingResultConsumptions.every((key) => nonBlank(key)))) ||
    !optionalDate(value.cancellingSince) ||
    (value.fixResult !== undefined && !isFixResult(value.fixResult)) ||
    (value.addressPromptPending !== undefined && typeof value.addressPromptPending !== "boolean") ||
    (value.addressSessionKey !== undefined && !nonBlank(value.addressSessionKey)) ||
    (value.addressRequestId !== undefined && !nonBlank(value.addressRequestId)) ||
    (value.addressTabId !== undefined && !nonBlank(value.addressTabId)) ||
    (value.customFixInstruction !== undefined &&
      !nonBlank(value.customFixInstruction, MULTI_REVIEW_CUSTOM_FIX_INSTRUCTION_MAX_LENGTH)) ||
    (value.customFixModel !== undefined && !isMultiReviewModelSelection(value.customFixModel)) ||
    (value.addressPromptAttempts !== undefined &&
      (!Number.isSafeInteger(value.addressPromptAttempts) ||
        (value.addressPromptAttempts as number) < 0)) ||
    (value.fixTabId !== undefined && !nonBlank(value.fixTabId)) ||
    !optionalString(value.presentationError, 4_096) ||
    (value.fixLaunch !== undefined &&
      (!record(value.fixLaunch) ||
        (value.fixLaunch.kind === "default"
          ? !hasOnlyKeys(value.fixLaunch, ["kind"])
          : value.fixLaunch.kind !== "custom" ||
            !hasOnlyKeys(value.fixLaunch, ["kind", "instruction", "model"]) ||
            !nonBlank(
              value.fixLaunch.instruction,
              MULTI_REVIEW_CUSTOM_FIX_INSTRUCTION_MAX_LENGTH,
            ) ||
            !isMultiReviewModelSelection(value.fixLaunch.model)))) ||
    (value.restartFixAfterConsolidation !== undefined &&
      typeof value.restartFixAfterConsolidation !== "boolean") ||
    !optionalString(value.error, 4_096) ||
    (value.consolidatedReport !== undefined &&
      !isStructuredReviewReport(value.consolidatedReport)) ||
    (value.consolidationOverlap !== undefined && !isReviewPanelOverlap(value.consolidationOverlap))
  ) {
    return false;
  }
  if (!isReviewerRecordList(value.reviewers)) return false;
  if (
    (value.phase === "ready" ||
      value.phase === "fixing" ||
      value.phase === "interactive" ||
      value.phase === "completed") &&
    !isStructuredReviewReport(value.consolidatedReport)
  ) {
    return false;
  }
  // A graph-engine Fix is a graph activation: it is `fixing` from admission,
  // before its provider session exists, and it never journals a request here.
  const graphEngine = value.engine === "graph";
  if (
    !graphEngine &&
    (value.phase === "fixing" || value.phase === "completed") &&
    !isFixSession(value.fixSession)
  ) {
    return false;
  }
  if (value.phase === "fixing" && !graphEngine) {
    const activeRequest = value.activeRequest;
    if (!isActiveRequest(activeRequest) || activeRequest.kind !== "fix") return false;
  }
  if (value.addressPromptPending === true && value.phase !== "interactive") return false;
  if (value.customFixInstruction !== undefined && value.addressPromptPending !== true) return false;
  if (value.customFixInstruction !== undefined && value.consolidatedReport === undefined)
    return false;
  if ((value.customFixInstruction === undefined) !== (value.customFixModel === undefined))
    return false;
  if (value.addressPromptAttempts !== undefined && value.addressPromptPending !== true)
    return false;
  if (
    value.addressPromptPending !== true &&
    (value.addressSessionKey !== undefined ||
      value.addressRequestId !== undefined ||
      value.addressTabId !== undefined)
  )
    return false;
  if ((value.phase === "cancelling") !== (typeof value.cancellingSince === "string")) return false;
  const paused = value.phase === "paused";
  if (
    paused !== (value.pausedFromPhase !== undefined) ||
    paused !== (value.pausedStep !== undefined)
  ) {
    return false;
  }
  if (
    paused &&
    ((value.pausedFromPhase === "preparing" && value.pausedStep !== "prepare") ||
      (value.pausedFromPhase === "consolidating" && value.pausedStep !== "consolidate") ||
      (value.pausedFromPhase === "fixing" && value.pausedStep !== "fix"))
  ) {
    return false;
  }
  if (
    paused &&
    (value.pausedFromPhase === "consolidating" || value.pausedFromPhase === "fixing") &&
    value.reviewPackage === undefined &&
    !value.reviewers.some((reviewer) => reviewer.report !== undefined)
  ) {
    return false;
  }
  if (paused && value.pausedFromPhase === "fixing" && value.consolidatedReport === undefined) {
    return false;
  }
  return true;
}

export function isMultiReviewTerminalPhase(phase: MultiReviewPhase): boolean {
  return phase === "interactive" || phase === "completed" || phase === "cancelled";
}

// ---------------------------------------------------------------------------
// Step sessions and their transcript tails
// ---------------------------------------------------------------------------

/**
 * Which step owns the fix session's clock and transcript right now.
 *
 * Older workflows run preparation, consolidation and the fix turn in one
 * provider session, and every dispatch resets its clock, so whatever that
 * session shows belongs to the step using it now and to no other.
 */
export function multiReviewSharedSessionStep(
  workflow: MultiReviewWorkflow,
): MultiReviewStepKind | null {
  switch (workflow.phase) {
    // The reviewers run without the fix session, so it still holds
    // preparation's finished turn for the whole review stage.
    case "preparing":
    case "reviewing":
      return "prepare";
    case "consolidating":
    case "ready":
      return "consolidate";
    case "fixing":
    case "completed":
      return "fix";
    case "paused":
      return workflow.pausedStep ?? null;
    // The address turn has not been dispatched yet, so the session still
    // carries consolidation's turn and no step may claim it.
    case "interactive":
      return workflow.addressPromptPending === true ? null : "fix";
    default:
      break;
  }
  // Cancellation clears the active request, so only a failure still says which
  // turn was in flight.
  return workflow.activeRequest?.kind ?? null;
}

/**
 * The provider session a step runs in. Preparation keeps its own once
 * consolidation moves to a fresh session; workflows without a separate
 * preparation model ran every step in the fix session.
 */
export function multiReviewStepSession(
  workflow: MultiReviewWorkflow,
  step: MultiReviewStepKind,
): MultiReviewSession | undefined {
  if (step === "fix") return workflow.fixSession;
  const coordinatorSession =
    workflow.reviewSession ??
    (workflow.reviewModel || workflow.consolidationModel ? undefined : workflow.fixSession);
  return step === "prepare"
    ? (workflow.preparationSession ?? coordinatorSession)
    : coordinatorSession;
}

/**
 * Whether `providerSessionId` on `agent` is one of the workflow's current
 * sessions: a step's or a reviewer's. Such a session outlives a tab opened on
 * it; closing the Multi Review closes it.
 */
export function multiReviewOwnsProviderSession(
  workflow: MultiReviewWorkflow,
  agent: AgentPlatform,
  providerSessionId: string,
): boolean {
  const sessions = [
    workflow.reviewSession,
    workflow.preparationSession,
    workflow.fixSession,
    ...workflow.reviewers,
  ];
  return sessions.some(
    (session) => session?.agent === agent && session.providerSessionId === providerSessionId,
  );
}

/**
 * Whether a step may show its session's transcript as its own.
 *
 * - `none`: the step has no session yet.
 * - `own`: the session is the step's, or the step is the one using a shared
 *   session now (see {@link multiReviewSharedSessionStep}). Once the pipeline
 *   has moved past every step sharing it, the last of them keeps it.
 * - `other-step`: the session is shared and another step is using it, so its
 *   transcript says nothing about this step.
 */
export type MultiReviewStepSessionAccess =
  | { kind: "none" }
  | { kind: "own"; session: MultiReviewSession }
  | { kind: "other-step"; session: MultiReviewSession; step: MultiReviewStepKind | null };

export function multiReviewStepSessionAccess(
  workflow: MultiReviewWorkflow,
  step: MultiReviewStepKind,
): MultiReviewStepSessionAccess {
  const session = multiReviewStepSession(workflow, step);
  if (!session) return { kind: "none" };
  const sharing = MULTI_REVIEW_STEP_KINDS.filter(
    (candidate) =>
      multiReviewStepSession(workflow, candidate)?.providerSessionId === session.providerSessionId,
  );
  if (sharing.length <= 1) return { kind: "own", session };
  const current = multiReviewSharedSessionStep(workflow);
  const order = (kind: MultiReviewStepKind) => MULTI_REVIEW_STEP_KINDS.indexOf(kind);
  const last = sharing[sharing.length - 1]!;
  const holder =
    current === null
      ? null
      : sharing.includes(current)
        ? current
        : order(current) > order(last)
          ? last
          : null;
  return holder === step ? { kind: "own", session } : { kind: "other-step", session, step: holder };
}

/**
 * Read model for the transcript tail of a preparation, consolidation or Fix
 * session, for the flow graph's inspector. It has the reviewer transcript's
 * contract: a bounded tail, an opaque session-scoped `sourceToken`, and an
 * `unchanged` answer with no messages when that token is still current.
 */
export interface MultiReviewStepTranscript {
  workflowId: string;
  step: MultiReviewStepKind;
  workflowPhase: MultiReviewPhase;
  /** See {@link MultiReviewStepSessionAccess}; only `own` carries messages. */
  session: MultiReviewStepSessionAccess["kind"];
  /** The step using a shared session now, when {@link session} is `other-step`. */
  sessionStep?: MultiReviewStepKind;
  agent?: AgentPlatform;
  model?: string;
  sessionStatus?: MultiReviewSession["status"];
  startedAt?: string;
  /** The bounded tail; empty when {@link transcript} is `"unchanged"`. */
  messages: unknown[];
  transcript: "snapshot" | "unchanged";
  /** Opaque, session-scoped token to send back as `knownSourceToken`. */
  sourceToken?: string;
  /** True when older messages were omitted to respect the count/byte bounds. */
  truncated?: boolean;
}

/** Messages one step transcript answer carries at most. */
export const MULTI_REVIEW_STEP_TRANSCRIPT_MAX_MESSAGES = 100;
/** Encoded JSON bytes of one step transcript answer's messages at most. */
export const MULTI_REVIEW_STEP_TRANSCRIPT_MAX_BYTES = 256 * 1024;

export interface MultiReviewStepTranscriptRequest {
  workflowId: string;
  step: MultiReviewStepKind;
  /** Token from the previous response; the backend ignores a stale or foreign one. */
  knownSourceToken?: string;
}

export function isMultiReviewStepTranscriptRequest(
  value: unknown,
): value is MultiReviewStepTranscriptRequest {
  return (
    record(value) &&
    hasOnlyKeys(value, ["workflowId", "step", "knownSourceToken"]) &&
    nonBlank(value.workflowId) &&
    MULTI_REVIEW_STEP_KINDS.includes(value.step as MultiReviewStepKind) &&
    (value.knownSourceToken === undefined ||
      (typeof value.knownSourceToken === "string" &&
        value.knownSourceToken.length > 0 &&
        value.knownSourceToken.length <= MULTI_REVIEW_TRANSCRIPT_TOKEN_MAX_LENGTH))
  );
}
