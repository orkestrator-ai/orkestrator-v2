/**
 * The build pipeline's multi-model review stage.
 *
 * When a pipeline is configured with more than one reviewer, its review phase
 * stops being one agent answering the structured-review contract and becomes
 * the same fan-out Multi Review runs: N reviewers against one pinned worktree
 * state, then a consolidation turn that merges their reports into the single
 * {@link BuildPipeline.structuredReview} the address stage already consumes.
 * Nothing downstream of the review stage learns there was more than one
 * reviewer — that is the whole point of consolidating here rather than
 * teaching every later stage about a list.
 *
 * The reviewer turn itself is not implemented here. It lives in
 * `review-fanout.ts` and is shared with Multi Review, so a fix to a wedged
 * reviewer, a schema repair or a dispatch race lands in both at once. What this
 * module owns is what only the pipeline knows: that its state is a field on the
 * pipeline snapshot, that its reviewers are mirrored into `pipeline.sessions`
 * so the build tab can render them, and that consolidation runs on the address
 * step's model.
 *
 * Every reviewer is also a real {@link PipelineSession}. That is deliberate:
 * the build tab, the interaction summaries and the review handoff prompt all
 * read `pipeline.sessions`, so a reviewer that existed only inside the fan-out
 * record would be invisible to a user watching the build and unreachable to the
 * address stage that has to quote it. The supervisor's single-session tick path
 * is skipped entirely while the fan-out is live; these sessions are driven from
 * here.
 */
import { randomUUID } from "node:crypto";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  pipelineReviewerConfigs,
  type BuildPipeline,
  type BuildPipelineAgent,
  type BuildStepConfig,
  type PipelineSession,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewerRecord, ReviewFanoutState } from "@orkestrator/protocol/review-fanout";
