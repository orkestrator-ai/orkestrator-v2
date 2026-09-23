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
 * The runner deliberately holds no state of its own beyond the host. Every
 * reviewer field it writes is a durable one, because the turn it describes runs
 * inside the environment and outlives this process.
 */
import { randomUUID } from "node:crypto";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  REVIEW_FANOUT_MAX_IDLE_RESULT_POLLS,
  REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS,
  REVIEW_FANOUT_MAX_SCHEMA_REPAIR_ATTEMPTS,
  REVIEW_FANOUT_MAX_SNAPSHOT_PATHS,
  reviewersSettled,
  usableReviewerReports,
  type ReviewerModelSelection,
  type ReviewerRecord,
  type ReviewWorktreeSnapshotRecord,
} from "@orkestrator/protocol/review-fanout";
import {
  ReviewContractValidationError,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  safeParseStructuredReviewReport,
  structuredReviewReportBudgetIssues,
  stripStructuredReviewProvenance,
  type ReviewContractValidationIssue,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  workflowResultInstruction,
  workflowResultToolName,
  type WorkflowResultSubmissionState,
} from "@orkestrator/protocol/workflow-results";
import type { AgentToolConnection } from "./agent-tools.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  AmbiguousPromptDispatchError,
  ProviderDispatchPreparationError,
  readProviderStatus,
  type BuildPipelineProvider,
  type ProviderPrepareDispatchOptions,
} from "./build-pipeline-provider.js";
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
  type ProgressObservation,
} from "./multi-review-progress.js";
import { probeReviewWorktree, REVIEW_WORKTREE_PROBE_ATTEMPTS } from "./review-worktree-probe.js";
import {
  efficiencyPlatform,
  recordEfficiency,
  type EfficiencyEvent,
  type EfficiencyOwner,
  type MultiReviewEfficiencyObserver,
} from "./multi-review-efficiency.js";
import {
  reviewFanoutConcurrency,
  runBoundedTasks,
  type ReviewFanoutConcurrency,
} from "./review-fanout-scheduler.js";
import { PassTranscriptReader } from "./review-fanout-transcript.js";

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

/**
 * The model to dispatch a reviewer's turn under, or `undefined` for "unset".
 *
 * A reviewer that pinned nothing says so explicitly, because the placeholder
 * cannot: `"default"` is a real Claude catalog id — the bridge resolves it to
 * Opus with a 1M context — so for Claude it is a selection to be forwarded,
 * while for every other harness it is only the launcher's stand-in for a
 * catalogue it does not have yet. This is the same line `stepModel` draws for
 * a single-reviewer review step.
 */
function reviewerModel(reviewer: ReviewerRecord): string | undefined {
  if (reviewer.modelUnpinned) return undefined;
  return reviewer.model === "default" && reviewer.agent !== "claude" ? undefined : reviewer.model;
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

/** A pre-dispatch policy read can be retried because no provider request ran. */
class ReviewerPolicyUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Reviewer execution policy is temporarily unavailable", { cause });
    this.name = "ReviewerPolicyUnavailableError";
  }
}

/** Broker or permission setup failed before the prompt request was written. */
class ReviewerDispatchSetupError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error ? cause.message : "Reviewer dispatch setup is temporarily unavailable",
      { cause },
    );
    this.name = "ReviewerDispatchSetupError";
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

// ---------------------------------------------------------------------------
// Report provenance
// ---------------------------------------------------------------------------

export function reviewerProvenanceLabel(
  reviewer: Pick<ReviewerModelSelection, "agent" | "model">,
): string {
  return `${reviewer.agent}/${reviewer.model}`;
}

/** Provider output cannot authoritatively identify its own launch model. */
export function attributeReportFindings(
  report: StructuredReviewReport,
  reviewer: Pick<ReviewerModelSelection, "agent" | "model">,
): StructuredReviewReport {
  const clean = stripStructuredReviewProvenance(report);
  const label = reviewerProvenanceLabel(reviewer);
  return {
    ...clean,
    issues: clean.issues.map((issue) => ({ ...issue, reviewModels: [label] })),
    testCoverageGaps: clean.testCoverageGaps.map((gap) => ({
      ...gap,
      reviewModels: [label],
    })),
  };
}

type SourceFindingKind = "issue" | "coverage-gap";

interface ProvenanceSource {
  kind: SourceFindingKind;
  model: string;
}

function sourceFindingId(
  reviewerIndex: number,
  kind: SourceFindingKind,
  findingIndex: number,
): string {
  return `reviewer-${reviewerIndex + 1}/${kind}-${findingIndex + 1}`;
}

export function consolidationReports(
  reviewers: readonly ReviewerRecord[],
): Parameters<typeof createMultiReviewConsolidationPrompt>[0]["reports"] {
  return reviewers.flatMap((reviewer, reviewerIndex) => {
    if (reviewer.status !== "completed" || !reviewer.report) return [];
    return [
      {
        reviewerId: reviewer.id,
        agent: reviewer.agent,
        model: reviewer.model,
        report: {
          ...reviewer.report,
          issues: reviewer.report.issues.map((issue, findingIndex) => ({
            ...issue,
            reviewSourceIds: [sourceFindingId(reviewerIndex, "issue", findingIndex)],
          })),
          testCoverageGaps: reviewer.report.testCoverageGaps.map((gap, findingIndex) => ({
            ...gap,
            reviewSourceIds: [sourceFindingId(reviewerIndex, "coverage-gap", findingIndex)],
          })),
        },
      },
    ];
  });
}

