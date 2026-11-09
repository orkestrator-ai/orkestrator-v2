import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  adoptCompletedBuild,
  type CompletedBuildAttempt,
} from "./build-pipeline-completed-build.js";
/**
 * Public build pipeline operations: init and shutdown, admission, and every
 * user control (pause, resume, messages, retries, restarts, cancel, remove).
 * Each control records its intent under the pipeline lock and leaves the work to
 * the stage supervisor.
 */
import { DEFAULT_BUILD_PIPELINE_ITERATIONS } from "./build-pipeline-stages.js";
import { createHash, randomUUID } from "node:crypto";
import { buildPipelineKanbanUpdate } from "./build-pipeline-kanban-lifecycle.js";
import {
  BUILD_CANCELLED_ERROR,
  type BuildPipeline,
  type PipelineSession,
  type StartBuildPipelineInput,
  isBuildPipeline,
  isActiveBuildPhase,
  isStartBuildPipelineInput,
  isReviewPackagePreparationSession,
  BRANCH_PUSH_SESSION_LABEL,
  isSupersededPipelineSession,
  pipelineReachedPullRequestStage,
  reviewValidationStage,
  REVIEW_PACKAGE_SESSION_LABEL,
  usesReviewFanout,
  MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH,
  MAX_CODE_REWIND_PREVIEW_PATHS,
  type BuildPipelineCodeRewindPreview,
  type PipelineCodeRewind,
  type PipelineRestartRequest,
  type TaskSnapshot,
} from "@orkestrator/protocol/build-pipeline";
import {
  normalizeTicketContent,
  sectionsFromTicketText,
  TICKET_SECTION_LIMITS,
  type DeliveryPolicy,
} from "@orkestrator/protocol/ticket-sections";
import { backfillBuildPipelineReviewReports } from "./storage-record-upgrades.js";
import type { KanbanTask } from "./storage-shared-core.js";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import type { Environment, PersistedBuildPipeline } from "./models.js";
import { type BuildPipelineProvider } from "./build-pipeline-provider.js";
import {
  errorMessage,
  buildAdmissionKey,
  sessionForCurrentPhase,
  resumablePhase,
  sessionAgent,
  pipelineAgents,
  normalizeReviewers,
  normalizeReviewPreparation,
  normalizeSteps,
  sessionPhaseFor,
  resumePromptFor,
  discardSessionReviewReports,
  withUnattendedPolicy,
} from "./build-pipeline-service-helpers.js";
import {
  DEFAULT_WORKFLOW_DISCOVERY_MS,
  KeyedWorkflowSupervisor,
  type WorkflowReconcileReport,
  type WorkflowSupervisorStatus,
  type WorkflowWakeReason,
} from "./workflow-supervisor.js";
import {
  discoverBuildPipelines,
  type BuildPipelineObligation,
} from "./build-pipeline-scheduling.js";
import { type BuildPipelineContext, BUILD_PIPELINE_PROGRESS_MS } from "./build-pipeline-context.js";
import type { BuildPipelineAgents } from "./build-pipeline-service-agents.js";
import type { BuildPipelineRecovery } from "./build-pipeline-service-recovery.js";
import type { BuildPipelineSupervisor } from "./build-pipeline-service-supervisor.js";
import {
  pruneRoundReviewReports,
  recordRewind,
  restartStepOrder,
  roundReviewReport,
  supersedeSessionsFrom,
  verificationFeedbackBefore,
} from "./build-pipeline-rewind.js";
import { isPanelReviewerSession } from "./build-pipeline-review-panel.js";
import { pruneKeyInformationAfterRewind } from "./build-pipeline-key-information.js";
import {
  codeRewindBackupRef,
  codeRewindRecord,
  codeRewindStateBlocker,
  inspectCodeRewind,
  readWorktreeStatus,
} from "./build-pipeline-code-rewind.js";
import { probeReviewWorktree } from "./review-worktree-probe.js";
import {
  applyBuildPipelineRestartSelection,
  pipelineRestartSlot,
  type BuildPipelineRestartSelection,
  type BuildPipelineRestartSlot,
} from "@orkestrator/protocol/build-pipeline-restart-selection";

import {
  coordinatorRestartRefusal,
  currentStepTarget,
  failedStepTarget,
  locateSessionStep,
  namedStepTarget,
  type CoordinatorRestartedStep,
  type RestartTarget,
} from "./build-pipeline-restart-targets.js";

const log = createLogger("build-pipeline");

const activityLog = createLogger("backend.activity");

/**
 * Clears the per-stage bookkeeping a restart or skip leaves behind: errors,
 * in-flight prompts and interactions, queued messages, retry flags and a pause.
 */
function clearStageControlState(candidate: BuildPipeline): void {
  delete candidate.error;
  delete candidate.cancelledAt;
  delete candidate.failureContext;
  delete candidate.reconnectAttempt;
  delete candidate.pendingPromptAttempt;
  delete candidate.activePromptContext;
  delete candidate.pendingInteractionResolution;
  delete candidate.pendingUserMessages;
  delete candidate.reviewRetryRequested;
  delete candidate.stageRetryRequested;
  delete candidate.interactionRetryRequested;
  delete candidate.stallWarning;
  delete candidate.pausedFromPhase;
  delete candidate.pauseCause;
  delete candidate.completionCommentStatus;
  delete candidate.completionCommentError;
}

export class BuildPipelineLifecycle {
  constructor(
    private readonly ctx: BuildPipelineContext,
    private readonly agents: BuildPipelineAgents,
    private readonly recovery: BuildPipelineRecovery,
    private readonly stageSupervisor: BuildPipelineSupervisor,
  ) {}

  /**
   * Moves legacy inline transcripts out of the control file and collects
   * transcripts no pipeline owns. Runs once per `init` in the background: a
   * large legacy file must not delay re-arming the supervisors, and every
   * unmigrated record stays readable through the legacy adapter meanwhile.
   */
  startTranscriptMaintenance(): void {
    if (this.ctx.transcriptMaintenance) return;
    this.ctx.transcriptMaintenance = (async () => {
      try {
        const report = await this.ctx.storage.migrateBuildPipelineTranscripts({
          shouldContinue: () => !this.ctx.stopped,
        });
        if (report.migrated || report.deferred || report.orphaned) {
          log.info("transcripts.migrated", {
            migrated: report.migrated,
            deferred: report.deferred,
            orphaned: report.orphaned,
            remaining: report.remaining,
          });
        }
        if (this.ctx.stopped) return;
        await this.ctx.storage.sweepBuildPipelineTranscripts();
      } catch (error) {
        log.warn("transcripts.maintenance-failed", { error: formatLogError(error) });
      }
    })();
  }

  async init(): Promise<void> {
    this.ctx.stopped = false;
    const terminalReconciliations: Promise<void>[] = [];
    for (const record of await this.ctx.storage.listAllBuildPipelines()) {
      if (!record.snapshot || typeof record.snapshot !== "object") continue;
      const normalized = {
        ...record.snapshot,
        controller: "backend" as const,
        backendRevision: record.revision,
      };
      if (!isBuildPipeline(normalized)) continue;
      const pipeline = normalized;
      if (pipeline.pendingResultConsumptions?.length && this.ctx.options.workflowResults) {
        try {
          for (const resultKey of pipeline.pendingResultConsumptions) {
            await this.ctx.options.workflowResults.consume(resultKey);
          }
          delete pipeline.pendingResultConsumptions;
          await this.ctx.save(pipeline, record.revision);
        } catch (error) {
          log.warn("result.consume-deferred", {
            pipelineId: pipeline.id,
            error: formatLogError(error),
          });
        }
      }
      if (
        (record.snapshot as { controller?: unknown }).controller !== "backend" ||
        (record.snapshot as { backendRevision?: unknown }).backendRevision !== record.revision
      ) {
        // One unsaveable record must not take the whole backend down with it.
        // The realistic case is a pipeline whose environment carries a deletion
        // tombstone because the app died part-way through deleting it: the save
        // is rejected on purpose, and re-arming the rest of the pipelines still
        // matters far more than adopting this one.
        try {
          await this.ctx.save(pipeline, record.revision);
        } catch (error) {
          log.warn("restore.skipped", { pipelineId: pipeline.id, error: formatLogError(error) });
          continue;
        }
      }
      if (
        pipeline.rewinds?.at(-1)?.code?.pending ||
        this.recovery.needsTerminalReconciliation(pipeline)
      ) {
        terminalReconciliations.push(this.stageSupervisor.runLocked(pipeline.id));
      }
    }
    await this.finishDurablyRecordedInteractionJournalEntries();
    if (this.ctx.options.autoAdvance !== false) {
      // Supervised services own storage maintenance; manually driven services
      // (tests) still migrate each legacy record on its next save.
      this.startTranscriptMaintenance();
      if (this.ctx.keyed) {
        // Non-blocking: the first discovery runs on the scheduler and joins the
        // terminal reconciliations above through the same per-pipeline lock.
        if (!this.ctx.supervisor) {
          this.ctx.supervisor = this.createSupervisor();
          // Deletions by other paths (environment removal) retire their keys
          // at once; everything else is noted where it is written.
          this.ctx.unsubscribeStorage = this.ctx.storage.addResourceChangeListener((change) => {
            if (change.resource === "build-pipeline" && change.deleted) {
              this.ctx.supervisor?.forget(change.id);
            }
          });
          this.ctx.supervisor.start();
        }
      } else {
        this.ctx.timer ??= setInterval(() => {
          void this.stageSupervisor.requestTick();
        }, BUILD_PIPELINE_PROGRESS_MS);
        this.ctx.timer.unref?.();
        void this.stageSupervisor.requestTick();
      }
    }
    await Promise.all(terminalReconciliations);
  }

