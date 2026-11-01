/**
 * The reviewer fan-out, shared by Multi Review and the build pipeline.
 *
 * Both owners run the same program: N reviewers answer the structured-review
 * contract independently against one pinned worktree state, then a single
 * consolidation turn merges their reports. Everything that program needs to do
 * — create the session, journal the dispatch exactly once, resolve unattended
 * interactions, bound a schema repair, tell a slow turn from a wedged one, and
 * derive the provenance the consolidated report has to carry — lives here.
 *
 * What differs between the owners is only where the state is persisted and what
 * happens after consolidation, so those are the host's business:
 * {@link ReviewFanoutHost} is the whole of the boundary. A host owns its own
 * storage, its own lease fence, and its own worktree baseline; this module owns
 * the turn.
 *
 * Everything inside one reviewer's turn — admission, the dispatch journal and
 * proof-based recovery, observation, repair, the reminder and continuation,
 * token metering and transcript capture — is the shared agent branch runner's
 * (`agent-branch-runner.ts`); this module adapts a review panel onto it.
 */
import {
  REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS,
  REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS,
  REVIEW_FANOUT_MAX_SNAPSHOT_PATHS,
  reviewersSettled,
  usableReviewerReports,
  type ReviewerModelSelection,
  type ReviewerProvisionalFinding,
  type ReviewerRecord,
  type ReviewWorktreeSnapshotRecord,
} from "@orkestrator/protocol/review-fanout";
import {
  ReviewContractValidationError,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  STRUCTURED_REVIEW_MAX_COVERAGE_GAPS,
  STRUCTURED_REVIEW_MAX_ISSUES,
  safeParseStructuredReviewReport,
  structuredReviewReportBudgetIssues,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultInstruction,
  workflowResultToolName,
  type WorkflowResultSubmissionState,
} from "@orkestrator/protocol/workflow-results";
import type { AgentToolConnection } from "./agent-tools.js";
import type { ArtifactTurnDispatch } from "./workflow-artifact-turns.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  structuredReportRepairPrompt,
  type ReviewWorktreeSnapshot,
} from "./build-pipeline-prompts.js";
import {
  createMultiReviewConsolidationPrompt,
  createMultiReviewerPrompt,
} from "./multi-review-prompts.js";
import {
  DEFAULT_STALL_ABANDON_MS,
  DEFAULT_STALL_WARNING_MS,
  MultiReviewProgressTracker,
  PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
  noProgressElapsedMs,
  stalledMinutes,
} from "./multi-review-progress.js";
import { probeReviewWorktree, REVIEW_WORKTREE_PROBE_ATTEMPTS } from "./review-worktree-probe.js";
import {
  efficiencyPlatform,
  type EfficiencyOwner,
  type MultiReviewEfficiencyObserver,
} from "./multi-review-efficiency.js";
import {
  reviewFanoutConcurrency,
  runBoundedTasks,
  type ReviewFanoutConcurrency,
} from "./review-fanout-scheduler.js";
import { attributeReportFindings } from "./review-fanout-provenance.js";
import {
  clearReviewerAdmission,
  projectReviewerAdmissionQueue,
} from "./review-fanout-admission.js";
import {
  appendProvisionalFindings,
  dropProvisionalFindings,
} from "./review-provisional-findings.js";
import { AGENT_BRANCH_RESULT_COMMIT_NUDGE_MS } from "./agent-branch-observation.js";
import { AgentBranchRunner, unattendedBranchInteraction } from "./agent-branch-runner.js";
import {
  agentBranchNeedsDispatch,
  type AgentBranchHost,
  type AgentBranchPollGate,
} from "./agent-branch-types.js";

// The branch helpers owners import from here.
export { commitProgressObservation } from "./agent-branch-observation.js";
export {
  attachAgentBeforeDispatch,
  resolveUnattendedReviewerInteractions,
} from "./agent-branch-runner.js";

export const MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS = REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS;
export const MAX_REVIEW_IDLE_RESULT_POLLS = REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS;

export function reviewFanoutNowIso(): string {
  return new Date().toISOString();
}

function nowIso(): string {
  return reviewFanoutNowIso();
}

export function reviewFanoutErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The review source is known to differ from the snapshot every reviewer saw. */
export class ReviewSnapshotChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSnapshotChangedError";
  }
}

