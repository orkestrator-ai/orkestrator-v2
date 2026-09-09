import * as shared from "./native-agent-service-shared.js";
import { AGENT_INTERACTION_KINDS } from "@orkestrator/protocol/agent-interactions";
import {
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  nativeAsyncQuestionItemId,
  recoverBackgroundTaskLaunchId,
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
} from "@orkestrator/protocol/native-agent";
import { parseCoordinatorDelegatedPrompt } from "@orkestrator/protocol/review-evidence-frames";
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
  NATIVE_SLASH_COMMAND_CACHE_LIMIT,
  NATIVE_SLASH_COMMAND_TTL_MS,
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
  createNativeAgentDisplayTail,
  NATIVE_DISPLAY_TAIL_WRITE_DEBOUNCE_MS,
} from "./native-agent-display-tails.js";
import {
  ProgressiveReadMetrics,
  type ProgressiveCacheTier,
  type ProgressiveReadOutcome,
} from "./native-agent-progressive-metrics.js";
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
  return {
    ...current,
    ...(mergedTurns.length > 0 ? { turns: mergedTurns } : {}),
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

export abstract class NativeAgentServiceProjection extends NativeAgentServiceDispatch {
  private readonly progressiveInstanceId = randomUUID();
  private readonly progressiveTranscriptCache = new Map<
    string,
    { token: string; sourceToken?: string; value: NativeAgentTranscriptView; bytes: number }
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
  private readonly progressiveMetrics = new ProgressiveReadMetrics();

  protected async settleAndClearProgressiveReads(): Promise<void> {
    for (const timer of this.displayTailWriteTimers.values()) clearTimeout(timer);
    this.displayTailWriteTimers.clear();
    this.pendingDisplayTails.clear();
    await Promise.allSettled(this.progressiveReads.values());
    await Promise.allSettled(this.progressiveTrailing.values());
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
  ): string {
    const serializedDetails = JSON.stringify(details);
    const detailRef = createHash("sha256")
      .update(`${sessionKey}\0${messageId}\0${partPath}\0${serializedDetails}`)
      .digest("hex")
      .slice(0, 32);
    let stored: NativeAgentToolDetails = { detailRef, ...details };
    let bytes = Buffer.byteLength(serializedDetails) + detailRef.length + 32;
    if (bytes > NATIVE_TOOL_DETAIL_MAX_BYTES) {
      stored = {
        detailRef,
        toolError: "Tool details exceeded the deferred display limit.",
      };
      bytes = Buffer.byteLength(JSON.stringify(stored));
    }

    const previous = this.toolDetailCache.get(detailRef);
    if (previous) this.toolDetailCacheBytes -= previous.bytes;
    this.toolDetailCache.delete(detailRef);
    this.toolDetailCache.set(detailRef, { sessionKey, details: stored, bytes });
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
    const backgroundTaskId = backgroundTaskIdFromProjectedLaunch(part);
    if (backgroundTaskId) projected.backgroundTaskId = backgroundTaskId;

    // A staged path is the durable image reference. Re-sending the same image
    // as an inline data URL on every snapshot only duplicates transport bytes.
    if (
      part.type === "file" &&
      typeof part.content === "string" &&
      (part.content.startsWith("/") ||
        part.content.startsWith("file://") ||
        /^[A-Za-z]:[\\/]/.test(part.content)) &&
      typeof part.fileUrl === "string" &&
      part.fileUrl.startsWith("data:image/")
    ) {
      delete projected.fileUrl;
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
      return {
        id: message.id,
        role,
        content: message.content,
        parts: attachProgressToToolRows(
          message.parts.map((part, index) =>
            this.projectionPart(sessionKey, message.id as string, part, String(index)),
          ),
        ),
        createdAt: message.createdAt,
        ...(typeof message.modelId === "string" ? { modelId: message.modelId } : {}),
        ...(typeof message.turnId === "string" ? { turnId: message.turnId } : {}),
        ...(typeof message.planReview === "boolean" ? { planReview: message.planReview } : {}),
        ...(promptPresentation ? { promptPresentation } : {}),
      };
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
    const messagesInWindow = boundedTranscript.overflowed
      ? requested.slice(-1)
      : boundedTranscript.messages;
    const omitted = messages.length - messagesInWindow.length;
    return {
      messages: messagesInWindow,
      window: {
        limit,
        truncated: omitted > 0,
        ...(omitted > 0
          ? {
              truncationReason:
                messages.length > limit && requested.length === messagesInWindow.length
                  ? ("count" as const)
                  : ("bytes" as const),
              omittedMessages: omitted,
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
    const tail = createNativeAgentDisplayTail({
      environmentId: pending.input.environmentId,
      agent: pending.input.agent,
      logicalSessionKey: pending.input.logicalSessionKey,
      providerSessionId: pending.value.identity.providerSessionId,
      historyEpoch: pending.value.historyEpoch,
      ...(pending.value.title ? { title: pending.value.title } : {}),
      messages: pending.value.messages,
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

  private async readProgressiveTranscript(
    input: NativeAgentTranscriptUpdateInput,
    key: string,
  ): Promise<NativeAgentTranscriptView | null> {
    const resolved = await this.resolveProjectionSession(input);
    if (!resolved) return null;
    const providerGeneration =
      this.providerConnections.get(`${input.environmentId}\0${input.agent}`) ??
      `in-process:${input.agent}`;
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
      return previous.value;
    }
    const snapshot: ProviderTranscriptSnapshot = providerResult;
    if (snapshot.sourceToken) this.progressiveSourceTokens.set(key, snapshot.sourceToken);
    // The common identity must be identical across independently delivered
    // domains. Bridge/source generations remain bound into the transcript's
    // source token; the backend connection generation is the shared fence.
    const sourceGeneration = providerGeneration;
    const identity = this.progressiveIdentity(
      input,
      resolved.session.providerSessionId,
      sourceGeneration,
    );
    const normalized = this.projectionMessages(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      snapshot.messages,
      input.liveWindow.messages,
      NATIVE_SYNC_MAX_SNAPSHOT_BYTES,
      resolved.session.initialPromptPresentation,
    );
    const bounded = this.boundedProjectedMessages(
      normalized.messages,
      input.liveWindow.messages,
      input.liveWindow.targetBytes,
    );
    const complete = snapshot.complete !== false && !normalized.window.truncated;
    const historyEpoch =
      snapshot.historyEpoch ??
      (previous?.value.identity.providerSessionId === resolved.session.providerSessionId
        ? previous.value.historyEpoch
        : randomUUID());
    const historyCursor = this.transcriptHistoryCursor(
      nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
      bounded.messages,
      historyEpoch,
      resolved.session.providerSessionId,
    );
    const value: NativeAgentTranscriptView = {
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
        canLoadEarlier: !complete || bounded.window.truncated,
      },
      ...(snapshot.title ? { title: snapshot.title } : {}),
      ...(snapshot.revision === undefined ? {} : { providerRevision: snapshot.revision }),
      ...(historyCursor ? { historyCursor } : {}),
      historyEpoch,
      historyComplete: complete,
    };
    return value;
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
    const commit = (value: NativeAgentTranscriptView): string => {
      const observed = this.progressiveTranscriptCache.get(key);
      if (observed?.value === value) return observed.token;
      const token = createHash("sha256")
        .update(
          JSON.stringify([
            value.identity,
            value.historyEpoch,
            value.providerRevision,
            this.progressiveSourceTokens.get(key),
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
        });
        this.progressiveTranscriptBytes += bytes;
        this.trimProgressiveTranscriptCache();
        this.scheduleDisplayTailPersist(input, value);
      }
      return token;
    };
    const publish = async (): Promise<NativeAgentTranscriptView | null> => {
      const value = await this.progressiveReadCovering(
        key,
        sessionKey,
        epoch,
        input.forceSnapshot === true,
        () => this.readProgressiveTranscript(input, key),
      );
      if (!value) return null;
      commit(value);
      return value;
    };
    if (!cached && !input.forceSnapshot) {
      const persisted = await this.storage.getNativeAgentDisplayTail(sessionKey).catch(() => null);
      if (persisted && persisted.logicalSessionKey === input.logicalSessionKey) {
        const value: NativeAgentTranscriptView = {
          identity: this.progressiveIdentity(
            input,
            persisted.providerSessionId,
            this.providerConnections.get(`${input.environmentId}\0${input.agent}`) ??
              `in-process:${input.agent}`,
          ),
          freshness: persisted.messages.length === 0 ? "empty" : "cached",
          messages: persisted.messages,
          historyEpoch: persisted.historyEpoch,
          historyComplete: false,
          ...(persisted.title ? { title: persisted.title } : {}),
        };
        const token = commit(value);
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
    const composer = await this.projectionComposer(
      input,
      resolved.session,
      stateSnapshot.composer,
      stateSnapshot.controls,
      true,
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
      composerControls: nativeComposerControls(
        composer,
        stateSnapshot.status === "running" || blocked,
        capabilities,
      ),
      composer,
      capabilities,
      ...(stateSnapshot.readiness ? { readiness: stateSnapshot.readiness } : {}),
      ...(stateSnapshot.shareUrl === undefined ? {} : { shareUrl: stateSnapshot.shareUrl }),
      ...(stateSnapshot.title ? { title: stateSnapshot.title } : {}),
      ...(queue
        ? {
            queue: {
              items: [...(stateSnapshot.providerQueue?.items ?? []), ...queue.messages],
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
      ...(stateSnapshot.contextUsage ? { contextUsage: stateSnapshot.contextUsage } : {}),
      ...(asyncQuestionResponses.size > 0
        ? { asyncQuestionResponses: [...asyncQuestionResponses.values()] }
        : {}),
      ...((stateSnapshot.policy ?? resolved.session.policy)
        ? { policy: stateSnapshot.policy ?? resolved.session.policy }
        : {}),
      ...(stateSnapshot.rateLimits ? { rateLimits: stateSnapshot.rateLimits } : {}),
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
    return entry.details;
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
    const selectedModelId =
      providerControls?.modelId ??
      session.controls?.modelId ??
      providerComposer?.selectedModelId ??
      models[0]?.id;
    const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0];
    const selectedReasoningId =
      providerControls?.reasoningId ??
      session.controls?.reasoningId ??
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
      ...(selectedModel ? { selectedModelId: selectedModel.id } : {}),
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

  protected refreshProjectionSlashCommands(
    key: string,
    provider: NativeAgentRuntimeProvider,
    sessionId?: string,
  ): Promise<NativeAgentSlashCommand[]> {
    const pending = this.slashCommandRefreshes.get(key);
    if (pending) return pending.operation;
    const validity = { current: true };
    const operation = (async () => {
      const commands = (await provider.slashCommands!(sessionId)).slice(0, 512);
      if (!validity.current) {
        throw new ProviderUnavailableError("Slash command refresh was invalidated");
      }
      if (
        !this.slashCommandCache.has(key) &&
        this.slashCommandCache.size >= NATIVE_SLASH_COMMAND_CACHE_LIMIT
      ) {
        const oldest = this.slashCommandCache.keys().next().value as string | undefined;
        if (oldest) this.slashCommandCache.delete(oldest);
      }
      this.slashCommandCache.set(key, {
        commands,
        expiresAt: this.now() + NATIVE_SLASH_COMMAND_TTL_MS,
      });
      return commands;
    })();
    const entry = { operation, validity };
    this.slashCommandRefreshes.set(key, entry);
    return operation.finally(() => {
      if (this.slashCommandRefreshes.get(key) === entry) {
        this.slashCommandRefreshes.delete(key);
      }
    });
  }

  protected async projectionSlashCommands(
    input: NativeAgentProjectionInput,
    provider: NativeAgentRuntimeProvider,
    sessionId?: string,
  ): Promise<NativeAgentSlashCommand[]> {
    const capabilities = nativeCapabilities(input.agent);
    // Runtime-performed commands exist even for a provider that advertises no
    // command discovery of its own, so they are merged outside the early exit.
    const withActions = (commands: NativeAgentSlashCommand[]) =>
      withSessionActionSlashCommands(commands, capabilities);
    if (!capabilities.slashCommands || !provider.slashCommands) {
      return withActions([]);
    }
    const key = `${input.environmentId}\0${input.agent}\0${sessionId ?? "global"}`;
    const cached = this.slashCommandCache.get(key);
    if (cached) {
      if (cached.expiresAt <= this.now()) {
        // Command discovery is optional UI metadata. Keep the expired list
        // visible and update it asynchronously so a transcript refresh never
        // waits on /global/slash-commands or a provider SDK request.
        void this.refreshProjectionSlashCommands(key, provider, sessionId)
          .then(() => {
            if (!this.stopped) {
              this.storage.announceNativeAgentSessionProjection(input.environmentId);
            }
          })
          .catch(() => {
            const retained = this.slashCommandCache.get(key);
            if (retained === cached) {
              retained.expiresAt = this.now() + NATIVE_DISCOVERY_RETRY_MS;
            }
          });
      }
      return withActions(cached.commands);
    }
    try {
      const commands = await this.refreshProjectionSlashCommands(key, provider, sessionId);
      return withActions(commands);
    } catch {
      // Discovery metadata is optional. Keep the transcript usable when a
      // provider temporarily cannot enumerate commands.
      return withActions([]);
    }
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
      const slashCommandsPromise = this.projectionSlashCommands(
        input,
        resolved.provider,
        resolved.session.providerSessionId,
      );
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
        discoveredSlashCommands,
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
      // Runtime action commands are merged from the static table before the
      // bridge qualification finishes. Never leave `/steer` behind when this
      // exact bridge cannot prove the reliable steering surface.
      const slashCommands = capabilities.actions?.steer
        ? discoveredSlashCommands
        : discoveredSlashCommands.filter((command) => command.name !== "/steer");
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
      const composer = await this.projectionComposer(
        input,
        resolved.session,
        snapshot.composer,
        snapshot.controls,
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
      const contextUsage = mergedContextUsage
        ? {
            ...mergedContextUsage,
            ...(mergedContextUsage.maximumTokens === undefined && selectedModel?.contextWindow
              ? { maximumTokens: selectedModel.contextWindow }
              : {}),
            ...(mergedContextUsage.percentage === undefined &&
            (mergedContextUsage.maximumTokens ?? selectedModel?.contextWindow)
              ? {
                  percentage: Math.max(
                    0,
                    Math.min(
                      100,
                      (mergedContextUsage.usedTokens /
                        (mergedContextUsage.maximumTokens ?? selectedModel!.contextWindow!)) *
                        100,
                    ),
                  ),
                }
              : {}),
          }
        : undefined;
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
        // Claude's thinking/context choices are settings-backed session
        // defaults, while Cursor's retired variant is a pre-combined parameter
        // cross product. Remove only those provider-specific duplicates at the
        // authoritative boundary so every renderer sees the same controls.
        composerControls: nativeComposerControls(
          composer,
          snapshot.status === "running" || blocked,
          capabilities,
        ).filter(
          (control) =>
            (input.agent !== "claude" ||
              (control.id !== "parameter:thinking" && control.id !== "parameter:context1m")) &&
            (input.agent !== "cursor" || control.id !== "parameter:variant"),
        ),
        composer,
        ...(snapshot.readiness ? { readiness: snapshot.readiness } : {}),
        ...(auth ? { auth } : {}),
        capabilities,
        ...(slashCommands.length > 0 ? { slashCommands } : {}),
        ...(queue
          ? {
              queue: {
                items: [...(snapshot.providerQueue?.items ?? []), ...queue.messages],
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
        ...((snapshot.notices ?? []).some(
          (notice) => notice.kind !== "error" && notice.kind !== "stopped",
        )
          ? {
              notices: snapshot.notices!.filter(
                (notice) => notice.kind !== "error" && notice.kind !== "stopped",
              ),
            }
          : {}),
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
        ...(resolved.session.openCodeIncompleteTurnNotice
          ? {
              notices: [
                ...(snapshot.notices ?? []),
                {
                  kind: "incomplete-turn" as const,
                  message:
                    resolved.session.openCodeIncompleteTurnNotice.kind === "failed"
                      ? "The previous OpenCode turn ended before completion."
                      : "OpenCode could not complete the previous turn after recovery.",
                },
              ],
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