function provenanceSources(
  reviewers: readonly ReviewerRecord[],
): ReadonlyMap<string, ProvenanceSource> {
  const sources = new Map<string, ProvenanceSource>();
  reviewers.forEach((reviewer, reviewerIndex) => {
    if (reviewer.status !== "completed" || !reviewer.report) return;
    const model = reviewerProvenanceLabel(reviewer);
    reviewer.report.issues.forEach((_issue, findingIndex) => {
      sources.set(sourceFindingId(reviewerIndex, "issue", findingIndex), {
        kind: "issue",
        model,
      });
    });
    reviewer.report.testCoverageGaps.forEach((_gap, findingIndex) => {
      sources.set(sourceFindingId(reviewerIndex, "coverage-gap", findingIndex), {
        kind: "coverage-gap",
        model,
      });
    });
  });
  return sources;
}

export function consolidationResultContext(reviewers: readonly ReviewerRecord[]): {
  type: "consolidated-review";
  sources: Record<string, SourceFindingKind>;
} {
  return {
    type: "consolidated-review",
    sources: Object.fromEntries(
      Array.from(provenanceSources(reviewers), ([sourceId, source]) => [sourceId, source.kind]),
    ),
  };
}

export function deriveConsolidatedProvenance(
  report: StructuredReviewReport,
  reviewers: readonly ReviewerRecord[],
): { report: StructuredReviewReport; issues: ReviewContractValidationIssue[] } {
  const issues: ReviewContractValidationIssue[] = [];
  const sources = provenanceSources(reviewers);
  const inspect = (
    reviewModels: string[] | undefined,
    reviewSourceIds: string[] | undefined,
    kind: SourceFindingKind,
    path: string,
  ): string[] => {
    if (reviewModels?.length) {
      issues.push({
        path: `${path}.reviewModels`,
        code: "invalid_value",
        message: "Consolidated findings must cite source IDs; the backend derives review models.",
      });
    }
    if (!reviewSourceIds?.length) {
      issues.push({
        path: `${path}.reviewSourceIds`,
        code: "missing_field",
        message: "Every consolidated finding must cite at least one source finding ID.",
      });
      return [];
    }
    const models: string[] = [];
    reviewSourceIds.forEach((sourceId, index) => {
      const source = sources.get(sourceId);
      if (!source || source.kind !== kind) {
        issues.push({
          path: `${path}.reviewSourceIds[${index}]`,
          code: "invalid_value",
          message: `Source finding ${JSON.stringify(sourceId)} does not identify a ${kind} in the supplied reviewer reports.`,
        });
      } else if (!models.includes(source.model)) {
        models.push(source.model);
      }
    });
    return models;
  };

  const derived = stripStructuredReviewProvenance(report);
  return {
    issues,
    report: {
      ...derived,
      issues: report.issues.map((finding, index) => ({
        ...derived.issues[index]!,
        reviewModels: inspect(
          finding.reviewModels,
          finding.reviewSourceIds,
          "issue",
          `$.issues[${index}]`,
        ),
      })),
      testCoverageGaps: report.testCoverageGaps.map((finding, index) => ({
        ...derived.testCoverageGaps[index]!,
        reviewModels: inspect(
          finding.reviewModels,
          finding.reviewSourceIds,
          "coverage-gap",
          `$.testCoverageGaps[${index}]`,
        ),
      })),
    },
  };
}

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
export function parseStructuredReportResult(result: StructuredOutputResult<unknown>) {
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
  const budget = structuredReviewReportBudgetIssues(parsed.data);
  if (budget.length > 0) {
    return {
      success: false as const,
      error: new ReviewContractValidationError("structured-review-report", budget),
    };
  }
  return parsed;
}

/**
 * Apply a probe to the durable progress clocks.
 *
 * `reset` — the transcript moved; the stall clock starts from now.
 * `hold` — first comparable sample of a session that has no clock yet; the
 * caller must not treat it as "unchanged" or a `stallAbandonMs: 0` test would
 * fail a reviewer on its first successful read.
 * `evaluate` — unchanged, failed, throttled, or a restart of a session that
 * already has a durable clock. The caller then applies the stall thresholds.
 */
export function commitProgressObservation(
  target: { progressAt?: string; stalledSince?: string; progressDigest?: string },
  observation: ProgressObservation,
): "reset" | "hold" | "evaluate" {
  if (observation.probed && observation.digest) {
    target.progressDigest = observation.digest;
  }
  if (observation.changed) {
    target.progressAt = nowIso();
    delete target.stalledSince;
    return "reset";
  }
  if (observation.baselineEstablished && target.progressAt === undefined) {
    target.progressAt = nowIso();
    return "hold";
  }
  return "evaluate";
}

/**
 * Attach the provider's agent process before a prompt is written.
 *
 * Best-effort by contract: the prompt request performs the same work and is the
 * one that answers authoritatively, so a failure here is left for it to report
 * rather than pre-empting it.
 */
export async function attachAgentBeforeDispatch(
  provider: BuildPipelineProvider,
  providerSessionId: string,
  options?: ProviderPrepareDispatchOptions,
): Promise<void> {
  try {
    await provider.prepareDispatch?.(providerSessionId, options);
  } catch (error) {
    console.warn(
      "[review-fanout] Attaching the agent before dispatch failed:",
      reviewFanoutErrorMessage(error),
    );
  }
}

