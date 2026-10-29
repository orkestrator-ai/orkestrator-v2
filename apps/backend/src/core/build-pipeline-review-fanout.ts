/**
 * The build pipeline's multi-model review stage.
 *
 * When a pipeline is configured with more than one reviewer, its review phase
 * stops being one agent answering the structured-review contract and becomes
 * the same fan-out Multi Review runs: N reviewers against one immutable review
 * package, then a consolidation turn that merges their reports into the single
 * {@link BuildPipeline.structuredReview} a single reviewer would have written,
 * routed to Address or Verify by the same rule.
 * Nothing downstream of the review stage learns there was more than one
 * reviewer — that is the whole point of consolidating here rather than
 * teaching every later stage about a list.
 *
 * The reviewer turn itself is not implemented here. It lives in
 * `review-fanout.ts` and is shared with Multi Review, so a fix to a wedged
 * reviewer, a schema repair or a dispatch race lands in both at once. What this
 * module owns is what only the pipeline knows: that its state is a field on the
 * pipeline snapshot, that its reviewers are mirrored into `pipeline.sessions`
 * so the build tab can render them, and that consolidation runs on the shared
 * review preparation selection.
 *
 * Every reviewer is also a real {@link PipelineSession}. That is deliberate:
 * the build tab, the interaction summaries and the review handoff prompt all
 * read `pipeline.sessions`, so a reviewer that existed only inside the fan-out
 * record would be invisible to a user watching the build and unreachable to the
 * address stage that has to quote it. The supervisor's single-session tick path
 * is skipped entirely while the fan-out is live; these sessions are driven from
 * here.
 */
