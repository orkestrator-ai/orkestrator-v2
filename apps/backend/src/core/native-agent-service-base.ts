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
export class NativeAgentServiceBase {
  [key: string]: any;
  protected readonly providers = new Map<string, NativeAgentRuntimeProvider>();
  /**
   * Identity of the live bridge generation behind each production provider.
   * Ports and bearer credentials both change when a bridge is replaced.
   */
  protected readonly providerConnections = new Map<string, string>();
  /** Bounded, reconstructible view cache; providers remain authoritative. */
  protected readonly projectionCache = new Map<
    string,
    NativeAgentProjectionCacheEntry
  >();
  /** Heavy, reconstructible fields omitted from ordinary renderer snapshots. */
  protected readonly toolDetailCache = new Map<string, {
    sessionKey: string;
    details: NativeAgentToolDetails;
    bytes: number;
  }>();
  /** Entries temporarily protected while an authoritative refresh recreates them. */
  protected readonly pinnedToolDetailRefs = new Set<string>();
  protected toolDetailCacheBytes = 0;
  protected readonly modelCatalogCache = new Map<
    string,
    { models: AgentModel[]; expiresAt: number }
  >();
  protected readonly slashCommandCache = new Map<
    string,
    { commands: NativeAgentSlashCommand[]; expiresAt: number }
  >();
  /** Coalesced stale-while-revalidate tasks for projection-only metadata. */
  protected readonly modelCatalogRefreshes = new Map<string, {
    operation: Promise<AgentModel[]>;
    validity: { current: boolean };
  }>();
  protected readonly slashCommandRefreshes = new Map<
    string,
    {
      operation: Promise<NativeAgentSlashCommand[]>;
      validity: { current: boolean };
    }
  >();
  protected readonly launchTasks = new Map<string, Promise<void>>();
  protected readonly launchRetryAt = new Map<string, number>();
  protected readonly queueTasks = new Map<string, Promise<void>>();
  protected readonly queueRetryAt = new Map<string, number>();
  protected readonly queueAttempts = new Map<string, number>();
  protected readonly scanTasks = new Set<Promise<void>>();
  protected readonly activityRetryAt = new Map<string, number>();
  protected readonly activityAttempts = new Map<string, number>();
  protected readonly absentBridgeUntil = new Map<string, number>();
  /** Last provider-owned state per durable session, used for exact turn edges. */
  protected readonly observedSessionActivity = new Map<
    string,
    { providerSessionId: string; state: AgentActivityState }
  >();
  /** In-flight incomplete-turn recoveries, coalesced per durable session. */
  protected readonly openCodeRecoveryTasks = new Map<string, Promise<void>>();
  /** Idle transcript candidates retained across transient recovery failures. */
  protected readonly openCodeRecoveryCandidates = new Map<
    string,
    OpenCodeRecoveryCandidate
  >();
  /** Short-lived manual-send claims prevent stale automatic continuations. */
  protected readonly openCodeManualPromptClaims = new Map<
    string,
    { providerSessionId: string; requestId: string; expiresAt: number }
  >();
  /** Final no-await handoff from recovery validation into provider dispatch. */
  protected readonly openCodeRecoveryDispatches = new Set<string>();
  /**
   * Parked dispatches currently being settled against their provider, keyed by
   * session and request id. Projection reads are frequent and the settle is a
   * network round trip, so this keeps one refresh from queueing another.
   */
  protected readonly settlingDispatches = new Set<string>();
  /**
   * Environments whose exact completion edge has not yet reached the PR
   * monitor. Delivery is retried by later sweeps, while the set coalesces
   * simultaneous session completions into one environment notification.
   */
  protected readonly pendingPrRefreshEnvironmentIds = new Set<string>();
  protected readonly interactionObservations = new Map<string, AgentInteractionObservation>();
  protected readonly trackedInteractions = new Map<
    string,
    {
      observationKey: string;
      sessionKey: string;
      expiresAt?: number;
      scan: number;
    }
  >();
  protected readonly providerReportedInteractions = new Map<
    string,
    {
      observationKey: string;
      providerSessionKey: string;
      detectedAt: number;
      missingSince?: number;
    }
  >();
  protected readonly interactionRetryAt = new Map<string, number>();
  protected readonly interactionAttempts = new Map<string, number>();
  protected readonly monitoredInteractionSessionKeys = new Set<string>();
  protected readonly observedInteractionRevisions = new Map<string, number>();
  /** Serializes projection reads so late provider responses cannot roll state back. */
  protected readonly projectionRefreshes = new Map<
    string,
    Promise<NativeAgentSessionProjection | null>
  >();
  /** Invalidates an in-flight read when a logical tab changes provider identity. */
  protected readonly projectionEpochs = new Map<string, number>();
  /** Round-robin offsets keep bounded scans from permanently favouring old sessions. */
  protected readonly interactionSelectionCursors = new Map<string, number>();
  protected interactionGlobalSelectionCursor = 0;
  protected activityScan: Promise<void> | null = null;
  protected interactionScan: Promise<void> | null = null;
  protected interactionScanNumber = 0;
  protected interactionRevisionReconciliations = 0;
  protected interactionMonitorAdoptionEnabled = true;
  protected launchTimer: ReturnType<typeof setInterval> | null = null;
  protected interactionTimer: ReturnType<typeof setInterval> | null = null;
  protected initialization: Promise<void> | null = null;
  protected stopped = false;

