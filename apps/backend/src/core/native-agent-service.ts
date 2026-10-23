export * from "./native-agent-service-shared.js";
import * as shared from "./native-agent-service-shared.js";
import path from "node:path";
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
  NATIVE_DISCOVERY_RETRY_MS,
  NATIVE_MISSING_SESSION_GRACE_MS,
  NATIVE_MODEL_CATALOG_CACHE_LIMIT,
  NATIVE_MODEL_CATALOG_TTL_MS,
  NATIVE_PROJECTION_CACHE_LIMIT,
  NATIVE_PROJECTION_MAX_BYTES,
  NATIVE_PROJECTION_MAX_MESSAGES,
  NATIVE_PROJECTION_MAX_WINDOW_MESSAGES,
  NATIVE_PROJECTION_REVISION_LIMIT,
  NATIVE_HISTORY_CACHE_MAX_BYTES,
  NATIVE_HISTORY_PAGE_DEFAULT_BYTES,
  NATIVE_HISTORY_PAGE_DEFAULT_MESSAGES,
  NATIVE_HISTORY_PAGE_MAX_MESSAGES,
  NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES,
  NATIVE_SYNC_LIVE_MESSAGES,
  NATIVE_SYNC_LIVE_TARGET_BYTES,
  NATIVE_SYNC_MAX_DELTA_BYTES,
  NATIVE_SYNC_MAX_DELTA_OPERATIONS,
  NATIVE_SYNC_MAX_SNAPSHOT_BYTES,
  NATIVE_SYNC_MAX_REVISIONS,
  NATIVE_SYNC_MAX_REVISION_BYTES,
  NATIVE_SYNC_MAX_TOTAL_REVISION_BYTES,
  NATIVE_SYNC_REVISION_TTL_MS,
  NATIVE_DIRECT_PAGE_CACHE_MAX_BYTES,
  NATIVE_DIRECT_PAGE_CACHE_MAX_ENTRIES,
  NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_BYTES,
  NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_ENTRIES,
  NATIVE_DIRECT_PAGE_CACHE_TTL_MS,
  NATIVE_FILE_DETAIL_MAX_BYTES,
  NATIVE_REVISED_MESSAGES_MAX_BYTES,
  inlineFileContentLabel,
  inlineFileUrlDisposition,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_BYTES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRIES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRY_BYTES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_BYTES,
  NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_ENTRIES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES,
  NATIVE_TOOL_DETAIL_MAX_BYTES,
  ProviderUnavailableError,
  boundTranscriptResponse,
  nativeComposerControls,
  resolveReasoningId,
  INTERACTION_MONITOR_DEFAULT_CONCURRENCY,
  INTERACTION_MONITOR_DEFAULT_MAX_RETRIES,
  INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT,
  INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS,
  INTERACTION_MONITOR_MAX_ADOPTED_SESSIONS,
  INTERACTION_MONITOR_MAX_OBSERVATIONS,
  INTERACTION_MONITOR_MAX_TRACKED_REQUESTS,
  PROVIDER_REPORTED_INTERACTION_GRACE_MS,
  isActiveBuildPhase,
  isBuildPipeline,
  isEnvironmentReadyForAgents,
  ACTIVITY_RETRY_BASE_MS,
  ACTIVITY_RETRY_CEILING_MS,
  ACTIVITY_STATUS_CONCURRENCY,
  LAUNCH_RETRY_MS,
  MAX_QUEUE_DISPATCH_ATTEMPTS,
  QUEUE_RETRY_BASE_MS,
  QUEUE_RETRY_CEILING_MS,
  aggregateAgentActivityState,
  assertValidPromptAttachments,
  resolveAgentPlatformSettings,
  resolveStartupLaunchFromSettings,
  ACP_SESSION_CREATE_ATTEMPTS,
  ACP_SESSION_CREATE_RETRY_BASE_MS,
} from "./native-agent-service-shared.js";
import {
  withProviderSessionTeardownLock,
  providerSessionHeldElsewhere,
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
  coordinatorRuntimeId,
  agentSessionOwnerKey,
} from "@orkestrator/protocol/coordinator";
import {
  NativeAgentCommandCatalogueCache,
  commandCatalogueKey,
  type CommandCatalogueSnapshot,
} from "./native-agent-command-catalogue.js";
import {
  type NativeAgentCommandRefreshOutcome,
  type NativeAgentDefaultModelResolution,
  type NativeAgentModelSubstitution,
  nativeAgentSteerRejectionMessage,
  nativeAsyncQuestionItemId,
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  NATIVE_AGENT_REVISED_MESSAGES_MAX,
  recoverBackgroundTaskLaunchId,
  resolveNativeComposerModelId,
  withResolvedNativeComposerModel,
  withoutSuppressedComposerControls,
  type NativeAgentDiscoverySection,
  type NativeAgentDiscoverySectionState,
  type NativeAgentDiscoveryUpdate,
  type NativeAgentDiscoveryView,
  type NativeAgentSessionStateUpdate,
  type NativeAgentSessionStateView,
  type NativeAgentTranscriptDelta,
  type NativeAgentTranscriptUpdate,
  type NativeAgentTranscriptView,
  type NativeAgentViewIdentity,
  type NativeAgentAsyncQuestionResponse,
  type NativeAgentContextUsage,
  type NativeAgentNotice,
  isNativeInlineErrorMessageId,
  nativeAgentApprovalModes,
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
import { localAgentAccountIds } from "./agent-account-bridge-state.js";
import type { NativeAgentProviderEnvironment } from "./native-agent-provider.js";
import { assertValidPromptImages, mimeTypeForImageData } from "./prompt-attachments.js";
import {
  ProviderRegistry,
  providerCacheKey,
  bridgeConnectionIdentity,
} from "./native-agent-provider-registry.js";
import { NATIVE_AGENT_SESSION_VERSION, sessionIncompleteTurnNotice } from "./models.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import {
  NativeAgentObservationBroker,
  MAIL_INJECT_OBSERVATION_MAX_AGE_MS,
  nativeAgentObservationGroupKey,
  observationSatisfies,
  nativeAgentObservationCapabilities,
  QUEUE_BUSY_OBSERVATION_MAX_AGE_MS,
  type NativeAgentObservationDemand,
  type NativeAgentObservationStatus,
  type NativeAgentObservationView,
  type NativeAgentObservationWakeReason,
} from "./native-agent-observation.js";
import { NativeAgentTurnRecovery } from "./native-agent-turn-recovery.js";
import { NativeQueueScheduling } from "./native-agent-queue-scheduling.js";
import { DEFAULT_WORKFLOW_DISCOVERY_MS, keyedSchedulingEnabled } from "./workflow-supervisor.js";
import { randomUUID } from "node:crypto";
import {
  PromptRejectedError,
  type ProviderMcpConfigEvidenceRead,
} from "./agent-provider-contract.js";
import { legacyCompatibilityCounts } from "./change-tracking/legacy-payload.js";
import { revisedRowsReconciliationToken } from "@orkestrator/protocol/node/revised-rows";
import { claudeReasoningSelection } from "@orkestrator/protocol/claude-model-catalog";
import { fileURLToPath } from "node:url";
import {
  AGENT_INTERACTION_KINDS,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import { redactArtifactGrantArgs } from "@orkestrator/protocol/transcript-artifacts";
import {
  parseCoordinatorDelegatedPrompt,
  stripSystemInstructions,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  inferredComposerSelectionToPersist,
  lastAssistantModelRef,
} from "./native-agent-composer-selection.js";
import { nativeAgentPlatformPolicy } from "./native-agent-platform-policy.js";
import { heldSessionModel } from "./session-held-model.js";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  createNativeAgentDisplayTail,
  displayTailRecoveryWindow,
} from "./native-agent-display-tails.js";
import { NativeAgentDisplayTailScheduler } from "./native-agent-display-tail-scheduler.js";
import {
  ProgressiveReadMetrics,
  ProgressiveReadPhaseTimer,
  monotonicMs,
  type ProgressiveCacheTier,
  type ProgressiveReadOutcome,
  type ProgressiveReadPhases,
} from "./native-agent-progressive-metrics.js";
import { readReadableHostFile } from "./path-safety.js";
import {
  BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES,
  readBridgePartDetail as bridgePartDetail,
} from "@orkestrator/protocol/node/bridge-transcript-summary";
import {
  DirectHistoryPageCache,
  decodeHistoryCursor,
  encodeDirectHistoryCursor,
} from "./native-agent-direct-history.js";
import {
  ArtifactOverlayIndex,
  artifactPublicationIds,
  overlayArtifactParts,
  type ArtifactOverlay,
} from "./native-agent-service-projection-artifacts.js";
import {
  ProjectedMessageCache,
  copyProjectionSource,
  type ProjectionDetailRegistration,
  type ProjectionEntryContext,
} from "./native-agent-projection-entries.js";
import { NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION } from "@orkestrator/protocol/native-agent-transcript-patch";
import { encodedPatchBytes, patchTranscriptDelta } from "./native-agent-transcript-patches.js";
import {
  digestWithMessages,
  encodedArrayBytes,
  encodedBytesWithMessages,
  encodedValue,
  reuseUnchangedMessages,
  sameEncoding,
  sameIds,
  tailDeletions,
  updateHashWithValues,
  valueFingerprint,
} from "./native-agent-projection-encoding.js";
import {
  unsupportedCommandCatalogueState,
  parseNativeAgentCommandIntent,
} from "@orkestrator/protocol/agent-command-catalogue";
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
import {
  assertEnvironmentAcceptsAgentWork,
  beginEnvironmentAgentWork,
} from "./environment-replacement-fence.js";
import { beginChangeTrackingTurn } from "./native-agent-change-tracking.js";
import {
  beginArtifactDispatchTurn,
  settleArtifactDispatchTurn,
} from "./workflow-artifact-turns.js";
import { claudeNativeParameterValues } from "@orkestrator/protocol/agent-settings";
import {
  buildInitialPromptWithAttachmentReferences,
  type SavedInitialPromptAttachment,
} from "@orkestrator/protocol/initial-prompt-attachments";
import { buildTerminalAgentLaunchCommand } from "@orkestrator/protocol/terminal-agent-launch";
import { readActivityGroup } from "./native-agent-activity-reads.js";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { composeDraftHoldsQueue } from "./compose-draft-occupancy.js";

// ---- module code from native-agent-service-base.ts ----
type BuildPipelineAgent = shared.BuildPipelineAgent;
type TaskSnapshotImage = shared.TaskSnapshotImage;
type AgentActivityState = shared.AgentActivityState;
type AgentInteractionKind = shared.AgentInteractionKind;
type AgentInteractionApplyOutcome = shared.AgentInteractionApplyOutcome;
type AgentInteractionOrigin = shared.AgentInteractionOrigin;
type AgentInteractionResolution = shared.AgentInteractionResolution;
type AgentModel = shared.AgentModel;
type NativeAgentCapabilities = shared.NativeAgentCapabilities;
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
type NativeAgentServiceOptions = shared.NativeAgentServiceOptions;
type AgentInteractionObservation = shared.AgentInteractionObservation;
type PromptDispatchPreparation = shared.PromptDispatchPreparation;

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

// ---- module code from native-agent-service-dispatch.ts ----
type NativeAgentAuthStatus = shared.NativeAgentAuthStatus;
type NativeAgentMcpServerAction = shared.NativeAgentMcpServerAction;
type PersistedNativeAgentPendingSteer = shared.PersistedNativeAgentPendingSteer;

// ---- module code from native-agent-service-projection.ts ----
type ProviderSessionStateSnapshot = shared.ProviderSessionStateSnapshot;
type ProviderTranscriptSnapshot = shared.ProviderTranscriptSnapshot;

interface ProjectedProgressiveTranscript {
  value: NativeAgentTranscriptView;
  historyStartIndex?: number;
  historyEndIndex?: number;
  /** Artifact ledger revision the view's artifact parts reflect. */
  ledgerRevision?: number;
  /** Ids in `value.revisedMessages` sent because a publication reached them. */
  ledgerRevisedIds?: readonly string[];
}
type NativeAgentProjectionUpdateInput = shared.NativeAgentProjectionUpdateInput;
type NativeAgentMessagePageInput = shared.NativeAgentMessagePageInput;
type NativeAgentProjectionUpdate = shared.NativeAgentProjectionUpdate;
type NativeAgentTranscriptUpdateInput = shared.NativeAgentTranscriptUpdateInput;
type NativeAgentProgressiveInput = shared.NativeAgentProgressiveInput;
type NativeAgentDiscoveryUpdateInput = shared.NativeAgentDiscoveryUpdateInput;
type NativeAgentProjectionDelta = shared.NativeAgentProjectionDelta;
type NativeAgentMessagePage = shared.NativeAgentMessagePage;

const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);
const READ_TOOL_KEYS = new Set(["read", "readfile", "cursorread", "view", "viewfile"]);
const READ_TOOL_PATH_KEYS = ["file_path", "filePath", "path", "target_file", "file"] as const;

function localImagePath(reference: unknown): string | undefined {
  if (typeof reference !== "string" || /[\0\r\n]/.test(reference)) return undefined;
  let candidate = reference.trim();
  if (!candidate) return undefined;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  }
  if (!path.isAbsolute(candidate) || !IMAGE_MIME_TYPES.has(path.extname(candidate).toLowerCase())) {
    return undefined;
  }
  return candidate;
}

function providerReportedImagePath(part: Record<string, unknown>): string | undefined {
  if (part.type === "image") {
    return (
      localImagePath(part.fileUrl) ?? localImagePath(part.filename) ?? localImagePath(part.content)
    );
  }
  if (part.type !== "tool-invocation" || part.toolState !== "success") return undefined;
  const toolKey =
    typeof part.toolName === "string"
      ? part.toolName.trim().toLowerCase().replace(/[_-]+/g, "")
      : "";
  if (!READ_TOOL_KEYS.has(toolKey)) return undefined;
  const args =
    part.toolArgs && typeof part.toolArgs === "object" && !Array.isArray(part.toolArgs)
      ? (part.toolArgs as Record<string, unknown>)
      : undefined;
  for (const key of READ_TOOL_PATH_KEYS) {
    const candidate = localImagePath(args?.[key]);
    if (candidate) return candidate;
  }
  return localImagePath(part.toolTitle);
}

/** Tool arguments with the artifact scope grant redacted (see `redactArtifactGrantArgs`). */
function redactArtifactGrant(part: Record<string, unknown>): Record<string, unknown> | undefined {
  return redactArtifactGrantArgs(part.toolName, part.toolArgs, {
    toolTitle: part.toolTitle,
    mcpServerName: part.mcpServerName,
  });
}

function imageMimeType(filePath: string): string {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "image/png";
}

function visibleProjectionNotices(
  agent: BuildPipelineAgent,
  notices: readonly NativeAgentNotice[] | undefined,
  incompleteTurn: IncompleteTurnNotice | undefined,
): NativeAgentNotice[] {
  const visible = (notices ?? [])
    .filter((notice) => notice.kind !== "error" && notice.kind !== "stopped")
    .slice(0, incompleteTurn ? 511 : 512);
  if (!incompleteTurn) return visible;
  const label = AGENT_PLATFORM_LABELS[agent] ?? agent;
  return [
    ...visible,
    {
      kind: "incomplete-turn",
      message:
        incompleteTurn.kind === "failed"
          ? `The previous ${label} turn ended before completion.`
          : `${label} could not complete the previous turn after recovery.`,
    },
  ];
}

/**
 * Carry sparse provider turn rows across projection reads.
 *
 * Live bridge events often contain only the newest row. The backend projection
 * is the renderer's authoritative reload source, so replacing that sparse list
 * would make older rows disappear whenever the tab remounted. Re-inserting by
 * id also moves a corrected row to the newest position while retaining the
 * strict twenty-row bound.
 */
const CUMULATIVE_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "sessionTokens",
  "costUsd",
  "durationMs",
  "apiDurationMs",
] as const;

const CUMULATIVE_USAGE_SOURCES = new Set<NativeAgentContextUsage["source"]>([
  "claude",
  "opencode",
  "codex",
]);

function isCumulativeUsageSource(source: NativeAgentContextUsage["source"]): boolean {
  return source !== undefined && CUMULATIVE_USAGE_SOURCES.has(source);
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}

export function mergeContextUsageTurns(
  previous: NativeAgentContextUsage | undefined,
  current: NativeAgentContextUsage | undefined,
): NativeAgentContextUsage | undefined {
  if (!current) return previous;
  const turns = new Map((previous?.turns ?? []).map((turn) => [turn.turnId, turn]));
  for (const turn of current.turns ?? []) {
    turns.delete(turn.turnId);
    turns.set(turn.turnId, turn);
  }
  const mergedTurns = [...turns.values()].slice(-20);
  const merged: NativeAgentContextUsage = {
    ...current,
    ...(mergedTurns.length > 0 ? { turns: mergedTurns } : {}),
  };
  if (!previous) return merged;
  // Lifetime spend can only grow for providers whose top-level counters are
  // cumulative. A later OpenCode or Claude snapshot that only sees the live
  // transcript tail would otherwise walk session/cache/cost backwards.
  // ACP-backed cursor, grok, and pi publish those same fields as the current
  // turn, so clamping them would freeze the panel on the largest turn ever
  // seen. Context occupancy (`usedTokens`) is always left on `current` so
  // compaction can shrink the gauge.
  if (isCumulativeUsageSource(current.source)) {
    for (const key of CUMULATIVE_USAGE_KEYS) {
      const value = maxDefined(previous[key], current[key]);
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * Provider-owned mid-turn items are already accepted. Keep those first and
 * consume at most one backend-queue counterpart for each, so a Pi follow-up
 * does not appear twice after both layers observed it. Distinct backend rows
 * stay distinct even when they share text.
 */
export function mergeNativeAgentQueueItems(
  providerItems: readonly unknown[],
  backendItems: readonly unknown[],
): unknown[] {
  const fields = (item: unknown) => {
    const record =
      item && typeof item === "object" ? (item as { text?: unknown; id?: unknown }) : {};
    return {
      text: typeof record.text === "string" ? record.text.trim() : "",
      id: typeof record.id === "string" ? record.id.trim() : "",
    };
  };
  const remaining = [...backendItems];
  const consumeCounterpart = (item: unknown) => {
    const { text, id } = fields(item);
    const index = remaining.findIndex((candidate) => {
      const other = fields(candidate);
      return (id !== "" && other.id === id) || (text !== "" && other.text === text);
    });
    if (index >= 0) remaining.splice(index, 1);
  };
  const merged: unknown[] = [];
  for (const item of providerItems) {
    merged.push(item);
    consumeCounterpart(item);
  }
  merged.push(...remaining);
  return merged;
}

/**
 * Fill the context-window denominator a provider omitted.
 *
 * Several providers report occupancy (`usedTokens`) without the model's context
 * size, which leaves the panel unable to show used-versus-total or a
 * percentage. The selected model knows the window, so the projection supplies
 * it and derives the percentage. An explicitly reported maximum or percentage
 * always wins; this only fills what the provider left absent.
 *
 * `fallback` is the previously projected usage for the same session. A
 * progressive state read carries no model list, so on a cold catalogue it
 * cannot resolve the selected model's window; without the fallback it would
 * replace the filled gauge from the last full projection with a bare total.
 * A resolved window still takes precedence, so a model change is not masked
 * when the catalogue actually knows the new model.
 */
export function withProviderContextWindow(
  usage: NativeAgentContextUsage | undefined,
  contextWindow: number | undefined,
  fallback?: NativeAgentContextUsage,
): NativeAgentContextUsage | undefined {
  if (!usage) return usage;
  const maximumTokens =
    usage.maximumTokens ??
    (contextWindow !== undefined && contextWindow > 0 ? contextWindow : undefined) ??
    fallback?.maximumTokens;
  return {
    ...usage,
    ...(usage.maximumTokens === undefined && maximumTokens !== undefined ? { maximumTokens } : {}),
    // A non-positive denominator is not a usable window: dividing by it would
    // report a bogus 100%. Keep whatever the provider reported and omit the
    // percentage, matching the truthiness check this replaced.
    ...(usage.percentage === undefined && maximumTokens !== undefined && maximumTokens > 0
      ? {
          percentage: Math.max(0, Math.min(100, (usage.usedTokens / maximumTokens) * 100)),
        }
      : {}),
  };
}

/**
 * Preserve only the opaque launch id before the full result moves behind a
 * detail reference.
 *
 * This is the renderer's only chance to see the text: `projectionPart` strips
 * `toolOutput` from every part it sends. The recovery rule itself lives in
 * `@orkestrator/protocol` so both sides of the boundary agree on which rows
 * own a task — a command backgrounded with Ctrl+B or by a foreground timeout
 * carries no `run_in_background` argument, and would otherwise be invisible.
 */
function backgroundTaskIdFromProjectedLaunch(part: Record<string, unknown>): string | undefined {
  if (part.type !== "tool-invocation") return undefined;
  return recoverBackgroundTaskLaunchId(part);
}

/**
 * Fold `progress` parts onto the tool rows they describe.
 *
 * A provider reports progress as its own event, so an adapter can only emit it
 * as a loose part; but a progress line beside a tool row rather than on it
 * reads as a second thing happening. Matching by `toolUseId` here means the
 * renderer receives a tool row with a `progress` field and needs no notion of
 * a progress part at all.
 *
 * Only the newest report per call survives — progress is a hint over the
 * authoritative `toolState`, so a backlog of superseded lines is noise. A
 * progress part naming a call this message does not contain is dropped rather
 * than kept as an orphan row: it belongs to a tool the transcript no longer
 * holds, and there is nothing for a reader to relate it to.
 */
export function attachProgressToToolRows(parts: unknown[]): unknown[] {
  const progressByToolUseId = new Map<string, Record<string, unknown>>();
  for (const candidate of parts) {
    const part = progressRecord(candidate);
    if (part?.type !== "progress") continue;
    const toolUseId = part.toolUseId;
    if (typeof toolUseId !== "string" || !toolUseId) continue;
    progressByToolUseId.set(toolUseId, {
      content: typeof part.content === "string" ? part.content : "",
      ...(typeof part.elapsedMs === "number" &&
      Number.isFinite(part.elapsedMs) &&
      part.elapsedMs >= 0
        ? { elapsedMs: part.elapsedMs }
        : {}),
      ...(typeof part.createdAt === "string" ? { createdAt: part.createdAt } : {}),
    });
  }
  // Nothing to fold *and* nothing to drop: return the same array so the common
  // case allocates nothing.
  const hasProgressPart = parts.some((candidate) => progressRecord(candidate)?.type === "progress");
  if (!hasProgressPart) return parts;
  return parts.flatMap((candidate) => {
    const part = progressRecord(candidate);
    if (part?.type === "progress") return [];
    const toolUseId = part?.toolUseId;
    if (typeof toolUseId !== "string") return [candidate];
    const progress = progressByToolUseId.get(toolUseId);
    return progress ? [{ ...part, progress }] : [candidate];
  });
}

function progressRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A session's own report of what it can raise, bounded and validated.
 *
 * Absent means "not reported", which leaves the platform table standing.
 * Present-and-empty is a real answer — "this session never asks" — and is the
 * whole reason the two are distinguished.
 */
function normalizeInteractionKinds(value: unknown): AgentInteractionKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kinds = value.filter((kind): kind is AgentInteractionKind =>
    (AGENT_INTERACTION_KINDS as readonly string[]).includes(kind as string),
  );
  return [...new Set(kinds)];
}

function isNormalizedProgressiveMessage(value: unknown): value is {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: unknown[];
  createdAt: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  const role = message.role;
  return (
    typeof message.id === "string" &&
    (role === "user" || role === "assistant" || role === "system") &&
    typeof message.content === "string" &&
    Array.isArray(message.parts) &&
    typeof message.createdAt === "string"
  );
}

function normalizedProgressiveMessages(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || !value.every(isNormalizedProgressiveMessage)) return null;
  return value;
}

function coordinatorDisplayMessage<T>(raw: T): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const message = raw as Record<string, unknown>;
  if (message.role !== "user") return raw;
  const projected: Record<string, unknown> = { ...message };
  if (typeof message.content === "string") {
    projected.content = stripCoordinatorContext(message.content);
  }
  if (Array.isArray(message.parts)) {
    let stripped = false;
    projected.parts = message.parts.map((rawPart) => {
      if (stripped || !rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
        return rawPart;
      }
      const part = rawPart as Record<string, unknown>;
      if (part.type !== "text" || typeof part.content !== "string") return rawPart;
      const content = stripCoordinatorContext(part.content);
      if (content === part.content) return rawPart;
      stripped = true;
      return { ...part, content };
    });
  }
  return projected as T;
}

function progressiveHydrationToken(snapshot: ProviderTranscriptSnapshot): string {
  if (snapshot.sourceToken) return snapshot.sourceToken;
  const first = snapshot.messages[0] as { id?: unknown } | undefined;
  const last = snapshot.messages.at(-1) as { id?: unknown } | undefined;
  return [
    snapshot.revision ?? "",
    snapshot.complete === false ? "0" : "1",
    snapshot.messages.length,
    typeof first?.id === "string" ? first.id : "",
    typeof last?.id === "string" ? last.id : "",
  ].join(":");
}

const PROGRESSIVE_HYDRATION_MAX_ATTEMPTS = 3;
const PROGRESSIVE_HYDRATION_RETRY_BASE_MS = 25;
/** One row of a direct history page: a bridge's oversized-row ceiling plus projection slack. */
const DIRECT_PAGE_ROW_MAX_BYTES =
  Math.max(NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES, BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES) + 64 * 1024;

type PromptPresentationKind = NonNullable<
  PersistedNativeAgentSession["initialPromptPresentation"]
>["kind"];

/** A provider transcript row after `projectionMessages` validated its shape. */
type ProviderTranscriptRow = Record<string, unknown> & {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: unknown[];
  createdAt: string;
};

interface ProjectedTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: unknown[];
  createdAt: string;
  modelId?: string;
  turnId?: string;
  planReview?: boolean;
  promptPresentation?: PromptPresentationKind;
}

type ProgressiveTranscriptEntry = {
  token: string;
  sourceToken?: string;
  value: NativeAgentTranscriptView;
  bytes: number;
  historyStartIndex?: number;
  historyEndIndex?: number;
  ledgerRevision?: number;
  ledgerRevisedIds?: readonly string[];
};

type ProgressiveHydrationEntry = {
  sourceToken: string;
  snapshot?: ProviderTranscriptSnapshot;
  promise?: Promise<void>;
  attempts: number;
  holdPreview: boolean;
};

// ---- module code from native-agent-service-prompt.ts ----
type MailInjectDispatchOutcome = shared.MailInjectDispatchOutcome;

// ---- module code from native-agent-service-reconciliation.ts ----

// ---- module code from native-agent-service-provider.ts ----

export class NativeAgentService {
  // ---- from native-agent-service-base.ts ----
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
    this.displayTailScheduler = new NativeAgentDisplayTailScheduler({
      write: (key, tail, fence) => this.storage.putNativeAgentDisplayTail(key, tail, { fence }),
      // Optional because narrow test doubles of the storage omit them.
      captureFence: () =>
        typeof this.storage.captureNativeAgentDisplayTailFence === "function"
          ? this.storage.captureNativeAgentDisplayTailFence()
          : 0,
      subscribeDeletions: (listener) =>
        typeof this.storage.onNativeAgentDisplayTailDeleted === "function"
          ? this.storage.onNativeAgentDisplayTailDeleted(listener)
          : () => undefined,
    });
    this.projectedMessages = new ProjectedMessageCache({
      maxEntries: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRIES,
      maxBytes: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_BYTES,
      maxSessionEntries: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_ENTRIES,
      maxSessionBytes: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_SESSION_BYTES,
      maxEntryBytes: NATIVE_PROJECTED_MESSAGE_CACHE_MAX_ENTRY_BYTES,
      ...options.projectedMessageCacheLimits,
    });
    this.directHistoryPages = new DirectHistoryPageCache({
      maxEntries: NATIVE_DIRECT_PAGE_CACHE_MAX_ENTRIES,
      maxBytes: NATIVE_DIRECT_PAGE_CACHE_MAX_BYTES,
      maxSessionEntries: NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_ENTRIES,
      maxSessionBytes: NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_BYTES,
      ttlMs: NATIVE_DIRECT_PAGE_CACHE_TTL_MS,
      ...options.directHistoryPageCacheLimits,
    });
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

