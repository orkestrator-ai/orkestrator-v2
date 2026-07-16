import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, History, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { useElapsedTimer, useVirtuosoScrollState } from "@/hooks";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useCodexStore, createCodexSessionKey, useConfigStore } from "@/stores";
import {
  OPTIMISTIC_MESSAGE_PREFIX,
  createOptimisticNativeMessage,
} from "@/lib/chat/client-only-messages";
import { formatElapsed } from "@/lib/format-elapsed";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import {
  type CodexConversationMode,
  type CodexMessage,
  type CodexPromptAttachment,
  type CodexReasoningEffort,
  DEFAULT_CODEX_MODEL,
  abortSession,
  checkHealth,
  createClient,
  createSession,
  getModels,
  getSlashCommands,
  getSessionMessages,
  getSessionStatus,
  resumeSession,
  sendPrompt,
  subscribeToEvents,
  updateSessionConfig as updateCodexSessionConfig,
} from "@/lib/codex-client";
import {
  getCodexServerLog,
  getCodexServerStatus,
  getLocalCodexServerStatus,
  renameEnvironmentFromPrompt,
  startCodexServer,
  startLocalCodexServer,
  updateGlobalConfig,
} from "@/lib/backend";
import { SYSTEM_MESSAGE_PREFIX } from "@/lib/opencode-client";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { normalizeCodexNativeMessage } from "@/lib/chat/native-message-adapters";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import { CodexComposeBar } from "./CodexComposeBar";
import { CodexPlanModeCard } from "./CodexPlanModeCard";
import { CodexResumeSessionDialog } from "./CodexResumeSessionDialog";
import { hasPendingInitialPrompt } from "./reconcile-guards";
import { createCodexSessionRefreshController } from "./session-refresh";
import {
  getPersistedCodexPreferences,
  persistCodexGlobalPreferences,
  resolveCodexPreferenceSelection,
  resolveReasoningEffort,
} from "./codex-preferences";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { isSetupPending } from "@/lib/setup-commands";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import { cn } from "@/lib/utils";
import type { CodexNativeData } from "@/types/paneLayout";
import type { CodexAttachment } from "@/stores/codexStore";

interface CodexChatTabProps {
  tabId: string;
  data: CodexNativeData;
  isActive: boolean;
  initialPrompt?: string;
  isReviewTab?: boolean;
}

type ConnectionState = "connecting" | "connected" | "error";

const DEFAULT_CODEX_MODE: CodexConversationMode = "build";
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "medium";
type CodexSendHandler = (
  text: string,
  attachments: CodexAttachment[],
) => Promise<void>;

