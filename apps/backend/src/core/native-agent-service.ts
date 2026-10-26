export * from "./native-agent-service-shared.js";
import * as shared from "./native-agent-service-shared.js";
import type {
  BuildPipelineAgent,
  TaskSnapshotImage,
  AgentActivityState,
  AgentInteractionApplyOutcome,
  AgentInteractionResolution,
  AgentModel,
  NativeAgentCapabilities,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentDispatchOutcome,
  NativeAgentForkOutcome,
  NativeAgentResumeEntry,
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentToolDetails,
  Environment,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  StorageService,
  BridgeConnection,
  NativeAgentRuntimeProvider,
  PromptAttachment,
  CommandInvoker,
  EnsureNativeAgentSessionInput,
  DispatchNativeAgentPromptInput,
  AdoptNativeAgentSessionInput,
  InspectNativeAgentSessionInput,
  NativeAgentProjectionInput,
  NativeAgentServiceOptions,
  AgentInteractionObservation,
  PromptDispatchPreparation,
  NativeAgentAuthStatus,
  NativeAgentMcpServerAction,
  PersistedNativeAgentPendingSteer,
  NativeAgentProjectionUpdateInput,
  NativeAgentMessagePageInput,
  NativeAgentProjectionUpdate,
  NativeAgentTranscriptUpdateInput,
  NativeAgentProgressiveInput,
  NativeAgentDiscoveryUpdateInput,
  NativeAgentMessagePage,
  MailInjectDispatchOutcome,
} from "./native-agent-service-shared.js";
import {
  BUILD_PIPELINE_AGENTS,
  INITIAL_PROMPT_STAGING_DIRECTORY,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  NativeAgentProviderSessionMissingError,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  controlsFromSessionInput,
  createNativeAgentProvider,
  isValidInteractionMetadata,
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  nonBlank,
  readProviderStatus,
  stagePromptImages,
  AmbiguousPromptDispatchError,
  PARKED_DISPATCH_CONFLICT_MESSAGE,
  PendingNativeAgentDispatchError,
  PendingNativeAgentSteerError,
  createHash,
  isFallbackExecutionProfileId,
  ProviderUnavailableError,
  isEnvironmentReadyForAgents,
  ACP_SESSION_CREATE_ATTEMPTS,
  ACP_SESSION_CREATE_RETRY_BASE_MS,
} from "./native-agent-service-shared.js";
import {
  withProviderSessionTeardownLock,
  providerSessionHeldElsewhere,
  replacedSessionCloseIntent,
} from "./provider-session-ownership.js";
import {
  coordinatorResearchLine,
  loadCoordinatorResearch,
} from "./coordinator-research-context.js";
import {
  COORDINATOR_ASYNC_CONTRACT,
  COORDINATOR_LAUNCH_DEFAULTS_RULE,
  COORDINATOR_CONTEXT_CLOSE_TAG,
  COORDINATOR_CONTEXT_OPEN_TAG,
  COORDINATOR_MAIL_ADDRESS,
  COORDINATOR_EXECUTION_POLICY,
  coordinatorIdFromRuntimeId,
  stripCoordinatorContext,
  coordinatorConversationIdFromRuntimeId,
  agentSessionOwnerKey,
} from "@orkestrator/protocol/coordinator";
import {
  type NativeAgentCommandRefreshOutcome,
  type NativeAgentDefaultModelResolution,
  type NativeAgentModelSubstitution,
  nativeAgentSteerRejectionMessage,
  dispatchOutcomeLostMessage,
  nativeAsyncQuestionItemId,
  type NativeAgentDiscoveryUpdate,
  type NativeAgentSessionStateUpdate,
  type NativeAgentTranscriptUpdate,
  resolveNativeAgentApprovalMode,
  nativeAgentCapabilities,
  type NativeAgentCommandIntent,
} from "@orkestrator/protocol/native-agent";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  coordinatorRuntimeUnavailableMessage,
  resolveCoordinatorRuntime,
  coordinatorRuntimeEnvironment,
} from "./coordinator-runtime.js";
import type { NativeAgentProviderEnvironment } from "./native-agent-provider.js";
import { assertValidPromptImages, mimeTypeForImageData } from "./prompt-attachments.js";
import {
  ProviderRegistry,
  providerCacheKey,
  bridgeConnectionIdentity,
} from "./native-agent-provider-registry.js";
import { NATIVE_AGENT_SESSION_VERSION } from "./models.js";
import {
  NativeAgentObservationBroker,
  MAIL_INJECT_OBSERVATION_MAX_AGE_MS,
  nativeAgentObservationGroupKey,
  observationSatisfies,
  type NativeAgentObservationDemand,
  type NativeAgentObservationStatus,
  type NativeAgentObservationView,
  type NativeAgentObservationWakeReason,
} from "./native-agent-observation.js";
import { NativeAgentTurnRecovery } from "./native-agent-turn-recovery.js";
import { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import { NativeAgentInteractionTracker } from "./native-agent-interaction-tracker.js";
import { NativeAgentLaunchActivityReconciler } from "./native-agent-launch-activity-reconciler.js";
import { NativeAgentPromptQueueDispatcher } from "./native-agent-prompt-queue-dispatcher.js";
import {
  NativeAgentTranscriptProjection,
  type ResolvedProjectionSession,
} from "./native-agent-transcript-projection.js";
import { DEFAULT_WORKFLOW_DISCOVERY_MS, keyedSchedulingEnabled } from "./workflow-supervisor.js";
import { randomUUID } from "node:crypto";
import {
  PromptRejectedError,
  type ProviderMcpConfigEvidenceRead,
} from "./agent-provider-contract.js";
import { claudeReasoningSelection } from "@orkestrator/protocol/claude-model-catalog";
import { type AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import { unsupportedCommandCatalogueState } from "@orkestrator/protocol/agent-command-catalogue";
import {
  isProjectHomeEnvironment,
  reconcileProjectHomeEnvironment,
} from "./project-home-environment.js";
import type { MailboxPresence } from "@orkestrator/protocol/agent-mail";
import { isGeneratedEnvironmentName } from "./environment-name.js";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import {
  commandDispatchNeedsCatalogue,
  planCommandDispatch,
  type CommandDispatchPlan,
} from "./native-agent-command-dispatch.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import { beginChangeTrackingTurn } from "./native-agent-change-tracking.js";
import {
  beginArtifactDispatchTurn,
  settleArtifactDispatchTurn,
} from "./workflow-artifact-turns.js";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { composeDraftHoldsQueue } from "./compose-draft-occupancy.js";
import {
  sessionHeldDispatchModelUpdate,
  unofferedDispatchModelMessage,
} from "./native-agent-dispatch-model.js";
/**
 * An ensured session, plus the model substitution its creation made. The
 * substitution is reported to the caller only and is never persisted.
 */
export type EnsuredNativeAgentSession = PersistedNativeAgentSession & {
  modelSubstitution?: NativeAgentModelSubstitution;
};

/**
 * In-process marker that `trustedSessionInput` already prepended the coordinator
 * preamble to this input.
 *
 * The injection has to be idempotent: `dispatchPromptInternal` runs
 * `trustedSessionInput` and then hands the same object to `ensureSession`, which
 * runs it again. That used to be detected by testing the prompt for a leading
 * `<orkestrator-coordinator-context>`, which any caller could satisfy by
 * submitting text that opens with a block of their own — suppressing the real
 * authority block and substituting a forged one, which transcript stripping then
 * hid from view. A module-private symbol cannot be reached or serialized by a
 * caller across the JSON RPC boundary, so only this function can set it, while
 * object spreads inside the dispatch path carry it forward.
 */
const COORDINATOR_CONTEXT_APPLIED = Symbol("orkestrator.coordinatorContextApplied");

export class NativeAgentService {
  /** Orders publication admission against dispatch and Stop for this session only. */
  withSessionWorkFence<T>(
    input: NativeAgentProjectionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.promptQueues.withSessionWorkFence(input, operation);
  }

  /**
   * Wake the durable queue worker after an intent-level queue mutation.
   *
   * The periodic scan remains the crash/restart safety net, but a newly queued
   * interactive prompt should not wait for that timer. The worker owns all
   * provider I/O and its per-queue task map coalesces concurrent notifications.
   */
  /** Step 08 diagnostics for the keyed launch/queue driver (`null` on rollback). */
  schedulingStatus() {
    return this.promptQueues.schedulingStatus();
  }

  wakeEnvironment(environmentId: string): void {
    return this.promptQueues.wakeEnvironment(environmentId);
  }

  reconcileScheduling() {
    return this.promptQueues.reconcileScheduling();
  }

  notifyPromptQueueChanged(queueKey: string): void {
    return this.promptQueues.notifyPromptQueueChanged(queueKey);
  }

  /**
   * Drain one session's queue now, named by the session's own identity.
   *
   * The turn-end edge already knows which session became free; waiting for the
   * next two-second sweep to rediscover that is latency for nothing. A session
   * with no queue costs one storage read, and the drain coalesces with any
   * pass already running.
   */
  drainPromptQueueForSession(input: {
    agent?: BuildPipelineAgent;
    logicalSessionKey?: string;
  }): Promise<void> {
    return this.promptQueues.drainPromptQueueForSession(input);
  }

  /** Cached runtime providers, their bridge generations and their retirement. */
  private readonly providerRegistry: ProviderRegistry;
  /** Admits each prompt against a replacement or move of its environment. */
  private readonly environmentFence: NonNullable<NativeAgentServiceOptions["environmentFence"]>;

  getTranscriptUpdate(
    input: NativeAgentTranscriptUpdateInput,
  ): Promise<NativeAgentTranscriptUpdate> {
    return this.projections.getTranscriptUpdate(input);
  }

  getSessionStateUpdate(
    input: NativeAgentProgressiveInput,
  ): Promise<NativeAgentSessionStateUpdate> {
    return this.projections.getSessionStateUpdate(input);
  }

  getDiscoveryUpdate(input: NativeAgentDiscoveryUpdateInput): Promise<NativeAgentDiscoveryUpdate> {
    return this.projections.getDiscoveryUpdate(input);
  }

  getProjectionUpdate(
    input: NativeAgentProjectionUpdateInput,
  ): Promise<NativeAgentProjectionUpdate> {
    return this.projections.getProjectionUpdate(input);
  }

  getMessagePage(input: NativeAgentMessagePageInput): Promise<NativeAgentMessagePage> {
    return this.projections.getMessagePage(input);
  }

  getProjectionToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
  ): Promise<NativeAgentToolDetails> {
    return this.projections.getProjectionToolDetails(input);
  }

  /**
   * The last projection this process built for one session, if any. Purely
   * in-memory: never reads a provider or hydrates a transcript, so background
   * observers may consult it freely. It can be stale or absent.
   */
  cachedProjectionSnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): NativeAgentSessionProjection | null {
    return this.projections.cachedProjectionSnapshot(environmentId, agent, logicalSessionKey);
  }
  /** Projection-only model and command catalogues. */
  private readonly catalogs: NativeAgentCatalogCache;
  /** Renderer views of provider sessions and every cache behind them. */
  private readonly projections: NativeAgentTranscriptProjection;
  /** Pending approvals and questions: observation records and the monitor sweep. */
  private readonly interactions: NativeAgentInteractionTracker;
  /** Activity sweeps, exact turn edges and the startup-launch scan. */
  private readonly launches: NativeAgentLaunchActivityReconciler;
  /** Prompt-queue drains, session work fences and parked-dispatch settles. */
  private readonly promptQueues: NativeAgentPromptQueueDispatcher;
  sessionActivitySnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): AgentActivityState | "unknown" {
    return this.launches.sessionActivitySnapshot(environmentId, agent, logicalSessionKey);
  }

  /**
   * Activity as the *turn* consumers read it, with background work removed.
   *
   * {@link sessionActivitySnapshot} answers what the environment indicator
   * shows, and a bridge reports `working` there for as long as tasks the
   * session launched are alive — a backgrounded dev server or file watcher can
   * hold that for the rest of the session. The parent turn has still ended and
   * the composer is still free, which the bridge reports separately as
   * `readyForInput`.
   *
   * Everything that gates on "can this session take a prompt right now" must
   * read that release rather than the raw state. Mail injection only claims a
   * message for an `idle` mailbox, so without this collapse one long-lived
   * background process would silence a worker for as long as it runs.
   */
  sessionTurnActivitySnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): AgentActivityState | "unknown" {
    return this.launches.sessionTurnActivitySnapshot(environmentId, agent, logicalSessionKey);
  }

  /**
   * Whether one environment's bridge has an in-flight dispatch or a session
   * last observed working, waiting, or running background tasks.
   *
   * Uses the raw state, not the turn view: replacing the bridge kills its whole
   * process tree, so a backgrounded test run or dev server is lost just like a
   * turn. Purely in-memory apart from the session list; never reads a bridge.
   */
  hasObservedLiveWork(environmentId: string, agent: BuildPipelineAgent): Promise<boolean> {
    return this.launches.hasObservedLiveWork(environmentId, agent);
  }

  /**
   * Rebuild the durable environment activity projection from provider-owned
   * session state. This does not depend on a mounted tab or a renderer event.
   */
  /**
   * Run (or join) one activity sweep.
   *
   * `startedAfter` is for a consumer that needs an answer read *after* its
   * request — a demand for a post-dispatch or fresher observation. It passes
   * the sweep number it saw ({@link activityScanNumber}) when the demand was
   * made and joins a sweep in flight only if that sweep started later; a
   * sweep that started earlier may already have read the group, so every such
   * caller shares one follow-up sweep instead.
   */
  reconcileAgentActivity(options: { startedAfter?: number } = {}): Promise<void> {
    return this.launches.reconcileAgentActivity(options);
  }

  /** Fresh no-touch admission read, including background work and persisted sessions after reload. */
  hasActiveCheckoutWork(environmentId: string): Promise<boolean> {
    return this.launches.hasActiveCheckoutWork(environmentId);
  }

  /**
   * The shared observation for one session, reading only when the retained
   * one does not satisfy the demand.
   *
   * This is the entry point for consumers that need to know whether a
   * session is busy — workflows and queues (step 08), mail, the coordinator —
   * instead of issuing their own provider read. It never starts a bridge,
   * attaches, hydrates or touches liveness: a miss wakes the session's group
   * and runs (or queues one follow-up) activity sweep, which uses the no-touch
   * observer path. `requirePostDispatch` refuses any answer read before the
   * latest dispatch to the session, so a cached pre-dispatch idle can never
   * advance a pipeline. A failed read answers `recovering`, never idle.
   */
  observeSessionActivity(
    input: { environmentId: string; agent: BuildPipelineAgent; logicalSessionKey: string },
    demand: NativeAgentObservationDemand = {},
  ): Promise<NativeAgentObservationView> {
    return this.launches.observeSessionActivity(input, demand);
  }

  /** Wake one environment's provider group(s) for the next sweep. */
  wakeObservation(
    environmentId: string,
    reason: NativeAgentObservationWakeReason,
    agent?: BuildPipelineAgent,
  ): void {
    return this.launches.wakeObservation(environmentId, reason, agent);
  }

  /** Content-free observer state for diagnostics and the client's gap anchor. */
  observationStatus(): NativeAgentObservationStatus & { stamp: ViewRevisionStamp } {
    return this.launches.observationStatus();
  }

  reconcileInitialLaunch(environmentId: string): Promise<void> {
    return this.launches.reconcileInitialLaunch(environmentId);
  }
  private readonly scanTasks = new Set<Promise<void>>();
  /**
   * Shared observation records, dispatch/generation fences and next-due
   * provider groups (recurring-processes step 07). `observedSessionActivity`
   * above stays the edge state machine; the broker says how old, how
   * trustworthy and how reusable each answer is.
   */
  private readonly observations: NativeAgentObservationBroker;
  private unsubscribeObservationWakeups: (() => void) | null = null;
  /**
   * Automatic continuation of incomplete turns, for platforms with a recovery
   * strategy, and the manual-prompt claims that keep it from racing the user.
   */
  private readonly turnRecovery: NativeAgentTurnRecovery;

  sessionPendingInteractions(
    input: NativeAgentProjectionInput,
  ): Promise<AgentInteractionRequest[] | null> {
    return this.interactions.sessionPendingInteractions(input);
  }

  /**
   * A committed stop: the environment's bridges and their parked requests are
   * gone, so nothing may keep reporting them as pending (see
   * `NativeAgentTranscriptProjection.withdrawEnvironmentInteractions`).
   */
  withdrawEnvironmentInteractions(environmentId: string): void {
    this.interactions.withdrawEnvironment(environmentId);
    this.projections.withdrawEnvironmentInteractions(environmentId);
  }

  /**
   * Operational kill switch. Existing adopted sessions keep reconciling so a
   * request already observed is not stranded; no new session is adopted.
   */
  setInteractionMonitorAdoptionEnabled(enabled: boolean): void {
    return this.interactions.setInteractionMonitorAdoptionEnabled(enabled);
  }

  /** Bounded, content-free evidence suitable for diagnostics and tests. */
  getInteractionObservations(): AgentInteractionObservation[] {
    return this.interactions.getInteractionObservations();
  }

  /**
   * Reconcile provider-owned pending requests without applying policy.
   *
   * This is deliberately independent of renderer lifecycle and uses only
   * authoritative snapshots. Polling adapters have no subscribe/replay gap:
   * anything that arrives after one snapshot is recovered by the next.
   */
  reconcileAgentInteractions(): Promise<void> {
    return this.interactions.reconcileAgentInteractions();
  }
  private initialization: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: NativeAgentServiceOptions = {},
  ) {
    this.environmentFence = options.environmentFence ?? new EnvironmentMutationFence();
    this.catalogs = new NativeAgentCatalogCache({
      invoke,
      now: () => this.now(),
      announce: (environmentId) => {
        if (!this.stopped) this.storage.announceNativeAgentSessionProjection(environmentId);
      },
    });
    this.observations = new NativeAgentObservationBroker(() => this.now());
    this.providerRegistry = new ProviderRegistry({
      now: () => this.now(),
      isStopped: () => this.stopped,
      assertAcceptingWork: () => this.assertAcceptingWork(),
      assertEnvironmentLive: (environmentId) => this.assertEnvironmentLive(environmentId),
      options,
      observations: this.observations,
      bridgeConnection: (agent, environment, model, effort) =>
        this.bridgeConnection(agent, environment, model, effort),
      observeBridgeConnection: (agent, environment) =>
        this.observeBridgeConnection(agent, environment),
      createProvider: (connection, environmentId, cacheKey) =>
        createNativeAgentProvider(connection, {
          onObservationHint: () => this.observations.wakeGroup(cacheKey, "provider-event"),
          stageImages: (images) => this.stageImages(environmentId, images),
          environment: this.providerEnvironment(environmentId),
        }),
      forgetGroup: (cacheKey) => this.launches.forgetActivityGroup(cacheKey),
    });
    this.turnRecovery = new NativeAgentTurnRecovery({
      storage,
      now: () => this.now(),
      isStopped: () => this.stopped,
      assertAcceptingWork: () => this.assertAcceptingWork(),
      observeProvider: (input) => this.observeProvider(input),
      dispatchPrompt: (input, prepare) => this.dispatchPromptInternal(input, prepare),
      observedActivity: (key) => this.launches.observedActivity(key),
    });
    this.projections = new NativeAgentTranscriptProjection({
      storage,
      options,
      catalogs: this.catalogs,
      observedActivity: (sessionKey) => this.launches.observedActivity(sessionKey),
      providerGeneration: (input) =>
        this.providerRegistry.connectionIdentity(
          providerCacheKey(input.environmentId, input.agent),
        ),
      now: () => this.now(),
      isStopped: () => this.stopped,
      assertProjectionInput: (input) => this.assertProjectionInput(input),
      resolveProjectionSession: (input) => this.resolveProjectionSession(input),
      provider: (input) => this.provider(input),
      recordAsyncQuestionAttention: (environmentId, sessionKey, itemIds) =>
        this.recordAsyncQuestionAttention(environmentId, sessionKey, itemIds),
      scheduleAmbiguousDispatchSettle: (input, key, requestId, provider) =>
        this.promptQueues.scheduleAmbiguousDispatchSettle(input, key, requestId, provider),
      scheduleAmbiguousSteerSettle: (input, key, requestId, provider) =>
        this.promptQueues.scheduleAmbiguousSteerSettle(input, key, requestId, provider),
    });
    this.promptQueues = new NativeAgentPromptQueueDispatcher({
      storage,
      isStopped: () => this.stopped,
      trackScan: (task) => this.trackScan(task),
      refreshProjection: (input) => this.projections.refreshProjection(input, true),
      queueSessionObservedBusy: (environmentId, agent, logicalSessionKey, head) =>
        this.launches.queueSessionObservedBusy(environmentId, agent, logicalSessionKey, head),
      assertEnvironmentLive: (environmentId) => this.assertEnvironmentLive(environmentId),
      ensureSession: (input) => this.ensureSession(input),
      provider: (input) => this.provider(input),
      dispatchPrompt: (input) => this.dispatchPrompt(input),
      dispatchQueuedAsyncQuestionAnswer: (input, resolved, text, requestId) =>
        this.dispatchQueuedAsyncQuestionAnswer(input, resolved, text, requestId),
      recordObservedTurnOutcome: (session, status, detail, provider) =>
        this.recordObservedTurnOutcome(session, status, detail, provider),
      settleAmbiguousDispatch: (input, key, requestId, provider) =>
        this.settleAmbiguousDispatch(input, key, requestId, provider),
      settleAmbiguousSteer: (input, key, requestId, provider) =>
        this.settleAmbiguousSteer(input, key, requestId, provider),
    });
    this.launches = new NativeAgentLaunchActivityReconciler({
      storage,
      invoke,
      options,
      providerRegistry: this.providerRegistry,
      observations: this.observations,
      turnRecovery: this.turnRecovery,
      now: () => this.now(),
      isStopped: () => this.stopped,
      observeProvider: (input) => this.observeProvider(input),
      trackScan: (task) => this.trackScan(task),
      recordAsyncQuestionAttention: (environmentId, sessionKey, itemIds) =>
        this.recordAsyncQuestionAttention(environmentId, sessionKey, itemIds),
      dispatchPrompt: (input) => this.dispatchPrompt(input),
      dispatchPromptWithPreparation: (input, prepare) =>
        this.dispatchPromptInternal(input, prepare),
    });
    this.interactions = new NativeAgentInteractionTracker({
      storage,
      options,
      evictProvider: (session, provider) => this.providerRegistry.evict(session, provider),
      now: () => this.now(),
      isStopped: () => this.stopped,
      observeProvider: (input) => this.observeProvider(input),
      trackScan: (task) => this.trackScan(task),
      cachedProjectionSnapshot: (environmentId, agent, logicalSessionKey) =>
        this.projections.cachedProjectionSnapshot(environmentId, agent, logicalSessionKey),
    });
    /*
     * Durable session mutations wake the affected provider group. Only a
     * backed-off group is affected at all — every other group is read on
     * every sweep — so this is a cheap hint, never a read of its own.
     * Optional because narrow test doubles of the storage omit listeners.
     */
    this.unsubscribeObservationWakeups =
      typeof storage.addResourceChangeListener === "function"
        ? storage.addResourceChangeListener((change) => {
            // Step 08: queue mutations and environment changes (readiness,
            // identity, launch intent) wake only their own due keys.
            if (change.resource === "prompt-queue") {
              this.promptQueues.queueChanged(change.id);
              return;
            }
            if (change.resource === "environment") {
              this.promptQueues.wakeEnvironment(change.id);
              return;
            }
            if (change.resource !== "native-agent-session") return;
            this.observations.wakeEnvironment(change.id, "session-mutation", change.agent);
          })
        : null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Resolve a provider, starting its bridge if needed. */
  private provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider> {
    return this.providerRegistry.resolve(input);
  }

  /** Resolve a provider for observation only, never starting a bridge. */
  private observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined> {
    return this.providerRegistry.observe(input);
  }

  /**
   * The environment an interactive provider serves. The provider factory
   * derives platform-specific dependencies from it (per-environment on-disk
   * state under the backend data directory, for example). Every creation site
   * that can cache a tab's provider passes it: whichever one caches the
   * provider serves the tab, so the observer and tab-close paths must not pass
   * less than the tab path does. Storage doubles without a data directory get
   * no on-disk provider state.
   */
  private providerEnvironment(environmentId: string): NativeAgentProviderEnvironment {
    // Read per call rather than per provider: providers are cached for the
    // life of a bridge connection, so a settings edit would otherwise not
    // reach the model catalogue until the environment restarted.
    const loadConfig = () => this.storage.loadConfig();
    const guidance = this.options.signInGuidance;
    const signInGuidance = guidance
      ? { signInGuidance: (agent: string) => guidance(environmentId, agent) }
      : {};
    return typeof this.storage.getDataDir === "function"
      ? { environmentId, dataDir: this.storage.getDataDir(), loadConfig, ...signInGuidance }
      : { environmentId, loadConfig, ...signInGuidance };
  }

  /** Stage base64 images into the workspace so a bridge will accept them. */
  private async stageImages(
    environmentId: string,
    images: readonly TaskSnapshotImage[],
  ): Promise<PromptAttachment[]> {
    // A coordinator's workspace is the user's own checkout, and the synthesized
    // environment behind it carries that path like any other worktree. Staging
    // there would have a read-only session write files into the repository it
    // exists not to touch, so its images go to the same application-data
    // directory a pasted attachment uses — the one root the bridge is
    // launched able to read besides the checkout.
    const coordinator = await resolveCoordinatorRuntime(this.storage, environmentId);
    if (coordinator.status === "unavailable") {
      throw new Error(coordinatorRuntimeUnavailableMessage(coordinator));
    }
    if (coordinator.status === "ready") {
      const staged: PromptAttachment[] = [];
      for (const image of assertValidPromptImages(images)) {
        const path = await this.storage.writeCoordinatorAttachment(
          coordinator.coordinatorId,
          coordinator.conversationId,
          image.filename,
          image.data,
        );
        staged.push({
          type: "image",
          path,
          filename: image.filename,
          dataUrl: `data:${mimeTypeForImageData(image.filename, image.data)};base64,${image.data}`,
        });
      }
      return staged;
    }
    const environment = await this.assertEnvironmentLive(environmentId);
    return stagePromptImages(this.invoke, environment, images, INITIAL_PROMPT_STAGING_DIRECTORY);
  }

  private async bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
    model?: string,
    effort?: string,
  ): Promise<BridgeConnection> {
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${agent}_server_cmd`,
        { environmentId: environment.id },
      );
      if (!result.authToken) {
        throw new Error(`${agent} bridge authentication is unavailable`);
      }
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        ...(agent === "claude" || agent === "codex"
          ? {
              accountId:
                this.options.localBridgeAccountId?.(`${agent}:${environment.id}`) ?? "unknown",
            }
          : {}),
        directory: environment.worktreePath,
        model,
        effort,
      };
    }

    if (!environment.containerId) {
      throw new Error("Native agent container is unavailable");
    }
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${agent}_server`,
      { containerId: environment.containerId },
    );
    if (!result.authToken) {
      throw new Error(`${agent} bridge authentication is unavailable`);
    }
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
      ...(agent === "claude" || agent === "codex" ? { accountId: "unknown" } : {}),
      model,
      effort,
    };
  }

  /**
   * Bridge coordinates for an already-running bridge, or `undefined`.
   *
   * The peek commands are the read-only twins of the start commands: they
   * report a live, authenticated bridge and never spawn one. Anything that
   * cannot be answered without starting a process is reported as "not running"
   * rather than started on the observer's behalf.
   */
  private async observeBridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
  ): Promise<BridgeConnection | undefined> {
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken: string } | null>(
        "peek_local_agent_bridge",
        { environmentId: environment.id, agent },
      );
      if (!result?.authToken) return undefined;
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        ...(agent === "claude" || agent === "codex"
          ? {
              accountId:
                this.options.localBridgeAccountId?.(`${agent}:${environment.id}`) ?? "unknown",
            }
          : {}),
        directory: environment.worktreePath,
      };
    }

    if (!environment.containerId) return undefined;
    const result = await this.invoke<{ hostPort: number; authToken: string } | null>(
      "peek_container_agent_bridge",
      {
        containerId: environment.containerId,
        agent,
      },
    );
    if (!result?.authToken) return undefined;
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
      ...(agent === "claude" || agent === "codex" ? { accountId: "unknown" } : {}),
    };
  }

  /** Resolve coordinator authority from persisted ownership, never caller metadata. */
  private async trustedSessionInput<T extends EnsureNativeAgentSessionInput>(input: T): Promise<T> {
    const coordinator = await resolveCoordinatorRuntime(this.storage, input.environmentId);
    if (coordinator.status === "not-coordinator") {
      const environment = await this.storage.getEnvironment(input.environmentId);
      const existing = await this.storage.getNativeAgentSession(
        nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      );
      return {
        ...input,
        ...(environment
          ? {
              owner: {
                kind: "environment" as const,
                projectId: environment.projectId,
                environmentId: environment.id,
              },
            }
          : {}),
        executionPolicy: existing?.executionPolicy,
        ...(environment
          ? {
              policy:
                existing?.policy ??
                resolveNativeAgentExecutionPolicy(
                  environment,
                  input.origin ?? "interactive-native",
                  environment.agentSettings?.executionPolicy,
                ),
            }
          : { policy: undefined }),
      };
    }
    if (coordinator.status === "unavailable") {
      throw new Error(coordinatorRuntimeUnavailableMessage(coordinator));
    }
    const { coordinatorId, workspace } = coordinator;
    const existing = await this.storage.getNativeAgentSession(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
    );
    // The persisted conversation decides the platform, never the caller. The
    // resolver has already rejected an unassigned conversation and one whose
    // platform is no longer qualified, so a mismatch here is a caller pointing
    // at somebody else's session.
    if (coordinator.conversation.agent !== input.agent) {
      throw new Error("Coordinator conversation is unavailable");
    }
    if (
      workspace.repositoryStatus?.operationState !== undefined &&
      workspace.repositoryStatus.operationState !== "idle"
    ) {
      throw new Error("The project checkout is changing; wait for the Git operation to finish");
    }
    const research = await loadCoordinatorResearch(this.storage);
    const webResearch = research.mode;
    const trusted = {
      ...input,
      origin: "coordinator",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      owner: { kind: "coordinator", projectId: workspace.projectId, coordinatorId },
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      // Resolved fresh rather than read from the record: the coordinator
      // policy is never user-overridable, and its only variable part is the
      // research setting, which applies from the next turn. OpenCode has no
      // bridge to hold process authority, so this is what it runs under.
      policy: resolveNativeAgentExecutionPolicy(
        { environmentType: "local", networkAccessMode: "restricted" },
        "coordinator",
        undefined,
        webResearch,
      ),
    };
    if (
      existing &&
      existing.policy &&
      JSON.stringify(existing.policy) !== JSON.stringify(trusted.policy)
    ) {
      // Only the research exception may change on a coordinator conversation.
      // All ownership and other policy fields still pass the normal identity
      // check. Never turn an unrelated or forged policy into coordinator authority.
      const oldAllow = existing.policy.capabilityPolicy?.allow;
      if (oldAllow?.some((capability) => capability !== "web.search")) {
        throw new Error("Native agent session key collision");
      }
      this.assertSessionIdentity(
        existing,
        {
          ...trusted,
          policy: {
            ...trusted.policy,
            capabilityPolicy: { ...trusted.policy.capabilityPolicy, allow: oldAllow },
          },
        },
        existing.key,
      );
      // Resolve launcher authority before recording the change. A busy bridge
      // refuses replacement; session-held permissions apply explicitly.
      const provider = await this.provider(trusted);
      if (provider.synchronizeSessionPolicy) {
        const { status } = await readProviderStatus(provider, existing.providerSessionId);
        // A missing provider session is replaced by ensureSession below.
        if (status !== "missing") {
          await provider.synchronizeSessionPolicy(existing.providerSessionId, trusted.policy);
        }
      }
      await this.storage.transitionCoordinatorResearchPolicy(
        existing,
        trusted.policy,
        trusted.owner,
      );
    }
    if (
      "prompt" in input &&
      typeof input.prompt === "string" &&
      !(COORDINATOR_CONTEXT_APPLIED in input)
    ) {
      const status = workspace.repositoryStatus;
      // Workers start where a normal environment would: the latest commit of
      // the configured base branch, not wherever this checkout happens to be.
      const baseBranch = await this.storage
        .getRepositoryConfig(workspace.projectId)
        .then((config) => config.defaultBranch?.trim() || "main")
        .catch(() => "main");
      const launchBaseLine =
        `Launch base: every launch_environment call must include baseBranch and baseCommit. By default start workers from the latest commit of the base branch ${baseBranch}: call get_launch_options and pass coordinatorBase.baseBranch and coordinatorBase.baseCommit unchanged. ` +
        `Use checkoutBase, the branch and commit of this checkout shown below, only when the user asks to build on the current checkout. If coordinatorBase is unavailable, report that instead of guessing values.\n`;
      const side = coordinator.conversation.role === "side";
      const nodeLine = (await this.options.coordinatorNodeContext?.().catch(() => null)) ?? "";
      const delegation = side
        ? `Side agent: you are ${coordinator.conversation.title}, a side agent of this project's coordinator. You can read the project and Orkestrator state, but you cannot launch environments or jobs. Exchange mail only with the main coordinator: send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}". Workers and other agents cannot reach you.\n`
        : this.options.coordinatorDelegationAvailable?.(coordinator.conversation.agent)
          ? `Main coordinator: every worker in this project reports to you. Side agents (Side 1, Side 2…) may mail you; reach one with send_message to its environment id from list_mailboxes. Message a worker by its environment id; toTabId is optional.\n` +
            `Delegation: create workers with the Orkestrator launch_environment tool. Provider sub-agents remain inside this coordinator session and are not worker environments. Report a worker as created only after launch_environment returns its environment id.\n` +
            `Actions: prefer launch_multi_review for the complete environment Multi Review button action; start_multi_review starts backend work only and does not open a tab. Use open_multi_review and open_multi_review_fix to present saved work. Reuse requestId on retry, and inspect outcome, ui and recovery before reporting completion.\n` +
            launchBaseLine +
            `${COORDINATOR_LAUNCH_DEFAULTS_RULE}\n` +
            `${COORDINATOR_ASYNC_CONTRACT}\n`
          : `Delegation: Orkestrator worker controls are unavailable in this session. Provider sub-agents remain inside this coordinator session and are not worker environments; do not report them as workers.\n`;
      return {
        ...trusted,
        [COORDINATOR_CONTEXT_APPLIED]: true,
        prompt:
          `${COORDINATOR_CONTEXT_OPEN_TAG}\n` +
          `Project: ${workspace.projectId}\n` +
          `Coordinator: ${coordinatorId}\n` +
          `Role: read-only coordinator. Research, inspect and plan here; delegate all file changes, commands that mutate the checkout, builds, and fixes to worker environments through approved Orkestrator controls. Never attempt to alter the project checkout directly.\n` +
          `Scope: keep your own work to quick reads, searches and lookups. Anything more serious (a multi-file investigation, running builds or tests, reproducing a bug, writing or reviewing code in depth) belongs in a worker environment you launch, even when it only reads.\n` +
          coordinatorResearchLine(research) +
          nodeLine +
          `Tools: report a tool as unavailable or denied only after you called it and the call was refused; never assume a refusal you have not seen.\n` +
          delegation +
          `Repository context revision: ${workspace.repositoryContextRevision}\n` +
          `Branch: ${status?.branch ?? "unknown"}\n` +
          `Commit: ${status?.headCommit ?? "unknown"}\n` +
          `${COORDINATOR_CONTEXT_CLOSE_TAG}\n\n${input.prompt}`,
      } as T;
    }
    return trusted;
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

  private async initialize(): Promise<void> {
    await this.repairPersistedStartupTabs().catch(() => undefined);
    await Promise.allSettled([
      this.trackScan(this.launches.launchScan()),
      this.trackScan(this.promptQueues.queueScan()),
    ]);
    if (this.stopped) return;
    const launchReconcileIntervalMs = this.options.launchReconcileIntervalMs;
    const progressMs = Number.isFinite(launchReconcileIntervalMs)
      ? Math.max(20, launchReconcileIntervalMs as number)
      : 2_000;
    if (this.options.keyedQueueScheduling ?? keyedSchedulingEnabled("native-queues")) {
      this.promptQueues.startKeyedScheduling(() => this.launches.countedLaunchScan(), {
        progressIntervalMs: progressMs,
        // Safety discovery. A test that shortens the launch cadence keeps
        // discovery at that cadence; production uses the 30 s interval.
        discoveryIntervalMs:
          this.options.queueDiscoveryIntervalMs ??
          (Number.isFinite(launchReconcileIntervalMs) ? progressMs : DEFAULT_WORKFLOW_DISCOVERY_MS),
        ...(this.options.queueSchedulerClock
          ? {
              now: this.options.queueSchedulerClock.now,
              timers: this.options.queueSchedulerClock.timers,
            }
          : {}),
      });
    } else {
      this.launches.startTimer(progressMs, () => this.promptQueues.queueScan());
    }
    await this.interactions.start();
  }

  /**
   * Upgrade only a still-present canonical startup tab from the historical
   * provider-specific terminal record to the native pane identity. Missing
   * tabs are left missing because their absence may be an intentional close,
   * and a tab that already holds the native identity is left completely alone:
   * this runs on every backend start, so touching a healthy tab would be a
   * recurring rewrite of state this repair does not own.
   */
  private async repairPersistedStartupTabs(): Promise<void> {
    const sessions = (await this.storage.listNativeAgentSessions())
      .filter(
        (session) =>
          session.origin === "interactive-native" &&
          session.logicalSessionKey === `env-${session.environmentId}:startup-agent`,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const repairedEnvironments = new Set<string>();
    for (const session of sessions) {
      if (this.stopped) return;
      if (repairedEnvironments.has(session.environmentId)) continue;
      repairedEnvironments.add(session.environmentId);
      await this.storage
        .ensureStartupNativeAgentTab({
          environmentId: session.environmentId,
          agent: session.agent,
          providerSessionId: session.providerSessionId,
          existingOnly: true,
          upgradeOnly: true,
        })
        .catch(() => undefined);
    }
  }

  async ensureSession(input: EnsureNativeAgentSessionInput): Promise<EnsuredNativeAgentSession> {
    input = await this.trustedSessionInput(input);
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId) ||
      !nonBlank(input.logicalSessionKey) ||
      !BUILD_PIPELINE_AGENTS.includes(input.agent) ||
      !isValidInteractionMetadata(input)
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
      const { status } = await readProviderStatus(provider, existing.providerSessionId);
      await this.assertEnvironmentLive(input.environmentId);
      if (status !== "missing") {
        // Restate session-held authority even after a backend restart. Providers
        // with process-held authority were refreshed by the launcher above.
        if (input.owner?.kind === "coordinator" && input.policy) {
          await provider.synchronizeSessionPolicy?.(existing.providerSessionId, input.policy);
        }
        if (
          ((!existing.owner || !existing.policy) && input.owner) ||
          (!existing.initialPromptPresentation && input.initialPromptPresentation)
        ) {
          const enriched = await this.storage.adoptNativeAgentSession({
            key,
            environmentId: input.environmentId,
            agent: input.agent,
            logicalSessionKey: input.logicalSessionKey,
            providerSessionId: existing.providerSessionId,
            origin: existing.origin,
            interactionPolicy: existing.interactionPolicy,
            owner: input.owner,
            executionPolicy: input.executionPolicy,
            policy: input.policy,
            initialPromptPresentation: input.initialPromptPresentation,
          });
          void this.interactions.reconcileAgentInteractions().catch(() => undefined);
          return enriched;
        }
        void this.interactions.reconcileAgentInteractions().catch(() => undefined);
        return existing;
      }
      await this.storage.invalidateNativeAgentSession(key, existing.providerSessionId);
    }
    /*
     * Create the provider session under the native-agent lock alone.
     *
     * `getOrCreateNativeAgentSession` deliberately holds *that* lock across the
     * external create, so two backend processes cannot mint two real provider
     * sessions for one logical key. It does not need the global environments
     * lock as well: it re-asserts the environment both before and after the
     * create, which is a strictly stronger fence than the single up-front check
     * `runWithLiveEnvironment` performed.
     *
     * Holding the environments lock here was the same contention bug the
     * dispatch path fixed, on a slower path: a cold agent start runs up to four
     * session-create attempts with backoff, and every second of that stalled
     * activity, unread and deletion bookkeeping for *every* environment.
     */
    /*
     * Only an inherited default is resolved; an explicit model stays pinned
     * and lets dispatch report its availability. A configured
     * default can name a provider this login has not connected, and storing it
     * as the session's controls would outrank the runtime's own default and
     * reject the first prompt. An unset one resolves to the runtime's effective
     * default. Either answer is stored on this session only; the configuration
     * keeps the user's choice.
     */
    const resolution =
      !input.model || input.model === "default" || input.modelSource === "default"
        ? await this.resolveDefaultModel(provider, input.model)
        : undefined;
    const modelSubstitution = resolution?.substitution;
    if (resolution?.modelId) input = { ...input, model: resolution.modelId };
    const session = await this.storage.getOrCreateNativeAgentSession(
      {
        key,
        environmentId: input.environmentId,
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
        origin: input.origin,
        interactionPolicy: input.interactionPolicy,
        controls: controlsFromSessionInput(input),
        owner: input.owner,
        executionPolicy: input.executionPolicy,
        policy: input.policy,
        initialPromptPresentation: input.initialPromptPresentation,
      },
      () => this.createProviderSession(provider, input),
    );
    void this.interactions.reconcileAgentInteractions().catch(() => undefined);
    // A concurrent ensure may have created the session first, with its own
    // controls; only report a substitution this session actually carries.
    return modelSubstitution && session.controls?.modelId === modelSubstitution.modelId
      ? { ...session, modelSubstitution }
      : session;
  }

  /**
   * Apply a dispatch's explicit model to a runtime whose prompts carry none
   * (`runsSessionHeldModel`), the way a model pick is applied: through a
   * control update under the admission/delivery lease, after replay and
   * conflict checks and before anything is journaled. A model the login's live
   * catalogue positively does not offer is refused here with the draft intact,
   * rather than reaching the runtime and failing there.
   * See `native-agent-dispatch-model.ts`.
   */
  private async applySessionHeldDispatchModel(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
  ): Promise<NativeAgentControlUpdate | undefined> {
    const update = sessionHeldDispatchModelUpdate(input, session);
    if (!update?.modelId) return undefined;
    const availability = await this.resolveDefaultModel(provider, update.modelId);
    if (availability?.substitution) {
      throw new PromptRejectedError(
        unofferedDispatchModelMessage(session.agent, update.modelId, availability.substitution),
      );
    }
    await provider.updateInteractiveControls?.(session.providerSessionId, update);
    return update;
  }

  private async resolveDefaultModel(
    provider: NativeAgentRuntimeProvider,
    modelId: string | undefined,
  ): Promise<NativeAgentDefaultModelResolution | undefined> {
    if (!provider.resolveDefaultModel) return undefined;
    try {
      return await provider.resolveDefaultModel(modelId);
    } catch {
      // Connectivity is advisory here. Dispatch preflight still reports a
      // model the runtime cannot serve.
      return undefined;
    }
  }

  async adoptSession(input: AdoptNativeAgentSessionInput): Promise<PersistedNativeAgentSession> {
    return this.promptQueues.withSessionMutationFence(input, () =>
      this.adoptSessionUnderFence(input),
    );
  }

  private async adoptSessionUnderFence(
    input: AdoptNativeAgentSessionInput,
  ): Promise<PersistedNativeAgentSession> {
    input = await this.trustedSessionInput(input);
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId) ||
      !nonBlank(input.logicalSessionKey) ||
      !nonBlank(input.providerSessionId) ||
      !BUILD_PIPELINE_AGENTS.includes(input.agent) ||
      !isValidInteractionMetadata(input) ||
      (input.expectedProviderSessionId !== undefined && !nonBlank(input.expectedProviderSessionId))
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
    // Acquisition and last-owner close share a lifecycle fence. Recheck liveness
    // after waiting: a close may have completed while this adoption was queued.
    return withProviderSessionTeardownLock(
      this.storage,
      input.environmentId,
      input.agent,
      input.providerSessionId,
      async () => {
        provider.registerSession?.(input.providerSessionId, {
          origin: input.origin ?? "interactive-native",
          interactionPolicy:
            input.interactionPolicy ??
            (input.origin === "build-pipeline" || input.origin === "looped-review"
              ? UNATTENDED_AGENT_INTERACTION_POLICY
              : INTERACTIVE_AGENT_INTERACTION_POLICY),
          phase: input.phase,
        });
        // Same liveness-only rule as ensureSession: a failed last turn is not a
        // missing session, and adopting one must still succeed.
        const { status } = await readProviderStatus(provider, input.providerSessionId);
        await this.assertEnvironmentLive(input.environmentId);
        if (status === "missing") {
          throw new NativeAgentProviderSessionMissingError();
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
          owner: input.owner,
          executionPolicy: input.executionPolicy,
          policy: input.policy,
          initialPromptPresentation: input.initialPromptPresentation,
          expectedProviderSessionId: input.expectedProviderSessionId,
        });
        void this.interactions.reconcileAgentInteractions().catch(() => undefined);
        return session;
      },
    );
  }

  /**
   * Render a backend-owned provider session without persisting a native-agent
   * mapping. Build pipelines retain the authoritative identity and lifecycle,
   * so persisting this inspection would make historical stages participate in
   * the native-session activity and interaction sweeps forever.
   */
  async inspectSession(
    input: InspectNativeAgentSessionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    input = await this.trustedSessionInput(input);
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId) ||
      !nonBlank(input.logicalSessionKey) ||
      !nonBlank(input.providerSessionId) ||
      !BUILD_PIPELINE_AGENTS.includes(input.agent) ||
      !isValidInteractionMetadata(input) ||
      (input.refreshUsage !== undefined && typeof input.refreshUsage !== "boolean")
    ) {
      throw new Error("Invalid native agent session inspection request");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    await this.assertEnvironmentLive(input.environmentId);
    const provider = await this.provider(input);
    const origin = input.origin ?? "interactive-native";
    const interactionPolicy =
      input.interactionPolicy ??
      (origin === "build-pipeline" || origin === "looped-review"
        ? UNATTENDED_AGENT_INTERACTION_POLICY
        : INTERACTIVE_AGENT_INTERACTION_POLICY);
    provider.registerSession?.(input.providerSessionId, {
      origin,
      interactionPolicy,
      phase: input.phase,
    });
    const { status } = await readProviderStatus(provider, input.providerSessionId);
    await this.assertEnvironmentLive(input.environmentId);
    if (status === "missing") {
      throw new NativeAgentProviderSessionMissingError();
    }
    const timestamp = new Date(this.now()).toISOString();
    const session: PersistedNativeAgentSession = {
      version: NATIVE_AGENT_SESSION_VERSION,
      key,
      environmentId: input.environmentId,
      agent: input.agent,
      logicalSessionKey: input.logicalSessionKey,
      providerSessionId: input.providerSessionId,
      origin,
      interactionPolicy,
      controls: input.controls ?? controlsFromSessionInput(input),
      owner: input.owner,
      executionPolicy: input.executionPolicy,
      policy: input.policy,
      initialPromptPresentation: input.initialPromptPresentation,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.projections.refreshProjection(
      {
        environmentId: input.environmentId,
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
        refreshUsage: input.refreshUsage,
      },
      true,
      { key, session, provider, transient: true },
    );
  }

  async getProjection(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    this.assertProjectionInput(input);
    return this.projections.refreshProjection(input, true);
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
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(sessionKey);
    if (session) this.assertSessionIdentity(session, input, sessionKey);
    const provider = await this.provider(input);
    // Discard in-flight discovery rather than waiting for it. Awaiting it would
    // only make this explicit user action inherit the latency of the very work
    // it just discarded — up to a full bridge request timeout.
    this.catalogs.invalidateModels(input.environmentId);
    this.catalogs.invalidateCommands(input, session?.providerSessionId);
    // Best-effort, and dropped *after* the caches above rather than before.
    // Some providers answer this by reaching their bridge process — Pi has to,
    // because its `ModelRuntime` owns a credential snapshot this side cannot
    // invalidate — so it can fail for reasons that have nothing to do with the
    // local caches. The in-flight discovery has already been discarded, so
    // throwing here would leave the refresh both failed *and* stale, which is
    // strictly worse than the partial refresh this did when it could not throw
    // at all. Re-listing against a bridge that did not refresh still gives the
    // best answer that bridge can produce.
    //
    // try/catch rather than `.catch`: the contract allows a synchronous
    // implementation — OpenCode's returns `void` — so there is not always a
    // promise to attach to, and a synchronous throw has to be caught too.
    try {
      await provider.refreshCatalog?.();
    } catch (error) {
      console.warn(`[native-agent] ${input.agent} catalogue refresh failed:`, error);
    }
    return this.projections.refreshProjection(input, true);
  }

  /**
   * Explicit command refresh for one session.
   *
   * Asks the provider to reload what it can, re-reads the catalogue, and says
   * which of those actually happened — a push-only provider cannot claim a
   * reload. Never restarts a provider and never cancels its work.
   */
  async refreshProjectionCommands(input: NativeAgentProjectionInput): Promise<{
    outcome: NativeAgentCommandRefreshOutcome;
    message?: string;
    projection: NativeAgentSessionProjection | null;
  }> {
    this.assertProjectionInput(input);
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(sessionKey);
    if (session) this.assertSessionIdentity(session, input, sessionKey);
    const capabilities = nativeCapabilities(input.agent);
    // No stored session means no projection to show a catalogue in (see
    // `resolveProjectionSession`), so there is nothing to reload and no
    // provider is started or read.
    if (!session) {
      return capabilities.slashCommands
        ? {
            outcome: "failed",
            message: "The agent session has not started yet, so there are no commands to refresh.",
            projection: null,
          }
        : { outcome: "unsupported", projection: null };
    }
    const provider = await this.provider(input);
    const supported =
      capabilities.slashCommands && Boolean(provider.slashCommands || provider.commandCatalogue);
    const result = supported
      ? await this.catalogs.refreshCommands(input, provider, session.providerSessionId)
      : { outcome: "unsupported" as const };
    this.projections.invalidateProjection(sessionKey);
    return { ...result, projection: await this.projections.refreshProjection(input, true) };
  }

  /** Called when an environment is deleted; never on tab unmount or switch. */
  forgetEnvironmentCommandCatalogues(environmentId: string): void {
    this.catalogs.forgetEnvironmentCommands(environmentId);
  }

  async listProjectionModels(input: NativeAgentProjectionInput): Promise<AgentModel[]> {
    this.assertProjectionInput(input);
    const provider = await this.provider(input);
    return provider.modelCatalog ? (await provider.modelCatalog()).slice(0, 512) : [];
  }

  /**
   * Read the bounded raw OpenCode catalogue for durable cache refreshes.
   *
   * Picker-facing callers must continue using `listProjectionModels`, which
   * applies the configured provider allowlist. The cache deliberately retains
   * the wider source catalogue so a provider added later is available to launch
   * dialogs before an environment starts another bridge.
   */
  async listModelCatalogForCache(input: NativeAgentProjectionInput): Promise<AgentModel[]> {
    this.assertProjectionInput(input);
    const provider = await this.provider(input);
    if (provider.rawModelCatalog) {
      return (await provider.rawModelCatalog()).slice(0, 512);
    }
    return provider.modelCatalog ? (await provider.modelCatalog()).slice(0, 512) : [];
  }

  /**
   * Providers the runtime reports as connected, for the durable catalogue
   * snapshot. Undefined when the runtime does not report connectivity.
   */
  async connectedModelProviders(input: NativeAgentProjectionInput): Promise<string[] | undefined> {
    this.assertProjectionInput(input);
    const provider = await this.provider(input);
    return provider.connectedModelProviders?.();
  }

  async dispatchIntent(input: DispatchNativeAgentPromptInput): Promise<NativeAgentDispatchOutcome> {
    return this.dispatchIntentInternal(input, false);
  }
  private async dispatchIntentInternal(
    input: DispatchNativeAgentPromptInput,
    preserveExistingPending: boolean,
  ): Promise<NativeAgentDispatchOutcome> {
    return this.promptQueues.withSessionMutationIntent(input, () =>
      this.dispatchIntentUnderIntent(input, preserveExistingPending),
    );
  }

  private async dispatchIntentUnderIntent(
    input: DispatchNativeAgentPromptInput,
    preserveExistingPending: boolean,
  ): Promise<NativeAgentDispatchOutcome> {
    input = await this.trustedSessionInput(input);
    // A manual prompt to a session with automatic turn recovery claims it
    // first, so a stale automatic continuation cannot be sent alongside.
    let manualClaimSession: PersistedNativeAgentSession | null = null;
    try {
      if (this.turnRecovery.appliesTo(input)) {
        manualClaimSession = await this.ensureSession(input);
        await this.turnRecovery.claimManualPrompt({
          environmentId: input.environmentId,
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualClaimSession.providerSessionId,
          requestId: input.requestId,
        });
      }
      return await this.attemptDispatch(input, true, preserveExistingPending);
    } catch (error) {
      // Everything before the first dispatch attempt: session creation, the
      // manual-prompt claim. A normal send has no earlier record to preserve;
      // an explicit recovery retry does, and must leave it parked on failure.
      if (!preserveExistingPending) {
        await this.storage
          .clearPendingNativeAgentDispatch(
            nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
            input.requestId,
          )
          .catch(() => false);
      }
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Prompt dispatch failed",
      };
    } finally {
      if (manualClaimSession) {
        this.turnRecovery.releaseManualPrompt({
          environmentId: input.environmentId,
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualClaimSession.providerSessionId,
          requestId: input.requestId,
        });
      }
    }
  }

  /**
   * One dispatch attempt, plus a single bounded retry once a stale block has
   * been cleared.
   *
   * `allowRecoveryRetry` is what bounds it. A prompt refused because an earlier
   * dispatch is still parked can legitimately proceed the moment that parked
   * record is settled against the provider — but only once, so a session that
   * keeps re-parking cannot drive an unbounded dispatch loop.
   */
  private async attemptDispatch(
    input: DispatchNativeAgentPromptInput,
    allowRecoveryRetry: boolean,
    preserveExistingPending: boolean,
  ): Promise<NativeAgentDispatchOutcome> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    try {
      await this.dispatchPromptInternal(input, undefined, true);
      void this.projections.refreshProjection(input, true).catch(() => undefined);
      return { outcome: "accepted", requestId: input.requestId };
    } catch (error) {
      if (error instanceof PendingNativeAgentDispatchError) {
        // The only thing refusing this prompt is an older dispatch nobody has
        // resolved. If the provider can prove that one landed, or that it never
        // will (retired), the block was stale and this prompt was never in
        // conflict with anything.
        if (
          allowRecoveryRetry &&
          (await this.settleAmbiguousDispatch(input, key, error.pendingRequestId))
        ) {
          return this.attemptDispatch(input, false, preserveExistingPending);
        }
        void this.projections.refreshProjection(input, true).catch(() => undefined);
        return { outcome: "rejected", error: PARKED_DISPATCH_CONFLICT_MESSAGE };
      }
      if (error instanceof PendingNativeAgentSteerError) {
        if (
          allowRecoveryRetry &&
          (await this.settleAmbiguousSteer(input, key, error.pendingRequestId))
        ) {
          return this.attemptDispatch(input, false, preserveExistingPending);
        }
        void this.projections.refreshProjection(input, true).catch(() => undefined);
        return { outcome: "rejected", error: PARKED_DISPATCH_CONFLICT_MESSAGE };
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        // Ask the provider before handing the ambiguity to the user. A lost
        // acknowledgement is not the same fact as a lost prompt, and the
        // provider's own dispatch journal can usually tell the two apart.
        const settled = await this.settleAmbiguousDispatch(input, key, input.requestId);
        if (settled === "confirmed") {
          void this.projections.refreshProjection(input, true).catch(() => undefined);
          return { outcome: "accepted", requestId: input.requestId };
        }
        if (settled === "retired") {
          // The bridge restarted under this very request and will refuse the
          // id for good: the same answer a retry would get, without the card.
          void this.projections.refreshProjection(input, true).catch(() => undefined);
          return {
            outcome: "rejected",
            error: dispatchOutcomeLostMessage(input.agent),
            requestIdRetired: true,
          };
        }
        void this.projections.refreshProjection(input, true).catch(() => undefined);
        return {
          outcome: "unknown",
          requestId: input.requestId,
          error: error.message,
        };
      }
      // A retry of an id the bridge has retired can never succeed, so the
      // parked record is resolved here too rather than left asking for one.
      const retired = error instanceof PromptRejectedError && error.requestIdRetired;
      if (!preserveExistingPending || retired) {
        await this.storage.clearPendingNativeAgentDispatch(key, input.requestId).catch(() => false);
      }
      if (retired) void this.projections.refreshProjection(input, true).catch(() => undefined);
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Prompt dispatch failed",
        ...(retired ? { requestIdRetired: true as const } : {}),
      };
    }
  }

  /**
   * Discard a parked dispatch without sending it.
   *
   * The other half of the recovery choice: retrying re-offers the prompt under
   * the same idempotency key, discarding accepts that it may have run and stops
   * blocking the session. Deliberately requires the exact request id the caller
   * was shown, so a stale tab cannot drop a newer parked dispatch it never saw.
   */
  async discardRecoverableDispatch(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<{ discarded: boolean }> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.requestId)) {
      throw new Error("Recoverable native agent request ID must not be blank");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    const discarded =
      session?.pendingSteer?.requestId === input.requestId
        ? await this.storage.clearPendingNativeAgentSteer(key, input.requestId, true)
        : await this.storage.clearPendingNativeAgentDispatch(key, input.requestId);
    if (discarded) {
      void this.projections.refreshProjection(input, true).catch(() => undefined);
    }
    return { discarded };
  }

  /**
   * Settle a parked dispatch against the provider's own journal.
   *
   * A dispatch becomes recoverable because Orkestrator lost the answer, not
   * because the provider lost the prompt — and every bridge keeps a durable
   * record keyed by the same request id. Asking it turns the common case (the
   * turn is running; only the acknowledgement went missing) back into a plain
   * accepted dispatch, instead of a banner the user has to act on.
   *
   * Read-only and strictly one-directional: it can only ever *clear* a pending
   * record, and only on an explicit answer. `dispatched` confirms it
   * (`confirmed`). `lost` means the provider recorded the id in an earlier
   * process and will refuse it for good, so a retry could only report that:
   * the record is retired instead (`retired`), with a content-free marker the
   * projection carries so every renderer releases the draft's id and shows
   * the message without a click. A parked prompt never belongs to a queue
   * item — the queue dispatches without parking and retries its own in-flight
   * id, which the bridge then refuses as retired. Providers with no journal to
   * ask, an unreachable bridge, and any failure at all leave the record exactly
   * where it was (`undefined`), because "I could not find out" must never read
   * as "it ran".
   */
  private async settleAmbiguousDispatch(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved?: NativeAgentRuntimeProvider,
  ): Promise<"confirmed" | "retired" | undefined> {
    try {
      // Cheapest question first. Projection reads drive this on every refresh,
      // and a provider with no journal to ask must not cost a storage read each
      // time to establish that it still has nothing to say.
      const provider = resolved ?? (await this.provider(input));
      if (!provider.dispatchStatus) return undefined;
      // Re-read rather than trusting the caller's snapshot: a real
      // acknowledgement may have landed since, and confirming against a stale
      // record would resurrect a request id that is no longer parked.
      const session = await this.storage.getNativeAgentSession(key);
      if (session?.pendingDispatch?.requestId !== requestId) return undefined;
      const status = await provider.dispatchStatus(session.providerSessionId, requestId);
      if (status === "lost") {
        return (await this.storage.retireNativeAgentDispatch(key, requestId))
          ? "retired"
          : undefined;
      }
      if (status !== "dispatched" && status !== "pending") return undefined;
      return (await this.storage.confirmNativeAgentDispatch(key, requestId))
        ? "confirmed"
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async settleAmbiguousSteer(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved?: NativeAgentRuntimeProvider,
  ): Promise<"dispatched" | "absent" | undefined> {
    try {
      await this.storage.recoverPromptQueueSteer(key, requestId);
      const session = await this.storage.getNativeAgentSession(key);
      if (session?.pendingSteer?.requestId !== requestId) {
        return session?.dispatchedRequestIds?.includes(requestId) ? "dispatched" : undefined;
      }
      const provider = resolved ?? (await this.provider(input));
      if (!provider.steerStatus) return undefined;
      const status = await this.storage.reconcileNativeAgentSteer(key, requestId, () =>
        provider.steerStatus!(session.providerSessionId, requestId),
      );
      if (status === "dispatched")
        await this.acknowledgeQueuedAsyncQuestionAnswer(input, requestId);
      return status;
    } catch {
      return undefined;
    }
  }

  private async acknowledgeQueuedAsyncQuestionAnswer(
    input: NativeAgentProjectionInput,
    requestId: string,
  ): Promise<void> {
    if (!nativeAsyncQuestionItemId(requestId)) return;
    await this.storage.acknowledgePromptQueueDispatch(
      `${input.agent}\0${input.logicalSessionKey}`,
      requestId,
    );
  }

  async retryRecoverableDispatch(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<NativeAgentDispatchOutcome> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.requestId)) {
      throw new Error("Recoverable native agent request ID must not be blank");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    const pending = session?.pendingDispatch;
    const pendingSteer = session?.pendingSteer;
    if (!session || (!pending && !pendingSteer)) {
      return {
        outcome: "rejected",
        error: "There is no recoverable dispatch for this session",
      };
    }
    if ((pending?.requestId ?? pendingSteer?.requestId) !== input.requestId) {
      return {
        outcome: "rejected",
        error: "The recoverable dispatch changed; refresh before retrying",
      };
    }
    if (pendingSteer) {
      const resolved = await this.resolveProjectionSession(input);
      if (!resolved?.provider.performSessionAction || !resolved.provider.steerSupported) {
        return { outcome: "rejected", error: `${input.agent} does not support steer` };
      }
      const qualified = await resolved.provider
        .steerSupported(resolved.session.providerSessionId)
        .catch(() => false);
      if (!qualified) {
        return {
          outcome: "rejected",
          error: `${input.agent} bridge does not support reliable steering; recovery remains parked`,
        };
      }
      const settlement = await this.settleAmbiguousSteer(
        input,
        key,
        input.requestId,
        resolved.provider,
      );
      if (settlement === "dispatched") {
        this.projections.invalidateProjection(key);
        return { outcome: "accepted", requestId: input.requestId };
      }
      if (
        settlement === "absent" ||
        !(await this.storage.getNativeAgentSession(key))?.pendingSteer
      ) {
        this.projections.invalidateProjection(key);
        return {
          outcome: "rejected",
          error: pendingSteer.sourceQueue
            ? "The steering instruction was not delivered. The prompt was returned to the queue."
            : "The steering instruction was not delivered.",
        };
      }
      const outcome = await this.dispatchPersistedSteer(
        resolved.provider,
        resolved.session.providerSessionId,
        key,
        pendingSteer,
      );
      this.projections.invalidateProjection(key);
      if (outcome.outcome === "applied") {
        await this.acknowledgeQueuedAsyncQuestionAnswer(input, input.requestId);
        return { outcome: "accepted", requestId: input.requestId };
      }
      if (outcome.outcome === "unknown") {
        return {
          outcome: "unknown",
          requestId: input.requestId,
          error: "The steering instruction is still being reconciled.",
        };
      }
      if (outcome.outcome === "rejected") {
        return { outcome: "rejected", error: nativeAgentSteerRejectionMessage(outcome) };
      }
      return {
        outcome: "rejected",
        error:
          outcome.outcome === "mismatch"
            ? "The active turn changed before the instruction could be delivered."
            : "There is no active turn to steer.",
      };
    }
    if (!pending) {
      return { outcome: "rejected", error: "There is no recoverable dispatch for this session" };
    }
    return this.dispatchIntentInternal(
      {
        environmentId: session.environmentId,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
        origin: session.origin,
        interactionPolicy: session.interactionPolicy,
        prompt: pending.prompt,
        requestId: pending.requestId,
        images: pending.images,
        attachments: pending.attachments,
        schema: pending.schema,
        mode: pending.mode,
        fastMode: pending.fastMode,
        subAgent: pending.subAgent,
        executionAgent: pending.executionAgent,
        includeLocalSettings: pending.includeLocalSettings,
        promptSuggestions: pending.promptSuggestions,
        model: pending.model,
        reasoningEffort: pending.reasoningEffort,
        // The same resolved intent, never re-derived from the text: a retry of
        // a command must run that command or fail, not become a prompt.
        ...(pending.command ? { command: pending.command } : {}),
      },
      true,
    );
  }

  async stopProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    return this.promptQueues.withSessionMutationIntent(input, () =>
      this.stopProjectionSessionWithIntent(input),
    );
  }

  private async stopProjectionSessionWithIntent(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const providerSessionId = resolved.session.providerSessionId;
    // Mark the active turn before stopping it: a stopped turn reads as idle,
    // and an observer must never mistake it for one that finished on its own.
    // A prompt the provider has not accepted yet (Pi's startup) is the turn
    // being stopped; it joins `dispatchedRequestIds` only once accepted.
    const inFlight = resolved.session.pendingDispatch;
    const requestId =
      inFlight && !inFlight.mailRefused
        ? inFlight.requestId
        : resolved.session.dispatchedRequestIds?.at(-1);
    let recordingInterrupt: Promise<void> | undefined;
    if (requestId) {
      const before = await resolved.provider
        .status(providerSessionId)
        .catch(() => "running" as const);
      // A live background task can keep status running after the turn released input.
      const released =
        (before === "running" || before === "blocked") && resolved.provider.observeActivity
          ? await resolved.provider
              .observeActivity(providerSessionId)
              .then((activity) => activity.readyForInput === true)
              .catch(() => false)
          : false;
      if ((before === "running" || before === "blocked") && !released) {
        this.promptQueues.fenceTurnInterrupt(resolved.key, providerSessionId, requestId);
        // Not awaited before the abort. A dispatch the provider has not
        // acknowledged holds this session's storage queue until it does, so
        // the write waits out exactly the startup the stop has to reach. The
        // in-memory fence above classifies the turn as interrupted meanwhile,
        // as it does when the write fails.
        recordingInterrupt = this.storage
          .recordNativeAgentTurnInterrupt(resolved.key, providerSessionId, requestId)
          .then(
            (persisted) => {
              if (persisted) this.promptQueues.releaseTurnInterrupt(resolved.key, requestId);
            },
            () => {
              console.warn(
                "[native-agent] Turn interrupt persistence failed; automatic publication remains fenced",
              );
            },
          );
      }
    }
    await resolved.provider.abort(providerSessionId);
    const graceMs = Math.max(0, this.options.abortGraceMs ?? 5_000);
    const deadline = this.now() + graceMs;
    let status = await resolved.provider.status(providerSessionId).catch(() => "running" as const);
    while ((status === "running" || status === "blocked") && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - this.now())));
      status = await resolved.provider.status(providerSessionId).catch(() => "running" as const);
    }
    const stoppedGracefully = status !== "running" && status !== "blocked";
    let hardAbortAttempted = false;
    if (!stoppedGracefully && resolved.provider.hardAbort) {
      hardAbortAttempted = true;
      await resolved.provider.hardAbort(providerSessionId);
    }
    await recordingInterrupt;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    this.projections.recordStopNotice(
      sessionKey,
      stoppedGracefully
        ? "The turn stopped after a graceful interrupt."
        : hardAbortAttempted
          ? "The turn did not stop within the grace period and a force-stop was requested."
          : "The turn did not stop within the grace period; this provider has no force-stop action.",
    );
    return this.projections.refreshProjection(input, true);
  }

  async stopProjectionBackgroundTask(
    input: NativeAgentProjectionInput & { taskId: string },
  ): Promise<NativeAgentSessionProjection | null> {
    if (!nonBlank(input.taskId)) throw new Error("Background task ID must not be blank");
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    if (!resolved.provider.stopBackgroundTask) {
      throw new Error(`${input.agent} does not support background tasks`);
    }
    await resolved.provider.stopBackgroundTask(resolved.session.providerSessionId, input.taskId);
    return this.projections.refreshProjection(input, true);
  }

  async dismissProjectionSuggestedPrompt(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    if (!resolved.provider.dismissSuggestedPrompt) {
      throw new Error(`${input.agent} does not support prompt suggestions`);
    }
    await resolved.provider.dismissSuggestedPrompt(resolved.session.providerSessionId);
    return this.projections.refreshProjection(input, true);
  }

  async listProjectionResumableSessions(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentResumeEntry[]> {
    this.assertProjectionInput(input);
    if (!nativeCapabilities(input.agent).resume) return [];
    const provider = await this.provider(input);
    if (!provider.listResumableSessions) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    /*
     * Ordered here rather than in each picker: providers return their own order
     * (OpenCode's is creation order), so the session the user most likely wants
     * was not necessarily at the top. Unknown timestamps sink to the bottom
     * instead of sorting as 1970.
     */
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const current = await this.storage.getNativeAgentSession(sessionKey);
    const [entries, currentState] = await Promise.all([
      provider.listResumableSessions(),
      current?.providerSessionId && provider.sessionStateSnapshot
        ? provider.sessionStateSnapshot(current.providerSessionId).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const currentResumableSessionId =
      currentState?.resumableSessionId ?? current?.providerSessionId;
    const activityAt = (entry: NativeAgentResumeEntry) => {
      const raw = entry.updatedAt ?? entry.createdAt;
      const parsed = raw ? Date.parse(raw) : Number.NaN;
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    return entries
      .filter((entry) => entry.sessionId !== currentResumableSessionId)
      .sort((left, right) => activityAt(right) - activityAt(left))
      .slice(0, 512);
  }

  async resumeProjectionSession(
    input: NativeAgentProjectionInput & {
      providerSessionId: string;
      controls?: NativeAgentControlUpdate;
    },
  ): Promise<NativeAgentSessionProjection | null> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.providerSessionId)) {
      throw new Error("Native agent resume session ID must not be blank");
    }
    if (!nativeCapabilities(input.agent).resume) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const existing = await this.storage.getNativeAgentSession(key);
    const trustedInput = await this.trustedSessionInput({
      ...input,
      origin: existing?.origin ?? "interactive-native",
      interactionPolicy: existing?.interactionPolicy ?? INTERACTIVE_AGENT_INTERACTION_POLICY,
      executionPolicy: undefined,
      policy: undefined,
    });
    const provider = await this.provider(trustedInput);
    if (!provider.resumeSession) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    this.projections.invalidateProjection(key);
    // Wait for any last-owner close before reopening the conversation. Adoption
    // takes the same fence and rechecks liveness before publishing its mapping.
    const resumeAndAdopt = async () => {
      const id = await withProviderSessionTeardownLock(
        this.storage,
        input.environmentId,
        input.agent,
        input.providerSessionId,
        () => provider.resumeSession!(input.providerSessionId, input.controls, trustedInput.policy),
      );
      await this.adoptSession({
        ...trustedInput,
        providerSessionId: id,
        expectedProviderSessionId: existing?.providerSessionId,
        controls: input.controls,
        model: input.controls?.modelId,
        reasoningEffort: input.controls?.reasoningId,
        sessionMode: input.controls?.mode,
        fastMode: input.controls?.fastMode,
      });
      return id;
    };
    let resumedId: string;
    try {
      resumedId = await resumeAndAdopt();
    } catch (error) {
      // A last-owner close can take the fence between the reopen and the
      // adoption, which then finds the session missing. That close has
      // finished by then, so one more reopen recovers the conversation.
      if (!(error instanceof shared.NativeAgentProviderSessionMissingError)) throw error;
      resumedId = await resumeAndAdopt();
    }
    const replacedId = existing?.providerSessionId;
    const closingReplaced =
      replacedId && replacedId !== resumedId
        ? this.closeReplacedSession(provider, input.environmentId, input.agent, replacedId)
        : undefined;
    // The close runs beside the projection refresh; the resume answers once both settle.
    return this.projections.refreshProjection(input, true).finally(() => closingReplaced);
  }

  /**
   * Close the session a resume replaced, which the tab no longer shows. A new
   * tab is given an empty session before its resume picker opens, so without
   * this every resume leaves one behind; for Grok, an agent process holding
   * an `ACP_MAX_SESSIONS` slot that nothing reaps. Same last-owner rules and
   * lock as tab teardown. The close keeps the vendor conversation.
   *
   * Never throws: the resume already succeeded. The close is journaled
   * first as a teardown intent (`replacedSessionCloseIntent`) and cleared
   * once it is confirmed, so a close that stays pending, times out or is cut
   * short by a backend exit is replayed by `reconcile_tab_teardowns` under
   * the same rules. An environment the journal cannot hold (a coordinator
   * runtime) still gets the one best-effort close.
   */
  private async closeReplacedSession(
    provider: NativeAgentRuntimeProvider,
    environmentId: string,
    agent: NativeAgentProjectionInput["agent"],
    providerSessionId: string,
  ): Promise<void> {
    try {
      await withProviderSessionTeardownLock(
        this.storage,
        environmentId,
        agent,
        providerSessionId,
        async () => {
          if (!provider.closeSession) return;
          const heldElsewhere = await providerSessionHeldElsewhere(this.storage, {
            environmentId,
            agent,
            providerSessionId,
          });
          if (heldElsewhere) return;
          const intent = replacedSessionCloseIntent(agent, providerSessionId);
          const journaled = await this.storage.setTabTeardownIntent(environmentId, intent).then(
            () => true,
            () => false,
          );
          await provider.closeSession(providerSessionId);
          if (journaled) {
            await this.storage.clearTabTeardownIntent(
              environmentId,
              intent.tabId,
              intent.createdAt,
            );
          }
        },
      );
    } catch (error) {
      console.warn(
        `[native-agent] The ${agent} session a resume replaced was not closed:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }

  async forkProjectionSession(
    input: NativeAgentProjectionInput & { messageId?: string },
  ): Promise<NativeAgentForkOutcome> {
    if (!nativeCapabilities(input.agent).fork) {
      throw new Error(`${input.agent} does not support session forks`);
    }
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    if (!resolved.provider.forkSession) {
      throw new Error(`${input.agent} does not support session forks`);
    }
    const projection = await this.getProjection(input);
    const composer = projection?.composer;
    const outcome = await resolved.provider.forkSession(
      resolved.session.providerSessionId,
      input.messageId,
    );
    try {
      this.options.changeTracking?.()?.noteFork({
        environmentId: resolved.session.environmentId,
        provider: input.agent,
        parentLogicalSessionKey: resolved.session.logicalSessionKey,
        childProviderSessionId: outcome.sessionId,
      });
    } catch {
      // Lineage is best effort; the child still gets its own fresh baseline.
    }
    return {
      ...outcome,
      controls: {
        ...resolved.session.controls,
        ...(composer?.selectedModelId ? { modelId: composer.selectedModelId } : {}),
        ...(composer?.selectedReasoningId ? { reasoningId: composer.selectedReasoningId } : {}),
        ...outcome.controls,
      },
    };
  }

  async performProjectionAction(
    input: NativeAgentProjectionInput & { action: NativeAgentSessionAction },
  ): Promise<NativeAgentSessionActionOutcome> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    if (
      resolved.session.executionPolicy === "coordinator-read-only" &&
      ["rewind-files", "undo", "redo"].includes(input.action.kind)
    ) {
      throw new Error("Read-only coordinator sessions cannot change project files");
    }
    const capability = {
      compact: "compact",
      "rewind-files": "rewindFiles",
      undo: "undo",
      redo: "redo",
      share: "share",
      unshare: "share",
      steer: "steer",
      review: "review",
      "rewind-messages": "rewindMessages",
      "switch-branch": "branches",
    }[input.action.kind] as keyof NonNullable<NativeAgentCapabilities["actions"]>;
    if (!nativeCapabilities(input.agent).actions?.[capability]) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    if (!resolved.provider.performSessionAction) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    if (input.action.kind === "steer") {
      return this.performProjectionSteer(input, resolved, input.action);
    }
    const outcome = await resolved.provider.performSessionAction(
      resolved.session.providerSessionId,
      input.action,
    );
    this.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  async performProjectionMcpAction(
    input: NativeAgentProjectionInput & {
      serverId: string;
      action: NativeAgentMcpServerAction;
    },
  ): Promise<{ url?: string }> {
    if (!nonBlank(input.serverId)) throw new Error("MCP server ID must not be blank");
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    if (!resolved.provider.mcpServerAction) {
      throw new Error(`${input.agent} does not support MCP server actions`);
    }
    const outcome = await resolved.provider.mcpServerAction(
      resolved.session.providerSessionId,
      input.serverId,
      input.action,
    );
    this.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  /**
   * Read the provider's account on demand. Deliberately uncached and absent from
   * the projection: an account read can reach the provider's auth service, and
   * the projection is rebuilt on every session change.
   */
  async readProjectionAuthStatus(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentAuthStatus | null> {
    const provider = await this.provider(input);
    return provider.authStatus ? provider.authStatus() : null;
  }

  async beginProjectionSignIn(
    input: NativeAgentProjectionInput & { deviceCode?: boolean },
  ): Promise<{ url?: string; code?: string }> {
    const provider = await this.provider(input);
    if (!provider.beginSignIn) throw new Error(`${input.agent} does not support sign-in here`);
    // A browser sign-in redirects to the agent's loopback, which no browser
    // reaches inside a container or, per the client, on another machine.
    const environment = await this.storage.getEnvironment(input.environmentId);
    const deviceCode =
      input.deviceCode === true || environment?.environmentType === "containerized";
    const outcome = await provider.beginSignIn(deviceCode ? { deviceCode: true } : undefined);
    this.projections.invalidateProjection(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
    );
    return outcome;
  }

  /** Abandon an in-tab sign-in; a platform without cancel has nothing to release. */
  async cancelProjectionSignIn(input: NativeAgentProjectionInput): Promise<{ cancelled: boolean }> {
    this.assertProjectionInput(input);
    try {
      const provider = await this.observeProvider(input);
      return provider?.cancelSignIn ? await provider.cancelSignIn() : { cancelled: false };
    } finally {
      this.projections.invalidateProjection(
        nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      );
    }
  }

  async signOutProjectionProvider(input: NativeAgentProjectionInput): Promise<void> {
    const provider = await this.provider(input);
    if (!provider.signOut) throw new Error(`${input.agent} does not support sign-out here`);
    await provider.signOut();
    this.projections.invalidateProjection(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
    );
  }

  /** One renderer request transfers a queue item into the backend-owned receipt. */
  async steerQueuedPrompt(
    input: NativeAgentProjectionInput & { messageId: string },
  ): Promise<NativeAgentSessionActionOutcome | null> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.messageId)) throw new Error("Queued message ID must not be blank");
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    const queueKey = `${input.agent}\0${input.logicalSessionKey}`;
    const queue = await this.storage.getPromptQueue(queueKey);
    if (queue?.inFlight?.steer) {
      await this.storage.recoverPromptQueueSteer(resolved.key, queue.inFlight.requestId);
      const latest = await this.storage.getNativeAgentSession(resolved.key);
      const item = queue.inFlight.message as { id?: string };
      if (
        item.id === input.messageId &&
        latest?.pendingSteer?.requestId === queue.inFlight.requestId
      ) {
        return { outcome: "unknown", requestId: queue.inFlight.requestId };
      }
      // A lost applied response can be replayed without another provider call.
      if (
        item.id === input.messageId &&
        latest?.dispatchedRequestIds?.includes(queue.inFlight.requestId)
      )
        return { outcome: "applied", requestId: queue.inFlight.requestId };
    }
    if (
      !resolved.provider.performSessionAction ||
      !resolved.provider.activeSteerRun ||
      !resolved.provider.steerSupported ||
      !resolved.provider.steerStatus ||
      !nativeCapabilities(input.agent).actions?.steer
    )
      throw new Error(`${input.agent} does not support reliable steering`);
    if (!(await resolved.provider.steerSupported(resolved.session.providerSessionId)))
      throw new Error(`${input.agent} bridge does not support reliable steering`);
    const active = await resolved.provider.activeSteerRun(resolved.session.providerSessionId);
    if (active.state === "idle") return { outcome: "idle" };
    if (active.state !== "running") throw new Error("The active turn is not ready to steer");
    const pending = await this.storage.reservePromptQueueSteer(
      resolved.key,
      input.messageId,
      active.runId,
    );
    if (!pending) return null;
    const outcome = await this.dispatchPersistedSteer(
      resolved.provider,
      resolved.session.providerSessionId,
      resolved.key,
      pending,
    );
    this.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  private async performProjectionSteer(
    input: NativeAgentProjectionInput,
    resolved: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
    },
    action: Extract<NativeAgentSessionAction, { kind: "steer" }>,
    requestId: string = randomUUID(),
  ): Promise<NativeAgentSessionActionOutcome> {
    const text = action.text.trim();
    if (!text) throw new Error("Steering text must not be blank");
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new Error("Steering text exceeds the 64 KB limit");
    }
    if (
      !resolved.provider.activeSteerRun ||
      !resolved.provider.steerSupported ||
      !resolved.provider.steerStatus
    ) {
      throw new Error(`${input.agent} does not support reliable steering`);
    }
    if (resolved.session.pendingDispatch) {
      throw new PendingNativeAgentDispatchError(resolved.session.pendingDispatch.requestId);
    }
    if (resolved.session.pendingSteer) {
      if (resolved.session.pendingSteer.requestId !== requestId)
        throw new Error(PARKED_DISPATCH_CONFLICT_MESSAGE);
      this.promptQueues.scheduleAmbiguousSteerSettle(
        input,
        resolved.key,
        resolved.session.pendingSteer.requestId,
        resolved.provider,
      );
      return { outcome: "unknown", requestId: resolved.session.pendingSteer.requestId };
    }

    if (!(await resolved.provider.steerSupported(resolved.session.providerSessionId))) {
      throw new Error(`${input.agent} bridge does not support reliable steering`);
    }
    const active = await resolved.provider.activeSteerRun(resolved.session.providerSessionId);
    if (active.state === "unsupported") {
      throw new Error(`${input.agent} does not support reliable steering`);
    }
    if (active.state === "idle") return { outcome: "idle" };
    if (active.state === "unknown") {
      throw new Error(`${input.agent} active turn is not ready to steer`);
    }

    const pending: PersistedNativeAgentPendingSteer = {
      requestId,
      text,
      inputDigest: createHash("sha256").update(text).digest("hex"),
      expectedRunId: active.runId,
      state: "prepared",
      createdAt: new Date().toISOString(),
    };
    const outcome = await this.dispatchPersistedSteer(
      resolved.provider,
      resolved.session.providerSessionId,
      resolved.key,
      pending,
    );
    this.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  private async dispatchQueuedAsyncQuestionAnswer(
    input: NativeAgentProjectionInput,
    resolved: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
    },
    text: string,
    requestId: string,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (!nativeAsyncQuestionItemId(requestId)) {
      throw new Error("Queued response is not an asynchronous-question answer");
    }
    return this.performProjectionSteer(input, resolved, { kind: "steer", text }, requestId);
  }

  private async dispatchPersistedSteer(
    provider: NativeAgentRuntimeProvider,
    providerSessionId: string,
    key: string,
    pending: PersistedNativeAgentPendingSteer,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (!provider.performSessionAction) {
      throw new Error(`${provider.agent} does not support steer`);
    }
    try {
      const session = await this.storage.getNativeAgentSession(key);
      if (!session || session.providerSessionId !== providerSessionId) {
        await this.storage.clearPendingNativeAgentSteer(key, pending.requestId);
        return { outcome: "mismatch" };
      }
      return await this.promptQueues.withSessionMutationFence(
        {
          environmentId: session.environmentId,
          agent: session.agent,
          logicalSessionKey: session.logicalSessionKey,
        },
        () =>
          this.storage.dispatchNativeAgentSteerOnce(key, pending, () =>
            provider.performSessionAction!(providerSessionId, {
              kind: "steer",
              text: pending.text,
              requestId: pending.requestId,
              expectedRunId: pending.expectedRunId,
            }),
          ),
      );
    } catch (error) {
      if (
        error instanceof PendingNativeAgentDispatchError ||
        error instanceof PendingNativeAgentSteerError
      ) {
        throw new Error(PARKED_DISPATCH_CONFLICT_MESSAGE);
      }
      throw error;
    }
  }

  async updateProjectionControls(
    input: NativeAgentProjectionInput & { update: NativeAgentControlUpdate },
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const current = await this.projections.refreshProjection(input, true);
    const composer = current?.composer;
    if (input.update.modelId !== undefined) {
      if (
        !composer?.models.some(
          (model: NativeAgentComposerState["models"][number]) => model.id === input.update.modelId,
        )
      ) {
        throw new Error("Native agent model selection is invalid");
      }
    }
    if (input.update.reasoningId !== undefined) {
      const modelId = input.update.modelId ?? composer?.selectedModelId;
      const model =
        composer?.models.find(
          (candidate: NativeAgentComposerState["models"][number]) => candidate.id === modelId,
        ) ?? composer?.models[0];
      if (
        !model?.reasoning?.some(
          (option: NonNullable<NativeAgentComposerState["models"][number]["reasoning"]>[number]) =>
            option.id === input.update.reasoningId,
        )
      ) {
        throw new Error("Native agent reasoning selection is invalid");
      }
    }
    if (input.update.parameterValues !== undefined) {
      const modelId = input.update.modelId ?? composer?.selectedModelId;
      const model =
        composer?.models.find(
          (candidate: NativeAgentComposerState["models"][number]) => candidate.id === modelId,
        ) ?? composer?.models[0];
      for (const [parameterId, value] of Object.entries(input.update.parameterValues)) {
        const parameter = model?.parameters?.find((candidate) => candidate.id === parameterId);
        if (!parameter || typeof value !== (parameter.kind === "toggle" ? "boolean" : "string")) {
          throw new Error(`Native agent parameter ${parameterId} is invalid`);
        }
        if (
          parameter.kind === "select" &&
          !parameter.options?.some((option) => option.id === value)
        ) {
          throw new Error(`Native agent parameter ${parameterId} selection is invalid`);
        }
      }
    }
    if (input.update.persistDefaults && composer?.persistedDefaults !== true) {
      throw new Error("This provider cannot persist composer defaults");
    }
    if (input.update.fastMode !== undefined && composer?.fastModeAvailable !== true) {
      throw new Error("Native agent fast mode is unavailable");
    }
    if (
      input.update.mode !== undefined &&
      !composer?.modes.some(
        (mode: NativeAgentComposerState["modes"][number]) => mode.id === input.update.mode,
      )
    ) {
      throw new Error("Native agent conversation mode is invalid");
    }
    if (
      input.update.executionProfileId !== undefined &&
      input.update.executionProfileId !== null &&
      !composer?.executionProfiles?.some(
        (profile: NonNullable<NativeAgentComposerState["executionProfiles"]>[number]) =>
          profile.id === input.update.executionProfileId,
      ) &&
      // An empty list means the provider's agent listing failed or has not
      // arrived, not that the id is wrong — the compose bar still has to offer
      // Plan/Build there, and a 400 would strand the user on whichever agent
      // the session happened to start with. Only the two built-in ids are
      // exempt: anything else is unverifiable *and* unguessable, and it is
      // forwarded verbatim as the provider's `agent` name.
      !(
        (composer?.executionProfiles?.length ?? 0) === 0 &&
        isFallbackExecutionProfileId(input.update.executionProfileId)
      )
    ) {
      throw new Error("Native agent execution profile is invalid");
    }
    if (
      input.update.approvalMode !== undefined &&
      !composer?.approvalModes?.some(
        (mode) => mode.id === input.update.approvalMode && !mode.disabled,
      )
    ) {
      throw new Error("Native agent approval mode is invalid");
    }
    const capabilities = nativeCapabilities(input.agent).composer;
    if (input.update.includeLocalSettings !== undefined && !capabilities.localSettings) {
      throw new Error("Native agent local settings are unavailable");
    }
    if (input.update.promptSuggestions !== undefined && !capabilities.promptSuggestions) {
      throw new Error("Native agent prompt suggestions are unavailable");
    }
    await this.storage.updateNativeAgentSessionControls(
      resolved.key,
      resolved.session.providerSessionId,
      input.update,
      async () => {
        await resolved.provider.updateInteractiveControls?.(
          resolved.session.providerSessionId,
          // Leaving Plan restores the session's existing approval mode.
          input.update.mode === "build" && input.update.approvalMode === undefined
            ? { ...input.update, approvalMode: composer?.selectedApprovalModeId }
            : input.update,
        );
      },
    );
    return this.projections.refreshProjection(input, true);
  }

  async resolveProjectionInteraction(
    input: NativeAgentProjectionInput & {
      interactionId: string;
      resolution: AgentInteractionResolution;
    },
  ): Promise<AgentInteractionApplyOutcome> {
    if (!nonBlank(input.interactionId)) {
      throw new Error("Native agent interaction ID must not be blank");
    }
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) {
      throw new Error("Native agent session was not found");
    }
    if (!resolved.provider.interactions) {
      throw new Error(`${input.agent} does not support interactive requests`);
    }
    const outcome = await resolved.provider.interactions.resolveInteraction(
      resolved.session.providerSessionId,
      input.interactionId,
      input.resolution,
    );
    // Observers must re-read instead of reporting an answered question as pending.
    this.interactions.forgetPendingInteractions(resolved.key);
    void this.projections.refreshProjection(input, true).catch(() => undefined);
    return outcome;
  }

  /**
   * Pause or resume an interaction's countdown. The request stays pending, but
   * its deadline moved: cached pending reads are dropped and the projection
   * refreshed so every client sees the new state.
   */
  async holdProjectionInteraction(
    input: NativeAgentProjectionInput & { interactionId: string; held: boolean },
  ): Promise<AgentInteractionApplyOutcome> {
    if (!nonBlank(input.interactionId)) {
      throw new Error("Native agent interaction ID must not be blank");
    }
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) {
      throw new Error("Native agent session was not found");
    }
    const interactions = resolved.provider.interactions;
    if (!interactions?.holdInteraction) {
      return {
        result: "rejected",
        interactionId: input.interactionId,
        sessionId: resolved.session.providerSessionId,
        revision: 0,
      };
    }
    const outcome = await interactions.holdInteraction(
      resolved.session.providerSessionId,
      input.interactionId,
      input.held,
    );
    this.interactions.forgetPendingInteractions(resolved.key);
    void this.projections.refreshProjection(input, true).catch(() => undefined);
    return outcome;
  }

  private assertProjectionInput(input: NativeAgentProjectionInput): void {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId) ||
      !nonBlank(input.logicalSessionKey) ||
      !BUILD_PIPELINE_AGENTS.includes(input.agent)
    ) {
      throw new Error("Invalid native agent projection request");
    }
  }

  private async resolveProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<ResolvedProjectionSession | null> {
    this.assertProjectionInput(input);
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    if (!session) return null;
    this.assertSessionIdentity(session, input, key);
    const provider = await this.provider(input);
    provider.registerSession?.(session.providerSessionId, {
      origin: session.origin,
      interactionPolicy: session.interactionPolicy,
    });
    return { key, session, provider, transient: false as const };
  }
  private async recordAsyncQuestionAttention(
    environmentId: string,
    sessionKey: string,
    itemIds: readonly string[],
  ): Promise<void> {
    const attentionKeys = itemIds.slice(-64).map((itemId) => {
      const digest = createHash("sha256")
        .update(sessionKey)
        .update("\0")
        .update(itemId)
        .digest("hex");
      return `codex:${digest}`;
    });
    if (attentionKeys.length === 0) return;
    const attention = await this.storage.recordEnvironmentAgentAttention(
      environmentId,
      attentionKeys,
      new Date(this.now()).toISOString(),
    );
    if (attention.recorded) {
      this.options.onAsyncQuestionAttention?.({ environmentId, sessionKey });
    }
  }

  sessionPresentationSnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): { presence: AgentActivityState | "unknown"; title?: string } {
    const projection = this.projections.cachedProjectionSnapshot(
      environmentId,
      agent,
      logicalSessionKey,
    );
    return {
      presence: this.launches.sessionActivitySnapshot(environmentId, agent, logicalSessionKey),
      ...(projection?.title ? { title: projection.title } : {}),
    };
  }

  /** Bounded retry bookkeeping for on-demand turn-outcome reads. */
  private readonly turnOutcomeAttempts = new Map<string, { attempts: number; retryAt: number }>();

  /**
   * Whether the turn started by `requestId` finished on its own as the
   * session's last word. Beyond {@link sessionTurnOutcome}, a turn a stop
   * reached is `interrupted`, and one followed by any later prompt or steer is
   * `superseded`, because the conversation then no longer ends with it.
   */
  async sessionRequestOutcome(
    input: NativeAgentProjectionInput & {
      requestId: string;
      expectedProviderSessionId?: string;
    },
  ): Promise<{
    outcome: "completed" | "failed" | "interrupted" | "superseded" | "pending" | "unknown";
    error?: string;
  }> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const initial = await this.storage.getNativeAgentSession(key);
    if (!initial) return { outcome: "unknown" };
    const classify = async () => {
      const { session, queue } = await this.storage.readNativeAgentPublicationState(
        key,
        `${input.agent}\0${input.logicalSessionKey}`,
      );
      if (
        !session ||
        session.providerSessionId !== initial.providerSessionId ||
        (input.expectedProviderSessionId !== undefined &&
          session.providerSessionId !== input.expectedProviderSessionId)
      ) {
        return { outcome: "unknown" as const };
      }
      const interrupt = this.promptQueues.pendingTurnInterrupt(key, input.requestId);
      if (interrupt?.providerSessionId === session.providerSessionId) {
        try {
          const persisted = await this.storage.recordNativeAgentTurnInterrupt(
            key,
            session.providerSessionId,
            input.requestId,
          );
          if (persisted) this.promptQueues.releaseTurnInterrupt(key, input.requestId);
        } catch {
          /* Retain the fence and retry on the next observation. */
        }
        return { outcome: "interrupted" as const };
      }
      if (session.interruptedRequestIds?.includes(input.requestId))
        return { outcome: "interrupted" as const };
      if (this.promptQueues.interruptFencesOverflowed()) return { outcome: "unknown" as const };
      const ids = session.dispatchedRequestIds ?? [];
      if (!ids.includes(input.requestId)) return { outcome: "unknown" as const };
      if (ids.at(-1) !== input.requestId) return { outcome: "superseded" as const };
      if (
        this.promptQueues.hasPendingSessionMutation(key) ||
        session.pendingDispatch ||
        session.pendingSteer ||
        queue?.messages.length ||
        queue?.inFlight ||
        queue?.outstandingClaim
      ) {
        return { outcome: "pending" as const };
      }
      return undefined;
    };
    const before = await classify();
    if (before) return before;
    const outcome = await this.sessionTurnOutcome(input);
    // Provider and persistence reads await: Stop, replacement and follow-ups
    // may have changed the authorization while historical outcome work ran.
    return (await classify()) ?? outcome;
  }

  /**
   * How the turn started by `requestId` ended, without reading the transcript.
   *
   * A durable record (written by the queue drain's own status read, or by an
   * earlier call) answers immediately. Otherwise, only while this request is
   * still the session's latest dispatch and the turn looks finished, one
   * provider status read settles it: a provider keeps a terminal turn error
   * until the next turn, so `error` then is this turn's error. `pending` means
   * "ask again later"; `unknown` means the outcome cannot be established.
   */
  async sessionTurnOutcome(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<{ outcome: "completed" | "failed" | "pending" | "unknown"; error?: string }> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    if (!session) return { outcome: "unknown" };
    const recorded = session.turnOutcomes?.find((entry) => entry.requestId === input.requestId);
    if (recorded) {
      return { outcome: recorded.outcome, ...(recorded.error ? { error: recorded.error } : {}) };
    }
    const ids = session.dispatchedRequestIds ?? [];
    if (ids[ids.length - 1] !== input.requestId) return { outcome: "unknown" };
    const activity = this.launches.sessionTurnActivitySnapshot(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (activity === "working" || activity === "waiting") return { outcome: "pending" };
    const attemptKey = `${key}\0${input.requestId}`;
    const attempt = this.turnOutcomeAttempts.get(attemptKey);
    if (attempt && attempt.retryAt > this.now()) return { outcome: "pending" };
    const retry = (): { outcome: "pending" | "unknown" } => {
      const attempts = (attempt?.attempts ?? 0) + 1;
      if (attempts >= 3) {
        this.turnOutcomeAttempts.delete(attemptKey);
        return { outcome: "unknown" };
      }
      if (!attempt && this.turnOutcomeAttempts.size >= 256) {
        const oldest = this.turnOutcomeAttempts.keys().next().value;
        if (oldest !== undefined) this.turnOutcomeAttempts.delete(oldest);
      }
      this.turnOutcomeAttempts.set(attemptKey, {
        attempts,
        retryAt: this.now() + 5_000 * attempts,
      });
      return { outcome: "pending" };
    };
    let provider: NativeAgentRuntimeProvider | undefined;
    let observation: Awaited<ReturnType<typeof readProviderStatus>>;
    try {
      provider = await this.observeProvider(input);
      // An absent observation can be a temporarily unavailable bridge.
      if (!provider) return retry();
      observation = await readProviderStatus(provider, session.providerSessionId);
    } catch {
      return retry();
    }
    if (observation.status === "running" || observation.status === "blocked") return retry();
    if (observation.status !== "idle" && observation.status !== "error") {
      this.turnOutcomeAttempts.delete(attemptKey);
      return { outcome: "unknown" };
    }
    let terminalError: string | null = null;
    if (observation.status === "idle" && provider.turnTerminalError) {
      try {
        terminalError = await provider.turnTerminalError(
          session.providerSessionId,
          input.requestId,
        );
      } catch {
        return retry();
      }
    }
    this.turnOutcomeAttempts.delete(attemptKey);
    const outcome =
      observation.status === "error" || terminalError !== null
        ? ("failed" as const)
        : ("completed" as const);
    const error =
      outcome === "failed" ? (terminalError ?? observation.error)?.slice(0, 500) : undefined;
    this.settleArtifactTurn(session, input.requestId);
    try {
      await this.storage.recordNativeAgentTurnOutcome(key, session.providerSessionId, {
        requestId: input.requestId,
        outcome,
        ...(error ? { error } : {}),
        observedAt: new Date(this.now()).toISOString(),
      });
    } catch {
      // The answer is still correct for this call; a later call re-reads.
    }
    return { outcome, ...(error ? { error } : {}) };
  }

  /**
   * Attribute this conversation's artifact tool calls to the turn being
   * dispatched and, when the provider's Orkestrator connection is
   * environment-wide (no per-tab credential), mint the turn's artifact-only
   * grant. Best-effort: artifact bookkeeping never blocks a prompt.
   */
  private beginArtifactTurn(
    durable: PersistedNativeAgentSession,
    requestId: string,
  ): string | undefined {
    if (durable.owner?.kind !== "environment") return undefined;
    return beginArtifactDispatchTurn(this.options.artifactDispatch, {
      environmentId: durable.environmentId,
      projectId: durable.owner.projectId,
      conversationKey: durable.logicalSessionKey,
      turnId: requestId,
      providerSessionId: durable.providerSessionId,
      needsGrant: nativeAgentCapabilities(durable.agent).agentTools !== true,
    });
  }

  private settleArtifactTurn(
    session: Pick<PersistedNativeAgentSession, "environmentId" | "logicalSessionKey">,
    requestId: string,
  ): void {
    settleArtifactDispatchTurn(
      this.options.artifactDispatch,
      session.environmentId,
      session.logicalSessionKey,
      requestId,
    );
  }

  /**
   * Record the latest dispatched turn's outcome from a status read the caller
   * already made (the queue drain reads status before sending the next prompt).
   * An `idle` read counts only when the turn is not visibly still running.
   */
  private async recordObservedTurnOutcome(
    session: PersistedNativeAgentSession,
    status: string,
    detail: string | undefined,
    provider?: Pick<NativeAgentRuntimeProvider, "turnTerminalError">,
  ): Promise<number | void> {
    const requestId = session.dispatchedRequestIds?.at(-1);
    if (!requestId || session.turnOutcomes?.some((entry) => entry.requestId === requestId)) return;
    if (status !== "idle" && status !== "error") return;
    let failure = status === "error" ? detail : undefined;
    if (status === "idle") {
      const activity = this.launches.sessionTurnActivitySnapshot(
        session.environmentId,
        session.agent,
        session.logicalSessionKey,
      );
      if (activity === "working" || activity === "waiting") return;
      if (provider?.turnTerminalError) {
        try {
          failure =
            (await provider.turnTerminalError(session.providerSessionId, requestId)) ?? undefined;
        } catch (error) {
          if (error instanceof ProviderUnavailableError && error.retryAfterMs !== undefined) {
            return error.retryAfterMs;
          }
          // Unreadable: leave the outcome for an observer rather than
          // recording a success nobody proved.
          return;
        }
      }
    }
    this.settleArtifactTurn(session, requestId);
    try {
      await this.storage.recordNativeAgentTurnOutcome(session.key, session.providerSessionId, {
        requestId,
        outcome: status === "error" || failure !== undefined ? "failed" : "completed",
        ...(failure ? { error: failure.slice(0, 500) } : {}),
        observedAt: new Date(this.now()).toISOString(),
      });
    } catch {
      // Best-effort bookkeeping; it must never fault the caller's drain.
    }
  }

  /** Delivery gate; recovers proven-unsent mail before checking its durable fence. */
  async mailInjectPresence(input: NativeAgentProjectionInput): Promise<MailboxPresence> {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const queueKey = `${input.agent}\0${input.logicalSessionKey}`;
    const draftKey = `${input.agent}:${input.environmentId}:${encodeURIComponent(input.logicalSessionKey)}`;
    let [environment, session, queue, draft] = await Promise.all([
      this.storage.getEnvironment(input.environmentId),
      this.storage.getNativeAgentSession(sessionKey),
      this.storage.getPromptQueue(queueKey),
      this.storage.getComposeDraft(draftKey),
    ]);
    if (session?.pendingDispatch?.mailRefused) {
      try {
        await this.storage.clearPendingNativeAgentDispatch(
          sessionKey,
          session.pendingDispatch.requestId,
          true,
        );
        session = await this.storage.getNativeAgentSession(sessionKey);
      } catch {
        return "working";
      }
    }
    if (!coordinatorIdFromRuntimeId(input.environmentId)) {
      if (!environment || environment.deletionRequestedAt || environment.status !== "running") {
        return "environment_stopped";
      }
      if (!isEnvironmentReadyForAgents(environment)) return "environment_unready";
    }
    if (composeDraftHoldsQueue(draft?.value)) return "draft";
    if (
      session?.pendingDispatch ||
      (queue && (queue.inFlight !== undefined || queue.messages.length > 0))
    ) {
      return "working";
    }
    const activity = this.launches.sessionTurnActivitySnapshot(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    // Idle presence is only as good as the observation behind it. A group the
    // observer has backed off keeps its retained idle between safety reads;
    // past the age the injection gate trusts, presence says `unknown` rather
    // than `idle`, so a slower observation never reads as permission to
    // inject (the gate then reads the provider itself).
    if (
      activity === "idle" &&
      !observationSatisfies(this.observations.view(sessionKey, session?.providerSessionId), {
        maxAgeMs: MAIL_INJECT_OBSERVATION_MAX_AGE_MS,
        requirePostDispatch: true,
      })
    ) {
      return "unknown";
    }
    return activity === "idle" || activity === "working" || activity === "waiting"
      ? activity
      : "unknown";
  }

  async reconcileMailInject(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    const candidates = [input];
    const coordinatorId = coordinatorIdFromRuntimeId(input.environmentId);
    const conversationId = coordinatorConversationIdFromRuntimeId(input.environmentId);
    // Mailbox synchronization upgrades routing to the renderer's tab key, but
    // an interrupted send still belongs to its original native-session row.
    // Read that row too, including during later verification passes/restarts;
    // never adopt it over an existing canonical transcript mapping.
    if (
      coordinatorId &&
      conversationId &&
      input.logicalSessionKey.startsWith(`env-${input.environmentId}:`)
    ) {
      candidates.push({
        ...input,
        logicalSessionKey: `coordinator-${coordinatorId}:${conversationId}`,
      });
    }
    const records = await Promise.all(
      candidates.map(async (candidate) => {
        const key = nativeAgentSessionStorageKey(
          candidate.environmentId,
          candidate.agent,
          candidate.logicalSessionKey,
        );
        return { candidate, key, session: await this.storage.getNativeAgentSession(key) };
      }),
    );
    if (records.some(({ session }) => session?.dispatchedRequestIds?.includes(input.requestId))) {
      return "dispatched";
    }
    let refused = false;
    let unresolved = false;
    for (const { candidate, key, session } of records) {
      if (session?.pendingDispatch?.requestId !== input.requestId) continue;
      if (session.pendingDispatch.mailRefused) refused = true;
      else if (
        (await this.settleAmbiguousDispatch(candidate, key, input.requestId)) === "confirmed"
      ) {
        return "dispatched";
      } else unresolved = true;
    }
    // A refusal in one identity cannot prove another identity's attempt unsent.
    return refused && !unresolved ? "not-dispatched" : "unknown";
  }

  async dispatchMailInject(
    input: DispatchNativeAgentPromptInput,
  ): Promise<MailInjectDispatchOutcome> {
    let heldReason: "parked" | "queue" | "draft" | "busy" | undefined;
    try {
      const result = await this.dispatchPromptInternal(
        { ...input, allowProviderCommands: false },
        async (session, provider) => {
          if (session.pendingDispatch && session.pendingDispatch.requestId !== input.requestId) {
            heldReason = "parked";
            return { dispatch: false };
          }
          const queueKey = `${input.agent}\0${input.logicalSessionKey}`;
          const queue = await this.storage.getPromptQueue(queueKey);
          if (queue && (queue.inFlight !== undefined || queue.messages.length > 0)) {
            heldReason = "queue";
            return { dispatch: false };
          }
          const draftKey = `${input.agent}:${input.environmentId}:${encodeURIComponent(input.logicalSessionKey)}`;
          const draft = await this.storage.getComposeDraft(draftKey);
          if (composeDraftHoldsQueue(draft?.value)) {
            heldReason = "draft";
            return { dispatch: false };
          }
          // The service-level idle observation happens before the message is
          // claimed. Recheck under the same durable per-session fence as a
          // normal prompt so whichever dispatch entered first has priority.
          //
          // A retained idle is trusted only while it is as fresh as the mail
          // presence lease and was read after the session's latest dispatch.
          // Anything older — a group the observer has backed off, a sweep that
          // has not run — is `unknown` here and costs one authoritative read:
          // slower observation must never read as permission to inject.
          //
          // This reads the turn, not the process: a session whose turn ended
          // but whose CLI still runs background subagents is free to take a
          // prompt, and the Claude bridge writes it into that same CLI rather
          // than resuming a second one. Holding on the raw state instead kept
          // mail from a tab's own subagents undelivered until all of them had
          // finished — long after anyone needed it.
          const observation = this.observations.view(session.key, session.providerSessionId);
          const observed = this.launches.sessionTurnActivitySnapshot(
            input.environmentId,
            input.agent,
            input.logicalSessionKey,
          );
          const activity =
            observed === "idle" &&
            !observationSatisfies(observation, {
              maxAgeMs: MAIL_INJECT_OBSERVATION_MAX_AGE_MS,
              requirePostDispatch: true,
            })
              ? "unknown"
              : observed;
          if (
            activity !== "idle" &&
            (activity !== "unknown" ||
              (await readProviderStatus(provider, session.providerSessionId)).status !== "idle")
          ) {
            heldReason = "busy";
            return { dispatch: false };
          }
          return { dispatch: true };
        },
        true,
        true,
      );
      if (result.pendingDispatch?.mailRefused) heldReason = "busy";
      if (heldReason === "busy") {
        const key = nativeAgentSessionStorageKey(
          input.environmentId,
          input.agent,
          input.logicalSessionKey,
        );
        try {
          await this.storage.clearPendingNativeAgentDispatch(key, input.requestId, true);
          if ((await this.storage.getNativeAgentSession(key))?.pendingDispatch) {
            return { outcome: "held", reason: "parked" };
          }
        } catch {
          return { outcome: "held", reason: "parked" };
        }
      }
      return heldReason
        ? { outcome: "held", reason: heldReason }
        : { outcome: "accepted", requestId: input.requestId };
    } catch (error) {
      if (error instanceof PendingNativeAgentDispatchError) {
        return { outcome: "held", reason: "parked" };
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        return { outcome: "unknown", requestId: input.requestId, error: error.message };
      }
      if (error instanceof ProviderUnavailableError) {
        // Readiness/attach can refuse before the dispatch window even opens.
        // Do not release an existing row: it may belong to an ambiguous send.
        const session = await this.storage.getNativeAgentSession(
          nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
        );
        if (!session?.pendingDispatch) return { outcome: "held", reason: "busy" };
      }
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Mail dispatch failed",
      };
    }
  }

  async dispatchPrompt(
    input: DispatchNativeAgentPromptInput,
  ): Promise<PersistedNativeAgentSession> {
    return this.dispatchPromptInternal(input);
  }

  private async dispatchPromptInternal(
    input: DispatchNativeAgentPromptInput,
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
    persistAmbiguousDispatch = false,
    mailInject = false,
  ): Promise<PersistedNativeAgentSession> {
    const releaseAgentWork = this.environmentFence.beginAgentWork(input.environmentId);
    try {
      return await this.promptQueues.withSessionMutationFence(input, () =>
        this.dispatchAdmittedPrompt(input, prepare, persistAmbiguousDispatch, mailInject),
      );
    } finally {
      releaseAgentWork();
    }
  }

  private async dispatchAdmittedPrompt(
    input: DispatchNativeAgentPromptInput,
    prepare:
      | ((
          session: PersistedNativeAgentSession,
          provider: NativeAgentRuntimeProvider,
        ) => Promise<PromptDispatchPreparation>)
      | undefined,
    persistAmbiguousDispatch: boolean,
    mailInject: boolean,
  ): Promise<PersistedNativeAgentSession> {
    input = await this.trustedSessionInput(input);
    const coordinatorContextRevision =
      input.owner?.kind === "coordinator"
        ? Number(input.prompt.match(/Repository context revision: (\d+)/)?.[1] ?? Number.NaN)
        : Number.NaN;
    const home =
      input.owner?.kind === "coordinator"
        ? null
        : await this.storage.getEnvironment(input.environmentId);
    const checkoutProjectId =
      input.owner?.kind === "coordinator"
        ? input.owner.projectId
        : isProjectHomeEnvironment(home)
          ? home!.projectId
          : undefined;
    const releaseCoordinatorTurn = checkoutProjectId
      ? this.options.beginCoordinatorTurn?.(checkoutProjectId)
      : undefined;
    try {
      if (isProjectHomeEnvironment(home))
        await reconcileProjectHomeEnvironment(home!, this.storage);
      this.assertAcceptingWork();
      // A rebuild or reset of this environment's runtime is in progress.
      this.environmentFence.assertAcceptsAgentWork(input.environmentId);
      const hasAttachments =
        (input.images?.length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0;
      if ((!nonBlank(input.prompt) && !hasAttachments) || !nonBlank(input.requestId)) {
        throw new Error("Native agent prompt or attachment and request ID must not be blank");
      }
      const session: PersistedNativeAgentSession = await this.ensureSession(input);
      // Freeze the effective inherited choice before preparing and journaling
      // dispatch. Retries replay this concrete model, never a stale default.
      if (input.modelSource === "default" || !input.model) {
        input = { ...input, model: session.controls?.modelId ?? input.model };
      }
      const provider = await this.provider(input);
      provider.registerSession?.(session.providerSessionId, {
        origin: session.origin,
        interactionPolicy: session.interactionPolicy,
        phase: input.phase,
      });
      /*
       * Decide what this submission executes before anything is journaled or
       * attached. A command that no longer exists, changed, or cannot accept
       * this input is refused here with the draft intact; it is never sent as
       * ordinary text instead.
       */
      const commandPlan = await this.planDispatchCommand(input, session, provider);
      if (commandPlan.kind === "rejected") throw new PromptRejectedError(commandPlan.message);
      if (commandPlan.kind === "session-action") {
        const result = await this.storage.dispatchNativeAgentPromptOnce(
          session.key,
          input.requestId,
          async (durable) => {
            await this.performCommandSessionAction(input, durable, provider, commandPlan.action);
          },
        );
        return result.session;
      }
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
      /*
       * Resolve the tab-scoped MCP credential once, before the warm-up attach.
       *
       * The bridge rebuilds its SDK session when the credential it was attached
       * with differs from the one on the prompt, so handing the attach the same
       * connection the prompt will send keeps a restarted session from paying a
       * second cold start. A resolution failure is swallowed here: the prompt
       * path resolves it authoritatively inside the dispatch window.
       */
      const resolveAgentMcp = async (
        durable: PersistedNativeAgentSession,
      ): Promise<{ url: string; token: string } | undefined> => {
        if (
          nativeAgentCapabilities(durable.agent).agentTools !== true ||
          durable.owner?.kind !== "environment" ||
          !this.options.resolveAgentToolConnection
        ) {
          return undefined;
        }
        const prefix = `env-${durable.environmentId}:`;
        const tabId = durable.logicalSessionKey.startsWith(prefix)
          ? durable.logicalSessionKey.slice(prefix.length)
          : "";
        const environment = tabId ? await this.storage.getEnvironment(durable.environmentId) : null;
        if (!environment) return undefined;
        return this.options.resolveAgentToolConnection(
          durable.environmentId,
          durable.owner.projectId,
          tabId,
          environment.environmentType === "local" ? "host" : "container",
        );
      };
      let dispatchAgentMcp: { url: string; token: string } | undefined;
      let dispatchAgentMcpResolved = false;
      try {
        dispatchAgentMcp = await resolveAgentMcp(session);
        dispatchAgentMcpResolved = true;
      } catch {
        // Best-effort; the prompt request resolves it authoritatively below.
      }
      await provider
        .prepareDispatch?.(session.providerSessionId, { agentMcp: dispatchAgentMcp })
        .catch((error: unknown) => {
          console.warn(
            `[native-agent] Attaching ${input.agent} before dispatch failed:`,
            error instanceof Error ? error.message : error,
          );
        });
      await this.prepareEnvironmentFirstPrompt(input, session, provider);
      /*
       * Validate liveness before opening the durable dispatch window, but do not
       * keep the global environments.json mutation lock across provider I/O.
       * The native-agent session lock below is the at-most-once fence; holding an
       * unrelated global lock here only stalls activity and deletion bookkeeping
       * for every environment while a provider is slow.
       *
       * Deletion may begin after this check, and physical teardown — the
       * container, the worktree — is no longer ordered behind this send at all.
       * That is the accepted trade: a send racing a teardown fails, and the user
       * asked for the environment to go away. What *is* still ordered is the part
       * that matters for at-most-once: an accepted request is confirmed
       * atomically under the native-agent lock, and deletion's session cleanup
       * queues behind that same lock, so it cannot remove the record mid-dispatch
       * and leave a confirmed turn unattributed.
       */
      await this.assertEnvironmentLive(input.environmentId);
      this.providerRegistry.beginDispatch(provider);
      try {
        let preparation: PromptDispatchPreparation = { dispatch: true };
        const result = await this.storage.dispatchNativeAgentPromptOnce(
          session.key,
          input.requestId,
          async (durable) => {
            if (!preparation.dispatch) {
              return {
                dispatched: false as const,
                ...(preparation.notice ? { incompleteTurnNotice: preparation.notice } : {}),
              };
            }
            // Reuse the credential resolved for the warm-up attach when it
            // succeeded; otherwise resolve it here, inside the at-most-once
            // window, which is the authoritative path.
            const agentMcp = dispatchAgentMcpResolved
              ? dispatchAgentMcp
              : await resolveAgentMcp(durable);
            /*
             * Fence every observation read that started before this point, or
             * runs while the send is in flight: its idle is the provider's
             * answer from before this turn and must never be applied after the
             * `working` recorded below (it would end a turn that just began).
             */
            // Change tracking captures the turn's start before the provider can write.
            const settleChangeTurn = await beginChangeTrackingTurn(
              this.options.changeTracking?.(),
              durable,
              input.requestId,
            );
            const artifactGrant = this.beginArtifactTurn(durable, input.requestId);
            const groupKey = nativeAgentObservationGroupKey(durable.environmentId, durable.agent);
            const releaseDispatchFence = this.observations.beginDispatch(durable.key, groupKey);
            try {
              await provider.send(durable.providerSessionId, preparation.prompt ?? input.prompt, {
                requestId: input.requestId,
                // Only a person typing into the composer can mean "run this
                // command"; workflow-authored prompts are literal text. The plan
                // above already applied that default and resolved any command.
                allowProviderCommands: commandPlan.allowProviderCommands,
                ...(commandPlan.command ? { command: commandPlan.command } : {}),
                images: input.images,
                attachments: input.attachments,
                schema: input.schema,
                mode: input.mode,
                fastMode: input.fastMode,
                subAgent: input.subAgent,
                executionAgent: preparation.executionAgent ?? input.executionAgent,
                includeLocalSettings: input.includeLocalSettings,
                promptSuggestions: input.promptSuggestions,
                model: preparation.model ?? input.model,
                effort:
                  durable.agent === "claude"
                    ? claudeReasoningSelection(
                        preparation.effort ??
                          input.reasoningEffort ??
                          durable.controls?.reasoningId,
                        durable.controls?.parameterValues,
                      )
                    : (preparation.effort ?? input.reasoningEffort),
                parameterValues: durable.controls?.parameterValues,
                persistDefaults: durable.controls?.persistDefaults,
                approvalMode: resolveNativeAgentApprovalMode(
                  durable.agent,
                  durable.policy,
                  durable.controls?.approvalMode,
                ),
                agentMcp,
                ...(artifactGrant ? { artifactGrant } : {}),
              });
              // Provider acceptance is the authoritative working edge. Record it
              // before the durable dispatch bookkeeping completes so a newer
              // idle activity snapshot cannot be overwritten by a late return
              // from storage.
              this.launches.recordObservedActivity(durable.key, {
                providerSessionId: durable.providerSessionId,
                state: "working",
              });
              this.observations.recordDispatchAccepted({
                sessionKey: durable.key,
                groupKey,
                providerSessionId: durable.providerSessionId,
              });
              settleChangeTurn("accepted");
            } catch (error) {
              settleChangeTurn(
                error instanceof AmbiguousPromptDispatchError ? "uncertain" : "rejected",
              );
              // Ambiguous dispatch may still be running. Reconciliation owns
              // settlement and the artifact grant until the outcome is known.
              if (!(error instanceof AmbiguousPromptDispatchError)) {
                this.settleArtifactTurn(durable, input.requestId);
              }
              if (
                mailInject &&
                error instanceof ProviderUnavailableError &&
                !(error instanceof AmbiguousPromptDispatchError)
              ) {
                return { dispatched: false as const, mailRefused: true as const };
              }
              throw error;
            } finally {
              releaseDispatchFence();
            }
          },
          persistAmbiguousDispatch && (session.origin === "interactive-native" || mailInject)
            ? this.persistedPendingDispatch({ ...input, command: commandPlan.persistedIntent })
            : undefined,
          async (durable) => {
            preparation = prepare ? await prepare(durable, provider) : { dispatch: true };
            if (!preparation.dispatch) return undefined;
            // The storage session lease also serializes durable control updates.
            // Recheck after provider preparation, immediately before delivery.
            if (input.requireSessionMode && durable.controls?.mode !== input.requireSessionMode) {
              throw new PromptRejectedError(
                "The session is no longer in Plan mode, so this read-only prompt was not sent. Switch the session back to Plan and retry, or cancel it.",
              );
            }
            return this.applySessionHeldDispatchModel(input, durable, provider);
          },
        );
        if (
          result.dispatched &&
          input.owner?.kind === "coordinator" &&
          Number.isSafeInteger(coordinatorContextRevision)
        ) {
          const coordinatorId = input.owner.coordinatorId;
          const conversationId = coordinatorConversationIdFromRuntimeId(input.environmentId);
          if (conversationId) {
            await this.storage
              .mutateCoordinatorWorkspace(input.owner.projectId, (workspace) =>
                workspace && workspace.id === coordinatorId
                  ? {
                      ...workspace,
                      conversations: workspace.conversations.map((conversation) =>
                        conversation.id === conversationId
                          ? {
                              ...conversation,
                              repositoryContextRevisionAcknowledged: Math.max(
                                conversation.repositoryContextRevisionAcknowledged ?? 0,
                                coordinatorContextRevision,
                              ),
                            }
                          : conversation,
                      ),
                      updatedAt: new Date(this.now()).toISOString(),
                    }
                  : workspace,
              )
              .catch((error) =>
                console.warn(
                  "[native-agent] Failed to acknowledge coordinator repository context:",
                  error instanceof Error ? error.message : error,
                ),
              );
          }
        }
        return result.session;
      } finally {
        this.providerRegistry.endDispatch(provider);
      }
    } finally {
      releaseCoordinatorTurn?.();
    }
  }

  /**
   * Persist and complete first-prompt naming at the backend dispatch boundary.
   *
   * The provider transcript is authoritative for adopted sessions: an empty
   * local request journal alone does not prove that this is the conversation's
   * first prompt. Naming failure remains cosmetic and never blocks dispatch.
   */
  private async prepareEnvironmentFirstPrompt(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
  ): Promise<void> {
    if ((session.dispatchedRequestIds?.length ?? 0) > 0 || !nonBlank(input.prompt)) return;
    try {
      const environment = await this.storage.getEnvironment(input.environmentId);
      if (!environment || !isGeneratedEnvironmentName(environment.name)) return;
      // Emptiness is all this needs; one message answers it on any transport
      // that can bound the read.
      const messages = await provider.messages(session.providerSessionId, { limit: 1 });
      if (messages.length > 0) return;
      await this.invoke("prepare_environment_first_prompt", {
        environmentId: input.environmentId,
        prompt: input.prompt,
      });
    } catch (error) {
      console.warn(
        `[native-agent] Failed to prepare first-prompt naming for ${input.environmentId}:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }

  private persistedPendingDispatch(
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
      ...(input.command ? { command: input.command } : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Resolve command intent against this session's authoritative catalogue.
   *
   * Absent intent keeps the historical default: an interactive composer's
   * text may invoke a command, anything a workflow, mail or schema authored is
   * literal. A selection that is not found gets one forced catalogue re-read,
   * because a list refreshed since the user picked it may simply be newer.
   */
  private async planDispatchCommand(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
  ): Promise<CommandDispatchPlan> {
    const intent: NativeAgentCommandIntent =
      input.allowProviderCommands === false
        ? { kind: "literal" }
        : (input.command ??
          (input.allowProviderCommands === true || session.origin === "interactive-native"
            ? { kind: "typed" }
            : { kind: "literal" }));
    const planInput = {
      platform: input.agent,
      agentLabel: AGENT_PLATFORM_LABELS[input.agent] ?? input.agent,
      prompt:
        input.owner?.kind === "coordinator" ? stripCoordinatorContext(input.prompt) : input.prompt,
      intent,
      structuredOutput: input.schema !== undefined,
      attachments: [
        ...(input.attachments ?? []).map((attachment) => ({ type: attachment.type })),
        ...(input.images ?? []).map(() => ({ type: "image" as const })),
      ],
    };
    const capabilities = nativeCapabilities(input.agent);
    if (!commandDispatchNeedsCatalogue(input.agent, planInput.prompt, intent)) {
      return planCommandDispatch({
        ...planInput,
        commands: [],
        catalogue: { status: "ready", revision: 0, enhanced: false },
      });
    }
    const supported =
      capabilities.slashCommands && Boolean(provider.slashCommands || provider.commandCatalogue);
    const read = async (force: boolean) =>
      supported
        ? this.catalogs.readCommandsForDispatch(input, provider, session.providerSessionId, force)
        : { commands: [], state: unsupportedCommandCatalogueState() };
    let snapshot = await read(false);
    const busy = (await readProviderStatus(provider, session.providerSessionId)).status !== "idle";
    let plan = planCommandDispatch({
      ...planInput,
      busy,
      commands: withSessionActionSlashCommands(snapshot.commands, capabilities),
      catalogue: snapshot.state,
    });
    if (plan.kind === "rejected" && plan.staleSelection && supported) {
      snapshot = await read(true);
      plan = planCommandDispatch({
        ...planInput,
        busy,
        commands: withSessionActionSlashCommands(snapshot.commands, capabilities),
        catalogue: snapshot.state,
      });
    }
    return plan;
  }

  /** Run a command that resolved to an Orkestrator session action. */
  private async performCommandSessionAction(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
    action: "compact",
  ): Promise<void> {
    const label = AGENT_PLATFORM_LABELS[input.agent] ?? input.agent;
    if (!nativeCapabilities(input.agent).actions?.compact || !provider.performSessionAction) {
      throw new PromptRejectedError(`${label} does not support /compact here.`);
    }
    if (session.pendingDispatch || session.pendingSteer) {
      throw new PromptRejectedError(PARKED_DISPATCH_CONFLICT_MESSAGE);
    }
    // Compacting mid-turn would rewrite the context a running turn is using.
    // The provider's own compact guard is the atomic fence; this check only
    // gives the common case a clear message before asking it.
    const { status } = await readProviderStatus(provider, session.providerSessionId);
    if (status === "running" || status === "blocked") {
      throw new PromptRejectedError(
        `/compact runs when ${label} is idle. Try again after this turn.`,
      );
    }
    const outcome = await provider.performSessionAction(session.providerSessionId, {
      kind: action,
    });
    this.projections.invalidateProjection(session.key);
    if (outcome.outcome !== "applied") {
      throw new PromptRejectedError(
        outcome.outcome === "idle"
          ? `${label} had nothing to compact.`
          : `${label} did not confirm the compaction. Check the transcript before retrying.`,
      );
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribeObservationWakeups?.();
    this.unsubscribeObservationWakeups = null;
    this.launches.stopTimer();
    this.promptQueues.stopScheduling();
    this.interactions.stop();
    await Promise.allSettled([
      ...this.projections.pendingRefreshes(),
      ...this.catalogs.pendingWork(),
    ]);
    await this.projections.settleAndClearProgressiveReads();
    await Promise.allSettled(this.scanTasks);
    while (
      this.launches.pendingLaunchTasks().length > 0 ||
      this.promptQueues.pendingDrains().length > 0 ||
      this.turnRecovery.pendingTasks().length > 0
    ) {
      await Promise.allSettled([
        ...this.launches.pendingLaunchTasks(),
        ...this.promptQueues.pendingDrains(),
        ...this.turnRecovery.pendingTasks(),
      ]);
    }
    await this.providerRegistry.shutdown();
    this.observations.clear();
    this.turnRecovery.clear();
    this.catalogs.clear();
    this.projections.clear();
  }

  /**
   * One provider per environment and agent.
   *
   * Model and effort are deliberately excluded from the key and passed per call
   * instead: keying on them accumulated an undisposed provider — and for
   * OpenCode a permanent event stream — for every variant a user ever queued.
   */
  /**
   * Forget a closed provider session's in-memory registration on the cached
   * provider, if one exists. Never resolves or starts a bridge: tab teardown
   * calls this after the provider-side close was confirmed, and only when no
   * other logical tab still maps to the same provider session.
   */
  releaseProviderSession(
    environmentId: string,
    agent: EnsureNativeAgentSessionInput["agent"],
    providerSessionId: string,
  ): void {
    this.providerRegistry
      .cached(providerCacheKey(environmentId, agent))
      ?.releaseSession?.(providerSessionId);
  }

  /**
   * The identity a later resume of this live session must name, read before
   * the session is closed. Codex resumes a thread, not the bridge session that
   * served it; providers that report nothing resume by the live id itself.
   *
   * Observe only: never starts a bridge. `undefined` when no bridge answers
   * or the read fails, so a caller never mistakes a guess for an identity.
   */
  async resumableSessionIdIfRunning(
    environmentId: string,
    agent: EnsureNativeAgentSessionInput["agent"],
    providerSessionId: string,
  ): Promise<string | undefined> {
    const provider = await this.observeProvider({
      environmentId,
      agent,
      logicalSessionKey: "tab-close",
    }).catch(() => undefined);
    if (!provider?.sessionStateSnapshot) return undefined;
    const snapshot = await provider.sessionStateSnapshot(providerSessionId).catch(() => undefined);
    if (!snapshot || snapshot.status === "missing") return undefined;
    const resumable = snapshot.resumableSessionId?.trim();
    return resumable || (agent === "codex" ? undefined : providerSessionId);
  }

  /**
   * Tab close through the provider, so the provider's own close runs: for
   * OpenCode that settles workflow-turn ownership, restores temporary reviewer
   * permissions and rejects pending requests before forgetting the session.
   *
   * Never starts a bridge. The cached provider is used only while it still
   * points at the running bridge; a restarted bridge gets a fresh provider,
   * cached like any other. `not-running` means no bridge answers, so the
   * caller keeps its durable intent.
   */
  async closeProviderSessionIfRunning(
    environmentId: string,
    agent: EnsureNativeAgentSessionInput["agent"],
    providerSessionId: string,
  ): Promise<"closed" | "not-running" | "unsupported"> {
    this.assertAcceptingWork();
    const cacheKey = providerCacheKey(environmentId, agent);
    const input = { environmentId, agent, logicalSessionKey: "tab-close" };
    let provider: NativeAgentRuntimeProvider | undefined;
    if (this.options.provider) {
      this.providerRegistry.clearBridgeAbsent(cacheKey);
      provider = await this.observeProvider(input);
    } else {
      const environment = await this.assertEnvironmentLive(environmentId);
      const connection = await this.observeBridgeConnection(agent, environment);
      if (!connection) return "not-running";
      const identity = bridgeConnectionIdentity(connection);
      const cached = this.providerRegistry.cachedForConnection(cacheKey, identity);
      if (cached) {
        provider = cached;
      } else {
        this.assertAcceptingWork();
        provider = createNativeAgentProvider(connection, {
          stageImages: (images) => this.stageImages(environmentId, images),
          environment: this.providerEnvironment(environmentId),
        });
        this.providerRegistry.cache(cacheKey, provider, identity);
      }
    }
    if (!provider) return "not-running";
    if (!provider.closeSession) return "unsupported";
    await provider.closeSession(providerSessionId);
    return "closed";
  }

  /** Destructive lifecycle admission: fresh metadata reads, without starting a bridge. */
  async assertEnvironmentIdleForMove(environmentId: string): Promise<void> {
    const sessions = (await this.storage.listNativeAgentSessions()).filter(
      (session) => session.environmentId === environmentId,
    );
    for (const session of sessions) {
      if (session.pendingDispatch)
        throw new Error("An agent submission is unresolved; settle it before moving");
      if (!session.providerSessionId) continue;
      this.providerRegistry.clearBridgeAbsent(providerCacheKey(environmentId, session.agent));
      const input = {
        environmentId,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
      };
      let provider: NativeAgentRuntimeProvider | undefined;
      if (this.options.provider) {
        provider = await this.observeProvider(input);
      } else {
        // The move stops bridges between its two reads. Cached providers can
        // still point at a stopped child, so verify its current connection.
        const connection = await this.observeBridgeConnection(
          session.agent,
          await this.assertEnvironmentLive(environmentId),
        );
        if (connection) {
          const key = providerCacheKey(environmentId, session.agent);
          const identity = bridgeConnectionIdentity(connection);
          const cached = this.providerRegistry.cachedForConnection(key, identity);
          if (cached) provider = cached;
          else {
            provider = createNativeAgentProvider(connection, {});
            this.providerRegistry.cache(key, provider, identity);
          }
        }
      }
      if (!provider) {
        const observed = this.launches.observedActivity(session.key);
        if (observed && observed.state !== "idle")
          throw new Error(
            "An agent is running in this environment; wait for it to finish before moving",
          );
        continue;
      }
      if (!provider.activity)
        throw new Error("Agent activity cannot be verified; stop the agent before moving");
      const state = await provider.activity(session.providerSessionId);
      if (state !== "idle" && state !== "missing")
        throw new Error(
          "An agent is running in this environment; wait for it to finish before moving",
        );
      this.launches.recordObservedActivity(session.key, {
        providerSessionId: session.providerSessionId,
        state: "idle",
      });
    }
  }

  /**
   * Reload MCP configuration in an environment's *already running* bridge.
   *
   * Resolves the provider the way the activity sweep does, so it never starts
   * a bridge, and calls a session-free bridge route, so it neither touches a
   * session's liveness nor re-attaches an idle thread — and it still works
   * after a bridge restart forgot every session. `not-running` is an answer:
   * a process that is not running reads the saved file when it starts.
   */
  async reloadMcpConfigurationIfRunning(
    environmentId: string,
    agent: BuildPipelineAgent,
  ): Promise<"reloaded" | "not-running" | "unsupported" | "busy"> {
    const provider = await this.observeProvider({
      environmentId,
      agent,
      logicalSessionKey: "mcp-configuration-reload",
    });
    if (!provider) return "not-running";
    if (!provider.reloadMcpConfiguration) return "unsupported";
    return provider.reloadMcpConfiguration();
  }

  /**
   * Names of the MCP servers an environment's *already running* OpenCode
   * server lists for its worktree, resolved like
   * {@link reloadMcpConfigurationIfRunning}: never starts a process.
   * OpenCode's inventory is directory-level, so no session is named.
   * `undefined` when nothing is running.
   */
  async openCodeMcpServerNamesIfRunning(environmentId: string): Promise<string[] | undefined> {
    const provider = await this.observeProvider({
      environmentId,
      agent: "opencode",
      logicalSessionKey: "mcp-configuration-reload",
    });
    const servers = await provider?.mcpServers?.("");
    return servers?.map((server) => server.name);
  }

  /**
   * Which saved MCP configuration a session's live runtime was built from,
   * for the MCP apply scheduler only.
   *
   * Observation-only on every hop: the persisted mapping supplies the
   * provider session id, the provider is resolved the way the activity sweep
   * resolves it (never starting a bridge), and the bridge route read is
   * `/runtime-health`, which touches no liveness, hydrates no transcript and
   * re-attaches nothing. The answer is never projected to a renderer.
   */
  async mcpConfigEvidenceIfRunning(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): Promise<ProviderMcpConfigEvidenceRead> {
    const session = await this.storage.getNativeAgentSession(
      shared.nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
    );
    if (!session?.providerSessionId) return { state: "none" };
    const provider = await this.observeProvider({ environmentId, agent, logicalSessionKey });
    if (!provider) return { state: "not-running" };
    if (!provider.mcpConfigEvidence) return { state: "none" };
    return provider.mcpConfigEvidence(session.providerSessionId);
  }

  private trackScan(task: Promise<void>): Promise<void> {
    const tracked = task.finally(() => {
      this.scanTasks.delete(tracked);
    });
    this.scanTasks.add(tracked);
    return tracked;
  }

  private assertAcceptingWork(): void {
    if (this.stopped) throw new Error("Native agent service is shut down");
  }

  private async assertEnvironmentLive(environmentId: string): Promise<Environment> {
    this.assertAcceptingWork();
    const coordinator = await resolveCoordinatorRuntime(this.storage, environmentId);
    if (coordinator.status === "unavailable") {
      throw new Error(coordinatorRuntimeUnavailableMessage(coordinator));
    }
    if (coordinator.status === "ready") {
      return coordinatorRuntimeEnvironment(environmentId, coordinator);
    }
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || environment.deletionRequestedAt) {
      throw new Error("Native agent environment is unavailable");
    }
    this.assertAcceptingWork();
    return environment;
  }

  private assertSessionIdentity(
    session: PersistedNativeAgentSession,
    input: EnsureNativeAgentSessionInput,
    key: string,
  ): void {
    if (
      session.key !== key ||
      session.environmentId !== input.environmentId ||
      session.agent !== input.agent ||
      session.logicalSessionKey !== input.logicalSessionKey ||
      (input.origin !== undefined && session.origin !== input.origin) ||
      (input.interactionPolicy !== undefined &&
        session.interactionPolicy.mode !== input.interactionPolicy.mode) ||
      (input.owner !== undefined &&
        session.owner !== undefined &&
        agentSessionOwnerKey(session.owner) !== agentSessionOwnerKey(input.owner)) ||
      (input.executionPolicy !== undefined &&
        session.executionPolicy !== undefined &&
        session.executionPolicy !== input.executionPolicy) ||
      (input.policy !== undefined &&
        session.policy !== undefined &&
        JSON.stringify(session.policy) !== JSON.stringify(input.policy))
    ) {
      throw new Error("Native agent session key collision");
    }
  }

  private async createProviderSession(
    provider: NativeAgentRuntimeProvider,
    input: EnsureNativeAgentSessionInput,
  ): Promise<string> {
    await this.assertEnvironmentLive(input.environmentId);
    const environment = await this.storage.getEnvironment(input.environmentId);
    const prefix = `env-${input.environmentId}:`;
    const tabId = input.logicalSessionKey.startsWith(prefix)
      ? input.logicalSessionKey.slice(prefix.length)
      : "";
    const agentMcp =
      nativeAgentCapabilities(input.agent).agentTools === true &&
      input.owner?.kind === "environment" &&
      tabId &&
      environment &&
      this.options.resolveAgentToolConnection
        ? this.options.resolveAgentToolConnection(
            input.environmentId,
            input.owner.projectId,
            tabId,
            environment.environmentType === "local" ? "host" : "container",
          )
        : undefined;
    const options = {
      clientSessionKey: input.logicalSessionKey,
      model: input.model,
      effort: input.reasoningEffort,
      mode: input.sessionMode,
      fastMode: input.fastMode,
      agentMcp,
      policy: input.policy,
      interaction: {
        origin: input.origin ?? "interactive-native",
        interactionPolicy:
          input.interactionPolicy ??
          (input.origin === "build-pipeline" || input.origin === "looped-review"
            ? UNATTENDED_AGENT_INTERACTION_POLICY
            : INTERACTIVE_AGENT_INTERACTION_POLICY),
        phase: input.phase,
      },
    };
    const maxAttempts =
      input.agent === "cursor" || input.agent === "grok" || input.agent === "pi"
        ? ACP_SESSION_CREATE_ATTEMPTS
        : 1;
    let providerSessionId: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        providerSessionId = await provider.createSession(
          input.phase ?? "build",
          input.title?.trim() || "Agent Session",
          options,
        );
        break;
      } catch (error) {
        if (!(error instanceof ProviderUnavailableError) || attempt === maxAttempts) {
          throw error;
        }
        // ACP and Pi session/create are both idempotent by clientSessionKey.
        // Retrying here keeps a short bridge initialization race represented as
        // "connecting" by the waiting renderer, without risking two sessions.
        // Pi belongs here because its cold start builds a model runtime the
        // same way an ACP spawn does.
        await this.assertEnvironmentLive(input.environmentId);
        const delay = ACP_SESSION_CREATE_RETRY_BASE_MS * 2 ** (attempt - 1);
        await (this.options.delay
          ? this.options.delay(delay)
          : new Promise<void>((resolve) => setTimeout(resolve, delay)));
      }
    }
    if (!providerSessionId) {
      throw new ProviderUnavailableError(`${input.agent} session creation did not complete`);
    }
    await this.assertEnvironmentLive(input.environmentId);
    return providerSessionId;
  }
}