/**
 * The review source could not be observed at all. Deliberately distinct from
 * drift: it does not mark the snapshot stale, so a retry resumes from the
 * completed reports instead of discarding them.
 */
export class ReviewSnapshotUnverifiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSnapshotUnverifiableError";
  }
}

export function isReviewSnapshotError(error: unknown): boolean {
  return (
    error instanceof ReviewSnapshotChangedError || error instanceof ReviewSnapshotUnverifiableError
  );
}

// ---------------------------------------------------------------------------
// Worktree snapshots
// ---------------------------------------------------------------------------

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Pins the state every reviewer and the consolidation turn will be judged
 * against. `label` names the caller in the failure text, because the same
 * message reaches a Multi Review tab and a build pipeline stage.
 */
export async function captureReviewWorktreeSnapshot(
  invoke: CommandInvoker,
  environmentId: string,
  label: string,
): Promise<ReviewWorktreeSnapshotRecord> {
  const observed = await probeReviewWorktree(
    (command, args) => invoke(command, args),
    environmentId,
    REVIEW_WORKTREE_PROBE_ATTEMPTS,
    // The starting snapshot is the one place content identity is worth its
    // cost: it is the evidence every reviewer prompt quotes.
    { fingerprint: true },
  );
  if (observed.status === "unknown") {
    throw new Error(
      `${label} cannot start because the backend could not capture the environment Git state: ${observed.reason}`,
    );
  }
  if (!observed.fingerprint) {
    throw new Error(
      `${label} cannot start because the worktree probe returned no content fingerprint`,
    );
  }
  const paths = observed.status === "dirty" ? [...observed.paths] : [];
  if (paths.length > REVIEW_FANOUT_MAX_SNAPSHOT_PATHS) {
    throw new Error(
      `${label} cannot start because the worktree has more than ${REVIEW_FANOUT_MAX_SNAPSHOT_PATHS} uncommitted paths`,
    );
  }
  return {
    status: observed.status,
    head: observed.head,
    paths,
    fingerprint: observed.fingerprint,
    capturedAt: nowIso(),
  };
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Set(right);
  return left.every((entry) => remaining.delete(entry)) && remaining.size === 0;
}

/**
 * Fails closed before dispatch when the long-running review source drifted.
 *
 * Drift is judged on HEAD and the uncommitted path set, not on content. The
 * reviewers are explicitly told validation "may write generated artifacts and
 * tool caches", so a byte-level comparison would fail the workflow for doing
 * exactly what it asked for; the path set is also the contract the build
 * pipeline's own validation guard already enforces. The content fingerprint
 * stays on the snapshot as the evidence quoted to reviewers.
 */
export async function assertReviewSnapshotCurrent(
  invoke: CommandInvoker,
  environmentId: string,
  baseline: ReviewWorktreeSnapshotRecord,
  label: string,
): Promise<void> {
  const current = await probeReviewWorktree(
    (command, args) => invoke(command, args),
    environmentId,
  );
  // "Could not look" is not evidence of "has changed". Reporting it as drift
  // would discard every completed report over a transient exec failure.
  if (current.status === "unknown") {
    throw new ReviewSnapshotUnverifiableError(
      `${label} cannot verify its worktree snapshot: ${current.reason}`,
    );
  }
  const currentPaths = current.status === "dirty" ? current.paths : [];
  if (current.head !== baseline.head || !samePathSet(currentPaths, baseline.paths)) {
    throw new ReviewSnapshotChangedError(
      `${label} stopped because the environment worktree changed after the review started. Retry to review the new snapshot.`,
    );
  }
}

/** The prompt-facing projection of a pinned snapshot. */
export function promptWorktreeSnapshot(
  snapshot: ReviewWorktreeSnapshotRecord,
): ReviewWorktreeSnapshot {
  return snapshot.status === "clean"
    ? { status: "clean", head: snapshot.head, fingerprint: snapshot.fingerprint }
    : {
        status: "dirty",
        head: snapshot.head,
        paths: [...snapshot.paths],
        fingerprint: snapshot.fingerprint,
      };
}

