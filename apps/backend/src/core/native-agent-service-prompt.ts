import * as shared from "./native-agent-service-shared.js";
const {
  createHash,
  BUILD_PIPELINE_AGENTS,
  isActiveBuildPhase,
  isBuildPipeline,
  aggregateAgentActivityState,
  AGENT_INTERACTION_ORIGINS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionPolicy,
  nativeAgentCapabilities,
  resolveReasoningId,
  withSessionActionSlashCommands,
  boundTranscriptResponse,
  resolveStartupLaunch,
  PendingNativeAgentDispatchError,
  AmbiguousPromptDispatchError,
  createNativeAgentProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  readProviderStatus,
  assertValidPromptAttachments,
  INITIAL_PROMPT_STAGING_DIRECTORY,
  stagePromptImages,
  inspectOpenCodeIncompleteTurn,
  openCodeIncompleteTurnRequestId,
  OPENCODE_INCOMPLETE_TURN_CONTINUATION,
  PROVIDER_REPORTED_INTERACTION_GRACE_MS,
  controlsFromSessionInput,
  isValidInteractionMetadata,
  isAgentTurnEndTransition,
  QUEUE_RETRY_BASE_MS,
  QUEUE_RETRY_CEILING_MS,
  MAX_QUEUE_DISPATCH_ATTEMPTS,
  LAUNCH_RETRY_MS,
  ACP_SESSION_CREATE_ATTEMPTS,
  ACP_SESSION_CREATE_RETRY_BASE_MS,
  ACTIVITY_STATUS_CONCURRENCY,
  ACTIVITY_RETRY_BASE_MS,
  ACTIVITY_RETRY_CEILING_MS,
  OPENCODE_RECOVERY_RETRY_BASE_MS,
  OPENCODE_RECOVERY_RETRY_CEILING_MS,
  PARKED_DISPATCH_CONFLICT_MESSAGE,
  OPENCODE_RECOVERY_MAX_CANDIDATES,
  OPENCODE_MANUAL_PROMPT_CLAIM_MS,
  OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT,
  ABSENT_BRIDGE_RECHECK_MS,
  INTERACTION_MONITOR_MAX_OBSERVATIONS,
  INTERACTION_MONITOR_MAX_TRACKED_REQUESTS,
  INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS,
  INTERACTION_MONITOR_DEFAULT_CONCURRENCY,
  INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT,
  INTERACTION_MONITOR_DEFAULT_MAX_RETRIES,
  INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS,
  NATIVE_PROJECTION_CACHE_LIMIT,
  NATIVE_PROJECTION_MAX_MESSAGES,
  NATIVE_PROJECTION_MAX_WINDOW_MESSAGES,
  NATIVE_PROJECTION_MAX_BYTES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES,
  NATIVE_TOOL_DETAIL_MAX_BYTES,
  NATIVE_MODEL_CATALOG_TTL_MS,
  NATIVE_MODEL_CATALOG_CACHE_LIMIT,
  NATIVE_SLASH_COMMAND_TTL_MS,
  NATIVE_SLASH_COMMAND_CACHE_LIMIT,
  NATIVE_DISCOVERY_RETRY_MS,
  nativeCapabilities,
  nativeComposerControls,
  nonBlank,
  isEnvironmentReadyForAgents,
  LEGACY_TIMESTAMP_ENVIRONMENT_NAME,
  COMPACT_TIMESTAMP_ENVIRONMENT_NAME,
  isGeneratedEnvironmentName,
  nativeAgentSessionStorageKey,
} = shared;
void [createHash, BUILD_PIPELINE_AGENTS, isActiveBuildPhase, isBuildPipeline, aggregateAgentActivityState, AGENT_INTERACTION_ORIGINS, INTERACTIVE_AGENT_INTERACTION_POLICY, UNATTENDED_AGENT_INTERACTION_POLICY, isAgentInteractionPolicy, nativeAgentCapabilities, resolveReasoningId, withSessionActionSlashCommands, boundTranscriptResponse, resolveStartupLaunch, PendingNativeAgentDispatchError, AmbiguousPromptDispatchError, createNativeAgentProvider, PromptRejectedError, ProviderUnavailableError, readProviderStatus, assertValidPromptAttachments, INITIAL_PROMPT_STAGING_DIRECTORY, stagePromptImages, inspectOpenCodeIncompleteTurn, openCodeIncompleteTurnRequestId, OPENCODE_INCOMPLETE_TURN_CONTINUATION, PROVIDER_REPORTED_INTERACTION_GRACE_MS, controlsFromSessionInput, isValidInteractionMetadata, isAgentTurnEndTransition, QUEUE_RETRY_BASE_MS, QUEUE_RETRY_CEILING_MS, MAX_QUEUE_DISPATCH_ATTEMPTS, LAUNCH_RETRY_MS, ACP_SESSION_CREATE_ATTEMPTS, ACP_SESSION_CREATE_RETRY_BASE_MS, ACTIVITY_STATUS_CONCURRENCY, ACTIVITY_RETRY_BASE_MS, ACTIVITY_RETRY_CEILING_MS, OPENCODE_RECOVERY_RETRY_BASE_MS, OPENCODE_RECOVERY_RETRY_CEILING_MS, PARKED_DISPATCH_CONFLICT_MESSAGE, OPENCODE_RECOVERY_MAX_CANDIDATES, OPENCODE_MANUAL_PROMPT_CLAIM_MS, OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT, ABSENT_BRIDGE_RECHECK_MS, INTERACTION_MONITOR_MAX_OBSERVATIONS, INTERACTION_MONITOR_MAX_TRACKED_REQUESTS, INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS, INTERACTION_MONITOR_DEFAULT_CONCURRENCY, INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT, INTERACTION_MONITOR_DEFAULT_MAX_RETRIES, INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS, NATIVE_PROJECTION_CACHE_LIMIT, NATIVE_PROJECTION_MAX_MESSAGES, NATIVE_PROJECTION_MAX_WINDOW_MESSAGES, NATIVE_PROJECTION_MAX_BYTES, NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES, NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES, NATIVE_TOOL_DETAIL_MAX_BYTES, NATIVE_MODEL_CATALOG_TTL_MS, NATIVE_MODEL_CATALOG_CACHE_LIMIT, NATIVE_SLASH_COMMAND_TTL_MS, NATIVE_SLASH_COMMAND_CACHE_LIMIT, NATIVE_DISCOVERY_RETRY_MS, nativeCapabilities, nativeComposerControls, nonBlank, isEnvironmentReadyForAgents, LEGACY_TIMESTAMP_ENVIRONMENT_NAME, COMPACT_TIMESTAMP_ENVIRONMENT_NAME, isGeneratedEnvironmentName, nativeAgentSessionStorageKey];
type BuildPipelineAgent = shared.BuildPipelineAgent;
type PipelineSessionPhase = shared.PipelineSessionPhase;
type TaskSnapshotImage = shared.TaskSnapshotImage;
type AgentActivityState = shared.AgentActivityState;
type AgentInteractionKind = shared.AgentInteractionKind;
type AgentInteractionApplyOutcome = shared.AgentInteractionApplyOutcome;
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type AgentInteractionPolicy = shared.AgentInteractionPolicy;
type AgentInteractionResolution = shared.AgentInteractionResolution;
type AgentModel = shared.AgentModel;
type NativeAgentCapabilities = shared.NativeAgentCapabilities;
type NativeAgentComposerControl = shared.NativeAgentComposerControl;
type NativeAgentComposerState = shared.NativeAgentComposerState;
type NativeAgentControlUpdate = shared.NativeAgentControlUpdate;
type NativeAgentDispatchOutcome = shared.NativeAgentDispatchOutcome;
type NativeAgentForkOutcome = shared.NativeAgentForkOutcome;
type NativeAgentMessageWindow = shared.NativeAgentMessageWindow;
type NativeAgentResumeEntry = shared.NativeAgentResumeEntry;
type NativeAgentSessionProjection = shared.NativeAgentSessionProjection;
type NativeAgentSessionAction = shared.NativeAgentSessionAction;
type NativeAgentSessionActionOutcome = shared.NativeAgentSessionActionOutcome;
type NativeAgentSlashCommand = shared.NativeAgentSlashCommand;
type NativeAgentToolDetails = shared.NativeAgentToolDetails;
type JsonSchema = shared.JsonSchema;
type Environment = shared.Environment;
type OpenCodeIncompleteTurnNotice = shared.OpenCodeIncompleteTurnNotice;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
type PersistedNativeAgentPendingDispatch = shared.PersistedNativeAgentPendingDispatch;
type StorageService = shared.StorageService;
type BridgeConnection = shared.BridgeConnection;
type NativeAgentRuntimeProvider = shared.NativeAgentRuntimeProvider;
type ProviderInteractiveSnapshot = shared.ProviderInteractiveSnapshot;
type ProviderInteractionObservationEvent = shared.ProviderInteractionObservationEvent;
type ProviderExecutionMode = shared.ProviderExecutionMode;
type PromptAttachment = shared.PromptAttachment;
type CommandInvoker = shared.CommandInvoker;
type EnsureNativeAgentSessionInput = shared.EnsureNativeAgentSessionInput;
type DispatchNativeAgentPromptInput = shared.DispatchNativeAgentPromptInput;
type AdoptNativeAgentSessionInput = shared.AdoptNativeAgentSessionInput;
type NativeAgentProjectionInput = shared.NativeAgentProjectionInput;
type NativeAgentProjectionCacheEntry = shared.NativeAgentProjectionCacheEntry;
type NativeAgentActivityTransition = shared.NativeAgentActivityTransition;
type NativeAgentServiceOptions = shared.NativeAgentServiceOptions;
type AgentInteractionObservation = shared.AgentInteractionObservation;
type OpenCodeRecoveryCandidate = shared.OpenCodeRecoveryCandidate;
type PromptDispatchPreparation = shared.PromptDispatchPreparation;
export type NativeAgentServiceLayerTypes = [
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
  AgentActivityState,
  AgentInteractionKind,
  AgentInteractionApplyOutcome,
  AgentInteractionOrigin,
  AgentInteractionPolicy,
  AgentInteractionResolution,
  AgentModel,
  NativeAgentCapabilities,
  NativeAgentComposerControl,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentDispatchOutcome,
  NativeAgentForkOutcome,
  NativeAgentMessageWindow,
  NativeAgentResumeEntry,
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
  NativeAgentToolDetails,
  JsonSchema,
  Environment,
  OpenCodeIncompleteTurnNotice,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  StorageService,
  BridgeConnection,
  NativeAgentRuntimeProvider,
  ProviderInteractiveSnapshot,
  ProviderInteractionObservationEvent,
  ProviderExecutionMode,
  PromptAttachment,
  CommandInvoker,
  EnsureNativeAgentSessionInput,
  DispatchNativeAgentPromptInput,
  AdoptNativeAgentSessionInput,
  NativeAgentProjectionInput,
  NativeAgentProjectionCacheEntry,
  NativeAgentActivityTransition,
  NativeAgentServiceOptions,
  AgentInteractionObservation,
  OpenCodeRecoveryCandidate,
  PromptDispatchPreparation,
];

