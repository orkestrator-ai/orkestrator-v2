import { randomUUID } from "node:crypto";
import type {
  BuildPipeline,
  BuildPipelineAgent,
  PipelineSession,
  PendingPipelineInteractionResolution,
  PipelineInteractionTranscriptEntry,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  stepKeyForSessionPhase,
  isVerificationVerdict,
  type VerificationVerdict,
} from "@orkestrator/protocol/build-pipeline";
import { type ReviewContractValidationError } from "@orkestrator/protocol/structured-review";
import {
  AGENT_INTERACTION_JOURNAL_VERSION,
  AGENT_INTERACTION_LIMITS,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  agentInteractionPolicyAction,
  type AgentInteractionOutcome,
  type AgentInteractionRequest,
  type AgentInteractionResolutionJournalEntry,
} from "@orkestrator/protocol/agent-interactions";
import {
  createBuildPipelineProvider,
  ProviderUnavailableError,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import { stagePromptImages } from "./prompt-attachments.js";
import {
  MAX_STRUCTURED_REPORT_REPAIR_PROMPT_BYTES,
  structuredReportRepairPrompt,
} from "./build-pipeline-prompts.js";
import { BuildPipelineServiceSupervisor } from "./build-pipeline-service-supervisor.js";
import {
  errorMessage,
  resumablePhase,
  connectionDefaultsFor,
  sessionAgent,
  stepModel,
  MAX_STRUCTURED_REPORT_REPAIR_ATTEMPTS,
  DEFAULT_INTERACTION_PROCESSING_LEASE_MS,
  withUnattendedPolicy,
  elapsedSince,
  appendInteractionSummary,
} from "./build-pipeline-service-helpers.js";
import type { PullRequestDetection } from "./build-pipeline-service-helpers.js";

export abstract class BuildPipelineServiceRecovery extends BuildPipelineServiceSupervisor {
  protected async repairStructuredReport(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
    error: ReviewContractValidationError,
  ): Promise<void> {
    const attempt = (session.structuredReportRepairAttempts ?? 0) + 1;
    if (attempt > MAX_STRUCTURED_REPORT_REPAIR_ATTEMPTS) {
      throw new Error(
        `${error.message} The review could not produce a valid report in ${MAX_STRUCTURED_REPORT_REPAIR_ATTEMPTS} repair attempts.`,
      );
    }
    const requestId = randomUUID();
    const startedAt = new Date().toISOString();
    session.structuredReportRepairAttempts = attempt;
    session.structuredRequestId = requestId;
    session.structuredResultStatus = "pending";
    session.turnStartedAt = startedAt;
    const prompt = withUnattendedPolicy(
      structuredReportRepairPrompt(error.issues, attempt, MAX_STRUCTURED_REPORT_REPAIR_ATTEMPTS),
    );
    if (Buffer.byteLength(prompt, "utf8") > MAX_STRUCTURED_REPORT_REPAIR_PROMPT_BYTES) {
      throw new Error("Structured report repair prompt exceeds its byte limit");
    }
    // The rejected report belongs to the previous request id; pointing both the
    // session and the pipeline at the new one is what makes the next tick read
    // the corrected result instead of re-reading the one already refused.
    pipeline.structuredReviewRequestId = requestId;
    pipeline.pendingPromptAttempt = {
      id: randomUUID(),
      sessionId: session.sdkSessionId,
      requestId,
      phase: "reviewing",
      prompt,
      useTaskImages: false,
      structuredReview: true,
      startedAt,
    };
    delete pipeline.stallWarning;
    await this.save(pipeline, pipeline.backendRevision);
    await this.dispatchPending(pipeline, provider);
  }

  protected async finishVerification(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    // advance() clears pendingPromptAttempt and activePromptContext before it
    // reaches this branch, so the session's own key is the only durable copy.
    // A snapshot written before that field existed has none, and there the
    // providers' own transcript metadata carries the last structured request.
    const resolvedRequestId =
      session.structuredRequestId ?? this.structuredRequestId(session.messages);
    if (!resolvedRequestId) throw new Error("Verification result key is missing");
    const result = await provider.structured<VerificationVerdict>(
      session.sdkSessionId,
      resolvedRequestId,
    );
    if (!result) {
      await this.awaitStructuredResult(pipeline, session, "verification");
      return;
    }
    await this.assertValidationWorktreeUnchanged(pipeline, session);
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    if (!isVerificationVerdict(result.value)) {
      throw new Error(
        "Verification returned malformed structured output: expected exactly a boolean complete field and a string rationale field",
      );
    }
    const { complete, rationale } = result.value;
    session.structuredResultStatus = "accepted";
    pipeline.verificationResult = complete ? "pass" : "fail";
    pipeline.verificationFeedback = rationale;
    if (complete) {
      await this.updateKanbanLifecycle(pipeline, {
        comment: "✅ Validation complete",
      });
      await this.startStage(pipeline, "pr", "creating-pr");
      return;
    }
    if (pipeline.iteration >= pipeline.maxIterations) {
      throw new Error(
        `Verification failed after ${pipeline.maxIterations} iterations: ${rationale}`,
      );
    }
    pipeline.iteration += 1;
    await this.startStage(pipeline, "fix", "fixing");
  }

  /**
   * Records that a finished turn has not produced its structured result yet,
   * and fails the pipeline once that has gone on too long.
   *
   * A null result is normal for a tick or two while the provider finalizes the
   * turn. It is also what a bridge returns for a result it no longer holds —
   * after a restart mid-turn, say — and in that case the session stays idle and
   * the answer never arrives. Without this the supervisor would re-poll an
   * unchanged snapshot every 1.5 seconds forever, showing the user a stage that
   * looks live and will never move.
   */
  protected async awaitStructuredResult(
    pipeline: BuildPipeline,
    session: PipelineSession,
    label: string,
  ): Promise<void> {
    const elapsed = elapsedSince(session.structuredWaitStartedAt);
    if (elapsed === null) {
      session.structuredWaitStartedAt = new Date().toISOString();
      await this.save(pipeline, pipeline.backendRevision);
      return;
    }
    if (elapsed >= this.structuredResultDeadlineMs) {
      throw new Error(`The ${label} finished without returning its required structured result`);
    }
  }

  protected structuredRequestId(messages: unknown[] | undefined): string | undefined {
    if (!messages) return undefined;
    for (const entry of [...messages].reverse()) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const info =
        record.info && typeof record.info === "object"
          ? (record.info as Record<string, unknown>)
          : record;
      if (info.role === "user" && typeof info.id === "string") return info.id;
      if (typeof record.requestId === "string") return record.requestId;
      if (typeof record.id === "string" && record.role === "user") return record.id;
    }
    return undefined;
  }

  protected async finishPullRequest(pipeline: BuildPipeline): Promise<void> {
    const detection = await this.detectPullRequest(pipeline);
    if (!detection) {
      // PR creation and GitHub indexing are not atomic. Keep the pipeline in
      // creating-pr and let the durable monitor plus the next supervisor pass
      // observe it; absence is not evidence that creation succeeded.
      await this.invoke("pr_monitor_watch", {
        environmentId: pipeline.environmentId,
        mode: "create-pending",
      });
      return;
    }
    await this.persistPullRequest(pipeline, detection);
    if (detection.hasMergeConflicts === true) {
      await this.startStage(pipeline, "resolve-conflicts", "resolving-conflicts");
      return;
    }
    await this.complete(pipeline);
  }

  protected async finishConflictResolution(pipeline: BuildPipeline): Promise<void> {
    const detection = await this.detectPullRequest(pipeline);
    if (!detection) {
      throw new Error("The pull request could not be found after conflict resolution");
    }
    await this.persistPullRequest(pipeline, detection);
    if (detection.hasMergeConflicts === true) {
      throw new Error("Merge conflicts could not be fully resolved automatically");
    }
    if (detection.hasMergeConflicts === null) {
      // GitHub computes mergeability asynchronously. Keep the durable phase in
      // place until a later supervisor pass has evidence that the conflict is
      // actually gone; an indeterminate answer is not successful resolution.
      return;
    }
    await this.complete(pipeline);
  }

  protected async detectPullRequest(pipeline: BuildPipeline): Promise<PullRequestDetection | null> {
    const environment = await this.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    const result =
      environment.environmentType === "local"
        ? await this.invoke<PullRequestDetection | null>("detect_pr_local", {
            environmentId: environment.id,
            branch: environment.branch,
          })
        : environment.containerId
          ? await this.invoke<PullRequestDetection | null>("detect_pr", {
              containerId: environment.containerId,
              branch: environment.branch,
            })
          : (() => {
              throw new Error("Build container is unavailable");
            })();
    if (!result) return null;
    if (
      typeof result.url !== "string" ||
      !result.url ||
      !["open", "merged", "closed"].includes(result.state) ||
      (result.hasMergeConflicts !== null && typeof result.hasMergeConflicts !== "boolean")
    ) {
      throw new Error("Pull request detection returned an invalid result");
    }
    return result;
  }

  protected async persistPullRequest(
    pipeline: BuildPipeline,
    detection: PullRequestDetection,
  ): Promise<void> {
    await this.storage.updateEnvironment(pipeline.environmentId, {
      prUrl: detection.url,
      prState: detection.state,
      hasMergeConflicts: detection.hasMergeConflicts,
    });
    await this.updateKanbanLifecycle(pipeline, {
      status: "review",
      prUrl: detection.url,
      prState: detection.state,
      comment: `🔗 PR raised: ${detection.url}`,
    });
    await this.invoke("pr_monitor_watch", {
      environmentId: pipeline.environmentId,
      mode: "normal",
    });
  }

  protected async complete(pipeline: BuildPipeline): Promise<void> {
    pipeline.phase = "complete";
    delete pipeline.error;
    delete pipeline.stallWarning;
    this.provisioningPrompts.delete(pipeline.id);
    this.lastProviderAgent.delete(pipeline.id);
    await this.save(pipeline, pipeline.backendRevision);
    await this.reconcileTerminalState(pipeline);
  }

  protected async postCompletionComment(pipeline: BuildPipeline): Promise<void> {
    const source = pipeline.source;
    if (!source || source.type === "kanban") return;
    if (pipeline.completionCommentStatus === "posted") return;
    pipeline.completionCommentStatus = "posting";
    await this.save(pipeline, pipeline.backendRevision);
    const body =
      pipeline.phase === "complete"
        ? `✅ Orkestrator build completed for **${pipeline.taskTitle}**.`
        : `❌ Orkestrator build failed for **${pipeline.taskTitle}**: ${pipeline.error ?? "Unknown error"}`;
    const result =
      source.type === "linear"
        ? await this.invoke<{ commentId?: string; postedAt?: string }>(
            "post_linear_completion_comment",
            {
              pipelineId: pipeline.id,
              issueId: source.issueId,
              body,
            },
          )
        : await this.invoke<{ commentId?: string; postedAt?: string }>(
            "post_github_completion_comment",
            {
              pipelineId: pipeline.id,
              projectId: pipeline.projectId,
              repositoryOwner: source.repositoryOwner,
              repositoryName: source.repositoryName,
              issueNumber: source.issueNumber,
              body,
            },
          );
    pipeline.completionCommentStatus = "posted";
    pipeline.completionCommentId = result.commentId;
    pipeline.completionCommentPostedAt = result.postedAt ?? new Date().toISOString();
    delete pipeline.completionCommentError;
    await this.save(pipeline, pipeline.backendRevision);
  }

  protected needsTerminalReconciliation(pipeline: BuildPipeline): boolean {
    if (pipeline.phase !== "complete" && pipeline.phase !== "failed") return false;
    return Boolean(
      pipeline.source &&
      pipeline.completionCommentStatus !== "posted" &&
      pipeline.completionCommentStatus !== "failed",
    );
  }

  protected async reconcileTerminalState(pipeline: BuildPipeline): Promise<void> {
    if (pipeline.phase !== "complete" && pipeline.phase !== "failed") return;
    if (!pipeline.source) return;
    if (pipeline.source.type === "kanban") {
      if (pipeline.completionCommentStatus === "posted") return;
      try {
        pipeline.completionCommentStatus = "posting";
        await this.save(pipeline, pipeline.backendRevision);
        await this.updateKanbanLifecycle(pipeline, {
          status: pipeline.phase === "complete" ? "review" : "backlog",
        });
        pipeline.completionCommentStatus = "posted";
        pipeline.completionCommentPostedAt = new Date().toISOString();
        delete pipeline.completionCommentError;
        await this.save(pipeline, pipeline.backendRevision);
      } catch (error) {
        pipeline.completionCommentStatus = "failed";
        pipeline.completionCommentError = errorMessage(error);
        await this.save(pipeline, pipeline.backendRevision);
      }
      return;
    }
    try {
      await this.postCompletionComment(pipeline);
    } catch (error) {
      pipeline.completionCommentStatus = "failed";
      pipeline.completionCommentError = errorMessage(error);
      await this.save(pipeline, pipeline.backendRevision);
    }
  }

  protected async updateKanbanLifecycle(
    pipeline: BuildPipeline,
    updates: {
      status?: "backlog" | "in-progress" | "review";
      comment?: string;
      prUrl?: string;
      prState?: "open" | "merged" | "closed";
    },
  ): Promise<void> {
    const source = pipeline.source;
    if (source?.type !== "kanban") return;
    const tasks = await this.invoke<
      Array<{
        id: string;
        status: string;
        prUrl?: string;
        prState?: string;
        comments: Array<{ text: string }>;
      }>
    >("get_kanban_tasks", { projectId: pipeline.projectId });
    const task = tasks.find((candidate) => candidate.id === source.taskId);
    if (!task) throw new Error(`Kanban task not found: ${source.taskId}`);
    if (
      (updates.status && task.status !== updates.status) ||
      (updates.prUrl && task.prUrl !== updates.prUrl) ||
      (updates.prState && task.prState !== updates.prState)
    ) {
      await this.invoke("update_kanban_task", {
        taskId: task.id,
        ...(updates.status ? { status: updates.status } : {}),
        ...(updates.prUrl ? { prUrl: updates.prUrl } : {}),
        ...(updates.prState ? { prState: updates.prState } : {}),
      });
    }
    if (updates.comment && !task.comments.some((comment) => comment.text === updates.comment)) {
      await this.invoke("add_kanban_comment", {
        taskId: task.id,
        text: updates.comment,
      });
    }
  }

  protected async configureEnvironment(pipeline: BuildPipeline): Promise<void> {
    await this.invoke("update_environment_agent_settings", {
      environmentId: pipeline.environmentId,
      defaultAgent: pipeline.agentType,
      claudeMode: "native",
      claudeNativeBackend: null,
      opencodeMode: "native",
      codexMode: "native",
      pendingAgentLaunch: false,
    });
  }

  /**
   * The harness, model and reasoning a step runs under.
   *
   * A step's own selections win. A field it left unset resolves to that
   * harness's default — the same value the launcher displayed for it — which
   * `connectionDefaultsFor` supplies one layer down when these are `undefined`.
   * The repository defaults never cross to a harness they were not chosen for.
   */
  protected async stepSettings(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
  ): Promise<{
    agent: BuildPipelineAgent;
    model?: string;
    effort?: string;
  }> {
    const step = pipeline.steps?.[stepKeyForSessionPhase(sessionPhase)];
    if (step) {
      const effort = step.reasoningEffort?.trim();
      return {
        agent: step.agent,
        // Normalised on read as well as on write: `start()` is not the only way
        // a snapshot gets here — `importLegacy` accepts one straight from disk,
        // where a placeholder could otherwise be sent as a real model id.
        model: stepModel(step.agent, step.model),
        effort: effort && effort !== "default" ? effort : undefined,
      };
    }
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    return {
      agent: pipeline.agentType,
      ...connectionDefaultsFor(pipeline.agentType, config, repository),
    };
  }

  protected async provider(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent = pipeline.agentType,
  ): Promise<BuildPipelineProvider> {
    // Recorded before anything that can throw, so a bridge that is unreachable
    // during connection setup is still attributed to the right harness.
    this.lastProviderAgent.set(pipeline.id, agent);
    const providerKey = `${pipeline.environmentId}:${agent}`;
    // Only this harness's own sessions. Registering a sibling step's session id
    // would put a foreign session into an environment-wide monitor that is
    // supposed to ignore everything it does not own.
    const ownSessions = pipeline.sessions.filter(
      (session) => sessionAgent(pipeline, session) === agent,
    );
    const cached = this.providers.get(providerKey);
    if (cached) {
      for (const session of ownSessions) {
        cached.registerSession?.(session.sdkSessionId, {
          origin: session.origin ?? "build-pipeline",
          interactionPolicy: session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: session.phase,
          workflowId: pipeline.id,
          provider: agent,
          fence: session.sessionKey,
        });
      }
      return cached;
    }
    if (this.options.provider) {
      const provider = await this.options.provider(pipeline, agent);
      for (const session of ownSessions) {
        provider.registerSession?.(session.sdkSessionId, {
          origin: session.origin ?? "build-pipeline",
          interactionPolicy: session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: session.phase,
          workflowId: pipeline.id,
          provider: agent,
          fence: session.sessionKey,
        });
      }
      this.providers.set(providerKey, provider);
      return provider;
    }
    const environment = await this.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    const connection = await this.bridgeConnection(agent, environment);
    const provider = createBuildPipelineProvider(
      {
        ...connection,
        // Connection-level defaults only, and only this harness's own. Every
        // pipeline turn passes the step's model and effort per call, which take
        // precedence; these fill in whatever the step left unset.
        ...connectionDefaultsFor(agent, config, repository),
      },
      {
        ...this.options.providerDependencies,
        // Milestone 4 resolves every provider through the same journaled backend
        // path. The OpenCode event-loop compatibility path used to grant an
        // unexpected permission once and fail questions before the common
        // monitor could see them; leaving it enabled would violate both rules.
        autoAnswerRequests: false,
        // Task-snapshot images arrive as base64. Both bridges require a workspace
        // path, so they have to be written into the environment before they can be
        // attached to a prompt.
        stageImages: (images) => stagePromptImages(this.invoke, environment, images),
        onInteractionObservation: async (event) => {
          const enriched = {
            ...event,
            environmentId: pipeline.environmentId,
            provider: agent,
          };
          try {
            await this.options.onInteractionObservation?.(enriched);
          } catch {
            // Passive diagnostics never control workflow behavior.
          }
        },
      },
    );
    for (const session of ownSessions) {
      provider.registerSession?.(session.sdkSessionId, {
        origin: session.origin ?? "build-pipeline",
        interactionPolicy: session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: session.phase,
        workflowId: pipeline.id,
        provider: agent,
        fence: session.sessionKey,
      });
    }
    this.providers.set(providerKey, provider);
    return provider;
  }

  protected interactionJournalEntry(
    entries: readonly AgentInteractionResolutionJournalEntry[],
    sessionId: string,
    interactionId: string,
  ): AgentInteractionResolutionJournalEntry | undefined {
    return entries.find(
      (entry) => entry.sessionId === sessionId && entry.interactionId === interactionId,
    );
  }

  protected async claimInteraction(
    pipeline: BuildPipeline,
    session: PipelineSession,
    request: AgentInteractionRequest,
  ): Promise<AgentInteractionResolutionJournalEntry> {
    let selected: AgentInteractionResolutionJournalEntry | undefined;
    const claimedAt = Date.now();
    await this.storage.updateAgentInteractionResolutionJournal((journal) => {
      const existing = this.interactionJournalEntry(
        journal.entries,
        session.sdkSessionId,
        request.id,
      );
      if (existing) {
        selected = existing;
        return journal;
      }
      const entry: AgentInteractionResolutionJournalEntry = {
        id: randomUUID(),
        interactionId: request.id,
        provider: request.provider,
        kind: request.kind,
        sessionId: session.sdkSessionId,
        state: "claimed",
        claim: {
          workflowType: "build-pipeline",
          workflowId: pipeline.id,
          phase: pipeline.phase,
          // The stage session key is the pipeline generation. Transcript-only
          // revision writes may advance while the same provider request lives;
          // fencing on a mutable storage revision would orphan a valid claim.
          fence: session.sessionKey,
          claimedAt,
        },
      };
      selected = entry;
      return {
        version: AGENT_INTERACTION_JOURNAL_VERSION,
        entries: [...journal.entries, entry],
      };
    });
    const entry = selected!;
    if (
      entry.claim.workflowType !== "build-pipeline" ||
      entry.claim.workflowId !== pipeline.id ||
      entry.claim.fence !== session.sessionKey
    ) {
      throw new ProviderUnavailableError(
        "A pending interaction belongs to a different workflow generation",
      );
    }
    return entry;
  }

  protected async markInteractionProviderResolved(
    pending: PendingPipelineInteractionResolution,
    outcome: AgentInteractionOutcome,
    resolvedAt: number,
    processingToken: string,
  ): Promise<boolean> {
    let recorded = false;
    await this.storage.updateAgentInteractionResolutionJournal((journal) => ({
      ...journal,
      entries: journal.entries.map((entry) => {
        if (
          entry.id !== pending.journalId ||
          entry.state !== "claimed" ||
          entry.processing?.ownerId !== this.interactionOwnerId ||
          entry.processing.token !== processingToken
        )
          return entry;
        recorded = true;
        const { processing: _processing, ...resolved } = entry;
        return {
          ...resolved,
          state: "provider-resolved" as const,
          outcome,
          providerResolvedAt: Math.max(resolvedAt, entry.claim.claimedAt),
        };
      }),
    }));
    return recorded;
  }

  /**
   * Exclusively fences the external provider response across backend processes.
   *
   * The workflow claim deliberately survives process death. Its short lease is
   * a separate concern: another backend may steal only after the previous
   * responder has had longer than the bounded provider request sequence to
   * finish, then reconciles the authoritative snapshot before doing any I/O.
   */
  protected async acquireInteractionProcessingLease(
    pending: PendingPipelineInteractionResolution,
  ): Promise<string | null> {
    const wallClock = Date.now();
    const proposedToken = randomUUID();
    let acquiredToken: string | null = null;
    await this.storage.updateAgentInteractionResolutionJournal((journal) => ({
      ...journal,
      entries: journal.entries.map((entry) => {
        if (entry.id !== pending.journalId || entry.state !== "claimed") {
          return entry;
        }
        const current = entry.processing;
        if (current?.ownerId === this.interactionOwnerId) {
          acquiredToken = current.token;
          return entry;
        }
        if (current && current.expiresAt > wallClock) return entry;
        // The claim may have been written by another backend process whose
        // clock runs ahead — which is exactly the case this lease exists for.
        // The lease validator requires `acquiredAt >= claim.claimedAt`, so
        // anchor to the claim rather than rejecting the whole journal update.
        const now = Math.max(wallClock, entry.claim.claimedAt);
        acquiredToken = proposedToken;
        return {
          ...entry,
          processing: {
            ownerId: this.interactionOwnerId,
            token: proposedToken,
            acquiredAt: now,
            expiresAt: now + DEFAULT_INTERACTION_PROCESSING_LEASE_MS,
          },
        };
      }),
    }));
    return acquiredToken;
  }

  protected async markInteractionWorkflowRecorded(
    pending: PendingPipelineInteractionResolution,
    recordedAt: number,
  ): Promise<void> {
    await this.storage.updateAgentInteractionResolutionJournal((journal) => ({
      ...journal,
      entries: journal.entries.map((entry) => {
        if (entry.id !== pending.journalId || entry.state === "workflow-recorded") {
          return entry;
        }
        // A workflow record is legal only after the provider boundary became
        // terminal. If a malformed/out-of-order record reaches here, keep its
        // claim for reconciliation rather than fabricating resolution.
        if (entry.state !== "provider-resolved" || entry.providerResolvedAt === undefined) {
          return entry;
        }
        return {
          ...entry,
          state: "workflow-recorded" as const,
          workflowRecordedAt: Math.max(recordedAt, entry.providerResolvedAt),
        };
      }),
    }));
  }

  protected recoveredPendingInteraction(
    entry: AgentInteractionResolutionJournalEntry,
    session: PipelineSession,
  ): PendingPipelineInteractionResolution {
    const action = agentInteractionPolicyAction(
      session.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
      entry.kind,
    );
    return {
      journalId: entry.id,
      sessionKey: session.sessionKey,
      sessionId: session.sdkSessionId,
      interactionId: entry.interactionId,
      provider: entry.provider,
      kind: entry.kind,
      phase: session.phase,
      requestedAt: entry.claim.claimedAt,
      claimedAt: entry.claim.claimedAt,
      action: action === "decline-and-continue" ? "decline-and-continue" : "deny-and-fail",
      title: "Provider interaction recovered after restart",
      body: "The provider no longer exposes the original bounded presentation.",
      questions: [],
    };
  }

  protected interactionOutcomeIsDurable(
    pipeline: BuildPipeline,
    pending: PendingPipelineInteractionResolution,
  ): boolean {
    return (
      pipeline.sessions.some((candidate) =>
        candidate.interactionTranscript?.some((entry) => entry.id === pending.interactionId),
      ) ||
      (pipeline.phase === "failed" &&
        pipeline.failureContext?.kind === "interactive-request" &&
        pipeline.failureContext.requestId === pending.interactionId)
    );
  }

  protected async saveInteractionOutcome(
    pipeline: BuildPipeline,
    pending: PendingPipelineInteractionResolution,
    outcome: AgentInteractionOutcome,
    resolvedAt: number,
  ): Promise<void> {
    let candidate = pipeline;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.save(candidate, candidate.backendRevision);
        return;
      } catch (error) {
        if (errorMessage(error) !== "Build pipeline revision conflict") throw error;
        const record = await this.requireRecord(pipeline.id);
        const latest = record.snapshot as BuildPipeline;
        latest.backendRevision = record.revision;
        if (this.interactionOutcomeIsDurable(latest, pending)) {
          if (latest.pendingInteractionResolution?.journalId !== pending.journalId) {
            return;
          }
          delete latest.pendingInteractionResolution;
          delete latest.stallWarning;
          candidate = latest;
          continue;
        }
        if (latest.pendingInteractionResolution?.journalId !== pending.journalId) {
          throw new ProviderUnavailableError(
            "The interaction outcome could not be merged into the current pipeline generation",
          );
        }
        this.applyInteractionOutcome(latest, pending, outcome, resolvedAt);
        candidate = latest;
      }
    }
    throw new ProviderUnavailableError(
      "The interaction outcome could not be persisted after concurrent updates",
    );
  }

  /**
   * Persists the workflow side of a new journal claim without turning an
   * expected cross-process CAS loss into a terminal pipeline failure.
   *
   * The winning process has written the same journal-backed pending envelope;
   * the loser must stop this pass and rehydrate that authoritative snapshot on
   * its next tick instead of continuing with its stale pipeline revision.
   */
  protected async savePendingInteractionResolution(
    pipeline: BuildPipeline,
    pending: PendingPipelineInteractionResolution,
  ): Promise<boolean> {
    try {
      await this.save(pipeline, pipeline.backendRevision);
      return true;
    } catch (error) {
      if (errorMessage(error) !== "Build pipeline revision conflict") throw error;
      const latest = (await this.requireRecord(pipeline.id)).snapshot as BuildPipeline;
      if (
        latest.pendingInteractionResolution?.journalId !== pending.journalId &&
        !this.interactionOutcomeIsDurable(latest, pending)
      ) {
        throw error;
      }
      return false;
    }
  }

  protected applyInteractionOutcome(
    pipeline: BuildPipeline,
    pending: PendingPipelineInteractionResolution,
    outcome: AgentInteractionOutcome,
    resolvedAt: number,
  ): void {
    const session = pipeline.sessions.find(
      (candidate) => candidate.sessionKey === pending.sessionKey,
    );
    if (!session) {
      throw new ProviderUnavailableError(
        "The interaction belongs to an unavailable pipeline session",
      );
    }
    const inputSucceeded = pending.action === "decline-and-continue" && outcome === "auto-declined";
    if (inputSucceeded) {
      const transcript = session.interactionTranscript ?? [];
      if (!transcript.some((entry) => entry.id === pending.interactionId)) {
        const entry: PipelineInteractionTranscriptEntry = {
          id: pending.interactionId,
          provider: pending.provider,
          kind: pending.kind,
          phase: pending.phase,
          requestedAt: pending.requestedAt,
          // The transcript validator enforces `resolvedAt >= requestedAt`; a
          // backwards clock step must not make the snapshot unparseable.
          resolvedAt: Math.max(resolvedAt, pending.requestedAt),
          outcome: "auto-declined-headless",
          title: pending.title,
          ...(pending.body ? { body: pending.body } : {}),
          questions: pending.questions,
        };
        session.interactionTranscript = [...transcript, entry].slice(
          -AGENT_INTERACTION_LIMITS.maxWorkflowSummaries,
        );
        session.autoDeclineCount = (session.autoDeclineCount ?? 0) + 1;
        pipeline.autoDeclineCount = (pipeline.autoDeclineCount ?? 0) + 1;
        session.interactionSummary = appendInteractionSummary(
          session.interactionSummary,
          pending,
          outcome,
          resolvedAt,
        );
        pipeline.interactionSummary = appendInteractionSummary(
          pipeline.interactionSummary,
          pending,
          outcome,
          resolvedAt,
        );
      }
      delete pipeline.pendingInteractionResolution;
      delete pipeline.stallWarning;
      return;
    }

    const failurePhase =
      resumablePhase(pipeline.phase) ??
      (pipeline.phase === "paused" ? pipeline.pausedFromPhase : null);
    if (!failurePhase) {
      // A distinct terminal action (most importantly an explicit user cancel)
      // wins over a provider result that was concurrently in flight. The
      // provider outcome is already fenced in the journal; clearing only this
      // recovery envelope lets that journal transition finish without
      // replacing the user's terminal reason or writing a non-resumable phase
      // into failureContext.
      delete pipeline.pendingInteractionResolution;
      delete pipeline.stallWarning;
      return;
    }

    // Authorization and unknown requests fail even after a successful denial.
    // Provider-response failures use the same visible path: the workflow must
    // never remain parked just because a safe decline could not be confirmed.
    const authorization = pending.action === "deny-and-fail" && outcome === "denied";
    pipeline.error = authorization
      ? `The ${session.label.toLowerCase()} requested unexpected authorization`
      : `The ${session.label.toLowerCase()} interaction could not be resolved safely`;
    pipeline.failureContext = {
      phase: failurePhase,
      kind: "interactive-request",
      sessionId: session.sdkSessionId,
      requestId: pending.interactionId,
    };
    session.status = "error";
    pipeline.phase = "failed";
    delete pipeline.pendingPromptAttempt;
    delete pipeline.pendingInteractionResolution;
    delete pipeline.stallWarning;
    delete pipeline.pausedFromPhase;
    this.provisioningPrompts.delete(pipeline.id);
    this.lastProviderAgent.delete(pipeline.id);
    session.interactionSummary = appendInteractionSummary(
      session.interactionSummary,
      pending,
      outcome,
      resolvedAt,
    );
    pipeline.interactionSummary = appendInteractionSummary(
      pipeline.interactionSummary,
      pending,
      outcome,
      resolvedAt,
    );
  }
}
