import * as shared from "./native-agent-service-shared.js";
import { withProviderSessionTeardownLock } from "./provider-session-ownership.js";
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
} from "@orkestrator/protocol/coordinator";
import {
  NativeAgentCommandCatalogueCache,
  commandCatalogueKey,
} from "./native-agent-command-catalogue.js";
import type {
  NativeAgentCommandRefreshOutcome,
  NativeAgentDefaultModelResolution,
  NativeAgentModelSubstitution,
} from "@orkestrator/protocol/native-agent";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  coordinatorRuntimeUnavailableMessage,
  resolveCoordinatorRuntime,
} from "./coordinator-runtime.js";
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
} from "./native-agent-service-shared.js";
import { localAgentAccountIds } from "./agent-account-bridge-state.js";
import type { NativeAgentProviderEnvironment } from "./native-agent-provider.js";
import { assertValidPromptImages, mimeTypeForImageData } from "./prompt-attachments.js";
import { ProviderRegistry } from "./native-agent-provider-registry.js";
import { NATIVE_AGENT_SESSION_VERSION } from "./models.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { NativeAgentObservationBroker } from "./native-agent-observation.js";
import { NativeAgentTurnRecovery } from "./native-agent-turn-recovery.js";
import { NativeQueueScheduling } from "./native-agent-queue-scheduling.js";
import { DEFAULT_WORKFLOW_DISCOVERY_MS, keyedSchedulingEnabled } from "./workflow-supervisor.js";
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
type IncompleteTurnNotice = shared.IncompleteTurnNotice;
type PersistedNativeAgentSession = shared.PersistedNativeAgentSession;
/**
 * An ensured session, plus the model substitution its creation made. The
 * substitution is reported to the caller only and is never persisted.
 */
export type EnsuredNativeAgentSession = PersistedNativeAgentSession & {
  modelSubstitution?: NativeAgentModelSubstitution;
};
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
type InspectNativeAgentSessionInput = shared.InspectNativeAgentSessionInput;
type NativeAgentProjectionInput = shared.NativeAgentProjectionInput;
type NativeAgentProjectionCacheEntry = shared.NativeAgentProjectionCacheEntry;
type NativeAgentSyncState = shared.NativeAgentSyncState;
type NativeAgentHistoryState = shared.NativeAgentHistoryState;
type NativeAgentActivityTransition = shared.NativeAgentActivityTransition;
type NativeAgentServiceOptions = shared.NativeAgentServiceOptions;
type AgentInteractionObservation = shared.AgentInteractionObservation;
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
  IncompleteTurnNotice,
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
  InspectNativeAgentSessionInput,
  NativeAgentProjectionInput,
  NativeAgentProjectionCacheEntry,
  NativeAgentActivityTransition,
  NativeAgentServiceOptions,
  AgentInteractionObservation,
  PromptDispatchPreparation,
];

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

export abstract class NativeAgentServiceBase {
  private readonly sessionWorkFences = new Map<string, Promise<void>>();
  private sessionWorkFenceCount = 0;
  protected readonly pendingSessionMutations = new Map<string, number>();

  /** Make waiting user work visible before it can acquire the publication fence. */
  protected withSessionMutationFence<T>(
    input: NativeAgentProjectionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withSessionMutationIntent(input, () => this.withSessionWorkFence(input, operation));
  }

  /** Stop publishes its intent immediately, without waiting behind a cold dispatch. */
  protected async withSessionMutationIntent<T>(
    input: NativeAgentProjectionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (!this.pendingSessionMutations.has(key) && this.pendingSessionMutations.size >= 1024) {
      throw new Error("Native session mutation admission is at capacity");
    }
    this.pendingSessionMutations.set(key, (this.pendingSessionMutations.get(key) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.pendingSessionMutations.get(key) ?? 1) - 1;
      if (remaining > 0) this.pendingSessionMutations.set(key, remaining);
      else this.pendingSessionMutations.delete(key);
    }
  }
  /** Failed interrupt writes remain publication fences until storage acknowledges them. */
  protected readonly pendingTurnInterrupts = new Map<
    string,
    {
      providerSessionId: string;
      requestId: string;
    }
  >();
  protected interruptFenceOverflow = false;

