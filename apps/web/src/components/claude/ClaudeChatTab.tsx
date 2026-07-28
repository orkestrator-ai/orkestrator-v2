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
import { useStalledTurnWatchdog } from "@/hooks/useStalledTurnWatchdog";
import { useAgentHandoff } from "@/hooks/useAgentHandoff";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import { TURN_STOPPED_BY_USER } from "@/lib/chat/client-only-messages";
import {useClaudeStore} from "@/stores/claudeStore";
import { useConfigStore } from "@/stores/configStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  createClient,
  getModels,
  createSession,
  getSession,
  getSessionMessages,
  getPendingQuestions,
  getPendingPlanApprovals,
  forkClaudeSession,
  sendPrompt,
  abortSession,
  subscribeToEvents,
  checkHealth,
  getSlashCommands,
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
  SessionNotFoundError,
  USAGE_SCAN_EXEMPT_EVENT_TYPES,
  parseClaudeBackgroundTasks,
  parseClaudeContextUsage,
  type ClaudeMessage as ClaudeMessageType,
  type ClaudeMessagePatch,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type PlanApprovalRequestedEventData,
  type PlanApprovalRespondedEventData,
  type SystemMessageEventData,
  type ClaudeEffortLevel,
} from "@/lib/claude-client";
import {
  extractContextUsage,
} from "@/lib/context-usage";
import {
  startClaudeServer,
  getClaudeServerStatus,
  getClaudeServerLog,
  startLocalClaudeServer,
  getLocalClaudeServerStatus,
  getClaudeModelCatalog,
  renameEnvironmentFromPrompt,
} from "@/lib/backend";
import { useMessageForkAction } from "@/components/chat/MessageForkAction";
import {
  buildMessageForkPlan,
  findPreviousForkMessage,
  forkAttachmentNotice,
  type MessageForkKind,
} from "@/components/chat/message-fork";
import { ClaudeComposeBar } from "./ClaudeComposeBar";
import { ClaudeQuestionCard } from "./ClaudeQuestionCard";
import { ClaudePlanApprovalCard } from "./ClaudePlanApprovalCard";
import { ResumeSessionDialog } from "./ResumeSessionDialog";
import type { ClaudeNativeData } from "@/types/paneLayout";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { isSetupPending } from "@/lib/setup-commands";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import { claimAgentPromptQueueHead } from "@/lib/prompt-queue-sources";
import type { ClaudeAttachment, QueuedMessage } from "@/stores/claudeStore";
import {
  getClaudeSourceMessageId,
  normalizeClaudeMessagesForDisplay,
} from "@/lib/chat/native-message-adapters";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";

/**
 * Event types that legitimately arrive without matching a stored session —
 * during initialization, or for an older session across a reconnect — and so
 * must not produce an "unmatched event" warning.
 */
const UNMATCHED_EVENT_WARNING_EXEMPT = new Set([
  "keepalive",
  "connected",
  "session.init",
  "message.updated",
  "message.patched",
  "session.updated",
  "session.idle",
  "session.title-updated",
  "plan.enter-requested",
  "plan.exit-requested",
  "plan.approval-requested",
  "plan.approval-responded",
  "system.compact",
  "system.message",
]);

interface ClaudeChatTabProps {
  tabId: string;
  data: ClaudeNativeData;
  isActive: boolean;
  initialPrompt?: string;
  isReviewTab?: boolean;
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  agentHandoffId?: string;
  consumedAgentHandoffId?: string;
  refreshRequestId?: number;
}
type ConnectionState = "connecting" | "connected" | "error";