// Report provenance lives in review-fanout-provenance.ts; re-exported for owners.
export {
  attributeReportFindings,
  consolidationOverlap,
  consolidationReports,
  consolidationResultContext,
  deriveConsolidatedProvenance,
  reviewerProvenanceLabel,
} from "./review-fanout-provenance.js";

const NO_VALID_REPORT_ERROR = "No reviewer produced a valid report";

/** Summarises why every reviewer failed, deduplicating a shared root cause. */
export function reviewerFailureSummary(reviewers: readonly ReviewerRecord[]): string {
  const reasons = [
    ...new Set(reviewers.flatMap((reviewer) => (reviewer.error ? [reviewer.error] : []))),
  ];
  // A stopped reviewer carries no error, so without this the user who stopped
  // the whole panel would be told the models failed to produce a report.
  const stopped = reviewers.filter((reviewer) => reviewer.status === "cancelled").length;
  if (stopped > 0) {
    reasons.push(`${stopped} reviewer${stopped === 1 ? " was" : "s were"} stopped`);
  }
  if (reasons.length === 0) return NO_VALID_REPORT_ERROR;
  return `${NO_VALID_REPORT_ERROR}: ${reasons.join("; ")}`.slice(0, 4_096);
}

/**
 * Reads a structured-review result as either a report or a contract failure.
 *
 * A provider-side schema rejection is turned into the same
 * {@link ReviewContractValidationError} the local parser raises, so one repair
 * path covers both. Any other provider error is a real fault and is thrown.
 */
