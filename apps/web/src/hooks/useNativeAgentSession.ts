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
} from "@orkestrator/protocol/native-agent";
import {
  adoptNativeAgentSession,
  dispatchNativeAgentIntent,
  dismissNativeAgentSuggestedPrompt,
  enqueuePromptQueueMessage,
  ensureNativeAgentSession,
  getNativeAgentProjection,
  forkNativeAgentSession,
  listNativeAgentResumableSessions,
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
  initialProviderSessionId?: string;
  initialConversationMode?: "build" | "plan";
  initialFastMode?: boolean;
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
  initialProviderSessionId,
  initialConversationMode,
  initialFastMode,
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
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(initialAgentModel || initialReasoningEffort),
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

  const refresh = useCallback(async (options?: { manual?: boolean }) => {
    if (!enabled) return null;
    const background = options?.manual === false;
    if (background && refreshesInFlightRef.current > 0) {
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
      ) {
        applyProjection(next);
        setRuntimeError(null);
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
      ) setIsRefreshing(false);
    }
  }, [applyProjection, enabled, identity, messageLimit]);

  const connect = useCallback(async () => {
    if (!enabled) {
      setIsRefreshing(false);
      return null;
    }
    setIsRefreshing(true);
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
            model: initialAgentModel,
            reasoningEffort: initialReasoningEffort,
            sessionMode: initialConversationMode,
            fastMode: initialFastMode,
          });
        }
      } else {
        await ensureNativeAgentSession({
          ...identity,
          title: platform === "cursor" ? "Cursor Agent" : platform === "grok" ? "Grok Build" : "Agent Session",
          model: initialAgentModel,
          reasoningEffort: initialReasoningEffort,
          sessionMode: initialConversationMode,
          fastMode: initialFastMode,
        });
      }
      isInitializedRef.current = true;
      lastInitTimeRef.current = Date.now();
      acknowledgeInitialLaunchOptions();
      setRuntimeError(null);
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
      setRuntimeError(error instanceof Error ? error.message : String(error));
      setIsRefreshing(false);
      return null;
    }
  }, [
    acknowledgeInitialLaunchOptions,
    identity,
    initialAgentModel,
    initialConversationMode,
    initialFastMode,
    initialProviderSessionId,
    initialReasoningEffort,
    enabled,
    platform,
    refresh,
  ]);

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
          void refresh({ manual: false });
        }
      },
    );
    const unsubscribeResync = onResourceResync(() => {
      if (enabled && isActive) void refresh({ manual: false });
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
    listResumable,
    resume,
    fork,
    performAction,
    refreshModels,
    loadEarlierMessages,
    initialLaunchOptionsRef,
    initialLaunchOptionsPendingRef,
    acknowledgeInitialLaunchOptions,
    isInitializedRef,
    lastInitTimeRef,
    forkInFlightRef,
  };
}