  constructor(
    protected readonly storage: StorageService,
    protected readonly invoke: CommandInvoker,
    protected readonly options: NativeAgentServiceOptions = {},
  ) {
    this.interactionMonitorAdoptionEnabled =
      options.interactionMonitorAdoptionEnabled !== false;
  }

  protected now(): number {
    return this.options.now?.() ?? Date.now();
  }

  init(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Native agent service is shut down"));
    if (this.initialization) return this.initialization;
    const operation = this.initialize().catch((error) => {
      if (this.initialization === operation) this.initialization = null;
      throw error;
    });
    this.initialization = operation;
    return operation;
  }

  protected async initialize(): Promise<void> {
    await this.repairPersistedStartupTabs().catch(() => undefined);
    await Promise.allSettled([
      this.trackScan(this.reconcilePendingLaunches()),
      this.trackScan(this.drainPromptQueues()),
    ]);
    if (this.stopped) return;
    this.launchTimer = setInterval(() => {
      if (this.stopped) return;
      void this.trackScan(this.reconcilePendingLaunches()).catch(() => undefined);
      void this.trackScan(this.drainPromptQueues()).catch(() => undefined);
    }, 2_000);
    this.launchTimer.unref?.();
    if (this.options.interactionMonitorMode === "observe-only") {
      await this.reconcileAgentInteractions().catch(() => undefined);
      if (this.stopped) return;
      this.interactionTimer = setInterval(() => {
        void this.reconcileAgentInteractions().catch(() => undefined);
      }, Math.max(100, this.options.interactionMonitorIntervalMs ?? 2_000));
      this.interactionTimer.unref?.();
    }
  }