  wakeEnvironment(environmentId: string, reason: WorkflowWakeReason): void {
    this.ctx.supervisor?.wakeTarget(environmentId, reason);
  }

  schedulingStatus(): WorkflowSupervisorStatus | null {
    return this.ctx.supervisor?.status() ?? null;
  }

  async reconcileScheduling(): Promise<WorkflowReconcileReport | null> {
    return this.ctx.supervisor ? this.ctx.supervisor.reconcileNow() : null;
  }

  /**
   * The keyed driver: one key per pipeline with an obligation, progressed on
   * the previous 1.5 s cadence by the same locked advance. Storage is listed
   * only by the safety discovery.
   */
  private createSupervisor(): KeyedWorkflowSupervisor<BuildPipelineObligation> {
    return new KeyedWorkflowSupervisor<BuildPipelineObligation>({
      domain: "build-pipeline",
      kind: "build-supervisor-tick",
      progressIntervalMs: BUILD_PIPELINE_PROGRESS_MS,
      discoveryIntervalMs: this.ctx.options.discoveryIntervalMs ?? DEFAULT_WORKFLOW_DISCOVERY_MS,
      discover: () => discoverBuildPipelines(this.ctx.storage),
      advance: async (pass) => {
        this.ctx.passTriggers.set(pass.key, pass.trigger);
        try {
          await this.stageSupervisor.runLocked(pass.key);
        } finally {
          this.ctx.passTriggers.delete(pass.key);
        }
      },
      admission: this.ctx.options.workflowAdmission ?? null,
      withoutAdmission: (obligation) => obligation === "provision",
      ...(this.ctx.options.schedulerClock
        ? {
            now: this.ctx.options.schedulerClock.now,
            timers: this.ctx.options.schedulerClock.timers,
          }
        : {}),
    });
  }

  /**
   * Close the narrow crash window after the workflow snapshot committed but
   * before its journal entry advanced to `workflow-recorded`.
   */
  async finishDurablyRecordedInteractionJournalEntries(): Promise<void> {
    const records = await this.ctx.storage.listAllBuildPipelines();
    const pipelines = new Map(
      records
        .filter((record) => isBuildPipeline(record.snapshot))
        .map((record) => [record.id, record.snapshot as BuildPipeline]),
    );
    await this.ctx.storage.updateAgentInteractionResolutionJournal((journal) => ({
      ...journal,
      entries: journal.entries.map((entry) => {
        if (
          entry.state !== "provider-resolved" ||
          entry.claim.workflowType !== "build-pipeline" ||
          entry.providerResolvedAt === undefined
        )
          return entry;
        const pipeline = pipelines.get(entry.claim.workflowId);
        if (!pipeline) return entry;
        const transcriptRecorded = pipeline.sessions.some((session) =>
          session.interactionTranscript?.some((item) => item.id === entry.interactionId),
        );
        const failureRecorded =
          pipeline.phase === "failed" &&
          pipeline.failureContext?.kind === "interactive-request" &&
          pipeline.failureContext.requestId === entry.interactionId;
        if (!transcriptRecorded && !failureRecorded) return entry;
        return {
          ...entry,
          state: "workflow-recorded" as const,
          workflowRecordedAt: Math.max(Date.now(), entry.providerResolvedAt),
        };
      }),
    }));
  }

  async shutdown(): Promise<void> {
    this.ctx.stopped = true;
    if (this.ctx.timer) clearInterval(this.ctx.timer);
    this.ctx.timer = null;
    this.ctx.supervisor?.stop();
    this.ctx.supervisor = null;
    this.ctx.unsubscribeStorage?.();
    this.ctx.unsubscribeStorage = null;
    this.ctx.tickRequested = false;
    if (this.ctx.tickPromise) {
      await this.ctx.tickPromise;
    }
    await this.ctx.transcriptMaintenance;
    this.ctx.transcriptMaintenance = null;
    while (this.ctx.locks.size > 0) {
      await Promise.allSettled(this.ctx.locks.values());
    }
    // A creation still in flight caches its provider when it settles; wait for
    // it so the disposal below reaches that instance too.
    await Promise.allSettled(this.ctx.providerCreations.values());
    await Promise.allSettled(
      [...this.ctx.providers.values()].map(async (provider) => {
        const disposable = provider as BuildPipelineProvider & {
          dispose?: () => void | Promise<void>;
        };
        await disposable.dispose?.();
      }),
    );
    this.ctx.providers.clear();
    this.ctx.provisioningPrompts.clear();
    this.ctx.lastProviderAgent.clear();
  }

  /**
   * The snapshot with the criteria Verify will check, under the Kanban
   * ticket's own ids so the results can be written back to it. The ticket's
   * items are used only while its criteria text still matches the snapshot;
   * otherwise, and for other sources, they are derived from the snapshot text.
   */
  private async snapshotWithCriteria(input: StartBuildPipelineInput): Promise<TaskSnapshot> {
    const snapshot = input.taskSnapshot;
    if (snapshot.acceptanceCriteriaItems) return snapshot;
    let ticket: KanbanTask | undefined;
    if (!input.source || input.source.type === "kanban") {
      try {
        const tasks = await this.ctx.invoke<KanbanTask[]>("get_kanban_tasks", {
          projectId: input.projectId,
        });
        ticket = Array.isArray(tasks) ? tasks.find((task) => task.id === input.taskId) : undefined;
      } catch {
        ticket = undefined;
      }
    }
    const content = ticket ? normalizeTicketContent(ticket, { now: ticket.createdAt }) : undefined;
    const snapshotCriteria =
      sectionsFromTicketText(snapshot.description, snapshot.acceptanceCriteria)
        .acceptanceCriteria ?? [];
    const liveCriteria = content?.sections.acceptanceCriteria ?? [];
    const fromTicket =
      content &&
      liveCriteria.length === snapshotCriteria.length &&
      liveCriteria.every((criterion, index) => criterion.text === snapshotCriteria[index]!.text)
        ? liveCriteria
        : undefined;
    // Verify judges at most this many; the snapshot text keeps the rest.
    const items = (fromTicket ?? snapshotCriteria).slice(
      0,
      TICKET_SECTION_LIMITS.maxAcceptanceCriteria,
    );
    return {
      ...snapshot,
      ...(content && !snapshot.kind ? { kind: content.kind } : {}),
      acceptanceCriteriaItems: items.map(({ id, text }) => ({
        id,
        text,
      })),
    };
  }

  /**
   * The policy to capture at launch, so a ticket deleted before Verify passes
   * still has one to follow. A Kanban ticket's own policy wins.
   */
  private async launchDeliveryPolicy(
    input: StartBuildPipelineInput,
  ): Promise<DeliveryPolicy | undefined> {
    const ticketId =
      input.source?.type === "kanban"
        ? input.source.taskId
        : input.source
          ? undefined
          : input.taskId;
    if (!ticketId) return input.deliveryPolicy;
    const tasks = await this.ctx.invoke<KanbanTask[]>("get_kanban_tasks", {
      projectId: input.projectId,
    });
    if (!Array.isArray(tasks)) throw new Error("Could not capture the ticket delivery policy");
    const ticket = tasks.find((task) => task.id === ticketId);
    return ticket?.sections?.delivery?.policy ?? input.deliveryPolicy;
  }

  async start(
    input: StartBuildPipelineInput,
    coordinatorLaunchId?: string,
    completedBuild?: CompletedBuildAttempt,
  ): Promise<BuildPipeline> {
    if (!isStartBuildPipelineInput(input)) throw new Error("Invalid build pipeline start request");
    // An existing checkout cannot be admitted while a promotion or rewind owns it.
    // The promotion's own admission inherits the exclusive owner's context.
    const release = input.existingEnvironmentId?.trim()
      ? this.ctx.options.environmentFence?.beginMutation(input.existingEnvironmentId.trim())
      : undefined;
    try {
      return await this.startAdmitted(input, coordinatorLaunchId, completedBuild);
    } finally {
      release?.();
    }
  }

