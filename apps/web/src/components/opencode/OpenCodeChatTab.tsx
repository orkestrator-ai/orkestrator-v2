import { toast } from "sonner";
import { createSessionKey } from "@/lib/utils";
import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { useVirtuosoScrollState, clearPersistedVirtuosoState, useElapsedTimer } from "@/hooks";
import { useEscapeToStop } from "@/hooks/useEscapeToStop";
import {
  useManualSessionRefresh,
  type RefreshSessionOptions,
} from "@/hooks/useManualSessionRefresh";
import { useNativeMessageQueue } from "@/hooks/useNativeMessageQueue";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import { useStalledTurnWatchdog } from "@/hooks/useStalledTurnWatchdog";
import { useAgentHandoff } from "@/hooks/useAgentHandoff";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import {
  OPTIMISTIC_MESSAGE_PREFIX,
  TURN_STOPPED_BY_USER,
  createOptimisticNativeMessage,
} from "@/lib/chat/client-only-messages";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useConfigStore } from "@/stores/configStore";
import { isSetupPending } from "@/lib/setup-commands";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import { claimAgentPromptQueueHead } from "@/lib/prompt-queue-sources";
import {
  checkClientHealth,
  createClient,
  getModelsWithDefaults,
  createSession,
  getSessionMessages,
  getSessionStatus,
  listSessions,
  getPendingPermissions,
  getPendingQuestions,
  getAvailableSlashCommands,
  getOpenCodeRuntimeHealth,
  forkOpenCodeSession,
  summarizeOpenCodeUsage,
  sendPrompt,
  formatOpenCodeError,
  abortSession,
  subscribeToEvents,
  normalizeOpenCodePart,
  buildOpenCodeMessageFromPart,
  collectOpenCodeSubagentIds,
  carryOverOpenCodeSubagentHydration,
  mergeOpenCodeMessageInfo,
  mergeOpenCodeSubagentTranscript,
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  type PermissionRequest,
  type QuestionRequest,
  type OpenCodeConversationMode,
  type OpenCodeMessage,
  type OpenCodeSlashCommand,
  type OpenCodeModel,
  type OpenCodeModelDefaults,
  type SendPromptResult,
} from "@/lib/opencode-client";
import { extractContextUsage } from "@/lib/context-usage";
import {
  startOpenCodeServer,
  getOpenCodeServerStatus,
  getOpenCodeServerLog,
  getOpencodeModelPreferences,
  getCachedOpenCodeModelCatalog,
  cacheOpenCodeModelCatalog,
  startLocalOpencodeServer,
  getLocalOpencodeServerStatus,
  renameEnvironmentFromPrompt,
  type OpenCodeModelPreferences,
} from "@/lib/backend";
import {
  EMPTY_OPENCODE_MODEL_PREFERENCES,
  normalizeOpenCodeModelPreferences,
  openCodeModelRefToId,
} from "@/lib/opencode-model-preferences";
import { useMessageForkAction } from "@/components/chat/MessageForkAction";
import {
  buildMessageForkPlan,
  findNextForkMessage,
  forkAttachmentNotice,
  type MessageForkKind,
} from "@/components/chat/message-fork";
import { normalizeOpenCodeNativeMessage } from "@/lib/chat/native-message-adapters";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
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
import type {
  OpenCodeAttachment,
  OpenCodeQueuedMessage,
} from "@/stores/openCodeStore";
import {
  classifyNewEnvironmentConnectionStartupError,
  getNewEnvironmentConnectionRetryDecision,
  isRetryableNewEnvironmentConnectionError,
} from "@/lib/new-environment-connection-retry";

interface OpenCodeChatTabProps {
  tabId: string;
  data: OpenCodeNativeData;
  isActive: boolean;
  /** Whether this pane currently owns document-level shortcuts. */
  ownsGlobalShortcuts?: boolean;
  /** Initial prompt to send after session creation */
  initialPrompt?: string;
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  agentHandoffId?: string;
  consumedAgentHandoffId?: string;
  refreshRequestId?: number;
}

type ConnectionState = "connecting" | "connected" | "error";

type SessionPendingRequests = {
  questions: Map<string, QuestionRequest>;
  permissions: Map<string, PermissionRequest>;
};

function readSessionPendingRequests(sessionId: string): SessionPendingRequests {
  const state = useOpenCodeStore.getState();
  const questions = new Map<string, QuestionRequest>();
  for (const question of state.pendingQuestions.values()) {
    if (question.sessionId === sessionId) questions.set(question.id, question);
  }
  const permissions = new Map<string, PermissionRequest>();
  for (const permission of state.pendingPermissions.values()) {
    if (permission.sessionId === sessionId) permissions.set(permission.id, permission);
  }
  return { questions, permissions };
}

function pendingRequestMapChanged<T>(
  before: Map<string, T>,
  after: Map<string, T>,
): boolean {
  if (before.size !== after.size) return true;
  for (const [id, value] of before) {
    if (after.get(id) !== value) return true;
  }
  return false;
}

function sessionPendingRequestsChanged(
  before: SessionPendingRequests,
  after: SessionPendingRequests,
): boolean {
  return (
    pendingRequestMapChanged(before.questions, after.questions)
    || pendingRequestMapChanged(before.permissions, after.permissions)
  );
}

const EMPTY_MODEL_PREFERENCES = EMPTY_OPENCODE_MODEL_PREFERENCES;

const EMPTY_SLASH_COMMANDS: OpenCodeSlashCommand[] = [];
const EMPTY_MODELS: OpenCodeModel[] = [];


