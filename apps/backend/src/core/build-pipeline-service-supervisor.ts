import { randomUUID } from "node:crypto";
import type {
  BuildPipeline,
  BuildPipelineAgent,
  PipelineSession,
  PipelineSessionPhase,
  ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  executionModeForSessionPhase,
  isBuildPipeline,
  isActiveBuildPhase,
  usesReviewFanout,
} from "@orkestrator/protocol/build-pipeline";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  safeParseStructuredReviewReport,
  stripStructuredReviewProvenance,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type { Environment } from "./models.js";
import {
  AmbiguousPromptDispatchError,
  ProviderUnavailableError,
  readProviderStatus,
  type BuildPipelineProvider,
  type ProviderExecutionMode,
} from "./build-pipeline-provider.js";
import {
  addressPrompt,
  buildPipelineReviewPackageContext,
  buildPipelineReviewPackageId,
  buildPrompt,
  fixPrompt,
  prPrompt,
  resolveConflictsPrompt,
  reviewPackagePreparationPrompt,
  verificationPrompt,
  type ObservedWorktreeSnapshot,
  type ReviewWorktreeSnapshot,
} from "./build-pipeline-prompts.js";
import { buildReviewHandoffPrompt, prependReviewHandoff } from "./build-pipeline-handoff.js";
import {
  BuildPipelineReviewFanout,
  type ReviewFanoutStep,
} from "./build-pipeline-review-fanout.js";
import { MultiReviewProgressTracker } from "./multi-review-progress.js";
import { probeReviewWorktreeOnce } from "./review-worktree-probe.js";
import {
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  createDiscoveryPrompt,
  parseReviewPreparationResult,
} from "./looped-review-prompts.js";
import { normalizeGeneratedReviewPackage } from "./review-package.js";
import { BuildPipelineServiceBase } from "./build-pipeline-service-base.js";
import {
  WORKTREE_PROBE_ATTEMPTS,
  VALIDATION_STAGE_LABELS,
  VERIFICATION_SCHEMA,
  SESSION_LABELS,
  PreSessionStageStartError,
  sessionForCurrentPhase,
  resumablePhase,
  sessionAgent,
  sessionPhaseFor,
  executionModeOverrideForPhase,
  DEFAULT_STALL_WARNING_MS,
  withUnattendedPolicy,
  transcriptFingerprint,
  attachBeforeDispatch,
  elapsedSince,
  elapsedSinceLatest,
  discardSessionReviewReports,
} from "./build-pipeline-service-helpers.js";

export abstract class BuildPipelineServiceSupervisor extends BuildPipelineServiceBase {
  /**
   * Progress clocks for the reviewer fan-out.
   *
   * Held on the supervisor rather than per pass so a reviewer's stall baseline
   * survives between ticks; entries are dropped when a session settles, so it
   * cannot grow with pipeline history.
   */
  private readonly reviewProgress = new MultiReviewProgressTracker();
  private reviewFanoutRunner: BuildPipelineReviewFanout | null = null;

  protected reviewFanout(): BuildPipelineReviewFanout {
    if (!this.reviewFanoutRunner) {
      this.reviewFanoutRunner = new BuildPipelineReviewFanout({
        provider: (pipeline, agent) => this.provider(pipeline, agent),
        save: async (pipeline) => {
          await this.save(pipeline, pipeline.backendRevision);
        },
        stepSettings: (pipeline, sessionPhase) => this.stepSettings(pipeline, sessionPhase),
        refreshTranscript: (session, provider) => this.refreshTranscript(session, provider),
        shouldPersistTranscript: (session) => this.shouldPersistTranscript(session),
        targetBranch: async (pipeline) => {
          const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
          return repository.prBaseBranch || "main";
        },
        reviewInstruction: async () => (await this.storage.loadConfig()).global.reviewInstruction,
        progress: this.reviewProgress,
      });
    }
    return this.reviewFanoutRunner;
  }

  protected requestTick(): Promise<void> {
    if (this.tickPromise) {
      this.tickRequested = true;
      return this.tickPromise;
    }
    const operation = (async () => {
      do {
        this.tickRequested = false;
        await this.tickPass();
      } while (!this.stopped && this.tickRequested);
    })().finally(() => {
      if (this.tickPromise === operation) this.tickPromise = null;
    });
    this.tickPromise = operation;
    return operation;
  }