  private async startAdmitted(
    input: StartBuildPipelineInput,
    coordinatorLaunchId?: string,
    completedBuild?: CompletedBuildAttempt,
  ): Promise<BuildPipeline> {
    if (!isStartBuildPipelineInput(input)) {
      throw new Error("Invalid build pipeline start request");
    }
    let existingEnvironment: Environment | null = null;
    const existingEnvironmentId = input.existingEnvironmentId?.trim() ?? "";
    if (existingEnvironmentId) {
      existingEnvironment = await this.ctx.storage.getEnvironment(existingEnvironmentId);
      if (
        !existingEnvironment ||
        existingEnvironment.projectId !== input.projectId ||
        existingEnvironment.deletionRequestedAt
      ) {
        throw new Error("The selected pipeline environment does not belong to this project");
      }
    }
    const taskSnapshot = await this.snapshotWithCriteria(input);
    const deliveryPolicy = await this.launchDeliveryPolicy(input);
    const steps = normalizeSteps(input.steps);
    const reviewers = normalizeReviewers(input.reviewers);
    const reviewPreparation = normalizeReviewPreparation(input.reviewPreparation);
    const pipeline: BuildPipeline = {
      id: randomUUID(),
      ...(coordinatorLaunchId ? { coordinatorLaunchId } : {}),
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: existingEnvironmentId,
      environmentType: existingEnvironment?.environmentType ?? input.environmentType,
      ...(input.delegationBaseBranch ? { delegationBaseBranch: input.delegationBaseBranch } : {}),
      ...(input.delegationBaseCommit ? { delegationBaseCommit: input.delegationBaseCommit } : {}),
      // The build step's harness is the pipeline's agent: it is what the
      // environment default is configured for and what every stage without its
      // own configuration falls back to.
      agentType: steps?.build?.agent ?? input.agentType,
      ...(steps ? { steps } : {}),
      ...(reviewers ? { reviewers } : {}),
      ...(reviewPreparation ? { reviewPreparation } : {}),
      ...(input.environmentOptions ? { environmentOptions: input.environmentOptions } : {}),
      phase: existingEnvironment ? "starting-environment" : "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: input.maxIterations ?? DEFAULT_BUILD_PIPELINE_ITERATIONS,
      createdAt: new Date().toISOString(),
      taskTitle: input.taskTitle,
      taskSnapshot,
      source: input.source,
      ...(deliveryPolicy ? { deliveryPolicy } : {}),
      featurePlanId: input.featurePlanId?.trim() || undefined,
      admissionKey: buildAdmissionKey(input),
      backendRevision: 0,
      controller: "backend",
    };
    if (completedBuild) {
      if (!existingEnvironment) {
        throw new Error("A completed Build requires a running existing environment");
      }
      adoptCompletedBuild(pipeline, completedBuild);
      if (existingEnvironment.status !== "running") {
        const admitted = await this.ctx.storage.listBuildPipelines(input.projectId);
        if (
          !admitted.some(
            (record) =>
              isBuildPipeline(record.snapshot) &&
              record.snapshot.admissionKey === pipeline.admissionKey,
          )
        ) {
          throw new Error("A completed Build requires a running existing environment");
        }
      }
    }
    if (!existingEnvironment) {
      // Installed before the reservation becomes visible to timer ticks.
      this.ctx.provisioningPrompts.set(pipeline.id, input.namingPrompt);
    }
    try {
      const admitted = await this.ctx.save(pipeline, 0);
      if (admitted.id !== pipeline.id) {
        this.ctx.provisioningPrompts.delete(pipeline.id);
        const existing = admitted.snapshot;
        if (!isBuildPipeline(existing)) {
          throw new Error("Existing build pipeline admission is invalid");
        }
        if (
          completedBuild &&
          !existing.sessions.some(
            (session) =>
              session.adoptedFromTabId === completedBuild.tabId &&
              session.sdkSessionId === completedBuild.sessionId &&
              session.adoptedAttemptDigest === pipeline.sessions[0]?.adoptedAttemptDigest,
          )
        ) {
          throw new Error("This ticket already has a different Build attempt");
        }
        // Admission is intentionally idempotent, including after a previous
        // caller completed provisioning but failed while publishing the pane
        // layout. Repair that last step before reporting success again. A
        // concurrent winner that has only persisted its initial reservation
        // does not have an environment to attach yet; that winner still owns
        // the provisioning pass and will materialize the tab before it returns.
        if (existing.environmentId && existing.sourceLinkedAt) {
          await this.ctx.storage.ensureBuildPipelineTab({
            pipelineId: existing.id,
            taskId: existing.taskId,
            environmentId: existing.environmentId,
            isLocal: existing.environmentType === "local",
          });
          if (this.ctx.options.autoAdvance !== false)
            void this.stageSupervisor.runLocked(existing.id);
        }
        return existing;
      }
    } catch (error) {
      this.ctx.provisioningPrompts.delete(pipeline.id);
      throw error;
    }
    // Provisioning is performed by the same per-pipeline supervisor lock used
    // by timer ticks. A tick that observes the just-persisted reservation joins
    // this pass instead of racing a second create_environment call.
    // For an existing environment the first pass only commits source linkage;
    // for a new environment it provisions exactly once. In both cases a timer
    // tick joins this same lock, so it cannot race the start response's write.
    await this.stageSupervisor.runLocked(pipeline.id, input.namingPrompt);
    let startedRecord = await this.ctx.requireRecord(pipeline.id);
    let started = startedRecord.snapshot as BuildPipeline;
    if (started.phase === "failed") {
      throw new Error(started.error ?? "Failed to start build pipeline");
    }
    if (!started.sourceLinkedAt) {
      // A newly provisioned environment is associated in the first pass and
      // source-linked in this second pass. It must also use runLocked: a timer
      // can observe the association save before start() resumes, and both
      // callers must join one CAS write rather than racing ensureSourceLink.
      await this.stageSupervisor.runLocked(pipeline.id);
      startedRecord = await this.ctx.requireRecord(pipeline.id);
      started = startedRecord.snapshot as BuildPipeline;
      if (started.phase === "failed") {
        throw new Error(started.error ?? "Failed to link build pipeline source");
      }
    }
    await this.ctx.storage.ensureBuildPipelineTab({
      pipelineId: started.id,
      taskId: started.taskId,
      environmentId: started.environmentId,
      isLocal: started.environmentType === "local",
    });
    if (this.ctx.options.autoAdvance !== false) void this.stageSupervisor.runLocked(pipeline.id);
    return started;
  }

