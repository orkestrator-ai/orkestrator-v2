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
  NativeAgentSessionProjection,
  NativeAgentSessionAction,
  NativeAgentToolDetails,
} from "@orkestrator/protocol/native-agent";
import {
  adoptNativeAgentSession,
  dispatchNativeAgentIntent,
  dismissNativeAgentSuggestedPrompt,
  enqueuePromptQueueMessage,
  ensureNativeAgentSession,
  getNativeAgentProjection,
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
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";

/** Mirrors the backend's default window; only used to size the first expansion. */
const DEFAULT_MESSAGE_WINDOW = 512;
/** Mirrors the backend ceiling, so the button stops offering what it would clamp. */
const MAX_MESSAGE_WINDOW = 4_096;
const ACTIVE_PROJECTION_REFRESH_MS = 500;
const IDLE_PROJECTION_REFRESH_MS = 1_500;

interface UseNativeAgentSessionOptions {
  platform: AgentPlatform;
  environmentId: string;
  tabId: string;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  defaultAgentModel?: string;
  defaultReasoningEffort?: string;
  initialProviderSessionId?: string;
  initialConversationMode?: "build" | "plan";
  initialFastMode?: boolean;
  initialExecutionProfileId?: string;
  defaultFastMode?: boolean;
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
  initialConversationMode,
  initialFastMode,
  initialExecutionProfileId,
  defaultFastMode,
  isActive = true,
  enabled = true,
}: UseNativeAgentSessionOptions) {
  const sessionKey = useMemo(
    () => createSessionKey(environmentId, tabId),
    [environmentId, tabId],
  );
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
    mode: initialConversationMode,
    fastMode: initialFastMode,
    executionProfileId: initialExecutionProfileId,
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(
      initialAgentModel
      || initialReasoningEffort
      || initialConversationMode
      || typeof initialFastMode === "boolean"
      || initialExecutionProfileId
    ),
  );
  const isInitializedRef = useRef(false);
  const lastInitTimeRef = useRef(0);
  const forkInFlightRef = useRef(false);
  const [runtimeProjection, setRuntimeProjection] = useState<
    NativeAgentSessionProjection<TMessage> | null
  >(null);
  const sharedProjection = useNativeAgentProjectionStore((state) =>
    state.projections.get(sessionKey),
  ) as NativeAgentSessionProjection<TMessage> | undefined;
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
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
    sharedProjection ?? null,
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
  const refreshRef = useRef<(
    options?: { manual?: boolean; reconcileAfterInFlight?: boolean },
  ) => Promise<NativeAgentSessionProjection<TMessage> | null>>(null);
  const pendingDispatchRef = useRef<{
    prompt: string;
    requestId: string;
  } | null>(null);
  const effectiveProjection = sharedProjection ?? runtimeProjection;
  const clearTabInitialAgentOptions = usePaneLayoutStore(
    (state) => state.clearTabInitialAgentOptions,
  );
  const updateTabNativeSessionId = usePaneLayoutStore(
    (state) => state.updateTabNativeSessionId,
  );
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
    return projectionOperationEpochRef.current;
  }, []);

  const applyProjection = useCallback((next: NativeAgentSessionProjection<TMessage> | null) => {
    if (!next) {
      projectionRef.current = null;
      setRuntimeProjection(null);
      useNativeAgentProjectionStore.getState().setProjection(sessionKey, null);
      return;
    }
    const current = projectionRef.current;
    if (
      current
      && current.generation === next.generation
      && next.revision < current.revision
    ) return;
    projectionRef.current = next;
    const stopMarker = useNativeAgentProjectionStore.getState().turnStopMarkers.get(sessionKey);
    if (stopMarker && stopMarker.sessionId !== next.sessionId) {
      useNativeAgentProjectionStore.getState().clearTurnStopped(sessionKey);
    }
    setRuntimeProjection(next);
    useNativeAgentProjectionStore.getState().setProjection(
      sessionKey,
      next as NativeAgentSessionProjection,
    );
    if (next.sessionId) {
      updateTabNativeSessionId(tabId, next.sessionId, environmentId);
    }
  }, [environmentId, sessionKey, tabId, updateTabNativeSessionId]);

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

  const refresh = useCallback(async (options?: {
    manual?: boolean;
    reconcileAfterInFlight?: boolean;
  }) => {
    if (!enabled) return null;
    const background = options?.manual === false;
    // A background read is never worth issuing while the session is still
    // being established: it cannot resolve to anything but `null`, and the
    // per-environment invalidation that triggers most of them fires for every
    // sibling tab in the environment, so a second agent tab makes this the
    // common case rather than a rare race.
    if (
      background
      && (refreshesInFlightRef.current > 0 || establishingSessionRef.current > 0)
    ) {
      if (options.reconcileAfterInFlight) {
        reconcileAfterInFlightRef.current = true;
      }
      return projectionRef.current;
    }
    refreshesInFlightRef.current += 1;
    const sequence = ++refreshSequenceRef.current;
    const operationEpoch = projectionOperationEpochRef.current;
    setIsRefreshing(true);
    try {
      const next = await getNativeAgentProjection<TMessage>({
        ...identity,
        // Sent on every read so an expanded transcript survives a reconnect,
        // a generation change, or a refresh triggered by another tab.
        ...(messageLimit === undefined ? {} : { messageLimit }),
      });
      if (
        sequence === refreshSequenceRef.current
        && operationEpoch === projectionOperationEpochRef.current
        // An empty read that raced this tab's own session creation says
        // nothing about the session; installing it would discard a cached
        // projection in favour of a state the backend never asserted.
        && !(next === null && establishingSessionRef.current > 0)
      ) {
        applyProjection(next);
        // A session that exists supersedes any earlier creation failure. One
        // that still does not exist is exactly what that failure described, so
        // its message survives instead of decaying into a generic failure.
        if (next) establishmentFailureRef.current = false;
        if (next || !establishmentFailureRef.current) setRuntimeError(null);
      }
      return next;
    } catch (error) {
      if (
        sequence === refreshSequenceRef.current
        && operationEpoch === projectionOperationEpochRef.current
      ) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      }
      return null;
    } finally {
      refreshesInFlightRef.current = Math.max(0, refreshesInFlightRef.current - 1);
      if (
        sequence === refreshSequenceRef.current
        && operationEpoch === projectionOperationEpochRef.current
        // Nothing this read saw is settled while the session it describes is
        // still being created. `connect` owns the connection surface for that
        // window and reads authoritatively once the provider mapping exists.
        && establishingSessionRef.current === 0
      ) {
        setIsRefreshing(false);
        // Settled, whatever it returned. A read that resolves to null is an
        // authoritative "no session", not a pending one.
        setHasCompletedRead(true);
      }
      flushPendingReconcile();
    }
  }, [applyProjection, enabled, flushPendingReconcile, identity, messageLimit]);

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
      establishingSessionRef.current = Math.max(
        0,
        establishingSessionRef.current - 1,
      );
    };
    const cached = projectionRef.current;
    const cachedSessionMatches = Boolean(
      initialProviderSessionId
      && cached?.platform === platform
      && cached.sessionId === initialProviderSessionId,
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
            ...(initialExecutionProfileId
              ? { executionProfileId: initialExecutionProfileId }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("provider session was not found")) throw error;
          // A restored pane may point at a rollout deleted outside
          // Orkestrator. Only an authoritative provider "missing" result may
          // replace it; transport failures remain retryable and never create a
          // surprise second session.
          await ensureNativeAgentSession({
            ...identity,
            title: platform === "cursor" ? "Cursor Agent" : platform === "grok" ? "Grok Build" : "Agent Session",
            model: initialAgentModel ?? defaultAgentModel,
            reasoningEffort: initialReasoningEffort ?? defaultReasoningEffort,
            sessionMode: initialConversationMode,
            fastMode: initialFastMode ?? defaultFastMode,
            executionProfileId: initialExecutionProfileId,
          });
        }
      } else {
        await ensureNativeAgentSession({
          ...identity,
          title: platform === "cursor" ? "Cursor Agent" : platform === "grok" ? "Grok Build" : "Agent Session",
          model: initialAgentModel ?? defaultAgentModel,
          reasoningEffort: initialReasoningEffort ?? defaultReasoningEffort,
          sessionMode: initialConversationMode,
          fastMode: initialFastMode ?? defaultFastMode,
          executionProfileId: initialExecutionProfileId,
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
          hydrated?.connection === "connected"
          && hydrated.platform === platform
          && hydrated.sessionId === initialProviderSessionId
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
    defaultReasoningEffort,
    identity,
    initialAgentModel,
    initialConversationMode,
    initialFastMode,
    initialExecutionProfileId,
    initialProviderSessionId,
    initialReasoningEffort,
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
    // For the same reason: one identity's creation failure must not keep
    // suppressing another identity's authoritative reads.
    establishmentFailureRef.current = false;
  }, [enabled, identity]);

  useEffect(() => {
    if (!enabled || !isActive) {
      setIsRefreshing(false);
      return;
    }
    void connect().then(() => undefined);
  }, [connect, enabled, isActive]);

  useEffect(() => {
    const unsubscribeChange = onResourceChanged(
      "native-agent-session",
      ({ id }) => {
        if (enabled && isActive && id === environmentId) {
          void refresh({ manual: false, reconcileAfterInFlight: true });
        }
      },
    );
    const unsubscribeResync = onResourceResync(() => {
      if (enabled && isActive) {
        void refresh({ manual: false, reconcileAfterInFlight: true });
      }
    });
    return () => {
      unsubscribeChange();
      unsubscribeResync();
    };
  }, [enabled, environmentId, isActive, refresh]);

  useEffect(() => {
    if (!enabled || !isActive) return;
    const active = runtimeProjection?.turn.phase === "running"
      || runtimeProjection?.turn.phase === "blocked"
      || runtimeProjection?.turn.phase === "cancelling"
      || runtimeProjection?.turn.phase === "recovering";
    const timer = window.setInterval(
      () => { void refresh({ manual: false }); },
      active ? ACTIVE_PROJECTION_REFRESH_MS : IDLE_PROJECTION_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [enabled, isActive, refresh, runtimeProjection?.turn.phase]);

  const send = useCallback(async (
    prompt: string,
    options: NativeAgentSendOptions = {},
  ): Promise<NativeAgentDispatchOutcome> => {
    const text = prompt.trim();
    if (!text) return { outcome: "rejected", error: "Prompt must not be blank" };
    const pending = pendingDispatchRef.current;
    const requestId = options.requestId
      ?? (pending?.prompt === text ? pending.requestId : crypto.randomUUID());
    pendingDispatchRef.current = { prompt: text, requestId };
    beginProjectionMutation();
    setIsDispatching(true);
    try {
      const outcome = await dispatchNativeAgentIntent({
        ...identity,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        title: platform === "cursor" ? "Cursor Agent" : platform === "grok" ? "Grok Build" : "Agent Session",
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
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      setIsDispatching(false);
    }
  }, [beginProjectionMutation, identity, platform, refresh, sessionKey]);

  const stop = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const stoppedSessionId = projectionRef.current?.sessionId;
    const next = await stopNativeAgentSession<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyProjection(next);
    if (stoppedSessionId) {
      useNativeAgentProjectionStore.getState().markTurnStopped(
        sessionKey,
        stoppedSessionId,
      );
    }
    return next;
  }, [applyProjection, beginProjectionMutation, identity, sessionKey]);

  const stopBackgroundTask = useCallback(async (taskId: string) => {
    const operationEpoch = beginProjectionMutation();
    const next = await stopNativeAgentBackgroundTask<TMessage>({
      ...identity,
      taskId,
    });
    if (operationEpoch === projectionOperationEpochRef.current) applyProjection(next);
    return next;
  }, [applyProjection, beginProjectionMutation, identity]);

  const dismissSuggestedPrompt = useCallback(async () => {
    const operationEpoch = beginProjectionMutation();
    const next = await dismissNativeAgentSuggestedPrompt<TMessage>(identity);
    if (operationEpoch === projectionOperationEpochRef.current) applyProjection(next);
    return next;
  }, [applyProjection, beginProjectionMutation, identity]);

  const updateControls = useCallback(async (update: NativeAgentControlUpdate) => {
    const operationEpoch = beginProjectionMutation();
    const next = await updateNativeAgentControls<TMessage>({ ...identity, update });
    if (operationEpoch === projectionOperationEpochRef.current) applyProjection(next);
    return next;
  }, [applyProjection, beginProjectionMutation, identity]);

  useEffect(() => {
    if (!sharedProjection || sharedProjection === projectionRef.current) return;
    const current = projectionRef.current;
    if (
      current
      && current.generation === sharedProjection.generation
      && sharedProjection.revision < current.revision
    ) return;
    projectionRef.current = sharedProjection;
    setRuntimeProjection(sharedProjection);
  }, [sharedProjection]);

  const resolveInteraction = useCallback(async (
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
  }, [identity, refresh]);

  const queueKey = useMemo(
    () => `${platform}\0${sessionKey}`,
    [platform, sessionKey],
  );
  const enqueue = useCallback(async (
    prompt: string,
    options: NativeAgentSendOptions = {},
  ) => {
    const text = prompt.trim();
    if (!text) throw new Error("Prompt must not be blank");
    await enqueuePromptQueueMessage(queueKey, environmentId, {
      id: crypto.randomUUID(),
      text,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort
        ? { reasoningEffort: options.reasoningEffort }
        : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.fastMode === undefined ? {} : { fastMode: options.fastMode }),
      ...(options.subAgent ? { agent: options.subAgent } : {}),
      ...(options.executionAgent ? { executionAgent: options.executionAgent } : {}),
      ...(options.includeLocalSettings === undefined
        ? {} : { includeLocalSettings: options.includeLocalSettings }),
      ...(options.promptSuggestions === undefined
        ? {} : { promptSuggestions: options.promptSuggestions }),
      ...(options.attachments?.length
        ? { attachments: options.attachments }
        : {}),
    });
    return refresh();
  }, [environmentId, queueKey, refresh]);
  const removeQueued = useCallback(async (messageId: string) => {
    await removePromptQueueMessage(queueKey, environmentId, messageId);
    return refresh();
  }, [environmentId, queueKey, refresh]);
  const moveQueued = useCallback(async (
    messageId: string,
    direction: "up" | "down",
  ) => {
    await movePromptQueueMessage(queueKey, environmentId, messageId, direction);
    return refresh();
  }, [environmentId, queueKey, refresh]);
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
  const listResumable = useCallback(
    () => listNativeAgentResumableSessions(identity),
    [identity],
  );
  const resume = useCallback(async (
    providerSessionId: string,
    controls?: NativeAgentControlUpdate,
  ) => {
    const operationEpoch = beginProjectionMutation();
    const next = await resumeNativeAgentSession<TMessage>({
      ...identity,
      providerSessionId,
      controls,
    });
    if (operationEpoch === projectionOperationEpochRef.current) applyProjection(next);
    return next;
  }, [applyProjection, beginProjectionMutation, identity]);
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
    if (operationEpoch === projectionOperationEpochRef.current) applyProjection(next);
    return next;
  }, [applyProjection, beginProjectionMutation, identity]);
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
    const current = projectionRef.current?.messageWindow?.limit
      ?? messageLimit
      ?? DEFAULT_MESSAGE_WINDOW;
    const next = Math.min(current * 2, MAX_MESSAGE_WINDOW);
    if (next <= current) return projectionRef.current;
    setMessageLimit(next);
    const sequence = ++refreshSequenceRef.current;
    const operationEpoch = projectionOperationEpochRef.current;
    const projection = await getNativeAgentProjection<TMessage>({
      ...identity,
      messageLimit: next,
    });
    if (
      sequence === refreshSequenceRef.current
      && operationEpoch === projectionOperationEpochRef.current
    ) applyProjection(projection);
    return projection;
  }, [applyProjection, identity, messageLimit]);

  return {
    sessionKey,
    projection: effectiveProjection,
    runtimeProjection: effectiveProjection,
    runtimeError,
    isRefreshing,
    hasCompletedRead,
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