  // ---- from native-agent-service-dispatch.ts ----
  protected async dispatchIntentInternal(
    input: DispatchNativeAgentPromptInput,
    preserveExistingPending: boolean,
  ): Promise<NativeAgentDispatchOutcome> {
    return this.withSessionMutationIntent(input, () =>
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
  protected async attemptDispatch(
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
      void this.refreshProjection(input, true).catch(() => undefined);
      return { outcome: "accepted", requestId: input.requestId };
    } catch (error) {
      if (error instanceof PendingNativeAgentDispatchError) {
        // The only thing refusing this prompt is an older dispatch nobody has
        // resolved. If the provider can prove that one landed, the block was
        // stale and this prompt was never in conflict with anything.
        if (
          allowRecoveryRetry &&
          (await this.settleAmbiguousDispatch(input, key, error.pendingRequestId))
        ) {
          return this.attemptDispatch(input, false, preserveExistingPending);
        }
        void this.refreshProjection(input, true).catch(() => undefined);
        return { outcome: "rejected", error: PARKED_DISPATCH_CONFLICT_MESSAGE };
      }
      if (error instanceof PendingNativeAgentSteerError) {
        if (
          allowRecoveryRetry &&
          (await this.settleAmbiguousSteer(input, key, error.pendingRequestId))
        ) {
          return this.attemptDispatch(input, false, preserveExistingPending);
        }
        void this.refreshProjection(input, true).catch(() => undefined);
        return { outcome: "rejected", error: PARKED_DISPATCH_CONFLICT_MESSAGE };
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        // Ask the provider before handing the ambiguity to the user. A lost
        // acknowledgement is not the same fact as a lost prompt, and the
        // provider's own dispatch journal can usually tell the two apart.
        if (await this.settleAmbiguousDispatch(input, key, input.requestId)) {
          void this.refreshProjection(input, true).catch(() => undefined);
          return { outcome: "accepted", requestId: input.requestId };
        }
        void this.refreshProjection(input, true).catch(() => undefined);
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
      if (retired) void this.refreshProjection(input, true).catch(() => undefined);
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
      void this.refreshProjection(input, true).catch(() => undefined);
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
   * record, and only on an explicit `dispatched`. Providers with no journal to
   * ask, an unreachable bridge, and any failure at all leave the record exactly
   * where it was, because "I could not find out" must never read as "it ran".
   */
  protected async settleAmbiguousDispatch(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved?: NativeAgentRuntimeProvider,
  ): Promise<boolean> {
    try {
      // Cheapest question first. Projection reads drive this on every refresh,
      // and a provider with no journal to ask must not cost a storage read each
      // time to establish that it still has nothing to say.
      const provider = resolved ?? (await this.provider(input));
      if (!provider.dispatchStatus) return false;
      // Re-read rather than trusting the caller's snapshot: a real
      // acknowledgement may have landed since, and confirming against a stale
      // record would resurrect a request id that is no longer parked.
      const session = await this.storage.getNativeAgentSession(key);
      if (session?.pendingDispatch?.requestId !== requestId) return false;
      const status = await provider.dispatchStatus(session.providerSessionId, requestId);
      if (status !== "dispatched") return false;
      return await this.storage.confirmNativeAgentDispatch(key, requestId);
    } catch {
      return false;
    }
  }

  /**
   * Settle a parked dispatch in the background, at most once at a time per
   * session.
   *
   * Driven from projection reads so a record that outlived the dispatch that
   * created it — a backend restart mid-flight, a bridge that came back after
   * the tab was closed — is resolved by the next refresh rather than waiting
   * for the user. Never awaited by the projection: an authoritative snapshot
   * must not be delayed by, or fail because of, an optional reconciliation.
   */
  protected scheduleAmbiguousDispatchSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved: NativeAgentRuntimeProvider,
  ): void {
    const inFlight = `${key}\0${requestId}`;
    if (this.settlingDispatches.has(inFlight)) return;
    this.settlingDispatches.add(inFlight);
    void this.trackScan(
      this.settleAmbiguousDispatch(input, key, requestId, resolved)
        .then((settled) => {
          if (settled) void this.refreshProjection(input, true).catch(() => undefined);
        })
        .catch(() => undefined)
        .finally(() => this.settlingDispatches.delete(inFlight)),
    ).catch(() => undefined);
  }

  protected async settleAmbiguousSteer(
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

  protected scheduleAmbiguousSteerSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved: NativeAgentRuntimeProvider,
  ): void {
    const inFlight = `steer\0${key}\0${requestId}`;
    if (this.settlingDispatches.has(inFlight)) return;
    this.settlingDispatches.add(inFlight);
    void this.trackScan(
      this.settleAmbiguousSteer(input, key, requestId, resolved)
        .then((settled) => {
          if (settled) void this.refreshProjection(input, true).catch(() => undefined);
        })
        .catch(() => undefined)
        .finally(() => this.settlingDispatches.delete(inFlight)),
    ).catch(() => undefined);
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
        this.invalidateProjection(key);
        return { outcome: "accepted", requestId: input.requestId };
      }
      if (
        settlement === "absent" ||
        !(await this.storage.getNativeAgentSession(key))?.pendingSteer
      ) {
        this.invalidateProjection(key);
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
      this.invalidateProjection(key);
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
    return this.withSessionMutationIntent(input, () => this.stopProjectionSessionWithIntent(input));
  }

  private async stopProjectionSessionWithIntent(
    input: NativeAgentProjectionInput,
  ): Promise<NativeAgentSessionProjection | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const providerSessionId = resolved.session.providerSessionId;
    // Mark the active turn before stopping it: a stopped turn reads as idle,
    // and an observer must never mistake it for one that finished on its own.
    const requestId = resolved.session.dispatchedRequestIds?.at(-1);
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
        const interruptKey = `${resolved.key}\0${requestId}`;
        if (this.pendingTurnInterrupts.size < 256 || this.pendingTurnInterrupts.has(interruptKey)) {
          this.pendingTurnInterrupts.set(interruptKey, { providerSessionId, requestId });
        } else {
          // Never evict an unpersisted Stop to make room for another one.
          this.interruptFenceOverflow = true;
        }
        try {
          await this.storage.recordNativeAgentTurnInterrupt(
            resolved.key,
            providerSessionId,
            requestId,
          );
          this.pendingTurnInterrupts.delete(interruptKey);
        } catch {
          console.warn(
            "[native-agent] Turn interrupt persistence failed; automatic publication remains fenced",
          );
        }
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
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    this.stopNotices.set(
      sessionKey,
      stoppedGracefully
        ? "The turn stopped after a graceful interrupt."
        : hardAbortAttempted
          ? "The turn did not stop within the grace period and a force-stop was requested."
          : "The turn did not stop within the grace period; this provider has no force-stop action.",
    );
    while (this.stopNotices.size > 256) {
      const oldest = this.stopNotices.keys().next().value as string | undefined;
      if (oldest) this.stopNotices.delete(oldest);
      else break;
    }
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
    await resolved.provider.stopBackgroundTask(resolved.session.providerSessionId, input.taskId);
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
    await resolved.provider.dismissSuggestedPrompt(resolved.session.providerSessionId);
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
    this.invalidateProjection(key);
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
    return this.refreshProjection(input, true).finally(() => closingReplaced);
  }

  /**
   * Close the session a resume replaced, which the tab no longer shows. A new
   * tab is given an empty session before its resume picker opens, so without
   * this every resume leaves one behind; for Grok, an agent process holding
   * an `ACP_MAX_SESSIONS` slot that nothing reaps. Same last-owner rules and
   * lock as tab teardown. The close keeps the vendor conversation.
   *
   * Best effort and never throws: the resume already succeeded. A bridge that
   * cannot be reached has usually lost the session with its process; a close
   * that stays pending leaves it registered (no durable retry yet).
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
          await provider.closeSession(providerSessionId);
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
    this.invalidateProjection(resolved.key);
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
    this.invalidateProjection(resolved.key);
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
    this.invalidateProjection(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
    );
    return outcome;
  }

  async signOutProjectionProvider(input: NativeAgentProjectionInput): Promise<void> {
    const provider = await this.provider(input);
    if (!provider.signOut) throw new Error(`${input.agent} does not support sign-out here`);
    await provider.signOut();
    this.invalidateProjection(
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
    this.invalidateProjection(resolved.key);
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
      this.scheduleAmbiguousSteerSettle(
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
    this.invalidateProjection(resolved.key);
    return outcome;
  }

  protected async dispatchQueuedAsyncQuestionAnswer(
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
      return await this.withSessionMutationFence(
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
    const current = await this.refreshProjection(input, true);
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
    if (resolved.provider.updateInteractiveControls) {
      await resolved.provider.updateInteractiveControls(
        resolved.session.providerSessionId,
        // Leaving plan mode returns a live Claude session to the session's
        // approval mode, which this update may not restate.
        input.update.mode === "build" && input.update.approvalMode === undefined
          ? { ...input.update, approvalMode: composer?.selectedApprovalModeId }
          : input.update,
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
    // Observers must re-read instead of reporting an answered question as pending.
    this.forgetPendingInteractions(resolved.key);
    void this.refreshProjection(input, true).catch(() => undefined);
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
    this.forgetPendingInteractions(resolved.key);
    void this.refreshProjection(input, true).catch(() => undefined);
    return outcome;
  }

  protected assertProjectionInput(input: NativeAgentProjectionInput): void {
    this.assertAcceptingWork();
    if (
      !nonBlank(input.environmentId) ||
      !nonBlank(input.logicalSessionKey) ||
      !BUILD_PIPELINE_AGENTS.includes(input.agent)
    ) {
      throw new Error("Invalid native agent projection request");
    }
  }

  protected async resolveProjectionSession(input: NativeAgentProjectionInput) {
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

  // ---- from native-agent-service-projection.ts ----
  private readonly progressiveInstanceId = randomUUID();
  private readonly progressiveTranscriptCache = new Map<string, ProgressiveTranscriptEntry>();
  private progressiveTranscriptBytes = 0;
  private readonly progressiveSourceTokens = new Map<string, string>();
  private readonly progressiveStateCache = new Map<
    string,
    { token: string; value: NativeAgentSessionStateView }
  >();
  private readonly progressiveReads = new Map<string, Promise<unknown>>();
  private readonly progressiveReadWaiters = new Map<string, number>();
  private progressiveReadWaiterCount = 0;
  private readonly progressiveDiscoveryJobsByProvider = new Map<string, number>();
  private readonly progressiveDiscoveryCache = new Map<
    string,
    {
      value: unknown;
      revision: number;
      expiresAt: number;
      bytes: number;
      availability: "ready" | "stale" | "unavailable";
      error?: string;
    }
  >();
  private progressiveDiscoveryBytes = 0;
  private readonly progressiveReadEpochs = new Map<string, number>();
  private readonly progressiveDirtyFollowUps = new Map<string, number>();
  private readonly progressiveTrailing = new Map<string, Promise<unknown>>();
  private readonly interactiveSnapshotShares = new Map<
    string,
    {
      promise: Promise<ProviderInteractiveSnapshot>;
      sessionKey: string;
      epoch: number;
      degraded: true;
    }
  >();
  /** Bounded restart-preview checkpoints; see native-agent-display-tail-scheduler.ts. */
  private readonly displayTailScheduler: NativeAgentDisplayTailScheduler;
  private readonly progressiveHydrations = new Map<string, ProgressiveHydrationEntry>();
  private readonly progressiveHydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progressiveMetrics = new ProgressiveReadMetrics();
  /** In-flight provider reads of remote tool details, one per reference. */
  private readonly remoteToolDetailReads = new Map<string, Promise<NativeAgentToolDetails>>();
  /** Projected rows reused while their provider rows are unchanged (step 12). */
  private readonly projectedMessages: ProjectedMessageCache;
  /** Immutable direct history pages of each session's current epoch (step 11). */
  private readonly directHistoryPages: DirectHistoryPageCache<{
    page: NativeAgentMessagePage;
    details: readonly ProjectionDetailRegistration[];
  }>;
  /** Per-conversation publication ledger reads, keyed by ledger revision. */
  private readonly artifactOverlays = new ArtifactOverlayIndex(
    () => this.options.artifactLedger?.() ?? null,
  );
  /**
   * Collects the detail references registered while one row (or one page) is
   * projected, so a reuse can re-register them without the bodies. Projection
   * is synchronous, so a single slot cannot interleave between reads.
   */
  private detailRegistrations: ProjectionDetailRegistration[] | undefined;

  /**
   * Whether a parked dispatch is still reconciling or has become a final
   * failure.
   *
   * Only a prompt gets the grace window: it is the kind whose acknowledgement
   * the provider's own journal can positively confirm on a later projection
   * read. A steer is reported as a choice immediately, because its best-effort
   * settle needs a provider that answers the steer dispatch journal, and a
   * provider that never does would otherwise leave the user locked behind a
   * spinner for the whole window.
   *
   * An unparseable or future-dated timestamp is treated as final: a decision
   * the user can make beats a record that can never leave the reconciling
   * state. A timestamp ahead of the service clock (a backward clock adjustment
   * between write and read) would otherwise keep the elapsed time negative for
   * as long as the skew lasts.
   */
  protected recoverableDispatchStatus(
    createdAt: string,
    kind: "prompt" | "steer" = "prompt",
  ): "reconciling" | "action-required" {
    if (kind === "steer") return "action-required";
    const created = Date.parse(createdAt);
    const now = this.now();
    if (!Number.isFinite(created) || created > now) return "action-required";
    return now - created >= shared.PARKED_DISPATCH_RECONCILE_GRACE_MS
      ? "action-required"
      : "reconciling";
  }

  protected async settleAndClearProgressiveReads(): Promise<void> {
    // Stop accepting checkpoints and drain the newest pending previews within
    // a bounded deadline, concurrently with settling the reads below. A
    // skipped preview only costs restart latency; the provider stays
    // authoritative, so shutdown never waits on it indefinitely.
    const displayTailDrain = this.displayTailScheduler
      .shutdown()
      .catch(() => ({ attempted: 0, written: 0, skipped: 0 }));
    for (const timer of this.progressiveHydrationTimers.values()) clearTimeout(timer);
    this.progressiveHydrationTimers.clear();
    await Promise.allSettled(this.progressiveReads.values());
    await Promise.allSettled(this.progressiveTrailing.values());
    await Promise.allSettled(
      Array.from(this.progressiveHydrations.values(), (entry) => entry.promise).filter(
        (promise): promise is Promise<void> => promise !== undefined,
      ),
    );
    this.progressiveHydrations.clear();
    this.progressiveReads.clear();
    this.progressiveTranscriptCache.clear();
    this.progressiveSourceTokens.clear();
    this.progressiveTranscriptBytes = 0;
    this.progressiveStateCache.clear();
    this.progressiveReadWaiters.clear();
    this.progressiveReadWaiterCount = 0;
    this.progressiveDiscoveryJobsByProvider.clear();
    this.progressiveDiscoveryCache.clear();
    this.progressiveDiscoveryBytes = 0;
    this.progressiveReadEpochs.clear();
    this.progressiveDirtyFollowUps.clear();
    this.progressiveTrailing.clear();
    this.interactiveSnapshotShares.clear();
    this.progressiveMetrics.clear();
    this.projectedMessages.clear();
    this.directHistoryPages.clear();
    this.artifactOverlays.clear();
    const drained = await displayTailDrain;
    if (drained.skipped > 0) {
      // Aggregate count only: previews carry transcript content.
      console.warn(
        `[NativeAgentService] Shutdown skipped ${drained.skipped} pending display-tail checkpoint(s); provider history remains authoritative`,
      );
    }
  }
  protected async recordAsyncQuestionAttention(
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

  protected cacheToolDetails(
    sessionKey: string,
    messageId: string,
    partPath: string,
    details: Omit<NativeAgentToolDetails, "detailRef">,
    /**
     * Per-entry ceiling. Defaults to the tool-output cap; a deferred image
     * raises it because one attachment legitimately outweighs a tool result.
     */
    options: {
      maximumBytes?: number;
      /** Exact path observed in a trusted provider transcript. */
      localImagePath?: string;
    } = {},
  ): string {
    const serializedDetails = JSON.stringify(details);
    const detailRef = createHash("sha256")
      .update(
        `${sessionKey}\0${messageId}\0${partPath}\0${serializedDetails}\0${options.localImagePath ?? ""}`,
      )
      .digest("hex")
      .slice(0, 32);
    let stored: NativeAgentToolDetails = { detailRef, ...details };
    let bytes =
      Buffer.byteLength(serializedDetails) +
      Buffer.byteLength(options.localImagePath ?? "") +
      detailRef.length +
      32;
    let storedLocalImagePath = options.localImagePath;
    if (bytes > (options.maximumBytes ?? NATIVE_TOOL_DETAIL_MAX_BYTES)) {
      stored = {
        detailRef,
        toolError: "Tool details exceeded the deferred display limit.",
      };
      storedLocalImagePath = undefined;
      bytes = Buffer.byteLength(JSON.stringify(stored));
    }

    const previous = this.toolDetailCache.get(detailRef);
    if (previous) this.toolDetailCacheBytes -= previous.bytes;
    this.toolDetailCache.delete(detailRef);
    this.toolDetailCache.set(detailRef, {
      sessionKey,
      details: stored,
      bytes,
      ...(storedLocalImagePath ? { localImagePath: storedLocalImagePath } : {}),
    });
    this.toolDetailCacheBytes += bytes;
    this.pruneToolDetailCache();
    this.detailRegistrations?.push({ ref: detailRef });
    return detailRef;
  }

  /**
   * Register a provider-held detail behind a summary locator. Nothing is read
   * until the row is expanded; the reference is stable for as long as the
   * locator is, and the locator changes whenever the body does.
   */
  protected cacheRemoteToolDetails(
    sessionKey: string,
    messageId: string,
    partPath: string,
    remote: { providerSessionId: string; locator: string },
  ): string {
    const detailRef = createHash("sha256")
      .update(`remote\0${sessionKey}\0${messageId}\0${partPath}\0${remote.locator}`)
      .digest("hex")
      .slice(0, 32);
    this.detailRegistrations?.push({
      ref: detailRef,
      remote: {
        messageId,
        partPath,
        providerSessionId: remote.providerSessionId,
        locator: remote.locator,
      },
    });
    const previous = this.toolDetailCache.get(detailRef);
    if (previous) {
      // Keep an already-fetched body; just refresh its recency.
      this.toolDetailCache.delete(detailRef);
      this.toolDetailCache.set(detailRef, previous);
      return detailRef;
    }
    const bytes = remote.locator.length + remote.providerSessionId.length + detailRef.length + 64;
    this.toolDetailCache.set(detailRef, {
      sessionKey,
      details: { detailRef },
      bytes,
      remote: { ...remote, resolved: false },
    });
    this.toolDetailCacheBytes += bytes;
    this.pruneToolDetailCache();
    return detailRef;
  }

  /**
   * Re-register the detail references a reused row or page carries, as its
   * projection would have: refresh each entry's recency, and register a
   * provider-held one again if it was evicted. False when an inline body was
   * evicted — only a fresh projection of the row can restore it.
   */
  private restoreDetailRegistrations(
    sessionKey: string,
    registrations: readonly ProjectionDetailRegistration[],
  ): boolean {
    const sink = this.detailRegistrations;
    this.detailRegistrations = undefined;
    try {
      for (const registration of registrations) {
        const entry = this.toolDetailCache.get(registration.ref);
        if (entry && entry.sessionKey === sessionKey) {
          this.toolDetailCache.delete(registration.ref);
          this.toolDetailCache.set(registration.ref, entry);
          continue;
        }
        if (!registration.remote) return false;
        this.cacheRemoteToolDetails(
          sessionKey,
          registration.remote.messageId,
          registration.remote.partPath,
          {
            providerSessionId: registration.remote.providerSessionId,
            locator: registration.remote.locator,
          },
        );
      }
    } finally {
      this.detailRegistrations = sink;
    }
    sink?.push(...registrations);
    return true;
  }

  protected pruneToolDetailCache(): void {
    while (
      this.toolDetailCache.size >
        (this.options.toolDetailCacheMaxEntries ?? NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES) ||
      this.toolDetailCacheBytes >
        (this.options.toolDetailCacheMaxBytes ?? NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES)
    ) {
      const oldest = [...this.toolDetailCache.keys()].find(
        (candidate) => !this.pinnedToolDetailRefs.has(candidate),
      );
      if (!oldest) break;
      const entry = this.toolDetailCache.get(oldest);
      if (entry) this.toolDetailCacheBytes -= entry.bytes;
      this.toolDetailCache.delete(oldest);
    }
  }

  protected projectionPart(
    sessionKey: string,
    messageId: string,
    raw: unknown,
    partPath: string,
    /** Set when `raw` is a provider summary whose details resolve remotely. */
    remote?: { providerSessionId: string },
  ): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const part = raw as Record<string, unknown>;
    const projected: Record<string, unknown> = { ...part };
    // A summary locator is provider-internal: it becomes a session-scoped
    // backend reference here and never reaches a renderer.
    delete projected.detail;
    const redactedArgs = redactArtifactGrant(part);
    if (redactedArgs) projected.toolArgs = redactedArgs;
    const summaryDetail = remote ? bridgePartDetail(part.detail) : undefined;
    if (summaryDetail && remote) {
      projected.detailRef = this.cacheRemoteToolDetails(sessionKey, messageId, partPath, {
        providerSessionId: remote.providerSessionId,
        locator: summaryDetail.locator,
      });
    }
    const deferredImagePath = providerReportedImagePath(part);
    const backgroundTaskId = backgroundTaskIdFromProjectedLaunch(part);
    if (backgroundTaskId) projected.backgroundTaskId = backgroundTaskId;

    /*
     * A file/image part can name its bytes three ways: a readable workspace
     * path, an inline data URL, or a remote URL. The live window must never be
     * dominated by inline bytes, because a single pasted screenshot is larger
     * than the whole 512 KiB target and would evict every other message.
     *
     * - A readable path is the durable reference: the renderer re-reads the
     *   file, so the inline copy is pure duplication.
     * - With no path (OpenCode persists a pasted attachment as a bare filename
     *   plus a data URL) the bytes only exist inline. Move them behind a detail
     *   reference the renderer fetches on demand, provided they still fit the
     *   detail cache; an oversized image keeps its inline copy rather than
     *   losing its preview entirely.
     * - Remote URLs are already a reference and stay put.
     */
    const fileUrlDisposition = inlineFileUrlDisposition(part);
    if (fileUrlDisposition === "drop") {
      delete projected.fileUrl;
    } else if (fileUrlDisposition === "defer") {
      delete projected.fileUrl;
      projected.detailRef = this.cacheToolDetails(
        sessionKey,
        messageId,
        partPath,
        { fileDataUrl: part.fileUrl as string },
        { maximumBytes: NATIVE_FILE_DETAIL_MAX_BYTES },
      );
    }
    /*
     * OpenCode falls back to the part's `url` for `content` when it has no
     * filename, so a data-URL attachment arrives with its bytes duplicated in
     * both `content` and `fileUrl`. Moving `fileUrl` behind a reference is not
     * enough: the live copy would still carry the whole payload and the
     * renderer's display name would be a multi-megabyte string. Substitute a
     * short label whenever `content` is itself the data URL.
     */
    const contentLabel = inlineFileContentLabel(part);
    if (contentLabel !== undefined) projected.content = contentLabel;

    const rawDiff =
      part.toolDiff && typeof part.toolDiff === "object" && !Array.isArray(part.toolDiff)
        ? (part.toolDiff as Record<string, unknown>)
        : undefined;
    const hasHeavyDiff = Boolean(
      rawDiff &&
      (typeof rawDiff.diff === "string" ||
        typeof rawDiff.before === "string" ||
        typeof rawDiff.after === "string"),
    );
    if (typeof part.toolOutput === "string" || typeof part.toolError === "string" || hasHeavyDiff) {
      projected.detailRef = this.cacheToolDetails(sessionKey, messageId, partPath, {
        ...(typeof part.toolOutput === "string" ? { toolOutput: part.toolOutput } : {}),
        ...(typeof part.toolError === "string" ? { toolError: part.toolError } : {}),
        ...(rawDiff ? { toolDiff: rawDiff } : {}),
      });
      delete projected.toolOutput;
      delete projected.toolError;
      if (rawDiff) {
        // Older clients read these counts: give them backend CountPolicyV1
        // numbers (or none), never the bridges' whole-side totals.
        const counts = hasHeavyDiff
          ? legacyCompatibilityCounts(projected.detailRef as string, {
              toolName: typeof part.toolName === "string" ? part.toolName : undefined,
              filePath: typeof rawDiff.filePath === "string" ? rawDiff.filePath : undefined,
              before: typeof rawDiff.before === "string" ? rawDiff.before : undefined,
              after: typeof rawDiff.after === "string" ? rawDiff.after : undefined,
              diff: typeof rawDiff.diff === "string" ? rawDiff.diff : undefined,
              additions: typeof rawDiff.additions === "number" ? rawDiff.additions : undefined,
              deletions: typeof rawDiff.deletions === "number" ? rawDiff.deletions : undefined,
            })
          : {
              ...(typeof rawDiff.additions === "number" ? { additions: rawDiff.additions } : {}),
              ...(typeof rawDiff.deletions === "number" ? { deletions: rawDiff.deletions } : {}),
            };
        projected.toolDiff = {
          ...(typeof rawDiff.filePath === "string" ? { filePath: rawDiff.filePath } : {}),
          ...counts,
          // Without this the renderer cannot tell a stripped diff from a
          // location-only hint, and every provider that identifies a file
          // mutation by diff content rather than tool name loses its edit
          // treatment until the row is expanded.
          ...(hasHeavyDiff ? { deferred: true } : {}),
        };
      }
    }

    if (deferredImagePath) {
      const imageDetailRef = this.cacheToolDetails(
        sessionKey,
        messageId,
        `${partPath}/image`,
        {},
        { localImagePath: deferredImagePath },
      );
      if (part.type === "tool-invocation") projected.imageDetailRef = imageDetailRef;
      else if (part.type === "image") projected.detailRef = imageDetailRef;
    }

    for (const field of ["parts", "childTools", "subagentActions"] as const) {
      if (!Array.isArray(part[field])) continue;
      projected[field] = part[field].map((child, index) =>
        this.projectionPart(sessionKey, messageId, child, `${partPath}/${field}/${index}`, remote),
      );
    }
    if (part.task && typeof part.task === "object" && !Array.isArray(part.task)) {
      projected.task = this.projectionPart(
        sessionKey,
        messageId,
        part.task,
        `${partPath}/task`,
        remote,
      );
    }
    return projected;
  }

  /**
   * One validated provider row, projected — or the projection kept from an
   * earlier read of an identical row in the same context (see
   * `native-agent-projection-entries.ts`). A miss projects from a private copy
   * of the row, so the value kept for later reads shares nothing a provider
   * could mutate afterwards.
   */
  private projectedMessage(
    context: ProjectionEntryContext,
    message: ProviderTranscriptRow,
    promptPresentation: PromptPresentationKind | undefined,
    remote: { providerSessionId: string } | undefined,
  ): ProjectedTranscriptMessage {
    const cached = this.projectedMessages.lookup(context, message.id, message, promptPresentation);
    if (cached && this.restoreDetailRegistrations(context.sessionKey, cached.details)) {
      return cached.projected as ProjectedTranscriptMessage;
    }
    const source = this.projectedMessages.enabled ? copyProjectionSource(message) : undefined;
    const row = (source?.copy ?? message) as ProviderTranscriptRow;
    const sink = this.detailRegistrations;
    const details: ProjectionDetailRegistration[] = [];
    this.detailRegistrations = details;
    let projected: ProjectedTranscriptMessage;
    try {
      const projectedParts = attachProgressToToolRows(
        row.parts.map((part, index) =>
          this.projectionPart(context.sessionKey, row.id, part, String(index), remote),
        ),
      );
      const projectedMessage: ProjectedTranscriptMessage = {
        id: row.id,
        role: row.role,
        content: row.content,
        parts: projectedParts,
        createdAt: row.createdAt,
        ...(typeof row.modelId === "string" ? { modelId: row.modelId } : {}),
        ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
        ...(typeof row.planReview === "boolean" ? { planReview: row.planReview } : {}),
        ...(promptPresentation ? { promptPresentation } : {}),
      };
      projected = context.coordinator
        ? coordinatorDisplayMessage(projectedMessage)
        : projectedMessage;
    } finally {
      this.detailRegistrations = sink;
    }
    sink?.push(...details);
    if (source) {
      let encodedBytes: number | undefined;
      try {
        // Memoized: every later measurement of this row reuses it.
        encodedBytes = encodedValue(projected).bytes;
      } catch {
        // Not serializable: the window bound below reports it; keep it uncached.
      }
      if (encodedBytes !== undefined) {
        this.projectedMessages.store(context, message.id, source, promptPresentation, {
          projected,
          details,
          encodedBytes,
        });
      }
    }
    return projected;
  }

  protected projectionMessages(
    sessionKey: string,
    messages: unknown[],
    limit: number,
    maximumBytes = NATIVE_PROJECTION_MAX_BYTES,
    initialPromptPresentation?: PersistedNativeAgentSession["initialPromptPresentation"],
    coordinatorTranscript = false,
    remote?: { providerSessionId: string },
    /**
     * Publications placed beside their calls after the per-row cache. Omit
     * for a read whose projected rows are themselves cached (history pages):
     * those apply the overlay on the way out instead.
     */
    artifactOverlay?: ArtifactOverlay | null,
  ): { messages: unknown[]; window: NativeAgentMessageWindow } {
    const firstUserMessageIndex = messages.findIndex(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).role === "user",
    );
    const requestedStart = Math.max(0, messages.length - limit);
    const context: ProjectionEntryContext = {
      sessionKey,
      ...(remote ? { remoteSessionId: remote.providerSessionId } : {}),
      coordinator: coordinatorTranscript,
    };
    const projectedRows = messages.slice(requestedStart).map((raw, requestedIndex) => {
      const message =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      const role = message?.role;
      if (
        !message ||
        typeof message.id !== "string" ||
        (role !== "user" && role !== "assistant" && role !== "system") ||
        typeof message.content !== "string" ||
        !Array.isArray(message.parts) ||
        typeof message.createdAt !== "string"
      ) {
        throw new ProviderUnavailableError("Provider returned a non-normalized native transcript");
      }
      const parsedDelegation =
        requestedStart + requestedIndex === firstUserMessageIndex && initialPromptPresentation
          ? parseCoordinatorDelegatedPrompt(message.content)
          : null;
      const promptPresentation =
        initialPromptPresentation && parsedDelegation?.frame === initialPromptPresentation.frame
          ? initialPromptPresentation.kind
          : undefined;
      return this.projectedMessage(
        context,
        message as ProviderTranscriptRow,
        promptPresentation,
        remote,
      );
    });
    // Never written back into the per-row cache: an overlaid row is a new
    // object, valid only for the ledger read that produced it.
    const requested = overlayArtifactParts(projectedRows, artifactOverlay);
    let boundedTranscript;
    try {
      boundedTranscript = boundTranscriptResponse(requested, maximumBytes, {
        // The bound applies to the bare message array; the surrounding
        // projection is not what this ceiling protects.
        envelopeReserveBytes: 0,
        // Projected rows are immutable: measure them once for every consumer.
        measure: (message) => encodedValue(message).bytes,
        // A half-rendered final message is worse than an explicit failure here:
        // the renderer has a recovery path for an unavailable projection, and
        // the bridges have already bounded their own responses well below this.
        contentFallbackBytes: null,
      });
    } catch (error) {
      /*
       * The bound's only failure mode is the `JSON.stringify` it uses to
       * measure, which throws a `TypeError` on a circular structure or a
       * BigInt. The normalized provider contract is JSON, so that is a
       * transport violation rather than something to leak to a renderer.
       * Measuring separately up front just to say so would serialize the whole
       * transcript twice on every refresh.
       */
      if (!(error instanceof TypeError)) throw error;
      throw new ProviderUnavailableError("Provider returned a non-serializable native transcript");
    }
    const { messages: bounded, messageWindow, overflowed } = boundedTranscript;
    if (overflowed) {
      throw new ProviderUnavailableError(
        "Provider transcript contains one message body larger than 16 MiB",
      );
    }
    const omittedParts = messageWindow.omittedParts ?? 0;
    const truncatedByCount = messages.length > requested.length;
    const droppedByBytes = bounded.length < requested.length;
    const truncatedByBytes = droppedByBytes || omittedParts > 0;
    const omittedMessages = messages.length - bounded.length;
    const truncated = truncatedByCount || truncatedByBytes;
    return {
      messages: bounded,
      window: {
        limit,
        truncated,
        /*
         * Whether a larger `limit` can actually reveal more messages, which is
         * not the same question as whether anything was truncated. Only the
         * count slice responds to the limit: once the byte ceiling has dropped
         * whole messages, widening the slice returns the identical set, and a
         * client that read `truncated` alone put an inert control on screen.
         * Trimmed parts are not that case — every requested message is still
         * present, so the limit is still the binding constraint.
         *
         * Reported only for a truncated window, where it is the answer to a
         * question the caller is actually asking.
         */
        ...(truncated ? { canLoadEarlier: truncatedByCount && !droppedByBytes } : {}),
        ...(truncatedByBytes
          ? {
              truncationReason: "bytes" as const,
              ...(omittedMessages > 0 ? { omittedMessages } : {}),
              ...(omittedParts > 0 ? { omittedParts } : {}),
            }
          : truncatedByCount
            ? { truncationReason: "count" as const }
            : {}),
      },
    };
  }

  protected boundedProjectedMessages(
    messages: unknown[],
    limit: number,
    maximumBytes: number,
  ): { messages: unknown[]; window: NativeAgentMessageWindow } {
    let boundedTranscript;
    const requested = messages.slice(-limit) as Array<{
      content: string;
      parts: unknown[];
    }>;
    try {
      boundedTranscript = boundTranscriptResponse(requested, maximumBytes, {
        envelopeReserveBytes: 0,
        contentFallbackBytes: null,
        measure: (message) => encodedValue(message).bytes,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new ProviderUnavailableError("Provider returned a non-serializable native transcript");
    }
    // A single valid message may exceed the soft live/page target. The hard
    // transcript limit was already enforced while normalizing history.
    const omittedParts = boundedTranscript.overflowed
      ? 0
      : (boundedTranscript.messageWindow.omittedParts ?? 0);
    const messagesInWindow = boundedTranscript.overflowed
      ? requested.slice(-1)
      : boundedTranscript.messages;
    const omitted = messages.length - messagesInWindow.length;
    const truncatedByCount = messages.length > requested.length;
    const droppedByBytes = messagesInWindow.length < requested.length || omittedParts > 0;
    const truncated = omitted > 0 || omittedParts > 0;
    return {
      messages: messagesInWindow,
      window: {
        limit,
        truncated,
        ...(truncated
          ? {
              /*
               * Only a count slice responds to a larger `limit`. Part-trimming
               * and whole-message byte drops return the same set when the
               * caller asks for more, so the load-earlier control must stay
               * off — it cannot restore omitted leading parts of the live head.
               */
              canLoadEarlier: truncatedByCount && !droppedByBytes,
              truncationReason:
                truncatedByCount && !droppedByBytes ? ("count" as const) : ("bytes" as const),
              ...(omitted > 0 ? { omittedMessages: omitted } : {}),
              ...(omittedParts > 0 ? { omittedParts } : {}),
            }
          : {}),
      },
    };
  }

  private updateProjectionHistory(
    sessionKey: string,
    sessionId: string,
    messages: unknown[],
    mutableTailStart: number,
    complete: boolean,
  ): void {
    // Memoized per projected message: a history refresh re-fingerprints only
    // the messages this read actually produced anew.
    const messageFingerprints = messages.map(valueFingerprint);
    const previous = this.projectionHistory.get(sessionKey);
    // Everything before the *current* live boundary is now historical. If a
    // message changed while simultaneously aging out of the live tail, the
    // old page cache must be invalidated rather than preserving stale text.
    const stableHistoricalCount = mutableTailStart;
    const appendCompatible = Boolean(
      previous &&
      previous.sessionId === sessionId &&
      messages.length >= previous.messages.length &&
      Array.from({ length: previous.messages.length }, (_, index) => index).every((index) =>
        index < stableHistoricalCount
          ? (previous.messages[index] as { id?: unknown })?.id ===
              (messages[index] as { id?: unknown })?.id &&
            previous.messageFingerprints[index] === messageFingerprints[index]
          : (previous.messages[index] as { id?: unknown })?.id ===
            (messages[index] as { id?: unknown })?.id,
      ),
    );
    const epoch = appendCompatible ? previous!.epoch : randomUUID();
    const bytes = encodedArrayBytes(messages);
    if (previous) this.projectionHistoryBytes -= previous.bytes;
    this.projectionHistory.delete(sessionKey);
    this.projectionHistory.set(sessionKey, {
      sessionId,
      epoch,
      messages,
      messageFingerprints,
      mutableTailStart,
      complete,
      bytes,
      updatedAt: this.now(),
    });
    this.projectionHistoryBytes += bytes;
    while (this.projectionHistoryBytes > NATIVE_HISTORY_CACHE_MAX_BYTES) {
      const oldest = this.projectionHistory.keys().next().value as string | undefined;
      if (!oldest || oldest === sessionKey) break;
      const entry = this.projectionHistory.get(oldest);
      if (entry) this.projectionHistoryBytes -= entry.bytes;
      this.projectionHistory.delete(oldest);
    }
  }

  private historyCursor(
    sessionKey: string,
    beforeId: string,
    epoch: string,
    sessionId: string,
  ): string {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        key: createHash("sha256").update(sessionKey).digest("hex").slice(0, 24),
        session: createHash("sha256").update(sessionId).digest("hex").slice(0, 24),
        epoch,
        before: createHash("sha256").update(beforeId).digest("base64url").slice(0, 32),
      }),
    ).toString("base64url");
  }

  private firstHistoryCursor(
    sessionKey: string,
    projection: NativeAgentSessionProjection,
  ): string | undefined {
    const history = this.projectionHistory.get(sessionKey);
    if (!history) return undefined;
    const historyIds = new Set(
      history.messages.map((message) => (message as { id?: unknown })?.id).filter(String),
    );
    const before = projection.messages.find((message) =>
      historyIds.has((message as { id?: unknown })?.id),
    ) as { id?: unknown } | undefined;
    if (!before) return undefined;
    const beforeIndex = history.messages.findIndex(
      (message) => (message as { id?: unknown })?.id === before.id,
    );
    if (beforeIndex <= 0) return undefined;
    return typeof before?.id === "string"
      ? this.historyCursor(sessionKey, before.id, history.epoch, history.sessionId)
      : undefined;
  }

