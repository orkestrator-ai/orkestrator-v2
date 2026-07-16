import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { Loader2, AlertCircle, RefreshCw, ArrowDown, History } from "lucide-react";
import { useVirtuosoScrollState, clearPersistedVirtuosoState, useElapsedTimer } from "@/hooks";
import { formatElapsed } from "@/lib/format-elapsed";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import { useClaudeStore, createClaudeSessionKey } from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  createClient,
  getModels,
  createSession,
  getSession,
  getSessionMessages,
  sendPrompt,
  abortSession,
  subscribeToEvents,
  checkHealth,
  getSlashCommands,
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  SessionNotFoundError,
  type ClaudeMessage as ClaudeMessageType,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type PlanApprovalRequestedEventData,
  type PlanApprovalRespondedEventData,
  type SystemMessageEventData,
} from "@/lib/claude-client";
import { extractContextUsage } from "@/lib/context-usage";
import {
  startClaudeServer,
  getClaudeServerStatus,
  getClaudeServerLog,
  startLocalClaudeServer,
  getLocalClaudeServerStatus,
  renameEnvironmentFromPrompt,
} from "@/lib/backend";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { ClaudeComposeBar } from "./ClaudeComposeBar";
import { ClaudeQuestionCard } from "./ClaudeQuestionCard";
import { ClaudePlanApprovalCard } from "./ClaudePlanApprovalCard";
import { ResumeSessionDialog } from "./ResumeSessionDialog";
import type { ClaudeNativeData } from "@/types/paneLayout";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { isSetupPending } from "@/lib/setup-commands";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import type { ClaudeAttachment } from "@/stores/claudeStore";
import { normalizeClaudeMessage } from "@/lib/chat/native-message-adapters";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";

interface ClaudeChatTabProps {
  tabId: string;
  data: ClaudeNativeData;
  isActive: boolean;
  initialPrompt?: string;
  isReviewTab?: boolean;
}

type ConnectionState = "connecting" | "connected" | "error";

function resolvePreferredClaudeModel(models: Array<{ id: string }>): string | undefined {
  const preferred = useConfigStore.getState().config.global.claudeModel;
  return models.some((model) => model.id === preferred)
    ? preferred
    : models[0]?.id;
}

