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
  NativeAgentMessageWindow,
  NativeAgentResumeEntry,
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  NativeAgentSlashCommand,
  NativeAgentToolDetails,
} from "@orkestrator/protocol/native-agent";
import {
  isFallbackExecutionProfileId,
  nativeAgentCapabilities,
  resolveReasoningId,
} from "@orkestrator/protocol/native-agent";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import { boundTranscriptResponse } from "@orkestrator/protocol/transcript-window";
import { resolveStartupLaunchFromSettings } from "@orkestrator/protocol/startup-launch";
import { resolveAgentPlatformSettings } from "@orkestrator/protocol/agent-settings";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import type {
  Environment,
  OpenCodeIncompleteTurnNotice,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
} from "./models.js";
import type { StorageService } from "./storage.js";
import { PendingNativeAgentDispatchError } from "./storage.js";
import {
  AmbiguousPromptDispatchError,
  createNativeAgentProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  readProviderStatus,
  type BridgeConnection,
  type NativeAgentRuntimeProvider,
  type ProviderInteractiveSnapshot,
  type ProviderInteractionObservationEvent,
  type ProviderExecutionMode,
} from "./native-agent-provider.js";
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

export const PROVIDER_REPORTED_INTERACTION_GRACE_MS = 60_000;

/** An authoritative provider probe proved that a session no longer exists. */
export class NativeAgentProviderSessionMissingError extends Error {
  constructor() {
    super("Native agent provider session was not found");
    this.name = "NativeAgentProviderSessionMissingError";
  }
}

export type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

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
  /** Primary execution profile to persist before the first interactive prompt. */
  executionProfileId?: string;
}

