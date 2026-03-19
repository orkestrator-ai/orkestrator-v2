import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, History, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useScrollLock } from "@/hooks";
import { useClaudeActivityStore } from "@/stores/claudeActivityStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useCodexStore, createCodexSessionKey, useConfigStore } from "@/stores";
import {
  type CodexConversationMode,
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
  startCodexServer,
  startLocalCodexServer,
  updateGlobalConfig,
} from "@/lib/tauri";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { CodexComposeBar } from "./CodexComposeBar";
import { CodexResumeSessionDialog } from "./CodexResumeSessionDialog";
import { hasPendingInitialPrompt } from "./reconcile-guards";
import { createCodexSessionRefreshController } from "./session-refresh";
import {
  getPersistedCodexPreferences,
  persistCodexGlobalPreferences,
  resolveCodexPreferenceSelection,
  resolveReasoningEffort,
} from "./codex-preferences";
import type { CodexNativeData } from "@/types/paneLayout";
import type { CodexAttachment } from "@/stores/codexStore";

interface CodexChatTabProps {
  tabId: string;
  data: CodexNativeData;
  isActive: boolean;
  initialPrompt?: string;
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
}: CodexChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [initialPromptSent, setInitialPromptSent] = useState(false);
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
    setMessages,
    setSessionLoading,
    setSessionError,
    setSessionTitle,
    setSelectedModel,
    setSelectedMode,
    setSelectedReasoningEffort,
    addToQueue,
    removeFromQueue,
    clients: clientsMap,
    sessions: sessionsMap,
    selectedModel: selectedModelMap,
    selectedMode: selectedModeMap,
    selectedReasoningEffort: selectedReasoningEffortMap,
    slashCommands: slashCommandsMap,
  } = useCodexStore();

  const { incrementContainerRef, decrementContainerRef, setContainerState } =
    useClaudeActivityStore();
  const { clearTabInitialPrompt } = usePaneLayoutStore();

  const client = useMemo(
    () => clientsMap.get(environmentId),
    [clientsMap, environmentId],
  );
  const session = useMemo(
    () => sessionsMap.get(sessionKey),
    [sessionsMap, sessionKey],
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
  const handleSendRef = useRef<CodexSendHandler | null>(null);

  const { isAtBottom, scrollToBottom } = useScrollLock(scrollRef, {
    scrollTrigger: sessionMessages,
    mountTrigger: connectionState,
    isActive,
    persistKey: sessionKey,
  });

  useEffect(() => {
    incrementContainerRef(environmentId);
    return () => {
      decrementContainerRef(environmentId);
    };
  }, [decrementContainerRef, environmentId, incrementContainerRef]);

  useEffect(() => {
    setContainerState(
      environmentId,
      connectionState === "connected" && session?.isLoading ? "working" : "idle",
    );
  }, [connectionState, environmentId, session?.isLoading, setContainerState]);

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
        setSessionLoading(sessionKey, false);
        setSessionError(sessionKey, "Failed to send prompt");
        return;
      }
      await refreshMessages(client, session.sessionId);
    },
    [
      client,
      refreshMessages,
      session?.sessionId,
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
        id: crypto.randomUUID(),
        text,
        attachments,
        model: selectedModel,
        mode: selectedMode,
        reasoningEffort: selectedReasoningEffort,
      });
    },
    [addToQueue, selectedMode, selectedModel, selectedReasoningEffort, sessionKey],
  );

  const processQueue = useCallback(() => {
    if (isProcessingQueueRef.current) return;
    if (connectionState !== "connected" || !client) return;

    const latestSession = useCodexStore.getState().sessions.get(sessionKey);
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
    setSessionError,
    setSessionLoading,
  ]);

  const handleStop = useCallback(async () => {
    if (!client || !session?.sessionId) return;
    await abortSession(client, session.sessionId);
  }, [client, session?.sessionId]);

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
      setResumeDialogOpen(false);
    },
    [
      client,
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      sessionKey,
      setSession,
    ],
  );

  useEffect(() => {
    persistedPreferencesRef.current = getPersistedCodexPreferences(config);
  }, [config]);

  useEffect(() => {
    if (!isActive) return;
    const now = Date.now();
    if (now - lastInitTimeRef.current < 1000 && isInitializedRef.current) return;
    lastInitTimeRef.current = now;

    let mounted = true;

    async function initialize() {
      try {
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
        if (existingSession?.sessionId) {
          const messages = await getSessionMessages(nextClient, existingSession.sessionId);
          if (!mounted) return;
          setMessages(sessionKey, messages);
        } else {
          const created = await createSession(nextClient, {
            model: resolvedModel,
            modelReasoningEffort: resolvedReasoningEffort,
            mode: resolvedMode,
          });
          if (!created) {
            throw new Error("Failed to create Codex session");
          }
          setSession(sessionKey, {
            sessionId: created.sessionId,
            messages: [],
            isLoading: false,
            title: created.title,
          });
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
            setServerLog("Local Codex bridge failed to start");
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
    isActive,
    isLocal,
    initAttempt,
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
  ]);

  const syncSessionConfig = useCallback(
    async (
      model: string,
      nextReasoningEffort: CodexReasoningEffort,
      mode: CodexConversationMode,
    ): Promise<boolean> => {
      if (!client || !session?.sessionId) {
        return true;
      }

      if (sessionMessages.length > 0 || session.isLoading) {
        return false;
      }

      const updated = await updateCodexSessionConfig(client, session.sessionId, {
        model,
        modelReasoningEffort: nextReasoningEffort,
        mode,
      });

      if (!updated) {
        setSessionError(sessionKey, "Failed to update Codex session settings");
      }

      return updated;
    },
    [client, session?.isLoading, session?.sessionId, sessionKey, sessionMessages.length, setSessionError],
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
      const updated = await syncSessionConfig(model, nextReasoningEffort, selectedMode);
      if (!updated && sessionMessages.length === 0 && !session?.isLoading) {
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
      models,
      persistCodexPreferences,
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      session?.isLoading,
      sessionKey,
      sessionMessages.length,
      setSelectedModel,
      setSelectedReasoningEffort,
      syncSessionConfig,
    ],
  );

  const handleModeChange = useCallback(
    async (mode: CodexConversationMode) => {
      const previousMode = selectedMode;
      setSelectedMode(sessionKey, mode);
      const updated = await syncSessionConfig(
        selectedModel,
        selectedReasoningEffort,
        mode,
      );
      if (!updated && sessionMessages.length === 0 && !session?.isLoading) {
        setSelectedMode(sessionKey, previousMode);
      }
    },
    [
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      session?.isLoading,
      sessionKey,
      sessionMessages.length,
      setSelectedMode,
      syncSessionConfig,
    ],
  );

  const handleReasoningEffortChange = useCallback(
    async (effort: CodexReasoningEffort) => {
      const previousReasoningEffort = selectedReasoningEffort;
      setSelectedReasoningEffort(sessionKey, effort);
      const updated = await syncSessionConfig(selectedModel, effort, selectedMode);
      if (!updated && sessionMessages.length === 0 && !session?.isLoading) {
        setSelectedReasoningEffort(sessionKey, previousReasoningEffort);
        void persistCodexPreferences(selectedModel, previousReasoningEffort);
        return;
      }

      void persistCodexPreferences(selectedModel, effort);
    },
    [
      persistCodexPreferences,
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      session?.isLoading,
      sessionKey,
      sessionMessages.length,
      setSelectedReasoningEffort,
      syncSessionConfig,
    ],
  );

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
      !isActive
      || connectionState !== "connected"
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
    isActive,
    reconcileSessionState,
    session?.sessionId,
  ]);

  useEffect(() => {
    if (
      !isActive
      || !session?.isLoading
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
              await refreshMessages(client, session.sessionId);
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
    isActive,
    refreshMessages,
    reconcileSessionState,
    session?.isLoading,
    session?.sessionId,
    sessionKey,
    setSessionError,
    setSessionLoading,
    setSessionTitle,
  ]);

  useEffect(() => {
    if (
      !isActive
      || !session?.isLoading
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
    isActive,
    reconcileSessionState,
    session?.isLoading,
    session?.sessionId,
    sessionKey,
  ]);

  useEffect(() => {
    if (queueLength > 0) {
      processQueue();
    }
  }, [processQueue, queueLength, session?.isLoading]);

  useEffect(() => {
    if (
      connectionState !== "connected"
      || !session?.sessionId
      || !initialPrompt
      || initialPromptSent
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
    session?.sessionId,
    tabId,
  ]);

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
    <div className="flex h-full min-h-0 flex-col bg-background">
      <ScrollArea ref={scrollRef} className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5">
          {sessionMessages.length === 0 ? (
            <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/70 bg-muted/15 px-5 py-8 text-center text-sm text-muted-foreground">
              <p>Codex is ready.</p>
              {client ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setResumeDialogOpen(true)}
                >
                  <History className="mr-2 h-4 w-4" />
                  Resume Session
                </Button>
              ) : null}
            </div>
          ) : (
            sessionMessages.map((message, index) => (
              <NativeMessage
                key={message.id}
                message={message}
                previousMessage={index > 0 ? sessionMessages[index - 1] ?? null : null}
                assistantLabel="Codex"
              />
            ))
          )}

          {session?.isLoading && (
            <div className="px-4 py-3">
              <div className="mx-auto max-w-3xl">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-xs">Codex is thinking...</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {!isAtBottom && sessionMessages.length > 0 ? (
        <div className="pointer-events-none absolute bottom-24 right-6">
          <Button
            size="icon"
            variant="secondary"
            className="pointer-events-auto rounded-full shadow-sm"
            onClick={() => scrollToBottom()}
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <CodexComposeBar
        environmentId={environmentId}
        containerId={containerId}
        sessionKey={sessionKey}
        models={models}
        selectedMode={selectedMode}
        selectedModel={selectedModel}
        selectedReasoningEffort={selectedReasoningEffort}
        slashCommands={slashCommands}
        settingsLocked={(sessionMessages.length > 0) || (session?.isLoading ?? false)}
        disabled={!session?.sessionId}
        isLoading={session?.isLoading ?? false}
        queueLength={queueLength}
        onSend={handleSend}
        onQueue={handleQueue}
        onStop={handleStop}
        onModeChange={handleModeChange}
        onModelChange={handleModelChange}
        onReasoningEffortChange={handleReasoningEffortChange}
      />

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