/**
 * Answers every interaction a reviewer session is parked on.
 *
 * Reviewers run unattended by construction — nobody is watching a fan-out of
 * eight sessions — so a request that would block the turn is declined, and one
 * that would grant access is denied. Both are fail-closed: an unanswered
 * request wedges the reviewer, and the review phase does not advance while any
 * reviewer is still running.
 *
 * Deliberately *not* the build pipeline's own `enforcePendingInteraction`,
 * which journals through a single `pendingInteractionResolution` slot on the
 * pipeline. That slot has one owner; N concurrent reviewers would contend for
 * it and the guard would reject every session but one.
 */
export async function resolveUnattendedReviewerInteractions(
  provider: BuildPipelineProvider,
  providerSessionId: string,
  assertFence: () => Promise<void>,
): Promise<void> {
  if (!provider.interactions) return;
  const snapshot = await provider.interactions.listPendingInteractions(providerSessionId);
  await assertFence();
  for (const request of snapshot.requests) {
    const action =
      request.kind === "question" ||
      request.kind === "mcp-form" ||
      request.kind === "elicitation" ||
      request.kind === "terminal-selection"
        ? ("decline" as const)
        : ("deny" as const);
    await provider.interactions.resolveInteraction(providerSessionId, request.id, {
      version: 1,
      interactionId: request.id,
      sessionId: providerSessionId,
      action,
      resolvedAt: Date.now(),
    });
    await assertFence();
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

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
  /** Package consumers use provider plan/read-only mode, including repair turns. */
  readonly reviewerMode?: "plan" | "build";
  /** Durable session key for one reviewer. Must be stable across restarts. */
  sessionKeyFor(reviewer: ReviewerRecord, index: number): string;
  /** Pane title for one reviewer's session. */
  sessionLabelFor(reviewer: ReviewerRecord, index: number): string;
  provider(selection: ReviewerModelSelection): Promise<BuildPipelineProvider>;
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
  readResult?<T>(requestId: string): Promise<StructuredOutputResult<T> | null>;
  /** Bounded delivery state for one slot, projected into the saved record. */
  projectResult?(requestId: string): Promise<WorkflowResultSubmissionState | undefined>;
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
   */
  reviewerPrompt?(reviewerIndex: number, reviewerCount: number): Promise<string>;
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
  /** Whether this owner persists provider-session usage for reviewer presentation. */
  readonly captureReviewerUsage?: boolean;
  /**
   * When false, token-count deltas stay in memory until the owner already has
   * another reason to save. Pipeline fan-out sets this so a streaming meter
   * cannot rewrite the whole build-pipelines file on every poll.
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

/** A reviewer whose next step is session creation or prompt dispatch. */
function reviewerNeedsDispatch(reviewer: ReviewerRecord): boolean {
  return (
    reviewer.status === "pending" ||
    reviewer.dispatchState === "prepared" ||
    reviewer.dispatchState === "dispatching"
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

export class ReviewFanoutRunner {
  /** Tail of the serialized commit queue; never rejects. */
  private commitTail: Promise<void> = Promise.resolve();
  /** An observation changed the in-memory record since the last write. */
  private observationStaged = false;
  private passStartedAt = Date.now();

  constructor(private readonly host: ReviewFanoutHost) {}

  private stallWarningMs(): number {
    return this.host.stallWarningMs ?? DEFAULT_STALL_WARNING_MS;
  }

  private stallAbandonMs(): number {
    return this.host.stallAbandonMs ?? DEFAULT_STALL_ABANDON_MS;
  }

  private record(event: Omit<EfficiencyEvent, "owner">): void {
    recordEfficiency(this.host.efficiency, {
      owner: this.host.efficiencyOwner ?? "multi-review",
      phase: "reviewing",
      ...event,
    });
  }

  /**
   * Immediate, durable write of a safety transition: session identity, the
   * dispatch journal, an accepted result, or a terminal reviewer state.
   *
   * Serialized with every other write this runner makes, so concurrent
   * reviewers cannot lose one another's updates. The caller awaits its own
   * commit before its next fallible operation — that is what keeps
   * `dispatching` durable before `send`.
   */
  private commit(): Promise<void> {
    const run = this.commitTail.then(async () => {
      const staged = this.observationStaged;
      // Whatever was staged rides on this write.
      this.observationStaged = false;
      const started = Date.now();
      try {
        await this.host.save();
      } catch (error) {
        this.observationStaged ||= staged;
        throw error;
      }
      this.record({ operation: "workflow.save_safety", elapsedMs: Date.now() - started });
    });
    this.commitTail = run.catch(() => undefined);
    return run;
  }

  /**
   * Marks an observational change — progress digest and clock, token usage,
   * the stall warning — for the single checkpoint at the end of the pass. The
   * change is already on the in-memory record, so any safety commit before
   * then carries it too.
   */
  private stageObservation(): void {
    this.observationStaged = true;
    this.record({ operation: "workflow.observation_staged" });
  }

  /**
   * Writes staged observations once. A failure other than a lost fence is
   * logged, not thrown: an observation is recoverable from the provider on the
   * next pass, and must never turn an already-settled result into a retry.
   */
  async flushObservations(): Promise<void> {
    const run = this.commitTail.then(async () => {
      if (!this.observationStaged) return;
      this.observationStaged = false;
      const started = Date.now();
      try {
        await this.host.save();
      } catch (error) {
        this.observationStaged = true;
        throw error;
      }
      this.record({ operation: "workflow.save_observation", elapsedMs: Date.now() - started });
    });
    this.commitTail = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      if (this.isFatal(error)) throw error;
      console.warn(
        "[review-fanout] Checkpointing reviewer observations failed:",
        reviewFanoutErrorMessage(error),
      );
    }
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
    this.passStartedAt = Date.now();
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

    let fatal: { error: unknown } | undefined;
    const stats = await runBoundedTasks(
      live.map(({ reviewer, index }) => ({
        pool: reviewerNeedsDispatch(reviewer) ? ("admission" as const) : ("observation" as const),
        group: efficiencyPlatform(reviewer.agent),
        run: async () => {
          try {
            await this.advanceReviewerIsolated(reviewer, index, reviewers.length);
          } catch (error) {
            fatal ??= { error };
          }
        },
      })),
      reviewFanoutConcurrency(this.host.concurrency),
      () => fatal === undefined,
    );
    this.record({
      operation: "reviewer.task",
      reviewers: reviewers.length,
      count: stats.maxActive,
      elapsedMs: Date.now() - this.passStartedAt,
    });
    if (fatal) {
      if (isReviewSnapshotError(fatal.error)) {
        // These end the whole pass rather than one reviewer, so the abort the
        // per-reviewer handler performs has to happen here instead.
        await this.abandonLiveReviewers(reviewers);
      }
      throw fatal.error;
    }
    await this.flushObservations();

    if (!reviewersSettled(reviewers)) return { kind: "working" };
    const reports = usableReviewerReports(reviewers);
    if (reports.length > 0) return { kind: "ready", reports };
    // Reviewers fail locally, so an environment-wide cause (an unreachable
    // bridge, a deleted worktree) reaches here as the same message on every
    // reviewer. Carry the distinct causes up rather than reporting a bare
    // "no valid report", which reads as a model-quality problem instead.
    return { kind: "no-reports", error: reviewerFailureSummary(reviewers) };
  }

  /**
   * One reviewer's advance inside its own failure boundary. Rethrows only
   * what must end the pass: snapshot/evidence faults and a lost fence.
   */
  private async advanceReviewerIsolated(
    reviewer: ReviewerRecord,
    index: number,
    reviewerCount: number,
  ): Promise<void> {
    try {
      await this.advanceReviewer(reviewer, index, reviewerCount);
    } catch (error) {
      if (isReviewSnapshotError(error)) throw error;
      if (this.isFatal(error)) {
        this.record({ operation: "reviewer.task", outcome: "fenced" });
        throw error;
      }
      if (
        error instanceof ReviewerPolicyUnavailableError ||
        error instanceof ReviewerDispatchSetupError
      ) {
        // The reviewer is still durably prepared. Leave it retryable instead
        // of converting a pre-prompt failure into a terminal review result;
        // its peers carry on regardless.
        this.record({ operation: "reviewer.task", outcome: "retryable" });
        return;
      }
      // The failure may have been raised while the provider turn was still
      // executing. Abort the session best-effort so that turn cannot keep
      // running through consolidation; the session id is kept so the
      // read-only transcript stays reachable and a later retry can abort
      // again without harm.
      if (reviewer.providerSessionId) {
        await this.host.abandonSession(reviewer, reviewer.providerSessionId);
        this.host.progress.forget(reviewer.providerSessionId);
      }
      reviewer.status = "failed";
      reviewer.error = reviewFanoutErrorMessage(error).slice(0, 4_096);
      reviewer.completedAt = nowIso();
      delete reviewer.idleResultPolls;
      delete reviewer.stalledSince;
      this.record({ operation: "reviewer.task", outcome: "failed" });
      await this.commit();
    }
  }

  /**
   * Errors that must not be absorbed into one reviewer's `error` field.
   *
   * A lost controller lease means this process no longer owns the workflow, so
   * writing to it at all would race the owner that does. Hosts name their own
   * fence error by class name because the runner cannot import theirs.
   */
  private isFatal(error: unknown): boolean {
    return error instanceof Error && error.name.endsWith("FenceError");
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
    await Promise.all(
      reviewers
        .filter((reviewer) => reviewer.status === "running" && reviewer.providerSessionId)
        .map((reviewer) => this.host.abandonSession(reviewer, reviewer.providerSessionId!)),
    );
  }

  /**
   * Advances one reviewer. `stop` means this reviewer has nothing more to do
   * this pass (a parked dispatch, a queued repair); its peers are unaffected.
   */
  private async advanceReviewer(
    reviewer: ReviewerRecord,
    index: number,
    reviewerCount: number,
  ): Promise<"continue" | "stop"> {
    const host = this.host;
    const provider = await host.provider(reviewer);
    await host.assertFence();
    if (reviewer.status === "pending") {
      const sessionKey = host.sessionKeyFor(reviewer, index);
      const createStarted = Date.now();
      const providerSessionId = await provider.createSession(
        "review",
        host.sessionLabelFor(reviewer, index),
        {
          clientSessionKey: sessionKey,
          mode: host.reviewerMode ?? "build",
          ...(host.reviewerMode === "plan" ? { readOnly: true } : {}),
          reviewerSession: true,
          model: reviewerModel(reviewer),
          effort: reviewer.reasoningEffort,
          ...(typeof reviewer.fastMode === "boolean" ? { fastMode: reviewer.fastMode } : {}),
          policy: await host.executionPolicy(),
          interaction: this.interactionContext(reviewer, sessionKey),
        },
      );
      this.record({
        operation: "reviewer.create",
        platform: efficiencyPlatform(reviewer.agent),
        elapsedMs: Date.now() - createStarted,
      });
      await host.assertFence();
      reviewer.sessionKey = sessionKey;
      reviewer.providerSessionId = providerSessionId;
      reviewer.requestId = randomUUID();
      reviewer.dispatchState = "prepared";
      reviewer.resultTransport =
        host.prepareResult && (host.supportsToolResult?.(reviewer) ?? true)
          ? "tool-v1"
          : "structured-output-v1";
      reviewer.resultSubmission = reviewer.resultTransport === "tool-v1" ? "preparing" : undefined;
      reviewer.status = "running";
      reviewer.startedAt = nowIso();
      delete reviewer.tokenCount;
      delete reviewer.usageFinalizationPolls;
      delete reviewer.progressAt;
      delete reviewer.progressDigest;
      delete reviewer.stalledSince;
      delete reviewer.continuationPrompt;
      await this.commit();
    }
    if (!reviewer.providerSessionId || !reviewer.requestId) return "continue";
    provider.registerSession?.(
      reviewer.providerSessionId,
      this.interactionContext(reviewer, reviewer.sessionKey),
    );
    if (reviewer.dispatchState === "prepared") {
      // Built before the dispatch is journaled: the worktree probe is a command
      // round trip that can be slow or fail, and nothing about it is ambiguous
      // while `dispatchState` is still `prepared`.
      //
      // A schema repair re-sends a prompt this reviewer already answered, so it
      // needs no snapshot. Gating it would turn an already-handled formatting
      // retry into a whole-workflow failure over drift the reviewer's own
      // authorised validation writes caused.
      let prompt = reviewer.schemaRepairPrompt ?? reviewer.continuationPrompt;
      if (!prompt) {
        if (host.reviewerPrompt) {
          prompt = await host.reviewerPrompt(index, reviewerCount);
        } else {
          if (!host.reviewSnapshot) {
            throw new Error(`${host.label} has no reviewer evidence source`);
          }
          const worktree = await host.reviewSnapshot();
          prompt = createMultiReviewerPrompt({
            targetBranch: host.targetBranch,
            reviewInstruction: host.reviewInstruction,
            reviewerNumber: index + 1,
            reviewerCount,
            worktree,
            worktreeChangedDuringReview: host.worktreeChangedDuringReview?.() === true,
          });
        }
        this.record({ operation: "reviewer.prompt", bytes: Buffer.byteLength(prompt, "utf8") });
      }
      await host.assertFence();
      const agentMcp =
        reviewer.resultTransport === "tool-v1"
          ? await host.agentMcp?.(reviewer, reviewer.requestId)
          : undefined;
      if (reviewer.resultTransport === "tool-v1" && host.prepareResult) {
        await host.prepareResult(
          reviewer,
          reviewer.requestId,
          STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema,
        );
      }
      let reviewShellPolicy: NativeAgentExecutionPolicy | undefined;
      if (host.reviewerMode === "plan" && reviewer.agent === "opencode") {
        try {
          // Resolve every fallible argument before opening the at-most-once
          // window. Once `dispatching` is saved, the next await must be send.
          reviewShellPolicy = await host.executionPolicy();
        } catch (error) {
          throw new ReviewerPolicyUnavailableError(error);
        }
      }
      // Attach after the connection is resolved so broker registration happens
      // outside the at-most-once window.
      await attachAgentBeforeDispatch(
        provider,
        reviewer.providerSessionId,
        agentMcp
          ? {
              agentMcp,
              workflowResultTool: workflowResultToolName("review-report"),
            }
          : undefined,
      );
      reviewer.dispatchState = "dispatching";
      // Other reviewers may be committing concurrently; this reviewer's own
      // journal is what matters. Its `dispatching` write is durable once this
      // await resolves, and `send` is the next reviewer-local fallible call.
      await this.commit();
      const sendStarted = Date.now();
      try {
        await provider.send(
          reviewer.providerSessionId,
          reviewer.resultTransport === "tool-v1"
            ? `${prompt}\n\n${workflowResultInstruction("review-report", reviewer.requestId, {
                capability: agentMcp?.workflowResultCapability,
              })}`
            : prompt,
          {
            requestId: reviewer.requestId,
            schema:
              reviewer.resultTransport === "tool-v1"
                ? undefined
                : (STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema),
            mode: host.reviewerMode ?? "build",
            ...(host.reviewerMode === "plan" ? { readOnly: true } : {}),
            ...(reviewShellPolicy ? { reviewShellPolicy } : {}),
            model: reviewerModel(reviewer),
            effort: reviewer.reasoningEffort,
            ...(typeof reviewer.fastMode === "boolean" ? { fastMode: reviewer.fastMode } : {}),
            ...(agentMcp ? { agentMcp } : {}),
            ...(agentMcp ? { workflowResultTool: workflowResultToolName("review-report") } : {}),
          },
        );
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) {
          this.record({
            operation: "reviewer.send",
            outcome: "ambiguous",
            platform: efficiencyPlatform(reviewer.agent),
            elapsedMs: Date.now() - sendStarted,
          });
          return "stop";
        }
        reviewer.dispatchState = "prepared";
        await this.commit();
        if (error instanceof ProviderDispatchPreparationError) {
          throw new ReviewerDispatchSetupError(error);
        }
        throw error;
      }
      const sentAt = Date.now();
      this.record({
        operation: "reviewer.send",
        outcome: "success",
        platform: efficiencyPlatform(reviewer.agent),
        elapsedMs: sentAt - sendStarted,
      });
      this.record({
        operation: "reviewer.dispatch_skew",
        reviewers: reviewerCount,
        elapsedMs: sentAt - this.passStartedAt,
      });
      await host.assertFence();
      reviewer.dispatchState = "sent";
      delete reviewer.continuationPrompt;
      await this.commit();
    }
    if (reviewer.dispatchState === "dispatching") {
      // Dispatch acceptance is ambiguous after a crash. The stable request id
      // makes provider reconciliation authoritative; never send it twice.
      reviewer.dispatchState = "sent";
      delete reviewer.continuationPrompt;
      await this.commit();
    }
    if (reviewer.status !== "running") return "continue";
    await host.resolveUnattendedInteractions(provider, reviewer.providerSessionId);
    // Read as data so the terminal-failure branch below fires whether or not
    // the provider explained itself, and can report the explanation when it did.
    const statusStarted = Date.now();
    const observation = await readProviderStatus(
      provider,
      reviewer.providerSessionId,
      reviewer.requestId,
    );
    this.record({
      operation: "reviewer.status",
      platform: efficiencyPlatform(reviewer.agent),
      elapsedMs: Date.now() - statusStarted,
    });
    const { status, error: statusDetail } = observation;
    await host.assertFence();
    if (status === "idle" && observation.turnSettled === false) return "continue";
    const transcript = new PassTranscriptReader(provider, reviewer.providerSessionId, {
      observer: host.efficiency,
      owner: host.efficiencyOwner ?? "multi-review",
    });
    await this.mirrorTranscript(
      reviewer,
      index,
      provider,
      transcript,
      status !== "running" && observation.backgroundWorkLive !== true,
    );
    if (status === "running") {
      await this.clearStall(reviewer);
      return this.observeReviewerProgress(provider, reviewer, transcript, observation.contextUsage);
    }
    // Outside the running path the turn is settling, so this read is bounded
    // by the stall and usage-finalization budgets rather than once per pass.
    const finalUsage = () =>
      this.refreshReviewerUsage(
        reviewer,
        provider,
        observation.contextUsage,
        this.usageNeedsTranscript(provider, observation.contextUsage)
          ? transcript.read(provider.usageMessageLimit)
          : undefined,
      );
    if (status === "blocked") {
      await finalUsage();
      // Every unattended interaction was already resolved above, and a provider
      // without an interaction surface can never be unblocked from here. Bound
      // the wait the same way the idle path is bounded rather than polling a
      // stalled reviewer forever.
      return this.recordStall(
        reviewer,
        "The reviewer stayed blocked without a resolvable interaction",
      );
    }
    if (status === "error" || status === "missing") {
      await finalUsage();
      reviewer.status = "failed";
      reviewer.completedAt = nowIso();
      reviewer.error =
        status === "missing"
          ? "The reviewer session no longer exists"
          : statusDetail
            ? `The reviewer session failed: ${statusDetail}`
            : "The reviewer session failed";
      await this.commit();
      return "continue";
    }
    if (reviewer.resultTransport === "tool-v1") {
      reviewer.resultSubmission = await host.projectResult?.(reviewer.requestId);
    }
    const result =
      reviewer.resultTransport === "tool-v1"
        ? ((await host.readResult?.<unknown>(reviewer.requestId)) ?? null)
        : await provider.structured<unknown>(reviewer.providerSessionId, reviewer.requestId);
    await host.assertFence();
    if (!result) {
      if (observation.backgroundWorkLive) {
        // The reviewer ended its turn to wait on background agents it launched;
        // the provider resumes it when they settle. That is progress, not an
        // idle reviewer, so it stays bounded by the transcript stall clock —
        // and its usage by the probe throttle, not by every pass.
        await this.clearStall(reviewer);
        return this.observeReviewerProgress(
          provider,
          reviewer,
          transcript,
          observation.contextUsage,
        );
      }
      await finalUsage();
      return this.recordStall(
        reviewer,
        "The reviewer became idle without returning its structured report",
      );
    }
    await finalUsage();
    const parsed = parseStructuredReportResult(result);
    if (!parsed.success) {
      return this.prepareReviewerReportRepair(reviewer, parsed.error);
    }
    if (
      host.captureReviewerUsage &&
      observation.usagePending === true &&
      (reviewer.usageFinalizationPolls ?? 0) < REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS
    ) {
      reviewer.usageFinalizationPolls = (reviewer.usageFinalizationPolls ?? 0) + 1;
      await this.commit();
      return "continue";
    }
    reviewer.report = attributeReportFindings(parsed.data, reviewer);
    reviewer.status = "completed";
    reviewer.completedAt = nowIso();
    delete reviewer.schemaRepairPrompt;
    delete reviewer.continuationPrompt;
    delete reviewer.idleResultPolls;
    delete reviewer.usageFinalizationPolls;
    delete reviewer.stalledSince;
    this.host.progress.forget(reviewer.providerSessionId);
    delete reviewer.progressDigest;
    if (reviewer.resultTransport === "tool-v1") {
      host.stageResultConsumption?.(reviewer.requestId);
    }
    await this.commit();
    if (reviewer.resultTransport === "tool-v1") {
      try {
        await host.consumeResult?.(reviewer.requestId);
        delete reviewer.resultSubmission;
        host.finishResultConsumption?.(reviewer.requestId);
        await this.commit();
      } catch (error) {
        host.stageResultConsumption?.(reviewer.requestId);
        console.warn(
          `[review-fanout] Deferred result consumption: ${reviewFanoutErrorMessage(error)}`,
        );
      }
    }
    return "continue";
  }

  private interactionContext(reviewer: ReviewerRecord, fence: string | undefined) {
    return {
      origin: "looped-review" as const,
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      reviewerSession: true,
      phase: "review" as const,
      workflowId: this.host.workflowId,
      provider: reviewer.agent,
      fence,
    };
  }

  /**
   * A host that renders reviewer transcripts is refreshed here rather than on
   * its own schedule, so a reviewer that finishes between ticks still leaves a
   * complete transcript behind. A read failure is not the reviewer's failure.
   */
  private async mirrorTranscript(
    reviewer: ReviewerRecord,
    index: number,
    provider: BuildPipelineProvider,
    transcript: PassTranscriptReader,
    settling: boolean,
  ): Promise<void> {
    if (!this.host.onReviewerObserved) return;
    try {
      await this.host.onReviewerObserved(
        reviewer,
        index,
        provider,
        () => transcript.read(undefined),
        settling,
      );
    } catch (error) {
      console.warn(
        "[review-fanout] Mirroring a reviewer transcript failed:",
        reviewFanoutErrorMessage(error),
      );
    }
  }

  /**
   * Usage comes from the authoritative status observation whenever the
   * provider supplies it; only a provider that meters from messages, and only
   * when the observation carried none, needs a transcript read for it.
   */
  private usageNeedsTranscript(
    provider: BuildPipelineProvider,
    observedUsage: { sessionTokens?: number } | undefined,
  ): boolean {
    return (
      this.host.captureReviewerUsage === true &&
      observedUsage === undefined &&
      provider.usageFromMessages !== undefined
    );
  }

  /**
   * Copies the provider's cumulative token counter into the durable workflow.
   * Usage is presentation metadata: an unavailable meter must never fail an
   * otherwise healthy review turn.
   */
  private async refreshReviewerUsage(
    reviewer: ReviewerRecord,
    provider: BuildPipelineProvider,
    observedUsage: { sessionTokens?: number } | undefined,
    messages: Promise<unknown[]> | undefined,
  ): Promise<boolean> {
    if (!this.host.captureReviewerUsage || !reviewer.providerSessionId) return false;
    try {
      const usage =
        observedUsage ??
        (provider.usageFromMessages && messages
          ? provider.usageFromMessages(await messages)
          : undefined);
      const reported = usage?.sessionTokens;
      if (typeof reported !== "number" || !Number.isSafeInteger(reported) || reported < 0) {
        return false;
      }
      await this.host.assertFence();
      const tokenCount = Math.max(reviewer.tokenCount ?? 0, reported);
      if (reviewer.tokenCount === tokenCount) return false;
      reviewer.tokenCount = tokenCount;
      return true;
    } catch (error) {
      if (this.isFatal(error)) throw error;
      console.warn(
        "[review-fanout] Reading reviewer token usage failed:",
        reviewFanoutErrorMessage(error),
      );
      return false;
    }
  }

  /**
   * Bounds a reviewer that reports `running` without producing anything.
   *
   * Provider status alone cannot distinguish a long turn from a wedged one — a
   * Cursor parent holding its turn open for a background child whose transcript
   * stopped moving reports `running` indefinitely, and the review phase will not
   * advance while any reviewer is still running. Transcript movement is the
   * signal that separates the two, because bridges stream sub-agent activity
   * into the parent transcript as it happens.
   *
   * The transcript is read only when the tracker says a probe is due: a
   * throttled pass starts no provider request at all. A provider that meters
   * usage from messages shares that one due read.
   *
   * The warning is durable so the tab can show it; the abandon is what stops one
   * stuck reviewer from halting consolidation for good.
   *
   * A failed or throttled probe is not a fingerprint comparison, but it is not
   * a pause of the stall clock either: `progressAt` / `startedAt` still decide
   * whether the session has been silent too long. A restart compares against
   * the persisted digest so it cannot invent a new baseline or move the clock
   * forward.
   */
  private async observeReviewerProgress(
    provider: BuildPipelineProvider,
    reviewer: ReviewerRecord,
    transcript: PassTranscriptReader,
    observedUsage: { sessionTokens?: number } | undefined,
  ): Promise<"continue"> {
    const providerSessionId = reviewer.providerSessionId;
    if (!providerSessionId) return "continue";
    const previousDigest = reviewer.progressDigest;
    let usageChanged = await this.refreshReviewerUsage(
      reviewer,
      provider,
      observedUsage,
      undefined,
    );
    const usageFromTranscript = this.usageNeedsTranscript(provider, observedUsage);
    this.record({
      operation: this.host.progress.isProbeDue(providerSessionId)
        ? "transcript.probe_due"
        : "transcript.probe_throttled",
    });
    const observation = await this.host.progress.observe(
      providerSessionId,
      async () =>
        (
          await transcript.read(
            usageFromTranscript ? provider.usageMessageLimit : PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
          )
        ).slice(-PROGRESS_TRANSCRIPT_TAIL_MESSAGES),
      reviewer.progressDigest,
    );
    if (usageFromTranscript) {
      // Only a read someone already paid for this pass — the due probe or the
      // owner's mirror. Usage metering never starts a read of its own here.
      const shared = transcript.peek(provider.usageMessageLimit);
      if (shared) {
        usageChanged =
          (await this.refreshReviewerUsage(reviewer, provider, undefined, shared)) || usageChanged;
      }
    }
    await this.host.assertFence();
    const decision = commitProgressObservation(reviewer, observation);
    if (decision === "reset" || decision === "hold") {
      this.stageObservation();
      return "continue";
    }
    const elapsedMs = noProgressElapsedMs(reviewer.progressAt, reviewer.startedAt);
    if (elapsedMs === null) {
      if (this.shouldPersistUsageOrProgress(usageChanged, previousDigest, reviewer)) {
        this.stageObservation();
      }
      return "continue";
    }
    if (elapsedMs >= this.stallAbandonMs()) {
      // Best-effort, like every other abandon: the session is unresponsive, so
      // waiting for it to confirm the abort would reproduce the stall.
      await this.host.abandonSession(reviewer, providerSessionId);
      this.host.progress.forget(providerSessionId);
      reviewer.status = "failed";
      reviewer.error = `The reviewer produced no activity for ${stalledMinutes(elapsedMs)} minutes and was stopped so the rest of the review could continue`;
      reviewer.completedAt = nowIso();
      delete reviewer.stalledSince;
      delete reviewer.idleResultPolls;
      await this.commit();
      return "continue";
    }
    if (elapsedMs >= this.stallWarningMs() && reviewer.stalledSince === undefined) {
      reviewer.stalledSince = nowIso();
      this.stageObservation();
      return "continue";
    }
    if (this.shouldPersistUsageOrProgress(usageChanged, previousDigest, reviewer)) {
      this.stageObservation();
    }
    return "continue";
  }

  private shouldPersistUsageOrProgress(
    usageChanged: boolean,
    previousDigest: string | undefined,
    reviewer: ReviewerRecord,
  ): boolean {
    if (reviewer.progressDigest !== previousDigest) return true;
    return usageChanged && this.host.persistReviewerUsageImmediately !== false;
  }

  private async prepareReviewerReportRepair(
    reviewer: ReviewerRecord,
    error: ReviewContractValidationError,
  ): Promise<"stop"> {
    const attempt = (reviewer.schemaRepairAttempts ?? 0) + 1;
    if (attempt > MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS) {
      throw new Error(
        `${error.message} The reviewer could not produce a valid report in ${MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS} repair attempts.`,
      );
    }
    const previousRequestId = reviewer.requestId;
    const previousTransport = reviewer.resultTransport;
    // Retire the old slot before the new request identity reaches memory: with
    // concurrent reviewers, a peer's commit could otherwise persist the new id
    // while the superseded slot was still accepting submissions.
    if (previousTransport === "tool-v1" && previousRequestId) {
      await this.host.closeResult?.(previousRequestId);
    }
    reviewer.schemaRepairAttempts = attempt;
    reviewer.schemaRepairPrompt = structuredReportRepairPrompt(
      error.issues,
      attempt,
      MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS,
    );
    reviewer.requestId = randomUUID();
    reviewer.dispatchState = "prepared";
    reviewer.resultTransport =
      this.host.prepareResult && (this.host.supportsToolResult?.(reviewer) ?? true)
        ? "tool-v1"
        : "structured-output-v1";
    reviewer.resultSubmission = reviewer.resultTransport === "tool-v1" ? "preparing" : undefined;
    delete reviewer.idleResultPolls;
    await this.commit();
    return "stop";
  }

  /** Counts one stalled poll, failing the reviewer once the bound is reached. */
  private async recordStall(reviewer: ReviewerRecord, error: string): Promise<"continue" | "stop"> {
    reviewer.idleResultPolls = (reviewer.idleResultPolls ?? 0) + 1;
    if (reviewer.idleResultPolls >= MAX_REVIEW_IDLE_RESULT_POLLS) {
      if (reviewer.providerSessionId) {
        await this.host.abandonSession(reviewer, reviewer.providerSessionId);
        this.host.progress.forget(reviewer.providerSessionId);
      }
      reviewer.status = "failed";
      reviewer.error = error;
      reviewer.completedAt = nowIso();
      delete reviewer.stalledSince;
    }
    await this.commit();
    return "continue";
  }

  /** Observed progress retires the stall count so it cannot accumulate. */
  private async clearStall(reviewer: ReviewerRecord): Promise<"continue"> {
    if (reviewer.idleResultPolls === undefined) return "continue";
    delete reviewer.idleResultPolls;
    await this.commit();
    return "continue";
  }
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