  private syncCacheKey(input: NativeAgentProjectionUpdateInput): string {
    return `${nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    )}\0sync-v1`;
  }

  private recordSyncProjection(
    key: string,
    projection: NativeAgentSessionProjection,
    historyEpoch: string,
    historyCursor: string | undefined,
  ): { token: string; identityChanged: boolean } {
    let state = this.projectionSync.get(key);
    const identity = JSON.stringify([projection.sessionId ?? null, projection.generation]);
    const identityChanged = Boolean(state && state.identity !== identity);
    if (!state || identityChanged) {
      if (state) this.projectionSyncBytes -= state.revisionBytes;
      state = { incarnation: randomUUID(), identity, revisions: [], revisionBytes: 0 };
      this.projectionSync.set(key, state);
    } else {
      this.projectionSync.delete(key);
      this.projectionSync.set(key, state);
    }
    const token = digestWithMessages(
      `${state.incarnation}\0${historyEpoch}\0${historyCursor ?? ""}`,
      projection,
    );
    if (state.currentToken === token) return { token, identityChanged: false };
    state.currentToken = token;
    const bytes = encodedBytesWithMessages(projection);
    if (bytes <= NATIVE_SYNC_MAX_REVISION_BYTES) {
      state.revisions.push({ token, projection, bytes, createdAt: this.now() });
      state.revisionBytes += bytes;
      this.projectionSyncBytes += bytes;
    }
    const expiredBefore = this.now() - NATIVE_SYNC_REVISION_TTL_MS;
    while (
      state.revisions.length > NATIVE_SYNC_MAX_REVISIONS ||
      state.revisionBytes > NATIVE_SYNC_MAX_REVISION_BYTES ||
      (state.revisions[0]?.createdAt ?? this.now()) < expiredBefore
    ) {
      const removed = state.revisions.shift();
      if (!removed) break;
      state.revisionBytes -= removed.bytes;
      this.projectionSyncBytes -= removed.bytes;
    }
    while (this.projectionSyncBytes > NATIVE_SYNC_MAX_TOTAL_REVISION_BYTES) {
      const oldestKey = this.projectionSync.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.projectionSync.get(oldestKey)!;
      const removed = oldest.revisions.shift();
      if (removed) {
        oldest.revisionBytes -= removed.bytes;
        this.projectionSyncBytes -= removed.bytes;
      } else if (oldestKey !== key) {
        this.projectionSync.delete(oldestKey);
      } else {
        break;
      }
    }
    return { token, identityChanged };
  }

  private projectionDelta(
    previous: NativeAgentSessionProjection,
    current: NativeAgentSessionProjection,
    currentHistoryIds: ReadonlySet<string>,
  ): NativeAgentProjectionDelta {
    const previousById = new Map(
      previous.messages.map((message) => [(message as { id: string }).id, message] as const),
    );
    const currentIds = current.messages.map((message) => (message as { id: string }).id);
    const previousIds = previous.messages.map((message) => (message as { id: string }).id);
    const messageUpserts = current.messages.filter((message) => {
      const id = (message as { id: string }).id;
      const existing = previousById.get(id);
      return !existing || !sameEncoding(existing, message);
    });
    const currentIdSet = new Set(currentIds);
    const setFields: Record<string, unknown> = {};
    const unsetFields: string[] = [];
    const previousFields = previous as unknown as Record<string, unknown>;
    const currentFields = current as unknown as Record<string, unknown>;
    const fields = new Set([...Object.keys(previousFields), ...Object.keys(currentFields)]);
    for (const field of fields) {
      if (field === "messages" || field === "revision" || field === "generation") {
        continue;
      }
      if (!(field in currentFields)) {
        unsetFields.push(field);
      } else if (JSON.stringify(previousFields[field]) !== JSON.stringify(currentFields[field])) {
        setFields[field] = currentFields[field];
      }
    }
    return {
      messageUpserts,
      ...(sameIds(previousIds, currentIds) ? {} : { liveMessageIds: currentIds }),
      deletedMessageIds: previousIds.filter(
        (id) => !currentIdSet.has(id) && !currentHistoryIds.has(id),
      ),
      setFields,
      unsetFields: unsetFields as NativeAgentProjectionDelta["unsetFields"],
      revision: current.revision,
      generation: current.generation,
      ...(current.cursor === undefined ? {} : { cursor: current.cursor }),
    };
  }

  private progressiveKey(input: NativeAgentProgressiveInput, domain: string): string {
    return `${nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    )}\0progressive-v1\0${domain}`;
  }

  private progressiveIdentity(
    input: NativeAgentProgressiveInput,
    providerSessionId: string,
    sourceGeneration: string | number,
  ): NativeAgentViewIdentity {
    return {
      backendInstanceId: this.progressiveInstanceId,
      environmentId: input.environmentId,
      platform: input.agent,
      logicalSessionKey: input.logicalSessionKey,
      providerSessionId,
      sourceGeneration,
    };
  }

  /** Join equivalent source work; one renderer leaving never cancels the read. */
  private progressiveRead<T>(key: string, read: () => Promise<T>, sessionKey?: string): Promise<T> {
    const pending = this.progressiveReads.get(key) as Promise<T> | undefined;
    if (pending) {
      const waiters = this.progressiveReadWaiters.get(key) ?? 0;
      if (waiters >= 32 || this.progressiveReadWaiterCount >= 512) {
        return Promise.reject(new ProviderUnavailableError("Native agent read is overloaded"));
      }
      this.progressiveReadWaiters.set(key, waiters + 1);
      this.progressiveReadWaiterCount += 1;
      return pending.finally(() => {
        const remaining = Math.max(0, (this.progressiveReadWaiters.get(key) ?? 1) - 1);
        if (remaining === 0) this.progressiveReadWaiters.delete(key);
        else this.progressiveReadWaiters.set(key, remaining);
        this.progressiveReadWaiterCount = Math.max(0, this.progressiveReadWaiterCount - 1);
      });
    }
    const sourceReads = Array.from(this.progressiveReads.keys()).filter(
      (candidate) => !candidate.includes("\0progressive-v1\0discovery:"),
    ).length;
    if (!key.includes("\0progressive-v1\0discovery:") && sourceReads >= 8) {
      return Promise.reject(new ProviderUnavailableError("Native agent read is overloaded"));
    }
    if (sessionKey) this.progressiveReadEpochs.set(key, this.projectionEpochs.get(sessionKey) ?? 0);
    const operation = read();
    const tracked = operation.finally(() => {
      if (this.progressiveReads.get(key) === tracked) this.progressiveReads.delete(key);
    });
    this.progressiveReads.set(key, tracked);
    return tracked;
  }

  /**
   * Join equivalent work, then run at most one trailing read when the session
   * epoch moved. A forced refresh never settles from an older joined read.
   */
  private async progressiveReadCovering<T>(
    key: string,
    sessionKey: string,
    requestedEpoch: number,
    force: boolean,
    read: () => Promise<T>,
  ): Promise<T> {
    const pending = this.progressiveReads.get(key) as Promise<T> | undefined;
    const startedEpoch = this.progressiveReadEpochs.get(key);
    if (pending && force && startedEpoch !== undefined && startedEpoch < requestedEpoch) {
      await pending.catch(() => undefined);
    }
    const value = await this.progressiveRead(key, read, sessionKey);
    const latest = this.projectionEpochs.get(sessionKey) ?? 0;
    if (latest <= requestedEpoch && (!force || latest >= requestedEpoch)) return value;
    this.progressiveDirtyFollowUps.set(
      key,
      Math.max(this.progressiveDirtyFollowUps.get(key) ?? 0, latest),
    );
    return this.scheduleProgressiveTrailing(key, sessionKey, read);
  }

  private scheduleProgressiveTrailing<T>(
    key: string,
    sessionKey: string,
    read: () => Promise<T>,
  ): Promise<T> {
    const existing = this.progressiveTrailing.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const trailing = (async () => {
      const required = this.progressiveDirtyFollowUps.get(key) ?? 0;
      const value = await this.progressiveRead(key, read, sessionKey);
      const latest = this.projectionEpochs.get(sessionKey) ?? 0;
      if (latest > required) {
        this.progressiveDirtyFollowUps.set(key, latest);
        return this.progressiveRead(key, read, sessionKey);
      }
      return value;
    })().finally(() => {
      if (this.progressiveTrailing.get(key) === trailing) this.progressiveTrailing.delete(key);
      // The marker is what `pruneProjectionEpoch` reads to decide the session
      // is still busy, so it has to clear on every exit — including the second
      // re-read above and a thrown read. Leaving it set on one branch pinned
      // the session's epoch in memory for the lifetime of the process.
      this.progressiveDirtyFollowUps.delete(key);
    });
    this.progressiveTrailing.set(key, trailing);
    return trailing;
  }

  private sharedInteractiveSnapshot(
    input: NativeAgentProgressiveInput,
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
  ): Promise<ProviderInteractiveSnapshot> {
    if (!provider.interactiveSnapshot) {
      return Promise.reject(new ProviderUnavailableError("Provider snapshot is unavailable"));
    }
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.projectionEpochs.get(sessionKey) ?? 0;
    const key = `${sessionKey}\0${sessionId}`;
    const existing = this.interactiveSnapshotShares.get(key);
    if (existing && existing.epoch === epoch) return existing.promise;
    const promise = provider.interactiveSnapshot(sessionId);
    this.interactiveSnapshotShares.set(key, { promise, sessionKey, epoch, degraded: true });
    return promise;
  }

  private recordProgressiveMetric(
    domain: "transcript" | "state" | "discovery",
    startedAt: number,
    cacheTier: ProgressiveCacheTier,
    outcome: ProgressiveReadOutcome,
    extras: ProgressiveReadPhases & { degraded?: boolean } = {},
  ): void {
    this.progressiveMetrics.record({
      domain,
      cacheTier,
      outcome,
      durationMs: monotonicMs() - startedAt,
      ...extras,
    });
  }

  private transcriptHistoryCursor(
    sessionKey: string,
    messages: unknown[],
    historyEpoch: string,
    sessionId: string,
  ): string | undefined {
    const first = messages[0] as { id?: unknown } | undefined;
    if (typeof first?.id !== "string") return undefined;
    const history = this.projectionHistory.get(sessionKey);
    if (!history || history.epoch !== historyEpoch) return undefined;
    const beforeIndex = history.messages.findIndex(
      (message) => (message as { id?: unknown })?.id === first.id,
    );
    return beforeIndex > 0
      ? this.historyCursor(sessionKey, first.id, history.epoch, sessionId)
      : undefined;
  }

  private transcriptDelta(
    previous: NativeAgentTranscriptView,
    current: NativeAgentTranscriptView,
  ): NativeAgentTranscriptDelta {
    const previousById = new Map(
      previous.messages.map((message) => [(message as { id: string }).id, message] as const),
    );
    const currentIds = current.messages.map((message) => (message as { id: string }).id);
    const previousIds = previous.messages.map((message) => (message as { id: string }).id);
    const messageUpserts = current.messages.filter((message) => {
      const id = (message as { id: string }).id;
      const existing = previousById.get(id);
      return !existing || !sameEncoding(existing, message);
    });
    return {
      messageUpserts,
      ...(sameIds(previousIds, currentIds) &&
      previous.historyReconciliationToken === current.historyReconciliationToken
        ? {}
        : { liveMessageIds: currentIds }),
      // Rows that only aged out of the window are not deletions: the client
      // keeps them, and pages back to anything it does not hold. Older history
      // exists whenever the view says so, including a provider that trimmed
      // its own window (OpenCode) before this projection counted anything.
      deletedMessageIds: tailDeletions(
        previousIds,
        currentIds,
        !current.historyComplete || current.historyCursor !== undefined,
      ),
      freshness: current.freshness,
      historyEpoch: current.historyEpoch,
      historyComplete: current.historyComplete,
      ...(current.historyCursor ? { historyCursor: current.historyCursor } : {}),
      ...(current.historyPaging ? { historyPaging: current.historyPaging } : {}),
      ...(current.title ? { title: current.title } : {}),
      ...(current.messageWindow ? { messageWindow: current.messageWindow } : {}),
      ...(current.providerRevision === undefined
        ? {}
        : { providerRevision: current.providerRevision }),
      // A snapshot rehydrates all noted rows; a delta carries only revisions
      // that changed since its base. Empty/absent lists clear transient notes,
      // while the client's already-replaced history copies stay authoritative.
      ...(current.historyReconciliationToken
        ? { historyReconciliationToken: current.historyReconciliationToken }
        : {}),
      ...(current.revisedMessages
        ? {
            revisedMessages: current.revisedMessages.filter((message) => {
              const previousRow = previous.revisedMessages?.find(
                (row) => (row as { id: string }).id === (message as { id: string }).id,
              );
              return previousRow === undefined || !sameEncoding(previousRow, message);
            }),
          }
        : {}),
    };
  }

  private scheduleDisplayTailPersist(
    input: NativeAgentProgressiveInput,
    value: NativeAgentTranscriptView,
  ): void {
    if (value.freshness !== "current" && value.freshness !== "empty") return;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    // One pending latest value per key; stripping and serialization happen
    // once, when the checkpoint is actually written.
    this.displayTailScheduler.update(sessionKey, {
      environmentId: input.environmentId,
      build: () => {
        const messageWindow = displayTailRecoveryWindow(value.messageWindow);
        return createNativeAgentDisplayTail({
          environmentId: input.environmentId,
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: value.identity.providerSessionId,
          historyEpoch: value.historyEpoch,
          ...(value.title ? { title: value.title } : {}),
          messages: value.messages,
          historyComplete: value.historyComplete,
          ...(messageWindow ? { messageWindow } : {}),
          updatedAt: new Date(this.now()).toISOString(),
        });
      },
    });
  }

  /** Immediate checkpoint of a pending tail (tests and explicit flushes). */
  protected async flushDisplayTailPersist(sessionKey: string): Promise<void> {
    await this.displayTailScheduler.flush(sessionKey);
  }

  private trimProgressiveTranscriptCache(): void {
    while (
      this.progressiveTranscriptCache.size > 128 ||
      this.progressiveTranscriptBytes > 64 * 1024 * 1024
    ) {
      const oldest = this.progressiveTranscriptCache.keys().next().value as string | undefined;
      if (!oldest) break;
      const entry = this.progressiveTranscriptCache.get(oldest);
      if (entry) this.progressiveTranscriptBytes -= entry.bytes;
      this.progressiveTranscriptCache.delete(oldest);
    }
  }

  /**
   * A live preview that still fits the window is not "older history".
   *
   * Providers report `complete: false` for a hydration hole as well as for a
   * genuine remainder. Treating the flag alone as pageable hid the first
   * prompt behind "Load earlier messages" on a two-row transcript. If the
   * preview has not filled the live window, recover the bounded remainder in
   * the background and keep the preview available until that read settles.
   */
  private resolveProgressiveSnapshot(
    key: string,
    snapshot: ProviderTranscriptSnapshot,
  ): ProviderTranscriptSnapshot {
    if (snapshot.complete !== false) return snapshot;
    const cached = this.progressiveHydrations.get(key);
    if (cached && cached.sourceToken === progressiveHydrationToken(snapshot) && cached.snapshot) {
      return cached.snapshot;
    }
    return snapshot;
  }

  private progressivePreviewFillsWindow(
    snapshot: ProviderTranscriptSnapshot,
    liveWindow: { messages: number; targetBytes: number },
  ): boolean {
    if (snapshot.messages.length >= liveWindow.messages) return true;
    return Buffer.byteLength(JSON.stringify(snapshot.messages)) >= liveWindow.targetBytes;
  }

  private scheduleIncompleteProgressiveHydration(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
    snapshot: ProviderTranscriptSnapshot,
    initialPromptPresentation: PersistedNativeAgentSession["initialPromptPresentation"],
    /** Whether the view built from `snapshot` pages directly from its cursor. */
    directPagingAdopted: boolean,
  ): void {
    const sourceToken = progressiveHydrationToken(snapshot);
    // Even a complete/current snapshot that needs no recovery supersedes an
    // older exact read. Fence it before any of the no-hydration fast paths.
    this.invalidateStaleProgressiveHydration(key, sourceToken);
    if (snapshot.complete !== false) return;
    /*
     * A summary window is measured without raw artifacts, so a short one means
     * the history before it is genuinely there to page, not that a tool body
     * crowded it out. Re-reading the legacy full transcript would bring back
     * exactly the payloads the summary exists to avoid. Only a part-trimmed
     * head — one row larger than the whole window — still needs exact recovery.
     *
     * A *cached* summary is the exception. It is the bridge's no-touch preview
     * of a session whose rollout body it has not loaded (a detached or restarted
     * Codex thread), so its short or empty window says nothing about what the
     * conversation holds. Display reads never attach the thread, which makes
     * this exact read the only thing that ever will: skipping it left a
     * finished session rendering as empty until something else touched it.
     *
     * A page cursor the view adopted says the same as a summary: the provider
     * has already said where the rest of the history is, so its window is
     * short on purpose. One merely offered says nothing — a view that could
     * not hold the whole window dropped the row the cursor names, and without
     * this read the history before what it kept is unreachable.
     */
    if (
      (snapshot.representation === "summary" || directPagingAdopted) &&
      snapshot.freshness !== "cached" &&
      (snapshot.omittedParts ?? 0) <= 0
    )
      return;
    if (
      (snapshot.omittedParts ?? 0) <= 0 &&
      this.progressivePreviewFillsWindow(snapshot, input.liveWindow)
    )
      return;
    const existing = this.progressiveHydrations.get(key);
    if (existing && existing.sourceToken === sourceToken) return;
    const previousTimer = this.progressiveHydrationTimers.get(key);
    if (previousTimer) clearTimeout(previousTimer);
    const entry: ProgressiveHydrationEntry = {
      sourceToken,
      attempts: 0,
      holdPreview: (snapshot.omittedParts ?? 0) > 0,
    };
    this.progressiveHydrations.set(key, entry);
    const scheduleAttempt = (delayMs: number): void => {
      const timer = setTimeout(() => {
        if (this.progressiveHydrationTimers.get(key) === timer) {
          this.progressiveHydrationTimers.delete(key);
        }
        if (this.stopped || this.progressiveHydrations.get(key) !== entry) return;
        entry.attempts += 1;
        const promise = this.fillIncompleteProgressiveSnapshot(
          provider,
          sessionId,
          snapshot,
          input.liveWindow,
        )
          .catch(() => snapshot)
          .then((hydrated) => {
            if (
              this.stopped ||
              this.progressiveHydrations.get(key) !== entry ||
              this.progressiveSourceTokens.get(key) !== snapshot.sourceToken
            )
              return;
            if (hydrated === snapshot) {
              // The preview is safer than freezing a stale, fuller revision.
              // Keep retrying exact recovery in the background, but only the
              // first attempt is allowed to hold the visible transcript.
              entry.holdPreview = false;
              if (entry.attempts < PROGRESSIVE_HYDRATION_MAX_ATTEMPTS) {
                scheduleAttempt(PROGRESSIVE_HYDRATION_RETRY_BASE_MS * 2 ** (entry.attempts - 1));
              }
              return;
            }
            entry.holdPreview = false;
            entry.snapshot = hydrated;
            this.commitProgressiveTranscript(
              key,
              input,
              this.projectProgressiveTranscript(
                input,
                key,
                hydrated,
                sessionId,
                initialPromptPresentation,
              ),
            );
            // An idle view reads on a slow cadence. Say the recovered transcript
            // is there rather than leaving it to wait for the next poll.
            this.storage.announceNativeAgentSessionProjection(input.environmentId, {
              agent: input.agent,
              logicalSessionKey: input.logicalSessionKey,
            });
          })
          .finally(() => {
            if (entry.promise === promise) entry.promise = undefined;
          });
        entry.promise = promise;
      }, delayMs);
      this.progressiveHydrationTimers.set(key, timer);
    };
    scheduleAttempt(0);
  }

  private invalidateStaleProgressiveHydration(key: string, sourceToken: string): void {
    const existing = this.progressiveHydrations.get(key);
    if (!existing || existing.sourceToken === sourceToken) return;
    const timer = this.progressiveHydrationTimers.get(key);
    if (timer) clearTimeout(timer);
    this.progressiveHydrationTimers.delete(key);
    this.progressiveHydrations.delete(key);
  }

  private async fillIncompleteProgressiveSnapshot(
    provider: NativeAgentRuntimeProvider,
    sessionId: string,
    snapshot: ProviderTranscriptSnapshot,
    liveWindow: { messages: number; targetBytes: number },
  ): Promise<ProviderTranscriptSnapshot> {
    let fuller: unknown;
    try {
      fuller = await provider.messages(sessionId, { limit: liveWindow.messages });
    } catch {
      return snapshot;
    }
    const normalized = normalizedProgressiveMessages(fuller);
    if (!normalized) return snapshot;
    // A single long Codex turn can lose tool/commentary parts without losing a
    // message. Message count alone rejects that exact recovery indefinitely.
    const previewHead = snapshot.messages[0];
    const recoveredHead = normalized.find(
      (message) =>
        isNormalizedProgressiveMessage(previewHead) &&
        isNormalizedProgressiveMessage(message) &&
        message.id === previewHead.id,
    );
    const recoveredParts =
      snapshot.omittedParts &&
      isNormalizedProgressiveMessage(previewHead) &&
      isNormalizedProgressiveMessage(recoveredHead) &&
      recoveredHead.parts.length > previewHead.parts.length;
    if (
      normalized.length < snapshot.messages.length ||
      (normalized.length === snapshot.messages.length && !recoveredParts)
    )
      return snapshot;
    const historyStartIndex =
      snapshot.historyStartIndex === undefined
        ? undefined
        : Math.max(0, snapshot.historyStartIndex + snapshot.messages.length - normalized.length);
    return {
      ...snapshot,
      messages: normalized,
      omittedParts: undefined,
      byteOmittedMessages: undefined,
      ...(historyStartIndex === undefined ? {} : { historyStartIndex }),
      complete: normalized.length < liveWindow.messages,
      freshness: "current",
    };
  }

  private projectProgressiveTranscript(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
    snapshot: ProviderTranscriptSnapshot,
    providerSessionId: string,
    initialPromptPresentation: PersistedNativeAgentSession["initialPromptPresentation"],
  ): ProjectedProgressiveTranscript {
    const previous = this.progressiveTranscriptCache.get(key);
    const overlay = this.artifactOverlay(input);
    const sourceGeneration =
      this.providerRegistry.connectionIdentity(
        providerCacheKey(input.environmentId, input.agent),
      ) ?? `in-process:${input.agent}`;
    const identity = this.progressiveIdentity(input, providerSessionId, sourceGeneration);
    const previewHead = snapshot.messages[0];
    const displayedHead = previous?.value.messages.find(
      (message) =>
        isNormalizedProgressiveMessage(previewHead) &&
        isNormalizedProgressiveMessage(message) &&
        message.id === previewHead.id,
    );
    /*
     * A byte-trimmed message is not a replacement for the full turn already on
     * screen. Keep the bounded display snapshot until the background exact read
     * above recovers its parts. Merging by array index would misidentify tool
     * details (and progress rows need not project one-to-one), so install that
     * recovery atomically instead. Epoch/session/generation changes and complete
     * snapshots remain authoritative replacements, including real deletions.
     */
    const hydration = this.progressiveHydrations.get(key);
    const hydrationHoldingPreview =
      hydration?.sourceToken === progressiveHydrationToken(snapshot) &&
      hydration.holdPreview &&
      (hydration.promise !== undefined || this.progressiveHydrationTimers.has(key));
    if (
      snapshot.complete === false &&
      (snapshot.omittedParts ?? 0) > 0 &&
      hydrationHoldingPreview &&
      snapshot.historyEpoch !== undefined &&
      previous?.value.historyEpoch === snapshot.historyEpoch &&
      previous.value.historyReconciliationToken === snapshot.historyReconciliationToken &&
      previous.value.identity.providerSessionId === providerSessionId &&
      previous.value.identity.sourceGeneration === identity.sourceGeneration &&
      isNormalizedProgressiveMessage(previewHead) &&
      isNormalizedProgressiveMessage(displayedHead)
    ) {
      return this.keptProgressiveProjection(previous, overlay);
    }
    const summary = snapshot.representation === "summary";
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (snapshot.historyEpoch !== undefined) {
      // A new epoch is a rewritten history: rows kept for the old one go now
      // rather than aging out, and so do pages cut from it.
      if (previous !== undefined && previous.value.historyEpoch !== snapshot.historyEpoch) {
        this.projectedMessages.forgetSession(sessionKey);
      }
      if (summary || snapshot.historyCursor !== undefined) {
        this.directHistoryPages.observeEpoch(sessionKey, providerSessionId, snapshot.historyEpoch);
      }
    }
    if (previous?.value.historyReconciliationToken !== snapshot.historyReconciliationToken) {
      this.directHistoryPages.forgetSession(sessionKey);
    }
    const normalized = this.projectionMessages(
      sessionKey,
      snapshot.messages,
      input.liveWindow.messages,
      NATIVE_SYNC_MAX_SNAPSHOT_BYTES,
      initialPromptPresentation,
      Boolean(coordinatorIdFromRuntimeId(input.environmentId)),
      summary ? { providerSessionId } : undefined,
      overlay,
    );
    let projectedMessages = normalized.messages;
    let projectedStartIndex = snapshot.historyStartIndex;
    let sourceComplete = snapshot.complete;
    /*
     * A bridge bounds raw tool output and inline attachments before we move
     * them behind detail references. Its preview can therefore omit the first
     * prompt even when the projected conversation fits comfortably here.
     * Hydration recovers that prefix, but each streaming revision changes the
     * hydration token. Do not publish the smaller preview again while its next
     * recovery is pending: that removes and reinserts the prompt every poll.
     *
     * Carry only a prefix whose sequence position is proven by the provider,
     * from the same explicit history epoch and runtime identity. Directly
     * overlapping rows must still match in order; an adjacent disjoint window
     * is the append-only case that ids alone cannot prove. Complete snapshots,
     * rewritten histories, gaps and unpositioned windows remain authoritative
     * replacements. Reapply the normal count/byte bounds after joining.
     */
    if (
      snapshot.complete === false &&
      snapshot.historyEpoch !== undefined &&
      previous?.value.historyEpoch === snapshot.historyEpoch &&
      previous.value.historyReconciliationToken === snapshot.historyReconciliationToken &&
      previous.value.identity.providerSessionId === providerSessionId &&
      previous.value.identity.sourceGeneration === identity.sourceGeneration &&
      previous.historyStartIndex !== undefined &&
      previous.historyEndIndex !== undefined &&
      projectedStartIndex !== undefined &&
      projectedMessages.length > 0
    ) {
      const id = (message: unknown) => (message as { id: string }).id;
      const earlier = previous.value.messages;
      const incomingEndIndex = projectedStartIndex + projectedMessages.length;
      const prefixLength = projectedStartIndex - previous.historyStartIndex;
      const overlapLength = previous.historyEndIndex - projectedStartIndex;
      if (
        prefixLength > 0 &&
        prefixLength <= earlier.length &&
        projectedStartIndex <= previous.historyEndIndex &&
        incomingEndIndex >= previous.historyEndIndex &&
        overlapLength >= 0 &&
        earlier
          .slice(prefixLength)
          .every((message, index) => id(message) === id(projectedMessages[index]))
      ) {
        projectedMessages = [...earlier.slice(0, prefixLength), ...projectedMessages];
        projectedStartIndex = previous.historyStartIndex;
        sourceComplete = previous.value.historyComplete;
      }
    }
    const bounded = this.boundedProjectedMessages(
      projectedMessages,
      input.liveWindow.messages,
      input.liveWindow.targetBytes,
    );
    const droppedProjectedMessages = projectedMessages.length - bounded.messages.length;
    const boundedStartIndex =
      projectedStartIndex === undefined
        ? undefined
        : projectedStartIndex + droppedProjectedMessages;
    if (snapshot.complete === false && sourceComplete === true && droppedProjectedMessages > 0) {
      // The old complete base justified the join only while its carried rows
      // remained visible. A byte bound that drops them leaves an incomplete,
      // non-pageable provider preview and must not claim complete history.
      sourceComplete = false;
    }
    /*
     * A provider page cursor names the position of the snapshot's first
     * message. It is usable only while this view starts at or before that
     * position: a joined prefix merely overlaps the first page (the client
     * deduplicates by id), but a bound that dropped leading rows would leave
     * a gap no page could ever fill.
     *
     * A provider that pages by message (OpenCode) reports no position, and
     * nothing can be joined ahead of its window, so the view must hold every
     * row of the snapshot instead. Inline bodies need no summary for this:
     * the page projection registers them as local details like any other.
     */
    const viewStartsAtSnapshot =
      snapshot.historyStartIndex === undefined
        ? normalized.messages.length === snapshot.messages.length && droppedProjectedMessages === 0
        : boundedStartIndex !== undefined && boundedStartIndex <= snapshot.historyStartIndex;
    const directHistoryCursor =
      snapshot.historyCursor && snapshot.historyEpoch !== undefined && viewStartsAtSnapshot
        ? encodeDirectHistoryCursor({
            sessionKey,
            providerSessionId,
            historyEpoch: snapshot.historyEpoch,
            providerCursor: snapshot.historyCursor,
          })
        : undefined;
    const localPageable =
      directHistoryCursor !== undefined ||
      bounded.window.canLoadEarlier === true ||
      (normalized.window.canLoadEarlier === true && normalized.window.truncationReason !== "bytes");
    // A provider tail that already fills the live window cannot produce a
    // local count slice, so incompleteness itself is the remainder signal.
    const pageable =
      localPageable ||
      (sourceComplete === false && bounded.messages.length >= input.liveWindow.messages);
    /*
     * Whole messages dropped for bytes ahead of this window, by the provider or
     * by the bound above. One oversized turn leaves a tail too short to fill
     * the count window, so neither signal above fires and the reader saw an
     * unexplained cut. A wider live window cannot restore these, but history
     * paging can, and the renderer offers it for exactly this shape: an
     * incomplete window reporting byte-omitted messages. A joined prefix has
     * already restored part of the provider's omission, so count from the
     * joined start when it is positioned.
     */
    const providerByteOmitted =
      sourceComplete === false && snapshot.byteOmittedMessages
        ? (projectedStartIndex ?? snapshot.byteOmittedMessages)
        : 0;
    const localByteOmitted =
      bounded.window.truncationReason === "bytes" ? (bounded.window.omittedMessages ?? 0) : 0;
    const byteOmitted = providerByteOmitted > 0 || localByteOmitted > 0;
    const truncated =
      Boolean(bounded.window.truncated || normalized.window.truncated) ||
      sourceComplete === false ||
      byteOmitted;
    const complete = !pageable && sourceComplete !== false && !byteOmitted;
    const historyEpoch =
      snapshot.historyEpoch ??
      (previous?.value.identity.providerSessionId === providerSessionId
        ? previous.value.historyEpoch
        : randomUUID());
    const historyCursor =
      directHistoryCursor ??
      this.transcriptHistoryCursor(sessionKey, bounded.messages, historyEpoch, providerSessionId);
    // Rows the provider says changed outside its window. One can sit in the
    // prefix joined ahead of that window from the previous view, which holds
    // its older copy: the revised copy replaces it there and is not sent again.
    const revised = this.projectedRevisedMessages(
      sessionKey,
      snapshot.revisedMessages,
      normalized.messages,
      initialPromptPresentation,
      Boolean(coordinatorIdFromRuntimeId(input.environmentId)),
      summary ? { providerSessionId } : undefined,
      overlay,
    );
    const deliveredRevisions = new Set(
      [...normalized.messages, ...(revised ?? [])].map((row) => (row as { id: string }).id),
    );
    const omittedRevisions =
      snapshot.revisedMessages?.filter(
        (row) => !deliveredRevisions.has((row as { id: string }).id),
      ) ?? [];
    const historyReconciliationToken = omittedRevisions.length
      ? revisedRowsReconciliationToken(0, [
          snapshot.historyReconciliationToken,
          ...omittedRevisions,
        ])
      : snapshot.historyReconciliationToken;
    const revisedById = new Map(
      (revised ?? []).map((message) => [(message as { id: string }).id, message] as const),
    );
    const replaced = revisedById.size
      ? bounded.messages.map((message) => {
          const id = (message as { id?: unknown }).id;
          const replacement = typeof id === "string" ? revisedById.get(id) : undefined;
          if (replacement === undefined) return message;
          revisedById.delete(id as string);
          return replacement;
        })
      : bounded.messages;
    // A prefix joined from the previous view carries that read's placements;
    // publications committed since then are placed here (idempotently).
    const viewed = overlayArtifactParts(replaced, overlay);
    const providerRevisedMessages =
      revised?.filter((message) => revisedById.has((message as { id: string }).id)) ?? [];
    const ledgerRevised = this.ledgerRevisedRows({
      sessionKey,
      context: {
        sessionKey,
        ...(summary ? { remoteSessionId: providerSessionId } : {}),
        coordinator: Boolean(coordinatorIdFromRuntimeId(input.environmentId)),
      },
      previous,
      sameHistory:
        previous?.value.historyEpoch === historyEpoch &&
        previous.value.identity.providerSessionId === providerSessionId,
      overlay,
      window: viewed,
      providerRevised: providerRevisedMessages,
    });
    const revisedMessages = [...providerRevisedMessages, ...ledgerRevised];
    // A cached history page holds whatever copy of a row it was read with; a
    // row that has changed since must not come back from one.
    if (
      revised?.length &&
      revisedRowsChanged(
        [...(previous?.value.messages ?? []), ...(previous?.value.revisedMessages ?? [])],
        revised,
      )
    ) {
      this.directHistoryPages.forgetSession(sessionKey);
    }
    // Unchanged rows keep the objects already held, so every later comparison
    // and encoding of them in this read and the next is a reference check.
    const messages = reuseUnchangedMessages(previous?.value.messages, viewed);
    return {
      value: {
        identity,
        freshness:
          messages.length === 0 && complete
            ? "empty"
            : snapshot.freshness === "cached"
              ? "cached"
              : "current",
        messages,
        messageWindow: {
          ...bounded.window,
          truncated,
          canLoadEarlier: pageable,
          ...(byteOmitted
            ? {
                truncationReason: "bytes" as const,
                omittedMessages: providerByteOmitted + (bounded.window.omittedMessages ?? 0),
              }
            : {}),
        },
        ...(snapshot.title ? { title: snapshot.title } : {}),
        ...(snapshot.revision === undefined ? {} : { providerRevision: snapshot.revision }),
        ...(historyCursor ? { historyCursor } : {}),
        ...(directHistoryCursor ? { historyPaging: "direct" as const } : {}),
        historyEpoch,
        historyComplete: complete,
        ...(revisedMessages.length ? { revisedMessages } : {}),
        ...(historyReconciliationToken ? { historyReconciliationToken } : {}),
      },
      ...(boundedStartIndex === undefined
        ? {}
        : {
            historyStartIndex: boundedStartIndex,
            historyEndIndex: boundedStartIndex + bounded.messages.length,
          }),
      ledgerRevision: overlay?.revision ?? 0,
      ...(ledgerRevised.length
        ? { ledgerRevisedIds: ledgerRevised.map((row) => (row as { id: string }).id) }
        : {}),
    };
  }

