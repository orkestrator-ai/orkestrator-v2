import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type {
  AgentInteractionApplyOutcome,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import type {
  NativeAgentControlUpdate,
  NativeAgentDispatchOutcome,
  NativeAgentMessageWindow,
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentToolDetails,
  NativeAgentViewIdentity,
  NativeAgentDiscoveryView,
  NativeAgentSessionStateView,
  NativeAgentTranscriptView,
} from "@orkestrator/protocol/native-agent";
import {
  applyNativeAgentProjectionDelta,
  applyNativeAgentTranscriptDelta,
  DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  isNativeAgentSessionProjection,
  nativeAgentCapabilities,
} from "@orkestrator/protocol/native-agent";
import {
  adoptNativeAgentSession,
  dispatchNativeAgentIntent,
  dismissNativeAgentSuggestedPrompt,
  enqueuePromptQueueMessage,
  ensureNativeAgentSession,
  getNativeAgentProjection,
  getNativeAgentProjectionUpdate,
  getNativeAgentMessagePage,
  getNativeAgentSyncCapabilities,
  getNativeAgentTranscriptUpdate,
  getNativeAgentSessionStateUpdate,
  getNativeAgentDiscoveryUpdate,
  getNativeAgentToolDetails,
  forkNativeAgentSession,
  listNativeAgentResumableSessions,
  discardNativeAgentDispatch,
  movePromptQueueMessage,
  performNativeAgentSessionAction,
  refreshNativeAgentModels,
  removePromptQueueMessage,
  resolveNativeAgentInteraction,
  resumeNativeAgentSession,
  retryPromptQueueDispatch,
  retryNativeAgentDispatch,
  stopNativeAgentSession,
  stopNativeAgentBackgroundTask,
  updateNativeAgentControls,
} from "@/lib/backend";
import { onResourceChanged, onResourceResync } from "@/lib/resource-sync";
import { createSessionKey } from "@/lib/utils";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  evictNativeAgentHistoryCaches,
  useNativeAgentProjectionStore,
  type NativeAgentSyncCacheEntry,
  type NativeAgentProgressiveCacheEntry,
} from "@/stores/nativeAgentProjectionStore";

/** Mirrors the backend's default window; only used to size the first expansion. */
const DEFAULT_MESSAGE_WINDOW = 512;
/** Mirrors the backend ceiling, so the button stops offering what it would clamp. */
const MAX_MESSAGE_WINDOW = 4_096;
const ACTIVE_PROJECTION_REFRESH_MS = 500;
const IDLE_PROJECTION_REFRESH_MS = 1_500;
const CLIENT_HISTORY_MAX_MESSAGES = 4_096;
const CLIENT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const CLIENT_HISTORY_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
/** Mirrors the backend page ceiling so a request is never silently clamped. */
const HISTORY_PAGE_MAX_MESSAGES = 200;

let syncCapability: {
  supported: boolean;
  progressive: boolean;
  checkedAt: number;
  generation: number;
} | null = null;
let syncCapabilityGeneration = 0;
let syncCapabilityInvalidationQueued = false;
let syncCapabilityRequest: { generation: number; promise: Promise<boolean> } | null = null;

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * A revision the projection on screen cannot mistake for an older read.
 *
 * `revision` is one ordering within a generation, but the surfaces that mint it
 * do not share a counter: the progressive transport increments locally on every
 * applied view, while the joined and legacy projections carry the backend's own
 * counter, which only moves when content changes. A tab that has polled for a
 * minute has therefore outrun the server's number, and `applyProjection` would
 * drop the next authoritative projection as stale.
 *
 * Only callers that have already fenced their read on sequence and operation
 * epoch may use this — ordering is established there, not here.
 */
function orderedRevision<TMessage>(
  current: NativeAgentSessionProjection<TMessage> | null,
  next: NativeAgentSessionProjection<TMessage>,
): number {
  return current && current.generation === next.generation && current.revision >= next.revision
    ? current.revision + 1
    : next.revision;
}

/**
 * The load-earlier control, derived from what this client can actually fetch.
 *
 * Three distinct states, and the server can only answer the last of them:
 *
 *  - a `cursor` this client holds — one click fetches a real page;
 *  - no cursor, a server that reports earlier messages, and no `boundaryCursor`
 *    this client has already walked past — the click has to mint a cursor
 *    first, which the joined snapshot does;
 *  - anything else — the range is either fully loaded or unreachable, so the
 *    control must not be offered.
 *
 * Driving the button from the server's live-tail boundary alone put an inert
 * action back on screen after every poll: the server keeps reporting that
 * messages exist before the live tail long after this client has paged back to
 * the start of the conversation. `boundaryCursor` without `cursor` is exactly
 * that walked-past state, which is why it suppresses the bootstrap rather than
 * enabling it.
 */
function historyMessageWindow(params: {
  messageCount: number;
  /** The cursor this client holds, if paging has one left to spend. */
  cursor?: string;
  /** The newest server-minted boundary this client has already resolved. */
  boundaryCursor?: string;
  /** Whether the server reports messages before the live tail. */
  serverCanLoadEarlier?: boolean;
  /** Server-reported completeness of the backend's own history. */
  complete: boolean;
  /** The server's own window, kept when nothing can be fetched. */
  serverWindow?: NativeAgentMessageWindow;
}): NativeAgentMessageWindow | undefined {
  if (params.cursor || (params.serverCanLoadEarlier === true && !params.boundaryCursor)) {
    return {
      limit: params.messageCount,
      truncated: true,
      truncationReason: "count",
      canLoadEarlier: true,
    };
  }
  if (params.complete) return undefined;
  return {
    ...(params.serverWindow ?? { limit: params.messageCount }),
    limit: params.messageCount,
    truncated: true,
    canLoadEarlier: false,
  };
}

async function nativeAgentSyncSupported(): Promise<boolean> {
  const generation = syncCapabilityGeneration;
  if (
    syncCapability &&
    syncCapability.generation === generation &&
    (syncCapability.supported || Date.now() - syncCapability.checkedAt < 30_000)
  ) {
    return syncCapability.supported;
  }
  if (syncCapabilityRequest?.generation === generation) return syncCapabilityRequest.promise;
  const promise = (async () => {
    try {
      const capabilities = await getNativeAgentSyncCapabilities();
      const supported = capabilities.projectionSyncVersions?.includes(1) === true;
      const progressive = capabilities.progressiveViewVersions?.includes(1) === true;
      if (generation === syncCapabilityGeneration) {
        syncCapability = { supported, progressive, checkedAt: Date.now(), generation };
      }
      return supported;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Unknown backend command: get_native_agent_sync_capabilities")) {
        if (generation === syncCapabilityGeneration) {
          syncCapability = {
            supported: false,
            progressive: false,
            checkedAt: Date.now(),
            generation,
          };
        }
        return false;
      }
      throw error;
    }
  })();
  const request = { generation, promise };
  syncCapabilityRequest = request;
  try {
    return await promise;
  } finally {
    if (syncCapabilityRequest === request) syncCapabilityRequest = null;
  }
}

async function nativeAgentProgressiveSupported(): Promise<boolean> {
  await nativeAgentSyncSupported();
  return Boolean(
    syncCapability?.generation === syncCapabilityGeneration && syncCapability.progressive,
  );
}

function sameProgressiveIdentity(
  left: NativeAgentViewIdentity | undefined,
  right: NativeAgentViewIdentity,
): boolean {
  return Boolean(
    left &&
    left.backendInstanceId === right.backendInstanceId &&
    left.environmentId === right.environmentId &&
    left.platform === right.platform &&
    left.logicalSessionKey === right.logicalSessionKey &&
    left.providerSessionId === right.providerSessionId &&
    left.sourceGeneration === right.sourceGeneration,
  );
}

function invalidateNativeAgentSyncCapability(): void {
  // Every mounted session hears the same reconnect/resync announcement. Treat
  // callbacks delivered in one turn as one backend-generation change so they
  // can still share the replacement backend's capability request.
  if (syncCapabilityInvalidationQueued) return;
  syncCapabilityInvalidationQueued = true;
  syncCapabilityGeneration += 1;
  syncCapability = null;
  queueMicrotask(() => {
    syncCapabilityInvalidationQueued = false;
  });
}

/** A merged sync transcript computed ahead of the fence that installs it. */
interface SyncMaterializationPlan<TMessage> {
  materialized: NativeAgentSessionProjection<TMessage>;
  live: NativeAgentSessionProjection<TMessage>;
  /** Absent when the live tail came from the progressive transcript. */
  token?: string;
  /** The backend paging epoch; absent until a sync-v1 surface minted one. */
  historyEpoch?: string;
  historyCursor?: string;
  /** Server-reported first message before the live tail, for recovery. */
  boundaryCursor?: string;
  historyComplete: boolean;
  historyMessages: TMessage[];
  historyBytes: number;
  evictionGeneration: number;
}

/**
 * Forget the negotiated backend capability.
 *
 * The answer is cached for the life of the process because it changes only
 * when the backend itself is replaced, and `onResourceResync` already
 * announces that. Tests are the one caller that swaps backends without an
 * announcement: a suite that advertises a different capability set has to say
 * so, or it inherits — and leaves behind — a protocol its own mocks do not
 * serve.
 */
export function resetNativeAgentSyncCapabilityForTests(): void {
  invalidateNativeAgentSyncCapability();
}

interface UseNativeAgentSessionOptions {
  platform: AgentPlatform;
  environmentId: string;
  tabId: string;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  defaultAgentModel?: string;
  defaultReasoningEffort?: string;
  initialProviderSessionId?: string;
  requireExistingResumeSession?: boolean;
  onResumeSessionReplaced?: (replacement: {
    requestedProviderSessionId: string;
    replacementProviderSessionId: string;
    logicalSessionKey: string;
  }) => Promise<void>;
  initialConversationMode?: "build" | "plan";
  initialFastMode?: boolean;
  initialExecutionProfileId?: string;
  defaultFastMode?: boolean;
  /** Generic provider parameters applied only when a fresh session is created. */
  defaultParameterValues?: Record<string, string | boolean>;
  isActive?: boolean;
  /** Setup-gated tabs mount presentation without starting provider I/O. */
  enabled?: boolean;
}

export interface NativeAgentSendOptions {
  requestId?: string;
  model?: string;
  reasoningEffort?: string;
  mode?: "build" | "plan";
  fastMode?: boolean;
  subAgent?: string;
  executionAgent?: string;
  includeLocalSettings?: boolean;
  promptSuggestions?: boolean;
  attachments?: Array<{
    type: "image" | "file";
    path: string;
    dataUrl?: string;
    filename?: string;
  }>;
}

/**
 * The shared native-agent lifecycle controller.
 *
 * Long-running authority stays in the backend. This hook only installs full
 * authoritative snapshots, treats resource events as invalidation hints, and
 * keeps transient button state local.
 */