import { NativeAgentServiceProjection } from "./native-agent-service-projection.ts";

export class NativeAgentServicePrompt extends NativeAgentServiceProjection {
  async dispatchPrompt(
    input: DispatchNativeAgentPromptInput,
  ): Promise<PersistedNativeAgentSession> {
    return this.dispatchPromptInternal(input);
  }

  protected async dispatchPromptInternal(
    input: DispatchNativeAgentPromptInput,
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
    persistAmbiguousDispatch = false,
  ): Promise<PersistedNativeAgentSession> {
    this.assertAcceptingWork();
    const hasAttachments = (input.images?.length ?? 0) > 0
      || (input.attachments?.length ?? 0) > 0;
    if ((!nonBlank(input.prompt) && !hasAttachments) || !nonBlank(input.requestId)) {
      throw new Error(
        "Native agent prompt or attachment and request ID must not be blank",
      );
    }
    const session = await this.ensureSession(input);
    const provider = await this.provider(input);
    provider.registerSession?.(session.providerSessionId, {
      origin: session.origin,
      interactionPolicy: session.interactionPolicy,
      phase: input.phase,
    });
    /*
     * Attach the provider before the at-most-once window opens.
     *
     * A cold agent process is the single most expensive thing the dispatch
     * request can be waiting on, and it used to run entirely inside the window
     * where a lost acknowledgement becomes an ambiguous dispatch the user has
     * to resolve by hand. Out here it is just a slow request that either works
     * or fails cleanly, and it is also outside the native-agent session
     * mutation queue, so one cold start no longer serializes every other
     * session's dispatch behind it.
     *
     * Best-effort by contract: the prompt request performs the same work, so a
     * failure here is left for it to report authoritatively rather than
     * pre-empting it with a second, less specific error.
     */
    await provider.prepareDispatch?.(session.providerSessionId).catch((error: unknown) => {
      console.warn(
        `[native-agent] Attaching ${input.agent} before dispatch failed:`,
        error instanceof Error ? error.message : error,
      );
    });
    const result = await this.storage.runWithLiveEnvironment(
      input.environmentId,
      "Native agent prompt",
      () =>
        this.storage.dispatchNativeAgentPromptOnce(
          session.key,
          input.requestId,
          async (durable) => {
            const preparation = prepare
              ? await prepare(durable, provider)
              : { dispatch: true as const };
            if (!preparation.dispatch) {
              return {
                dispatched: false as const,
                ...(preparation.notice
                  ? { openCodeIncompleteTurnNotice: preparation.notice }
                  : {}),
              };
            }
            await provider.send(durable.providerSessionId, input.prompt, {
              requestId: input.requestId,
              // Only a person typing into the composer can mean "run this
              // command"; workflow-authored prompts are literal text.
              allowProviderCommands: durable.origin === "interactive-native",
              images: input.images,
              attachments: input.attachments,
              schema: input.schema,
              mode: input.mode,
              fastMode: input.fastMode,
              subAgent: input.subAgent,
              executionAgent:
                preparation.executionAgent ?? input.executionAgent,
              includeLocalSettings: input.includeLocalSettings,
              promptSuggestions: input.promptSuggestions,
              model: preparation.model ?? input.model,
              effort: preparation.effort ?? input.reasoningEffort,
            });
            // Provider acceptance is the authoritative working edge. Record it
            // before the durable dispatch bookkeeping completes so a newer
            // idle activity snapshot cannot be overwritten by a late return
            // from storage.
            this.observedSessionActivity.set(durable.key, {
              providerSessionId: durable.providerSessionId,
              state: "working",
            });
          },
          persistAmbiguousDispatch && session.origin === "interactive-native"
            ? this.persistedPendingDispatch(input)
            : undefined,
        ),
    );
    return result.session;
  }

