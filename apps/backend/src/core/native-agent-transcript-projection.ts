import * as shared from "./native-agent-service-shared.js";
import type {
  BuildPipelineAgent,
  NativeAgentComposerState,
  NativeAgentControlUpdate,
  NativeAgentMessageWindow,
  NativeAgentSessionProjection,
  NativeAgentToolDetails,
  PersistedNativeAgentSession,
  StorageService,
  NativeAgentRuntimeProvider,
  ProviderInteractiveSnapshot,
  EnsureNativeAgentSessionInput,
  NativeAgentProjectionInput,
  NativeAgentProjectionCacheEntry,
  NativeAgentSyncState,
  NativeAgentHistoryState,
  NativeAgentServiceOptions,
  ProviderSessionStateSnapshot,
  ProviderTranscriptSnapshot,
  NativeAgentProjectionUpdateInput,
  NativeAgentMessagePageInput,
  NativeAgentProjectionUpdate,
  NativeAgentTranscriptUpdateInput,
  NativeAgentProgressiveInput,
  NativeAgentDiscoveryUpdateInput,
  NativeAgentProjectionDelta,
  NativeAgentMessagePage,
} from "./native-agent-service-shared.js";
import path from "node:path";
import { stat } from "node:fs/promises";
import {
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  nonBlank,
  readProviderStatus,
  createHash,
  NATIVE_DISCOVERY_RETRY_MS,
  NATIVE_MISSING_SESSION_GRACE_MS,
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
} from "./native-agent-service-shared.js";
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { type CommandCatalogueSnapshot } from "./native-agent-command-catalogue.js";
import {
  nativeAsyncQuestionItemId,
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  NATIVE_AGENT_REVISED_MESSAGES_MAX,
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
  nativeAgentApprovalModes,
  normalizeNativeAgentSelectionPricing,
  resolveNativeAgentApprovalMode,
} from "@orkestrator/protocol/native-agent";
import { sessionIncompleteTurnNotice } from "./models.js";
import { NativeAgentResumeIdentityObserver } from "./native-agent-resume-identity.js";
import { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import { randomUUID } from "node:crypto";
import { legacyCompatibilityCounts } from "./change-tracking/index.js";
import { revisedRowsReconciliationToken } from "@orkestrator/protocol/node/revised-rows";
import { claudeReasoningSelection } from "@orkestrator/protocol/claude-model-catalog";
import { type AgentInteractionSnapshot } from "@orkestrator/protocol/agent-interactions";
import type { PermissionRuleEnforcer } from "./permission-rules/enforcer.js";
import { parseCoordinatorDelegatedPrompt } from "@orkestrator/protocol/review-evidence-frames";
import {
  inferredComposerSelectionToPersist,
  lastAssistantModelRef,
} from "./native-agent-composer-selection.js";
import { nativeAgentPlatformPolicy } from "./native-agent-platform-policy.js";
import { NativeAgentSessionTitles } from "./native-agent-session-titles.js";
import { heldSessionModel } from "./session-held-model.js";
import { projectedRetiredDispatch } from "./native-agent-retired-dispatch.js";
import {
  createNativeAgentDisplayTail,
  displayTailRecoveryWindow,
} from "./native-agent-display-tails.js";
import { NativeAgentDisplayTailScheduler } from "./native-agent-display-tail-scheduler.js";
import { UsageHistoryRecorder } from "./usage-history-recorder.js";
import {
  ProgressiveReadMetrics,
  ProgressiveReadPhaseTimer,
  monotonicMs,
  type ProgressiveCacheTier,
  type ProgressiveReadOutcome,
  type ProgressiveReadPhases,
} from "./native-agent-progressive-metrics.js";
import { readReadableHostFile } from "./path-safety.js";
import { transcriptMediaPins } from "./transcript-media-pins.js";
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
import { unsupportedCommandCatalogueState } from "@orkestrator/protocol/agent-command-catalogue";
import { goalPublicView, sessionGoal } from "@orkestrator/protocol/native-agent-goal";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import { type CompatibilityPathId, compatibilityPathUsage } from "./compatibility-path-usage.js";
import { withNativeTerminalMessages } from "@orkestrator/protocol/native-terminal-rows";
import { nativeTerminalMessages } from "./native-terminal-messages.js";
import {
  DIRECT_PAGE_ROW_MAX_BYTES,
  PROGRESSIVE_HYDRATION_MAX_ATTEMPTS,
  PROGRESSIVE_HYDRATION_RETRY_BASE_MS,
  attachProgressToToolRows,
  backgroundTaskIdFromProjectedLaunch,
  discoveryAnnouncementKey,
  displayMessage,
  firstNamedCursor,
  firstUserMessageOf,
  imageMimeType,
  isNormalizedProgressiveMessage,
  mergeContextUsageTurns,
  mergeNativeAgentQueueItems,
  modelCatalogKey,
  normalizeInteractionKinds,
  normalizedProgressiveMessages,
  progressiveHydrationToken,
  providerReportedImagePath,
  redactArtifactGrant,
  visibleProjectionNotices,
  withProviderContextWindow,
} from "./native-agent-projection-helpers.js";

export {
  attachProgressToToolRows,
  mergeContextUsageTurns,
  mergeNativeAgentQueueItems,
  withProviderContextWindow,
} from "./native-agent-projection-helpers.js";

interface ProjectedProgressiveTranscript {
  value: NativeAgentTranscriptView;
  historyStartIndex?: number;
  historyEndIndex?: number;
  /** Artifact ledger revision the view's artifact parts reflect. */
  ledgerRevision?: number;
  /** Ids in `value.revisedMessages` sent because a publication reached them. */
  ledgerRevisedIds?: readonly string[];
}

/**
 * Why a session's latest progressive view carried no direct cursor, kept only
 * to attribute the joined pages that follow (0232 item 3): a source with no
 * direct pages retires with the `/messages` fallback, while a source that
 * pages but named or wrapped no cursor needs direct recovery first.
 */
type DirectHistoryGap = "unpaged-source" | "unnamed-cursor";
/** Sessions whose gap is kept; a view with a direct cursor removes its entry. */
const DIRECT_HISTORY_GAPS_MAX = 512;

function joinedPageCounter(gap: DirectHistoryGap | undefined): CompatibilityPathId {
  return gap ? `history.joined-v1-page.${gap}` : "history.joined-v1-page";
}

/**
 * Whether user rows of this runtime may open with a server-authored context
 * block: a coordinator conversation's, or a bug report's pointer to its
 * briefing. Both use the coordinator context tags.
 */
function hasServerPromptPreamble(environmentId: string): boolean {
  return Boolean(
    coordinatorIdFromRuntimeId(environmentId) || bugReportIdFromRuntimeId(environmentId),
  );
}

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

/** A projection session resolved against storage and its runtime provider. */
export interface ResolvedProjectionSession {
  key: string;
  session: PersistedNativeAgentSession;
  provider: NativeAgentRuntimeProvider;
  transient: false;
}

/** What the transcript projection needs from the service that wires it. */
export interface NativeAgentTranscriptProjectionHost {
  storage: StorageService;
  options: NativeAgentServiceOptions;
  catalogs: NativeAgentCatalogCache;
  /** Last provider-owned activity; read without touching the provider. */
  observedActivity(
    sessionKey: string,
  ): { providerSessionId: string; contentRevision?: string } | undefined;
  /** The bridge generation serving this environment and agent, if a provider is cached. */
  providerGeneration(
    input: Pick<NativeAgentProjectionInput, "environmentId" | "agent">,
  ): string | undefined;
  now(): number;
  isStopped(): boolean;
  assertProjectionInput(input: NativeAgentProjectionInput): void;
  resolveProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<ResolvedProjectionSession | null>;
  provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider>;
  recordAsyncQuestionAttention(
    environmentId: string,
    sessionKey: string,
    itemIds: readonly string[],
  ): Promise<void>;
  /** Settle a parked prompt dispatch against its provider in the background. */
  scheduleAmbiguousDispatchSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    provider: NativeAgentRuntimeProvider,
  ): void;
  /** Settle a parked steer against its provider in the background. */
  scheduleAmbiguousSteerSettle(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    provider: NativeAgentRuntimeProvider,
  ): void;
  /**
   * Orkestrator's permission rules (todo 0723): answers the pending requests a
   * rule covers before any card is built, and offers "Approve and remember"
   * on the rest. Absent in tests that do not wire it.
   */
  permissionRules?: PermissionRuleEnforcer;
}