  protected async tickPass(): Promise<void> {
    if (this.stopped) return;
    const records = await this.storage.listAllBuildPipelines();
    await Promise.all(
      records.flatMap((record) => {
        if (
          !isBuildPipeline(record.snapshot) ||
          (!isActiveBuildPhase(record.snapshot.phase) &&
            !this.needsTerminalReconciliation(record.snapshot))
        ) {
          return [];
        }
        return [this.runLocked(record.id)];
      }),
    );
  }

  protected runLocked(pipelineId: string, namingPrompt?: string): Promise<void> {
    // Timer ticks are level-triggered. If a pass is already running, joining
    // it is sufficient; appending another promise every 1.5 seconds lets a
    // stalled provider call grow an unbounded queue.
    const existing = this.locks.get(pipelineId);
    if (existing) return existing;
    const next = this.advance(pipelineId, namingPrompt)
      .catch(async (error) => {
        if (error instanceof ProviderUnavailableError) {
          await this.recordReconnect(pipelineId, error).catch(() => undefined);
        } else {
          await this.fail(pipelineId, error).catch(() => undefined);
        }
      })
      .finally(() => {
        if (this.locks.get(pipelineId) === next) this.locks.delete(pipelineId);
      });
    this.locks.set(pipelineId, next);
    return next;
  }