  protected persistedPendingDispatch(
    input: DispatchNativeAgentPromptInput,
  ): PersistedNativeAgentPendingDispatch {
    return {
      requestId: input.requestId,
      prompt: input.prompt,
      images: input.images,
      attachments: input.attachments,
      schema: input.schema,
      mode: input.mode,
      fastMode: input.fastMode,
      subAgent: input.subAgent,
      executionAgent: input.executionAgent,
      includeLocalSettings: input.includeLocalSettings,
      promptSuggestions: input.promptSuggestions,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  async claimOpenCodeManualPrompt(input: {
    environmentId: string;
    logicalSessionKey: string;
    providerSessionId: string;
    requestId: string;
  }): Promise<void> {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !nonBlank(input.providerSessionId)
      || !nonBlank(input.requestId)
    ) {
      throw new Error("OpenCode manual prompt claim is invalid");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      "opencode",
      input.logicalSessionKey,
    );
    const existing = this.openCodeManualPromptClaims.get(key);
    if (this.openCodeRecoveryDispatches.has(key)) {
      throw new Error("OpenCode automatic recovery is already being sent");
    }
    if (
      existing
      && existing.expiresAt > this.now()
      && existing.requestId !== input.requestId
    ) {
      throw new Error("Another OpenCode prompt is already being sent");
    }
    if (!existing && this.openCodeManualPromptClaims.size >= OPENCODE_RECOVERY_MAX_CANDIDATES) {
      const oldest = this.openCodeManualPromptClaims.keys().next().value;
      if (oldest) this.openCodeManualPromptClaims.delete(oldest);
    }
    const claim = {
      providerSessionId: input.providerSessionId,
      requestId: input.requestId,
      expiresAt: this.now() + OPENCODE_MANUAL_PROMPT_CLAIM_MS,
    };
    // Publish before the first await so a recovery guard cannot pass while the
    // durable identity check is in flight.
    this.openCodeManualPromptClaims.set(key, claim);
    try {
      const durable = await this.storage.getNativeAgentSession(key);
      if (durable?.providerSessionId !== input.providerSessionId) {
        throw new Error("OpenCode manual prompt session no longer matches");
      }
      // The user is explicitly replacing the stalled turn. Remove any older
      // automatic-recovery notice from the authoritative session snapshot so
      // it cannot reappear after a renderer remount.
      const cleared = await this.storage.setOpenCodeIncompleteTurnNotice(
        key,
        input.providerSessionId,
        null,
      );
      if (!cleared) {
        throw new Error("OpenCode manual prompt session no longer matches");
      }
    } catch (error) {
      if (this.openCodeManualPromptClaims.get(key) === claim) {
        this.openCodeManualPromptClaims.delete(key);
      }
      throw error;
    }
  }

  releaseOpenCodeManualPrompt(input: {
    environmentId: string;
    logicalSessionKey: string;
    providerSessionId: string;
    requestId: string;
  }): void {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      "opencode",
      input.logicalSessionKey,
    );
    const claim = this.openCodeManualPromptClaims.get(key);
    if (
      claim?.providerSessionId === input.providerSessionId
      && claim.requestId === input.requestId
    ) {
      this.openCodeManualPromptClaims.delete(key);
    }
  }