/** The goal a view shows. The session record is the only place it lives. */
function goalProjectionField(session: PersistedNativeAgentSession) {
  const goal = sessionGoal(session);
  return goal ? { goal: goalPublicView(goal) } : {};
}

/**
 * Renderer views of provider sessions: the legacy full projection, its sync
 * deltas and history pages, the progressive transcript/state/discovery reads,
 * tool details and the restart display tails.
 *
 * Every cache here is bounded (`toolDetailCacheBytes`, `projectionHistoryBytes`,
 * `progressiveTranscriptBytes`, the projected-message and direct-page caches)
 * and reconstructible: providers stay authoritative, so dropping any of it
 * costs a re-read, never user state.
 */
export class NativeAgentTranscriptProjection {
  /**
   * The session's pending requests as a card list: the provider's own list,
   * minus what a permission rule just answered, with remember offers. A
   * transient read has no stored session for a rule to belong to.
   */
  private pendingInteractions(resolved: {
    session: PersistedNativeAgentSession;
    provider: NativeAgentRuntimeProvider;
    transient: boolean;
  }): Promise<Pick<AgentInteractionSnapshot, "requests" | "revision">> {
    const interactions = resolved.provider.interactions;
    if (!interactions) return Promise.resolve({ requests: [], revision: 0 });
    const read = interactions.listPendingInteractions(resolved.session.providerSessionId);
    const rules = this.host.permissionRules;
    if (!rules || resolved.transient) return read;
    return read.then((snapshot) =>
      rules
        .apply(resolved.session, resolved.provider, snapshot)
        .then((applied) => applied.snapshot)
        .catch(() => snapshot),
    );
  }

  /** Bounded, reconstructible view cache; providers remain authoritative. */
  private readonly projectionCache = new Map<string, NativeAgentProjectionCacheEntry>();
  /** Bounded wire revisions for conditional/delta projection reads. */
  private readonly projectionSync = new Map<string, NativeAgentSyncState>();
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
  private readonly projectionRevisions = new Map<
    string,
    { generation: string; revision: number }
  >();
  private projectionSyncBytes = 0;
  /** Bounded normalized transcript source for independent history pages. */
  private readonly projectionHistory = new Map<string, NativeAgentHistoryState>();
  private projectionHistoryBytes = 0;
  /** By session key: why its latest progressive view had no direct cursor. */
  private readonly directHistoryGaps = new Map<string, DirectHistoryGap>();
  /**
   * When each projection key's current run of `missing` provider reads began.
   *
   * Dates the `connecting` overlay so the grace can expire into a reportable
   * failure. Cleared by any read that finds the session, and by every path that
   * drops the key's cache entry, so it stays bounded by `projectionCache`
   * rather than growing with key churn.
   */
  private readonly projectionMissingSince = new Map<string, number>();
  /** Heavy, reconstructible fields omitted from ordinary renderer snapshots. */
  private readonly toolDetailCache = new Map<
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
  private readonly pinnedToolDetailRefs = new Set<string>();
  private toolDetailCacheBytes = 0;
  /** Serializes projection reads so late provider responses cannot roll state back. */
  private readonly projectionRefreshes = new Map<
    string,
    Promise<NativeAgentSessionProjection | null>
  >();
  private readonly projectionRefreshDescriptors = new Map<
    string,
    { epoch: number; signature: string; environmentId: string }
  >();
  /** Invalidates an in-flight read when a logical tab changes provider identity. */
  private readonly projectionEpochs = new Map<string, number>();
  /** Session-scoped stop result retained until the next authoritative projection. */
  private readonly stopNotices = new Map<string, string>();
  /** The backend's choice of title per session, and its push to the provider. */
  private readonly sessionTitles: NativeAgentSessionTitles;
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
  /**
   * Durable token and spend history, fed from the per-turn usage every
   * provider already reports. The recorder de-duplicates and writes off the
   * projection path, so a projection never waits on it.
   */
  private readonly usageRecorder = new UsageHistoryRecorder({
    // Optional because narrow test doubles of the storage omit it.
    write: ({ sessionKey, environmentId, platform, providerSessionId, turns }) =>
      typeof this.storage.recordAgentUsageTurns === "function"
        ? this.storage.recordAgentUsageTurns({
            sessionKey,
            environmentId,
            platform,
            ...(providerSessionId ? { providerSessionId } : {}),
            turns: turns ?? [],
          })
        : 0,
  });
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

