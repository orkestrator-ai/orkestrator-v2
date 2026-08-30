import { randomUUID } from "node:crypto";
import type {
  BuildPipeline,
  BuildPipelineAgent,
  PipelineSession,
  PipelineSessionPhase,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import {
  isBuildPipeline,
  isActiveBuildPhase,
  isStartBuildPipelineInput,
  usesReviewFanout,
  MAX_PIPELINE_USER_MESSAGES,
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewContractValidationError } from "@orkestrator/protocol/structured-review";
import type { Environment, PersistedBuildPipeline } from "./models.js";
import type { StorageService } from "./storage.js";
import {
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderDependencies,
  type ProviderInteractionObservationEvent,
  ProviderUnavailableError,
} from "./build-pipeline-provider.js";
import {
  errorMessage,
  buildAdmissionKey,
  sessionForCurrentPhase,
  resumablePhase,
  sessionAgent,
  pipelineAgents,
  normalizeReviewers,
  normalizeSteps,
  sessionPhaseFor,
  resumePromptFor,
  discardSessionReviewReports,
  DEFAULT_RECONNECT_DEADLINE_MS,
  DEFAULT_STRUCTURED_RESULT_DEADLINE_MS,
  DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS,
  withUnattendedPolicy,
} from "./build-pipeline-service-helpers.js";
import type { CommandInvoker } from "./build-pipeline-service-helpers.js";

export abstract class BuildPipelineServiceBase {
  protected timer: ReturnType<typeof setInterval> | null = null;
  protected readonly locks = new Map<string, Promise<void>>();
  protected readonly providers = new Map<string, BuildPipelineProvider>();
  /**
   * The harness whose provider each pipeline last resolved.
   *
   * A stage transition resolves and caches the *next* step's provider before it
   * records that step's session, so a failure there cannot be attributed by
   * reading the stored snapshot — it still describes the previous stage. Passes
   * are serialised per pipeline by {@link runLocked}, so the last agent handed
   * to {@link provider} is the one that failed.
   */
  protected readonly lastProviderAgent = new Map<string, BuildPipelineAgent>();
  protected readonly provisioningPrompts = new Map<string, string | undefined>();
  /** Fences provider responses across backend processes sharing one journal. */
  protected readonly interactionOwnerId = randomUUID();
  protected tickPromise: Promise<void> | null = null;
  protected tickRequested = false;
  protected stopped = false;

  protected abstract save(
    pipeline: BuildPipeline,
    expectedRevision: number,
  ): Promise<PersistedBuildPipeline>;
  protected abstract bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
  ): Promise<BridgeConnection>;
  protected abstract recordReconnect(
    pipelineId: string,
    error: ProviderUnavailableError,
  ): Promise<void>;
  protected abstract fail(pipelineId: string, error: unknown): Promise<void>;
  protected abstract configureEnvironment(pipeline: BuildPipeline): Promise<void>;
  protected abstract enforcePendingInteraction(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<boolean>;
  protected abstract finishVerification(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void>;
  protected abstract finishPullRequest(pipeline: BuildPipeline): Promise<void>;
  protected abstract finishConflictResolution(pipeline: BuildPipeline): Promise<void>;
  protected abstract updateKanbanLifecycle(
    pipeline: BuildPipeline,
    updates: {
      status?: "backlog" | "in-progress" | "review";
      comment?: string;
      prUrl?: string;
      prState?: "open" | "merged" | "closed";
    },
  ): Promise<void>;
  protected abstract stepSettings(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
  ): Promise<{ agent: BuildPipelineAgent; model?: string; effort?: string }>;
  protected abstract awaitStructuredResult(
    pipeline: BuildPipeline,
    session: PipelineSession,
    label: string,
  ): Promise<void>;
  protected abstract repairStructuredReport(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
    error: ReviewContractValidationError,
  ): Promise<void>;

  constructor(
    protected readonly storage: StorageService,
    protected readonly invoke: CommandInvoker,
    protected readonly options: {
      autoAdvance?: boolean;
      provider?: (
        pipeline: BuildPipeline,
        agent: BuildPipelineAgent,
      ) => Promise<BuildPipelineProvider>;
      reconnectDeadlineMs?: number;
      structuredResultDeadlineMs?: number;
      transcriptPersistIntervalMs?: number;
      onInteractionObservation?: (
        event: ProviderInteractionObservationEvent & {
          environmentId: string;
          provider: BuildPipelineAgent;
        },
      ) => void | Promise<void>;
      /** Narrow production-provider seam used by deterministic backend tests. */
      providerDependencies?: Pick<ProviderDependencies, "openCodeClient" | "monitorRetryMs">;
    } = {},
  ) {}

  protected get reconnectDeadlineMs(): number {
    return this.options.reconnectDeadlineMs ?? DEFAULT_RECONNECT_DEADLINE_MS;
  }

  protected get structuredResultDeadlineMs(): number {
    return this.options.structuredResultDeadlineMs ?? DEFAULT_STRUCTURED_RESULT_DEADLINE_MS;
  }

  protected get transcriptPersistIntervalMs(): number {
    return this.options.transcriptPersistIntervalMs ?? DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS;
  }

  async init(): Promise<void> {
    this.stopped = false;
    const terminalReconciliations: Promise<void>[] = [];
    for (const record of await this.storage.listAllBuildPipelines()) {
      if (!record.snapshot || typeof record.snapshot !== "object") continue;
      const normalized = {
        ...record.snapshot,
        controller: "backend" as const,
        backendRevision: record.revision,
      };
      if (!isBuildPipeline(normalized)) continue;
      const pipeline = normalized;
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
          await this.save(pipeline, record.revision);
        } catch (error) {
          console.warn(
            `[build-pipeline] Skipped restoring pipeline ${pipeline.id}:`,
            errorMessage(error),
          );
          continue;
        }
      }
      if (this.needsTerminalReconciliation(pipeline)) {
        terminalReconciliations.push(this.runLocked(pipeline.id));
      }
    }
    await this.finishDurablyRecordedInteractionJournalEntries();
    if (this.options.autoAdvance !== false) {
      this.timer ??= setInterval(() => {
        void this.requestTick();
      }, 1_500);
      this.timer.unref?.();
      void this.requestTick();
    }
    await Promise.all(terminalReconciliations);
  }

  /**
   * Close the narrow crash window after the workflow snapshot committed but
   * before its journal entry advanced to `workflow-recorded`.
   */
  protected async finishDurablyRecordedInteractionJournalEntries(): Promise<void> {
    const records = await this.storage.listAllBuildPipelines();
    const pipelines = new Map(
      records
        .filter((record) => isBuildPipeline(record.snapshot))
        .map((record) => [record.id, record.snapshot as BuildPipeline]),
    );
    await this.storage.updateAgentInteractionResolutionJournal((journal) => ({
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
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tickRequested = false;
    if (this.tickPromise) {
      await this.tickPromise;
    }
    while (this.locks.size > 0) {
      await Promise.allSettled(this.locks.values());
    }
    await Promise.allSettled(
      [...this.providers.values()].map(async (provider) => {
        const disposable = provider as BuildPipelineProvider & {
          dispose?: () => void | Promise<void>;
        };
        await disposable.dispose?.();
      }),
    );
    this.providers.clear();
    this.provisioningPrompts.clear();
    this.lastProviderAgent.clear();
  }

  async start(input: StartBuildPipelineInput): Promise<BuildPipeline> {
    if (!isStartBuildPipelineInput(input)) {
      throw new Error("Invalid build pipeline start request");
    }
    let existingEnvironment: Environment | null = null;
    const existingEnvironmentId = input.existingEnvironmentId?.trim() ?? "";
    if (existingEnvironmentId) {
      existingEnvironment = await this.storage.getEnvironment(existingEnvironmentId);
      if (
        !existingEnvironment ||
        existingEnvironment.projectId !== input.projectId ||
        existingEnvironment.deletionRequestedAt
      ) {
        throw new Error("The selected build environment does not belong to this project");
      }
    }
    const steps = normalizeSteps(input.steps);
    const reviewers = normalizeReviewers(input.reviewers);
    const pipeline: BuildPipeline = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: existingEnvironmentId,
      environmentType: existingEnvironment?.environmentType ?? input.environmentType,
      // The build step's harness is the pipeline's agent: it is what the
      // environment default is configured for and what every stage without its
      // own configuration falls back to.
      agentType: steps?.build?.agent ?? input.agentType,
      ...(steps ? { steps } : {}),
      ...(reviewers ? { reviewers } : {}),
      ...(input.environmentOptions ? { environmentOptions: input.environmentOptions } : {}),
      phase: existingEnvironment ? "starting-environment" : "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: input.maxIterations ?? 3,
      createdAt: new Date().toISOString(),
      taskTitle: input.taskTitle,
      taskSnapshot: input.taskSnapshot,
      source: input.source,
      featurePlanId: input.featurePlanId?.trim() || undefined,
      admissionKey: buildAdmissionKey(input),
      backendRevision: 0,
      controller: "backend",
    };
    if (!existingEnvironment) {
      // Installed before the reservation becomes visible to timer ticks.
      this.provisioningPrompts.set(pipeline.id, input.namingPrompt);
    }
    try {
      const admitted = await this.save(pipeline, 0);
      if (admitted.id !== pipeline.id) {
        this.provisioningPrompts.delete(pipeline.id);
        const existing = admitted.snapshot;
        if (!isBuildPipeline(existing)) {
          throw new Error("Existing build pipeline admission is invalid");
        }
        // Admission is intentionally idempotent, including after a previous
        // caller completed provisioning but failed while publishing the pane
        // layout. Repair that last step before reporting success again. A
        // concurrent winner that has only persisted its initial reservation
        // does not have an environment to attach yet; that winner still owns
        // the provisioning pass and will materialize the tab before it returns.
        if (existing.environmentId && existing.sourceLinkedAt) {
          await this.storage.ensureBuildPipelineTab({
            pipelineId: existing.id,
            taskId: existing.taskId,
            environmentId: existing.environmentId,
            isLocal: existing.environmentType === "local",
          });
          if (this.options.autoAdvance !== false) void this.runLocked(existing.id);
        }
        return existing;
      }
    } catch (error) {
      this.provisioningPrompts.delete(pipeline.id);
      throw error;
    }
    // Provisioning is performed by the same per-pipeline supervisor lock used
    // by timer ticks. A tick that observes the just-persisted reservation joins
    // this pass instead of racing a second create_environment call.
    // For an existing environment the first pass only commits source linkage;
    // for a new environment it provisions exactly once. In both cases a timer
    // tick joins this same lock, so it cannot race the start response's write.
    await this.runLocked(pipeline.id, input.namingPrompt);
    let startedRecord = await this.requireRecord(pipeline.id);
    let started = startedRecord.snapshot as BuildPipeline;
    if (started.phase === "failed") {
      throw new Error(started.error ?? "Failed to start build pipeline");
    }
    if (!started.sourceLinkedAt) {
      // A newly provisioned environment is associated in the first pass and
      // source-linked in this second pass. It must also use runLocked: a timer
      // can observe the association save before start() resumes, and both
      // callers must join one CAS write rather than racing ensureSourceLink.
      await this.runLocked(pipeline.id);
      startedRecord = await this.requireRecord(pipeline.id);
      started = startedRecord.snapshot as BuildPipeline;
      if (started.phase === "failed") {
        throw new Error(started.error ?? "Failed to link build pipeline source");
      }
    }
    await this.storage.ensureBuildPipelineTab({
      pipelineId: started.id,
      taskId: started.taskId,
      environmentId: started.environmentId,
      isLocal: started.environmentType === "local",
    });
    if (this.options.autoAdvance !== false) void this.runLocked(pipeline.id);
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
      const normalized = {
        ...snapshot,
        controller: "backend",
        backendRevision: 0,
      };
      if (!isBuildPipeline(normalized) || normalized.projectId !== projectId) {
        skipped += 1;
        continue;
      }
      if (await this.storage.getBuildPipeline(normalized.id)) {
        skipped += 1;
        continue;
      }
      if (normalized.environmentId) {
        const environment = await this.storage.getEnvironment(normalized.environmentId);
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
      const admitted = await this.save(normalized, 0);
      if (admitted.id !== normalized.id) {
        skipped += 1;
        continue;
      }
      importedIds.push(normalized.id);
      if (isActiveBuildPhase(normalized.phase) && this.options.autoAdvance !== false) {
        void this.runLocked(normalized.id);
      }
    }
    return { importedIds, skipped };
  }

  /** Immediate supervisor pass, also useful for deterministic backend tests. */
  advanceNow(pipelineId: string): Promise<void> {
    return this.runLocked(pipelineId);
  }

  async pause(pipelineId: string): Promise<BuildPipeline> {
    let abortErrors: unknown[] = [];
    const pipeline = await this.mutate(pipelineId, async (pipeline) => {
      const previous = resumablePhase(pipeline.phase);
      if (!previous) return;
      pipeline.pausedFromPhase = previous;
      pipeline.phase = "paused";
      // The warning says the stage "is still running"; a paused build has
      // stopped, and `advance` returns early for non-active phases so nothing
      // else would ever clear it.
      delete pipeline.stallWarning;
      if (pipeline.reviewFanout) {
        abortErrors = await this.abandonReviewFanout(pipeline, "idle");
      } else {
        const session = sessionForCurrentPhase(pipeline);
        if (session?.status !== "running") return;
        try {
          const provider = await this.provider(pipeline, sessionAgent(pipeline, session));
          await provider.abort(session.sdkSessionId);
          session.status = "idle";
        } catch (error) {
          abortErrors = [error];
        }
      }
      if (abortErrors.length > 0) {
        pipeline.error = `Build paused, but stopping every agent could not be confirmed: ${abortErrors.map(errorMessage).join("; ")}`;
      }
    });
    if (abortErrors.length > 0) throw abortErrors[0];
    return pipeline;
  }

  async resume(pipelineId: string): Promise<BuildPipeline> {
    const pipeline = await this.mutate(pipelineId, (candidate) => {
      if (candidate.phase !== "paused") return;
      const phase = candidate.pausedFromPhase ?? "building";
      candidate.phase = phase;
      delete candidate.pausedFromPhase;
      delete candidate.error;
      // Multi-model review resumes by opening a fresh panel. There is no one
      // reviewer session a generic resume prompt could safely target.
      if (phase === "reviewing" && usesReviewFanout(candidate)) {
        candidate.reviewRetryRequested = true;
        if (!candidate.reviewPackage) {
          discardSessionReviewReports(candidate);
          delete candidate.structuredReview;
          delete candidate.structuredReviewRequestId;
        }
        return;
      }
      const session = sessionForCurrentPhase(candidate);
      const resumePrompt = resumePromptFor(phase);
      const prompt = resumePrompt ? withUnattendedPolicy(resumePrompt) : null;
      if (prompt && session?.status === "idle" && session.phase === sessionPhaseFor(phase)) {
        const requestId = randomUUID();
        const startedAt = new Date().toISOString();
        const structuredReview = phase === "reviewing" || phase === "verifying";
        candidate.pendingPromptAttempt = {
          id: randomUUID(),
          sessionId: session.sdkSessionId,
          requestId,
          phase,
          prompt,
          useTaskImages: false,
          structuredReview,
          startedAt,
        };
        session.turnStartedAt = startedAt;
        delete candidate.stallWarning;
        candidate.activePromptContext = {
          phase,
          kind: "prompt-dispatch",
          sessionId: session.sdkSessionId,
          requestId,
          prompt,
          useTaskImages: false,
          structuredReview,
        };
        session.structuredRequestId = structuredReview ? requestId : undefined;
        session.structuredResultStatus = structuredReview ? "pending" : undefined;
        if (phase === "reviewing") {
          candidate.structuredReviewRequestId = requestId;
          delete candidate.structuredReview;
        }
      }
    });
    void this.runLocked(pipelineId);
    return pipeline;
  }

  /**
   * Queues a user message for the pipeline's current agent session.
   *
   * The message is durable rather than sent straight through: the agent is
   * usually mid-turn, the tab that composed it may be unmounted before the turn
   * ends, and a pause can sit between composing and dispatch. The supervisor
   * delivers it on the next idle tick, one at a time, through the same
   * at-most-once attempt record every other prompt uses.
   */
  async sendMessage(pipelineId: string, text: string): Promise<BuildPipeline> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Message must not be blank");
    if (trimmed.length > MAX_PIPELINE_USER_MESSAGE_LENGTH) {
      throw new Error(`Message exceeds the ${MAX_PIPELINE_USER_MESSAGE_LENGTH} character limit`);
    }
    let rejection: Error | undefined;
    const pipeline = await this.mutate(pipelineId, (candidate) => {
      if (candidate.phase === "complete" || candidate.phase === "failed") {
        rejection = new Error("This build has finished");
        return;
      }
      if (
        usesReviewFanout(candidate) &&
        (candidate.phase === "reviewing" ||
          (candidate.phase === "paused" && candidate.pausedFromPhase === "reviewing"))
      ) {
        rejection = new Error("Messages cannot be sent during a multi-model review");
        return;
      }
      const queue = candidate.pendingUserMessages ?? [];
      if (queue.length >= MAX_PIPELINE_USER_MESSAGES) {
        rejection = new Error(`Only ${MAX_PIPELINE_USER_MESSAGES} queued messages are allowed`);
        return;
      }
      candidate.pendingUserMessages = [
        ...queue,
        {
          id: randomUUID(),
          text: trimmed,
          createdAt: new Date().toISOString(),
        },
      ];
    });
    if (rejection) throw rejection;
    void this.runLocked(pipelineId);
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
    await this.mutate(pipelineId, (candidate) => {
      if (candidate.phase === "complete") {
        rejection = new Error("This build has already completed");
        return;
      }
      if (!candidate.environmentId || candidate.sessions.length === 0) {
        rejection = new Error("This build has not reached its review stage yet");
        return;
      }
      candidate.reviewRetryRequested = true;
      discardSessionReviewReports(candidate);
      delete candidate.reviewPackage;
      delete candidate.structuredReview;
      delete candidate.structuredReviewRequestId;
      delete candidate.verificationResult;
      delete candidate.verificationFeedback;
      if (candidate.phase === "failed" || candidate.phase === "paused") {
        // A retry is an explicit instruction to keep going, so revive the
        // pipeline; the requested review starts on the next supervisor pass.
        candidate.phase = candidate.pausedFromPhase ?? "reviewing";
        delete candidate.pausedFromPhase;
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
    await this.runLocked(pipelineId);
    return (await this.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  /** Starts a fresh attempt for the non-interactive stage that failed. */
  async retryStage(pipelineId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.mutate(pipelineId, (candidate) => {
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
      if (failedSession && failedSession.sdkSessionId === candidate.failureContext.sessionId) {
        failedSession.status = "error";
      }
      delete candidate.error;
      delete candidate.failureContext;
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
    await this.runLocked(pipelineId);
    return (await this.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  async retryInteractionFailure(pipelineId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.mutate(pipelineId, (candidate) => {
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
      delete candidate.pendingInteractionResolution;
      delete candidate.completionCommentStatus;
      delete candidate.completionCommentError;
    });
    if (rejection) throw rejection;
    await this.runLocked(pipelineId);
    return (await this.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  async cancel(pipelineId: string): Promise<BuildPipeline> {
    let abortErrors: unknown[] = [];
    const pipeline = await this.mutate(pipelineId, async (pipeline) => {
      if (pipeline.reviewFanout) {
        abortErrors = await this.abandonReviewFanout(pipeline, "idle");
      } else {
        const session = sessionForCurrentPhase(pipeline);
        if (session?.status === "running" && pipeline.environmentId) {
          try {
            await (
              await this.provider(pipeline, sessionAgent(pipeline, session))
            ).abort(session.sdkSessionId);
            session.status = "idle";
          } catch (error) {
            abortErrors = [error];
          }
        }
      }
      pipeline.phase = "failed";
      pipeline.error =
        abortErrors.length > 0
          ? `Build cancelled, but stopping every agent could not be confirmed: ${abortErrors.map(errorMessage).join("; ")}`
          : "Build cancelled";
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
    this.lastProviderAgent.delete(pipelineId);
    await this.reconcileTerminalState(pipeline);
    if (abortErrors.length > 0) throw abortErrors[0];
    return pipeline;
  }

  /** Stops every provider turn owned by a live multi-model review. */
  protected async abandonReviewFanout(
    pipeline: BuildPipeline,
    sessionStatus: "idle" | "error",
  ): Promise<unknown[]> {
    const fanout = pipeline.reviewFanout;
    if (!fanout) return [];
    const now = new Date().toISOString();
    const targets: Array<{ agent: BuildPipelineAgent; sessionId: string }> = [];
    for (const reviewer of fanout.reviewers) {
      if (
        reviewer.status !== "pending" &&
        reviewer.status !== "running" &&
        reviewer.status !== "cancelled"
      ) {
        continue;
      }
      reviewer.status = "cancelled";
      reviewer.completedAt = now;
      delete reviewer.stalledSince;
      delete reviewer.idleResultPolls;
      if (reviewer.providerSessionId) {
        targets.push({
          agent: reviewer.agent as BuildPipelineAgent,
          sessionId: reviewer.providerSessionId,
        });
      }
    }
    if (fanout.consolidation && !fanout.report) {
      targets.push({
        agent: fanout.consolidation.agent as BuildPipelineAgent,
        sessionId: fanout.consolidation.providerSessionId,
      });
    }
    const fanoutOwnsCurrentSession =
      pipeline.phase === "reviewing" ||
      (pipeline.phase === "paused" && pipeline.pausedFromPhase === "reviewing");
    const currentSession = sessionForCurrentPhase(pipeline);
    if (!fanoutOwnsCurrentSession && currentSession?.status === "running") {
      targets.push({
        agent: sessionAgent(pipeline, currentSession),
        sessionId: currentSession.sdkSessionId,
      });
    }
    const uniqueTargets = Array.from(
      new Map(targets.map((target) => [target.sessionId, target])).values(),
    );
    const mirroredSessionIds = new Set(
      fanout.reviewers.flatMap((reviewer) =>
        reviewer.providerSessionId ? [reviewer.providerSessionId] : [],
      ),
    );
    if (fanout.consolidation) mirroredSessionIds.add(fanout.consolidation.providerSessionId);
    for (const target of uniqueTargets) mirroredSessionIds.add(target.sessionId);
    for (const sessionId of mirroredSessionIds) {
      const session = pipeline.sessions.find((candidate) => candidate.sdkSessionId === sessionId);
      if (session?.status === "running") session.status = sessionStatus;
    }
    const results = await Promise.allSettled(
      uniqueTargets.map(async ({ agent, sessionId }) => {
        await (await this.provider(pipeline, agent)).abort(sessionId);
      }),
    );
    return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  }

  async remove(pipelineId: string): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (
      record &&
      isBuildPipeline(record.snapshot) &&
      (isActiveBuildPhase(record.snapshot.phase) || record.snapshot.reviewFanout !== undefined)
    ) {
      await this.cancel(pipelineId);
    }
    await this.storage.deleteBuildPipeline(pipelineId);
    this.lastProviderAgent.delete(pipelineId);
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
    for (const candidate of await this.storage.listAllBuildPipelines()) {
      if (candidate.id === pipelineId || !isBuildPipeline(candidate.snapshot)) {
        continue;
      }
      for (const agent of pipelineAgents(candidate.snapshot)) {
        providerKeys.delete(`${candidate.snapshot.environmentId}:${agent}`);
      }
    }
    for (const providerKey of providerKeys) {
      const provider = this.providers.get(providerKey);
      this.providers.delete(providerKey);
      await provider?.dispose?.();
    }
  }

  async retryCompletionComment(pipelineId: string): Promise<BuildPipeline> {
    await this.mutate(pipelineId, (candidate) => {
      delete candidate.completionCommentStatus;
      delete candidate.completionCommentError;
    });
    await this.runLocked(pipelineId);
    const record = await this.requireRecord(pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    if (pipeline.completionCommentStatus === "failed") {
      throw new Error(pipeline.completionCommentError ?? "Failed to post completion comment");
    }
    return pipeline;
  }

  protected abstract requestTick(): Promise<void>;
  protected abstract runLocked(pipelineId: string, namingPrompt?: string): Promise<void>;
  protected abstract mutate(
    pipelineId: string,
    mutation: (pipeline: BuildPipeline) => void | Promise<void>,
  ): Promise<BuildPipeline>;
  protected abstract requireRecord(pipelineId: string): Promise<PersistedBuildPipeline>;
  protected abstract provider(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent,
  ): Promise<BuildPipelineProvider>;
  protected abstract needsTerminalReconciliation(pipeline: BuildPipeline): boolean;
  protected abstract reconcileTerminalState(pipeline: BuildPipeline): Promise<void>;
}
