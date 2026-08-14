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
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(enabled);
  const [isDispatching, setIsDispatching] = useState(false);
  /**
   * How much transcript this tab has asked for. Undefined keeps the backend
   * default; `loadEarlierMessages` raises it, and the raised value is resent on
   * every subsequent read so the window cannot silently collapse.
   */
  const [messageLimit, setMessageLimit] = useState<number | undefined>(undefined);
  const projectionRef = useRef<NativeAgentSessionProjection<TMessage> | null>(null);
  const refreshSequenceRef = useRef(0);
  const pendingDispatchRef = useRef<{
    prompt: string;
    requestId: string;
  } | null>(null);
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

  const refresh = useCallback(async (_options?: { manual?: boolean }) => {
    if (!enabled) return null;
    const sequence = ++refreshSequenceRef.current;
    setIsRefreshing(true);
    try {
      const next = await getNativeAgentProjection<TMessage>({
        ...identity,
        // Sent on every read so an expanded transcript survives a reconnect,
        // a generation change, or a refresh triggered by another tab.
        ...(messageLimit === undefined ? {} : { messageLimit }),
      });
      if (sequence === refreshSequenceRef.current) {
        applyProjection(next);
        setRuntimeError(null);
      }
      return next;
    } catch (error) {
      if (sequence === refreshSequenceRef.current) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
      }
      return null;
    } finally {
      if (sequence === refreshSequenceRef.current) setIsRefreshing(false);
    }
  }, [applyProjection, enabled, identity, messageLimit]);

  const connect = useCallback(async () => {
    if (!enabled) {
      setIsRefreshing(false);
      return null;
    }
    setIsRefreshing(true);
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
    if (!enabled) {
      setIsRefreshing(false);
      return;
    }
    let cancelled = false;
    void connect().then((next) => {
      if (cancelled || !next) return;
      applyProjection(next);
    });
    return () => { cancelled = true; };
  }, [applyProjection, connect, enabled]);

  useEffect(() => {
    const unsubscribeChange = onResourceChanged(
      "native-agent-session",
      ({ id }) => { if (enabled && id === environmentId) void refresh(); },
    );
    const unsubscribeResync = onResourceResync(() => { if (enabled) void refresh(); });
    return () => {
      unsubscribeChange();
      unsubscribeResync();
    };
  }, [enabled, environmentId, refresh]);

  useEffect(() => {
    if (enabled && isActive) void refresh();
  }, [enabled, isActive, refresh]);

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
  }, [identity, platform, refresh, sessionKey]);

  const stop = useCallback(async () => {
    const stoppedSessionId = projectionRef.current?.sessionId;
    const next = await stopNativeAgentSession<TMessage>(identity);
    applyProjection(next);
    if (stoppedSessionId) {
      useNativeAgentProjectionStore.getState().markTurnStopped(
        sessionKey,
        stoppedSessionId,
      );
    }
    return next;
  }, [applyProjection, identity, sessionKey]);

  const stopBackgroundTask = useCallback(async (taskId: string) => {
    const next = await stopNativeAgentBackgroundTask<TMessage>({
      ...identity,
      taskId,
    });
    applyProjection(next);
    return next;
  }, [applyProjection, identity]);

  const dismissSuggestedPrompt = useCallback(async () => {
    const next = await dismissNativeAgentSuggestedPrompt<TMessage>(identity);
    applyProjection(next);
    return next;
  }, [applyProjection, identity]);

  const updateControls = useCallback(async (update: NativeAgentControlUpdate) => {
    const next = await updateNativeAgentControls<TMessage>({ ...identity, update });
    applyProjection(next);
    return next;
  }, [applyProjection, identity]);

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
    setIsDispatching(true);
    try {
      const outcome = await retryNativeAgentDispatch(identity);
      if (outcome.outcome !== "unknown") pendingDispatchRef.current = null;
      await refresh();
      return outcome;
    } finally {
      setIsDispatching(false);
    }
  }, [identity, refresh]);
  const listResumable = useCallback(
    () => listNativeAgentResumableSessions(identity),
    [identity],
  );
  const resume = useCallback(async (
    providerSessionId: string,
    controls?: NativeAgentControlUpdate,
  ) => {
    const next = await resumeNativeAgentSession<TMessage>({
      ...identity,
      providerSessionId,
      controls,
    });
    applyProjection(next);
    return next;
  }, [applyProjection, identity]);
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
    const next = await refreshNativeAgentModels<TMessage>(identity);
    applyProjection(next);
    return next;
  }, [applyProjection, identity]);
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
    const projection = await getNativeAgentProjection<TMessage>({
      ...identity,
      messageLimit: next,
    });
    applyProjection(projection);
    return projection;
  }, [applyProjection, identity, messageLimit]);

  return {
    sessionKey,
    projection: runtimeProjection,
    runtimeProjection,
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
