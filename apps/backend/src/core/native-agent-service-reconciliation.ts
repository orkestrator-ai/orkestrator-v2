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

import { NativeAgentServicePrompt } from "./native-agent-service-prompt.ts";

export class NativeAgentServiceReconciliation extends NativeAgentServicePrompt {
  reconcileAgentActivity(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.activityScan) return this.activityScan;
    const scan = this.trackScan(this.reconcileAgentActivityOnce())
      .finally(() => {
        if (this.activityScan === scan) this.activityScan = null;
      });
    this.activityScan = scan;
    return scan;
  }

  protected async reconcileAgentActivityOnce(): Promise<void> {
    const [environments, sessions] = await Promise.all([
      this.storage.loadEnvironments(),
      this.storage.listNativeAgentSessions(),
    ]);
    if (this.stopped) return;

    const environmentsById = new Map(
      environments.map((environment) => [environment.id, environment]),
    );
    const sessionsByEnvironment = new Map<
      string,
      PersistedNativeAgentSession[]
    >();
    for (const session of sessions) {
      if (!environmentsById.has(session.environmentId)) continue;
      const grouped = sessionsByEnvironment.get(session.environmentId) ?? [];
      grouped.push(session);
      sessionsByEnvironment.set(session.environmentId, grouped);
    }

    const activityByEnvironment = new Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >();
    const completionCandidates = new Set<string>();
    const failedEnvironments = new Set<string>();
    const groups = new Map<string, PersistedNativeAgentSession[]>();
    for (const [environmentId, environmentSessions] of sessionsByEnvironment) {
      const environment = environmentsById.get(environmentId)!;
      if (!isEnvironmentReadyForAgents(environment)) continue;
      // A pending deletion makes every provider call throw on the liveness
      // assertion, which would otherwise warn and back off on a loop until the
      // delete finishes. Its activity is settled by the delete itself.
      if (environment.deletionRequestedAt) continue;
      for (const session of environmentSessions) {
        const key = `${environmentId}\0${session.agent}`;
        const grouped = groups.get(key) ?? [];
        grouped.push(session);
        groups.set(key, grouped);
      }
    }

    const pendingGroups = [...groups.entries()];
    let nextGroup = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopped) {
        const entry = pendingGroups[nextGroup++];
        if (!entry) return;
        const [groupKey, group] = entry;
        const first = group[0]!;
        const environment = environmentsById.get(first.environmentId)!;
        // A group whose last read failed stays untouched until its backoff
        // expires. Its environment is still withheld from the commit below:
        // publishing an aggregate built from a group we deliberately skipped
        // would report the unread agent as idle.
        if ((this.activityRetryAt.get(groupKey) ?? 0) > this.now()) {
          failedEnvironments.add(first.environmentId);
          continue;
        }
        // A bridge known to be absent stays absent until something starts it,
        // and starting one always runs through `provider()`, which clears this.
        // Re-probing on every tick would mean a `docker exec` per container
        // every two seconds to re-learn an answer that cannot have changed.
        if ((this.absentBridgeUntil.get(groupKey) ?? 0) > this.now()) {
          for (const session of group) {
            if (await this.recordActivity(
              activityByEnvironment,
              session,
              "idle",
              Boolean(environment.prRecheckAfterAgentCompletionArmedAt),
            )) completionCandidates.add(session.environmentId);
          }
          continue;
        }
        let provider: NativeAgentRuntimeProvider | undefined;
        try {
          provider = await this.observeProvider(first);
          if (!provider) {
            // No bridge is running for this environment, so no turn can be
            // executing. That is an answer, not a failure — recording it is
            // what retires a `working` indicator left behind by a crash.
            for (const session of group) {
              if (await this.recordActivity(
                activityByEnvironment,
                session,
                "idle",
                Boolean(environment.prRecheckAfterAgentCompletionArmedAt),
              )) completionCandidates.add(session.environmentId);
            }
            this.activityAttempts.delete(groupKey);
            this.activityRetryAt.delete(groupKey);
            this.absentBridgeUntil.set(
              groupKey,
              this.now() + ABSENT_BRIDGE_RECHECK_MS,
            );
            continue;
          }
          this.absentBridgeUntil.delete(groupKey);
          for (const session of group) {
            provider.registerSession?.(session.providerSessionId, {
              origin: session.origin,
              interactionPolicy: session.interactionPolicy,
            });
          }
          const batchedActivity = provider.activityBatch
            ? await provider.activityBatch(
                group.map((session) => session.providerSessionId),
              )
            : undefined;
          for (const session of group) {
            const activity = batchedActivity
              ? batchedActivity.get(session.providerSessionId)
              : provider.activity
                ? await provider.activity(session.providerSessionId)
                : await readProviderStatus(provider, session.providerSessionId)
                    .then(({ status }) =>
                      status === "missing"
                        ? "missing"
                        : status === "running"
                          ? "working"
                          : status === "blocked" ? "waiting" : "idle"
                    );
            if (!activity) {
              throw new ProviderUnavailableError(
                `Provider activity snapshot omitted ${session.providerSessionId}`,
              );
            }
            if (activity === "missing") {
              // Provider adapters may return `missing` only from an
              // authoritative existence read. Incremental activity/status
              // snapshots must surface uncertainty as provider unavailability.
              await this.storage.invalidateNativeAgentSession(
                session.key,
                session.providerSessionId,
              );
              continue;
            }
            if (await this.recordActivity(
              activityByEnvironment,
              session,
              activity,
              Boolean(environment.prRecheckAfterAgentCompletionArmedAt),
            )) completionCandidates.add(session.environmentId);
          }
          this.activityAttempts.delete(groupKey);
          this.activityRetryAt.delete(groupKey);
        } catch (error) {
          failedEnvironments.add(first.environmentId);
          this.backOffActivityGroup(groupKey);
          if (provider) {
            this.evictProvider(first, provider);
          }
          console.warn(
            `[native-agent] Activity reconciliation for ${first.environmentId} failed:`,
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ACTIVITY_STATUS_CONCURRENCY, pendingGroups.length) },
        () => worker(),
      ),
    );
    if (this.stopped) return;

    // An exact per-session completion must not wait for the environment-wide
    // aggregate to become idle: another tab using the same provider may still
    // be working. The command is backend-internal and only acts when durable
    // conflict-resolution intent is armed.
    for (const environmentId of completionCandidates) {
      this.pendingPrRefreshEnvironmentIds.add(environmentId);
    }
    const armedEnvironmentIds = new Set(
      environments
        .filter((environment) =>
          Boolean(environment.prRecheckAfterAgentCompletionArmedAt)
        )
        .map((environment) => environment.id),
    );
    for (const environmentId of this.pendingPrRefreshEnvironmentIds) {
      if (!armedEnvironmentIds.has(environmentId)) {
        this.pendingPrRefreshEnvironmentIds.delete(environmentId);
      }
    }
    await this.flushPendingPrRefreshNotifications();

    const liveSessionsByKey = new Map(
      sessions
        .filter((session) => environmentsById.has(session.environmentId))
        .map((session) => [session.key, session.providerSessionId]),
    );
    for (const [key, observed] of this.observedSessionActivity) {
      if (liveSessionsByKey.get(key) !== observed.providerSessionId) {
        this.observedSessionActivity.delete(key);
      }
    }

    for (const environment of environments) {
      if (failedEnvironments.has(environment.id)) continue;
      const hasRegisteredSessions = sessionsByEnvironment.has(environment.id);
      const previous = environment.agentActivitySources?.["native-agent"];
      if (!hasRegisteredSessions && !previous) continue;
      const desiredState = isEnvironmentReadyForAgents(environment)
        ? aggregateAgentActivityState(
            activityByEnvironment.get(environment.id) ?? {},
          )
        : "idle";
      if (previous?.state === desiredState) continue;
      await this.storage.setEnvironmentAgentActivity(
        environment.id,
        desiredState,
        new Date().toISOString(),
        "native-agent",
      ).catch((error) => {
        console.warn(
          `[native-agent] Failed to persist activity for ${environment.id}:`,
          error instanceof Error ? error.name : "unknown error",
        );
      });
    }
  }

  /** Stage one session's observed state into the per-environment aggregate. */
  protected async recordActivity(
    activityByEnvironment: Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >,
    session: PersistedNativeAgentSession,
    state: AgentActivityState,
    countUnknownIdleAsCompletion: boolean,
  ): Promise<boolean> {
    const observed = this.observedSessionActivity.get(session.key);
    const previous = observed?.providerSessionId === session.providerSessionId
      ? observed.state
      : undefined;
    const durableAttentionEdge = (state === "idle" || state === "waiting")
      && (
        previous === "working"
        || (state === "idle" && observed === undefined && countUnknownIdleAsCompletion)
      );
    // PR reconciliation retains its narrower historical completion contract:
    // a parked waiting turn needs the user's attention, but it has not ended.
    const completed = state === "idle"
      && (
        previous === "working"
        || (observed === undefined && countUnknownIdleAsCompletion)
      );
    // Persist the exact session edge before advancing the in-memory observation.
    // If storage fails, the provider group backs off and the next scan still
    // sees `previous === "working"`, so the durable completion is retried.
    if (durableAttentionEdge) {
      await this.storage.recordEnvironmentSessionCompletion(
        session.environmentId,
        new Date(this.now()).toISOString(),
      );
    }
    this.observedSessionActivity.set(session.key, {
      providerSessionId: session.providerSessionId,
      state,
    });
    if (previous !== state) {
      this.options.onActivityTransition?.({
        environmentId: session.environmentId,
        sessionKey: session.key,
        providerSessionId: session.providerSessionId,
        previousState: previous,
        state,
      });
    }
    /*
     * First-idle inspection is the restart/reconnect snapshot path. Later
     * candidates originate from exact turn-end edges, while a retained
     * candidate is retried after transient provider or storage failures.
     * Unattended workflows own their own turn lifecycle and remain excluded.
     */
    const openCodeInteractive = session.agent === "opencode"
      && session.origin !== "build-pipeline"
      && session.origin !== "looped-review";
    if (!openCodeInteractive || state !== "idle") {
      this.openCodeRecoveryCandidates.delete(session.key);
    } else {
      if (
        previous === undefined
        || isAgentTurnEndTransition({ previousState: previous, state })
      ) {
        this.markOpenCodeRecoveryCandidate(session);
      }
      this.scheduleOpenCodeIncompleteTurnRecovery(session);
    }
    const sources = activityByEnvironment.get(session.environmentId) ?? {};
    sources[session.key] = {
      state,
      // Only the state matters for this in-memory aggregate. A real timestamp
      // is supplied once per committed environment.
      updatedAt: "1970-01-01T00:00:00.000Z",
    };
    activityByEnvironment.set(session.environmentId, sources);
    return completed;
  }

  /** Deliver pending completion notifications with the same bound as status IO. */
  protected async flushPendingPrRefreshNotifications(): Promise<void> {
    const environmentIds = [...this.pendingPrRefreshEnvironmentIds];
    let nextEnvironment = 0;
    const worker = async (): Promise<void> => {
      while (!this.stopped) {
        const environmentId = environmentIds[nextEnvironment++];
        if (!environmentId) return;
        try {
          await this.invoke("pr_monitor_agent_turn_completed", { environmentId });
          this.pendingPrRefreshEnvironmentIds.delete(environmentId);
        } catch (error) {
          console.warn(
            `[native-agent] Failed to schedule PR refresh after completion for ${environmentId}:`,
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            ACTIVITY_STATUS_CONCURRENCY,
            environmentIds.length,
          ),
        },
        () => worker(),
      ),
    );
  }

  protected markOpenCodeRecoveryCandidate(
    session: PersistedNativeAgentSession,
  ): void {
    const current = this.openCodeRecoveryCandidates.get(session.key);
    if (current?.providerSessionId === session.providerSessionId) return;
    if (
      !current
      && this.openCodeRecoveryCandidates.size >= OPENCODE_RECOVERY_MAX_CANDIDATES
    ) {
      const oldest = this.openCodeRecoveryCandidates.keys().next().value;
      if (oldest) this.openCodeRecoveryCandidates.delete(oldest);
    }
    this.openCodeRecoveryCandidates.set(session.key, {
      providerSessionId: session.providerSessionId,
      attempts: 0,
      retryAt: 0,
    });
  }

  protected hasOpenCodeManualPromptClaim(
    session: PersistedNativeAgentSession,
  ): boolean {
    const claim = this.openCodeManualPromptClaims.get(session.key);
    if (!claim) return false;
    if (
      claim.providerSessionId !== session.providerSessionId
      || claim.expiresAt <= this.now()
    ) {
      this.openCodeManualPromptClaims.delete(session.key);
      return false;
    }
    return true;
  }

  protected hasNewerOpenCodeActivity(
    session: PersistedNativeAgentSession,
  ): boolean {
    const observed = this.observedSessionActivity.get(session.key);
    return observed?.providerSessionId === session.providerSessionId
      && observed.state !== "idle";
  }

  /** Coalesce concurrent idle observations onto one recovery pass per session. */
  protected scheduleOpenCodeIncompleteTurnRecovery(
    session: PersistedNativeAgentSession,
  ): void {
    const candidate = this.openCodeRecoveryCandidates.get(session.key);
    if (
      this.stopped
      || this.openCodeRecoveryTasks.has(session.key)
      || candidate?.providerSessionId !== session.providerSessionId
      || candidate.retryAt > this.now()
    ) return;
    const task = this.recoverOpenCodeIncompleteTurnOnce(session)
      .then((result) => {
        const latest = this.openCodeRecoveryCandidates.get(session.key);
        if (latest?.providerSessionId !== session.providerSessionId) return;
        if (result === "complete") {
          this.openCodeRecoveryCandidates.delete(session.key);
          return;
        }
        latest.retryAt = this.now() + OPENCODE_RECOVERY_RETRY_BASE_MS;
      })
      .catch((error) => {
        const latest = this.openCodeRecoveryCandidates.get(session.key);
        if (latest?.providerSessionId === session.providerSessionId) {
          latest.attempts += 1;
          latest.retryAt = this.now() + Math.min(
            OPENCODE_RECOVERY_RETRY_CEILING_MS,
            OPENCODE_RECOVERY_RETRY_BASE_MS
              * 2 ** Math.min(latest.attempts - 1, 8),
          );
        }
        console.warn(
          `[native-agent] OpenCode incomplete-turn recovery for ${session.environmentId} failed:`,
          error instanceof Error ? error.name : "unknown error",
        );
      })
      .finally(() => {
        if (this.openCodeRecoveryTasks.get(session.key) === task) {
          this.openCodeRecoveryTasks.delete(session.key);
        }
      });
    this.openCodeRecoveryTasks.set(session.key, task);
  }

  /**
   * Continue an OpenCode turn that ended incomplete, at most once per stall.
   *
   * The authoritative transcript is both the detector and the loop bound: the
   * stalled shape (`unknown` finish, reasoning only, no error, no pending
   * tools) must be present, and the fixed continuation prompt as the latest
   * user turn means recovery already ran and stalled again — that turn is left
   * for the user. Dispatch itself goes through the durable per-request-id
   * journal, so a re-observed edge or a backend restart cannot double-send.
   */
  protected async recoverOpenCodeIncompleteTurnOnce(
    session: PersistedNativeAgentSession,
  ): Promise<"complete" | "retry"> {
    if (this.stopped) return "complete";
    const environment = await this.storage.getEnvironment(session.environmentId);
    if (
      !environment
      || environment.deletionRequestedAt
      || !isEnvironmentReadyForAgents(environment)
    ) {
      return "complete";
    }
    // The mapping may have been replaced since the sweep observed the edge; a
    // continuation must never reach a different provider session.
    const durable = await this.storage.getNativeAgentSession(session.key);
    if (durable?.providerSessionId !== session.providerSessionId) return "complete";

    const provider = await this.observeProvider({
      environmentId: session.environmentId,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    });
    if (!provider) return "retry";
    if (this.hasOpenCodeManualPromptClaim(session)) return "retry";
    const initialMessages = await provider.messages(
      session.providerSessionId,
      { limit: OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT },
    );
    if (this.stopped) return "complete";
    const initialRecovery = inspectOpenCodeIncompleteTurn(initialMessages);
    if (!initialRecovery) return "complete";
    let disposition: "complete" | "retry" = "complete";
    let confirmedAssistantMessageId: string | undefined;
    try {
      await this.dispatchPromptInternal({
        environmentId: session.environmentId,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
        origin: session.origin,
        interactionPolicy: session.interactionPolicy,
        prompt: OPENCODE_INCOMPLETE_TURN_CONTINUATION,
        requestId: openCodeIncompleteTurnRequestId(
          initialRecovery.assistantMessageId,
        ),
      }, async (lockedSession, lockedProvider) => {
        if (this.stopped) return { dispatch: false };
        if (
          this.hasOpenCodeManualPromptClaim(lockedSession)
          || this.hasNewerOpenCodeActivity(lockedSession)
        ) {
          disposition = "retry";
          return { dispatch: false };
        }
        const queue = await this.storage.getPromptQueue(
          `${lockedSession.agent}\0${lockedSession.logicalSessionKey}`,
        );
        if (queue && (queue.messages.length > 0 || queue.inFlight !== undefined)) {
          disposition = "retry";
          return { dispatch: false };
        }
        const messages = await lockedProvider.messages(
          lockedSession.providerSessionId,
          { limit: OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT },
        );
        if (this.stopped) return { dispatch: false };
        // Claims and queues may have appeared while the authoritative read was
        // in flight. This final check is inside the durable dispatch lock.
        if (
          this.hasOpenCodeManualPromptClaim(lockedSession)
          || this.hasNewerOpenCodeActivity(lockedSession)
        ) {
          disposition = "retry";
          return { dispatch: false };
        }
        const latestQueue = await this.storage.getPromptQueue(
          `${lockedSession.agent}\0${lockedSession.logicalSessionKey}`,
        );
        if (
          this.hasOpenCodeManualPromptClaim(lockedSession)
          || this.hasNewerOpenCodeActivity(lockedSession)
        ) {
          disposition = "retry";
          return { dispatch: false };
        }
        if (
          latestQueue
          && (latestQueue.messages.length > 0 || latestQueue.inFlight !== undefined)
        ) {
          disposition = "retry";
          return { dispatch: false };
        }
        const recovery = inspectOpenCodeIncompleteTurn(messages);
        if (!recovery) return { dispatch: false };
        if (recovery.assistantMessageId !== initialRecovery.assistantMessageId) {
          disposition = "retry";
          return { dispatch: false };
        }
        confirmedAssistantMessageId = recovery.assistantMessageId;
        if (recovery.action === "exhausted") {
          console.warn(
            `[native-agent] OpenCode turn for ${session.environmentId} ended incomplete again after an automatic continuation; leaving it for the user`,
          );
          return {
            dispatch: false,
            notice: {
              kind: "exhausted",
              assistantMessageId: recovery.assistantMessageId,
              updatedAt: new Date(this.now()).toISOString(),
            },
          };
        }
        console.warn(
          `[native-agent] Continuing an incomplete OpenCode turn for ${session.environmentId}`,
        );
        // Publish synchronously after the last awaited guard. A direct/manual
        // claim now fails until provider acceptance finishes, closing the
        // otherwise unavoidable check-to-send gap.
        this.openCodeRecoveryDispatches.add(lockedSession.key);
        return {
          dispatch: true,
          model: recovery.modelId,
          effort: recovery.variant,
          executionAgent: recovery.agent,
        };
      });
      return disposition;
    } catch (error) {
      if (confirmedAssistantMessageId) {
        await this.storage.setOpenCodeIncompleteTurnNotice(
          session.key,
          session.providerSessionId,
          {
            kind: "failed",
            assistantMessageId: confirmedAssistantMessageId,
            updatedAt: new Date(this.now()).toISOString(),
          },
        ).catch(() => false);
      }
      throw error;
    } finally {
      this.openCodeRecoveryDispatches.delete(session.key);
    }
  }

  /**
   * Push a failing group's next read out geometrically.
   *
   * Without this an environment whose bridge cannot be reached is retried
   * thirty times a minute forever, each attempt re-resolving a connection and
   * emitting a warning. Mirrors the prompt queue's backoff so the two paths
   * degrade the same way.
   */
  protected backOffActivityGroup(groupKey: string): void {
    const attempts = (this.activityAttempts.get(groupKey) ?? 0) + 1;
    this.activityAttempts.set(groupKey, attempts);
    const backoff = Math.min(
      ACTIVITY_RETRY_CEILING_MS,
      ACTIVITY_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8),
    );
    this.activityRetryAt.set(groupKey, this.now() + backoff);
  }

  async reconcileInitialLaunch(environmentId: string): Promise<void> {
    if (this.stopped) return;
    const existing = this.launchTasks.get(environmentId);
    if (existing) return existing;
    const task = this.reconcileInitialLaunchOnce(environmentId)
      .finally(() => {
        if (this.launchTasks.get(environmentId) === task) {
          this.launchTasks.delete(environmentId);
        }
      });
    this.launchTasks.set(environmentId, task);
    return task;
  }

  protected async reconcilePendingLaunches(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const environments = await this.storage.loadEnvironments();
    if (this.stopped) return;
    await this.pruneProviders(
      new Set(
        environments
          .filter((environment) => !environment.deletionRequestedAt)
          .map((environment) => environment.id),
      ),
    );
    if (this.stopped) return;
    await Promise.allSettled(
      environments
        .filter((environment) =>
          environment.pendingAgentLaunch
          && (environment.status === "creating" || environment.status === "running")
          && (this.launchRetryAt.get(environment.id) ?? 0) <= now
        )
        .map((environment) => this.reconcileInitialLaunch(environment.id)),
    );
  }

  protected async drainPromptQueues(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const queues = await this.storage.listAllPromptQueues();
    if (this.stopped) return;
    await Promise.allSettled(
      queues
        .filter((queue) => {
          const agent = queue.queueKey.split("\0", 1)[0];
          return (
            BUILD_PIPELINE_AGENTS.includes(agent as BuildPipelineAgent)
            && (queue.messages.length > 0 || queue.inFlight !== undefined)
            && queue.dispatchError === undefined
            && (this.queueRetryAt.get(queue.queueKey) ?? 0) <= now
          );
        })
        .map((queue) => this.drainPromptQueue(queue.queueKey)),
    );
  }

  /**
   * Back off a queue and, once the attempts are clearly not transient, park it
   * with a durable error the renderer can show.
   *
   * An unbounded 2s retry is invisible: nothing is logged, no dispatchError is
   * latched, and the user sees a queue that simply never drains.
   */
  protected async deferQueue(
    queueKey: string,
    reason: string,
    requestId?: string,
    park?: {
      /**
       * Reserve the queue head so an exhausted deferral can park it even though
       * no dispatch ever claimed it. Only for conditions the drain itself can
       * never clear; a transient one must keep retrying instead.
       */
      reserveHead?: boolean;
      /** Persisted for the user; `reason` is what reaches the log. */
      message?: string;
    },
  ): Promise<void> {
    const attempts = (this.queueAttempts.get(queueKey) ?? 0) + 1;
    this.queueAttempts.set(queueKey, attempts);
    if (attempts >= MAX_QUEUE_DISPATCH_ATTEMPTS) {
      // The key and the reason are safe to log; the prompt itself never is, and
      // neither is provider-authored detail — that is persisted, not logged.
      console.warn(
        `[native-agent] Prompt queue ${queueKey} has failed ${attempts} times: ${reason}`,
      );
      // A head no dispatch ever reserved has no request id, so the park path a
      // failed dispatch uses could not run: the prompt was neither sent nor
      // failed and the queue stalled at the backoff ceiling with nothing shown
      // to the user. Reserving it here gives that path its identity.
      const parkedRequestId = requestId
        ?? (park?.reserveHead
          ? (await this.storage.reservePromptQueueHeadForDispatch(queueKey))
            ?.requestId
          : undefined);
      if (parkedRequestId !== undefined) {
        this.queueAttempts.delete(queueKey);
        this.queueRetryAt.delete(queueKey);
        await this.storage.failPromptQueueDispatch(
          queueKey,
          parkedRequestId,
          park?.message ?? reason,
        );
        return;
      }
    }
    // Exponential up to a ceiling so a wedged provider is retried rarely rather
    // than every two seconds forever.
    const backoff = Math.min(
      QUEUE_RETRY_CEILING_MS,
      QUEUE_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 8),
    );
    this.queueRetryAt.set(queueKey, Date.now() + backoff);
  }

  protected clearQueueBackoff(queueKey: string): void {
    this.queueAttempts.delete(queueKey);
    this.queueRetryAt.delete(queueKey);
  }

  protected async drainPromptQueue(queueKey: string): Promise<void> {
    if (this.stopped) return;
    const existing = this.queueTasks.get(queueKey);
    if (!existing) {
      const task = this.drainPromptQueueOnce(queueKey)
        .finally(() => {
          if (this.queueTasks.get(queueKey) === task) {
            this.queueTasks.delete(queueKey);
          }
        });
      this.queueTasks.set(queueKey, task);
      return task;
    }
    // Coalesce concurrent notifications onto the in-flight pass, but guarantee
    // a fresh pass after it settles: that pass may already have read the queue
    // before this notification's mutation was persisted, so only a follow-up
    // pass is certain to see the new head. The in-flight pass removes itself
    // from the task map before these follow-ups run, so any number of
    // notifications collapse onto a single extra pass rather than one per
    // notification.
    return existing.finally(() => {
      if (this.queueTasks.has(queueKey)) return;
      void this.drainPromptQueue(queueKey);
    });
  }

  protected async drainPromptQueueOnce(queueKey: string): Promise<void> {
    try {
      await this.drainReadyPromptQueue(queueKey);
    } catch (error) {
      // Any fault that escapes the drain must still back off. A storage read or
      // reservation that throws bypasses every inner handler, and the scan's
      // `allSettled` swallows the rejection — so without this the queue was
      // retried every two seconds with no attempt counter, no latch and no log:
      // the same invisible hot loop deferQueue exists to prevent, reached
      // through a storage fault instead of a provider fault.
      await this.deferQueue(
        queueKey,
        error instanceof Error ? error.name : "unknown drain error",
      ).catch(() => undefined);
    }
  }

  protected async drainReadyPromptQueue(queueKey: string): Promise<void> {
    if (this.stopped) return;
    const separator = queueKey.indexOf("\0");
    if (separator <= 0) return;
    const agent = queueKey.slice(0, separator) as BuildPipelineAgent;
    const logicalSessionKey = queueKey.slice(separator + 1);
    if (
      !BUILD_PIPELINE_AGENTS.includes(agent)
      || !nonBlank(logicalSessionKey)
    ) {
      return;
    }
    const queue = await this.storage.getPromptQueue(queueKey);
    if (!queue || queue.dispatchError) return;
    if (queue.inFlight === undefined && queue.messages.length === 0) return;
    const environment = await this.assertEnvironmentLive(queue.environmentId);
    // The launch path has always required this; so must the drain path. A
    // stopped or still-provisioning environment must not be started by a
    // leftover queued prompt.
    if (!isEnvironmentReadyForAgents(environment)) {
      await this.deferQueue(queueKey, "environment is not ready for agents");
      return;
    }
    const draftKey =
      `${agent}:${queue.environmentId}:${encodeURIComponent(logicalSessionKey)}`;
    const draft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(draft?.value)) return;

    const head = queue.inFlight?.message ?? queue.messages[0];
    const mode = this.queueExecutionMode(agent, head);
    const session = await this.ensureSession({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: this.queueString(head, "model"),
      reasoningEffort: this.queueReasoningEffort(head),
      phase: mode === "plan" ? "review" : "build",
    });
    const provider = await this.provider({
      environmentId: queue.environmentId,
      agent,
      logicalSessionKey,
      model: this.queueString(head, "model"),
      reasoningEffort: this.queueReasoningEffort(head),
    });
    await this.assertEnvironmentLive(queue.environmentId);
    // Read as data: a failed last turn must defer with a bounded backoff and a
    // reason, not escape as a throw that the outer handler can only report as
    // an anonymous drain fault.
    const { status, error: statusDetail } = await readProviderStatus(
      provider,
      session.providerSessionId,
    );
    await this.assertEnvironmentLive(queue.environmentId);
    if (status === "running" || status === "blocked") return;
    if (status !== "idle") {
      await this.deferQueue(
        queueKey,
        `provider session is ${status}`,
        queue.inFlight?.requestId,
        {
          /*
           * A terminal turn error is sticky until the next turn runs, and the
           * drain is the only thing that would have run it — so retrying can
           * never clear this on its own. Deferring alone left the prompt
           * neither sent nor failed and told the user nothing. Park it instead:
           * the composer shows the provider's own explanation and the existing
           * retry control resends it once the model is changed. Auto-sending
           * here would be worse than silence, because an at-capacity model
           * fails every queued prompt in turn and burns the whole queue.
           */
          reserveHead: true,
          message: statusDetail
            ? `The ${agent} session failed before this prompt was sent: ${
              statusDetail.slice(0, 500)
            }`
            : `The ${agent} session is ${status}; the queued prompt was not sent.`,
        },
      );
      return;
    }
    if (this.stopped) return;
    const latestDraft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(latestDraft?.value)) return;
    const reservation = await this.storage.reservePromptQueueHeadForDispatch(
      queueKey,
    );
    if (!reservation || typeof reservation.message !== "object") return;
    const message = reservation.message as Record<string, unknown>;
    if (!nonBlank(message.text)) {
      await this.storage.acknowledgePromptQueueDispatch(
        queueKey,
        reservation.requestId,
      );
      return;
    }

    // Queued attachments were staged by the renderer, so they already carry
    // workspace paths and can be attached for real. Flattening them into prose
    // silently degraded an image to a filename the model had to guess at.
    let attachments: PromptAttachment[] = [];
    try {
      attachments = Array.isArray(message.attachments)
        ? assertValidPromptAttachments(message.attachments)
        : [];
    } catch (error) {
      const reason = error instanceof Error
        ? error.message
        : "Queued attachment is invalid";
      await this.storage.failPromptQueueDispatch(
        queueKey,
        reservation.requestId,
        reason,
      );
      this.clearQueueBackoff(queueKey);
      return;
    }
    try {
      // Only the first prompt in a session names the environment, and only while
      // it still carries a generated name — the same guard the renderer applied
      // before draining moved to the backend.
      if ((session.dispatchedRequestIds?.length ?? 0) === 0) {
        await this.renameEnvironmentFromFirstPrompt(
          queue.environmentId,
          message.text,
        );
      }
      await this.dispatchPrompt({
        environmentId: queue.environmentId,
        agent,
        logicalSessionKey,
        model: this.queueString(message, "model"),
        reasoningEffort: this.queueReasoningEffort(message),
        phase: this.queueExecutionMode(agent, message) === "plan"
          ? "review"
          : "build",
        mode: this.queueExecutionMode(agent, message),
        fastMode: this.queueFastMode(agent, message),
        subAgent: this.queueString(message, "agent"),
        executionAgent:
          this.queueString(message, "executionAgent")
          ?? this.queueString(message, "agent"),
        includeLocalSettings: this.queueBoolean(message, "includeLocalSettings"),
        promptSuggestions: this.queueBoolean(message, "promptSuggestions"),
        attachments,
        prompt: message.text,
        requestId: reservation.requestId,
      });
      await this.storage.acknowledgePromptQueueDispatch(
        queueKey,
        reservation.requestId,
      );
      this.clearQueueBackoff(queueKey);
    } catch (error) {
      if (error instanceof PromptRejectedError) {
        await this.storage.failPromptQueueDispatch(
          queueKey,
          reservation.requestId,
          error.message,
        );
        this.clearQueueBackoff(queueKey);
        return;
      }
      // Keep the in-flight record durable. The same request id is retried after
      // backoff, so an ambiguous provider response cannot become a second turn.
      // Handled here rather than rethrown so the attempt is counted once, with
      // the reservation id the latch needs.
      await this.deferQueue(
        queueKey,
        error instanceof Error ? error.name : "unknown dispatch error",
        reservation.requestId,
      );
    }
  }

  protected async reconcileInitialLaunchOnce(
    environmentId: string,
  ): Promise<void> {
    if (this.stopped) return;
    const environment = await this.storage.getEnvironment(environmentId);
    if (
      !environment
      || !environment.pendingAgentLaunch
      || (environment.status !== "creating" && environment.status !== "running")
    ) {
      return;
    }
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(
      environment.projectId,
    );
    // Shared with the renderer rather than reimplemented here: the renderer has
    // to predict this exact decision to know whether it may still stage the
    // initial prompt's images itself, and any divergence silently costs the
    // user the attachment. See `resolveStartupLaunch`.
    const { agent, dispatchedByBackend } = resolveStartupLaunch({
      environment,
      repository,
      global: config.global,
    });

    // Terminal and Claude-tmux launches still need a PTY/tmux projection. They
    // are left pending for the backend terminal coordinator rather than being
    // falsely marked consumed by this native-session service.
    if (!dispatchedByBackend) {
      return;
    }

    const logicalSessionKey = `env-${environment.id}:startup-agent`;
    const model =
      environment.initialAgentModel
      ?? repository.defaultModel
      ?? (
        agent === "claude"
          ? config.global.claudeModel
          : agent === "codex"
            ? config.global.codexModel
            : config.global.opencodeModel
      );
    const reasoningEffort =
      environment.initialReasoningEffort
      ?? repository.defaultEffort
      ?? (agent === "codex" ? config.global.codexReasoningEffort : undefined);

    // Publishing runs inside the same failure handling as the launch itself. A
    // throw here (an unwritable layout file, a root over the size bound) would
    // otherwise escape before the catch below records the durable error and
    // arms `launchRetryAt`, leaving the two-second sweep retrying forever with
    // no backoff and nothing for the renderer to surface.
    try {
      // Publish both startup surfaces as soon as backend intent exists,
      // including while setup is still running. Provider creation remains gated
      // below, but the durable pane can already rehydrate in an inactive
      // renderer.
      await this.storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent,
      });
      const startupSession = environment.startupAgentSession;
      if (
        !startupSession
        || startupSession.agent !== agent
        || startupSession.style !== "native"
        || startupSession.status !== "starting"
      ) {
        await this.storage.updateEnvironment(environment.id, {
          startupAgentSession: {
            tabId: "startup-agent",
            agent,
            style: "native",
            model,
            reasoningEffort,
            status: "starting",
          },
        });
      }

      if (!isEnvironmentReadyForAgents(environment)) return;

      const prompt = environment.initialPrompt?.trim();
      // Passed as base64 rather than staged here: the provider stages inside the
      // durable dispatch lock, so only the supervisor that actually wins the
      // launch writes the file. Staging first would have every supervisor write
      // the same path concurrently.
      const images = environment.initialPromptAttachments?.map((attachment) => ({
        filename: attachment.name,
        data: attachment.base64Data,
      }));
      const session = prompt || (images?.length ?? 0) > 0
        ? await this.dispatchPrompt({
            environmentId: environment.id,
            agent,
            logicalSessionKey,
            model,
            reasoningEffort,
            prompt: prompt ?? "",
            requestId: `initial-prompt:${environment.id}:startup-agent`,
            images,
          })
        : await this.ensureSession({
            environmentId: environment.id,
            agent,
            logicalSessionKey,
            model,
            reasoningEffort,
          });

      // The provider mapping is not enough to satisfy the launch: the user
      // needs a durable pane projection even if every renderer was inactive
      // throughout setup. Publish it before consuming the launch intent so a
      // crash at either boundary is safely retried and converges by stable id.
      const publishedLayout = await this.storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent,
        providerSessionId: session.providerSessionId,
      });

      await this.storage.updateEnvironment(environment.id, {
        pendingAgentLaunch: false,
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
        initialPromptAttachments: undefined,
        // Once the durable pane carries the provider session id, the snapshot
        // has no remaining reader and must reach a terminal state. Leaving it
        // set is not inert: every renderer keeps polling this environment for
        // the life of the app, and the launch effect keeps re-projecting a
        // startup tab the user has since closed.
        startupAgentSession: publishedLayout
          ? undefined
          : {
              tabId: "startup-agent",
              agent,
              style: "native",
              model,
              reasoningEffort,
              providerSessionId: session.providerSessionId,
              status: "running",
              startedAt: new Date().toISOString(),
            },
      });
      this.launchRetryAt.delete(environment.id);
    } catch (error) {
      // A rejection is the provider's verdict on this prompt, not a transient
      // fault: retrying it every ten seconds forever would never succeed and
      // leaves the environment hidden-mounted and polled for the life of the
      // app. Stop retrying and let the surfaced error stand.
      const terminal = error instanceof PromptRejectedError;
      console.warn(
        `[native-agent] Startup launch for ${environment.id} failed`
        + `${terminal ? " permanently" : ""}: `
        + (error instanceof Error ? error.name : "unknown error"),
      );
      if (!terminal) this.launchRetryAt.set(environment.id, Date.now() + LAUNCH_RETRY_MS);
      await this.storage.updateEnvironment(environment.id, {
        ...(terminal
          ? {
              pendingAgentLaunch: false,
              initialPromptAttachments: undefined,
            }
          : {}),
        startupAgentSession: {
          tabId: "startup-agent",
          agent,
          style: "native",
          model,
          reasoningEffort,
          status: "error",
          error: terminal
            ? `The agent rejected the initial prompt: ${error.message}`
            : "Agent launch failed; the backend will retry.",
        },
      });
      throw error;
    }
  }

  /**
   * Name the environment from its first prompt.
   *
   * Draining moved out of the renderer, and this call moved with the rest of
   * `handleSend` — so an environment whose first prompt arrived through the
   * queue kept its generated timestamp name. A failure here must never block the
   * prompt: the name is cosmetic, the dispatch is not.
   */
  protected async renameEnvironmentFromFirstPrompt(
    environmentId: string,
    prompt: unknown,
  ): Promise<void> {
    if (!nonBlank(prompt)) return;
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || !isGeneratedEnvironmentName(environment.name)) return;
    try {
      await this.invoke("rename_environment_from_prompt", {
        environmentId,
        prompt,
      });
    } catch (error) {
      console.warn(
        `[native-agent] Failed to rename ${environmentId} from its first prompt:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }

  /**
   * One provider per environment and agent.
   *
   * Model and effort are deliberately excluded from the key and passed per call
   * instead: keying on them accumulated an undisposed provider — and for
   * OpenCode a permanent event stream — for every variant a user ever queued.
   */

}