  /** Orders publication admission against dispatch and Stop for this session only. */
  async withSessionWorkFence<T>(
    input: NativeAgentProjectionInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (this.sessionWorkFenceCount >= 1024)
      throw new Error("Native session work admission is at capacity");
    this.sessionWorkFenceCount += 1;
    const previous = this.sessionWorkFences.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.sessionWorkFences.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      this.sessionWorkFenceCount -= 1;
      if (this.sessionWorkFences.get(key) === tail) this.sessionWorkFences.delete(key);
    }
  }

  /** Cached runtime providers, their bridge generations and their retirement. */
  protected readonly providerRegistry: ProviderRegistry;
  /** Bounded, reconstructible view cache; providers remain authoritative. */
  protected readonly projectionCache = new Map<string, NativeAgentProjectionCacheEntry>();
  /** Bounded wire revisions for conditional/delta projection reads. */
  protected readonly projectionSync = new Map<string, NativeAgentSyncState>();
  /**
   * One revision sequence per logical native-agent session.
   *
   * The legacy full-projection representation and the sync-v1 live tail are
   * cached under different keys but describe the same session and carry the
   * same generation, and the renderer compares `revision` as a single ordering.
   * Allocating from separate per-key counters let the sync counter run ahead,
   * so an authoritative projection returned by a mutation could arrive with a
   * lower revision than the client already held and be discarded as stale.
   */
  protected readonly projectionRevisions = new Map<
    string,
    { generation: string; revision: number }
  >();
  protected projectionSyncBytes = 0;
  /** Bounded normalized transcript source for independent history pages. */
  protected readonly projectionHistory = new Map<string, NativeAgentHistoryState>();
  protected projectionHistoryBytes = 0;
  /**
   * When each projection key's current run of `missing` provider reads began.
   *
   * Dates the `connecting` overlay so the grace can expire into a reportable
   * failure. Cleared by any read that finds the session, and by every path that
   * drops the key's cache entry, so it stays bounded by `projectionCache`
   * rather than growing with key churn.
   */
  protected readonly projectionMissingSince = new Map<string, number>();
  /** Heavy, reconstructible fields omitted from ordinary renderer snapshots. */
  protected readonly toolDetailCache = new Map<
    string,
    {
      sessionKey: string;
      details: NativeAgentToolDetails;
      bytes: number;
      /** Exact provider-reported image path; never supplied by the renderer. */
      localImagePath?: string;
      /**
       * A provider-held body behind a summary locator, fetched on first
       * expansion. `resolved` once `details` holds the exact body.
       */
      remote?: { providerSessionId: string; locator: string; resolved: boolean };
    }
  >();
  /** Entries temporarily protected while an authoritative refresh recreates them. */
  protected readonly pinnedToolDetailRefs = new Set<string>();
  protected toolDetailCacheBytes = 0;
  protected readonly modelCatalogCache = new Map<
    string,
    { models: AgentModel[]; expiresAt: number }
  >();
  /** Authoritative, bounded command catalogues; see native-agent-command-catalogue.ts. */
  protected readonly commandCatalogues = new NativeAgentCommandCatalogueCache({
    now: () => this.now(),
    announce: (environmentId) => {
      if (!this.stopped) this.storage.announceNativeAgentSessionProjection(environmentId);
    },
  });
  /** Coalesced stale-while-revalidate tasks for projection-only metadata. */
  protected readonly modelCatalogRefreshes = new Map<
    string,
    {
      operation: Promise<AgentModel[]>;
      validity: { current: boolean };
    }
  >();
  protected readonly launchTasks = new Map<string, Promise<void>>();
  protected readonly launchRetryAt = new Map<string, number>();
  protected readonly queueTasks = new Map<string, Promise<void>>();
  protected readonly queueRetryAt = new Map<string, number>();
  /** Keyed launch/queue driver (step 08); `null` on the rollback timer. */
  protected queueScheduling: NativeQueueScheduling | null = null;
  protected readonly queueAttempts = new Map<string, number>();
  protected readonly scanTasks = new Set<Promise<void>>();
  protected readonly activityRetryAt = new Map<string, number>();
  protected readonly activityAttempts = new Map<string, number>();
  /** Last provider-owned state per durable session, used for exact turn edges. */
  protected readonly observedSessionActivity = new Map<
    string,
    {
      providerSessionId: string;
      state: AgentActivityState;
      readyForInput?: boolean;
      completionPending?: boolean;
      /** The provider's content revision at this observation, when it reports one. */
      contentRevision?: string;
    }
  >();
  /**
   * Shared observation records, dispatch/generation fences and next-due
   * provider groups (recurring-processes step 07). `observedSessionActivity`
   * above stays the edge state machine; the broker says how old, how
   * trustworthy and how reusable each answer is.
   */
  protected readonly observations: NativeAgentObservationBroker;
  protected unsubscribeObservationWakeups: (() => void) | null = null;
  /**
   * Automatic continuation of incomplete turns, for platforms with a recovery
   * strategy, and the manual-prompt claims that keep it from racing the user.
   */
  protected readonly turnRecovery: NativeAgentTurnRecovery;

  protected abstract trackScan(task: Promise<void>): Promise<void>;
  /** Resolves with how many environments still carry a launch intent. */
  protected abstract reconcilePendingLaunches(): Promise<number>;
  protected abstract drainPromptQueues(): Promise<void>;
  /** Drop cached pending-interaction reads after one of them is answered. */
  protected abstract forgetPendingInteractions(key: string): void;
  abstract reconcileAgentInteractions(): Promise<void>;
  protected abstract assertAcceptingWork(): void;
  protected abstract assertEnvironmentLive(environmentId: string): Promise<Environment>;
  protected abstract assertSessionIdentity(
    session: PersistedNativeAgentSession,
    input: EnsureNativeAgentSessionInput,
    key: string,
  ): void;
  protected abstract createProviderSession(
    provider: NativeAgentRuntimeProvider,
    input: EnsureNativeAgentSessionInput,
  ): Promise<string>;
  protected abstract assertProjectionInput(input: NativeAgentProjectionInput): void;
  protected abstract refreshProjection(
    input: NativeAgentProjectionInput,
    force: boolean,
    resolvedSession?: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
      transient: true;
    },
  ): Promise<NativeAgentSessionProjection | null>;
  protected abstract dispatchIntentInternal(
    input: DispatchNativeAgentPromptInput,
    preserveExistingPending: boolean,
  ): Promise<NativeAgentDispatchOutcome>;
  protected abstract dispatchPromptInternal(
    input: DispatchNativeAgentPromptInput,
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
    persistAmbiguousDispatch?: boolean,
  ): Promise<PersistedNativeAgentSession>;
  protected abstract invalidateProjection(key: string): void;
  protected abstract drainPromptQueue(queueKey: string): Promise<void>;
  protected abstract composeDraftHoldsQueue(value: unknown): boolean;
  protected abstract queueExecutionMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): ProviderExecutionMode;
  protected abstract queueDispatchMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): ProviderExecutionMode | undefined;
  protected abstract queueString(message: unknown, field: string): string | undefined;
  protected abstract queueReasoningEffort(message: unknown): string | undefined;
  protected abstract queueFastMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): boolean | undefined;
  protected abstract queueBoolean(message: unknown, field: string): boolean | undefined;
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
  protected readonly projectionRefreshDescriptors = new Map<
    string,
    { epoch: number; signature: string }
  >();
  /** Invalidates an in-flight read when a logical tab changes provider identity. */
  protected readonly projectionEpochs = new Map<string, number>();
  /** Session-scoped stop result retained until the next authoritative projection. */
  protected readonly stopNotices = new Map<string, string>();
  /** One best-effort provider title push per backend-derived title. */
  protected readonly pushedSessionTitles = new Map<string, string>();
  /** Round-robin offsets keep bounded scans from permanently favouring old sessions. */
  protected readonly interactionSelectionCursors = new Map<string, number>();
  protected interactionGlobalSelectionCursor = 0;
  protected activityScan: Promise<void> | null = null;
  /** Number of the latest sweep started; demands compare against it. */
  protected activityScanNumber = 0;
  /** One follow-up scan shared by every consumer demanding a newer read. */
  protected activityScanFollowUp: Promise<void> | null = null;
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
    this.interactionMonitorAdoptionEnabled = options.interactionMonitorAdoptionEnabled !== false;
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
          // Interactive sessions belong to a tab that renders approvals and
          // questions. Answering them here would run a command the user never saw
          // and cancel the card that exists to answer it.
          autoAnswerRequests: false,
          onObservationHint: () => this.observations.wakeGroup(cacheKey, "provider-event"),
          stageImages: (images) => this.stageImages(environmentId, images),
          environment: this.providerEnvironment(environmentId),
        }),
      forgetGroup: (cacheKey) => {
        this.activityRetryAt.delete(cacheKey);
        this.activityAttempts.delete(cacheKey);
      },
    });
    this.turnRecovery = new NativeAgentTurnRecovery({
      storage,
      now: () => this.now(),
      isStopped: () => this.stopped,
      assertAcceptingWork: () => this.assertAcceptingWork(),
      observeProvider: (input) => this.observeProvider(input),
      dispatchPrompt: (input, prepare) => this.dispatchPromptInternal(input, prepare),
      observedActivity: (key) => this.observedSessionActivity.get(key),
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
              this.queueScheduling?.queueChanged(change.id);
              return;
            }
            if (change.resource === "environment") {
              this.queueScheduling?.wakeEnvironment(change.id);
              return;
            }
            if (change.resource !== "native-agent-session") return;
            this.observations.wakeEnvironment(change.id, "session-mutation", change.agent);
          })
        : null;
  }

  protected now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Resolve a provider, starting its bridge if needed. */
  protected provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider> {
    return this.providerRegistry.resolve(input);
  }

  /** Resolve a provider for observation only, never starting a bridge. */
  protected observeProvider(
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
  protected providerEnvironment(environmentId: string): NativeAgentProviderEnvironment {
    // Read per call rather than per provider: providers are cached for the
    // life of a bridge connection, so a settings edit would otherwise not
    // reach the model catalogue until the environment restarted.
    const loadConfig = () => this.storage.loadConfig();
    return typeof this.storage.getDataDir === "function"
      ? { environmentId, dataDir: this.storage.getDataDir(), loadConfig }
      : { environmentId, loadConfig };
  }

  /** Stage base64 images into the workspace so a bridge will accept them. */
  protected async stageImages(
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

  protected async bridgeConnection(
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
          ? { accountId: localAgentAccountIds.get(`${agent}:${environment.id}`) ?? "unknown" }
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
  protected async observeBridgeConnection(
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
          ? { accountId: localAgentAccountIds.get(`${agent}:${environment.id}`) ?? "unknown" }
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
  protected async trustedSessionInput<T extends EnsureNativeAgentSessionInput>(
    input: T,
  ): Promise<T> {
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

  protected async initialize(): Promise<void> {
    await this.repairPersistedStartupTabs().catch(() => undefined);
    await Promise.allSettled([
      this.trackScan(this.observedLaunchScan()),
      this.trackScan(this.observedQueueScan()),
    ]);
    if (this.stopped) return;
    const launchReconcileIntervalMs = this.options.launchReconcileIntervalMs;
    const progressMs = Number.isFinite(launchReconcileIntervalMs)
      ? Math.max(20, launchReconcileIntervalMs as number)
      : 2_000;
    if (this.options.keyedQueueScheduling ?? keyedSchedulingEnabled("native-queues")) {
      this.queueScheduling = new NativeQueueScheduling(
        {
          launchScan: () => this.trackCount(this.observedLaunchCount()),
          listQueues: () => this.storage.listAllPromptQueues(),
          drainQueue: (queueKey) => this.trackScan(this.drainPromptQueue(queueKey)),
          queueRetryDelayMs: (queueKey) =>
            Math.max(0, (this.queueRetryAt.get(queueKey) ?? 0) - Date.now()),
        },
        {
          progressIntervalMs: progressMs,
          // Safety discovery. A test that shortens the launch cadence keeps
          // discovery at that cadence; production uses the 30 s interval.
          discoveryIntervalMs:
            this.options.queueDiscoveryIntervalMs ??
            (Number.isFinite(launchReconcileIntervalMs)
              ? progressMs
              : DEFAULT_WORKFLOW_DISCOVERY_MS),
          ...(this.options.queueSchedulerClock
            ? {
                now: this.options.queueSchedulerClock.now,
                timers: this.options.queueSchedulerClock.timers,
              }
            : {}),
        },
      );
      this.queueScheduling.start();
    } else {
      this.launchTimer = setInterval(() => {
        if (this.stopped) return;
        void this.trackScan(this.observedLaunchScan()).catch(() => undefined);
        void this.trackScan(this.observedQueueScan()).catch(() => undefined);
      }, progressMs);
      this.launchTimer.unref?.();
    }
    if (this.options.interactionMonitorMode === "observe-only") {
      await this.reconcileAgentInteractions().catch(() => undefined);
      if (this.stopped) return;
      this.interactionTimer = setInterval(
        () => {
          void this.reconcileAgentInteractions().catch(() => undefined);
        },
        Math.max(100, this.options.interactionMonitorIntervalMs ?? 2_000),
      );
      this.interactionTimer.unref?.();
    }
  }

  /** Neither sweep has an overlap guard; every tick is a full started pass. */
  private observedLaunchScan(): Promise<void> {
    recurringWorkMetrics.requested("native-launch-scan");
    return recurringWorkMetrics
      .observe("native-launch-scan", () => this.reconcilePendingLaunches())
      .then(() => undefined);
  }

  /** The keyed launch job: the scheduler already observes it as one attempt. */
  private observedLaunchCount(): Promise<number> {
    return this.reconcilePendingLaunches();
  }

  /** Tracks a counted scan so shutdown drains it like any other scan. */
  private async trackCount(task: Promise<number>): Promise<number> {
    let count = 0;
    await this.trackScan(
      task.then((value) => {
        count = value;
      }),
    );
    return count;
  }

  private observedQueueScan(): Promise<void> {
    recurringWorkMetrics.requested("native-queue-scan");
    return recurringWorkMetrics.observe("native-queue-scan", () => this.drainPromptQueues());
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
          void this.reconcileAgentInteractions().catch(() => undefined);
          return enriched;
        }
        void this.reconcileAgentInteractions().catch(() => undefined);
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
    void this.reconcileAgentInteractions().catch(() => undefined);
    // A concurrent ensure may have created the session first, with its own
    // controls; only report a substitution this session actually carries.
    return modelSubstitution && session.controls?.modelId === modelSubstitution.modelId
      ? { ...session, modelSubstitution }
      : session;
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
    return this.withSessionMutationFence(input, () => this.adoptSessionUnderFence(input));
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
        void this.reconcileAgentInteractions().catch(() => undefined);
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
    return this.refreshProjection(
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
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(sessionKey);
    if (session) this.assertSessionIdentity(session, input, sessionKey);
    const provider = await this.provider(input);
    const slashCommandKey = commandCatalogueKey(
      input.environmentId,
      input.agent,
      session?.providerSessionId,
    );
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
    this.modelCatalogCache.delete(input.environmentId);
    this.commandCatalogues.invalidate(slashCommandKey);
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
    return this.refreshProjection(input, true);
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
    const provider = await this.provider(input);
    const capabilities = nativeCapabilities(input.agent);
    const supported =
      capabilities.slashCommands && Boolean(provider.slashCommands || provider.commandCatalogue);
    const result = supported
      ? await this.commandCatalogues.refresh(
          commandCatalogueKey(input.environmentId, input.agent, session?.providerSessionId),
          input.environmentId,
          provider,
          session?.providerSessionId,
        )
      : { outcome: "unsupported" as const };
    this.invalidateProjection(sessionKey);
    return { ...result, projection: await this.refreshProjection(input, true) };
  }

  /** Called when an environment is deleted; never on tab unmount or switch. */
  forgetEnvironmentCommandCatalogues(environmentId: string): void {
    this.commandCatalogues.forgetEnvironment(environmentId);
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
}
