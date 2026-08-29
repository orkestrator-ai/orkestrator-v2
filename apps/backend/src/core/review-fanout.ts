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
  stripStructuredReviewProvenance,
  type ReviewContractValidationIssue,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  AmbiguousPromptDispatchError,
  readProviderStatus,
  type BuildPipelineProvider,
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
  return safeParseStructuredReviewReport(result.value);
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
): Promise<void> {
  try {
    await provider.prepareDispatch?.(providerSessionId);
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
  /** Durable session key for one reviewer. Must be stable across restarts. */
  sessionKeyFor(reviewer: ReviewerRecord, index: number): string;
  /** Pane title for one reviewer's session. */
  sessionLabelFor(reviewer: ReviewerRecord, index: number): string;
  provider(selection: ReviewerModelSelection): Promise<BuildPipelineProvider>;
  /** Persists the host's own record. Called after every durable mutation. */
  save(): Promise<void>;
  /** Throws if this process no longer owns the workflow. */
  assertFence(): Promise<void>;
  /**
   * Re-verifies the pinned worktree and returns the prompt projection of it.
   * Throws {@link ReviewSnapshotChangedError} on drift.
   */
  reviewSnapshot(): Promise<ReviewWorktreeSnapshot>;
  resolveUnattendedInteractions(
    provider: BuildPipelineProvider,
    providerSessionId: string,
  ): Promise<void>;
  /** Best-effort abort of a session the workflow is discarding. */
  abandonSession(selection: ReviewerModelSelection, providerSessionId: string): Promise<void>;
  /**
   * Lets an owner mirror a reviewer's transcript into its own read model.
   *
   * Called on every pass over a live reviewer, after status is known. It must
   * not throw for a transcript it could not read: a reviewer's turn is not the
   * host's rendering.
   */
  onReviewerObserved?(
    reviewer: ReviewerRecord,
    index: number,
    provider: BuildPipelineProvider,
  ): Promise<void>;
  readonly progress: MultiReviewProgressTracker;
  readonly stallWarningMs?: number;
  readonly stallAbandonMs?: number;
}

export type ReviewFanoutOutcome =
  /** Reviewers are still working, or this pass stopped early on purpose. */
  | { kind: "working" }
  /** Every reviewer settled and at least one produced a usable report. */
  | { kind: "ready"; reports: ReviewerRecord[] }
  /** Every reviewer settled and none produced a usable report. */
  | { kind: "no-reports"; error: string };

export class ReviewFanoutRunner {
  constructor(private readonly host: ReviewFanoutHost) {}

  private stallWarningMs(): number {
    return this.host.stallWarningMs ?? DEFAULT_STALL_WARNING_MS;
  }

  private stallAbandonMs(): number {
    return this.host.stallAbandonMs ?? DEFAULT_STALL_ABANDON_MS;
  }

  /**
   * Advances every unsettled reviewer once.
   *
   * A reviewer is one independent input to the consolidated result, so its
   * failure stays local: the remaining reviewers can still produce a valid
   * report. Only a snapshot fault ends the whole pass, because it invalidates
   * the state every reviewer was judged against.
   */
  async advanceReviewers(reviewers: ReviewerRecord[]): Promise<ReviewFanoutOutcome> {
    for (let index = 0; index < reviewers.length; index++) {
      const reviewer = reviewers[index]!;
      if (
        reviewer.status === "completed" ||
        reviewer.status === "failed" ||
        reviewer.status === "cancelled"
      ) {
        continue;
      }
      let done: "continue" | "stop";
      try {
        done = await this.advanceReviewer(reviewer, index, reviewers.length);
      } catch (error) {
        if (isReviewSnapshotError(error)) {
          // These end the whole pass rather than one reviewer, so the abort the
          // handler below performs has to happen here instead.
          await this.abandonLiveReviewers(reviewers);
          throw error;
        }
        if (this.isFatal(error)) throw error;
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
        delete reviewer.idleResultPolls;
        delete reviewer.stalledSince;
        await this.host.save();
        done = "continue";
      }
      if (done === "stop") return { kind: "working" };
    }

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

  /** Advances one reviewer. `stop` ends the pass without touching the rest. */
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
      const providerSessionId = await provider.createSession(
        "review",
        host.sessionLabelFor(reviewer, index),
        {
          clientSessionKey: sessionKey,
          mode: "build",
          model: reviewerModel(reviewer),
          effort: reviewer.reasoningEffort,
          interaction: this.interactionContext(reviewer, sessionKey),
        },
      );
      await host.assertFence();
      reviewer.sessionKey = sessionKey;
      reviewer.providerSessionId = providerSessionId;
      reviewer.requestId = randomUUID();
      reviewer.dispatchState = "prepared";
      reviewer.status = "running";
      reviewer.startedAt = nowIso();
      delete reviewer.progressAt;
      delete reviewer.progressDigest;
      delete reviewer.stalledSince;
      delete reviewer.continuationPrompt;
      await host.save();
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
        const worktree = await host.reviewSnapshot();
        prompt = createMultiReviewerPrompt({
          targetBranch: host.targetBranch,
          reviewInstruction: host.reviewInstruction,
          reviewerNumber: index + 1,
          reviewerCount,
          worktree,
        });
      }
      // Attach the agent process before the at-most-once window opens: a cold
      // spawn is the slowest thing a dispatch can wait on, and time spent on it
      // inside the request is time the outcome is unknowable if it fails.
      await attachAgentBeforeDispatch(provider, reviewer.providerSessionId);
      await host.assertFence();
      reviewer.dispatchState = "dispatching";
      await host.save();
      try {
        await provider.send(reviewer.providerSessionId, prompt, {
          requestId: reviewer.requestId,
          schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema,
          mode: "build",
          model: reviewerModel(reviewer),
          effort: reviewer.reasoningEffort,
        });
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) return "stop";
        throw error;
      }
      await host.assertFence();
      reviewer.dispatchState = "sent";
      delete reviewer.continuationPrompt;
      await host.save();
    }
    if (reviewer.dispatchState === "dispatching") {
      // Dispatch acceptance is ambiguous after a crash. The stable request id
      // makes provider reconciliation authoritative; never send it twice.
      reviewer.dispatchState = "sent";
      delete reviewer.continuationPrompt;
      await host.save();
    }
    if (reviewer.status !== "running") return "continue";
    await host.resolveUnattendedInteractions(provider, reviewer.providerSessionId);
    // Read as data so the terminal-failure branch below fires whether or not
    // the provider explained itself, and can report the explanation when it did.
    const { status, error: statusDetail } = await readProviderStatus(
      provider,
      reviewer.providerSessionId,
    );
    await host.assertFence();
    await this.mirrorTranscript(reviewer, index, provider);
    if (status === "running") {
      await this.clearStall(reviewer);
      return this.observeReviewerProgress(provider, reviewer);
    }
    if (status === "blocked") {
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
      reviewer.status = "failed";
      reviewer.error =
        status === "missing"
          ? "The reviewer session no longer exists"
          : statusDetail
            ? `The reviewer session failed: ${statusDetail}`
            : "The reviewer session failed";
      await host.save();
      return "continue";
    }
    const result = await provider.structured<unknown>(
      reviewer.providerSessionId,
      reviewer.requestId,
    );
    await host.assertFence();
    if (!result) {
      return this.recordStall(
        reviewer,
        "The reviewer became idle without returning its structured report",
      );
    }
    const parsed = parseStructuredReportResult(result);
    if (!parsed.success) {
      return this.prepareReviewerReportRepair(reviewer, parsed.error);
    }
    reviewer.report = attributeReportFindings(parsed.data, reviewer);
    reviewer.status = "completed";
    reviewer.completedAt = nowIso();
    delete reviewer.schemaRepairPrompt;
    delete reviewer.continuationPrompt;
    delete reviewer.idleResultPolls;
    delete reviewer.stalledSince;
    this.host.progress.forget(reviewer.providerSessionId);
    delete reviewer.progressDigest;
    await host.save();
    return "continue";
  }

  private interactionContext(reviewer: ReviewerRecord, fence: string | undefined) {
    return {
      origin: "looped-review" as const,
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
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
  ): Promise<void> {
    if (!this.host.onReviewerObserved) return;
    try {
      await this.host.onReviewerObserved(reviewer, index, provider);
    } catch (error) {
      console.warn(
        "[review-fanout] Mirroring a reviewer transcript failed:",
        reviewFanoutErrorMessage(error),
      );
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
  ): Promise<"continue"> {
    const providerSessionId = reviewer.providerSessionId;
    if (!providerSessionId) return "continue";
    const previousDigest = reviewer.progressDigest;
    const observation = await this.host.progress.observe(
      providerSessionId,
      () => provider.messages(providerSessionId, { limit: PROGRESS_TRANSCRIPT_TAIL_MESSAGES }),
      reviewer.progressDigest,
    );
    await this.host.assertFence();
    const decision = commitProgressObservation(reviewer, observation);
    if (decision === "reset" || decision === "hold") {
      await this.host.save();
      return "continue";
    }
    const elapsedMs = noProgressElapsedMs(reviewer.progressAt, reviewer.startedAt);
    if (elapsedMs === null) {
      if (reviewer.progressDigest !== previousDigest) await this.host.save();
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
      await this.host.save();
      return "continue";
    }
    if (elapsedMs >= this.stallWarningMs() && reviewer.stalledSince === undefined) {
      reviewer.stalledSince = nowIso();
      await this.host.save();
      return "continue";
    }
    if (reviewer.progressDigest !== previousDigest) await this.host.save();
    return "continue";
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
    reviewer.schemaRepairAttempts = attempt;
    reviewer.schemaRepairPrompt = structuredReportRepairPrompt(
      error.issues,
      attempt,
      MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS,
    );
    reviewer.requestId = randomUUID();
    reviewer.dispatchState = "prepared";
    delete reviewer.idleResultPolls;
    await this.host.save();
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
    await this.host.save();
    return "continue";
  }

  /** Observed progress retires the stall count so it cannot accumulate. */
  private async clearStall(reviewer: ReviewerRecord): Promise<"continue"> {
    if (reviewer.idleResultPolls === undefined) return "continue";
    delete reviewer.idleResultPolls;
    await this.host.save();
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
