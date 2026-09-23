import path from "node:path";
import { fileURLToPath } from "node:url";
import * as shared from "./native-agent-service-shared.js";
import { AGENT_INTERACTION_KINDS } from "@orkestrator/protocol/agent-interactions";
import {
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  nativeAsyncQuestionItemId,
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
} from "@orkestrator/protocol/native-agent";
import { parseCoordinatorDelegatedPrompt } from "@orkestrator/protocol/review-evidence-frames";
import {
  coordinatorIdFromRuntimeId,
  stripCoordinatorContext,
} from "@orkestrator/protocol/coordinator";
import {
  NATIVE_DISCOVERY_RETRY_MS,
  NATIVE_AUTH_STATUS_CACHE_LIMIT,
  NATIVE_AUTH_STATUS_TTL_MS,
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
  NATIVE_FILE_DETAIL_MAX_BYTES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_BYTES,
  NATIVE_TOOL_DETAIL_CACHE_MAX_ENTRIES,
  NATIVE_TOOL_DETAIL_MAX_BYTES,
  ProviderUnavailableError,
  boundTranscriptResponse,
  createHash,
  randomUUID,
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  nativeComposerControls,
  nonBlank,
  readProviderStatus,
  resolveReasoningId,
  withSessionActionSlashCommands,
} from "./native-agent-service-shared.js";
import {
  lastAssistantModelRef,
  openCodeComposerSelectionToPersist,
} from "./native-agent-composer-selection.js";
import {
  createNativeAgentDisplayTail,
  displayTailRecoveryWindow,
  NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS,
} from "./native-agent-display-tails.js";
import {
  ProgressiveReadMetrics,
  type ProgressiveCacheTier,
  type ProgressiveReadOutcome,
} from "./native-agent-progressive-metrics.js";
import { readReadableHostFile } from "./path-safety.js";
import { unsupportedCommandCatalogueState } from "@orkestrator/protocol/agent-command-catalogue";
import {
  commandCatalogueKey,
  type CommandCatalogueSnapshot,
} from "./native-agent-command-catalogue.js";
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
type NativeAgentReadiness = shared.NativeAgentReadiness;
type NativeAgentResumeEntry = shared.NativeAgentResumeEntry;
type NativeAgentSessionProjection = shared.NativeAgentSessionProjection;
type NativeAgentSessionAction = shared.NativeAgentSessionAction;
type NativeAgentSessionActionOutcome = shared.NativeAgentSessionActionOutcome;
type NativeAgentSlashCommand = shared.NativeAgentSlashCommand;
type NativeAgentAuthStatus = shared.NativeAgentAuthStatus;
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
type ProviderSessionStateSnapshot = shared.ProviderSessionStateSnapshot;
type ProviderTranscriptSnapshot = shared.ProviderTranscriptSnapshot;

interface ProjectedProgressiveTranscript {
  value: NativeAgentTranscriptView;
  historyStartIndex?: number;
  historyEndIndex?: number;
}
type ProviderInteractionObservationEvent = shared.ProviderInteractionObservationEvent;
type ProviderExecutionMode = shared.ProviderExecutionMode;
type PromptAttachment = shared.PromptAttachment;
type CommandInvoker = shared.CommandInvoker;
type EnsureNativeAgentSessionInput = shared.EnsureNativeAgentSessionInput;
type DispatchNativeAgentPromptInput = shared.DispatchNativeAgentPromptInput;
type AdoptNativeAgentSessionInput = shared.AdoptNativeAgentSessionInput;
type NativeAgentProjectionInput = shared.NativeAgentProjectionInput;
type NativeAgentProjectionCacheEntry = shared.NativeAgentProjectionCacheEntry;
type NativeAgentProjectionUpdateInput = shared.NativeAgentProjectionUpdateInput;
type NativeAgentMessagePageInput = shared.NativeAgentMessagePageInput;
type NativeAgentProjectionUpdate = shared.NativeAgentProjectionUpdate;
type NativeAgentTranscriptUpdateInput = shared.NativeAgentTranscriptUpdateInput;
type NativeAgentProgressiveInput = shared.NativeAgentProgressiveInput;
type NativeAgentDiscoveryUpdateInput = shared.NativeAgentDiscoveryUpdateInput;
type NativeAgentProjectionDelta = shared.NativeAgentProjectionDelta;
type NativeAgentMessagePage = shared.NativeAgentMessagePage;
type NativeAgentActivityTransition = shared.NativeAgentActivityTransition;
type NativeAgentServiceOptions = shared.NativeAgentServiceOptions;
type AgentInteractionObservation = shared.AgentInteractionObservation;
type OpenCodeRecoveryCandidate = shared.OpenCodeRecoveryCandidate;
type PromptDispatchPreparation = shared.PromptDispatchPreparation;

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