  async importLegacy(
    projectId: string,
    snapshots: unknown[],
  ): Promise<{ importedIds: string[]; skipped: number }> {
    const importedIds: string[] = [];
    let skipped = 0;
    if (!projectId.trim() || !Array.isArray(snapshots)) {
      return { importedIds, skipped: Array.isArray(snapshots) ? snapshots.length : 0 };
    }
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        skipped += 1;
        continue;
      }
      // A localStorage snapshot can predate `testResults.notRun`, the one old
      // shape the database migration upgrades for stored records.
      const normalized = {
        ...(backfillBuildPipelineReviewReports(snapshot) as Record<string, unknown>),
        controller: "backend",
        backendRevision: 0,
      };
      if (!isBuildPipeline(normalized) || normalized.projectId !== projectId) {
        skipped += 1;
        continue;
      }
      if (await this.ctx.storage.getBuildPipeline(normalized.id)) {
        skipped += 1;
        continue;
      }
      if (normalized.environmentId) {
        const environment = await this.ctx.storage.getEnvironment(normalized.environmentId);
        if (
          !environment ||
          environment.projectId !== projectId ||
          environment.deletionRequestedAt ||
          (environment.buildPipelineId !== undefined &&
            environment.buildPipelineId !== normalized.id)
        ) {
          skipped += 1;
          continue;
        }
      }
      // save() short-circuits when an active pipeline already holds this
      // admission key and returns that record instead. Treating the returned id
      // as imported would report a pipeline that was never persisted and then
      // schedule a supervisor pass for it.
      const admitted = await this.ctx.save(normalized, 0);
      if (admitted.id !== normalized.id) {
        skipped += 1;
        continue;
      }
      importedIds.push(normalized.id);
      if (isActiveBuildPhase(normalized.phase) && this.ctx.options.autoAdvance !== false) {
        void this.stageSupervisor.runLocked(normalized.id);
      }
    }
    return { importedIds, skipped };
  }

  /** Immediate supervisor pass, also useful for deterministic backend tests. */
  advanceNow(pipelineId: string): Promise<void> {
    return this.stageSupervisor.runLocked(pipelineId);
  }

  async pause(pipelineId: string): Promise<BuildPipeline> {
    let abortErrors: unknown[] = [];
    const pipeline = await this.ctx.mutate(pipelineId, async (pipeline) => {
      const previous = resumablePhase(pipeline.phase);
      if (!previous) return;
      if (
        pipeline.validationRun &&
        ["planned", "running"].includes(pipeline.validationRun.status)
      ) {
        pipeline.validationRun = await this.ctx.invoke("cancel_review_validation", {
          environmentId: pipeline.environmentId,
          run: pipeline.validationRun,
        });
      }

      pipeline.pausedFromPhase = previous;
      pipeline.phase = "paused";
      pipeline.pauseCause = "requested";
      // The warning says the stage "is still running"; a paused build has
      // stopped, and `advance` returns early for non-active phases so nothing
      // else would ever clear it.
      delete pipeline.stallWarning;
      if (pipeline.reviewFanout) {
        abortErrors = await this.agents.abandonReviewFanout(pipeline, "idle");
      } else {
        const session = sessionForCurrentPhase(pipeline);
        if (session?.status !== "running") return;
        try {
          const provider = await this.agents.provider(pipeline, sessionAgent(pipeline, session));
          await provider.abort(session.sdkSessionId);
          session.status = "idle";
          session.completedAt ??= new Date().toISOString();
        } catch (error) {
          abortErrors = [error];
        }
      }
      if (abortErrors.length > 0) {
        pipeline.error = `Build paused, but stopping every agent could not be confirmed: ${abortErrors.map(errorMessage).join("; ")}`;
      }
    });
    await this.closeWorkflowResults(pipeline, "superseded");
    if (abortErrors.length > 0) throw abortErrors[0];
    return pipeline;
  }

  async resume(pipelineId: string): Promise<BuildPipeline> {
    await this.ctx.refreshWorkflowRollout();
    const paused = (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
    if (paused.phase === "paused") await this.closeWorkflowResults(paused, "superseded");
    const pipeline = await this.ctx.mutate(pipelineId, async (candidate) => {
      if (candidate.phase !== "paused") return;
      const phase = candidate.pausedFromPhase ?? "building";
      candidate.phase = phase;
      delete candidate.pausedFromPhase;
      delete candidate.pauseCause;
      delete candidate.error;
      // Multi-model review resumes the panel it paused: only what the pause
      // interrupted runs again. There is no one reviewer session a generic resume
      // prompt could safely target.
      if (phase === "reviewing" && usesReviewFanout(candidate)) {
        if (!candidate.reviewPackage) {
          // Nothing to review against: the retry path rebuilds the package.
          candidate.reviewRetryRequested = true;
          discardSessionReviewReports(candidate);
          delete candidate.structuredReview;
          delete candidate.structuredReviewRequestId;
          return;
        }
        // Not through `reviewRetryRequested`: an explicit retry always re-runs
        // package preparation, while a resume reuses the package the paused
        // panel was reviewing, and the reports it already has. Pause already
        // stopped the panel; abandon again so an abort that failed then is retried.
        await this.agents.abandonReviewFanout(candidate, "idle");
        await this.stageSupervisor.reviewFanout().resumeAfterPause(candidate);
        delete candidate.verificationResult;
        delete candidate.verificationFeedback;
        return;
      }
      if (candidate.validationRun && !candidate.reviewPackage) return;
      const session = sessionForCurrentPhase(candidate);
      const resumePrompt = resumePromptFor(phase, {
        addressFindingsResult: session?.addressReportKind !== undefined,
        deliveryPolicy: candidate.delivery?.policy,
      });
      const prompt = resumePrompt ? withUnattendedPolicy(resumePrompt) : null;
      if (prompt && session?.status === "idle" && session.phase === sessionPhaseFor(phase)) {
        const requestId = randomUUID();
        const startedAt = new Date().toISOString();
        // An Address session resumes with a result slot only when it was
        // opened with one; an older session keeps its text report.
        const structuredReview =
          phase === "building" ||
          phase === "fixing" ||
          phase === "reviewing" ||
          phase === "verifying" ||
          (phase === "addressing" && session.addressReportKind !== undefined);
        const resumeResultKind = this.ctx.workflowResultKind(phase);
        const resultTransport =
          structuredReview && resumeResultKind
            ? this.ctx.workflowToolEnabled(sessionAgent(candidate, session), resumeResultKind)
              ? ("tool-v1" as const)
              : ("structured-output-v1" as const)
            : structuredReview
              ? ("structured-output-v1" as const)
              : undefined;
        candidate.pendingPromptAttempt = {
          dispatchVersion: 1,
          id: randomUUID(),
          sessionId: session.sdkSessionId,
          requestId,
          phase,
          prompt,
          useTaskImages: false,
          structuredReview,
          resultTransport,
          startedAt,
        };
        session.turnStartedAt = startedAt;
        delete session.completedAt;
        delete session.usageFinalizationPolls;
        delete candidate.stallWarning;
        candidate.activePromptContext = {
          phase,
          kind: "prompt-dispatch",
          sessionId: session.sdkSessionId,
          requestId,
          prompt,
          useTaskImages: false,
          structuredReview,
          resultTransport,
        };
        session.structuredRequestId = structuredReview ? requestId : undefined;
        session.resultTransport = resultTransport;
        session.resultSubmission = resultTransport === "tool-v1" ? "preparing" : undefined;
        session.structuredResultStatus = structuredReview ? "pending" : undefined;
        if (phase === "reviewing") {
          candidate.structuredReviewRequestId = requestId;
          delete candidate.structuredReview;
        }
      }
    });
    void this.stageSupervisor.runLocked(pipelineId);
    return pipeline;
  }

  /**
   * Re-runs the review stage against the current working tree.
   *
   * Recorded as a request rather than performed here so the new session is
   * created inside the same per-pipeline lock every other transition uses; a
   * direct startStage would race a tick that is already advancing this pipeline.
   */
  async retryReview(pipelineId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.ctx.mutate(pipelineId, (candidate) => {
      if (candidate.phase === "complete") {
        rejection = new Error("This build has already completed");
        return;
      }
      if (!candidate.environmentId || candidate.sessions.length === 0) {
        rejection = new Error("This build has not reached its review stage yet");
        return;
      }
      candidate.reviewRetryRequested = true;
      delete candidate.delivery;
      pruneKeyInformationAfterRewind(candidate, candidate.iteration, false, false);
      discardSessionReviewReports(candidate);
      // Preparation archives the cancelled run with its sealed failure summary
      // before deleting the package. Keep that evidence until then.
      if (!candidate.validationRun) delete candidate.reviewPackage;
      delete candidate.structuredReview;
      delete candidate.structuredReviewRequestId;
      delete candidate.verificationResult;
      delete candidate.verificationFeedback;
      if (candidate.phase === "failed" || candidate.phase === "paused") {
        // A retry is an explicit instruction to keep going, so revive the
        // pipeline; the requested review starts on the next supervisor pass.
        candidate.phase = candidate.pausedFromPhase ?? "reviewing";
        delete candidate.pausedFromPhase;
        delete candidate.pauseCause;
        delete candidate.error;
        delete candidate.failureContext;
        // The terminal comment for the abandoned outcome has already been
        // posted. Clearing the bookkeeping lets the eventual new outcome
        // reconcile again; the post commands dedupe by pipeline id, so this
        // cannot produce a second comment on the issue.
        delete candidate.completionCommentStatus;
        delete candidate.completionCommentError;
      }
    });
    if (rejection) throw rejection;
    this.ctx.reviewerPollGate.clearPrefix(`${pipelineId}\0`);
    await this.stageSupervisor.runLocked(pipelineId);
    return (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  /**
   * Restarts one visible pipeline stage and invalidates every result derived
   * from it. The pipeline rewinds to the stage's own round, so the rounds
   * after it are available again; the stage's old session and every later one
   * stay in the record as a superseded previous attempt. The worktree is not
   * reset. Works from a failed or completed pipeline too. The request is
   * persisted before the supervisor opens a new session, so an unmounted
   * renderer or backend restart cannot lose the run.
   *
   * With a `selection` ("Restart in…") the step's configured harness, model,
   * effort and speed are replaced first, so the new session and every later
   * run of that step use them. Only an agent session's step can take one.
   */
  async restartStep(
    pipelineId: string,
    stageId: string,
    selection?: BuildPipelineRestartSelection,
  ): Promise<BuildPipeline> {
    return this.restartLocatedStage(
      pipelineId,
      (candidate) => namedStepTarget(candidate, stageId, Boolean(selection)),
      selection ? { selection } : {},
    );
  }

  /**
   * The coordinator's `restart_build_pipeline_step`: restarts `stageId`, or
   * with none the step a failed pipeline failed in, or the paused, stalled or
   * running pipeline's current step, as the UI's restarts do. A cancelled or
   * completed pipeline, a failure outside every step and an unknown step are
   * refused before anything changes. `alreadyRestarted` reports a repeat of a
   * restart that has already happened (nothing was done again).
   */
  async restartForCoordinator(
    pipelineId: string,
    stageId: string | undefined,
    selection?: BuildPipelineRestartSelection,
    requestId?: string,
  ): Promise<{
    pipeline: BuildPipeline;
    step: CoordinatorRestartedStep;
    alreadyRestarted: boolean;
  }> {
    const requestKey = requestId ? createHash("sha256").update(requestId).digest("hex") : undefined;
    const intent = createHash("sha256")
      .update(
        JSON.stringify({
          stageId,
          selection: selection
            ? {
                agent: selection.agent,
                model: selection.model,
                reasoningEffort: selection.reasoningEffort,
                fastMode: selection.fastMode,
              }
            : undefined,
        }),
      )
      .digest("hex");
    // Read when located, before the restart supersedes the session it names.
    let step: CoordinatorRestartedStep = { phase: "unknown", round: 1 };
    let alreadyRestarted = false;
    const pipeline = await this.restartLocatedStage(
      pipelineId,
      (candidate) => {
        const prior = requestKey
          ? candidate.coordinatorRestarts?.find((entry) => entry.key === requestKey)
          : undefined;
        if (prior) {
          if (prior.intent !== intent)
            return new Error("Restart requestId was reused with different intent");
          step = prior.step;
          alreadyRestarted = true;
          return { kind: "satisfied" };
        }
        if (requestKey && (candidate.coordinatorRestarts?.length ?? 0) >= 1024) {
          return new Error("This pipeline has reached its coordinator restart history capacity");
        }
        const target =
          coordinatorRestartRefusal(candidate, stageId) ??
          (stageId !== undefined
            ? namedStepTarget(candidate, stageId, Boolean(selection))
            : candidate.phase === "failed"
              ? failedStepTarget(candidate)
              : currentStepTarget(candidate));
        if (target instanceof Error) return target;
        const session = target.kind === "session" ? target.session : undefined;
        step = {
          phase:
            target.kind === "session"
              ? target.phase
              : target.kind === "review-package"
                ? "review-preparation"
                : target.kind === "validation"
                  ? "validation"
                  : candidate.phase,
          round: (session?.iteration ?? candidate.iteration) + 1,
          ...(session ? { sessionKey: session.sessionKey, label: session.label } : {}),
        };
        alreadyRestarted =
          target.kind === "satisfied" || (session ? isSupersededPipelineSession(session) : false);
        return target;
      },
      {
        ...(selection ? { selection } : {}),
        recordRestart: requestKey
          ? (candidate) => {
              (candidate.coordinatorRestarts ??= []).push({ key: requestKey, intent, step });
            }
          : undefined,
      },
    );
    return { pipeline, step, alreadyRestarted };
  }

  /**
   * What "Rewind code to here" on `stageId` would do: the commits it drops,
   * whether the upstream branch has them, and why it cannot run now, if it
   * cannot. Reads only; the confirmed request is {@link rewindCode}.
   */
  async previewCodeRewind(
    pipelineId: string,
    stageId: string,
  ): Promise<BuildPipelineCodeRewindPreview> {
    const pipeline = (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
    const located = locateSessionStep(pipeline, stageId);
    if (located instanceof Error) throw located;
    const session = located.session!;
    if (isSupersededPipelineSession(session)) {
      throw new Error(
        "This step belongs to a previous attempt. Rewind to a step of the current run instead.",
      );
    }
    const preview: BuildPipelineCodeRewindPreview = {
      pipelineId,
      sessionKey: session.sessionKey,
      iteration: session.iteration,
      commits: [],
      commitCount: 0,
    };
    const blockers: string[] = [];
    const block = (reason: string | undefined) => {
      if (reason) blockers.push(reason);
    };
    const shipped = pipelineReachedPullRequestStage(pipeline);
    const environment = pipeline.environmentId
      ? await this.ctx.storage.getEnvironment(pipeline.environmentId)
      : null;
    if (shipped && environment?.prUrl) {
      preview.pullRequest = { url: environment.prUrl, state: environment.prState ?? "unknown" };
    }
    if (shipped && environment?.prState === "merged") {
      block("This build's pull request has been merged. Start a new build for further changes.");
    }
    block(codeRewindStateBlocker(pipeline, session));
    const git = this.ctx.options.environmentGit;
    if (!git) block("Rewinding code is not available on this backend.");
    if (session.headAtStart) {
      preview.targetCommit = session.headAtStart;
      const worktree = await probeReviewWorktree(
        (command, args) => this.ctx.invoke(command, args),
        pipeline.environmentId,
      );
      if (worktree.status === "unknown") {
        block(`The worktree could not be read: ${worktree.reason}.`);
      } else {
        preview.head = worktree.head;
        if (worktree.status === "dirty") {
          preview.uncommittedPaths = worktree.paths.slice(0, MAX_CODE_REWIND_PREVIEW_PATHS);
          block(
            "The worktree has uncommitted changes, which a reset would destroy. Commit or discard them first.",
          );
        }
        if (git) {
          try {
            Object.assign(
              preview,
              await inspectCodeRewind(git, pipeline.environmentId, session.headAtStart),
            );
          } catch (error) {
            block(errorMessage(error));
          }
        }
      }
    }
    return blockers.length > 0 ? { ...preview, blocked: blockers[0] } : preview;
  }

  /**
   * Resets the worktree to the commit `stageId` started from and restarts the
   * pipeline from that step, as "Restart from here" does. Refused unless the
   * pipeline is paused, failed or complete, the worktree is clean and HEAD is
   * still `expectedHead`, the one the user's confirmed preview showed. The old
   * tip stays reachable at the rewind's backup ref.
   */
  async rewindCode(
    pipelineId: string,
    stageId: string,
    expectedHead: string,
  ): Promise<BuildPipeline> {
    const git = this.ctx.options.environmentGit;
    if (!git) throw new Error("Rewinding code is not available on this backend.");
    return this.restartLocatedStage(
      pipelineId,
      (candidate) => locateSessionStep(candidate, stageId),
      {
        expectedHead,
        resetCode: async (candidate, session, rewindId) => {
          const blocker = codeRewindStateBlocker(candidate, session);
          if (blocker) return new Error(blocker);
          const target = session.headAtStart!;
          const head = (await git(candidate.environmentId, ["rev-parse", "HEAD"])).trim();
          if (head !== expectedHead) {
            return new Error(
              "The branch moved since the rewind was previewed. Review the commits it drops again.",
            );
          }
          if ((await readWorktreeStatus(git, candidate.environmentId)).trim()) {
            return new Error(
              "The worktree has uncommitted changes, which a reset would destroy. Commit or discard them first.",
            );
          }
          try {
            const inspection = await inspectCodeRewind(git, candidate.environmentId, target);
            const reset = {
              from: head,
              to: target,
              backupRef: codeRewindBackupRef(candidate.id, rewindId),
            };
            return { ...codeRewindRecord(reset, inspection), pending: true };
          } catch (error) {
            return new Error(`The code could not be rewound: ${errorMessage(error)}`);
          }
        },
      },
    );
  }

  /** Restarts whichever stage the pipeline is on ({@link currentStepTarget}). */
  async restartCurrentStep(pipelineId: string): Promise<BuildPipeline> {
    return this.restartLocatedStage(pipelineId, currentStepTarget);
  }

  private async restartLocatedStage(
    pipelineId: string,
    locate: (candidate: BuildPipeline) => RestartTarget,
    options: {
      expectedHead?: string;
      recordRestart?: (candidate: BuildPipeline) => void;
      /** Prepares the reset intent. Git changes only after the restart is saved. */
      resetCode?: (
        candidate: BuildPipeline,
        session: PipelineSession,
        rewindId: string,
      ) => Promise<PipelineCodeRewind | Error>;
      /** "Restart in…": the step runs from now on under this selection. */
      selection?: BuildPipelineRestartSelection;
      /** The named reviewer alone runs again; the panel's other reports stay. */
      rerunReviewer?: boolean;
    } = {},
  ): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    let satisfied = false;
    const mutation = async (candidate: BuildPipeline) => {
      const target = locate(candidate);
      if (target instanceof Error) {
        rejection = target;
        return;
      }
      if (target.kind === "satisfied") {
        satisfied = true;
        return;
      }
      const named = target.kind === "session" ? target.session : undefined;
      if (named && isSupersededPipelineSession(named)) {
        // The same request again (a double click, a retried command) names the
        // step the newest rewind just superseded: that restart is already done.
        // A selection is new intent; no saved rewind records it, so require a
        // fresh session instead of claiming it was applied.
        const latest = candidate.rewinds?.at(-1);
        if (
          options.selection ||
          latest?.id !== named.supersededBy ||
          latest?.sessionKey !== named.sessionKey ||
          (options.resetCode &&
            (!latest.code ||
              latest.code.from !== options.expectedHead ||
              latest.code.to !== named.headAtStart))
        ) {
          rejection = new Error(
            "This step belongs to a previous attempt. Review a fresh rewind preview or restart a step of the current run instead.",
          );
        }
        return;
      }
      if (await this.pullRequestMerged(candidate)) {
        // Shipping again would open a second pull request for merged work.
        rejection = new Error(
          "This build's pull request has been merged. Start a new build for further changes.",
        );
        return;
      }
      let selectionSlot: BuildPipelineRestartSlot | null = null;
      if (options.selection) {
        selectionSlot = named
          ? pipelineRestartSlot(candidate, named)
          : target.kind === "session" &&
              (target.phase !== "review" || (candidate.reviewers?.length ?? 0) <= 1)
            ? pipelineRestartSlot(candidate, { phase: target.phase, label: "" })
            : null;
        if (!selectionSlot) {
          rejection = new Error("This step cannot be restarted with a different agent or model.");
          return;
        }
      }
      // Consolidation, or one reviewer, restarts alone while the reports it
      // needs survive. A code rewind changes what they describe, so it does not.
      const keptPanel =
        named && !options.resetCode
          ? this.stageSupervisor
              .reviewFanout()
              .panelToKeep(candidate, named, Boolean(options.rerunReviewer))
          : null;
      if (options.rerunReviewer && (!keptPanel || !candidate.reviewPackage)) {
        rejection = new Error(
          "This reviewer's review is over. Restart from here to run the whole review again.",
        );
        return;
      }
      const rewindId = randomUUID();
      let code: PipelineCodeRewind | undefined;
      if (options.resetCode) {
        if (!named) {
          rejection = new Error("This pipeline stage is no longer available");
          return;
        }
        // Refused admission leaves the pipeline unchanged. The reset is journaled below.
        const reset = await options.resetCode(candidate, named, rewindId);
        if (reset instanceof Error) {
          rejection = reset;
          return;
        }
        code = reset;
      }
      const fromPhase = candidate.phase;
      const fromIteration = candidate.iteration;
      // Restarting a step rewinds the pipeline to that step's own round. A
      // validation or package restart without a named session is the current
      // round's. The worktree is not rewound: the new run works on the code
      // as it is now, later rounds' commits included.
      const iteration = named ? named.iteration : candidate.iteration;
      const rewindsRound = iteration < candidate.iteration;
      const previousFeedback = candidate.verificationFeedback;
      // Every refusal is behind us, so the new selection cannot outlive a
      // restart that did not happen.
      if (selectionSlot && options.selection) {
        applyBuildPipelineRestartSelection(candidate, selectionSlot, options.selection);
      }

      // A late tool submission from the discarded generation must be denied;
      // otherwise it could become authoritative after the replacement starts.
      await this.closeWorkflowResults(
        candidate,
        "superseded",
        new Set(candidate.pendingResultConsumptions ?? []),
      );

      if (
        candidate.validationRun &&
        (candidate.validationRun.status === "planned" ||
          candidate.validationRun.status === "running")
      ) {
        try {
          candidate.validationRun = await this.ctx.invoke("cancel_review_validation", {
            environmentId: candidate.environmentId,
            run: candidate.validationRun,
          });
        } catch {
          // The new generation is authoritative even when an obsolete runner
          // cannot confirm cancellation. Its id is discarded below.
        }
      }
      await this.stopCurrentStage(candidate, Boolean(options.resetCode));

      // Old records kept only the latest accepted Verify verdict. Preserve it
      // on its owning session before clearing the live result during rewind.
      const verdictOwner = [...candidate.sessions]
        .reverse()
        .find(
          (session) =>
            session.phase === "verify" &&
            !isSupersededPipelineSession(session) &&
            (session.structuredResultStatus === "accepted" ||
              (session.structuredResultStatus === undefined && session.status === "idle")),
        );
      if (verdictOwner && candidate.verificationResult && !verdictOwner.verificationResult) {
        verdictOwner.verificationResult = candidate.verificationResult;
        if (candidate.verificationFeedback !== undefined) {
          const feedback = candidate.verificationFeedback;
          verdictOwner.verificationFeedback ??=
            feedback.length <= MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH
              ? feedback
              : `${feedback.slice(0, MAX_PIPELINE_SESSION_VERIFICATION_FEEDBACK_LENGTH - 1)}…`;
        }
      }
      const previousValidationRun = candidate.validationRun;
      candidate.iteration = iteration;
      if (rewindsRound) {
        // Later rounds derived these from their own code. The rewound round
        // runs on the code as it is now, so it prepares, reviews and verifies
        // again rather than reusing another round's evidence.
        delete candidate.reviewPackage;
        delete candidate.validationRun;
        discardSessionReviewReports(candidate);
        delete candidate.reviewFanout;
        delete candidate.structuredReview;
        delete candidate.structuredReviewRequestId;
        delete candidate.verificationResult;
        delete candidate.verificationFeedback;
      }

      const implementationPhase = (): "build" | "fix" => {
        const currentIterationImplementation = [...candidate.sessions]
          .reverse()
          .find(
            (session) =>
              session.iteration === candidate.iteration &&
              (session.phase === "build" || session.phase === "fix") &&
              !isSupersededPipelineSession(session) &&
              !isReviewPackagePreparationSession(session, candidate),
          );
        return currentIterationImplementation?.phase === "fix" ? "fix" : "build";
      };

      if (keptPanel) {
        await this.stageSupervisor
          .reviewFanout()
          .reopenPanel(candidate, keptPanel, options.rerunReviewer ? named : undefined);
      } else if (target.kind === "validation") {
        const plan = candidate.validationRun!.plan;
        candidate.validationRun = newReviewValidationRun(`review-validation-${randomUUID()}`, plan);
        candidate.restartRequest = {
          kind: "validation",
          implementationPhase: implementationPhase(),
        };
      } else if (target.kind === "review-package") {
        candidate.restartRequest = target;
      } else if (
        !target.forceStage &&
        isReviewPackagePreparationSession(target.session, candidate)
      ) {
        candidate.restartRequest = {
          kind: "review-package",
          implementationPhase: target.phase === "fix" ? "fix" : "build",
        };
      } else {
        const requestedPhase = target.phase;
        if (requestedPhase === "review" && !candidate.reviewPackage) {
          candidate.restartRequest = {
            kind: "review-package",
            implementationPhase: implementationPhase(),
          };
        } else if (requestedPhase === "address" && !candidate.structuredReview) {
          // A later round replaced the live report; the round's own copy lets
          // Address rerun alone instead of reviewing again.
          const retained = roundReviewReport(candidate, iteration);
          if (retained) {
            candidate.structuredReview = retained;
            candidate.restartRequest = { kind: "session", phase: "address" };
          } else {
            candidate.restartRequest = candidate.reviewPackage
              ? { kind: "session", phase: "review" }
              : { kind: "review-package", implementationPhase: implementationPhase() };
          }
        } else {
          candidate.restartRequest = { kind: "session", phase: requestedPhase };
        }
      }

      // A reopened panel needs no request: the next pass finds it live and
      // advances it, which is the step running again.
      const restart: PipelineRestartRequest = keptPanel
        ? { kind: "session", phase: "review" }
        : candidate.restartRequest!;
      const selectedPhase =
        restart.kind === "session" ? restart.phase : restart.implementationPhase;
      const selectedOrder = {
        build: 0,
        fix: 0,
        review: 2,
        address: 3,
        verify: 4,
        pr: 5,
        "resolve-conflicts": 6,
      }[selectedPhase];

      if (selectedOrder <= 1) {
        delete candidate.reviewPackage;
        if (restart.kind !== "validation") delete candidate.validationRun;
      }
      if (selectedOrder <= 2 && !keptPanel) {
        discardSessionReviewReports(candidate);
        delete candidate.reviewFanout;
        delete candidate.structuredReview;
        delete candidate.structuredReviewRequestId;
      }
      if (selectedOrder <= 4) {
        // Verify runs again, so the next pass reads the ticket again.
        delete candidate.delivery;
        delete candidate.verificationResult;
        if (!(restart.kind === "session" && restart.phase === "fix")) {
          delete candidate.verificationFeedback;
        }
      }
      if (restart.kind === "session" && restart.phase === "fix") {
        // A fix answers the verification that ended the round before it.
        // A legacy record's pipeline-level verdict belongs to its latest
        // round; it cannot explain a Fix in an earlier round.
        const feedback =
          verificationFeedbackBefore(candidate, iteration) ??
          (rewindsRound ? undefined : previousFeedback);
        if (feedback === undefined) delete candidate.verificationFeedback;
        else candidate.verificationFeedback = feedback;
      }

      // The restarted step's old session and everything after it become a
      // previous attempt: kept, readable, and out of the live run.
      const at = new Date().toISOString();
      const supersededSessions = supersedeSessionsFrom(
        candidate,
        { iteration, order: restartStepOrder(restart) },
        rewindId,
        at,
        (session) =>
          keptPanel !== null &&
          session.reviewPassId !== undefined &&
          session.reviewPassId === named?.reviewPassId &&
          isPanelReviewerSession(session, session.reviewPassId),
      );
      pruneRoundReviewReports(candidate);
      pruneKeyInformationAfterRewind(
        candidate,
        iteration,
        restart.kind === "session" &&
          (restart.phase === "pr" || restart.phase === "resolve-conflicts"),
        selectedOrder > 2,
      );
      if (
        supersededSessions > 0 ||
        code ||
        (previousValidationRun && previousValidationRun.id !== candidate.validationRun?.id)
      ) {
        recordRewind(candidate, {
          id: rewindId,
          at,
          fromPhase,
          fromIteration,
          iteration,
          step: { ...restart },
          ...(named ? { sessionKey: named.sessionKey } : {}),
          supersededSessions,
          ...(restart.kind === "validation"
            ? { replacementValidationRunId: candidate.validationRun!.id }
            : {}),
          ...(previousValidationRun && previousValidationRun.id !== candidate.validationRun?.id
            ? { validationRun: previousValidationRun }
            : {}),
          ...(code ? { code } : {}),
        });
      }

      candidate.phase =
        restart.kind === "session"
          ? restart.phase === "build"
            ? "building"
            : restart.phase === "review"
              ? "reviewing"
              : restart.phase === "address"
                ? "addressing"
                : restart.phase === "verify"
                  ? "verifying"
                  : restart.phase === "fix"
                    ? "fixing"
                    : restart.phase === "pr"
                      ? "creating-pr"
                      : "resolving-conflicts"
          : restart.implementationPhase === "fix"
            ? "fixing"
            : "building";
      delete candidate.skipRequest;
      clearStageControlState(candidate);
      candidate.pendingKanbanReactivation = true;
      delete candidate.kanbanReactivationRetryAt;
      options.recordRestart?.(candidate);
    };
    await this.ctx.mutate(pipelineId, mutation, (candidate) => {
      const target = locate(candidate);
      return Boolean(
        options.resetCode &&
        !(target instanceof Error) &&
        target.kind === "session" &&
        target.session &&
        !isSupersededPipelineSession(target.session),
      );
    });
    if (rejection) throw rejection;
    if (!satisfied) await this.stageSupervisor.runLocked(pipelineId);
    return (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  /**
   * Skips the stage the pipeline is on and moves to the one after it, without
   * the skipped stage's result. `stageId` names the stage the user saw, so a
   * renderer behind the latest transition cannot skip the stage after it.
   *
   * Skipping validation stops the checks and seals the review package with the
   * results they had, as a Multi Review's "stop validation" does. Skipping an
   * agent stage stops its session: an implementation turn goes to review
   * preparation, a review or an address turn to verification, and a
   * verification to the pull request. Review preparation cannot be skipped,
   * because the review reads the package it produces.
   */
  async skipStep(pipelineId: string, stageId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.ctx.mutate(pipelineId, async (candidate) => {
      const phase =
        candidate.phase === "paused" ? candidate.pausedFromPhase : resumablePhase(candidate.phase);
      const stagePhase = phase ? sessionPhaseFor(phase) : null;
      if (!phase || !stagePhase) {
        rejection = new Error("This build has no running step to skip");
        return;
      }
      const validationTarget = reviewValidationStage(candidate, phase);
      const run = candidate.validationRun;
      if (validationTarget === "validation" || stageId.startsWith("validation:")) {
        // A pause cancels the run, so a paused pipeline's run may be cancelled;
        // in a running one that means preparation is starting over instead.
        const skippable =
          run !== undefined &&
          stageId === `validation:${run.id}` &&
          !candidate.reviewPackage &&
          !candidate.reviewRetryRequested &&
          (phase === "building" || phase === "fixing") &&
          (run.status === "planned" ||
            run.status === "running" ||
            (run.status === "cancelled" && candidate.phase === "paused"));
        if (!skippable) {
          rejection = new Error("This step has already finished");
          return;
        }
        // The supervisor stops the run and seals its partial results; recording
        // the intent first means a restart in between still skips it.
        candidate.skippedValidationRunId = run.id;
        candidate.phase = phase;
        clearStageControlState(candidate);
        return;
      }
      const session = sessionForCurrentPhase(candidate);
      const fanoutReview =
        phase === "reviewing" && usesReviewFanout(candidate) && Boolean(candidate.reviewFanout);
      const named = candidate.sessions.find(
        (entry) => entry.sdkSessionId === stageId || entry.sessionKey === stageId,
      );
      const isCurrent =
        named !== undefined &&
        !named.superseded &&
        !isSupersededPipelineSession(named) &&
        named.phase === stagePhase &&
        (fanoutReview
          ? Boolean(named.sessionKey) &&
            (candidate.reviewFanout!.reviewers.some(
              (reviewer) => reviewer.sessionKey === named.sessionKey,
            ) ||
              candidate.reviewFanout!.consolidation?.sessionKey === named.sessionKey)
          : named === session);
      if (!isCurrent) {
        rejection = new Error("This step has already finished");
        return;
      }
      if (
        validationTarget === "review-package" ||
        named.label === REVIEW_PACKAGE_SESSION_LABEL ||
        stagePhase === "pr" ||
        stagePhase === "resolve-conflicts"
      ) {
        rejection = new Error(
          stagePhase === "resolve-conflicts"
            ? "Conflict resolution cannot be skipped"
            : stagePhase === "pr"
              ? named.label === BRANCH_PUSH_SESSION_LABEL
                ? "The push step cannot be skipped"
                : "The pull request step cannot be skipped"
              : "Review preparation cannot be skipped: the review needs the package it prepares",
        );
        return;
      }

      // A late tool submission from the skipped stage must not be accepted
      // once its successor has started.
      await this.closeWorkflowResults(
        candidate,
        "superseded",
        new Set(candidate.pendingResultConsumptions ?? []),
      );
      await this.stopCurrentStage(candidate);
      if (fanoutReview) {
        const fanout = candidate.reviewFanout!;
        // Keep the interrupted pass visible after the supervisor retires its
        // live state. Skipping the panel discards all of its reviewer results;
        // skipping only consolidation preserves the settled reviewer outcomes.
        const skippedKeys = new Set(
          fanout.reviewers
            .filter((reviewer) => !fanout.consolidation || reviewer.status === "cancelled")
            .map((reviewer) => reviewer.sessionKey),
        );
        if (fanout.consolidation) skippedKeys.add(fanout.consolidation.sessionKey);
        for (const entry of candidate.sessions) {
          if (!entry.sessionKey || !skippedKeys.has(entry.sessionKey)) continue;
          entry.skipped = true;
          entry.completedAt ??= new Date().toISOString();
        }
      } else {
        named.skipped = true;
        named.completedAt ??= new Date().toISOString();
      }
      candidate.skipRequest = { phase: stagePhase };
      candidate.phase = phase;
      delete candidate.restartRequest;
      clearStageControlState(candidate);
    });
    if (rejection) throw rejection;
    await this.stageSupervisor.runLocked(pipelineId);
    return (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  /** Stops whatever agent work the current stage has running. Best effort. */
  private async stopCurrentStage(candidate: BuildPipeline, requireStopped = false): Promise<void> {
    if (candidate.reviewFanout) {
      const errors = await this.agents.abandonReviewFanout(candidate, "idle");
      if (requireStopped && errors.length) throw errors[0];
      return;
    }
    const current = sessionForCurrentPhase(candidate);
    if (current?.status !== "running") return;
    try {
      await (
        await this.agents.provider(candidate, sessionAgent(candidate, current))
      ).abort(current.sdkSessionId);
    } catch (error) {
      if (requireStopped) throw error;
      // The pipeline moves to a new session; a failed best-effort abort must
      // not strand the durable request on the obsolete generation.
    }
    current.status = "idle";
    current.completedAt ??= new Date().toISOString();
  }

  /**
   * Whether this pipeline shipped a pull request that has since merged. A
   * restart would then ship the work a second time. An environment PR with no
   * Ship session belongs to a reused environment, not to this pipeline.
   */
  private async pullRequestMerged(pipeline: BuildPipeline): Promise<boolean> {
    if (!pipeline.environmentId || !pipelineReachedPullRequestStage(pipeline)) {
      return false;
    }
    const environment = await this.ctx.storage.getEnvironment(pipeline.environmentId);
    return environment?.prState === "merged";
  }

  /**
   * Runs one failed reviewer of the current review pass again. The rest of
   * the panel keeps its reports; a pipeline that failed or paused in the
   * review resumes it.
   */
  async retryReviewer(pipelineId: string, reviewerId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.ctx.mutate(pipelineId, async (candidate) => {
      const phase =
        candidate.phase === "paused"
          ? candidate.pausedFromPhase
          : candidate.phase === "failed"
            ? candidate.failureContext?.phase
            : candidate.phase;
      if (
        phase !== "reviewing" ||
        (candidate.phase === "failed" && candidate.failureContext?.kind === "interactive-request")
      ) {
        rejection = new Error("This build is not in a review that can retry a reviewer");
        return;
      }
      try {
        await this.stageSupervisor.reviewFanout().prepareReviewerRetry(candidate, reviewerId);
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
        return;
      }
      if (candidate.phase === "failed" || candidate.phase === "paused") {
        candidate.phase = "reviewing";
        delete candidate.pausedFromPhase;
        delete candidate.pauseCause;
        delete candidate.error;
        delete candidate.failureContext;
        delete candidate.cancelledAt;
        delete candidate.reconnectAttempt;
        delete candidate.stageRetryRequested;
        delete candidate.completionCommentStatus;
        delete candidate.completionCommentError;
      }
      delete candidate.stallWarning;
    });
    if (rejection) throw rejection;
    await this.stageSupervisor.runLocked(pipelineId);
    return (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  /**
   * Stops one reviewer of the running review. The rest of the panel carries on,
   * and consolidation runs from the reports the others file.
   */
  async stopReviewer(pipelineId: string, reviewerId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    const pipeline = await this.ctx.mutate(pipelineId, async (candidate) => {
      try {
        await this.stageSupervisor.reviewFanout().stopReviewer(candidate, reviewerId);
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
      }
    });
    if (rejection) throw rejection;
    // With this reviewer out of the way the pass may already be able to
    // consolidate. The answer does not wait for that pass: it can be held up by
    // the reviewers still running.
    void this.stageSupervisor.runLocked(pipelineId);
    return pipeline;
  }

  /**
   * Runs one reviewer again whatever state it is in, keeping the rest of the
   * panel. In the running review its peers carry on undisturbed; for a pass the
   * pipeline has moved on from, the round rewinds to the panel, as a restart does.
   */
  async restartReviewer(pipelineId: string, reviewerId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    let live = false;
    await this.ctx.mutate(pipelineId, async (candidate) => {
      const phase =
        candidate.phase === "paused"
          ? candidate.pausedFromPhase
          : candidate.phase === "failed"
            ? candidate.failureContext?.phase
            : candidate.phase;
      live =
        phase === "reviewing" &&
        Boolean(
          candidate.reviewFanout?.reviewers.some(
            (reviewer) => reviewer.id === reviewerId || reviewer.sessionKey === reviewerId,
          ),
        );
      if (!live) return;
      if (
        candidate.phase === "failed" &&
        candidate.failureContext?.kind === "interactive-request"
      ) {
        rejection = new Error("This build is not in a review that can restart a reviewer");
        return;
      }
      try {
        await this.stageSupervisor
          .reviewFanout()
          .prepareReviewerRetry(candidate, reviewerId, { anyStatus: true });
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
        return;
      }
      if (candidate.phase === "failed" || candidate.phase === "paused") {
        candidate.phase = "reviewing";
        delete candidate.pausedFromPhase;
        delete candidate.pauseCause;
        delete candidate.error;
        delete candidate.failureContext;
        delete candidate.cancelledAt;
        delete candidate.reconnectAttempt;
        delete candidate.stageRetryRequested;
        delete candidate.completionCommentStatus;
        delete candidate.completionCommentError;
      }
      delete candidate.stallWarning;
    });
    if (rejection) throw rejection;
    if (!live) {
      return this.restartLocatedStage(
        pipelineId,
        (candidate) => locateSessionStep(candidate, reviewerId),
        { rerunReviewer: true },
      );
    }
    void this.stageSupervisor.runLocked(pipelineId);
    return (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  /** Starts a fresh attempt for the non-interactive stage that failed. */
  async retryStage(pipelineId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.ctx.mutate(pipelineId, (candidate) => {
      if (
        candidate.phase !== "failed" ||
        !candidate.failureContext ||
        candidate.failureContext.kind === "interactive-request"
      ) {
        rejection = new Error("This build has no failed stage to retry");
        return;
      }
      const phase = candidate.failureContext.phase;
      candidate.phase = phase;
      if (sessionPhaseFor(phase)) {
        candidate.stageRetryRequested = true;
      } else {
        delete candidate.stageRetryRequested;
      }
      const failedSession = sessionForCurrentPhase(candidate);
      if (
        failedSession &&
        !failedSession.adoptedFromTabId &&
        failedSession.sdkSessionId === candidate.failureContext.sessionId
      ) {
        failedSession.status = "error";
      }
      delete candidate.error;
      delete candidate.failureContext;
      delete candidate.cancelledAt;
      delete candidate.reconnectAttempt;
      delete candidate.pendingPromptAttempt;
      delete candidate.activePromptContext;
      delete candidate.reviewRetryRequested;
      delete candidate.interactionRetryRequested;
      delete candidate.stallWarning;
      delete candidate.completionCommentStatus;
      delete candidate.completionCommentError;
    });
    if (rejection) throw rejection;
    await this.stageSupervisor.runLocked(pipelineId);
    return (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  async retryInteractionFailure(pipelineId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.ctx.mutate(pipelineId, (candidate) => {
      if (
        candidate.phase !== "failed" ||
        candidate.failureContext?.kind !== "interactive-request"
      ) {
        rejection = new Error("This build has no interactive request failure to retry");
        return;
      }
      // `advance` consumes the retry flag after the provisioning phases have
      // already returned, so a phase that owns no stage session would leave the
      // flag set and start the stage twice. Reject it here instead, where the
      // pipeline is still untouched.
      if (!sessionPhaseFor(candidate.failureContext.phase)) {
        rejection = new Error(`Cannot retry pipeline phase ${candidate.failureContext.phase}`);
        return;
      }
      candidate.phase = candidate.failureContext.phase;
      candidate.interactionRetryRequested = true;
      delete candidate.error;
      delete candidate.failureContext;
      delete candidate.cancelledAt;
      delete candidate.pendingInteractionResolution;
      delete candidate.completionCommentStatus;
      delete candidate.completionCommentError;
    });
    if (rejection) throw rejection;
    await this.stageSupervisor.runLocked(pipelineId);
    return (await this.ctx.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  async cancel(pipelineId: string): Promise<BuildPipeline> {
    let abortErrors: unknown[] = [];
    const pipeline = await this.ctx.mutate(pipelineId, async (pipeline) => {
      if (
        pipeline.validationRun &&
        ["planned", "running"].includes(pipeline.validationRun.status)
      ) {
        pipeline.validationRun = await this.ctx.invoke("cancel_review_validation", {
          environmentId: pipeline.environmentId,
          run: pipeline.validationRun,
        });
      }

      if (pipeline.reviewFanout) {
        abortErrors = await this.agents.abandonReviewFanout(pipeline, "idle");
      } else {
        const session = sessionForCurrentPhase(pipeline);
        if (session?.status === "running" && pipeline.environmentId) {
          try {
            await (
              await this.agents.provider(pipeline, sessionAgent(pipeline, session))
            ).abort(session.sdkSessionId);
            session.status = "idle";
          } catch (error) {
            abortErrors = [error];
          }
        }
      }
      pipeline.phase = "failed";
      pipeline.cancelledAt = new Date().toISOString();
      pipeline.error =
        abortErrors.length > 0
          ? `${BUILD_CANCELLED_ERROR}, but stopping every agent could not be confirmed: ${abortErrors.map(errorMessage).join("; ")}`
          : BUILD_CANCELLED_ERROR;
      delete pipeline.pendingPromptAttempt;
      delete pipeline.activePromptContext;
      delete pipeline.pendingUserMessages;
      delete pipeline.reviewRetryRequested;
      delete pipeline.stageRetryRequested;
      delete pipeline.interactionRetryRequested;
      delete pipeline.stallWarning;
    });
    // `provider()` records attribution for reconnect handling while a pipeline
    // is active. Cancellation is a terminal transition, so retaining the id
    // here would grow the map for every cancelled build until shutdown.
    this.ctx.lastProviderAgent.delete(pipelineId);
    await this.closeWorkflowResults(pipeline, "cancelled");
    await this.recovery.reconcileTerminalState(pipeline);
    if (abortErrors.length > 0) throw abortErrors[0];
    return pipeline;
  }

  /** Enumerates every bearer result slot still reachable from a pipeline snapshot. */
  private workflowResultKeys(pipeline: BuildPipeline): Set<string> {
    const resultKeys = new Set(
      pipeline.sessions.flatMap((session) =>
        session.resultTransport === "tool-v1" && session.structuredRequestId
          ? [session.structuredRequestId]
          : [],
      ),
    );
    for (const reviewer of pipeline.reviewFanout?.reviewers ?? []) {
      if (reviewer.resultTransport === "tool-v1" && reviewer.requestId) {
        resultKeys.add(reviewer.requestId);
      }
    }
    const consolidation = pipeline.reviewFanout?.consolidation;
    if (consolidation?.resultTransport === "tool-v1") {
      resultKeys.add(consolidation.requestId);
    }
    if (pipeline.pendingPromptAttempt?.resultTransport === "tool-v1") {
      resultKeys.add(pipeline.pendingPromptAttempt.requestId);
    }
    if (
      pipeline.activePromptContext?.resultTransport === "tool-v1" &&
      pipeline.activePromptContext.requestId
    ) {
      resultKeys.add(pipeline.activePromptContext.requestId);
    }
    return resultKeys;
  }

  private async closeWorkflowResults(
    pipeline: BuildPipeline,
    lifecycle: "cancelled" | "superseded",
    excluded = new Set<string>(),
  ): Promise<void> {
    await Promise.all(
      Array.from(this.workflowResultKeys(pipeline), (resultKey) =>
        excluded.has(resultKey)
          ? Promise.resolve()
          : this.ctx.options.workflowResults?.close(resultKey, lifecycle),
      ),
    );
  }

  async remove(pipelineId: string): Promise<void> {
    let record = await this.ctx.storage.getBuildPipeline(pipelineId);
    let deleted = false;
    if (record && isBuildPipeline(record.snapshot) && hasPendingCodeRewind(record.snapshot)) {
      ({ deleted, record } = await this.deleteWithPendingCodeRewind(pipelineId));
    }
    if (
      !deleted &&
      record &&
      isBuildPipeline(record.snapshot) &&
      (isActiveBuildPhase(record.snapshot.phase) || record.snapshot.reviewFanout !== undefined)
    ) {
      await this.cancel(pipelineId);
    }
    if (!deleted) await this.ctx.storage.deleteBuildPipeline(pipelineId);
    if (record && isBuildPipeline(record.snapshot)) {
      this.ctx.transcriptCheckpoints.forget(record.snapshot.sessions);
    }
    this.ctx.supervisor?.forget(pipelineId);
    this.ctx.reviewerPollGate.clearPrefix(`${pipelineId}\0`);
    this.ctx.lastProviderAgent.delete(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return;
    const removed = record.snapshot;
    // Providers are keyed by environment and agent, so a sibling pipeline in
    // the same environment shares this one. Disposing it there would tear down
    // the OpenCode request monitor out from under a build that is still running.
    // A pipeline whose steps chose different harnesses holds one provider per
    // harness, so every one of them has to be checked, not just its build agent.
    const providerKeys = new Set(
      [...pipelineAgents(removed)].map((agent) => `${removed.environmentId}:${agent}`),
    );
    for (const candidate of await this.ctx.storage.listAllBuildPipelines()) {
      if (candidate.id === pipelineId || !isBuildPipeline(candidate.snapshot)) {
        continue;
      }
      for (const agent of pipelineAgents(candidate.snapshot)) {
        providerKeys.delete(`${candidate.snapshot.environmentId}:${agent}`);
      }
    }
    for (const providerKey of providerKeys) {
      const provider = this.ctx.providers.get(providerKey);
      this.ctx.providers.delete(providerKey);
      await provider?.dispose?.();
    }
  }

  /**
   * Deletes a pipeline whose newest code rewind is still pending, skipping
   * `cancel`: cancel would first finish the reset, and a reset that cannot run
   * (the container is gone, or the branch moved since the rewind was
   * previewed) would then block the delete for good. Nothing is left to
   * cancel, because admitting the rewind required an idle pipeline and no
   * agent starts until the reset finishes. The pipeline lock keeps the
   * supervisor from finishing the reset while, or after, the record goes.
   *
   * Returns the record as it stood under the lock; `deleted` is false when the
   * reset finished first, and the caller then removes the pipeline as usual.
   */
  private async deleteWithPendingCodeRewind(
    pipelineId: string,
  ): Promise<{ deleted: boolean; record: PersistedBuildPipeline | null }> {
    return this.ctx.withLock(pipelineId, async () => {
      const record = await this.ctx.storage.getBuildPipeline(pipelineId);
      if (!record || !isBuildPipeline(record.snapshot) || !hasPendingCodeRewind(record.snapshot)) {
        return { deleted: false, record };
      }
      await this.ctx.storage.deleteBuildPipeline(pipelineId);
      // Update the ticket without terminal reconciliation, which saves the
      // pipeline and must never run after its record has been deleted.
      try {
        await this.recovery.updateKanbanLifecycle(
          record.snapshot,
          buildPipelineKanbanUpdate("failed"),
          { terminal: true },
        );
      } catch {
        activityLog.warn("job.failed", { scope: "deleted-pipeline-kanban-update" });
      }
      return { deleted: true, record };
    });
  }

  async retryCompletionComment(pipelineId: string): Promise<BuildPipeline> {
    await this.ctx.mutate(pipelineId, (candidate) => {
      delete candidate.completionCommentStatus;
      delete candidate.completionCommentError;
    });
    await this.stageSupervisor.runLocked(pipelineId);
    const record = await this.ctx.requireRecord(pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    if (pipeline.completionCommentStatus === "failed") {
      throw new Error(pipeline.completionCommentError ?? "Failed to post completion comment");
    }
    return pipeline;
  }
}

/** Whether the newest rewind journaled a code reset that has not run yet. */
function hasPendingCodeRewind(pipeline: BuildPipeline): boolean {
  return pipeline.rewinds?.at(-1)?.code?.pending === true;
}