export function ClaudeChatTab({
  tabId,
  data,
  isActive,
  initialPrompt,
  isReviewTab = false,
}: ClaudeChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  // Initialize as "connected" if we already have a client and session from a previous init.
  // This avoids even a single frame of spinner when switching back to an already-connected env.
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => {
    const hasClient = useClaudeStore.getState().clients.has(environmentId);
    const hasSession = useClaudeStore.getState().sessions.has(createClaudeSessionKey(environmentId, tabId));
    return hasClient && hasSession ? "connected" : "connecting";
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);

  const tabSessionIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const initialPromptSentRef = useRef(false);
  const isProcessingQueueRef = useRef(false);
  const slashCmdCleanupRef = useRef<(() => void) | null>(null);
  const handleSendRef = useRef<((text: string, attachments: ClaudeAttachment[], effort: import("@/lib/claude-client").ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => Promise<void>) | null>(null);

  const {
    setClient,
    models,
    setModels,
    setSession,
    addMessage,
    removeMessage,
    setMessages,
    upsertMessage,
    setSessionLoading,
    setServerStatus,
    getSelectedModel,
    setSelectedModel,
    addPendingQuestion,
    removePendingQuestion,
    setSessionTitle,
    setContextUsage,
    addPendingPlanApproval,
    removePendingPlanApproval,
    getOrCreateEventSubscription,
    setEventStream,
    hasActiveEventSubscription,
    getEffort,
    isPlanMode,
    setPlanMode,
    isFastMode,
    getSessionKeyBySdkSessionId,
    addToQueue,
    removeFromQueue,
    clients: clientsMap,
    sessions: sessionsMap,
    pendingQuestions: pendingQuestionsMap,
    pendingPlanApprovals: pendingPlanApprovalsMap,
  } = useClaudeStore();

  // Pane layout store - for clearing initialPrompt after it's been sent
  const { clearTabInitialPrompt, updateTabNativeSessionId } = usePaneLayoutStore();

  // Create a unique session key that combines environmentId and tabId
  // This prevents session collisions when multiple environments use the same tab IDs (e.g., "default")
  const sessionKey = useMemo(() => createClaudeSessionKey(environmentId, tabId), [environmentId, tabId]);

  const seedInitialFastMode = useCallback(() => {
    const claudeState = useClaudeStore.getState();
    const existing = claudeState.fastMode.get(sessionKey);
    if (existing !== undefined) {
      return existing;
    }

    const enabled = useConfigStore.getState().config.global.claudeNativeFastModeDefault ?? false;
    claudeState.setFastMode(sessionKey, enabled);
    return enabled;
  }, [sessionKey]);

  const client = useMemo(() => clientsMap.get(environmentId), [clientsMap, environmentId]);
  const session = useMemo(() => sessionsMap.get(sessionKey), [sessionsMap, sessionKey]);
  const showAddressAll = Boolean(
    isReviewTab &&
      session &&
      !session.isLoading &&
      session.messages.length > 0,
  );

  // Virtuoso scroll state - auto-follow when user is at bottom, persist across tab switches
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive,
    persistKey: sessionKey,
    environmentId,
    stickToBottomOnActivation: true,
  });

  const pendingQuestions = useMemo(() => {
    if (!session?.sessionId) return [];
    const questions: ClaudeQuestionRequest[] = [];
    for (const question of pendingQuestionsMap.values()) {
      if (question.sessionId === session.sessionId) {
        questions.push(question);
      }
    }
    return questions;
  }, [session?.sessionId, pendingQuestionsMap]);

  const pendingPlanApprovals = useMemo(() => {
    if (!session?.sessionId) return [];
    const approvals: ClaudePlanApprovalRequest[] = [];
    for (const approval of pendingPlanApprovalsMap.values()) {
      if (approval.sessionId === session.sessionId) {
        approvals.push(approval);
      }
    }
    return approvals;
  }, [session?.sessionId, pendingPlanApprovalsMap]);

  // Memoize messages separately to provide stable reference for child components
  // This prevents unnecessary recalculations when other session properties change
  const sessionMessages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const displayMessages = useMemo(
    () => pinActiveNativeAgentParts(sessionMessages.map(normalizeClaudeMessage)),
    [sessionMessages],
  );
  const hasMessageHistory = sessionMessages.length > 0;
  const centerCompose = !hasMessageHistory && !(session?.isLoading ?? false);

  // Queue length for this session - use selector to only re-render when this specific queue changes
  const queueLength = useClaudeStore(
    useCallback((state) => state.messageQueue.get(sessionKey)?.length ?? 0, [sessionKey])
  );
  const isQueueBlockedByDraft = useClaudeStore(
    useCallback(
      (state) =>
        (state.draftText.get(sessionKey)?.trim().length ?? 0) > 0 ||
        (state.attachments.get(sessionKey)?.length ?? 0) > 0,
      [sessionKey],
    ),
  );

  // Elapsed timer: counts up while agent is working
  const { elapsedSeconds, finalElapsedSeconds } = useElapsedTimer(
    session?.isLoading,
    session?.sessionId,
    session?.loadingStartedAt,
    session?.lastCompletedElapsedSeconds,
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

  const lastInitTimeRef = useRef<number>(0);
  const INIT_DEBOUNCE_MS = 1000;
  const sseReconnectAttemptsRef = useRef<number>(0);
  const startSharedEventSubscriptionRef = useRef<((client: ReturnType<typeof createClient>) => void) | null>(null);
  const MAX_SSE_RECONNECT_ATTEMPTS = 10;
  const SSE_RECONNECT_BASE_DELAY = 3000;
  const SSE_RECONNECT_MAX_DELAY = 60000;

  // Activity state tracking is handled globally by useGlobalActivityMonitor
  // (in App.tsx), which derives state from this store's session data.

  useEffect(() => {
    // Block initialization until setup scripts finish (local environments with orkestrator-ai.json)
    if (setupPending) {
      return;
    }

    const now = Date.now();
    const timeSinceLastInit = now - lastInitTimeRef.current;
    if (timeSinceLastInit < INIT_DEBOUNCE_MS && isInitializedRef.current) {
      return;
    }

    let mounted = true;

    async function initialize() {
      try {
        // Fast path: if we already have a client and session from a previous init,
        // skip all expensive steps (server status, health check, models fetch) and
        // reconnect instantly. This makes environment switching near-instant.
        const existingClient = useClaudeStore.getState().clients.get(environmentId);
        const existingSession = useClaudeStore.getState().sessions.get(sessionKey);
        if (existingClient && existingSession?.sessionId) {
          console.debug("[ClaudeChatTab] Fast reconnect - reusing existing client and session", {
            tabId,
            environmentId,
            sessionId: existingSession.sessionId,
          });
          tabSessionIdRef.current = existingSession.sessionId;
          updateTabNativeSessionId(tabId, existingSession.sessionId, environmentId);
          isInitializedRef.current = true;
          lastInitTimeRef.current = Date.now();
          setConnectionState("connected");
          setErrorMessage(null);

          // Ensure SSE subscription is still active
          if (!hasActiveEventSubscription(environmentId)) {
            startSharedEventSubscription(existingClient);
          }

          // Non-blocking background health check - if server crashed while we were
          // on another env, fall through to full init. If healthy, re-sync session
          // state to pick up any messages missed while the tab was inactive.
          checkHealth(existingClient).then(async (healthy) => {
            if (!mounted) return;
            if (!healthy) {
              console.warn("[ClaudeChatTab] Background health check failed, re-initializing");
              setClient(environmentId, null);
              setConnectionState("error");
              setErrorMessage("Bridge server disconnected. Click retry to reconnect.");
              return;
            }

            // Re-sync session state from the server.
            // If SSE events were missed while this tab was inactive (e.g. due to
            // an EventSource error killing the subscription), messages and loading
            // state can be stale.
            const serverSession = await getSession(existingClient, existingSession.sessionId);
            if (!mounted || !serverSession) return;
            const messages = await getSessionMessages(existingClient, existingSession.sessionId);
            if (!mounted) return;

            // Only apply fetched messages if they are more complete than what
            // the store currently has (SSE may have already delivered newer data).
            const currentMessages = useClaudeStore.getState().sessions.get(sessionKey)?.messages ?? [];
            if (messages.length >= currentMessages.length) {
              setMessages(sessionKey, messages);
            }

            // Reconcile loading state with server - re-read from store to avoid
            // acting on the stale snapshot captured at the start of this block.
            const currentSession = useClaudeStore.getState().sessions.get(sessionKey);
            if (serverSession.status !== "running" && currentSession?.isLoading) {
              setSessionLoading(sessionKey, false);
            }
          }).catch((err) => {
            if (!mounted) return;
            console.debug("[ClaudeChatTab] Background health check / re-sync failed:", err);
            setClient(environmentId, null);
            setConnectionState("error");
            setErrorMessage("Bridge server disconnected. Click retry to reconnect.");
          });
          return;
        }

        // Warm path: client exists for this environment (another tab already initialized)
        // but no session for this specific tab. Skip server status/health/models and
        // jump straight to session creation using the existing client.
        if (existingClient) {
          console.debug("[ClaudeChatTab] Warm path - reusing existing client, creating new session", {
            tabId,
            environmentId,
          });
          lastInitTimeRef.current = Date.now();
          setConnectionState("connecting");
          setErrorMessage(null);

          const bridgeClient = existingClient;

          // Reuse models from store if available, otherwise fetch
          let resolvedModels = models;
          if (resolvedModels.length === 0) {
            resolvedModels = await getModels(bridgeClient);
            if (!mounted) return;
            setModels(resolvedModels);
          }

          const currentSelectedModel = getSelectedModel(sessionKey);
          const preferredModel = resolvePreferredClaudeModel(resolvedModels);
          if (!currentSelectedModel && preferredModel) {
            setSelectedModel(sessionKey, preferredModel);
          }

          if (data.sessionId) {
            try {
              const restoredMessages = await getSessionMessages(bridgeClient, data.sessionId);
              if (!mounted) return;
              const restoredServerSession = await getSession(bridgeClient, data.sessionId);
              if (!mounted) return;

              tabSessionIdRef.current = data.sessionId;
              updateTabNativeSessionId(tabId, data.sessionId, environmentId);
              isInitializedRef.current = true;
              setSession(sessionKey, {
                sessionId: data.sessionId,
                messages: restoredMessages,
                isLoading: restoredServerSession?.status === "running",
              });
              setConnectionState("connected");
              if (!hasActiveEventSubscription(environmentId)) {
                startSharedEventSubscription(bridgeClient);
              }
              return;
            } catch (error) {
              if (!(error instanceof SessionNotFoundError)) throw error;
              updateTabNativeSessionId(tabId, undefined, environmentId);
            }
          }

          const newSession = await createSession(bridgeClient);
          if (!mounted) return;

          if (!newSession) {
            throw new Error("Failed to create session");
          }

          tabSessionIdRef.current = newSession.sessionId;
          updateTabNativeSessionId(tabId, newSession.sessionId, environmentId);
          isInitializedRef.current = true;
          seedInitialFastMode();

          setSession(sessionKey, {
            sessionId: newSession.sessionId,
            messages: [],
            isLoading: false,
          });

          setConnectionState("connected");

          if (!hasActiveEventSubscription(environmentId)) {
            startSharedEventSubscription(bridgeClient);
          }
          return;
        }

        console.debug("[ClaudeChatTab] Cold start - full initialization", {
          tabId,
          environmentId,
          isLocal,
          containerId,
          connectionState,
        });
        lastInitTimeRef.current = Date.now();
        setConnectionState("connecting");
        setErrorMessage(null);

        let hostPort: number | null = null;

        if (isLocal) {
          // Local environment - use local server commands
          let localStatus = await getLocalClaudeServerStatus(environmentId);
          console.debug("[ClaudeChatTab] Local server status:", localStatus);

          if (!localStatus.running) {
            console.debug("[ClaudeChatTab] Starting local Claude server...");
            const result = await startLocalClaudeServer(environmentId);
            console.debug("[ClaudeChatTab] Local Claude server start result:", result);
            localStatus = { running: true, port: result.port, pid: result.pid };
          }

          if (!mounted) return;

          if (!localStatus.port) {
            throw new Error("Local server started but no port available");
          }

          hostPort = localStatus.port;
        } else {
          // Containerized environment - use container server commands
          if (!containerId) {
            throw new Error("Container ID is required for containerized environments");
          }

          let status = await getClaudeServerStatus(containerId);
          console.debug("[ClaudeChatTab] Container server status:", status);

          if (!status.running) {
            console.debug("[ClaudeChatTab] Starting container Claude server...");
            const result = await startClaudeServer(containerId);
            console.debug("[ClaudeChatTab] Container Claude server start result:", result);
            status = { running: true, hostPort: result.hostPort };
          }

          if (!mounted) return;

          if (!status.hostPort) {
            throw new Error("Server started but no port available");
          }

          hostPort = status.hostPort;
        }

        if (!hostPort) {
          throw new Error("Failed to get server port");
        }

        setServerStatus(environmentId, {
          running: true,
          hostPort: hostPort,
        });

        const baseUrl = `http://127.0.0.1:${hostPort}`;
        console.debug("[ClaudeChatTab] Claude bridge server base URL:", baseUrl);
        const bridgeClient = createClient(baseUrl);
        setClient(environmentId, bridgeClient);

        const healthy = await checkHealth(bridgeClient);
        console.debug("[ClaudeChatTab] Claude bridge health:", healthy);
        const modelsStart = Date.now();
        const availableModels = await getModels(bridgeClient);
        if (!mounted) return;
        console.debug("[ClaudeChatTab] Available models:", availableModels, "durationMs:", Date.now() - modelsStart);
        setModels(availableModels);

        // Set default model if not already selected
        const currentSelectedModel = getSelectedModel(sessionKey);
        const preferredModel = resolvePreferredClaudeModel(availableModels);
        if (!currentSelectedModel && preferredModel) {
          setSelectedModel(sessionKey, preferredModel);
        }

        // Eagerly load slash commands from plugins (before first query)
        // The SDK only provides slash_commands in the session.init message after the
        // first query, so we discover them from plugin directories on the filesystem.
        // Uses an AbortController tied to the mount lifecycle to cancel on unmount.
        if (mounted) {
          const slashCmdController = new AbortController();
          const cleanupSlashCmd = () => slashCmdController.abort();
          // Store cleanup so the effect teardown can abort in-flight requests
          slashCmdCleanupRef.current = cleanupSlashCmd;

          getSlashCommands(bridgeClient, slashCmdController.signal).then((slashCommands) => {
            if (!mounted || slashCommands.length === 0) return;
            const existing = useClaudeStore.getState().sessionInitData.get(environmentId);
            // Merge with any existing commands (e.g., from SDK session.init)
            const existingNames = new Set(
              (existing?.slashCommands || []).map((c) => c.split(" - ")[0]!.trim().toLowerCase())
            );
            const newCommands = slashCommands.filter(
              (c) => !existingNames.has(c.split(" - ")[0]!.trim().toLowerCase())
            );
            const merged = [...(existing?.slashCommands || []), ...newCommands];
            useClaudeStore.getState().setSessionInitData(environmentId, {
              mcpServers: existing?.mcpServers || [],
              plugins: existing?.plugins || [],
              slashCommands: merged,
            });
          }).catch((err) => {
            if (err instanceof DOMException && err.name === "AbortError") return;
            console.debug("[ClaudeChatTab] Failed to eagerly load slash commands:", err);
          });
        }

        // Check for existing session - first from component ref, then from Zustand store
        // This handles reconnection after tab remount where refs are lost but store persists
        const existingSessionFromRef = tabSessionIdRef.current;
        const existingSessionFromStore = useClaudeStore.getState().sessions.get(sessionKey);
        const existingSessionId = existingSessionFromRef || existingSessionFromStore?.sessionId || data.sessionId;

        if (existingSessionId) {
          // Restore session from store - component may have remounted
          tabSessionIdRef.current = existingSessionId;
          updateTabNativeSessionId(tabId, existingSessionId, environmentId);
          isInitializedRef.current = true;
          console.debug("[ClaudeChatTab] Reconnecting to existing session", {
            tabId,
            sessionKey,
            sessionId: existingSessionId,
            environmentId,
            fromRef: !!existingSessionFromRef,
            fromStore: !!existingSessionFromStore,
          });
          setConnectionState("connected");

          // Start SSE subscription BEFORE sending initial prompt to avoid race condition
          // where SSE events could wipe locally-added messages
          startSharedEventSubscription(bridgeClient);

          // Refresh messages from server to ensure we have latest state
          try {
            const messages = await getSessionMessages(bridgeClient, existingSessionId);
            if (!mounted) return;
            // Preserve any client-side error messages that may not be on the server
            const currentMessages = existingSessionFromStore?.messages || [];
            const errorMessages = currentMessages.filter((m) => m.id.startsWith(ERROR_MESSAGE_PREFIX));
            const serverMessageIds = new Set(messages.map((m) => m.id));
            const errorMessagesToKeep = errorMessages.filter((m) => !serverMessageIds.has(m.id));
            if (existingSessionFromStore) {
              setMessages(
                sessionKey,
                errorMessagesToKeep.length > 0 ? [...messages, ...errorMessagesToKeep] : messages,
              );
            } else {
              const serverSession = await getSession(bridgeClient, existingSessionId);
              if (!mounted) return;
              setSession(sessionKey, {
                sessionId: existingSessionId,
                messages,
                isLoading: serverSession?.status === "running",
              });
            }
          } catch (err) {
            if (err instanceof SessionNotFoundError) {
              // Session expired on server - create a new one
              console.warn("[ClaudeChatTab] Session expired on server, creating new session");
              const newSession = await createSession(bridgeClient);
              if (!mounted) return;
              if (newSession) {
                seedInitialFastMode();
                tabSessionIdRef.current = newSession.sessionId;
                updateTabNativeSessionId(tabId, newSession.sessionId, environmentId);
                setSession(sessionKey, {
                  sessionId: newSession.sessionId,
                  messages: [],
                  isLoading: false,
                });
              }
            } else if (existingSessionFromStore) {
              console.warn("[ClaudeChatTab] Failed to refresh messages on reconnect:", err);
              // Keep existing messages from store if refresh fails
            } else {
              throw err;
            }
          }
        } else {
          const newSession = await createSession(bridgeClient);
          if (!mounted) return;

          if (!newSession) {
            throw new Error("Failed to create session");
          }

          tabSessionIdRef.current = newSession.sessionId;
          updateTabNativeSessionId(tabId, newSession.sessionId, environmentId);
          isInitializedRef.current = true;
          seedInitialFastMode();

          console.debug("[ClaudeChatTab] Created new session", {
            tabId,
            sessionKey,
            sessionId: newSession.sessionId,
            environmentId,
          });

          // Check if we have an initial prompt to send
          // We send it BEFORE starting SSE to avoid race conditions where
          // SSE events could wipe locally-added messages before they're synced
          const shouldSendInitialPrompt = initialPrompt && !initialPromptSentRef.current;

          if (shouldSendInitialPrompt) {
            // Mark as sent immediately to prevent double-sending
            initialPromptSentRef.current = true;
            // Also clear the initialPrompt from the pane store to prevent re-submission on remount
            clearTabInitialPrompt(tabId, environmentId);

            // Create user message
            const userMessage = {
              id: createUuid(),
              role: "user" as const,
              content: initialPrompt,
              parts: [{ type: "text" as const, content: initialPrompt }],
              timestamp: new Date().toISOString(),
            };

            console.debug("[ClaudeChatTab] Sending initial prompt during initialization", {
              tabId,
              sessionId: newSession.sessionId,
              promptLength: initialPrompt.length,
            });

            // Set session with the user message already included and loading state
            setSession(sessionKey, {
              sessionId: newSession.sessionId,
              messages: [userMessage],
              isLoading: true,
            });

            setConnectionState("connected");

            // Send the prompt to the server
            const selectedModel = getSelectedModel(sessionKey);
            const effortLevel = getEffort(sessionKey);
            const planModeEnabled = isPlanMode(sessionKey);
            const fastModeEnabled = seedInitialFastMode();
            const permissionMode = planModeEnabled ? "plan" : "bypassPermissions";
            const modelSupportsFastMode = useClaudeStore
              .getState()
              .models.find((m) => m.id === selectedModel)?.supportsFastMode !== false;

            // Start SSE subscription first so we can receive the response
            startSharedEventSubscription(bridgeClient);

            // Now send the prompt
            const success = await sendPrompt(bridgeClient, newSession.sessionId, initialPrompt, {
              model: selectedModel,
              effort: effortLevel,
              permissionMode,
              fastMode: fastModeEnabled && modelSupportsFastMode,
            });

            if (!success) {
              console.error("[ClaudeChatTab] Failed to send initial prompt");
              setSessionLoading(sessionKey, false);
              // Show error message to user
              const errorMessage = {
                id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant" as const,
                content: "Failed to send message. Please try again.",
                parts: [{ type: "text" as const, content: "Failed to send message. Please try again." }],
                timestamp: new Date().toISOString(),
              };
              addMessage(sessionKey, errorMessage);
            }
          } else {
            // No initial prompt - just set up the session normally
            setSession(sessionKey, {
              sessionId: newSession.sessionId,
              messages: [],
              isLoading: false,
            });

            setConnectionState("connected");
            startSharedEventSubscription(bridgeClient);
          }
        }
      } catch (error) {
        console.error("[ClaudeChatTab] Initialization failed:", error);
        if (!mounted) return;
        setConnectionState("error");
        let message = "Connection failed";
        if (error instanceof Error) {
          message = error.message;
        } else if (typeof error === "string") {
          message = error;
        } else if (error && typeof error === "object" && "message" in error) {
          message = String((error as { message: unknown }).message);
        }
        if (message.includes("port") && message.includes("not mapped")) {
          message += ". Try recreating the environment to enable Claude native mode support.";
        }
        setErrorMessage(message);

        // Try to fetch server log for debugging if timeout error (only for containerized environments)
        if (message.includes("timeout") && !isLocal && containerId) {
          try {
            const log = await getClaudeServerLog(containerId);
            if (log) {
              setServerLog(log);
            }
          } catch (logError) {
            console.error("[ClaudeChatTab] Failed to fetch server log:", logError);
          }
        }
      }
    }

    initialize();

    return () => {
      mounted = false;
      slashCmdCleanupRef.current?.();
      slashCmdCleanupRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, environmentId, tabId, isLocal, setupPending]);

  const startSharedEventSubscription = useCallback(
    async (bridgeClient: ReturnType<typeof createClient>) => {
      if (hasActiveEventSubscription(environmentId)) {
        return;
      }

      const subscriptionState = getOrCreateEventSubscription(environmentId);
      if (!subscriptionState) {
        return;
      }

      const { abortController } = subscriptionState;

      try {
        console.debug("[ClaudeChatTab] Starting shared event subscription", { environmentId });
        const eventStream = subscribeToEvents(bridgeClient, abortController.signal);
        setEventStream(environmentId, eventStream);

        const lastReloadTimeBySession = new Map<string, number>();
        const DEBOUNCE_MS = 200;
        const pendingReloads = new Map<string, NodeJS.Timeout>();

        // Note: sessionKey is the session key from the sessions Map (e.g., "env-{envId}:{tabId}")
        const fetchMessagesDebounced = (sessionId: string, sessionKey: string, immediate = false) => {
          const pendingTimeout = pendingReloads.get(sessionId);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(sessionId);
          }

          const doFetch = async () => {
            const now = Date.now();
            lastReloadTimeBySession.set(sessionId, now);
            console.debug("[ClaudeChatTab] Fetching session messages", { sessionId, sessionKey });
            const messages = await getSessionMessages(bridgeClient, sessionId);
            setMessages(sessionKey, messages);
          };

          if (immediate) {
            doFetch();
          } else {
            const now = Date.now();
            const lastTime = lastReloadTimeBySession.get(sessionId) || 0;
            if (now - lastTime > DEBOUNCE_MS) {
              doFetch();
            } else {
              const timeout = setTimeout(doFetch, DEBOUNCE_MS);
              pendingReloads.set(sessionId, timeout);
            }
          }
        };

        for await (const event of eventStream) {
          // Reset reconnect backoff on first successful event
          sseReconnectAttemptsRef.current = 0;

          if (abortController.signal.aborted) {
            for (const timeout of pendingReloads.values()) {
              clearTimeout(timeout);
            }
            break;
          }

          const eventType = event?.type;
          const eventSessionId = event?.sessionId;
          const usageFromEvent = extractContextUsage(event.data);
          console.debug("[ClaudeChatTab] SSE event", { eventType, eventSessionId });

          if (!eventSessionId && !["question.asked", "question.answered", "plan.enter-requested", "plan.exit-requested", "plan.approval-requested", "plan.approval-responded"].includes(eventType || "")) {
            continue;
          }

          const sessions = useClaudeStore.getState().sessions;

          // Debug: Log all stored sessions and whether we found a match
          const sessionIds = Array.from(sessions.entries()).map(([tabId, state]) => ({
            tabId,
            sessionId: state.sessionId,
          }));
          let foundMatch = false;

          for (const [sessionTabId, sessionState] of sessions) {
            if (sessionState.sessionId !== eventSessionId) continue;
            foundMatch = true;

            const isFinalEvent = eventType === "session.idle";

            if (eventType === "message.updated") {
              const message = (event.data as { message?: ClaudeMessageType } | undefined)?.message;
              if (message?.id && message.role === "assistant") {
                upsertMessage(sessionTabId, message);
              } else {
                // Non-assistant payloads (e.g. server-originated `system`
                // re-prompts) and payload-less events fall back to an
                // authoritative refetch so they still surface promptly.
                fetchMessagesDebounced(eventSessionId, sessionTabId);
              }
            } else if (isFinalEvent) {
              fetchMessagesDebounced(eventSessionId, sessionTabId, true);
            }

            if (usageFromEvent) {
              const fallbackModel = useClaudeStore.getState().selectedModel.get(sessionTabId);
              setContextUsage(sessionTabId, {
                ...usageFromEvent,
                modelId: usageFromEvent.modelId ?? fallbackModel,
              });
            }

            if (isFinalEvent) {
              setSessionLoading(sessionTabId, false);
            }

            if (eventType === "session.title-updated") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const titleData = event.data as any;
              if (titleData?.title) {
                setSessionTitle(sessionTabId, titleData.title);
              }
            }

            if (eventType === "session.error") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const rawError = (event.data as any)?.error;
              console.error("[ClaudeChatTab] Session error:", rawError);
              setSessionLoading(sessionTabId, false);
              let errorMsg: string;
              if (typeof rawError === "string") {
                errorMsg = rawError;
              } else if (rawError && typeof rawError === "object") {
                const errObj = rawError as Record<string, unknown>;
                errorMsg = String(errObj.message || errObj.error || JSON.stringify(rawError));
              } else {
                errorMsg = "An unknown error occurred";
              }
              const errorMessage = {
                id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant" as const,
                content: errorMsg,
                parts: [{ type: "text" as const, content: errorMsg }],
                timestamp: new Date().toISOString(),
              };
              addMessage(sessionTabId, errorMessage);
            }

          }

          // Handle session.init outside the session loop - uses environmentId as key
          // regardless of whether a specific session matched (handles race conditions)
          if (eventType === "session.init") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const initData = event.data as any;
            if (initData) {
              // The SDK's slash_commands includes both real commands AND skill
              // definitions. Our eagerly-loaded list (from discoverSlashCommands)
              // correctly includes only actual commands from commands/ directories.
              // Prefer our eagerly-loaded list when available; fall back to SDK's list.
              const existing = useClaudeStore.getState().sessionInitData.get(environmentId);
              const slashCommands = existing?.slashCommands?.length
                ? existing.slashCommands
                : initData.slashCommands || [];
              useClaudeStore.getState().setSessionInitData(environmentId, {
                mcpServers: initData.mcpServers || [],
                plugins: initData.plugins || [],
                slashCommands,
              });
            }
          }

          // Debug: Warn if no session matched the event
          // Filter out events that are expected during initialization or are informational
          // Also filter message/session updates since they can arrive for old sessions during reconnects
          const ignoredEventTypes = ["keepalive", "connected", "session.init", "message.updated", "session.updated", "session.idle", "session.title-updated", "plan.enter-requested", "plan.exit-requested", "plan.approval-requested", "plan.approval-responded", "system.compact", "system.message"];
          if (!foundMatch && eventSessionId && !ignoredEventTypes.includes(eventType || "")) {
            console.warn("[ClaudeChatTab] No session matched event", {
              eventType,
              eventSessionId,
              storedSessions: sessionIds,
            });
          }

          if (eventType === "question.asked") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const questionData = event.data as any;
            if (questionData?.id && questionData?.questions) {
              const questionRequest: ClaudeQuestionRequest = {
                id: questionData.id,
                sessionId: questionData.sessionId || eventSessionId || "",
                questions: questionData.questions,
                toolUseId: questionData.toolUseId,
              };
              addPendingQuestion(questionRequest);
            }
          } else if (eventType === "question.answered") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const answerData = event.data as any;
            if (answerData?.requestId) {
              removePendingQuestion(answerData.requestId);
            }
          } else if (eventType === "plan.enter-requested") {
            // Claude has entered plan mode - enable plan mode in the UI to sync state
            const planSessionKey = eventSessionId ? getSessionKeyBySdkSessionId(eventSessionId) : null;
            if (planSessionKey) {
              console.log("[ClaudeChatTab] Plan enter requested, enabling plan mode for session:", planSessionKey);
              setPlanMode(planSessionKey, true);
            } else {
              console.warn("[ClaudeChatTab] Could not find session key for plan.enter-requested event, sessionId:", eventSessionId);
            }
          } else if (eventType === "plan.exit-requested") {
            // Claude has requested to exit plan mode - disable plan mode for this session
            const planSessionKey = eventSessionId ? getSessionKeyBySdkSessionId(eventSessionId) : null;
            if (planSessionKey) {
              console.log("[ClaudeChatTab] Plan exit requested, disabling plan mode for session:", planSessionKey);
              setPlanMode(planSessionKey, false);
            } else {
              console.warn("[ClaudeChatTab] Could not find session key for plan.exit-requested event, sessionId:", eventSessionId);
            }
          } else if (eventType === "plan.approval-requested") {
            // Claude is waiting for plan approval - show approval UI
            const approvalData = event.data as PlanApprovalRequestedEventData | undefined;
            if (approvalData?.id) {
              const approvalRequest: ClaudePlanApprovalRequest = {
                id: approvalData.id,
                sessionId: approvalData.sessionId || eventSessionId || "",
                toolUseId: approvalData.toolUseId,
              };
              console.log("[ClaudeChatTab] Plan approval requested:", approvalRequest);
              addPendingPlanApproval(approvalRequest);
            }
          } else if (eventType === "plan.approval-responded") {
            // Plan approval response received - remove the pending approval
            const responseData = event.data as PlanApprovalRespondedEventData | undefined;
            if (responseData?.requestId) {
              console.log("[ClaudeChatTab] Plan approval responded:", responseData);
              removePendingPlanApproval(responseData.requestId);
            }
          } else if (eventType === "system.compact") {
            // Show simple feedback for /compact command
            const matchedSessionKey = eventSessionId ? getSessionKeyBySdkSessionId(eventSessionId) : null;
            if (matchedSessionKey) {
              const systemMessage: ClaudeMessageType = {
                id: `${SYSTEM_MESSAGE_PREFIX}${createUuid()}`,
                role: "system",
                content: "Conversation compacted.",
                parts: [{ type: "text", content: "Conversation compacted." }],
                timestamp: new Date().toISOString(),
              };
              addMessage(matchedSessionKey, systemMessage);
            }
          } else if (eventType === "system.message") {
            // Show feedback for specific system messages (not all subtypes)
            const sysData = event.data as SystemMessageEventData | undefined;
            // Only show user-facing messages, filter out informational subtypes like "status"
            const userFacingSubtypes = ["clear"];
            if (sysData?.subtype && userFacingSubtypes.includes(sysData.subtype)) {
              // Use the store helper to find the sessionKey for this SDK session ID
              const matchedSessionKey = eventSessionId ? getSessionKeyBySdkSessionId(eventSessionId) : null;
              if (matchedSessionKey) {
                let content = `System: ${sysData.subtype}`;

                // Format specific subtypes
                if (sysData.subtype === "clear") {
                  content = "Conversation cleared.";
                }

                const systemMessage: ClaudeMessageType = {
                  id: `${SYSTEM_MESSAGE_PREFIX}${createUuid()}`,
                  role: "system",
                  content,
                  parts: [{ type: "text", content }],
                  timestamp: new Date().toISOString(),
                };
                addMessage(matchedSessionKey, systemMessage);
              } else {
                console.warn("[ClaudeChatTab] system.message: No matching session found for SDK session ID", eventSessionId);
              }
            }
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[ClaudeChatTab] Event subscription error:", error);
        }
      } finally {
        setEventStream(environmentId, null);

        // Auto-reconnect SSE if the connection dropped unexpectedly (not explicitly aborted).
        // Uses exponential backoff capped at 60s, with a maximum retry count.
        if (!abortController.signal.aborted) {
          const attempt = sseReconnectAttemptsRef.current;
          if (attempt >= MAX_SSE_RECONNECT_ATTEMPTS) {
            console.warn("[ClaudeChatTab] SSE reconnect limit reached for", environmentId);
          } else {
            const reconnectDelay = Math.min(SSE_RECONNECT_BASE_DELAY * Math.pow(2, attempt), SSE_RECONNECT_MAX_DELAY);
            sseReconnectAttemptsRef.current = attempt + 1;
            console.debug("[ClaudeChatTab] SSE dropped, reconnect attempt", attempt + 1, "in", reconnectDelay, "ms for", environmentId);
            setTimeout(() => {
              const currentClient = useClaudeStore.getState().clients.get(environmentId);
              if (currentClient && !hasActiveEventSubscription(environmentId)) {
                console.debug("[ClaudeChatTab] Reconnecting SSE for", environmentId);
                startSharedEventSubscriptionRef.current?.(currentClient);
              }
            }, reconnectDelay);
          }
        } else {
          // Explicit abort — reset reconnect counter
          sseReconnectAttemptsRef.current = 0;
        }
      }
    },
    [environmentId, hasActiveEventSubscription, getOrCreateEventSubscription, setEventStream, setMessages, upsertMessage, setSessionLoading, setSessionTitle, setContextUsage, addMessage, addPendingQuestion, removePendingQuestion, addPendingPlanApproval, removePendingPlanApproval, setPlanMode, getSessionKeyBySdkSessionId]
  );
  startSharedEventSubscriptionRef.current = startSharedEventSubscription;

  const handleSend = useCallback(
    async (text: string, attachments: ClaudeAttachment[], effort: import("@/lib/claude-client").ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => {
      if (!client || !session) return;

      const selectedModel = getSelectedModel(sessionKey);

      const userMessage = {
        id: createUuid(),
        role: "user" as const,
        content: text,
        parts: [{ type: "text" as const, content: text }],
        timestamp: new Date().toISOString(),
      };
      addMessage(sessionKey, userMessage);
      setSessionLoading(sessionKey, true);

      // If this is the first message and the environment still has a default timestamp name,
      // rename the environment (including git branch) BEFORE sending the prompt to the agent.
      // This avoids renaming the branch while the agent is doing git operations.
      if (!session.messages.length) {
        const env = useEnvironmentStore.getState().getEnvironmentById(environmentId);
        if (env && isDefaultTimestampEnvironmentName(env.name)) {
          const namingMsgId = `${SYSTEM_MESSAGE_PREFIX}naming-${createUuid()}`;
          addMessage(sessionKey, {
            id: namingMsgId,
            role: "system" as const,
            content: "Naming environment...",
            parts: [{ type: "text" as const, content: "Naming environment..." }],
            timestamp: new Date().toISOString(),
          });
          try {
            await renameEnvironmentFromPrompt(environmentId, text);
          } catch (e) {
            console.warn("[ClaudeChatTab] Failed to rename environment from prompt:", e);
          }
          removeMessage(sessionKey, namingMsgId);
        }
      }

      const sdkAttachments = attachments.map((att) => ({
        type: att.type,
        path: att.path,
        dataUrl: att.previewUrl,
        filename: att.name,
      }));

      // Map planMode to SDK permission mode:
      // - plan mode true -> "plan" (no tool execution)
      // - plan mode false -> "bypassPermissions" (all tools auto-approved)
      const permissionMode = planModeEnabled ? "plan" : "bypassPermissions";

      // Guard: only honor fast mode if the selected model supports it.
      const modelSupportsFastMode = useClaudeStore
        .getState()
        .models.find((m) => m.id === selectedModel)?.supportsFastMode !== false;

      const success = await sendPrompt(client, session.sessionId, text, {
        model: selectedModel,
        attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
        effort,
        permissionMode,
        fastMode: fastModeEnabled && modelSupportsFastMode,
      });

      if (!success) {
        console.error("[ClaudeChatTab] Failed to send prompt");
        setSessionLoading(sessionKey, false);
      }
    },
    [client, session, sessionKey, environmentId, getSelectedModel, addMessage, removeMessage, setSessionLoading]
  );

  handleSendRef.current = handleSend;

  // Handle adding a message to the queue when Claude is busy
  const handleQueue = useCallback(
    (text: string, attachments: ClaudeAttachment[], effort: import("@/lib/claude-client").ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => {
      addToQueue(sessionKey, {
        id: createUuid(),
        text,
        attachments,
        effort,
        planModeEnabled,
        fastModeEnabled,
      });
    },
    [sessionKey, addToQueue]
  );

  const promoteNextQueuedPromptToDraft = useCallback(() => {
    const store = useClaudeStore.getState();
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
    store.setEffort(sessionKey, nextMessage.effort);
    store.setPlanMode(sessionKey, nextMessage.planModeEnabled);
    store.setFastMode(sessionKey, nextMessage.fastModeEnabled);
  }, [sessionKey]);

  // Handle stopping the current query
  const handleStop = useCallback(async () => {
    if (!client || !session) return;

    promoteNextQueuedPromptToDraft();
    setSessionLoading(sessionKey, false);

    const success = await abortSession(client, session.sessionId);
    if (success) {
      // Add a system message to indicate the query was stopped
      const systemMessage: ClaudeMessageType = {
        id: `${SYSTEM_MESSAGE_PREFIX}${createUuid()}`,
        role: "system",
        content: "Query stopped by user.",
        parts: [{ type: "text", content: "Query stopped by user." }],
        timestamp: new Date().toISOString(),
      };
      addMessage(sessionKey, systemMessage);
    } else {
      console.error("[ClaudeChatTab] Failed to abort session");
    }
  }, [client, session, sessionKey, promoteNextQueuedPromptToDraft, setSessionLoading, addMessage]);

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

  // Compute effort and plan mode values outside useEffect to avoid function reference dependencies
  const effortValue = getEffort(sessionKey);
  const planModeEnabledValue = isPlanMode(sessionKey);
  const fastModeEnabledValue = isFastMode(sessionKey);

  // Send initial prompt on RECONNECTION to existing session only.
  // New sessions handle initial prompt directly in initialize() to avoid race conditions.
  // This effect catches the case where we reconnect to an existing session that had an initial prompt.
  useEffect(() => {
    // Additional check: if session already has messages, the initial prompt was already sent
    // This is more robust than relying solely on the ref, which resets on component remount
    const sessionHasMessages = session?.messages && session.messages.length > 0;

    if (
      connectionState === "connected" &&
      client &&
      session &&
      initialPrompt &&
      !setupPending &&
      !initialPromptSentRef.current &&
      !sessionHasMessages
    ) {
      initialPromptSentRef.current = true;
      // Also clear the initialPrompt from the pane store to prevent re-submission on remount
      clearTabInitialPrompt(tabId, environmentId);
      console.debug("[ClaudeChatTab] Sending initial prompt on reconnection for tab:", tabId);
      handleSendRef.current?.(initialPrompt, [], effortValue, planModeEnabledValue, fastModeEnabledValue);
    }
  }, [connectionState, client, session, initialPrompt, setupPending, tabId, effortValue, planModeEnabledValue, fastModeEnabledValue, clearTabInitialPrompt, environmentId]);

  // Process queued messages when session becomes idle
  useEffect(() => {
    // Only process queue when:
    // 1. Connected and have client/session
    // 2. Session is not loading (just became idle)
    // 3. There are messages in the queue
    // 4. Not already processing a queued message (prevents race conditions)
    if (
      connectionState === "connected" &&
      client &&
      session &&
      !session.isLoading &&
      queueLength > 0 &&
      !isQueueBlockedByDraft &&
      !setupPending &&
      !isProcessingQueueRef.current
    ) {
      const nextMessage = removeFromQueue(sessionKey);
      if (nextMessage) {
        // Set flag to prevent double-processing during state transitions
        isProcessingQueueRef.current = true;

        // Send the queued message using handleSend
        const sendPromise = handleSendRef.current?.(
          nextMessage.text,
          nextMessage.attachments,
          nextMessage.effort,
          nextMessage.planModeEnabled,
          nextMessage.fastModeEnabled
        );

        // Handle completion/errors and reset the processing flag
        if (sendPromise) {
          sendPromise
            .catch((error) => {
              console.error("[ClaudeChatTab] Failed to send queued message:", error);
              // Add error message to inform user which queued message failed
              const errorMessage: ClaudeMessageType = {
                id: `${ERROR_MESSAGE_PREFIX}${createUuid()}`,
                role: "assistant",
                content: `Failed to send queued message: ${error instanceof Error ? error.message : "Unknown error"}`,
                parts: [{ type: "text", content: `Failed to send queued message: ${error instanceof Error ? error.message : "Unknown error"}` }],
                timestamp: new Date().toISOString(),
              };
              addMessage(sessionKey, errorMessage);
              setSessionLoading(sessionKey, false);
            })
            .finally(() => {
              // Reset processing flag after a short delay to allow state to settle
              setTimeout(() => {
                isProcessingQueueRef.current = false;
              }, 100);
            });
        } else {
          isProcessingQueueRef.current = false;
        }
      }
    }
  }, [connectionState, client, session, session?.isLoading, queueLength, isQueueBlockedByDraft, setupPending, sessionKey, removeFromQueue, addMessage, setSessionLoading]);

  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    tabSessionIdRef.current = null;
    updateTabNativeSessionId(tabId, undefined, environmentId);
    isInitializedRef.current = false;
    clearPersistedVirtuosoState(sessionKey);
    setClient(environmentId, null);
    setSession(sessionKey, null);
    setContextUsage(sessionKey, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
  }, [sessionKey, environmentId, tabId, setClient, setSession, setContextUsage, setServerStatus, updateTabNativeSessionId]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;

      try {
        // Fetch messages for the selected session
        console.debug("[ClaudeChatTab] Resuming session:", sessionId);
        const messages = await getSessionMessages(client, sessionId);
        console.debug("[ClaudeChatTab] Fetched messages for resumed session:", {
          sessionId,
          messageCount: messages.length,
          messages,
        });

        // Update the component's session reference
        tabSessionIdRef.current = sessionId;
        updateTabNativeSessionId(tabId, sessionId, environmentId);

        // Update the store with the resumed session
        setSession(sessionKey, {
          sessionId,
          messages,
          isLoading: false,
        });

        console.debug("[ClaudeChatTab] Session state updated:", {
          sessionKey,
          sessionId,
          messageCount: messages.length,
        });

        setResumeDialogOpen(false);
      } catch (error) {
        console.error("[ClaudeChatTab] Failed to resume session:", error);
      }
    },
    [client, environmentId, sessionKey, setSession, tabId, updateTabNativeSessionId]
  );

  if (setupPending) {
    return (
      <SetupPendingOverlay
        environmentId={environmentId}
        subtext="Claude will connect automatically once setup finishes"
      />
    );
  }

  if (connectionState === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin" />
        <p className="text-sm">Connecting to Claude bridge server...</p>
      </div>
    );
  }

  if (connectionState === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground p-4">
        <AlertCircle className="w-10 h-10 text-destructive" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Connection Failed</p>
          <p className="text-xs mt-1">{errorMessage || "Unable to connect to Claude bridge server"}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRetry} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Retry
          </Button>
          {serverLog && (
            <Button variant="ghost" size="sm" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide Log" : "Show Log"}
            </Button>
          )}
        </div>
        {showLog && serverLog && (
          <div className="w-full max-w-lg mt-2">
            <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-48 text-left whitespace-pre-wrap">
              {serverLog || "(empty log)"}
            </pre>
          </div>
        )}
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
              assistantLabel="Claude"
              containerId={containerId}
            />
          )}
          emptyState={
            !centerCompose ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-3">
                <p className="text-sm">No messages yet. Start a conversation with Claude!</p>
                {client && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResumeDialogOpen(true)}
                  >
                    <History className="w-4 h-4 mr-2" />
                    Resume Session
                  </Button>
                )}
              </div>
            ) : undefined
          }
          footer={
          <>
            {session?.isLoading && (
              <div className="px-2 @sm:px-4 py-3">
                <div className="max-w-3xl mx-auto min-w-0">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-xs">Claude is thinking...</span>
                    {elapsedSeconds !== null && elapsedSeconds > 0 && (
                      <span className="text-xs text-muted-foreground/50">{formatElapsed(elapsedSeconds)}</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {session && client && pendingQuestions.length > 0 && (
              <div className="max-w-3xl mx-auto min-w-0">
                {pendingQuestions.map((question) => (
                  <ClaudeQuestionCard
                    key={question.id}
                    question={question}
                    client={client}
                    sessionId={session.sessionId}
                  />
                ))}
              </div>
            )}

            {session && client && pendingPlanApprovals.length > 0 && (
              <div className="max-w-3xl mx-auto min-w-0">
                {pendingPlanApprovals.map((approval) => (
                  <ClaudePlanApprovalCard
                    key={approval.id}
                    approval={approval}
                    client={client}
                    sessionId={session.sessionId}
                    messages={sessionMessages}
                  />
                ))}
              </div>
            )}

            {!session?.isLoading && finalElapsedSeconds !== null && (
              <div className="px-2 @sm:px-4 py-1.5">
                <div className="max-w-3xl mx-auto min-w-0">
                  <span className="text-[10px] text-muted-foreground/40">
                    Completed in {formatElapsed(finalElapsedSeconds)}
                  </span>
                </div>
              </div>
            )}
              <div className="h-32" aria-hidden="true" />
            </>
          }
          scrollProps={scrollProps}
          virtuosoRef={virtuosoRef}
        />

      </div>

      <NativeComposeDock
        centered={centerCompose}
        topAccessory={
          !isAtBottom ? (
            <button
              type="button"
              onClick={scrollToBottom}
              className="flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 shadow-sm transition-colors hover:bg-zinc-700"
              aria-label="Scroll to bottom of conversation"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              <span>Scroll down</span>
            </button>
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
        <ClaudeComposeBar
          environmentId={environmentId}
          tabId={tabId}
          containerId={containerId}
          models={models}
          onSend={handleSend}
          disabled={!client || !session}
          isLoading={session?.isLoading ?? false}
          queueLength={queueLength}
          onStop={handleStop}
          onQueue={handleQueue}
          showAddressAll={showAddressAll}
          layout={centerCompose ? "centered" : "bottom"}
        />
      </NativeComposeDock>

      {client && (
        <ResumeSessionDialog
          open={resumeDialogOpen}
          onOpenChange={setResumeDialogOpen}
          client={client}
          onResume={handleResumeSession}
          currentSessionId={session?.sessionId}
        />
      )}
    </div>
  );
}