  /**
   * Upgrade only a still-present canonical startup tab from the historical
   * provider-specific terminal record to the native pane identity. Missing
   * tabs are left missing because their absence may be an intentional close,
   * and a tab that already holds the native identity is left completely alone:
   * this runs on every backend start, so touching a healthy tab would be a
   * recurring rewrite of state this repair does not own.
   */
  protected async repairPersistedStartupTabs(): Promise<void> {
    const sessions = (await this.storage.listNativeAgentSessions())
      .filter((session) =>
        session.origin === "interactive-native"
        && session.logicalSessionKey === `env-${session.environmentId}:startup-agent`
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const repairedEnvironments = new Set<string>();
    for (const session of sessions) {
      if (this.stopped) return;
      if (repairedEnvironments.has(session.environmentId)) continue;
      repairedEnvironments.add(session.environmentId);
      await this.storage.ensureStartupNativeAgentTab({
        environmentId: session.environmentId,
        agent: session.agent,
        providerSessionId: session.providerSessionId,
        existingOnly: true,
        upgradeOnly: true,
      }).catch(() => undefined);
    }
  }

  async ensureSession(
    input: EnsureNativeAgentSessionInput,
  ): Promise<PersistedNativeAgentSession> {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !BUILD_PIPELINE_AGENTS.includes(input.agent)
      || !isValidInteractionMetadata(input)
    ) {
      throw new Error("Invalid native agent session request");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    await this.assertEnvironmentLive(input.environmentId);
    const provider = await this.provider(input);
    const existing = await this.storage.getNativeAgentSession(key);
    if (existing) {
      this.assertSessionIdentity(existing, input, key);
      await this.assertEnvironmentLive(input.environmentId);
      provider.registerSession?.(existing.providerSessionId, {
        origin: existing.origin,
        interactionPolicy: existing.interactionPolicy,
        phase: input.phase,
      });
      /*
       * Liveness only. A session whose last turn ended in a terminal error —
       * "Selected model is at capacity", a usage limit, a transport fault — is
       * still a live session with an intact rollout, and the user's next move is
       * usually to change model and continue. Letting that error escape here
       * failed every later ensure/dispatch on the *previous* turn's failure, so
       * the tab could never send the message that would have cleared it.
       */
      const { status } = await readProviderStatus(
        provider,
        existing.providerSessionId,
      );
      await this.assertEnvironmentLive(input.environmentId);
      if (status !== "missing") {
        void this.reconcileAgentInteractions().catch(() => undefined);
        return existing;
      }
      await this.storage.invalidateNativeAgentSession(
        key,
        existing.providerSessionId,
      );
    }
    const session = await this.storage.runWithLiveEnvironment(
      input.environmentId,
      "Native agent session",
      () =>
        this.storage.getOrCreateNativeAgentSession(
          {
            key,
            environmentId: input.environmentId,
            agent: input.agent,
            logicalSessionKey: input.logicalSessionKey,
            origin: input.origin,
            interactionPolicy: input.interactionPolicy,
            controls: controlsFromSessionInput(input),
          },
          () => this.createProviderSession(provider, input),
        ),
    );
    void this.reconcileAgentInteractions().catch(() => undefined);
    return session;
  }

  async adoptSession(
    input: AdoptNativeAgentSessionInput,
  ): Promise<PersistedNativeAgentSession> {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !nonBlank(input.providerSessionId)
      || !BUILD_PIPELINE_AGENTS.includes(input.agent)
      || !isValidInteractionMetadata(input)
      || (
        input.expectedProviderSessionId !== undefined
        && !nonBlank(input.expectedProviderSessionId)
      )
    ) {
      throw new Error("Invalid native agent session adoption request");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    await this.assertEnvironmentLive(input.environmentId);
    const provider = await this.provider(input);
    provider.registerSession?.(input.providerSessionId, {
      origin: input.origin ?? "interactive-native",
      interactionPolicy: input.interactionPolicy
        ?? ((input.origin === "build-pipeline" || input.origin === "looped-review")
          ? UNATTENDED_AGENT_INTERACTION_POLICY
          : INTERACTIVE_AGENT_INTERACTION_POLICY),
      phase: input.phase,
    });
    // Same liveness-only rule as ensureSession: a failed last turn is not a
    // missing session, and adopting one must still succeed.
    const { status } = await readProviderStatus(provider, input.providerSessionId);
    await this.assertEnvironmentLive(input.environmentId);
    if (status === "missing") {
      throw new Error("Native agent provider session was not found");
    }
    const session = await this.storage.adoptNativeAgentSession({
      key,
      environmentId: input.environmentId,
      agent: input.agent,
      logicalSessionKey: input.logicalSessionKey,
      providerSessionId: input.providerSessionId,
      origin: input.origin,
      interactionPolicy: input.interactionPolicy,
      controls: input.controls ?? controlsFromSessionInput(input),
      expectedProviderSessionId: input.expectedProviderSessionId,
    });
    void this.reconcileAgentInteractions().catch(() => undefined);
    return session;
  }

  async getProjection(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    this.assertProjectionInput(input);
    return this.refreshProjection(input, true);
  }

  /**
   * Drop every cached model/command list for this environment and re-read.
   *
   * Providers discover models at their own cadence, so a user who has just
   * installed or authorized one needs a way to say "look again" without
   * restarting the environment. Neutral, so it works for any provider rather
   * than only the one whose tab used to own a refresh button.
   */
  async refreshProjectionModels(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    this.assertProjectionInput(input);
    const provider = await this.provider(input);
    const slashCommandKey = `${input.environmentId}\0${input.agent}`;
    // Discard in-flight discovery rather than waiting for it. Each refresh
    // re-checks its validity flag immediately before writing its cache, with no
    // await in between, so an invalidated read can no longer land. Awaiting one
    // would only make this explicit user action inherit the latency of the very
    // work it just discarded — up to a full bridge request timeout.
    const pendingModelCatalog = this.modelCatalogRefreshes.get(input.environmentId);
    if (pendingModelCatalog) {
      pendingModelCatalog.validity.current = false;
      this.modelCatalogRefreshes.delete(input.environmentId);
    }
    const pendingSlashCommands = this.slashCommandRefreshes.get(slashCommandKey);
    if (pendingSlashCommands) {
      pendingSlashCommands.validity.current = false;
      this.slashCommandRefreshes.delete(slashCommandKey);
    }
    await provider.refreshCatalog?.();
    this.modelCatalogCache.delete(input.environmentId);
    this.slashCommandCache.delete(slashCommandKey);
    return this.refreshProjection(input, true);
  }

  async listProjectionModels(
    input: NativeAgentProjectionInput,
  ): Promise<AgentModel[]> {
    this.assertProjectionInput(input);
    const provider = await this.provider(input);
    return provider.modelCatalog
      ? (await provider.modelCatalog()).slice(0, 512)
      : [];
  }

  /**
   * Read the bounded raw OpenCode catalogue for durable cache refreshes.
   *
   * Picker-facing callers must continue using `listProjectionModels`, which
   * applies the configured provider allowlist. The cache deliberately retains
   * the wider source catalogue so a provider added later is available to launch
   * dialogs before an environment starts another bridge.
   */
  async listModelCatalogForCache(
    input: NativeAgentProjectionInput,
  ): Promise<AgentModel[]> {
    this.assertProjectionInput(input);
    const provider = await this.provider(input);
    if (provider.rawModelCatalog) {
      return (await provider.rawModelCatalog()).slice(0, 512);
    }
    return provider.modelCatalog
      ? (await provider.modelCatalog()).slice(0, 512)
      : [];
  }

  async dispatchIntent(
    input: DispatchNativeAgentPromptInput,
  ): Promise<NativeAgentDispatchOutcome> {
    return this.dispatchIntentInternal(input, false);
  }


}

