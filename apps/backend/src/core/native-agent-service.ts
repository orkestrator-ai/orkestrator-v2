import { createHash } from "node:crypto";
import type {
  BuildPipelineAgent,
  PipelineSessionPhase,
  TaskSnapshotImage,
} from "@orkestrator/protocol/build-pipeline";
import {
  BUILD_PIPELINE_AGENTS,
  isActiveBuildPhase,
  isBuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import {
  aggregateAgentActivityState,
  type AgentActivityState,
} from "@orkestrator/protocol/agent-activity";
import {
  AGENT_INTERACTION_ORIGINS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionPolicy,
  type AgentInteractionKind,
  type AgentInteractionApplyOutcome,
  type AgentInteractionOrigin,
  type AgentInteractionPolicy,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import type {
  AgentModel,
  NativeAgentCapabilities,
  NativeAgentComposerControl,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentDispatchOutcome,
  NativeAgentForkOutcome,
  NativeAgentResumeEntry,
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import type {
  Environment,
  OpenCodeIncompleteTurnNotice,
  PersistedNativeAgentSession,
} from "./models.js";
import type { StorageService } from "./storage.js";
import {
  AmbiguousPromptDispatchError,
  createBuildPipelineProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  type BridgeConnection,
  type NativeAgentRuntimeProvider,
  type ProviderInteractionObservationEvent,
  type ProviderExecutionMode,
} from "./build-pipeline-provider.js";
import {
  assertValidPromptAttachments,
  INITIAL_PROMPT_STAGING_DIRECTORY,
  stagePromptImages,
  type PromptAttachment,
} from "./prompt-attachments.js";
import {
  inspectOpenCodeIncompleteTurn,
  openCodeIncompleteTurnRequestId,
  OPENCODE_INCOMPLETE_TURN_CONTINUATION,
} from "./opencode-turn-recovery.js";

const PROVIDER_REPORTED_INTERACTION_GRACE_MS = 60_000;

type CommandInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface EnsureNativeAgentSessionInput {
  environmentId: string;
  agent: BuildPipelineAgent;
  logicalSessionKey: string;
  /** Persisted once with the logical session; omitted callers are interactive. */
  origin?: AgentInteractionOrigin;
  /** Metadata only in Milestone 1; enforcement is introduced later. */
  interactionPolicy?: AgentInteractionPolicy;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  phase?: PipelineSessionPhase;
  /**
   * Execution mode for the session, overriding what the phase implies.
   *
   * Looped-review phases collapse several distinct steps onto `review`, and one
   * of them (preparation) has to commit changes — so a phase-derived read-only
   * Codex session would make that round fail.
   */
  sessionMode?: ProviderExecutionMode;
  /** Cursor/Grok ACP speed toggle applied at session create. */
  fastMode?: boolean;
}

export interface DispatchNativeAgentPromptInput
  extends EnsureNativeAgentSessionInput {
  prompt: string;
  requestId: string;
  /** Base64 images that still need staging into the workspace. */
  images?: TaskSnapshotImage[];
  /** Attachments the caller already staged, carrying workspace paths. */
  attachments?: PromptAttachment[];
  schema?: JsonSchema;
  mode?: ProviderExecutionMode;
  fastMode?: boolean;
  subAgent?: string;
  /**
   * OpenCode execution agent for this prompt (`build`, `plan`, or a custom
   * agent). Distinct from {@link EnsureNativeAgentSessionInput.agent}, which
   * selects the provider. Incomplete-turn recovery uses this to continue a
   * stalled turn under the same agent it originally ran with.
   */
  executionAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
}

export interface AdoptNativeAgentSessionInput
  extends EnsureNativeAgentSessionInput {
  providerSessionId: string;
  expectedProviderSessionId?: string;
}

export interface NativeAgentProjectionInput {
  environmentId: string;
  agent: BuildPipelineAgent;
  logicalSessionKey: string;
}

function controlsFromSessionInput(
  input: EnsureNativeAgentSessionInput,
): NativeAgentControlUpdate | undefined {
  const controls: NativeAgentControlUpdate = {
    ...(input.model ? { modelId: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningId: input.reasoningEffort } : {}),
    ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
    ...(input.sessionMode ? { mode: input.sessionMode } : {}),
  };
  return Object.keys(controls).length > 0 ? controls : undefined;
}

type NativeAgentProjectionCacheEntry = {
  input: NativeAgentProjectionInput;
  projection: NativeAgentSessionProjection;
  fingerprint: string;
  generation: string;
  nextRefreshAt: number;
};

function isValidInteractionMetadata(input: {
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
}): boolean {
  if (
    input.origin !== undefined
    && !AGENT_INTERACTION_ORIGINS.includes(input.origin)
  ) return false;
  if (
    input.interactionPolicy !== undefined
    && !isAgentInteractionPolicy(input.interactionPolicy)
  ) return false;
  const origin = input.origin ?? "interactive-native";
  const policyMode = input.interactionPolicy?.mode
    ?? (origin === "build-pipeline" || origin === "looped-review"
      ? "unattended"
      : "interactive");
  return (origin === "build-pipeline" || origin === "looped-review")
    === (policyMode === "unattended");
}

/** One session's observed activity change, as reported to `onActivityTransition`. */
export interface NativeAgentActivityTransition {
  environmentId: string;
  sessionKey: string;
  providerSessionId: string;
  previousState?: AgentActivityState;
  state: AgentActivityState;
}

/**
 * Whether a transition means an agent turn just ended in this backend.
 *
 * Shared with the composition root so one-shot PR discovery hangs off exactly
 * this edge. A first observation (no previous state) is a backend restart or a
 * newly adopted session, not a turn that finished here, and `working`/`waiting`
 * are both live turns that have now stopped.
 */
export function isAgentTurnEndTransition(
  transition: Pick<NativeAgentActivityTransition, "previousState" | "state">,
): boolean {
  return transition.state === "idle"
    && (transition.previousState === "working" || transition.previousState === "waiting");
}

export interface NativeAgentServiceOptions {
  provider?: (
    input: EnsureNativeAgentSessionInput,
    environment: Environment,
  ) => Promise<NativeAgentRuntimeProvider>;
  /**
   * Clock for the activity sweep's backoff. Injectable so a test can prove the
   * retry schedule without sleeping through a 60-second ceiling.
   */
  now?: () => number;
  /** Disabled by default. Milestone 3 observes and never resolves. */
  interactionMonitorMode?: "disabled" | "observe-only";
  interactionMonitorAdoptionEnabled?: boolean;
  interactionMonitorIntervalMs?: number;
  interactionMonitorMaxConcurrency?: number;
  interactionMonitorMaxSessionsPerEnvironment?: number;
  interactionMonitorRetryBaseMs?: number;
  interactionMonitorMaxRetries?: number;
  onInteractionObservation?: (
    observation: AgentInteractionObservation,
  ) => void | Promise<void>;
  onActivityTransition?: (event: NativeAgentActivityTransition) => void;
}

export interface AgentInteractionObservation {
  provider: BuildPipelineAgent;
  kind: AgentInteractionKind;
  workflowSurface: AgentInteractionOrigin;
  phase: string;
  firstDetectedAt: number;
  lastDetectedAt: number;
  count: number;
  providerState: "blocked" | "running" | "idle" | "error" | "missing";
  eventualOutcome?: "expired" | "withdrawn";
  eventualAt?: number;
}

const QUEUE_RETRY_BASE_MS = 2_000;
const QUEUE_RETRY_CEILING_MS = 60_000;
const MAX_QUEUE_DISPATCH_ATTEMPTS = 5;
const LAUNCH_RETRY_MS = 10_000;
const ACTIVITY_STATUS_CONCURRENCY = 8;
const ACTIVITY_RETRY_BASE_MS = 2_000;
const ACTIVITY_RETRY_CEILING_MS = 60_000;
const OPENCODE_RECOVERY_RETRY_BASE_MS = 2_000;
const OPENCODE_RECOVERY_RETRY_CEILING_MS = 60_000;
const OPENCODE_RECOVERY_MAX_CANDIDATES = 1_024;
const OPENCODE_MANUAL_PROMPT_CLAIM_MS = 2 * 60_000;
const OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT = 64;
/** How long "no bridge is running" is trusted before it is re-probed. */
const ABSENT_BRIDGE_RECHECK_MS = 15_000;
const INTERACTION_MONITOR_MAX_OBSERVATIONS = 64;
const INTERACTION_MONITOR_MAX_TRACKED_REQUESTS = 512;
const INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS = 1_024;
const INTERACTION_MONITOR_DEFAULT_CONCURRENCY = 4;
const INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT = 8;
const INTERACTION_MONITOR_DEFAULT_MAX_RETRIES = 5;
const INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS = 1_000;
const NATIVE_PROJECTION_CACHE_LIMIT = 1_024;
const NATIVE_PROJECTION_ACTIVE_REFRESH_MS = 350;
const NATIVE_PROJECTION_IDLE_REFRESH_MS = 1_500;
const NATIVE_PROJECTION_MAX_MESSAGES = 512;
const NATIVE_PROJECTION_MAX_BYTES = 8 * 1024 * 1024;
const NATIVE_MODEL_CATALOG_TTL_MS = 30_000;
const NATIVE_MODEL_CATALOG_CACHE_LIMIT = 128;
const NATIVE_SLASH_COMMAND_TTL_MS = 30_000;
const NATIVE_SLASH_COMMAND_CACHE_LIMIT = 256;

const RICH_NATIVE_CAPABILITIES: NativeAgentCapabilities = Object.freeze({
  attachments: { files: true, images: true },
  queue: true,
  resume: true,
  fork: true,
  slashCommands: true,
  backgroundTasks: false,
  composer: {
    provider: true,
    model: true,
    reasoning: true,
    speed: true,
    mode: true,
    executionProfile: false,
    localSettings: false,
    promptSuggestions: false,
  },
  actions: { compact: true },
});

function nativeCapabilities(agent: BuildPipelineAgent): NativeAgentCapabilities {
  if (agent === "cursor" || agent === "grok") {
    return {
      attachments: { files: false, images: false },
      queue: false,
      resume: false,
      fork: false,
      slashCommands: false,
      backgroundTasks: false,
      composer: { ...RICH_NATIVE_CAPABILITIES.composer },
      actions: {},
    };
  }
  if (agent === "claude") {
    return {
      ...RICH_NATIVE_CAPABILITIES,
      backgroundTasks: true,
      composer: {
        ...RICH_NATIVE_CAPABILITIES.composer,
        executionProfile: true,
        localSettings: true,
        promptSuggestions: true,
      },
      actions: { compact: true, rewindFiles: true },
    };
  }
  if (agent === "opencode") {
    return {
      ...RICH_NATIVE_CAPABILITIES,
      composer: {
        ...RICH_NATIVE_CAPABILITIES.composer,
        speed: false,
        executionProfile: true,
      },
      actions: { compact: true, undo: true, redo: true, share: true },
    };
  }
  return {
    ...RICH_NATIVE_CAPABILITIES,
    actions: { compact: true, steer: true, review: true },
  };
}

function nativeComposerControls(
  composer: NativeAgentComposerState | undefined,
  disabled: boolean,
): NativeAgentComposerControl[] {
  if (!composer) return [];
  const selectedModel = composer.models.find(
    (model) => model.id === composer.selectedModelId,
  ) ?? composer.models[0];
  const controls: NativeAgentComposerControl[] = [];
  if (composer.models.length > 0) {
    controls.push({
      kind: "select",
      id: "model",
      label: "Model",
      value: selectedModel?.id,
      options: composer.models.map((model) => ({ id: model.id, label: model.label })),
      disabled,
    });
  }
  if ((selectedModel?.reasoning?.length ?? 0) > 0) {
    controls.push({
      kind: "select",
      id: "reasoning",
      label: "Reasoning",
      value: composer.selectedReasoningId ?? selectedModel?.defaultReasoningId,
      options: selectedModel!.reasoning!.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
      disabled,
    });
  }
  if (composer.fastModeAvailable && composer.fastModeEnabled !== null) {
    controls.push({
      kind: "toggle",
      id: "speed",
      label: "Fast mode",
      value: composer.fastModeEnabled,
      disabled,
    });
  }
  if (composer.modes.length > 0) {
    controls.push({
      kind: "segmented",
      id: "mode",
      label: "Mode",
      value: composer.selectedModeId,
      options: composer.modes,
      disabled,
    });
  }
  if ((composer.executionProfiles?.length ?? 0) > 0) {
    controls.push({
      kind: "select",
      id: "execution-profile",
      label: "Execution profile",
      value: composer.selectedExecutionProfileId,
      options: composer.executionProfiles!.map((profile) => ({
        id: profile.id,
        label: profile.label,
        description: profile.description,
      })),
      disabled,
    });
  }
  if (typeof composer.includeLocalSettings === "boolean") {
    controls.push({
      kind: "toggle",
      id: "local-settings",
      label: "Include local Claude settings",
      value: composer.includeLocalSettings,
      disabled,
    });
  }
  if (typeof composer.promptSuggestionsEnabled === "boolean") {
    controls.push({
      kind: "toggle",
      id: "prompt-suggestions",
      label: "Suggest a follow-up after each turn",
      value: composer.promptSuggestionsEnabled,
      disabled,
    });
  }
  return controls;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * An agent can only be driven once its environment is running and its setup
 * scripts have finished.
 *
 * The launch path has always checked this. The drain path must too: without it a
 * stopped or still-provisioning environment with a leftover queued prompt makes
 * the backend spawn bridge servers and attempt dispatch every two seconds.
 */
function isEnvironmentReadyForAgents(environment: Environment): boolean {
  return environment.status === "running"
    && (environment.setupPhase === "ready" || environment.setupScriptsComplete === true);
}

const LEGACY_TIMESTAMP_ENVIRONMENT_NAME = /^\d{8}-\d{6}$/;
const COMPACT_TIMESTAMP_ENVIRONMENT_NAME = /^\d{15}$/;

/**
 * True for a name generated before the environment had a prompt-derived title.
 *
 * Twin of `apps/web/src/lib/environment-name.ts` — the renderer applies the same
 * guard on its own send path, and both must agree on which names are renameable.
 */
function isGeneratedEnvironmentName(name: string): boolean {
  return LEGACY_TIMESTAMP_ENVIRONMENT_NAME.test(name)
    || COMPACT_TIMESTAMP_ENVIRONMENT_NAME.test(name);
}

export function nativeAgentSessionStorageKey(
  environmentId: string,
  agent: BuildPipelineAgent,
  logicalSessionKey: string,
): string {
  return createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(agent)
    .update("\0")
    .update(logicalSessionKey)
    .digest("hex");
}

type OpenCodeRecoveryCandidate = {
  providerSessionId: string;
  attempts: number;
  retryAt: number;
};

type PromptDispatchPreparation =
  | { dispatch: false; notice?: OpenCodeIncompleteTurnNotice }
  | {
      dispatch: true;
      model?: string;
      effort?: string;
      executionAgent?: string;
    };

/**
 * Backend authority for provider-session creation and prompt dispatch.
 *
 * Renderers may ask for the same logical session concurrently. Storage holds
 * its cross-process lock across providers that cannot create deterministically
 * (OpenCode), while Claude/Codex also receive the logical key as a second layer
 * of idempotency at their bridges.
 */
export class NativeAgentService {
  private readonly providers = new Map<string, NativeAgentRuntimeProvider>();
  /**
   * Identity of the live bridge generation behind each production provider.
   * Ports and bearer credentials both change when a bridge is replaced.
   */
  private readonly providerConnections = new Map<string, string>();
  /** Bounded, reconstructible view cache; providers remain authoritative. */
  private readonly projectionCache = new Map<
    string,
    NativeAgentProjectionCacheEntry
  >();
  private readonly modelCatalogCache = new Map<
    string,
    { models: AgentModel[]; expiresAt: number }
  >();
  private readonly slashCommandCache = new Map<
    string,
    { commands: NativeAgentSlashCommand[]; expiresAt: number }
  >();
  private readonly launchTasks = new Map<string, Promise<void>>();
  private readonly launchRetryAt = new Map<string, number>();
  private readonly queueTasks = new Map<string, Promise<void>>();
  private readonly queueRetryAt = new Map<string, number>();
  private readonly queueAttempts = new Map<string, number>();
  private readonly scanTasks = new Set<Promise<void>>();
  private readonly activityRetryAt = new Map<string, number>();
  private readonly activityAttempts = new Map<string, number>();
  private readonly absentBridgeUntil = new Map<string, number>();
  /** Last provider-owned state per durable session, used for exact turn edges. */
  private readonly observedSessionActivity = new Map<
    string,
    { providerSessionId: string; state: AgentActivityState }
  >();
  /** In-flight incomplete-turn recoveries, coalesced per durable session. */
  private readonly openCodeRecoveryTasks = new Map<string, Promise<void>>();
  /** Idle transcript candidates retained across transient recovery failures. */
  private readonly openCodeRecoveryCandidates = new Map<
    string,
    OpenCodeRecoveryCandidate
  >();
  /** Short-lived manual-send claims prevent stale automatic continuations. */
  private readonly openCodeManualPromptClaims = new Map<
    string,
    { providerSessionId: string; requestId: string; expiresAt: number }
  >();
  /** Final no-await handoff from recovery validation into provider dispatch. */
  private readonly openCodeRecoveryDispatches = new Set<string>();
  /**
   * Environments whose exact completion edge has not yet reached the PR
   * monitor. Delivery is retried by later sweeps, while the set coalesces
   * simultaneous session completions into one environment notification.
   */
  private readonly pendingPrRefreshEnvironmentIds = new Set<string>();
  private readonly interactionObservations = new Map<string, AgentInteractionObservation>();
  private readonly trackedInteractions = new Map<
    string,
    {
      observationKey: string;
      sessionKey: string;
      expiresAt?: number;
      scan: number;
    }
  >();
  private readonly providerReportedInteractions = new Map<
    string,
    {
      observationKey: string;
      providerSessionKey: string;
      detectedAt: number;
      missingSince?: number;
    }
  >();
  private readonly interactionRetryAt = new Map<string, number>();
  private readonly interactionAttempts = new Map<string, number>();
  private readonly monitoredInteractionSessionKeys = new Set<string>();
  private readonly observedInteractionRevisions = new Map<string, number>();
  /** Round-robin offsets keep bounded scans from permanently favouring old sessions. */
  private readonly interactionSelectionCursors = new Map<string, number>();
  private interactionGlobalSelectionCursor = 0;
  private activityScan: Promise<void> | null = null;
  private interactionScan: Promise<void> | null = null;
  private interactionScanNumber = 0;
  private interactionRevisionReconciliations = 0;
  private interactionMonitorAdoptionEnabled = true;
  private launchTimer: ReturnType<typeof setInterval> | null = null;
  private projectionTimer: ReturnType<typeof setInterval> | null = null;
  private projectionScan: Promise<void> | null = null;
  private interactionTimer: ReturnType<typeof setInterval> | null = null;
  private initialization: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: NativeAgentServiceOptions = {},
  ) {
    this.interactionMonitorAdoptionEnabled =
      options.interactionMonitorAdoptionEnabled !== false;
  }

  private now(): number {
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

  private async initialize(): Promise<void> {
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
    this.projectionTimer = setInterval(() => {
      if (this.stopped || this.projectionScan) return;
      const scan = this.reconcileProjectionCache().finally(() => {
        if (this.projectionScan === scan) this.projectionScan = null;
      });
      this.projectionScan = scan;
      void scan.catch(() => undefined);
    }, NATIVE_PROJECTION_ACTIVE_REFRESH_MS);
    this.projectionTimer.unref?.();
    if (this.options.interactionMonitorMode === "observe-only") {
      await this.reconcileAgentInteractions().catch(() => undefined);
      if (this.stopped) return;
      this.interactionTimer = setInterval(() => {
        void this.reconcileAgentInteractions().catch(() => undefined);
      }, Math.max(100, this.options.interactionMonitorIntervalMs ?? 2_000));
      this.interactionTimer.unref?.();
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
      const status = await provider.status(existing.providerSessionId);
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
    const status = await provider.status(input.providerSessionId);
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
      controls: controlsFromSessionInput(input),
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

  async listProjectionModels(
    input: NativeAgentProjectionInput,
  ): Promise<AgentModel[]> {
    this.assertProjectionInput(input);
    const provider = await this.provider(input);
    return provider.modelCatalog
      ? (await provider.modelCatalog()).slice(0, 512)
      : [];
  }

  async dispatchIntent(
    input: DispatchNativeAgentPromptInput,
  ): Promise<NativeAgentDispatchOutcome> {
    let manualOpenCodeSession: PersistedNativeAgentSession | null = null;
    try {
      const isManualOpenCode = input.agent === "opencode"
        && input.origin !== "build-pipeline"
        && input.origin !== "looped-review";
      if (isManualOpenCode) {
        manualOpenCodeSession = await this.ensureSession(input);
        await this.claimOpenCodeManualPrompt({
          environmentId: input.environmentId,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualOpenCodeSession.providerSessionId,
          requestId: input.requestId,
        });
      }
      await this.dispatchPromptInternal(input);
      void this.refreshProjection(input, true).catch(() => undefined);
      return { outcome: "accepted", requestId: input.requestId };
    } catch (error) {
      if (error instanceof AmbiguousPromptDispatchError) {
        void this.refreshProjection(input, true).catch(() => undefined);
        return {
          outcome: "unknown",
          requestId: input.requestId,
          error: error.message,
        };
      }
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Prompt dispatch failed",
      };
    } finally {
      if (manualOpenCodeSession) {
        this.releaseOpenCodeManualPrompt({
          environmentId: input.environmentId,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualOpenCodeSession.providerSessionId,
          requestId: input.requestId,
        });
      }
    }
  }

  async stopProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    await resolved.provider.abort(resolved.session.providerSessionId);
    return this.refreshProjection(input, true);
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
    await resolved.provider.stopBackgroundTask(
      resolved.session.providerSessionId,
      input.taskId,
    );
    return this.refreshProjection(input, true);
  }

  async dismissProjectionSuggestedPrompt(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    if (!resolved.provider.dismissSuggestedPrompt) {
      throw new Error(`${input.agent} does not support prompt suggestions`);
    }
    await resolved.provider.dismissSuggestedPrompt(
      resolved.session.providerSessionId,
    );
    return this.refreshProjection(input, true);
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
    return (await provider.listResumableSessions()).slice(0, 512);
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
    const provider = await this.provider(input);
    if (!provider.resumeSession) {
      throw new Error(`${input.agent} does not support session resume`);
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const existing = await this.storage.getNativeAgentSession(key);
    const resumedId = await provider.resumeSession(
      input.providerSessionId,
      input.controls,
    );
    await this.adoptSession({
      ...input,
      providerSessionId: resumedId,
      expectedProviderSessionId: existing?.providerSessionId,
      model: input.controls?.modelId,
      reasoningEffort: input.controls?.reasoningId,
      sessionMode: input.controls?.mode,
      fastMode: input.controls?.fastMode,
    });
    this.projectionCache.delete(key);
    return this.refreshProjection(input, true);
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
    return resolved.provider.forkSession(
      resolved.session.providerSessionId,
      input.messageId,
    );
  }

  async performProjectionAction(
    input: NativeAgentProjectionInput & { action: NativeAgentSessionAction },
  ): Promise<NativeAgentSessionActionOutcome> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    const capability = {
      compact: "compact",
      "rewind-files": "rewindFiles",
      undo: "undo",
      redo: "redo",
      share: "share",
      unshare: "share",
      steer: "steer",
      review: "review",
    }[input.action.kind] as keyof NonNullable<NativeAgentCapabilities["actions"]>;
    if (!nativeCapabilities(input.agent).actions?.[capability]) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    if (!resolved.provider.performSessionAction) {
      throw new Error(`${input.agent} does not support ${input.action.kind}`);
    }
    const outcome = await resolved.provider.performSessionAction(
      resolved.session.providerSessionId,
      input.action,
    );
    this.projectionCache.delete(resolved.key);
    return outcome;
  }

  async updateProjectionControls(
    input: NativeAgentProjectionInput & { update: NativeAgentControlUpdate },
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const current = await this.refreshProjection(input, true);
    const composer = current?.composer;
    if (input.update.modelId !== undefined) {
      if (!composer?.models.some((model) => model.id === input.update.modelId)) {
        throw new Error("Native agent model selection is invalid");
      }
    }
    if (input.update.reasoningId !== undefined) {
      const modelId = input.update.modelId ?? composer?.selectedModelId;
      const model = composer?.models.find((candidate) => candidate.id === modelId);
      if (!model?.reasoning?.some((option) => option.id === input.update.reasoningId)) {
        throw new Error("Native agent reasoning selection is invalid");
      }
    }
    if (
      input.update.fastMode !== undefined
      && composer?.fastModeAvailable !== true
    ) {
      throw new Error("Native agent fast mode is unavailable");
    }
    if (
      input.update.mode !== undefined
      && !composer?.modes.some((mode) => mode.id === input.update.mode)
    ) {
      throw new Error("Native agent conversation mode is invalid");
    }
    if (
      input.update.executionProfileId !== undefined
      && input.update.executionProfileId !== null
      && !composer?.executionProfiles?.some(
        (profile) => profile.id === input.update.executionProfileId,
      )
    ) {
      throw new Error("Native agent execution profile is invalid");
    }
    const capabilities = nativeCapabilities(input.agent).composer;
    if (input.update.includeLocalSettings !== undefined && !capabilities.localSettings) {
      throw new Error("Native agent local settings are unavailable");
    }
    if (input.update.promptSuggestions !== undefined && !capabilities.promptSuggestions) {
      throw new Error("Native agent prompt suggestions are unavailable");
    }
    if (resolved.provider.updateInteractiveControls) {
      await resolved.provider.updateInteractiveControls(
        resolved.session.providerSessionId,
        input.update,
      );
    }
    await this.storage.updateNativeAgentSessionControls(
      resolved.key,
      resolved.session.providerSessionId,
      input.update,
    );
    return this.refreshProjection(input, true);
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
    void this.refreshProjection(input, true).catch(() => undefined);
    return outcome;
  }

  private assertProjectionInput(input: NativeAgentProjectionInput): void {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId)
      || !nonBlank(input.logicalSessionKey)
      || !BUILD_PIPELINE_AGENTS.includes(input.agent)
    ) {
      throw new Error("Invalid native agent projection request");
    }
  }

  private async resolveProjectionSession(input: NativeAgentProjectionInput) {
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
    return { key, session, provider };
  }

  private projectionMessages(messages: unknown[]): unknown[] {
    const bounded = messages.slice(-NATIVE_PROJECTION_MAX_MESSAGES).map((raw) => {
      const message = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null;
      const role = message?.role;
      if (
        !message
        || typeof message.id !== "string"
        || (role !== "user" && role !== "assistant" && role !== "system")
        || typeof message.content !== "string"
        || !Array.isArray(message.parts)
        || typeof message.createdAt !== "string"
      ) {
        throw new ProviderUnavailableError(
          "Provider returned a non-normalized native transcript",
        );
      }
      return {
        id: message.id,
        role,
        content: message.content,
        parts: message.parts,
        createdAt: message.createdAt,
        ...(typeof message.modelId === "string" ? { modelId: message.modelId } : {}),
        ...(typeof message.turnId === "string" ? { turnId: message.turnId } : {}),
        ...(typeof message.planReview === "boolean" ? { planReview: message.planReview } : {}),
      };
    });
    let bytes = Number.POSITIVE_INFINITY;
    try {
      bytes = Buffer.byteLength(JSON.stringify(bounded));
    } catch {
      // The normalized provider contract is JSON. Non-serializable messages
      // are a transport violation, never something to leak to a renderer.
    }
    if (bytes > NATIVE_PROJECTION_MAX_BYTES) {
      throw new ProviderUnavailableError("Provider transcript projection is oversized");
    }
    return bounded;
  }

  private async projectionComposer(
    input: NativeAgentProjectionInput,
    session: PersistedNativeAgentSession,
    providerComposer?: NativeAgentComposerState,
    providerControls?: NativeAgentControlUpdate,
  ): Promise<NativeAgentComposerState> {
    let models = providerComposer?.models ?? [];
    if (models.length === 0) {
      const cached = this.modelCatalogCache.get(input.environmentId);
      if (cached && cached.expiresAt > this.now()) {
        models = cached.models.filter((model) => model.platform === input.agent);
      } else {
        try {
          const catalog = await this.invoke<AgentModel[]>(
            "get_native_agent_model_catalog",
            { environmentId: input.environmentId },
          );
          const bounded = Array.isArray(catalog) ? catalog.slice(0, 512) : [];
          if (this.modelCatalogCache.size >= NATIVE_MODEL_CATALOG_CACHE_LIMIT) {
            const oldest = this.modelCatalogCache.keys().next().value as string | undefined;
            if (oldest) this.modelCatalogCache.delete(oldest);
          }
          this.modelCatalogCache.set(input.environmentId, {
            models: bounded,
            expiresAt: this.now() + NATIVE_MODEL_CATALOG_TTL_MS,
          });
          models = bounded.filter((model) => model.platform === input.agent);
        } catch {
          // A stale or unavailable catalog must not hide the transcript.
        }
      }
    }
    const selectedModelId = providerControls?.modelId
      ?? session.controls?.modelId
      ?? providerComposer?.selectedModelId
      ?? models[0]?.id;
    const selectedModel = models.find((model) => model.id === selectedModelId)
      ?? models[0];
    const supportsSpeed = providerComposer?.fastModeAvailable === true
      || selectedModel?.supportsSpeed === true;
    const capabilities = nativeCapabilities(input.agent);
    return {
      models,
      ...(selectedModel ? { selectedModelId: selectedModel.id } : {}),
      ...(providerControls?.reasoningId
        ?? session.controls?.reasoningId
        ?? providerComposer?.selectedReasoningId
        ?? selectedModel?.defaultReasoningId
        ? {
            selectedReasoningId: providerControls?.reasoningId
              ?? session.controls?.reasoningId
              ?? providerComposer?.selectedReasoningId
              ?? selectedModel?.defaultReasoningId,
          }
        : {}),
      fastModeAvailable: supportsSpeed,
      fastModeEnabled: supportsSpeed
        ? providerControls?.fastMode
          ?? session.controls?.fastMode
          ?? providerComposer?.fastModeEnabled
          ?? false
        : null,
      ...(capabilities.composer.mode ? {
        selectedModeId: providerControls?.mode
          ?? session.controls?.mode
          ?? providerComposer?.selectedModeId
          ?? "build",
      } : {}),
      modes: capabilities.composer.mode
        ? providerComposer?.modes.length
          ? providerComposer.modes
          : [{ id: "build", label: "Build" }, { id: "plan", label: "Plan" }]
        : [],
      ...(providerComposer?.executionProfiles?.length ? {
        executionProfiles: providerComposer.executionProfiles,
      } : {}),
      ...(providerControls?.executionProfileId
        ?? providerComposer?.selectedExecutionProfileId
        ?? session.controls?.executionProfileId
        ?? undefined
        ? {
            selectedExecutionProfileId: providerControls?.executionProfileId
              ?? providerComposer?.selectedExecutionProfileId
              ?? session.controls?.executionProfileId
              ?? undefined,
          }
        : {}),
      ...(capabilities.composer.localSettings ? {
        includeLocalSettings: providerControls?.includeLocalSettings
          ?? providerComposer?.includeLocalSettings
          ?? session.controls?.includeLocalSettings
          ?? false,
      } : {}),
      ...(capabilities.composer.promptSuggestions ? {
        promptSuggestionsEnabled: providerControls?.promptSuggestions
          ?? providerComposer?.promptSuggestionsEnabled
          ?? session.controls?.promptSuggestions
          ?? false,
      } : {}),
    };
  }

  private async projectionSlashCommands(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
  ): Promise<NativeAgentSlashCommand[]> {
    if (!nativeCapabilities(input.agent).slashCommands || !provider.slashCommands) {
      return [];
    }
    const key = `${input.environmentId}\0${input.agent}`;
    const cached = this.slashCommandCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.commands;
    try {
      const commands = (await provider.slashCommands()).slice(0, 512);
      if (!cached && this.slashCommandCache.size >= NATIVE_SLASH_COMMAND_CACHE_LIMIT) {
        const oldest = this.slashCommandCache.keys().next().value as string | undefined;
        if (oldest) this.slashCommandCache.delete(oldest);
      }
      this.slashCommandCache.set(key, {
        commands,
        expiresAt: this.now() + NATIVE_SLASH_COMMAND_TTL_MS,
      });
      return commands;
    } catch {
      // Discovery metadata is optional. Keep the transcript usable when a
      // provider temporarily cannot enumerate commands.
      return cached?.commands ?? [];
    }
  }

  private async refreshProjection(
    input: NativeAgentProjectionInput,
    force: boolean,
  ): Promise<NativeAgentSessionProjection | null> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const previous = this.projectionCache.get(key);
    if (!force && previous && previous.nextRefreshAt > this.now()) {
      return previous.projection;
    }
    let generation = previous?.generation ?? `unresolved:${input.agent}`;
    try {
      const resolved = await this.resolveProjectionSession(input);
      if (!resolved) {
        this.projectionCache.delete(key);
        return null;
      }
      const providerCacheKey = `${input.environmentId}\0${input.agent}`;
      generation = this.providerConnections.get(providerCacheKey)
        ?? `in-process:${input.agent}`;
      const snapshot = resolved.provider.interactiveSnapshot
        ? await resolved.provider.interactiveSnapshot(
            resolved.session.providerSessionId,
          )
        : {
            status: await resolved.provider.status(resolved.session.providerSessionId),
            messages: await resolved.provider.messages(resolved.session.providerSessionId),
          };
      if (snapshot.providerGeneration !== undefined) {
        generation = `${generation}:${String(snapshot.providerGeneration)}`;
      }
      if (snapshot.status === "missing") {
        throw new ProviderUnavailableError("Native agent provider session is recovering");
      }
      const interactionSnapshot = resolved.provider.interactions
        ? await resolved.provider.interactions.listPendingInteractions(
            resolved.session.providerSessionId,
          )
        : { requests: [], revision: 0 };
      const capabilities = nativeCapabilities(input.agent);
      const queue = capabilities.queue
        ? await this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : null;
      const blocked = interactionSnapshot.requests.length > 0;
      const composer = await this.projectionComposer(
        input,
        resolved.session,
        snapshot.composer,
        snapshot.controls,
      );
      const selectedModel = composer.models.find(
        (model) => model.id === composer.selectedModelId,
      );
      const contextUsage = snapshot.contextUsage
        ? {
            ...snapshot.contextUsage,
            ...(snapshot.contextUsage.maximumTokens === undefined
              && selectedModel?.contextWindow
              ? { maximumTokens: selectedModel.contextWindow }
              : {}),
            ...(snapshot.contextUsage.percentage === undefined
              && (snapshot.contextUsage.maximumTokens ?? selectedModel?.contextWindow)
              ? {
                  percentage: Math.max(0, Math.min(
                    100,
                    snapshot.contextUsage.usedTokens
                      / (snapshot.contextUsage.maximumTokens ?? selectedModel!.contextWindow!)
                      * 100,
                  )),
                }
              : {}),
          }
        : undefined;
      const slashCommands = await this.projectionSlashCommands(
        input,
        resolved.provider,
      );
      const messages = this.projectionMessages(snapshot.messages);
      const projection: NativeAgentSessionProjection = {
        platform: input.agent,
        environmentId: input.environmentId,
        sessionId: resolved.session.providerSessionId,
        ...(snapshot.title ? { title: snapshot.title } : {}),
        ...(snapshot.shareUrl === undefined ? {} : { shareUrl: snapshot.shareUrl }),
        connection: "connected",
        turn: {
          phase: snapshot.phase === "cancelling"
            || snapshot.phase === "recovering"
            || snapshot.phase === "error"
            ? snapshot.phase
            : blocked
              ? "blocked"
              : snapshot.phase ?? (snapshot.status === "error"
                ? "error"
                : snapshot.status === "running" ? "running" : "idle"),
          ...(snapshot.turnStartedAt === undefined
            ? {} : { startedAt: snapshot.turnStartedAt }),
          ...(snapshot.error ? { error: snapshot.error } : {}),
        },
        messages,
        interactions: interactionSnapshot.requests,
        composerControls: nativeComposerControls(
          composer,
          snapshot.status === "running" || blocked,
        ),
        composer,
        capabilities,
        ...(slashCommands.length > 0 ? { slashCommands } : {}),
        ...(queue ? {
          queue: {
            items: queue.messages,
            ...(queue.inFlight ? { inFlightRequestId: queue.inFlight.requestId } : {}),
            ...(queue.dispatchError ? {
              blocked: {
                messageId: queue.dispatchError.messageId,
                error: queue.dispatchError.message,
              },
            } : {}),
          },
        } : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...(snapshot.rateLimits ? { rateLimits: snapshot.rateLimits } : {}),
        ...(snapshot.runtime ? { runtime: snapshot.runtime } : {}),
        ...(snapshot.notices ? { notices: snapshot.notices } : {}),
        ...(snapshot.backgroundTasks
          ? { backgroundTasks: snapshot.backgroundTasks }
          : {}),
        ...(snapshot.suggestedPrompt
          ? { suggestedPrompt: snapshot.suggestedPrompt }
          : {}),
        ...(snapshot.completionBlockedByBackgroundTasks === undefined
          ? {}
          : {
              completionBlockedByBackgroundTasks:
                snapshot.completionBlockedByBackgroundTasks,
            }),
        ...(capabilities.fork ? {
          turnBoundaries: messages.flatMap((candidate) => {
            const message = candidate as Record<string, unknown>;
            return typeof message.id === "string"
              ? [{
                  turnId: typeof message.turnId === "string"
                    ? message.turnId
                    : message.id,
                  messageId: message.id,
                  resumable: capabilities.resume,
                  forkable: true,
                }]
              : [];
          }),
        } : {}),
        ...(resolved.session.openCodeIncompleteTurnNotice ? {
          notices: [...(snapshot.notices ?? []), {
            kind: "incomplete-turn" as const,
            message: resolved.session.openCodeIncompleteTurnNotice.kind === "failed"
              ? "The previous OpenCode turn ended before completion."
              : "OpenCode could not complete the previous turn after recovery.",
          }],
        } : {}),
        revision: 0,
        generation,
        cursor: snapshot.providerRevision === undefined
          ? undefined
          : String(snapshot.providerRevision),
      };
      return this.commitProjection(key, input, projection, generation);
    } catch (error) {
      const projection: NativeAgentSessionProjection = {
        ...(previous?.projection ?? {
          platform: input.agent,
          environmentId: input.environmentId,
          messages: [],
          interactions: [],
          composerControls: [],
          capabilities: nativeCapabilities(input.agent),
          revision: 0,
          generation,
        }),
        connection: "error",
        turn: {
          phase: "recovering",
          error: error instanceof Error ? error.message : "Native agent is unavailable",
        },
        notices: [{
          kind: "recovery",
          message: "Reconnecting to the native agent runtime…",
        }],
        revision: 0,
        generation,
      };
      return this.commitProjection(key, input, projection, generation);
    }
  }

  private commitProjection(
    key: string,
    input: NativeAgentProjectionInput,
    candidate: NativeAgentSessionProjection,
    generation: string,
  ): NativeAgentSessionProjection {
    const previous = this.projectionCache.get(key);
    const fingerprint = JSON.stringify({
      ...candidate,
      revision: 0,
      cursor: candidate.cursor,
    });
    const interval = candidate.turn.phase === "running"
      || candidate.turn.phase === "blocked"
      || candidate.turn.phase === "cancelling"
      || candidate.turn.phase === "recovering"
      ? NATIVE_PROJECTION_ACTIVE_REFRESH_MS
      : NATIVE_PROJECTION_IDLE_REFRESH_MS;
    if (
      previous
      && previous.generation === generation
      && previous.fingerprint === fingerprint
    ) {
      previous.nextRefreshAt = this.now() + interval;
      return previous.projection;
    }
    const revision = previous?.generation === generation
      ? previous.projection.revision + 1
      : 1;
    const projection = {
      ...candidate,
      revision,
      generation,
      cursor: `${generation}:${revision}`,
    };
    if (!previous && this.projectionCache.size >= NATIVE_PROJECTION_CACHE_LIMIT) {
      const oldest = this.projectionCache.keys().next().value as string | undefined;
      if (oldest) this.projectionCache.delete(oldest);
    }
    this.projectionCache.set(key, {
      input: { ...input },
      projection,
      fingerprint,
      generation,
      nextRefreshAt: this.now() + interval,
    });
    this.storage.announceNativeAgentSessionProjection(input.environmentId);
    return projection;
  }

  private async reconcileProjectionCache(): Promise<void> {
    const due = [...this.projectionCache.values()]
      .filter((entry) => entry.nextRefreshAt <= this.now());
    for (let index = 0; index < due.length; index += ACTIVITY_STATUS_CONCURRENCY) {
      await Promise.allSettled(
        due.slice(index, index + ACTIVITY_STATUS_CONCURRENCY).map((entry) =>
          this.refreshProjection(entry.input, true)
        ),
      );
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
  ): Promise<PersistedNativeAgentSession> {
    this.assertAcceptingWork();
    if (!nonBlank(input.prompt) || !nonBlank(input.requestId)) {
      throw new Error("Native agent prompt and request ID must not be blank");
    }
    const session = await this.ensureSession(input);
    const provider = await this.provider(input);
    provider.registerSession?.(session.providerSessionId, {
      origin: session.origin,
      interactionPolicy: session.interactionPolicy,
      phase: input.phase,
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
        ),
    );
    return result.session;
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
    if (this.projectionTimer) clearInterval(this.projectionTimer);
    this.projectionTimer = null;
    if (this.projectionScan) await this.projectionScan.catch(() => undefined);
    this.projectionScan = null;
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
    this.projectionCache.clear();
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

  private interactionPhase(session: PersistedNativeAgentSession): string {
    if (session.origin === "looped-review") {
      const segments = session.logicalSessionKey.split(":");
      const phase = segments[2];
      if (phase && phase.length <= 256) return phase;
    }
    return session.origin === "build-pipeline" ? "pipeline" : "native-session";
  }

  private observationKey(
    session: PersistedNativeAgentSession,
    kind: AgentInteractionKind,
  ): string {
    return [session.agent, kind, session.origin, this.interactionPhase(session)].join("\0");
  }

  private evictInteractionObservation(key: string): void {
    this.interactionObservations.delete(key);
    for (const [trackedKey, tracked] of this.trackedInteractions) {
      if (tracked.observationKey === key) this.trackedInteractions.delete(trackedKey);
    }
    for (const [trackedKey, tracked] of this.providerReportedInteractions) {
      if (tracked.observationKey === key) this.providerReportedInteractions.delete(trackedKey);
    }
  }

  private ensureInteractionObservation(
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

  private emitInteractionObservation(observation: AgentInteractionObservation): void {
    // A diagnostic consumer must never delay or fail provider reconciliation.
    try {
      void Promise.resolve(this.options.onInteractionObservation?.({ ...observation }))
        .catch(() => undefined);
    } catch {
      // Synchronous telemetry failures are isolated too.
    }
  }

  private recordInteractionDetection(
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

  private settleMissingInteractions(
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

  private finalizeRemovedInteractions(
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

  private releaseMonitoredInteractionSession(
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

  private async reconcileAgentInteractionsOnce(): Promise<void> {
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
                providerState = await provider.status(session.providerSessionId);
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

  private async reconcileAgentActivityOnce(): Promise<void> {
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
                : await provider.status(session.providerSessionId).then((status) =>
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
  private async recordActivity(
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
  private async flushPendingPrRefreshNotifications(): Promise<void> {
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

  private markOpenCodeRecoveryCandidate(
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

  private hasOpenCodeManualPromptClaim(
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

  private hasNewerOpenCodeActivity(
    session: PersistedNativeAgentSession,
  ): boolean {
    const observed = this.observedSessionActivity.get(session.key);
    return observed?.providerSessionId === session.providerSessionId
      && observed.state !== "idle";
  }

  /** Coalesce concurrent idle observations onto one recovery pass per session. */
  private scheduleOpenCodeIncompleteTurnRecovery(
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
  private async recoverOpenCodeIncompleteTurnOnce(
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
  private backOffActivityGroup(groupKey: string): void {
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

  private async reconcilePendingLaunches(): Promise<void> {
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
          && isEnvironmentReadyForAgents(environment)
          && (this.launchRetryAt.get(environment.id) ?? 0) <= now
        )
        .map((environment) => this.reconcileInitialLaunch(environment.id)),
    );
  }

  private async drainPromptQueues(): Promise<void> {
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
  private async deferQueue(
    queueKey: string,
    reason: string,
    requestId?: string,
  ): Promise<void> {
    const attempts = (this.queueAttempts.get(queueKey) ?? 0) + 1;
    this.queueAttempts.set(queueKey, attempts);
    if (attempts >= MAX_QUEUE_DISPATCH_ATTEMPTS) {
      // The key and the reason are safe to log; the prompt itself never is.
      console.warn(
        `[native-agent] Prompt queue ${queueKey} has failed ${attempts} times: ${reason}`,
      );
      if (requestId !== undefined) {
        this.queueAttempts.delete(queueKey);
        this.queueRetryAt.delete(queueKey);
        await this.storage.failPromptQueueDispatch(queueKey, requestId, reason);
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

  private clearQueueBackoff(queueKey: string): void {
    this.queueAttempts.delete(queueKey);
    this.queueRetryAt.delete(queueKey);
  }

  private async drainPromptQueue(queueKey: string): Promise<void> {
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

  private async drainPromptQueueOnce(queueKey: string): Promise<void> {
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

  private async drainReadyPromptQueue(queueKey: string): Promise<void> {
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
    const status = await provider.status(session.providerSessionId);
    await this.assertEnvironmentLive(queue.environmentId);
    if (status === "running" || status === "blocked") return;
    if (status !== "idle") {
      await this.deferQueue(
        queueKey,
        `provider session is ${status}`,
        queue.inFlight?.requestId,
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

  private async reconcileInitialLaunchOnce(
    environmentId: string,
  ): Promise<void> {
    if (this.stopped) return;
    const environment = await this.storage.getEnvironment(environmentId);
    if (
      !environment
      || !environment.pendingAgentLaunch
      || !isEnvironmentReadyForAgents(environment)
    ) {
      return;
    }
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(
      environment.projectId,
    );
    const agent =
      environment.defaultAgent
      ?? repository.defaultAgent
      ?? config.global.defaultAgent;
    const mode = agent === "claude"
      ? environment.claudeMode ?? config.global.claudeMode
      : agent === "codex"
        ? environment.codexMode ?? config.global.codexMode
        : environment.opencodeMode ?? config.global.opencodeMode;
    const claudeBackend =
      environment.claudeNativeBackend
      ?? repository.claudeNativeBackend
      ?? config.global.claudeNativeBackend;

    // Terminal and Claude-tmux launches still need a PTY/tmux projection. They
    // are left pending for the backend terminal coordinator rather than being
    // falsely marked consumed by this native-session service.
    if (
      mode !== "native"
      || (agent === "claude" && claudeBackend === "tmux")
    ) {
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

    try {
      const prompt = environment.initialPrompt?.trim();
      // Passed as base64 rather than staged here: the provider stages inside the
      // durable dispatch lock, so only the supervisor that actually wins the
      // launch writes the file. Staging first would have every supervisor write
      // the same path concurrently.
      const images = environment.initialPromptAttachments?.map((attachment) => ({
        filename: attachment.name,
        data: attachment.base64Data,
      }));
      const session = prompt
        ? await this.dispatchPrompt({
            environmentId: environment.id,
            agent,
            logicalSessionKey,
            model,
            reasoningEffort,
            prompt,
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

      await this.storage.updateEnvironment(environment.id, {
        pendingAgentLaunch: false,
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
        initialPromptAttachments: undefined,
        startupAgentSession: {
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
  private async renameEnvironmentFromFirstPrompt(
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
  private async provider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider> {
    this.assertAcceptingWork();
    const cacheKey = `${input.environmentId}\0${input.agent}`;
    const environment = await this.assertEnvironmentLive(input.environmentId);
    const cached = this.providers.get(cacheKey);

    if (this.options.provider) {
      if (cached) return cached;
      const provider = await this.options.provider(input, environment);
      await this.assertEnvironmentLive(input.environmentId);
      this.assertAcceptingWork();
      this.cacheProvider(cacheKey, provider);
      return provider;
    }
    // A renderer readiness request or tab teardown can replace the bridge
    // without going through this service. Re-resolve its generation before
    // trusting a cached provider, otherwise that provider keeps sending to the
    // dead port/token for the rest of the backend process.
    const connection = await this.bridgeConnection(
      input.agent,
      environment,
      input.model,
      input.reasoningEffort,
    );
    const connectionIdentity = this.bridgeConnectionIdentity(connection);
    if (
      cached
      && this.providerConnections.get(cacheKey) === connectionIdentity
    ) return cached;
    await this.assertEnvironmentLive(input.environmentId);
    this.assertAcceptingWork();
    const provider = createBuildPipelineProvider(connection, {
      // Interactive sessions belong to a tab that renders approvals and
      // questions. Answering them here would run a command the user never saw
      // and cancel the card that exists to answer it.
      autoAnswerRequests: false,
      stageImages: (images) =>
        this.stageImages(input.environmentId, images),
    });
    this.cacheProvider(cacheKey, provider, connectionIdentity);
    return provider;
  }

  /**
   * Publish a provider and retire any "no bridge is running" note for it.
   *
   * Reaching here means a bridge was just started or connected to, so the
   * observer's cooldown is stale and would otherwise keep the sidebar reporting
   * idle for up to its full window after a user opens a tab.
   */
  private cacheProvider(
    cacheKey: string,
    provider: NativeAgentRuntimeProvider,
    connectionIdentity?: string,
  ): void {
    this.providers.set(cacheKey, provider);
    if (connectionIdentity) {
      this.providerConnections.set(cacheKey, connectionIdentity);
    } else {
      this.providerConnections.delete(cacheKey);
    }
    this.absentBridgeUntil.delete(cacheKey);
  }

  private bridgeConnectionIdentity(connection: BridgeConnection): string {
    return createHash("sha256")
      .update(connection.agent)
      .update("\0")
      .update(connection.baseUrl)
      .update("\0")
      .update(connection.authToken)
      .digest("hex");
  }

  /**
   * Resolve a provider for observation only, never starting a bridge.
   *
   * `provider()` resolves its connection by *invoking the start command*, so
   * calling it from the activity sweep would spawn a bridge process for every
   * environment that has ever held a session — at startup, with no tab open,
   * and then keep them all alive on a two-second poll. An environment with no
   * running bridge has no turn in flight, which the caller records as idle, so
   * `undefined` here is an answer rather than a failure.
   */
  private async observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined> {
    this.assertAcceptingWork();
    const cacheKey = `${input.environmentId}\0${input.agent}`;
    if ((this.absentBridgeUntil.get(cacheKey) ?? 0) > this.now()) {
      return undefined;
    }
    const environment = await this.assertEnvironmentLive(input.environmentId);
    const cached = this.providers.get(cacheKey);
    if (cached) return cached;

    if (this.options.provider) {
      const provider = await this.options.provider(input, environment);
      await this.assertEnvironmentLive(input.environmentId);
      this.assertAcceptingWork();
      this.providers.set(cacheKey, provider);
      this.providerConnections.delete(cacheKey);
      return provider;
    }
    const connection = await this.observeBridgeConnection(
      input.agent,
      environment,
    );
    if (!connection) {
      this.absentBridgeUntil.set(
        cacheKey,
        this.now() + ABSENT_BRIDGE_RECHECK_MS,
      );
      return undefined;
    }
    await this.assertEnvironmentLive(input.environmentId);
    this.assertAcceptingWork();
    const provider = createBuildPipelineProvider(connection, {
      autoAnswerRequests: false,
      stageImages: (images) =>
        this.stageImages(input.environmentId, images),
    });
    this.cacheProvider(
      cacheKey,
      provider,
      this.bridgeConnectionIdentity(connection),
    );
    return provider;
  }

  /** Forget a provider whose environment is gone, along with its observer state. */
  private forgetProviderState(cacheKey: string): void {
    this.providers.delete(cacheKey);
    this.providerConnections.delete(cacheKey);
    this.absentBridgeUntil.delete(cacheKey);
    this.activityRetryAt.delete(cacheKey);
    this.activityAttempts.delete(cacheKey);
  }

  /**
   * Drop a provider whose read-only activity call failed so the next sweep
   * reconnects with fresh bridge coordinates. The identity check avoids
   * evicting a replacement installed by concurrent work.
   *
   * Deliberately does not dispose. `OpenCodeProvider.dispose()` aborts the
   * controller whose signal is attached to *every* request that provider makes,
   * including a `promptAsync` the user is waiting on — so disposing here would
   * let a failed background health read cancel a live prompt and report it as
   * an ambiguous dispatch. Eviction alone is enough: these providers are built
   * with `autoAnswerRequests: false`, so they hold no event stream, and
   * `pruneProviders` still disposes a provider whose environment has gone away,
   * where nothing can be in flight.
   */
  private evictProvider(
    input: Pick<EnsureNativeAgentSessionInput, "environmentId" | "agent">,
    provider: NativeAgentRuntimeProvider,
  ): void {
    const cacheKey = `${input.environmentId}\0${input.agent}`;
    if (this.providers.get(cacheKey) !== provider) return;
    this.providers.delete(cacheKey);
    this.providerConnections.delete(cacheKey);
  }

  /** Stage base64 images into the workspace so a bridge will accept them. */
  private async stageImages(
    environmentId: string,
    images: readonly TaskSnapshotImage[],
  ): Promise<PromptAttachment[]> {
    const environment = await this.assertEnvironmentLive(environmentId);
    return stagePromptImages(
      this.invoke,
      environment,
      images,
      INITIAL_PROMPT_STAGING_DIRECTORY,
    );
  }

  /**
   * Dispose providers whose environment has gone away.
   *
   * Without this a deleted environment's provider stays cached for the life of
   * the process, holding its bridge connection open.
   */
  private async pruneProviders(liveEnvironmentIds: Set<string>): Promise<void> {
    const stale: Array<[string, NativeAgentRuntimeProvider]> = [];
    for (const [cacheKey, provider] of this.providers) {
      const environmentId = cacheKey.slice(0, cacheKey.indexOf("\0"));
      if (!liveEnvironmentIds.has(environmentId)) stale.push([cacheKey, provider]);
    }
    if (stale.length === 0) return;
    for (const [cacheKey] of stale) this.forgetProviderState(cacheKey);
    // Safe to dispose here, unlike the observer's eviction path: the
    // environment is gone, so nothing can still be dispatching through it.
    await Promise.allSettled(stale.map(([, provider]) => provider.dispose?.()));
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
      session.key !== key
      || session.environmentId !== input.environmentId
      || session.agent !== input.agent
      || session.logicalSessionKey !== input.logicalSessionKey
      || (input.origin !== undefined && session.origin !== input.origin)
      || (
        input.interactionPolicy !== undefined
        && session.interactionPolicy.mode !== input.interactionPolicy.mode
      )
    ) {
      throw new Error("Native agent session key collision");
    }
  }

  private async createProviderSession(
    provider: NativeAgentRuntimeProvider,
    input: EnsureNativeAgentSessionInput,
  ): Promise<string> {
    await this.assertEnvironmentLive(input.environmentId);
    const providerSessionId = await provider.createSession(
      input.phase ?? "build",
      input.title?.trim() || "Agent Session",
      {
        clientSessionKey: input.logicalSessionKey,
        model: input.model,
        effort: input.reasoningEffort,
        mode: input.sessionMode,
        fastMode: input.fastMode,
        interaction: {
          origin: input.origin ?? "interactive-native",
          interactionPolicy: input.interactionPolicy
            ?? ((input.origin === "build-pipeline" || input.origin === "looped-review")
              ? UNATTENDED_AGENT_INTERACTION_POLICY
              : INTERACTIVE_AGENT_INTERACTION_POLICY),
          phase: input.phase,
        },
      },
    );
    await this.assertEnvironmentLive(input.environmentId);
    return providerSessionId;
  }

  private composeDraftHoldsQueue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const draft = value as Record<string, unknown>;
    if (typeof draft.text !== "string") return true;
    if (!Array.isArray(draft.mentions) || !Array.isArray(draft.attachments)) {
      return true;
    }
    return draft.text.trim().length > 0
      || draft.mentions.length > 0
      || draft.attachments.length > 0;
  }

  private queueBoolean(message: unknown, field: string): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return typeof value === "boolean" ? value : undefined;
  }

  private queueString(message: unknown, field: string): string | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return nonBlank(value) ? value : undefined;
  }

  private queueReasoningEffort(message: unknown): string | undefined {
    return this.queueString(message, "reasoningEffort")
      ?? this.queueString(message, "effort")
      ?? this.queueString(message, "variant");
  }

  private queueFastMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const record = message as Record<string, unknown>;
    const value = agent === "claude"
      ? record.fastModeEnabled
      : agent === "codex"
        ? record.fastMode
        : undefined;
    return typeof value === "boolean" ? value : undefined;
  }

  private queueExecutionMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): ProviderExecutionMode {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return "plan";
    }
    const record = message as Record<string, unknown>;
    if (agent === "claude") {
      if (record.planModeEnabled === true) return "plan";
      if (record.planModeEnabled === false || record.planModeEnabled === undefined) {
        return "build";
      }
      return "plan";
    }
    if (record.mode === "plan" || record.mode === "build") return record.mode;
    return record.mode === undefined ? "build" : "plan";
  }

  private async bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
    model?: string,
    effort?: string,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${suffix}_server_cmd`,
        { environmentId: environment.id },
      );
      if (!result.authToken) {
        throw new Error(`${agent} bridge authentication is unavailable`);
      }
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
        model,
        effort,
      };
    }

    if (!environment.containerId) {
      throw new Error("Native agent container is unavailable");
    }
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${suffix}_server`,
      { containerId: environment.containerId },
    );
    if (!result.authToken) {
      throw new Error(`${agent} bridge authentication is unavailable`);
    }
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
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
      const result = await this.invoke<
        { port: number; authToken: string } | null
      >("peek_local_agent_bridge", { environmentId: environment.id, agent });
      if (!result?.authToken) return undefined;
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
      };
    }

    if (!environment.containerId) return undefined;
    const result = await this.invoke<
      { hostPort: number; authToken: string } | null
    >("peek_container_agent_bridge", {
      containerId: environment.containerId,
      agent,
    });
    if (!result?.authToken) return undefined;
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }
}
