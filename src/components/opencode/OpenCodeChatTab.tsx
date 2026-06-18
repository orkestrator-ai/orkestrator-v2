import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import {
  Loader2,
  AlertCircle,
  RefreshCw,
  ArrowDown,
  History,
} from "lucide-react";
import { useVirtuosoScrollState, clearPersistedVirtuosoState, useElapsedTimer } from "@/hooks";
import {
  OPTIMISTIC_MESSAGE_PREFIX,
  createOptimisticNativeMessage,
} from "@/lib/chat/client-only-messages";
import { formatElapsed } from "@/lib/format-elapsed";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { VirtualizedMessageList } from "@/components/chat/VirtualizedMessageList";
import {
  useOpenCodeStore,
  createOpenCodeSessionKey,
} from "@/stores/openCodeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { isSetupPending } from "@/lib/setup-commands";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import {
  createClient,
  getModelsWithDefaults,
  createSession,
  getSessionMessages,
  getPendingPermissions,
  getPendingQuestions,
  getAvailableSlashCommands,
  sendPrompt,
  formatOpenCodeError,
  abortSession,
  subscribeToEvents,
  normalizeOpenCodePart,
  buildOpenCodeMessageFromPart,
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  type PermissionRequest,
  type QuestionRequest,
  type OpenCodeConversationMode,
  type OpenCodeSlashCommand,
  type OpenCodeModel,
  type OpenCodeModelDefaults,
} from "@/lib/opencode-client";
import { extractContextUsage } from "@/lib/context-usage";
import {
  startOpenCodeServer,
  getOpenCodeServerStatus,
  getOpenCodeServerLog,
  getOpencodeModelPreferences,
  startLocalOpencodeServer,
  getLocalOpencodeServerStatus,
  renameEnvironmentFromPrompt,
  type OpenCodeModelRef,
  type OpenCodeModelPreferences,
} from "@/lib/tauri";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { normalizeOpenCodeNativeMessage } from "@/lib/chat/native-message-adapters";
import { OpenCodeComposeBar } from "./OpenCodeComposeBar";
import { OpenCodePermissionCard } from "./OpenCodePermissionCard";
import { OpenCodeQuestionCard } from "./OpenCodeQuestionCard";
import { OpenCodeResumeSessionDialog } from "./OpenCodeResumeSessionDialog";
import {
  resolveSlashCommandDirectory,
  shouldLoadSlashCommands,
} from "./slash-command-directory";
import { getNativeSlashCommands } from "./slash-command-registry";
import type { OpenCodeNativeData } from "@/types/paneLayout";
import type { OpenCodeAttachment } from "@/stores/openCodeStore";

interface OpenCodeChatTabProps {
  tabId: string;
  data: OpenCodeNativeData;
  isActive: boolean;
  /** Initial prompt to send after session creation */
  initialPrompt?: string;
  isReviewTab?: boolean;
}

type ConnectionState = "connecting" | "connected" | "error";

const EMPTY_MODEL_PREFERENCES: OpenCodeModelPreferences = {
  recent: [],
  favorite: [],
  variant: {},
};

const EMPTY_SLASH_COMMANDS: OpenCodeSlashCommand[] = [];
const EMPTY_MODELS: OpenCodeModel[] = [];

function toOpenCodeModelId(modelRef?: OpenCodeModelRef): string | undefined {
  if (!modelRef?.providerID || !modelRef?.modelID) {
    return undefined;
  }

  return `${modelRef.providerID}/${modelRef.modelID}`;
}

function resolveModelSelection(input: {
  availableModels: OpenCodeModel[];
  defaults: OpenCodeModelDefaults;
  preferences: OpenCodeModelPreferences;
  currentModel: string | undefined;
  currentVariant: string | undefined;
}): { model: string | undefined; variant: string | undefined } {
  const { availableModels, defaults, preferences, currentModel, currentVariant } = input;
  const availableModelIds = new Set(availableModels.map((m) => m.id));
  const recentModelId = toOpenCodeModelId(preferences.recent[0]);

  let model =
    currentModel && availableModelIds.has(currentModel) ? currentModel : undefined;

  if (!model) {
    if (recentModelId && availableModelIds.has(recentModelId)) {
      model = recentModelId;
    } else if (defaults.modelId && availableModelIds.has(defaults.modelId)) {
      model = defaults.modelId;
    } else {
      model = availableModels[0]?.id;
    }
  }

  const modelObj = availableModels.find((m) => m.id === model);
  const availableVariants = modelObj?.variants ?? [];

  let variant =
    currentVariant && availableVariants.includes(currentVariant)
      ? currentVariant
      : undefined;

  if (!variant && model) {
    const preferredVariant = preferences.variant[model];
    if (preferredVariant && availableVariants.includes(preferredVariant)) {
      variant = preferredVariant;
    }
  }

  if (
    !variant &&
    model === defaults.modelId &&
    defaults.variant &&
    availableVariants.includes(defaults.variant)
  ) {
    variant = defaults.variant;
  }

  return { model, variant };
}