function resolvePreferredClaudeModel(
  models: Array<{ id: string }>,
  oneShotModel?: string,
): string | undefined {
  const preferred = oneShotModel ?? useConfigStore.getState().config.global.claudeModel;
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
  initialAgentModel,
  initialReasoningEffort,
  agentHandoffId,
  consumedAgentHandoffId,
  refreshRequestId = 0,
}: ClaudeChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  // Initialize as "connected" if we already have a client and session from a previous init.
  // This avoids even a single frame of spinner when switching back to an already-connected env.
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => {
    const hasClient = useClaudeStore.getState().clients.has(environmentId);
    const hasSession = useClaudeStore.getState().sessions.has(createSessionKey(environmentId, tabId));
    return hasClient && hasSession ? "connected" : "connecting";
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [forkInFlight, setForkInFlight] = useState(false);

  const forkInFlightRef = useRef(false);
  const tabSessionIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const initialPromptSentRef = useRef(false);
  const slashCmdCleanupRef = useRef<(() => void) | null>(null);
  const manualRefreshSequenceRef = useRef(0);
  /**
   * Bumped by *every* refresh, manual or watchdog-driven.
   *
   * A background reconcile is invalidated by anything newer; a manual one is
   * only invalidated by a newer *manual* refresh. Sharing one counter made an
   * overlapping watchdog tick turn the user's refresh into a silent no-op.
   */
  const backgroundRefreshSequenceRef = useRef(0);
  const resumeSequenceRef = useRef(0);
  const handleSendRef = useRef<((text: string, attachments: ClaudeAttachment[], effort: import("@/lib/claude-client").ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => Promise<void>) | null>(null);

  // Narrow, per-key subscriptions (mirrors CodexChatTab): store actions are
  // referentially stable, and value reads are scoped so unrelated store writes
  // (other environments, other sessions) no longer re-render this tab.
  const setClient = useClaudeStore((state) => state.setClient);
  const setModels = useClaudeStore((state) => state.setModels);
  const setModelCatalog = useClaudeStore((state) => state.setModelCatalog);
  const setSession = useClaudeStore((state) => state.setSession);
  const addMessage = useClaudeStore((state) => state.addMessage);
  const removeMessage = useClaudeStore((state) => state.removeMessage);
  const setMessages = useClaudeStore((state) => state.setMessages);
  const upsertMessage = useClaudeStore((state) => state.upsertMessage);
  const patchMessage = useClaudeStore((state) => state.patchMessage);
  const setSessionLoading = useClaudeStore((state) => state.setSessionLoading);
  const setSessionError = useClaudeStore((state) => state.setSessionError);
  const setServerStatus = useClaudeStore((state) => state.setServerStatus);
  const getSelectedModel = useClaudeStore((state) => state.getSelectedModel);
  const setSelectedModel = useClaudeStore((state) => state.setSelectedModel);
  const addPendingQuestion = useClaudeStore((state) => state.addPendingQuestion);
  const removePendingQuestion = useClaudeStore(
    (state) => state.removePendingQuestion,
  );
  const setSessionTitle = useClaudeStore((state) => state.setSessionTitle);
  const setContextUsage = useClaudeStore((state) => state.setContextUsage);
  const setPromptSuggestion = useClaudeStore((state) => state.setPromptSuggestion);
  const setBackgroundTasks = useClaudeStore((state) => state.setBackgroundTasks);
  const addPendingPlanApproval = useClaudeStore(
    (state) => state.addPendingPlanApproval,
  );
  const removePendingPlanApproval = useClaudeStore(
    (state) => state.removePendingPlanApproval,
  );
  const getOrCreateEventSubscription = useClaudeStore(
    (state) => state.getOrCreateEventSubscription,
  );
  const setEventStream = useClaudeStore((state) => state.setEventStream);
  const hasActiveEventSubscription = useClaudeStore(
    (state) => state.hasActiveEventSubscription,
  );
  const getEffort = useClaudeStore((state) => state.getEffort);
  const isPlanMode = useClaudeStore((state) => state.isPlanMode);
  const setPlanMode = useClaudeStore((state) => state.setPlanMode);
  const isFastMode = useClaudeStore((state) => state.isFastMode);
  const getSessionKeyBySdkSessionId = useClaudeStore(
    (state) => state.getSessionKeyBySdkSessionId,
  );
  const addToQueue = useClaudeStore((state) => state.addToQueue);
  // Pending-request maps stay map-level subscriptions: the filtered views below
  // need to react to any entry for this session appearing or disappearing.
  const pendingQuestionsMap = useClaudeStore((state) => state.pendingQuestions);
  const pendingPlanApprovalsMap = useClaudeStore(
    (state) => state.pendingPlanApprovals,
  );
  const models = useClaudeStore(
    useCallback(
      (state) => state.modelCatalogs.get(environmentId)?.models ?? state.models,
      [environmentId],
    ),
  );

  const loadAuthoritativeModels = useCallback(
    async (
      bridgeClient: ReturnType<typeof createClient>,
      forceRefresh = false,
    ) => {
      try {
        const catalog = await getClaudeModelCatalog(
          environmentId,
          forceRefresh,
        );
        setModelCatalog(catalog);
        return catalog.models;
      } catch (error) {
        console.debug(
          "[ClaudeChatTab] Backend model catalog unavailable; using direct bridge discovery",
          error,
        );
        const directModels = await getModels(bridgeClient);
        setModels(directModels, environmentId);
        return directModels;
      }
    },
    [environmentId, setModelCatalog, setModels],
  );

  // Pane layout store - for clearing initialPrompt after it's been sent
  const clearTabInitialPrompt = usePaneLayoutStore(
    (state) => state.clearTabInitialPrompt,
  );
  const clearTabAgentHandoff = usePaneLayoutStore(
    (state) => state.clearTabAgentHandoff,
  );
  const updateTabNativeSessionId = usePaneLayoutStore(
    (state) => state.updateTabNativeSessionId,
  );

  // Create a unique session key that combines environmentId and tabId
  // This prevents session collisions when multiple environments use the same tab IDs (e.g., "default")
  const sessionKey = useMemo(() => createSessionKey(environmentId, tabId), [environmentId, tabId]);
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
  });
  const initialLaunchOptionsPendingRef = useRef(
    Boolean(initialAgentModel || initialReasoningEffort),
  );
  const initialLaunchModel = initialLaunchOptionsRef.current.model;
  const initialLaunchReasoningEffort = initialLaunchOptionsRef.current.reasoningEffort;
  const clearTabInitialAgentOptions = usePaneLayoutStore(
    (state) => state.clearTabInitialAgentOptions,
  );

  useEffect(() => {
    if (!initialLaunchReasoningEffort) return;
    const supported: ClaudeEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
    if (supported.includes(initialLaunchReasoningEffort as ClaudeEffortLevel)) {
      useClaudeStore.getState().setEffort(sessionKey, initialLaunchReasoningEffort as ClaudeEffortLevel);
    }
  }, [initialLaunchReasoningEffort, sessionKey]);

  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);

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

  const client = useClaudeStore(
    useCallback((state) => state.clients.get(environmentId), [environmentId]),
  );
  const session = useClaudeStore(
    useCallback((state) => state.sessions.get(sessionKey), [sessionKey]),
  );
  const promptSuggestion = useClaudeStore(
    useCallback(
      (state) => state.promptSuggestions.get(sessionKey),
      [sessionKey],
    ),
  );
  /**
   * Apply a server-delivered suggestion unless this session already consumed it.
   *
   * The bridge does not clear `session.promptSuggestion` once a turn has
   * produced one, so every authoritative snapshot — mount, restore, reconnect
   * and each `session.idle` — re-delivers it. The "already consumed" latch
   * therefore lives in the store, not in a component ref: consuming the chip
   * and then switching environments unmounts this tab, and a ref would let the
   * next mount resurrect the chip from the replayed snapshot. Remembering the
   * exact string (not just "dismissed") means a genuinely new suggestion still
   * gets through.
   */
  const applyPromptSuggestion = useCallback(
    (key: string, suggestion: string | undefined) => {
      if (
        suggestion !== undefined
        && suggestion === useClaudeStore.getState().dismissedPromptSuggestions.get(key)
      ) {
        return;
      }
      setPromptSuggestion(key, suggestion);
    },
    [setPromptSuggestion],
  );
  const applyServerSessionMetadata = useCallback(
    (
      key: string,
      serverSession: Awaited<ReturnType<typeof getSession>>,
    ) => {
      if (!serverSession) return;
      const invalidFields = new Set(serverSession.invalidMetadataFields ?? []);
      const contextUsage = parseClaudeContextUsage(serverSession.contextUsage);
      if (invalidFields.has("contextUsage")) {
        // Preserve the last valid snapshot when only this optional wire field
        // was malformed.
      } else if (contextUsage) {
        setContextUsage(key, contextUsage);
      } else {
        setContextUsage(key, null);
      }
      if (
        !invalidFields.has("promptSuggestion")
        && (
          serverSession.promptSuggestion === undefined
          || typeof serverSession.promptSuggestion === "string"
        )
      ) {
        applyPromptSuggestion(key, serverSession.promptSuggestion);
      }
      if (invalidFields.has("backgroundTasks")) {
        // Preserve the last valid snapshot when only this optional wire field
        // was malformed.
      } else if (serverSession.backgroundTasks === undefined) {
        setBackgroundTasks(key, {});
      } else {
        const backgroundTasks = parseClaudeBackgroundTasks(serverSession.backgroundTasks);
        if (backgroundTasks) {
          setBackgroundTasks(key, backgroundTasks);
        }
      }
    },
    [applyPromptSuggestion, setBackgroundTasks, setContextUsage],
  );
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

  /**
   * True only while the user's own refresh is in flight.
   *
   * A manual refresh is slow — it forces the model catalog, which makes the
   * bridge respawn model discovery and a synchronous `claude --version` — so a
   * background reconcile that lands mid-flight would mutate the store under it
   * and turn the user's click into a "session changed while refreshing" error.
   */
  const manualRefreshInFlightRef = useRef(false);

  const applyServerSessionSnapshot = useCallback(async (
    { manual = false }: RefreshSessionOptions = {},
  ) => {
    const stateBeforeRefresh = useClaudeStore.getState();
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

    const stateBeforeAttempt = useClaudeStore.getState();
    const sessionBeforeAttempt = stateBeforeAttempt.sessions.get(sessionKey);
    if (
      stateBeforeAttempt.clients.get(environmentId) !== activeClient ||
      sessionBeforeAttempt?.sessionId !== sessionId
    ) {
      return;
    }

    const questionsBeforeAttempt = stateBeforeAttempt.pendingQuestions;
    const approvalsBeforeAttempt = stateBeforeAttempt.pendingPlanApprovals;
    const existingQuestionIds = new Set(
      Array.from(questionsBeforeAttempt.values())
        .filter((question) => question.sessionId === sessionId)
        .map((question) => question.id),
    );
    const existingApprovalIds = new Set(
      Array.from(approvalsBeforeAttempt.values())
        .filter((approval) => approval.sessionId === sessionId)
        .map((approval) => approval.id),
    );

    const [serverSession, messages, questions, approvals] = await Promise.all([
      getSession(activeClient, sessionId),
      getSessionMessages(activeClient, sessionId, { throwOnError: true }),
      getPendingQuestions(activeClient, sessionId, { throwOnError: true }),
      getPendingPlanApprovals(activeClient, sessionId, { throwOnError: true }),
      /**
       * Only an explicit user refresh forces the catalog. A forced refresh
       * bypasses the backend cache and makes the bridge spawn Claude model
       * discovery plus a synchronous `claude --version`, on the same bridge
       * that is streaming this turn — far too costly for a 1s watchdog tick.
       */
      manual ? loadAuthoritativeModels(activeClient, true) : undefined,
    ]);

    if (!shouldApply()) return;
    if (!serverSession) {
      throw new Error("The Claude session is no longer available on the server");
    }
    applyServerSessionMetadata(sessionKey, serverSession);

    const stateAfterAttempt = useClaudeStore.getState();
    const sessionAfterAttempt = stateAfterAttempt.sessions.get(sessionKey);
    if (
      stateAfterAttempt.clients.get(environmentId) !== activeClient ||
      sessionAfterAttempt?.sessionId !== sessionId
    ) {
      return;
    }
    const liveStateChanged =
      sessionAfterAttempt !== sessionBeforeAttempt ||
      stateAfterAttempt.pendingQuestions !== questionsBeforeAttempt ||
      stateAfterAttempt.pendingPlanApprovals !== approvalsBeforeAttempt;
    if (liveStateChanged) {
      /**
       * The snapshot is older than a frame that already landed; applying it
       * would let a stale `running` response re-lock a session that just went
       * idle. A manual refresh reports this so the user can retry; the
       * watchdog stays silent and re-checks once activity goes stale again.
       */
      if (manual) {
        throw new Error("Claude session changed while refreshing; try again");
      }
      return;
    }

    setMessages(sessionKey, messages);
    setSessionLoading(sessionKey, serverSession.status === "running");
    setSessionError(
      sessionKey,
      serverSession.status === "error"
        ? serverSession.error?.trim() || "Claude session failed"
        : undefined,
    );
    if (serverSession.title?.trim()) {
      setSessionTitle(sessionKey, serverSession.title);
    }

    const refreshedQuestionIds = new Set(questions.map((question) => question.id));
    for (const question of questions) addPendingQuestion(question);
    for (const questionId of existingQuestionIds) {
      if (!refreshedQuestionIds.has(questionId)) removePendingQuestion(questionId);
    }

    const refreshedApprovalIds = new Set(approvals.map((approval) => approval.id));
    for (const approval of approvals) addPendingPlanApproval(approval);
    for (const approvalId of existingApprovalIds) {
      if (!refreshedApprovalIds.has(approvalId)) removePendingPlanApproval(approvalId);
    }
    return;
  }, [
    applyServerSessionMetadata,
    addPendingPlanApproval,
    addPendingQuestion,
    environmentId,
    loadAuthoritativeModels,
    removePendingPlanApproval,
    removePendingQuestion,
    sessionKey,
    setMessages,
    setSessionError,
    setSessionLoading,
    setSessionTitle,
  ]);

  const refreshSessionFromServer = useCallback(
    async (options: RefreshSessionOptions = {}) => {
      if (!options.manual) {
        await applyServerSessionSnapshot(options);
        return;
      }
      manualRefreshInFlightRef.current = true;
      try {
        await applyServerSessionSnapshot(options);
      } finally {
        manualRefreshInFlightRef.current = false;
      }
    },
    [applyServerSessionSnapshot],
  );

  useManualSessionRefresh({
    refreshRequestId,
    isReady:
      connectionState === "connected" && !!client && !!session?.sessionId,
    agentLabel: "Claude",
    refresh: refreshSessionFromServer,
  });

  useStalledTurnWatchdog({
    agentLabel: "Claude",
    isLoading: session?.isLoading ?? false,
    isReady:
      connectionState === "connected" && !!client && !!session?.sessionId,
    // Every SSE frame replaces the session object, so a session reference that
    // stops changing is exactly the stall this watchdog exists to catch.
    activitySignal: session,
    // Explicitly background: no forced model-catalog reload, and superseded by
    // any newer refresh rather than superseding the user's own.
    reconcile: () => refreshSessionFromServer({ manual: false }),
    // Stand down entirely while the user's refresh is running. That pass is slow
    // enough (forced model catalog → `claude --version` on the same bridge) that
    // a reconcile landing mid-flight would fail it with "session changed".
    shouldReconcile: () => !manualRefreshInFlightRef.current,
  });

  // Memoize messages separately to provide stable reference for child components
  // This prevents unnecessary recalculations when other session properties change
  const sessionMessages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const providerDisplayMessages = useMemo(
    () => pinActiveNativeAgentParts(
      normalizeClaudeMessagesForDisplay(sessionMessages),
    ),
    [sessionMessages],
  );
  const handoff = useAgentHandoff(
    agentHandoffId,
    "claude",
    environmentId,
    providerDisplayMessages,
    consumedAgentHandoffId,
  );
  const displayMessages = handoff.displayMessages;
  const launchPrompt = initialPrompt ?? handoff.initialPrompt;
  /*
   * Initialization is blocked while a handoff loads, so by the time the effect
   * below runs this ref holds the resolved prompt. Reading it through a ref
   * rather than a dependency keeps the prompt out of the effect's identity: it
   * resolves a few milliseconds after mount, and re-running initialization then
   * would tear down an in-flight connect.
   */
  const handoffPending = !handoff.ready;
  const launchPromptRef = useRef<string | undefined>(undefined);
  launchPromptRef.current = launchPrompt;
  const forkPlan = useMemo(
    () => buildMessageForkPlan(providerDisplayMessages, {
      responseInProgress: session?.isLoading ?? false,
      // Claude's boundary is inclusive, so branching *before* a prompt means
      // forking at the message before it; the first prompt has nothing to fork
      // at and starts an empty sibling session instead.
      resolvePromptBoundary: (message, messages) => {
        const previous = findPreviousForkMessage(messages, message.id);
        return previous
          ? {
              type: "message",
              messageId: getClaudeSourceMessageId(previous.id),
            }
          : { type: "session-start" };
      },
      // A response is inclusive of itself. Display rows split by timestamp
      // resolve back to the one message the bridge can find on disk.
      resolveResponseBoundary: (message) => ({
        type: "message",
        messageId: getClaudeSourceMessageId(message.id),
      }),
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

    /*
     * Block until a restored handoff has loaded. Without this the first run
     * captures `launchPrompt === undefined` and the in-init send below can never
     * fire, pushing every handoff bootstrap onto the post-SSE path this function
     * deliberately avoids.
     */
    if (handoffPending) {
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
          acknowledgeInitialLaunchOptions();
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
            applyServerSessionMetadata(sessionKey, serverSession);
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
          if (!useClaudeStore.getState().modelCatalogs.has(environmentId)) {
            resolvedModels = await loadAuthoritativeModels(bridgeClient);
            if (!mounted) return;
          }

          const currentSelectedModel = getSelectedModel(sessionKey);
          const preferredModel = resolvePreferredClaudeModel(resolvedModels, initialLaunchModel);
          if (!currentSelectedModel && preferredModel) {
            setSelectedModel(sessionKey, preferredModel);
          }
          if (resolvedModels.length > 0 || !initialLaunchModel) {
            acknowledgeInitialLaunchOptions();
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
              applyServerSessionMetadata(sessionKey, restoredServerSession);
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
        const availableModels = await loadAuthoritativeModels(bridgeClient);
        if (!mounted) return;
        console.debug("[ClaudeChatTab] Available models:", availableModels, "durationMs:", Date.now() - modelsStart);

        // Set default model if not already selected
        const currentSelectedModel = getSelectedModel(sessionKey);
        const preferredModel = resolvePreferredClaudeModel(availableModels, initialLaunchModel);
        if (!currentSelectedModel && preferredModel) {
          setSelectedModel(sessionKey, preferredModel);
        }
        if (availableModels.length > 0 || !initialLaunchModel) {
          acknowledgeInitialLaunchOptions();
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
              agents: existing?.agents || [],
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
              applyServerSessionMetadata(sessionKey, serverSession);
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
          const pendingLaunchPrompt = launchPromptRef.current;
          const shouldSendInitialPrompt =
            pendingLaunchPrompt && !initialPromptSentRef.current;

          if (shouldSendInitialPrompt) {
            // Mark as sent immediately to prevent double-sending
            initialPromptSentRef.current = true;
            // Also clear the initialPrompt from the pane store to prevent re-submission on remount
            clearTabInitialPrompt(tabId, environmentId);

            // Create user message
            const userMessage = {
              id: createUuid(),
              role: "user" as const,
              content: pendingLaunchPrompt,
              parts: [{ type: "text" as const, content: pendingLaunchPrompt }],
              timestamp: new Date().toISOString(),
            };

            console.debug("[ClaudeChatTab] Sending initial prompt during initialization", {
              tabId,
              sessionId: newSession.sessionId,
              promptLength: pendingLaunchPrompt.length,
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
              .getModels(environmentId)
              .find((m) => m.id === selectedModel)?.supportsFastMode !== false;

            // Start SSE subscription first so we can receive the response
            startSharedEventSubscription(bridgeClient);

            // Now send the prompt
            const success = await sendPrompt(bridgeClient, newSession.sessionId, pendingLaunchPrompt, {
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
  }, [containerId, environmentId, tabId, isLocal, setupPending, handoffPending, initAttempt]);

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
        const reloadGenerations = new Map<string, number>();

        // Note: sessionKey is the session key from the sessions Map (e.g., "env-{envId}:{tabId}")
        const fetchMessagesDebounced = (sessionId: string, sessionKey: string, immediate = false) => {
          const reloadKey = `${sessionId}:${sessionKey}`;
          const generation = (reloadGenerations.get(reloadKey) ?? 0) + 1;
          reloadGenerations.set(reloadKey, generation);
          const pendingTimeout = pendingReloads.get(reloadKey);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(reloadKey);
          }

          const doFetch = async () => {
            pendingReloads.delete(reloadKey);
            const now = Date.now();
            lastReloadTimeBySession.set(sessionId, now);
            console.debug("[ClaudeChatTab] Fetching session messages", { sessionId, sessionKey });
            const messages = await getSessionMessages(bridgeClient, sessionId);
            if (reloadGenerations.get(reloadKey) !== generation) return;
            const currentSession = useClaudeStore.getState().sessions.get(sessionKey);
            if (currentSession?.sessionId !== sessionId) return;
            setMessages(sessionKey, messages);
          };

          if (immediate) {
            doFetch();
          } else {
            const now = Date.now();
            const lastTime = lastReloadTimeBySession.get(sessionId) || 0;
            if (now - lastTime > DEBOUNCE_MS) {
              void doFetch();
            } else {
              const timeout = setTimeout(() => void doFetch(), DEBOUNCE_MS);
              pendingReloads.set(reloadKey, timeout);
            }
          }
        };

        const reconcileAuthoritativeSession = async (
          sessionId: string,
          sessionTabId: string,
        ) => {
          const reloadKey = `${sessionId}:${sessionTabId}`;
          const generation = (reloadGenerations.get(reloadKey) ?? 0) + 1;
          reloadGenerations.set(reloadKey, generation);
          const pendingTimeout = pendingReloads.get(reloadKey);
          if (pendingTimeout) {
            clearTimeout(pendingTimeout);
            pendingReloads.delete(reloadKey);
          }

          const [serverSession, messages, questions, approvals] = await Promise.all([
            getSession(bridgeClient, sessionId),
            getSessionMessages(bridgeClient, sessionId, { throwOnError: true }),
            getPendingQuestions(bridgeClient, sessionId, { throwOnError: true }),
            getPendingPlanApprovals(bridgeClient, sessionId, { throwOnError: true }),
          ]);
          if (reloadGenerations.get(reloadKey) !== generation || !serverSession) return;

          const state = useClaudeStore.getState();
          const currentSession = state.sessions.get(sessionTabId);
          if (currentSession?.sessionId !== sessionId) return;

          const existingQuestionIds = Array.from(state.pendingQuestions.values())
            .filter((question) => question.sessionId === sessionId)
            .map((question) => question.id);
          const existingApprovalIds = Array.from(state.pendingPlanApprovals.values())
            .filter((approval) => approval.sessionId === sessionId)
            .map((approval) => approval.id);

          setMessages(sessionTabId, messages);
          applyServerSessionMetadata(sessionTabId, serverSession);
          setSessionLoading(sessionTabId, serverSession.status === "running");
          setSessionError(
            sessionTabId,
            serverSession.status === "error"
              ? serverSession.error?.trim() || "Claude session failed"
              : undefined,
          );
          if (serverSession.title?.trim()) {
            setSessionTitle(sessionTabId, serverSession.title);
          }

          const nextQuestionIds = new Set(questions.map((question) => question.id));
          for (const question of questions) addPendingQuestion(question);
          for (const questionId of existingQuestionIds) {
            if (!nextQuestionIds.has(questionId)) removePendingQuestion(questionId);
          }
          const nextApprovalIds = new Set(approvals.map((approval) => approval.id));
          for (const approval of approvals) addPendingPlanApproval(approval);
          for (const approvalId of existingApprovalIds) {
            if (!nextApprovalIds.has(approvalId)) removePendingPlanApproval(approvalId);
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
          const eventDataRecord =
            event.data
            && typeof event.data === "object"
            && !Array.isArray(event.data)
              ? event.data as Record<string, unknown>
              : null;
          const hasExactSessionUsage =
            eventType === "session.updated"
            && eventDataRecord !== null
            && "contextUsage" in eventDataRecord;
          const usageFromEvent =
            USAGE_SCAN_EXEMPT_EVENT_TYPES.has(eventType || "")
            || hasExactSessionUsage
            ? null
            : extractContextUsage(event.data);

          if (eventType === "replay.required") {
            // The cursor fell behind the bridge's bounded replay window.
            // Rehydrate every Claude session owned by this environment; live
            // events then resume as incremental updates against that snapshot.
            const reconciles: Promise<void>[] = [];
            for (const [sessionTabId, sessionState] of useClaudeStore.getState().sessions) {
              if (
                !sessionTabId.startsWith(`env-${environmentId}:`)
                || !sessionState.sessionId
              ) continue;
              reconciles.push(
                reconcileAuthoritativeSession(
                  sessionState.sessionId,
                  sessionTabId,
                ).catch((error) => {
                  console.warn(
                    "[ClaudeChatTab] Failed to reconcile replay gap:",
                    error,
                  );
                }),
              );
            }
            await Promise.all(reconciles);
            continue;
          }

          if (!eventSessionId && !["question.asked", "question.answered", "plan.enter-requested", "plan.exit-requested", "plan.approval-requested", "plan.approval-responded"].includes(eventType || "")) {
            continue;
          }

          const sessions = useClaudeStore.getState().sessions;

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
            } else if (eventType === "message.patched") {
              const patch = event.data as ClaudeMessagePatch | undefined;
              // A patch is only meaningful against the exact revision it
              // extends. `patchMessage` returns false for every way that can
              // fail — this tab never saw the message (mounted mid-turn), its
              // copy is behind (the subscription reconnected past some frames,
              // or a refetch landed out of order and rolled it back), or the
              // payload is malformed. In all of them the authoritative
              // transcript is the recovery, and it re-establishes a revision
              // the next patch can build on.
              if (!patch?.messageId || !patchMessage(sessionTabId, patch)) {
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

            if (eventType === "session.updated") {
              const sessionUpdate = eventDataRecord;
              const exactUsage = parseClaudeContextUsage(sessionUpdate?.contextUsage);
              if (exactUsage) {
                setContextUsage(sessionTabId, exactUsage);
              }
              if (
                sessionUpdate
                && "promptSuggestion" in sessionUpdate
                && (
                  sessionUpdate.promptSuggestion === undefined
                  || typeof sessionUpdate.promptSuggestion === "string"
                )
              ) {
                applyPromptSuggestion(
                  sessionTabId,
                  sessionUpdate.promptSuggestion as string | undefined,
                );
              }
              if (sessionUpdate && "backgroundTasks" in sessionUpdate) {
                /*
                 * `parseClaudeBackgroundTasks` drops individual malformed tasks
                 * rather than rejecting the whole map, so a frame in which
                 * *every* task was rejected arrives here as `{}`. That is a
                 * malformed frame, not an authoritative "no tasks left":
                 * writing it would remove the Stop controls for tasks that are
                 * still running.
                 */
                const droppedTaskIds: string[] = [];
                const tasks = parseClaudeBackgroundTasks(
                  sessionUpdate.backgroundTasks,
                  droppedTaskIds,
                );
                if (
                  tasks
                  && !(Object.keys(tasks).length === 0 && droppedTaskIds.length > 0)
                ) {
                  setBackgroundTasks(sessionTabId, tasks);
                }
              }
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
                agents: initData.agents || existing?.agents || [],
              });
            }
          }

          // Debug: Warn if no session matched the event
          // Filter out events that are expected during initialization or are informational
          // Also filter message/session updates since they can arrive for old sessions during reconnects
          if (!foundMatch && eventSessionId && !UNMATCHED_EVENT_WARNING_EXEMPT.has(eventType || "")) {
            // The stored-session list is built here rather than up front: this
            // warning is rare, while the loop above runs on every frame.
            console.warn("[ClaudeChatTab] No session matched event", {
              eventType,
              eventSessionId,
              storedSessions: Array.from(sessions.entries()).map(([tabId, state]) => ({
                tabId,
                sessionId: state.sessionId,
              })),
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
    [environmentId, hasActiveEventSubscription, getOrCreateEventSubscription, setEventStream, setMessages, upsertMessage, patchMessage, setSessionLoading, setSessionError, setSessionTitle, setContextUsage, setPromptSuggestion, setBackgroundTasks, applyServerSessionMetadata, addMessage, addPendingQuestion, removePendingQuestion, addPendingPlanApproval, removePendingPlanApproval, setPlanMode, getSessionKeyBySdkSessionId]
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
        .getModels(environmentId)
        .find((m) => m.id === selectedModel)?.supportsFastMode !== false;

      const success = await sendPrompt(client, session.sessionId, text, {
        model: selectedModel,
        attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
        effort,
        permissionMode,
        fastMode: fastModeEnabled && modelSupportsFastMode,
        agent: useClaudeStore.getState().getSelectedAgent(sessionKey),
        includeLocalSettings: useClaudeStore
          .getState()
          .includesLocalSettings(sessionKey),
        promptSuggestions:
          useClaudeStore.getState().promptSuggestionOptIn.get(sessionKey) === true,
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
      // Leave a marker in the transcript. Without it an interrupted turn is
      // indistinguishable from one that simply produced nothing.
      const systemMessage: ClaudeMessageType = {
        id: `${SYSTEM_MESSAGE_PREFIX}${createUuid()}`,
        role: "system",
        content: TURN_STOPPED_BY_USER,
        parts: [{ type: "text", content: TURN_STOPPED_BY_USER }],
        timestamp: new Date().toISOString(),
      };
      addMessage(sessionKey, systemMessage);
    } else {
      console.error("[ClaudeChatTab] Failed to abort session");
    }
  }, [client, session, sessionKey, promoteNextQueuedPromptToDraft, setSessionLoading, addMessage]);

  useEscapeToStop({
    isActive,
    isLoading: session?.isLoading ?? false,
    onStop: handleStop,
  });

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
      handoff.ready &&
      launchPrompt &&
      !setupPending &&
      !initialPromptSentRef.current &&
      !sessionHasMessages
    ) {
      initialPromptSentRef.current = true;
      // Also clear the initialPrompt from the pane store to prevent re-submission on remount
      clearTabInitialPrompt(tabId, environmentId);
      console.debug("[ClaudeChatTab] Sending initial prompt on reconnection for tab:", tabId);
      handleSendRef.current?.(launchPrompt, [], effortValue, planModeEnabledValue, fastModeEnabledValue);
    }
  }, [connectionState, client, session, handoff.ready, launchPrompt, setupPending, tabId, effortValue, planModeEnabledValue, fastModeEnabledValue, clearTabInitialPrompt, environmentId]);

  useNativeMessageQueue({
    agentLabel: "Claude",
    sessionKey,
    store: useClaudeStore,
    canDrain:
      handoff.ready
      && !setupPending
      && connectionState === "connected"
      && !!client,
    queueLength,
    isLoading: session?.isLoading ?? false,
    blockedByDraft: isQueueBlockedByDraft,
    claimHead: () => claimAgentPromptQueueHead<QueuedMessage>("claude", sessionKey),
    send: (entry) =>
      handleSendRef.current?.(
        entry.text,
        entry.attachments,
        entry.effort,
        entry.planModeEnabled,
        entry.fastModeEnabled,
      ),
    onError: (error) => {
      const errorText = `Failed to send queued message: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      const errorMessage: ClaudeMessageType = {
        id: `${ERROR_MESSAGE_PREFIX}${createUuid()}`,
        role: "assistant",
        content: errorText,
        parts: [{ type: "text", content: errorText }],
        timestamp: new Date().toISOString(),
      };
      addMessage(sessionKey, errorMessage);
      setSessionLoading(sessionKey, false);
    },
  });

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
    setInitAttempt((value) => value + 1);
  }, [sessionKey, environmentId, tabId, setClient, setSession, setContextUsage, setServerStatus, updateTabNativeSessionId]);

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;

      const resumeSequence = ++resumeSequenceRef.current;
      try {
        console.debug("[ClaudeChatTab] Resuming session:", sessionId);
        const [serverSession, messages] = await Promise.all([
          getSession(client, sessionId),
          getSessionMessages(client, sessionId, { throwOnError: true }),
        ]);
        if (resumeSequence !== resumeSequenceRef.current) return;
        if (!serverSession || serverSession.id !== sessionId) {
          throw new Error("The selected Claude session is no longer available");
        }
        console.debug("[ClaudeChatTab] Fetched messages for resumed session:", {
          sessionId,
          messageCount: messages.length,
          messages,
        });

        const contextUsage = parseClaudeContextUsage(serverSession.contextUsage);
        const backgroundTasks =
          parseClaudeBackgroundTasks(serverSession.backgroundTasks) ?? {};

        // Publish the new identity, transcript, and all session-scoped metadata
        // in one store update. No render can pair the resumed session with the
        // previous session's usage, suggestion, or task controls.
        useClaudeStore.setState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(sessionKey, {
            sessionId,
            messages,
            isLoading: serverSession.status === "running",
            error:
              serverSession.status === "error"
                ? serverSession.error?.trim() || "Claude session failed"
                : undefined,
            title: serverSession.title,
          });

          const contextUsageBySession = new Map(state.contextUsage);
          if (contextUsage) contextUsageBySession.set(sessionKey, contextUsage);
          else contextUsageBySession.delete(sessionKey);

          const promptSuggestions = new Map(state.promptSuggestions);
          if (typeof serverSession.promptSuggestion === "string") {
            promptSuggestions.set(sessionKey, serverSession.promptSuggestion);
          } else {
            promptSuggestions.delete(sessionKey);
          }

          // The consumed-suggestion latch belongs to the session that was
          // replaced; keeping it would suppress the resumed session's own
          // suggestion if the two happened to match.
          const dismissedPromptSuggestions = new Map(state.dismissedPromptSuggestions);
          dismissedPromptSuggestions.delete(sessionKey);

          const tasksBySession = new Map(state.backgroundTasks);
          if (Object.keys(backgroundTasks).length > 0) {
            tasksBySession.set(sessionKey, backgroundTasks);
          } else {
            tasksBySession.delete(sessionKey);
          }

          return {
            sessions,
            contextUsage: contextUsageBySession,
            promptSuggestions,
            dismissedPromptSuggestions,
            backgroundTasks: tasksBySession,
          };
        });
        tabSessionIdRef.current = sessionId;
        updateTabNativeSessionId(tabId, sessionId, environmentId);
        clearTabAgentHandoff(tabId, environmentId);

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
    [
      clearTabAgentHandoff,
      client,
      environmentId,
      sessionKey,
      tabId,
      updateTabNativeSessionId,
    ]
  );

  const handleForkFromMessage = useCallback(async (
    messageId: string,
    kind: MessageForkKind,
  ) => {
    if (!client || !session?.sessionId) return;
    // Each call POSTs a fork and then adds a tab with a freshly generated id,
    // so the pane store cannot dedupe a double click into one tab. The ref
    // latches synchronously; the state drives the disabled attribute.
    if (forkInFlightRef.current) return;
    forkInFlightRef.current = true;
    setForkInFlight(true);
    try {
      const planned = forkPlanRef.current.get(messageId);
      if (!planned || planned.kind !== kind) {
        throw new Error("The selected message is no longer in this session");
      }

      let fork: Awaited<ReturnType<typeof forkClaudeSession>>;
      if (planned.boundary.type === "message") {
        fork = await forkClaudeSession(client, session.sessionId, {
          upToMessageId: planned.boundary.messageId,
        });
      } else {
        const created = await createSession(
          client,
          session.title ? `${session.title} (fork)` : "Forked session",
        );
        if (!created) {
          throw new Error("Claude did not return a new session");
        }
        fork = created;
      }

      const paneStore = usePaneLayoutStore.getState();
      const forkTabId = createUuid();
      if (planned.kind === "prompt") {
        useClaudeStore.getState().setDraftText(
          createSessionKey(environmentId, forkTabId),
          planned.draftText,
        );
      }
      paneStore.addTab(
        paneStore.getActivePaneId(environmentId),
        {
          id: forkTabId,
          type: "claude-native",
          displayTitle: fork.title ?? "Claude fork",
          claudeNativeData: { ...data, sessionId: fork.sessionId },
        },
        environmentId,
      );

      const attachmentNotice = forkAttachmentNotice(planned.droppedAttachmentCount);
      if (attachmentNotice) toast.warning(attachmentNotice);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to fork Claude session");
    } finally {
      forkInFlightRef.current = false;
      setForkInFlight(false);
    }
  }, [
    client,
    data,
    environmentId,
    session?.sessionId,
    session?.title,
  ]);

  // None of these change while an answer streams in — the transcript is read
  // through `forkPlanRef` precisely so it cannot drag the handler's identity
  // with it. That keeps the cached fork elements below referentially stable per
  // message id, which is what lets `memo(NativeMessage)` hold on every tick.
  const forkAction = useMessageForkAction({
    agentLabel: "Claude",
    disabled: forkInFlight,
    onFork: handleForkFromMessage,
  });

  if (setupPending) {
    return (
      <SetupPendingOverlay
        environmentId={environmentId}
        subtext="Claude will connect automatically once setup finishes"
      />
    );
  }

  return (
    <NativeChatShell
      agentLabel="Claude"
      containerId={containerId}
      connectionState={connectionState}
      errorMessage={errorMessage}
      serverLog={serverLog}
      onRetry={handleRetry}
      messages={displayMessages}
      isLoading={session?.isLoading ?? false}
      elapsedSeconds={elapsedSeconds}
      finalElapsedSeconds={finalElapsedSeconds}
      centerCompose={centerCompose}
      isAtBottom={isAtBottom}
      scrollToBottom={scrollToBottom}
      scrollProps={scrollProps}
      virtuosoRef={virtuosoRef}
      onResumeClick={client ? () => setResumeDialogOpen(true) : undefined}
      messageActions={(message) => {
        // Keyed by display row id: the plan already resolved a split row back
        // to the persisted message the bridge can find.
        const planned = forkPlan.get(message.id);
        return planned ? forkAction(message.id, planned.kind) : undefined;
      }}
      topAccessory={
        promptSuggestion ? (
          <button
            type="button"
            onClick={() => {
              /*
               * `draftText` is the composer's backing store, so replacing
               * it unconditionally silently destroyed a half-written
               * message. Append instead whenever there is one.
               */
              const store = useClaudeStore.getState();
              const draft = store.getDraftText(sessionKey);
              store.setDraftText(
                sessionKey,
                draft.trim().length > 0
                  ? `${draft.replace(/\s+$/, "")}\n\n${promptSuggestion}`
                  : promptSuggestion,
              );
              store.setDismissedPromptSuggestion(sessionKey, promptSuggestion);
              setPromptSuggestion(sessionKey, undefined);
            }}
            className="max-w-[min(70vw,34rem)] truncate rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            title={promptSuggestion}
          >
            Suggested: {promptSuggestion}
          </button>
        ) : null
      }
      blockingCards={
        session && client && (pendingQuestions.length > 0 || pendingPlanApprovals.length > 0) ? (
          <>
            {pendingQuestions.map((question) => (
              <ClaudeQuestionCard
                key={question.id}
                question={question}
                client={client}
                sessionId={session.sessionId}
              />
            ))}
            {pendingPlanApprovals.map((approval) => (
              <ClaudePlanApprovalCard
                key={approval.id}
                approval={approval}
                client={client}
                sessionId={session.sessionId}
                messages={sessionMessages}
              />
            ))}
          </>
        ) : null
      }
      composer={
        <ClaudeComposeBar
          environmentId={environmentId}
          tabId={tabId}
          containerId={containerId}
          models={models}
          onSend={handleSend}
          disabled={!handoff.ready || !client || !session}
          isLoading={session?.isLoading ?? false}
          queueLength={queueLength}
          onStop={handleStop}
          onQueue={handleQueue}
          showAddressAll={showAddressAll}
          layout={centerCompose ? "centered" : "bottom"}
        />
      }
      resumeDialog={
        client ? (
          <ResumeSessionDialog
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