export function CodexChatTab({
  tabId,
  data,
  isActive,
  initialPrompt,
  isReviewTab = false,
}: CodexChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  // Initialize as "connected" if we already have a client and session from a previous init.
  // This avoids even a single frame of spinner when switching back to an already-connected env.
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => {
    const hasClient = useCodexStore.getState().clients.has(environmentId);
    const hasSession = useCodexStore.getState().sessions.has(createCodexSessionKey(environmentId, tabId));
    return hasClient && hasSession ? "connected" : "connecting";
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [initialPromptSent, setInitialPromptSent] = useState(false);
  const [dismissedPlanReviewMessageId, setDismissedPlanReviewMessageId] = useState<string | null>(null);
  const [isPlanTransitionPending, setIsPlanTransitionPending] = useState(false);
  const lastInitTimeRef = useRef(0);
  const isInitializedRef = useRef(false);
  const isProcessingQueueRef = useRef(false);
  const isWatchdogRefreshInFlightRef = useRef(false);
  const refreshControllerRef = useRef(createCodexSessionRefreshController());
  const sessionKey = useMemo(
    () => createCodexSessionKey(environmentId, tabId),
    [environmentId, tabId],
  );
  const config = useConfigStore((state) => state.config);
  const setConfig = useConfigStore((state) => state.setConfig);
  const persistedPreferencesRef = useRef(getPersistedCodexPreferences(config));

  const {
    models,
    setModels,
    setSlashCommands,
    setServerStatus,
    setClient,
    setSession,
    addMessage,
    removeMessage,
    setMessages,
    upsertMessage,
    setSessionLoading,
    setSessionError,
    setSessionTitle,
    setSelectedModel,
    setSelectedMode,
    setSelectedReasoningEffort,
    setFastMode,
    addToQueue,
    removeFromQueue,
    clients: clientsMap,
    sessions: sessionsMap,
    selectedModel: selectedModelMap,
    selectedMode: selectedModeMap,
    selectedReasoningEffort: selectedReasoningEffortMap,
    slashCommands: slashCommandsMap,
  } = useCodexStore();

  const { clearTabInitialPrompt, updateTabNativeSessionId } = usePaneLayoutStore();

  const client = useMemo(
    () => clientsMap.get(environmentId),
    [clientsMap, environmentId],
  );
  // Setup completion awareness - block initialization until setup scripts finish
  const setupScriptsRunning = useEnvironmentStore(
    (state) => state.setupScriptsRunning.has(environmentId)
  );
  const setupCommandsResolved = useEnvironmentStore(
    (state) => state.setupCommandsResolved.has(environmentId)
  );
  const hasPendingSetupCommands = useEnvironmentStore(
    (state) => state.pendingSetupCommands.has(environmentId)
  );
  const workspaceReady = useEnvironmentStore(
    (state) => state.workspaceReadyEnvironments.has(environmentId)
  );
  const setupPending = isSetupPending({
    isLocal: !!isLocal,
    setupCommandsResolved,
    hasPendingSetupCommands,
    setupScriptsRunning,
    workspaceReady,
  });

  const session = useMemo(
    () => sessionsMap.get(sessionKey),
    [sessionsMap, sessionKey],
  );
  const showAddressAll = Boolean(
    isReviewTab &&
      session &&
      !session.isLoading &&
      session.messages.length > 0,
  );
  const selectedModel = useMemo(
    () => selectedModelMap.get(sessionKey) ?? DEFAULT_CODEX_MODEL,
    [selectedModelMap, sessionKey],
  );
  const selectedMode = useMemo(
    () => selectedModeMap.get(sessionKey) ?? DEFAULT_CODEX_MODE,
    [selectedModeMap, sessionKey],
  );
  const selectedReasoningEffort = useMemo(
    () => selectedReasoningEffortMap.get(sessionKey) ?? DEFAULT_REASONING_EFFORT,
    [selectedReasoningEffortMap, sessionKey],
  );
  const fastModeEnabled = useCodexStore(
    useCallback((state) => state.fastMode.get(sessionKey) ?? false, [sessionKey]),
  );
  const seedInitialFastMode = useCallback((codexState = useCodexStore.getState()) => {
    const existing = codexState.fastMode.get(sessionKey);
    if (existing !== undefined) {
      return existing;
    }

    const enabled = useConfigStore.getState().config.global.codexNativeFastModeDefault ?? false;
    codexState.setFastMode(sessionKey, enabled);
    return enabled;
  }, [sessionKey]);
  const persistCodexPreferences = useCallback(
    async (model: string, effort: CodexReasoningEffort) => {
      try {
        await persistCodexGlobalPreferences({
          config,
          setConfig,
          persistGlobalConfig: updateGlobalConfig,
          model,
          effort,
        });
      } catch (error) {
        console.error("[CodexChatTab] Failed to persist Codex defaults:", error);
      }
    },
    [config, setConfig],
  );
  const sessionMessages = useMemo(
    () => session?.messages ?? [],
    [session?.messages],
  );
  const displayMessages = useMemo(
    () => pinActiveNativeAgentParts(sessionMessages.map(normalizeCodexNativeMessage)),
    [sessionMessages],
  );
  const hasMessageHistory = sessionMessages.length > 0;
  const centerCompose = !hasMessageHistory && !(session?.isLoading ?? false);
  const latestAssistantMessage = useMemo(() => {
    for (let i = sessionMessages.length - 1; i >= 0; i--) {
      const msg = sessionMessages[i];
      if (msg?.role === "assistant") return msg;
    }
    return undefined;
  }, [sessionMessages]);
  const latestAssistantHasReviewContent = useMemo(() => {
    if (!latestAssistantMessage) return false;
    if (latestAssistantMessage.content.trim().length > 0) return true;
    return latestAssistantMessage.parts.some((part) => (
      part.type === "text" && part.content.trim().length > 0
    ));
  }, [latestAssistantMessage]);
  const slashCommands = useMemo(
    () => slashCommandsMap.get(environmentId) ?? [],
    [environmentId, slashCommandsMap],
  );
  const queueLength = useCodexStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey)?.length ?? 0,
      [sessionKey],
    ),
  );
  const isQueueBlockedByDraft = useCodexStore(
    useCallback(
      (state) =>
        (state.draftText.get(sessionKey)?.trim().length ?? 0) > 0 ||
        (state.attachments.get(sessionKey)?.length ?? 0) > 0,
      [sessionKey],
    ),
  );
  const handleSendRef = useRef<CodexSendHandler | null>(null);
  const { elapsedSeconds, finalElapsedSeconds } = useElapsedTimer(
    session?.isLoading,
    session?.sessionId,
    session?.loadingStartedAt,
    session?.lastCompletedElapsedSeconds,
  );

  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive,
    persistKey: sessionKey,
    environmentId,
    stickToBottomOnActivation: true,
  });

  // Activity state tracking is handled globally by useGlobalActivityMonitor
  // (in App.tsx), which derives state from this store's session data.

  const refreshMessages = useCallback(
    async (activeClient = client, sessionId = session?.sessionId) => {
      if (!activeClient || !sessionId) return;
      const requestId = refreshControllerRef.current.beginRequest();
      const messages = await getSessionMessages(activeClient, sessionId);
      if (!refreshControllerRef.current.shouldApplyRequest(requestId)) {
        return;
      }
      refreshControllerRef.current.markActivity();
      setMessages(sessionKey, messages);
    },
    [client, session?.sessionId, sessionKey, setMessages],
  );

  useEffect(() => {
    refreshControllerRef.current = createCodexSessionRefreshController();
    refreshControllerRef.current.markActivity();
  }, [sessionKey, session?.sessionId]);

  const handleSend = useCallback(
    async (text: string, attachments: CodexAttachment[]) => {
      if (!client || !session?.sessionId) return;

      const userMessage = createOptimisticNativeMessage(
        `${OPTIMISTIC_MESSAGE_PREFIX}${createUuid()}`,
        text,
        attachments,
      );
      addMessage(sessionKey, userMessage);

      if (!session.messages.length) {
        const environment = useEnvironmentStore.getState().getEnvironmentById(environmentId);
        if (environment && isDefaultTimestampEnvironmentName(environment.name)) {
          const namingMessageId = `${SYSTEM_MESSAGE_PREFIX}naming-${createUuid()}`;
          addMessage(sessionKey, {
            id: namingMessageId,
            role: "assistant" as const,
            content: "Naming environment...",
            parts: [{ type: "text" as const, content: "Naming environment..." }],
            createdAt: new Date().toISOString(),
          });
          try {
            await renameEnvironmentFromPrompt(environmentId, text);
          } catch (error) {
            console.warn("[CodexChatTab] Failed to rename environment from prompt:", error);
          }
          removeMessage(sessionKey, namingMessageId);
        }
      }

      setSessionError(sessionKey, undefined);
      setSessionLoading(sessionKey, true);
      const promptAttachments: CodexPromptAttachment[] = attachments.map((attachment) => ({
        type: "image",
        path: attachment.path,
        dataUrl: attachment.previewUrl,
        filename: attachment.name,
      }));
      const sent = await sendPrompt(client, session.sessionId, text, {
        attachments: promptAttachments.length > 0 ? promptAttachments : undefined,
      });
      if (!sent) {
        removeMessage(sessionKey, userMessage.id);
        setSessionLoading(sessionKey, false);
        setSessionError(sessionKey, "Failed to send prompt");
        return;
      }
      await refreshMessages(client, session.sessionId);
    },
    [
      client,
      addMessage,
      environmentId,
      refreshMessages,
      removeMessage,
      session?.sessionId,
      session?.messages.length,
      sessionKey,
      setSessionError,
      setSessionLoading,
    ],
  );

  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const handleQueue = useCallback(
    (text: string, attachments: CodexAttachment[]) => {
      addToQueue(sessionKey, {
        id: createUuid(),
        text,
        attachments,
        model: selectedModel,
        mode: selectedMode,
        reasoningEffort: selectedReasoningEffort,
        fastMode: fastModeEnabled,
      });
    },
    [addToQueue, fastModeEnabled, selectedMode, selectedModel, selectedReasoningEffort, sessionKey],
  );

  const processQueue = useCallback(() => {
    if (isProcessingQueueRef.current) return;
    if (setupPending) return;
    if (connectionState !== "connected" || !client) return;

    const codexState = useCodexStore.getState();
    if (
      (codexState.draftText.get(sessionKey)?.trim().length ?? 0) > 0 ||
      (codexState.attachments.get(sessionKey)?.length ?? 0) > 0
    ) {
      return;
    }

    const latestSession = codexState.sessions.get(sessionKey);
    if (!latestSession || latestSession.isLoading) return;

    const nextMessage = removeFromQueue(sessionKey);
    if (!nextMessage) return;

    isProcessingQueueRef.current = true;

    const sendPromise = handleSendRef.current?.(nextMessage.text, nextMessage.attachments);

    if (!sendPromise) {
      isProcessingQueueRef.current = false;
      return;
    }

    sendPromise
      .catch((error) => {
        console.error("[CodexChatTab] Failed to send queued prompt:", error);
        setSessionLoading(sessionKey, false);
        setSessionError(
          sessionKey,
          `Failed to send queued prompt: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      })
      .finally(() => {
        isProcessingQueueRef.current = false;
        // Don't recurse here — the useEffect watching isLoading/queueLength
        // will call processQueue again when the session becomes idle.
      });
  }, [
    client,
    connectionState,
    removeFromQueue,
    sessionKey,
    setupPending,
    setSessionError,
    setSessionLoading,
  ]);

  const promoteNextQueuedPromptToDraft = useCallback(() => {
    const store = useCodexStore.getState();
    const hasCurrentDraft =
      store.getDraftText(sessionKey).trim().length > 0 ||
      store.getAttachments(sessionKey).length > 0;
    if (hasCurrentDraft) return;

    const nextMessage = store.removeFromQueue(sessionKey);
    if (!nextMessage) return;

    store.setDraftText(sessionKey, nextMessage.text);
    store.setDraftMentions(sessionKey, []);
    store.clearAttachments(sessionKey);
    for (const attachment of nextMessage.attachments) {
      store.addAttachment(sessionKey, attachment);
    }
    store.setSelectedModel(sessionKey, nextMessage.model);
    store.setSelectedMode(sessionKey, nextMessage.mode);
    store.setSelectedReasoningEffort(sessionKey, nextMessage.reasoningEffort);
    store.setFastMode(sessionKey, nextMessage.fastMode);
  }, [sessionKey]);

  const handleStop = useCallback(async () => {
    if (!client || !session?.sessionId) return;

    promoteNextQueuedPromptToDraft();
    setSessionLoading(sessionKey, false);
    setSessionError(sessionKey, undefined);

    const success = await abortSession(client, session.sessionId);
    if (!success) {
      console.error("[CodexChatTab] Failed to abort session");
    }
  }, [
    client,
    promoteNextQueuedPromptToDraft,
    session?.sessionId,
    sessionKey,
    setSessionError,
    setSessionLoading,
  ]);

  useEffect(() => {
    if (!isActive || !session?.isLoading) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.defaultPrevented
        || event.repeat
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.isComposing
      ) {
        return;
      }

      event.preventDefault();
      void handleStop();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleStop, isActive, session?.isLoading]);

  const handleResumeSession = useCallback(
    async (threadId: string) => {
      if (!client) return;

      const resumed = await resumeSession(client, {
        threadId,
        model: selectedModel,
        modelReasoningEffort: selectedReasoningEffort,
        mode: selectedMode,
        fastMode: fastModeEnabled,
      });

      if (!resumed) {
        console.error("[CodexChatTab] Failed to resume session");
        return;
      }

      setSession(sessionKey, {
        sessionId: resumed.session.sessionId,
        messages: resumed.messages,
        isLoading: false,
        title: resumed.session.title,
      });
      updateTabNativeSessionId(tabId, resumed.session.sessionId, environmentId);
      setResumeDialogOpen(false);
    },
    [
      client,
      fastModeEnabled,
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      sessionKey,
      setSession,
      tabId,
      updateTabNativeSessionId,
      environmentId,
    ],
  );

  useEffect(() => {
    persistedPreferencesRef.current = getPersistedCodexPreferences(config);
  }, [config]);

  useEffect(() => {
    if (!isActive && !initialPrompt?.trim() && queueLength === 0) return;

    // Block initialization until setup scripts finish (local environments with orkestrator-ai.json)
    if (setupPending) {
      return;
    }

    const now = Date.now();
    if (now - lastInitTimeRef.current < 1000 && isInitializedRef.current) return;
    lastInitTimeRef.current = now;

    let mounted = true;

    async function initialize() {
      try {
        // Fast path: if we already have a client and session from a previous init,
        // skip all expensive steps (server status, health check, model fetch, etc.)
        // and reconnect instantly. This makes environment switching near-instant.
        const cachedClient = useCodexStore.getState().clients.get(environmentId);
        const cachedSession = useCodexStore.getState().sessions.get(sessionKey);
        if (cachedClient && cachedSession?.sessionId) {
          console.debug("[CodexChatTab] Fast reconnect - reusing existing client and session", {
            tabId,
            environmentId,
            sessionId: cachedSession.sessionId,
          });
          updateTabNativeSessionId(tabId, cachedSession.sessionId, environmentId);
          isInitializedRef.current = true;
          lastInitTimeRef.current = Date.now();
          setConnectionState("connected");
          setErrorMessage(null);

          // Non-blocking background health check
          checkHealth(cachedClient).then((healthy) => {
            if (!mounted || healthy) return;
            console.warn("[CodexChatTab] Background health check failed, re-initializing");
            setClient(environmentId, null);
            setConnectionState("error");
            setErrorMessage("Codex bridge server disconnected. Click retry to reconnect.");
          }).catch(() => {
            if (!mounted) return;
            setClient(environmentId, null);
            setConnectionState("error");
            setErrorMessage("Codex bridge server disconnected. Click retry to reconnect.");
          });
          return;
        }

        // Warm path: client exists for this environment (another tab already initialized)
        // but no session for this specific tab. Skip server status/health/models and
        // jump straight to session creation using the existing client.
        if (cachedClient) {
          console.debug("[CodexChatTab] Warm path - reusing existing client, creating new session", {
            tabId,
            environmentId,
          });
          lastInitTimeRef.current = Date.now();
          setConnectionState("connecting");
          setErrorMessage(null);

          const codexState = useCodexStore.getState();
          const storedMode = codexState.selectedMode.get(sessionKey);
          const resolvedMode = storedMode ?? DEFAULT_CODEX_MODE;
          const resolvedSelection = resolveCodexPreferenceSelection({
            models: codexState.models.length > 0 ? codexState.models : models,
            storedModel: codexState.selectedModel.get(sessionKey),
            storedReasoningEffort: codexState.selectedReasoningEffort.get(sessionKey),
            persistedModel: persistedPreferencesRef.current.model,
            persistedReasoningEffort: persistedPreferencesRef.current.reasoningEffort,
          });

          const warmFastMode = seedInitialFastMode(codexState);
          if (data.sessionId) {
            const restoredStatus = await getSessionStatus(cachedClient, data.sessionId);
            if (restoredStatus) {
              const restoredMessages = await getSessionMessages(cachedClient, data.sessionId);
              if (!mounted) return;
              setSession(sessionKey, {
                sessionId: data.sessionId,
                messages: restoredMessages,
                isLoading: restoredStatus.status === "running",
                title: restoredStatus.title,
                error: restoredStatus.status === "error" ? restoredStatus.error : undefined,
              });
              updateTabNativeSessionId(tabId, data.sessionId, environmentId);
              setSelectedModel(sessionKey, resolvedSelection.model);
              setSelectedMode(sessionKey, resolvedMode);
              setSelectedReasoningEffort(sessionKey, resolvedSelection.reasoningEffort);
              isInitializedRef.current = true;
              setConnectionState("connected");
              return;
            }
            updateTabNativeSessionId(tabId, undefined, environmentId);
          }

          const created = await createSession(cachedClient, {
            model: resolvedSelection.model,
            modelReasoningEffort: resolvedSelection.reasoningEffort,
            mode: resolvedMode,
            fastMode: warmFastMode,
          });
          if (!mounted) return;

          isInitializedRef.current = true;
          setSession(sessionKey, {
            sessionId: created.sessionId,
            messages: [],
            isLoading: false,
            title: created.title,
          });
          updateTabNativeSessionId(tabId, created.sessionId, environmentId);
          setSelectedModel(sessionKey, resolvedSelection.model);
          setSelectedMode(sessionKey, resolvedMode);
          setSelectedReasoningEffort(sessionKey, resolvedSelection.reasoningEffort);
          setConnectionState("connected");
          return;
        }

        setConnectionState("connecting");
        setErrorMessage(null);

        let port: number | null = null;
        if (isLocal) {
          let status = await getLocalCodexServerStatus(environmentId);
          if (!status.running) {
            const result = await startLocalCodexServer(environmentId);
            status = { running: true, port: result.port, pid: result.pid };
          }
          if (!mounted) return;
          port = status.port;
        } else {
          if (!containerId) {
            throw new Error("Container ID is required for containerized Codex");
          }
          let status = await getCodexServerStatus(containerId);
          if (!status.running) {
            const result = await startCodexServer(containerId);
            status = { running: true, hostPort: result.hostPort };
          }
          if (!mounted) return;
          port = status.hostPort;
        }

        if (!port) {
          throw new Error("Failed to resolve Codex bridge port");
        }

        setServerStatus(environmentId, { running: true, hostPort: port });
        const nextClient = createClient(`http://127.0.0.1:${port}`);
        setClient(environmentId, nextClient);

        if (!(await checkHealth(nextClient))) {
          throw new Error("Codex bridge health check failed");
        }

        const { models: availableModels, source: modelsSource } = await getModels(nextClient);
        const availableSlashCommands = await getSlashCommands(nextClient);
        const codexState = useCodexStore.getState();
        if (
          modelsSource === "cache"
          || codexState.models.length === 0
          || availableModels.length > codexState.models.length
        ) {
          setModels(availableModels);
        }
        setSlashCommands(environmentId, availableSlashCommands);

        const storedSelectedModel = codexState.selectedModel.get(sessionKey);
        const storedMode = codexState.selectedMode.get(sessionKey);
        const resolvedMode = storedMode ?? DEFAULT_CODEX_MODE;
        const storedReasoningEffort = codexState.selectedReasoningEffort.get(sessionKey);
        const resolvedSelection = resolveCodexPreferenceSelection({
          models: availableModels,
          storedModel: storedSelectedModel,
          storedReasoningEffort,
          persistedModel: persistedPreferencesRef.current.model,
          persistedReasoningEffort: persistedPreferencesRef.current.reasoningEffort,
        });
        const resolvedModel = resolvedSelection.model;
        const resolvedReasoningEffort = resolvedSelection.reasoningEffort;

        const existingSession = useCodexStore.getState().sessions.get(sessionKey);
        const existingSessionId = existingSession?.sessionId || data.sessionId;
        const existingStatus = existingSessionId
          ? await getSessionStatus(nextClient, existingSessionId)
          : null;
        if (existingSessionId && existingStatus) {
          const messages = await getSessionMessages(nextClient, existingSessionId);
          if (!mounted) return;
          if (existingSession) {
            setMessages(sessionKey, messages);
          } else {
            setSession(sessionKey, {
              sessionId: existingSessionId,
              messages,
              isLoading: existingStatus.status === "running",
              title: existingStatus.title,
              error: existingStatus.status === "error" ? existingStatus.error : undefined,
            });
          }
          updateTabNativeSessionId(tabId, existingSessionId, environmentId);
        } else {
          if (existingSessionId) {
            updateTabNativeSessionId(tabId, undefined, environmentId);
          }
          const coldFastMode = seedInitialFastMode(codexState);
          const created = await createSession(nextClient, {
            model: resolvedModel,
            modelReasoningEffort: resolvedReasoningEffort,
            mode: resolvedMode,
            fastMode: coldFastMode,
          });
          setSession(sessionKey, {
            sessionId: created.sessionId,
            messages: [],
            isLoading: false,
            title: created.title,
          });
          updateTabNativeSessionId(tabId, created.sessionId, environmentId);
        }

        if (!mounted) return;
        isInitializedRef.current = true;
        if (storedSelectedModel !== resolvedModel) {
          setSelectedModel(sessionKey, resolvedModel);
        }
        if (storedMode !== resolvedMode) {
          setSelectedMode(sessionKey, resolvedMode);
        }
        if (storedReasoningEffort !== resolvedReasoningEffort) {
          setSelectedReasoningEffort(sessionKey, resolvedReasoningEffort);
        }
        setConnectionState("connected");
      } catch (error) {
        if (!mounted) return;
        isInitializedRef.current = false;
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Failed to initialize Codex";
        setConnectionState("error");
        setErrorMessage(message);
        try {
          if (isLocal) {
            const detail = error instanceof Error ? error.message : String(error);
            setServerLog(`Local Codex bridge error: ${detail}`);
          } else if (containerId) {
            setServerLog(await getCodexServerLog(containerId));
          }
        } catch (logError) {
          console.error("[CodexChatTab] Failed to fetch server log:", logError);
        }
      }
    }

    void initialize();

    return () => {
      mounted = false;
    };
  }, [
    containerId,
    environmentId,
    initialPrompt,
    isActive,
    isLocal,
    initAttempt,
    queueLength,
    sessionKey,
    setClient,
    setModels,
    setSlashCommands,
    setMessages,
    setSelectedMode,
    setSelectedReasoningEffort,
    setSelectedModel,
    setServerStatus,
    setSession,
    seedInitialFastMode,
    setupPending,
    tabId,
    updateTabNativeSessionId,
  ]);

  const syncSessionConfig = useCallback(
    async (
      model: string,
      nextReasoningEffort: CodexReasoningEffort,
      mode: CodexConversationMode,
      fastMode: boolean,
    ): Promise<boolean> => {
      if (!client || !session?.sessionId) {
        return true;
      }

      if (session.isLoading) {
        return false;
      }

      const updated = await updateCodexSessionConfig(client, session.sessionId, {
        model,
        modelReasoningEffort: nextReasoningEffort,
        mode,
        fastMode,
      });

      if (!updated) {
        setSessionError(sessionKey, "Failed to update Codex session settings");
      }

      return updated;
    },
    [client, session?.isLoading, session?.sessionId, sessionKey, setSessionError],
  );

  const applyModeChange = useCallback(
    async (mode: CodexConversationMode): Promise<boolean> => {
      const previousMode = selectedMode;
      setSelectedMode(sessionKey, mode);
      const updated = await syncSessionConfig(
        selectedModel,
        selectedReasoningEffort,
        mode,
        fastModeEnabled,
      );
      if (!updated && !session?.isLoading) {
        setSelectedMode(sessionKey, previousMode);
        return false;
      }
      return true;
    },
    [
      fastModeEnabled,
      selectedMode,
      selectedModel,
      selectedReasoningEffort,
      session?.isLoading,
      sessionKey,
      setSelectedMode,
      syncSessionConfig,
    ],
  );

  const handleModelChange = useCallback(
    async (model: string) => {
      const previousModel = selectedModel;
      setSelectedModel(sessionKey, model);
      const nextReasoningEffort = resolveReasoningEffort(
        model,
        models,
        selectedReasoningEffort,
      );
      if (nextReasoningEffort !== selectedReasoningEffort) {
        setSelectedReasoningEffort(sessionKey, nextReasoningEffort);
      }
      const updated = await syncSessionConfig(model, nextReasoningEffort, selectedMode, fastModeEnabled);
      if (!updated && !session?.isLoading) {
        setSelectedModel(sessionKey, previousModel);
        if (nextReasoningEffort !== selectedReasoningEffort) {
          setSelectedReasoningEffort(sessionKey, selectedReasoningEffort);
        }
        void persistCodexPreferences(previousModel, selectedReasoningEffort);
        return;
      }

      void persistCodexPreferences(model, nextReasoningEffort);
    },
    [
      fastModeEnabled,
      models,
      persistCodexPreferences,
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      session?.isLoading,
      sessionKey,
      setSelectedModel,
      setSelectedReasoningEffort,
      syncSessionConfig,
    ],
  );

  const handleModeChange = useCallback(
    async (mode: CodexConversationMode) => {
      const changed = await applyModeChange(mode);
      if (changed && mode === "build" && latestAssistantMessage?.planReview === true) {
        setDismissedPlanReviewMessageId(latestAssistantMessage.id);
      }
    },
    [applyModeChange, latestAssistantMessage?.id, latestAssistantMessage?.planReview],
  );

  const handleReasoningEffortChange = useCallback(
    async (effort: CodexReasoningEffort) => {
      const previousReasoningEffort = selectedReasoningEffort;
      setSelectedReasoningEffort(sessionKey, effort);
      const updated = await syncSessionConfig(selectedModel, effort, selectedMode, fastModeEnabled);
      if (!updated && !session?.isLoading) {
        setSelectedReasoningEffort(sessionKey, previousReasoningEffort);
        void persistCodexPreferences(selectedModel, previousReasoningEffort);
        return;
      }

      void persistCodexPreferences(selectedModel, effort);
    },
    [
      fastModeEnabled,
      persistCodexPreferences,
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      session?.isLoading,
      sessionKey,
      setSelectedReasoningEffort,
      syncSessionConfig,
    ],
  );

  const handleFastModeChange = useCallback(
    (enabled: boolean) => {
      const previous = fastModeEnabled;
      setFastMode(sessionKey, enabled);
      // Push the change to the bridge so the current thread uses the new service tier.
      void syncSessionConfig(selectedModel, selectedReasoningEffort, selectedMode, enabled).then(
        (updated) => {
          if (!updated && !session?.isLoading) {
            setFastMode(sessionKey, previous);
          }
        },
      );
    },
    [
      fastModeEnabled,
      selectedMode,
      selectedModel,
      selectedReasoningEffort,
      session?.isLoading,
      sessionKey,
      setFastMode,
      syncSessionConfig,
    ],
  );

  const handleSwitchPlanToBuild = useCallback(async (): Promise<void> => {
    setIsPlanTransitionPending(true);
    try {
      const changed = await applyModeChange("build");
      if (changed) {
        setDismissedPlanReviewMessageId(latestAssistantMessage?.id ?? null);
      }
    } finally {
      setIsPlanTransitionPending(false);
    }
  }, [applyModeChange, latestAssistantMessage?.id]);

  const handleApprovePlan = useCallback(async (): Promise<void> => {
    setIsPlanTransitionPending(true);
    try {
      const changed = await applyModeChange("build");
      if (!changed) {
        return;
      }

      setDismissedPlanReviewMessageId(latestAssistantMessage?.id ?? null);
      await handleSend(
        "The plan is approved. Exit plan mode and implement it.",
        [],
      );
    } finally {
      setIsPlanTransitionPending(false);
    }
  }, [applyModeChange, handleSend, latestAssistantMessage?.id]);

  const showPlanModeCard = selectedMode === "plan"
    && !session?.isLoading
    && !session?.error
    && !!latestAssistantMessage
    && latestAssistantMessage.planReview === true
    && latestAssistantHasReviewContent
    && latestAssistantMessage.id !== dismissedPlanReviewMessageId;

  const reconcileSessionState = useCallback(async (options?: { forceRefreshMessages?: boolean }) => {
    if (
      connectionState !== "connected"
      || !client
      || !session?.sessionId
    ) {
      return;
    }

    const status = await getSessionStatus(client, session.sessionId);
    if (!status) {
      return;
    }
    refreshControllerRef.current.markActivity();

    if (typeof status.title === "string" && status.title.trim().length > 0) {
      setSessionTitle(sessionKey, status.title);
    }

    if (status.status === "idle") {
      setSessionLoading(sessionKey, false);
      setSessionError(sessionKey, undefined);
      await refreshMessages(client, session.sessionId);
      return;
    }

    if (status.status === "error") {
      const error = status.error?.trim() || "Codex session failed";
      setSessionLoading(sessionKey, false);
      setSessionError(sessionKey, error);
      setErrorMessage(error);
      await refreshMessages(client, session.sessionId);
      return;
    }

    setSessionLoading(sessionKey, true);
    if (options?.forceRefreshMessages) {
      await refreshMessages(client, session.sessionId);
    }
  }, [
    client,
    connectionState,
    refreshMessages,
    session?.sessionId,
    sessionKey,
    setSessionError,
    setSessionLoading,
    setSessionTitle,
  ]);

  useEffect(() => {
    if (
      connectionState !== "connected"
      || !client
      || !session?.sessionId
      || hasPendingInitialPrompt(initialPrompt, initialPromptSent)
    ) {
      return;
    }

    void reconcileSessionState();
  }, [
    client,
    connectionState,
    initialPrompt,
    initialPromptSent,
    reconcileSessionState,
    session?.sessionId,
  ]);

  // SSE event subscription. Runs whenever a turn is in progress, including
  // when the tab is rendered as a hidden background mount (e.g. an off-screen
  // initial-prompt dispatch), so the response is processed before the
  // environment unmounts.
  useEffect(() => {
    if (
      !session?.isLoading
      || connectionState !== "connected"
      || !client
      || !session?.sessionId
    ) {
      return;
    }

    const abortController = new AbortController();
    const isTurnActive = () =>
      useCodexStore.getState().sessions.get(sessionKey)?.isLoading === true;

    (async () => {
      while (!abortController.signal.aborted && isTurnActive()) {
        try {
          for await (const event of subscribeToEvents(client, abortController.signal)) {
            if (!event || typeof event.type !== "string") {
              console.warn("[CodexChatTab] Received malformed event, skipping");
              continue;
            }

            if (event.sessionId && event.sessionId !== session.sessionId) {
              continue;
            }

            refreshControllerRef.current.markActivity();

            if (event.type === "message.updated") {
              const message = event.data?.message as CodexMessage | undefined;
              if (message?.id) {
                upsertMessage(sessionKey, message);
              } else {
                await refreshMessages(client, session.sessionId);
              }
              continue;
            }

            if (event.type === "session.updated") {
              setSessionLoading(sessionKey, true);
              continue;
            }

            if (event.type === "session.idle") {
              setSessionLoading(sessionKey, false);
              setSessionError(sessionKey, undefined);
              const title = event.data?.title;
              if (typeof title === "string" && title.trim().length > 0) {
                setSessionTitle(sessionKey, title);
              }
              await refreshMessages(client, session.sessionId);
              continue;
            }

            if (event.type === "session.title-updated") {
              const title = event.data?.title;
              if (typeof title === "string" && title.trim().length > 0) {
                setSessionTitle(sessionKey, title);
              }
              continue;
            }

            if (event.type === "session.error") {
              const error =
                typeof event.data?.error === "string"
                  ? event.data.error
                  : "Codex session failed";
              setSessionLoading(sessionKey, false);
              setSessionError(sessionKey, error);
              setErrorMessage(error);
            }
          }
        } catch (error) {
          if (!abortController.signal.aborted) {
            console.error("[CodexChatTab] Event subscription error:", error);
          }
        }

        if (abortController.signal.aborted) {
          break;
        }

        await reconcileSessionState();

        if (abortController.signal.aborted || !isTurnActive()) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [
    client,
    connectionState,
    refreshMessages,
    reconcileSessionState,
    session?.isLoading,
    session?.sessionId,
    sessionKey,
    setSessionError,
    setSessionLoading,
    setSessionTitle,
    upsertMessage,
  ]);

  // Watchdog poll for stalled turns. Mirrors the SSE gate above so it also
  // runs for hidden background mounts during a turn.
  useEffect(() => {
    if (
      !session?.isLoading
      || connectionState !== "connected"
      || !client
      || !session?.sessionId
    ) {
      return;
    }

    let cancelled = false;

    const pollSessionState = async () => {
      if (
        cancelled
        || isWatchdogRefreshInFlightRef.current
        || !refreshControllerRef.current.shouldRefresh()
      ) {
        return;
      }

      isWatchdogRefreshInFlightRef.current = true;
      try {
        await reconcileSessionState({ forceRefreshMessages: true });
      } finally {
        isWatchdogRefreshInFlightRef.current = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void pollSessionState();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    client,
    connectionState,
    reconcileSessionState,
    session?.isLoading,
    session?.sessionId,
    sessionKey,
  ]);

  useEffect(() => {
    if (queueLength > 0 && !isQueueBlockedByDraft && !setupPending) {
      processQueue();
    }
  }, [processQueue, queueLength, isQueueBlockedByDraft, setupPending, session?.isLoading]);

  useEffect(() => {
    if (
      connectionState !== "connected"
      || !session?.sessionId
      || !initialPrompt
      || initialPromptSent
      || setupPending
    ) {
      return;
    }

    setInitialPromptSent(true);
    void handleSend(initialPrompt, []).then(() => {
      clearTabInitialPrompt(tabId, environmentId);
    });
  }, [
    clearTabInitialPrompt,
    connectionState,
    environmentId,
    handleSend,
    initialPrompt,
    initialPromptSent,
    setupPending,
    session?.sessionId,
    tabId,
  ]);

  if (setupPending) {
    return (
      <SetupPendingOverlay
        environmentId={environmentId}
        subtext="Codex will connect automatically once setup finishes"
      />
    );
  }

  if (connectionState === "connecting") {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Connecting Codex
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div className="space-y-1">
          <div className="font-medium">Codex failed to start</div>
          <div className="text-sm text-muted-foreground">
            {errorMessage ?? "Unknown error"}
          </div>
          {serverLog ? (
            <pre className="mt-3 max-w-3xl overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
              {serverLog}
            </pre>
          ) : null}
        </div>
        <Button
          variant="outline"
          onClick={() => {
            isInitializedRef.current = false;
            lastInitTimeRef.current = 0;
            setConnectionState("connecting");
            setErrorMessage(null);
            setInitAttempt((value) => value + 1);
          }}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none",
          centerCompose && "pointer-events-none scale-[0.995] opacity-0",
        )}
      >
        {/* Virtualized messages area */}
        <VirtualizedMessageList
          messages={displayMessages}
          computeItemKey={(_index, msg) => msg.id}
          renderMessage={(_index, message, prev) => (
            <NativeMessage
              message={message}
              previousMessage={prev}
              assistantLabel="Codex"
            />
          )}
          footer={
            <>
              {session?.isLoading && (
                <div className="px-2 @sm:px-4 py-3">
                  <div className="mx-auto max-w-3xl min-w-0">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span className="text-xs">Codex is thinking...</span>
                      {elapsedSeconds !== null && elapsedSeconds > 0 && (
                        <span className="text-xs text-muted-foreground/50">
                          {formatElapsed(elapsedSeconds)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {!session?.isLoading && finalElapsedSeconds !== null && (
                <div className="px-2 @sm:px-4 py-1.5">
                  <div className="mx-auto max-w-3xl min-w-0">
                    <span className="text-[10px] text-muted-foreground/40">
                      Completed in {formatElapsed(finalElapsedSeconds)}
                    </span>
                  </div>
                </div>
              )}

              {/* h-32 ≈ compose bar; h-80 adds room for the plan card (~230px) above it */}
              <div className={showPlanModeCard ? "h-80" : "h-32"} aria-hidden="true" />
            </>
          }
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
        />

      </div>

      <NativeComposeDock
        centered={centerCompose}
        topAccessory={
          !isAtBottom || showPlanModeCard ? (
            <div className="flex w-full flex-col gap-2">
              {!isAtBottom ? (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="flex items-center gap-1.5 self-end rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
                  aria-label="Scroll to bottom of conversation"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  <span>Scroll down</span>
                </button>
              ) : null}

              {showPlanModeCard ? (
                <CodexPlanModeCard
                  className="mx-0 my-0"
                  isSubmitting={isPlanTransitionPending}
                  onApproveAndBuild={handleApprovePlan}
                  onSwitchToBuild={handleSwitchPlanToBuild}
                  onDismiss={() => setDismissedPlanReviewMessageId(latestAssistantMessage?.id ?? null)}
                />
              ) : null}
            </div>
          ) : null
        }
        actions={
          client ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setResumeDialogOpen(true)}
              className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
              aria-hidden={!centerCompose}
              tabIndex={centerCompose ? 0 : -1}
            >
              <History className="mr-2 h-4 w-4" />
              Resume Session
            </Button>
          ) : null
        }
      >
        <CodexComposeBar
          environmentId={environmentId}
          containerId={containerId}
          sessionKey={sessionKey}
          models={models}
          selectedMode={selectedMode}
          selectedModel={selectedModel}
          selectedReasoningEffort={selectedReasoningEffort}
          slashCommands={slashCommands}
          settingsLocked={session?.isLoading ?? false}
          disabled={!session?.sessionId}
          isLoading={session?.isLoading ?? false}
          queueLength={queueLength}
          onSend={handleSend}
          onQueue={handleQueue}
          onStop={handleStop}
          onModeChange={handleModeChange}
          onModelChange={handleModelChange}
          onReasoningEffortChange={handleReasoningEffortChange}
          fastModeEnabled={fastModeEnabled}
          onFastModeChange={handleFastModeChange}
          showAddressAll={showAddressAll}
          layout={centerCompose ? "centered" : "bottom"}
        />
      </NativeComposeDock>

      {client ? (
        <CodexResumeSessionDialog
          open={resumeDialogOpen}
          onOpenChange={setResumeDialogOpen}
          client={client}
          onResume={handleResumeSession}
          currentSessionId={session?.sessionId}
        />
      ) : null}
    </div>
  );
}