function resolveModelSelection(input: {
  availableModels: OpenCodeModel[];
  defaults: OpenCodeModelDefaults;
  preferences: OpenCodeModelPreferences;
  currentModel: string | undefined;
  currentVariant: string | undefined;
}): { model: string | undefined; variant: string | undefined } {
  const { availableModels, defaults, preferences, currentModel, currentVariant } = input;
  const availableModelIds = new Set(availableModels.map((m) => m.id));
  const recentModelId = openCodeModelRefToId(preferences.recent[0]);

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
  ownsGlobalShortcuts = isActive,
  initialPrompt,
  isReviewTab = false,
  initialAgentModel,
  initialReasoningEffort,
  agentHandoffId,
  consumedAgentHandoffId,
  refreshRequestId = 0,
}: OpenCodeChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  // Initialize as "connected" if we already have a client and session from a previous init.
  // This avoids even a single frame of spinner when switching back to an already-connected env.
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => {
    const hasClient = useOpenCodeStore.getState().clients.has(environmentId);
    const hasSession = useOpenCodeStore.getState().sessions.has(createSessionKey(environmentId, tabId));
    return hasClient && hasSession ? "connected" : "connecting";
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const automaticInitRetryCountRef = useRef(0);
  const automaticInitRetryWindowStartedAtRef = useRef<number | null>(null);
  const setupPendingObservedForInitRetryRef = useRef(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [modelPreferences, setModelPreferences] =
    useState<OpenCodeModelPreferences>(EMPTY_MODEL_PREFERENCES);

  // Track this tab's session ID locally to prevent interference between tabs
  const tabSessionIdRef = useRef<string | null>(null);
  // Track if this tab has been initialized (to differentiate first mount vs re-activation)
  const isInitializedRef = useRef(false);
  // Track if initial prompt has been sent (to prevent duplicate sends)
  const initialPromptSentRef = useRef(false);
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(initialAgentModel || initialReasoningEffort),
  );
  /**
   * Whether initialization has finished deciding what to do with the one-shot
   * launch options.
   *
   * Validating them can require a catalogue fetch, and the initial-prompt
   * effect below runs on its own schedule — on a warm client it can fire before
   * that fetch resolves. Without this gate the prompt would race ahead and
   * dispatch with the server default while the user's explicit choice was
   * still being validated.
   */
  const [launchOptionsSettled, setLaunchOptionsSettled] = useState(
    () => !initialLaunchOptionsPendingRef.current,
  );
  // Track when we are currently draining queued prompts
  const manualRefreshSequenceRef = useRef(0);
  /**
   * Bumped by *every* refresh, manual or watchdog-driven.
   *
   * A background reconcile is invalidated by anything newer; a manual one is
   * only invalidated by a newer *manual* refresh. Sharing one counter made an
   * overlapping watchdog tick turn the user's refresh into a silent no-op.
   */
  const backgroundRefreshSequenceRef = useRef(0);
  // Ref to store handleSend for use in effects without causing re-runs
  const handleSendRef = useRef<
    ((
      text: string,
      attachments: OpenCodeAttachment[],
      options?: {
        model?: string;
        variant?: string;
        mode?: OpenCodeConversationMode;
        requestId?: string;
      },
    ) => Promise<SendPromptResult | undefined>) | null
  >(null);

  // Narrow, per-key subscriptions (mirrors CodexChatTab): store actions are
  // referentially stable, and value reads are scoped so unrelated store writes
  // (other environments, other sessions) no longer re-render this tab.
  const setClient = useOpenCodeStore((state) => state.setClient);
  const setModels = useOpenCodeStore((state) => state.setModels);
  const setSession = useOpenCodeStore((state) => state.setSession);
  const addMessage = useOpenCodeStore((state) => state.addMessage);
  const removeMessage = useOpenCodeStore((state) => state.removeMessage);
  const setMessages = useOpenCodeStore((state) => state.setMessages);
  const upsertMessage = useOpenCodeStore((state) => state.upsertMessage);
  const setSessionLoading = useOpenCodeStore((state) => state.setSessionLoading);
  const setServerStatus = useOpenCodeStore((state) => state.setServerStatus);
  const setSelectedModel = useOpenCodeStore((state) => state.setSelectedModel);
  const setSelectedVariant = useOpenCodeStore((state) => state.setSelectedVariant);
  const setSlashCommands = useOpenCodeStore((state) => state.setSlashCommands);
  const getSelectedModel = useOpenCodeStore((state) => state.getSelectedModel);
  const getSelectedVariant = useOpenCodeStore((state) => state.getSelectedVariant);
  const getSelectedMode = useOpenCodeStore((state) => state.getSelectedMode);
  const setContextUsage = useOpenCodeStore((state) => state.setContextUsage);
  const setSessionTitle = useOpenCodeStore((state) => state.setSessionTitle);
  const setRuntimeHealth = useOpenCodeStore((state) => state.setRuntimeHealth);
  const addToQueue = useOpenCodeStore((state) => state.addToQueue);
  const addPendingPermission = useOpenCodeStore((state) => state.addPendingPermission);
  const addPendingQuestion = useOpenCodeStore((state) => state.addPendingQuestion);
  const removePendingPermission = useOpenCodeStore(
    (state) => state.removePendingPermission,
  );
  const removePendingQuestion = useOpenCodeStore(
    (state) => state.removePendingQuestion,
  );
  // Event subscription management (shared per environment)
  const getOrCreateEventSubscription = useOpenCodeStore(
    (state) => state.getOrCreateEventSubscription,
  );
  const setEventStream = useOpenCodeStore((state) => state.setEventStream);
  const hasActiveEventSubscription = useOpenCodeStore(
    (state) => state.hasActiveEventSubscription,
  );
  const closeEventSubscription = useOpenCodeStore(
    (state) => state.closeEventSubscription,
  );
  // Pending-request maps stay map-level subscriptions: the filtered views below
  // need to react to any entry for this session appearing or disappearing.
  const pendingPermissionsMap = useOpenCodeStore((state) => state.pendingPermissions);
  const pendingQuestionsMap = useOpenCodeStore((state) => state.pendingQuestions);

  const clearTabInitialPrompt = usePaneLayoutStore(
    (state) => state.clearTabInitialPrompt,
  );
  const clearTabInitialAgentOptions = usePaneLayoutStore(
    (state) => state.clearTabInitialAgentOptions,
  );
  const clearTabAgentHandoff = usePaneLayoutStore(
    (state) => state.clearTabAgentHandoff,
  );
  const updateTabNativeSessionId = usePaneLayoutStore(
    (state) => state.updateTabNativeSessionId,
  );

  // Create a unique session key that combines environmentId and tabId
  // This prevents session collisions when multiple environments use the same tab IDs (e.g., "default")
  const sessionKey = useMemo(
    () => createSessionKey(environmentId, tabId),
    [environmentId, tabId],
  );
  useNativeComposeDraftPersistence("opencode", environmentId, sessionKey, useOpenCodeStore);

  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);

  // Get client for this environment (shared per environment). Per-key selector:
  // re-renders only when this environment's client changes.
  const client = useOpenCodeStore(
    useCallback((state) => state.clients.get(environmentId), [environmentId]),
  );
  // Get session keyed by sessionKey (each tab has its own session, scoped by environment)
  const session = useOpenCodeStore(
    useCallback((state) => state.sessions.get(sessionKey), [sessionKey]),
  );

  const forkInFlightRef = useRef(false);
  const [forkInFlight, setForkInFlight] = useState(false);

  const sessionMessages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const providerDisplayMessages = useMemo(
    () => pinActiveNativeAgentParts(
      sessionMessages.map(normalizeOpenCodeNativeMessage),
    ),
    [sessionMessages],
  );
  const handoff = useAgentHandoff(
    agentHandoffId,
    "opencode",
    environmentId,
    providerDisplayMessages,
    consumedAgentHandoffId,
  );
  const displayMessages = handoff.displayMessages;
  const launchPrompt = initialPrompt ?? handoff.initialPrompt;
  /*
   * Read through a ref inside the initialization effect. `launchPrompt` resolves
   * a few milliseconds after mount for a handoff tab, so listing it as a
   * dependency would tear down and restart an in-flight connect; `handoffPending`
   * flips once and is the correct gate.
   */
  const handoffPending = !handoff.ready;
  const launchPromptRef = useRef<string | undefined>(undefined);
  launchPromptRef.current = launchPrompt;
  const forkPlan = useMemo(
    () => buildMessageForkPlan(providerDisplayMessages, {
      responseInProgress: session?.isLoading ?? false,
      /*
       * OpenCode's boundary is exclusive: it clones the messages *before*
       * messageID. A prompt therefore branches at its own id, while a response
       * branches at the message after it — or, when it ends the transcript, at
       * no boundary at all, which clones everything.
       */
      resolvePromptBoundary: (message) => ({
        type: "message",
        messageId: message.id,
      }),
      resolveResponseBoundary: (message, messages) => {
        const next = findNextForkMessage(messages, message.id);
        return next
          ? { type: "message", messageId: next.id }
          : { type: "whole-session" };
      },
    }),
    [providerDisplayMessages, session?.isLoading],
  );
  // Read by the fork handler so it does not have to depend on the transcript:
  // `displayMessages` is a fresh array on every streaming tick, and a handler
  // that changed with it would rebuild every fork button on every tick.
  const forkPlanRef = useRef(forkPlan);
  forkPlanRef.current = forkPlan;
  const hasMessageHistory = displayMessages.length > 0;
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
    stickToBottomOnActivation: true,
  });

  // Get pending questions for this session - subscribe to the Map for reactivity
  const pendingQuestions = useMemo(() => {
    if (!session?.sessionId) return [];
    const questions: QuestionRequest[] = [];
    for (const question of pendingQuestionsMap.values()) {
      if (question.sessionId === session.sessionId) {
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
      if (permission.sessionId === session.sessionId) {
        permissions.push(permission);
      }
    }
    return permissions;
  }, [session?.sessionId, pendingPermissionsMap]);

  const favoriteModelIds = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const favorite of modelPreferences.favorite) {
      const modelId = openCodeModelRefToId(favorite);
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
  const projectId = useEnvironmentStore(
    useCallback(
      (state) => state.getEnvironmentById(environmentId)?.projectId.trim() ?? "",
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
  const resolveModelLabel = useCallback(
    (modelId: string) => resolveCatalogModelLabel(modelId, models),
    [models],
  );

  // Rehydrate a last-known-good catalogue before a server finishes starting.
  // The authoritative live fetch below replaces it as soon as one is available.
  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    void getCachedOpenCodeModelCatalog(projectId)
      .then((snapshot) => {
        if (
          cancelled ||
          !snapshot?.models.length ||
          useOpenCodeStore.getState().getModels(environmentId).length > 0
        ) {
          return;
        }
        setModels(environmentId, snapshot.models, "cache");
      })
      .catch((error) => {
        console.warn("[OpenCodeChatTab] Failed to load cached models:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, projectId, setModels]);

  /**
   * Fingerprint of every token-bearing field the usage summary reads.
   *
   * `sessionMessages` is a fresh array on every streaming frame, but the
   * usage-relevant fields only change when a turn reports tokens (typically at
   * completion). Keying the effect on this fingerprint instead of the array
   * keeps `summarizeOpenCodeUsage` + the store write off the per-frame path
   * while still recomputing the moment any turn's usage lands or changes.
   */
  const usageFingerprint = useMemo(() => {
    let fingerprint = "";
    for (const message of sessionMessages) {
      const usage = message.providerUsage;
      if (!usage) continue;
      fingerprint += `${message.id}|${usage.modelId}|${usage.totalTokens ?? ""}|${usage.inputTokens}|${usage.outputTokens}|${usage.reasoningTokens}|${usage.cacheReadTokens}|${usage.cacheWriteTokens}|${usage.cost}|${usage.durationMs ?? ""};`;
    }
    return fingerprint;
  }, [sessionMessages]);
  const sessionMessagesRef = useRef(sessionMessages);
  sessionMessagesRef.current = sessionMessages;

  useEffect(() => {
    const usage = summarizeOpenCodeUsage(sessionMessagesRef.current, models);
    if (usage) setContextUsage(sessionKey, usage);
    // The transcript itself is read through a ref: every input the summary
    // depends on is captured by `usageFingerprint` and `models`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, sessionKey, usageFingerprint, setContextUsage]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void getOpenCodeRuntimeHealth(
      client,
      slashCommandDirectory,
      session?.sessionId,
    )
      .then((health) => {
        if (cancelled) return;
        // The inventory half (agents/MCP/skills/LSP/formatters) is environment
        // wide, so it stays on the environment key. `todos` and `diffs` are
        // scoped to `session?.sessionId`, and every OpenCode tab in this
        // environment writes to that same environment key — last write wins.
        // Mirroring the snapshot onto the session key gives the agent-info
        // popover a per-session read that a sibling tab cannot clobber.
        setRuntimeHealth(environmentId, health);
        if (session?.sessionId) setRuntimeHealth(sessionKey, health);
      })
      .catch((error) => {
        console.warn("[OpenCodeChatTab] Failed to load runtime health:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    environmentId,
    session?.sessionId,
    sessionKey,
    setRuntimeHealth,
    slashCommandDirectory,
  ]);

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
      options: {
        throwOnError?: boolean;
        /**
         * Whether a live frame landing mid-sync is an error.
         *
         * Separate from `throwOnError` so a background reconcile can still let
         * *fetch* failures propagate (its caller logs them) while treating a
         * raced snapshot as "try again later" rather than a user-facing error.
         */
        throwOnStale?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ): Promise<boolean> => {
      const pendingBeforeSync = readSessionPendingRequests(sessionId);

      let questions: QuestionRequest[];
      let permissions: PermissionRequest[];
      try {
        [questions, permissions] = await Promise.all([
          // An empty authoritative snapshot means "remove every old card"; a
          // transport fallback must never be allowed to masquerade as one.
          getPendingQuestions(sdkClient, { throwOnError: true }),
          getPendingPermissions(sdkClient, { throwOnError: true }),
        ]);
      } catch (error) {
        console.error(
          "[OpenCodeChatTab] Failed to synchronize pending requests:",
          error,
        );
        if (options.throwOnError) throw error;
        return false;
      }
      if (options.shouldApply && !options.shouldApply()) return false;

      const stateAfterSync = useOpenCodeStore.getState();
      if (
        stateAfterSync.clients.get(environmentId) !== sdkClient
        || stateAfterSync.sessions.get(sessionKey)?.sessionId !== sessionId
      ) {
        return false;
      }

      const pendingAfterSync = readSessionPendingRequests(sessionId);
      if (sessionPendingRequestsChanged(pendingBeforeSync, pendingAfterSync)) {
        if (options.throwOnStale ?? options.throwOnError) {
          throw new Error(
            "OpenCode pending requests changed while refreshing; try again",
          );
        }
        return false;
      }

      const questionIds = new Set<string>();
      for (const question of questions) {
        if (question.sessionId !== sessionId) continue;
        questionIds.add(question.id);
        addPendingQuestion(question);
      }

      const permissionIds = new Set<string>();
      for (const permission of permissions) {
        if (permission.sessionId !== sessionId) continue;
        permissionIds.add(permission.id);
        addPendingPermission(permission);
      }

      for (const existingQuestionId of pendingBeforeSync.questions.keys()) {
        if (!questionIds.has(existingQuestionId)) {
          removePendingQuestion(existingQuestionId);
        }
      }

      for (const existingPermissionId of pendingBeforeSync.permissions.keys()) {
        if (!permissionIds.has(existingPermissionId)) {
          removePendingPermission(existingPermissionId);
        }
      }

      return true;
    },
    [
      addPendingPermission,
      addPendingQuestion,
      environmentId,
      removePendingPermission,
      removePendingQuestion,
      sessionKey,
    ],
  );

  const refreshSessionFromServer = useCallback(async (
    { manual = false }: RefreshSessionOptions = {},
  ) => {
    const stateBeforeRefresh = useOpenCodeStore.getState();
    const activeClient = stateBeforeRefresh.clients.get(environmentId);
    const activeSession = stateBeforeRefresh.sessions.get(sessionKey);
    if (!activeClient || !activeSession?.sessionId) return;

    const sessionId = activeSession.sessionId;
    const backgroundSequence = ++backgroundRefreshSequenceRef.current;
    const manualSequence = manual
      ? ++manualRefreshSequenceRef.current
      : manualRefreshSequenceRef.current;
    const shouldApply = manual
      ? () => manualSequence === manualRefreshSequenceRef.current
      : () => backgroundSequence === backgroundRefreshSequenceRef.current;

    const stateBeforeAttempt = useOpenCodeStore.getState();
    const sessionBeforeAttempt = stateBeforeAttempt.sessions.get(sessionKey);
    if (
      stateBeforeAttempt.clients.get(environmentId) !== activeClient ||
      sessionBeforeAttempt?.sessionId !== sessionId
    ) {
      return;
    }

    const [messages, status] = await Promise.all([
      getSessionMessages(activeClient, sessionId, { throwOnError: true }),
      getSessionStatus(activeClient, sessionId, { throwOnError: true }),
    ]);
    if (!shouldApply()) return;

    const stateAfterAttempt = useOpenCodeStore.getState();
    const sessionAfterAttempt = stateAfterAttempt.sessions.get(sessionKey);
    if (
      stateAfterAttempt.clients.get(environmentId) !== activeClient ||
      sessionAfterAttempt?.sessionId !== sessionId
    ) {
      return;
    }
    if (sessionAfterAttempt !== sessionBeforeAttempt) {
      /**
       * The snapshot is older than a frame that already landed; applying it
       * would let a stale `busy` status re-lock a session that just went idle.
       * A manual refresh reports this so the user can retry; the watchdog
       * stays silent and re-checks once activity goes stale again.
       */
      if (manual) {
        throw new Error("OpenCode session changed while refreshing; try again");
      }
      return;
    }

    setMessages(sessionKey, messages);
    if (status) {
      setSessionLoading(sessionKey, status !== "idle");
    }
    await syncPendingRequests(activeClient, sessionId, {
      throwOnError: true,
      throwOnStale: manual,
      shouldApply,
    });
  }, [
    environmentId,
    sessionKey,
    setMessages,
    setSessionLoading,
    syncPendingRequests,
  ]);

  useManualSessionRefresh({
    refreshRequestId,
    isReady:
      connectionState === "connected" && !!client && !!session?.sessionId,
    agentLabel: "OpenCode",
    refresh: refreshSessionFromServer,
  });

  useStalledTurnWatchdog({
    agentLabel: "OpenCode",
    isLoading: session?.isLoading ?? false,
    isReady:
      connectionState === "connected" && !!client && !!session?.sessionId,
    // Every SSE frame replaces the session object, so a session reference that
    // stops changing is exactly the stall this watchdog exists to catch. An
    // applied reconcile replaces it too, so the staleness clock alone cannot
    // bound the poll rate — `minReconcileIntervalMs` (defaulted in the hook) is
    // what keeps a quiet turn from becoming a sustained poll loop.
    activitySignal: session,
    // Explicitly background: superseded by any newer refresh rather than
    // superseding the user's own.
    reconcile: () => refreshSessionFromServer({ manual: false }),
  });

  // Initialize connection on mount.
  // Active tabs always initialize; inactive tabs initialize too when a launch
  // or handoff prompt is pending, so background mounts can dispatch it before
  // becoming visible.
  useEffect(() => {
    if (handoffPending) return;
    if (!isActive && !launchPromptRef.current?.trim() && queueLength === 0) {
      return;
    }

    // Block initialization until setup scripts finish (local environments with orkestrator-ai.json)
    if (setupPending) {
      setupPendingObservedForInitRetryRef.current = true;
      return;
    }

    if (automaticInitRetryWindowStartedAtRef.current === null) {
      const environment = useEnvironmentStore
        .getState()
        .getEnvironmentById(environmentId);
      const initialDecision = getNewEnvironmentConnectionRetryDecision({
        createdAt: environment?.createdAt,
        attempt: 0,
        retryWindowStartedAt: null,
        setupPendingObserved: setupPendingObservedForInitRetryRef.current,
      });
      if (initialDecision) {
        automaticInitRetryWindowStartedAtRef.current =
          initialDecision.retryWindowStartedAt;
      }
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
        let existingClient = useOpenCodeStore.getState().clients.get(environmentId);
        const existingSession = useOpenCodeStore.getState().sessions.get(sessionKey);
        if (existingClient && !await checkClientHealth(existingClient)) {
          if (!mounted) return;
          // A restarted OpenCode server rotates its Basic credential. Keeping
          // this SDK client would make both REST rehydration and the shared SSE
          // loop retry the obsolete password forever.
          closeEventSubscription(environmentId);
          setClient(environmentId, null);
          existingClient = undefined;
        }
        /**
         * Seed this sessionKey's model/variant before either warm path returns.
         *
         * Only the cold path below fetches the model catalogue, so a tab that
         * finds a warm client — a second tab in the environment, or one
         * reopened after `clearSession` — would otherwise never seed its own
         * sessionKey-keyed selection: the compose bar shows "Select model" and
         * `handleSend` sends `model: undefined`, silently falling back to
         * whatever the server happens to default to.
         */
        const pendingLaunchOptions = initialLaunchOptionsPendingRef.current;
        if (
          existingClient &&
          (pendingLaunchOptions || !getSelectedModel(sessionKey))
        ) {
          /**
           * Only a *live* catalogue may be used here. One rehydrated from the
           * durable project cache has the same shape but cannot prove the
           * running server advertises those ids, so pinning one would send a
           * model the server may reject.
           */
          let liveModels = useOpenCodeStore.getState().hasLiveModels(environmentId)
            ? useOpenCodeStore.getState().getModels(environmentId)
            : EMPTY_MODELS;

          /**
           * A one-shot launch option is the user's explicit choice and is
           * consumed exactly once. Rather than drop it because this path
           * normally skips the catalogue fetch, pay for a single fetch so it
           * can be validated and acknowledged — nothing else on the warm path
           * ever refreshes the catalogue, so deferring here means never.
           */
          if (pendingLaunchOptions && liveModels.length === 0) {
            // Best-effort: failing to validate a launch option must not turn a
            // reconnect that would otherwise have worked into a broken tab.
            const { models: refreshedModels } = await getModelsWithDefaults(
              existingClient,
            ).catch((error) => {
              console.warn(
                "[OpenCodeChatTab] Failed to load models for launch options:",
                error,
              );
              return { models: EMPTY_MODELS, defaults: {} };
            });
            if (!mounted) return;
            if (refreshedModels.length > 0) {
              setModels(environmentId, refreshedModels);
              liveModels = refreshedModels;
              if (projectId) {
                void cacheOpenCodeModelCatalog(projectId, refreshedModels).catch(
                  (error) => {
                    console.warn("[OpenCodeChatTab] Failed to cache models:", error);
                  },
                );
              }
            }
          }

          if (liveModels.length > 0) {
            const { model: resolvedModel, variant: resolvedVariant } =
              resolveModelSelection({
                availableModels: liveModels,
                defaults: {},
                preferences: pendingLaunchOptions
                  ? EMPTY_MODEL_PREFERENCES
                  : modelPreferences,
                currentModel: pendingLaunchOptions
                  ? initialLaunchOptionsRef.current.model
                  : // No launch option to honour, so fall back to the user's
                    // global OpenCode default — the same value the compose bar
                    // persists whenever a model is picked.
                    useConfigStore.getState().config.global.opencodeModel,
                currentVariant: pendingLaunchOptions
                  ? initialLaunchOptionsRef.current.reasoningEffort
                  : getSelectedVariant(sessionKey),
              });
            if (resolvedModel) setSelectedModel(sessionKey, resolvedModel);
            setSelectedVariant(sessionKey, resolvedVariant);
            if (pendingLaunchOptions) {
              acknowledgeInitialLaunchOptions();
            }
          }
          // A server that reports no catalogue at all cannot validate anything.
          // Keep the one-shot options pending — the tab holds the only durable
          // copy — and let the initial prompt fall back to the server default.
          setLaunchOptionsSettled(true);
        }
        if (existingClient && existingSession?.sessionId) {
          console.debug("[OpenCodeChatTab] Fast reconnect - reusing existing client and session", {
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

          // The subscription may have progressed while this React tree was
          // inactive. Rehydrate from the authoritative parent and child
          // session transcripts without delaying the fast reconnect UI.
          // A reconnect resets the session, so every refresh already in flight
          // is stale — invalidate both sequences, not just the manual one.
          const reconnectSequence = ++manualRefreshSequenceRef.current;
          backgroundRefreshSequenceRef.current += 1;
          void Promise.all([
            getSessionMessages(existingClient, existingSession.sessionId, {
              throwOnError: true,
            }),
            getSessionStatus(existingClient, existingSession.sessionId, {
              throwOnError: true,
            }),
            // Pending requests are equally authoritative. A tab can have been
            // unmounted when the upstream SSE frame arrived, and a cached
            // client/session fast path must not leave that blocked request
            // invisible until the watchdog runs.
            syncPendingRequests(existingClient, existingSession.sessionId, {
              shouldApply: () =>
                mounted
                && reconnectSequence === manualRefreshSequenceRef.current,
            }),
          ]).then(([messages, status]) => {
            if (
              !mounted ||
              reconnectSequence !== manualRefreshSequenceRef.current
            ) return;
            const currentState = useOpenCodeStore.getState();
            const currentSession = currentState.sessions.get(sessionKey);
            if (
              currentState.clients.get(environmentId) !== existingClient ||
              currentSession?.sessionId !== existingSession.sessionId ||
              currentSession !== existingSession
            ) {
              return;
            }
            // An empty reconnect response must not erase a transcript that
            // received a live update after this request started.
            if (messages.length > 0) setMessages(sessionKey, messages);
            if (status) setSessionLoading(sessionKey, status !== "idle");
          }).catch((error) => {
            console.warn("[OpenCodeChatTab] Fast reconnect rehydration failed:", error);
          });
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

          if (data.sessionId) {
            const availableSessions = await listSessions(existingClient);
            if (availableSessions.some((session) => session.id === data.sessionId)) {
              const messages = await getSessionMessages(existingClient, data.sessionId);
              if (!mounted) return;
              tabSessionIdRef.current = data.sessionId;
              updateTabNativeSessionId(tabId, data.sessionId, environmentId);
              isInitializedRef.current = true;
              setSession(sessionKey, {
                sessionId: data.sessionId,
                messages,
                isLoading: false,
              });
              setConnectionState("connected");
              if (!hasActiveEventSubscription(environmentId)) {
                startSharedEventSubscription(existingClient);
              }
              await syncPendingRequests(existingClient, data.sessionId);
              return;
            }
            updateTabNativeSessionId(tabId, undefined, environmentId);
          }

          const newSession = await createSession(existingClient);
          if (!mounted) return;

          if (!newSession) {
            throw new Error("Failed to create OpenCode session");
          }

          tabSessionIdRef.current = newSession.id;
          updateTabNativeSessionId(tabId, newSession.id, environmentId);
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
        let authToken: string | undefined;

        if (isLocal) {
          // Local environment - use local server commands
          let localStatus;
          try {
            localStatus = await getLocalOpencodeServerStatus(environmentId);
          } catch (error) {
            throw classifyNewEnvironmentConnectionStartupError(error);
          }

          if (!localStatus.running) {
            const result = await startLocalOpencodeServer(environmentId);
            localStatus = {
              running: true,
              port: result.port,
              pid: result.pid,
              authToken: result.authToken,
            };
          }

          if (!mounted) return;

          if (!localStatus.port) {
            throw new Error("Local server started but no port available");
          }

          hostPort = localStatus.port;
          authToken = localStatus.authToken;
        } else {
          // Containerized environment - use container server commands
          if (!containerId) {
            throw new Error(
              "Container ID is required for containerized environments",
            );
          }

          let status;
          try {
            status = await getOpenCodeServerStatus(containerId);
          } catch (error) {
            throw classifyNewEnvironmentConnectionStartupError(error);
          }

          if (!status.running) {
            const result = await startOpenCodeServer(containerId);
            status = {
              running: true,
              hostPort: result.hostPort,
              authToken: result.authToken,
            };
          }

          if (!mounted) return;

          if (!status.hostPort) {
            throw new Error("Server started but no port available");
          }

          hostPort = status.hostPort;
          authToken = status.authToken;
        }

        if (!hostPort) {
          throw new Error("Failed to get server port");
        }
        if (!authToken) {
          throw new Error("OpenCode server did not return an authentication credential");
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
        const sdkClient = createClient(baseUrl, undefined, authToken);
        setClient(environmentId, sdkClient);

        // Fetch available models, server defaults, and model preferences
        const [{ models: availableModels, defaults }, rawPreferences] =
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

        // Only a live catalogue is authoritative. When the server reports an
        // empty one, whatever the durable cache seeded stays on screen for the
        // picker, but nothing is pinned to this session and the one-shot launch
        // options are not consumed against it.
        const hasLiveCatalog = availableModels.length > 0;
        if (hasLiveCatalog) {
          setModels(environmentId, availableModels);
          if (projectId) {
            void cacheOpenCodeModelCatalog(projectId, availableModels).catch((error) => {
              console.warn("[OpenCodeChatTab] Failed to cache models:", error);
            });
          }
        }
        const preferences = normalizeOpenCodeModelPreferences(rawPreferences);
        setModelPreferences(preferences);

        // Initialize selected model/variant while preserving valid user-selected values.
        const pendingInitialOptions = initialLaunchOptionsPendingRef.current
          ? initialLaunchOptionsRef.current
          : undefined;
        if (hasLiveCatalog) {
          const currentModel = pendingInitialOptions
            ? pendingInitialOptions.model
            : getSelectedModel(sessionKey);
          const currentVariant = pendingInitialOptions
            ? pendingInitialOptions.reasoningEffort
            : getSelectedVariant(sessionKey);
          const { model: resolvedModel, variant: resolvedVariant } =
            resolveModelSelection({
              availableModels,
              defaults,
              preferences,
              currentModel,
              currentVariant,
            });
          if (resolvedModel && resolvedModel !== getSelectedModel(sessionKey)) {
            setSelectedModel(sessionKey, resolvedModel);
          }

          if (resolvedVariant !== getSelectedVariant(sessionKey)) {
            setSelectedVariant(sessionKey, resolvedVariant);
          }
          if (pendingInitialOptions) {
            acknowledgeInitialLaunchOptions();
          }
        }
        setLaunchOptionsSettled(true);

        // Check for existing session - first from component ref, then from Zustand store
        // This handles reconnection after tab remount where refs are lost but store persists
        const existingSessionFromRef = tabSessionIdRef.current;
        const existingSessionFromStore = useOpenCodeStore
          .getState()
          .sessions.get(sessionKey);
        let existingSessionId =
          existingSessionFromRef || existingSessionFromStore?.sessionId || data.sessionId;

        if (existingSessionId) {
          const availableSessions = await listSessions(sdkClient);
          if (!availableSessions.some((session) => session.id === existingSessionId)) {
            updateTabNativeSessionId(tabId, undefined, environmentId);
            existingSessionId = undefined;
          }
        }

        if (existingSessionId) {
          // Restore session from store - component may have remounted
          tabSessionIdRef.current = existingSessionId;
          updateTabNativeSessionId(tabId, existingSessionId, environmentId);
          isInitializedRef.current = true;
          setConnectionState("connected");

          // Start shared event subscription if not already running
          startSharedEventSubscription(sdkClient);

          // Sync pending interactions in case we missed early SSE events
          await syncPendingRequests(sdkClient, existingSessionId);

          // Refresh messages from server to ensure latest state on reconnection.
          // A restored pane on a new client has no in-memory session yet, so it
          // must hydrate the transcript rather than installing an empty shell.
          try {
            const messages = await getSessionMessages(
              sdkClient,
              existingSessionId,
            );
            if (!mounted) return;

            if (existingSessionFromStore) {
              // setMessages preserves client-side error messages (ERROR_MESSAGE_PREFIX)
              // from the existing session state when replacing server messages.
              setMessages(sessionKey, messages);
            } else {
              setSession(sessionKey, {
                sessionId: existingSessionId,
                messages,
                isLoading: false,
              });
            }
          } catch (err) {
            if (existingSessionFromStore) {
              console.warn(
                "[OpenCodeChatTab] Failed to refresh messages on reconnect:",
                err,
              );
              // Keep existing messages from store if refresh fails
            } else {
              throw err;
            }
          }
        } else {
          // First initialization - create a new session
          const newSession = await createSession(sdkClient);
          if (!mounted) return;

          // Store the session ID in the ref for future re-activations
          tabSessionIdRef.current = newSession.id;
          updateTabNativeSessionId(tabId, newSession.id, environmentId);
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
        if (!mounted) return;
        // Extract error message with structured details when available.
        let message = isRetryableNewEnvironmentConnectionError(error)
          ? error.message
          : formatOpenCodeError(error);
        // Add hint for port mapping issues
        if (message.includes("port") && message.includes("not mapped")) {
          message +=
            ". Try recreating the environment to enable native mode support.";
        }
        const environment = useEnvironmentStore
          .getState()
          .getEnvironmentById(environmentId);
        const retryDecision = isRetryableNewEnvironmentConnectionError(error)
          ? getNewEnvironmentConnectionRetryDecision({
              createdAt: environment?.createdAt,
              attempt: automaticInitRetryCountRef.current,
              retryWindowStartedAt: automaticInitRetryWindowStartedAtRef.current,
              setupPendingObserved: setupPendingObservedForInitRetryRef.current,
            })
          : null;
        if (retryDecision !== null) {
          const { delayMs, retryWindowStartedAt } = retryDecision;
          automaticInitRetryWindowStartedAtRef.current = retryWindowStartedAt;
          automaticInitRetryCountRef.current += 1;
          console.warn(
            `[OpenCodeChatTab] Retrying new environment connection in ${delayMs}ms:`,
            message,
          );
          setClient(environmentId, null);
          setConnectionState("connecting");
          setErrorMessage(null);
          window.setTimeout(() => {
            if (mounted) setInitAttempt((value) => value + 1);
          }, delayMs);
          return;
        }

        console.error("[OpenCodeChatTab] Initialization failed:", error);
        setConnectionState("error");
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
    projectId,
    tabId,
    isActive,
    handoffPending,
    isLocal,
    queueLength,
    syncPendingRequests,
    getSelectedModel,
    getSelectedVariant,
    acknowledgeInitialLaunchOptions,
    setSelectedModel,
    setSelectedVariant,
    setupPending,
    initAttempt,
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
      const lastReloadTimeBySession = new Map<string, number>();
      const pendingReloads = new Map<string, NodeJS.Timeout>();
      const reloadGenerationByKey = new Map<string, number>();

      const beginReloadGeneration = (reloadKey: string) => {
        const generation = (reloadGenerationByKey.get(reloadKey) ?? 0) + 1;
        reloadGenerationByKey.set(reloadKey, generation);
        return generation;
      };

      const isCurrentReload = (reloadKey: string, generation: number) =>
        !abortController.signal.aborted &&
        reloadGenerationByKey.get(reloadKey) === generation;

      try {
        const eventStream = await subscribeToEvents(sdkClient);
        if (!eventStream || abortController.signal.aborted) {
          return;
        }

        // Store stream reference in the store for cleanup
        setEventStream(environmentId, eventStream);

        const DEBOUNCE_MS = 200; // Debounce all message fetches

        const refreshSubagentTranscript = async (
          childSessionId: string,
          reloadKey: string,
          generation: number,
          state?: "success" | "failure" | "pending",
        ) => {
          let childMessages: OpenCodeMessage[];
          try {
            childMessages = await getSessionMessages(sdkClient, childSessionId, {
              throwOnError: true,
            });
          } catch (error) {
            console.warn(
              "[OpenCodeChatTab] Failed to refresh subagent transcript:",
              error,
            );
            return;
          }
          if (!isCurrentReload(reloadKey, generation)) return;

          const sessions = useOpenCodeStore.getState().sessions;
          for (const [sessionTabId, sessionState] of sessions) {
            if (!collectOpenCodeSubagentIds(sessionState.messages).has(childSessionId)) {
              continue;
            }
            const messages = mergeOpenCodeSubagentTranscript(
              sessionState.messages,
              childSessionId,
              childMessages,
              state,
            );
            if (messages !== sessionState.messages) {
              setMessages(sessionTabId, messages);
            }
          }
        };

        const fetchSubagentMessagesDebounced = (
          childSessionId: string,
          immediate = false,
          state?: "success" | "failure" | "pending",
        ) => {
          const reloadKey = `subagent:${childSessionId}`;
          const generation = beginReloadGeneration(reloadKey);
          const pendingTimeout = pendingReloads.get(reloadKey);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(reloadKey);
          }

          const doFetch = () => {
            pendingReloads.delete(reloadKey);
            lastReloadTimeBySession.set(reloadKey, Date.now());
            void refreshSubagentTranscript(
              childSessionId,
              reloadKey,
              generation,
              state,
            );
          };
          if (immediate) {
            doFetch();
            return;
          }

          const lastTime = lastReloadTimeBySession.get(reloadKey) || 0;
          if (Date.now() - lastTime > DEBOUNCE_MS) {
            doFetch();
          } else {
            const timeout = setTimeout(doFetch, DEBOUNCE_MS);
            pendingReloads.set(reloadKey, timeout);
          }
        };

        // Helper to fetch messages with debouncing
        // Note: sessionKey is the session key from the sessions Map (e.g., "env-{envId}:{tabId}")
        //
        // Final events (`immediate`) fetch the fully hydrated transcript,
        // subagents included — they are the authoritative reconcile point.
        // Streaming-triggered refetches skip the recursive subagent hydration
        // (`includeSubagents: false`): the live child updates are covered by
        // `fetchSubagentMessagesDebounced`, and already-hydrated Agent rows are
        // carried over so they do not blank until the final reconcile.
        const fetchMessagesDebounced = (
          sessionId: string,
          sessionKey: string,
          immediate = false,
        ) => {
          const reloadKey = `session:${sessionId}:${sessionKey}`;
          const generation = beginReloadGeneration(reloadKey);
          // Clear any pending reload for this session
          const pendingTimeout = pendingReloads.get(reloadKey);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(reloadKey);
          }

          const includeSubagents = immediate;
          const doFetch = async () => {
            pendingReloads.delete(reloadKey);
            const now = Date.now();
            lastReloadTimeBySession.set(reloadKey, now);
            try {
              const messages = await getSessionMessages(sdkClient, sessionId, {
                throwOnError: true,
                ...(includeSubagents ? {} : { includeSubagents: false }),
              });
              if (!isCurrentReload(reloadKey, generation)) return;
              const currentSession = useOpenCodeStore
                .getState()
                .sessions.get(sessionKey);
              if (currentSession?.sessionId !== sessionId) return;
              setMessages(
                sessionKey,
                includeSubagents
                  ? messages
                  : carryOverOpenCodeSubagentHydration(
                      currentSession.messages,
                      messages,
                    ),
              );
            } catch (error) {
              console.warn(
                "[OpenCodeChatTab] Failed to refresh session transcript:",
                error,
              );
            }
          };

          if (immediate) {
            // For final events (session.idle), fetch immediately
            doFetch();
          } else {
            // For streaming events, debounce
            const now = Date.now();
            const lastTime = lastReloadTimeBySession.get(reloadKey) || 0;
            if (now - lastTime > DEBOUNCE_MS) {
              // Enough time has passed, fetch now
              doFetch();
            } else {
              // Schedule a fetch after debounce period
              const timeout = setTimeout(doFetch, DEBOUNCE_MS);
              pendingReloads.set(reloadKey, timeout);
            }
          }
        };

        /**
         * Sessions whose `message.part.updated` frames are currently applying
         * cleanly. While a session streams via parts, `message.updated` and
         * `session.updated` frames carry nothing the parts don't (bar
         * message-level metadata, which is applied incrementally below), so
         * the full-transcript refetch is skipped for them. The flag is cleared
         * on any part-application failure and on final events, both of which
         * fall back to the authoritative refetch.
         */
        const partStreamHealthyBySession = new Set<string>();

        const applyPartUpdate = (
          sessionTabId: string,
          rawPart: unknown,
          delta?: string,
        ) => {
          const part = normalizeOpenCodePart(rawPart);
          if (!part?.sourceMessageId) {
            partStreamHealthyBySession.delete(sessionTabId);
            return null;
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
          partStreamHealthyBySession.add(sessionTabId);
          return part;
        };

        /**
         * Apply a `message.updated` payload incrementally. Returns false when
         * the payload cannot be applied and the caller must refetch.
         */
        const applyMessageInfoUpdate = (
          sessionTabId: string,
          rawInfo: unknown,
        ): boolean => {
          const sessionState = useOpenCodeStore.getState().sessions.get(sessionTabId);
          const info = rawInfo as { id?: unknown } | null | undefined;
          const messageId = typeof info?.id === "string" ? info.id : undefined;
          const existingMessage = messageId
            ? sessionState?.messages.find((message) => message.id === messageId)
            : undefined;
          const merged = mergeOpenCodeMessageInfo(existingMessage, rawInfo);
          if (!merged) return false;
          upsertMessage(sessionTabId, merged);
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
            const isRemovalEvent =
              eventType === "message.removed" ||
              eventType === "message.part.removed";

            if (eventType === "message.part.updated") {
              const appliedPart = applyPartUpdate(
                sessionTabId,
                props?.part,
                typeof props?.delta === "string" ? props.delta : undefined,
              );
              if (!appliedPart) {
                fetchMessagesDebounced(
                  eventSessionId,
                  sessionTabId,
                  false,
                );
              } else if (
                appliedPart.type === "subagent" &&
                appliedPart.subagentId
              ) {
                fetchSubagentMessagesDebounced(appliedPart.subagentId);
              }
            } else if (isFinalEvent || isRemovalEvent) {
              // Final events fully reconcile (subagents included) so anything
              // the incremental paths missed — including frames dropped while
              // this environment was in the background — is recovered here.
              partStreamHealthyBySession.delete(sessionTabId);
              fetchMessagesDebounced(eventSessionId, sessionTabId, true);
            } else if (eventType === "message.updated") {
              // The payload carries message-level metadata only (role, error,
              // token usage) — parts stream separately. Apply it in place and
              // fall back to a cheap refetch only when it cannot be applied.
              if (!applyMessageInfoUpdate(sessionTabId, props?.info)) {
                fetchMessagesDebounced(eventSessionId, sessionTabId, false);
              }
            } else if (eventType === "session.updated") {
              // Session metadata (title, share, revert timestamps). While the
              // part stream is applying cleanly this carries no transcript
              // content; outside streaming (e.g. an idle-time revert) refetch
              // so the transcript still catches up promptly.
              if (!partStreamHealthyBySession.has(sessionTabId)) {
                fetchMessagesDebounced(eventSessionId, sessionTabId, false);
              }
            }

            // Carry the server-assigned title into the store so the tab chrome
            // can label the session, as Claude and Codex tabs already do.
            if (eventType === "session.updated") {
              const updatedTitle = props?.info?.title;
              if (typeof updatedTitle === "string" && updatedTitle.length > 0) {
                setSessionTitle(sessionTabId, updatedTitle);
              }
            }

            if (usageFromEvent) {
              // Keyed by the session the event belongs to, not this tab's — the
              // subscription is environment-wide and model selection is now
              // per-session.
              const fallbackModel = useOpenCodeStore
                .getState()
                .selectedModel.get(sessionTabId);
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

          if (eventSessionId) {
            // O(1) amortized per event: `collectOpenCodeSubagentIds` caches per
            // transcript/message reference, so only the messages that actually
            // changed since the last event are re-scanned.
            let hasMatchingSubagent = false;
            for (const sessionState of useOpenCodeStore.getState().sessions.values()) {
              if (collectOpenCodeSubagentIds(sessionState.messages).has(eventSessionId)) {
                hasMatchingSubagent = true;
                break;
              }
            }
            if (hasMatchingSubagent) {
              const isChildIdle =
                eventType === "session.idle" ||
                (eventType === "session.status" && props?.status?.type === "idle");
              const isChildError = eventType === "session.error";
              const isChildRemoval =
                eventType === "message.removed" ||
                eventType === "message.part.removed";
              if (
                eventType === "message.part.updated" ||
                eventType === "message.updated" ||
                eventType === "session.updated" ||
                isChildRemoval ||
                isChildIdle ||
                isChildError
              ) {
                fetchSubagentMessagesDebounced(
                  eventSessionId,
                  isChildIdle || isChildError || isChildRemoval,
                  isChildError ? "failure" : isChildIdle ? "success" : undefined,
                );
              }
            }
          }

          if (
            (eventType === "todo.updated" || eventType === "session.diff")
            && eventSessionId
          ) {
            const state = useOpenCodeStore.getState();
            /*
             * The subscription is shared by the entire environment and only
             * the component that created it consumes the stream. Route the
             * update through the authoritative session map rather than the
             * owner's captured session key so sibling tabs stay current too.
             * A provider session may intentionally be visible in more than one
             * tab, so update every matching key.
             */
            for (const [matchingSessionKey, matchingSession] of state.sessions) {
              if (matchingSession.sessionId !== eventSessionId) continue;
              const current = state.runtimeHealth.get(matchingSessionKey)
                ?? state.runtimeHealth.get(environmentId);
              if (current) {
                state.setRuntimeHealth(matchingSessionKey, {
                  ...current,
                  ...(eventType === "todo.updated"
                    && Array.isArray(event.properties?.todos)
                    ? { todos: event.properties.todos }
                    : {}),
                  ...(eventType === "session.diff"
                    && Array.isArray(event.properties?.diff)
                    ? { diffs: event.properties.diff }
                    : {}),
                  fetchedAt: new Date().toISOString(),
                });
              }
            }
          }

          // Handle permission events (not session-specific, need to match by sessionID in the event)
          if (eventType === "permission.asked") {
            const permissionProps = event.properties;
            if (permissionProps?.id && permissionProps?.permission) {
              const permissionRequest: PermissionRequest = {
                id: permissionProps.id,
                sessionId:
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
                sessionId:
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
        for (const timeout of pendingReloads.values()) {
          clearTimeout(timeout);
        }
        pendingReloads.clear();
        reloadGenerationByKey.clear();
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
        requestId?: string;
      },
    ) => {
      if (!client || !session) return;

      const hasModelOverride = options
        ? Object.prototype.hasOwnProperty.call(options, "model")
        : false;
      const selectedModelValue = hasModelOverride
        ? options?.model
        : getSelectedModel(sessionKey);
      const selectedModel = selectedModelValue === "default"
        ? undefined
        : selectedModelValue;
      const hasVariantOverride = options
        ? Object.prototype.hasOwnProperty.call(options, "variant")
        : false;
      const selectedVariant = hasVariantOverride
        ? options?.variant
        : getSelectedVariant(sessionKey);
      const selectedMode = options?.mode ?? getSelectedMode(sessionKey);
      const selectedAgent = useOpenCodeStore
        .getState()
        .getSelectedAgent(sessionKey);

      // Add user message optimistically
      const userMessage = createOptimisticNativeMessage(
        `${OPTIMISTIC_MESSAGE_PREFIX}${createUuid()}`,
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
        if (env && isDefaultTimestampEnvironmentName(env.name)) {
          const namingMsgId = `${SYSTEM_MESSAGE_PREFIX}naming-${createUuid()}`;
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
      const trimmedText = text.trim();
      const commandName = trimmedText.split(/\s+/)[0];
      const nativeCommand = commandName && slashCommands.some(
        (command) => command.name === commandName,
      )
        ? {
            name: commandName,
            /*
             * Sliced from the original text rather than rebuilt from the split
             * tokens: `split(/\s+/).join(" ")` collapsed every newline, tab and
             * run of spaces, so a command invoked with a pasted diff or a
             * multi-line spec reached the server as one flattened line.
             */
            arguments:
              trimmedText.slice(commandName.length).trimStart() || undefined,
          }
        : undefined;
      const sendResult = await sendPrompt(client, session.sessionId, text, {
        model: selectedModel,
        variant: selectedVariant,
        mode: selectedMode,
        agent: selectedAgent,
        directory: slashCommandDirectory,
        command: nativeCommand,
        attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
        requestId: options?.requestId,
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
      return sendResult;
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
      slashCommands,
      slashCommandDirectory,
    ],
  );

  // Keep handleSendRef updated with the latest handleSend
  handleSendRef.current = handleSend;

  const handleQueue = useCallback(
    (text: string, attachments: OpenCodeAttachment[]) => {
      addToQueue(sessionKey, {
        id: createUuid(),
        text,
        attachments,
        model: getSelectedModel(sessionKey),
        // Queue what is selected *now*, exactly as `handleSend` would read it.
        // Gating on the tab's launch-time model dropped the variant for the
        // rest of the tab's life once it had launched on "default", even after
        // the user switched to a variant-capable model.
        variant: getSelectedVariant(sessionKey),
        mode: getSelectedMode(sessionKey),
      });
    },
    [
      addToQueue,
      sessionKey,
      getSelectedModel,
      getSelectedVariant,
      getSelectedMode,
    ],
  );

  useNativeMessageQueue({
    agentLabel: "OpenCode",
    sessionKey,
    store: useOpenCodeStore,
    canDrain:
      handoff.ready
      && !setupPending
      && connectionState === "connected"
      && !!client,
    queueLength,
    isLoading: session?.isLoading ?? false,
    blockedByDraft: isQueueBlockedByDraft,
    claimHead: () =>
      claimAgentPromptQueueHead<OpenCodeQueuedMessage>("opencode", sessionKey),
    send: (entry) =>
      handleSendRef.current?.(entry.text, entry.attachments, {
        model: entry.model,
        variant: entry.variant,
        mode: entry.mode,
      }),
    onError: (error) => {
      const errorText = `Failed to send queued prompt: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      addMessage(sessionKey, {
        id: `${ERROR_MESSAGE_PREFIX}${createUuid()}`,
        role: "assistant",
        content: errorText,
        parts: [{ type: "text", content: errorText }],
        createdAt: new Date().toISOString(),
      });
      setSessionLoading(sessionKey, false);
    },
  });

  // Send initial prompt after session is ready (for code review, PR creation, etc.)
  useEffect(() => {
    const sessionHasMessages = !!session?.messages.length;

    if (
      connectionState === "connected" &&
      client &&
      session &&
      handoff.ready &&
      launchPrompt &&
      !setupPending &&
      launchOptionsSettled &&
      !initialPromptSentRef.current &&
      !sessionHasMessages
    ) {
      initialPromptSentRef.current = true;
      // Clear from pane state so it can't be re-sent after remount
      clearTabInitialPrompt(tabId, environmentId);
      console.debug("[OpenCodeChatTab] Sending initial prompt for tab:", tabId);
      // Use ref to avoid effect re-running when handleSend changes
      const launchOptionsValidated = !initialLaunchOptionsPendingRef.current;
      const resolvedModel = launchOptionsValidated
        ? getSelectedModel(sessionKey)
        : undefined;
      handleSendRef.current?.(launchPrompt, [], {
        model:
          initialLaunchOptionsRef.current.model === "default" || resolvedModel === "default"
            ? undefined
            : resolvedModel,
        variant: launchOptionsValidated
          ? getSelectedVariant(sessionKey)
          : undefined,
        requestId: `initial-prompt:${environmentId}:${tabId}`,
      });
    }
  }, [
    connectionState,
    client,
    session,
    handoff.ready,
    launchPrompt,
    setupPending,
    launchOptionsSettled,
    tabId,
    clearTabInitialPrompt,
    environmentId,
    sessionKey,
    getSelectedModel,
    getSelectedVariant,
  ]);

  // Handle retry connection
  const handleRetry = useCallback(() => {
    automaticInitRetryCountRef.current = 0;
    automaticInitRetryWindowStartedAtRef.current = Date.now();
    setupPendingObservedForInitRetryRef.current = false;
    setConnectionState("connecting");
    setErrorMessage(null);
    // Reset initialization state to force new session creation
    tabSessionIdRef.current = null;
    updateTabNativeSessionId(tabId, undefined, environmentId);
    isInitializedRef.current = false;
    clearPersistedVirtuosoState(sessionKey);
    // Trigger re-initialization by clearing client
    setClient(environmentId, null);
    setSession(sessionKey, null);
    setContextUsage(sessionKey, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
    setInitAttempt((value) => value + 1);
  }, [
    sessionKey,
    environmentId,
    setClient,
    setSession,
    setContextUsage,
    setServerStatus,
    tabId,
    updateTabNativeSessionId,
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
      store.setSelectedModel(sessionKey, nextMessage.model);
    }
    store.setSelectedVariant(sessionKey, nextMessage.variant);
    store.setSelectedMode(sessionKey, nextMessage.mode);
  }, [environmentId, sessionKey]);

  // Handle stopping the current query
  const handleStop = useCallback(async () => {
    if (!client || !session) return;

    promoteNextQueuedPromptToDraft();
    setSessionLoading(sessionKey, false);

    const success = await abortSession(client, session.sessionId);
    if (success) {
      // Leave a marker in the transcript. Without it an interrupted turn is
      // indistinguishable from one that simply produced nothing.
      addMessage(sessionKey, {
        id: `${SYSTEM_MESSAGE_PREFIX}${createUuid()}`,
        role: "system",
        content: TURN_STOPPED_BY_USER,
        parts: [{ type: "text", content: TURN_STOPPED_BY_USER }],
        createdAt: new Date().toISOString(),
      });
    } else {
      console.error("[OpenCodeChatTab] Failed to abort session");
    }
  }, [
    addMessage,
    client,
    session,
    sessionKey,
    promoteNextQueuedPromptToDraft,
    setSessionLoading,
  ]);

  useEscapeToStop({
    isActive,
    isLoading: session?.isLoading ?? false,
    onStop: handleStop,
  });

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;

      try {
        const messages = await getSessionMessages(client, sessionId);

        tabSessionIdRef.current = sessionId;
        updateTabNativeSessionId(tabId, sessionId, environmentId);
        isInitializedRef.current = true;

        /*
         * The tab key survives a resume, so every session-scoped snapshot has
         * to be replaced with the new session's in the same update — exactly
         * what the Claude and Codex tabs do. The usage effect only ever writes
         * a *truthy* summary, so a resumed session whose transcript reports no
         * usage yet used to keep displaying the previous session's context
         * meter. The session-keyed runtime health (todos and diffs) is dropped
         * for the same reason: the health refetch that follows can fail, and a
         * stale todo list is worse than none.
         */
        const resumedUsage = summarizeOpenCodeUsage(messages, models);
        useOpenCodeStore.setState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(sessionKey, { sessionId, messages, isLoading: false });
          const contextUsage = new Map(state.contextUsage);
          if (resumedUsage) contextUsage.set(sessionKey, resumedUsage);
          else contextUsage.delete(sessionKey);
          const runtimeHealth = new Map(state.runtimeHealth);
          runtimeHealth.delete(sessionKey);
          return { sessions, contextUsage, runtimeHealth };
        });
        clearTabAgentHandoff(tabId, environmentId);

        await syncPendingRequests(client, sessionId);

        setResumeDialogOpen(false);
      } catch (error) {
        console.error("[OpenCodeChatTab] Failed to resume session:", error);
      }
    },
    [
      clearTabAgentHandoff,
      client,
      environmentId,
      models,
      sessionKey,
      syncPendingRequests,
      tabId,
      updateTabNativeSessionId,
    ],
  );

  const handleForkFromMessage = useCallback(async (
    messageId: string,
    kind: MessageForkKind,
  ) => {
    if (!client || !session?.sessionId) return;
    // Each call forks server-side and then adds a tab with a freshly generated
    // id, so the pane store cannot dedupe a double click. The ref latches
    // synchronously; the state drives the disabled attribute.
    if (forkInFlightRef.current) return;
    forkInFlightRef.current = true;
    setForkInFlight(true);
    try {
      const planned = forkPlanRef.current.get(messageId);
      if (!planned || planned.kind !== kind) {
        throw new Error("The selected message is no longer in this session");
      }

      const fork = await forkOpenCodeSession(
        client,
        session.sessionId,
        planned.boundary.type === "message"
          ? planned.boundary.messageId
          : undefined,
      );
      const paneStore = usePaneLayoutStore.getState();
      const forkTabId = createUuid();
      if (planned.kind === "prompt") {
        useOpenCodeStore.getState().setDraftText(
          createSessionKey(environmentId, forkTabId),
          planned.draftText,
        );
      }
      paneStore.addTab(
        paneStore.getActivePaneId(environmentId),
        {
          id: forkTabId,
          type: "opencode-native",
          displayTitle: fork.title ?? "OpenCode fork",
          openCodeNativeData: { ...data, sessionId: fork.id },
        },
        environmentId,
      );

      const attachmentNotice = forkAttachmentNotice(planned.droppedAttachmentCount);
      if (attachmentNotice) toast.warning(attachmentNotice);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to fork OpenCode session");
    } finally {
      forkInFlightRef.current = false;
      setForkInFlight(false);
    }
  }, [client, data, environmentId, session?.sessionId]);

  // None of these change while an answer streams in — the transcript is read
  // through `forkPlanRef` precisely so it cannot drag the handler's identity
  // with it. That keeps the cached fork elements below referentially stable per
  // message id, which is what lets `memo(NativeMessage)` hold on every tick.
  const forkAction = useMessageForkAction({
    agentLabel: "OpenCode",
    disabled: forkInFlight,
    onFork: handleForkFromMessage,
  });

  // Refresh models by re-fetching from the SDK client
  const refreshModels = useCallback(async () => {
    if (!client) return;

    try {
      const { models: availableModels, defaults } =
        await getModelsWithDefaults(client);
      const hasLiveCatalog = availableModels.length > 0;
      if (hasLiveCatalog) {
        setModels(environmentId, availableModels);
        if (projectId) {
          void cacheOpenCodeModelCatalog(projectId, availableModels).catch((error) => {
            console.warn("[OpenCodeChatTab] Failed to cache refreshed models:", error);
          });
        }
      }

      const rawPreferences = await getOpencodeModelPreferences().catch((error) => {
        console.warn("[OpenCodeChatTab] Failed to load model preferences:", error);
        return EMPTY_MODEL_PREFERENCES;
      });
      const preferences = normalizeOpenCodeModelPreferences(rawPreferences);
      setModelPreferences(preferences);

      // Same rule as initialization: a catalogue the server did not just
      // report cannot validate a model id, so nothing is pinned from it.
      if (!hasLiveCatalog) return;

      const pendingInitialOptions = initialLaunchOptionsPendingRef.current
        ? initialLaunchOptionsRef.current
        : undefined;
      const currentModel = pendingInitialOptions
        ? pendingInitialOptions.model
        : getSelectedModel(sessionKey);
      const currentVariant = pendingInitialOptions
        ? pendingInitialOptions.reasoningEffort
        : getSelectedVariant(sessionKey);
      const { model: resolvedModel, variant: resolvedVariant } =
        resolveModelSelection({
          availableModels,
          defaults,
          preferences,
          currentModel,
          currentVariant,
        });

      if (resolvedModel && resolvedModel !== getSelectedModel(sessionKey)) {
        setSelectedModel(sessionKey, resolvedModel);
      }
      if (resolvedVariant !== getSelectedVariant(sessionKey)) {
        setSelectedVariant(sessionKey, resolvedVariant);
      }
      if (pendingInitialOptions) {
        acknowledgeInitialLaunchOptions();
      }
    } catch (error) {
      console.error("[OpenCodeChatTab] Failed to refresh models:", error);
    }
  }, [
    client,
    environmentId,
    projectId,
    sessionKey,
    setModels,
    getSelectedModel,
    getSelectedVariant,
    setSelectedModel,
    setSelectedVariant,
    acknowledgeInitialLaunchOptions,
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

  return (
    <NativeChatShell
      agentLabel="OpenCode"
      isActive={ownsGlobalShortcuts}
      containerId={containerId}
      connectionState={connectionState}
      errorMessage={errorMessage}
      serverLog={serverLog}
      onRetry={handleRetry}
      messages={displayMessages}
      resolveModelLabel={resolveModelLabel}
      isLoading={session?.isLoading ?? false}
      elapsedSeconds={elapsedSeconds}
      finalElapsedSeconds={finalElapsedSeconds}
      centerCompose={centerCompose}
      isAtBottom={isAtBottom}
      scrollToBottom={scrollToBottom}
      scrollProps={scrollProps}
      virtuosoRef={virtuosoRef}
      onResumeClick={client ? () => setResumeDialogOpen(true) : undefined}
      emptyStateMessage="No messages yet. Start a conversation!"
      messageActions={(message) => {
        const planned = forkPlan.get(message.id);
        return planned ? forkAction(message.id, planned.kind) : undefined;
      }}
      blockingCards={
        session && client && (pendingPermissions.length > 0 || pendingQuestions.length > 0) ? (
          <>
            {pendingPermissions.map((permission) => (
              <OpenCodePermissionCard
                key={permission.id}
                permission={permission}
                client={client}
              />
            ))}
            {pendingQuestions.map((question) => (
              <OpenCodeQuestionCard
                key={question.id}
                question={question}
                client={client}
              />
            ))}
          </>
        ) : null
      }
      composer={
        <OpenCodeComposeBar
          environmentId={environmentId}
          tabId={tabId}
          containerId={containerId}
          models={models}
          slashCommands={slashCommands}
          favoriteModelIds={favoriteModelIds}
          onSend={async (text, attachments) => {
            await handleSend(text, attachments);
          }}
          disabled={!handoff.ready || !client || !session}
          isLoading={session?.isLoading ?? false}
          queueLength={queueLength}
          onStop={handleStop}
          onQueue={handleQueue}
          onRefreshModels={refreshModels}
          showAddressAll={showAddressAll}
          layout={centerCompose ? "centered" : "bottom"}
        />
      }
      resumeDialog={
        client ? (
          <OpenCodeResumeSessionDialog
            open={resumeDialogOpen}
            onOpenChange={setResumeDialogOpen}
            client={client}
            onResume={handleResumeSession}
            currentSessionId={session?.sessionId}
          />
        ) : null
      }
    />
  );
}