  private artifactOverlay(input: {
    environmentId: string;
    logicalSessionKey: string;
  }): ArtifactOverlay | null {
    return this.artifactOverlays.overlay(input.environmentId, input.logicalSessionKey);
  }

  /**
   * A view kept from an earlier read, with publications committed since then
   * placed into its rows. Its rows are never modified, and its ledger
   * revision is not advanced: rows outside it are searched by the next full
   * projection.
   */
  private keptProgressiveProjection(
    previous: ProgressiveTranscriptEntry,
    overlay: ArtifactOverlay | null,
  ): ProjectedProgressiveTranscript {
    const messages = overlayArtifactParts(previous.value.messages, overlay);
    return {
      value:
        messages === previous.value.messages ? previous.value : { ...previous.value, messages },
      ...(previous.historyStartIndex === undefined
        ? {}
        : { historyStartIndex: previous.historyStartIndex }),
      ...(previous.historyEndIndex === undefined
        ? {}
        : { historyEndIndex: previous.historyEndIndex }),
      ...(previous.ledgerRevision === undefined ? {} : { ledgerRevision: previous.ledgerRevision }),
      ...(previous.ledgerRevisedIds ? { ledgerRevisedIds: previous.ledgerRevisedIds } : {}),
    };
  }

  /**
   * Rows outside the window that a publication committed since the previous
   * view now reaches, plus rows sent this way before that are still outside
   * it. Readers re-read only the window, so like a provider's revised rows
   * these travel in `revisedMessages` and replace the reader's copy.
   *
   * A row is taken from the previous view or the per-row projection cache,
   * never fabricated, and never a part-trimmed head row (a reader would lose
   * the parts it holds). A publication whose row this backend no longer holds
   * is left to the reader's own merge, which places it when that row is
   * paged. Bounded together with the provider's revised rows by
   * `NATIVE_AGENT_REVISED_MESSAGES_MAX` and `NATIVE_REVISED_MESSAGES_MAX_BYTES`.
   */
  private ledgerRevisedRows(input: {
    sessionKey: string;
    context: ProjectionEntryContext;
    previous: ProgressiveTranscriptEntry | undefined;
    sameHistory: boolean;
    overlay: ArtifactOverlay | null;
    window: readonly unknown[];
    providerRevised: readonly unknown[];
  }): unknown[] {
    const { previous, overlay } = input;
    if (!overlay || !previous || !input.sameHistory) return [];
    const room = NATIVE_AGENT_REVISED_MESSAGES_MAX - input.providerRevised.length;
    if (room <= 0) return [];
    const idOf = (row: unknown): string | undefined => {
      const id = (row as { id?: unknown } | null | undefined)?.id;
      return typeof id === "string" ? id : undefined;
    };
    const excluded = new Set<string>();
    for (const row of [...input.window, ...input.providerRevised]) {
      const id = idOf(row);
      if (id !== undefined) excluded.add(id);
    }
    const candidates = new Map<string, unknown>();
    const since = previous.ledgerRevision;
    if (since !== undefined && overlay.revision > since) {
      const shown = artifactPublicationIds([...input.window, ...input.providerRevised]);
      const fresh = new Set(
        overlay.publications
          .filter(
            (publication) =>
              publication.conversationSequence > since && !shown.has(publication.ref.publicationId),
          )
          .map((publication) => publication.ref.publicationId),
      );
      const previousRows = previous.value.messages;
      const trimmedHead =
        (previous.value.messageWindow?.omittedParts ?? 0) > 0 ? idOf(previousRows[0]) : undefined;
      const consider = (row: unknown): void => {
        const id = idOf(row);
        if (id === undefined || excluded.has(id) || candidates.has(id) || id === trimmedHead) {
          return;
        }
        const [overlaid] = overlayArtifactParts([row], overlay);
        if (overlaid === row) return;
        let reached = false;
        for (const publicationId of artifactPublicationIds([overlaid])) {
          if (fresh.delete(publicationId)) reached = true;
        }
        if (reached) candidates.set(id, overlaid);
      };
      for (const row of [...(previous.value.revisedMessages ?? []), ...previousRows]) {
        if (fresh.size === 0 || candidates.size >= room) break;
        consider(row);
      }
      if (fresh.size > 0 && candidates.size < room) {
        for (const entry of this.projectedMessages.sessionEntries(input.context)) {
          if (fresh.size === 0 || candidates.size >= room) break;
          const id = idOf(entry.projected);
          if (id === undefined || excluded.has(id) || candidates.has(id)) continue;
          // Its detail references must resolve like the window's do.
          if (!this.restoreDetailRegistrations(input.sessionKey, entry.details)) continue;
          consider(entry.projected);
        }
      }
    }
    for (const id of previous.ledgerRevisedIds ?? []) {
      if (excluded.has(id) || candidates.has(id)) continue;
      const row = previous.value.revisedMessages?.find((candidate) => idOf(candidate) === id);
      if (row !== undefined) candidates.set(id, overlayArtifactParts([row], overlay)[0]);
    }
    let bytes = input.providerRevised.reduce<number>(
      (total, row) => total + encodedValue(row).bytes,
      0,
    );
    const rows: unknown[] = [];
    for (const row of candidates.values()) {
      if (rows.length >= room) break;
      const size = encodedValue(row).bytes;
      if (bytes + size > NATIVE_REVISED_MESSAGES_MAX_BYTES) continue;
      bytes += size;
      rows.push(row);
    }
    return rows;
  }

  /**
   * A provider's revised rows from before the window, projected like window
   * rows so their details register and resolve the same way.
   *
   * Rows the window holds are dropped (it is authoritative for them), and so
   * is any row its projection would have to trim: a reader replaces its whole
   * copy with what arrives here, and a trimmed row would lose parts it holds.
   * The session's first prompt is presented by its position in the whole
   * transcript, which a lone revised row does not carry, so a user row is left
   * to the copy the reader already presents. Malformed rows are skipped rather
   * than failing a read that is otherwise sound. Bounded by count and bytes.
   */
  private projectedRevisedMessages(
    sessionKey: string,
    revised: readonly unknown[] | undefined,
    window: readonly unknown[],
    initialPromptPresentation: PersistedNativeAgentSession["initialPromptPresentation"],
    coordinatorTranscript: boolean,
    remote: { providerSessionId: string } | undefined,
    artifactOverlay: ArtifactOverlay | null,
  ): unknown[] | undefined {
    if (!revised?.length) return undefined;
    const seen = new Set(window.map((message) => (message as { id?: unknown }).id));
    const projected: unknown[] = [];
    let bytes = 0;
    for (const row of revised) {
      if (projected.length >= NATIVE_AGENT_REVISED_MESSAGES_MAX) break;
      const record =
        row && typeof row === "object" && !Array.isArray(row)
          ? (row as Record<string, unknown>)
          : undefined;
      const id = record?.id;
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      if (initialPromptPresentation && record!.role === "user") continue;
      let one: { messages: unknown[]; window: NativeAgentMessageWindow };
      try {
        one = this.projectionMessages(
          sessionKey,
          [row],
          1,
          NATIVE_REVISED_MESSAGES_MAX_BYTES,
          undefined,
          coordinatorTranscript,
          remote,
          artifactOverlay,
        );
      } catch (error) {
        if (error instanceof ProviderUnavailableError) continue;
        throw error;
      }
      const message = one.messages[0];
      if (one.window.truncated || message === undefined) continue;
      const size = encodedValue(message).bytes;
      if (bytes + size > NATIVE_REVISED_MESSAGES_MAX_BYTES) continue;
      bytes += size;
      projected.push(message);
    }
    return projected.length > 0 ? projected : undefined;
  }

  private commitProgressiveTranscript(
    key: string,
    input: NativeAgentTranscriptUpdateInput,
    projection: ProjectedProgressiveTranscript,
  ): string {
    const value = projection.value;
    const observed = this.progressiveTranscriptCache.get(key);
    if (observed?.value === value) return observed.token;
    const token = updateHashWithValues(
      updateHashWithValues(
        createHash("sha256").update(
          JSON.stringify([
            value.identity,
            value.historyEpoch,
            value.providerRevision,
            this.progressiveSourceTokens.get(key),
            projection.historyStartIndex,
            projection.historyEndIndex,
            // A publication moves the view even before its row is read. No
            // ledger read (a persisted tail) and an empty ledger hash alike, so
            // an identical view keeps its token.
            projection.ledgerRevision ?? 0,
          ]),
        ),
        value.messages,
      ),
      // A provider's token already moves when a revised row changes; hashing
      // them too keeps "unchanged" honest for one whose token does not.
      value.revisedMessages ?? [],
    )
      .digest("base64url")
      .slice(0, 43);
    const current = this.progressiveTranscriptCache.get(key);
    if (!current || current.token !== token) {
      const bytes = encodedBytesWithMessages(value);
      if (current) this.progressiveTranscriptBytes -= current.bytes;
      this.progressiveTranscriptCache.delete(key);
      this.progressiveTranscriptCache.set(key, {
        token,
        sourceToken: this.progressiveSourceTokens.get(key),
        value,
        bytes,
        ...(projection.historyStartIndex === undefined
          ? {}
          : { historyStartIndex: projection.historyStartIndex }),
        ...(projection.historyEndIndex === undefined
          ? {}
          : { historyEndIndex: projection.historyEndIndex }),
        ...(projection.ledgerRevision === undefined
          ? {}
          : { ledgerRevision: projection.ledgerRevision }),
        ...(projection.ledgerRevisedIds ? { ledgerRevisedIds: projection.ledgerRevisedIds } : {}),
      });
      this.progressiveTranscriptBytes += bytes;
      this.trimProgressiveTranscriptCache();
      this.scheduleDisplayTailPersist(input, value);
    }
    return token;
  }