  private readonly resumeIdentity: NativeAgentResumeIdentityObserver;
  private readonly storage: StorageService;
  private readonly options: NativeAgentServiceOptions;
  private readonly catalogs: NativeAgentCatalogCache;

  constructor(private readonly host: NativeAgentTranscriptProjectionHost) {
    this.storage = host.storage;
    this.resumeIdentity = new NativeAgentResumeIdentityObserver(this.storage);
    this.options = host.options;
    this.catalogs = host.catalogs;
    this.sessionTitles = new NativeAgentSessionTitles({
      storage: {
        // Optional because narrow test doubles of the storage omit it.
        recordNativeAgentSessionBackendTitle: (key, title) =>
          typeof this.storage.recordNativeAgentSessionBackendTitle === "function"
            ? this.storage.recordNativeAgentSessionBackendTitle(key, title)
            : Promise.resolve(false),
      },
      ...(this.options.sessionTitles ? { generator: this.options.sessionTitles } : {}),
      onTitleChosen: (sessionKey, title, providerSessionId) =>
        this.showChosenTitle(sessionKey, title, providerSessionId),
      now: () => this.host.now(),
    });
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
      ...this.options.projectedMessageCacheLimits,
    });
    this.directHistoryPages = new DirectHistoryPageCache({
      maxEntries: NATIVE_DIRECT_PAGE_CACHE_MAX_ENTRIES,
      maxBytes: NATIVE_DIRECT_PAGE_CACHE_MAX_BYTES,
      maxSessionEntries: NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_ENTRIES,
      maxSessionBytes: NATIVE_DIRECT_PAGE_CACHE_MAX_SESSION_BYTES,
      ttlMs: NATIVE_DIRECT_PAGE_CACHE_TTL_MS,
      ...this.options.directHistoryPageCacheLimits,
    });
  }

  /**
   * A title the backend just chose, shown in the cached projections without
   * waiting for the next provider read: an idle session may not be read again
   * for a long time.
   */
  private showChosenTitle(sessionKey: string, title: string, providerSessionId: string): void {
    for (const key of [sessionKey, `${sessionKey}\0sync-v1`]) {
      const entry = this.projectionCache.get(key);
      if (
        !entry ||
        entry.projection.sessionId !== providerSessionId ||
        entry.projection.title === title
      )
        continue;
      this.commitProjection(
        key,
        entry.input,
        { ...entry.projection, title },
        entry.generation,
        this.projectionEpochs.get(key) ?? 0,
      );
    }
  }

  /**
   * A background recovery of the same conversation keeps the title the view
   * already shows: it carries only the provider's own, which the read path
   * may have replaced with the backend's (`sessionTitles.resolve`).
   */
  private withShownTitle(
    key: string,
    projection: ProjectedProgressiveTranscript,
  ): ProjectedProgressiveTranscript {
    const shown = this.progressiveTranscriptCache.get(key)?.value;
    if (
      !shown?.title ||
      shown.title === projection.value.title ||
      shown.identity.providerSessionId !== projection.value.identity.providerSessionId
    ) {
      return projection;
    }
    return { ...projection, value: { ...projection.value, title: shown.title } };
  }

  /** Keep a session's stop result until its next authoritative projection. */
  recordStopNotice(sessionKey: string, message: string): void {
    this.stopNotices.set(sessionKey, message);
    while (this.stopNotices.size > 256) {
      const oldest = this.stopNotices.keys().next().value as string | undefined;
      if (oldest) this.stopNotices.delete(oldest);
      else break;
    }
  }

  /** Projection reads and title choices still in flight, for shutdown to settle. */
  pendingRefreshes(): Promise<unknown>[] {
    return [...this.projectionRefreshes.values(), ...this.sessionTitles.pending()];
  }

  /**
   * Test-only view of the caches this projection owns and of a few internal
   * steps. Service tests reach projection state here, never through the
   * service; production code must not call it.
   */
  forTesting() {
    return {
      projectionCache: this.projectionCache,
      quietObservationFlag: (session: PersistedNativeAgentSession) =>
        this.quietObservationFlag(session),
      projectionEpochs: this.projectionEpochs,
      projectionRefreshes: this.projectionRefreshes,
      stopNotices: this.stopNotices,
      progressiveTranscriptCache: this.progressiveTranscriptCache,
      progressiveReads: this.progressiveReads,
      progressiveDirtyFollowUps: this.progressiveDirtyFollowUps,
      progressiveTrailing: this.progressiveTrailing,
      progressiveHydrations: this.progressiveHydrations,
      progressiveMetrics: this.progressiveMetrics,
      progressiveReadWaiterCount: () => this.progressiveReadWaiterCount,
      projectedMessages: this.projectedMessages,
      directHistoryPages: this.directHistoryPages,
      projectionHistory: this.projectionHistory,
      directHistoryGaps: this.directHistoryGaps,
      updateProjectionHistory: (...args: Parameters<typeof this.updateProjectionHistory>) =>
        this.updateProjectionHistory(...args),
      toolDetailCache: this.toolDetailCache,
      toolDetailCacheBytes: () => this.toolDetailCacheBytes,
      /** Simulate capacity eviction of every tool detail. */
      evictToolDetails: () => {
        this.toolDetailCache.clear();
        this.toolDetailCacheBytes = 0;
      },
      invalidateProjection: (key: string) => this.invalidateProjection(key),
      pruneProjectionEpoch: (key: string) => this.pruneProjectionEpoch(key),
      projectionPart: (sessionKey: string, messageId: string, raw: unknown, partPath: string) =>
        this.projectionPart(sessionKey, messageId, raw, partPath) as Record<string, unknown>,
      transcriptDelta: (previous: NativeAgentTranscriptView, current: NativeAgentTranscriptView) =>
        this.transcriptDelta(previous, current),
      recoverableDispatchStatus: (createdAt: string, kind?: "prompt" | "steer") =>
        this.recoverableDispatchStatus(createdAt, kind),
    };
  }

  /** Drop every legacy projection cache; run after shutdown settled the reads. */
  clear(): void {
    this.projectionCache.clear();
    this.projectionSync.clear();
    this.projectionSyncBytes = 0;
    this.projectionHistory.clear();
    this.projectionHistoryBytes = 0;
    this.directHistoryGaps.clear();
    this.toolDetailCache.clear();
    this.pinnedToolDetailRefs.clear();
    this.toolDetailCacheBytes = 0;
    this.projectionRefreshes.clear();
    this.projectionRefreshDescriptors.clear();
    this.projectionEpochs.clear();
  }

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
  private recoverableDispatchStatus(
    createdAt: string,
    kind: "prompt" | "steer" = "prompt",
  ): "reconciling" | "action-required" {
    if (kind === "steer") return "action-required";
    const created = Date.parse(createdAt);
    const now = this.host.now();
    if (!Number.isFinite(created) || created > now) return "action-required";
    return now - created >= shared.PARKED_DISPATCH_RECONCILE_GRACE_MS
      ? "action-required"
      : "reconciling";
  }

  async settleAndClearProgressiveReads(): Promise<void> {
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

  private cacheToolDetails(
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
  private cacheRemoteToolDetails(
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

  private pruneToolDetailCache(): void {
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

  private projectionPart(
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
      projected = displayMessage(projectedMessage, Boolean(context.coordinator));
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

  private projectionMessages(
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

  private boundedProjectedMessages(
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
      updatedAt: this.host.now(),
    });
    this.projectionHistoryBytes += bytes;
    while (this.projectionHistoryBytes > NATIVE_HISTORY_CACHE_MAX_BYTES) {
      const oldest = this.projectionHistory.keys().next().value as string | undefined;
      if (!oldest || oldest === sessionKey) break;
      const entry = this.projectionHistory.get(oldest);
      if (entry) this.projectionHistoryBytes -= entry.bytes;
      this.projectionHistory.delete(oldest);
      this.directHistoryGaps.delete(oldest);
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
      state.revisions.push({ token, projection, bytes, createdAt: this.host.now() });
      state.revisionBytes += bytes;
      this.projectionSyncBytes += bytes;
    }
    const expiredBefore = this.host.now() - NATIVE_SYNC_REVISION_TTL_MS;
    while (
      state.revisions.length > NATIVE_SYNC_MAX_REVISIONS ||
      state.revisionBytes > NATIVE_SYNC_MAX_REVISION_BYTES ||
      (state.revisions[0]?.createdAt ?? this.host.now()) < expiredBefore
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
          updatedAt: new Date(this.host.now()).toISOString(),
        });
      },
    });
  }

  /** Immediate checkpoint of a pending tail (tests and explicit flushes). */
  async flushDisplayTailPersist(sessionKey: string): Promise<void> {
    await this.displayTailScheduler.flush(sessionKey);
  }

  private recordDirectHistoryGap(sessionKey: string, gap: DirectHistoryGap | undefined): void {
    this.directHistoryGaps.delete(sessionKey);
    if (!gap) return;
    this.directHistoryGaps.set(sessionKey, gap);
    if (this.directHistoryGaps.size > DIRECT_HISTORY_GAPS_MAX) {
      const oldest = this.directHistoryGaps.keys().next().value as string | undefined;
      if (oldest) this.directHistoryGaps.delete(oldest);
    }
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
     * not hold the whole window, and could not name a cursor at a row it kept
     * either, dropped the row the cursor names, and without this read the
     * history before what it kept is unreachable.
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
        if (this.host.isStopped() || this.progressiveHydrations.get(key) !== entry) return;
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
              this.host.isStopped() ||
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
              this.withShownTitle(
                key,
                this.projectProgressiveTranscript(
                  input,
                  key,
                  hydrated,
                  sessionId,
                  initialPromptPresentation,
                ),
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
    const sourceGeneration = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
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
      hasServerPromptPreamble(input.environmentId),
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
    /*
     * Otherwise the provider names a cursor for the first row the view kept
     * (or, for a provider that pages by message, the first kept row a page can
     * end at). Rows between the view's start and that position come back on
     * the first page as well, and the client deduplicates them by id; rows the
     * bound dropped come back after them. If only an OpenCode inline error row
     * remains, no whole-message boundary can name a cursor: joined paging
     * must recover its dropped main row. Without this, the client could only
     * page by minting a joined cursor, a whole transcript read (0232).
     */
    const providerHistoryCursor = !snapshot.historyCursor
      ? undefined
      : viewStartsAtSnapshot
        ? snapshot.historyCursor
        : firstNamedCursor(bounded.messages, snapshot.historyCursorBefore);
    const directHistoryCursor =
      providerHistoryCursor && snapshot.historyEpoch !== undefined
        ? encodeDirectHistoryCursor({
            sessionKey,
            providerSessionId,
            historyEpoch: snapshot.historyEpoch,
            providerCursor: providerHistoryCursor,
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
    // Only a view with older history to load can send a click to joined paging.
    // A pageable source can omit its cursor at the first message, even when
    // our byte bound then drops leading rows. Prefer explicit capability;
    // snapshots predating that field can still prove paging with a cursor.
    this.recordDirectHistoryGap(
      sessionKey,
      complete || directHistoryCursor
        ? undefined
        : (snapshot.historyPageable ?? Boolean(snapshot.historyCursor))
          ? "unnamed-cursor"
          : "unpaged-source",
    );
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
      hasServerPromptPreamble(input.environmentId),
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
        coordinator: hasServerPromptPreamble(input.environmentId),
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
    const resolved = await this.host.resolveProjectionSession(input);
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
      const title = this.sessionTitles.resolve({
        sessionKey: resolved.key,
        session: resolved.session,
        agent: input.agent,
        ...(projection.value.title ? { providerTitle: projection.value.title } : {}),
        ...firstUserMessageOf(
          projection.value.messages,
          projection.value.historyCursor === undefined
            ? projection.value.messageWindow
            : { truncated: true },
        ),
        transient: resolved.transient,
        ...(resolved.provider.setSessionTitle
          ? {
              setProviderTitle: (id: string, value: string) =>
                resolved.provider.setSessionTitle!(id, value),
            }
          : {}),
      });
      if (title !== projection.value.title) {
        const { title: _providerTitle, ...rest } = projection.value;
        projection = { ...projection, value: { ...rest, ...(title ? { title } : {}) } };
      }
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
    this.host.assertProjectionInput(input);
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
            this.host.providerGeneration(input) ?? `in-process:${input.agent}`,
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
    timer?: ProgressiveReadPhaseTimer,
  ): Promise<NativeAgentSessionStateView | null> {
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) return null;
    const advertisedCapabilities = nativeCapabilities(input.agent);
    timer?.sourceStarted();
    const sourceReads = Promise.all([
      this.resumeIdentity.read(resolved.session, () =>
        resolved.provider.sessionStateSnapshot
          ? resolved.provider.sessionStateSnapshot(resolved.session.providerSessionId)
          : resolved.provider.interactiveSnapshot
            ? this.sharedInteractiveSnapshot(
                input,
                resolved.provider,
                resolved.session.providerSessionId,
              )
            : readProviderStatus(resolved.provider, resolved.session.providerSessionId),
      ),
      this.pendingInteractions(resolved),
      advertisedCapabilities.queue
        ? this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : Promise.resolve(null),
      advertisedCapabilities.actions?.steer
        ? (resolved.provider
            .steerSupported?.(resolved.session.providerSessionId)
            .catch(() => false) ?? Promise.resolve(false))
        : Promise.resolve(false),
    ]);
    // A failed source read ends the phase too, so `unavailable` keeps its time.
    const [snapshot, interactionSnapshot, queue, steerSupported] = await sourceReads.finally(() =>
      timer?.sourceEnded(),
    );
    if (snapshot.status === "missing") return null;
    const commandRevision = (snapshot as ProviderSessionStateSnapshot).commandCatalogueRevision;
    if (commandRevision !== undefined) {
      this.catalogs.observeCommandRevision(
        input,
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
    // Body-free: it shows the title already chosen, never chooses one.
    const stateTitle = this.sessionTitles.resolve({
      sessionKey: resolved.key,
      session: resolved.session,
      agent: input.agent,
      ...(stateSnapshot.title ? { providerTitle: stateSnapshot.title } : {}),
      reachesStart: false,
      transient: resolved.transient,
      ...(resolved.provider.setSessionTitle
        ? {
            setProviderTitle: (id: string, value: string) =>
              resolved.provider.setSessionTitle!(id, value),
          }
        : {}),
    });
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
    const providerGeneration = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
    const sourceGeneration = providerGeneration;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (resolved.session.pendingDispatch) {
      this.host.scheduleAmbiguousDispatchSettle(
        input,
        sessionKey,
        resolved.session.pendingDispatch.requestId,
        resolved.provider,
      );
    }
    if (resolved.session.pendingSteer) {
      this.host.scheduleAmbiguousSteerSettle(
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
    const retiredDispatch = projectedRetiredDispatch(
      input.agent,
      resolved.session,
      this.host.now(),
    );
    const notices = visibleProjectionNotices(
      input.agent,
      stateSnapshot.notices,
      sessionIncompleteTurnNotice(resolved.session),
      retiredDispatch,
    );
    // The transcript read never sees session state, so the rows saying how the
    // turn ended travel here. A kept stop result stays with the full read the
    // stop answers with, which consumes it.
    const terminalMessages = nativeTerminalMessages({
      notices: stateSnapshot.notices,
      error: stateSnapshot.error,
      turnStartedAt: stateSnapshot.turnStartedAt,
    });
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
        ...this.quietObservationFlag(resolved.session),
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
      ...(stateTitle ? { title: stateTitle } : {}),
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
      ...goalProjectionField(resolved.session),
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
      ...(retiredDispatch ? { retiredDispatch } : {}),
      ...(stateSnapshot.backgroundTasks ? { backgroundTasks: stateSnapshot.backgroundTasks } : {}),
      ...(stateSnapshot.suggestedPrompt ? { suggestedPrompt: stateSnapshot.suggestedPrompt } : {}),
      ...(stateSnapshot.completionBlockedByBackgroundTasks === undefined
        ? {}
        : {
            completionBlockedByBackgroundTasks: stateSnapshot.completionBlockedByBackgroundTasks,
          }),
      ...(terminalMessages.length > 0 ? { terminalMessages } : {}),
    };
  }

  async getSessionStateUpdate(
    input: NativeAgentProgressiveInput,
  ): Promise<NativeAgentSessionStateUpdate> {
    this.host.assertProjectionInput(input);
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
    const phases = new ProgressiveReadPhaseTimer();
    try {
      const value = await phases.covering(() =>
        this.progressiveReadCovering(
          key,
          sessionKey,
          epoch,
          input.forceSnapshot === true,
          phases.own(() => this.readProgressiveSessionState(input, phases)),
        ),
      );
      if (!value) {
        this.recordProgressiveMetric("state", startedAt, "provider", "missing", phases.phases());
        return { viewVersion: 1, status: "missing" };
      }
      const token = phases.normalize(() =>
        createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 43),
      );
      const previous = this.progressiveStateCache.get(key);
      this.progressiveStateCache.delete(key);
      this.progressiveStateCache.set(key, { token, value });
      while (this.progressiveStateCache.size > 128) {
        const oldest = this.progressiveStateCache.keys().next().value as string | undefined;
        if (!oldest || oldest === key) break;
        this.progressiveStateCache.delete(oldest);
      }
      if (!input.forceSnapshot && input.knownToken === token) {
        this.recordProgressiveMetric("state", startedAt, "provider", "unchanged", phases.phases());
        return { viewVersion: 1, status: "unchanged", token, identity: value.identity };
      }
      this.recordProgressiveMetric("state", startedAt, "provider", "snapshot", phases.phases());
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
      this.recordProgressiveMetric("state", startedAt, "provider", "unavailable", phases.phases());
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

  /**
   * Store one discovery section. Returns `changed` when the stored section
   * differs at all (its revision moves), and `announce` when a view would
   * show something different enough to be told now:
   *
   * - A retained value that only flips between `ready` and `stale` is not
   *   announced. A renewal that misses its 2 s deadline and then succeeds
   *   with the same value announced twice per 30 s expiry and reset an idle
   *   view's quiet backoff each time (0049 code item 5); the view still sees
   *   the stored availability on its next read.
   * - Diagnostic drift counters in the runtime section are not announced:
   *   `unknownEvents` only ever grows while the provider streams events this
   *   backend has no branch for, so every renewal of an idle session would
   *   otherwise announce. The set of unknown kinds still is.
   */
  private storeProgressiveDiscovery(
    key: string,
    entry: {
      value: unknown;
      availability: "ready" | "stale" | "unavailable";
      expiresAt: number;
      error?: string;
    },
  ): { changed: boolean; announce: boolean } {
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
    const retainedValue =
      previous !== undefined &&
      previous.value !== undefined &&
      entry.value !== undefined &&
      previous.availability !== "unavailable" &&
      entry.availability !== "unavailable";
    const announce =
      changed &&
      (!retainedValue ||
        discoveryAnnouncementKey(previous.value) !== discoveryAnnouncementKey(entry.value));
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
    return { changed, announce };
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
      this.host.providerGeneration(input) ?? "in-process",
    )}`;
    if (
      activeDiscoveryJobs >= 4 ||
      (this.progressiveDiscoveryJobsByProvider.get(providerKey) ?? 0) >= 2
    )
      return;
    const read = async (): Promise<unknown> => {
      switch (section) {
        case "models":
          return (await this.catalogs.refreshModels(input.environmentId)).filter(
            (model) => model.platform === input.agent,
          );
        case "commands":
          return this.catalogs.slashCommands(input, provider, providerSessionId);
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
    // The job runs behind the views that asked for it, so its timing is its
    // own sample: provider read, then committing the section.
    const jobStartedAt = monotonicMs();
    const phases = new ProgressiveReadPhaseTimer();
    const timedRead = phases.own(async () => {
      phases.sourceStarted();
      try {
        return await read();
      } finally {
        phases.sourceEnded();
      }
    });
    const operation = phases.covering(() => this.progressiveRead(cacheKey, timedRead));
    let settled = false;
    const deadline = setTimeout(() => {
      if (
        settled ||
        this.host.isStopped() ||
        (this.projectionEpochs.get(sessionKey) ?? 0) !== epoch
      )
        return;
      const previous = this.progressiveDiscoveryCache.get(cacheKey);
      const { announce } = this.storeProgressiveDiscovery(cacheKey, {
        value: previous?.value,
        availability: previous?.value === undefined ? "unavailable" : "stale",
        expiresAt: this.host.now() + 5_000,
        error: "Discovery timed out",
      });
      if (!announce) return;
      this.storage.announceNativeAgentSessionProjection(input.environmentId, {
        agent: input.agent,
        logicalSessionKey: input.logicalSessionKey,
      });
    }, 2_000);
    void operation
      .then((value) => {
        settled = true;
        clearTimeout(deadline);
        if (this.host.isStopped() || (this.projectionEpochs.get(sessionKey) ?? 0) !== epoch) return;
        const { announce } = phases.normalize(() =>
          this.storeProgressiveDiscovery(cacheKey, {
            value,
            availability: "ready",
            expiresAt: this.host.now() + 30_000,
          }),
        );
        this.recordProgressiveMetric(
          "discovery",
          jobStartedAt,
          "provider",
          announce ? "snapshot" : "unchanged",
          phases.phases(),
        );
        // Every section expires after 30 s and an idle view's own read renews
        // it. Announcing an unchanged renewal would wake that view (and reset
        // its quiet backoff) four times per expiry for nothing: a view reads
        // only values, and they did not change.
        if (!announce) return;
        this.storage.announceNativeAgentSessionProjection(input.environmentId, {
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
        });
      })
      .catch((error) => {
        settled = true;
        clearTimeout(deadline);
        if (this.host.isStopped() || (this.projectionEpochs.get(sessionKey) ?? 0) !== epoch) return;
        this.recordProgressiveMetric(
          "discovery",
          jobStartedAt,
          "provider",
          "unavailable",
          phases.phases(),
        );
        const previous = this.progressiveDiscoveryCache.get(cacheKey);
        this.storeProgressiveDiscovery(cacheKey, {
          value: previous?.value,
          availability: previous?.value === undefined ? "unavailable" : "stale",
          expiresAt: this.host.now() + 5_000,
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
    this.host.assertProjectionInput(input);
    if (input.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) {
      throw new Error("Native agent progressive view version is unsupported");
    }
    const startedAt = monotonicMs();
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) {
      this.recordProgressiveMetric("discovery", startedAt, "memory", "missing");
      return { viewVersion: 1, status: "missing" };
    }
    const assembleStartedAt = monotonicMs();
    const providerGeneration = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
    const identity = this.progressiveIdentity(
      input,
      resolved.session.providerSessionId,
      providerGeneration,
    );
    const sections: NativeAgentDiscoveryView["sections"] = {};
    for (const section of input.sections) {
      const key = this.progressiveKey(input, `discovery:${section}`);
      const cached = this.progressiveDiscoveryCache.get(key);
      const expired = !cached || cached.expiresAt <= this.host.now();
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
        const catalogue = this.catalogs.peekCommands(input, resolved.session.providerSessionId);
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
    // Served from the section cache: the provider reads are the jobs above,
    // each recorded when it settles. This read's own cost is assembling and
    // hashing the view.
    const normalizeMs = monotonicMs() - assembleStartedAt;
    if (!input.forceSnapshot && input.knownToken === token) {
      this.recordProgressiveMetric("discovery", startedAt, "memory", "unchanged", { normalizeMs });
      return { viewVersion: 1, status: "unchanged", token, identity };
    }
    this.recordProgressiveMetric("discovery", startedAt, "memory", "snapshot", { normalizeMs });
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
    this.host.assertProjectionInput(input);
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
    this.host.assertProjectionInput(input);
    if (input.before.length > 1024) throw new Error("History cursor is too large");
    const direct = await this.directMessagePage(input);
    if (direct) return direct;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    compatibilityPathUsage.record(joinedPageCounter(this.directHistoryGaps.get(sessionKey)));
    const projection = await this.refreshProjection(
      { ...input, messageLimit: NATIVE_SYNC_LIVE_MESSAGES, representation: "sync-v1" },
      true,
    );
    if (!projection) throw new Error("Native agent history is unavailable");
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
    const resolved = await this.host.resolveProjectionSession(input);
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
      this.host.now(),
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
            hasServerPromptPreamble(input.environmentId),
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
      () => this.host.now(),
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
    const provider = await this.host.provider(input);
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
    this.host.assertProjectionInput(input);
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
    const localImagePath = entry.localImagePath;
    const readCurrentFile = async () => {
      const bytes = await readReadableHostFile(localImagePath, [path.dirname(localImagePath)]);
      const info = await stat(localImagePath).catch(() => null);
      return { bytes, ...(info ? { modifiedAt: info.mtime.toISOString() } : {}) };
    };
    // Reuse a successful read if saving it fails; reader failures still propagate.
    let currentRead: ReturnType<typeof readCurrentFile> | undefined;
    const readFile = () => (currentRead ??= readCurrentFile());
    // The reference is stable per message, part and path, so its first read
    // is saved and later reads show that copy even after the file changes.
    const pinned =
      typeof this.storage.getDataDir === "function"
        ? await transcriptMediaPins(this.storage.getDataDir())
            .pin(
              {
                environmentId: input.environmentId,
                logicalSessionKey: input.logicalSessionKey,
                messageId: input.detailRef,
                reference: `detail:${localImagePath}`,
              },
              readFile,
            )
            .catch(() => undefined)
        : undefined;
    const current = pinned ? undefined : await readFile();
    const bytes = pinned ? Buffer.from(pinned.bytes) : current!.bytes;
    return {
      ...entry.details,
      fileDataUrl: `data:${imageMimeType(localImagePath)};base64,${bytes.toString("base64")}`,
      ...(pinned
        ? {
            fileSnapshot: {
              status: pinned.status,
              capturedAt: pinned.capturedAt,
              ...(pinned.fileModifiedAt ? { fileModifiedAt: pinned.fileModifiedAt } : {}),
              ...(pinned.reason ? { reason: pinned.reason } : {}),
            },
          }
        : {
            fileSnapshot: {
              status: "live" as const,
              reason: "missing" as const,
              capturedAt: new Date(this.host.now()).toISOString(),
              ...(current?.modifiedAt ? { fileModifiedAt: current.modifiedAt } : {}),
            },
          }),
    };
  }

  /**
   * Resolve the transcript window for one refresh.
   *
   * Callers that ask for a bigger window raise it; callers that ask for nothing
   * inherit the window the session already had. Clamped so a renderer cannot
   * ask the provider for an unbounded transcript.
   */
  private resolveMessageLimit(requested: number | undefined, previous: number | undefined): number {
    const candidate = requested ?? previous ?? NATIVE_PROJECTION_MAX_MESSAGES;
    if (!Number.isSafeInteger(candidate) || candidate <= 0) {
      return NATIVE_PROJECTION_MAX_MESSAGES;
    }
    return Math.min(candidate, NATIVE_PROJECTION_MAX_WINDOW_MESSAGES);
  }

  /**
   * `turn.quietObservation`: the activity observer holds a content revision
   * for this provider session, so every change to its idle view is announced
   * (`onObservationInvalidation`) and the view may read less often. Absent
   * before the first observation and for a bridge that reports none.
   */
  private quietObservationFlag(session: PersistedNativeAgentSession): {
    quietObservation?: true;
  } {
    const observed = this.host.observedActivity(session.key);
    return observed?.providerSessionId === session.providerSessionId &&
      observed.contentRevision !== undefined
      ? { quietObservation: true }
      : {};
  }

  private async projectionComposer(
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
      const cached = this.catalogs.cachedModels(input.environmentId);
      if (cached) {
        models = cached.models.filter((model) => model.platform === input.agent);
        if (cached.expiresAt <= this.host.now()) {
          // Model discovery can probe several runtimes and take seconds. An
          // expired entry is still perfectly adequate for rendering the
          // transcript and existing picker selection, so refresh it out of the
          // transcript-critical path. The next projection poll observes the
          // refreshed catalogue.
          void this.catalogs
            .refreshModels(input.environmentId)
            .then((refreshed) => {
              // The same catalogue changes no view; announcing it would wake
              // every idle view of the environment once per TTL.
              if (
                !this.host.isStopped() &&
                modelCatalogKey(refreshed) !== modelCatalogKey(cached.models)
              ) {
                this.storage.announceNativeAgentSessionProjection(input.environmentId);
              }
            })
            .catch(() => {
              this.catalogs.retryModelsAfter(
                input.environmentId,
                cached,
                NATIVE_DISCOVERY_RETRY_MS,
              );
            });
        }
      } else {
        const refresh = this.catalogs.refreshModels(input.environmentId);
        if (discoveryInBackground) {
          void refresh
            .then(() => {
              if (!this.host.isStopped()) {
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
    const composer: NativeAgentComposerState = {
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
    return withProviderSelectionPricing(composer, providerComposer);
  }

  /**
   * A committed stop withdraws the environment's outstanding agent requests.
   * Parked requests die with their bridge and never survive a restart, but a
   * failed read keeps the last projection, so the dead request stayed
   * `pending` while stopped; the public CLI and the coordinator's
   * `get_tab_state` read that cache. It is withdrawn the way a live snapshot
   * withdraws one: dropped from the list, which only ever holds outstanding
   * requests, in a new announced revision. Every key with a cached projection
   * or a refresh in flight has its epoch bumped, so a read that saw the
   * request before the stop cannot commit it back.
   */
  withdrawEnvironmentInteractions(environmentId: string): void {
    const keys = new Set<string>();
    for (const [key, entry] of this.projectionCache) {
      if (entry.input.environmentId === environmentId) keys.add(key);
    }
    for (const [key, descriptor] of this.projectionRefreshDescriptors) {
      if (descriptor.environmentId === environmentId) keys.add(key);
    }
    for (const key of keys) {
      const epoch = (this.projectionEpochs.get(key) ?? 0) + 1;
      this.projectionEpochs.set(key, epoch);
      const entry = this.projectionCache.get(key);
      if (!entry) continue;
      const interactions = entry.projection.interactions.filter(
        (interaction) => interaction.state !== "pending" && interaction.state !== "answering",
      );
      this.commitProjection(
        key,
        entry.input,
        { ...entry.projection, interactions },
        entry.generation,
        epoch,
      );
    }
  }

  invalidateProjection(key: string): void {
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
    this.directHistoryGaps.delete(key);
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
  private pruneProjectionEpoch(key: string): void {
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

  refreshProjection(
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
    this.projectionRefreshDescriptors.set(key, {
      epoch,
      signature,
      environmentId: input.environmentId,
    });
    return operation.finally(() => {
      if (this.projectionRefreshes.get(key) === operation) {
        this.projectionRefreshes.delete(key);
        this.projectionRefreshDescriptors.delete(key);
      }
      this.pruneProjectionEpoch(key);
    });
  }

  private async refreshProjectionOnce(
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
      const resolved = resolvedSession ?? (await this.host.resolveProjectionSession(input));
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
            this.directHistoryGaps.delete(historyKey);
          }
          this.projectionMissingSince.delete(key);
        }
        return null;
      }
      transient = resolved.transient;
      generation = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
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
      const readSnapshot = (): Promise<ProviderInteractiveSnapshot> =>
        resolved.provider.interactiveSnapshot
          ? resolved.provider.interactiveSnapshot(resolved.session.providerSessionId)
          : (async () => ({
              // A terminal turn error belongs in the projection as `error` plus
              // its detail, not as a thrown read that would report the whole
              // runtime as unreachable.
              ...(await readProviderStatus(resolved.provider, resolved.session.providerSessionId)),
              messages: await resolved.provider.messages(resolved.session.providerSessionId),
            }))();
      // Capture as soon as the snapshot resolves, before unrelated metadata.
      const snapshotPromise = resolved.transient
        ? readSnapshot()
        : this.resumeIdentity.read(resolved.session, readSnapshot);
      const interactionSnapshotPromise = this.pendingInteractions(resolved);
      const queuePromise = advertisedCapabilities.queue
        ? this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : Promise.resolve(null);
      const slashCommandsPromise = this.catalogs
        .commandCatalogue(input, resolved.provider, resolved.session.providerSessionId)
        .catch((): CommandCatalogueSnapshot => ({
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
        this.catalogs.observeCommandRevision(
          input,
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
        const since = this.projectionMissingSince.get(key) ?? this.host.now();
        this.projectionMissingSince.set(key, since);
        const projection: NativeAgentSessionProjection =
          this.host.now() - since >= NATIVE_MISSING_SESSION_GRACE_MS
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
      // Usage history is recorded from the merged turns, which carry every
      // turn the provider still republishes rather than only the newest one.
      // The provider session scopes their ids: this key belongs to the tab,
      // which outlives the conversation in it.
      this.usageRecorder.observe({
        sessionKey,
        environmentId: input.environmentId,
        platform: input.agent,
        ...(resolved.session.providerSessionId
          ? { providerSessionId: resolved.session.providerSessionId }
          : {}),
        usage: contextUsage,
      });
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
      const terminalMessages = nativeTerminalMessages({
        notices: snapshot.notices,
        error: snapshot.error,
        stopNotice,
        turnStartedAt: snapshot.turnStartedAt,
      });
      if (stopNotice) this.stopNotices.delete(sessionKey);
      // A provider that already says why the turn failed (OpenCode's inline
      // error row, Codex and Pi's error status line) gets no second row.
      const messagesWithNotices = withNativeTerminalMessages(
        transcript.messages,
        terminalMessages as unknown[],
      );
      const renderedTranscript = { messages: messagesWithNotices, window: transcript.window };
      const projectionTitle = this.sessionTitles.resolve({
        sessionKey,
        session: resolved.session,
        agent: input.agent,
        ...(snapshot.title ? { providerTitle: snapshot.title } : {}),
        ...firstUserMessageOf(normalized.messages, normalized.window),
        transient: resolved.transient,
        ...(resolved.provider.setSessionTitle
          ? {
              setProviderTitle: (id: string, title: string) =>
                resolved.provider.setSessionTitle!(id, title),
            }
          : {}),
      });
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
          await this.host.recordAsyncQuestionAttention(
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
        this.host.scheduleAmbiguousDispatchSettle(
          input,
          key,
          resolved.session.pendingDispatch.requestId,
          resolved.provider,
        );
      }
      if (!resolved.transient && resolved.session.pendingSteer) {
        this.host.scheduleAmbiguousSteerSettle(
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
      const retiredDispatch = projectedRetiredDispatch(
        input.agent,
        resolved.session,
        this.host.now(),
      );
      const notices = visibleProjectionNotices(
        input.agent,
        snapshot.notices,
        sessionIncompleteTurnNotice(resolved.session),
        retiredDispatch,
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
          ...this.quietObservationFlag(resolved.session),
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
        ...goalProjectionField(resolved.session),
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
        ...(retiredDispatch ? { retiredDispatch } : {}),
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
  private unreachableProjection(
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
  private nextProjectionRevision(sessionKey: string, generation: string): number {
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

  private commitProjection(
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

/**
 * Carry the bridge's premium-pricing indicator onto the projected composer.
 *
 * The bridge computes it for *its* selection. The projection can override that
 * selection with stored or pending controls, and an indicator describing a
 * different combination would be wrong in both directions, so it is kept only
 * when model, reasoning, speed and parameters all agree with the bridge's.
 */
function withProviderSelectionPricing(
  composer: NativeAgentComposerState,
  providerComposer: NativeAgentComposerState | undefined,
): NativeAgentComposerState {
  const pricing = normalizeNativeAgentSelectionPricing(providerComposer?.selectionPricing);
  if (!pricing || !providerComposer) return composer;
  const providerValues = providerComposer.parameterValues ?? {};
  const sameSelection =
    composer.selectedModelId === providerComposer.selectedModelId &&
    composer.selectedReasoningId === providerComposer.selectedReasoningId &&
    // The projection shows an untouched speed toggle as off where the bridge
    // still holds "never chosen"; both mean the default, standard-speed run.
    (composer.fastModeEnabled ?? false) === (providerComposer.fastModeEnabled ?? false) &&
    Object.entries(composer.parameterValues ?? {}).every(
      ([id, value]) => providerValues[id] === value,
    );
  return sameSelection ? { ...composer, selectionPricing: pricing } : composer;
}
