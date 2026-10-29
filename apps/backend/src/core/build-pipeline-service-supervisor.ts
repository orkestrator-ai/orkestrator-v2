/**
 * The build pipeline stage supervisor: the whole-store tick, the per-pipeline
 * lock, and the state machine each pass advances (provisioning, stage start and
 * dispatch, review packages, validation and the multi-model review).
 */
import { randomUUID } from "node:crypto";
import {
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSession,
  type PipelineSessionPhase,
  type ResumableBuildPhase,
  isBuildPipeline,
  isActiveBuildPhase,
  reviewValidationStage,
  REVIEW_PACKAGE_SESSION_LABEL,
  usesReviewFanout,
  executionModeForSessionPhase,
  pipelineReviewIssueCounts,
} from "@orkestrator/protocol/build-pipeline";
import {
  newReviewValidationRun,
  parseReviewValidationPlan,
  type ReviewValidationRun,
  type ReviewPackageReference,
} from "@orkestrator/protocol/review-workflow";
import type { Environment } from "./models.js";
import {
  type BuildPipelineProvider,
  ProviderUnavailableError,
  AmbiguousPromptDispatchError,
  readProviderStatus,
  type ProviderExecutionMode,
} from "./build-pipeline-provider.js";
import {
  errorMessage,
  sessionForCurrentPhase,
  resumablePhase,
  discardPreparationResult,
  sessionAgent,
  sessionPhaseFor,
  discardSessionReviewReports,
  withUnattendedPolicy,
  type BuildStepSelection,
  WORKTREE_PROBE_ATTEMPTS,
  SESSION_LABELS,
  PreSessionStageStartError,
  executionModeOverrideForPhase,
  DEFAULT_STALL_WARNING_MS,
  attachBeforeDispatch,
  elapsedSince,
  elapsedSinceLatest,
  stageAfterReview,
} from "./build-pipeline-service-helpers.js";
import {
  reviewValidationDiscoveryPrompt,
  REVIEW_VALIDATION_PLAN_SCHEMA,
} from "./review-validation-prompts.js";
import { validationPreparation } from "./review-validation-service.js";
import {
  LAST_ASSISTANT_TEXT_READ_LIMIT,
  lastAssistantText,
  workflowRestartContinuationPrompt,
  workflowResultReminderPrompt,
} from "./workflow-result-missing.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { carriesFixBaseline, retainRoundReviewReport } from "./build-pipeline-rewind.js";
import {
  safeParseStructuredReviewReport,
  stripStructuredReviewProvenance,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import {
  type WorkflowResultKind,
  workflowResultInstruction,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  buildPipelineReviewPackageContext,
  buildPipelineReviewPackageId,
  reviewPackagePreparationPrompt,
  type ObservedWorktreeSnapshot,
  type ReviewWorktreeSnapshot,
} from "./build-pipeline-prompts.js";
import {
  BuildPipelineReviewFanout,
  type ReviewFanoutStep,
} from "./build-pipeline-review-fanout.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import {
  recordPipelineSessionUsage,
  deferPipelineSessionUsage,
  sharedTranscriptRead,
} from "./build-pipeline-session-usage.js";
import {
  hasProgressSnapshot,
  readTranscriptProgressSample,
  type ProgressSample,
} from "./transcript-progress.js";
import {
  probeReviewWorktree,
  probeReviewWorktreeOnce,
  type ReviewWorktreeProbeOptions,
} from "./review-worktree-probe.js";
import {
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  parseReviewPreparationResult,
} from "./review-prompts.js";
import { parseReviewPackageReference } from "./review-package.js";
import type { BuildPipelineContext } from "./build-pipeline-context.js";
import type { BuildPipelineAgents } from "./build-pipeline-service-agents.js";
import type { BuildPipelineRecovery } from "./build-pipeline-service-recovery.js";
import type { BuildPipelineInteractions } from "./build-pipeline-service-interactions.js";
import type { ReviewPackageVerification } from "./commands-review.js";
import { sessionWorkspaceBaselineFields } from "./build-pipeline-validation-worktree.js";
import { BuildPipelineReadOnlyGuard } from "./build-pipeline-read-only-guard.js";
import { PIPELINE_ADDRESS_REPORT_KIND } from "@orkestrator/protocol/build-pipeline-address-report";
import { commandWorkspaceProbe } from "./workspace-read-only-guard.js";
import { BuildPipelineStagePrompts, type StagePrompt } from "./build-pipeline-stage-prompts.js";
import {
  buildPhaseForSessionPhase,
  buildPipelineSessionStage,
  buildPipelineStage,
  usesPackagePreparationSession,
} from "./build-pipeline-stages.js";
import {
  pipelineReviewPreparationInstructions,
  withBuildStepInstructions,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import {
  BuildPipelinePromptDispatch,
  readOnlyReviewSendOptions,
  readsReviewPackage,
} from "./build-pipeline-prompt-dispatch.js";

/**
 * Shown in the build header while the pipeline waits for a person. Says what
 * happened, the likely reason, and what each available control will do.
 */
export const UNCHANGED_FIX_PAUSE_MESSAGE =
  "Paused: the fix stage finished without changing the branch, so another review and verification round would check identical code. The verification failure may not be caused by this branch (for example a test that also fails on the target branch, or one this host cannot run). Read the Fix transcript, then Resume to run another round anyway, send a message first to steer the fix, or Cancel and open the pull request yourself.";

export class BuildPipelineSupervisor {
  /**
   * Progress clocks for the reviewer fan-out.
   *
   * Held on the supervisor rather than per pass so a reviewer's stall baseline
   * survives between ticks; entries are dropped when a session settles, so it
   * cannot grow with pipeline history.
   */
  private readonly reviewProgress = new MultiReviewProgressTracker();

  private reviewFanoutRunner: BuildPipelineReviewFanout | null = null;

  /**
   * The read-only guard on Review, consolidation and Verify. The facade
   * registers its submit-time checks; this supervisor captures baselines
   * before dispatch and certifies results when it consumes them.
   */
  readonly readOnly: BuildPipelineReadOnlyGuard;

  /** What each stage's session is told when it opens. */
  private readonly stagePrompts: BuildPipelineStagePrompts;

  /** Sends the journaled `pendingPromptAttempt`, at most once. */
  private readonly promptDispatch: BuildPipelinePromptDispatch;

  constructor(
    private readonly ctx: BuildPipelineContext,
    private readonly agents: BuildPipelineAgents,
    private readonly recovery: BuildPipelineRecovery,
    private readonly interactions: BuildPipelineInteractions,
  ) {
    this.readOnly = new BuildPipelineReadOnlyGuard(
      ctx.storage,
      commandWorkspaceProbe((command, args) => ctx.invoke(command, args), WORKTREE_PROBE_ATTEMPTS),
    );
    this.stagePrompts = new BuildPipelineStagePrompts(ctx, (environmentId, reviewPackage) =>
      this.assertReviewPackageIntegrity(environmentId, reviewPackage),
    );
    this.promptDispatch = new BuildPipelinePromptDispatch(ctx, agents);
  }

  reviewFanout(): BuildPipelineReviewFanout {
    if (!this.reviewFanoutRunner) {
      this.reviewFanoutRunner = new BuildPipelineReviewFanout({
        provider: (pipeline, agent) => this.agents.provider(pipeline, agent),
        providerUnavailable: (pipeline, agent, provider) =>
          this.agents.evictUnreachableProvider(pipeline, agent, provider),
        executionPolicy: (pipeline) => this.ctx.executionPolicy(pipeline),
        save: async (pipeline) => {
          await this.ctx.save(pipeline, pipeline.backendRevision);
        },
        stepSettings: (pipeline, sessionPhase) => this.agents.stepSettings(pipeline, sessionPhase),
        settingsForSelection: (pipeline, selection) =>
          this.agents.settingsForSelection(pipeline, selection),
        settingsForSelections: (pipeline, selections) =>
          this.agents.settingsForSelections(pipeline, selections),
        refreshMovedTranscript: (session, provider, options) =>
          this.refreshMovedTranscript(session, provider, options),
        shouldPersistTranscript: (session) => this.shouldPersistTranscript(session),
        targetBranch: async (pipeline) => {
          const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
          return repository.prBaseBranch || "main";
        },
        reviewInstruction: async () =>
          (await this.ctx.storage.loadConfig()).global.reviewInstruction,
        reviewContext: async (pipeline) => {
          const notes = (await this.ctx.storage.kanban.getProjectNotes(pipeline.projectId)).content;
          return buildPipelineReviewPackageContext(pipeline, notes).context;
        },
        verifyReviewPackage: (pipeline, reviewPackage) =>
          this.assertReviewPackageIntegrity(pipeline.environmentId, reviewPackage),
        progress: this.reviewProgress,
        workflowResults: this.ctx.options.workflowResults,
        workflowToolEnabled: (agent, kind) =>
          this.ctx.workflowToolEnabled(agent as BuildPipelineAgent, kind),
        agentMcp: (pipeline, resultKey, provider, stage) =>
          this.ctx.workflowAgentMcp(pipeline, resultKey, provider, stage),
        artifactDispatch: this.ctx.options.artifactDispatch,
        captureWorkspaceBaseline: (pipeline) => this.readOnly.capturePanel(pipeline),
        workspaceViolation: (pipeline, subject) => this.readOnly.panelViolation(pipeline, subject),
        concurrency: this.ctx.options.reviewFanoutConcurrency,
        efficiency: this.ctx.options.efficiency,
        pollGate: (pipeline) => ({
          count: (scope) =>
            this.ctx.reviewerPollGate.count(scope, this.ctx.passTrigger(pipeline.id)),
          exhausted: (scope, count, limit) =>
            this.ctx.reviewerPollGate.exhausted(scope, count, limit),
          clear: (scope) => this.ctx.reviewerPollGate.clear(scope),
        }),
      });
    }
    return this.reviewFanoutRunner;
  }

  requestTick(): Promise<void> {
    recurringWorkMetrics.requested("build-supervisor-tick");
    if (this.ctx.tickPromise) {
      recurringWorkMetrics.coalesced("build-supervisor-tick");
      this.ctx.tickRequested = true;
      return this.ctx.tickPromise;
    }
    const operation = (async () => {
      do {
        this.ctx.tickRequested = false;
        await recurringWorkMetrics.observe("build-supervisor-tick", () => this.tickPass());
      } while (!this.ctx.stopped && this.ctx.tickRequested);
    })().finally(() => {
      if (this.ctx.tickPromise === operation) this.ctx.tickPromise = null;
    });
    this.ctx.tickPromise = operation;
    return operation;
  }

  async tickPass(): Promise<void> {
    if (this.ctx.stopped) return;
    const records = await this.ctx.storage.listAllBuildPipelines();
    recurringWorkMetrics.work("record-scanned", records.length);
    await Promise.all(
      records.flatMap((record) => {
        if (
          !isBuildPipeline(record.snapshot) ||
          (!isActiveBuildPhase(record.snapshot.phase) &&
            !this.recovery.needsTerminalReconciliation(record.snapshot))
        ) {
          return [];
        }
        recurringWorkMetrics.work("record-selected");
        return [this.runLocked(record.id)];
      }),
    );
  }

  runLocked(pipelineId: string, namingPrompt?: string): Promise<void> {
    // Timer ticks are level-triggered. If a pass is already running, joining
    // it is sufficient; appending another promise every 1.5 seconds lets a
    // stalled provider call grow an unbounded queue.
    const existing = this.ctx.locks.get(pipelineId);
    if (existing) return existing;
    const next = this.advance(pipelineId, namingPrompt)
      .catch(async (error) => {
        if (error instanceof ProviderUnavailableError) {
          await this.interactions.recordReconnect(pipelineId, error).catch(() => undefined);
        } else {
          await this.interactions.fail(pipelineId, error).catch(() => undefined);
        }
      })
      .finally(() => {
        if (this.ctx.locks.get(pipelineId) === next) this.ctx.locks.delete(pipelineId);
      });
    this.ctx.locks.set(pipelineId, next);
    return next;
  }

  async advance(pipelineId: string, namingPrompt?: string): Promise<void> {
    const record = await this.ctx.requireRecord(pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    pipeline.backendRevision = record.revision;
    if (pipeline.rewinds?.at(-1)?.code?.pending) {
      try {
        await this.ctx.finishPendingCodeRewind(pipeline);
      } catch (error) {
        // Keep the durable intent and restart target intact for retry/startup.
        console.warn(
          `[build-pipeline] Pending code rewind for ${pipeline.id}:`,
          errorMessage(error),
        );
      }
      return;
    }
    if (pipeline.pendingResultConsumptions?.length && this.ctx.options.workflowResults) {
      try {
        for (const resultKey of pipeline.pendingResultConsumptions) {
          await this.ctx.options.workflowResults.consume(resultKey);
        }
        delete pipeline.pendingResultConsumptions;
        await this.ctx.save(pipeline, record.revision);
      } catch (error) {
        console.warn(
          `[build-pipeline] Deferred result consumption for ${pipeline.id}:`,
          errorMessage(error),
        );
      }
      return;
    }
    if (!isActiveBuildPhase(pipeline.phase)) {
      await this.recovery.reconcileTerminalState(pipeline);
      return;
    }

    if (pipeline.environmentId && !pipeline.sourceLinkedAt) {
      await this.ensureSourceLink(pipeline);
      return;
    }

    if (pipeline.phase === "creating-environment") {
      const environment =
        (await this.findLinkedEnvironment(pipeline)) ??
        (await this.ctx.invoke<Environment>("create_environment", {
          projectId: pipeline.projectId,
          // A launcher that collected a network mode wins; otherwise a
          // container is restricted, which is the app's own default, and a
          // local worktree has no firewall to apply one to.
          networkAccessMode:
            pipeline.environmentOptions?.networkAccessMode ??
            (pipeline.environmentType === "containerized" ? "restricted" : "full"),
          environmentType: pipeline.environmentType,
          buildPipelineId: pipeline.id,
          ...(pipeline.delegationBaseBranch
            ? { delegationBaseBranch: pipeline.delegationBaseBranch }
            : {}),
          ...(pipeline.delegationBaseCommit
            ? { delegationBaseCommit: pipeline.delegationBaseCommit }
            : {}),
          // An explicit name suppresses the rename-from-prompt path in
          // `create_environment`, so it is only sent when the user chose one.
          ...(pipeline.environmentOptions?.name?.trim()
            ? { name: pipeline.environmentOptions.name.trim() }
            : {}),
          ...(pipeline.environmentOptions?.portMappings?.length
            ? { portMappings: pipeline.environmentOptions.portMappings }
            : {}),
          namingPrompt:
            namingPrompt ?? this.ctx.provisioningPrompts.get(pipeline.id) ?? pipeline.taskTitle,
        }));
      pipeline.environmentId = environment.id;
      pipeline.environmentType = environment.environmentType;
      pipeline.phase = "starting-environment";
      await this.ctx.save(pipeline, record.revision);
      this.ctx.provisioningPrompts.delete(pipeline.id);
      return;
    }

    if (!pipeline.environmentId) {
      throw new Error("Build pipeline has no environment");
    }

    if (pipeline.phase === "starting-environment") {
      await this.recovery.configureEnvironment(pipeline);
      const environment = await this.ctx.storage.getEnvironment(pipeline.environmentId);
      if (!environment) throw new Error("Build environment no longer exists");
      if (environment.status !== "running") {
        await this.ctx.invoke("start_environment", {
          environmentId: pipeline.environmentId,
        });
      }
      pipeline.phase = "waiting-for-setup";
      await this.ctx.save(pipeline, record.revision);
      return;
    }

    if (pipeline.phase === "waiting-for-setup") {
      await this.ctx.invoke("run_environment_setup", {
        environmentId: pipeline.environmentId,
      });
      // Setup temporarily owns the active terminal tab while it installs the
      // environment. Once that work is finished, move the authoritative pane
      // selection back to the build surface before starting the first agent
      // turn. Keeping this in the backend means a renderer that was unmounted
      // during setup catches up from the persisted layout when it returns.
      await this.ctx.storage.ensureBuildPipelineTab({
        pipelineId: pipeline.id,
        taskId: pipeline.taskId,
        environmentId: pipeline.environmentId,
        isLocal: pipeline.environmentType === "local",
      });
      await this.startStage(pipeline, "build", "building");
      return;
    }

    if (
      (pipeline.pendingKanbanReactivation || pipeline.restartRequest) &&
      (!pipeline.kanbanReactivationRetryAt ||
        Date.now() >= Date.parse(pipeline.kanbanReactivationRetryAt))
    ) {
      // Keep reconciliation durable independently of dispatch. A transient
      // Kanban failure must neither strand nor dispatch the replacement twice.
      pipeline.pendingKanbanReactivation = true;
      try {
        await this.recovery.updateKanbanLifecycle(pipeline, { status: "in-progress" });
        delete pipeline.pendingKanbanReactivation;
        delete pipeline.kanbanReactivationRetryAt;
      } catch (error) {
        pipeline.kanbanReactivationRetryAt = new Date(Date.now() + 30_000).toISOString();
        console.warn(
          `[build-pipeline] Kanban status for restarted ${pipeline.id}:`,
          errorMessage(error),
        );
      }
      await this.ctx.save(pipeline, pipeline.backendRevision);
      record.revision = pipeline.backendRevision;
    }

    if (pipeline.restartRequest) {
      const request = pipeline.restartRequest;
      delete pipeline.restartRequest;
      if (request.kind === "review-package") {
        pipeline.phase = request.implementationPhase === "fix" ? "fixing" : "building";
        await this.startReviewPackagePreparation(pipeline);
        return;
      }
      if (request.kind === "validation") {
        pipeline.phase = request.implementationPhase === "fix" ? "fixing" : "building";
        if (!pipeline.validationRun) throw new Error("Validation restart plan is missing");
        await this.advanceValidation(pipeline);
        return;
      }
      await this.startStage(pipeline, request.phase, buildPhaseForSessionPhase(request.phase));
      return;
    }

    if (pipeline.skipRequest) {
      const { phase } = pipeline.skipRequest;
      delete pipeline.skipRequest;
      if (phase === "build" || phase === "fix") {
        await this.startReviewPackagePreparation(pipeline);
        return;
      }
      if (phase === "review") {
        // The review produced nothing to address; verification judges the
        // work on its own.
        delete pipeline.reviewFanout;
        delete pipeline.structuredReview;
        delete pipeline.structuredReviewRequestId;
        delete pipeline.verificationResult;
        delete pipeline.verificationFeedback;
      }
      if (phase === "verify") {
        delete pipeline.verificationResult;
        delete pipeline.verificationFeedback;
        await this.startStage(pipeline, "pr", "creating-pr");
        return;
      }
      await this.startStage(pipeline, "verify", "verifying");
      return;
    }

    if (
      pipeline.stageRetryRequested &&
      pipeline.phase === "reviewing" &&
      usesReviewFanout(pipeline) &&
      pipeline.reviewFanout
    ) {
      delete pipeline.stageRetryRequested;
      if (await this.reviewFanout().restartConsolidation(pipeline)) {
        await this.advanceReviewFanout(pipeline);
        return;
      }
      // A reviewer-stage failure has no usable settled panel to preserve. Keep
      // the existing full-stage retry semantics in that case.
      await this.startStage(pipeline, "review", "reviewing");
      return;
    }

    if (pipeline.stageRetryRequested) {
      const phase = pipeline.phase as ResumableBuildPhase;
      const sessionPhase = sessionPhaseFor(phase);
      if (!sessionPhase) throw new Error(`Cannot retry pipeline phase ${phase}`);
      delete pipeline.stageRetryRequested;
      await this.startStage(pipeline, sessionPhase, phase);
      return;
    }

    if (pipeline.interactionRetryRequested) {
      const phase = pipeline.phase as ResumableBuildPhase;
      const sessionPhase = sessionPhaseFor(phase);
      if (!sessionPhase) throw new Error(`Cannot retry pipeline phase ${phase}`);
      delete pipeline.interactionRetryRequested;
      if (phase === "addressing") {
        if (!pipeline.structuredReview) {
          throw new Error("Cannot retry addressing without the structured review");
        }
        await this.startStage(pipeline, sessionPhase, phase);
      } else {
        await this.startStage(pipeline, sessionPhase, phase);
      }
      return;
    }

    // The fan-out drives several reviewer sessions at once, so it cannot go
    // through the single-session path below. It owns the whole `reviewing`
    // phase and hands back one consolidated report.
    // Gated on the configuration rather than on the live record: a pipeline
    // that crashed between opening this stage and persisting its state has the
    // phase and no fan-out, and falling through to the single-session path
    // below would read whichever session happens to be current as the review.
    if (pipeline.phase === "reviewing" && usesReviewFanout(pipeline)) {
      // Handled here rather than on the idle path below: that path is reached
      // through the current session, and the fan-out has several.
      if (pipeline.reviewRetryRequested) {
        await this.agents.abandonReviewFanout(pipeline, "idle");
        delete pipeline.reviewRetryRequested;
        discardSessionReviewReports(pipeline);
        delete pipeline.reviewFanout;
        delete pipeline.structuredReview;
        delete pipeline.structuredReviewRequestId;
        delete pipeline.verificationResult;
        delete pipeline.verificationFeedback;
        await this.startVerifiedReviewOrPrepare(pipeline);
        return;
      }
      if (!pipeline.reviewFanout) {
        await this.startVerifiedReviewOrPrepare(pipeline);
        return;
      }
      await this.advanceReviewFanout(pipeline);
      return;
    }

    const validationTarget = reviewValidationStage(
      pipeline,
      resumablePhase(pipeline.phase) ?? undefined,
    );
    if (validationTarget) {
      if (validationTarget === "review-package") {
        delete pipeline.reviewRetryRequested;
        await this.startReviewPackagePreparation(pipeline);
        return;
      }
      await this.advanceValidation(pipeline);
      return;
    }

    const session = sessionForCurrentPhase(pipeline);
    if (!session) {
      await this.restartMissingStage(pipeline);
      return;
    }
    const currentAgent = sessionAgent(pipeline, session);
    const provider = await this.agents.provider(pipeline, currentAgent);
    if (await this.interactions.enforcePendingInteraction(pipeline, provider, session)) {
      return;
    }
    // Read as data. A bridge that answers with a terminal turn error is
    // reachable, so this must reach both the reconnect-clearing block below —
    // otherwise a stale `reconnectAttempt` outlives the harness it accused —
    // and the `error` branch, which is the only one that fails the stage with
    // the provider's own explanation rather than an anonymous read fault.
    const {
      status,
      error: statusDetail,
      turnSettled,
      backgroundWorkLive,
      retainedContinuationRequestIds,
      interruption,
      contextUsage,
      usagePending,
    } = await readProviderStatus(provider, session.sdkSessionId, session.structuredRequestId);
    // Only the harness that was recorded as unreachable can clear its own
    // reconnect attempt. A stage transition resolves the *next* step's provider
    // before it records that step's session, so a failure there belongs to a
    // harness this session does not name — and clearing it on this session's
    // evidence would reset `startedAt` on every retry, so the reconnect deadline
    // would never elapse and the pipeline would retry a dead bridge forever.
    // An attempt written before the agent was recorded has no harness to
    // disagree with, so it keeps the original behaviour.
    if (
      pipeline.reconnectAttempt &&
      !pipeline.pendingPromptAttempt &&
      (pipeline.reconnectAttempt.agent === undefined ||
        pipeline.reconnectAttempt.agent === currentAgent)
    ) {
      delete pipeline.reconnectAttempt;
      delete pipeline.error;
      await this.ctx.save(pipeline, record.revision);
      return;
    }
    if (status === "missing") {
      throw new Error(`The ${session.label.toLowerCase()} is no longer available`);
    }
    if (status === "error") {
      // Usage must survive failure handling, including when the transcript is
      // unreadable. Meter the observation independently of that best-effort read.
      await recordPipelineSessionUsage(session, provider, contextUsage, undefined);
      try {
        const transcript = sharedTranscriptRead(provider, session.sdkSessionId);
        await this.refreshMovedTranscript(session, provider, {
          force: true,
          read: transcript.read,
        }).catch(() => false);
        await recordPipelineSessionUsage(session, provider, contextUsage, transcript.taken());
        session.completedAt ??= new Date().toISOString();
        await this.ctx.save(pipeline, pipeline.backendRevision);
      } catch {
        // Metering/checkpoint failures must not replace the provider's failure.
      }
    }
    if (status === "error" && interruption === "restart") {
      // A submitted result survives the process that produced it. Otherwise
      // continue this stage once, under a new durable dispatch/result key.
      const result = session.structuredRequestId
        ? await this.ctx.readWorkflowResult<unknown>(provider, session, session.structuredRequestId)
        : null;
      if (result?.ok !== true) {
        if (
          pipeline.pendingPromptAttempt?.sessionId === session.sdkSessionId &&
          session.restartContinuationSent
        ) {
          await this.dispatchPending(pipeline, provider);
          return;
        }
        if (!session.restartContinuationSent) {
          await this.continueInterruptedStage(pipeline, provider, session);
          return;
        }
        throw new Error(
          `The ${session.label.toLowerCase()} failed: ${statusDetail ?? "interrupted again"}`,
        );
      }
      // The result proves this dispatch ran, including an attempt whose HTTP
      // acceptance was lost before the restart.
      if (pipeline.pendingPromptAttempt?.sessionId === session.sdkSessionId) {
        delete pipeline.pendingPromptAttempt;
      }
    } else if (status === "error") {
      throw new Error(
        statusDetail
          ? `The ${session.label.toLowerCase()} failed: ${statusDetail}`
          : `The ${session.label.toLowerCase()} failed`,
      );
    }
    if (status === "blocked") {
      // Observe-only Milestone 3 must not advance or fail a phase. The parked
      // request remains provider-owned until Milestone 4 applies its policy.
      session.status = "running";
      return;
    }
    if (
      pipeline.pendingPromptAttempt &&
      pipeline.pendingPromptAttempt.sessionId === session.sdkSessionId
    ) {
      if (status === "running") {
        delete pipeline.pendingPromptAttempt;
        delete pipeline.reconnectAttempt;
        delete pipeline.error;
        await this.ctx.save(pipeline, record.revision);
        return;
      }
      await this.dispatchPending(pipeline, provider);
      return;
    }
    if (status === "idle" && turnSettled === false) return;
    // Claude releases a turn to idle while background agents it launched are
    // still running, then re-enters the same session once they settle — and a
    // retained continuation covers the gap between the two. Either way the
    // stage's work is not done: advancing here would start the next stage
    // against a worktree this session is still about to change. Only this
    // pipeline drives the session, so any retained continuation is its own.
    const backgroundWorkPending =
      status === "idle" &&
      (backgroundWorkLive === true || (retainedContinuationRequestIds?.length ?? 0) > 0);
    if (status === "running" || backgroundWorkPending) {
      const statusChanged = session.status !== "running";
      session.status = "running";
      // Viewers read the committed copy, which only a save changes, so the
      // transcript is looked at only when this pass may save it: a status
      // change, the persist boundary, or a shown stall warning that movement
      // must clear at once. Even then the whole body is read only when a
      // bounded probe shows it moved since that committed copy.
      const persistDue = this.shouldPersistTranscript(session);
      const transcript = sharedTranscriptRead(provider, session.sdkSessionId);
      const transcriptChanged =
        statusChanged || persistDue || pipeline.stallWarning !== undefined
          ? await this.refreshMovedTranscript(session, provider, { read: transcript.read })
          : false;
      // Live usage, so a running node shows what the turn has cost so far.
      // Like a transcript delta it waits for the persist boundary below.
      const usageChanged = await recordPipelineSessionUsage(
        session,
        provider,
        contextUsage,
        transcript.taken(),
      );
      const previousWarning = pipeline.stallWarning;
      if (transcriptChanged) {
        delete pipeline.stallWarning;
      } else if (
        elapsedSinceLatest(
          session.turnStartedAt,
          session.messagesPersistedAt,
          session.startedAt,
        )! >= DEFAULT_STALL_WARNING_MS &&
        pipeline.stallWarning?.sessionId !== session.sdkSessionId
      ) {
        pipeline.stallWarning = {
          sessionId: session.sdkSessionId,
          detectedAt: new Date().toISOString(),
        };
      }
      const warningChanged = previousWarning !== pipeline.stallWarning;
      // A status change is a state transition and always persists. A pure
      // transcript delta waits for the persist boundary: a streaming turn moves
      // on every tick, and each checkpoint writes the transcript's new chunks
      // and this pipeline's control row. A pass that read nothing had no
      // warning to clear, and its stall clock is younger than the persist
      // interval, so no warning can appear on it either.
      if (statusChanged || warningChanged || ((transcriptChanged || usageChanged) && persistDue)) {
        session.messagesPersistedAt = new Date().toISOString();
        await this.ctx.save(pipeline, record.revision);
      }
      return;
    }

    const wasRunning = session.status === "running";
    session.status = "idle";
    const completionChanged = session.completedAt === undefined;
    session.completedAt ??= new Date().toISOString();
    delete pipeline.stallWarning;
    // The turn ended, and its artifact grant with it.
    this.ctx.settleArtifactTurn(
      pipeline,
      session,
      pipeline.activePromptContext?.requestId ?? pipeline.pendingPromptAttempt?.requestId,
    );
    // The pass that sees the turn end reads the whole transcript whatever the
    // probe says, so the handoff window and request-id recovery below see the
    // final copy. Later idle passes (a structured-result wait, PR detection)
    // read it again only when the provider shows it moved.
    const transcript = sharedTranscriptRead(provider, session.sdkSessionId);
    const transcriptChanged = await this.refreshMovedTranscript(session, provider, {
      force: wasRunning,
      read: transcript.read,
    });
    const usageChanged = await recordPipelineSessionUsage(
      session,
      provider,
      contextUsage,
      transcript.taken(),
    );
    delete pipeline.pendingPromptAttempt;
    delete pipeline.activePromptContext;
    const previousUsagePolls = session.usageFinalizationPolls;
    const waitForUsage = deferPipelineSessionUsage(session, usagePending, {
      count: (scope) => this.ctx.reviewerPollGate.count(scope, this.ctx.passTrigger(pipeline.id)),
      exhausted: (scope, count, limit) => this.ctx.reviewerPollGate.exhausted(scope, count, limit),
      clear: (scope) => this.ctx.reviewerPollGate.clear(scope),
    });
    if (
      wasRunning ||
      completionChanged ||
      transcriptChanged ||
      usageChanged ||
      previousUsagePolls !== session.usageFinalizationPolls
    ) {
      // The turn is over, so this is the final transcript. Persist it now
      // rather than leaving the throttled tail to whichever branch runs next —
      // several of them return without saving.
      session.messagesPersistedAt = new Date().toISOString();
      await this.ctx.save(pipeline, pipeline.backendRevision);
    }

    if (waitForUsage) return;

    if (pipeline.reviewRetryRequested) {
      delete pipeline.reviewRetryRequested;
      discardSessionReviewReports(pipeline);
      delete pipeline.structuredReview;
      delete pipeline.structuredReviewRequestId;
      delete pipeline.verificationResult;
      delete pipeline.verificationFeedback;
      await this.startVerifiedReviewOrPrepare(pipeline);
      return;
    }

    if (pipeline.pendingUserMessages?.length) {
      await this.dispatchUserMessage(pipeline, provider, session);
      return;
    }

    switch (pipeline.phase) {
      case "building":
      case "fixing":
        if (await this.pauseUnchangedFix(pipeline, session)) return;
        if (
          usesPackagePreparationSession(pipeline) &&
          session.label !== REVIEW_PACKAGE_SESSION_LABEL
        ) {
          await this.startReviewPackagePreparation(pipeline);
          return;
        }
        await this.finishReviewPackagePreparation(pipeline, provider, session);
        return;
      case "reviewing":
        await this.finishReview(pipeline, provider, session);
        return;
      case "addressing":
        await this.recovery.finishAddress(pipeline, provider, session);
        return;
      case "verifying":
        await this.recovery.finishVerification(pipeline, provider, session);
        return;
      case "creating-pr":
        await this.recovery.finishPullRequest(pipeline);
        return;
      case "resolving-conflicts":
        await this.recovery.finishConflictResolution(pipeline);
        return;
      default:
        return;
    }
  }

  async probeWorktreeOnce(
    pipeline: BuildPipeline,
    options: ReviewWorktreeProbeOptions = {},
  ): Promise<ReviewWorktreeSnapshot> {
    return probeReviewWorktreeOnce(
      (command, args) => this.ctx.invoke(command, args),
      pipeline.environmentId,
      options,
    );
  }

  /** The worktree HEAD before a stage starts, or undefined when it cannot be read. */
  private async headAtStageStart(pipeline: BuildPipeline): Promise<string | undefined> {
    const snapshot = await this.probeWorktreeOnce(pipeline);
    return snapshot.status === "unknown" ? undefined : snapshot.head;
  }

  /**
   * Content identity of the worktree, or undefined when it cannot be observed.
   *
   * Undefined is not an error: the only consumer is the unchanged-fix check,
   * which then lets the loop continue exactly as it did before the check
   * existed rather than failing a stage over an optional optimisation.
   */
  async worktreeFingerprint(pipeline: BuildPipeline): Promise<string | undefined> {
    const snapshot = await probeReviewWorktree(
      (command, args) => this.ctx.invoke(command, args),
      pipeline.environmentId,
      WORKTREE_PROBE_ATTEMPTS,
      { fingerprint: true },
    );
    return snapshot.status === "unknown" ? undefined : snapshot.fingerprint;
  }

  /**
   * Pauses the pipeline when a fix turn ended without changing the worktree.
   *
   * Review and verification of byte-identical code reach the same verdict, so
   * continuing would only spend full review rounds until the iteration cap and
   * then fail a branch whose work may be finished. The usual cause is a failure
   * the fix agent judged unrelated to this branch — a test that also fails on
   * the target branch, or one the host cannot run — and that is a call for a
   * person, not for another round.
   *
   * The baseline is consumed on the first comparison, so Resume runs the next
   * round as before instead of pausing again on the same turn.
   */
  async pauseUnchangedFix(pipeline: BuildPipeline, session: PipelineSession): Promise<boolean> {
    const baseline = session.fixWorktreeFingerprintAtStart;
    if (session.phase !== "fix" || !baseline) return false;
    // Every attempt in this fix stage shares the original baseline. Consume
    // all copies so a restart or Resume cannot compare this same stage again.
    for (const attempt of pipeline.sessions) {
      if (attempt.phase === "fix" && attempt.iteration === session.iteration) {
        delete attempt.fixWorktreeFingerprintAtStart;
      }
    }
    const current = await this.worktreeFingerprint(pipeline);
    if (current !== baseline) {
      await this.ctx.save(pipeline, pipeline.backendRevision);
      return false;
    }
    pipeline.pausedFromPhase = "fixing";
    pipeline.phase = "paused";
    pipeline.pauseCause = "supervisor";
    pipeline.error = UNCHANGED_FIX_PAUSE_MESSAGE;
    delete pipeline.stallWarning;
    await this.ctx.save(pipeline, pipeline.backendRevision);
    return true;
  }

  /**
   * Establishes the baseline a guarded stage (Verify, or Review over a package)
   * will later be certified against.
   *
   * A dirty start is not a failure. The build stage is only *asked* to commit,
   * the verifier is told which paths were left behind, and the guard cares
   * about what the stage itself changed rather than where it began. Only a
   * state the backend could not observe at all is fatal, and it is fatal *here*
   * — before the turn is dispatched — because a stage that can never be
   * certified is not worth an agent turn, and failing after the fact would
   * discard a completed turn and report it as a Git error.
   */
  async validationBaseline(
    pipeline: BuildPipeline,
    sessionPhase: "review" | "verify",
  ): Promise<ObservedWorktreeSnapshot> {
    return this.readOnly.captureSession(pipeline, sessionPhase);
  }

  /**
   * Rejects a guarded turn that changed the workspace rather than only reading
   * it and writing ignored output. See `compareWorkspace` in
   * `workspace-read-only-guard.ts` for exactly what counts as a change.
   */
  async assertValidationWorktreeUnchanged(
    pipeline: BuildPipeline,
    session: PipelineSession,
    options: { repairableOnly?: boolean } = {},
  ): Promise<void> {
    await this.readOnly.certifySession(pipeline, session, options);
  }

  /**
   * Accepts the build model's preparation metadata, then has the backend create
   * the single immutable package every reviewer will read.
   *
   * Legacy in-flight build sessions have no structured key. They receive one
   * preparation-only follow-up in the same session, preserving the model and
   * its implementation context across an upgrade.
   */
  async finishReviewPackagePreparation(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
    const targetBranch = repository.prBaseBranch || "main";
    await this.ctx.refreshWorkflowRollout();
    if (!session.structuredRequestId) {
      const requestId = randomUUID();
      const startedAt = new Date().toISOString();
      const prompt = withUnattendedPolicy(reviewPackagePreparationPrompt(pipeline, targetBranch));
      session.structuredRequestId = requestId;
      session.producedReviewPackagePlan = true;
      session.resultTransport = this.ctx.workflowToolEnabled(
        sessionAgent(pipeline, session),
        "review-preparation",
      )
        ? "tool-v1"
        : "structured-output-v1";
      session.resultSubmission = session.resultTransport === "tool-v1" ? "preparing" : undefined;
      session.structuredResultStatus = "pending";
      session.turnStartedAt = startedAt;
      delete session.completedAt;
      delete session.usageFinalizationPolls;
      pipeline.pendingPromptAttempt = {
        dispatchVersion: 1,
        id: randomUUID(),
        sessionId: session.sdkSessionId,
        requestId,
        phase: pipeline.phase as "building" | "fixing",
        prompt,
        useTaskImages: false,
        structuredReview: true,
        resultTransport: session.resultTransport,
        startedAt,
      };
      await this.ctx.save(pipeline, pipeline.backendRevision);
      await this.dispatchPending(pipeline, provider);
      return;
    }
    const result = await this.ctx.readWorkflowResult<unknown>(
      provider,
      session,
      session.structuredRequestId,
    );
    if (!result) {
      await this.recovery.awaitStructuredResult(
        pipeline,
        provider,
        session,
        "review package preparation",
      );
      return;
    }
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    if (result.value && typeof result.value === "object" && "commands" in result.value) {
      pipeline.validationRun = newReviewValidationRun(
        `review-validation-${randomUUID()}`,
        parseReviewValidationPlan(result.value),
      );
      pipeline.validationRun.discoveryDurationMs = Math.max(
        0,
        Date.now() - Date.parse(session.turnStartedAt ?? session.startedAt),
      );
      session.structuredResultStatus = "accepted";
      session.producedReviewPackagePlan = true;
      this.ctx.stageWorkflowResultConsumption(pipeline, session, session.structuredRequestId);
      await this.ctx.save(pipeline, pipeline.backendRevision);
      await this.ctx.consumeWorkflowResult(pipeline, session, session.structuredRequestId);
      return;
    }
    const preparation = parseReviewPreparationResult(result.value);
    const packageId = buildPipelineReviewPackageId(pipeline);
    const round = pipeline.iteration + 1;
    const notes = (await this.ctx.storage.kanban.getProjectNotes(pipeline.projectId)).content;
    const boundedContext = buildPipelineReviewPackageContext(pipeline, notes);
    const generated = await this.ctx.invoke<unknown>("generate_review_package", {
      environmentId: pipeline.environmentId,
      packageId,
      round,
      targetBranch,
      preparation,
      additionalLimitations: boundedContext.limitations,
    });
    pipeline.reviewPackage = parseReviewPackageReference(generated, {
      id: packageId,
      round,
      targetBranch,
    });
    session.structuredResultStatus = "accepted";
    session.producedReviewPackagePlan = true;
    this.ctx.stageWorkflowResultConsumption(pipeline, session, session.structuredRequestId);
    await this.startStage(pipeline, "review", "reviewing");
    await this.ctx.consumeWorkflowResult(pipeline, session, session.structuredRequestId);
  }

  private async advanceValidation(pipeline: BuildPipeline): Promise<void> {
    let run = pipeline.validationRun!;
    // A skipped run is stopped, and then sealed with the results it had.
    const skipped = pipeline.skippedValidationRunId === run.id;
    if (run.status === "planned" || run.status === "running") {
      run = await this.ctx.invoke<ReviewValidationRun>(
        skipped
          ? "cancel_review_validation"
          : run.status === "planned"
            ? "start_review_validation"
            : "status_review_validation",
        {
          environmentId: pipeline.environmentId,
          run,
        },
      );
      pipeline.validationRun = run;
      await this.ctx.save(pipeline, pipeline.backendRevision);
      if (run.status === "planned" || run.status === "running") return;
    }
    const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
    const targetBranch = repository.prBaseBranch || "main";
    const round = pipeline.iteration + 1;
    const notes = (await this.ctx.storage.kanban.getProjectNotes(pipeline.projectId)).content;
    const sealingStarted = Date.now();
    const generated = await this.ctx.invoke<unknown>("generate_review_package", {
      environmentId: pipeline.environmentId,
      packageId: run.id,
      round,
      targetBranch,
      preparation: validationPreparation(run, { allowCancelled: skipped }),
      expectedHead: run.plan.headRef,
      validationPlan: run.plan,
      additionalLimitations: buildPipelineReviewPackageContext(pipeline, notes).limitations,
    });
    run.sealingDurationMs = Date.now() - sealingStarted;
    pipeline.reviewPackage = parseReviewPackageReference(generated, {
      id: run.id,
      round,
      targetBranch,
    });
    await this.startStage(pipeline, "review", "reviewing");
  }

  async findLinkedEnvironment(
    pipeline: Pick<BuildPipeline, "id" | "projectId">,
  ): Promise<Environment | undefined> {
    return (await this.ctx.storage.getEnvironmentsByProject(pipeline.projectId)).find(
      (environment) =>
        environment.buildPipelineId === pipeline.id && !environment.deletionRequestedAt,
    );
  }

  async assertReviewPackageIntegrity(
    environmentId: string,
    reviewPackage: ReviewPackageReference,
  ): Promise<ReviewPackageVerification> {
    const verification = await this.ctx.invoke<ReviewPackageVerification>("verify_review_package", {
      environmentId,
      reviewPackage,
    });
    if (!verification.valid) {
      throw new Error(
        `Review package integrity verification failed: ${verification.reason ?? "unknown reason"}`,
      );
    }
    return verification;
  }

  private async startVerifiedReviewOrPrepare(pipeline: BuildPipeline): Promise<void> {
    const reviewPackage = pipeline.reviewPackage;
    if (reviewPackage && "kind" in reviewPackage) {
      const verification = await this.ctx.invoke<{ valid: boolean; reason?: string }>(
        "verify_review_package",
        { environmentId: pipeline.environmentId, reviewPackage },
      );
      if (!verification.valid) delete pipeline.reviewPackage;
    }
    if (pipeline.reviewPackage) {
      await this.startStage(pipeline, "review", "reviewing");
    } else {
      await this.startReviewPackagePreparation(pipeline);
    }
  }

  async refreshTranscript(
    session: PipelineSession,
    provider: BuildPipelineProvider,
    observedMessages?: readonly unknown[],
    probe?: ProgressSample,
  ): Promise<boolean> {
    const messages = observedMessages
      ? Array.from(observedMessages)
      : await provider.messages(session.sdkSessionId);
    // The body is held by the checkpointer, not the snapshot: the next save
    // commits it to the transcript store before the control record that
    // references it (plan step 16). "Changed" means changed since the last
    // committed checkpoint, so a throttled delta is re-detected until saved.
    return this.ctx.transcriptCheckpoints.observe(session, messages, probe);
  }

  /**
   * {@link refreshTranscript}, but the whole transcript is read only when it
   * may have moved since the committed copy.
   *
   * A bounded progress probe goes first: a conditional read of the newest
   * messages, answered `unchanged` from the provider's source token without a
   * body. Only summary probes track revisions outside the tail; legacy probes
   * cannot skip a checkpoint read. When a summary matches the probe the
   * committed copy was read under, nothing
   * else is read and the answer is "unchanged". Otherwise — a moved probe, no
   * baseline yet (a new session, a backend restart), or a probe that failed
   * and so taught nothing — the whole transcript is read as before, and the
   * probe becomes the new baseline. The probe always precedes the read, so a
   * baseline never describes content newer than the copy it vouches for.
   *
   * `force` reads the whole transcript even when the probe matches (the pass
   * that sees a turn end). `read` supplies the whole read, so a caller that
   * shares one read per pass keeps sharing it. A provider without the bounded
   * snapshot surface has no cheap probe and keeps reading the whole body.
   */
  async refreshMovedTranscript(
    session: PipelineSession,
    provider: BuildPipelineProvider,
    options: { force?: boolean; read?: () => Promise<readonly unknown[]> } = {},
  ): Promise<boolean> {
    let whole: Promise<readonly unknown[]> | undefined;
    const readWhole = () =>
      (whole ??= options.read ? options.read() : provider.messages(session.sdkSessionId));
    if (!hasProgressSnapshot(provider)) {
      return this.refreshTranscript(session, provider, await readWhole());
    }
    const checkpoints = this.ctx.transcriptCheckpoints;
    let probe: ProgressSample | undefined;
    try {
      probe = await readTranscriptProgressSample({
        provider,
        sessionId: session.sdkSessionId,
        known: checkpoints.knownProbe(session),
        // An oversized tail row is hashed from the exact tail; take it from the
        // whole read this pass is about to need anyway.
        fallbackRead: async () => Array.from(await readWhole()),
      });
    } catch {
      // Nothing learned: the whole read below decides, as before the probe.
    }
    if (!options.force && probe && checkpoints.matchesProbe(session, probe)) return false;
    return this.refreshTranscript(session, provider, await readWhole(), probe);
  }

  shouldPersistTranscript(session: PipelineSession): boolean {
    const elapsed = elapsedSince(session.messagesPersistedAt);
    return elapsed === null || elapsed >= this.ctx.transcriptPersistIntervalMs;
  }

  /**
   * Dispatches the oldest queued user message into the current session.
   *
   * The message moves out of the queue and into the durable prompt attempt
   * before anything is sent, so a dispatch whose response is lost is retried by
   * the normal pending-attempt path under the same request id rather than being
   * either dropped or delivered twice.
   */
  async dispatchUserMessage(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const [next, ...rest] = pipeline.pendingUserMessages ?? [];
    if (!next) return;
    const phase = resumablePhase(pipeline.phase);
    if (!phase) return;
    if (phase === "building" || phase === "fixing") discardPreparationResult(session);
    if (rest.length) {
      pipeline.pendingUserMessages = rest;
    } else {
      delete pipeline.pendingUserMessages;
    }
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    pipeline.pendingPromptAttempt = {
      dispatchVersion: 1,
      id: next.id,
      sessionId: session.sdkSessionId,
      requestId,
      phase,
      prompt: next.text,
      useTaskImages: false,
      startedAt,
    };
    session.turnStartedAt = startedAt;
    delete session.completedAt;
    delete session.usageFinalizationPolls;
    delete pipeline.stallWarning;
    await this.ctx.save(pipeline, pipeline.backendRevision);
    await this.dispatchPending(pipeline, provider);
  }

  async ensureSourceLink(pipeline: BuildPipeline): Promise<void> {
    if (!pipeline.environmentId || pipeline.sourceLinkedAt) return;
    if (pipeline.source?.type === "kanban") {
      await this.ctx.invoke("update_kanban_task", {
        taskId: pipeline.source.taskId,
        environmentId: pipeline.environmentId,
        buildPipelineId: pipeline.id,
      });
    }
    if (pipeline.featurePlanId) {
      await this.ctx.invoke("update_feature_plan", {
        featureId: pipeline.featurePlanId,
        updates: {
          status: "building",
          buildTaskId: pipeline.taskId,
          buildPipelineId: pipeline.id,
          codexEnvironmentId: pipeline.environmentId,
        },
      });
    }
    pipeline.sourceLinkedAt = new Date().toISOString();
    await this.ctx.save(pipeline, pipeline.backendRevision);
  }

  async restartMissingStage(pipeline: BuildPipeline): Promise<void> {
    const stage =
      pipeline.phase === "building"
        ? "build"
        : pipeline.phase === "reviewing"
          ? "review"
          : pipeline.phase === "addressing"
            ? "address"
            : pipeline.phase === "verifying"
              ? "verify"
              : pipeline.phase === "fixing"
                ? "fix"
                : pipeline.phase === "creating-pr"
                  ? "pr"
                  : pipeline.phase === "resolving-conflicts"
                    ? "resolve-conflicts"
                    : null;
    if (!stage) throw new Error(`Cannot recover pipeline phase ${pipeline.phase}`);
    if (stage === "review") {
      await this.startVerifiedReviewOrPrepare(pipeline);
      return;
    }
    await this.startStage(pipeline, stage, pipeline.phase as ResumableBuildPhase);
  }

  /**
   * Opens a writable preparation-only turn before a review retry or legacy
   * package-less review. Reusing the normal fixing completion path keeps
   * structured-result recovery and package generation in one state machine.
   */
  async startReviewPackagePreparation(pipeline: BuildPipeline): Promise<void> {
    const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
    const targetBranch = repository.prBaseBranch || "main";
    if (pipeline.validationRun) {
      await this.ctx.invoke("cancel_review_validation", {
        environmentId: pipeline.environmentId,
        run: pipeline.validationRun,
      });
      delete pipeline.validationRun;
    }
    delete pipeline.reviewPackage;
    await this.startStage(pipeline, "fix", "fixing", {
      // The dedicated preparation runs under the preparation step, not Build.
      prompt: withBuildStepInstructions(
        reviewValidationDiscoveryPrompt(targetBranch),
        pipelineReviewPreparationInstructions(pipeline),
      ),
      images: [],
      schema: REVIEW_VALIDATION_PLAN_SCHEMA,
      label: buildPipelineStage("preparation").session!.label,
      settings: pipeline.reviewPreparation
        ? {
            agent: pipeline.reviewPreparation.agent,
            model: pipeline.reviewPreparation.model,
            effort: pipeline.reviewPreparation.reasoningEffort,
          }
        : await this.agents.stepSettings(pipeline, "address"),
    });
  }

  /**
   * Applies one pass of the multi-model review stage.
   *
   * The fan-out reports what happened rather than mutating the phase itself,
   * so that the transition into `addressing` or `verifying` stays where every
   * other stage transition is, and a failure is raised the same way any other stage's is.
   */
  async advanceReviewFanout(pipeline: BuildPipeline): Promise<void> {
    const step: ReviewFanoutStep = await this.reviewFanout().advance(pipeline);
    if (step.kind === "working") return;
    if (step.kind === "failed") throw new Error(step.error);
    const report = pipeline.structuredReview ?? pipeline.reviewFanout?.report;
    if (!report) throw new Error("The consolidated review report is missing");
    // The consolidated report routes exactly as a single reviewer's does:
    // Address when it has findings, otherwise straight to Verify.
    const next = stageAfterReview(report);
    // The next stage opens first, and only then is the record dropped.
    // Doing it the other way round leaves a window in which the phase is still
    // `reviewing` with nothing to drive it, which the branch above would have
    // to recover from by re-running every reviewer.
    await this.startStage(pipeline, next.sessionPhase, next.phase);
    // Everything downstream reads `structuredReview`, which the fan-out has
    // already written. Dropping the record keeps the snapshot from carrying a
    // completed fan-out through the rest of the run — and makes a later review
    // iteration start a fresh one rather than resume this one.
    delete pipeline.reviewFanout;
    await this.ctx.save(pipeline, pipeline.backendRevision);
  }

  async startStage(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
    phase: ResumableBuildPhase,
    override?: {
      prompt: string;
      images: BuildPipeline["taskSnapshot"]["images"];
      mode?: ProviderExecutionMode;
      schema?: JsonSchema;
      label?: string;
      settings?: BuildStepSelection;
    },
  ): Promise<void> {
    await this.ctx.refreshWorkflowRollout();
    // A pipeline retains reports only for its newest review attempt. This is
    // both the retry boundary and the iteration boundary, and prevents up to a
    // full reviewer panel of duplicate structured reports accumulating on
    // every pass through the fix loop.
    if (sessionPhase === "review" && !override) {
      discardSessionReviewReports(pipeline);
    }
    // A multi-reviewer pipeline has no single review session to open, so the
    // review stage is delegated whole. An `override` is a hand-written prompt
    // for one session — a retry or a user message — and is never a fan-out.
    if (sessionPhase === "review" && !override && usesReviewFanout(pipeline)) {
      try {
        await this.reviewFanout().start(pipeline);
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw error;
        throw new PreSessionStageStartError(error, phase);
      }
      return;
    }
    const dispatch = await (async () => {
      if (sessionPhase === "build") {
        await this.recovery.updateKanbanLifecycle(pipeline, {
          status: "in-progress",
          comment: "🔨 Build started",
        });
      }
      // A review over an immutable package runs as a Multi Review reviewer
      // does: plan mode with the read-only mutation boundary.
      const readOnlyReview = readsReviewPackage(pipeline, sessionPhase);
      // Probed before the provider session exists so an unestablishable Git state
      // fails the stage without leaving a session behind or spending a turn on a
      // stage that could never be certified.
      const validationWorktree =
        (!override && buildPipelineSessionStage(sessionPhase).turn === "guarded") || readOnlyReview
          ? await this.validationBaseline(pipeline, readOnlyReview ? "review" : "verify")
          : undefined;
      // Only a real fix turn: the dedicated package-preparation session also
      // runs as "fix" but always arrives with an override and never edits code.
      const originalFix = pipeline.sessions.find(
        (session) =>
          session.phase === "fix" &&
          session.iteration === pipeline.iteration &&
          session.label !== REVIEW_PACKAGE_SESSION_LABEL &&
          // A fix superseded by a rewind from a later round ran before those
          // rounds changed the code; its baseline is not this fix's.
          carriesFixBaseline(pipeline, session),
      );
      // A retry/restart must compare with the code before the first attempt,
      // including when that attempt's probe was unavailable or already consumed.
      const fixWorktreeFingerprint =
        !override && sessionPhase === "fix"
          ? originalFix
            ? originalFix.fixWorktreeFingerprintAtStart
            : await this.worktreeFingerprint(pipeline)
          : undefined;
      // The commit "Rewind code to here" returns to. Best effort and probed
      // once: a step without it only loses that action.
      const headAtStart = validationWorktree?.head ?? (await this.headAtStageStart(pipeline));
      const { agent, model, effort, fastMode, modelSubstitution } = override?.settings
        ? await this.agents.settingsForSelection(pipeline, override.settings)
        : await this.agents.stepSettings(pipeline, sessionPhase);
      const provider = await this.agents.provider(pipeline, agent);
      const label = override?.label ?? SESSION_LABELS[sessionPhase];
      // Stated rather than left to each provider's own default, so the sandbox a
      // stage runs under is one decision in one place and does not move when a
      // step pins a different harness.
      const mode =
        override?.mode ??
        executionModeOverrideForPhase(phase) ??
        (readOnlyReview ? "plan" : executionModeForSessionPhase(sessionPhase, agent));
      const sessionKey = `${pipeline.id}:${sessionPhase}:${pipeline.iteration}:${randomUUID()}`;
      const policy = await this.ctx.executionPolicy(pipeline);
      // Codex binds model and effort at session creation, Claude and OpenCode at
      // prompt dispatch, so a per-step selection has to be supplied at both.
      const sessionId = await provider.createSession(sessionPhase, label, {
        model,
        effort,
        ...(typeof fastMode === "boolean" ? { fastMode } : {}),
        mode,
        ...(readOnlyReview ? { readOnly: true, reviewerSession: true } : {}),
        policy,
        interaction: {
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          ...(readOnlyReview ? { reviewerSession: true } : {}),
          phase: sessionPhase,
          workflowId: pipeline.id,
          provider: agent,
          fence: sessionKey,
        },
      });
      provider.registerSession?.(sessionId, {
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        ...(readOnlyReview ? { reviewerSession: true } : {}),
        phase: sessionPhase,
        workflowId: pipeline.id,
        provider: agent,
        fence: sessionKey,
      });
      const stagePrompt = override
        ? { prompt: override.prompt, images: override.images, schema: override.schema }
        : await this.promptFor(pipeline, sessionPhase, agent, validationWorktree);
      const prompt = withUnattendedPolicy(stagePrompt.prompt);
      const { schema, images } = stagePrompt;
      const requestId = randomUUID();
      const dispatchResultKind = this.ctx.workflowResultKind(
        phase,
        schema === REVIEW_VALIDATION_PLAN_SCHEMA,
      );
      const resultTransport =
        schema !== undefined
          ? dispatchResultKind && this.ctx.workflowToolEnabled(agent, dispatchResultKind)
            ? ("tool-v1" as const)
            : ("structured-output-v1" as const)
          : undefined;
      const promptStartedAt = new Date().toISOString();
      const session: PipelineSession = {
        phase: sessionPhase,
        agent,
        modelSelectionResolved: true,
        ...(model ? { model } : {}),
        ...(modelSubstitution ? { modelSubstitution } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(typeof fastMode === "boolean" ? { fastMode } : {}),
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        iteration: pipeline.iteration,
        sessionKey,
        sdkSessionId: sessionId,
        status: "running",
        startedAt: new Date().toISOString(),
        turnStartedAt: promptStartedAt,
        label,
        messageRevision: 0,
        structuredRequestId: schema !== undefined ? requestId : undefined,
        resultTransport,
        resultSubmission: resultTransport === "tool-v1" ? ("preparing" as const) : undefined,
        structuredResultStatus: schema !== undefined ? "pending" : undefined,
        ...(schema === REVIEW_VALIDATION_PLAN_SCHEMA ||
        schema === REVIEW_PREPARATION_RESULT_JSON_SCHEMA
          ? { producedReviewPackagePlan: true as const }
          : {}),
        // The marker Verify reads to choose the typed report over the text.
        ...(sessionPhase === "address" && dispatchResultKind === PIPELINE_ADDRESS_REPORT_KIND
          ? { addressReportKind: PIPELINE_ADDRESS_REPORT_KIND }
          : {}),
        ...sessionWorkspaceBaselineFields(validationWorktree),
        ...(fixWorktreeFingerprint
          ? { fixWorktreeFingerprintAtStart: fixWorktreeFingerprint }
          : {}),
        ...(headAtStart ? { headAtStart } : {}),
      };
      pipeline.sessions.push(session);
      pipeline.currentSessionIndex = pipeline.sessions.length - 1;
      pipeline.phase = phase;
      delete pipeline.error;
      delete pipeline.failureContext;

      pipeline.pendingPromptAttempt = {
        dispatchVersion: 1,
        id: randomUUID(),
        sessionId,
        requestId,
        phase,
        prompt,
        useTaskImages: images.length > 0,
        structuredReview: schema !== undefined,
        resultTransport,
        validationPlan: schema === REVIEW_VALIDATION_PLAN_SCHEMA,
        startedAt: promptStartedAt,
      };
      pipeline.activePromptContext = {
        phase,
        kind: "prompt-dispatch",
        sessionId,
        prompt,
        useTaskImages: images.length > 0,
        requestId,
        structuredReview: schema !== undefined,
        resultTransport,
        validationPlan: schema === REVIEW_VALIDATION_PLAN_SCHEMA,
      };
      if (phase === "reviewing") {
        pipeline.structuredReviewRequestId = requestId;
        delete pipeline.structuredReview;
      }
      await this.ctx.save(pipeline, pipeline.backendRevision);
      return {
        provider,
        sessionId,
        sessionKey,
        prompt,
        requestId,
        images,
        schema,
        model,
        effort,
        fastMode,
        mode,
        resultTransport,
        agent,
        readOnlyReview,
        policy,
      };
    })().catch((error: unknown) => {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new PreSessionStageStartError(error, phase);
    });
    const {
      provider,
      sessionId,
      sessionKey,
      prompt,
      requestId,
      images,
      schema,
      model,
      effort,
      fastMode,
      mode,
      resultTransport,
      agent,
      readOnlyReview,
      policy,
    } = dispatch;
    const resultKind = this.ctx.workflowResultKind(phase, schema === REVIEW_VALIDATION_PLAN_SCHEMA);
    if (resultTransport === "tool-v1" && resultKind && this.ctx.options.workflowResults) {
      await this.ctx.options.workflowResults.prepare({
        resultKey: requestId,
        kind: resultKind,
        environmentId: pipeline.environmentId,
        projectId: pipeline.projectId,
        provider: agent,
        schema,
      });
    }
    const agentMcp =
      resultTransport === "tool-v1"
        ? await this.ctx.workflowAgentMcp(
            pipeline,
            requestId,
            agent,
            `build pipeline ${phase} step`,
          )
        : undefined;
    const stageSession = { sessionKey, sdkSessionId: sessionId };
    const artifactTurn = this.ctx.beginArtifactTurn(
      pipeline,
      stageSession,
      requestId,
      agent,
      agentMcp,
    );
    const turnAgentMcp = artifactTurn?.agentMcp ?? agentMcp;
    await attachBeforeDispatch(
      provider,
      sessionId,
      turnAgentMcp
        ? {
            agentMcp: turnAgentMcp,
            ...(resultKind ? { workflowResultTool: workflowResultToolName(resultKind) } : {}),
          }
        : undefined,
    );
    try {
      await this.promptDispatch.openDispatchWindow(pipeline, requestId);
    } catch (error) {
      this.ctx.settleArtifactTurn(pipeline, stageSession, requestId);
      throw error;
    }
    try {
      await provider.send(
        sessionId,
        resultTransport === "tool-v1" && resultKind
          ? `${prompt}\n\n${workflowResultInstruction(resultKind, requestId, {
              capability: agentMcp?.workflowResultCapability,
            })}`
          : prompt,
        {
          requestId,
          images,
          schema: resultTransport === "tool-v1" ? undefined : schema,
          model,
          effort,
          ...(typeof fastMode === "boolean" ? { fastMode } : {}),
          mode,
          ...(readOnlyReview ? readOnlyReviewSendOptions(agent, policy) : {}),
          ...(turnAgentMcp ? { agentMcp: turnAgentMcp } : {}),
          ...(artifactTurn?.artifactGrant ? { artifactGrant: artifactTurn.artifactGrant } : {}),
          ...(agentMcp && resultKind
            ? { workflowResultTool: workflowResultToolName(resultKind) }
            : {}),
        },
      );
      delete pipeline.pendingPromptAttempt;
      await this.ctx.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (!(error instanceof AmbiguousPromptDispatchError)) {
        this.ctx.settleArtifactTurn(pipeline, stageSession, requestId);
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        // The bridge may have accepted the stable request before the response
        // was lost. Keep the durable attempt; the next tick settles it on the
        // provider's dispatch answer and re-sends this exact request id only
        // when the provider proves it never arrived.
        return;
      }
      await this.promptDispatch.closeDispatchWindow(pipeline, requestId);
      throw error;
    }
  }

  private async continueInterruptedStage(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const phase = resumablePhase(pipeline.phase);
    if (!phase) throw new Error("Interrupted stage is not resumable");
    const validationPlan = pipeline.activePromptContext?.validationPlan === true;
    const resultKind = session.structuredRequestId
      ? this.ctx.workflowResultKind(phase, validationPlan)
      : undefined;
    await this.sendStageFollowUp(pipeline, provider, session, {
      phase,
      spend: "restartContinuationSent",
      validationPlan,
      prompt: workflowRestartContinuationPrompt({
        workLabel: session.label.toLowerCase(),
        resultLabel: resultKind ? workflowResultLabel(resultKind) : "completed work",
        ...(session.resultTransport === "tool-v1" && resultKind
          ? { toolName: workflowResultToolName(resultKind) }
          : {}),
      }),
    });
  }

  /**
   * Queues the one result reminder for a tool-mode stage turn that went idle
   * with no accepted result, in place of failing it. Returns false when the
   * reminder does not apply or was already spent, so the caller fails as
   * before.
   *
   * The same once-only, persisted contract as the reviewers' and Multi
   * Review's steps: the stage's work is done and only delivery failed, so a
   * fresh stage would redo all of it. The turn's prompt context is gone by
   * now, so the result slot's own binding names what it was waiting for.
   */
  async remindMissingStageResult(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<boolean> {
    const phase = resumablePhase(pipeline.phase);
    const previousRequestId = session.structuredRequestId;
    if (
      !phase ||
      !previousRequestId ||
      session.resultTransport !== "tool-v1" ||
      session.resultReminderSent === true ||
      // Accepted-but-unread and budget-exhausted slots are not a delivery gap
      // another turn can close.
      session.resultSubmission === "received" ||
      session.resultSubmission === "needs-attention"
    ) {
      return false;
    }
    const binding = await this.ctx.options.workflowResults
      ?.binding(
        { environmentId: pipeline.environmentId, projectId: pipeline.projectId },
        previousRequestId,
      )
      .catch(() => null);
    const resultKind = binding?.kind;
    if (
      !resultKind ||
      this.ctx.workflowResultKind(phase, resultKind === "validation-plan") !== resultKind
    ) {
      return false;
    }
    const finalText = await provider
      .messages(session.sdkSessionId, { limit: LAST_ASSISTANT_TEXT_READ_LIMIT })
      .then(lastAssistantText, () => undefined);
    await this.sendStageFollowUp(pipeline, provider, session, {
      phase,
      spend: "resultReminderSent",
      validationPlan: resultKind === "validation-plan",
      prompt: workflowResultReminderPrompt({
        resultLabel: workflowResultLabel(resultKind),
        toolName: workflowResultToolName(resultKind),
        submission: session.resultSubmission,
        finalText,
        workLabel: `${session.label.toLowerCase()} work`,
      }),
    });
    return true;
  }

  /**
   * One automatic follow-up turn in the stage's own session, under a new
   * durable dispatch and result key. The spent flag is saved with the attempt,
   * so a restart before dispatch retries this follow-up instead of earning
   * another.
   */
  private async sendStageFollowUp(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
    followUp: {
      phase: NonNullable<ReturnType<typeof resumablePhase>>;
      spend: "restartContinuationSent" | "resultReminderSent";
      validationPlan: boolean;
      prompt: string;
    },
  ): Promise<void> {
    const { phase } = followUp;
    const previousRequestId = session.structuredRequestId;
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    session[followUp.spend] = true;
    session.turnStartedAt = startedAt;
    delete session.completedAt;
    delete session.usageFinalizationPolls;
    delete session.structuredWaitStartedAt;
    if (previousRequestId) {
      session.structuredRequestId = requestId;
      session.structuredResultStatus = "pending";
      if (session.resultTransport === "tool-v1") session.resultSubmission = "preparing";
      if (phase === "reviewing") pipeline.structuredReviewRequestId = requestId;
    }
    pipeline.pendingPromptAttempt = {
      dispatchVersion: 1,
      id: randomUUID(),
      sessionId: session.sdkSessionId,
      requestId,
      phase,
      prompt: withUnattendedPolicy(followUp.prompt),
      useTaskImages: false,
      structuredReview: previousRequestId !== undefined,
      validationPlan: followUp.validationPlan,
      resultTransport: session.resultTransport,
      startedAt,
    };
    pipeline.activePromptContext = {
      ...pipeline.pendingPromptAttempt,
      kind: "prompt-dispatch",
    };
    delete pipeline.stallWarning;
    await this.ctx.save(pipeline, pipeline.backendRevision);
    if (session.resultTransport === "tool-v1" && previousRequestId) {
      await this.ctx.options.workflowResults?.close(previousRequestId, "superseded");
    }
    await this.dispatchPending(pipeline, provider);
  }

  dispatchPending(pipeline: BuildPipeline, provider: BuildPipelineProvider): Promise<void> {
    return this.promptDispatch.dispatchPending(pipeline, provider);
  }

  /** See {@link BuildPipelineStagePrompts.promptFor}. */
  promptFor(
    pipeline: BuildPipeline,
    phase: PipelineSessionPhase,
    agent: BuildPipelineAgent,
    worktree?: ReviewWorktreeSnapshot,
  ): Promise<StagePrompt> {
    return this.stagePrompts.promptFor(pipeline, phase, agent, worktree);
  }

  async finishReview(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const requestId = pipeline.structuredReviewRequestId;
    if (!requestId) throw new Error("Review result key is missing");
    const result = await this.ctx.readWorkflowResult<unknown>(provider, session, requestId);
    if (!result) {
      try {
        await this.recovery.awaitStructuredResult(pipeline, provider, session, "review");
      } catch (error) {
        // A report the read-only guard kept refusing never arrives. Name the
        // repairable change that blocked it; an unavailable comparison keeps
        // the original missing-result error.
        await this.readOnly.certifySession(pipeline, session, { repairableOnly: true });
        throw error;
      }
      return;
    }
    // The report is only usable from the worktree the reviewer was given.
    await this.readOnly.certifySession(pipeline, session);
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    const parsed = safeParseStructuredReviewReport(result.value, {
      allowLegacyTestResults: true,
    });
    if (!parsed.success) {
      await this.recovery.repairStructuredReport(pipeline, provider, session, parsed.error);
      return;
    }
    const report = stripStructuredReviewProvenance(parsed.data);
    session.structuredResultStatus = "accepted";
    session.reviewReport = report;
    session.reviewIssueCounts = pipelineReviewIssueCounts(report);
    pipeline.structuredReview = report;
    retainRoundReviewReport(pipeline, session, report);
    this.ctx.stageWorkflowResultConsumption(pipeline, session, requestId);
    const next = stageAfterReview(report);
    await this.startStage(pipeline, next.sessionPhase, next.phase);
    await this.ctx.consumeWorkflowResult(pipeline, session, requestId);
  }
}

/** Prompt wording for a result kind, e.g. "review-report" → "review report". */
function workflowResultLabel(kind: WorkflowResultKind): string {
  return kind.replaceAll("-", " ");
}