  /**
   * Wake the durable queue worker after an intent-level queue mutation.
   *
   * The periodic scan remains the crash/restart safety net, but a newly queued
   * interactive prompt should not wait for that timer. The worker owns all
   * provider I/O and its per-queue task map coalesces concurrent notifications.
   */
  notifyPromptQueueChanged(queueKey: string): void {
    if (this.stopped || !nonBlank(queueKey)) return;
    void this.drainPromptQueue(queueKey);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.launchTimer) clearInterval(this.launchTimer);
    this.launchTimer = null;
    if (this.interactionTimer) clearInterval(this.interactionTimer);
    this.interactionTimer = null;
    await Promise.allSettled([
      ...this.projectionRefreshes.values(),
      ...[...this.modelCatalogRefreshes.values()].map((entry) => entry.operation),
      ...[...this.slashCommandRefreshes.values()].map((entry) => entry.operation),
    ]);
    await Promise.allSettled([...this.scanTasks]);
    while (
      this.launchTasks.size > 0
      || this.queueTasks.size > 0
      || this.openCodeRecoveryTasks.size > 0
    ) {
      await Promise.allSettled([
        ...this.launchTasks.values(),
        ...this.queueTasks.values(),
        ...this.openCodeRecoveryTasks.values(),
      ]);
    }
    await Promise.allSettled(
      [...this.providers.values()].map((provider) => provider.dispose?.()),
    );
    this.openCodeRecoveryCandidates.clear();
    this.openCodeManualPromptClaims.clear();
    this.openCodeRecoveryDispatches.clear();
    this.providers.clear();
    this.providerConnections.clear();
    this.modelCatalogCache.clear();
    this.slashCommandCache.clear();
    this.modelCatalogRefreshes.clear();
    this.slashCommandRefreshes.clear();
    this.projectionCache.clear();
    this.toolDetailCache.clear();
    this.pinnedToolDetailRefs.clear();
    this.toolDetailCacheBytes = 0;
    this.projectionRefreshes.clear();
    this.projectionEpochs.clear();
  }

  /**
   * Operational kill switch. Existing adopted sessions keep reconciling so a
   * request already observed is not stranded; no new session is adopted.
   */
  setInteractionMonitorAdoptionEnabled(enabled: boolean): void {
    this.interactionMonitorAdoptionEnabled = enabled;
  }

  /** Bounded, content-free evidence suitable for diagnostics and tests. */
  getInteractionObservations(): AgentInteractionObservation[] {
    return [...this.interactionObservations.values()].map((entry) => ({ ...entry }));
  }

  /** Close the polling race for a provider that applies an immediate legacy response. */
  recordProviderInteractionObservation(
    event: ProviderInteractionObservationEvent & {
      environmentId: string;
      provider: BuildPipelineAgent;
    },
  ): void {
    if (this.stopped || this.options.interactionMonitorMode !== "observe-only") return;
    const phase = event.registration.origin === "build-pipeline"
      ? "pipeline"
      : event.registration.phase?.slice(0, 256) ?? "native-session";
    const observationKey = [
      event.provider,
      event.kind,
      event.registration.origin,
      phase,
    ].join("\0");
    const providerSessionKey = JSON.stringify([
      event.environmentId,
      event.provider,
      event.sessionId,
    ]);
    const trackedKey = JSON.stringify([
      event.environmentId,
      event.provider,
      event.sessionId,
      event.interactionId,
    ]);

    if (event.state === "withdrawn") {
      const tracked = this.providerReportedInteractions.get(trackedKey);
      if (!tracked) return;
      this.providerReportedInteractions.delete(trackedKey);
      const observation = this.interactionObservations.get(tracked.observationKey);
      if (!observation) return;
      const remainsBlocked = [...this.trackedInteractions.values()].some(
        (entry) => entry.observationKey === tracked.observationKey,
      ) || [...this.providerReportedInteractions.values()].some(
        (entry) => entry.observationKey === tracked.observationKey,
      );
      if (!remainsBlocked) {
        observation.providerState = event.providerState ?? "running";
        observation.eventualOutcome = "withdrawn";
        observation.eventualAt = this.now();
      }
      return;
    }

    const existing = this.providerReportedInteractions.get(trackedKey);
    if (existing) {
      const observation = this.interactionObservations.get(existing.observationKey);
      if (observation) {
        observation.lastDetectedAt = this.now();
        observation.providerState = "blocked";
        delete observation.eventualOutcome;
        delete observation.eventualAt;
        return;
      }
      this.providerReportedInteractions.delete(trackedKey);
    }
    if (
      this.trackedInteractions.size + this.providerReportedInteractions.size
        >= INTERACTION_MONITOR_MAX_TRACKED_REQUESTS
    ) return;
    const observation = this.ensureInteractionObservation(
      observationKey,
      event.provider,
      event.kind,
      event.registration.origin,
      phase,
    );
    observation.count += 1;
    observation.lastDetectedAt = this.now();
    observation.providerState = "blocked";
    delete observation.eventualOutcome;
    delete observation.eventualAt;
    this.providerReportedInteractions.set(trackedKey, {
      observationKey,
      providerSessionKey,
      detectedAt: this.now(),
    });
    this.emitInteractionObservation(observation);
  }

  /**
   * Reconcile provider-owned pending requests without applying policy.
   *
   * This is deliberately independent of renderer lifecycle and uses only
   * authoritative snapshots. Polling adapters have no subscribe/replay gap:
   * anything that arrives after one snapshot is recovered by the next.
   */
  reconcileAgentInteractions(): Promise<void> {
    if (
      this.stopped
      || this.options.interactionMonitorMode !== "observe-only"
    ) return Promise.resolve();
    if (this.interactionScan) return this.interactionScan;
    const scan = this.trackScan(this.reconcileAgentInteractionsOnce())
      .finally(() => {
        if (this.interactionScan === scan) this.interactionScan = null;
      });
    this.interactionScan = scan;
    return scan;
  }

  protected interactionPhase(session: PersistedNativeAgentSession): string {
    if (session.origin === "looped-review") {
      const segments = session.logicalSessionKey.split(":");
      const phase = segments[2];
      if (phase && phase.length <= 256) return phase;
    }
    return session.origin === "build-pipeline" ? "pipeline" : "native-session";
  }

  protected observationKey(
    session: PersistedNativeAgentSession,
    kind: AgentInteractionKind,
  ): string {
    return [session.agent, kind, session.origin, this.interactionPhase(session)].join("\0");
  }

  protected evictInteractionObservation(key: string): void {
    this.interactionObservations.delete(key);
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (tracked.observationKey === key) this.trackedInteractions.delete(trackedKey);
    }
    for (const [trackedKey, tracked] of this.providerReportedInteractions) {
      if (tracked.observationKey === key) this.providerReportedInteractions.delete(trackedKey);
    }
  }

  protected ensureInteractionObservation(
    key: string,
    provider: BuildPipelineAgent,
    kind: AgentInteractionKind,
    workflowSurface: AgentInteractionOrigin,
    phase: string,
  ): AgentInteractionObservation {
    const existing = this.interactionObservations.get(key);
    if (existing) return existing;
    if (this.interactionObservations.size >= INTERACTION_MONITOR_MAX_OBSERVATIONS) {
      const oldest = [...this.interactionObservations.entries()].sort(
        ([, left], [, right]) => left.lastDetectedAt - right.lastDetectedAt,
      )[0]?.[0];
      if (oldest) this.evictInteractionObservation(oldest);
    }
    const now = this.now();
    const observation: AgentInteractionObservation = {
      provider,
      kind,
      workflowSurface,
      phase,
      firstDetectedAt: now,
      lastDetectedAt: now,
      count: 0,
      providerState: "blocked",
    };
    this.interactionObservations.set(key, observation);
    return observation;
  }

  protected emitInteractionObservation(observation: AgentInteractionObservation): void {
    // A diagnostic consumer must never delay or fail provider reconciliation.
    try {
      void Promise.resolve(this.options.onInteractionObservation?.({ ...observation }))
        .catch(() => undefined);
    } catch {
      // Synchronous telemetry failures are isolated too.
    }
  }

  protected recordInteractionDetection(
    session: PersistedNativeAgentSession,
    interactionId: string,
    kind: AgentInteractionKind,
    expiresAt: number | undefined,
    scan: number,
  ): void {
    const trackedKey = `${session.key}\0${interactionId}`;
    const existingTrack = this.trackedInteractions.get(trackedKey);
    if (existingTrack) {
      existingTrack.scan = scan;
      existingTrack.expiresAt = expiresAt;
      const observation = this.interactionObservations.get(existingTrack.observationKey);
      if (observation) {
        observation.lastDetectedAt = this.now();
        observation.providerState = "blocked";
        delete observation.eventualOutcome;
        delete observation.eventualAt;
        return;
      }
      this.trackedInteractions.delete(trackedKey);
    }
    if (
      this.trackedInteractions.size + this.providerReportedInteractions.size
        >= INTERACTION_MONITOR_MAX_TRACKED_REQUESTS
    ) {
      return;
    }
    const key = this.observationKey(session, kind);
    const now = this.now();
    const observation = this.ensureInteractionObservation(
      key,
      session.agent,
      kind,
      session.origin,
      this.interactionPhase(session),
    );
    observation.count += 1;
    observation.lastDetectedAt = now;
    observation.providerState = "blocked";
    delete observation.eventualOutcome;
    delete observation.eventualAt;
    this.trackedInteractions.set(trackedKey, {
      observationKey: key,
      sessionKey: session.key,
      expiresAt,
      scan,
    });
    this.emitInteractionObservation(observation);
  }

  protected settleMissingInteractions(
    session: PersistedNativeAgentSession,
    scan: number,
    providerState: AgentInteractionObservation["providerState"],
  ): void {
    const prefix = `${session.key}\0`;
    const removed = new Map<string, { expiresAt?: number }>();
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (!trackedKey.startsWith(prefix) || tracked.scan === scan) continue;
      removed.set(tracked.observationKey, { expiresAt: tracked.expiresAt });
      this.trackedInteractions.delete(trackedKey);
    }
    this.finalizeRemovedInteractions(removed, providerState);
  }

  protected finalizeRemovedInteractions(
    removed: ReadonlyMap<string, { expiresAt?: number }>,
    providerState: AgentInteractionObservation["providerState"],
  ): void {
    if (removed.size === 0) return;
    const stillBlocked = new Set(
      [
        ...this.trackedInteractions.values(),
        ...this.providerReportedInteractions.values(),
      ].map((tracked) => tracked.observationKey),
    );
    const now = this.now();
    for (const [observationKey, tracked] of removed) {
      const observation = this.interactionObservations.get(observationKey);
      if (!observation) continue;
      if (stillBlocked.has(observationKey)) {
        observation.providerState = "blocked";
        delete observation.eventualOutcome;
        delete observation.eventualAt;
        continue;
      }
      observation.providerState = providerState;
      observation.eventualOutcome = tracked.expiresAt !== undefined
        && tracked.expiresAt <= now ? "expired" : "withdrawn";
      observation.eventualAt = now;
    }
  }

  protected releaseMonitoredInteractionSession(
    key: string,
    providerState: AgentInteractionObservation["providerState"] = "missing",
  ): void {
    this.monitoredInteractionSessionKeys.delete(key);
    this.observedInteractionRevisions.delete(key);
    this.interactionRetryAt.delete(key);
    this.interactionAttempts.delete(key);
    const prefix = `${key}\0`;
    const removed = new Map<string, { expiresAt?: number }>();
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (!trackedKey.startsWith(prefix)) continue;
      removed.set(tracked.observationKey, { expiresAt: tracked.expiresAt });
      this.trackedInteractions.delete(trackedKey);
    }
    this.finalizeRemovedInteractions(removed, providerState);
  }

  protected async reconcileAgentInteractionsOnce(): Promise<void> {
    const [environments, nativeSessions, pipelineRecords] = await Promise.all([
      this.storage.loadEnvironments(),
      this.storage.listNativeAgentSessions(),
      this.storage.listAllBuildPipelines(),
    ]);
    if (this.stopped) return;
    const environmentIds = new Set(
      environments
        .filter((environment) =>
          isEnvironmentReadyForAgents(environment)
          && !environment.deletionRequestedAt
        )
        .map((environment) => environment.id),
    );
    const pipelineSessions: PersistedNativeAgentSession[] = [];
    for (const record of pipelineRecords) {
      if (!isBuildPipeline(record.snapshot) || !isActiveBuildPhase(record.snapshot.phase)) {
        continue;
      }
      const current = record.snapshot.sessions[record.snapshot.currentSessionIndex];
      if (!current || current.status !== "running") continue;
      pipelineSessions.push({
        version: 1,
        key: `build-pipeline:${record.snapshot.id}:${current.sessionKey}`,
        environmentId: record.snapshot.environmentId,
        agent: current.agent ?? record.snapshot.agentType,
        logicalSessionKey: current.phase,
        providerSessionId: current.sdkSessionId,
        origin: current.origin ?? "build-pipeline",
        interactionPolicy: current.interactionPolicy
          ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        createdAt: current.startedAt,
        updatedAt: current.startedAt,
      });
    }
    const allSessions = [...nativeSessions, ...pipelineSessions];
    const eligibleSessions = allSessions.filter((session) =>
      session.interactionPolicy.mode === "unattended"
      && environmentIds.has(session.environmentId)
    );
    const liveProviderSessions = new Set(eligibleSessions.map((session) =>
      JSON.stringify([session.environmentId, session.agent, session.providerSessionId])
    ));
    const providerReportSweepAt = this.now();
    for (const [trackedKey, tracked] of this.providerReportedInteractions) {
      if (
        providerReportSweepAt - tracked.detectedAt
          >= PROVIDER_REPORTED_INTERACTION_GRACE_MS
      ) {
        this.providerReportedInteractions.delete(trackedKey);
        const observation = this.interactionObservations.get(tracked.observationKey);
        if (!observation) continue;
        const remainsBlocked = [...this.trackedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        ) || [...this.providerReportedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        );
        if (!remainsBlocked) {
          observation.providerState = "missing";
          observation.eventualOutcome = "withdrawn";
          observation.eventualAt = providerReportSweepAt;
        }
        continue;
      }
      if (liveProviderSessions.has(tracked.providerSessionKey)) {
        delete tracked.missingSince;
        continue;
      }
      // A provider can report detection, wait for the owner to durably fail an
      // unattended workflow, and only then withdraw the upstream request. The
      // durable failure removes the session from the active-pipeline snapshot,
      // so retain this bounded direct record briefly for that terminal event.
      // Without the grace period, a concurrent scan stamps `missing` and makes
      // the provider's authoritative `withdrawn/error` event a no-op.
      tracked.missingSince ??= providerReportSweepAt;
      if (
        providerReportSweepAt - tracked.missingSince
          < PROVIDER_REPORTED_INTERACTION_GRACE_MS
      ) continue;
      this.providerReportedInteractions.delete(trackedKey);
      const observation = this.interactionObservations.get(tracked.observationKey);
      if (!observation) continue;
      const remainsBlocked = [...this.trackedInteractions.values()].some(
        (entry) => entry.observationKey === tracked.observationKey,
      ) || [...this.providerReportedInteractions.values()].some(
        (entry) => entry.observationKey === tracked.observationKey,
      );
      if (!remainsBlocked) {
        observation.providerState = "missing";
        observation.eventualOutcome = "withdrawn";
        observation.eventualAt = this.now();
      }
    }
    const eligibleEnvironmentIds = new Set(
      eligibleSessions.map((session) => session.environmentId),
    );
    const liveKeys = new Set(eligibleSessions.map((session) => session.key));
    const removedInactiveTracks = new Map<string, { expiresAt?: number }>();
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (liveKeys.has(tracked.sessionKey)) continue;
      this.trackedInteractions.delete(trackedKey);
      removedInactiveTracks.set(tracked.observationKey, {
        expiresAt: tracked.expiresAt,
      });
    }
    this.finalizeRemovedInteractions(removedInactiveTracks, "missing");
    for (const key of this.monitoredInteractionSessionKeys) {
      if (liveKeys.has(key)) continue;
      this.releaseMonitoredInteractionSession(key);
    }
    for (const key of this.interactionRetryAt.keys()) {
      if (liveKeys.has(key)) continue;
      this.interactionRetryAt.delete(key);
      this.interactionAttempts.delete(key);
    }
    for (const key of this.interactionSelectionCursors.keys()) {
      const environmentId = key.split("\0", 1)[0];
      if (environmentId && eligibleEnvironmentIds.has(environmentId)) continue;
      this.interactionSelectionCursors.delete(key);
    }
    const maxPerEnvironment = Math.max(
      1,
      this.options.interactionMonitorMaxSessionsPerEnvironment
        ?? INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT,
    );
    const byEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    const candidatesByEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    for (const session of eligibleSessions) {
      if (
        !this.interactionMonitorAdoptionEnabled
        && !this.monitoredInteractionSessionKeys.has(session.key)
      ) continue;
      const candidates = candidatesByEnvironment.get(session.environmentId) ?? [];
      candidates.push(session);
      candidatesByEnvironment.set(session.environmentId, candidates);
    }
    const locallySelected: PersistedNativeAgentSession[] = [];
    for (const [environmentId, candidates] of candidatesByEnvironment) {
      const selected: PersistedNativeAgentSession[] = [];
      const pipelineCandidates = candidates.filter((session) =>
        session.key.startsWith("build-pipeline:")
      );
      // With more than one slot, an active pipeline receives one reserved slot.
      // A one-slot configuration rotates across both classes so native work is
      // not permanently hidden by a long-running pipeline.
      if (maxPerEnvironment === 1) {
        const singleSlotCandidates = [
          ...pipelineCandidates,
          ...candidates.filter((session) => !session.key.startsWith("build-pipeline:")),
        ];
        const cursor = this.interactionSelectionCursors.get(environmentId) ?? 0;
        if (singleSlotCandidates.length > 0) {
          selected.push(singleSlotCandidates[cursor % singleSlotCandidates.length]!);
        }
        this.interactionSelectionCursors.set(
          environmentId,
          singleSlotCandidates.length > 0
            ? (cursor + 1) % singleSlotCandidates.length
            : 0,
        );
      } else if (pipelineCandidates.length > 0) {
        const cursorKey = `${environmentId}\0pipeline`;
        const cursor = this.interactionSelectionCursors.get(cursorKey) ?? 0;
        selected.push(pipelineCandidates[cursor % pipelineCandidates.length]!);
        this.interactionSelectionCursors.set(
          cursorKey,
          (cursor + 1) % pipelineCandidates.length,
        );
      }
      if (maxPerEnvironment > 1) {
        const remaining = candidates.filter((candidate) =>
          !selected.some((session) => session.key === candidate.key)
        );
        const cursor = this.interactionSelectionCursors.get(environmentId) ?? 0;
        for (
          let offset = 0;
          offset < remaining.length && selected.length < maxPerEnvironment;
          offset += 1
        ) {
          selected.push(remaining[(cursor + offset) % remaining.length]!);
        }
        if (remaining.length > 0) {
          const reserved = pipelineCandidates.length > 0 ? 1 : 0;
          this.interactionSelectionCursors.set(
            environmentId,
            (cursor + Math.max(1, maxPerEnvironment - reserved)) % remaining.length,
          );
        }
      }
      locallySelected.push(...selected);
    }

    let globallySelected = locallySelected;
    if (locallySelected.length > INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS) {
      const cursor = this.interactionGlobalSelectionCursor % locallySelected.length;
      globallySelected = Array.from(
        { length: INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS },
        (_, offset) => locallySelected[(cursor + offset) % locallySelected.length]!,
      );
      this.interactionGlobalSelectionCursor =
        (cursor + INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS) % locallySelected.length;
    } else {
      this.interactionGlobalSelectionCursor = 0;
    }
    const selectedKeys = new Set(globallySelected.map((session) => session.key));
    if (this.interactionMonitorAdoptionEnabled) {
      // Enabled-mode adoption is a bounded lease. Retain request evidence while
      // rotating the lease; a later authoritative snapshot settles it.
      for (const key of this.monitoredInteractionSessionKeys) {
        if (selectedKeys.has(key)) continue;
        this.monitoredInteractionSessionKeys.delete(key);
        this.observedInteractionRevisions.delete(key);
      }
    }
    for (const session of globallySelected) {
      if (!this.monitoredInteractionSessionKeys.has(session.key)) {
        if (!this.interactionMonitorAdoptionEnabled) continue;
        this.monitoredInteractionSessionKeys.add(session.key);
      }
      const group = byEnvironment.get(session.environmentId) ?? [];
      group.push(session);
      byEnvironment.set(session.environmentId, group);
    }

    const scan = ++this.interactionScanNumber;
    const groups = [...byEnvironment.values()];
    let nextEnvironment = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopped) {
        const sessions = groups[nextEnvironment++];
        if (!sessions) return;
        // One environment is processed serially, explicitly bounding its
        // concurrent monitor work at one while global workers handle others.
        for (const session of sessions) {
          const retryKey = session.key;
          if ((this.interactionRetryAt.get(retryKey) ?? 0) > this.now()) continue;
          let provider: NativeAgentRuntimeProvider | undefined;
          try {
            provider = await this.observeProvider(session);
            if (!provider) {
              this.settleMissingInteractions(session, scan, "missing");
              this.interactionAttempts.delete(retryKey);
              this.interactionRetryAt.delete(retryKey);
              continue;
            }
            if (!provider.interactions) {
              this.settleMissingInteractions(session, scan, "error");
              this.interactionAttempts.delete(retryKey);
              this.interactionRetryAt.delete(retryKey);
              continue;
            }
            provider.registerSession?.(session.providerSessionId, {
              origin: session.origin,
              interactionPolicy: session.interactionPolicy,
              phase: this.interactionPhase(session),
            });
            const snapshot = await provider.interactions.listPendingInteractions(
              session.providerSessionId,
            );
            const previousRevision = this.observedInteractionRevisions.get(session.key);
            if (
              previousRevision !== undefined
              && snapshot.revision !== previousRevision
              && snapshot.revision !== previousRevision + 1
            ) {
              // A gap, reset, or bridge-generation change is already reconciled:
              // this is the full authoritative snapshot, never a live-event delta.
              this.interactionRevisionReconciliations = Math.min(
                Number.MAX_SAFE_INTEGER,
                this.interactionRevisionReconciliations + 1,
              );
            }
            this.observedInteractionRevisions.set(session.key, snapshot.revision);
            for (const request of snapshot.requests) {
              this.recordInteractionDetection(
                session,
                request.id,
                request.kind,
                request.expiresAt,
                scan,
              );
            }
            let providerState: AgentInteractionObservation["providerState"] =
              snapshot.requests.length > 0 ? "blocked" : "idle";
            if (snapshot.requests.length === 0) {
              try {
                // A terminal turn error is an observation, not a read fault:
                // it settles the withdrawn cards as `error` without putting the
                // whole interaction scan into retry backoff.
                providerState =
                  (await readProviderStatus(provider, session.providerSessionId)).status;
              } catch (error) {
                // The empty authoritative snapshot already proves withdrawal;
                // a failed auxiliary status read must not preserve stale cards.
                this.settleMissingInteractions(session, scan, "error");
                throw error;
              }
            }
            this.settleMissingInteractions(session, scan, providerState);
            this.interactionAttempts.delete(retryKey);
            this.interactionRetryAt.delete(retryKey);
          } catch (error) {
            const attempts = Math.min(
              Math.max(
                1,
                this.options.interactionMonitorMaxRetries
                  ?? INTERACTION_MONITOR_DEFAULT_MAX_RETRIES,
              ),
              (this.interactionAttempts.get(retryKey) ?? 0) + 1,
            );
            this.interactionAttempts.set(retryKey, attempts);
            const base = Math.max(
              1,
              this.options.interactionMonitorRetryBaseMs
                ?? INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS,
            );
            this.interactionRetryAt.set(
              retryKey,
              this.now() + Math.min(60_000, base * 2 ** Math.max(0, attempts - 1)),
            );
            if (provider) this.evictProvider(session, provider);
            console.warn(
              `[native-agent] Interaction observation for ${session.agent} failed:`,
              error instanceof Error ? error.name : "unknown error",
            );
          }
        }
      }
    };
    await Promise.all(Array.from({
      length: Math.min(
        Math.max(
          1,
          this.options.interactionMonitorMaxConcurrency
            ?? INTERACTION_MONITOR_DEFAULT_CONCURRENCY,
        ),
        groups.length,
      ),
    }, () => worker()));
  }

  /**
   * Rebuild the durable environment activity projection from provider-owned
   * session state. This does not depend on a mounted tab or a renderer event.
   */

}