export interface DispatchNativeAgentPromptInput extends EnsureNativeAgentSessionInput {
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

export interface AdoptNativeAgentSessionInput extends EnsureNativeAgentSessionInput {
  providerSessionId: string;
  expectedProviderSessionId?: string;
  controls?: NativeAgentControlUpdate;
}

export interface NativeAgentProjectionInput {
  environmentId: string;
  agent: BuildPipelineAgent;
  logicalSessionKey: string;
  /**
   * Newest messages this projection may carry.
   *
   * Omitted means "keep whatever window this session already had", so a caller
   * that only wants status — the agent-information panel, the reconciler —
   * cannot shrink a transcript the tab has expanded.
   */
  messageLimit?: number;
}

export function controlsFromSessionInput(
  input: EnsureNativeAgentSessionInput,
): NativeAgentControlUpdate | undefined {
  const controls: NativeAgentControlUpdate = {
    ...(input.model ? { modelId: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningId: input.reasoningEffort } : {}),
    ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
    ...(input.sessionMode ? { mode: input.sessionMode } : {}),
    ...(input.executionProfileId ? { executionProfileId: input.executionProfileId } : {}),
  };
  return Object.keys(controls).length > 0 ? controls : undefined;
}

export type NativeAgentProjectionCacheEntry = {
  input: NativeAgentProjectionInput;
  projection: NativeAgentSessionProjection;
  fingerprint: string;
  generation: string;
};

export function isValidInteractionMetadata(input: {
  origin?: AgentInteractionOrigin;
  interactionPolicy?: AgentInteractionPolicy;
}): boolean {
  if (input.origin !== undefined && !AGENT_INTERACTION_ORIGINS.includes(input.origin)) return false;
  if (input.interactionPolicy !== undefined && !isAgentInteractionPolicy(input.interactionPolicy))
    return false;
  const origin = input.origin ?? "interactive-native";
  const policyMode =
    input.interactionPolicy?.mode ??
    (origin === "build-pipeline" || origin === "looped-review" ? "unattended" : "interactive");
  return (
    (origin === "build-pipeline" || origin === "looped-review") === (policyMode === "unattended")
  );
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
  return (
    transition.state === "idle" &&
    (transition.previousState === "working" || transition.previousState === "waiting")
  );
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
  /** Injectable for bounded provider-start retries. */
  delay?: (milliseconds: number) => Promise<void>;
  /** Disabled by default. Milestone 3 observes and never resolves. */
  interactionMonitorMode?: "disabled" | "observe-only";
  interactionMonitorAdoptionEnabled?: boolean;
  interactionMonitorIntervalMs?: number;
  interactionMonitorMaxConcurrency?: number;
  interactionMonitorMaxSessionsPerEnvironment?: number;
  interactionMonitorRetryBaseMs?: number;
  interactionMonitorMaxRetries?: number;
  onInteractionObservation?: (observation: AgentInteractionObservation) => void | Promise<void>;
  onActivityTransition?: (event: NativeAgentActivityTransition) => void;
  /** Test seam for exercising deterministic detail-cache capacity eviction. */
  toolDetailCacheMaxEntries?: number;
  /** Test seam for exercising deterministic detail-cache byte eviction. */
  toolDetailCacheMaxBytes?: number;
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

export const QUEUE_RETRY_BASE_MS = 2_000;
export const QUEUE_RETRY_CEILING_MS = 60_000;
export const MAX_QUEUE_DISPATCH_ATTEMPTS = 5;
export const LAUNCH_RETRY_MS = 10_000;
export const ACP_SESSION_CREATE_ATTEMPTS = 4;
export const ACP_SESSION_CREATE_RETRY_BASE_MS = 250;
export const ACTIVITY_STATUS_CONCURRENCY = 8;
export const ACTIVITY_RETRY_BASE_MS = 2_000;
export const ACTIVITY_RETRY_CEILING_MS = 60_000;
export const OPENCODE_RECOVERY_RETRY_BASE_MS = 2_000;
export const OPENCODE_RECOVERY_RETRY_CEILING_MS = 60_000;
/**
 * Shown when a new prompt collides with a dispatch that is still parked.
 *
 * Names both ways out, because the storage-level refusal it replaces described
 * an internal invariant rather than anything the user could act on.
 */
export const PARKED_DISPATCH_CONFLICT_MESSAGE =
  "An earlier message is still awaiting confirmation." +
  " Retry or discard it before sending another.";

export const OPENCODE_RECOVERY_MAX_CANDIDATES = 1_024;
export const OPENCODE_MANUAL_PROMPT_CLAIM_MS = 2 * 60_000;
export const OPENCODE_INCOMPLETE_TURN_HISTORY_LIMIT = 64;
/** How long "no bridge is running" is trusted before it is re-probed. */
export const ABSENT_BRIDGE_RECHECK_MS = 15_000;
export const INTERACTION_MONITOR_MAX_OBSERVATIONS = 64;
export const INTERACTION_MONITOR_MAX_TRACKED_REQUESTS = 512;
export const INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS = 1_024;
export const INTERACTION_MONITOR_DEFAULT_CONCURRENCY = 4;
export const INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT = 8;
export const INTERACTION_MONITOR_DEFAULT_MAX_RETRIES = 5;
export const INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS = 1_000;
/**
 * How long a tab stays `connecting` while the provider reports `missing`.
 *
 * A bridge that is restarting, restoring its state file or re-attaching an
 * idle-detached session answers `missing` for a moment on a session that is
 * about to come back, and reporting that as a failure flashed Connection
 * Failed on a tab that went on to connect perfectly well.
 *
 * The grace has to be bounded, though: `connecting` renders a spinner with no
 * retry control, and no read path re-creates a provider session, so a session
 * that is genuinely gone would leave the tab with no way back. Past this the
 * projection reports the failure, which is the state that carries the control.
 *
 * Elapsed time rather than a count of reads, because the read rate is not a
 * property of the outage: a tab polls at one cadence while `recovering`, a
 * second reader or a burst of resource-changed events can spend a read budget
 * in a fraction of the time an ordinary reconnect needs.
 */
export const NATIVE_MISSING_SESSION_GRACE_MS = 15_000;
export const NATIVE_PROJECTION_CACHE_LIMIT = 1_024;
export const NATIVE_PROJECTION_MAX_MESSAGES = 512;
/**
 * Ceiling for an explicitly expanded transcript window.
 *
 * The default window keeps ordinary refreshes small; a user who asks to see
 * earlier messages can raise it up to here, which is still bounded by
 * `NATIVE_PROJECTION_MAX_BYTES`.
 */
export const NATIVE_PROJECTION_MAX_WINDOW_MESSAGES = 4_096;
export const NATIVE_PROJECTION_MAX_BYTES = 16 * 1024 * 1024;
export const NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES = 4_096;
export const NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const NATIVE_TOOL_DETAIL_MAX_BYTES = 4 * 1024 * 1024;
export const NATIVE_MODEL_CATALOG_TTL_MS = 30_000;
export const NATIVE_MODEL_CATALOG_CACHE_LIMIT = 128;
export const NATIVE_SLASH_COMMAND_TTL_MS = 30_000;
export const NATIVE_SLASH_COMMAND_CACHE_LIMIT = 256;
/** Prevent a failed optional discovery endpoint from being retried every poll. */
export const NATIVE_DISCOVERY_RETRY_MS = 5_000;

/**
 * Shared with the renderer rather than reimplemented here. The projection's
 * `capabilities.queue` and the composer's decision to enqueue have to agree, so
 * they read the same protocol table instead of two copies that can drift.
 */
export function nativeCapabilities(agent: BuildPipelineAgent): NativeAgentCapabilities {
  return nativeAgentCapabilities(agent);
}

/**
 * Build the composer control list for one projection.
 *
 * Capabilities are a required argument rather than an optional refinement: the
 * generated array used to be derived from composer *state* alone, so a provider
 * that happened to report execution profiles, local settings or prompt
 * suggestions produced a control for a platform whose table says it has none.
 * State decides whether a permitted control has anything to show; the table
 * decides whether it is permitted at all.
 */
export function nativeComposerControls(
  composer: NativeAgentComposerState | undefined,
  disabled: boolean,
  capabilities: NativeAgentCapabilities,
): NativeAgentComposerControl[] {
  if (!composer) return [];
  const selectedModel =
    composer.models.find((model) => model.id === composer.selectedModelId) ?? composer.models[0];
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
  if (
    capabilities.composer.speed &&
    composer.fastModeAvailable &&
    composer.fastModeEnabled !== null
  ) {
    controls.push({
      kind: "toggle",
      id: "speed",
      label: "Fast mode",
      value: composer.fastModeEnabled,
      disabled,
    });
  }
  if (capabilities.composer.mode && composer.modes.length > 0) {
    controls.push({
      kind: "segmented",
      id: "mode",
      label: "Mode",
      value: composer.selectedModeId,
      options: composer.modes,
      disabled,
    });
  }
  if (capabilities.composer.executionProfile && (composer.executionProfiles?.length ?? 0) > 0) {
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
  if (capabilities.composer.localSettings && typeof composer.includeLocalSettings === "boolean") {
    controls.push({
      kind: "toggle",
      id: "local-settings",
      label: "Include local Claude settings",
      value: composer.includeLocalSettings,
      disabled,
    });
  }
  if (
    capabilities.composer.promptSuggestions &&
    typeof composer.promptSuggestionsEnabled === "boolean"
  ) {
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

export function nonBlank(value: unknown): value is string {
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
export function isEnvironmentReadyForAgents(environment: Environment): boolean {
  return (
    environment.status === "running" &&
    (environment.setupPhase === "ready" || environment.setupScriptsComplete === true)
  );
}

export const LEGACY_TIMESTAMP_ENVIRONMENT_NAME = /^\d{8}-\d{6}$/;
export const COMPACT_TIMESTAMP_ENVIRONMENT_NAME = /^\d{15}$/;

/**
 * True for a name generated before the environment had a prompt-derived title.
 *
 * Twin of `apps/web/src/lib/environment-name.ts` — the renderer applies the same
 * guard on its own send path, and both must agree on which names are renameable.
 */
export function isGeneratedEnvironmentName(name: string): boolean {
  return (
    LEGACY_TIMESTAMP_ENVIRONMENT_NAME.test(name) || COMPACT_TIMESTAMP_ENVIRONMENT_NAME.test(name)
  );
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

export type OpenCodeRecoveryCandidate = {
  providerSessionId: string;
  attempts: number;
  retryAt: number;
};

export type PromptDispatchPreparation =
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

export {
  createHash,
  BUILD_PIPELINE_AGENTS,
  isActiveBuildPhase,
  isBuildPipeline,
  aggregateAgentActivityState,
  AGENT_INTERACTION_ORIGINS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionPolicy,
  isFallbackExecutionProfileId,
  nativeAgentCapabilities,
  resolveReasoningId,
  withSessionActionSlashCommands,
  boundTranscriptResponse,
  resolveStartupLaunchFromSettings,
  resolveAgentPlatformSettings,
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
};

export type {
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
};