export function parseStructuredReportResult(
  result: StructuredOutputResult<unknown>,
  consolidationReviewers?: readonly ReviewerRecord[],
) {
  if (!result.ok) {
    if (
      result.error.code === "schema_retry_exhausted" ||
      result.error.code === "malformed_output"
    ) {
      const detailPath =
        typeof result.error.details?.path === "string" ? result.error.details.path : "$";
      const detailText = result.error.details
        ? ` Provider validation details: ${JSON.stringify(result.error.details)}`
        : "";
      return {
        success: false as const,
        error: new ReviewContractValidationError("structured-review-report", [
          {
            path: detailPath,
            code: "invalid_value",
            message: `${result.error.message}${detailText}`,
          },
        ]),
      };
    }
    throw new Error(result.error.message);
  }
  const parsed = safeParseStructuredReviewReport(result.value);
  if (!parsed.success) return parsed;
  // A shape-valid answer can still be too large to consolidate. Budget
  // feedback goes through the same bounded repair as a schema fault, and
  // never quotes the report back.
  const sourceReports = consolidationReviewers
    ? usableReviewerReports(consolidationReviewers)
    : undefined;
  const budget = structuredReviewReportBudgetIssues(
    parsed.data,
    sourceReports
      ? {
          maxIssues: Math.max(
            STRUCTURED_REVIEW_MAX_ISSUES,
            sourceReports.reduce((total, reviewer) => total + reviewer.report!.issues.length, 0),
          ),
          maxCoverageGaps: Math.max(
            STRUCTURED_REVIEW_MAX_COVERAGE_GAPS,
            sourceReports.reduce(
              (total, reviewer) => total + reviewer.report!.testCoverageGaps.length,
              0,
            ),
          ),
          preserveFindings: true,
        }
      : undefined,
  );
  if (budget.length > 0) {
    return {
      success: false as const,
      error: new ReviewContractValidationError("structured-review-report", budget),
    };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** See {@link ReviewFanoutHost.pollGate}. Scopes are process-local identifiers. */
export type ReviewerPollGate = AgentBranchPollGate;

/**
 * When the panel hands over to consolidation: once every reviewer has settled
 * and at least `minSuccessful` produced a usable report, with the failed
 * reviewers carried as a summary rather than blocking.
 */
export const REVIEW_FANOUT_FAN_IN = Object.freeze({
  wait: "all-settled",
  minSuccessful: 1,
  includeFailures: true,
} as const);

/**
 * A reviewer's provider mode. A sealed package makes the reviewer a read-only
 * plan-mode turn (the runner adds the read-only boundary for `plan`); a review
 * without one, a record from before packages, runs in build mode. Multi Review
 * and the pipeline panel both decide it here.
 */
export function reviewFanoutReviewerMode(reviewPackage: unknown): "plan" | "build" {
  return reviewPackage ? "plan" : "build";
}

/**
 * Everything the fan-out needs from whichever workflow owns it.
 *
 * A host is expected to be cheap to construct per pass: the runner calls it
 * synchronously between awaits and never caches anything across ticks.
 */
export interface ReviewFanoutHost {
  /** Identifies the owning workflow in session keys and interaction fences. */
  readonly workflowId: string;
  readonly targetBranch: string;
  readonly reviewInstruction?: string;
  /** Names the owner in user-facing failure text. */
  readonly label: string;
  /** The environment its reviewers run in. */
  readonly environmentId?: string;
  /** Package consumers use provider plan/read-only mode, including repair turns. */
  readonly reviewerMode?: "plan" | "build";
  /** Durable session key for one reviewer. Must be stable across restarts. */
  sessionKeyFor(reviewer: ReviewerRecord, index: number): string;
  /** Pane title for one reviewer's session. */
  sessionLabelFor(reviewer: ReviewerRecord, index: number): string;
  provider(selection: ReviewerModelSelection): Promise<BuildPipelineProvider>;
  /**
   * `provider`, returned by {@link provider} for this selection, could not
   * reach its transport. A host that caches providers drops that instance (and
   * only that one: a peer may already have replaced it), so the next
   * {@link provider} call reconnects. Disposal waits for its concurrent users.
   */
  providerUnavailable?(
    selection: ReviewerModelSelection,
    provider: BuildPipelineProvider,
  ): Promise<void>;
  /** Trusted policy resolved from the persisted environment, never provider defaults. */
  executionPolicy(): Promise<NativeAgentExecutionPolicy>;
  agentMcp?(
    selection: ReviewerModelSelection,
    resultKey: string,
  ): Promise<AgentToolConnection | undefined>;
  prepareResult?(
    selection: ReviewerModelSelection,
    requestId: string,
    schema: JsonSchema,
  ): Promise<void>;
  supportsToolResult?(selection: ReviewerModelSelection): boolean;
  /**
   * Findings this reviewer reported through `report_finding` since the last
   * pass. A host that provides it offers the tool, and the reviewer's
   * instruction mentions it.
   */
  takeProvisionalFindings?(reviewer: ReviewerRecord): ReviewerProvisionalFinding[];
  readResult?<T>(requestId: string): Promise<StructuredOutputResult<T> | null>;
  /** Bounded delivery state for one slot, projected into the saved record. */
  projectResult?(requestId: string): Promise<WorkflowResultSubmissionState | undefined>;
  /**
   * A result that passed validation but was never committed, with how long it
   * has been held. Lets the runner nudge a live turn whose model validated its
   * report and then stalled on delivery.
   */
  heldResult?(requestId: string): { digest: string; ageMs: number } | undefined;
  /** Owner-held, bounded one-shot marker that survives runner construction. */
  claimResultNudge?(requestId: string): boolean;
  consumeResult?(requestId: string): Promise<void>;
  /** Adds/removes a durable owner-side outbox marker around consumption. */
  stageResultConsumption?(requestId: string): void;
  finishResultConsumption?(requestId: string): void;
  closeResult?(requestId: string): Promise<void>;
  /**
   * Persists the host's own record.
   *
   * The runner serializes every call, so two reviewers advancing concurrently
   * never race one revision-checked write against another. Each call persists
   * the whole in-memory record, including observations staged since the last
   * write.
   */
  save(): Promise<void>;
  /** Throws if this process no longer owns the workflow. */
  assertFence(): Promise<void>;
  /**
   * Verifies the evidence every reviewer admitted this pass will be sent.
   *
   * Called once per pass, before any reviewer that needs its original prompt
   * leaves `pending` or `prepared`. It replaces a verification per reviewer:
   * the whole admission generation shares one exact check. A rejection here is
   * workflow-fatal, like a snapshot error, and no reviewer is dispatched.
   */
  beforeAdmission?(): Promise<void>;
  /**
   * Optional owner-built prompt. The build pipeline uses this to hand every
   * reviewer the same immutable package instead of exposing the live worktree.
   * The reviewer's own text (its lens) must come last, after its position.
   */
  reviewerPrompt?(
    reviewerIndex: number,
    reviewerCount: number,
    reviewer: ReviewerRecord,
  ): Promise<string>;
  /**
   * Re-verifies the pinned worktree and returns the prompt projection of it.
   * Owners choose whether drift is fatal or is recorded for prompt qualification.
   */
  reviewSnapshot?(): Promise<ReviewWorktreeSnapshot>;
  /** True when the owner tolerated live-worktree drift after pinning the snapshot. */
  worktreeChangedDuringReview?(): boolean;
  resolveUnattendedInteractions(
    provider: BuildPipelineProvider,
    providerSessionId: string,
  ): Promise<void>;
  /** Best-effort abort of a session the workflow is discarding. */
  abandonSession(selection: ReviewerModelSelection, providerSessionId: string): Promise<void>;
  /**
   * Elapsed-time gate for the attempt-counted reviewer deadlines (idle result
   * grace, bounded final-usage probes). An observation it does not count
   * leaves the persisted count unchanged, and `exhausted` also ends a grace
   * once the duration it stands for has elapsed. Absent, every poll counts.
   */
  readonly pollGate?: ReviewerPollGate;
  /** Whether this owner persists provider-session usage for reviewer presentation. */
  readonly captureReviewerUsage?: boolean;
  /**
   * Transcript-artifact authority for reviewer turns. With it, each turn gets
   * an artifact grant owned by the reviewer session's own key
   * ({@link sessionKeyFor}) in this environment, delivered with the turn and
   * revoked when the turn settles (`workflow-artifact-turns.ts`).
   */
  readonly artifactTurns?: {
    dispatch: ArtifactTurnDispatch;
    environmentId: string;
    projectId: string;
  };
  /**
   * When false, token-count deltas stay in memory until the owner already has
   * another reason to save. Pipeline fan-out sets this so a streaming meter
   * cannot write the pipeline's control row on every poll.
   */
  readonly persistReviewerUsageImmediately?: boolean;
  /**
   * Lets an owner mirror a reviewer's transcript into its own read model.
   *
   * Called on every pass over a live reviewer, after status is known. The
   * transcript is offered lazily: an owner that has no reason to refresh its
   * copy this pass does not call `readTranscript`, and no provider read
   * happens. `settling` is true when the provider reports the turn is no
   * longer running, so this may be the reviewer's last observation and the
   * owner should keep its final transcript. It must not throw for a transcript
   * it could not read: a reviewer's turn is not the host's rendering.
   */
  onReviewerObserved?(
    reviewer: ReviewerRecord,
    index: number,
    provider: BuildPipelineProvider,
    readTranscript: () => Promise<readonly unknown[]>,
    settling: boolean,
  ): Promise<void>;
  readonly progress: MultiReviewProgressTracker;
  readonly stallWarningMs?: number;
  readonly stallAbandonMs?: number;
  /** Bounded reviewer concurrency; see {@link reviewFanoutConcurrency}. */
  readonly concurrency?: Partial<ReviewFanoutConcurrency>;
  /** Content-free measurement sink. Defaults to a no-op. */
  readonly efficiency?: MultiReviewEfficiencyObserver;
  readonly efficiencyOwner?: EfficiencyOwner;
}

export type ReviewFanoutOutcome =
  /** Reviewers are still working, or this pass stopped early on purpose. */
  | { kind: "working" }
  /** Every reviewer settled and at least one produced a usable report. */
  | { kind: "ready"; reports: ReviewerRecord[] }
  /** Every reviewer settled and none produced a usable report. */
  | { kind: "no-reports"; error: string };

function reviewerSettled(reviewer: ReviewerRecord): boolean {
  return (
    reviewer.status === "completed" ||
    reviewer.status === "failed" ||
    reviewer.status === "cancelled"
  );
}

/**
 * A reviewer about to receive its original, evidence-bearing prompt. A schema
 * repair or an unstick continuation re-uses the evidence the reviewer already
 * has and is deliberately not re-gated on it.
 */
function reviewerNeedsEvidence(reviewer: ReviewerRecord): boolean {
  if (reviewer.status === "pending") return true;
  return (
    reviewer.dispatchState === "prepared" &&
    reviewer.schemaRepairPrompt === undefined &&
    reviewer.continuationPrompt === undefined
  );
}

export const REVIEW_RESULT_COMMIT_NUDGE_MS = AGENT_BRANCH_RESULT_COMMIT_NUDGE_MS;

/**
 * The panel around the shared branch runner: each reviewer is one branch of
 * {@link AgentBranchRunner}, which owns everything inside its turn. What stays
 * here is what only a review panel knows — the evidence check before
 * admission, provisional findings, the admission-queue projection, the
 * review prompt, the structured-review contract and its provenance, and the
 * fan-in outcome.
 */
export class ReviewFanoutRunner {
  private readonly branches: AgentBranchRunner<ReviewerRecord>;

  constructor(private readonly host: ReviewFanoutHost) {
    this.branches = new AgentBranchRunner(reviewBranchHost(host));
  }

  /** Writes staged observations once; see {@link AgentBranchRunner.flushObservations}. */
  flushObservations(): Promise<void> {
    return this.branches.flushObservations();
  }

  /**
   * Advances every unsettled reviewer once.
   *
   * A reviewer is one independent input to the consolidated result, so its
   * failure stays local: the remaining reviewers can still produce a valid
   * report. Reviewers advance concurrently under bounded admission,
   * observation and per-provider limits; a slow or retrying reviewer no longer
   * holds up the rest of the panel. Only a snapshot or evidence fault, or a
   * lost fence, ends the whole pass: the first stops new work from starting,
   * lets in-flight provider calls settle, and is then rethrown.
   */
  async advanceReviewers(reviewers: ReviewerRecord[]): Promise<ReviewFanoutOutcome> {
    const passStartedAt = this.branches.beginPass();
    const live = reviewers.flatMap((reviewer, index) =>
      reviewerSettled(reviewer) ? [] : [{ reviewer, index }],
    );
    if (this.host.beforeAdmission && live.some(({ reviewer }) => reviewerNeedsEvidence(reviewer))) {
      try {
        await this.host.beforeAdmission();
      } catch (error) {
        if (isReviewSnapshotError(error)) await this.abandonLiveReviewers(reviewers);
        throw error;
      }
    }

    // Findings reported since the last pass become observations of this one.
    for (const { reviewer } of live) {
      if (reviewer.status !== "running" || !reviewer.requestId) continue;
      const reported = this.host.takeProvisionalFindings?.(reviewer) ?? [];
      if (appendProvisionalFindings(reviewer, reported)) this.branches.stageObservation();
    }

    let fatal: { error: unknown } | undefined;
    const stats = await runBoundedTasks(
      live.map(({ reviewer, index }) => ({
        reviewer,
        pool: agentBranchNeedsDispatch(reviewer)
          ? ("admission" as const)
          : ("observation" as const),
        group: efficiencyPlatform(reviewer.agent),
        run: async () => {
          try {
            await this.branches.advanceIsolated(reviewer, index, reviewers.length);
          } catch (error) {
            fatal ??= { error };
          }
        },
      })),
      reviewFanoutConcurrency(this.host.concurrency),
      () => fatal === undefined,
      // Each queued reviewer's place, as the scheduler offers slots. Staged
      // only: the next safety commit (a started reviewer's session) carries it.
      (waiting) => {
        const queued = waiting.flatMap((task) =>
          task.reviewer.status === "pending" ? [task.reviewer] : [],
        );
        if (projectReviewerAdmissionQueue(reviewers, queued)) this.branches.stageObservation();
      },
    );
    // A reviewer still pending here (a retryable setup failure, or a pass that
    // stopped early) waits for the next pass, in panel order.
    if (
      projectReviewerAdmissionQueue(
        reviewers,
        reviewers.filter((reviewer) => reviewer.status === "pending"),
      )
    ) {
      this.branches.stageObservation();
    }
    this.branches.record({
      operation: "reviewer.task",
      reviewers: reviewers.length,
      count: stats.maxActive,
      elapsedMs: Date.now() - passStartedAt,
    });
    if (fatal) {
      if (isReviewSnapshotError(fatal.error)) {
        // These end the whole pass rather than one reviewer, so the abort the
        // per-reviewer handler performs has to happen here instead.
        await this.abandonLiveReviewers(reviewers);
      }
      throw fatal.error;
    }
    await this.branches.flushObservations();

    if (!reviewersSettled(reviewers)) return { kind: "working" };
    const reports = usableReviewerReports(reviewers);
    if (reports.length >= REVIEW_FANOUT_FAN_IN.minSuccessful) return { kind: "ready", reports };
    // Reviewers fail locally, so an environment-wide cause (an unreachable
    // bridge, a deleted worktree) reaches here as the same message on every
    // reviewer. Carry the distinct causes up rather than reporting a bare
    // "no valid report", which reads as a model-quality problem instead.
    return { kind: "no-reports", error: reviewerFailureSummary(reviewers) };
  }

  /**
   * Aborts reviewer turns the workflow is about to stop supervising.
   *
   * A snapshot failure escapes the per-reviewer handler that normally does
   * this, and unlike a lost controller fence there is no other controller that
   * will inherit the sessions. Left alone they keep running against the very
   * worktree whose state could not be trusted. The session ids are kept so the
   * read-only transcripts stay reachable.
   */
  async abandonLiveReviewers(reviewers: readonly ReviewerRecord[]): Promise<void> {
    await this.branches.abandonLive(reviewers);
  }
}

/**
 * A review panel's owner, as the shared branch runner sees it: the
 * reviewer prompt, the structured-review contract, provenance on acceptance
 * and the reviewer's words in failure text. Everything else passes through.
 */
function reviewBranchHost(host: ReviewFanoutHost): AgentBranchHost<ReviewerRecord> {
  const toolName = workflowResultToolName("review-report");
  return {
    workflowId: host.workflowId,
    ...(host.environmentId ? { environmentId: host.environmentId } : {}),
    sessionPhase: "review",
    ...(host.reviewerMode ? { mode: host.reviewerMode } : {}),
    wording: {
      subject: "reviewer",
      resultLabel: "structured report",
      workLabel: "review",
      validResult: "a valid report",
      stallStopReason: "so the rest of the review could continue",
    },
    sessionKeyFor: (reviewer, index) => host.sessionKeyFor(reviewer, index),
    sessionLabelFor: (reviewer, index) => host.sessionLabelFor(reviewer, index),
    interactionContext: (reviewer, fence) =>
      unattendedBranchInteraction({
        origin: "automated-review",
        reviewerSession: true,
        phase: "review",
        workflowId: host.workflowId,
        provider: reviewer.agent,
        fence,
      }),
    provider: (reviewer) => host.provider(reviewer),
    ...(host.providerUnavailable
      ? {
          providerUnavailable: (reviewer: ReviewerRecord, provider: BuildPipelineProvider) =>
            host.providerUnavailable!(reviewer, provider),
        }
      : {}),
    executionPolicy: () => host.executionPolicy(),
    ...(host.agentMcp
      ? {
          agentMcp: (reviewer: ReviewerRecord, resultKey: string) =>
            host.agentMcp!(reviewer, resultKey),
        }
      : {}),
    ...(host.prepareResult
      ? {
          prepareResult: (reviewer: ReviewerRecord, requestId: string, schema: JsonSchema) =>
            host.prepareResult!(reviewer, requestId, schema),
        }
      : {}),
    ...(host.supportsToolResult
      ? { supportsToolResult: (reviewer: ReviewerRecord) => host.supportsToolResult!(reviewer) }
      : {}),
    ...(host.readResult
      ? {
          readResult: <T>(requestId: string) => host.readResult!<T>(requestId),
        }
      : {}),
    ...(host.projectResult
      ? { projectResult: (requestId: string) => host.projectResult!(requestId) }
      : {}),
    ...(host.heldResult ? { heldResult: (requestId: string) => host.heldResult!(requestId) } : {}),
    ...(host.claimResultNudge
      ? { claimResultNudge: (requestId: string) => host.claimResultNudge!(requestId) }
      : {}),
    ...(host.consumeResult
      ? { consumeResult: (requestId: string) => host.consumeResult!(requestId) }
      : {}),
    ...(host.stageResultConsumption
      ? {
          stageResultConsumption: (requestId: string) => host.stageResultConsumption!(requestId),
        }
      : {}),
    ...(host.finishResultConsumption
      ? {
          finishResultConsumption: (requestId: string) => host.finishResultConsumption!(requestId),
        }
      : {}),
    ...(host.closeResult
      ? { closeResult: (requestId: string) => host.closeResult!(requestId) }
      : {}),
    save: () => host.save(),
    assertFence: () => host.assertFence(),
    branchPrompt: async (reviewer, index, count) => {
      if (host.reviewerPrompt) return host.reviewerPrompt(index, count, reviewer);
      if (!host.reviewSnapshot) {
        throw new Error(`${host.label} has no reviewer evidence source`);
      }
      const worktree = await host.reviewSnapshot();
      return createMultiReviewerPrompt({
        targetBranch: host.targetBranch,
        reviewInstruction: host.reviewInstruction,
        reviewerNumber: index + 1,
        reviewerCount: count,
        worktree,
        worktreeChangedDuringReview: host.worktreeChangedDuringReview?.() === true,
        lens: reviewer.lens,
      });
    },
    resultSchema: () => STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema,
    resultInstruction: (_reviewer, requestId, agentMcp) =>
      workflowResultInstruction("review-report", requestId, {
        capability: agentMcp?.workflowResultCapability,
        provisionalFindings: host.takeProvisionalFindings !== undefined,
      }),
    resultTurn: (_reviewer, requestId) => ({
      toolName,
      prepare: { workflowResultTool: toolName },
      send: { workflowResultTool: toolName, workflowResultKey: requestId },
    }),
    parseResult: (_reviewer, result) => parseStructuredReportResult(result),
    repairPrompt: (_reviewer, issues, attempt, maxAttempts) =>
      structuredReportRepairPrompt(issues, attempt, maxAttempts),
    acceptResult: (reviewer, data) => {
      reviewer.report = attributeReportFindings(data as StructuredReviewReport, reviewer);
      // The accepted report is the reviewer's findings; the provisional ones it
      // reported on the way were progress and are replaced, not merged.
      dropProvisionalFindings(reviewer);
    },
    commitNudgeText: (_reviewer, requestId, digest) =>
      `Your structured report already passed \`${WORKFLOW_RESULT_VALIDATION_TOOL_NAME}\`. If it is final, commit it now by calling \`${toolName}\` with resultKey ${JSON.stringify(requestId)} (and the capability from your instructions, if one was given) and \`validatedDigest\` ${JSON.stringify(digest)}; leave \`result\` out so the large object is not sent again. If a call is rejected as unparseable, the brace count is off by one: recount and call again without shortening the report.`,
    clearAdmission: (reviewer) => {
      clearReviewerAdmission(reviewer);
    },
    resolveUnattendedInteractions: (provider, providerSessionId) =>
      host.resolveUnattendedInteractions(provider, providerSessionId),
    abandonSession: (reviewer, providerSessionId) =>
      host.abandonSession(reviewer, providerSessionId),
    isPassFatal: isReviewSnapshotError,
    ...(host.pollGate ? { pollGate: host.pollGate } : {}),
    ...(host.captureReviewerUsage !== undefined ? { captureUsage: host.captureReviewerUsage } : {}),
    ...(host.persistReviewerUsageImmediately !== undefined
      ? { persistUsageImmediately: host.persistReviewerUsageImmediately }
      : {}),
    ...(host.artifactTurns ? { artifactTurns: host.artifactTurns } : {}),
    ...(host.onReviewerObserved
      ? {
          onObserved: (
            reviewer: ReviewerRecord,
            index: number,
            provider: BuildPipelineProvider,
            readTranscript: () => Promise<readonly unknown[]>,
            settling: boolean,
          ) => host.onReviewerObserved!(reviewer, index, provider, readTranscript, settling),
        }
      : {}),
    progress: host.progress,
    ...(host.stallWarningMs !== undefined ? { stallWarningMs: host.stallWarningMs } : {}),
    ...(host.stallAbandonMs !== undefined ? { stallAbandonMs: host.stallAbandonMs } : {}),
    ...(host.concurrency ? { concurrency: host.concurrency } : {}),
    ...(host.efficiency ? { efficiency: host.efficiency } : {}),
    ...(host.efficiencyOwner ? { efficiencyOwner: host.efficiencyOwner } : {}),
  };
}

/** Re-exported so hosts do not each import the progress module directly. */
export {
  MultiReviewProgressTracker as ReviewProgressTracker,
  DEFAULT_STALL_ABANDON_MS,
  DEFAULT_STALL_WARNING_MS,
  PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
  noProgressElapsedMs,
  stalledMinutes,
};
export { createMultiReviewConsolidationPrompt as createReviewConsolidationPrompt };