  private async readProgressiveTranscript(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
    phases?: ProgressiveReadPhaseTimer,
  ): Promise<ProjectedProgressiveTranscript | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const previous = this.progressiveTranscriptCache.get(key);
    // A publication committed since the previous view changes rows the
    // provider has not: its "unchanged" would keep the view without them.
    const ledgerMoved =
      previous !== undefined &&
      (previous.ledgerRevision ?? 0) !== (this.artifactOverlay(input)?.revision ?? 0);
    phases?.sourceStarted();
    const providerResult = resolved.provider.transcriptSnapshot
      ? await resolved.provider.transcriptSnapshot(resolved.session.providerSessionId, {
          limit: input.liveWindow.messages,
          targetBytes: input.liveWindow.targetBytes,
          ...(previous?.sourceToken && !ledgerMoved
            ? { knownSourceToken: previous.sourceToken }
            : {}),
          // This projection resolves detail locators, so it can take the
          // lightweight form; other consumers keep reading bodies inline.
          representation: "summary",
        })
      : resolved.provider.interactiveSnapshot
        ? await this.sharedInteractiveSnapshot(
            input,
            resolved.provider,
            resolved.session.providerSessionId,
          ).then(
            (snapshot) =>
              ({
                messages: snapshot.messages,
                complete: snapshot.messagesComplete,
                freshness: "current" as const,
                ...(snapshot.title ? { title: snapshot.title } : {}),
                ...(snapshot.providerRevision === undefined
                  ? {}
                  : { revision: snapshot.providerRevision }),
              }) satisfies ProviderTranscriptSnapshot,
          )
        : ({
            messages: await resolved.provider.messages(resolved.session.providerSessionId, {
              limit: input.liveWindow.messages,
            }),
            freshness: "current" as const,
          } satisfies ProviderTranscriptSnapshot);
    phases?.sourceEnded();
    if ("unchanged" in providerResult) {
      if (!previous) {
        throw new ProviderUnavailableError("Provider returned unchanged without a transcript base");
      }
      this.invalidateStaleProgressiveHydration(key, providerResult.sourceToken);
      this.progressiveTranscriptCache.delete(key);
      this.progressiveTranscriptCache.set(key, {
        ...previous,
        sourceToken: providerResult.sourceToken,
      });
      this.progressiveSourceTokens.set(key, providerResult.sourceToken);
      return this.keptProgressiveProjection(previous, this.artifactOverlay(input));
    }
    const snapshot = this.resolveProgressiveSnapshot(key, providerResult);
    if (snapshot.sourceToken) this.progressiveSourceTokens.set(key, snapshot.sourceToken);
    else this.progressiveSourceTokens.delete(key);
    const scheduleHydration = (directPagingAdopted: boolean) =>
      this.scheduleIncompleteProgressiveHydration(
        input,
        key,
        resolved.provider,
        resolved.session.providerSessionId,
        providerResult,
        resolved.session.initialPromptPresentation,
        directPagingAdopted,
      );
    /*
     * The projection reads whether a recovery is holding the preview, which
     * only one for a part-trimmed head does, so that one is scheduled first.
     * Any other is scheduled after projecting: whether the view could adopt
     * the provider's cursor decides whether it is needed at all.
     */
    const holdsPreview = (snapshot.omittedParts ?? 0) > 0;
    if (holdsPreview) scheduleHydration(false);
    /*
     * A restarted Codex bridge knows the durable thread identity before it has
     * loaded the rollout body. Its no-touch preview is therefore empty, cached,
     * and explicitly incomplete. Keep a non-empty persisted display tail on
     * screen while the exact messages read above re-attaches the thread; the
     * preview has no authority to erase content it admits it has not loaded.
     */
    if (
      providerResult.freshness === "cached" &&
      providerResult.complete === false &&
      providerResult.messages.length === 0 &&
      previous?.value.identity.providerSessionId === resolved.session.providerSessionId &&
      previous.value.messages.length > 0
    ) {
      if (!holdsPreview) scheduleHydration(false);
      return this.keptProgressiveProjection(previous, this.artifactOverlay(input));
    }
    let projection: ProjectedProgressiveTranscript;
    try {
      projection = this.projectProgressiveTranscript(
        input,
        key,
        snapshot,
        resolved.session.providerSessionId,
        resolved.session.initialPromptPresentation,
      );
    } catch (error) {
      if (!holdsPreview) scheduleHydration(false);
      throw error;
    }
    if (!holdsPreview) scheduleHydration(projection.value.historyPaging === "direct");
    return projection;
  }

  async getTranscriptUpdate(
    input: NativeAgentTranscriptUpdateInput,
  ): Promise<NativeAgentTranscriptUpdate> {
    this.assertProjectionInput(input);
    if (input.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) {
      throw new Error("Native agent progressive view version is unsupported");
    }
    const key = this.progressiveKey(
      input,
      `transcript:${input.liveWindow.messages}:${input.liveWindow.targetBytes}`,
    );
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.projectionEpochs.get(sessionKey) ?? 0;
    const startedAt = monotonicMs();
    const cached = this.progressiveTranscriptCache.get(key);
    // Phase timings for the read this caller waits on; background refreshes
    // behind a cached answer are not attributed to this response.
    const phases = new ProgressiveReadPhaseTimer();
    const publish = async (
      timer?: ProgressiveReadPhaseTimer,
    ): Promise<NativeAgentTranscriptView | null> => {
      const read = () => this.readProgressiveTranscript(input, key, timer);
      const cover = () =>
        this.progressiveReadCovering(
          key,
          sessionKey,
          epoch,
          input.forceSnapshot === true,
          timer ? timer.own(read) : read,
        );
      const projection = await (timer ? timer.covering(cover) : cover());
      if (!projection) return null;
      const commit = () => this.commitProgressiveTranscript(key, input, projection);
      if (timer) timer.normalize(commit);
      else commit();
      return projection.value;
    };
    if (!cached && !input.forceSnapshot) {
      const persisted = await this.storage.getNativeAgentDisplayTail(sessionKey).catch(() => null);
      if (persisted && persisted.logicalSessionKey === input.logicalSessionKey) {
        const historyComplete = persisted.historyComplete === true;
        const messageWindow = displayTailRecoveryWindow(persisted.messageWindow);
        const value: NativeAgentTranscriptView = {
          identity: this.progressiveIdentity(
            input,
            persisted.providerSessionId,
            this.providerRegistry.connectionIdentity(
              providerCacheKey(input.environmentId, input.agent),
            ) ?? `in-process:${input.agent}`,
          ),
          freshness: persisted.messages.length === 0 ? "empty" : "cached",
          // Tails are written from the already-stripped progressive projection.
          // Stripping again here would drop a user-authored leading context
          // block that the first pass is documented to keep visible.
          messages: persisted.messages,
          historyEpoch: persisted.historyEpoch,
          // v1 tails and any write that omitted remainder metadata cannot
          // prove the start of history. Claim complete only when persisted.
          historyComplete,
          ...(messageWindow ? { messageWindow } : {}),
          ...(persisted.title ? { title: persisted.title } : {}),
        };
        const token = this.commitProgressiveTranscript(key, input, { value });
        void publish().catch(() => undefined);
        this.recordProgressiveMetric("transcript", startedAt, "persisted", "cached");
        return { viewVersion: 1, status: "snapshot", token, value };
      }
    }
    if (cached && !input.forceSnapshot && input.knownToken !== cached.token) {
      void publish().catch(() => undefined);
      this.recordProgressiveMetric("transcript", startedAt, "memory", "cached");
      return {
        viewVersion: 1,
        status: "snapshot",
        token: cached.token,
        value: { ...cached.value, freshness: "cached" },
      };
    }
    try {
      const previous = cached;
      const value = await publish(phases);
      if (!value) {
        this.recordProgressiveMetric(
          "transcript",
          startedAt,
          "provider",
          "missing",
          phases.phases(),
        );
        return { viewVersion: 1, status: "missing" };
      }
      const entry = this.progressiveTranscriptCache.get(key)!;
      if (!input.forceSnapshot && input.knownToken === entry.token) {
        this.recordProgressiveMetric(
          "transcript",
          startedAt,
          "provider",
          "unchanged",
          phases.phases(),
        );
        return {
          viewVersion: 1,
          status: "unchanged",
          token: entry.token,
          identity: entry.value.identity,
        };
      }
      if (
        previous &&
        input.knownToken === previous.token &&
        previous.token !== entry.token &&
        previous.value.identity.providerSessionId === value.identity.providerSessionId &&
        previous.value.historyEpoch === value.historyEpoch
      ) {
        const delta = this.transcriptDelta(previous.value, value);
        if (input.patchVersion === NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION) {
          patchTranscriptDelta(delta, previous.value.messages);
        }
        const operationCount =
          delta.messageUpserts.length +
          (delta.messagePatches?.length ?? 0) +
          delta.deletedMessageIds.length +
          (delta.liveMessageIds?.length ?? 0);
        const deltaBytes =
          encodedBytesWithMessages({
            ...delta,
            messages: delta.messageUpserts,
            messageUpserts: [],
            messagePatches: [],
          }) + (delta.messagePatches ? encodedPatchBytes(delta.messagePatches) : 0);
        const snapshotBytes = entry.bytes;
        if (operationCount <= 1024 && deltaBytes < snapshotBytes) {
          this.recordProgressiveMetric(
            "transcript",
            startedAt,
            "provider",
            "delta",
            phases.phases(),
          );
          return {
            viewVersion: 1,
            status: "delta",
            baseToken: previous.token,
            token: entry.token,
            identity: value.identity,
            delta,
          };
        }
      }
      this.recordProgressiveMetric(
        "transcript",
        startedAt,
        "provider",
        "snapshot",
        phases.phases(),
      );
      return {
        viewVersion: 1,
        status: "snapshot",
        token: entry.token,
        value,
        resetReason: input.forceSnapshot
          ? "forced"
          : input.knownToken
            ? "unknown-token"
            : "initial",
      };
    } catch (error) {
      this.recordProgressiveMetric(
        "transcript",
        startedAt,
        "provider",
        "unavailable",
        phases.phases(),
      );
      return {
        viewVersion: 1,
        status: "unavailable",
        retryable: true,
        error: error instanceof Error ? error.message.slice(0, 4_000) : "Transcript unavailable",
      };
    }
  }

  private async readProgressiveSessionState(
    input: NativeAgentProgressiveInput,
  ): Promise<NativeAgentSessionStateView | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const advertisedCapabilities = nativeCapabilities(input.agent);
    const [snapshot, interactionSnapshot, queue, steerSupported] = await Promise.all([
      resolved.provider.sessionStateSnapshot
        ? resolved.provider.sessionStateSnapshot(resolved.session.providerSessionId)
        : resolved.provider.interactiveSnapshot
          ? this.sharedInteractiveSnapshot(
              input,
              resolved.provider,
              resolved.session.providerSessionId,
            )
          : readProviderStatus(resolved.provider, resolved.session.providerSessionId),
      resolved.provider.interactions
        ? resolved.provider.interactions.listPendingInteractions(resolved.session.providerSessionId)
        : Promise.resolve({ requests: [], revision: 0 }),
      advertisedCapabilities.queue
        ? this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : Promise.resolve(null),
      advertisedCapabilities.actions?.steer
        ? (resolved.provider
            .steerSupported?.(resolved.session.providerSessionId)
            .catch(() => false) ?? Promise.resolve(false))
        : Promise.resolve(false),
    ]);
    if (snapshot.status === "missing") return null;
    const commandRevision = (snapshot as ProviderSessionStateSnapshot).commandCatalogueRevision;
    if (commandRevision !== undefined) {
      this.commandCatalogues.observeProviderRevision(
        commandCatalogueKey(input.environmentId, input.agent, resolved.session.providerSessionId),
        input.environmentId,
        resolved.provider,
        resolved.session.providerSessionId,
        commandRevision,
      );
    }
    const liveInteractionKinds = normalizeInteractionKinds(
      (snapshot as ProviderSessionStateSnapshot).interactionKinds,
    );
    let capabilities =
      liveInteractionKinds === undefined
        ? advertisedCapabilities
        : { ...advertisedCapabilities, interactions: { kinds: liveInteractionKinds } };
    if (capabilities.actions?.steer && !steerSupported) {
      capabilities = { ...capabilities, actions: { ...capabilities.actions, steer: false } };
    }
    const stateSnapshot = snapshot as ProviderSessionStateSnapshot;
    const lastAssistant = lastAssistantModelRef(
      "messages" in stateSnapshot && Array.isArray(stateSnapshot.messages)
        ? stateSnapshot.messages
        : [],
    );
    const composer = await this.projectionComposer(
      input,
      resolved.session,
      stateSnapshot.composer,
      stateSnapshot.controls,
      true,
      {
        lastAssistantModelId: stateSnapshot.lastAssistantModelId ?? lastAssistant.modelId,
        lastAssistantReasoningId:
          stateSnapshot.lastAssistantReasoningId ?? lastAssistant.reasoningId,
        sessionModelId: stateSnapshot.sessionModelId,
        sessionReasoningId: stateSnapshot.sessionReasoningId,
        // A body-free OpenCode state view may see session.model before the
        // stronger last-assistant evidence arrives with transcript hydration.
        persistSelection:
          !nativeAgentPlatformPolicy(input.agent).infersComposerSelection ||
          !!(stateSnapshot.lastAssistantModelId ?? lastAssistant.modelId),
      },
    );
    const selectedModel = composer.models.find((model) => model.id === composer.selectedModelId);
    // A provider that reports no composer (OpenCode) resolves its model window
    // from the catalogue, which may still be loading on the first state read.
    // Fall back to the usage the last full projection already filled — from
    // whichever representation this tab last read — both to keep the window and
    // to keep the counters when a state read races ahead of the provider's
    // transcript cache.
    const storedContextUsage = [
      this.projectionCache.get(resolved.key)?.projection,
      this.projectionCache.get(`${resolved.key}\0sync-v1`)?.projection,
    ].find(
      (projection) => projection?.sessionId === resolved.session.providerSessionId,
    )?.contextUsage;
    const contextUsage = withProviderContextWindow(
      stateSnapshot.contextUsage ?? storedContextUsage,
      selectedModel?.contextWindow,
      storedContextUsage,
    );
    const blocked = interactionSnapshot.requests.some((request) => request.blocking !== false);
    const providerGeneration =
      this.providerRegistry.connectionIdentity(
        providerCacheKey(input.environmentId, input.agent),
      ) ?? `in-process:${input.agent}`;
    const sourceGeneration = providerGeneration;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (resolved.session.pendingDispatch) {
      this.scheduleAmbiguousDispatchSettle(
        input,
        sessionKey,
        resolved.session.pendingDispatch.requestId,
        resolved.provider,
      );
    }
    if (resolved.session.pendingSteer) {
      this.scheduleAmbiguousSteerSettle(
        input,
        sessionKey,
        resolved.session.pendingSteer.requestId,
        resolved.provider,
      );
    }
    const asyncQuestionResponses = new Map<string, NativeAgentAsyncQuestionResponse>();
    const responsePriority: Record<NativeAgentAsyncQuestionResponse["state"], number> = {
      queued: 1,
      failed: 2,
      dispatching: 3,
      sent: 4,
    };
    const recordResponse = (
      requestId: unknown,
      state: NativeAgentAsyncQuestionResponse["state"],
    ) => {
      if (typeof requestId !== "string") return;
      const itemId = nativeAsyncQuestionItemId(requestId);
      if (!itemId) return;
      const existing = asyncQuestionResponses.get(itemId);
      if (existing && responsePriority[existing.state] >= responsePriority[state]) return;
      asyncQuestionResponses.set(itemId, { itemId, requestId, state });
    };
    for (const requestId of resolved.session.dispatchedRequestIds ?? []) {
      recordResponse(requestId, "sent");
    }
    for (const message of queue?.messages ?? []) {
      recordResponse(
        message && typeof message === "object" ? (message as { id?: unknown }).id : undefined,
        "queued",
      );
    }
    recordResponse(queue?.inFlight?.requestId, "dispatching");
    recordResponse(queue?.dispatchError?.messageId, "failed");
    const notices = visibleProjectionNotices(
      input.agent,
      stateSnapshot.notices,
      sessionIncompleteTurnNotice(resolved.session),
    );
    return {
      identity: this.progressiveIdentity(
        input,
        resolved.session.providerSessionId,
        sourceGeneration,
      ),
      connection: "connected",
      turn: {
        phase:
          stateSnapshot.phase === "cancelling" ||
          stateSnapshot.phase === "recovering" ||
          stateSnapshot.phase === "error"
            ? stateSnapshot.phase
            : blocked
              ? "blocked"
              : (stateSnapshot.phase ??
                (stateSnapshot.status === "error"
                  ? "error"
                  : stateSnapshot.status === "blocked"
                    ? "blocked"
                    : stateSnapshot.status === "running"
                      ? "running"
                      : "idle")),
        ...(stateSnapshot.turnStartedAt === undefined
          ? {}
          : { startedAt: stateSnapshot.turnStartedAt }),
        ...(stateSnapshot.error ? { error: stateSnapshot.error } : {}),
        // Both projection reads carry it, so a progressive refresh cannot
        // strip an indicator the full read just showed.
        ...(stateSnapshot.turnActivity && stateSnapshot.status === "running"
          ? { activity: stateSnapshot.turnActivity }
          : {}),
      },
      interactions: interactionSnapshot.requests,
      // The progressive read feeds the same rendered projection as the full
      // one, so it must apply the identical suppression table.
      composerControls: withoutSuppressedComposerControls(
        input.agent,
        nativeComposerControls(
          composer,
          stateSnapshot.status === "running" || blocked,
          capabilities,
          input.agent,
        ),
      ),
      composer,
      capabilities,
      ...(stateSnapshot.readiness ? { readiness: stateSnapshot.readiness } : {}),
      ...(stateSnapshot.shareUrl === undefined ? {} : { shareUrl: stateSnapshot.shareUrl }),
      ...(stateSnapshot.title ? { title: stateSnapshot.title } : {}),
      ...(queue
        ? {
            queue: {
              items: mergeNativeAgentQueueItems(
                stateSnapshot.providerQueue?.items ?? [],
                queue.messages,
              ),
              ...(queue.inFlight ? { inFlightRequestId: queue.inFlight.requestId } : {}),
              ...(queue.dispatchError
                ? {
                    blocked: {
                      messageId: queue.dispatchError.messageId,
                      error: queue.dispatchError.message,
                    },
                  }
                : {}),
            },
          }
        : stateSnapshot.providerQueue
          ? { queue: stateSnapshot.providerQueue }
          : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...(asyncQuestionResponses.size > 0
        ? { asyncQuestionResponses: [...asyncQuestionResponses.values()] }
        : {}),
      ...((stateSnapshot.policy ?? resolved.session.policy)
        ? { policy: stateSnapshot.policy ?? resolved.session.policy }
        : {}),
      ...(stateSnapshot.rateLimits ? { rateLimits: stateSnapshot.rateLimits } : {}),
      ...(stateSnapshot.runtimeHealthAuthoritative === undefined
        ? {}
        : { runtimeHealthAuthoritative: stateSnapshot.runtimeHealthAuthoritative }),
      notices,
      ...(resolved.session.pendingDispatch || resolved.session.pendingSteer
        ? {
            recoverableDispatch: {
              requestId:
                resolved.session.pendingDispatch?.requestId ??
                resolved.session.pendingSteer!.requestId,
              createdAt:
                resolved.session.pendingDispatch?.createdAt ??
                resolved.session.pendingSteer!.createdAt,
              kind: resolved.session.pendingDispatch ? ("prompt" as const) : ("steer" as const),
              status: this.recoverableDispatchStatus(
                resolved.session.pendingDispatch?.createdAt ??
                  resolved.session.pendingSteer!.createdAt,
                resolved.session.pendingDispatch ? "prompt" : "steer",
              ),
            },
          }
        : {}),
      ...(stateSnapshot.backgroundTasks ? { backgroundTasks: stateSnapshot.backgroundTasks } : {}),
      ...(stateSnapshot.suggestedPrompt ? { suggestedPrompt: stateSnapshot.suggestedPrompt } : {}),
      ...(stateSnapshot.completionBlockedByBackgroundTasks === undefined
        ? {}
        : {
            completionBlockedByBackgroundTasks: stateSnapshot.completionBlockedByBackgroundTasks,
          }),
    };
  }

  async getSessionStateUpdate(
    input: NativeAgentProgressiveInput,
  ): Promise<NativeAgentSessionStateUpdate> {
    this.assertProjectionInput(input);
    if (input.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) {
      throw new Error("Native agent progressive view version is unsupported");
    }
    const key = this.progressiveKey(input, "state");
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.projectionEpochs.get(sessionKey) ?? 0;
    const startedAt = monotonicMs();
    try {
      const value = await this.progressiveReadCovering(
        key,
        sessionKey,
        epoch,
        input.forceSnapshot === true,
        () => this.readProgressiveSessionState(input),
      );
      if (!value) {
        this.recordProgressiveMetric("state", startedAt, "provider", "missing");
        return { viewVersion: 1, status: "missing" };
      }
      const token = createHash("sha256")
        .update(JSON.stringify(value))
        .digest("base64url")
        .slice(0, 43);
      const previous = this.progressiveStateCache.get(key);
      this.progressiveStateCache.delete(key);
      this.progressiveStateCache.set(key, { token, value });
      while (this.progressiveStateCache.size > 128) {
        const oldest = this.progressiveStateCache.keys().next().value as string | undefined;
        if (!oldest || oldest === key) break;
        this.progressiveStateCache.delete(oldest);
      }
      if (!input.forceSnapshot && input.knownToken === token) {
        this.recordProgressiveMetric("state", startedAt, "provider", "unchanged");
        return { viewVersion: 1, status: "unchanged", token, identity: value.identity };
      }
      this.recordProgressiveMetric("state", startedAt, "provider", "snapshot");
      return {
        viewVersion: 1,
        status: "snapshot",
        token,
        value,
        resetReason:
          input.forceSnapshot || !previous
            ? input.forceSnapshot
              ? "forced"
              : "initial"
            : input.knownToken
              ? "unknown-token"
              : "initial",
      };
    } catch (error) {
      this.recordProgressiveMetric("state", startedAt, "provider", "unavailable");
      const cached = this.progressiveStateCache.get(key);
      return {
        viewVersion: 1,
        status: "unavailable",
        retryable: true,
        ...(cached ? { identity: cached.value.identity } : {}),
        error: error instanceof Error ? error.message.slice(0, 4_000) : "Session state unavailable",
      };
    }
  }

  /** Store one discovery section; true when what a view would show changed. */
  private storeProgressiveDiscovery(
    key: string,
    entry: {
      value: unknown;
      availability: "ready" | "stale" | "unavailable";
      expiresAt: number;
      error?: string;
    },
  ): boolean {
    const previous = this.progressiveDiscoveryCache.get(key);
    const semantic = JSON.stringify({
      value: entry.value,
      availability: entry.availability,
      error: entry.error,
    });
    const previousSemantic = previous
      ? JSON.stringify({
          value: previous.value,
          availability: previous.availability,
          error: previous.error,
        })
      : undefined;
    const changed = previousSemantic !== semantic;
    const bytes = Buffer.byteLength(semantic);
    if (previous) this.progressiveDiscoveryBytes -= previous.bytes;
    this.progressiveDiscoveryCache.delete(key);
    this.progressiveDiscoveryCache.set(key, {
      ...entry,
      revision: changed ? (previous?.revision ?? 0) + 1 : (previous?.revision ?? 0),
      bytes,
    });
    this.progressiveDiscoveryBytes += bytes;
    while (
      this.progressiveDiscoveryCache.size > 256 ||
      this.progressiveDiscoveryBytes > 16 * 1024 * 1024
    ) {
      const oldest = this.progressiveDiscoveryCache.keys().next().value as string | undefined;
      if (!oldest || oldest === key) break;
      const removed = this.progressiveDiscoveryCache.get(oldest);
      if (removed) this.progressiveDiscoveryBytes -= removed.bytes;
      this.progressiveDiscoveryCache.delete(oldest);
    }
    return changed;
  }

  private scheduleProgressiveDiscovery(
    input: NativeAgentDiscoveryUpdateInput,
    section: NativeAgentDiscoverySection,
    provider: NativeAgentRuntimeProvider,
    providerSessionId: string,
  ): void {
    const cacheKey = this.progressiveKey(input, `discovery:${section}`);
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.projectionEpochs.get(sessionKey) ?? 0;
    if (this.progressiveReads.has(cacheKey)) return;
    const activeDiscoveryJobs = Array.from(this.progressiveReads.keys()).filter((key) =>
      key.includes("\0progressive-v1\0discovery:"),
    ).length;
    const providerKey = `${input.environmentId}\0${input.agent}\0${String(
      this.providerRegistry.connectionIdentity(
        providerCacheKey(input.environmentId, input.agent),
      ) ?? "in-process",
    )}`;
    if (
      activeDiscoveryJobs >= 4 ||
      (this.progressiveDiscoveryJobsByProvider.get(providerKey) ?? 0) >= 2
    )
      return;
    const read = async (): Promise<unknown> => {
      switch (section) {
        case "models":
          return (await this.refreshProjectionModelCatalog(input.environmentId)).filter(
            (model) => model.platform === input.agent,
          );
        case "commands":
          return this.projectionSlashCommands(input, provider, providerSessionId);
        case "mcp":
          return provider.mcpServers
            ? (await provider.mcpServers(providerSessionId)).slice(0, 512)
            : [];
        case "runtime": {
          const health = provider.runtimeHealth
            ? await provider.runtimeHealth(providerSessionId)
            : { summary: {}, notices: [], authoritative: true };
          return { summary: health.summary, notices: health.notices };
        }
      }
    };
    this.progressiveDiscoveryJobsByProvider.set(
      providerKey,
      (this.progressiveDiscoveryJobsByProvider.get(providerKey) ?? 0) + 1,
    );
    const operation = this.progressiveRead(cacheKey, read);
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled || this.stopped || (this.projectionEpochs.get(sessionKey) ?? 0) !== epoch) return;
      const previous = this.progressiveDiscoveryCache.get(cacheKey);
      const changed = this.storeProgressiveDiscovery(cacheKey, {
        value: previous?.value,
        availability: previous?.value === undefined ? "unavailable" : "stale",
        expiresAt: this.now() + 5_000,
        error: "Discovery timed out",
      });
      if (!changed) return;
      this.storage.announceNativeAgentSessionProjection(input.environmentId, {
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
      });
    }, 2_000);
    void operation
      .then((value) => {
        settled = true;
        clearTimeout(deadline);
        if (this.stopped || (this.projectionEpochs.get(sessionKey) ?? 0) !== epoch) return;
        const changed = this.storeProgressiveDiscovery(cacheKey, {
          value,
          availability: "ready",
          expiresAt: this.now() + 30_000,
        });
        // Every section expires after 30 s and an idle view's own read renews
        // it. Announcing an unchanged renewal would wake that view (and reset
        // its quiet backoff) four times per expiry for nothing: a view reads
        // only values, and they did not change.
        if (!changed) return;
        this.storage.announceNativeAgentSessionProjection(input.environmentId, {
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
        });
      })
      .catch((error) => {
        settled = true;
        clearTimeout(deadline);
        if (this.stopped || (this.projectionEpochs.get(sessionKey) ?? 0) !== epoch) return;
        const previous = this.progressiveDiscoveryCache.get(cacheKey);
        this.storeProgressiveDiscovery(cacheKey, {
          value: previous?.value,
          availability: previous?.value === undefined ? "unavailable" : "stale",
          expiresAt: this.now() + 5_000,
          error: error instanceof Error ? error.message.slice(0, 4_000) : "Discovery unavailable",
        });
      })
      .finally(() => {
        const remaining = Math.max(
          0,
          (this.progressiveDiscoveryJobsByProvider.get(providerKey) ?? 1) - 1,
        );
        if (remaining === 0) this.progressiveDiscoveryJobsByProvider.delete(providerKey);
        else this.progressiveDiscoveryJobsByProvider.set(providerKey, remaining);
      });
  }

  async getDiscoveryUpdate(
    input: NativeAgentDiscoveryUpdateInput,
  ): Promise<NativeAgentDiscoveryUpdate> {
    this.assertProjectionInput(input);
    if (input.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) {
      throw new Error("Native agent progressive view version is unsupported");
    }
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return { viewVersion: 1, status: "missing" };
    const providerGeneration =
      this.providerRegistry.connectionIdentity(
        providerCacheKey(input.environmentId, input.agent),
      ) ?? `in-process:${input.agent}`;
    const identity = this.progressiveIdentity(
      input,
      resolved.session.providerSessionId,
      providerGeneration,
    );
    const sections: NativeAgentDiscoveryView["sections"] = {};
    for (const section of input.sections) {
      const key = this.progressiveKey(input, `discovery:${section}`);
      const cached = this.progressiveDiscoveryCache.get(key);
      const expired = !cached || cached.expiresAt <= this.now();
      if (expired) {
        this.scheduleProgressiveDiscovery(
          input,
          section,
          resolved.provider,
          resolved.session.providerSessionId,
        );
      }
      const state: NativeAgentDiscoverySectionState<unknown> = cached
        ? {
            availability:
              expired && cached.availability === "ready" ? "stale" : cached.availability,
            value: cached.value,
            revision: cached.revision,
            ...(cached.error ? { error: cached.error } : {}),
          }
        : { availability: "loading", revision: 0 };
      if (section === "commands") {
        // The richer catalogue state rides beside the generic availability so a
        // composer can tell ready-empty, unsupported and stale apart.
        const catalogue = this.commandCatalogues.peek(
          commandCatalogueKey(input.environmentId, input.agent, resolved.session.providerSessionId),
        );
        const unsupported = !nativeCapabilities(input.agent).slashCommands;
        const detail = unsupported ? unsupportedCommandCatalogueState() : catalogue?.state;
        if (catalogue && !unsupported) {
          // The first discovery job may have cached only session actions while
          // a slow catalogue was still loading. Publish rows and state from
          // the same authoritative snapshot when that read finishes, rather
          // than keeping the empty placeholder until the discovery TTL ends.
          Object.assign(state, {
            value: withSessionActionSlashCommands(
              catalogue.commands,
              nativeCapabilities(input.agent),
            ),
            revision: catalogue.state.revision,
            availability:
              catalogue.state.status === "loading"
                ? "loading"
                : catalogue.state.status === "unavailable"
                  ? "unavailable"
                  : catalogue.state.status === "stale"
                    ? "stale"
                    : "ready",
          });
        }
        if (detail) Object.assign(state, { catalogue: detail });
      }
      Object.assign(sections, { [section]: state });
    }
    const value: NativeAgentDiscoveryView = { identity, sections };
    const token = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("base64url")
      .slice(0, 43);
    if (!input.forceSnapshot && input.knownToken === token) {
      return { viewVersion: 1, status: "unchanged", token, identity };
    }
    return {
      viewVersion: 1,
      status: "snapshot",
      token,
      value,
      resetReason: input.forceSnapshot ? "forced" : input.knownToken ? "unknown-token" : "initial",
    };
  }

  async getProjectionUpdate(
    input: NativeAgentProjectionUpdateInput,
  ): Promise<NativeAgentProjectionUpdate> {
    this.assertProjectionInput(input);
    const projection = await this.refreshProjection(
      { ...input, messageLimit: NATIVE_SYNC_LIVE_MESSAGES, representation: "sync-v1" },
      true,
    );
    if (!projection) return { syncVersion: 1, status: "missing" };
    const projectionBytes = encodedBytesWithMessages(projection);
    if (projectionBytes > NATIVE_SYNC_MAX_SNAPSHOT_BYTES) {
      throw new ProviderUnavailableError("Native agent sync projection exceeded 20 MiB");
    }
    const key = this.syncCacheKey(input);
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const history = this.projectionHistory.get(sessionKey);
    const historyEpoch = history?.epoch ?? "unavailable";
    const historyComplete = history?.complete ?? false;
    const historyCursor = this.firstHistoryCursor(sessionKey, projection);
    const { token, identityChanged } = this.recordSyncProjection(
      key,
      projection,
      historyEpoch,
      historyCursor,
    );
    if (!input.forceSnapshot && input.knownToken === token) {
      return { syncVersion: 1, status: "unchanged", token };
    }
    const state = this.projectionSync.get(key)!;
    const base = input.knownToken
      ? state.revisions.find((entry) => entry.token === input.knownToken)
      : undefined;
    if (!input.forceSnapshot && base) {
      const delta = this.projectionDelta(
        base.projection,
        projection,
        new Set(
          (history?.messages ?? [])
            .map((message) => (message as { id?: unknown })?.id)
            .filter((id): id is string => typeof id === "string"),
        ),
      );
      const operationCount =
        delta.messageUpserts.length +
        delta.deletedMessageIds.length +
        (delta.liveMessageIds?.length ?? 0) +
        Object.keys(delta.setFields).length +
        delta.unsetFields.length;
      const deltaBytes = encodedBytesWithMessages({
        ...delta,
        messages: delta.messageUpserts,
        messageUpserts: [],
      });
      const snapshotBytes = projectionBytes;
      if (
        operationCount <= NATIVE_SYNC_MAX_DELTA_OPERATIONS &&
        deltaBytes <= NATIVE_SYNC_MAX_DELTA_BYTES &&
        deltaBytes < snapshotBytes
      ) {
        return {
          syncVersion: 1,
          status: "delta",
          baseToken: input.knownToken!,
          token,
          delta,
          historyEpoch,
          historyComplete,
          ...(historyCursor ? { historyCursor } : {}),
        };
      }
    }
    return {
      syncVersion: 1,
      status: "snapshot",
      token,
      projection,
      historyEpoch,
      historyComplete,
      ...(historyCursor ? { historyCursor } : {}),
      resetReason: input.forceSnapshot
        ? "forced"
        : identityChanged
          ? "identity-changed"
          : input.knownToken
            ? base
              ? "expired"
              : "unknown-token"
            : "initial",
    };
  }

  async getMessagePage(input: NativeAgentMessagePageInput): Promise<NativeAgentMessagePage> {
    this.assertProjectionInput(input);
    if (input.before.length > 1024) throw new Error("History cursor is too large");
    const direct = await this.directMessagePage(input);
    if (direct) return direct;
    const projection = await this.refreshProjection(
      { ...input, messageLimit: NATIVE_SYNC_LIVE_MESSAGES, representation: "sync-v1" },
      true,
    );
    if (!projection) throw new Error("Native agent history is unavailable");
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const history = this.projectionHistory.get(sessionKey);
    if (!history) throw new Error("Native agent history is unavailable");
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(input.before, "base64url").toString("utf8"));
    } catch {
      throw new Error("Native agent history cursor is invalid");
    }
    const record = cursor as Record<string, unknown>;
    if (
      !record ||
      record.v !== 1 ||
      record.key !== createHash("sha256").update(sessionKey).digest("hex").slice(0, 24) ||
      record.session !==
        createHash("sha256").update(history.sessionId).digest("hex").slice(0, 24) ||
      record.epoch !== history.epoch ||
      typeof record.before !== "string"
    ) {
      throw new Error("Native agent history cursor expired");
    }
    const beforeIndex = history.messages.findIndex(
      (message) =>
        typeof (message as { id?: unknown }).id === "string" &&
        createHash("sha256")
          .update((message as { id: string }).id)
          .digest("base64url")
          .slice(0, 32) === record.before,
    );
    if (beforeIndex < 0) throw new Error("Native agent history cursor expired");
    const limit = Math.min(
      input.limit ?? NATIVE_HISTORY_PAGE_DEFAULT_MESSAGES,
      NATIVE_HISTORY_PAGE_MAX_MESSAGES,
    );
    const targetBytes = Math.min(
      input.targetBytes ?? NATIVE_HISTORY_PAGE_DEFAULT_BYTES,
      NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES,
    );
    const candidates = history.messages.slice(Math.max(0, beforeIndex - limit), beforeIndex);
    let bounded = this.boundedProjectedMessages(candidates, limit, targetBytes);
    // A row larger than the target on its own is sent whole, up to the same
    // ceiling a bridge page uses: the next cursor starts before this row, so
    // any parts trimmed from its front could never be paged back.
    if (bounded.messages.length === 1 && bounded.window.omittedParts !== undefined) {
      bounded = this.boundedProjectedMessages(
        candidates.slice(-1),
        1,
        Math.max(targetBytes, BRIDGE_PAGE_OVERSIZED_ROW_MAX_BYTES),
      );
    }
    const first = bounded.messages[0] as { id?: unknown } | undefined;
    const firstIndex = first
      ? history.messages.findIndex((message) => (message as { id?: unknown }).id === first.id)
      : beforeIndex;
    const nextCursor =
      first && typeof first.id === "string" && firstIndex > 0
        ? this.historyCursor(sessionKey, first.id, history.epoch, history.sessionId)
        : undefined;
    return {
      syncVersion: 1,
      messages: bounded.messages,
      historyEpoch: history.epoch,
      ...(nextCursor ? { nextCursor } : {}),
      complete: history.complete,
      truncated: Boolean(nextCursor) || !history.complete,
    };
  }

  /**
   * Serve a direct (provider-positioned) page, or undefined for a joined-
   * history cursor. No projection refresh, composer or interaction read, and
   * no fingerprint pass over earlier pages: validate the owner, then answer
   * from the page cache while the cursor's epoch is still the session's
   * current one, or read and project only that range.
   */
  private async directMessagePage(
    input: NativeAgentMessagePageInput,
  ): Promise<NativeAgentMessagePage | undefined> {
    let peek: unknown;
    try {
      peek = JSON.parse(Buffer.from(input.before, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if ((peek as { v?: unknown } | null)?.v !== 2) return undefined;
    const startedAt = monotonicMs();
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent history is unavailable");
    const providerSessionId = resolved.session.providerSessionId;
    const cursor = decodeHistoryCursor(input.before, {
      sessionKey: resolved.key,
      providerSessionId,
    });
    if (cursor.version !== 2) throw new Error("Native agent history cursor expired");
    const transcriptPage = resolved.provider.transcriptPage?.bind(resolved.provider);
    if (!transcriptPage) {
      throw new Error("Native agent history cursor expired");
    }
    const limit = Math.min(
      input.limit ?? NATIVE_HISTORY_PAGE_DEFAULT_MESSAGES,
      NATIVE_HISTORY_PAGE_MAX_MESSAGES,
    );
    const targetBytes = Math.min(
      input.targetBytes ?? NATIVE_HISTORY_PAGE_DEFAULT_BYTES,
      NATIVE_HISTORY_PAGE_MAX_TARGET_BYTES,
    );
    const pageKey = [
      resolved.key,
      providerSessionId,
      cursor.epoch,
      cursor.providerCursor,
      limit,
      targetBytes,
    ].join("\0");
    const cached = this.directHistoryPages.lookup(
      resolved.key,
      providerSessionId,
      cursor.epoch,
      pageKey,
      this.now(),
    );
    // Cached pages hold provider rows only; publications are placed on the
    // way out, so a ledger change never leaves a stale page behind.
    const withArtifacts = (page: NativeAgentMessagePage): NativeAgentMessagePage => ({
      ...page,
      messages: overlayArtifactParts(page.messages, this.artifactOverlay(input)).slice(),
    });
    if (cached) {
      if (this.restoreDetailRegistrations(resolved.key, cached.details)) {
        this.recordProgressiveMetric("transcript", startedAt, "memory", "cached");
        return withArtifacts(cached.page);
      }
      // An inline detail body was evicted; only a fresh read registers it again.
      this.directHistoryPages.delete(pageKey);
    }
    const { page } = await this.directHistoryPages.load(
      { sessionKey: resolved.key, providerSessionId, epoch: cursor.epoch, key: pageKey },
      async () => {
        const sourceStartedAt = monotonicMs();
        const providerPage = await transcriptPage(providerSessionId, {
          cursor: cursor.providerCursor,
          limit,
          targetBytes,
        });
        const sourceMs = monotonicMs() - sourceStartedAt;
        // An epoch the provider no longer holds is a rewritten history. The
        // renderer resets and re-reads rather than stitching pages from two
        // histories together.
        if (
          !providerPage ||
          providerPage.status !== "page" ||
          providerPage.historyEpoch !== cursor.epoch
        ) {
          this.recordProgressiveMetric("transcript", startedAt, "provider", "missing", {
            sourceMs,
          });
          throw new Error("Native agent history cursor expired");
        }
        const normalizeStartedAt = monotonicMs();
        const details: ProjectionDetailRegistration[] = [];
        const sink = this.detailRegistrations;
        this.detailRegistrations = details;
        let projected: { messages: unknown[] };
        try {
          /*
           * The provider already bounded the page, so this projection must
           * not drop a row of it: the row would fall between two cursors.
           * Only the hard transcript bound applies to the page as a whole.
           */
          projected = this.projectionMessages(
            resolved.key,
            providerPage.messages,
            Math.max(limit, providerPage.messages.length),
            NATIVE_PROJECTION_MAX_BYTES,
            resolved.session.initialPromptPresentation,
            Boolean(coordinatorIdFromRuntimeId(input.environmentId)),
            { providerSessionId },
          );
        } finally {
          this.detailRegistrations = sink;
        }
        const normalizeMs = monotonicMs() - normalizeStartedAt;
        if (projected.messages.length !== providerPage.messages.length) {
          throw new Error("Native agent history page exceeded its bound");
        }
        /*
         * A bridge sends a row larger than the page target whole, up to its
         * oversized-row ceiling, and projection only shrinks it. A provider
         * that pages raw rows (OpenCode) can still hand over one larger than
         * that — an inline attachment the projection keeps. Trim that row on
         * its own rather than refuse the page: refusing wedged the walk on it
         * forever, while a trimmed row still lets every older page load.
         */
        let trimmedRow = false;
        const pageMessages = projected.messages.map((message) => {
          if (encodedValue(message).bytes <= DIRECT_PAGE_ROW_MAX_BYTES) return message;
          const bounded = boundTranscriptResponse(
            [message as { content: string; parts: unknown[] }],
            DIRECT_PAGE_ROW_MAX_BYTES,
            { envelopeReserveBytes: 0, contentFallbackBytes: 64 * 1024 },
          );
          trimmedRow = true;
          return bounded.messages[0] ?? message;
        });
        const nextCursor = providerPage.historyCursor
          ? encodeDirectHistoryCursor({
              sessionKey: resolved.key,
              providerSessionId,
              historyEpoch: cursor.epoch,
              providerCursor: providerPage.historyCursor,
            })
          : undefined;
        if (providerPage.historyCursor && !nextCursor) {
          throw new Error("Native agent history cursor expired");
        }
        this.recordProgressiveMetric("transcript", startedAt, "provider", "snapshot", {
          sourceMs,
          normalizeMs,
        });
        const page: NativeAgentMessagePage = {
          syncVersion: 1,
          messages: pageMessages,
          historyEpoch: cursor.epoch,
          ...(nextCursor ? { nextCursor } : {}),
          complete: !nextCursor && providerPage.complete,
          truncated:
            Boolean(nextCursor) || !providerPage.complete || providerPage.truncated || trimmedRow,
        };
        const detailBytes = details.reduce(
          (total, detail) => total + 64 + detail.ref.length + (detail.remote?.locator.length ?? 0),
          0,
        );
        return {
          value: { page, details },
          bytes: encodedArrayBytes(page.messages) + detailBytes + (nextCursor?.length ?? 0) + 256,
        };
      },
      () => this.now(),
    );
    // Callers share the cached page; each gets its own message array.
    return withArtifacts(page);
  }

  /**
   * Fetch the exact provider body behind a summary locator. The bridge checks
   * the body still has the digest the summary was minted with, so this either
   * returns that revision or reports it gone — never a newer body under an
   * old reference.
   */
  private async resolveRemoteToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
    entry: {
      sessionKey: string;
      remote?: { providerSessionId: string; locator: string; resolved: boolean };
      bytes: number;
    },
  ): Promise<NativeAgentToolDetails> {
    const remote = entry.remote!;
    const provider = await this.provider(input);
    const result = provider.transcriptDetail
      ? await provider.transcriptDetail(remote.providerSessionId, remote.locator)
      : undefined;
    if (!result || result.status === "missing" || result.status === "expired") {
      // The cache may have evicted (and already un-counted) this entry while
      // the read was in flight; only remove what is still ours.
      if (this.toolDetailCache.get(input.detailRef) === entry) {
        this.toolDetailCache.delete(input.detailRef);
        this.toolDetailCacheBytes -= entry.bytes;
      }
      throw new Error("Native agent tool details are no longer available");
    }
    const details: NativeAgentToolDetails =
      result.status === "ok"
        ? { detailRef: input.detailRef, ...result.detail }
        : {
            detailRef: input.detailRef,
            toolError: "Tool details exceeded the deferred display limit.",
          };
    const bytes = Buffer.byteLength(JSON.stringify(details)) + remote.locator.length + 64;
    const current = this.toolDetailCache.get(input.detailRef);
    if (current === entry) {
      this.toolDetailCacheBytes += bytes - entry.bytes;
      this.toolDetailCache.set(input.detailRef, {
        sessionKey: entry.sessionKey,
        details,
        bytes,
        remote: { ...remote, resolved: true },
      });
      this.pruneToolDetailCache();
    }
    return details;
  }

  async getProjectionToolDetails(
    input: NativeAgentProjectionInput & { detailRef: string },
  ): Promise<NativeAgentToolDetails> {
    this.assertProjectionInput(input);
    if (!nonBlank(input.detailRef) || input.detailRef.length > 128) {
      throw new Error("Native agent tool detail reference is invalid");
    }
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    let entry = this.toolDetailCache.get(input.detailRef);
    if (!entry || entry.sessionKey !== sessionKey) {
      this.pinnedToolDetailRefs.add(input.detailRef);
      try {
        // Rebuild details from the bounded retained history as well as the
        // live tail. Otherwise expanding an older paged row after detail-cache
        // eviction could never make its reference resolvable again.
        await this.refreshProjection(
          { ...input, messageLimit: NATIVE_SYNC_LIVE_MESSAGES, representation: "sync-v1" },
          true,
        );
        entry = this.toolDetailCache.get(input.detailRef);
      } finally {
        this.pinnedToolDetailRefs.delete(input.detailRef);
        this.pruneToolDetailCache();
      }
    }
    if (!entry || entry.sessionKey !== sessionKey) {
      throw new Error("Native agent tool details are no longer available");
    }
    this.toolDetailCache.delete(input.detailRef);
    this.toolDetailCache.set(input.detailRef, entry);
    if (entry.remote && !entry.remote.resolved) {
      // Two views expanding the same row share one provider read. The key is
      // the session-scoped reference, so sharing never crosses sessions.
      const shared = this.remoteToolDetailReads.get(input.detailRef);
      if (shared) return shared;
      const read = this.resolveRemoteToolDetails(input, entry).finally(() => {
        if (this.remoteToolDetailReads.get(input.detailRef) === read) {
          this.remoteToolDetailReads.delete(input.detailRef);
        }
      });
      this.remoteToolDetailReads.set(input.detailRef, read);
      return read;
    }
    if (!entry.localImagePath) return entry.details;

    // The renderer presents only the opaque, session-scoped reference. The
    // path came from the provider transcript and cannot be replaced by the
    // caller, so this grants one exact lazy read instead of widening a shared
    // directory such as /tmp into a renderer-readable root.
    const bytes = await readReadableHostFile(entry.localImagePath, [
      path.dirname(entry.localImagePath),
    ]);
    return {
      ...entry.details,
      fileDataUrl: `data:${imageMimeType(entry.localImagePath)};base64,${bytes.toString("base64")}`,
    };
  }

  /**
   * Resolve the transcript window for one refresh.
   *
   * Callers that ask for a bigger window raise it; callers that ask for nothing
   * inherit the window the session already had. Clamped so a renderer cannot
   * ask the provider for an unbounded transcript.
   */
  protected resolveMessageLimit(
    requested: number | undefined,
    previous: number | undefined,
  ): number {
    const candidate = requested ?? previous ?? NATIVE_PROJECTION_MAX_MESSAGES;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      return NATIVE_PROJECTION_MAX_MESSAGES;
    }
    return Math.min(candidate, NATIVE_PROJECTION_MAX_WINDOW_MESSAGES);
  }

  protected async projectionComposer(
    input: NativeAgentProjectionInput,
    session: PersistedNativeAgentSession,
    providerComposer?: NativeAgentComposerState,
    providerControls?: NativeAgentControlUpdate,
    discoveryInBackground = false,
    hints: {
      lastAssistantModelId?: string;
      lastAssistantReasoningId?: string;
      sessionModelId?: string;
      sessionReasoningId?: string;
      persistSelection?: boolean;
    } = {},
  ): Promise<NativeAgentComposerState> {
    let models = providerComposer?.models ?? [];
    if (models.length === 0) {
      const cached = this.modelCatalogCache.get(input.environmentId);
      if (cached) {
        models = cached.models.filter((model) => model.platform === input.agent);
        if (cached.expiresAt <= this.now()) {
          // Model discovery can probe several runtimes and take seconds. An
          // expired entry is still perfectly adequate for rendering the
          // transcript and existing picker selection, so refresh it out of the
          // transcript-critical path. The next projection poll observes the
          // refreshed catalogue.
          void this.refreshProjectionModelCatalog(input.environmentId)
            .then((refreshed) => {
              // The same catalogue changes no view; announcing it would wake
              // every idle view of the environment once per TTL.
              if (!this.stopped && JSON.stringify(refreshed) !== JSON.stringify(cached.models)) {
                this.storage.announceNativeAgentSessionProjection(input.environmentId);
              }
            })
            .catch(() => {
              const retained = this.modelCatalogCache.get(input.environmentId);
              if (retained === cached) {
                retained.expiresAt = this.now() + NATIVE_DISCOVERY_RETRY_MS;
              }
            });
        }
      } else {
        const refresh = this.refreshProjectionModelCatalog(input.environmentId);
        if (discoveryInBackground) {
          void refresh
            .then(() => {
              if (!this.stopped) {
                this.storage.announceNativeAgentSessionProjection(input.environmentId, {
                  agent: input.agent,
                  logicalSessionKey: input.logicalSessionKey,
                });
              }
            })
            .catch(() => undefined);
        } else {
          try {
            const bounded = await refresh;
            models = bounded.filter((model) => model.platform === input.agent);
          } catch {
            // A stale or unavailable catalog must not hide the transcript.
          }
        }
      }
    }
    const sessionSelectionHints =
      nativeAgentPlatformPolicy(input.agent).infersComposerSelection === true;
    const selectedModelId = resolveNativeComposerModelId({
      providerControlsModelId: providerControls?.modelId,
      sessionControlsModelId: session.controls?.modelId,
      ...(sessionSelectionHints
        ? {
            lastAssistantModelId: hints.lastAssistantModelId,
            sessionModelId: hints.sessionModelId,
            inferredModelId: session.inferredComposerSelection?.modelId,
          }
        : {}),
      catalogDefaultModelId: providerComposer?.selectedModelId,
      firstCatalogModelId: models[0]?.id,
    });
    if (
      nativeAgentPlatformPolicy(input.agent).runsSessionHeldModel === true &&
      selectedModelId &&
      models.length > 0 &&
      !models.some((model) => model.id === selectedModelId)
    ) {
      models = [...models, heldSessionModel(input.agent, selectedModelId)];
    }
    const resolvedSelection = withResolvedNativeComposerModel(models, selectedModelId, input.agent);
    models = resolvedSelection.models;
    const selectedModel = resolvedSelection.selectedModel;
    if (hints.persistSelection && sessionSelectionHints) {
      const persist = inferredComposerSelectionToPersist({
        sessionControlsModelId: session.controls?.modelId,
        lastAssistantModelId: hints.lastAssistantModelId,
        lastAssistantReasoningId: hints.lastAssistantReasoningId,
        sessionModelId: hints.sessionModelId,
        sessionReasoningId: hints.sessionReasoningId,
      });
      if (persist) {
        void this.storage
          .initializeNativeAgentSessionInferredComposerIfAbsent(
            session.key,
            session.providerSessionId,
            persist,
          )
          .catch(() => undefined);
      }
    }
    const storedReasoningId =
      providerControls?.reasoningId ??
      session.controls?.reasoningId ??
      (sessionSelectionHints
        ? (hints.lastAssistantReasoningId ??
          hints.sessionReasoningId ??
          session.inferredComposerSelection?.reasoningId)
        : undefined) ??
      providerComposer?.selectedReasoningId ??
      // The advertised default matters for Cursor/Grok, where it carries the
      // agent's own current effort rather than a static catalog value.
      resolveReasoningId(
        selectedModel?.reasoning ?? [],
        undefined,
        selectedModel?.defaultReasoningId,
      ) ??
      selectedModel?.defaultReasoningId;
    const selectedReasoningId =
      input.agent === "claude"
        ? claudeReasoningSelection(storedReasoningId, session.controls?.parameterValues)
        : storedReasoningId;
    const capabilities = nativeCapabilities(input.agent);
    // The compose bar renders `fastModeAvailable` directly, so the table has to
    // be consulted here and not only in `nativeComposerControls`. Without it a
    // provider that grew a fast surface would show the toggle on a platform the
    // table says has none, and `updateProjectionControls` would then accept the
    // patch because its own guard reads this same field.
    const supportsSpeed =
      capabilities.composer.speed &&
      (providerComposer?.fastModeAvailable === true || selectedModel?.supportsSpeed === true);
    const executionProfiles = capabilities.composer.executionProfile
      ? (providerComposer?.executionProfiles ?? [])
      : [];
    // A session created before a platform's Build/Plan pair was reclassified as
    // an execution profile still carries `controls.mode`. That value was already
    // dispatched as the provider's agent name, so it names the same thing the
    // profile now names; without this the upgraded session silently falls back
    // to the provider default and runs a different agent than the user chose.
    const legacyModeProfileId = !capabilities.composer.mode ? session.controls?.mode : undefined;
    const storedExecutionProfileId =
      providerControls?.executionProfileId ??
      session.controls?.executionProfileId ??
      providerComposer?.selectedExecutionProfileId ??
      legacyModeProfileId;
    // Only drop the stored selection when the provider actually told us which
    // profiles exist. An empty list means the agent listing failed or has not
    // arrived, and the stored id is then the best evidence we have — discarding
    // it there would swap the user's agent for the provider default on a
    // transient read. A non-empty list that omits the id is different: that id
    // demonstrably does not exist, and sending it would fail the dispatch.
    const profilesAreKnown = executionProfiles.length > 0;
    const selectedExecutionProfileId =
      capabilities.composer.executionProfile &&
      storedExecutionProfileId !== undefined &&
      (!profilesAreKnown ||
        executionProfiles.some((profile) => profile.id === storedExecutionProfileId))
        ? storedExecutionProfileId
        : undefined;
    const approvalModes = nativeAgentApprovalModes(input.agent, session.policy);
    const selectedApprovalModeId = resolveNativeAgentApprovalMode(
      input.agent,
      session.policy,
      providerControls?.approvalMode ?? session.controls?.approvalMode,
    );
    return {
      models,
      ...(resolvedSelection.selectedModelId
        ? { selectedModelId: resolvedSelection.selectedModelId }
        : selectedModel
          ? { selectedModelId: selectedModel.id }
          : {}),
      ...(selectedReasoningId
        ? {
            selectedReasoningId,
          }
        : {}),
      fastModeAvailable: supportsSpeed,
      fastModeEnabled: supportsSpeed
        ? (providerControls?.fastMode ??
          session.controls?.fastMode ??
          providerComposer?.fastModeEnabled ??
          false)
        : null,
      ...(capabilities.composer.mode
        ? {
            selectedModeId:
              providerControls?.mode ??
              session.controls?.mode ??
              providerComposer?.selectedModeId ??
              "build",
          }
        : {}),
      modes: capabilities.composer.mode
        ? providerComposer?.modes.length
          ? providerComposer.modes
          : [
              { id: "build", label: "Build" },
              { id: "plan", label: "Plan" },
            ]
        : [],
      // Execution profiles were previously copied across whenever the provider
      // reported any, so a platform whose table says `executionProfile: false`
      // would grow the control the moment its bridge started listing agents.
      ...(executionProfiles.length ? { executionProfiles } : {}),
      ...(selectedExecutionProfileId ? { selectedExecutionProfileId } : {}),
      ...(capabilities.composer.localSettings
        ? {
            includeLocalSettings:
              providerControls?.includeLocalSettings ??
              session.controls?.includeLocalSettings ??
              providerComposer?.includeLocalSettings ??
              false,
          }
        : {}),
      ...(capabilities.composer.promptSuggestions
        ? {
            promptSuggestionsEnabled:
              providerControls?.promptSuggestions ??
              session.controls?.promptSuggestions ??
              providerComposer?.promptSuggestionsEnabled ??
              false,
          }
        : {}),
      ...(providerComposer?.parameterValues ||
      session.controls?.parameterValues ||
      providerControls?.parameterValues
        ? {
            parameterValues: {
              ...providerComposer?.parameterValues,
              ...session.controls?.parameterValues,
              ...providerControls?.parameterValues,
            },
          }
        : {}),
      ...(providerComposer?.persistedDefaults === undefined
        ? {}
        : { persistedDefaults: providerComposer.persistedDefaults }),
      ...(approvalModes.length > 0 && selectedApprovalModeId
        ? { approvalModes, selectedApprovalModeId }
        : {}),
    };
  }

  protected refreshProjectionModelCatalog(environmentId: string): Promise<AgentModel[]> {
    const pending = this.modelCatalogRefreshes.get(environmentId);
    if (pending) return pending.operation;
    const validity = { current: true };
    const operation = (async () => {
      const catalog = await this.invoke<AgentModel[]>("get_native_agent_model_catalog", {
        environmentId,
      });
      const bounded = Array.isArray(catalog) ? catalog.slice(0, 512) : [];
      if (!validity.current) {
        throw new ProviderUnavailableError("Model catalog refresh was invalidated");
      }
      if (
        !this.modelCatalogCache.has(environmentId) &&
        this.modelCatalogCache.size >= NATIVE_MODEL_CATALOG_CACHE_LIMIT
      ) {
        const oldest = this.modelCatalogCache.keys().next().value as string | undefined;
        if (oldest) this.modelCatalogCache.delete(oldest);
      }
      this.modelCatalogCache.set(environmentId, {
        models: bounded,
        expiresAt: this.now() + NATIVE_MODEL_CATALOG_TTL_MS,
      });
      return bounded;
    })();
    const entry = { operation, validity };
    this.modelCatalogRefreshes.set(environmentId, entry);
    return operation.finally(() => {
      if (this.modelCatalogRefreshes.get(environmentId) === entry) {
        this.modelCatalogRefreshes.delete(environmentId);
      }
    });
  }

  /**
   * Provider command rows plus their catalogue state, without session actions.
   *
   * Session actions are merged by the caller *after* runtime qualification, so
   * an unqualified `/steer` never shadows (or deletes) a provider command.
   */
  protected async projectionCommandCatalogue(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
    sessionId?: string,
  ): Promise<CommandCatalogueSnapshot> {
    const capabilities = nativeCapabilities(input.agent);
    if (!capabilities.slashCommands || (!provider.slashCommands && !provider.commandCatalogue)) {
      return { commands: [], state: unsupportedCommandCatalogueState() };
    }
    return this.commandCatalogues.read(
      commandCatalogueKey(input.environmentId, input.agent, sessionId),
      input.environmentId,
      provider,
      sessionId,
    );
  }

  /** Command rows as a composer sees them: provider commands plus runtime actions. */
  protected async projectionSlashCommands(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
    sessionId?: string,
  ): Promise<NativeAgentSlashCommand[]> {
    const snapshot = await this.projectionCommandCatalogue(input, provider, sessionId);
    return withSessionActionSlashCommands(snapshot.commands, nativeCapabilities(input.agent));
  }

  protected invalidateProjection(key: string): void {
    this.stopNotices.delete(key);
    const keys = [key, `${key}\0sync-v1`];
    for (const candidate of keys) {
      this.projectionCache.delete(candidate);
      const sync = this.projectionSync.get(candidate);
      if (sync) this.projectionSyncBytes -= sync.revisionBytes;
      this.projectionSync.delete(candidate);
      this.projectionEpochs.set(candidate, (this.projectionEpochs.get(candidate) ?? 0) + 1);
    }
    const history = this.projectionHistory.get(key);
    if (history) this.projectionHistoryBytes -= history.bytes;
    this.projectionHistory.delete(key);
    // Rewind, resume and replacement all land here: nothing kept for the old
    // history may be reused, and a page read still in flight is not admitted.
    this.projectedMessages.forgetSession(key);
    this.directHistoryPages.forgetSession(key);
    // The identity behind this key changed, so the grace the previous session
    // had spent says nothing about the new one. A tab that resumes into a
    // different provider session starts its reconnect from a full window.
    this.projectionMissingSince.delete(key);
    const progressivePrefix = `${key}\0progressive-v1\0`;
    for (const candidate of Array.from(this.progressiveTranscriptCache.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      const entry = this.progressiveTranscriptCache.get(candidate);
      if (entry) this.progressiveTranscriptBytes -= entry.bytes;
      this.progressiveTranscriptCache.delete(candidate);
      this.progressiveSourceTokens.delete(candidate);
    }
    for (const candidate of Array.from(this.progressiveHydrations.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      const timer = this.progressiveHydrationTimers.get(candidate);
      if (timer) clearTimeout(timer);
      this.progressiveHydrationTimers.delete(candidate);
      this.progressiveHydrations.delete(candidate);
    }
    for (const candidate of Array.from(this.progressiveStateCache.keys())) {
      if (candidate.startsWith(progressivePrefix)) this.progressiveStateCache.delete(candidate);
    }
    for (const candidate of Array.from(this.progressiveDiscoveryCache.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      const entry = this.progressiveDiscoveryCache.get(candidate);
      if (entry) this.progressiveDiscoveryBytes -= entry.bytes;
      this.progressiveDiscoveryCache.delete(candidate);
    }
    for (const candidate of Array.from(this.interactiveSnapshotShares.keys())) {
      if (candidate.startsWith(`${key}\0`)) this.interactiveSnapshotShares.delete(candidate);
    }
    /*
     * Only transcript and state reads are covered by `progressiveReadCovering`,
     * so only they have a trailing read that can consume — and then clear — a
     * follow-up marker. Marking a discovery key would strand it: discovery goes
     * through `progressiveRead` directly, never reaches the trailing path, and
     * the stranded marker would block `pruneProjectionEpoch` forever. Discovery
     * needs no marker anyway; its cache entries were dropped above, so the next
     * read reschedules it.
     */
    for (const candidate of Array.from(this.progressiveReads.keys())) {
      if (!candidate.startsWith(progressivePrefix)) continue;
      if (candidate.includes("\0progressive-v1\0discovery:")) continue;
      this.progressiveDirtyFollowUps.set(candidate, this.projectionEpochs.get(key) ?? 0);
    }
  }

  /**
   * Drop the epoch counter for a key that is neither cached nor being read.
   *
   * The epoch only means anything relative to a read that captured it, so once
   * a key has no cache entry and no in-flight refresh, restarting it at zero is
   * indistinguishable from keeping it. Without this the map would outlive every
   * bound `projectionCache` enforces and grow with key churn for the life of
   * the process.
   */
  protected pruneProjectionEpoch(key: string): void {
    if (this.projectionCache.has(key)) return;
    if (this.projectionRefreshes.has(key)) return;
    const progressivePrefix = `${key}\0progressive-v1\0`;
    if (
      Array.from(this.progressiveReads.keys()).some((candidate) =>
        candidate.startsWith(progressivePrefix),
      ) ||
      Array.from(this.progressiveTrailing.keys()).some((candidate) =>
        candidate.startsWith(progressivePrefix),
      ) ||
      Array.from(this.progressiveDirtyFollowUps.keys()).some((candidate) =>
        candidate.startsWith(progressivePrefix),
      )
    ) {
      return;
    }
    this.projectionEpochs.delete(key);
    this.projectionMissingSince.delete(key);
  }

  protected refreshProjection(
    input: NativeAgentProjectionInput,
    force: boolean,
    resolvedSession?: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
      transient: true;
    },
  ): Promise<NativeAgentSessionProjection | null> {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const key = input.representation === "sync-v1" ? `${sessionKey}\0sync-v1` : sessionKey;
    const previousRefresh = this.projectionRefreshes.get(key);
    const epoch = this.projectionEpochs.get(key) ?? 0;
    const signature = JSON.stringify({
      messageLimit: input.messageLimit ?? null,
      refreshUsage: input.refreshUsage === true,
      representation: input.representation ?? "legacy",
      force,
    });
    const previousDescriptor = this.projectionRefreshDescriptors.get(key);
    if (
      previousRefresh &&
      previousDescriptor?.epoch === epoch &&
      previousDescriptor.signature === signature
    ) {
      return previousRefresh;
    }
    const operation = (async () => {
      if (previousRefresh) await previousRefresh.catch(() => undefined);
      const coveredEpoch = this.projectionEpochs.get(key) ?? epoch;
      return this.refreshProjectionOnce(input, force, key, coveredEpoch, resolvedSession);
    })();
    this.projectionRefreshes.set(key, operation);
    this.projectionRefreshDescriptors.set(key, { epoch, signature });
    return operation.finally(() => {
      if (this.projectionRefreshes.get(key) === operation) {
        this.projectionRefreshes.delete(key);
        this.projectionRefreshDescriptors.delete(key);
      }
      this.pruneProjectionEpoch(key);
    });
  }

  protected async refreshProjectionOnce(
    input: NativeAgentProjectionInput,
    force: boolean,
    key: string,
    epoch: number,
    resolvedSession?: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
      transient: true;
    },
  ): Promise<NativeAgentSessionProjection | null> {
    const previous = this.projectionCache.get(key);
    const messageLimit = this.resolveMessageLimit(input.messageLimit, previous?.input.messageLimit);
    const windowed: NativeAgentProjectionInput = { ...input, messageLimit };
    if (!force && previous && previous.input.messageLimit === messageLimit) {
      return previous.projection;
    }
    let generation = previous?.generation ?? `unresolved:${input.agent}`;
    let transient = resolvedSession?.transient ?? false;
    try {
      const resolved = resolvedSession ?? (await this.resolveProjectionSession(input));
      if (!resolved) {
        if ((this.projectionEpochs.get(key) ?? 0) === epoch) {
          this.projectionCache.delete(key);
          const sync = this.projectionSync.get(key);
          if (sync) this.projectionSyncBytes -= sync.revisionBytes;
          this.projectionSync.delete(key);
          if (input.representation === "sync-v1") {
            const historyKey = nativeAgentSessionStorageKey(
              input.environmentId,
              input.agent,
              input.logicalSessionKey,
            );
            const history = this.projectionHistory.get(historyKey);
            if (history) this.projectionHistoryBytes -= history.bytes;
            this.projectionHistory.delete(historyKey);
          }
          this.projectionMissingSince.delete(key);
        }
        return null;
      }
      transient = resolved.transient;
      generation =
        this.providerRegistry.connectionIdentity(
          providerCacheKey(input.environmentId, input.agent),
        ) ?? `in-process:${input.agent}`;
      const advertisedCapabilities = nativeCapabilities(input.agent);
      // User-triggered supplementary metadata. A billing endpoint failure
      // must not make an otherwise healthy transcript unavailable. Merge the
      // value below after the ordinary snapshot resolves.
      const refreshedUsage = input.refreshUsage
        ? await resolved.provider
            .refreshUsage?.(resolved.session.providerSessionId)
            .catch(() => undefined)
        : undefined;
      // These reads describe independent parts of one projection. Keeping
      // them serial made a transcript wait for every approval, queue and slash
      // command round trip in turn, even though none produces message text.
      const snapshotPromise: Promise<ProviderInteractiveSnapshot> = resolved.provider
        .interactiveSnapshot
        ? resolved.provider.interactiveSnapshot(resolved.session.providerSessionId)
        : (async () => ({
            // A terminal turn error belongs in the projection as `error` plus
            // its detail, not as a thrown read that would report the whole
            // runtime as unreachable.
            ...(await readProviderStatus(resolved.provider, resolved.session.providerSessionId)),
            messages: await resolved.provider.messages(resolved.session.providerSessionId),
          }))();
      const interactionSnapshotPromise = resolved.provider.interactions
        ? resolved.provider.interactions.listPendingInteractions(resolved.session.providerSessionId)
        : Promise.resolve({ requests: [], revision: 0 });
      const queuePromise = advertisedCapabilities.queue
        ? this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : Promise.resolve(null);
      const slashCommandsPromise = this.projectionCommandCatalogue(
        input,
        resolved.provider,
        resolved.session.providerSessionId,
      ).catch((): CommandCatalogueSnapshot => ({
        commands: [],
        state: { status: "unavailable", revision: 0, enhanced: false },
      }));
      const steerSupportedPromise = advertisedCapabilities.actions?.steer
        ? (resolved.provider
            .steerSupported?.(resolved.session.providerSessionId)
            .catch(() => false) ?? Promise.resolve(false))
        : Promise.resolve(false);
      const mcpPromise =
        resolved.provider.mcpServers?.(resolved.session.providerSessionId).catch(() => []) ??
        Promise.resolve([]);
      const [snapshot, interactionSnapshot, queue, commandCatalogue, steerSupported, mcpServers] =
        await Promise.all([
          snapshotPromise,
          interactionSnapshotPromise,
          queuePromise,
          slashCommandsPromise,
          steerSupportedPromise,
          mcpPromise,
        ]);
      const steerQualified =
        !advertisedCapabilities.actions?.steer || steerSupported
          ? advertisedCapabilities
          : {
              ...advertisedCapabilities,
              actions: {
                ...advertisedCapabilities.actions,
                steer: false,
              },
            };
      // A live session's own answer wins over the platform table. The table
      // says what a platform *may* raise; a Pi session with its approval gate
      // off raises nothing, and reporting the platform's list there would
      // promise approvals that can never arrive.
      const liveInteractionKinds = normalizeInteractionKinds(snapshot.interactionKinds);
      const capabilities =
        liveInteractionKinds === undefined
          ? steerQualified
          : { ...steerQualified, interactions: { kinds: liveInteractionKinds } };
      if (snapshot.commandCatalogueRevision !== undefined) {
        this.commandCatalogues.observeProviderRevision(
          commandCatalogueKey(input.environmentId, input.agent, resolved.session.providerSessionId),
          input.environmentId,
          resolved.provider,
          resolved.session.providerSessionId,
          snapshot.commandCatalogueRevision,
        );
      }
      // Runtime actions are merged only after this exact bridge has qualified
      // them: an unproven steering surface never advertises `/steer`, and a
      // provider's own same-named command is kept rather than deleted.
      const slashCommands = withSessionActionSlashCommands(commandCatalogue.commands, capabilities);
      if (snapshot.providerGeneration !== undefined) {
        generation = `${generation}:${String(snapshot.providerGeneration)}`;
      }
      if (snapshot.status === "missing") {
        /*
         * The mapping is real and the bridge is up; it just does not hold this
         * session yet (a restart that has not finished restoring, an idle
         * detach). Stamping `connection: "error"` on the first such read made
         * the renderer flash Connection Failed on a tab that was about to
         * attach, so the first few stay connecting and let the next poll find
         * it.
         *
         * The grace is counted, not open-ended. Nothing on this path re-creates
         * a provider session and the connecting overlay carries no retry
         * control, so a session that really is gone has to end up reported —
         * with its detail — rather than on a spinner the user cannot leave.
         */
        const since = this.projectionMissingSince.get(key) ?? this.now();
        this.projectionMissingSince.set(key, since);
        const projection: NativeAgentSessionProjection =
          this.now() - since >= NATIVE_MISSING_SESSION_GRACE_MS
            ? this.unreachableProjection(
                previous,
                input,
                generation,
                "The native agent runtime no longer holds this session. " +
                  "Retry to start a new one.",
                resolved.session.providerSessionId,
              )
            : {
                ...(previous?.projection ?? {
                  platform: input.agent,
                  environmentId: input.environmentId,
                  sessionId: resolved.session.providerSessionId,
                  messages: [],
                  interactions: [],
                  composerControls: [],
                  capabilities,
                  revision: 0,
                  generation,
                }),
                connection: "connecting",
                turn: { phase: "recovering" },
                notices: [
                  {
                    kind: "recovery",
                    message: "Reconnecting to the native agent runtime…",
                  },
                ],
                revision: 0,
                generation,
              };
        return this.commitProjection(key, windowed, projection, generation, epoch, !transient);
      }
      // The session answered, so this key's run of missing reads is over. Left
      // set, a later transient miss would inherit a spent deadline and report a
      // reconnect that is still in its first moment as a failure.
      this.projectionMissingSince.delete(key);
      const blocked = interactionSnapshot.requests.some((request) => request.blocking !== false);
      const lastAssistant = lastAssistantModelRef(snapshot.messages);
      const composer = await this.projectionComposer(
        input,
        resolved.session,
        snapshot.composer,
        snapshot.controls,
        false,
        {
          lastAssistantModelId: lastAssistant.modelId,
          lastAssistantReasoningId: lastAssistant.reasoningId,
          sessionModelId: snapshot.sessionModelId,
          sessionReasoningId: snapshot.sessionReasoningId,
          persistSelection: !transient,
        },
      );
      const selectedModel = composer.models.find((model) => model.id === composer.selectedModelId);
      const previousContextUsage =
        previous?.projection.sessionId === resolved.session.providerSessionId
          ? previous.projection.contextUsage
          : undefined;
      const mergedContextUsage = mergeContextUsageTurns(
        previousContextUsage,
        mergeContextUsageTurns(snapshot.contextUsage, refreshedUsage),
      );
      const contextUsage = withProviderContextWindow(
        mergedContextUsage,
        selectedModel?.contextWindow,
      );
      const sessionKey = nativeAgentSessionStorageKey(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      );
      const normalized = this.projectionMessages(
        sessionKey,
        snapshot.messages,
        input.representation === "sync-v1" ? NATIVE_PROJECTION_MAX_WINDOW_MESSAGES : messageLimit,
        NATIVE_PROJECTION_MAX_BYTES,
        resolved.session.initialPromptPresentation,
        resolved.session.owner?.kind === "coordinator",
        undefined,
        this.artifactOverlay(input),
      );
      const transcript =
        input.representation === "sync-v1"
          ? this.boundedProjectedMessages(
              normalized.messages,
              NATIVE_SYNC_LIVE_MESSAGES,
              NATIVE_SYNC_LIVE_TARGET_BYTES,
            )
          : normalized;
      const stopNotice = this.stopNotices.get(sessionKey);
      const terminalNotices = [
        ...(snapshot.notices ?? []).filter(
          (notice) => notice.kind === "error" || notice.kind === "stopped",
        ),
        ...(snapshot.error &&
        !(snapshot.notices ?? []).some(
          (notice) => notice.kind === "error" && notice.message === snapshot.error,
        )
          ? [{ kind: "error" as const, message: snapshot.error }]
          : []),
        ...(stopNotice ? [{ kind: "stopped" as const, message: stopNotice }] : []),
      ];
      if (stopNotice) this.stopNotices.delete(sessionKey);
      const messageIds = new Set(
        transcript.messages.map((message) => (message as { id?: unknown })?.id),
      );
      // A provider that already renders its failure inline (OpenCode today)
      // ends the transcript with an inline error row; a second terminal row
      // would repeat it.
      const lastMessageId = (transcript.messages.at(-1) as { id?: unknown } | undefined)?.id;
      const inlineError = isNativeInlineErrorMessageId(lastMessageId)
        ? (transcript.messages.at(-1) as { content?: unknown })
        : undefined;
      const terminalMessages = terminalNotices
        .filter(
          (notice) =>
            notice.kind !== "error" ||
            typeof inlineError?.content !== "string" ||
            (inlineError.content !== notice.message &&
              !inlineError.content.endsWith(`: ${notice.message}`)),
        )
        .map((notice) => ({
          id: `native-terminal:${notice.kind}:${createHash("sha256")
            .update(notice.message)
            .digest("hex")
            .slice(0, 16)}`,
          role: "system" as const,
          content: notice.message,
          parts: [{ type: "text" as const, content: notice.message }],
          // Provider terminal metadata does not consistently carry a time.
          // A fixed value keeps repeated authoritative reads byte-stable.
          createdAt: "1970-01-01T00:00:00.000Z",
        }))
        .filter((message) => {
          if (messageIds.has(message.id)) return false;
          messageIds.add(message.id);
          return true;
        });
      const messagesWithNotices = [...transcript.messages, ...terminalMessages];
      const renderedTranscript = { messages: messagesWithNotices, window: transcript.window };
      const fallbackTitle = transcript.messages.flatMap((candidate) => {
        const message = candidate as { role?: unknown; content?: unknown };
        if (message.role !== "user" || typeof message.content !== "string") return [];
        // Name the session after the user's own words, not provider-only guidance.
        const normalized = stripSystemInstructions(message.content).replace(/\s+/g, " ").trim();
        return normalized ? [normalized.slice(0, 80)] : [];
      })[0];
      const snapshotTitle = snapshot.title?.trim();
      // "Agent Session" is the title this service creates every provider
      // session with, and "Session 1a2b3c" is Claude's own; neither names the
      // conversation. Left in place they stay its title in the resume list, so
      // every OpenCode conversation read "Agent Session" there.
      const placeholderTitle =
        snapshotTitle === "Agent Session" ||
        (input.agent === "claude" && /^Session [a-f0-9]{6}$/i.test(snapshotTitle ?? ""));
      const projectionTitle =
        (!placeholderTitle && snapshotTitle) || fallbackTitle || snapshotTitle;
      if (
        projectionTitle &&
        (!snapshotTitle || placeholderTitle) &&
        resolved.provider.setSessionTitle &&
        !resolved.transient &&
        this.pushedSessionTitles.get(sessionKey) !== projectionTitle
      ) {
        this.pushedSessionTitles.set(sessionKey, projectionTitle);
        void resolved.provider
          .setSessionTitle(resolved.session.providerSessionId, projectionTitle)
          .catch(() => undefined);
      }
      if (input.representation === "sync-v1") {
        const historyIds = new Set(
          normalized.messages
            .map((message) => (message as { id?: unknown })?.id)
            .filter((id): id is string => typeof id === "string"),
        );
        const firstLiveId = (
          renderedTranscript.messages.find((message) =>
            historyIds.has((message as { id?: unknown })?.id as string),
          ) as { id?: unknown } | undefined
        )?.id;
        const mutableTailStart =
          typeof firstLiveId === "string"
            ? normalized.messages.findIndex(
                (message) => (message as { id?: unknown })?.id === firstLiveId,
              )
            : normalized.messages.length;
        this.updateProjectionHistory(
          sessionKey,
          resolved.session.providerSessionId,
          normalized.messages,
          Math.max(0, mutableTailStart),
          snapshot.messagesComplete !== false && !normalized.window.truncated,
        );
      }
      if (input.agent === "codex" && !resolved.transient) {
        const attentionItemIds = renderedTranscript.messages.flatMap((message) => {
          const record = message as { parts?: unknown };
          if (!Array.isArray(record.parts)) return [];
          return record.parts.flatMap((part) => {
            if (!part || typeof part !== "object") return [];
            const candidate = part as {
              type?: unknown;
              asyncQuestion?: { itemId?: unknown };
            };
            return candidate.type === "async-question" &&
              typeof candidate.asyncQuestion?.itemId === "string"
              ? [candidate.asyncQuestion.itemId]
              : [];
          });
        });
        try {
          await this.recordAsyncQuestionAttention(
            input.environmentId,
            resolved.session.key,
            attentionItemIds,
          );
        } catch (error) {
          // Attention is auxiliary projection metadata. A deleted environment
          // or transient persistence failure must not make its transcript
          // unreadable.
          console.warn(
            `[native-agent] Could not record async-question attention for ${input.environmentId}:`,
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
      // Reading the projection is the only moment a parked dispatch is
      // reliably revisited, so it is where the provider gets asked whether the
      // prompt landed after all. A record that outlived the backend generation
      // that created it is settled here instead of waiting for the user.
      if (!resolved.transient && resolved.session.pendingDispatch) {
        this.scheduleAmbiguousDispatchSettle(
          input,
          key,
          resolved.session.pendingDispatch.requestId,
          resolved.provider,
        );
      }
      if (!resolved.transient && resolved.session.pendingSteer) {
        this.scheduleAmbiguousSteerSettle(
          input,
          key,
          resolved.session.pendingSteer.requestId,
          resolved.provider,
        );
      }
      const asyncQuestionResponses = new Map<string, NativeAgentAsyncQuestionResponse>();
      const asyncQuestionResponsePriority: Record<
        NativeAgentAsyncQuestionResponse["state"],
        number
      > = {
        queued: 1,
        failed: 2,
        dispatching: 3,
        sent: 4,
      };
      const recordAsyncQuestionResponse = (
        requestId: unknown,
        state: NativeAgentAsyncQuestionResponse["state"],
      ) => {
        if (typeof requestId !== "string") return;
        const itemId = nativeAsyncQuestionItemId(requestId);
        if (!itemId) return;
        const existing = asyncQuestionResponses.get(itemId);
        if (
          existing &&
          asyncQuestionResponsePriority[existing.state] >= asyncQuestionResponsePriority[state]
        )
          return;
        asyncQuestionResponses.set(itemId, { itemId, requestId, state });
      };
      for (const requestId of resolved.session.dispatchedRequestIds ?? []) {
        recordAsyncQuestionResponse(requestId, "sent");
      }
      for (const message of queue?.messages ?? []) {
        recordAsyncQuestionResponse(
          message && typeof message === "object" ? (message as { id?: unknown }).id : undefined,
          "queued",
        );
      }
      recordAsyncQuestionResponse(queue?.inFlight?.requestId, "dispatching");
      recordAsyncQuestionResponse(queue?.dispatchError?.messageId, "failed");
      const notices = visibleProjectionNotices(
        input.agent,
        snapshot.notices,
        sessionIncompleteTurnNotice(resolved.session),
      );

      const projection: NativeAgentSessionProjection = {
        platform: input.agent,
        environmentId: input.environmentId,
        sessionId: resolved.session.providerSessionId,
        messageWindow: renderedTranscript.window,
        ...(projectionTitle ? { title: projectionTitle } : {}),
        ...(snapshot.shareUrl === undefined ? {} : { shareUrl: snapshot.shareUrl }),
        connection: "connected",
        turn: {
          phase:
            snapshot.phase === "cancelling" ||
            snapshot.phase === "recovering" ||
            snapshot.phase === "error"
              ? snapshot.phase
              : blocked
                ? "blocked"
                : (snapshot.phase ??
                  (snapshot.status === "error"
                    ? "error"
                    : snapshot.status === "running"
                      ? "running"
                      : "idle")),
          ...(snapshot.turnStartedAt === undefined ? {} : { startedAt: snapshot.turnStartedAt }),
          ...(snapshot.error ? { error: snapshot.error } : {}),
          ...(snapshot.turnActivity && snapshot.status === "running"
            ? { activity: snapshot.turnActivity }
            : {}),
        },
        messages: renderedTranscript.messages,
        interactions: interactionSnapshot.requests,
        // Remove the provider-specific controls the compact input bar does not
        // own. Both projection reads apply the same shared table, so a control
        // hidden on this path cannot reappear on the progressive one.
        composerControls: withoutSuppressedComposerControls(
          input.agent,
          nativeComposerControls(
            composer,
            snapshot.status === "running" || blocked,
            capabilities,
            input.agent,
          ),
        ),
        composer,
        ...(snapshot.readiness ? { readiness: snapshot.readiness } : {}),
        capabilities,
        ...(slashCommands.length > 0 ? { slashCommands } : {}),
        slashCommandCatalogue: commandCatalogue.state,
        ...(queue
          ? {
              queue: {
                items: mergeNativeAgentQueueItems(
                  snapshot.providerQueue?.items ?? [],
                  queue.messages,
                ),
                ...(queue.inFlight ? { inFlightRequestId: queue.inFlight.requestId } : {}),
                ...(queue.dispatchError
                  ? {
                      blocked: {
                        messageId: queue.dispatchError.messageId,
                        error: queue.dispatchError.message,
                      },
                    }
                  : {}),
              },
            }
          : snapshot.providerQueue
            ? { queue: snapshot.providerQueue }
            : {}),
        ...(asyncQuestionResponses.size > 0
          ? { asyncQuestionResponses: [...asyncQuestionResponses.values()] }
          : {}),
        ...(contextUsage ? { contextUsage } : {}),
        ...((snapshot.policy ?? resolved.session.policy)
          ? { policy: snapshot.policy ?? resolved.session.policy }
          : {}),
        ...(snapshot.rateLimits ? { rateLimits: snapshot.rateLimits } : {}),
        ...(snapshot.runtimeHealthAuthoritative === undefined
          ? {}
          : { runtimeHealthAuthoritative: snapshot.runtimeHealthAuthoritative }),
        ...(snapshot.runtime || mcpServers.length > 0
          ? {
              runtime: {
                ...snapshot.runtime,
                ...(mcpServers.length > 0
                  ? { mcpServers: mcpServers.length, mcp: mcpServers }
                  : {}),
              },
            }
          : {}),
        ...(notices.length > 0 ? { notices } : {}),
        ...(resolved.session.pendingDispatch || resolved.session.pendingSteer
          ? {
              recoverableDispatch: {
                requestId:
                  resolved.session.pendingDispatch?.requestId ??
                  resolved.session.pendingSteer!.requestId,
                createdAt:
                  resolved.session.pendingDispatch?.createdAt ??
                  resolved.session.pendingSteer!.createdAt,
                kind: resolved.session.pendingDispatch ? ("prompt" as const) : ("steer" as const),
                status: this.recoverableDispatchStatus(
                  resolved.session.pendingDispatch?.createdAt ??
                    resolved.session.pendingSteer!.createdAt,
                  resolved.session.pendingDispatch ? "prompt" : "steer",
                ),
              },
            }
          : {}),
        ...(snapshot.backgroundTasks ? { backgroundTasks: snapshot.backgroundTasks } : {}),
        ...(snapshot.suggestedPrompt ? { suggestedPrompt: snapshot.suggestedPrompt } : {}),
        ...(snapshot.completionBlockedByBackgroundTasks === undefined
          ? {}
          : {
              completionBlockedByBackgroundTasks: snapshot.completionBlockedByBackgroundTasks,
            }),
        ...(capabilities.fork
          ? {
              turnBoundaries: renderedTranscript.messages.flatMap((candidate) => {
                const message = candidate as Record<string, unknown>;
                return typeof message.id === "string"
                  ? [
                      {
                        turnId: typeof message.turnId === "string" ? message.turnId : message.id,
                        messageId: message.id,
                        resumable: capabilities.resume,
                        forkable: true,
                      },
                    ]
                  : [];
              }),
            }
          : {}),
        revision: 0,
        generation,
        cursor:
          snapshot.providerRevision === undefined ? undefined : String(snapshot.providerRevision),
      };
      return this.commitProjection(key, windowed, projection, generation, epoch, !transient);
    } catch (error) {
      return this.commitProjection(
        key,
        windowed,
        this.unreachableProjection(
          previous,
          input,
          generation,
          error instanceof Error ? error.message : "Native agent is unavailable",
        ),
        generation,
        epoch,
        !transient,
      );
    }
  }

  /**
   * The projection for a session this backend cannot read right now.
   *
   * `error` is the only connection state the renderer gives a retry control and
   * failure text to, so every terminally unreachable path lands here rather
   * than leaving a tab on an overlay it has no way to leave. Whatever was last
   * cached stays underneath it: the transcript the user was reading is still
   * the best description of the conversation, and a reconnect that succeeds
   * should not have to rebuild it from nothing.
   */
  protected unreachableProjection(
    previous: NativeAgentProjectionCacheEntry | undefined,
    input: NativeAgentProjectionInput,
    generation: string,
    error: string,
    sessionId?: string,
  ): NativeAgentSessionProjection {
    return {
      ...(previous?.projection ?? {
        platform: input.agent,
        environmentId: input.environmentId,
        ...(sessionId ? { sessionId } : {}),
        messages: [],
        interactions: [],
        composerControls: [],
        capabilities: nativeCapabilities(input.agent),
        revision: 0,
        generation,
      }),
      connection: "error",
      turn: { phase: "recovering", error },
      notices: [
        {
          kind: "recovery",
          message: "Reconnecting to the native agent runtime…",
        },
      ],
      revision: 0,
      generation,
    };
  }

  /**
   * Allocate the next revision for one logical session, whatever representation
   * asked for it.
   *
   * The renderer treats `revision` as a single ordering within a generation, so
   * the legacy full projection and the sync-v1 live tail must draw from the
   * same sequence. A counter that was never recorded — or was evicted — is
   * re-seeded from whatever is still cached for this session, so a restart
   * cannot hand back a revision a client already holds.
   */
  protected nextProjectionRevision(sessionKey: string, generation: string): number {
    const record = this.projectionRevisions.get(sessionKey);
    let previous = record?.generation === generation ? record.revision : 0;
    if (record?.generation !== generation) {
      for (const candidate of [sessionKey, `${sessionKey}\0sync-v1`]) {
        const cached = this.projectionCache.get(candidate);
        if (cached?.generation === generation) {
          previous = Math.max(previous, cached.projection.revision);
        }
      }
    }
    const revision = previous + 1;
    this.projectionRevisions.delete(sessionKey);
    this.projectionRevisions.set(sessionKey, { generation, revision });
    while (this.projectionRevisions.size > NATIVE_PROJECTION_REVISION_LIMIT) {
      const oldest = this.projectionRevisions.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === sessionKey) break;
      this.projectionRevisions.delete(oldest);
    }
    return revision;
  }

  protected commitProjection(
    key: string,
    input: NativeAgentProjectionInput,
    candidate: NativeAgentSessionProjection,
    generation: string,
    epoch: number,
    announce = true,
  ): NativeAgentSessionProjection {
    if ((this.projectionEpochs.get(key) ?? 0) !== epoch) {
      /*
       * This read lost a race with a mutation that replaced the tab's provider
       * identity, so it must not become the cached authoritative state. It is
       * still a real answer though: `null` is reserved for "this logical tab
       * resolves to no provider session", and returning it here would make an
       * ordinary resume look like a deleted session to any caller that does not
       * fence reads itself. Hand back the newest committed projection, or the
       * uncommitted candidate at revision 0 when nothing is cached yet.
       */
      return (
        this.projectionCache.get(key)?.projection ?? {
          ...candidate,
          revision: 0,
          generation,
          cursor: `${generation}:0`,
        }
      );
    }
    const previous = this.projectionCache.get(key);
    const fingerprint = JSON.stringify({
      ...candidate,
      revision: 0,
      cursor: candidate.cursor,
    });
    if (previous && previous.generation === generation && previous.fingerprint === fingerprint) {
      return previous.projection;
    }
    const revision = this.nextProjectionRevision(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      generation,
    );
    const projection = {
      ...candidate,
      revision,
      generation,
      cursor: `${generation}:${revision}`,
    };
    if (!previous && this.projectionCache.size >= NATIVE_PROJECTION_CACHE_LIMIT) {
      const oldest = this.projectionCache.keys().next().value as string | undefined;
      /*
       * Capacity eviction is not an identity change: bumping the evicted key's
       * epoch would fence an unrelated in-flight read for it and report that
       * session as missing. Drop the entry only, and reclaim its epoch when no
       * read is relying on it.
       */
      if (oldest) {
        this.projectionCache.delete(oldest);
        const sync = this.projectionSync.get(oldest);
        if (sync) this.projectionSyncBytes -= sync.revisionBytes;
        this.projectionSync.delete(oldest);
        this.projectionMissingSince.delete(oldest);
        this.pruneProjectionEpoch(oldest);
      }
    }
    this.projectionCache.set(key, {
      input: { ...input },
      projection,
      fingerprint,
      generation,
    });
    if (announce) {
      this.storage.announceNativeAgentSessionProjection(input.environmentId, {
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
      });
    }
    return projection;
  }

  // ---- from native-agent-service-prompt.ts ----
  sessionActivitySnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): AgentActivityState | "unknown" {
    const observed = this.observedSessionActivity.get(
      nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
    );
    return observed?.state ?? "unknown";
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
    const observed = this.observedSessionActivity.get(
      nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
    );
    if (!observed) return "unknown";
    return observed.state === "working" && observed.readyForInput === true
      ? "idle"
      : observed.state;
  }

  /**
   * Whether one environment's bridge has an in-flight dispatch or a session
   * last observed working, waiting, or running background tasks.
   *
   * Uses the raw state, not the turn view: replacing the bridge kills its whole
   * process tree, so a backgrounded test run or dev server is lost just like a
   * turn. Purely in-memory apart from the session list; never reads a bridge.
   */
  async hasObservedLiveWork(environmentId: string, agent: BuildPipelineAgent): Promise<boolean> {
    const provider = this.providerRegistry.cached(providerCacheKey(environmentId, agent));
    if (provider && this.providerRegistry.hasDispatchInFlight(provider)) return true;
    const sessions = await this.storage.listNativeAgentSessions();
    return sessions.some((session) => {
      if (session.environmentId !== environmentId || session.agent !== agent) return false;
      const observed = this.observedSessionActivity.get(session.key);
      if (!observed || observed.providerSessionId !== session.providerSessionId) return false;
      return observed.state === "working" || observed.state === "waiting";
    });
  }

  sessionPresentationSnapshot(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
  ): { presence: AgentActivityState | "unknown"; title?: string } {
    const sessionKey = nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey);
    const projection =
      this.projectionCache.get(`${sessionKey}\0sync-v1`)?.projection ??
      this.projectionCache.get(sessionKey)?.projection;
    return {
      presence: this.sessionActivitySnapshot(environmentId, agent, logicalSessionKey),
      ...(projection?.title ? { title: projection.title } : {}),
    };
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
    const sessionKey = nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey);
    return (
      this.projectionCache.get(`${sessionKey}\0sync-v1`)?.projection ??
      this.projectionCache.get(sessionKey)?.projection ??
      null
    );
  }

  /** Bounded retry bookkeeping for on-demand turn-outcome reads. */
  protected readonly turnOutcomeAttempts = new Map<string, { attempts: number; retryAt: number }>();
  /** Short-lived cache of on-demand pending-interaction reads, per session. */
  protected readonly pendingInteractionReads = new Map<
    string,
    { at: number; requests: AgentInteractionRequest[] }
  >();

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
      const interruptKey = `${key}\0${input.requestId}`;
      const interrupt = this.pendingTurnInterrupts.get(interruptKey);
      if (interrupt?.providerSessionId === session.providerSessionId) {
        try {
          await this.storage.recordNativeAgentTurnInterrupt(
            key,
            session.providerSessionId,
            input.requestId,
          );
          this.pendingTurnInterrupts.delete(interruptKey);
        } catch {
          /* Retain the fence and retry on the next observation. */
        }
        return { outcome: "interrupted" as const };
      }
      if (session.interruptedRequestIds?.includes(input.requestId))
        return { outcome: "interrupted" as const };
      if (this.interruptFenceOverflow) return { outcome: "unknown" as const };
      const ids = session.dispatchedRequestIds ?? [];
      if (!ids.includes(input.requestId)) return { outcome: "unknown" as const };
      if (ids.at(-1) !== input.requestId) return { outcome: "superseded" as const };
      if (
        this.pendingSessionMutations.has(key) ||
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
    const activity = this.sessionTurnActivitySnapshot(
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
  protected beginArtifactTurn(
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

  protected settleArtifactTurn(
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
  protected async recordObservedTurnOutcome(
    session: PersistedNativeAgentSession,
    status: string,
    detail: string | undefined,
    provider?: Pick<NativeAgentRuntimeProvider, "turnTerminalError">,
  ): Promise<void> {
    const requestId = session.dispatchedRequestIds?.at(-1);
    if (!requestId || session.turnOutcomes?.some((entry) => entry.requestId === requestId)) return;
    if (status !== "idle" && status !== "error") return;
    let failure = status === "error" ? detail : undefined;
    if (status === "idle") {
      const activity = this.sessionTurnActivitySnapshot(
        session.environmentId,
        session.agent,
        session.logicalSessionKey,
      );
      if (activity === "working" || activity === "waiting") return;
      if (provider?.turnTerminalError) {
        try {
          failure =
            (await provider.turnTerminalError(session.providerSessionId, requestId)) ?? undefined;
        } catch {
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

  /**
   * Pending interactions of one session, for linking to the request whose turn
   * is waiting. Reads the provider's pending-interaction list at most once per
   * ten seconds per session (callers ask only while a turn is `waiting`),
   * falling back to the in-memory projection; `null` when neither is known.
   */
  protected forgetPendingInteractions(key: string): void {
    this.pendingInteractionReads.delete(key);
  }

  async sessionPendingInteractions(
    input: NativeAgentProjectionInput,
  ): Promise<AgentInteractionRequest[] | null> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const live = (requests: readonly AgentInteractionRequest[]) =>
      requests.filter((request) => request.state === "pending" || request.state === "answering");
    const cached = this.pendingInteractionReads.get(key);
    if (cached && cached.at > this.now() - 10_000) return live(cached.requests);
    const fallback = () => {
      const projection = this.cachedProjectionSnapshot(
        input.environmentId,
        input.agent,
        input.logicalSessionKey,
      );
      return projection?.interactions ? live(projection.interactions) : null;
    };
    try {
      const session = await this.storage.getNativeAgentSession(key);
      if (!session) return null;
      const provider = await this.observeProvider(input);
      if (!provider?.interactions) return fallback();
      const snapshot = await provider.interactions.listPendingInteractions(
        session.providerSessionId,
      );
      if (!cached && this.pendingInteractionReads.size >= 128) {
        const oldest = this.pendingInteractionReads.keys().next().value;
        if (oldest !== undefined) this.pendingInteractionReads.delete(oldest);
      }
      this.pendingInteractionReads.set(key, { at: this.now(), requests: snapshot.requests });
      return live(snapshot.requests);
    } catch {
      return fallback();
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
    if (this.composeDraftHoldsQueue(draft?.value)) return "draft";
    if (
      session?.pendingDispatch ||
      (queue && (queue.inFlight !== undefined || queue.messages.length > 0))
    ) {
      return "working";
    }
    const activity = this.sessionTurnActivitySnapshot(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
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
      else if (await this.settleAmbiguousDispatch(candidate, key, input.requestId)) {
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
          if (this.composeDraftHoldsQueue(draft?.value)) {
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
          const observed = this.sessionTurnActivitySnapshot(
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

  protected async dispatchPromptInternal(
    input: DispatchNativeAgentPromptInput,
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
    persistAmbiguousDispatch = false,
    mailInject = false,
  ): Promise<PersistedNativeAgentSession> {
    const releaseAgentWork = beginEnvironmentAgentWork(input.environmentId);
    try {
      return await this.withSessionMutationFence(input, () =>
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
      assertEnvironmentAcceptsAgentWork(input.environmentId);
      const hasAttachments =
        (input.images?.length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0;
      if ((!nonBlank(input.prompt) && !hasAttachments) || !nonBlank(input.requestId)) {
        throw new Error("Native agent prompt or attachment and request ID must not be blank");
      }
      const session = await this.ensureSession(input);
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
        const result = await this.storage.dispatchNativeAgentPromptOnce(
          session.key,
          input.requestId,
          async (durable) => {
            const preparation = prepare
              ? await prepare(durable, provider)
              : { dispatch: true as const };
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
              this.observedSessionActivity.set(durable.key, {
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
  protected async planDispatchCommand(
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
    const key = commandCatalogueKey(input.environmentId, input.agent, session.providerSessionId);
    const read = async (force: boolean) =>
      supported
        ? this.commandCatalogues.readForDispatch(
            key,
            input.environmentId,
            provider,
            session.providerSessionId,
            force,
          )
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
  protected async performCommandSessionAction(
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
    this.invalidateProjection(session.key);
    if (outcome.outcome !== "applied") {
      throw new PromptRejectedError(
        outcome.outcome === "idle"
          ? `${label} had nothing to compact.`
          : `${label} did not confirm the compaction. Check the transcript before retrying.`,
      );
    }
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
    return this.queueScheduling?.status() ?? null;
  }

  wakeEnvironment(environmentId: string): void {
    this.queueScheduling?.wakeEnvironment(environmentId);
  }

  async reconcileScheduling() {
    return this.queueScheduling ? this.queueScheduling.reconcileNow() : null;
  }

  notifyPromptQueueChanged(queueKey: string): void {
    if (this.stopped || !nonBlank(queueKey)) return;
    // Index the key so a busy session's queue keeps its 2 s due check.
    this.queueScheduling?.wakeQueue(queueKey, "enqueue");
    void this.drainPromptQueue(queueKey);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribeObservationWakeups?.();
    this.unsubscribeObservationWakeups = null;
    if (this.launchTimer) clearInterval(this.launchTimer);
    this.launchTimer = null;
    this.queueScheduling?.stop();
    this.queueScheduling = null;
    if (this.interactionTimer) clearInterval(this.interactionTimer);
    this.interactionTimer = null;
    await Promise.allSettled([
      ...this.projectionRefreshes.values(),
      ...[...this.modelCatalogRefreshes.values()].map((entry) => entry.operation),
      this.commandCatalogues.settle(),
    ]);
    await this.settleAndClearProgressiveReads();
    await Promise.allSettled(this.scanTasks);
    while (
      this.launchTasks.size > 0 ||
      this.queueTasks.size > 0 ||
      this.turnRecovery.pendingTasks().length > 0
    ) {
      await Promise.allSettled([
        ...this.launchTasks.values(),
        ...this.queueTasks.values(),
        ...this.turnRecovery.pendingTasks(),
      ]);
    }
    await this.providerRegistry.shutdown();
    this.observations.clear();
    this.turnRecovery.clear();
    this.modelCatalogCache.clear();
    this.commandCatalogues.clear();
    this.modelCatalogRefreshes.clear();
    this.projectionCache.clear();
    this.projectionSync.clear();
    this.projectionSyncBytes = 0;
    this.projectionHistory.clear();
    this.projectionHistoryBytes = 0;
    this.toolDetailCache.clear();
    this.pinnedToolDetailRefs.clear();
    this.toolDetailCacheBytes = 0;
    this.projectionRefreshes.clear();
    this.projectionRefreshDescriptors.clear();
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
    const phase =
      event.registration.origin === "build-pipeline"
        ? "pipeline"
        : (event.registration.phase?.slice(0, 256) ?? "native-session");
    const observationKey = [event.provider, event.kind, event.registration.origin, phase].join(
      "\0",
    );
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
      const remainsBlocked =
        [...this.trackedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        ) ||
        [...this.providerReportedInteractions.values()].some(
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
      this.trackedInteractions.size + this.providerReportedInteractions.size >=
      INTERACTION_MONITOR_MAX_TRACKED_REQUESTS
    )
      return;
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
    if (this.stopped || this.options.interactionMonitorMode !== "observe-only")
      return Promise.resolve();
    recurringWorkMetrics.requested("native-interaction-observe");
    if (this.interactionScan) {
      recurringWorkMetrics.coalesced("native-interaction-observe");
      return this.interactionScan;
    }
    const scan = this.trackScan(
      recurringWorkMetrics.observe("native-interaction-observe", () =>
        this.reconcileAgentInteractionsOnce(),
      ),
    ).finally(() => {
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
      void Promise.resolve(this.options.onInteractionObservation?.({ ...observation })).catch(
        () => undefined,
      );
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
      this.trackedInteractions.size + this.providerReportedInteractions.size >=
      INTERACTION_MONITOR_MAX_TRACKED_REQUESTS
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
      [...this.trackedInteractions.values(), ...this.providerReportedInteractions.values()].map(
        (tracked) => tracked.observationKey,
      ),
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
      observation.eventualOutcome =
        tracked.expiresAt !== undefined && tracked.expiresAt <= now ? "expired" : "withdrawn";
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
        .filter(
          (environment) =>
            isEnvironmentReadyForAgents(environment) && !environment.deletionRequestedAt,
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
        interactionPolicy: current.interactionPolicy ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        createdAt: current.startedAt,
        updatedAt: current.startedAt,
      });
    }
    const allSessions = [...nativeSessions, ...pipelineSessions];
    const eligibleSessions = allSessions.filter(
      (session) =>
        session.interactionPolicy.mode === "unattended" &&
        environmentIds.has(session.environmentId),
    );
    const liveProviderSessions = new Set(
      eligibleSessions.map((session) =>
        JSON.stringify([session.environmentId, session.agent, session.providerSessionId]),
      ),
    );
    const providerReportSweepAt = this.now();
    for (const [trackedKey, tracked] of this.providerReportedInteractions) {
      if (providerReportSweepAt - tracked.detectedAt >= PROVIDER_REPORTED_INTERACTION_GRACE_MS) {
        this.providerReportedInteractions.delete(trackedKey);
        const observation = this.interactionObservations.get(tracked.observationKey);
        if (!observation) continue;
        const remainsBlocked =
          [...this.trackedInteractions.values()].some(
            (entry) => entry.observationKey === tracked.observationKey,
          ) ||
          [...this.providerReportedInteractions.values()].some(
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
      if (providerReportSweepAt - tracked.missingSince < PROVIDER_REPORTED_INTERACTION_GRACE_MS)
        continue;
      this.providerReportedInteractions.delete(trackedKey);
      const observation = this.interactionObservations.get(tracked.observationKey);
      if (!observation) continue;
      const remainsBlocked =
        [...this.trackedInteractions.values()].some(
          (entry) => entry.observationKey === tracked.observationKey,
        ) ||
        [...this.providerReportedInteractions.values()].some(
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
      this.options.interactionMonitorMaxSessionsPerEnvironment ??
        INTERACTION_MONITOR_DEFAULT_PER_ENVIRONMENT,
    );
    const byEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    const candidatesByEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    for (const session of eligibleSessions) {
      if (
        !this.interactionMonitorAdoptionEnabled &&
        !this.monitoredInteractionSessionKeys.has(session.key)
      )
        continue;
      const candidates = candidatesByEnvironment.get(session.environmentId) ?? [];
      candidates.push(session);
      candidatesByEnvironment.set(session.environmentId, candidates);
    }
    const locallySelected: PersistedNativeAgentSession[] = [];
    for (const [environmentId, candidates] of candidatesByEnvironment) {
      const selected: PersistedNativeAgentSession[] = [];
      const pipelineCandidates = candidates.filter((session) =>
        session.key.startsWith("build-pipeline:"),
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
          singleSlotCandidates.length > 0 ? (cursor + 1) % singleSlotCandidates.length : 0,
        );
      } else if (pipelineCandidates.length > 0) {
        const cursorKey = `${environmentId}\0pipeline`;
        const cursor = this.interactionSelectionCursors.get(cursorKey) ?? 0;
        selected.push(pipelineCandidates[cursor % pipelineCandidates.length]!);
        this.interactionSelectionCursors.set(cursorKey, (cursor + 1) % pipelineCandidates.length);
      }
      if (maxPerEnvironment > 1) {
        const remaining = candidates.filter(
          (candidate) => !selected.some((session) => session.key === candidate.key),
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
              previousRevision !== undefined &&
              snapshot.revision !== previousRevision &&
              snapshot.revision !== previousRevision + 1
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
                providerState = (await readProviderStatus(provider, session.providerSessionId))
                  .status;
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
                this.options.interactionMonitorMaxRetries ??
                  INTERACTION_MONITOR_DEFAULT_MAX_RETRIES,
              ),
              (this.interactionAttempts.get(retryKey) ?? 0) + 1,
            );
            this.interactionAttempts.set(retryKey, attempts);
            const base = Math.max(
              1,
              this.options.interactionMonitorRetryBaseMs ??
                INTERACTION_MONITOR_DEFAULT_RETRY_BASE_MS,
            );
            this.interactionRetryAt.set(
              retryKey,
              this.now() + Math.min(60_000, base * 2 ** Math.max(0, attempts - 1)),
            );
            if (provider) this.providerRegistry.evict(session, provider);
            console.warn(
              `[native-agent] Interaction observation for ${session.agent} failed:`,
              error instanceof Error ? error.name : "unknown error",
            );
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            Math.max(
              1,
              this.options.interactionMonitorMaxConcurrency ??
                INTERACTION_MONITOR_DEFAULT_CONCURRENCY,
            ),
            groups.length,
          ),
        },
        () => worker(),
      ),
    );
  }

  /**
   * Rebuild the durable environment activity projection from provider-owned
   * session state. This does not depend on a mounted tab or a renderer event.
   */

  // ---- from native-agent-service-reconciliation.ts ----
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
    if (this.stopped) return Promise.resolve();
    recurringWorkMetrics.requested("native-activity-sweep");
    if (this.activityScan) {
      recurringWorkMetrics.coalesced("native-activity-sweep");
      if (options.startedAfter === undefined || this.activityScanNumber > options.startedAfter) {
        return this.activityScan;
      }
      this.activityScanFollowUp ??= this.activityScan
        .catch(() => undefined)
        .then(() => {
          this.activityScanFollowUp = null;
          return this.reconcileAgentActivity();
        });
      return this.activityScanFollowUp;
    }
    this.activityScanNumber += 1;
    const scan = this.trackScan(
      recurringWorkMetrics.observe("native-activity-sweep", () =>
        this.reconcileAgentActivityOnce(),
      ),
    ).finally(() => {
      if (this.activityScan === scan) this.activityScan = null;
    });
    this.activityScan = scan;
    return scan;
  }

  /** Fresh no-touch admission read, including background work and persisted sessions after reload. */
  async hasActiveCheckoutWork(environmentId: string): Promise<boolean> {
    const sessions = (await this.storage.listNativeAgentSessions()).filter(
      (session) => session.environmentId === environmentId,
    );
    for (const session of sessions) {
      if (session.pendingDispatch) return true;
      const provider = await this.observeProvider(session);
      if (!provider) continue;
      if (this.providerRegistry.hasDispatchInFlight(provider)) return true;
      let active = false;
      await readActivityGroup({
        provider,
        sessions: [session],
        apply: async (_session, activity) => {
          if (activity.state !== "idle" && activity.state !== "missing") active = true;
        },
      });
      if (active) return true;
    }
    return false;
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
    /*
     * Coordinator runtimes have no environment row, so they used to fall out of
     * this scan entirely: the group builder below skips any session whose id is
     * not an environment, and the cleanup pass at the end then deleted the
     * `working` observation dispatch had just written. A coordinator's activity
     * was therefore permanently `unknown` — it never read `idle`, so nothing
     * could react to its turn ending and mail delivery fell through to the
     * cold-tab path with a provider probe and a backoff per attempt.
     *
     * Resolving them here puts a coordinator on exactly the same footing as an
     * environment session for observation purposes. The environment-only side
     * effects — the activity aggregate, session-completion bookkeeping, the PR
     * probe — stay gated on the `owner` this records.
     *
     * Deliberately one pass over the coordinator store rather than one resolve
     * per runtime id: this runs every two seconds, and that store is read
     * uncached, so a per-id resolve would re-read and re-parse it once per
     * conversation per tick. Nothing is read at all when no coordinator session
     * exists, which is the common case.
     */
    const coordinatorEnvironmentIds = new Set<string>();
    const coordinatorRuntimeIds = new Set(
      sessions
        .map((session) => session.environmentId)
        .filter((id) => !environmentsById.has(id) && coordinatorIdFromRuntimeId(id)),
    );
    if (coordinatorRuntimeIds.size > 0) {
      const projects = new Map<string, Awaited<ReturnType<StorageService["getProject"]>>>();
      for (const workspace of await this.storage.listCoordinatorWorkspaces()) {
        if (workspace.lifecycleState !== "ready") continue;
        if (!projects.has(workspace.projectId)) {
          projects.set(workspace.projectId, await this.storage.getProject(workspace.projectId));
        }
        const project = projects.get(workspace.projectId);
        if (!project?.localPath) continue;
        for (const conversation of workspace.conversations) {
          if (conversation.closedAt || !conversation.agent) continue;
          const runtimeId = coordinatorRuntimeId(workspace.id, conversation.id);
          if (!coordinatorRuntimeIds.has(runtimeId)) continue;
          environmentsById.set(
            runtimeId,
            coordinatorRuntimeEnvironment(runtimeId, { workspace, project }),
          );
          coordinatorEnvironmentIds.add(runtimeId);
        }
      }
    }
    if (this.stopped) return;
    // Preserve the aggregate's restart fallback until every session has a
    // known prior observation. Afterwards exact session edges own attention,
    // including completions announced before a detached shell finally exits.
    const environmentsWithUnknownSessions = new Set<string>();
    const sessionsByEnvironment = new Map<string, PersistedNativeAgentSession[]>();
    for (const session of sessions) {
      if (!environmentsById.has(session.environmentId)) continue;
      if (
        this.observedSessionActivity.get(session.key)?.providerSessionId !==
        session.providerSessionId
      ) {
        environmentsWithUnknownSessions.add(session.environmentId);
      }
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
        const sessionOwner = coordinatorEnvironmentIds.has(first.environmentId)
          ? ("coordinator" as const)
          : ("environment" as const);
        // A group whose last read failed stays untouched until its backoff
        // expires. Its environment is still withheld from the commit below:
        // publishing an aggregate built from a group we deliberately skipped
        // would report the unread agent as idle.
        if ((this.activityRetryAt.get(groupKey) ?? 0) > this.now()) {
          failedEnvironments.add(first.environmentId);
          continue;
        }
        // A stably idle group whose provider holds a qualified wakeup path is
        // not due yet. Its retained, confirmed observations still feed the
        // aggregate; nothing is re-announced because nothing was re-read.
        if (
          !this.observations.isGroupDue(groupKey) &&
          this.contributeRetainedGroup(activityByEnvironment, group, sessionOwner)
        ) {
          recurringWorkMetrics.cacheHit("native-activity-sweep");
          continue;
        }
        recurringWorkMetrics.cacheMiss("native-activity-sweep");
        /*
         * Captured before anything is read, including the bridge peek: a
         * dispatch that begins after this point makes every answer below
         * pre-dispatch evidence for that session, and it is refused rather
         * than allowed to overwrite the `working` the dispatch recorded.
         */
        let ticket = this.observations.beginRead(
          groupKey,
          group.map((session) => session.key),
        );
        let settledIdle = true;
        const applyObservation = async (
          session: PersistedNativeAgentSession,
          activity: AgentActivityState,
          details: {
            readyForInput?: boolean;
            completionPending?: boolean;
            pendingInteraction?: boolean;
          } = {},
        ): Promise<void> => {
          if (!this.observations.accepts(ticket, session.key)) {
            settledIdle = false;
            if (!this.contributeRetained(activityByEnvironment, session, sessionOwner)) {
              failedEnvironments.add(session.environmentId);
            }
            return;
          }
          if (
            await this.recordActivity(
              activityByEnvironment,
              session,
              activity,
              Boolean(environment.prRecheckAfterAgentCompletionArmedAt),
              sessionOwner,
              details.readyForInput,
              () => this.observations.accepts(ticket, session.key),
              details.completionPending,
            )
          )
            completionCandidates.add(session.environmentId);
          if (!this.observations.accepts(ticket, session.key)) {
            settledIdle = false;
            if (!this.contributeRetained(activityByEnvironment, session, sessionOwner)) {
              failedEnvironments.add(session.environmentId);
            }
            return;
          }
          // Published after the edge is durable, so a storage failure above
          // leaves no fresh record contradicting the retained edge state.
          this.observations.record(ticket, {
            sessionKey: session.key,
            providerSessionId: session.providerSessionId,
            activity,
            ...(details.readyForInput !== undefined
              ? { readyForInput: details.readyForInput }
              : {}),
            ...(details.pendingInteraction !== undefined
              ? { pendingInteraction: details.pendingInteraction }
              : {}),
          });
          if (activity !== "idle") settledIdle = false;
        };
        // A bridge known to be absent stays absent until something starts it,
        // and starting one always runs through `provider()`, which clears this.
        // Re-probing on every tick would mean a `docker exec` per container
        // every two seconds to re-learn an answer that cannot have changed.
        if (this.providerRegistry.isBridgeKnownAbsent(groupKey)) {
          for (const session of group) await applyObservation(session, "idle");
          continue;
        }
        let provider: NativeAgentRuntimeProvider | undefined;
        try {
          provider = await this.observeProvider(first);
          if (!provider) {
            // No bridge is running for this environment, so no turn can be
            // executing. That is an answer, not a failure — recording it is
            // what retires a `working` indicator left behind by a crash.
            for (const session of group) await applyObservation(session, "idle");
            this.activityAttempts.delete(groupKey);
            this.activityRetryAt.delete(groupKey);
            this.providerRegistry.markBridgeAbsent(groupKey);
            this.observations.noteGroupObserved(groupKey, {
              settledIdle,
              wakeupQualified: false,
            });
            continue;
          }
          // Results are fenced against the provider actually read from: a
          // replacement installed from here on makes them inert.
          ticket = this.observations.withCurrentGeneration(ticket);
          this.providerRegistry.clearBridgeAbsent(groupKey);
          for (const session of group) {
            provider.registerSession?.(session.providerSessionId, {
              origin: session.origin,
              interactionPolicy: session.interactionPolicy,
            });
          }
          // Batched where the provider can, bounded-concurrent per session
          // otherwise; see `readActivityGroup` for the fallback and failure
          // rules. Answers are applied one at a time, in completion order.
          await readActivityGroup({
            provider,
            sessions: group,
            apply: async (session, { state: activity, observation }) => {
              if (activity === "missing") {
                // Provider adapters may return `missing` only from an
                // authoritative existence read. Incremental activity/status
                // snapshots must surface uncertainty as provider unavailability.
                await this.storage.invalidateNativeAgentSession(
                  session.key,
                  session.providerSessionId,
                );
                this.observations.forget(session.key);
                settledIdle = false;
                return;
              }
              if (session.agent === "codex" && observation?.asyncQuestionItemIds?.length) {
                try {
                  await this.recordAsyncQuestionAttention(
                    session.environmentId,
                    session.key,
                    observation.asyncQuestionItemIds,
                  );
                } catch (error) {
                  // A badge persistence failure is not evidence that the bridge
                  // or any session in this activity group is unhealthy.
                  console.warn(
                    `[native-agent] Could not record async-question attention for ${session.environmentId}:`,
                    error instanceof Error ? error.name : "unknown error",
                  );
                }
              }
              await applyObservation(session, activity, {
                ...(observation?.readyForInput !== undefined
                  ? { readyForInput: observation.readyForInput }
                  : {}),
                ...(observation?.completionPending !== undefined
                  ? { completionPending: observation.completionPending }
                  : {}),
                pendingInteraction:
                  activity === "waiting" || (observation?.asyncQuestionItemIds?.length ?? 0) > 0,
              });
            },
          });
          this.activityAttempts.delete(groupKey);
          this.activityRetryAt.delete(groupKey);
          // Change evidence rides the same per-bridge observation; the pull is
          // single-flight and its failures never affect the activity group.
          try {
            this.options.changeTracking?.()?.noteProviderObserved(provider, first.environmentId);
          } catch {
            // Change tracking is best effort here; its own pull logs failures.
          }
          this.observations.noteGroupObserved(groupKey, {
            settledIdle:
              settledIdle && !group.some((session) => this.turnRecovery.hasCandidate(session.key)),
            wakeupQualified: this.observationWakeupQualified(first.agent, provider),
          });
        } catch (error) {
          failedEnvironments.add(first.environmentId);
          this.observations.noteGroupFailed(groupKey);
          this.backOffActivityGroup(groupKey);
          if (provider) {
            this.providerRegistry.evict(first, provider);
          }
          console.warn(
            `[native-agent] Activity reconciliation for ${first.environmentId} failed:`,
            error instanceof Error ? error.name : "unknown error",
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ACTIVITY_STATUS_CONCURRENCY, pendingGroups.length) }, () =>
        worker(),
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
        .filter((environment) => Boolean(environment.prRecheckAfterAgentCompletionArmedAt))
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
    this.observations.retainSessions(liveSessionsByKey);
    this.observations.retainGroups(new Set(groups.keys()));

    for (const environment of environments) {
      if (failedEnvironments.has(environment.id)) continue;
      const hasRegisteredSessions = sessionsByEnvironment.has(environment.id);
      const previous = environment.agentActivitySources?.["native-agent"];
      if (!hasRegisteredSessions && !previous) continue;
      const desiredState = isEnvironmentReadyForAgents(environment)
        ? aggregateAgentActivityState(activityByEnvironment.get(environment.id) ?? {})
        : "idle";
      if (previous?.state === desiredState) continue;
      await this.storage
        .setEnvironmentAgentActivity(
          environment.id,
          desiredState,
          new Date().toISOString(),
          "native-agent",
          undefined,
          false,
          {
            completionAttention:
              !hasRegisteredSessions || environmentsWithUnknownSessions.has(environment.id),
          },
        )
        .catch((error) => {
          console.warn(
            `[native-agent] Failed to persist activity for ${environment.id}:`,
            error instanceof Error ? error.name : "unknown error",
          );
        });
    }
  }

  /**
   * Stage a session's retained observation into the aggregate, with no edge.
   *
   * Used where this pass holds no applicable answer for the session: its
   * group is not due, or its read was fenced by a dispatch. Returns false when
   * nothing is retained for the current provider session, in which case the
   * caller must withhold the environment's commit rather than publish an
   * aggregate that silently omits the session.
   */
  protected contributeRetained(
    activityByEnvironment: Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >,
    session: PersistedNativeAgentSession,
    owner: "environment" | "coordinator",
  ): boolean {
    const observed = this.observedSessionActivity.get(session.key);
    if (!observed || observed.providerSessionId !== session.providerSessionId) return false;
    if (owner === "environment") {
      const sources = activityByEnvironment.get(session.environmentId) ?? {};
      sources[session.key] = { state: observed.state, updatedAt: "1970-01-01T00:00:00.000Z" };
      activityByEnvironment.set(session.environmentId, sources);
    }
    return true;
  }

  /** A not-due group is skipped only when every session has a retained idle. */
  protected contributeRetainedGroup(
    activityByEnvironment: Map<
      string,
      Record<string, { state: AgentActivityState; updatedAt: string }>
    >,
    group: readonly PersistedNativeAgentSession[],
    owner: "environment" | "coordinator",
  ): boolean {
    const retained = group.every((session) => {
      const observed = this.observedSessionActivity.get(session.key);
      return (
        observed?.providerSessionId === session.providerSessionId &&
        observed.state === "idle" &&
        !this.turnRecovery.hasCandidate(session.key)
      );
    });
    if (!retained) return false;
    for (const session of group) this.contributeRetained(activityByEnvironment, session, owner);
    return true;
  }

  /**
   * Whether a stably idle group of this provider may back off right now: the
   * capability matrix names a push path for externally started work *and* the
   * provider reports that path live (an OpenCode event stream that is
   * connected, not reconnecting). Everything else keeps every sweep.
   */
  protected observationWakeupQualified(
    agent: BuildPipelineAgent,
    provider: NativeAgentRuntimeProvider,
  ): boolean {
    return (
      this.options.observationSharing !== false &&
      nativeAgentObservationCapabilities(agent)?.idleBackoffWakeup === "provider-event-stream" &&
      provider.observationStreamLive?.() === true
    );
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
  async observeSessionActivity(
    input: { environmentId: string; agent: BuildPipelineAgent; logicalSessionKey: string },
    demand: NativeAgentObservationDemand = {},
  ): Promise<NativeAgentObservationView> {
    if (this.stopped) return { freshness: "unknown", postDispatch: false };
    // Captured before any await: only a sweep that starts after this demand
    // can answer it if the retained observation does not.
    const demandedAfter = this.activityScanNumber;
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.storage.getNativeAgentSession(key);
    if (!session) return { freshness: "unknown", postDispatch: false };
    const retained = this.observations.view(key, session.providerSessionId);
    if (observationSatisfies(retained, demand)) {
      recurringWorkMetrics.cacheHit("native-activity-sweep");
      return retained;
    }
    this.observations.wakeGroup(
      nativeAgentObservationGroupKey(input.environmentId, input.agent),
      "demand",
    );
    await this.reconcileAgentActivity({ startedAfter: demandedAfter });
    return this.observations.view(key, session.providerSessionId);
  }

  /** Wake one environment's provider group(s) for the next sweep. */
  wakeObservation(
    environmentId: string,
    reason: NativeAgentObservationWakeReason,
    agent?: BuildPipelineAgent,
  ): void {
    this.observations.wakeEnvironment(environmentId, reason, agent);
  }

  /** Content-free observer state for diagnostics and the client's gap anchor. */
  observationStatus(): NativeAgentObservationStatus & { stamp: ViewRevisionStamp } {
    return { ...this.observations.status(), stamp: this.observations.stamp() };
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
    /**
     * A coordinator runtime is observed like any session but owns none of the
     * environment bookkeeping: there is no row to record a completion against
     * and no aggregate to publish. Its transition is still reported, which is
     * what wakes held worker mail.
     */
    owner: "environment" | "coordinator" = "environment",
    readyForInput?: boolean,
    stillApplicable?: () => boolean,
    completionPending?: boolean,
  ): Promise<boolean> {
    const observed = this.observedSessionActivity.get(session.key);
    const currentObservation =
      observed?.providerSessionId === session.providerSessionId ? observed : undefined;
    const previous = currentObservation?.state;
    // Readiness alone is ambiguous on older bridges. An explicit settled root
    // turn can ring while detached shells keep the environment working; an
    // owed continuation keeps its completion edge until the final result.
    const releasedCompletion =
      state === "working" && readyForInput === true && completionPending === false;
    const previousReleasedCompletion =
      previous === "working" &&
      currentObservation?.readyForInput === true &&
      currentObservation.completionPending === false;
    const durableAttentionEdge =
      (state === "waiting" &&
        previous !== "waiting" &&
        (currentObservation !== undefined || observed === undefined)) ||
      (completionPending !== true &&
        (state === "idle" || releasedCompletion) &&
        !previousReleasedCompletion &&
        (previous === "working" ||
          (state === "idle" && observed === undefined && countUnknownIdleAsCompletion)));
    // PR reconciliation retains its narrower historical completion contract:
    // a parked waiting turn needs the user's attention, but it has not ended.
    //
    // Both flags key their "never seen before" case on `observed`, not on
    // `currentObservation`. Rotating a session's provider id is not a first
    // observation: this backend watched the previous turn under the old id, so
    // the idle that follows a rotation is already accounted for and must not be
    // replayed as a completion. `previous` still narrows to the current
    // provider session, which is what keeps a rotation from inheriting an edge.
    const completed =
      state === "idle" &&
      (previous === "working" || (observed === undefined && countUnknownIdleAsCompletion));
    // Persist the exact session edge before advancing the in-memory observation.
    // If storage fails, the provider group backs off and the next scan still
    // sees `previous === "working"`, so the durable completion is retried.
    if (durableAttentionEdge && owner === "environment") {
      await this.storage.recordEnvironmentSessionCompletion(
        session.environmentId,
        new Date(this.now()).toISOString(),
        state === "waiting" ? "agent_waiting" : "agent_finished",
      );
    }
    if (stillApplicable && !stillApplicable()) return false;
    this.observedSessionActivity.set(session.key, {
      providerSessionId: session.providerSessionId,
      state,
      ...(readyForInput !== undefined ? { readyForInput } : {}),
      ...(completionPending !== undefined ? { completionPending } : {}),
    });
    if (previous !== state) {
      const observation = this.observations.nextStamp();
      this.options.onActivityTransition?.({
        observation,
        environmentId: session.environmentId,
        sessionKey: session.key,
        providerSessionId: session.providerSessionId,
        previousState: previous,
        state,
        owner,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
      });
    }
    // Incomplete-turn recovery keys its candidates on these applied edges.
    this.turnRecovery.noteActivity(session, state, previous);
    if (owner === "environment") {
      const sources = activityByEnvironment.get(session.environmentId) ?? {};
      sources[session.key] = {
        state,
        // Only the state matters for this in-memory aggregate. A real timestamp
        // is supplied once per committed environment.
        updatedAt: "1970-01-01T00:00:00.000Z",
      };
      activityByEnvironment.set(session.environmentId, sources);
    }
    return completed && owner === "environment";
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
          length: Math.min(ACTIVITY_STATUS_CONCURRENCY, environmentIds.length),
        },
        () => worker(),
      ),
    );
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
    const task = this.reconcileInitialLaunchOnce(environmentId).finally(() => {
      if (this.launchTasks.get(environmentId) === task) {
        this.launchTasks.delete(environmentId);
      }
    });
    this.launchTasks.set(environmentId, task);
    return task;
  }

  protected async reconcilePendingLaunches(): Promise<number> {
    if (this.stopped) return 0;
    const now = Date.now();
    const environments = await this.storage.loadEnvironments();
    if (this.stopped) return 0;
    await this.providerRegistry.prune(
      new Set(
        environments
          .filter((environment) => !environment.deletionRequestedAt)
          .map((environment) => environment.id),
      ),
    );
    if (this.stopped) return 0;
    const pending = environments.filter(
      (environment) =>
        environment.pendingAgentLaunch &&
        (environment.status === "creating" || environment.status === "running"),
    );
    await Promise.allSettled(
      pending
        .filter((environment) => (this.launchRetryAt.get(environment.id) ?? 0) <= now)
        .map((environment) => this.reconcileInitialLaunch(environment.id)),
    );
    return pending.length;
  }

  /**
   * Drain one session's queue now, named by the session's own identity.
   *
   * The turn-end edge already knows which session became free; waiting for the
   * next two-second sweep to rediscover that is latency for nothing. A session
   * with no queue costs one storage read, and the drain coalesces with any
   * pass already running.
   */
  async drainPromptQueueForSession(input: {
    agent?: BuildPipelineAgent;
    logicalSessionKey?: string;
  }): Promise<void> {
    if (this.stopped) return;
    const { agent, logicalSessionKey } = input;
    if (!agent || !nonBlank(logicalSessionKey)) return;
    if (!BUILD_PIPELINE_AGENTS.includes(agent)) return;
    const queueKey = `${agent}\0${logicalSessionKey}`;
    const queue = await this.storage.getPromptQueue(queueKey);
    this.queueScheduling?.note(queue, queueKey);
    if (!queue || (queue.dispatchError && !queue.inFlight?.steer)) return;
    if (queue.inFlight === undefined && queue.messages.length === 0) return;
    await this.drainPromptQueue(queueKey);
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
            BUILD_PIPELINE_AGENTS.includes(agent as BuildPipelineAgent) &&
            (queue.messages.length > 0 || queue.inFlight !== undefined) &&
            (queue.inFlight?.steer || queue.dispatchError === undefined) &&
            (this.queueRetryAt.get(queue.queueKey) ?? 0) <= now
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
      const parkedRequestId =
        requestId ??
        (park?.reserveHead
          ? (await this.storage.reservePromptQueueHeadForDispatch(queueKey))?.requestId
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
      const task = this.drainPromptQueueOnce(queueKey).finally(() => {
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
    if (!BUILD_PIPELINE_AGENTS.includes(agent) || !nonBlank(logicalSessionKey)) {
      return;
    }
    const queue = await this.storage.getPromptQueue(queueKey);
    this.queueScheduling?.note(queue, queueKey);
    if (!queue) return;
    if (queue.inFlight?.steer) {
      const key = nativeAgentSessionStorageKey(queue.environmentId, agent, logicalSessionKey);
      await this.storage.recoverPromptQueueSteer(key, queue.inFlight.requestId);
      const session = await this.storage.getNativeAgentSession(key);
      if (session?.pendingSteer?.requestId === queue.inFlight.requestId) {
        await this.settleAmbiguousSteer(
          { environmentId: queue.environmentId, agent, logicalSessionKey },
          key,
          queue.inFlight.requestId,
        );
      }
      return;
    }
    if (queue.dispatchError) return;
    if (queue.inFlight === undefined && queue.messages.length === 0) return;
    const environment = await this.assertEnvironmentLive(queue.environmentId);
    // The launch path has always required this; so must the drain path. A
    // stopped or still-provisioning environment must not be started by a
    // leftover queued prompt.
    if (!isEnvironmentReadyForAgents(environment)) {
      await this.deferQueue(queueKey, "environment is not ready for agents");
      return;
    }
    const draftKey = `${agent}:${queue.environmentId}:${encodeURIComponent(logicalSessionKey)}`;
    const draft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(draft?.value)) return;

    const head = queue.inFlight?.message ?? queue.messages[0];
    /*
     * Share the activity sweep's answer instead of reading the provider again.
     * `ensureSession` and the status read below are tab-facing reads — a
     * liveness touch on Codex, a transcript hydrate on Claude — and a busy
     * session with a queued prompt used to pay both on every two-second pass
     * for the whole turn. A fresh, confirmed busy answer ends this pass exactly
     * as a `running` status would; the turn-end edge drains the queue, and an
     * answer older than two sweeps falls back to the authoritative read.
     * Idle is never taken from here: dispatch still requires the provider's
     * own current status below.
     */
    if (this.queueSessionObservedBusy(queue.environmentId, agent, logicalSessionKey, head)) {
      recurringWorkMetrics.cacheHit("native-queue-scan");
      return;
    }
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
    // This read is the last look at the previous turn before the next prompt
    // replaces its status; keep its content-free outcome for observers.
    await this.recordObservedTurnOutcome(session, status, statusDetail, provider);
    await this.assertEnvironmentLive(queue.environmentId);
    if (status === "running") {
      const requestId =
        head && typeof head === "object"
          ? (this.queueString(head as Record<string, unknown>, "requestId") ??
            this.queueString(head as Record<string, unknown>, "id"))
          : undefined;
      if (agent !== "codex" || !requestId || !nativeAsyncQuestionItemId(requestId)) return;

      const reservation = await this.storage.reservePromptQueueHeadForDispatch(queueKey);
      if (!reservation || typeof reservation.message !== "object") return;
      const message = reservation.message as Record<string, unknown>;
      const latestSession = await this.storage.getNativeAgentSession(session.key);
      if (latestSession?.dispatchedRequestIds?.includes(reservation.requestId)) {
        await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
        this.clearQueueBackoff(queueKey);
        return;
      }
      if (!nonBlank(message.text)) {
        await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
        return;
      }
      // Async-question answers are text-only and keep their queue reservation
      // until reliable steering has either been confirmed or the live turn has
      // ended. The latter case falls through to ordinary next-turn dispatch on
      // a later drain pass without changing the request identity.
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        await this.storage.failPromptQueueDispatch(
          queueKey,
          reservation.requestId,
          "Asynchronous-question answers cannot include attachments",
        );
        return;
      }
      try {
        const outcome = await this.dispatchQueuedAsyncQuestionAnswer(
          { environmentId: queue.environmentId, agent, logicalSessionKey },
          { key: session.key, session, provider },
          message.text,
          reservation.requestId,
        );
        if (outcome.outcome === "applied") {
          await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
          this.clearQueueBackoff(queueKey);
        }
        // idle/mismatch means the turn ended during qualification, and
        // rejected means the bridge refused more steering for this turn. Keep
        // the reservation for the next idle pass, which sends it as a normal turn.
        // unknown is protected by pendingSteer and the recoverable-dispatch UI.
      } catch {
        // A bridge without reliable steering can still deliver this response as
        // an ordinary prompt after the active turn ends. Keep it reserved and
        // avoid treating capability skew as a failed user answer.
      }
      return;
    }
    if (status === "blocked") return;
    if (status !== "idle") {
      await this.deferQueue(queueKey, `provider session is ${status}`, queue.inFlight?.requestId, {
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
          ? `The ${agent} session failed before this prompt was sent: ${statusDetail.slice(0, 500)}`
          : `The ${agent} session is ${status}; the queued prompt was not sent.`,
      });
      return;
    }
    if (this.stopped) return;
    const latestDraft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(latestDraft?.value)) return;
    const reservation = await this.storage.reservePromptQueueHeadForDispatch(queueKey);
    if (!reservation || typeof reservation.message !== "object") return;
    const message = reservation.message as Record<string, unknown>;
    if (!nonBlank(message.text)) {
      await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
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
      const reason = error instanceof Error ? error.message : "Queued attachment is invalid";
      await this.storage.failPromptQueueDispatch(queueKey, reservation.requestId, reason);
      this.clearQueueBackoff(queueKey);
      return;
    }
    try {
      await this.dispatchPrompt({
        environmentId: queue.environmentId,
        agent,
        logicalSessionKey,
        model: this.queueString(message, "model"),
        reasoningEffort: this.queueReasoningEffort(message),
        phase: this.queueExecutionMode(agent, message) === "plan" ? "review" : "build",
        mode: this.queueDispatchMode(agent, message),
        fastMode: this.queueFastMode(agent, message),
        subAgent: this.queueString(message, "agent"),
        executionAgent:
          this.queueString(message, "executionAgent") ?? this.queueString(message, "agent"),
        includeLocalSettings: this.queueBoolean(message, "includeLocalSettings"),
        promptSuggestions: this.queueBoolean(message, "promptSuggestions"),
        attachments,
        prompt: message.text,
        requestId: reservation.requestId,
        // Revalidated now, at dequeue: a selection whose binding changed while
        // queued fails with its reason instead of running something else.
        ...(parseNativeAgentCommandIntent(message.command)
          ? { command: parseNativeAgentCommandIntent(message.command) }
          : {}),
      });
      await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
      this.clearQueueBackoff(queueKey);
    } catch (error) {
      if (error instanceof PromptRejectedError) {
        await this.storage.failPromptQueueDispatch(queueKey, reservation.requestId, error.message, {
          requestIdRetired: error.requestIdRetired,
        });
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

  /** A fresh, confirmed observation says the session cannot take this head now. */
  protected queueSessionObservedBusy(
    environmentId: string,
    agent: BuildPipelineAgent,
    logicalSessionKey: string,
    head: unknown,
  ): boolean {
    const requestId =
      head && typeof head === "object"
        ? (this.queueString(head as Record<string, unknown>, "requestId") ??
          this.queueString(head as Record<string, unknown>, "id"))
        : undefined;
    if (this.options.observationSharing === false) return false;
    // An async-question answer is delivered *into* a running Codex turn.
    if (agent === "codex" && requestId && nativeAsyncQuestionItemId(requestId)) return false;
    const key = nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey);
    const observed = this.observedSessionActivity.get(key);
    if (!observed) return false;
    const view = this.observations.view(key, observed.providerSessionId);
    const record = view.record;
    if (
      !record ||
      // Only the provider's own confirmation. The `working` a dispatch records
      // at acceptance is not evidence the turn is still running: a turn that
      // finished before the next sweep must still release its queue here.
      record.source !== "provider" ||
      view.freshness === "recovering" ||
      view.ageMs === undefined ||
      view.ageMs > QUEUE_BUSY_OBSERVATION_MAX_AGE_MS ||
      record.activity !== observed.state
    ) {
      return false;
    }
    return (
      record.activity === "waiting" ||
      (record.activity === "working" && record.readyForInput !== true)
    );
  }

  protected async reconcileInitialLaunchOnce(environmentId: string): Promise<void> {
    if (this.stopped) return;
    const environment = await this.storage.getEnvironment(environmentId);
    if (
      !environment ||
      !environment.pendingAgentLaunch ||
      (environment.status !== "creating" && environment.status !== "running")
    ) {
      return;
    }
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(environment.projectId);
    // Resolve the same inherited settings contract the renderer uses to label
    // the durable startup projection. Launching and attachment staging are now
    // backend-owned for every mode.
    const tiers = {
      environment: environment.agentSettings,
      repository: repository.agentSettings,
      global: config.global.agentSettings,
    };
    const configuredLaunch = resolveStartupLaunchFromSettings(tiers);
    const agent = environment.initialAgentPlatform ?? configuredLaunch.agent;

    const logicalSessionKey = `env-${environment.id}:startup-agent`;
    // One resolver for the whole chain. This used to read the repository's
    // single `defaultModel` for *whatever* agent launched, so a model id
    // belonging to one platform's catalogue could be sent to another; a model
    // now travels only down its own platform column.
    const resolved = resolveAgentPlatformSettings(tiers, agent);
    const mode = resolved.mode;
    const claudeNativeBackend = resolveAgentPlatformSettings(tiers, "claude").claudeNativeBackend;
    const selectedModel = environment.initialAgentModel ?? resolved.model;
    // The Claude catalogue exposes Sonnet through its stable alias. Stored
    // release ids remain valid preferences but must be dispatched as that alias.
    const model =
      agent === "claude" &&
      (selectedModel === "claude-sonnet-5" || selectedModel === "claude-sonnet-5-5")
        ? "sonnet"
        : selectedModel;
    const reasoningEffort = environment.initialReasoningEffort ?? resolved.reasoningEffort;
    // Same one-shot-over-tier rule as the two above: a launcher that offered a
    // Fast/Normal control for this run must win over the platform's durable
    // setting, or the choice the user made in the dialog is silently ignored.
    const fastMode = environment.initialFastMode ?? resolved.fastMode;
    const conversationMode = environment.initialConversationMode;
    const parameterValues = agent === "claude" ? claudeNativeParameterValues(resolved) : undefined;
    const nativeProviderLaunch =
      mode === "native" && !(agent === "claude" && claudeNativeBackend === "tmux");

    if (!nativeProviderLaunch) {
      try {
        await this.storage.ensureTerminalJobTab({
          environmentId: environment.id,
          tabId: "startup-agent",
          type: agent === "claude" && claudeNativeBackend === "tmux" ? "claude-tmux" : agent,
          // A restored renderer must not attach to a PTY identity left by a
          // previous backend generation while this launch is still pending.
          terminalSessionId: null,
        });
        const startupSession = environment.startupAgentSession;
        if (
          !startupSession ||
          startupSession.tabId !== "startup-agent" ||
          startupSession.agent !== agent ||
          startupSession.style !== "terminal" ||
          startupSession.model !== model ||
          startupSession.reasoningEffort !== reasoningEffort ||
          startupSession.status !== "starting"
        ) {
          await this.storage.updateEnvironment(environment.id, {
            startupAgentSession: {
              tabId: "startup-agent",
              agent,
              style: "terminal",
              model,
              reasoningEffort,
              status: "starting",
            },
          });
        }
        if (!isEnvironmentReadyForAgents(environment)) return;

        let prompt = environment.initialPrompt?.trim() ?? "";
        const attachments = environment.initialPromptAttachments ?? [];
        if (attachments.length > 0) {
          const saved = await this.invoke<SavedInitialPromptAttachment[]>(
            "write_initial_prompt_attachments",
            {
              environmentId: environment.id,
              attachments: attachments.map(({ id, name, base64Data }) => ({
                id,
                name,
                base64Data,
              })),
            },
          );
          prompt = buildInitialPromptWithAttachmentReferences(prompt, saved);
          // Staging is a durable step of this launch. Persist the rewritten
          // prompt and consume the bodies before starting the PTY so a retry
          // reuses the same workspace files instead of creating another batch.
          await this.storage.updateEnvironment(environment.id, {
            initialPrompt: prompt,
            initialPromptAttachments: undefined,
          });
        }

        if (agent === "claude" && claudeNativeBackend === "tmux") {
          await this.invoke("launch_terminal_job", {
            requestId: `initial-prompt:${environment.id}:startup-agent`,
            environmentId: environment.id,
            tabId: "startup-agent",
            tabType: "claude-tmux",
            initialPrompt: prompt || undefined,
            model,
            reasoningEffort,
            fastMode,
            activateTab: true,
          });
        } else {
          const command = buildTerminalAgentLaunchCommand({
            tabType: agent,
            initialPrompt: prompt || undefined,
            model,
            reasoningEffort,
            fastMode,
          });
          if (!command) throw new Error(`${agent} does not support terminal launch`);
          await this.invoke("launch_terminal_job", {
            requestId: `initial-prompt:${environment.id}:startup-agent`,
            environmentId: environment.id,
            tabId: "startup-agent",
            tabType: agent,
            data: `${command}\n`,
            activateTab: true,
          });
        }

        await this.storage.updateEnvironment(environment.id, {
          pendingAgentLaunch: false,
          initialAgentPlatform: undefined,
          initialAgentModel: undefined,
          initialReasoningEffort: undefined,
          initialFastMode: undefined,
          initialConversationMode: undefined,
          initialPromptAttachments: undefined,
          initialPromptPresentation: undefined,
          startupAgentSession: undefined,
        });
        this.launchRetryAt.delete(environment.id);
      } catch (error) {
        this.launchRetryAt.set(environment.id, Date.now() + LAUNCH_RETRY_MS);
        await this.storage.updateEnvironment(environment.id, {
          startupAgentSession: {
            tabId: "startup-agent",
            agent,
            style: "terminal",
            model,
            reasoningEffort,
            status: "error",
            error: "Agent launch failed; the backend will retry.",
          },
        });
        throw error;
      }
      return;
    }

    // Publishing runs inside the same failure handling as the launch itself. A
    // throw here (an unwritable layout file, a root over the size bound) would
    // otherwise escape before the catch below records the durable error and
    // arms `launchRetryAt`, leaving the two-second sweep retrying forever with
    // no backoff and nothing for the renderer to surface.
    try {
      const prompt = environment.initialPrompt?.trim();
      const initialAttachments = environment.initialPromptAttachments ?? [];
      const hasInitialWork = Boolean(prompt || initialAttachments.length > 0);
      const preselectOptions = hasInitialWork
        ? { lockPlatform: true as const }
        : {
            initialAgentPlatform: agent,
            ...(model ? { initialAgentModel: model } : {}),
            ...(reasoningEffort ? { initialReasoningEffort: reasoningEffort } : {}),
            ...(conversationMode ? { initialConversationMode: conversationMode } : {}),
            ...(typeof fastMode === "boolean" ? { initialFastMode: fastMode } : {}),
          };

      // Publish both startup surfaces as soon as backend intent exists,
      // including while setup is still running. Provider creation remains gated
      // below, but the durable pane can already rehydrate in an inactive
      // renderer. A prompt-less launch stays unassigned so the user can still
      // change the preselected model before the first send.
      await this.storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent,
        ...preselectOptions,
      });
      const startupSession = environment.startupAgentSession;
      if (
        !startupSession ||
        startupSession.agent !== agent ||
        startupSession.style !== "native" ||
        startupSession.status !== "starting"
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

      if (!hasInitialWork) {
        // No opening prompt was submitted with the environment. Leave the tab
        // unlocked, keep the create-dialog model as a one-shot preselect, and
        // do not mint a provider session the user may never use.
        const publishedLayout = await this.storage.ensureStartupNativeAgentTab({
          environmentId: environment.id,
          agent,
          activateOnSetupHandoff: true,
          ...preselectOptions,
        });
        await this.storage.updateEnvironment(environment.id, {
          pendingAgentLaunch: false,
          initialAgentPlatform: undefined,
          initialAgentModel: undefined,
          initialReasoningEffort: undefined,
          initialFastMode: undefined,
          initialConversationMode: undefined,
          initialPromptAttachments: undefined,
          initialPromptPresentation: undefined,
          startupAgentSession: publishedLayout
            ? undefined
            : {
                tabId: "startup-agent",
                agent,
                style: "native",
                model,
                reasoningEffort,
                status: "running",
                startedAt: new Date().toISOString(),
              },
        });
        this.launchRetryAt.delete(environment.id);
        return;
      }

      const files = initialAttachments.filter((attachment) => attachment.type === "file");
      // Images stay as base64 until the provider stages them inside the durable
      // dispatch lock. Files use the same lock through the preparation callback
      // below. Staging either kind before dispatch would let every supervisor
      // write a competing copy of the same startup attachment.
      const images = initialAttachments
        .filter((attachment) => attachment.type !== "file")
        .map((attachment) => ({
          filename: attachment.name,
          data: attachment.base64Data,
        }));
      const dispatchInput: DispatchNativeAgentPromptInput = {
        environmentId: environment.id,
        agent,
        logicalSessionKey,
        model,
        // A model the launch named is pinned. One read from the settings tiers
        // is an inherited default, which the runtime may replace when this
        // login cannot serve it (the shipped Codex `gpt-5.4` on a ChatGPT
        // login): otherwise every worker a coordinator launches with default
        // settings fails its first turn.
        modelSource: environment.initialAgentModel ? "explicit" : "default",
        reasoningEffort,
        ...(conversationMode ? { mode: conversationMode } : {}),
        ...(typeof fastMode === "boolean" ? { fastMode } : {}),
        ...(parameterValues ? { parameterValues } : {}),
        // A file-only turn needs non-blank text before its final workspace paths
        // can be resolved inside the dispatch lock below.
        prompt: prompt || (files.length > 0 ? "Use the attached file." : ""),
        requestId: `initial-prompt:${environment.id}:startup-agent`,
        images,
        ...(environment.initialPromptPresentation
          ? { initialPromptPresentation: environment.initialPromptPresentation }
          : {}),
      };
      const session =
        files.length > 0
          ? await this.dispatchPromptInternal(dispatchInput, async () => {
              const saved = await this.invoke<SavedInitialPromptAttachment[]>(
                "write_initial_prompt_attachments",
                {
                  environmentId: environment.id,
                  attachments: files.map(({ id, name, base64Data }) => ({
                    id,
                    name,
                    base64Data,
                  })),
                },
              );
              return {
                dispatch: true,
                prompt: buildInitialPromptWithAttachmentReferences(prompt ?? "", saved),
              };
            })
          : await this.dispatchPrompt(dispatchInput);

      // The provider mapping is not enough to satisfy the launch: the user
      // needs a durable pane projection even if every renderer was inactive
      // throughout setup. Publish it before consuming the launch intent so a
      // crash at either boundary is safely retried and converges by stable id.
      const publishedLayout = await this.storage.ensureStartupNativeAgentTab({
        environmentId: environment.id,
        agent,
        providerSessionId: session.providerSessionId,
        lockPlatform: true,
      });

      await this.storage.updateEnvironment(environment.id, {
        pendingAgentLaunch: false,
        initialAgentPlatform: undefined,
        initialAgentModel: undefined,
        initialReasoningEffort: undefined,
        initialFastMode: undefined,
        initialConversationMode: undefined,
        initialPromptAttachments: undefined,
        initialPromptPresentation: undefined,
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
        `[native-agent] Startup launch for ${environment.id} failed` +
          `${terminal ? " permanently" : ""}: ` +
          (error instanceof Error ? error.name : "unknown error"),
      );
      if (!terminal) this.launchRetryAt.set(environment.id, Date.now() + LAUNCH_RETRY_MS);
      await this.storage.updateEnvironment(environment.id, {
        ...(terminal
          ? {
              pendingAgentLaunch: false,
              initialAgentPlatform: undefined,
              initialAgentModel: undefined,
              initialReasoningEffort: undefined,
              initialFastMode: undefined,
              initialConversationMode: undefined,
              initialPromptAttachments: undefined,
              initialPromptPresentation: undefined,
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
   * One provider per environment and agent.
   *
   * Model and effort are deliberately excluded from the key and passed per call
   * instead: keying on them accumulated an undisposed provider — and for
   * OpenCode a permanent event stream — for every variant a user ever queued.
   */

  // ---- from native-agent-service-provider.ts ----
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
          autoAnswerRequests: false,
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
            provider = createNativeAgentProvider(connection, { autoAnswerRequests: false });
            this.providerRegistry.cache(key, provider, identity);
          }
        }
      }
      if (!provider) {
        const observed = this.observedSessionActivity.get(session.key);
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
      this.observedSessionActivity.set(session.key, {
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
  ): Promise<"reloaded" | "not-running" | "unsupported"> {
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

  protected trackScan(task: Promise<void>): Promise<void> {
    const tracked = task.finally(() => {
      this.scanTasks.delete(tracked);
    });
    this.scanTasks.add(tracked);
    return tracked;
  }

  protected assertAcceptingWork(): void {
    if (this.stopped) throw new Error("Native agent service is shut down");
  }

  protected async assertEnvironmentLive(environmentId: string): Promise<Environment> {
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

  protected assertSessionIdentity(
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

  protected async createProviderSession(
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

  protected composeDraftHoldsQueue(value: unknown): boolean {
    return composeDraftHoldsQueue(value);
  }

  protected queueBoolean(message: unknown, field: string): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return typeof value === "boolean" ? value : undefined;
  }

  protected queueString(message: unknown, field: string): string | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const value = (message as Record<string, unknown>)[field];
    return nonBlank(value) ? value : undefined;
  }

  protected queueReasoningEffort(message: unknown): string | undefined {
    return (
      this.queueString(message, "reasoningEffort") ??
      this.queueString(message, "effort") ??
      this.queueString(message, "variant")
    );
  }

  protected queueFastMode(agent: BuildPipelineAgent, message: unknown): boolean | undefined {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return undefined;
    }
    const record = message as Record<string, unknown>;
    // Native compose queues persist the shared `fastMode` field for every
    // provider. Keep accepting Claude's legacy `fastModeEnabled` shape while
    // forwarding the shared field to Codex, Cursor, and Grok.
    //
    // Each candidate is type-checked before the next is considered rather than
    // coalesced first: `??` only falls through on null/undefined, so a garbage
    // legacy value would otherwise shadow a perfectly good shared field and
    // silently drop the user's speed selection.
    const candidates =
      agent === "claude" ? [record.fastModeEnabled, record.fastMode] : [record.fastMode];
    for (const candidate of candidates) {
      if (typeof candidate === "boolean") return candidate;
    }
    return undefined;
  }

  protected queueExecutionMode(agent: BuildPipelineAgent, message: unknown): ProviderExecutionMode {
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

  /**
   * The mode actually sent with a queued prompt. Backend-authored prompts may
   * ask to leave the session's own mode untouched (`preserveSessionMode`):
   * several providers persist a prompt's mode on the session, so sending the
   * `build` default would silently change a mode the user chose.
   */
  protected queueDispatchMode(
    agent: BuildPipelineAgent,
    message: unknown,
  ): ProviderExecutionMode | undefined {
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>).preserveSessionMode === true &&
      (message as Record<string, unknown>).mode === undefined &&
      (message as Record<string, unknown>).planModeEnabled === undefined
    ) {
      return undefined;
    }
    return this.queueExecutionMode(agent, message);
  }
}

/** Whether `next` names a row the previous view did not carry in exactly this form. */
function revisedRowsChanged(previous: readonly unknown[], next: readonly unknown[]): boolean {
  const held = new Map(
    previous.map((message) => [(message as { id?: unknown }).id, message] as const),
  );
  return next.some((message) => {
    const before = held.get((message as { id?: unknown }).id);
    return before === undefined || !sameEncoding(before, message);
  });
}