  protected async advance(pipelineId: string, namingPrompt?: string): Promise<void> {
    const record = await this.requireRecord(pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    pipeline.backendRevision = record.revision;
    if (!isActiveBuildPhase(pipeline.phase)) {
      await this.reconcileTerminalState(pipeline);
      return;
    }

    if (pipeline.environmentId && !pipeline.sourceLinkedAt) {
      await this.ensureSourceLink(pipeline);
      return;
    }

    if (pipeline.phase === "creating-environment") {
      const environment =
        (await this.findLinkedEnvironment(pipeline)) ??
        (await this.invoke<Environment>("create_environment", {
          projectId: pipeline.projectId,
          // A launcher that collected a network mode wins; otherwise a
          // container is restricted, which is the app's own default, and a
          // local worktree has no firewall to apply one to.
          networkAccessMode:
            pipeline.environmentOptions?.networkAccessMode ??
            (pipeline.environmentType === "containerized" ? "restricted" : "full"),
          environmentType: pipeline.environmentType,
          buildPipelineId: pipeline.id,
          // An explicit name suppresses the rename-from-prompt path in
          // `create_environment`, so it is only sent when the user chose one.
          ...(pipeline.environmentOptions?.name?.trim()
            ? { name: pipeline.environmentOptions.name.trim() }
            : {}),
          ...(pipeline.environmentOptions?.portMappings?.length
            ? { portMappings: pipeline.environmentOptions.portMappings }
            : {}),
          namingPrompt:
            namingPrompt ?? this.provisioningPrompts.get(pipeline.id) ?? pipeline.taskTitle,
        }));
      pipeline.environmentId = environment.id;
      pipeline.environmentType = environment.environmentType;
      pipeline.phase = "starting-environment";
      await this.save(pipeline, record.revision);
      this.provisioningPrompts.delete(pipeline.id);
      return;
    }

    if (!pipeline.environmentId) {
      throw new Error("Build pipeline has no environment");
    }

    if (pipeline.phase === "starting-environment") {
      await this.configureEnvironment(pipeline);
      const environment = await this.storage.getEnvironment(pipeline.environmentId);
      if (!environment) throw new Error("Build environment no longer exists");
      if (environment.status !== "running") {
        await this.invoke("start_environment", {
          environmentId: pipeline.environmentId,
        });
      }
      pipeline.phase = "waiting-for-setup";
      await this.save(pipeline, record.revision);
      return;
    }

    if (pipeline.phase === "waiting-for-setup") {
      await this.invoke("run_environment_setup", {
        environmentId: pipeline.environmentId,
      });
      // Setup temporarily owns the active terminal tab while it installs the
      // environment. Once that work is finished, move the authoritative pane
      // selection back to the build surface before starting the first agent
      // turn. Keeping this in the backend means a renderer that was unmounted
      // during setup catches up from the persisted layout when it returns.
      await this.storage.ensureBuildPipelineTab({
        pipelineId: pipeline.id,
        taskId: pipeline.taskId,
        environmentId: pipeline.environmentId,
        isLocal: pipeline.environmentType === "local",
      });
      await this.startStage(pipeline, "build", "building");
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
        await this.abandonReviewFanout(pipeline, "idle");
        delete pipeline.reviewRetryRequested;
        discardSessionReviewReports(pipeline);
        delete pipeline.reviewFanout;
        delete pipeline.structuredReview;
        delete pipeline.structuredReviewRequestId;
        delete pipeline.verificationResult;
        delete pipeline.verificationFeedback;
        if (pipeline.reviewPackage) {
          await this.startStage(pipeline, "review", "reviewing");
        } else {
          await this.startReviewPackagePreparation(pipeline);
        }
        return;
      }
      if (!pipeline.reviewFanout) {
        if (pipeline.reviewPackage) {
          await this.startStage(pipeline, "review", "reviewing");
        } else {
          await this.startReviewPackagePreparation(pipeline);
        }
        return;
      }
      await this.advanceReviewFanout(pipeline);
      return;
    }

    const session = sessionForCurrentPhase(pipeline);
    if (!session) {
      await this.restartMissingStage(pipeline);
      return;
    }
    const currentAgent = sessionAgent(pipeline, session);
    const provider = await this.provider(pipeline, currentAgent);
    if (await this.enforcePendingInteraction(pipeline, provider, session)) {
      return;
    }
    // Read as data. A bridge that answers with a terminal turn error is
    // reachable, so this must reach both the reconnect-clearing block below —
    // otherwise a stale `reconnectAttempt` outlives the harness it accused —
    // and the `error` branch, which is the only one that fails the stage with
    // the provider's own explanation rather than an anonymous read fault.
    const { status, error: statusDetail } = await readProviderStatus(
      provider,
      session.sdkSessionId,
    );
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
      await this.save(pipeline, record.revision);
      return;
    }
    if (status === "missing") {
      throw new Error(`The ${session.label.toLowerCase()} is no longer available`);
    }
    if (status === "error") {
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
        await this.save(pipeline, record.revision);
        return;
      }
      await this.dispatchPending(pipeline, provider);
      return;
    }
    if (status === "running") {
      const transcriptChanged = await this.refreshTranscript(session, provider);
      const statusChanged = session.status !== "running";
      session.status = "running";
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
      // transcript delta is throttled: it arrives on every tick of a streaming
      // turn, and each save rewrites the entire build-pipelines file.
      if (
        statusChanged ||
        warningChanged ||
        (transcriptChanged && this.shouldPersistTranscript(session))
      ) {
        session.messagesPersistedAt = new Date().toISOString();
        await this.save(pipeline, record.revision);
      }
      return;
    }

    const wasRunning = session.status === "running";
    session.status = "idle";
    delete pipeline.stallWarning;
    const transcriptChanged = await this.refreshTranscript(session, provider);
    delete pipeline.pendingPromptAttempt;
    delete pipeline.activePromptContext;
    if (wasRunning || transcriptChanged) {
      // The turn is over, so this is the final transcript. Persist it now
      // rather than leaving the throttled tail to whichever branch runs next —
      // several of them return without saving.
      session.messagesPersistedAt = new Date().toISOString();
      await this.save(pipeline, pipeline.backendRevision);
    }

    if (pipeline.reviewRetryRequested) {
      delete pipeline.reviewRetryRequested;
      discardSessionReviewReports(pipeline);
      delete pipeline.structuredReview;
      delete pipeline.structuredReviewRequestId;
      delete pipeline.verificationResult;
      delete pipeline.verificationFeedback;
      if (pipeline.reviewPackage) {
        await this.startStage(pipeline, "review", "reviewing");
      } else {
        await this.startReviewPackagePreparation(pipeline);
      }
      return;
    }

    if (pipeline.pendingUserMessages?.length) {
      await this.dispatchUserMessage(pipeline, provider, session);
      return;
    }

    switch (pipeline.phase) {
      case "building":
      case "fixing":
        await this.finishReviewPackagePreparation(pipeline, provider, session);
        return;
      case "reviewing":
        await this.finishReview(pipeline, provider, session);
        return;
      case "addressing":
        await this.startStage(pipeline, "verify", "verifying");
        return;
      case "verifying":
        await this.finishVerification(pipeline, provider, session);
        return;
      case "creating-pr":
        await this.finishPullRequest(pipeline);
        return;
      case "resolving-conflicts":
        await this.finishConflictResolution(pipeline);
        return;
      default:
        return;
    }
  }

  /**
   * Observes the worktree a validation stage is about to run in.
   *
   * The build stage is only *asked* to commit, so a review that re-derived this
   * inside its own turn could quietly decide the tree was dirty and skip
   * validation. Probing here makes the state the pipeline's own evidence.
   *
   * The probe is one command round trip into a container or worktree and can
   * fail transiently, so it is retried a bounded number of times before the
   * caller is told the state is unknown. Retries are immediate: the supervisor
   * tick is not a place to sleep, and the failures this covers — a momentarily
   * busy daemon, a lost exec — do not need a backoff to clear. A state that is
   * still unknown afterwards is not survivable, because nothing downstream can
   * certify a turn whose starting point was never established.
   */
  protected async reviewWorktreeSnapshot(pipeline: BuildPipeline): Promise<ReviewWorktreeSnapshot> {
    let last = await this.probeWorktreeOnce(pipeline);
    for (
      let attempt = 1;
      attempt < WORKTREE_PROBE_ATTEMPTS && last.status === "unknown";
      attempt += 1
    ) {
      last = await this.probeWorktreeOnce(pipeline);
    }
    return last;
  }

  protected async probeWorktreeOnce(pipeline: BuildPipeline): Promise<ReviewWorktreeSnapshot> {
    return probeReviewWorktreeOnce(
      (command, args) => this.invoke(command, args),
      pipeline.environmentId,
    );
  }

  /**
   * Establishes the baseline a validation stage will later be certified against.
   *
   * A dirty start is not a failure. The build stage is only *asked* to commit,
   * the reviewer is told which paths were left behind, and the guard below cares
   * about what validation itself changed rather than where it began. Only a
   * state the backend could not observe at all is fatal, and it is fatal *here*
   * — before the turn is dispatched — because a stage that can never be
   * certified is not worth an agent turn, and failing after the fact would
   * discard a completed review and report it as a Git error.
   */
  protected async validationBaseline(
    pipeline: BuildPipeline,
    sessionPhase: "review" | "verify",
  ): Promise<ObservedWorktreeSnapshot> {
    const snapshot = await this.reviewWorktreeSnapshot(pipeline);
    if (snapshot.status === "unknown") {
      throw new Error(
        `${VALIDATION_STAGE_LABELS[sessionPhase]} cannot start because the backend could not establish the environment Git state: ${snapshot.reason}`,
      );
    }
    return snapshot;
  }

  /**
   * Rejects a validation turn that changed the workspace rather than only
   * reading it and writing ignored output.
   *
   * Scope is exactly what `git status --porcelain` reports plus HEAD: tracked
   * paths, and untracked paths Git does not ignore. It deliberately does *not*
   * cover ignored files, anything under `.git/`, or paths outside the worktree —
   * writes there are invisible to this check, so the disclosure the launcher
   * shows and the prompts' own instructions have to claim no more than this.
   *
   * The comparison is against the baseline path set, not against cleanliness, so
   * uncommitted work the build stage left behind survives review instead of
   * failing the pipeline after the fact.
   */
  protected async assertValidationWorktreeUnchanged(
    pipeline: BuildPipeline,
    session: PipelineSession,
  ): Promise<void> {
    const stage = VALIDATION_STAGE_LABELS[session.phase === "review" ? "review" : "verify"];
    // A snapshot written before the path list existed still carries a status, and
    // "clean" pins the baseline to the empty set without it. "dirty" does not,
    // so that one case still fails closed rather than guessing.
    const baselinePaths =
      session.validationUncommittedPathsAtStart ??
      (session.validationWorktreeStatusAtStart === "clean" ? [] : undefined);
    if (!session.validationHeadAtStart || !baselinePaths) {
      throw new Error(
        `${stage} cannot be certified because its starting Git state was not recorded`,
      );
    }
    const current = await this.reviewWorktreeSnapshot(pipeline);
    if (current.status === "unknown") {
      throw new Error(
        `${stage} cannot be certified because the backend could not verify Git state after validation: ${current.reason}`,
      );
    }
    if (current.head !== session.validationHeadAtStart) {
      throw new Error(
        `${stage} cannot be certified because validation changed the environment HEAD`,
      );
    }
    const before = new Set(baselinePaths);
    const currentPaths = current.status === "dirty" ? current.paths : [];
    const after = new Set(currentPaths);
    const added = currentPaths.filter((path) => !before.has(path));
    if (added.length) {
      throw new Error(
        `${stage} cannot be certified because validation left ${added.length} uncommitted ${added.length === 1 ? "path that was" : "paths that were"} not there when it started`,
      );
    }
    // Removal matters as much as addition: deleting a path the build stage left
    // uncommitted destroys work that no commit is holding.
    const removed = baselinePaths.filter((path) => !after.has(path));
    if (removed.length) {
      throw new Error(
        `${stage} cannot be certified because validation removed ${removed.length} uncommitted ${removed.length === 1 ? "path that was" : "paths that were"} there when it started`,
      );
    }
  }

  /**
   * Accepts the build model's preparation metadata, then has the backend create
   * the single immutable package every reviewer will read.
   *
   * Legacy in-flight build sessions have no structured key. They receive one
   * preparation-only follow-up in the same session, preserving the model and
   * its implementation context across an upgrade.
   */
  protected async finishReviewPackagePreparation(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    const targetBranch = repository.prBaseBranch || "main";
    if (!session.structuredRequestId) {
      const requestId = randomUUID();
      const startedAt = new Date().toISOString();
      const prompt = withUnattendedPolicy(reviewPackagePreparationPrompt(pipeline, targetBranch));
      session.structuredRequestId = requestId;
      session.structuredResultStatus = "pending";
      session.turnStartedAt = startedAt;
      pipeline.pendingPromptAttempt = {
        id: randomUUID(),
        sessionId: session.sdkSessionId,
        requestId,
        phase: pipeline.phase as "building" | "fixing",
        prompt,
        useTaskImages: false,
        structuredReview: true,
        startedAt,
      };
      await this.save(pipeline, pipeline.backendRevision);
      await this.dispatchPending(pipeline, provider);
      return;
    }
    const result = await provider.structured<unknown>(
      session.sdkSessionId,
      session.structuredRequestId,
    );
    if (!result) {
      await this.awaitStructuredResult(pipeline, session, "review package preparation");
      return;
    }
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    const preparation = parseReviewPreparationResult(result.value);
    const packageId = buildPipelineReviewPackageId(pipeline);
    const round = pipeline.iteration + 1;
    const generated = await this.invoke<unknown>("generate_looped_review_package", {
      environmentId: pipeline.environmentId,
      packageId,
      round,
      targetBranch,
      preparation,
    });
    const notes = (await this.storage.getProjectNotes(pipeline.projectId)).content;
    const boundedContext = buildPipelineReviewPackageContext(pipeline, notes);
    pipeline.reviewPackage = normalizeGeneratedReviewPackage(generated, {
      id: packageId,
      round,
      targetBranch,
      context: boundedContext.context,
      additionalLimitations: boundedContext.limitations,
    });
    session.structuredResultStatus = "accepted";
    await this.startStage(pipeline, "review", "reviewing");
  }

  protected async findLinkedEnvironment(
    pipeline: Pick<BuildPipeline, "id" | "projectId">,
  ): Promise<Environment | undefined> {
    return (await this.storage.getEnvironmentsByProject(pipeline.projectId)).find(
      (environment) =>
        environment.buildPipelineId === pipeline.id && !environment.deletionRequestedAt,
    );
  }

  protected async refreshTranscript(
    session: PipelineSession,
    provider: BuildPipelineProvider,
  ): Promise<boolean> {
    const messages = await provider.messages(session.sdkSessionId);
    const fingerprint = transcriptFingerprint(messages);
    // A snapshot restored before fingerprints existed has none, so fall back to
    // recomputing it from the stored transcript exactly once.
    const previous =
      session.messagesFingerprint ??
      (session.messages === undefined ? undefined : transcriptFingerprint(session.messages));
    if (previous === fingerprint) return false;
    session.messages = messages;
    session.messagesFingerprint = fingerprint;
    session.messageRevision = (session.messageRevision ?? 0) + 1;
    return true;
  }

  protected shouldPersistTranscript(session: PipelineSession): boolean {
    const elapsed = elapsedSince(session.messagesPersistedAt);
    return elapsed === null || elapsed >= this.transcriptPersistIntervalMs;
  }

  /**
   * Dispatches the oldest queued user message into the current session.
   *
   * The message moves out of the queue and into the durable prompt attempt
   * before anything is sent, so a dispatch whose response is lost is retried by
   * the normal pending-attempt path under the same request id rather than being
   * either dropped or delivered twice.
   */
  protected async dispatchUserMessage(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const [next, ...rest] = pipeline.pendingUserMessages ?? [];
    if (!next) return;
    const phase = resumablePhase(pipeline.phase);
    if (!phase) return;
    if (phase === "building" || phase === "fixing") {
      // Any implementation follow-up can change HEAD, validation artifacts, or
      // the uncommitted set. The earlier structured preparation result no
      // longer describes the state that will be packaged after this turn.
      delete session.structuredRequestId;
      delete session.structuredResultStatus;
      delete session.structuredWaitStartedAt;
    }
    if (rest.length) {
      pipeline.pendingUserMessages = rest;
    } else {
      delete pipeline.pendingUserMessages;
    }
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    pipeline.pendingPromptAttempt = {
      id: next.id,
      sessionId: session.sdkSessionId,
      requestId,
      phase,
      prompt: next.text,
      useTaskImages: false,
      startedAt,
    };
    session.turnStartedAt = startedAt;
    delete pipeline.stallWarning;
    await this.save(pipeline, pipeline.backendRevision);
    await this.dispatchPending(pipeline, provider);
  }

  protected async ensureSourceLink(pipeline: BuildPipeline): Promise<void> {
    if (!pipeline.environmentId || pipeline.sourceLinkedAt) return;
    if (pipeline.source?.type === "kanban") {
      await this.invoke("update_kanban_task", {
        taskId: pipeline.source.taskId,
        environmentId: pipeline.environmentId,
        buildPipelineId: pipeline.id,
      });
    }
    if (pipeline.featurePlanId) {
      await this.invoke("update_feature_plan", {
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
    await this.save(pipeline, pipeline.backendRevision);
  }

  protected async restartMissingStage(pipeline: BuildPipeline): Promise<void> {
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
    if (stage === "review" && !pipeline.reviewPackage) {
      await this.startReviewPackagePreparation(pipeline);
      return;
    }
    await this.startStage(pipeline, stage, pipeline.phase as ResumableBuildPhase);
  }

  /**
   * Opens a writable preparation-only turn before a review retry or legacy
   * package-less review. Reusing the normal fixing completion path keeps
   * structured-result recovery and package generation in one state machine.
   */
  protected async startReviewPackagePreparation(pipeline: BuildPipeline): Promise<void> {
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    const targetBranch = repository.prBaseBranch || "main";
    delete pipeline.reviewPackage;
    await this.startStage(pipeline, "fix", "fixing", {
      prompt: reviewPackagePreparationPrompt(pipeline, targetBranch),
      images: [],
      schema: REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
    });
  }

  /**
   * Applies one pass of the multi-model review stage.
   *
   * The fan-out reports what happened rather than mutating the phase itself,
   * so that the transition into `addressing` stays where every other stage
   * transition is, and a failure is raised the same way any other stage's is.
   */
  protected async advanceReviewFanout(pipeline: BuildPipeline): Promise<void> {
    const step: ReviewFanoutStep = await this.reviewFanout().advance(pipeline);
    if (step.kind === "working") return;
    if (step.kind === "failed") throw new Error(step.error);
    // The address stage opens first, and only then is the record dropped.
    // Doing it the other way round leaves a window in which the phase is still
    // `reviewing` with nothing to drive it, which the branch above would have
    // to recover from by re-running every reviewer.
    await this.startStage(pipeline, "address", "addressing");
    // Everything downstream reads `structuredReview`, which the fan-out has
    // already written. Dropping the record keeps the snapshot from carrying a
    // completed fan-out through the rest of the run — and makes a later review
    // iteration start a fresh one rather than resume this one.
    delete pipeline.reviewFanout;
    await this.save(pipeline, pipeline.backendRevision);
  }

  protected async startStage(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
    phase: ResumableBuildPhase,
    override?: {
      prompt: string;
      images: BuildPipeline["taskSnapshot"]["images"];
      mode?: ProviderExecutionMode;
      schema?: JsonSchema;
    },
  ): Promise<void> {
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
        await this.updateKanbanLifecycle(pipeline, {
          status: "in-progress",
          comment: "🔨 Build started",
        });
      }
      // Probed before the provider session exists so an unestablishable Git state
      // fails the stage without leaving a session behind or spending a turn on a
      // review that could never be certified.
      const validationWorktree =
        !override && sessionPhase === "verify"
          ? await this.validationBaseline(pipeline, sessionPhase)
          : undefined;
      const { agent, model, effort } = await this.stepSettings(pipeline, sessionPhase);
      const provider = await this.provider(pipeline, agent);
      const label = SESSION_LABELS[sessionPhase];
      // Stated rather than left to each provider's own default, so the sandbox a
      // stage runs under is one decision in one place and does not move when a
      // step pins a different harness.
      const mode =
        override?.mode ??
        executionModeOverrideForPhase(phase) ??
        executionModeForSessionPhase(sessionPhase, agent);
      const sessionKey = `${pipeline.id}:${sessionPhase}:${pipeline.iteration}:${randomUUID()}`;
      // Codex binds model and effort at session creation, Claude and OpenCode at
      // prompt dispatch, so a per-step selection has to be supplied at both.
      const sessionId = await provider.createSession(sessionPhase, label, {
        model,
        effort,
        mode,
        interaction: {
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: sessionPhase,
          workflowId: pipeline.id,
          provider: agent,
          fence: sessionKey,
        },
      });
      provider.registerSession?.(sessionId, {
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: sessionPhase,
        workflowId: pipeline.id,
        provider: agent,
        fence: sessionKey,
      });
      const stagePrompt = override
        ? { prompt: override.prompt, images: override.images, schema: override.schema }
        : await this.promptFor(pipeline, sessionPhase, agent);
      const prompt = withUnattendedPolicy(stagePrompt.prompt);
      const { schema, images } = stagePrompt;
      const requestId = randomUUID();
      const promptStartedAt = new Date().toISOString();
      const session: PipelineSession = {
        phase: sessionPhase,
        agent,
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        iteration: pipeline.iteration,
        sessionKey,
        sdkSessionId: sessionId,
        status: "running",
        startedAt: new Date().toISOString(),
        turnStartedAt: promptStartedAt,
        label,
        messages: [],
        messageRevision: 0,
        structuredRequestId: schema !== undefined ? requestId : undefined,
        structuredResultStatus: schema !== undefined ? "pending" : undefined,
        validationHeadAtStart: validationWorktree?.head,
        validationWorktreeStatusAtStart: validationWorktree?.status,
        validationUncommittedPathsAtStart: validationWorktree
          ? validationWorktree.status === "dirty"
            ? [...validationWorktree.paths]
            : []
          : undefined,
      };
      pipeline.sessions.push(session);
      pipeline.currentSessionIndex = pipeline.sessions.length - 1;
      pipeline.phase = phase;
      delete pipeline.error;
      delete pipeline.failureContext;

      pipeline.pendingPromptAttempt = {
        id: randomUUID(),
        sessionId,
        requestId,
        phase,
        prompt,
        useTaskImages: images.length > 0,
        structuredReview: schema !== undefined,
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
      };
      if (phase === "reviewing") {
        pipeline.structuredReviewRequestId = requestId;
        delete pipeline.structuredReview;
      }
      await this.save(pipeline, pipeline.backendRevision);
      return { provider, sessionId, prompt, requestId, images, schema, model, effort, mode };
    })().catch((error: unknown) => {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new PreSessionStageStartError(error, phase);
    });
    const { provider, sessionId, prompt, requestId, images, schema, model, effort, mode } =
      dispatch;
    await attachBeforeDispatch(provider, sessionId);
    try {
      await provider.send(sessionId, prompt, {
        requestId,
        images,
        schema,
        model,
        effort,
        mode,
      });
      delete pipeline.pendingPromptAttempt;
      await this.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (error instanceof AmbiguousPromptDispatchError) {
        // The bridge may have accepted the stable request before the response
        // was lost. Keep the durable attempt; the next tick reconciles status
        // and, if still idle, retries this exact request ID through bridge
        // deduplication.
        return;
      }
      throw error;
    }
  }

  protected async dispatchPending(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
  ): Promise<void> {
    const attempt = pipeline.pendingPromptAttempt;
    if (!attempt) return;
    const schema = attempt.structuredReview
      ? attempt.phase === "building" || attempt.phase === "fixing"
        ? REVIEW_PREPARATION_RESULT_JSON_SCHEMA
        : attempt.phase === "reviewing"
          ? STRUCTURED_REVIEW_REPORT_JSON_SCHEMA
          : attempt.phase === "verifying"
            ? VERIFICATION_SCHEMA
            : undefined
      : undefined;
    // Redispatch has to carry the same step selection the session was opened
    // with: Claude and OpenCode take the model per prompt, so omitting it here
    // would quietly retry the turn on the connection default instead.
    const sessionPhase = sessionPhaseFor(attempt.phase);
    const step = sessionPhase ? await this.stepSettings(pipeline, sessionPhase) : undefined;
    // Re-state the mode the session was opened with so a redispatch cannot land
    // in a different sandbox. Addressing is a writable, independent session.
    const mode =
      executionModeOverrideForPhase(attempt.phase) ??
      (sessionPhase && step ? executionModeForSessionPhase(sessionPhase, step.agent) : undefined);
    await attachBeforeDispatch(provider, attempt.sessionId);
    try {
      await provider.send(attempt.sessionId, attempt.prompt, {
        requestId: attempt.requestId,
        images: attempt.useTaskImages ? pipeline.taskSnapshot.images : [],
        schema,
        mode,
        model: step?.model,
        effort: step?.effort,
      });
      const session = pipeline.sessions.find(
        (candidate) => candidate.sdkSessionId === attempt.sessionId,
      );
      if (session) session.status = "running";
      delete pipeline.pendingPromptAttempt;
      delete pipeline.reconnectAttempt;
      delete pipeline.error;
      await this.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (error instanceof AmbiguousPromptDispatchError) return;
      throw error;
    }
  }

  /**
   * The baseline is passed in rather than probed here: the same observation has
   * to reach both the prompt the reviewer reads and the session field the guard
   * later compares against, and two probes could disagree.
   */
  protected async promptFor(
    pipeline: BuildPipeline,
    phase: PipelineSessionPhase,
    agent: BuildPipelineAgent,
  ): Promise<{
    prompt: string;
    schema?: JsonSchema;
    images: BuildPipeline["taskSnapshot"]["images"];
  }> {
    const notes = (await this.storage.getProjectNotes(pipeline.projectId)).content;
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    const target = repository.prBaseBranch || "main";
    if (phase === "build") {
      return {
        prompt: buildPrompt(pipeline, notes, target),
        schema: REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "review") {
      if (!pipeline.reviewPackage) {
        throw new Error("Cannot review without an immutable review package");
      }
      return {
        prompt: createDiscoveryPrompt({
          reviewPackage: pipeline.reviewPackage,
          reviewInstruction: config.global.reviewInstruction,
        }),
        schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "address") {
      if (!pipeline.structuredReview) {
        throw new Error("Cannot address issues without the structured review");
      }
      const sourceSession = [...pipeline.sessions]
        .reverse()
        .find((session) => session.phase === "review");
      if (!sourceSession) {
        throw new Error("Cannot address issues without the review session");
      }
      const handoff = buildReviewHandoffPrompt({
        environmentId: pipeline.environmentId,
        sourceAgent: sessionAgent(pipeline, sourceSession),
        destinationAgent: agent,
        sourceSession,
      });
      return {
        prompt: prependReviewHandoff(handoff, addressPrompt(pipeline.structuredReview)),
        images: [],
      };
    }
    if (phase === "verify") {
      return {
        prompt: verificationPrompt(pipeline, notes, target),
        schema: VERIFICATION_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "fix") {
      return {
        prompt: fixPrompt(
          pipeline,
          notes,
          pipeline.verificationFeedback ?? "The verification did not pass.",
          target,
        ),
        schema: REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "pr") {
      return { prompt: prPrompt(target), images: [] };
    }
    return { prompt: resolveConflictsPrompt(target), images: [] };
  }

  protected async finishReview(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const requestId = pipeline.structuredReviewRequestId;
    if (!requestId) throw new Error("Review result key is missing");
    const result = await provider.structured<unknown>(session.sdkSessionId, requestId);
    if (!result) {
      await this.awaitStructuredResult(pipeline, session, "review");
      return;
    }
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    const parsed = safeParseStructuredReviewReport(result.value, {
      allowLegacyTestResults: true,
    });
    if (!parsed.success) {
      await this.repairStructuredReport(pipeline, provider, session, parsed.error);
      return;
    }
    const report = stripStructuredReviewProvenance(parsed.data);
    session.structuredResultStatus = "accepted";
    session.reviewReport = report;
    pipeline.structuredReview = report;
    if (report.issues.length || report.testCoverageGaps.length) {
      await this.startStage(pipeline, "address", "addressing");
      return;
    }
    await this.startStage(pipeline, "verify", "verifying");
  }

  /**
   * Asks the review session to re-emit a report the contract rejected.
   *
   * The failures this covers are the ones the provider's JSON schema cannot
   * catch — totals that disagree with the arrays they count, duplicate ids,
   * out-of-range confidences — so the reviewer has no way to know it produced an
   * unusable report unless it is told. It is told here, in the session that
   * still holds the whole review, rather than by restarting a stage that already
   * spent its turn reaching the right conclusions.
   *
   * The corrected report is a new turn under a new structured request id, so it
   * goes out through the same durable attempt every other prompt uses: a
   * dispatch whose response is lost is retried under that id rather than
   * delivered twice. The session's validation baseline is untouched, so the
   * repair turn is certified against the same worktree state the review was.
   */
}