export function OpenCodeChatTab({
  tabId,
  data,
  isActive,
  initialPrompt,
  isReviewTab = false,
}: OpenCodeChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  // Initialize as "connected" if we already have a client and session from a previous init.
  // This avoids even a single frame of spinner when switching back to an already-connected env.
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => {
    const hasClient = useOpenCodeStore.getState().clients.has(environmentId);
    const hasSession = useOpenCodeStore.getState().sessions.has(createOpenCodeSessionKey(environmentId, tabId));
    return hasClient && hasSession ? "connected" : "connecting";
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [modelPreferences, setModelPreferences] =
    useState<OpenCodeModelPreferences>(EMPTY_MODEL_PREFERENCES);

  // Track this tab's session ID locally to prevent interference between tabs
  const tabSessionIdRef = useRef<string | null>(null);
  // Track if this tab has been initialized (to differentiate first mount vs re-activation)
  const isInitializedRef = useRef(false);
  // Track if initial prompt has been sent (to prevent duplicate sends)
  const initialPromptSentRef = useRef(false);
  // Track when we are currently draining queued prompts
  const isProcessingQueueRef = useRef(false);
  // Ref to store handleSend for use in effects without causing re-runs
  const handleSendRef = useRef<
    ((
      text: string,
      attachments: OpenCodeAttachment[],
      options?: {
        model?: string;
        variant?: string;
        mode?: OpenCodeConversationMode;
      },
    ) => Promise<void>) | null
  >(null);

  const {
    setClient,
    setModels,
    getSession,
    setSession,
    addMessage,
    removeMessage,
    setMessages,
    upsertMessage,
    setSessionLoading,
    setServerStatus,
    setSelectedModel,
    setSelectedVariant,
    setSlashCommands,
    getSelectedModel,
    getSelectedVariant,
    getSelectedMode,
    setContextUsage,
    addToQueue,
    removeFromQueue,
    addPendingPermission,
    addPendingQuestion,
    removePendingPermission,
    removePendingQuestion,
    // Event subscription management (shared per environment)
    getOrCreateEventSubscription,
    setEventStream,
    hasActiveEventSubscription,
    // Subscribe to Maps directly for proper reactivity (triggers re-render on changes)
    clients: clientsMap,
    sessions: sessionsMap,
    pendingPermissions: pendingPermissionsMap,
    pendingQuestions: pendingQuestionsMap,
  } = useOpenCodeStore();

  const { clearTabInitialPrompt } = usePaneLayoutStore();

  // Create a unique session key that combines environmentId and tabId
  // This prevents session collisions when multiple environments use the same tab IDs (e.g., "default")
  const sessionKey = useMemo(
    () => createOpenCodeSessionKey(environmentId, tabId),
    [environmentId, tabId],
  );

  // Get client from Map (shared per environment) - subscribing to the Map ensures re-render on changes
  const client = useMemo(
    () => clientsMap.get(environmentId),
    [clientsMap, environmentId],
  );
  // Get session from Map keyed by sessionKey (each tab has its own session, scoped by environment)
  const session = useMemo(
    () => sessionsMap.get(sessionKey),
    [sessionsMap, sessionKey],
  );

  const sessionMessages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const hasMessageHistory = sessionMessages.length > 0;
  const centerCompose = !hasMessageHistory && !(session?.isLoading ?? false);
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
  });

  // Get pending questions for this session - subscribe to the Map for reactivity
  const pendingQuestions = useMemo(() => {
    if (!session?.sessionId) return [];
    const questions: QuestionRequest[] = [];
    for (const question of pendingQuestionsMap.values()) {
      if (question.sessionID === session.sessionId) {
        questions.push(question);
      }
    }
    return questions;
  }, [session?.sessionId, pendingQuestionsMap]);

  // Get pending permissions for this session - subscribe to the Map for reactivity
  const pendingPermissions = useMemo(() => {
    if (!session?.sessionId) return [];
    const permissions: PermissionRequest[] = [];
    for (const permission of pendingPermissionsMap.values()) {
      if (permission.sessionID === session.sessionId) {
        permissions.push(permission);
      }
    }
    return permissions;
  }, [session?.sessionId, pendingPermissionsMap]);

  const favoriteModelIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const favorite of modelPreferences.favorite) {
      const modelId = toOpenCodeModelId(favorite);
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      ids.push(modelId);
    }

    return ids;
  }, [modelPreferences]);

  // Elapsed timer: counts up while agent is working
  const { elapsedSeconds, finalElapsedSeconds } = useElapsedTimer(
    session?.isLoading,
    session?.sessionId,
    session?.loadingStartedAt,
    session?.lastCompletedElapsedSeconds,
  );

  const worktreePath = useEnvironmentStore(
    useCallback(
      (state) => state.getEnvironmentById(environmentId)?.worktreePath,
      [environmentId],
    ),
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

  const slashCommandDirectory = resolveSlashCommandDirectory(
    isLocal ?? false,
    worktreePath,
  );

  // Queue length for this tab session - subscribe narrowly for fewer re-renders
  const queueLength = useOpenCodeStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey)?.length ?? 0,
      [sessionKey],
    ),
  );
  const isQueueBlockedByDraft = useOpenCodeStore(
    useCallback(
      (state) =>
        (state.draftText.get(sessionKey)?.trim().length ?? 0) > 0 ||
        (state.attachments.get(sessionKey)?.length ?? 0) > 0,
      [sessionKey],
    ),
  );

  const slashCommands = useOpenCodeStore(
    useCallback(
      (state) => state.slashCommands.get(environmentId) ?? EMPTY_SLASH_COMMANDS,
      [environmentId],
    ),
  );

  const models = useOpenCodeStore(
    useCallback(
      (state) => state.models.get(environmentId) ?? EMPTY_MODELS,
      [environmentId],
    ),
  );

  // Activity state tracking is handled globally by useGlobalActivityMonitor
  // (in App.tsx), which derives state from this store's session data.

  // Track last initialization time to prevent rapid re-initialization
  const lastInitTimeRef = useRef<number>(0);
  const INIT_DEBOUNCE_MS = 1000; // Don't re-initialize within 1 second
  const sseReconnectAttemptsRef = useRef<number>(0);
  const startSharedEventSubscriptionRef = useRef<((client: ReturnType<typeof createClient>) => void) | null>(null);
  const MAX_SSE_RECONNECT_ATTEMPTS = 10;
  const SSE_RECONNECT_BASE_DELAY = 3000;
  const SSE_RECONNECT_MAX_DELAY = 60000;

  // Hydrate pending permission/question requests in case SSE events were missed
  const syncPendingRequests = useCallback(
    async (
      sdkClient: ReturnType<typeof createClient>,
      sessionId: string,
    ) => {
      const stateBeforeSync = useOpenCodeStore.getState();
      const existingQuestionIds = new Set<string>();
      const existingPermissionIds = new Set<string>();

      for (const existingQuestion of stateBeforeSync.pendingQuestions.values()) {
        if (existingQuestion.sessionID === sessionId) {
          existingQuestionIds.add(existingQuestion.id);
        }
      }

      for (const existingPermission of stateBeforeSync.pendingPermissions.values()) {
        if (existingPermission.sessionID === sessionId) {
          existingPermissionIds.add(existingPermission.id);
        }
      }

      const [questions, permissions] = await Promise.all([
        getPendingQuestions(sdkClient),
        getPendingPermissions(sdkClient),
      ]);

      const questionIds = new Set<string>();
      for (const question of questions) {
        if (question.sessionID !== sessionId) continue;
        questionIds.add(question.id);
        addPendingQuestion(question);
      }

      const permissionIds = new Set<string>();
      for (const permission of permissions) {
        if (permission.sessionID !== sessionId) continue;
        permissionIds.add(permission.id);
        addPendingPermission(permission);
      }

      // Prune only items that existed before sync started.
      // This avoids deleting requests that arrive via SSE during the sync window.
      for (const existingQuestionId of existingQuestionIds) {
        if (!questionIds.has(existingQuestionId)) {
          removePendingQuestion(existingQuestionId);
        }
      }

      for (const existingPermissionId of existingPermissionIds) {
        if (!permissionIds.has(existingPermissionId)) {
          removePendingPermission(existingPermissionId);
        }
      }
    },
    [
      addPendingPermission,
      addPendingQuestion,
      removePendingPermission,
      removePendingQuestion,
    ],
  );

  // Initialize connection on mount.
  // Active tabs always initialize; inactive tabs initialize too when an
  // initialPrompt is pending so background mounts can dispatch the prompt
  // before becoming visible.
  useEffect(() => {
    if (!isActive && !initialPrompt?.trim() && queueLength === 0) {
      return;
    }

    // Block initialization until setup scripts finish (local environments with orkestrator-ai.json)
    if (setupPending) {
      return;
    }

    // Debounce rapid re-initialization
    const now = Date.now();
    const timeSinceLastInit = now - lastInitTimeRef.current;
    if (timeSinceLastInit < INIT_DEBOUNCE_MS && isInitializedRef.current) {
      return;
    }

    let mounted = true;

    async function initialize() {
      try {
        // Fast path: if we already have a client and session from a previous init,
        // skip all expensive steps (server status, model fetch, etc.) and
        // reconnect instantly. This makes environment switching near-instant.
        const existingClient = useOpenCodeStore.getState().clients.get(environmentId);
        const existingSession = useOpenCodeStore.getState().sessions.get(sessionKey);
        if (existingClient && existingSession?.sessionId) {
          console.debug("[OpenCodeChatTab] Fast reconnect - reusing existing client and session", {
            tabId,
            environmentId,
            sessionId: existingSession.sessionId,
          });
          tabSessionIdRef.current = existingSession.sessionId;
          isInitializedRef.current = true;
          lastInitTimeRef.current = Date.now();
          setConnectionState("connected");
          setErrorMessage(null);

          // Ensure SSE subscription is still active
          if (!hasActiveEventSubscription(environmentId)) {
            startSharedEventSubscription(existingClient);
          }
          return;
        }

        // Warm path: client exists for this environment (another tab already initialized)
        // but no session for this specific tab. Skip server status/models and
        // jump straight to session creation using the existing client.
        if (existingClient) {
          console.debug("[OpenCodeChatTab] Warm path - reusing existing client, creating new session", {
            tabId,
            environmentId,
          });
          lastInitTimeRef.current = Date.now();
          setConnectionState("connecting");
          setErrorMessage(null);

          const newSession = await createSession(existingClient);
          if (!mounted) return;

          if (!newSession) {
            throw new Error("Failed to create OpenCode session");
          }

          tabSessionIdRef.current = newSession.id;
          isInitializedRef.current = true;

          setSession(sessionKey, {
            sessionId: newSession.id,
            messages: [],
            isLoading: false,
          });

          setConnectionState("connected");

          if (!hasActiveEventSubscription(environmentId)) {
            startSharedEventSubscription(existingClient);
          }
          return;
        }

        lastInitTimeRef.current = Date.now();
        setConnectionState("connecting");
        setErrorMessage(null);

        let hostPort: number | null = null;

        if (isLocal) {
          // Local environment - use local server commands
          let localStatus = await getLocalOpencodeServerStatus(environmentId);

          if (!localStatus.running) {
            const result = await startLocalOpencodeServer(environmentId);
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
            throw new Error(
              "Container ID is required for containerized environments",
            );
          }

          let status = await getOpenCodeServerStatus(containerId);

          if (!status.running) {
            const result = await startOpenCodeServer(containerId);
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

        // Create SDK client (shared per environment)
        const baseUrl = `http://127.0.0.1:${hostPort}`;
        console.debug("[OpenCodeChatTab] OpenCode server running at:", baseUrl);
        // Local OpenCode servers are already launched with their CWD set to the
        // environment worktree, so attaching the SDK-wide directory header is
        // unnecessary here. Avoiding that extra browser header also removes one
        // more local-only variable from native-tab startup.
        const sdkClient = createClient(baseUrl);
        setClient(environmentId, sdkClient);

        // Fetch available models, server defaults, and model preferences
        const [{ models: availableModels, defaults }, preferences] =
          await Promise.all([
            getModelsWithDefaults(sdkClient),
            getOpencodeModelPreferences().catch((error) => {
              console.warn(
                "[OpenCodeChatTab] Failed to load model preferences:",
                error,
              );
              return EMPTY_MODEL_PREFERENCES;
            }),
          ]);
        if (!mounted) return;

        setModels(environmentId, availableModels);
        setModelPreferences(preferences);

        // Initialize selected model/variant while preserving valid user-selected values.
        const currentModel = getSelectedModel(environmentId);
        const currentVariant = getSelectedVariant(environmentId);
        const { model: resolvedModel, variant: resolvedVariant } =
          resolveModelSelection({
            availableModels,
            defaults,
            preferences,
            currentModel,
            currentVariant,
          });

        if (resolvedModel && resolvedModel !== currentModel) {
          setSelectedModel(environmentId, resolvedModel);
        }

        if (resolvedVariant !== currentVariant) {
          setSelectedVariant(environmentId, resolvedVariant);
        }

        // Check for existing session - first from component ref, then from Zustand store
        // This handles reconnection after tab remount where refs are lost but store persists
        const existingSessionFromRef = tabSessionIdRef.current;
        const existingSessionFromStore = useOpenCodeStore
          .getState()
          .sessions.get(sessionKey);
        const existingSessionId =
          existingSessionFromRef || existingSessionFromStore?.sessionId;

        if (existingSessionId) {
          // Restore session from store - component may have remounted
          tabSessionIdRef.current = existingSessionId;
          isInitializedRef.current = true;
          setConnectionState("connected");

          // Start shared event subscription if not already running
          startSharedEventSubscription(sdkClient);

          // Sync pending interactions in case we missed early SSE events
          await syncPendingRequests(sdkClient, existingSessionId);

          // Refresh messages from server to ensure latest state on reconnection
          if (existingSessionFromStore) {
            try {
              const messages = await getSessionMessages(
                sdkClient,
                existingSessionId,
              );
              if (!mounted) return;

              // setMessages preserves client-side error messages (ERROR_MESSAGE_PREFIX)
              // from the existing session state when replacing server messages.
              setMessages(sessionKey, messages);
            } catch (err) {
              console.warn(
                "[OpenCodeChatTab] Failed to refresh messages on reconnect:",
                err,
              );
              // Keep existing messages from store if refresh fails
            }
          } else {
            // Session exists in ref but not in store, restore minimal state
            setSession(sessionKey, {
              sessionId: existingSessionId,
              messages: [],
              isLoading: false,
            });
          }
        } else {
          // First initialization - create a new session
          const newSession = await createSession(sdkClient);
          if (!mounted) return;

          // Store the session ID in the ref for future re-activations
          tabSessionIdRef.current = newSession.id;
          isInitializedRef.current = true;

          setSession(sessionKey, {
            sessionId: newSession.id,
            messages: [],
            isLoading: false,
          });

          setConnectionState("connected");

          // Start shared event subscription if not already running
          startSharedEventSubscription(sdkClient);

          // Sync pending interactions in case we missed early SSE events
          await syncPendingRequests(sdkClient, newSession.id);
        }
      } catch (error) {
        console.error("[OpenCodeChatTab] Initialization failed:", error);
        if (!mounted) return;
        setConnectionState("error");
        // Extract error message with structured details when available.
        let message = formatOpenCodeError(error);
        // Add hint for port mapping issues
        if (message.includes("port") && message.includes("not mapped")) {
          message +=
            ". Try recreating the environment to enable native mode support.";
        }
        setErrorMessage(message);

        // Try to fetch server log for debugging if timeout error (only for containerized environments)
        if (message.includes("timeout") && !isLocal && containerId) {
          try {
            const log = await getOpenCodeServerLog(containerId);
            if (log) {
              setServerLog(log);
            }
          } catch (logError) {
            console.error(
              "[OpenCodeChatTab] Failed to fetch server log:",
              logError,
            );
          }
        }
      }
    }

    initialize();

    return () => {
      mounted = false;
      // NOTE: We do NOT close the event subscription here - it's shared per environment
      // The subscription will be closed when the environment is cleaned up
      // We also don't clear the client - it's shared per environment
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    containerId,
    environmentId,
    tabId,
    isActive,
    initialPrompt,
    isLocal,
    queueLength,
    syncPendingRequests,
    getSelectedModel,
    getSelectedVariant,
    setSelectedModel,
    setSelectedVariant,
    setupPending,
  ]);

  useEffect(() => {
    if (!isActive || connectionState !== "connected" || !client) {
      return;
    }

    if (!shouldLoadSlashCommands(isLocal ?? false, slashCommandDirectory)) {
      return;
    }

    let cancelled = false;

    getAvailableSlashCommands(client, slashCommandDirectory)
      .then((availableSlashCommands) => {
        if (cancelled) return;
        setSlashCommands(
          environmentId,
          getNativeSlashCommands(availableSlashCommands),
        );
      })
      .catch((error) => {
        console.warn("[OpenCodeChatTab] Failed to load slash commands:", error);
        if (cancelled) return;
        setSlashCommands(
          environmentId,
          getNativeSlashCommands(EMPTY_SLASH_COMMANDS),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    client,
    connectionState,
    environmentId,
    isActive,
    isLocal,
    setSlashCommands,
    slashCommandDirectory,
  ]);

  // Start shared event subscription for the environment (only if not already running)
  const startSharedEventSubscription = useCallback(
    async (sdkClient: ReturnType<typeof createClient>) => {
      // Check if there's already an active subscription for this environment
      if (hasActiveEventSubscription(environmentId)) {
        return;
      }

      // Get or create subscription state from store
      const subscriptionState = getOrCreateEventSubscription(environmentId);
      if (!subscriptionState) {
        return;
      }

      const { abortController } = subscriptionState;

      try {
        const eventStream = await subscribeToEvents(sdkClient);
        if (!eventStream || abortController.signal.aborted) {
          return;
        }

        // Store stream reference in the store for cleanup
        setEventStream(environmentId, eventStream);

        // Track last reload time to debounce rapid updates per session
        const lastReloadTimeBySession = new Map<string, number>();
        const DEBOUNCE_MS = 200; // Debounce all message fetches
        const pendingReloads = new Map<string, NodeJS.Timeout>(); // Track pending debounced reloads

        // Helper to fetch messages with debouncing
        // Note: sessionKey is the session key from the sessions Map (e.g., "env-{envId}:{tabId}")
        const fetchMessagesDebounced = (
          sessionId: string,
          sessionKey: string,
          immediate = false,
        ) => {
          // Clear any pending reload for this session
          const pendingTimeout = pendingReloads.get(sessionId);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(sessionId);
          }

          const doFetch = async () => {
            const now = Date.now();
            lastReloadTimeBySession.set(sessionId, now);
            const messages = await getSessionMessages(sdkClient, sessionId);
            setMessages(sessionKey, messages);
          };

          if (immediate) {
            // For final events (session.idle), fetch immediately
            doFetch();
          } else {
            // For streaming events, debounce
            const now = Date.now();
            const lastTime = lastReloadTimeBySession.get(sessionId) || 0;
            if (now - lastTime > DEBOUNCE_MS) {
              // Enough time has passed, fetch now
              doFetch();
            } else {
              // Schedule a fetch after debounce period
              const timeout = setTimeout(doFetch, DEBOUNCE_MS);
              pendingReloads.set(sessionId, timeout);
            }
          }
        };

        const applyPartUpdate = (
          sessionTabId: string,
          rawPart: unknown,
          delta?: string,
        ): boolean => {
          const part = normalizeOpenCodePart(rawPart);
          if (!part?.sourceMessageId) {
            return false;
          }

          const sessionState = useOpenCodeStore.getState().sessions.get(sessionTabId);
          const existingMessage = sessionState?.messages.find(
            (message) => message.id === part.sourceMessageId,
          );
          upsertMessage(
            sessionTabId,
            buildOpenCodeMessageFromPart(
              existingMessage,
              part.sourceMessageId,
              part,
              delta,
            ),
          );
          return true;
        };

        for await (const event of eventStream) {
          // Reset reconnect backoff on first successful event
          sseReconnectAttemptsRef.current = 0;

          if (abortController.signal.aborted) {
            // Clean up pending reloads on abort
            for (const timeout of pendingReloads.values()) {
              clearTimeout(timeout);
            }
            break;
          }

          // Handle different event types based on OpenCode SDK
          const eventType = event?.type;
          const usageFromEvent = extractContextUsage(event);
          // SessionID can be in different places depending on event type:
          // - session events: properties.sessionID
          // - message part events: properties.part.sessionID
          // - message events: properties.info?.sessionID
          // - session.updated events: properties.info?.id (the session ID itself)
          const props = event?.properties;
          const eventSessionId =
            props?.sessionID ||
            props?.sessionId ||
            props?.part?.sessionID ||
            props?.info?.sessionID ||
            props?.info?.id ||
            props?.message?.sessionID ||
            (event as any)?.sessionID;

          // Skip events we don't care about (heartbeats, etc)
          if (
            !eventSessionId &&
            ![
              "permission.asked",
              "permission.replied",
              "question.asked",
              "question.replied",
              "question.rejected",
            ].includes(eventType || "")
          ) {
            continue;
          }

          // Find the tab that has this session
          const sessions = useOpenCodeStore.getState().sessions;

          // Handle events for all sessions in this environment
          for (const [sessionTabId, sessionState] of sessions) {
            if (sessionState.sessionId !== eventSessionId) continue;

            // Determine if this is a "final" event that should trigger immediate refresh
            const isFinalEvent =
              eventType === "session.idle" ||
              (eventType === "session.status" &&
                props?.status?.type === "idle");

            if (eventType === "message.part.updated") {
              const applied = applyPartUpdate(
                sessionTabId,
                props?.part,
                typeof props?.delta === "string" ? props.delta : undefined,
              );
              if (!applied) {
                fetchMessagesDebounced(
                  eventSessionId,
                  sessionTabId,
                  false,
                );
              }
            } else if (
              eventType === "message.updated" ||
              eventType === "session.updated" ||
              isFinalEvent
            ) {
              fetchMessagesDebounced(
                eventSessionId,
                sessionTabId,
                isFinalEvent,
              );
            }

            if (usageFromEvent) {
              const fallbackModel = useOpenCodeStore
                .getState()
                .selectedModel.get(environmentId);
              setContextUsage(sessionTabId, {
                ...usageFromEvent,
                modelId: usageFromEvent.modelId ?? fallbackModel,
              });
            }

            // Clear loading state on final events
            if (isFinalEvent) {
              setSessionLoading(sessionTabId, false);
            }

            // Handle errors
            if (eventType === "session.error") {
              console.error("[OpenCodeChatTab] Session error:", props?.error);
              setSessionLoading(sessionTabId, false);
              const errorMsg = formatOpenCodeError(props?.error);
              // Add error as a message with special ID prefix so it persists
              // The setMessages function preserves messages with ERROR_MESSAGE_PREFIX
              const errorMessage = {
                id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
                role: "assistant" as const,
                content: errorMsg,
                parts: [{ type: "text" as const, content: errorMsg }],
                createdAt: new Date().toISOString(),
              };
              addMessage(sessionTabId, errorMessage);
            }
          }

          // Handle permission events (not session-specific, need to match by sessionID in the event)
          if (eventType === "permission.asked") {
            const permissionProps = event.properties;
            if (permissionProps?.id && permissionProps?.permission) {
              const permissionRequest: PermissionRequest = {
                id: permissionProps.id,
                sessionID:
                  permissionProps.sessionID ||
                  permissionProps.sessionId ||
                  eventSessionId ||
                  "",
                permission: permissionProps.permission,
                patterns: Array.isArray(permissionProps.patterns)
                  ? permissionProps.patterns
                  : [],
                metadata:
                  permissionProps.metadata &&
                  typeof permissionProps.metadata === "object"
                    ? permissionProps.metadata
                    : {},
                always: Array.isArray(permissionProps.always)
                  ? permissionProps.always
                  : [],
                tool: permissionProps.tool,
              };
              addPendingPermission(permissionRequest);
            }
          }
          // Handle permission replied events (remove the permission request)
          else if (eventType === "permission.replied") {
            if (event.properties?.requestID) {
              removePendingPermission(event.properties.requestID);
            }
          }
          // Handle question events (not session-specific, need to match by sessionID in the event)
          else if (eventType === "question.asked") {
            const questionProps = event.properties;
            if (questionProps?.id && questionProps?.questions) {
              const questionRequest: QuestionRequest = {
                id: questionProps.id,
                sessionID:
                  questionProps.sessionID ||
                  questionProps.sessionId ||
                  eventSessionId ||
                  "",
                questions: questionProps.questions,
                tool: questionProps.tool,
              };
              addPendingQuestion(questionRequest);
            }
          }
          // Handle question replied events (remove the question)
          else if (eventType === "question.replied") {
            if (event.properties?.requestID) {
              removePendingQuestion(event.properties.requestID);
            }
          }
          // Handle question rejected events (remove the question)
          else if (eventType === "question.rejected") {
            if (event.properties?.requestID) {
              removePendingQuestion(event.properties.requestID);
            }
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error("[OpenCodeChatTab] Event subscription error:", error);
        }
      } finally {
        // Clear the stream reference when loop ends
        setEventStream(environmentId, null);

        // Auto-reconnect SSE if the connection dropped unexpectedly (not explicitly aborted).
        // Uses exponential backoff capped at 60s, with a maximum retry count.
        if (!abortController.signal.aborted) {
          const attempt = sseReconnectAttemptsRef.current;
          if (attempt >= MAX_SSE_RECONNECT_ATTEMPTS) {
            console.warn("[OpenCodeChatTab] SSE reconnect limit reached for", environmentId);
          } else {
            const reconnectDelay = Math.min(SSE_RECONNECT_BASE_DELAY * Math.pow(2, attempt), SSE_RECONNECT_MAX_DELAY);
            sseReconnectAttemptsRef.current = attempt + 1;
            console.debug("[OpenCodeChatTab] SSE dropped, reconnect attempt", attempt + 1, "in", reconnectDelay, "ms for", environmentId);
            setTimeout(() => {
              const currentClient = useOpenCodeStore.getState().clients.get(environmentId);
              if (currentClient && !hasActiveEventSubscription(environmentId)) {
                console.debug("[OpenCodeChatTab] Reconnecting SSE for", environmentId);
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
    [
      environmentId,
      hasActiveEventSubscription,
      getOrCreateEventSubscription,
      setEventStream,
      setMessages,
      upsertMessage,
      setSessionLoading,
      setContextUsage,
      addMessage,
      addPendingPermission,
      addPendingQuestion,
      removePendingPermission,
      removePendingQuestion,
    ],
  );
  startSharedEventSubscriptionRef.current = startSharedEventSubscription;

  // Handle sending a message
  const handleSend = useCallback(
    async (
      text: string,
      attachments: OpenCodeAttachment[],
      options?: {
        model?: string;
        variant?: string;
        mode?: OpenCodeConversationMode;
      },
    ) => {
      if (!client || !session) return;

      const selectedModel = options?.model ?? getSelectedModel(environmentId);
      const selectedVariant =
        options?.variant ?? getSelectedVariant(environmentId);
      const selectedMode = options?.mode ?? getSelectedMode(sessionKey);

      // Add user message optimistically
      const userMessage = createOptimisticNativeMessage(
        `${OPTIMISTIC_MESSAGE_PREFIX}${crypto.randomUUID()}`,
        text,
        attachments,
      );
      addMessage(sessionKey, userMessage);
      setSessionLoading(sessionKey, true);

      // If this is the first message and the environment still has a default timestamp name,
      // rename the environment (including git branch) BEFORE sending the prompt to the agent.
      // This avoids renaming the branch while the agent is doing git operations.
      if (!session.messages.length) {
        const env = useEnvironmentStore.getState().getEnvironmentById(environmentId);
        if (env && /^\d{8}-\d{6}$/.test(env.name)) {
          const namingMsgId = `${SYSTEM_MESSAGE_PREFIX}naming-${crypto.randomUUID()}`;
          addMessage(sessionKey, {
            id: namingMsgId,
            role: "assistant" as const,
            content: "Naming environment...",
            parts: [{ type: "text" as const, content: "Naming environment..." }],
            createdAt: new Date().toISOString(),
          });
          try {
            await renameEnvironmentFromPrompt(environmentId, text);
          } catch (e) {
            console.warn("[OpenCodeChatTab] Failed to rename environment from prompt:", e);
          }
          removeMessage(sessionKey, namingMsgId);
        }
      }

      // Convert attachments to SDK format (include dataUrl for proper MIME/URL handling)
      const sdkAttachments = attachments.map((att) => ({
        type: att.type,
        path: att.path,
        dataUrl: att.previewUrl, // Data URL for images
        filename: att.name,
      }));

      // Send prompt
      const sendResult = await sendPrompt(client, session.sessionId, text, {
        model: selectedModel,
        variant: selectedVariant,
        mode: selectedMode,
        attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
      });

      if (!sendResult.success) {
        console.error("[OpenCodeChatTab] Failed to send prompt");
        const errorText = sendResult.error || "Failed to send prompt";
        removeMessage(sessionKey, userMessage.id);
        addMessage(sessionKey, {
          id: `${ERROR_MESSAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role: "assistant" as const,
          content: errorText,
          parts: [{ type: "text" as const, content: errorText }],
          createdAt: new Date().toISOString(),
        });
        setSessionLoading(sessionKey, false);
      }
      // Response will come via SSE events
    },
    [
      client,
      session,
      sessionKey,
      environmentId,
      getSelectedModel,
      getSelectedVariant,
      getSelectedMode,
      addMessage,
      removeMessage,
      setSessionLoading,
    ],
  );

  // Keep handleSendRef updated with the latest handleSend
  handleSendRef.current = handleSend;

  const handleQueue = useCallback(
    (text: string, attachments: OpenCodeAttachment[]) => {
      addToQueue(sessionKey, {
        id: crypto.randomUUID(),
        text,
        attachments,
        model: getSelectedModel(environmentId),
        variant: getSelectedVariant(environmentId),
        mode: getSelectedMode(sessionKey),
      });
    },
    [
      addToQueue,
      sessionKey,
      getSelectedModel,
      getSelectedVariant,
      getSelectedMode,
      environmentId,
    ],
  );

  const processQueue = useCallback(() => {
    if (isProcessingQueueRef.current) return;
    if (setupPending) return;
    if (connectionState !== "connected" || !client) return;

    const openCodeState = useOpenCodeStore.getState();
    if (
      (openCodeState.draftText.get(sessionKey)?.trim().length ?? 0) > 0 ||
      (openCodeState.attachments.get(sessionKey)?.length ?? 0) > 0
    ) {
      return;
    }

    const latestSession = getSession(sessionKey);
    if (!latestSession || latestSession.isLoading) return;

    const nextMessage = removeFromQueue(sessionKey);
    if (!nextMessage) return;

    isProcessingQueueRef.current = true;

    const sendPromise = handleSendRef.current?.(
      nextMessage.text,
      nextMessage.attachments,
      {
        model: nextMessage.model,
        variant: nextMessage.variant,
        mode: nextMessage.mode,
      },
    );

    if (!sendPromise) {
      isProcessingQueueRef.current = false;
      return;
    }

    sendPromise
      .catch((error) => {
        console.error("[OpenCodeChatTab] Failed to send queued prompt:", error);
        const errorText = `Failed to send queued prompt: ${
          error instanceof Error ? error.message : "Unknown error"
        }`;
        addMessage(sessionKey, {
          id: `${ERROR_MESSAGE_PREFIX}${crypto.randomUUID()}`,
          role: "assistant",
          content: errorText,
          parts: [{ type: "text", content: errorText }],
          createdAt: new Date().toISOString(),
        });
        setSessionLoading(sessionKey, false);
      })
      .finally(() => {
        isProcessingQueueRef.current = false;
        queueMicrotask(() => {
          processQueue();
        });
      });
  }, [
    connectionState,
    client,
    getSession,
    sessionKey,
    setupPending,
    removeFromQueue,
    addMessage,
    setSessionLoading,
  ]);

  // Process queued prompts whenever there is queued work and the session can accept input.
  useEffect(() => {
    if (queueLength > 0 && !isQueueBlockedByDraft && !setupPending) {
      processQueue();
    }
  }, [queueLength, isQueueBlockedByDraft, setupPending, session?.isLoading, processQueue]);

  // Send initial prompt after session is ready (for code review, PR creation, etc.)
  useEffect(() => {
    const sessionHasMessages = !!session?.messages.length;

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
      // Clear from pane state so it can't be re-sent after remount
      clearTabInitialPrompt(tabId, environmentId);
      console.debug("[OpenCodeChatTab] Sending initial prompt for tab:", tabId);
      // Use ref to avoid effect re-running when handleSend changes
      handleSendRef.current?.(initialPrompt, []);
    }
  }, [
    connectionState,
    client,
    session,
    initialPrompt,
    setupPending,
    tabId,
    clearTabInitialPrompt,
    environmentId,
  ]);

  // Handle retry connection
  const handleRetry = useCallback(() => {
    setConnectionState("connecting");
    setErrorMessage(null);
    // Reset initialization state to force new session creation
    tabSessionIdRef.current = null;
    isInitializedRef.current = false;
    clearPersistedVirtuosoState(sessionKey);
    // Trigger re-initialization by clearing client
    setClient(environmentId, null);
    setSession(sessionKey, null);
    setContextUsage(sessionKey, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
  }, [
    sessionKey,
    environmentId,
    setClient,
    setSession,
    setContextUsage,
    setServerStatus,
  ]);

  const promoteNextQueuedPromptToDraft = useCallback(() => {
    const store = useOpenCodeStore.getState();
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
    if (nextMessage.model) {
      store.setSelectedModel(environmentId, nextMessage.model);
    }
    store.setSelectedVariant(environmentId, nextMessage.variant);
    store.setSelectedMode(sessionKey, nextMessage.mode);
  }, [environmentId, sessionKey]);

  // Handle stopping the current query
  const handleStop = useCallback(async () => {
    if (!client || !session) return;

    promoteNextQueuedPromptToDraft();
    setSessionLoading(sessionKey, false);

    const success = await abortSession(client, session.sessionId);
    if (!success) {
      console.error("[OpenCodeChatTab] Failed to abort session");
    }
  }, [client, session, sessionKey, promoteNextQueuedPromptToDraft, setSessionLoading]);

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
    async (sessionId: string) => {
      if (!client) return;

      try {
        const messages = await getSessionMessages(client, sessionId);

        tabSessionIdRef.current = sessionId;
        isInitializedRef.current = true;

        setSession(sessionKey, {
          sessionId,
          messages,
          isLoading: false,
        });

        await syncPendingRequests(client, sessionId);

        setResumeDialogOpen(false);
      } catch (error) {
        console.error("[OpenCodeChatTab] Failed to resume session:", error);
      }
    },
    [client, sessionKey, setSession, syncPendingRequests],
  );

  // Refresh models by re-fetching from the SDK client
  const refreshModels = useCallback(async () => {
    if (!client) return;

    try {
      const { models: availableModels, defaults } =
        await getModelsWithDefaults(client);
      setModels(environmentId, availableModels);

      const preferences = await getOpencodeModelPreferences().catch((error) => {
        console.warn("[OpenCodeChatTab] Failed to load model preferences:", error);
        return EMPTY_MODEL_PREFERENCES;
      });
      setModelPreferences(preferences);

      const currentModel = getSelectedModel(environmentId);
      const currentVariant = getSelectedVariant(environmentId);
      const { model: resolvedModel, variant: resolvedVariant } =
        resolveModelSelection({
          availableModels,
          defaults,
          preferences,
          currentModel,
          currentVariant,
        });

      if (resolvedModel && resolvedModel !== currentModel) {
        setSelectedModel(environmentId, resolvedModel);
      }
      if (resolvedVariant !== currentVariant) {
        setSelectedVariant(environmentId, resolvedVariant);
      }
    } catch (error) {
      console.error("[OpenCodeChatTab] Failed to refresh models:", error);
    }
  }, [
    client,
    environmentId,
    setModels,
    getSelectedModel,
    getSelectedVariant,
    setSelectedModel,
    setSelectedVariant,
  ]);

  // Render loading state
  if (setupPending) {
    return (
      <SetupPendingOverlay
        environmentId={environmentId}
        subtext="OpenCode will connect automatically once setup finishes"
      />
    );
  }

  if (connectionState === "connecting") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin" />
        <p className="text-sm">Connecting to OpenCode server...</p>
      </div>
    );
  }

  // Render error state
  if (connectionState === "error") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground p-4">
        <AlertCircle className="w-10 h-10 text-destructive" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            Connection Failed
          </p>
          <p className="text-xs mt-1 whitespace-pre-wrap break-words text-left max-w-lg">
            {errorMessage || "Unable to connect to OpenCode server"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRetry}
            className="gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </Button>
          {serverLog && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowLog(!showLog)}
            >
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
          messages={sessionMessages}
          computeItemKey={(_index, msg) => msg.id}
          renderMessage={(_index, message, prev) => (
            <NativeMessage
              message={normalizeOpenCodeNativeMessage(message)}
              previousMessage={prev ? normalizeOpenCodeNativeMessage(prev) : null}
              assistantLabel="OpenCode"
            />
          )}
          emptyState={
            !centerCompose ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-muted-foreground gap-3">
                <p className="text-sm">No messages yet. Start a conversation!</p>
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
                    <span className="text-xs">OpenCode is thinking...</span>
                    {elapsedSeconds !== null && elapsedSeconds > 0 && (
                      <span className="text-xs text-muted-foreground/50">{formatElapsed(elapsedSeconds)}</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {session && client && pendingPermissions.length > 0 && (
              <div className="max-w-3xl mx-auto min-w-0">
                {pendingPermissions.map((permission) => (
                  <OpenCodePermissionCard
                    key={permission.id}
                    permission={permission}
                    client={client}
                  />
                ))}
              </div>
            )}

            {session && client && pendingQuestions.length > 0 && (
              <div className="max-w-3xl mx-auto min-w-0">
                {pendingQuestions.map((question) => (
                  <OpenCodeQuestionCard
                    key={question.id}
                    question={question}
                    client={client}
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

        {/* Scroll to bottom button - positioned above compose bar */}
        {!isAtBottom && (
          <div className="flex justify-end px-4 py-1">
            <button
              onClick={scrollToBottom}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 shadow-sm transition-colors"
              aria-label="Scroll to bottom of conversation"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>Scroll down</span>
            </button>
          </div>
        )}
      </div>

      <NativeComposeDock
        centered={centerCompose}
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
        <OpenCodeComposeBar
          environmentId={environmentId}
          tabId={tabId}
          containerId={containerId}
          models={models}
          slashCommands={slashCommands}
          favoriteModelIds={favoriteModelIds}
          onSend={handleSend}
          disabled={!client || !session}
          isLoading={session?.isLoading ?? false}
          queueLength={queueLength}
          onStop={handleStop}
          onQueue={handleQueue}
          onRefreshModels={refreshModels}
          showAddressAll={showAddressAll}
          layout={centerCompose ? "centered" : "bottom"}
        />
      </NativeComposeDock>

      {client && (
        <OpenCodeResumeSessionDialog
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