import {
  ReviewContractValidationError,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import {
  AmbiguousPromptDispatchError,
  readProviderStatus,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import { structuredReportRepairPrompt } from "./build-pipeline-prompts.js";
import {
  MAX_REVIEW_IDLE_RESULT_POLLS,
  MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS,
  ReviewFanoutRunner,
  assertReviewSnapshotCurrent,
  attachAgentBeforeDispatch,
  captureReviewWorktreeSnapshot,
  commitProgressObservation,
  consolidationReports,
  createReviewConsolidationPrompt,
  deriveConsolidatedProvenance,
  parseStructuredReportResult,
  promptWorktreeSnapshot,
  resolveUnattendedReviewerInteractions,
  reviewFanoutErrorMessage,
  reviewFanoutNowIso,
  type ReviewFanoutHost,
} from "./review-fanout.js";
import {
  DEFAULT_STALL_ABANDON_MS,
  DEFAULT_STALL_WARNING_MS,
  MultiReviewProgressTracker,
  PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
  noProgressElapsedMs,
  stalledMinutes,
} from "./multi-review-progress.js";

/** Names the pipeline in reviewer-facing and user-facing failure text. */
const FANOUT_LABEL = "Multi-model review";

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** What the fan-out needs from the supervisor that owns the pipeline. */
export interface BuildPipelineReviewFanoutDeps {
  invoke: CommandInvoker;
  provider(pipeline: BuildPipeline, agent: BuildPipelineAgent): Promise<BuildPipelineProvider>;
  save(pipeline: BuildPipeline): Promise<void>;
  stepSettings(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
  ): Promise<{ agent: BuildPipelineAgent; model?: string; effort?: string }>;
  refreshTranscript(session: PipelineSession, provider: BuildPipelineProvider): Promise<boolean>;
  shouldPersistTranscript(session: PipelineSession): boolean;
  /** The branch the diff is reviewed against, as the review prompt states it. */
  targetBranch(pipeline: BuildPipeline): Promise<string>;
  progress: MultiReviewProgressTracker;
  stallWarningMs?: number;
  stallAbandonMs?: number;
}

/** What the supervisor should do after one fan-out pass. */
export type ReviewFanoutStep =
  /** Still working. The supervisor returns without touching the pipeline. */
  | { kind: "working" }
  /** The consolidated report is on the pipeline; start the address stage. */
  | { kind: "consolidated" }
  /** The stage failed. The supervisor applies its usual failure handling. */
  | { kind: "failed"; error: string };

export class BuildPipelineReviewFanout {
  constructor(private readonly deps: BuildPipelineReviewFanoutDeps) {}

  /**
   * Pins the worktree and opens the fan-out.
   *
   * The snapshot is captured before any session exists, for the same reason the
   * single-reviewer stage probes before dispatch: a stage that could never be
   * certified is not worth an agent turn, and failing afterwards would discard
   * completed reviews and report them as a Git error.
   */
  async start(pipeline: BuildPipeline): Promise<void> {
    const snapshot = await captureReviewWorktreeSnapshot(
      this.deps.invoke,
      pipeline.environmentId,
      FANOUT_LABEL,
    );
    pipeline.reviewFanout = {
      reviewers: pipelineReviewerConfigs(pipeline).map((config) => reviewerFromConfig(config)),
      snapshot,
    };
    pipeline.phase = "reviewing";
    delete pipeline.structuredReview;
    delete pipeline.structuredReviewRequestId;
    delete pipeline.error;
    delete pipeline.failureContext;
    // A retried review must not inherit the previous attempt's dangling prompt
    // state: the fan-out has no single pending attempt of its own.
    delete pipeline.pendingPromptAttempt;
    delete pipeline.activePromptContext;
    await this.deps.save(pipeline);
  }

  /** Advances the fan-out by one supervisor pass. */
  async advance(pipeline: BuildPipeline): Promise<ReviewFanoutStep> {
    const state = pipeline.reviewFanout;
    if (!state) return { kind: "working" };
    if (state.report) return { kind: "consolidated" };
    const targetBranch = await this.deps.targetBranch(pipeline);

    if (!state.consolidation) {
      const runner = new ReviewFanoutRunner(this.reviewHost(pipeline, state, targetBranch));
      const outcome = await runner.advanceReviewers(state.reviewers);
      // Settled *after* the pass, not inside it: a reviewer's last transcript
      // mirror happens while its provider status is still being read, so the
      // status it ends on — completed, failed, stopped — is only known here.
      // Without this the build tab shows finished reviewers as still running.
      await this.settleReviewerSessions(pipeline, state);
      if (outcome.kind === "working") return { kind: "working" };
      if (outcome.kind === "no-reports") return { kind: "failed", error: outcome.error };
    }
    return this.advanceConsolidation(pipeline, state, targetBranch);
  }

  // -------------------------------------------------------------------------
  // Reviewers
  // -------------------------------------------------------------------------

  private reviewHost(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
    targetBranch: string,
  ): ReviewFanoutHost {
    return {
      workflowId: pipeline.id,
      targetBranch,
      label: FANOUT_LABEL,
      sessionKeyFor: (reviewer) => `${pipeline.id}:review:${pipeline.iteration}:${reviewer.id}`,
      sessionLabelFor: (_reviewer, index) => `Review ${index + 1}`,
      provider: (selection) => this.deps.provider(pipeline, selection.agent as BuildPipelineAgent),
      save: () => this.deps.save(pipeline),
      // The pipeline has no controller lease of its own: the supervisor holds
      // the pipeline lock for the whole pass, so there is no fence to lose
      // part-way through one.
      assertFence: async () => {},
      reviewSnapshot: async () => {
        const baseline = state.snapshot;
        if (!baseline) {
          const adopted = await captureReviewWorktreeSnapshot(
            this.deps.invoke,
            pipeline.environmentId,
            FANOUT_LABEL,
          );
          state.snapshot = adopted;
          await this.deps.save(pipeline);
          return promptWorktreeSnapshot(adopted);
        }
        await assertReviewSnapshotCurrent(
          this.deps.invoke,
          pipeline.environmentId,
          baseline,
          FANOUT_LABEL,
        );
        return promptWorktreeSnapshot(baseline);
      },
      resolveUnattendedInteractions: (provider, providerSessionId) =>
        resolveUnattendedReviewerInteractions(provider, providerSessionId, async () => {}),
      abandonSession: (selection, providerSessionId) =>
        this.abandonSession(pipeline, selection.agent as BuildPipelineAgent, providerSessionId),
      onReviewerObserved: (reviewer, index, provider) =>
        this.mirrorReviewerSession(pipeline, reviewer, index, provider),
      progress: this.deps.progress,
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
   */
  private async mirrorReviewerSession(
    pipeline: BuildPipeline,
    reviewer: ReviewerRecord,
    index: number,
    provider: BuildPipelineProvider,
  ): Promise<void> {
    if (!reviewer.providerSessionId || !reviewer.sessionKey) return;
    const session = this.ensureSession(pipeline, {
      sessionKey: reviewer.sessionKey,
      sdkSessionId: reviewer.providerSessionId,
      agent: reviewer.agent as BuildPipelineAgent,
      label: `Review ${index + 1}`,
      startedAt: reviewer.startedAt,
    });
    const changed = await this.deps.refreshTranscript(session, provider);
    const status = reviewer.status === "running" ? "running" : "idle";
    const statusChanged = session.status !== status;
    if (statusChanged || (changed && this.deps.shouldPersistTranscript(session))) {
      session.status = status;
      session.messagesPersistedAt = reviewFanoutNowIso();
      await this.deps.save(pipeline);
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
      const status =
        reviewer.status === "pending" || reviewer.status === "running" ? "running" : "idle";
      if (session.status !== status) {
        session.status = status;
        changed = true;
      }
    }
    if (changed) await this.deps.save(pipeline);
  }

  private ensureSession(
    pipeline: BuildPipeline,
    fields: {
      sessionKey: string;
      sdkSessionId: string;
      agent: BuildPipelineAgent;
      label: string;
      startedAt?: string;
    },
  ): PipelineSession {
    const existing = pipeline.sessions.find(
      (candidate) => candidate.sessionKey === fields.sessionKey,
    );
    if (existing) return existing;
    const session: PipelineSession = {
      phase: "review",
      agent: fields.agent,
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      iteration: pipeline.iteration,
      sessionKey: fields.sessionKey,
      sdkSessionId: fields.sdkSessionId,
      status: "running",
      startedAt: fields.startedAt ?? reviewFanoutNowIso(),
      label: fields.label,
      messages: [],
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
   * Merges the reviewer reports into one, on the address step's model.
   *
   * The address step is the one that will act on the result, so consolidating
   * on a different model would hand the fixer a summary written in a voice it
   * never reads. It is also the same choice Multi Review makes, where the fix
   * model owns the consolidation turn.
   */
  private async advanceConsolidation(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
    targetBranch: string,
  ): Promise<ReviewFanoutStep> {
    if (!state.consolidation) {
      const step = await this.deps.stepSettings(pipeline, "address");
      const provider = await this.deps.provider(pipeline, step.agent);
      const sessionKey = `${pipeline.id}:review-consolidation:${pipeline.iteration}:${randomUUID()}`;
      const providerSessionId = await provider.createSession("review", "Review · Consolidation", {
        clientSessionKey: sessionKey,
        mode: "plan",
        model: step.model,
        effort: step.effort,
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
        ...(step.model ? { model: step.model } : {}),
        ...(step.effort ? { reasoningEffort: step.effort } : {}),
      };
      await this.deps.save(pipeline);
    }

    const consolidation = state.consolidation;
    const provider = await this.deps.provider(pipeline, consolidation.agent as BuildPipelineAgent);
    const session = this.ensureSession(pipeline, {
      sessionKey: consolidation.sessionKey,
      sdkSessionId: consolidation.providerSessionId,
      agent: consolidation.agent as BuildPipelineAgent,
      label: "Consolidation",
    });
    provider.registerSession?.(consolidation.providerSessionId, {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "review",
      workflowId: pipeline.id,
      provider: consolidation.agent,
      fence: consolidation.sessionKey,
    });

    if (consolidation.state === "prepared") {
      // Built while the dispatch is still unjournaled, for the same reason a
      // reviewer prompt is: the worktree probe must not widen the window in
      // which a crash leaves the turn ambiguous. A schema repair re-sends an
      // already-answered prompt and is not re-gated.
      let prompt = consolidation.schemaRepairPrompt;
      if (!prompt) {
        if (state.snapshot) {
          await assertReviewSnapshotCurrent(
            this.deps.invoke,
            pipeline.environmentId,
            state.snapshot,
            FANOUT_LABEL,
          );
        }
        prompt = createReviewConsolidationPrompt({
          targetBranch,
          worktree: state.snapshot ? promptWorktreeSnapshot(state.snapshot) : undefined,
          reports: consolidationReports(state.reviewers),
        });
      }
      await attachAgentBeforeDispatch(provider, consolidation.providerSessionId);
      consolidation.state = "dispatching";
      await this.deps.save(pipeline);
      try {
        await provider.send(consolidation.providerSessionId, prompt, {
          requestId: consolidation.requestId,
          schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema,
          mode: "plan",
          model: consolidation.model,
          effort: consolidation.reasoningEffort,
        });
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) return { kind: "working" };
        throw error;
      }
      consolidation.state = "sent";
      session.status = "running";
      await this.deps.save(pipeline);
    }
    if (consolidation.state === "dispatching") {
      // Dispatch acceptance is ambiguous after a crash. The stable request id
      // makes provider reconciliation authoritative; never send it twice.
      consolidation.state = "sent";
      await this.deps.save(pipeline);
    }

    await resolveUnattendedReviewerInteractions(
      provider,
      consolidation.providerSessionId,
      async () => {},
    );
    const { status, error: statusDetail } = await readProviderStatus(
      provider,
      consolidation.providerSessionId,
    );
    const transcriptChanged = await this.deps.refreshTranscript(session, provider);
    if (transcriptChanged && this.deps.shouldPersistTranscript(session)) {
      session.messagesPersistedAt = reviewFanoutNowIso();
      await this.deps.save(pipeline);
    }
    if (status === "running") {
      if (consolidation.idleResultPolls !== undefined) {
        delete consolidation.idleResultPolls;
        await this.deps.save(pipeline);
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
    if (status === "error" || status === "missing") {
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

    const result = await provider.structured<unknown>(
      consolidation.providerSessionId,
      consolidation.requestId,
    );
    if (!result) {
      return this.countIdlePoll(
        pipeline,
        state,
        "The consolidation session became idle without returning its consolidated report",
      );
    }
    let parsed: ReturnType<typeof parseStructuredReportResult>;
    try {
      parsed = parseStructuredReportResult(result);
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
    state.report = provenance.report;
    session.status = "idle";
    pipeline.structuredReview = provenance.report;
    await this.deps.save(pipeline);
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
      () =>
        provider.messages(consolidation.providerSessionId, {
          limit: PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
        }),
      consolidation.progressDigest,
    );
    const decision = commitProgressObservation(consolidation, observation);
    if (decision === "reset" || decision === "hold") {
      await this.deps.save(pipeline);
      return { kind: "working" };
    }
    const elapsedMs = noProgressElapsedMs(consolidation.progressAt, consolidation.createdAt);
    if (elapsedMs === null) {
      if (consolidation.progressDigest !== previousDigest) await this.deps.save(pipeline);
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
      await this.deps.save(pipeline);
      return { kind: "working" };
    }
    if (consolidation.progressDigest !== previousDigest) await this.deps.save(pipeline);
    return { kind: "working" };
  }

  private async countIdlePoll(
    pipeline: BuildPipeline,
    state: ReviewFanoutState,
    error: string,
  ): Promise<ReviewFanoutStep> {
    const consolidation = state.consolidation;
    if (!consolidation) return { kind: "working" };
    consolidation.idleResultPolls = (consolidation.idleResultPolls ?? 0) + 1;
    await this.deps.save(pipeline);
    if (consolidation.idleResultPolls >= MAX_REVIEW_IDLE_RESULT_POLLS) {
      return { kind: "failed", error };
    }
    return { kind: "working" };
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
    consolidation.schemaRepairAttempts = attempt;
    consolidation.schemaRepairPrompt = structuredReportRepairPrompt(
      error.issues,
      attempt,
      MAX_REVIEW_SCHEMA_REPAIR_ATTEMPTS,
    );
    consolidation.requestId = randomUUID();
    consolidation.state = "prepared";
    delete consolidation.idleResultPolls;
    await this.deps.save(pipeline);
    return { kind: "working" };
  }
}

function reviewerFromConfig(config: BuildStepConfig): ReviewerRecord {
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
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    status: "pending",
  };
}