import { recoveredDispatchAcceptance } from "./provider-dispatch-recovery.js";
import { randomUUID } from "node:crypto";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  boundedPipelineSessionError,
  pipelineIndependentReviewLabel,
  pipelineReviewIssueCounts,
  pipelineReviewerConfigs,
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSession,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  reviewersSettled,
  usableReviewerReports,
  type ReviewerRecord,
  type ReviewConsolidationSession,
  type ReviewFanoutState,
} from "@orkestrator/protocol/review-fanout";
import type {
  ReviewPackageContext,
  ReviewPackageReference,
} from "@orkestrator/protocol/review-workflow";
import {
  ReviewContractValidationError,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type {
  NativeAgentExecutionPolicy,
  NativeAgentModelSubstitution,
} from "@orkestrator/protocol/native-agent";
import {
  workflowResultInstruction,
  workflowResultToolName,
  type WorkflowResultKind,
} from "@orkestrator/protocol/workflow-results";
import {
  lastAssistantText,
  missingWorkflowResultMessage,
  workflowRestartContinuationPrompt,
  workflowResultReminderPrompt,
} from "./workflow-result-missing.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { WorkflowResultService } from "./workflow-result-service.js";
import {
  recordPipelineSessionUsage,
  deferPipelineSessionUsage,
  sharedTranscriptRead,
} from "./build-pipeline-session-usage.js";
import {
  AmbiguousPromptDispatchError,
  ProviderDispatchPreparationError,
  readProviderStatus,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import { structuredReportRepairPrompt } from "./build-pipeline-prompts.js";
import type { BuildStepSelection } from "./build-pipeline-service-helpers.js";
import { createDiscoveryPrompt } from "./review-prompts.js";
import {
  pipelineReviewPreparationInstructions,
  pipelineReviewerInstructions,
  withBuildStepInstructions,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import { reviewerPanelTail } from "./multi-review-prompts.js";
import {
  MAX_REVIEW_IDLE_RESULT_POLLS,
  MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS,
  ReviewFanoutRunner,
  attachAgentBeforeDispatch,
  commitProgressObservation,
  consolidationOverlap,
  consolidationReports,
  createReviewConsolidationPrompt,
  deriveConsolidatedProvenance,
  consolidationResultContext,
  parseStructuredReportResult,
  resolveUnattendedReviewerInteractions,
  reviewFanoutErrorMessage,
  reviewFanoutNowIso,
  reviewFanoutReviewerMode,
  type ReviewFanoutHost,
  type ReviewerPollGate,
} from "./review-fanout.js";
import { buildPipelineStage, buildPipelineStageTurn } from "./build-pipeline-stages.js";
import { clearReviewerAdmission } from "./review-fanout-admission.js";
import { dropProvisionalFindings } from "./review-provisional-findings.js";
import {
  DEFAULT_STALL_ABANDON_MS,
  DEFAULT_STALL_WARNING_MS,
  MultiReviewProgressTracker,
  noProgressElapsedMs,
  stalledMinutes,
} from "./multi-review-progress.js";
import { readTranscriptProgressSample } from "./transcript-progress.js";
import { recordEfficiency, type MultiReviewEfficiencyObserver } from "./multi-review-efficiency.js";
import type { ReviewFanoutConcurrency } from "./review-fanout-scheduler.js";
import { multiReviewDuplicateReviewerCount } from "@orkestrator/protocol/multi-review-launch";
import { reviewLensField } from "@orkestrator/protocol/review-lens";
import {
  beginWorkflowArtifactTurn,
  settleArtifactDispatchTurn,
  type ArtifactTurnDispatch,
} from "./workflow-artifact-turns.js";
import type { ReviewPackageVerification } from "./commands-review.js";
import { retainRoundReviewReport } from "./build-pipeline-rewind.js";
import type { WorkspaceGitBaseline } from "@orkestrator/protocol/workspace-guard";

/** Names the pipeline in reviewer-facing and user-facing failure text. */
const FANOUT_LABEL = "Multi-model review";
/** The panel's result kinds and the consolidation turn, from the stage table. */
const REVIEWER_RESULT_KIND = buildPipelineStage("review").result!;
const CONSOLIDATION_RESULT_KIND = buildPipelineStage("consolidation").result!;
const CONSOLIDATION_TURN = buildPipelineStageTurn(buildPipelineStage("consolidation"));

/** What the fan-out needs from the supervisor that owns the pipeline. */
export interface BuildPipelineReviewFanoutDeps {
  provider(pipeline: BuildPipeline, agent: BuildPipelineAgent): Promise<BuildPipelineProvider>;
  providerUnavailable?(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent,
    provider: BuildPipelineProvider,
  ): Promise<void>;
  executionPolicy(pipeline: BuildPipeline): Promise<NativeAgentExecutionPolicy>;
  save(pipeline: BuildPipeline): Promise<void>;
  stepSettings(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
  ): Promise<BuildStepSelection>;
  settingsForSelection(
    pipeline: BuildPipeline,
    selection: BuildStepSelection,
  ): Promise<BuildStepSelection>;
  settingsForSelections(
    pipeline: BuildPipeline,
    selections: readonly BuildStepSelection[],
  ): Promise<BuildStepSelection[]>;
  /**
   * Observes a session's transcript for the next checkpoint, reading the whole
   * body only when a bounded probe shows it moved since the committed copy (or
   * when `force` asks for it). Answers whether it changed since that copy.
   */
  refreshMovedTranscript(
    session: PipelineSession,
    provider: BuildPipelineProvider,
    options?: { force?: boolean; read?: () => Promise<readonly unknown[]> },
  ): Promise<boolean>;
  shouldPersistTranscript(session: PipelineSession): boolean;
  /** The branch the diff is reviewed against, as the review prompt states it. */
  targetBranch(pipeline: BuildPipeline): Promise<string>;
  reviewInstruction(): Promise<string | undefined>;
  reviewContext(pipeline: BuildPipeline): Promise<ReviewPackageContext>;
  verifyReviewPackage(
    pipeline: BuildPipeline,
    reviewPackage: ReviewPackageReference,
  ): Promise<Pick<ReviewPackageVerification, "artifacts" | "artifactBytes"> | void>;
  progress: MultiReviewProgressTracker;
  stallWarningMs?: number;
  stallAbandonMs?: number;
  workflowResults?: WorkflowResultService;
  /** Backend-owned admission gate, evaluated once per attempt. */
  workflowToolEnabled?(agent: ReviewerRecord["agent"], kind: WorkflowResultKind): boolean;
  agentMcp?(
    pipeline: BuildPipeline,
    resultKey: string,
    provider: BuildPipelineAgent | undefined,
    stage: string,
  ): Promise<AgentToolConnection | undefined>;
  /** Bounded reviewer concurrency shared with standalone Multi Review. */
  concurrency?: Partial<ReviewFanoutConcurrency>;
  /** Content-free measurement sink. */
  efficiency?: MultiReviewEfficiencyObserver;
  /** Elapsed-time gate for reviewer poll counts during this pipeline's pass. */
  pollGate?(pipeline: BuildPipeline): ReviewerPollGate;
  /** Reviewer and consolidation turns' artifact grants (`workflow-artifact-turns.ts`). */
  artifactDispatch?: ArtifactTurnDispatch;
  /**
   * The read-only guard's baseline for a new pass, taken before any reviewer
   * is dispatched (`build-pipeline-read-only-guard.ts`). Throws when the Git
   * state cannot be observed, which fails the stage before any turn is spent.
   */
  captureWorkspaceBaseline(pipeline: BuildPipeline): Promise<WorkspaceGitBaseline>;
  /**
   * The stage error when the worktree no longer matches the pass's baseline,
   * or null. Asked when reviewer reports arrive and before the consolidated
   * report is accepted.
   */
  workspaceViolation(
    pipeline: BuildPipeline,
    subject: "review" | "consolidation",
  ): Promise<string | null>;
}

/** What the supervisor should do after one fan-out pass. */
export type ReviewFanoutStep =
  /** Still working. The supervisor returns without touching the pipeline. */
  | { kind: "working" }
  /** The consolidated report is on the pipeline; route it to Address or Verify. */
  | { kind: "consolidated" }
  /** The stage failed. The supervisor applies its usual failure handling. */
  | { kind: "failed"; error: string };

export class BuildPipelineReviewFanout {
  /**
   * Per-pipeline write queue. Reviewers advance concurrently, and every write
   * here is revision-checked against the pipeline snapshot, so two unserialized
   * saves of the same in-memory pipeline would conflict with each other.
   */
  private readonly saveTails = new WeakMap<BuildPipeline, Promise<void>>();

  constructor(private readonly deps: BuildPipelineReviewFanoutDeps) {}

  /** Serialized {@link BuildPipelineReviewFanoutDeps.save} for one pipeline object. */
  private save(pipeline: BuildPipeline): Promise<void> {
    const run = (this.saveTails.get(pipeline) ?? Promise.resolve()).then(() =>
      this.deps.save(pipeline),
    );
    this.saveTails.set(
      pipeline,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * Opens the fan-out over the package prepared by the implementing model.
   *
   * No live-worktree snapshot is captured here. Every reviewer receives the
   * same committed evidence, so later commits and generated artifacts cannot
   * change or invalidate the subject of the review.
   */
  async start(pipeline: BuildPipeline): Promise<void> {
    if (!pipeline.reviewPackage) {
      throw new Error(`${FANOUT_LABEL} cannot start because no immutable review package exists`);
    }
    // Reviewers and the consolidator share the worktree, so they share one
    // baseline, taken before the first of them can touch it.
    const workspaceBaseline = await this.deps.captureWorkspaceBaseline(pipeline);
    // One batch, so the shared environment, config, and model catalogue are
    // read once for the whole fan-out rather than once per reviewer.
    const configs = pipelineReviewerConfigs(pipeline);
    const selections = await this.deps.settingsForSelections(
      pipeline,
      configs.map((config) => ({
        agent: config.agent,
        model: config.model,
        effort: config.reasoningEffort,
      })),
    );
    // Each record keeps its reviewer's lens, copied from the stored row, so a
    // fresh pass after a restart or rewind runs the same focus.
    pipeline.reviewFanout = {
      reviewers: selections.map((selection, index) => ({
        ...reviewerFromConfig(selection),
        ...reviewLensField(configs[index]?.lens),
      })),
      workspaceBaseline,
    };
    recordEfficiency(this.deps.efficiency, {
      owner: "build-pipeline",
      operation: "launch.duplicate_reviewers",
      reviewers: pipeline.reviewFanout.reviewers.length,
      count: multiReviewDuplicateReviewerCount(pipeline.reviewFanout.reviewers),
    });
    pipeline.phase = "reviewing";
    delete pipeline.structuredReview;
    delete pipeline.structuredReviewRequestId;
    delete pipeline.error;
    delete pipeline.failureContext;
    // A retried review must not inherit the previous attempt's dangling prompt
    // state: the fan-out has no single pending attempt of its own.
    delete pipeline.pendingPromptAttempt;
    delete pipeline.activePromptContext;
    await this.save(pipeline);
  }

  /** Advances the fan-out by one supervisor pass. */
  async advance(pipeline: BuildPipeline): Promise<ReviewFanoutStep> {
    const state = pipeline.reviewFanout;
    if (!state) return { kind: "working" };
    if (state.report) return { kind: "consolidated" };
    const targetBranch = await this.deps.targetBranch(pipeline);

    if (!state.consolidation) {
      const runner = new ReviewFanoutRunner(this.reviewHost(pipeline, targetBranch));
      const completedBefore = completedReviewerCount(state.reviewers);
      const outcome = await runner.advanceReviewers(state.reviewers);
      // Settled *after* the pass, not inside it: a reviewer's last transcript
      // mirror happens while its provider status is still being read, so the
      // status it ends on — completed, failed, stopped — is only known here.
      // Without this the build tab shows finished reviewers as still running.
      await this.settleReviewerSessions(pipeline, state);
      // A report is only usable from a worktree the panel left as it found it.
      // Checked as reports arrive, so a reviewer that committed fails the pass
      // without waiting for the rest of the panel, and again before
      // consolidation reads them.
      if (outcome.kind === "ready" || completedReviewerCount(state.reviewers) > completedBefore) {
        const violation = await this.deps.workspaceViolation(pipeline, "review");
        if (violation) return { kind: "failed", error: violation };
      }
      if (outcome.kind === "working") return { kind: "working" };
      if (outcome.kind === "no-reports") return { kind: "failed", error: outcome.error };
    }
    return this.advanceConsolidation(pipeline, state, targetBranch);
  }

  /**
   * Discards only a failed consolidation attempt, keeping the completed
   * reviewer panel that feeds it.
   *
   * The pipeline exposes the whole fan-out as its `reviewing` phase, but the
   * restart control promises to retry the stage that actually failed. Once the
   * reviewers have settled with at least one report, that stage is
   * consolidation. Rotating only its session avoids spending every reviewer's
   * turn again while still giving a failed or exhausted consolidator a clean
   * context and repair budget.
   *
   * A reviewer-stage failure never writes a consolidation record, and
   * `abandonReviewFanout` marks unfinished reviewers cancelled — which
   * `reviewersSettled` treats as done. Either signal means this is not a
   * consolidation failure, so the caller must recreate the panel.
   */
  async restartConsolidation(pipeline: BuildPipeline): Promise<boolean> {
    const state = pipeline.reviewFanout;
    if (
      !state ||
      state.report ||
      !state.consolidation ||
      !reviewersSettled(state.reviewers) ||
      state.reviewers.some((reviewer) => reviewer.status === "cancelled") ||
      usableReviewerReports(state.reviewers).length === 0
    ) {
      return false;
    }

    const consolidation = state.consolidation;
    if (consolidation) {
      this.deps.progress.forget(consolidation.providerSessionId);
      if (consolidation.resultTransport === "tool-v1") {
        await this.deps.workflowResults?.close(consolidation.requestId, "superseded");
      }
    }
    delete state.consolidation;
    delete pipeline.structuredReview;
    delete pipeline.structuredReviewRequestId;
    await this.save(pipeline);
    return true;
  }

  /**
   * Runs one failed reviewer of the current pass again, keeping the rest of
   * the panel. The caller persists the pipeline.
   *
   * Consolidation is derived from every reviewer's report, so an attempt that
   * has started (or failed) is discarded: it runs again once the retried
   * reviewer settles. An accepted consolidated report means the pass has
   * moved on, and the reviewer can only be rerun by restarting the stage.
   * The failed attempt's session stays in the pipeline as history; the retry
   * opens a session of its own.
   */
  async prepareReviewerRetry(pipeline: BuildPipeline, reviewerId: string): Promise<void> {
    const state = pipeline.reviewFanout;
    const reviewer = state?.reviewers.find((candidate) => candidate.id === reviewerId);
    if (!state || !reviewer) {
      throw new Error("This reviewer is no longer part of the current review");
    }
    if (state.report) {
      throw new Error("The review has been consolidated; restart the review stage to rerun it");
    }
    if (reviewer.status !== "failed") {
      throw new Error("Only a failed reviewer can be retried");
    }
    const consolidation = state.consolidation;
    if (consolidation) {
      this.deps.progress.forget(consolidation.providerSessionId);
      await this.abandonSession(
        pipeline,
        consolidation.agent as BuildPipelineAgent,
        consolidation.providerSessionId,
      );
      if (consolidation.resultTransport === "tool-v1") {
        await this.deps.workflowResults?.close(consolidation.requestId, "superseded");
      }
      const session = pipeline.sessions.find(
        (candidate) => candidate.sessionKey === consolidation.sessionKey,
      );
      if (session) {
        session.status = "idle";
        session.superseded = true;
        delete session.reviewReport;
        delete session.reviewIssueCounts;
        delete session.reviewOverlap;
        delete session.structuredResultStatus;
        delete session.resultSubmission;
        delete session.error;
        session.completedAt ??= reviewFanoutNowIso();
      }
      delete state.consolidation;
      delete pipeline.structuredReview;
      delete pipeline.structuredReviewRequestId;
    }
    // Pause interrupts the other queued/running reviewers too. Requeue those
    // peers under fresh result slots before resuming, preserving completed reports.
    for (const retry of state.reviewers.filter(
      (candidate) => candidate === reviewer || candidate.status === "cancelled",
    )) {
      if (retry.providerSessionId) this.deps.progress.forget(retry.providerSessionId);
      if (retry.resultTransport === "tool-v1" && retry.requestId) {
        await this.deps.workflowResults?.close(retry.requestId, "superseded");
      }
      resetReviewerForRetry(retry);
    }
  }

  // -------------------------------------------------------------------------
  // Reviewers
  // -------------------------------------------------------------------------

  private settleConsolidationArtifactTurn(
    pipeline: BuildPipeline,
    consolidation: { sessionKey: string; requestId: string },
  ): void {
    settleArtifactDispatchTurn(
      this.deps.artifactDispatch,
      pipeline.environmentId,
      consolidation.sessionKey,
      consolidation.requestId,
    );
  }

  private reviewHost(pipeline: BuildPipeline, targetBranch: string): ReviewFanoutHost {
    return {
      workflowId: pipeline.id,
      targetBranch,
      label: FANOUT_LABEL,
      // Reviewers read the immutable package, so they run as Multi Review's do:
      // provider plan mode with the read-only mutation boundary, on every turn
      // including repairs. The read-only guard backs this on every provider.
      reviewerMode: reviewFanoutReviewerMode(pipeline.reviewPackage),
      ...(this.deps.pollGate ? { pollGate: this.deps.pollGate(pipeline) } : {}),
      sessionKeyFor: (reviewer) => reviewerSessionKey(pipeline, reviewer),
      sessionLabelFor: (_reviewer, index) => pipelineIndependentReviewLabel(index),
      provider: (selection) => this.deps.provider(pipeline, selection.agent as BuildPipelineAgent),
      providerUnavailable: (selection, provider) =>
        this.deps.providerUnavailable?.(
          pipeline,
          selection.agent as BuildPipelineAgent,
          provider,
        ) ?? Promise.resolve(),
      executionPolicy: () => this.deps.executionPolicy(pipeline),
      agentMcp: async (selection, resultKey) =>
        this.deps.agentMcp?.(pipeline, resultKey, selection.agent, "build pipeline reviewer"),
      ...(this.deps.artifactDispatch
        ? {
            artifactTurns: {
              dispatch: this.deps.artifactDispatch,
              environmentId: pipeline.environmentId,
              projectId: pipeline.projectId,
            },
          }
        : {}),
      ...(this.deps.workflowResults && this.deps.agentMcp
        ? {
            supportsToolResult: (selection: ReviewerRecord) =>
              this.deps.workflowToolEnabled?.(selection.agent, REVIEWER_RESULT_KIND) ?? false,
            prepareResult: async (
              selection: ReviewerRecord,
              requestId: string,
              schema: JsonSchema,
            ) =>
              this.deps.workflowResults!.prepare({
                resultKey: requestId,
                kind: REVIEWER_RESULT_KIND,
                environmentId: pipeline.environmentId,
                projectId: pipeline.projectId,
                provider: selection.agent,
                schema,
              }),
            projectResult: (requestId: string) => this.deps.workflowResults!.projection(requestId),
            heldResult: (requestId: string) => this.deps.workflowResults!.heldValidation(requestId),
            claimResultNudge: (requestId: string) =>
              this.deps.workflowResults!.claimCommitNudge(requestId),
            readResult: <T>(requestId: string) =>
              this.deps.workflowResults!.structured<T>(requestId),
            consumeResult: (requestId: string) => this.deps.workflowResults!.consume(requestId),
            stageResultConsumption: (requestId: string) => {
              pipeline.pendingResultConsumptions = Array.from(
                new Set([...(pipeline.pendingResultConsumptions ?? []), requestId]),
              );
            },
            finishResultConsumption: (requestId: string) => {
              const pending = (pipeline.pendingResultConsumptions ?? []).filter(
                (candidate) => candidate !== requestId,
              );
              if (pending.length > 0) pipeline.pendingResultConsumptions = pending;
              else delete pipeline.pendingResultConsumptions;
            },
            closeResult: (requestId: string) =>
              this.deps.workflowResults!.close(requestId, "superseded"),
          }
        : {}),
      save: () => this.save(pipeline),
      // The pipeline has no controller lease of its own: the supervisor holds
      // the pipeline lock for the whole pass, so there is no fence to lose
      // part-way through one.
      assertFence: async () => {},
      // One verification per admission wave instead of one per reviewer. The
      // pipeline holds its lock for the whole pass, so the package cannot be
      // regenerated between this check and the dispatches it admits.
      beforeAdmission: async () => {
        const reviewPackage = pipeline.reviewPackage;
        if (!reviewPackage) {
          throw new Error(`${FANOUT_LABEL} lost its immutable review package`);
        }
        if (!("kind" in reviewPackage)) return;
        const started = Date.now();
        const verification = await this.deps.verifyReviewPackage(pipeline, reviewPackage);
        recordEfficiency(this.deps.efficiency, {
          owner: "build-pipeline",
          operation: "evidence.verify",
          phase: "reviewing",
          // The package and every validation artifact it references were hashed.
          bytes: reviewPackage.bytes + (verification?.artifactBytes ?? 0),
          count: verification?.artifacts,
          elapsedMs: Date.now() - started,
        });
      },
      reviewerPrompt: async (index, count, reviewer) => {
        const reviewPackage = pipeline.reviewPackage;
        if (!reviewPackage) {
          throw new Error(`${FANOUT_LABEL} lost its immutable review package`);
        }
        // Shared package prompt first so every reviewer's prefix is identical;
        // the panel position, the reviewer's lens and its own instructions are
        // the only per-reviewer text, and they come last, in that order.
        return withBuildStepInstructions(
          [
            createDiscoveryPrompt({
              reviewPackage,
              reviewInstruction: await this.deps.reviewInstruction(),
              context: await this.deps.reviewContext(pipeline),
            }),
            reviewerPanelTail(index + 1, count, reviewer.lens),
          ].join("\n\n"),
          pipelineReviewerInstructions(pipeline, index),
        );
      },
      resolveUnattendedInteractions: (provider, providerSessionId) =>
        resolveUnattendedReviewerInteractions(provider, providerSessionId, async () => {}),
      abandonSession: (selection, providerSessionId) =>
        this.abandonSession(pipeline, selection.agent as BuildPipelineAgent, providerSessionId),
      // The stage rail shows the same usage line as standalone Multi Review.
      // Keep the counter in the authoritative fan-out record until it can be
      // projected onto the durable pipeline session below. Persist the meter
      // with the transcript throttle, not on every poll.
      captureReviewerUsage: true,
      persistReviewerUsageImmediately: false,
      onReviewerObserved: (reviewer, index, provider, readTranscript, settling) =>
        this.mirrorReviewerSession(pipeline, reviewer, index, provider, readTranscript, settling),
      progress: this.deps.progress,
      concurrency: this.deps.concurrency,
      efficiency: this.deps.efficiency,
      efficiencyOwner: "build-pipeline",
      stallWarningMs: this.deps.stallWarningMs,
      stallAbandonMs: this.deps.stallAbandonMs,
    };
  }

  /**
   * Keeps one reviewer visible as a pipeline session.
   *
   * Created lazily rather than up front, because a reviewer has no provider
   * session until the runner opens one, and a session record with no session id
   * would fail snapshot validation and take the whole pipeline offline.
   *
   * The transcript is read only when this pass could persist it — the persist
   * throttle is due, the session's status changes, or the turn is settling and
   * this may be the last look. A copy refreshed in memory and never saved was
   * previously paid for on every pass and then discarded with the pass.
   */
  private async mirrorReviewerSession(
    pipeline: BuildPipeline,
    reviewer: ReviewerRecord,
    index: number,
    provider: BuildPipelineProvider,
    readTranscript: () => Promise<readonly unknown[]>,
    settling: boolean,
  ): Promise<void> {
    if (!reviewer.providerSessionId || !reviewer.sessionKey) return;
    const session = this.ensureSession(pipeline, {
      sessionKey: reviewer.sessionKey,
      sdkSessionId: reviewer.providerSessionId,
      agent: reviewer.agent as BuildPipelineAgent,
      label: pipelineIndependentReviewLabel(index),
      model: reviewer.modelUnpinned ? undefined : reviewer.model,
      modelSubstitution: reviewer.modelSubstitution,
      reasoningEffort: reviewer.reasoningEffort,
      startedAt: reviewer.startedAt,
      tokenCount: reviewer.tokenCount,
    });
    let metadataChanged = false;
    if (!reviewer.modelUnpinned && session.model !== reviewer.model) {
      session.model = reviewer.model;
      metadataChanged = true;
    }
    if (
      reviewer.reasoningEffort !== undefined &&
      session.reasoningEffort !== reviewer.reasoningEffort
    ) {
      session.reasoningEffort = reviewer.reasoningEffort;
      metadataChanged = true;
    }
    // Token counts change on essentially every poll. Treat them as a
    // transcript-class delta so they cannot bypass the persist throttle and
    // write this pipeline's control row once per reviewer per tick.
    const tokenCountChanged =
      reviewer.tokenCount !== undefined && session.tokenCount !== reviewer.tokenCount;
    // The runner mirrors before it changes reviewer.status. Project the observed
    // terminal transition now so it forces exactly one final read.
    const status = reviewer.status === "running" && !settling ? "running" : "idle";
    const statusChanged = session.status !== status;
    const persistDue = this.deps.shouldPersistTranscript(session);
    // A status change reads the whole transcript unconditionally, so a reviewer
    // that just finished keeps its final copy; otherwise only a moved probe does.
    const changed =
      persistDue || statusChanged || settling
        ? await this.deps.refreshMovedTranscript(session, provider, {
            force: statusChanged,
            read: readTranscript,
          })
        : false;
    if (
      metadataChanged ||
      statusChanged ||
      ((changed || tokenCountChanged) && persistDue) ||
      (changed && settling)
    ) {
      if (tokenCountChanged) session.tokenCount = reviewer.tokenCount;
      session.status = status;
      session.messagesPersistedAt = reviewFanoutNowIso();
      await this.save(pipeline);
    }
  }

  /** Projects each reviewer's settled state onto the session the tab renders. */
  private async settleReviewerSessions(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
  ): Promise<void> {
    let changed = false;
    for (const reviewer of state.reviewers) {
      if (!reviewer.sessionKey) continue;
      const session = pipeline.sessions.find(
        (candidate) => candidate.sessionKey === reviewer.sessionKey,
      );
      if (!session) continue;
      const settled = reviewer.status !== "pending" && reviewer.status !== "running";
      // A running reviewer record may be waiting for its final usage/result
      // after its provider turn ended. Keep the status mirroring observed, or
      // every idle poll would look like another terminal transition.
      if (settled && session.status !== "idle") {
        session.status = "idle";
        changed = true;
      }
      if (reviewer.report && !session.reviewReport) {
        session.reviewReport = reviewer.report;
        session.structuredRequestId = reviewer.requestId;
        session.structuredResultStatus = "accepted";
        changed = true;
      }
      if (reviewer.report && !session.reviewIssueCounts) {
        session.reviewIssueCounts = pipelineReviewIssueCounts(reviewer.report);
        changed = true;
      }
      // The fan-out record is retired with its pass; the session keeps how
      // this attempt ended, so the graph can still show a failed reviewer.
      const outcome =
        reviewer.status === "completed" ||
        reviewer.status === "failed" ||
        reviewer.status === "cancelled"
          ? reviewer.status
          : undefined;
      if (outcome && session.reviewerOutcome !== outcome) {
        session.reviewerOutcome = outcome;
        changed = true;
      }
      const error =
        reviewer.status === "failed" && reviewer.error?.trim()
          ? boundedPipelineSessionError(reviewer.error)
          : undefined;
      if (error && session.error !== error) {
        session.error = error;
        changed = true;
      }
      if (reviewer.completedAt && session.completedAt !== reviewer.completedAt) {
        session.completedAt = reviewer.completedAt;
        changed = true;
      }
      if (
        settled &&
        reviewer.tokenCount !== undefined &&
        session.tokenCount !== reviewer.tokenCount
      ) {
        session.tokenCount = reviewer.tokenCount;
        changed = true;
      }
      if (
        settled &&
        reviewer.cacheReadTokens !== undefined &&
        session.cacheReadTokens !== reviewer.cacheReadTokens
      ) {
        session.cacheReadTokens = reviewer.cacheReadTokens;
        changed = true;
      }
    }
    if (changed) await this.save(pipeline);
  }

  private ensureSession(
    pipeline: BuildPipeline,
    fields: {
      sessionKey: string;
      sdkSessionId: string;
      agent: BuildPipelineAgent;
      label: string;
      model?: string;
      modelSubstitution?: NativeAgentModelSubstitution;
      reasoningEffort?: string;
      startedAt?: string;
      tokenCount?: number;
      fastMode?: boolean;
    },
  ): PipelineSession {
    const existing = pipeline.sessions.find(
      (candidate) => candidate.sessionKey === fields.sessionKey,
    );
    if (existing) {
      existing.reviewPassId ??= pipeline.reviewFanout?.reviewers[0]?.id;
      return existing;
    }
    const session: PipelineSession = {
      phase: "review",
      agent: fields.agent,
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      iteration: pipeline.iteration,
      // Reviewer IDs are allocated once per full launch and survive individual retries.
      reviewPassId: pipeline.reviewFanout?.reviewers[0]?.id,
      sessionKey: fields.sessionKey,
      sdkSessionId: fields.sdkSessionId,
      status: "running",
      startedAt: fields.startedAt ?? reviewFanoutNowIso(),
      label: fields.label,
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields.modelSubstitution ? { modelSubstitution: fields.modelSubstitution } : {}),
      ...(fields.reasoningEffort ? { reasoningEffort: fields.reasoningEffort } : {}),
      ...(fields.tokenCount === undefined ? {} : { tokenCount: fields.tokenCount }),
      ...(typeof fields.fastMode === "boolean" ? { fastMode: fields.fastMode } : {}),
      messageRevision: 0,
    };
    pipeline.sessions.push(session);
    // The tab follows the newest session, which is the one the user most likely
    // wants to watch. The supervisor's single-session tick path is not running
    // while the fan-out owns the phase, so this only affects presentation.
    pipeline.currentSessionIndex = pipeline.sessions.length - 1;
    return session;
  }

  private async abandonSession(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent,
    providerSessionId: string,
  ): Promise<void> {
    try {
      const provider = await this.deps.provider(pipeline, agent);
      await provider.abort(providerSessionId);
    } catch {
      // Intentionally ignored; the caller is discarding this session either way.
    }
  }

  // -------------------------------------------------------------------------
  // Consolidation
  // -------------------------------------------------------------------------

  /**
   * Merges the reviewer reports on the same model that prepared their package.
   */
  /**
   * Reads the accepted consolidated report and refreshes the projected
   * delivery state on the same poll, so a renderer rehydrating from the
   * snapshot sees a status the controller wrote.
   */
  private async readConsolidationResult(
    consolidation: NonNullable<ReviewFanoutState["consolidation"]>,
  ): Promise<StructuredOutputResult<unknown> | null> {
    if (!this.deps.workflowResults) return null;
    consolidation.resultSubmission = await this.deps.workflowResults.projection(
      consolidation.requestId,
    );
    return this.deps.workflowResults.structured<unknown>(consolidation.requestId);
  }

  private async advanceConsolidation(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
    targetBranch: string,
  ): Promise<ReviewFanoutStep> {
    if (!state.consolidation) {
      const step = pipeline.reviewPreparation
        ? await this.deps.settingsForSelection(pipeline, {
            agent: pipeline.reviewPreparation.agent,
            model: pipeline.reviewPreparation.model,
            effort: pipeline.reviewPreparation.reasoningEffort,
          })
        : await this.deps.stepSettings(pipeline, "address");
      const provider = await this.deps.provider(pipeline, step.agent);
      const sessionKey = `${pipeline.id}:review-consolidation:${pipeline.iteration}:${randomUUID()}`;
      const providerSessionId = await provider.createSession("review", "Review · Consolidation", {
        clientSessionKey: sessionKey,
        ...CONSOLIDATION_TURN,
        model: step.model,
        effort: step.effort,
        ...(typeof step.fastMode === "boolean" ? { fastMode: step.fastMode } : {}),
        policy: await this.deps.executionPolicy(pipeline),
        interaction: {
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "review",
          workflowId: pipeline.id,
          provider: step.agent,
          fence: sessionKey,
        },
      });
      state.consolidation = {
        sessionKey,
        providerSessionId,
        requestId: randomUUID(),
        state: "prepared",
        createdAt: reviewFanoutNowIso(),
        agent: step.agent,
        resultTransport:
          this.deps.workflowResults &&
          this.deps.agentMcp &&
          this.deps.workflowToolEnabled?.(step.agent, CONSOLIDATION_RESULT_KIND)
            ? "tool-v1"
            : "structured-output-v1",
        ...(this.deps.workflowResults &&
        this.deps.agentMcp &&
        this.deps.workflowToolEnabled?.(step.agent, CONSOLIDATION_RESULT_KIND)
          ? { resultSubmission: "preparing" as const }
          : {}),
        ...(step.model ? { model: step.model } : {}),
        ...(step.modelSubstitution ? { modelSubstitution: step.modelSubstitution } : {}),
        ...(step.effort ? { reasoningEffort: step.effort } : {}),
        ...(typeof step.fastMode === "boolean" ? { fastMode: step.fastMode } : {}),
      };
      await this.save(pipeline);
    }

    const consolidation = state.consolidation;
    const provider = await this.deps.provider(pipeline, consolidation.agent as BuildPipelineAgent);
    const session = this.ensureSession(pipeline, {
      sessionKey: consolidation.sessionKey,
      sdkSessionId: consolidation.providerSessionId,
      agent: consolidation.agent as BuildPipelineAgent,
      label: "Consolidation",
      model: consolidation.model,
      reasoningEffort: consolidation.reasoningEffort,
      fastMode: consolidation.fastMode,
      modelSubstitution: consolidation.modelSubstitution,
    });
    // Sessionless failures have no transcript/session row to retain their outcome.
    // Keep only their bounded diagnostics on this pass's consolidation session.
    session.sessionlessReviewers = state.reviewers.flatMap((reviewer, slot) =>
      reviewer.status === "failed" &&
      !pipeline.sessions.some((candidate) => candidate.sessionKey === reviewer.sessionKey)
        ? [
            {
              id: reviewer.id.slice(0, 128),
              slot,
              agent: reviewer.agent as BuildPipelineAgent,
              ...(reviewer.model && !reviewer.modelUnpinned
                ? { model: reviewer.model.slice(0, 256) }
                : {}),
              ...(reviewer.reasoningEffort
                ? { reasoningEffort: reviewer.reasoningEffort.slice(0, 128) }
                : {}),
              error: boundedPipelineSessionError(
                reviewer.error ?? "Reviewer session creation failed",
              ),
            },
          ]
        : [],
    );
    session.model ??= consolidation.model;
    session.reasoningEffort ??= consolidation.reasoningEffort;
    provider.registerSession?.(consolidation.providerSessionId, {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "review",
      workflowId: pipeline.id,
      provider: consolidation.agent,
      fence: consolidation.sessionKey,
    });

    if (consolidation.state === "prepared") {
      // Build the prompt while dispatch is still unjournaled. A schema repair
      // re-sends an already-answered prompt with the same reviewer evidence.
      let prompt = consolidation.continuationPrompt ?? consolidation.schemaRepairPrompt;
      if (!prompt) {
        prompt = withBuildStepInstructions(
          createReviewConsolidationPrompt({
            targetBranch,
            reports: consolidationReports(state.reviewers),
            onEvidenceStats: (stats) =>
              recordEfficiency(this.deps.efficiency, {
                owner: "build-pipeline",
                operation: "consolidation.input",
                phase: "consolidating",
                reviewers: stats.reviewers,
                count: stats.sourceFindings,
                bytes: stats.compactBytes,
              }),
          }),
          pipelineReviewPreparationInstructions(pipeline),
        );
      }
      const agentMcp =
        consolidation.resultTransport === "tool-v1"
          ? await this.deps.agentMcp?.(
              pipeline,
              consolidation.requestId,
              consolidation.agent,
              "build pipeline consolidation step",
            )
          : undefined;
      if (consolidation.resultTransport === "tool-v1" && this.deps.workflowResults) {
        await this.deps.workflowResults.prepare({
          resultKey: consolidation.requestId,
          kind: CONSOLIDATION_RESULT_KIND,
          environmentId: pipeline.environmentId,
          projectId: pipeline.projectId,
          provider: consolidation.agent,
          schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema,
          context: consolidationResultContext(state.reviewers),
        });
      }
      const artifactTurn = beginWorkflowArtifactTurn(this.deps.artifactDispatch, {
        environmentId: pipeline.environmentId,
        projectId: pipeline.projectId,
        conversationKey: consolidation.sessionKey,
        turnId: consolidation.requestId,
        providerSessionId: consolidation.providerSessionId,
        agent: consolidation.agent,
        ...(agentMcp ? { agentMcp } : {}),
      });
      const turnAgentMcp = artifactTurn?.agentMcp ?? agentMcp;
      await attachAgentBeforeDispatch(
        provider,
        consolidation.providerSessionId,
        turnAgentMcp
          ? {
              agentMcp: turnAgentMcp,
              workflowResultTool: workflowResultToolName(CONSOLIDATION_RESULT_KIND),
            }
          : undefined,
      );
      delete session.completedAt;
      delete session.usageFinalizationPolls;
      consolidation.state = "dispatching";
      await this.save(pipeline);
      try {
        await provider.send(
          consolidation.providerSessionId,
          consolidation.resultTransport === "tool-v1"
            ? `${prompt}\n\n${workflowResultInstruction(
                CONSOLIDATION_RESULT_KIND,
                consolidation.requestId,
                { capability: agentMcp?.workflowResultCapability },
              )}`
            : prompt,
          {
            requestId: consolidation.requestId,
            schema:
              consolidation.resultTransport === "tool-v1"
                ? undefined
                : (STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema),
            ...CONSOLIDATION_TURN,
            model: consolidation.model,
            effort: consolidation.reasoningEffort,
            ...(typeof consolidation.fastMode === "boolean"
              ? { fastMode: consolidation.fastMode }
              : {}),
            ...(turnAgentMcp ? { agentMcp: turnAgentMcp } : {}),
            ...(artifactTurn?.artifactGrant ? { artifactGrant: artifactTurn.artifactGrant } : {}),
            ...(agentMcp
              ? {
                  workflowResultTool: workflowResultToolName(CONSOLIDATION_RESULT_KIND),
                  workflowResultKey: consolidation.requestId,
                }
              : {}),
          },
        );
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) return { kind: "working" };
        this.settleConsolidationArtifactTurn(pipeline, consolidation);
        consolidation.state = "prepared";
        await this.save(pipeline);
        if (error instanceof ProviderDispatchPreparationError) return { kind: "working" };
        throw error;
      }
      consolidation.state = "sent";
      delete consolidation.continuationPrompt;
      session.status = "running";
      await this.save(pipeline);
    }
    if (consolidation.state === "dispatching") {
      // Session status can still belong to a superseded request. Require
      // acceptance of this exact ID before observing it or spending a follow-up.
      const acceptance = await recoveredDispatchAcceptance(
        provider,
        consolidation.providerSessionId,
        consolidation.requestId,
        consolidation.resultTransport === "tool-v1"
          ? () => this.deps.workflowResults?.structured<unknown>(consolidation.requestId)
          : undefined,
      );
      if (acceptance === "absent") {
        // Proven never delivered: back to `prepared`, as after a send refused
        // before the prompt was written, so the next pass sends it again under
        // the same id.
        delete consolidation.idleResultPolls;
        consolidation.state = "prepared";
        await this.save(pipeline);
        return { kind: "working" };
      }
      if (acceptance !== "dispatched" && acceptance !== "pending") {
        return this.countIdlePoll(
          pipeline,
          state,
          "The consolidation dispatch acceptance could not be confirmed",
        );
      }
      delete consolidation.idleResultPolls;
      consolidation.state = "sent";
      delete consolidation.continuationPrompt;
      await this.save(pipeline);
    }

    await resolveUnattendedReviewerInteractions(
      provider,
      consolidation.providerSessionId,
      async () => {},
    );
    const {
      status,
      error: statusDetail,
      turnSettled,
      backgroundWorkLive,
      interruption,
      contextUsage,
      usagePending,
    } = await readProviderStatus(
      provider,
      consolidation.providerSessionId,
      consolidation.requestId,
    );
    if ((status === "idle" || status === "error") && turnSettled === false)
      return { kind: "working" };
    // A running session's transcript is looked at only at the persist
    // boundary, and its whole body is read only when the bounded probe shows
    // it moved since the committed copy; an unchanged one costs no body and no
    // save. The first terminal observation forces a final read; later idle
    // polls stay conditional. Progress observation reads its own bounded tail
    // on its own cadence.
    const persistDue = this.deps.shouldPersistTranscript(session);
    const observedStatus = status === "running" || backgroundWorkLive ? "running" : "idle";
    const statusChanged = session.status !== observedStatus;
    const turnEnded = statusChanged && observedStatus === "idle";
    const completionChanged = observedStatus === "idle" && session.completedAt === undefined;
    if (observedStatus === "idle") session.completedAt ??= reviewFanoutNowIso();
    if (turnEnded) this.settleConsolidationArtifactTurn(pipeline, consolidation);
    if (status !== "running" || persistDue || statusChanged) {
      const transcript = sharedTranscriptRead(provider, consolidation.providerSessionId);
      const changed = await this.deps.refreshMovedTranscript(session, provider, {
        force: turnEnded,
        read: transcript.read,
      });
      // Usage rides the same cadence as the transcript: every terminal look,
      // and the persist boundary while the turn runs.
      const usageChanged = await recordPipelineSessionUsage(
        session,
        provider,
        contextUsage,
        transcript.taken(),
      );
      if (changed || statusChanged || completionChanged || usageChanged) {
        session.status = observedStatus;
        session.messagesPersistedAt = reviewFanoutNowIso();
        await this.save(pipeline);
      }
    }
    if (status === "running") {
      if (consolidation.idleResultPolls !== undefined) {
        delete consolidation.idleResultPolls;
        await this.save(pipeline);
      }
      return this.observeConsolidationProgress(pipeline, state, provider);
    }
    if (status === "blocked") {
      // Every unattended interaction was already resolved above, so a provider
      // still reporting blocked cannot be waited on indefinitely.
      return this.countIdlePoll(
        pipeline,
        state,
        "The consolidation session stayed blocked without a resolvable interaction",
      );
    }
    const restartInterrupted = status === "error" && interruption === "restart";
    if ((status === "error" && !restartInterrupted) || status === "missing") {
      return {
        kind: "failed",
        error:
          status === "missing"
            ? "The consolidation session no longer exists"
            : statusDetail
              ? `The consolidation session failed: ${statusDetail}`
              : "The consolidation session failed",
      };
    }

    const result =
      consolidation.resultTransport === "tool-v1"
        ? ((await this.readConsolidationResult(consolidation)) ?? null)
        : await provider.structured<unknown>(
            consolidation.providerSessionId,
            consolidation.requestId,
          );
    if (restartInterrupted && result?.ok !== true) {
      if (consolidation.restartContinuationSent) {
        return {
          kind: "failed",
          error: `The consolidation session failed: ${statusDetail ?? "interrupted again"}`,
        };
      }
      await this.prepareConsolidationFollowUp(
        pipeline,
        consolidation,
        "restartContinuationSent",
        workflowRestartContinuationPrompt({
          workLabel: "consolidation",
          resultLabel: "consolidated report",
          ...(consolidation.resultTransport === "tool-v1"
            ? { toolName: workflowResultToolName(CONSOLIDATION_RESULT_KIND) }
            : {}),
        }),
      );
      return { kind: "working" };
    }
    if (!result) {
      if (backgroundWorkLive) {
        if (consolidation.idleResultPolls !== undefined) {
          delete consolidation.idleResultPolls;
          await this.save(pipeline);
        }
        return this.observeConsolidationProgress(pipeline, state, provider);
      }
      return this.countIdlePoll(
        pipeline,
        state,
        consolidation.resultTransport === "tool-v1"
          ? missingWorkflowResultMessage({
              subject: "The consolidation session",
              resultLabel: "consolidated report",
              toolName: workflowResultToolName(CONSOLIDATION_RESULT_KIND),
              submission: consolidation.resultSubmission,
              finalText: lastAssistantText(session.messages),
            })
          : "The consolidation session became idle without returning its consolidated report",
        () => this.prepareConsolidationResultReminder(pipeline, consolidation, session),
      );
    }
    let parsed: ReturnType<typeof parseStructuredReportResult>;
    try {
      parsed = parseStructuredReportResult(result, state.reviewers);
    } catch (error) {
      return { kind: "failed", error: reviewFanoutErrorMessage(error) };
    }
    if (!parsed.success) {
      return this.prepareConsolidationRepair(pipeline, state, parsed.error);
    }
    const provenance = deriveConsolidatedProvenance(parsed.data, state.reviewers);
    if (provenance.issues.length > 0) {
      return this.prepareConsolidationRepair(
        pipeline,
        state,
        new ReviewContractValidationError("structured-review-report", provenance.issues),
      );
    }
    const previousUsagePolls = session.usageFinalizationPolls;
    if (deferPipelineSessionUsage(session, usagePending, this.deps.pollGate?.(pipeline))) {
      if (previousUsagePolls !== session.usageFinalizationPolls) await this.save(pipeline);
      return { kind: "working" };
    }
    // The consolidated report is consumed here. The submit-time check let the
    // consolidator repair a change within its turn; this one decides.
    const violation = await this.deps.workspaceViolation(pipeline, "consolidation");
    if (violation) return { kind: "failed", error: violation };
    state.report = provenance.report;
    session.status = "idle";
    session.reviewReport = provenance.report;
    session.reviewOverlap = consolidationOverlap(parsed.data, state.reviewers);
    session.reviewIssueCounts = pipelineReviewIssueCounts(provenance.report);
    session.structuredRequestId = consolidation.requestId;
    session.structuredResultStatus = "accepted";
    pipeline.structuredReview = provenance.report;
    retainRoundReviewReport(pipeline, session, provenance.report);
    pipeline.structuredReviewRequestId = consolidation.requestId;
    if (consolidation.resultTransport === "tool-v1") {
      pipeline.pendingResultConsumptions = Array.from(
        new Set([...(pipeline.pendingResultConsumptions ?? []), consolidation.requestId]),
      );
    }
    await this.save(pipeline);
    if (consolidation.resultTransport === "tool-v1") {
      try {
        await this.deps.workflowResults?.consume(consolidation.requestId);
        delete consolidation.resultSubmission;
        const pending = (pipeline.pendingResultConsumptions ?? []).filter(
          (candidate) => candidate !== consolidation.requestId,
        );
        if (pending.length > 0) pipeline.pendingResultConsumptions = pending;
        else delete pipeline.pendingResultConsumptions;
        await this.save(pipeline);
      } catch (error) {
        pipeline.pendingResultConsumptions = Array.from(
          new Set([...(pipeline.pendingResultConsumptions ?? []), consolidation.requestId]),
        );
        console.warn(
          `[build-pipeline] Deferred consolidation result consumption: ${reviewFanoutErrorMessage(error)}`,
        );
      }
    }
    return { kind: "consolidated" };
  }

  private async observeConsolidationProgress(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
    provider: BuildPipelineProvider,
  ): Promise<ReviewFanoutStep> {
    const consolidation = state.consolidation;
    if (!consolidation) return { kind: "working" };
    const previousDigest = consolidation.progressDigest;
    const observation = await this.deps.progress.observe(
      consolidation.providerSessionId,
      (known) =>
        readTranscriptProgressSample({
          provider,
          sessionId: consolidation.providerSessionId,
          known,
        }),
      consolidation.progressDigest,
    );
    const decision = commitProgressObservation(consolidation, observation);
    if (decision === "reset" || decision === "hold") {
      await this.save(pipeline);
      return { kind: "working" };
    }
    const elapsedMs = noProgressElapsedMs(consolidation.progressAt, consolidation.createdAt);
    if (elapsedMs === null) {
      if (consolidation.progressDigest !== previousDigest) await this.save(pipeline);
      return { kind: "working" };
    }
    if (elapsedMs >= (this.deps.stallAbandonMs ?? DEFAULT_STALL_ABANDON_MS)) {
      await this.abandonSession(
        pipeline,
        consolidation.agent as BuildPipelineAgent,
        consolidation.providerSessionId,
      );
      this.deps.progress.forget(consolidation.providerSessionId);
      return {
        kind: "failed",
        error: `The consolidation session produced no activity for ${stalledMinutes(elapsedMs)} minutes`,
      };
    }
    if (
      elapsedMs >= (this.deps.stallWarningMs ?? DEFAULT_STALL_WARNING_MS) &&
      consolidation.stalledSince === undefined
    ) {
      consolidation.stalledSince = reviewFanoutNowIso();
      await this.save(pipeline);
      return { kind: "working" };
    }
    if (consolidation.progressDigest !== previousDigest) await this.save(pipeline);
    return { kind: "working" };
  }

  /**
   * Counts one idle poll, failing once the bound is reached. `remind`, when
   * given, may claim the exhausted bound for one more turn instead.
   */
  private async countIdlePoll(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
    error: string,
    remind?: () => Promise<boolean>,
  ): Promise<ReviewFanoutStep> {
    const consolidation = state.consolidation;
    if (!consolidation) return { kind: "working" };
    consolidation.idleResultPolls = (consolidation.idleResultPolls ?? 0) + 1;
    await this.save(pipeline);
    if (consolidation.idleResultPolls >= MAX_REVIEW_IDLE_RESULT_POLLS) {
      if (remind && (await remind())) return { kind: "working" };
      return { kind: "failed", error };
    }
    return { kind: "working" };
  }

  /**
   * Queues the consolidation's one reminder to submit a report it never
   * delivered through its result tool, as the reviewers and Multi Review's
   * consolidation get. Returns false when it does not apply or was spent.
   */
  private async prepareConsolidationResultReminder(
    pipeline: BuildPipeline,
    consolidation: ReviewConsolidationSession,
    session: PipelineSession,
  ): Promise<boolean> {
    if (
      consolidation.resultTransport !== "tool-v1" ||
      consolidation.resultReminderSent === true ||
      // Accepted-but-unread and budget-exhausted slots are not a delivery gap
      // another turn can close.
      consolidation.resultSubmission === "received" ||
      consolidation.resultSubmission === "needs-attention"
    ) {
      return false;
    }
    await this.prepareConsolidationFollowUp(
      pipeline,
      consolidation,
      "resultReminderSent",
      workflowResultReminderPrompt({
        resultLabel: "consolidated report",
        toolName: workflowResultToolName(CONSOLIDATION_RESULT_KIND),
        submission: consolidation.resultSubmission,
        finalText: lastAssistantText(session.messages),
        workLabel: "consolidation work",
      }),
    );
    return true;
  }

  /**
   * One automatic follow-up turn in the consolidation's own session under a
   * new request id; the spent flag is saved with it, before the old slot is
   * retired.
   */
  private async prepareConsolidationFollowUp(
    pipeline: BuildPipeline,
    consolidation: ReviewConsolidationSession,
    spend: "restartContinuationSent" | "resultReminderSent",
    prompt: string,
  ): Promise<void> {
    const previousRequestId = consolidation.requestId;
    consolidation.requestId = randomUUID();
    consolidation.state = "prepared";
    consolidation.createdAt = reviewFanoutNowIso();
    consolidation[spend] = true;
    consolidation.continuationPrompt = prompt;
    delete consolidation.schemaRepairPrompt;
    delete consolidation.idleResultPolls;
    delete consolidation.progressDigest;
    delete consolidation.stalledSince;
    consolidation.progressAt = consolidation.createdAt;
    if (consolidation.resultTransport === "tool-v1") consolidation.resultSubmission = "preparing";
    await this.save(pipeline);
    if (consolidation.resultTransport === "tool-v1") {
      await this.deps.workflowResults?.close(previousRequestId, "superseded");
    }
  }

  /**
   * Asks the consolidation session to re-emit a report the contract rejected.
   *
   * Repairing inside the same session is what keeps the reviewer reports in
   * play: they are in its context, and restarting the stage would spend every
   * reviewer's turn again to fix a formatting fault.
   */
  private async prepareConsolidationRepair(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
    error: ReviewContractValidationError,
  ): Promise<ReviewFanoutStep> {
    const consolidation = state.consolidation;
    if (!consolidation) return { kind: "working" };
    const attempt = (consolidation.schemaRepairAttempts ?? 0) + 1;
    if (attempt > MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS) {
      return {
        kind: "failed",
        error: `${error.message} The consolidation could not produce a valid report in ${MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS} repair attempts.`,
      };
    }
    const previousRequestId = consolidation.requestId;
    const previousTransport = consolidation.resultTransport;
    consolidation.schemaRepairAttempts = attempt;
    consolidation.schemaRepairPrompt = structuredReportRepairPrompt(
      error.issues,
      attempt,
      MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS,
    );
    consolidation.requestId = randomUUID();
    consolidation.state = "prepared";
    delete consolidation.idleResultPolls;
    if (previousTransport === "tool-v1") {
      await this.deps.workflowResults?.close(previousRequestId, "superseded");
    }
    await this.save(pipeline);
    return { kind: "working" };
  }
}

/**
 * The conversation key for a reviewer's next session. The first attempt keeps
 * the key it always had; a retry gets a numbered one, because the failed
 * attempt's session stays in the pipeline under the original key.
 */
export function reviewerSessionKey(
  pipeline: Pick<BuildPipeline, "id" | "iteration" | "sessions">,
  reviewer: Pick<ReviewerRecord, "id">,
): string {
  const base = `${pipeline.id}:review:${pipeline.iteration}:${reviewer.id}`;
  const taken = new Set(pipeline.sessions.map((session) => session.sessionKey));
  if (!taken.has(base)) return base;
  let attempt = 2;
  while (taken.has(`${base}:attempt-${attempt}`)) attempt += 1;
  return `${base}:attempt-${attempt}`;
}

/** Returns a failed reviewer to the admission queue for a fresh attempt. */
export function resetReviewerForRetry(reviewer: ReviewerRecord): void {
  reviewer.status = "pending";
  clearReviewerAdmission(reviewer);
  dropProvisionalFindings(reviewer);
  delete reviewer.sessionKey;
  delete reviewer.providerSessionId;
  delete reviewer.requestId;
  delete reviewer.dispatchState;
  delete reviewer.resultTransport;
  delete reviewer.resultSubmission;
  delete reviewer.schemaRepairAttempts;
  delete reviewer.schemaRepairPrompt;
  delete reviewer.continuationPrompt;
  delete reviewer.resultReminderSent;
  delete reviewer.restartContinuationSent;
  delete reviewer.idleResultPolls;
  delete reviewer.progressAt;
  delete reviewer.progressDigest;
  delete reviewer.stalledSince;
  delete reviewer.tokenCount;
  delete reviewer.cacheReadTokens;
  delete reviewer.usageFinalizationPolls;
  delete reviewer.commandSandboxOff;
  delete reviewer.report;
  delete reviewer.error;
  delete reviewer.startedAt;
  delete reviewer.completedAt;
}

function reviewerFromConfig(config: BuildStepSelection): ReviewerRecord {
  const model = config.model?.trim();
  return {
    id: randomUUID(),
    agent: config.agent,
    // A reviewer record requires a concrete model id, so a step that pinned
    // none is labelled with the same placeholder the launcher shows — but
    // flagged, because the placeholder is not the selection. `"default"` is a
    // real Claude model, so inferring "unpinned" from the string would run an
    // unconfigured Claude reviewer on Opus 1M while the single-reviewer stage
    // ran it on the repository default.
    model: model || "default",
    ...(model ? {} : { modelUnpinned: true }),
    ...(model && config.modelSubstitution?.modelId === model
      ? { modelSubstitution: config.modelSubstitution }
      : {}),
    ...(config.effort ? { reasoningEffort: config.effort } : {}),
    ...(typeof config.fastMode === "boolean" ? { fastMode: config.fastMode } : {}),
    status: "pending",
  };
}

function completedReviewerCount(reviewers: readonly ReviewerRecord[]): number {
  return reviewers.filter((reviewer) => reviewer.status === "completed").length;
}