function imageMimeType(filePath: string): string {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "image/png";
}

function visibleProjectionNotices(
  notices: readonly NativeAgentNotice[] | undefined,
  incompleteTurn: OpenCodeIncompleteTurnNotice | undefined,
): NativeAgentNotice[] {
  const visible = (notices ?? [])
    .filter((notice) => notice.kind !== "error" && notice.kind !== "stopped")
    .slice(0, incompleteTurn ? 511 : 512);
  if (!incompleteTurn) return visible;
  return [
    ...visible,
    {
      kind: "incomplete-turn",
      message:
        incompleteTurn.kind === "failed"
          ? "The previous OpenCode turn ended before completion."
          : "OpenCode could not complete the previous turn after recovery.",
    },
  ];
}
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
  NativeAgentReadiness,
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

import { NativeAgentServiceDispatch } from "./native-agent-service-dispatch.ts";

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

function isNormalizedProgressiveMessage(value: unknown): boolean {
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

export abstract class NativeAgentServiceProjection extends NativeAgentServiceDispatch {
  private readonly progressiveInstanceId = randomUUID();
  private readonly progressiveTranscriptCache = new Map<
    string,
    {
      token: string;
      sourceToken?: string;
      value: NativeAgentTranscriptView;
      bytes: number;
      historyStartIndex?: number;
      historyEndIndex?: number;
    }
  >();
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
  private readonly displayTailWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingDisplayTails = new Map<
    string,
    { input: NativeAgentProgressiveInput; value: NativeAgentTranscriptView }
  >();
  private readonly progressiveHydrations = new Map<
    string,
    {
      sourceToken: string;
      snapshot?: ProviderTranscriptSnapshot;
      promise?: Promise<void>;
    }
  >();
  private readonly progressiveHydrationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly progressiveMetrics = new ProgressiveReadMetrics();

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
    for (const timer of this.displayTailWriteTimers.values()) clearTimeout(timer);
    this.displayTailWriteTimers.clear();
    this.pendingDisplayTails.clear();
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
    return detailRef;
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
  ): unknown {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const part = raw as Record<string, unknown>;
    const projected: Record<string, unknown> = { ...part };
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
    const inlineFileUrl =
      typeof part.fileUrl === "string" && part.fileUrl.startsWith("data:")
        ? part.fileUrl
        : undefined;
    if (inlineFileUrl && (part.type === "file" || part.type === "image")) {
      const content = typeof part.content === "string" ? part.content : "";
      const readablePath =
        content.startsWith("/") || content.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(content);
      if (readablePath) {
        delete projected.fileUrl;
      } else if (
        inlineFileUrl.startsWith("data:image/") &&
        Buffer.byteLength(inlineFileUrl) <= NATIVE_FILE_DETAIL_MAX_BYTES - 256
      ) {
        delete projected.fileUrl;
        projected.detailRef = this.cacheToolDetails(
          sessionKey,
          messageId,
          partPath,
          { fileDataUrl: inlineFileUrl },
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
      if (content.startsWith("data:")) {
        const filename = typeof part.filename === "string" ? part.filename.trim() : "";
        projected.content = filename || (part.type === "image" ? "image" : "Attached file");
      }
    }

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
        projected.toolDiff = {
          ...(typeof rawDiff.filePath === "string" ? { filePath: rawDiff.filePath } : {}),
          ...(typeof rawDiff.additions === "number" ? { additions: rawDiff.additions } : {}),
          ...(typeof rawDiff.deletions === "number" ? { deletions: rawDiff.deletions } : {}),
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
        this.projectionPart(sessionKey, messageId, child, `${partPath}/${field}/${index}`),
      );
    }
    if (part.task && typeof part.task === "object" && !Array.isArray(part.task)) {
      projected.task = this.projectionPart(sessionKey, messageId, part.task, `${partPath}/task`);
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
  ): { messages: unknown[]; window: NativeAgentMessageWindow } {
    const firstUserMessageIndex = messages.findIndex(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).role === "user",
    );
    const requestedStart = Math.max(0, messages.length - limit);
    const requested = messages.slice(requestedStart).map((raw, requestedIndex) => {
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
      const projectedParts = attachProgressToToolRows(
        message.parts.map((part, index) =>
          this.projectionPart(sessionKey, message.id as string, part, String(index)),
        ),
      );
      const projectedMessage = {
        id: message.id,
        role,
        content: message.content,
        parts: projectedParts,
        createdAt: message.createdAt,
        ...(typeof message.modelId === "string" ? { modelId: message.modelId } : {}),
        ...(typeof message.turnId === "string" ? { turnId: message.turnId } : {}),
        ...(typeof message.planReview === "boolean" ? { planReview: message.planReview } : {}),
        ...(promptPresentation ? { promptPresentation } : {}),
      };
      return coordinatorTranscript ? coordinatorDisplayMessage(projectedMessage) : projectedMessage;
    });
    let boundedTranscript;
    try {
      boundedTranscript = boundTranscriptResponse(requested, maximumBytes, {
        // The bound applies to the bare message array; the surrounding
        // projection is not what this ceiling protects.
        envelopeReserveBytes: 0,
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
    const messageFingerprints = messages.map((message) =>
      createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 24),
    );
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
    const bytes = Buffer.byteLength(JSON.stringify(messages));
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
    const serializedProjection = JSON.stringify(projection);
    const token = createHash("sha256")
      .update(
        `${state.incarnation}\0${serializedProjection}\0${historyEpoch}\0${historyCursor ?? ""}`,
      )
      .digest("base64url")
      .slice(0, 43);
    if (state.currentToken === token) return { token, identityChanged: false };
    state.currentToken = token;
    const bytes = Buffer.byteLength(serializedProjection);
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
      return !existing || JSON.stringify(existing) !== JSON.stringify(message);
    });
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
      ...(JSON.stringify(previousIds) === JSON.stringify(currentIds)
        ? {}
        : { liveMessageIds: currentIds }),
      deletedMessageIds: previousIds.filter(
        (id) => !currentIds.includes(id) && !currentHistoryIds.has(id),
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
    extras: { joined?: boolean; degraded?: boolean } = {},
  ): void {
    this.progressiveMetrics.record({
      domain,
      cacheTier,
      outcome,
      durationMs: this.now() - startedAt,
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
      return !existing || JSON.stringify(existing) !== JSON.stringify(message);
    });
    return {
      messageUpserts,
      ...(JSON.stringify(previousIds) === JSON.stringify(currentIds)
        ? {}
        : { liveMessageIds: currentIds }),
      deletedMessageIds: previousIds.filter((id) => !currentIds.includes(id)),
      freshness: current.freshness,
      historyEpoch: current.historyEpoch,
      historyComplete: current.historyComplete,
      ...(current.historyCursor ? { historyCursor: current.historyCursor } : {}),
      ...(current.title ? { title: current.title } : {}),
      ...(current.messageWindow ? { messageWindow: current.messageWindow } : {}),
      ...(current.providerRevision === undefined
        ? {}
        : { providerRevision: current.providerRevision }),
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
    const previous = this.displayTailWriteTimers.get(sessionKey);
    if (previous) clearTimeout(previous);
    this.pendingDisplayTails.set(sessionKey, { input, value });
    const timer = setTimeout(() => {
      void this.flushDisplayTailPersist(sessionKey);
    }, NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS);
    this.displayTailWriteTimers.set(sessionKey, timer);
  }

  private async flushDisplayTailPersist(sessionKey: string): Promise<void> {
    const timer = this.displayTailWriteTimers.get(sessionKey);
    if (timer) clearTimeout(timer);
    this.displayTailWriteTimers.delete(sessionKey);
    const pending = this.pendingDisplayTails.get(sessionKey);
    this.pendingDisplayTails.delete(sessionKey);
    if (!pending) return;
    const messageWindow = displayTailRecoveryWindow(pending.value.messageWindow);
    const tail = createNativeAgentDisplayTail({
      environmentId: pending.input.environmentId,
      agent: pending.input.agent,
      logicalSessionKey: pending.input.logicalSessionKey,
      providerSessionId: pending.value.identity.providerSessionId,
      historyEpoch: pending.value.historyEpoch,
      ...(pending.value.title ? { title: pending.value.title } : {}),
      messages: pending.value.messages,
      historyComplete: pending.value.historyComplete,
      ...(messageWindow ? { messageWindow } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    });
    if (!tail) return;
    await this.storage.putNativeAgentDisplayTail(sessionKey, tail).catch(() => undefined);
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
  ): void {
    if (snapshot.complete !== false) return;
    if (this.progressivePreviewFillsWindow(snapshot, input.liveWindow)) return;
    const sourceToken = progressiveHydrationToken(snapshot);
    const existing = this.progressiveHydrations.get(key);
    if (existing && existing.sourceToken === sourceToken) return;
    const previousTimer = this.progressiveHydrationTimers.get(key);
    if (previousTimer) clearTimeout(previousTimer);
    const entry: {
      sourceToken: string;
      snapshot?: ProviderTranscriptSnapshot;
      promise?: Promise<void>;
    } = { sourceToken };
    this.progressiveHydrations.set(key, entry);
    const timer = setTimeout(() => {
      if (this.progressiveHydrationTimers.get(key) === timer) {
        this.progressiveHydrationTimers.delete(key);
      }
      if (this.stopped) return;
      const promise = this.fillIncompleteProgressiveSnapshot(
        provider,
        sessionId,
        snapshot,
        input.liveWindow,
      )
        .then((hydrated) => {
          if (this.stopped) return;
          const current = this.progressiveHydrations.get(key);
          if (!current || current.sourceToken !== sourceToken) return;
          current.snapshot = hydrated;
          if (hydrated === snapshot) return;
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
        })
        .catch(() => undefined)
        .finally(() => {
          const current = this.progressiveHydrations.get(key);
          if (current?.promise === promise) current.promise = undefined;
        });
      entry.promise = promise;
    }, 0);
    this.progressiveHydrationTimers.set(key, timer);
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
    if (!normalized || normalized.length <= snapshot.messages.length) return snapshot;
    const historyStartIndex =
      snapshot.historyStartIndex === undefined
        ? undefined
        : Math.max(0, snapshot.historyStartIndex + snapshot.messages.length - normalized.length);
    return {
      ...snapshot,
      messages: normalized,
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
    const sourceGeneration =
      this.providerConnections.get(`${input.environmentId}\0${input.agent}`) ??
      `in-process:${input.agent}`;
    const identity = this.progressiveIdentity(input, providerSessionId, sourceGeneration);
    const normalized = this.projectionMessages(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      snapshot.messages,
      input.liveWindow.messages,
      NATIVE_SYNC_MAX_SNAPSHOT_BYTES,
      initialPromptPresentation,
      Boolean(coordinatorIdFromRuntimeId(input.environmentId)),
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
    const localPageable =
      bounded.window.canLoadEarlier === true ||
      (normalized.window.canLoadEarlier === true && normalized.window.truncationReason !== "bytes");
    // A provider tail that already fills the live window cannot produce a
    // local count slice, so incompleteness itself is the remainder signal.
    const pageable =
      localPageable ||
      (sourceComplete === false && bounded.messages.length >= input.liveWindow.messages);
    const truncated =
      Boolean(bounded.window.truncated || normalized.window.truncated) || sourceComplete === false;
    const complete = !pageable && sourceComplete !== false;
    const historyEpoch =
      snapshot.historyEpoch ??
      (previous?.value.identity.providerSessionId === providerSessionId
        ? previous.value.historyEpoch
        : randomUUID());
    const historyCursor = this.transcriptHistoryCursor(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      bounded.messages,
      historyEpoch,
      providerSessionId,
    );
    return {
      value: {
        identity,
        freshness:
          bounded.messages.length === 0 && complete
            ? "empty"
            : snapshot.freshness === "cached"
              ? "cached"
              : "current",
        messages: bounded.messages,
        messageWindow: {
          ...bounded.window,
          truncated,
          canLoadEarlier: pageable,
        },
        ...(snapshot.title ? { title: snapshot.title } : {}),
        ...(snapshot.revision === undefined ? {} : { providerRevision: snapshot.revision }),
        ...(historyCursor ? { historyCursor } : {}),
        historyEpoch,
        historyComplete: complete,
      },
      ...(boundedStartIndex === undefined
        ? {}
        : {
            historyStartIndex: boundedStartIndex,
            historyEndIndex: boundedStartIndex + bounded.messages.length,
          }),
    };
  }

  private commitProgressiveTranscript(
    key: string,
    input: NativeAgentTranscriptUpdateInput,
    projection: ProjectedProgressiveTranscript,
  ): string {
    const value = projection.value;
    const observed = this.progressiveTranscriptCache.get(key);
    if (observed?.value === value) return observed.token;
    const token = createHash("sha256")
      .update(
        JSON.stringify([
          value.identity,
          value.historyEpoch,
          value.providerRevision,
          this.progressiveSourceTokens.get(key),
          projection.historyStartIndex,
          projection.historyEndIndex,
          value.messages,
        ]),
      )
      .digest("base64url")
      .slice(0, 43);
    const current = this.progressiveTranscriptCache.get(key);
    if (!current || current.token !== token) {
      const bytes = Buffer.byteLength(JSON.stringify(value));
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
  ): Promise<ProjectedProgressiveTranscript | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const previous = this.progressiveTranscriptCache.get(key);
    const providerResult = resolved.provider.transcriptSnapshot
      ? await resolved.provider.transcriptSnapshot(resolved.session.providerSessionId, {
          limit: input.liveWindow.messages,
          targetBytes: input.liveWindow.targetBytes,
          ...(previous?.sourceToken ? { knownSourceToken: previous.sourceToken } : {}),
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
    if ("unchanged" in providerResult) {
      if (!previous) {
        throw new ProviderUnavailableError("Provider returned unchanged without a transcript base");
      }
      this.progressiveTranscriptCache.delete(key);
      this.progressiveTranscriptCache.set(key, {
        ...previous,
        sourceToken: providerResult.sourceToken,
      });
      this.progressiveSourceTokens.set(key, providerResult.sourceToken);
      return {
        value: previous.value,
        ...(previous.historyStartIndex === undefined
          ? {}
          : { historyStartIndex: previous.historyStartIndex }),
        ...(previous.historyEndIndex === undefined
          ? {}
          : { historyEndIndex: previous.historyEndIndex }),
      };
    }
    const snapshot = this.resolveProgressiveSnapshot(key, providerResult);
    if (snapshot.sourceToken) this.progressiveSourceTokens.set(key, snapshot.sourceToken);
    this.scheduleIncompleteProgressiveHydration(
      input,
      key,
      resolved.provider,
      resolved.session.providerSessionId,
      providerResult,
      resolved.session.initialPromptPresentation,
    );
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
      return {
        value: previous.value,
        ...(previous.historyStartIndex === undefined
          ? {}
          : { historyStartIndex: previous.historyStartIndex }),
        ...(previous.historyEndIndex === undefined
          ? {}
          : { historyEndIndex: previous.historyEndIndex }),
      };
    }
    return this.projectProgressiveTranscript(
      input,
      key,
      snapshot,
      resolved.session.providerSessionId,
      resolved.session.initialPromptPresentation,
    );
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
    const startedAt = this.now();
    const cached = this.progressiveTranscriptCache.get(key);
    const publish = async (): Promise<NativeAgentTranscriptView | null> => {
      const projection = await this.progressiveReadCovering(
        key,
        sessionKey,
        epoch,
        input.forceSnapshot === true,
        () => this.readProgressiveTranscript(input, key),
      );
      if (!projection) return null;
      this.commitProgressiveTranscript(key, input, projection);
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
            this.providerConnections.get(`${input.environmentId}\0${input.agent}`) ??
              `in-process:${input.agent}`,
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
      const value = await publish();
      if (!value) {
        this.recordProgressiveMetric("transcript", startedAt, "provider", "missing");
        return { viewVersion: 1, status: "missing" };
      }
      const entry = this.progressiveTranscriptCache.get(key)!;
      if (!input.forceSnapshot && input.knownToken === entry.token) {
        this.recordProgressiveMetric("transcript", startedAt, "provider", "unchanged");
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
        const operationCount =
          delta.messageUpserts.length +
          delta.deletedMessageIds.length +
          (delta.liveMessageIds?.length ?? 0);
        const deltaBytes = Buffer.byteLength(JSON.stringify(delta));
        const snapshotBytes = Buffer.byteLength(JSON.stringify(value));
        if (operationCount <= 1024 && deltaBytes < snapshotBytes) {
          this.recordProgressiveMetric("transcript", startedAt, "provider", "delta");
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
      this.recordProgressiveMetric("transcript", startedAt, "provider", "snapshot");
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
      this.recordProgressiveMetric("transcript", startedAt, "provider", "unavailable");
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
        lastAssistantModelId: lastAssistant.modelId,
        lastAssistantReasoningId: lastAssistant.reasoningId,
        sessionModelId: stateSnapshot.sessionModelId,
        sessionReasoningId: stateSnapshot.sessionReasoningId,
        persistSelection: true,
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
      this.providerConnections.get(`${input.environmentId}\0${input.agent}`) ??
      `in-process:${input.agent}`;
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
      stateSnapshot.notices,
      resolved.session.openCodeIncompleteTurnNotice,
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
    const startedAt = this.now();
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

  private storeProgressiveDiscovery(
    key: string,
    entry: {
      value: unknown;
      availability: "ready" | "stale" | "unavailable";
      expiresAt: number;
      error?: string;
    },
  ): void {
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
    const bytes = Buffer.byteLength(semantic);
    if (previous) this.progressiveDiscoveryBytes -= previous.bytes;
    this.progressiveDiscoveryCache.delete(key);
    this.progressiveDiscoveryCache.set(key, {
      ...entry,
      revision:
        previousSemantic === semantic ? (previous?.revision ?? 0) : (previous?.revision ?? 0) + 1,
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
      this.providerConnections.get(`${input.environmentId}\0${input.agent}`) ?? "in-process",
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
        case "auth":
          return provider.authStatus ? await provider.authStatus() : null;
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
      this.storeProgressiveDiscovery(cacheKey, {
        value: previous?.value,
        availability: previous?.value === undefined ? "unavailable" : "stale",
        expiresAt: this.now() + 5_000,
        error: "Discovery timed out",
      });
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
        this.storeProgressiveDiscovery(cacheKey, {
          value,
          availability: "ready",
          expiresAt: this.now() + 30_000,
        });
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
      this.providerConnections.get(`${input.environmentId}\0${input.agent}`) ??
      `in-process:${input.agent}`;
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
        )?.state;
        const unsupported = !nativeCapabilities(input.agent).slashCommands;
        const detail = unsupported ? unsupportedCommandCatalogueState() : catalogue;
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
    if (Buffer.byteLength(JSON.stringify(projection)) > NATIVE_SYNC_MAX_SNAPSHOT_BYTES) {
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
      const deltaBytes = Buffer.byteLength(JSON.stringify(delta));
      const snapshotBytes = Buffer.byteLength(JSON.stringify(projection));
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
    const bounded = this.boundedProjectedMessages(candidates, limit, targetBytes);
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
            .then(() => {
              if (!this.stopped) {
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
    const openCodeHints = input.agent === "opencode";
    const selectedModelId = resolveNativeComposerModelId({
      providerControlsModelId: providerControls?.modelId,
      sessionControlsModelId: session.controls?.modelId,
      ...(openCodeHints
        ? {
            lastAssistantModelId: hints.lastAssistantModelId,
            sessionModelId: hints.sessionModelId,
            inferredModelId: session.inferredComposerSelection?.modelId,
          }
        : {}),
      catalogDefaultModelId: providerComposer?.selectedModelId,
      firstCatalogModelId: models[0]?.id,
    });
    const resolvedSelection = withResolvedNativeComposerModel(models, selectedModelId, input.agent);
    models = resolvedSelection.models;
    const selectedModel = resolvedSelection.selectedModel;
    if (hints.persistSelection && openCodeHints) {
      const persist = openCodeComposerSelectionToPersist({
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
    const selectedReasoningId =
      providerControls?.reasoningId ??
      session.controls?.reasoningId ??
      (openCodeHints
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

  protected async projectionAuthStatus(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
  ): Promise<NativeAgentAuthStatus | undefined> {
    if (!provider.authStatus) return undefined;
    const key = `${input.environmentId}\0${input.agent}`;
    const cached = this.authStatusCache.get(key);
    if (cached) {
      if (cached.expiresAt <= this.now()) {
        cached.expiresAt = this.now() + NATIVE_AUTH_STATUS_TTL_MS;
        void Promise.resolve()
          .then(() => provider.authStatus!())
          .then((status) => {
            this.authStatusCache.set(key, {
              status,
              expiresAt: this.now() + NATIVE_AUTH_STATUS_TTL_MS,
            });
            if (!this.stopped) {
              this.storage.announceNativeAgentSessionProjection(input.environmentId);
            }
          })
          .catch(() => {
            cached.expiresAt = this.now() + NATIVE_DISCOVERY_RETRY_MS;
          });
      }
      return cached.status;
    }
    const status = await provider.authStatus().catch(() => undefined);
    if (this.authStatusCache.size >= NATIVE_AUTH_STATUS_CACHE_LIMIT) {
      const oldest = this.authStatusCache.keys().next().value as string | undefined;
      if (oldest) this.authStatusCache.delete(oldest);
    }
    this.authStatusCache.set(key, {
      status,
      expiresAt: this.now() + NATIVE_AUTH_STATUS_TTL_MS,
    });
    return status;
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
      const providerCacheKey = `${input.environmentId}\0${input.agent}`;
      generation = this.providerConnections.get(providerCacheKey) ?? `in-process:${input.agent}`;
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
      const authPromise = this.projectionAuthStatus(input, resolved.provider);
      const [
        snapshot,
        interactionSnapshot,
        queue,
        commandCatalogue,
        steerSupported,
        mcpServers,
        auth,
      ] = await Promise.all([
        snapshotPromise,
        interactionSnapshotPromise,
        queuePromise,
        slashCommandsPromise,
        steerSupportedPromise,
        mcpPromise,
        authPromise,
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
      const terminalMessages = terminalNotices
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
        const normalized = message.content.replace(/\s+/g, " ").trim();
        return normalized ? [normalized.slice(0, 80)] : [];
      })[0];
      const snapshotTitle = snapshot.title?.trim();
      const placeholderTitle =
        input.agent === "claude" &&
        (snapshotTitle === "Agent Session" || /^Session [a-f0-9]{6}$/i.test(snapshotTitle ?? ""));
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
        snapshot.notices,
        resolved.session.openCodeIncompleteTurnNotice,
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
        ...(auth ? { auth } : {}),
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
}