export function useNativeAgentSession<TMessage = unknown>({
  platform,
  environmentId,
  tabId,
  initialAgentModel,
  initialReasoningEffort,
  defaultAgentModel,
  defaultReasoningEffort,
  initialProviderSessionId,
  requireExistingResumeSession = false,
  onResumeSessionReplaced,
  initialConversationMode,
  initialFastMode,
  initialExecutionProfileId,
  defaultFastMode,
  defaultParameterValues,
  isActive = true,
  enabled = true,
}: UseNativeAgentSessionOptions) {
  const sessionKey = useMemo(() => createSessionKey(environmentId, tabId), [environmentId, tabId]);
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
    mode: initialConversationMode,
    fastMode: initialFastMode,
    executionProfileId: initialExecutionProfileId,
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(
      initialAgentModel ||
      initialReasoningEffort ||
      initialConversationMode ||
      typeof initialFastMode === "boolean" ||
      initialExecutionProfileId,
    ),
  );
  const isInitializedRef = useRef(false);
  const lastInitTimeRef = useRef(0);
  const forkInFlightRef = useRef(false);
  const [runtimeProjection, setRuntimeProjection] =
    useState<NativeAgentSessionProjection<TMessage> | null>(null);
  const sharedProjection = useNativeAgentProjectionStore((state) =>
    state.projections.get(sessionKey),
  ) as NativeAgentSessionProjection<TMessage> | undefined;
  const sharedSyncCache = useNativeAgentProjectionStore((state) =>
    state.syncCaches.get(sessionKey),
  );
  const sharedProgressiveCache = useNativeAgentProjectionStore((state) =>
    state.progressiveCaches.get(sessionKey),
  );
  const matchingSharedProjection =
    sharedProjection?.platform === platform &&
    sharedProjection.environmentId === environmentId &&
    (!initialProviderSessionId || sharedProjection.sessionId === initialProviderSessionId)
      ? sharedProjection
      : undefined;
  const matchingProgressiveCache =
    sharedProgressiveCache?.identity?.environmentId === environmentId &&
    sharedProgressiveCache.identity.platform === platform &&
    sharedProgressiveCache.identity.logicalSessionKey === sessionKey &&
    (!initialProviderSessionId ||
      sharedProgressiveCache.identity.providerSessionId === initialProviderSessionId)
      ? sharedProgressiveCache
      : undefined;
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [resumeSessionReplacement, setResumeSessionReplacement] = useState<{
    requestedProviderSessionId: string;
    replacementProviderSessionId: string;
  } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(enabled);
  /**
   * Whether an authoritative read has finished for the current identity.
   *
   * A projection-less session is ambiguous on its own: an inactive tab has
   * simply never asked, while an active tab whose read came back empty has been
   * told there is nothing there. Only the second is a failure the user can act
   * on, so the connection surface needs to tell them apart rather than treating
   * every absent projection the same way.
   */
  const [hasCompletedRead, setHasCompletedRead] = useState(false);
  const [transcriptAvailability, setTranscriptAvailability] = useState<
    NativeAgentProgressiveCacheEntry["transcriptAvailability"]
  >(
    // Emptiness has to come from the transcript surface, not from an empty
    // message array. A session-state snapshot installs a projection with
    // `messages: []` before its paired transcript read resolves, so counting
    // messages would call a state-only placeholder an authoritative empty
    // transcript and suppress the shimmer for a session that still has history.
    matchingSharedProjection
      ? matchingProgressiveCache?.transcriptAvailability === "empty"
        ? "empty"
        : "cached"
      : "unavailable",
  );
  const transcriptAvailabilityRef = useRef(transcriptAvailability);
  const markTranscriptAvailability = useCallback(
    (availability: NativeAgentProgressiveCacheEntry["transcriptAvailability"]) => {
      transcriptAvailabilityRef.current = availability;
      setTranscriptAvailability(availability);
    },
    [],
  );
  const [transcriptRefreshing, setTranscriptRefreshing] = useState(enabled);
  const [transcriptError, setTranscriptError] = useState<string | null>(
    matchingProgressiveCache?.transcriptError ?? null,
  );
  /*
   * Action authority is only ever granted by a live session-state read, so a
   * remount starts unavailable even when the shared cache still holds the
   * previous mount's snapshot. The cached *transcript* is readable regardless;
   * that separation is the point of the progressive view.
   */
  const [sessionStateAvailability, setSessionStateAvailability] =
    useState<NativeAgentProgressiveCacheEntry["stateAvailability"]>("unavailable");
  const [sessionStateRefreshing, setSessionStateRefreshing] = useState(false);
  const [sessionStateError, setSessionStateError] = useState<string | null>(
    matchingProgressiveCache?.stateError ?? null,
  );
  const sessionStateAvailabilityRef = useRef(sessionStateAvailability);
  const markSessionStateAvailability = useCallback(
    (availability: NativeAgentProgressiveCacheEntry["stateAvailability"]) => {
      sessionStateAvailabilityRef.current = availability;
      setSessionStateAvailability(availability);
    },
    [],
  );
  /**
   * Begin a state read without surrendering authority.
   *
   * A refresh is not evidence that the last known state became wrong: the
   * session is still whatever the previous authoritative read said until a new
   * one contradicts it. Dropping to `refreshing` while a snapshot is already
   * held would blank pending approvals and lock the composer on every poll —
   * once every 500 ms during an active turn. Only a tab that has never had an
   * authoritative read shows `refreshing`, which is the genuine first-load
   * case the connecting state exists for.
   */
  const beginSessionStateRefresh = useCallback(() => {
    setSessionStateRefreshing(true);
    if (sessionStateAvailabilityRef.current !== "current") {
      markSessionStateAvailability("refreshing");
    }
    return sessionStateAvailabilityRef.current;
  }, [markSessionStateAvailability]);
  const [isDispatching, setIsDispatching] = useState(false);
  /**
   * How much transcript this tab has asked for. Undefined keeps the backend
   * default; `loadEarlierMessages` raises it, and the raised value is resent on
   * every subsequent read so the window cannot silently collapse.
   */
  const [messageLimit, setMessageLimit] = useState<number | undefined>(undefined);
  // Seed the imperative view from the shared renderer cache. Environment
  // switches unmount this hook, but the cache survives; using it here lets the
  // remount start its authoritative transcript read immediately instead of
  // waiting for a redundant provider-adoption probe first.
  const projectionRef = useRef<NativeAgentSessionProjection<TMessage> | null>(
    matchingSharedProjection ?? null,
  );
  const syncTokenRef = useRef<string | undefined>(sharedSyncCache?.token);
  const progressiveTranscriptTokenRef = useRef(matchingProgressiveCache?.transcriptToken);
  const lastTranscriptViewRef = useRef<NativeAgentTranscriptView<TMessage> | null>(null);
  /**
   * The history epoch of the last transcript view this session installed,
   * including the one a previous mount installed.
   *
   * `lastTranscriptViewRef` is rebuilt empty on every mount while the
   * projection it describes is seeded from the shared store, so reading the
   * epoch only from that ref left the first snapshot after a remount unable to
   * tell a rotation from an ordinary poll — the one case where retaining aged
   * out messages resurrects a history the provider has already rewritten.
   */
  const progressiveHistoryEpochRef = useRef<string | undefined>(
    matchingProgressiveCache?.transcriptHistoryEpoch,
  );
  /**
   * The store-side history eviction counter the progressive path has honoured.
   *
   * Kept separate from `historyEvictionRef`: that one is committed by sync
   * materialization, and one transport acknowledging an eviction must not
   * silence it for the other.
   */
  const progressiveHistoryEvictionRef = useRef(
    useNativeAgentProjectionStore.getState().historyEvictions.get(sessionKey) ?? 0,
  );
  /** Never seeded from the shared cache; see the remount reset below. */
  const progressiveStateTokenRef = useRef<string | undefined>(undefined);
  const progressiveDiscoveryTokenRef = useRef(matchingProgressiveCache?.discoveryToken);
  const progressiveIdentityRef = useRef<NativeAgentViewIdentity | undefined>(
    matchingProgressiveCache?.identity,
  );
  const progressiveDiscoveryRef = useRef<NativeAgentDiscoveryView | undefined>(
    matchingProgressiveCache?.discovery,
  );
  const syncLiveProjectionRef = useRef<NativeAgentSessionProjection<TMessage> | null>(
    (sharedSyncCache?.liveProjection as NativeAgentSessionProjection<TMessage> | undefined) ?? null,
  );
  const historyEpochRef = useRef<string | undefined>(sharedSyncCache?.historyEpoch);
  const historyCursorRef = useRef<string | undefined>(sharedSyncCache?.historyCursor);
  /**
   * The newest server-reported boundary between retained history and the live
   * tail. Every recovery path — a rotated epoch, a store eviction, a collapse
   * back to the bounded live view — restarts paging from here, so it must
   * survive a page load that reports only its own older cursor.
   */
  const historyBoundaryCursorRef = useRef<string | undefined>(
    sharedSyncCache?.historyBoundaryCursor,
  );
  const historyCompleteRef = useRef(sharedSyncCache?.historyComplete ?? false);
  /**
   * Whether one click could still mint a paging cursor this tab does not hold.
   *
   * Only the progressive transport reaches that state: its transcript reports
   * that earlier messages exist while the backend's paging cache — populated
   * by a different surface entirely — has never been read for this session.
   * Recorded here because a mutation answers on the legacy projection surface,
   * which knows none of this and would otherwise drop the control until the
   * next poll rebuilt it.
   */
  const historyBootstrapRef = useRef(false);
  const historyMessagesRef = useRef<TMessage[]>(
    (sharedSyncCache?.historyMessages as TMessage[] | undefined) ?? [],
  );
  /**
   * The store-side history eviction counter this hook has already honoured.
   *
   * The store can only evict its own copy of a retained page; the mounted hook
   * holds the same messages in `historyMessagesRef` and would write them
   * straight back on its next materialization. Observing the counter is what
   * makes a global eviction actually reclaim the bytes.
   */
  const historyEvictionRef = useRef(
    useNativeAgentProjectionStore.getState().historyEvictions.get(sessionKey) ?? 0,
  );
  const refreshSequenceRef = useRef(0);
  const projectionOperationEpochRef = useRef(0);
  const refreshesInFlightRef = useRef(0);
  const reconcileAfterInFlightRef = useRef(false);
  /**
   * How many `connect()` calls are still establishing this tab's provider
   * session — that is, still inside `adopt`/`ensure`.
   *
   * A read taken inside that window is not authoritative. The backend resolves
   * a logical session key to a provider session, and until the adopt or ensure
   * that creates the mapping returns there is nothing to resolve, so the read
   * answers `null`. That is "not created yet", not "this session is gone", and
   * the two are indistinguishable at the call site. Spawning a fresh agent is
   * slow enough — seconds, for a cold ACP bridge — that ordinary background
   * refreshes land squarely in the middle of it, and one of them settling the
   * connection surface is what flashes Connection Failed on a tab that goes on
   * to connect perfectly well.
   */
  const establishingSessionRef = useRef(0);
  /**
   * Whether the last `connect()` failed to establish a session and its error is
   * still the truest thing known about this tab.
   *
   * A failed adopt/ensure leaves no provider mapping behind, so every read that
   * follows resolves to `null` — and a read that installs `null` normally clears
   * `runtimeError`, because an authoritative "no session" is not an error state.
   * That combination replaces a message the user can act on ("provider session
   * was not found", an auth failure, a bridge that would not spawn) with the
   * generic connection-failed surface, within one poll interval. The flag keeps
   * the establishment error until a read actually finds a session or a fresh
   * connect supersedes it.
   */
  const establishmentFailureRef = useRef(false);
  const backgroundRefreshEnabledRef = useRef(enabled && isActive);
  backgroundRefreshEnabledRef.current = enabled && isActive;
  const refreshRef =
    useRef<
      (options?: {
        manual?: boolean;
        reconcileAfterInFlight?: boolean;
      }) => Promise<NativeAgentSessionProjection<TMessage> | null>
    >(null);
  const pendingDispatchRef = useRef<{
    prompt: string;
    requestId: string;
  } | null>(null);
  const effectiveProjection = matchingSharedProjection ?? runtimeProjection;
  const clearTabInitialAgentOptions = usePaneLayoutStore(
    (state) => state.clearTabInitialAgentOptions,
  );
  const updateTabNativeSessionId = usePaneLayoutStore((state) => state.updateTabNativeSessionId);
  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);

  const identity = useMemo(
    () => ({ environmentId, agent: platform, logicalSessionKey: sessionKey }),
    [environmentId, platform, sessionKey],
  );

  const beginProjectionMutation = useCallback(() => {
    projectionOperationEpochRef.current += 1;
    refreshSequenceRef.current += 1;
    progressiveStateTokenRef.current = undefined;
    // The token is dropped so the next read returns a full snapshot, but the
    // state already on screen stays authoritative until that snapshot lands.
    beginSessionStateRefresh();
    return projectionOperationEpochRef.current;
  }, [beginSessionStateRefresh]);

  const applyProjection = useCallback(
    (
      next: NativeAgentSessionProjection<TMessage> | null,
      syncCache?: NativeAgentSyncCacheEntry | null,
    ) => {
      if (!next) {
        projectionRef.current = null;
        setRuntimeProjection(null);
        useNativeAgentProjectionStore.getState().setProjection(sessionKey, null, null);
        return;
      }
      const current = projectionRef.current;
      if (current && current.generation === next.generation && next.revision < current.revision)
        return;
      projectionRef.current = next;
      const stopMarker = useNativeAgentProjectionStore.getState().turnStopMarkers.get(sessionKey);
      if (stopMarker && stopMarker.sessionId !== next.sessionId) {
        useNativeAgentProjectionStore.getState().clearTurnStopped(sessionKey);
      }
      setRuntimeProjection(next);
      useNativeAgentProjectionStore
        .getState()
        .setProjection(sessionKey, next as NativeAgentSessionProjection, syncCache);
      if (next.sessionId) {
        updateTabNativeSessionId(tabId, next.sessionId, environmentId);
      }
    },
    [environmentId, sessionKey, tabId, updateTabNativeSessionId],
  );

  /**
   * Room left for history this tab has not fetched yet.
   *
   * Used to size the page request itself, so the server trims rather than the
   * client: a page the client has to trim on arrival leaves its older half
   * behind a cursor only the server can mint.
   */
  const historyRequestBudget = useCallback((): { messages: number; bytes: number } => {
    const store = useNativeAgentProjectionStore.getState();
    const otherHistoryBytes = Array.from(store.syncCaches.entries()).reduce(
      (total, [key, cache]) => total + (key === sessionKey ? 0 : cache.historyBytes),
      0,
    );
    const byteCeiling = Math.min(
      CLIENT_HISTORY_MAX_BYTES,
      Math.max(0, CLIENT_HISTORY_TOTAL_MAX_BYTES - otherHistoryBytes),
    );
    const liveMessages = syncLiveProjectionRef.current?.messages.length ?? 0;
    return {
      messages: Math.max(
        0,
        CLIENT_HISTORY_MAX_MESSAGES - liveMessages - historyMessagesRef.current.length,
      ),
      bytes: Math.max(0, byteCeiling - encodedBytes(historyMessagesRef.current)),
    };
  }, [sessionKey]);

  /**
   * Compute — but do not install — the merged transcript one sync update
   * implies.
   *
   * Every ref this reads is left untouched. A read that started before a
   * mutation has to be discarded whole, and a materializer that mutated state
   * on the way to producing its answer would already have clobbered the newer
   * authoritative projection by the time the caller's fence noticed. The
   * caller commits the plan only once it has confirmed the read is still the
   * newest one for this identity.
   */
  const planSyncMaterialization = useCallback(
    (params: {
      live: NativeAgentSessionProjection<TMessage>;
      token?: string;
      historyEpoch?: string;
      /** Server-reported completeness of the backend's own history. */
      historyComplete: boolean;
      /**
       * The live tail's own boundary, as this update reported it. Present only
       * when the update actually carried one; paging omits it so the last
       * reported boundary survives, which is the cursor every recovery path
       * below has to fall back to.
       */
      boundary?: { cursor?: string };
      deletedMessageIds?: readonly string[];
      /** Explicit retained state, used by paging instead of the current refs. */
      retained?: { messages: TMessage[]; cursor?: string; complete: boolean };
    }): SyncMaterializationPlan<TMessage> => {
      const { live, token, historyEpoch, historyComplete } = params;
      const boundaryCursor = params.boundary
        ? params.boundary.cursor
        : historyBoundaryCursorRef.current;
      const store = useNativeAgentProjectionStore.getState();
      const evictionGeneration = store.historyEvictions.get(sessionKey) ?? 0;
      const evicted = evictionGeneration !== historyEvictionRef.current;
      const previousLive = syncLiveProjectionRef.current;
      const historyEpochChanged = historyEpochRef.current !== historyEpoch;
      const messageId = (message: TMessage): unknown => (message as { id?: unknown })?.id;

      let retainedMessages: TMessage[];
      let retainedCursor: string | undefined;
      let mergeAgedOut = false;
      if (params.retained) {
        retainedMessages = [...params.retained.messages];
        retainedCursor = params.retained.cursor;
      } else if (historyEpochChanged || evicted) {
        // A rotated history or a global eviction invalidates every retained
        // page. The server's own first cursor makes the same range fetchable
        // again rather than stranding it.
        retainedMessages = [];
        retainedCursor = boundaryCursor;
      } else {
        retainedMessages = historyMessagesRef.current;
        if (params.deletedMessageIds?.length) {
          const deleted = new Set(params.deletedMessageIds);
          retainedMessages = retainedMessages.filter(
            (message) => !deleted.has(messageId(message) as string),
          );
        }
        if (retainedMessages.length === 0) {
          // With no retained pages, follow the moving live boundary. Once pages
          // exist their cursor is older and remains valid across append-only
          // updates, so it must not be replaced by this first-page cursor.
          retainedCursor = boundaryCursor;
        } else {
          retainedCursor = historyCursorRef.current;
          mergeAgedOut = true;
        }
      }
      /*
       * Completeness describes the backend's history for this session, not how
       * far this client has paged, so the authoritative value always wins.
       * Accumulating it with AND made `false` absorbing: one transient
       * incomplete read left the transcript permanently marked truncated even
       * after a later snapshot proved otherwise.
       */
      const retainedComplete =
        params.retained && !historyEpochChanged ? params.retained.complete : historyComplete;

      const liveIds = new Set(
        live.messages
          .map((message) => messageId(message))
          .filter((id): id is string => typeof id === "string"),
      );
      if (mergeAgedOut && previousLive) {
        const retainedIds = new Set(retainedMessages.map((message) => messageId(message)));
        const agedOut = previousLive.messages.filter((message) => {
          const id = messageId(message);
          return typeof id === "string" && !liveIds.has(id) && !retainedIds.has(id);
        });
        if (agedOut.length > 0) retainedMessages = [...retainedMessages, ...agedOut];
      }
      retainedMessages = retainedMessages.filter(
        (message) => !liveIds.has(messageId(message) as string),
      );

      const otherHistoryBytes = Array.from(store.syncCaches.entries()).reduce(
        (total, [key, cache]) => total + (key === sessionKey ? 0 : cache.historyBytes),
        0,
      );
      let retainedHistoryBytes = encodedBytes(retainedMessages);
      let settledCursor = retainedCursor;
      if (
        retainedMessages.length + live.messages.length > CLIENT_HISTORY_MAX_MESSAGES ||
        retainedHistoryBytes > CLIENT_HISTORY_MAX_BYTES ||
        retainedHistoryBytes + otherHistoryBytes > CLIENT_HISTORY_TOTAL_MAX_BYTES
      ) {
        // Eviction is an explicit collapse back to the bounded live view. The
        // server-supplied first cursor lets the same history be fetched again.
        retainedMessages = [];
        retainedHistoryBytes = encodedBytes(retainedMessages);
        settledCursor = boundaryCursor;
      }

      const seen = new Set<string>();
      const messages = [...retainedMessages, ...live.messages].filter((message) => {
        const id = messageId(message);
        if (typeof id !== "string" || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      /*
       * No bootstrap term here on purpose. A sync-v1 read always mints its own
       * boundary cursor when earlier messages exist, so "the server says there
       * is history but this client holds no cursor" is not a state this path
       * can recover from — offering the control would put an inert action back
       * on screen after every poll.
       */
      const messageWindow = historyMessageWindow({
        messageCount: messages.length,
        ...(settledCursor ? { cursor: settledCursor } : {}),
        complete: retainedComplete,
        ...(live.messageWindow ? { serverWindow: live.messageWindow } : {}),
      });
      return {
        materialized: {
          ...live,
          messages,
          ...(messageWindow ? { messageWindow } : { messageWindow: undefined }),
        },
        live,
        ...(token ? { token } : {}),
        ...(historyEpoch ? { historyEpoch } : {}),
        ...(settledCursor ? { historyCursor: settledCursor } : {}),
        ...(boundaryCursor ? { boundaryCursor } : {}),
        historyComplete: retainedComplete,
        historyMessages: retainedMessages,
        historyBytes: retainedHistoryBytes,
        evictionGeneration,
      };
    },
    [sessionKey],
  );

  /** Installs a plan. Callers must have fenced the read that produced it. */
  const commitSyncMaterialization = useCallback(
    (plan: SyncMaterializationPlan<TMessage>) => {
      const materialized: NativeAgentSessionProjection<TMessage> = {
        ...plan.materialized,
        revision: orderedRevision(projectionRef.current, plan.materialized),
      };
      historyEpochRef.current = plan.historyEpoch;
      historyCursorRef.current = plan.historyCursor;
      historyBoundaryCursorRef.current = plan.boundaryCursor;
      historyCompleteRef.current = plan.historyComplete;
      historyMessagesRef.current = plan.historyMessages;
      historyEvictionRef.current = plan.evictionGeneration;
      syncTokenRef.current = plan.token;
      syncLiveProjectionRef.current = plan.live;
      // A sync-v1 read answers the bootstrap question outright: it either
      // minted a cursor or proved there is nothing left to mint one for.
      historyBootstrapRef.current = false;
      applyProjection(materialized, {
        ...(plan.token ? { token: plan.token } : {}),
        liveProjection: plan.live as NativeAgentSessionProjection,
        ...(plan.historyEpoch ? { historyEpoch: plan.historyEpoch } : {}),
        ...(plan.historyCursor ? { historyCursor: plan.historyCursor } : {}),
        ...(plan.boundaryCursor ? { historyBoundaryCursor: plan.boundaryCursor } : {}),
        historyComplete: plan.historyComplete,
        historyMessages: plan.historyMessages,
        historyBytes: plan.historyBytes,
      });
      return materialized;
    },
    [applyProjection],
  );

  /** Forgets every sync-v1 assumption, so the next read starts from a snapshot. */
  const resetSyncState = useCallback(() => {
    syncTokenRef.current = undefined;
    syncLiveProjectionRef.current = null;
    historyMessagesRef.current = [];
    historyCursorRef.current = undefined;
    historyBoundaryCursorRef.current = undefined;
    historyEpochRef.current = undefined;
    historyCompleteRef.current = false;
    historyBootstrapRef.current = false;
  }, []);

  const updateProgressiveCache = useCallback(
    (patch: Partial<NativeAgentProgressiveCacheEntry>) => {
      const store = useNativeAgentProjectionStore.getState();
      const previous = store.progressiveCaches.get(sessionKey);
      store.setProgressiveCache(sessionKey, {
        transcriptAvailability: previous?.transcriptAvailability ?? "unavailable",
        transcriptRefreshing: previous?.transcriptRefreshing ?? false,
        stateAvailability: previous?.stateAvailability ?? "unavailable",
        ...previous,
        ...patch,
      });
    },
    [sessionKey],
  );

  const identityBelongsToView = useCallback(
    (candidate: NativeAgentViewIdentity): boolean =>
      candidate.environmentId === environmentId &&
      candidate.platform === platform &&
      candidate.logicalSessionKey === sessionKey &&
      (!initialProviderSessionId || candidate.providerSessionId === initialProviderSessionId),
    [environmentId, initialProviderSessionId, platform, sessionKey],
  );

  /** Install transcript content without inventing action authority. */
  const applyProgressiveTranscript = useCallback(
    (
      value: NativeAgentTranscriptView<TMessage>,
      token: string,
      deletedMessageIds?: readonly string[],
    ) => {
      if (!identityBelongsToView(value.identity)) return null;
      const identityChanged =
        progressiveIdentityRef.current !== undefined &&
        !sameProgressiveIdentity(progressiveIdentityRef.current, value.identity);
      const providerChanged =
        progressiveIdentityRef.current !== undefined &&
        progressiveIdentityRef.current.providerSessionId !== value.identity.providerSessionId;
      if (identityChanged) {
        progressiveStateTokenRef.current = undefined;
        progressiveDiscoveryTokenRef.current = undefined;
        progressiveDiscoveryRef.current = undefined;
        markSessionStateAvailability("unavailable");
        setSessionStateError(null);
      }
      const current = providerChanged ? null : projectionRef.current;
      const hasAuthoritativeState =
        !identityChanged && sessionStateAvailabilityRef.current === "current" && current !== null;
      /*
       * Progressive snapshots are the live tail (100 messages / 512 KiB), not
       * the whole conversation. Replacing the rendered list with that tail on
       * every poll — including the refresh that runs when a hidden tab becomes
       * active again — dropped every message that had aged out. Keep them unless
       * the session identity or history epoch actually rotated.
       *
       * An unknown previous epoch counts as a rotation. A mount that holds a
       * cached projection it cannot date has no way to tell aged-out messages
       * from a history the provider rewrote while nothing was watching, and
       * showing deleted messages is the worse of the two failures.
       */
      const previousEpoch =
        lastTranscriptViewRef.current?.historyEpoch ?? progressiveHistoryEpochRef.current;
      const historyEpochChanged = previousEpoch !== value.historyEpoch;
      const evictionGeneration =
        useNativeAgentProjectionStore.getState().historyEvictions.get(sessionKey) ?? 0;
      const evicted = evictionGeneration !== progressiveHistoryEvictionRef.current;
      const deleted = deletedMessageIds?.length ? new Set(deletedMessageIds) : undefined;
      const liveIds = new Set(
        value.messages
          .map((message) => (message as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const firstLiveId = value.messages.find(
        (message) => typeof (message as { id?: unknown })?.id === "string",
      ) as { id?: unknown } | undefined;
      const firstLiveIndex =
        current && typeof firstLiveId?.id === "string"
          ? current.messages.findIndex(
              (message) => (message as { id?: unknown })?.id === firstLiveId.id,
            )
          : -1;
      // Ageing out is a suffix window: keep the prefix before the live tail.
      // A rewind or other prefix window starts at an earlier message we already
      // hold, so that prefix is empty and the omitted suffix must drop.
      let retained =
        current && !identityChanged && !historyEpochChanged && !evicted && firstLiveIndex > 0
          ? current.messages.slice(0, firstLiveIndex).filter((message) => {
              const id = (message as { id?: unknown })?.id;
              if (typeof id !== "string") return true;
              // A delta deletes from the live tail it was diffed against, so an
              // id it removes never appears in `liveIds`. Without this the
              // retained prefix would reinstate exactly the messages the
              // provider just deleted.
              if (deleted?.has(id)) return false;
              return !liveIds.has(id);
            })
          : [];
      /*
       * Retention is a client-side buffer and gets the same explicit ceiling
       * sync materialization applies to its retained pages. Exceeding it
       * collapses back to the bounded live tail rather than growing an array
       * the shared store cannot evict — its trim loop refuses to drop the
       * session it is currently writing, so nothing else would reclaim this.
       */
      let retainedBytes = retained.length > 0 ? encodedBytes(retained) : 0;
      const retentionCollapsed =
        retained.length > 0 &&
        (retained.length + value.messages.length > CLIENT_HISTORY_MAX_MESSAGES ||
          retainedBytes > CLIENT_HISTORY_MAX_BYTES);
      if (retentionCollapsed) {
        retained = [];
        retainedBytes = 0;
      }
      const messages = [...retained, ...value.messages];
      const serverCanLoadEarlier = value.messageWindow?.canLoadEarlier === true;
      /*
       * Whether the paging state this hook holds still describes this
       * transcript. Paging lives in the sync-v1 namespace — its cursors, its
       * epoch and its retained pages are all minted by the joined projection
       * and message-page endpoints — so the transcript view can only ever
       * invalidate that state, never re-derive it.
       *
       * In particular `value.historyEpoch` is the bridge's content epoch and
       * `historyEpochRef` is the backend's paging epoch. They are different
       * identifiers for different things and never compare equal, so comparing
       * them here would discard the cursor on every poll. The transcript's own
       * rotation is already covered by `historyEpochChanged`.
       */
      const pagingCarriesOver =
        !identityChanged &&
        !historyEpochChanged &&
        !evicted &&
        syncLiveProjectionRef.current !== null;
      const historyBoundaryCursor = pagingCarriesOver
        ? historyBoundaryCursorRef.current
        : undefined;
      /*
       * A collapse discards retained pages, so the range they covered has to
       * become fetchable again. The boundary is the only cursor that still
       * describes it; the page cursor pointed further back than anything now
       * on screen.
       */
      const settledHistoryCursor = !pagingCarriesOver
        ? undefined
        : retentionCollapsed
          ? historyBoundaryCursorRef.current
          : historyCursorRef.current;
      const historyPagingEpoch = pagingCarriesOver ? historyEpochRef.current : undefined;
      const canBootstrapHistory =
        serverCanLoadEarlier && !historyBoundaryCursor && !settledHistoryCursor;
      /*
       * Completeness is about what this client can show, not about the window
       * the transcript happened to carry. A live tail reports itself truncated
       * for as long as messages have aged out of it, but a client that has
       * already paged those messages back in is showing the whole conversation
       * and must not keep a "not shown" banner on screen for it.
       *
       * Paging having reached the start is exactly "a boundary was resolved and
       * no cursor survived it", and only then does its completeness win.
       */
      const historyComplete =
        pagingCarriesOver && historyBoundaryCursor && !settledHistoryCursor
          ? historyCompleteRef.current
          : value.historyComplete;
      const messageWindow = historyMessageWindow({
        messageCount: messages.length,
        ...(settledHistoryCursor ? { cursor: settledHistoryCursor } : {}),
        ...(historyBoundaryCursor ? { boundaryCursor: historyBoundaryCursor } : {}),
        serverCanLoadEarlier,
        complete: historyComplete,
        ...(value.messageWindow ? { serverWindow: value.messageWindow } : {}),
      });
      const live: NativeAgentSessionProjection<TMessage> = {
        platform,
        environmentId,
        sessionId: value.identity.providerSessionId,
        ...(value.title || current?.title ? { title: value.title ?? current?.title } : {}),
        connection: hasAuthoritativeState ? current.connection : "connecting",
        turn: hasAuthoritativeState ? current.turn : { phase: "recovering" },
        messages: value.messages,
        ...(value.messageWindow ? { messageWindow: value.messageWindow } : {}),
        interactions: hasAuthoritativeState ? current.interactions : [],
        composerControls: hasAuthoritativeState ? current.composerControls : [],
        ...(hasAuthoritativeState && current.composer ? { composer: current.composer } : {}),
        ...(hasAuthoritativeState && current.readiness ? { readiness: current.readiness } : {}),
        capabilities: hasAuthoritativeState
          ? current.capabilities
          : nativeAgentCapabilities(platform),
        ...(hasAuthoritativeState && current.queue ? { queue: current.queue } : {}),
        ...(hasAuthoritativeState && current.asyncQuestionResponses
          ? { asyncQuestionResponses: current.asyncQuestionResponses }
          : {}),
        ...(hasAuthoritativeState && current.contextUsage
          ? { contextUsage: current.contextUsage }
          : {}),
        ...(hasAuthoritativeState && current.policy ? { policy: current.policy } : {}),
        ...(hasAuthoritativeState && current.rateLimits ? { rateLimits: current.rateLimits } : {}),
        ...(current?.runtime ? { runtime: current.runtime } : {}),
        ...(current?.runtimeHealthAuthoritative === undefined
          ? {}
          : { runtimeHealthAuthoritative: current.runtimeHealthAuthoritative }),
        ...(current?.auth ? { auth: current.auth } : {}),
        ...(current?.notices ? { notices: current.notices } : {}),
        ...(hasAuthoritativeState && current.recoverableDispatch
          ? { recoverableDispatch: current.recoverableDispatch }
          : {}),
        ...(hasAuthoritativeState && current.backgroundTasks
          ? { backgroundTasks: current.backgroundTasks }
          : {}),
        ...(hasAuthoritativeState && current.suggestedPrompt
          ? { suggestedPrompt: current.suggestedPrompt }
          : {}),
        ...(hasAuthoritativeState && current.completionBlockedByBackgroundTasks !== undefined
          ? { completionBlockedByBackgroundTasks: current.completionBlockedByBackgroundTasks }
          : {}),
        ...(current?.turnBoundaries ? { turnBoundaries: current.turnBoundaries } : {}),
        ...(current?.slashCommands ? { slashCommands: current.slashCommands } : {}),
        revision: (current?.revision ?? 0) + 1,
        generation: value.identity.sourceGeneration,
      };
      const next: NativeAgentSessionProjection<TMessage> = {
        ...live,
        messages,
        ...(messageWindow ? { messageWindow } : { messageWindow: undefined }),
      };
      historyEpochRef.current = historyPagingEpoch;
      historyCursorRef.current = settledHistoryCursor;
      historyBoundaryCursorRef.current = historyBoundaryCursor;
      historyCompleteRef.current = historyComplete;
      historyBootstrapRef.current = canBootstrapHistory;
      historyMessagesRef.current = retained;
      historyEvictionRef.current = evictionGeneration;
      if (!pagingCarriesOver) syncTokenRef.current = undefined;
      syncLiveProjectionRef.current = live;
      progressiveTranscriptTokenRef.current = token;
      lastTranscriptViewRef.current = value;
      progressiveHistoryEpochRef.current = value.historyEpoch;
      progressiveHistoryEvictionRef.current = evictionGeneration;
      progressiveIdentityRef.current = value.identity;
      const availability = value.freshness === "empty" ? "empty" : "current";
      markTranscriptAvailability(availability);
      setTranscriptRefreshing(false);
      setTranscriptError(null);
      applyProjection(next, {
        ...(syncTokenRef.current ? { token: syncTokenRef.current } : {}),
        liveProjection: live as NativeAgentSessionProjection,
        ...(historyPagingEpoch ? { historyEpoch: historyPagingEpoch } : {}),
        ...(settledHistoryCursor ? { historyCursor: settledHistoryCursor } : {}),
        ...(historyBoundaryCursor ? { historyBoundaryCursor } : {}),
        ...(canBootstrapHistory ? { historyBootstrap: true } : {}),
        historyComplete,
        historyMessages: retained,
        historyBytes: retainedBytes,
      });
      updateProgressiveCache({
        identity: value.identity,
        transcriptToken: token,
        transcriptHistoryEpoch: value.historyEpoch,
        transcriptAvailability: availability,
        transcriptRefreshing: false,
        transcriptError: undefined,
        ...(identityChanged
          ? {
              stateToken: undefined,
              discoveryToken: undefined,
              stateAvailability: "unavailable",
              stateError: undefined,
              discovery: undefined,
            }
          : {}),
      });
      return next;
    },
    [
      applyProjection,
      environmentId,
      identityBelongsToView,
      platform,
      markSessionStateAvailability,
      markTranscriptAvailability,
      sessionKey,
      updateProgressiveCache,
    ],
  );

  /** Install action-critical state while preserving the transcript array. */
  const applyProgressiveState = useCallback(
    (value: NativeAgentSessionStateView, token: string) => {
      if (!identityBelongsToView(value.identity)) return null;
      const knownIdentity = progressiveIdentityRef.current;
      if (knownIdentity && knownIdentity.providerSessionId !== value.identity.providerSessionId) {
        applyProjection(null);
        markTranscriptAvailability("unavailable");
        progressiveTranscriptTokenRef.current = undefined;
        lastTranscriptViewRef.current = null;
        progressiveHistoryEpochRef.current = undefined;
      }
      const current = projectionRef.current;
      const next: NativeAgentSessionProjection<TMessage> = {
        platform,
        environmentId,
        sessionId: value.identity.providerSessionId,
        ...(value.title || current?.title ? { title: value.title ?? current?.title } : {}),
        ...(value.shareUrl === undefined ? {} : { shareUrl: value.shareUrl }),
        connection: value.connection,
        turn: value.turn,
        messages: current?.messages ?? [],
        ...(current?.messageWindow ? { messageWindow: current.messageWindow } : {}),
        interactions: value.interactions,
        composerControls: value.composerControls,
        ...(value.composer ? { composer: value.composer } : {}),
        ...(value.readiness ? { readiness: value.readiness } : {}),
        capabilities: value.capabilities,
        ...(value.queue ? { queue: value.queue } : {}),
        ...(value.asyncQuestionResponses
          ? { asyncQuestionResponses: value.asyncQuestionResponses }
          : {}),
        ...(value.contextUsage ? { contextUsage: value.contextUsage } : {}),
        ...(value.policy ? { policy: value.policy } : {}),
        ...(value.rateLimits ? { rateLimits: value.rateLimits } : {}),
        ...(current?.runtime ? { runtime: current.runtime } : {}),
        ...(value.runtimeHealthAuthoritative === undefined
          ? current?.runtimeHealthAuthoritative === undefined
            ? {}
            : { runtimeHealthAuthoritative: current.runtimeHealthAuthoritative }
          : { runtimeHealthAuthoritative: value.runtimeHealthAuthoritative }),
        ...(current?.auth ? { auth: current.auth } : {}),
        notices: value.notices,
        ...(value.recoverableDispatch ? { recoverableDispatch: value.recoverableDispatch } : {}),
        ...(value.backgroundTasks ? { backgroundTasks: value.backgroundTasks } : {}),
        ...(value.suggestedPrompt ? { suggestedPrompt: value.suggestedPrompt } : {}),
        ...(value.completionBlockedByBackgroundTasks === undefined
          ? {}
          : { completionBlockedByBackgroundTasks: value.completionBlockedByBackgroundTasks }),
        ...(current?.turnBoundaries ? { turnBoundaries: current.turnBoundaries } : {}),
        ...(current?.slashCommands ? { slashCommands: current.slashCommands } : {}),
        revision: (current?.revision ?? 0) + 1,
        generation: value.identity.sourceGeneration,
      };
      progressiveStateTokenRef.current = token;
      progressiveIdentityRef.current = value.identity;
      markSessionStateAvailability("current");
      setSessionStateError(null);
      applyProjection(next);
      updateProgressiveCache({
        identity: value.identity,
        stateToken: token,
        stateAvailability: "current",
        stateError: undefined,
        ...(knownIdentity && knownIdentity.providerSessionId !== value.identity.providerSessionId
          ? {
              transcriptToken: undefined,
              transcriptHistoryEpoch: undefined,
              transcriptAvailability: "unavailable" as const,
            }
          : {}),
      });
      return next;
    },
    [
      applyProjection,
      environmentId,
      identityBelongsToView,
      markSessionStateAvailability,
      markTranscriptAvailability,
      platform,
      updateProgressiveCache,
    ],
  );

  const applyProgressiveDiscovery = useCallback(
    (value: NativeAgentDiscoveryView, token: string) => {
      if (!identityBelongsToView(value.identity)) return;
      const knownIdentity = progressiveIdentityRef.current;
      if (knownIdentity && !sameProgressiveIdentity(knownIdentity, value.identity)) return;
      progressiveDiscoveryTokenRef.current = token;
      progressiveDiscoveryRef.current = value;
      const current = projectionRef.current;
      if (current) {
        const models = value.sections.models?.value;
        const commands = value.sections.commands?.value;
        const mcp = value.sections.mcp?.value;
        const auth = value.sections.auth?.value;
        const runtime = value.sections.runtime?.value;
        const next: NativeAgentSessionProjection<TMessage> = {
          ...current,
          ...(models
            ? {
                composer: current.composer
                  ? { ...current.composer, models }
                  : {
                      models,
                      fastModeEnabled: null,
                      fastModeAvailable: false,
                      modes: [],
                    },
              }
            : {}),
          ...(commands ? { slashCommands: commands } : {}),
          ...(runtime || mcp
            ? {
                runtime: {
                  ...current.runtime,
                  ...runtime?.summary,
                  ...(runtime ? { notices: runtime.notices } : {}),
                  ...(mcp ? { mcp, mcpServers: mcp.length } : {}),
                },
              }
            : {}),
          ...(auth !== undefined ? { auth: auth ?? undefined } : {}),
          revision: current.revision + 1,
        };
        applyProjection(next);
      }
      updateProgressiveCache({
        identity: value.identity,
        discoveryToken: token,
        discovery: value,
      });
    },
    [applyProjection, identityBelongsToView, updateProgressiveCache],
  );

  /**
   * Install an authoritative projection returned by a mutation.
   *
   * Mutations answer on the legacy full-projection surface, whose transcript
   * window is unrelated to the sync live tail. Applying one verbatim would
   * drop every page this tab had loaded until a later poll happened to rebuild
   * them. Merge it over the retained history instead, and leave the sync token
   * and live projection alone — they describe the base the backend will diff
   * its next delta against, and a legacy window is not that base.
   */
  const applyMutationProjection = useCallback(
    (next: NativeAgentSessionProjection<TMessage> | null) => {
      progressiveStateTokenRef.current = undefined;
      markSessionStateAvailability(next ? "current" : "unavailable");
      setSessionStateRefreshing(false);
      setSessionStateError(null);
      const live = syncLiveProjectionRef.current;
      const retained = historyMessagesRef.current;
      /*
       * A tab with no retained pages still owns a load-earlier decision the
       * legacy window cannot express, so only an identity mismatch short
       * circuits here. The merge below is a no-op when `retained` is empty.
       */
      if (!next || !live || next.platform !== platform || next.environmentId !== environmentId) {
        const ordered = next
          ? { ...next, revision: orderedRevision(projectionRef.current, next) }
          : null;
        applyProjection(ordered);
        return ordered;
      }
      const nextIds = new Set(
        next.messages
          .map((message) => (message as { id?: unknown })?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      const messages = [
        ...retained.filter((message) => !nextIds.has((message as { id?: unknown })?.id as string)),
        ...next.messages,
      ];
      const messageWindow = historyMessageWindow({
        messageCount: messages.length,
        ...(historyCursorRef.current ? { cursor: historyCursorRef.current } : {}),
        serverCanLoadEarlier: historyBootstrapRef.current,
        complete: historyCompleteRef.current,
        ...(next.messageWindow ? { serverWindow: next.messageWindow } : {}),
      });
      const merged = {
        ...next,
        messages,
        ...(messageWindow ? { messageWindow } : { messageWindow: undefined }),
        revision: orderedRevision(projectionRef.current, next),
      } as NativeAgentSessionProjection<TMessage>;
      applyProjection(merged);
      return merged;
    },
    [applyProjection, environmentId, markSessionStateAvailability, platform],
  );

  /**
   * Run the trailing reconciliation a coalesced invalidation asked for, once
   * nothing is left that would make its read stale or premature.
   */
  const flushPendingReconcile = useCallback(() => {
    if (!reconcileAfterInFlightRef.current) return;
    if (refreshesInFlightRef.current > 0 || establishingSessionRef.current > 0) return;
    reconcileAfterInFlightRef.current = false;
    if (!backgroundRefreshEnabledRef.current) return;
    queueMicrotask(() => {
      void refreshRef.current?.({
        manual: false,
        reconcileAfterInFlight: true,
      });
    });
  }, []);

  const refresh = useCallback(
    async (options?: { manual?: boolean; reconcileAfterInFlight?: boolean }) => {
      if (!enabled) return null;
      const background = options?.manual === false;
      // A background read is never worth issuing while the session is still
      // being established: it cannot resolve to anything but `null`, and the
      // per-environment invalidation that triggers most of them fires for every
      // sibling tab in the environment, so a second agent tab makes this the
      // common case rather than a rare race.
      if (background && (refreshesInFlightRef.current > 0 || establishingSessionRef.current > 0)) {
        if (options.reconcileAfterInFlight) {
          reconcileAfterInFlightRef.current = true;
        }
        return projectionRef.current;
      }
      refreshesInFlightRef.current += 1;
      const sequence = ++refreshSequenceRef.current;
      const operationEpoch = projectionOperationEpochRef.current;
      setIsRefreshing(true);
      setTranscriptRefreshing(true);
      try {
        if (await nativeAgentProgressiveSupported()) {
          setTranscriptError(null);
          const retainedStateAvailability = beginSessionStateRefresh();
          setSessionStateError(null);
          updateProgressiveCache({
            transcriptRefreshing: true,
            transcriptError: undefined,
            stateAvailability: retainedStateAvailability,
            stateError: undefined,
          });

          const stillCurrent = () =>
            sequence === refreshSequenceRef.current &&
            operationEpoch === projectionOperationEpochRef.current;
          let transcriptMissing = false;
          let stateMissing = false;
          const transcriptRead = getNativeAgentTranscriptUpdate<TMessage>({
            ...identity,
            viewVersion: 1,
            liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
            ...(progressiveTranscriptTokenRef.current
              ? { knownToken: progressiveTranscriptTokenRef.current }
              : {}),
            ...(options?.manual === true ? { forceSnapshot: true } : {}),
          })
            .then((update) => {
              if (!stillCurrent()) return;
              if (update.status === "snapshot") {
                applyProgressiveTranscript(
                  update.value as NativeAgentTranscriptView<TMessage>,
                  update.token,
                );
              } else if (update.status === "delta") {
                const current = lastTranscriptViewRef.current;
                if (
                  current &&
                  progressiveTranscriptTokenRef.current === update.baseToken &&
                  sameProgressiveIdentity(current.identity, update.identity)
                ) {
                  const merged = applyNativeAgentTranscriptDelta(current, update.delta);
                  if (merged) {
                    applyProgressiveTranscript(
                      merged,
                      update.token,
                      update.delta.deletedMessageIds,
                    );
                    return;
                  }
                }
                progressiveTranscriptTokenRef.current = undefined;
                lastTranscriptViewRef.current = null;
              } else if (update.status === "unchanged") {
                progressiveTranscriptTokenRef.current = update.token;
                const previousAvailability = transcriptAvailabilityRef.current;
                const availability =
                  previousAvailability === "empty" || previousAvailability === "unavailable"
                    ? previousAvailability
                    : projectionRef.current
                      ? "current"
                      : "unavailable";
                markTranscriptAvailability(availability);
                setTranscriptRefreshing(false);
                setTranscriptError(null);
                updateProgressiveCache({
                  identity: update.identity,
                  transcriptToken: update.token,
                  transcriptAvailability: availability,
                  transcriptRefreshing: false,
                  transcriptError: undefined,
                });
              } else if (update.status === "missing") {
                transcriptMissing = true;
                setTranscriptRefreshing(false);
              } else {
                const message = update.error ?? "Transcript is temporarily unavailable";
                setTranscriptRefreshing(false);
                setTranscriptError(message);
                updateProgressiveCache({
                  transcriptRefreshing: false,
                  transcriptError: message,
                });
              }
            })
            .catch((error) => {
              if (!stillCurrent()) return;
              const message = error instanceof Error ? error.message : String(error);
              setTranscriptRefreshing(false);
              setTranscriptError(message);
              updateProgressiveCache({ transcriptRefreshing: false, transcriptError: message });
            });

          const stateRead = getNativeAgentSessionStateUpdate({
            ...identity,
            viewVersion: 1,
            ...(progressiveStateTokenRef.current
              ? { knownToken: progressiveStateTokenRef.current }
              : {}),
            ...(options?.manual === true ? { forceSnapshot: true } : {}),
          })
            .then((update) => {
              if (!stillCurrent()) return;
              if (update.status === "snapshot") {
                applyProgressiveState(update.value, update.token);
              } else if (update.status === "unchanged") {
                progressiveStateTokenRef.current = update.token;
                markSessionStateAvailability("current");
                setSessionStateError(null);
                updateProgressiveCache({
                  identity: update.identity,
                  stateToken: update.token,
                  stateAvailability: "current",
                  stateError: undefined,
                });
              } else if (update.status === "missing") {
                stateMissing = true;
                markSessionStateAvailability("unavailable");
                updateProgressiveCache({ stateAvailability: "unavailable" });
              } else {
                const message = update.error ?? "Session state is temporarily unavailable";
                markSessionStateAvailability("unavailable");
                setSessionStateError(message);
                updateProgressiveCache({ stateAvailability: "unavailable", stateError: message });
              }
            })
            .catch((error) => {
              if (!stillCurrent()) return;
              const message = error instanceof Error ? error.message : String(error);
              markSessionStateAvailability("unavailable");
              setSessionStateError(message);
              updateProgressiveCache({ stateAvailability: "unavailable", stateError: message });
            });

          void getNativeAgentDiscoveryUpdate({
            ...identity,
            viewVersion: 1,
            sections: ["models", "commands", "mcp", "auth", "runtime"],
            ...(progressiveDiscoveryTokenRef.current
              ? { knownToken: progressiveDiscoveryTokenRef.current }
              : {}),
            ...(options?.manual === true ? { forceSnapshot: true } : {}),
          })
            .then((update) => {
              if (!stillCurrent()) return;
              if (update.status === "snapshot") {
                applyProgressiveDiscovery(update.value, update.token);
              } else if (update.status === "unchanged") {
                progressiveDiscoveryTokenRef.current = update.token;
              }
            })
            .catch(() => undefined);

          await Promise.allSettled([transcriptRead, stateRead]);
          // A superseding refresh owns the flag from here on; clearing it would
          // report that tab as settled while its newer read is still running.
          if (stillCurrent()) setSessionStateRefreshing(false);
          if (
            stillCurrent() &&
            transcriptMissing &&
            stateMissing &&
            establishingSessionRef.current === 0
          ) {
            applyProjection(null);
            markTranscriptAvailability("unavailable");
            setTranscriptRefreshing(false);
            updateProgressiveCache({
              transcriptAvailability: "unavailable",
              transcriptRefreshing: false,
              stateAvailability: "unavailable",
            });
          }
          if (stillCurrent()) {
            if (projectionRef.current) establishmentFailureRef.current = false;
            if (projectionRef.current || !establishmentFailureRef.current) setRuntimeError(null);
          }
          return projectionRef.current;
        }

        let next: NativeAgentSessionProjection<TMessage> | null;
        /*
         * Every sync side effect is deferred behind the fence below.
         *
         * A poll can outlive the stop, resume, control update or session
         * replacement that started after it, and the guard further down
         * recognises exactly that case. Materializing on the way to the answer
         * defeated it: the refs, the renderer cache and the shared store had
         * already been rewritten from the stale read by the time the sequence
         * comparison rejected it.
         */
        let commit: (() => void) | null = null;
        if (await nativeAgentSyncSupported()) {
          let update = await getNativeAgentProjectionUpdate<TMessage>({
            ...identity,
            syncVersion: 1,
            liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
            ...(syncTokenRef.current ? { knownToken: syncTokenRef.current } : {}),
            ...(options?.manual === true ? { forceSnapshot: true } : {}),
          });
          if (update.status === "unchanged") {
            next = projectionRef.current;
          } else if (update.status === "missing") {
            next = null;
            commit = resetSyncState;
          } else {
            let live: NativeAgentSessionProjection<TMessage> | null = null;
            if (update.status === "snapshot") {
              live = update.projection;
            } else if (syncTokenRef.current === update.baseToken && syncLiveProjectionRef.current) {
              live = applyNativeAgentProjectionDelta(syncLiveProjectionRef.current, update.delta);
            }
            if (
              live &&
              (!isNativeAgentSessionProjection(live) ||
                live.platform !== platform ||
                live.environmentId !== environmentId)
            ) {
              live = null;
            }
            const deletedMessageIds =
              update.status === "delta" ? update.delta.deletedMessageIds : [];
            if (!live) {
              update = await getNativeAgentProjectionUpdate<TMessage>({
                ...identity,
                syncVersion: 1,
                liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
                forceSnapshot: true,
              });
              live = update.status === "snapshot" ? update.projection : null;
              if (
                live &&
                (!isNativeAgentSessionProjection(live) ||
                  live.platform !== platform ||
                  live.environmentId !== environmentId)
              ) {
                live = null;
              }
            }
            if (live && (update.status === "snapshot" || update.status === "delta")) {
              const plan = planSyncMaterialization({
                live,
                token: update.token,
                historyEpoch: update.historyEpoch,
                historyComplete: update.historyComplete,
                boundary: { cursor: update.historyCursor },
                deletedMessageIds,
              });
              next = plan.materialized;
              commit = () => commitSyncMaterialization(plan);
            } else {
              next = null;
            }
          }
        } else {
          next = await getNativeAgentProjection<TMessage>({
            ...identity,
            ...(messageLimit === undefined ? {} : { messageLimit }),
          });
        }
        if (
          sequence === refreshSequenceRef.current &&
          operationEpoch === projectionOperationEpochRef.current &&
          // An empty read that raced this tab's own session creation says
          // nothing about the session; installing it would discard a cached
          // projection in favour of a state the backend never asserted.
          !(next === null && establishingSessionRef.current > 0)
        ) {
          commit?.();
          if (!syncLiveProjectionRef.current || !next) applyProjection(next);
          markSessionStateAvailability(next ? "current" : "unavailable");
          setSessionStateRefreshing(false);
          markTranscriptAvailability(
            next ? (next.messages.length === 0 ? "empty" : "current") : "unavailable",
          );
          setTranscriptRefreshing(false);
          setTranscriptError(null);
          setSessionStateError(null);
          // A session that exists supersedes any earlier creation failure. One
          // that still does not exist is exactly what that failure described, so
          // its message survives instead of decaying into a generic failure.
          if (next) establishmentFailureRef.current = false;
          if (next || !establishmentFailureRef.current) setRuntimeError(null);
        }
        return next;
      } catch (error) {
        if (
          sequence === refreshSequenceRef.current &&
          operationEpoch === projectionOperationEpochRef.current
        ) {
          setRuntimeError(error instanceof Error ? error.message : String(error));
          setTranscriptRefreshing(false);
        }
        return null;
      } finally {
        refreshesInFlightRef.current = Math.max(0, refreshesInFlightRef.current - 1);
        if (
          sequence === refreshSequenceRef.current &&
          operationEpoch === projectionOperationEpochRef.current &&
          // Nothing this read saw is settled while the session it describes is
          // still being created. `connect` owns the connection surface for that
          // window and reads authoritatively once the provider mapping exists.
          establishingSessionRef.current === 0
        ) {
          setIsRefreshing(false);
          // Settled, whatever it returned. A read that resolves to null is an
          // authoritative "no session", not a pending one.
          setHasCompletedRead(true);
        }
        flushPendingReconcile();
      }
    },
    [
      applyProjection,
      applyProgressiveDiscovery,
      applyProgressiveState,
      applyProgressiveTranscript,
      beginSessionStateRefresh,
      commitSyncMaterialization,
      enabled,
      environmentId,
      flushPendingReconcile,
      identity,
      messageLimit,
      markSessionStateAvailability,
      markTranscriptAvailability,
      planSyncMaterialization,
      platform,
      resetSyncState,
      updateProgressiveCache,
    ],
  );

  useEffect(() => {
    refreshRef.current = refresh;
    return () => {
      if (refreshRef.current === refresh) refreshRef.current = null;
    };
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!enabled) {
      setIsRefreshing(false);
      return null;
    }
    setIsRefreshing(true);
    // Leave the previous identity's failure behind so Retry is not stuck on
    // Connection Failed for the whole reconnect, and a later platform cannot
    // inherit a completed read it never made.
    setRuntimeError(null);
    setHasCompletedRead(false);
    establishmentFailureRef.current = false;
    // Held only for as long as the provider mapping is genuinely missing, so
    // the reads that follow the adopt/ensure below still settle normally and a
    // session that really is gone is still reported as one.
    establishingSessionRef.current += 1;
    let establishing = true;
    const settleEstablishing = () => {
      if (!establishing) return;
      establishing = false;
      establishingSessionRef.current = Math.max(0, establishingSessionRef.current - 1);
    };
    const cached = projectionRef.current;
    const cachedSessionMatches = Boolean(
      initialProviderSessionId &&
      cached?.platform === platform &&
      cached.sessionId === initialProviderSessionId,
    );
    // On an environment remount the durable mapping has already been adopted.
    // Start the transcript read alongside the liveness/adoption check so the
    // common path pays the slower operation once, not both in series.
    const cachedSessionRefresh = cachedSessionMatches ? refresh() : null;
    try {
      if (initialProviderSessionId) {
        try {
          await adoptNativeAgentSession({
            ...identity,
            providerSessionId: initialProviderSessionId,
            ...(initialAgentModel ? { model: initialAgentModel } : {}),
            ...(initialReasoningEffort ? { reasoningEffort: initialReasoningEffort } : {}),
            ...(initialConversationMode ? { sessionMode: initialConversationMode } : {}),
            ...(typeof initialFastMode === "boolean" ? { fastMode: initialFastMode } : {}),
            ...(initialExecutionProfileId ? { executionProfileId: initialExecutionProfileId } : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("provider session was not found")) throw error;
          if (requireExistingResumeSession) throw error;
          // A restored pane may point at a rollout deleted outside
          // Orkestrator. Only an authoritative provider "missing" result may
          // replace it; transport failures remain retryable and never create a
          // surprise second session.
          const replacement = await ensureNativeAgentSession({
            ...identity,
            title:
              platform === "cursor"
                ? "Cursor Agent"
                : platform === "grok"
                  ? "Grok Build"
                  : "Agent Session",
            model: initialAgentModel ?? defaultAgentModel,
            reasoningEffort: initialReasoningEffort ?? defaultReasoningEffort,
            sessionMode: initialConversationMode,
            fastMode: initialFastMode ?? defaultFastMode,
            executionProfileId: initialExecutionProfileId,
            parameterValues: defaultParameterValues,
          });
          await onResumeSessionReplaced?.({
            requestedProviderSessionId: initialProviderSessionId,
            replacementProviderSessionId: replacement.providerSessionId,
            logicalSessionKey: replacement.logicalSessionKey,
          });
          setResumeSessionReplacement({
            requestedProviderSessionId: initialProviderSessionId,
            replacementProviderSessionId: replacement.providerSessionId,
          });
        }
      } else {
        await ensureNativeAgentSession({
          ...identity,
          title:
            platform === "cursor"
              ? "Cursor Agent"
              : platform === "grok"
                ? "Grok Build"
                : "Agent Session",
          model: initialAgentModel ?? defaultAgentModel,
          reasoningEffort: initialReasoningEffort ?? defaultReasoningEffort,
          sessionMode: initialConversationMode,
          fastMode: initialFastMode ?? defaultFastMode,
          executionProfileId: initialExecutionProfileId,
          parameterValues: defaultParameterValues,
        });
      }
      isInitializedRef.current = true;
      lastInitTimeRef.current = Date.now();
      acknowledgeInitialLaunchOptions();
      establishmentFailureRef.current = false;
      setRuntimeError(null);
      // The provider mapping now exists, so every read from here on is
      // authoritative again — including the two below.
      settleEstablishing();
      if (cachedSessionRefresh) {
        const hydrated = await cachedSessionRefresh;
        if (
          hydrated?.connection === "connected" &&
          hydrated.platform === platform &&
          hydrated.sessionId === initialProviderSessionId
        ) {
          return hydrated;
        }
      }
      return await refresh();
    } catch (error) {
      // A failed adopt/ensure is a real, reportable failure: close the window
      // first so this error actually reaches the connection surface, and mark it
      // so the reads that follow — the trailing reconcile below, then the poll
      // loop — report the same failure rather than overwriting it.
      settleEstablishing();
      establishmentFailureRef.current = true;
      setRuntimeError(error instanceof Error ? error.message : String(error));
      setIsRefreshing(false);
      setTranscriptRefreshing(false);
      markSessionStateAvailability("unavailable");
      setSessionStateRefreshing(false);
      setHasCompletedRead(true);
      return null;
    } finally {
      // Backstop for a path that returned before the settle above, and the
      // point where a reconciliation coalesced during establishment is run.
      settleEstablishing();
      flushPendingReconcile();
    }
  }, [
    acknowledgeInitialLaunchOptions,
    defaultAgentModel,
    defaultFastMode,
    defaultParameterValues,
    defaultReasoningEffort,
    identity,
    initialAgentModel,
    initialConversationMode,
    initialFastMode,
    initialExecutionProfileId,
    initialProviderSessionId,
    initialReasoningEffort,
    markSessionStateAvailability,
    requireExistingResumeSession,
    onResumeSessionReplaced,
    enabled,
    flushPendingReconcile,
    platform,
    refresh,
  ]);

  // A new identity, or a session this hook is no longer allowed to read, has
  // nothing settled about it yet. Without this reset a completed read would
  // keep vouching for a platform or environment it never covered — a deferred
  // tab resolves its platform after mount, which is exactly that case.
  useEffect(() => {
    setHasCompletedRead(false);
    setResumeSessionReplacement(null);
    // For the same reason: one identity's creation failure must not keep
    // suppressing another identity's authoritative reads.
    establishmentFailureRef.current = false;
    resetSyncState();
    const store = useNativeAgentProjectionStore.getState();
    historyEvictionRef.current = store.historyEvictions.get(sessionKey) ?? 0;
    progressiveHistoryEvictionRef.current = store.historyEvictions.get(sessionKey) ?? 0;
    const cached = store.syncCaches.get(sessionKey);
    if (
      cached &&
      cached.liveProjection.platform === platform &&
      cached.liveProjection.environmentId === environmentId
    ) {
      syncTokenRef.current = cached.token;
      syncLiveProjectionRef.current =
        cached.liveProjection as NativeAgentSessionProjection<TMessage>;
      historyEpochRef.current = cached.historyEpoch;
      historyCursorRef.current = cached.historyCursor;
      historyBoundaryCursorRef.current = cached.historyBoundaryCursor;
      historyCompleteRef.current = cached.historyComplete;
      historyBootstrapRef.current = cached.historyBootstrap === true;
      historyMessagesRef.current = cached.historyMessages as TMessage[];
    }
    const progressive = store.progressiveCaches.get(sessionKey);
    if (
      progressive?.identity?.environmentId === environmentId &&
      progressive.identity.platform === platform &&
      progressive.identity.logicalSessionKey === sessionKey &&
      (!initialProviderSessionId ||
        progressive.identity.providerSessionId === initialProviderSessionId)
    ) {
      progressiveIdentityRef.current = progressive.identity;
      progressiveTranscriptTokenRef.current = progressive.transcriptToken;
      progressiveHistoryEpochRef.current = progressive.transcriptHistoryEpoch;
      /*
       * The shared cache carries tokens, not the session-state value they
       * validate. Replaying the token would let the backend answer `unchanged`
       * and grant this mount authority over controls it never read, so the
       * first state read after a remount always asks for a full snapshot.
       */
      progressiveStateTokenRef.current = undefined;
      progressiveDiscoveryTokenRef.current = progressive.discoveryToken;
      progressiveDiscoveryRef.current = progressive.discovery;
      markTranscriptAvailability(
        progressive.transcriptAvailability === "empty"
          ? "empty"
          : projectionRef.current
            ? "cached"
            : "unavailable",
      );
      setTranscriptError(progressive.transcriptError ?? null);
      markSessionStateAvailability("unavailable");
      setSessionStateError(null);
    } else {
      progressiveIdentityRef.current = undefined;
      progressiveTranscriptTokenRef.current = undefined;
      progressiveHistoryEpochRef.current = undefined;
      progressiveStateTokenRef.current = undefined;
      progressiveDiscoveryTokenRef.current = undefined;
      progressiveDiscoveryRef.current = undefined;
      // No matching transcript metadata, so a retained or foreign projection is
      // only ever `cached` here: its message count cannot prove the transcript
      // read ever came back empty.
      markTranscriptAvailability(projectionRef.current ? "cached" : "unavailable");
      setTranscriptError(null);
      markSessionStateAvailability("unavailable");
      setSessionStateError(null);
    }
  }, [
    enabled,
    environmentId,
    identity,
    initialProviderSessionId,
    markSessionStateAvailability,
    markTranscriptAvailability,
    platform,
    resetSyncState,
    sessionKey,
  ]);

  useEffect(() => {
    if (!enabled || !isActive) {
      setIsRefreshing(false);
      setTranscriptRefreshing(false);
      return;
    }
    void connect().then(() => undefined);
  }, [connect, enabled, isActive]);

  useEffect(() => {
    const unsubscribeChange = onResourceChanged("native-agent-session", (change) => {
      if (
        enabled &&
        isActive &&
        change.id === environmentId &&
        (change.agent === undefined ||
          (change.agent === platform && change.logicalSessionKey === sessionKey))
      ) {
        void refresh({ manual: false, reconcileAfterInFlight: true });
      }
    });
    const unsubscribeResync = onResourceResync(() => {
      invalidateNativeAgentSyncCapability();
      if (enabled && isActive) {
        void refresh({ manual: false, reconcileAfterInFlight: true });
      }
    });
    return () => {
      unsubscribeChange();
      unsubscribeResync();
    };
  }, [enabled, environmentId, isActive, platform, refresh, sessionKey]);

  useEffect(() => {
    if (!enabled || !isActive) return;
    const active =
      runtimeProjection?.turn.phase === "running" ||
      runtimeProjection?.turn.phase === "blocked" ||
      runtimeProjection?.turn.phase === "cancelling" ||
      runtimeProjection?.turn.phase === "recovering";
    const timer = window.setInterval(
      () => {
        void refresh({ manual: false });
      },
      active ? ACTIVE_PROJECTION_REFRESH_MS : IDLE_PROJECTION_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [enabled, isActive, refresh, runtimeProjection?.turn.phase]);

  const send = useCallback(
    async (
      prompt: string,
      options: NativeAgentSendOptions = {},
    ): Promise<NativeAgentDispatchOutcome> => {
      const text = prompt.trim();
      if (!text) return { outcome: "rejected", error: "Prompt must not be blank" };
      const pending = pendingDispatchRef.current;
      const requestId =
        options.requestId ?? (pending?.prompt === text ? pending.requestId : crypto.randomUUID());
      pendingDispatchRef.current = { prompt: text, requestId };
      beginProjectionMutation();
      setIsDispatching(true);
      try {
        const outcome = await dispatchNativeAgentIntent({
          ...identity,
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          title:
            platform === "cursor"
              ? "Cursor Agent"
              : platform === "grok"
                ? "Grok Build"
                : "Agent Session",
          prompt: text,
          requestId,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          mode: options.mode,
          fastMode: options.fastMode,
          subAgent: options.subAgent,
          executionAgent: options.executionAgent,
          includeLocalSettings: options.includeLocalSettings,
          promptSuggestions: options.promptSuggestions,
          attachments: options.attachments,
        });
        if (outcome.outcome !== "unknown") pendingDispatchRef.current = null;
        if (outcome.outcome === "accepted") {
          useNativeAgentProjectionStore.getState().clearTurnStopped(sessionKey);
        }
        await refresh();
        return outcome;
      } catch (error) {
        // Keep the stable request id. If the transport failed after acceptance,
        // an explicit retry is deduplicated by the backend/provider journal.
        await refresh();
        return {
          outcome: "unknown",
          requestId,
          // The RPC itself failed, so the backend never opened its at-most-once
          // window and no recoverable record can exist for this request id.
          // Marking it lets the renderer surface the failure instead of leaving
          // the optimistic prompt looking delivered with no feedback at all.
          origin: "transport",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        setIsDispatching(false);
      }
    },
    [beginProjectionMutation, identity, platform, refresh, sessionKey],
  );

  const stop = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const stoppedSessionId = projectionRef.current?.sessionId;
    const next = await stopNativeAgentSession<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
    if (stoppedSessionId) {
      useNativeAgentProjectionStore.getState().markTurnStopped(sessionKey, stoppedSessionId);
    }
    return next;
  }, [applyMutationProjection, beginProjectionMutation, identity, sessionKey]);

  const stopBackgroundTask = useCallback(
    async (taskId: string) => {
      const operationEpoch = beginProjectionMutation();
      const next = await stopNativeAgentBackgroundTask<TMessage>({
        ...identity,
        taskId,
      });
      if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
      return next;
    },
    [applyMutationProjection, beginProjectionMutation, identity],
  );

  const dismissSuggestedPrompt = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const next = await dismissNativeAgentSuggestedPrompt<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
    return next;
  }, [applyMutationProjection, beginProjectionMutation, identity]);

  const updateControls = useCallback(
    async (update: NativeAgentControlUpdate) => {
      const operationEpoch = beginProjectionMutation();
      const next = await updateNativeAgentControls<TMessage>({ ...identity, update });
      if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
      return next;
    },
    [applyMutationProjection, beginProjectionMutation, identity],
  );

  useEffect(() => {
    if (!matchingSharedProjection || matchingSharedProjection === projectionRef.current) return;
    const current = projectionRef.current;
    if (
      current &&
      current.generation === matchingSharedProjection.generation &&
      matchingSharedProjection.revision < current.revision
    )
      return;
    projectionRef.current = matchingSharedProjection;
    setRuntimeProjection(matchingSharedProjection);
  }, [matchingSharedProjection]);

  const resolveInteraction = useCallback(
    async (
      interactionId: string,
      resolution: AgentInteractionResolution,
    ): Promise<AgentInteractionApplyOutcome> => {
      const outcome = await resolveNativeAgentInteraction({
        ...identity,
        interactionId,
        resolution,
      });
      await refresh();
      return outcome;
    },
    [identity, refresh],
  );

  const queueKey = useMemo(() => `${platform}\0${sessionKey}`, [platform, sessionKey]);
  const enqueue = useCallback(
    async (prompt: string, options: NativeAgentSendOptions = {}) => {
      const text = prompt.trim();
      if (!text) throw new Error("Prompt must not be blank");
      await enqueuePromptQueueMessage(queueKey, environmentId, {
        id: options.requestId ?? crypto.randomUUID(),
        text,
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.fastMode === undefined ? {} : { fastMode: options.fastMode }),
        ...(options.subAgent ? { agent: options.subAgent } : {}),
        ...(options.executionAgent ? { executionAgent: options.executionAgent } : {}),
        ...(options.includeLocalSettings === undefined
          ? {}
          : { includeLocalSettings: options.includeLocalSettings }),
        ...(options.promptSuggestions === undefined
          ? {}
          : { promptSuggestions: options.promptSuggestions }),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      });
      return refresh();
    },
    [environmentId, queueKey, refresh],
  );
  const removeQueued = useCallback(
    async (messageId: string) => {
      await removePromptQueueMessage(queueKey, environmentId, messageId);
      return refresh();
    },
    [environmentId, queueKey, refresh],
  );
  const moveQueued = useCallback(
    async (messageId: string, direction: "up" | "down") => {
      await movePromptQueueMessage(queueKey, environmentId, messageId, direction);
      return refresh();
    },
    [environmentId, queueKey, refresh],
  );
  const retryQueue = useCallback(async () => {
    await retryPromptQueueDispatch(queueKey);
    return refresh();
  }, [queueKey, refresh]);
  const retryRecoverableDispatch = useCallback(async () => {
    const requestId = projectionRef.current?.recoverableDispatch?.requestId;
    if (!requestId) {
      return { outcome: "rejected" as const, error: "There is no recoverable dispatch" };
    }
    beginProjectionMutation();
    setIsDispatching(true);
    try {
      const outcome = await retryNativeAgentDispatch({ ...identity, requestId });
      if (outcome.outcome !== "unknown") pendingDispatchRef.current = null;
      await refresh();
      return outcome;
    } finally {
      setIsDispatching(false);
    }
  }, [beginProjectionMutation, identity, refresh]);
  /**
   * Stop a parked dispatch from blocking the session without re-sending it.
   *
   * The prompt may still have run at the provider, which is exactly why it was
   * parked; discarding says the user accepts that and wants the composer back.
   */
  const discardRecoverableDispatch = useCallback(async () => {
    const requestId = projectionRef.current?.recoverableDispatch?.requestId;
    if (!requestId) return { discarded: false };
    beginProjectionMutation();
    setIsDispatching(true);
    try {
      const outcome = await discardNativeAgentDispatch({ ...identity, requestId });
      pendingDispatchRef.current = null;
      await refresh();
      return outcome;
    } finally {
      setIsDispatching(false);
    }
  }, [beginProjectionMutation, identity, refresh]);
  const listResumable = useCallback(() => listNativeAgentResumableSessions(identity), [identity]);
  const resume = useCallback(
    async (providerSessionId: string, controls?: NativeAgentControlUpdate) => {
      const operationEpoch = beginProjectionMutation();
      const next = await resumeNativeAgentSession<TMessage>({
        ...identity,
        providerSessionId,
        controls,
      });
      if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
      return next;
    },
    [applyMutationProjection, beginProjectionMutation, identity],
  );
  const fork = useCallback(
    (messageId?: string) => forkNativeAgentSession({ ...identity, messageId }),
    [identity],
  );
  const performAction = useCallback(
    async (action: NativeAgentSessionAction) => {
      const outcome = await performNativeAgentSessionAction({ ...identity, action });
      await refresh();
      return outcome;
    },
    [identity, refresh],
  );
  const refreshModels = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const next = await refreshNativeAgentModels<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyMutationProjection(next);
    return next;
  }, [applyMutationProjection, beginProjectionMutation, identity]);
  const loadToolDetails = useCallback(
    (detailRef: string): Promise<NativeAgentToolDetails> =>
      getNativeAgentToolDetails({ ...identity, detailRef }),
    [identity],
  );
  /**
   * Widen the transcript window, then reconcile.
   *
   * Grows from whatever the backend actually returned rather than from a local
   * counter, so repeated clicks cannot outrun the provider or ask for a window
   * the session never had.
   */
  const loadEarlierMessages = useCallback(async () => {
    const requestedOperationEpoch = projectionOperationEpochRef.current;
    const progressive = await nativeAgentProgressiveSupported();
    if (
      progressive &&
      !historyCursorRef.current &&
      (!syncLiveProjectionRef.current || historyBootstrapRef.current)
    ) {
      /*
       * The progressive transcript knows that history exists long before the
       * backend has populated the paging cache that mints its cursor: only a
       * sync-v1 read fills that cache, and this tab may never have issued one.
       * The joined snapshot is what turns "there is history" into a cursor.
       */
      const update = await getNativeAgentProjectionUpdate<TMessage>({
        ...identity,
        syncVersion: 1,
        liveWindow: DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
        forceSnapshot: true,
      });
      /*
       * Fence before committing, not after. A mutation that landed while the
       * snapshot was in flight owns the transcript now, and installing this
       * plan would rewrite the paging refs from a pre-mutation live tail.
       */
      if (requestedOperationEpoch !== projectionOperationEpochRef.current) {
        return projectionRef.current;
      }
      if (update.status === "snapshot") {
        const live = update.projection;
        if (
          isNativeAgentSessionProjection(live) &&
          live.platform === platform &&
          live.environmentId === environmentId
        ) {
          commitSyncMaterialization(
            planSyncMaterialization({
              live,
              token: update.token,
              historyEpoch: update.historyEpoch,
              historyComplete: update.historyComplete,
              boundary: { cursor: update.historyCursor },
            }),
          );
        }
      }
    }
    if (requestedOperationEpoch !== projectionOperationEpochRef.current) {
      return projectionRef.current;
    }
    if (await nativeAgentSyncSupported()) {
      const before = historyCursorRef.current;
      if (!before) return projectionRef.current;
      /*
       * Free room from inactive identities first, then ask for a page that
       * fits what is left. Bounding the request is what keeps acceptance
       * all-or-nothing: a page trimmed on arrival would strand its older half
       * behind a cursor only the server can mint.
       */
      evictNativeAgentHistoryCaches(
        sessionKey,
        encodedBytes(historyMessagesRef.current),
        CLIENT_HISTORY_TOTAL_MAX_BYTES,
      );
      const budget = historyRequestBudget();
      if (budget.messages <= 0 || budget.bytes <= 0) return projectionRef.current;
      const sequence = ++refreshSequenceRef.current;
      const page = await getNativeAgentMessagePage<TMessage>({
        ...identity,
        syncVersion: 1,
        before,
        limit: Math.min(budget.messages, HISTORY_PAGE_MAX_MESSAGES),
        targetBytes: budget.bytes,
      });
      // A mutation that landed while the page was in flight owns the transcript
      // now. Installing this page would merge history into a live tail it no
      // longer describes.
      if (
        sequence !== refreshSequenceRef.current ||
        requestedOperationEpoch !== projectionOperationEpochRef.current
      ) {
        return projectionRef.current;
      }
      const syncLive = syncLiveProjectionRef.current;
      const token = syncTokenRef.current;
      /*
       * `historyEpochRef` and `page.historyEpoch` are both the backend's paging
       * epoch, so a mismatch means the history this cursor described has been
       * rewritten. The token is deliberately not required: a progressive tail
       * pages without ever holding a joined-projection token.
       */
      if (page.historyEpoch !== historyEpochRef.current || !syncLive) {
        resetSyncState();
        await refresh({ manual: true });
        return projectionRef.current;
      }
      const current = projectionRef.current;
      const live =
        current &&
        current.platform === syncLive.platform &&
        current.environmentId === syncLive.environmentId &&
        current.sessionId === syncLive.sessionId &&
        current.generation === syncLive.generation
          ? {
              ...current,
              messages: syncLive.messages,
              ...(syncLive.messageWindow
                ? { messageWindow: syncLive.messageWindow }
                : { messageWindow: undefined }),
            }
          : syncLive;
      const existing = new Set(
        [...historyMessagesRef.current, ...live.messages].map(
          (message) => (message as { id?: unknown }).id,
        ),
      );
      const newMessages = page.messages.filter(
        (message) => !existing.has((message as { id?: unknown }).id),
      );
      const retained = [...historyMessagesRef.current];
      const accepted: TMessage[] = [];
      const messageBudget = Math.max(0, CLIENT_HISTORY_MAX_MESSAGES - live.messages.length);
      let acceptedBytes = 0;
      for (let index = newMessages.length - 1; index >= 0; index -= 1) {
        if (accepted.length + retained.length >= messageBudget) break;
        const message = newMessages[index]!;
        const bytes = encodedBytes(message) + 1;
        if (acceptedBytes + bytes > budget.bytes) break;
        accepted.unshift(message);
        acceptedBytes += bytes;
      }
      // One message larger than the whole remaining byte budget would otherwise
      // make the control permanently inert. Take it anyway: the plan below
      // still enforces the retained-history ceiling, and a click must always
      // either show more or stop offering to.
      if (accepted.length === 0 && newMessages.length > 0 && retained.length < messageBudget) {
        accepted.push(newMessages[newMessages.length - 1]!);
      }
      const acceptedWholePage = accepted.length === newMessages.length;
      /*
       * A partially accepted page keeps the cursor it was fetched with.
       * Advancing to `nextCursor` would acknowledge messages that were never
       * retained, and clearing the cursor entirely — the previous behaviour —
       * made them unreachable until the history epoch rotated.
       */
      const plan = planSyncMaterialization({
        live,
        ...(token ? { token } : {}),
        historyEpoch: page.historyEpoch,
        historyComplete: page.complete,
        retained: {
          messages: [...accepted, ...retained],
          ...(acceptedWholePage
            ? page.nextCursor
              ? { cursor: page.nextCursor }
              : {}
            : { cursor: before }),
          complete: page.complete,
        },
      });
      return commitSyncMaterialization(plan);
    }
    const current =
      projectionRef.current?.messageWindow?.limit ?? messageLimit ?? DEFAULT_MESSAGE_WINDOW;
    const next = Math.min(current * 2, MAX_MESSAGE_WINDOW);
    if (next <= current) return projectionRef.current;
    setMessageLimit(next);
    const sequence = ++refreshSequenceRef.current;
    const projection = await getNativeAgentProjection<TMessage>({
      ...identity,
      messageLimit: next,
    });
    if (
      sequence === refreshSequenceRef.current &&
      requestedOperationEpoch === projectionOperationEpochRef.current
    )
      applyProjection(projection);
    return projection;
  }, [
    applyProjection,
    commitSyncMaterialization,
    historyRequestBudget,
    identity,
    messageLimit,
    planSyncMaterialization,
    environmentId,
    platform,
    refresh,
    resetSyncState,
    sessionKey,
  ]);

  return {
    sessionKey,
    projection: effectiveProjection,
    runtimeProjection: effectiveProjection,
    runtimeError,
    resumeSessionReplacement,
    isRefreshing,
    hasCompletedRead,
    transcriptAvailability,
    transcriptRefreshing,
    transcriptError,
    sessionStateAvailability,
    sessionStateRefreshing,
    sessionStateError,
    isDispatching,
    refresh,
    connect,
    send,
    stop,
    stopBackgroundTask,
    dismissSuggestedPrompt,
    updateControls,
    resolveInteraction,
    enqueue,
    removeQueued,
    moveQueued,
    retryQueue,
    retryRecoverableDispatch,
    discardRecoverableDispatch,
    listResumable,
    resume,
    fork,
    performAction,
    refreshModels,
    loadToolDetails,
    loadEarlierMessages,
    initialLaunchOptionsRef,
    initialLaunchOptionsPendingRef,
    acknowledgeInitialLaunchOptions,
    isInitializedRef,
    lastInitTimeRef,
    forkInFlightRef,
  };
}
