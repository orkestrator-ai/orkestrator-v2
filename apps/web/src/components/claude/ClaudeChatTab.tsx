import { toast } from "sonner";
import { createSessionKey } from "@/lib/utils";
import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { useVirtuosoScrollState, clearPersistedVirtuosoState, useElapsedTimer } from "@/hooks";
import { useEscapeToStop } from "@/hooks/useEscapeToStop";
import {
  useManualSessionRefresh,
  type RefreshSessionOptions,
} from "@/hooks/useManualSessionRefresh";
import type { QueueDispatchOutcome } from "@/lib/prompt-queue-persistence";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import { useStalledTurnWatchdog } from "@/hooks/useStalledTurnWatchdog";
import { useAgentHandoff } from "@/hooks/useAgentHandoff";
import { prependAgentHandoffHistory } from "@/lib/agent-handoff";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { TURN_STOPPED_BY_USER } from "@/lib/chat/client-only-messages";
import {useClaudeStore} from "@/stores/claudeStore";
import { shouldReconnectEventSubscription } from "@/stores/createNativeChatStore";
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
  shouldReconcileClaudePrompt,
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
  parseClaudeRateLimits,
  type ClaudeMessage as ClaudeMessageType,
  type ClaudeMessagePatch,
  type ClaudeQuestionRequest,
  type ClaudePlanApprovalRequest,
  type PlanApprovalRequestedEventData,
  type PlanApprovalRespondedEventData,
  type SystemMessageEventData,
  type ClaudeEffortLevel,
  type ClaudeBackgroundTask,
  dismissPromptSuggestion,
  stopClaudeBackgroundTask,
  updateSessionPreferences,
} from "@/lib/claude-client";
import {
  extractContextUsage,
} from "@/lib/context-usage";
import { parseBackendTurnStartedAt } from "@/lib/session-timer";
import {
  startClaudeServer,
  getClaudeServerStatus,
  getClaudeServerLog,
  startLocalClaudeServer,
  getLocalClaudeServerStatus,
  getClaudeModelCatalog,
  adoptNativeAgentSession,
  ensureNativeAgentSession,
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
import { ClaudeBackgroundTaskHoldCard } from "./ClaudeBackgroundTaskHoldCard";
import { ResumeSessionDialog } from "./ResumeSessionDialog";
import type { ClaudeNativeData } from "@/types/paneLayout";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { isSetupPending } from "@/lib/setup-commands";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import {
  enqueueAgentPrompt,
  transferAgentPromptToComposeDraft,
} from "@/lib/prompt-queue-sources";
import type { ClaudeAttachment, QueuedMessage } from "@/stores/claudeStore";
import {
  applyClaudeBackgroundTaskStates,
  getClaudeSourceMessageId,
  normalizeClaudeMessagesForDisplay,
} from "@/lib/chat/native-message-adapters";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import {
  RetryableNewEnvironmentConnectionError,
  classifyNewEnvironmentConnectionStartupError,
  getNewEnvironmentConnectionRetryDecision,
  isRetryableNewEnvironmentConnectionError,
} from "@/lib/new-environment-connection-retry";

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
const EMPTY_BACKGROUND_TASKS: Record<string, ClaudeBackgroundTask> = {};
const EMPTY_CLAUDE_SLASH_COMMANDS: string[] = [];
const DEFAULT_CLAUDE_SLASH_COMMAND_NAMES = new Set([
  "/clear",
  "/compact",
  "/context",
  "/cost",
  "/doctor",
  "/goal",
  "/help",
  "/init",
  "/logout",
  "/memory",
  "/model",
  "/permissions",
  "/review",
  "/status",
  "/vim",
]);

type SessionPendingPrompts = {
  questions: Map<string, ClaudeQuestionRequest>;
  approvals: Map<string, ClaudePlanApprovalRequest>;
};

/**
 * The pending questions and plan approvals the store holds for one session.
 *
 * Both store maps are global across every environment and tab, so comparing the
 * map *references* would report "changed" for traffic this tab has no interest
 * in — and a rehydration that bails on another environment's question is the
 * exact gap `syncPendingPrompts` exists to close.
 */
function readSessionPendingPrompts(sessionId: string): SessionPendingPrompts {
  const state = useClaudeStore.getState();
  const questions = new Map<string, ClaudeQuestionRequest>();
  for (const question of state.pendingQuestions.values()) {
    if (question.sessionId === sessionId) questions.set(question.id, question);
  }
  const approvals = new Map<string, ClaudePlanApprovalRequest>();
  for (const approval of state.pendingPlanApprovals.values()) {
    if (approval.sessionId === sessionId) approvals.set(approval.id, approval);
  }
  return { questions, approvals };
}

function pendingPromptMapChanged<T>(before: Map<string, T>, after: Map<string, T>): boolean {
  if (before.size !== after.size) return true;
  for (const [id, value] of before) {
    // Identity, not just presence: a live frame can replace a card in place.
    if (after.get(id) !== value) return true;
  }
  return false;
}

function sessionPendingPromptsChanged(
  before: SessionPendingPrompts,
  after: SessionPendingPrompts,
): boolean {
  return (
    pendingPromptMapChanged(before.questions, after.questions)
    || pendingPromptMapChanged(before.approvals, after.approvals)
  );
}

interface ClaudeChatTabProps {
  tabId: string;
  data: ClaudeNativeData;
  isActive: boolean;
  /** Whether this pane currently owns document-level shortcuts. */
  ownsGlobalShortcuts?: boolean;
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
  ownsGlobalShortcuts = isActive,
  initialPrompt,
  isReviewTab = false,
  initialAgentModel,
  initialReasoningEffort,
  agentHandoffId,
  consumedAgentHandoffId,
  refreshRequestId = 0,
}: ClaudeChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  const projectedSessionId = data.sessionId;
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
  const automaticInitRetryCountRef = useRef(0);
  const automaticInitRetryWindowStartedAtRef = useRef<number | null>(null);
  const setupPendingObservedForInitRetryRef = useRef(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [forkInFlight, setForkInFlight] = useState(false);

  const forkInFlightRef = useRef(false);
  const tabSessionIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const initialPromptSentRef = useRef(false);
  const slashCmdCleanupRef = useRef<(() => void) | null>(null);
  const initializationSequenceRef = useRef(0);
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
  const handleSendRef = useRef<((text: string, attachments: ClaudeAttachment[], effort: import("@/lib/claude-client").ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean, requestId?: string) => Promise<QueueDispatchOutcome>) | null>(null);
  const planPreferenceWriteRef = useRef<Promise<void>>(Promise.resolve());
  // Retain the newest successfully requested value until an authoritative
  // snapshot confirms it. A GET started before the PUT may otherwise land
  // afterwards and visually undo the user's toggle with stale data.
  const desiredPlanPreferenceRef = useRef(new Map<string, boolean>());

  // Narrow, per-key subscriptions (mirrors CodexChatTab): store actions are
  // referentially stable, and value reads are scoped so unrelated store writes
  // (other environments, other sessions) no longer re-render this tab.
  const setClient = useClaudeStore((state) => state.setClient);
  const setModels = useClaudeStore((state) => state.setModels);
  const setModelCatalog = useClaudeStore((state) => state.setModelCatalog);
  const setSession = useClaudeStore((state) => state.setSession);
  const replaceSessionIdentity = useClaudeStore(
    (state) => state.replaceSessionIdentity,
  );
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
  const setRateLimits = useClaudeStore((state) => state.setRateLimits);
  const setPromptSuggestion = useClaudeStore((state) => state.setPromptSuggestion);
  const setBackgroundTasks = useClaudeStore((state) => state.setBackgroundTasks);
  const setCompletionBlockedByBackgroundTasks = useClaudeStore(
    (state) => state.setCompletionBlockedByBackgroundTasks,
  );
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
  const resolveModelLabel = useCallback(
    (modelId: string) => resolveCatalogModelLabel(modelId, models),
    [models],
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
        // The create-environment picker has no environment id yet, so keep a
        // host-level projection alongside a discovered or last-known-good
        // scoped snapshot. A bundled fallback is environment-local recovery,
        // not evidence that the host's last-known-good catalog is obsolete.
        if (catalog.source !== "fallback") {
          setModels(catalog.models);
        }
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
  useNativeComposeDraftPersistence("claude", environmentId, sessionKey, useClaudeStore);
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
  const discoveredSlashCommands = useClaudeStore(
    useCallback(
      (state) =>
        state.sessionInitData.get(environmentId)?.slashCommands
        ?? EMPTY_CLAUDE_SLASH_COMMANDS,
      [environmentId],
    ),
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
   * The bridge clears a dismissed suggestion authoritatively, but an older
   * snapshot can still race that request. The "already consumed" latch
   * therefore lives in the store, not in a component ref: consuming the chip
   * and then switching environments unmounts this tab, and a stale response
   * must not resurrect it on the next mount. Remembering the exact string (not
   * just "dismissed") means a genuinely new suggestion still gets through.
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
      {
        applyBackgroundTasks = true,
        applyCompletionHold = true,
      }: {
        applyBackgroundTasks?: boolean;
        applyCompletionHold?: boolean;
      } = {},
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
      if (serverSession.rateLimits !== undefined) {
        // This snapshot is independent of context occupancy. In particular,
        // an empty array is an authoritative clear and a non-empty array can
        // arrive before Claude reports its first token reading. `lookupSession`
        // has already sanitized partial arrays, so valid windows remain usable
        // even when invalidMetadataFields reports entries it dropped.
        setRateLimits(key, serverSession.rateLimits);
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
      if (!invalidFields.has("planMode") && typeof serverSession.planMode === "boolean") {
        const desired = desiredPlanPreferenceRef.current.get(key);
        if (desired === undefined || desired === serverSession.planMode) {
          if (desired === serverSession.planMode) {
            desiredPlanPreferenceRef.current.delete(key);
          }
          setPlanMode(key, serverSession.planMode);
        }
      }
      if (!applyBackgroundTasks) {
        // A newer SSE task snapshot landed while this REST snapshot was in
        // flight. Apply unrelated metadata, including an independently safe
        // completion hold, but preserve the newer task set.
      } else if (invalidFields.has("backgroundTasks")) {
        // Preserve the last valid snapshot when only this optional wire field
        // was malformed.
      } else if (serverSession.backgroundTasks === undefined) {
        setBackgroundTasks(key, {});
      } else {
        const backgroundTasks = parseClaudeBackgroundTasks(serverSession.backgroundTasks);
        /*
         * Mirrors the SSE guard below. `lookupSession` drops individual
         * malformed tasks and reports each one as `backgroundTasks.<id>`, so a
         * snapshot that arrives empty *because* every task was rejected is a
         * malformed payload, not an authoritative "no tasks left". Writing it
         * would remove the Stop controls for tasks that are still running.
         */
        const droppedEveryTask =
          backgroundTasks !== undefined
          && Object.keys(backgroundTasks).length === 0
          && Array.from(invalidFields).some((field) =>
            field.startsWith("backgroundTasks."),
          );
        if (backgroundTasks && !droppedEveryTask) {
          setBackgroundTasks(key, backgroundTasks);
        }
      }
      if (
        applyCompletionHold
        && !invalidFields.has("completionBlockedByBackgroundTasks")
      ) {
        setCompletionBlockedByBackgroundTasks(
          key,
          serverSession.completionBlockedByBackgroundTasks === true,
        );
      }
    },
    [
      applyPromptSuggestion,
      setBackgroundTasks,
      setContextUsage,
      setCompletionBlockedByBackgroundTasks,
      setPlanMode,
      setRateLimits,
    ],
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

  /**
   * Rehydrate this session's question and plan-approval cards from the bridge.
   *
   * `GET /session/:id/questions` and `/plan-approvals` are the authoritative
   * source, not the SSE frame. A tab that was unmounted — or an environment that
   * was in the background — when Claude asked never saw the event, and its
   * resubscription carries no cursor, so the bridge replays nothing. The turn
   * stays blocked on a card nobody can see until the stalled-turn watchdog
   * happens to fire. Every path that (re)establishes a view of a session
   * therefore calls this: mount/fast reconnect, cold reconnect, resume, the
   * user's own refresh, and the watchdog.
   *
   * It removes as well as adds. A question answered in another window, or a plan
   * approved from the CLI, is gone from the server's list; without the removal
   * pass its card would linger in the store forever with nothing able to clear
   * it.
   */
  const syncPendingPrompts = useCallback(
    async (
      bridgeClient: ReturnType<typeof createClient>,
      sessionId: string,
      options: {
        /**
         * Propagate a failed fetch to the caller instead of logging it and
         * leaving the current cards untouched.
         */
        throwOnError?: boolean;
        /**
         * Whether a live frame landing mid-sync is an error.
         *
         * Separate from `throwOnError` so a background reconcile can still let
         * fetch failures propagate while treating a raced snapshot as "try again
         * later" rather than a user-facing error.
         */
        throwOnStale?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ): Promise<boolean> => {
      const promptsBeforeSync = readSessionPendingPrompts(sessionId);

      let questions: ClaudeQuestionRequest[];
      let approvals: ClaudePlanApprovalRequest[];
      try {
        /*
         * Always `throwOnError` on the wire calls. These helpers otherwise
         * resolve to `[]` on an HTTP failure, and an empty list here does not
         * mean "nothing is pending" — it would clear a live card because the
         * bridge blipped.
         */
        [questions, approvals] = await Promise.all([
          getPendingQuestions(bridgeClient, sessionId, { throwOnError: true }),
          getPendingPlanApprovals(bridgeClient, sessionId, { throwOnError: true }),
        ]);
      } catch (error) {
        if (options.throwOnError) throw error;
        console.debug("[ClaudeChatTab] Failed to rehydrate pending prompts:", error);
        return false;
      }

      if (options.shouldApply && !options.shouldApply()) return false;

      /*
       * Recheck client identity and session id *after* the await: the
       * environment may have been retried onto a new bridge client, or the tab
       * may have resumed or forked into a different session, while the fetch was
       * in flight. Either way this answer belongs to nobody.
       */
      const stateAfterSync = useClaudeStore.getState();
      if (
        stateAfterSync.clients.get(environmentId) !== bridgeClient
        || stateAfterSync.sessions.get(sessionKey)?.sessionId !== sessionId
      ) {
        return false;
      }

      const promptsAfterSync = readSessionPendingPrompts(sessionId);
      if (sessionPendingPromptsChanged(promptsBeforeSync, promptsAfterSync)) {
        /*
         * A live frame already moved this session's cards, so the snapshot is
         * older than what the store holds; applying it would resurrect a prompt
         * the user just answered. A manual refresh reports this so the user can
         * retry; every other caller stays silent and re-syncs on the next path.
         */
        if (options.throwOnStale ?? options.throwOnError) {
          throw new Error("Claude session changed while refreshing; try again");
        }
        return false;
      }

      const serverQuestionIds = new Set<string>();
      for (const question of questions) {
        if (question.sessionId !== sessionId) continue;
        serverQuestionIds.add(question.id);
        addPendingQuestion(question);
      }

      const serverApprovalIds = new Set<string>();
      for (const approval of approvals) {
        if (approval.sessionId !== sessionId) continue;
        serverApprovalIds.add(approval.id);
        addPendingPlanApproval(approval);
      }

      for (const questionId of promptsBeforeSync.questions.keys()) {
        if (!serverQuestionIds.has(questionId)) removePendingQuestion(questionId);
      }
      for (const approvalId of promptsBeforeSync.approvals.keys()) {
        if (!serverApprovalIds.has(approvalId)) removePendingPlanApproval(approvalId);
      }

      return true;
    },
    [
      addPendingPlanApproval,
      addPendingQuestion,
      environmentId,
      removePendingPlanApproval,
      removePendingQuestion,
      sessionKey,
    ],
  );

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
    const loadingRevisionBeforeAttempt =
      stateBeforeAttempt.sessionLoadingRevisions.get(sessionKey) ?? 0;
    const backgroundTaskRevisionBeforeAttempt =
      stateBeforeAttempt.backgroundTaskRevisions.get(sessionKey) ?? 0;
    const completionHoldRevisionBeforeAttempt =
      stateBeforeAttempt.completionHoldRevisions.get(sessionKey) ?? 0;
    if (
      stateBeforeAttempt.clients.get(environmentId) !== activeClient ||
      sessionBeforeAttempt?.sessionId !== sessionId
    ) {
      return;
    }

    const [serverSession, messages] = await Promise.all([
      getSession(activeClient, sessionId),
      getSessionMessages(activeClient, sessionId, { throwOnError: true }),
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
    const stateAfterAttempt = useClaudeStore.getState();
    const sessionAfterAttempt = stateAfterAttempt.sessions.get(sessionKey);
    if (
      stateAfterAttempt.clients.get(environmentId) !== activeClient ||
      sessionAfterAttempt?.sessionId !== sessionId
    ) {
      return;
    }
    if (
      sessionAfterAttempt !== sessionBeforeAttempt
      || (stateAfterAttempt.sessionLoadingRevisions.get(sessionKey) ?? 0)
        !== loadingRevisionBeforeAttempt
    ) {
      /**
       * The snapshot is older than a frame that already landed; applying it
       * would let a stale `running` response re-lock a session that just went
       * idle. A manual refresh reports this so the user can retry; the
       * watchdog stays silent and re-checks once activity goes stale again.
       *
       * Both tokens are required. The session reference catches transcript
       * writes, which this pass would otherwise overwrite with an older
       * `messages` snapshot. It cannot catch every lifecycle edge on its own:
       * `updateTimedSessionLoading` returns the *same* object for a repeated
       * `running` edge (`lib/session-timer.ts`), so a turn restarting while
       * these reads were in flight would slip past it and let the older `idle`
       * response unlock it. The monotonic revision closes exactly that hole.
       */
      if (manual) {
        throw new Error("Claude session changed while refreshing; try again");
      }
      return;
    }
    /**
     * Tasks and the completion hold are independent store state and arrive in
     * separate SSE frames. Gate each field with its own monotonic revision so
     * a newer frame cannot be overwritten, while the REST value for the other
     * field still rehydrates missed activity.
     */
    const backgroundTasksUnchanged =
      (stateAfterAttempt.backgroundTaskRevisions.get(sessionKey) ?? 0)
        === backgroundTaskRevisionBeforeAttempt;
    const completionHoldUnchanged =
      (stateAfterAttempt.completionHoldRevisions.get(sessionKey) ?? 0)
        === completionHoldRevisionBeforeAttempt;

    applyServerSessionMetadata(sessionKey, serverSession, {
      applyBackgroundTasks: backgroundTasksUnchanged,
      applyCompletionHold: completionHoldUnchanged,
    });
    setMessages(sessionKey, messages);
    setSessionLoading(
      sessionKey,
      serverSession.status === "running",
      serverSession.turnStartedAt,
    );
    setSessionError(
      sessionKey,
      serverSession.status === "error"
        ? serverSession.error?.trim() || "Claude session failed"
        : undefined,
    );
    if (serverSession.title?.trim()) {
      setSessionTitle(sessionKey, serverSession.title);
    }

    await syncPendingPrompts(activeClient, sessionId, {
      throwOnError: true,
      throwOnStale: manual,
      shouldApply,
    });
    return;
  }, [
    applyServerSessionMetadata,
    environmentId,
    loadAuthoritativeModels,
    sessionKey,
    setMessages,
    setSessionError,
    setSessionLoading,
    setSessionTitle,
    syncPendingPrompts,
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
  const backgroundTasks = useClaudeStore(
    useCallback(
      (state) => state.backgroundTasks.get(sessionKey) ?? EMPTY_BACKGROUND_TASKS,
      [sessionKey],
    ),
  );
  const completionBlockedByBackgroundTasks = useClaudeStore(
    useCallback(
      (state) => state.completionBlockedByBackgroundTasks.get(sessionKey) === true,
      [sessionKey],
    ),
  );
  const liveBackgroundTasks = useMemo(
    () => Object.values(backgroundTasks).filter(
      (task) => task.status === "pending" || task.status === "running" || task.status === "paused",
    ),
    [backgroundTasks],
  );
  const lifecycleMessages = useMemo(
    () => applyClaudeBackgroundTaskStates(sessionMessages, backgroundTasks),
    [backgroundTasks, sessionMessages],
  );
  const providerDisplayMessages = useMemo(
    () => pinActiveNativeAgentParts(
      normalizeClaudeMessagesForDisplay(lifecycleMessages),
    ),
    [lifecycleMessages],
  );
  const handoff = useAgentHandoff(
    agentHandoffId,
    "claude",
    environmentId,
    providerDisplayMessages,
    consumedAgentHandoffId,
  );
  const displayMessages = handoff.displayMessages;
  const backendOwnsStartupPrompt = useEnvironmentStore((state) => {
    if (tabId !== "startup-agent") return false;
    const environment = state.getEnvironmentById(environmentId);
    return environment?.pendingAgentLaunch === true
      || environment?.startupAgentSession !== undefined;
  });
  const launchPrompt = backendOwnsStartupPrompt || agentHandoffId
    ? undefined
    : initialPrompt;
  useEffect(() => {
    if (backendOwnsStartupPrompt && initialPrompt) {
      // NativeAgentService owns the durable initial prompt and its images. A
      // renderer that materializes the tab first must discard its text-only
      // copy rather than racing the backend dispatch.
      clearTabInitialPrompt(tabId, environmentId);
    }
  }, [
    backendOwnsStartupPrompt,
    clearTabInitialPrompt,
    environmentId,
    initialPrompt,
    tabId,
  ]);
  /*
   * Read ordinary launch prompts through a ref so they do not restart an
   * in-flight connect. Handoff readiness is a separate gate: imported history
   * never starts a turn by itself.
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
      setupPendingObservedForInitRetryRef.current = true;
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

    const now = Date.now();
    const timeSinceLastInit = now - lastInitTimeRef.current;
    const cachedSessionId = useClaudeStore
      .getState()
      .sessions.get(sessionKey)?.sessionId;
    const projectedSessionChanged = Boolean(
      projectedSessionId && cachedSessionId !== projectedSessionId,
    );
    if (
      !projectedSessionChanged
      && timeSinceLastInit < INIT_DEBOUNCE_MS
      && isInitializedRef.current
    ) {
      return;
    }

    let mounted = true;
    const initializationSequence = ++initializationSequenceRef.current;
    const isCurrentInitialization = () =>
      mounted && initializationSequenceRef.current === initializationSequence;

    async function initialize() {
      try {
        // Fast path: if we already have a client and session from a previous init,
        // skip all expensive steps (server status, health check, models fetch) and
        // reconnect instantly. This makes environment switching near-instant.
        const existingClient = useClaudeStore.getState().clients.get(environmentId);
        const existingSession = useClaudeStore.getState().sessions.get(sessionKey);
        if (
          existingClient
          && existingSession?.sessionId
          && (!projectedSessionId || existingSession.sessionId === projectedSessionId)
        ) {
          const existingSessionId = existingSession.sessionId;
          const isCurrentFastReconnect = () => {
            if (!isCurrentInitialization()) return false;
            const currentState = useClaudeStore.getState();
            return (
              currentState.clients.get(environmentId) === existingClient
              && currentState.sessions.get(sessionKey)?.sessionId === existingSessionId
            );
          };
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
            if (!isCurrentFastReconnect()) return;
            if (!healthy) {
              console.warn("[ClaudeChatTab] Background health check failed, re-initializing");
              setClient(environmentId, null);
              setConnectionState("error");
              setErrorMessage("Bridge server disconnected. Click retry to reconnect.");
              return;
            }

            /*
             * Start the card rehydration before the transcript reads and await it
             * last, so it neither serializes behind them nor gets skipped by the
             * `!serverSession` early return below. A blocked turn is the one piece
             * of state nothing else can recover: the question was raised while this
             * tab was unmounted, so no SSE frame will ever replay it.
             *
             * Deliberately not gated on `mounted` — the cards live in the store, so
             * they must land even if the user switches away again mid-fetch. The
             * helper's client and session-id rechecks keep a superseded session out.
             */
            const pendingPromptsSync = syncPendingPrompts(
              existingClient,
              existingSessionId,
            );

            // Re-sync session state from the server.
            // If SSE events were missed while this tab was inactive (e.g. due to
            // an EventSource error killing the subscription), messages and loading
            // state can be stale.
            const loadingRevisionBeforeSnapshot =
              useClaudeStore.getState().sessionLoadingRevisions.get(sessionKey) ?? 0;
            const backgroundRevisionBeforeSnapshot =
              useClaudeStore.getState().backgroundTaskRevisions.get(sessionKey) ?? 0;
            const completionHoldRevisionBeforeSnapshot =
              useClaudeStore.getState().completionHoldRevisions.get(sessionKey) ?? 0;
            const serverSession = await getSession(existingClient, existingSessionId);
            if (!isCurrentFastReconnect() || !serverSession) return;
            const messages = await getSessionMessages(existingClient, existingSessionId);
            if (!isCurrentFastReconnect()) return;

            /*
             * Transcript and metadata frames also replace the session object,
             * while a repeated lifecycle edge may preserve it. The dedicated
             * monotonic revision changes for every lifecycle/identity write
             * but not transcript or metadata writes, so an older REST status
             * cannot overwrite a newer live one.
             */
            // Only apply fetched messages if they are more complete than what
            // the store currently has (SSE may have already delivered newer data).
            const backgroundTasksUnchanged =
              (useClaudeStore.getState().backgroundTaskRevisions.get(sessionKey) ?? 0)
                === backgroundRevisionBeforeSnapshot;
            const completionHoldUnchanged =
              (useClaudeStore.getState().completionHoldRevisions.get(sessionKey) ?? 0)
                === completionHoldRevisionBeforeSnapshot;
            applyServerSessionMetadata(sessionKey, serverSession, {
              applyBackgroundTasks: backgroundTasksUnchanged,
              applyCompletionHold: completionHoldUnchanged,
            });
            const currentMessages = useClaudeStore.getState().sessions.get(sessionKey)?.messages ?? [];
            if (messages.length >= currentMessages.length) {
              setMessages(sessionKey, messages);
            }

            /*
             * Reconcile in both directions. Background queue dispatches and
             * turns started while this tab was unmounted can leave the stored
             * flag idle even though the bridge is actively producing tools.
             */
            if (
              (useClaudeStore.getState().sessionLoadingRevisions.get(sessionKey) ?? 0)
                === loadingRevisionBeforeSnapshot
            ) {
              setSessionLoading(
                sessionKey,
                serverSession.status === "running",
                serverSession.turnStartedAt,
              );
            }

            await pendingPromptsSync;
          }).catch((err) => {
            if (!isCurrentFastReconnect()) return;
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
            if (!isCurrentInitialization()) return;
          }

          const currentSelectedModel = getSelectedModel(sessionKey);
          const preferredModel = resolvePreferredClaudeModel(resolvedModels, initialLaunchModel);
          if (!currentSelectedModel && preferredModel) {
            setSelectedModel(sessionKey, preferredModel);
          }
          if (resolvedModels.length > 0 || !initialLaunchModel) {
            acknowledgeInitialLaunchOptions();
          }

          if (projectedSessionId) {
            try {
              const restoredMessages = await getSessionMessages(bridgeClient, projectedSessionId);
              if (!isCurrentInitialization()) return;
              const restoredServerSession = await getSession(bridgeClient, projectedSessionId);
              if (!isCurrentInitialization()) return;

              tabSessionIdRef.current = projectedSessionId;
              updateTabNativeSessionId(tabId, projectedSessionId, environmentId);
              isInitializedRef.current = true;
              replaceSessionIdentity(sessionKey, {
                sessionId: projectedSessionId,
                messages: restoredMessages,
                isLoading: restoredServerSession?.status === "running",
              });
              applyServerSessionMetadata(sessionKey, restoredServerSession);
              setConnectionState("connected");
              if (!hasActiveEventSubscription(environmentId)) {
                startSharedEventSubscription(bridgeClient);
              }
              // A restored session can already be blocked on a question or plan
              // approval raised before this tab existed.
              await syncPendingPrompts(bridgeClient, projectedSessionId);
              return;
            } catch (error) {
              if (!(error instanceof SessionNotFoundError)) throw error;
            }
          }

          const ensured = await ensureNativeAgentSession({
            environmentId,
            agent: "claude",
            logicalSessionKey: sessionKey,
          });
          const newSession = { sessionId: ensured.providerSessionId };
          if (!isCurrentInitialization()) return;

          tabSessionIdRef.current = newSession.sessionId;
          isInitializedRef.current = true;
          seedInitialFastMode();

          replaceSessionIdentity(sessionKey, {
            sessionId: newSession.sessionId,
            messages: [],
            isLoading: false,
          });
          updateTabNativeSessionId(tabId, newSession.sessionId, environmentId);

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
        let authToken: string | undefined;

        if (isLocal) {
          // Local environment - use local server commands
          let localStatus;
          try {
            localStatus = await getLocalClaudeServerStatus(environmentId);
          } catch (error) {
            throw classifyNewEnvironmentConnectionStartupError(error);
          }
          console.debug("[ClaudeChatTab] Local server status:", localStatus.running);

          if (!localStatus.running || !localStatus.authToken) {
            console.debug("[ClaudeChatTab] Starting local Claude server...");
            let result;
            try {
              result = await startLocalClaudeServer(environmentId);
            } catch (error) {
              throw classifyNewEnvironmentConnectionStartupError(error);
            }
            localStatus = {
              running: true,
              port: result.port,
              pid: result.pid,
              authToken: result.authToken,
            };
          }

          if (!isCurrentInitialization()) return;

          if (!localStatus.port) {
            throw new Error("Local server started but no port available");
          }

          hostPort = localStatus.port;
          authToken = localStatus.authToken;
        } else {
          // Containerized environment - use container server commands
          if (!containerId) {
            throw new Error("Container ID is required for containerized environments");
          }

          let status;
          try {
            status = await getClaudeServerStatus(containerId);
          } catch (error) {
            throw classifyNewEnvironmentConnectionStartupError(error);
          }
          console.debug("[ClaudeChatTab] Container server status:", status.running);

          if (!status.running || !status.authToken) {
            console.debug("[ClaudeChatTab] Starting container Claude server...");
            let result;
            try {
              result = await startClaudeServer(containerId);
            } catch (error) {
              throw classifyNewEnvironmentConnectionStartupError(error);
            }
            status = {
              running: true,
              hostPort: result.hostPort,
              authToken: result.authToken,
            };
          }

          if (!isCurrentInitialization()) return;

          if (!status.hostPort) {
            throw new Error("Server started but no port available");
          }

          hostPort = status.hostPort;
          authToken = status.authToken;
        }

        if (!authToken) {
          throw new Error("Failed to resolve Claude bridge authentication");
        }

        setServerStatus(environmentId, {
          running: true,
          hostPort: hostPort,
        });

        const baseUrl = `http://127.0.0.1:${hostPort}`;
        console.debug("[ClaudeChatTab] Claude bridge server base URL:", baseUrl);
        const bridgeClient = createClient(baseUrl, authToken);
        setClient(environmentId, bridgeClient);

        let healthy: boolean;
        try {
          healthy = await checkHealth(bridgeClient);
        } catch (error) {
          throw classifyNewEnvironmentConnectionStartupError(error);
        }
        if (!isCurrentInitialization()) return;
        console.debug("[ClaudeChatTab] Claude bridge health:", healthy);
        if (!healthy) {
          throw new RetryableNewEnvironmentConnectionError(
            "Claude bridge health check failed",
          );
        }
        const modelsStart = Date.now();
        const availableModels = await loadAuthoritativeModels(bridgeClient);
        if (!isCurrentInitialization()) return;
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
        const existingSessionId =
          projectedSessionId
          ?? existingSessionFromRef
          ?? existingSessionFromStore?.sessionId;
        const storeHasExistingSession =
          existingSessionFromStore?.sessionId === existingSessionId;

        if (existingSessionId) {
          // Restore session from store - component may have remounted
          tabSessionIdRef.current = existingSessionId;
          // Claim the restored id for this tab's logical key. A tab persisted
          // before the bridge derived session ids from a client key holds a
          // random id the backend has no record of, so the first queued prompt
          // would otherwise be dispatched into a freshly created session.
          // Best-effort: the tab is already usable, so a disagreement here must
          // not break the reconnect the user is watching.
          await adoptNativeAgentSession({
            environmentId,
            agent: "claude",
            logicalSessionKey: sessionKey,
            providerSessionId: existingSessionId,
          }).catch((error) => {
            console.warn(
              "[ClaudeChatTab] Failed to adopt the restored session:",
              error,
            );
          });
          if (!isCurrentInitialization()) return;
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
            if (!isCurrentInitialization()) return;
            if (storeHasExistingSession) {
              // The store owns client-only message preservation and
              // de-duplication. Appending errors here as well would publish the
              // same row twice.
              setMessages(sessionKey, messages);
            } else {
              const serverSession = await getSession(bridgeClient, existingSessionId);
              if (!isCurrentInitialization()) return;
              replaceSessionIdentity(sessionKey, {
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
              const ensured = await ensureNativeAgentSession({
                environmentId,
                agent: "claude",
                logicalSessionKey: sessionKey,
              });
              const newSession = { sessionId: ensured.providerSessionId };
              if (!isCurrentInitialization()) return;
              seedInitialFastMode();
              tabSessionIdRef.current = newSession.sessionId;
              replaceSessionIdentity(sessionKey, {
                sessionId: newSession.sessionId,
                messages: [],
                isLoading: false,
              });
              updateTabNativeSessionId(tabId, newSession.sessionId, environmentId);
            } else if (storeHasExistingSession) {
              console.warn("[ClaudeChatTab] Failed to refresh messages on reconnect:", err);
              // Keep existing messages from store if refresh fails
            } else {
              throw err;
            }
          }

          /*
           * Rehydrate the cards for the session we actually ended up on. If the
           * catch above replaced an expired session, `tabSessionIdRef` has moved
           * and the fresh session cannot have pending prompts.
           */
          if (tabSessionIdRef.current === existingSessionId) {
            await syncPendingPrompts(bridgeClient, existingSessionId);
          }
        } else {
          const ensured = await ensureNativeAgentSession({
            environmentId,
            agent: "claude",
            logicalSessionKey: sessionKey,
          });
          const newSession = { sessionId: ensured.providerSessionId };
          if (!isCurrentInitialization()) return;

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
            replaceSessionIdentity(sessionKey, {
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
              requestId: `initial-prompt:${environmentId}:${tabId}`,
            });

            if (!shouldReconcileClaudePrompt(success)) {
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
            } else if (
              typeof success === "object"
              && success.ok
              && success.turnStartedAt !== undefined
            ) {
              setSessionLoading(sessionKey, true, success.turnStartedAt);
            }
          } else {
            // No initial prompt - just set up the session normally
            replaceSessionIdentity(sessionKey, {
              sessionId: newSession.sessionId,
              messages: [],
              isLoading: false,
            });

            setConnectionState("connected");
            startSharedEventSubscription(bridgeClient);
          }
        }
      } catch (error) {
        if (!isCurrentInitialization()) return;
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
          const {
            delayMs,
            retryWindowStartedAt,
            retryWindowExpiresAt,
          } = retryDecision;
          automaticInitRetryWindowStartedAtRef.current = retryWindowStartedAt;
          automaticInitRetryCountRef.current += 1;
          console.warn(
            `[ClaudeChatTab] Retrying new environment connection in ${delayMs}ms:`,
            message,
          );
          setClient(environmentId, null);
          setConnectionState("connecting");
          setErrorMessage(null);
          window.setTimeout(() => {
            if (!isCurrentInitialization()) return;
            if (Date.now() > retryWindowExpiresAt) {
              setConnectionState("error");
              setErrorMessage(message);
              return;
            }
            setInitAttempt((value) => value + 1);
          }, delayMs);
          return;
        }

        console.error("[ClaudeChatTab] Initialization failed:", error);
        setConnectionState("error");
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
  }, [
    containerId,
    environmentId,
    tabId,
    isLocal,
    setupPending,
    handoffPending,
    initAttempt,
    projectedSessionId,
  ]);

  const startSharedEventSubscription = useCallback(
    async (bridgeClient: ReturnType<typeof createClient>) => {
      if (hasActiveEventSubscription(environmentId)) {
        return;
      }

      const subscriptionState = getOrCreateEventSubscription(environmentId);
      const { abortController } = subscriptionState;

      try {
        console.debug("[ClaudeChatTab] Starting shared event subscription", { environmentId });
        const eventStream = subscribeToEvents(bridgeClient, abortController.signal);
        setEventStream(environmentId, eventStream, abortController);

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

          // Transcript and status are mandatory — without them there is nothing
          // to reconcile. The two interaction lists are optional: letting a
          // transient 500 on `/questions` reject the whole reconcile leaves the
          // transcript, status, title *and* the other list stale, with no retry
          // and no watchdog (`useStalledTurnWatchdog` is gated on `isLoading`,
          // which a skipped reconcile leaves false).
          const coreReconcile = Promise.all([
            getSession(bridgeClient, sessionId),
            getSessionMessages(bridgeClient, sessionId, { throwOnError: true }),
          ]);
          const interactionsReconcile = Promise.allSettled([
            getPendingQuestions(bridgeClient, sessionId, { throwOnError: true }),
            getPendingPlanApprovals(bridgeClient, sessionId, { throwOnError: true }),
          ]);
          const [serverSession, messages] = await coreReconcile;
          if (reloadGenerations.get(reloadKey) !== generation || !serverSession) return;

          const state = useClaudeStore.getState();
          const currentSession = state.sessions.get(sessionTabId);
          if (currentSession?.sessionId !== sessionId) return;

          setMessages(sessionTabId, messages);
          applyServerSessionMetadata(sessionTabId, serverSession);
          setSessionLoading(
            sessionTabId,
            serverSession.status === "running",
            serverSession.turnStartedAt,
          );
          setSessionError(
            sessionTabId,
            serverSession.status === "error"
              ? serverSession.error?.trim() || "Claude session failed"
              : undefined,
          );
          if (serverSession.title?.trim()) {
            setSessionTitle(sessionTabId, serverSession.title);
          }

          const [questionsResult, approvalsResult] = await interactionsReconcile;
          if (reloadGenerations.get(reloadKey) !== generation) return;
          const reconciledState = useClaudeStore.getState();
          if (reconciledState.sessions.get(sessionTabId)?.sessionId !== sessionId) return;

          if (questionsResult.status === "fulfilled") {
            const existingQuestionIds = Array.from(reconciledState.pendingQuestions.values())
              .filter((question) => question.sessionId === sessionId)
              .map((question) => question.id);
            const nextQuestionIds = new Set(
              questionsResult.value.map((question) => question.id),
            );
            for (const question of questionsResult.value) addPendingQuestion(question);
            for (const questionId of existingQuestionIds) {
              if (!nextQuestionIds.has(questionId)) removePendingQuestion(questionId);
            }
          } else {
            console.warn(
              "[ClaudeChatTab] Failed to reconcile pending questions:",
              questionsResult.reason,
            );
          }

          if (approvalsResult.status === "fulfilled") {
            const existingApprovalIds = Array.from(reconciledState.pendingPlanApprovals.values())
              .filter((approval) => approval.sessionId === sessionId)
              .map((approval) => approval.id);
            const nextApprovalIds = new Set(
              approvalsResult.value.map((approval) => approval.id),
            );
            for (const approval of approvalsResult.value) addPendingPlanApproval(approval);
            for (const approvalId of existingApprovalIds) {
              if (!nextApprovalIds.has(approvalId)) removePendingPlanApproval(approvalId);
            }
          } else {
            console.warn(
              "[ClaudeChatTab] Failed to reconcile pending plan approvals:",
              approvalsResult.reason,
            );
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
              /*
               * Prompt dispatch can be owned by the backend (queued prompts,
               * pipelines, or another mounted tab), so there is no local
               * optimistic send to set `isLoading`. The bridge's running edge
               * is authoritative and must clear a stale Completed footer.
               * Terminal transitions still use session.idle/session.error.
               */
              if (sessionUpdate?.status === "running") {
                setSessionLoading(
                  sessionTabId,
                  true,
                  parseBackendTurnStartedAt(sessionUpdate.turnStartedAt),
                );
              }
              const exactUsage = parseClaudeContextUsage(sessionUpdate?.contextUsage);
              if (exactUsage) {
                setContextUsage(sessionTabId, exactUsage);
              }
              if (sessionUpdate && "rateLimits" in sessionUpdate) {
                const exactRateLimits = parseClaudeRateLimits(
                  sessionUpdate.rateLimits,
                );
                if (exactRateLimits) {
                  setRateLimits(sessionTabId, exactRateLimits);
                }
              }
              if (
                sessionUpdate
                && "promptSuggestion" in sessionUpdate
                && (
                  sessionUpdate.promptSuggestion === null
                  || typeof sessionUpdate.promptSuggestion === "string"
                )
              ) {
                applyPromptSuggestion(
                  sessionTabId,
                  typeof sessionUpdate.promptSuggestion === "string"
                    ? sessionUpdate.promptSuggestion
                    : undefined,
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
              if (
                sessionUpdate
                && "completionBlockedByBackgroundTasks" in sessionUpdate
                && typeof sessionUpdate.completionBlockedByBackgroundTasks === "boolean"
              ) {
                setCompletionBlockedByBackgroundTasks(
                  sessionTabId,
                  sessionUpdate.completionBlockedByBackgroundTasks,
                );
              }
            }

            if (isFinalEvent) {
              setSessionLoading(sessionTabId, false);
              setCompletionBlockedByBackgroundTasks(sessionTabId, false);
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
              setCompletionBlockedByBackgroundTasks(sessionTabId, false);
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
                ...(questionData.expiresAt === undefined
                  ? {}
                  : {
                      expiresAt:
                        typeof questionData.expiresAt === "number"
                          ? questionData.expiresAt
                          : Number.NaN,
                    }),
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
              desiredPlanPreferenceRef.current.delete(planSessionKey);
              setPlanMode(planSessionKey, true);
            } else {
              console.warn("[ClaudeChatTab] Could not find session key for plan.enter-requested event, sessionId:", eventSessionId);
            }
          } else if (eventType === "plan.exit-requested") {
            // Claude has requested to exit plan mode - disable plan mode for this session
            const planSessionKey = eventSessionId ? getSessionKeyBySdkSessionId(eventSessionId) : null;
            if (planSessionKey) {
              console.log("[ClaudeChatTab] Plan exit requested, disabling plan mode for session:", planSessionKey);
              desiredPlanPreferenceRef.current.delete(planSessionKey);
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
                ...(approvalData.expiresAt === undefined
                  ? {}
                  : {
                      expiresAt:
                        typeof approvalData.expiresAt === "number"
                          ? approvalData.expiresAt
                          : Number.NaN,
                    }),
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
        setEventStream(environmentId, null, abortController);

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
              const currentState = useClaudeStore.getState();
              const currentClient = currentState.clients.get(environmentId);
              if (
                currentClient
                && shouldReconnectEventSubscription(
                  currentState.eventSubscriptions.get(environmentId),
                  abortController,
                )
              ) {
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
    [environmentId, hasActiveEventSubscription, getOrCreateEventSubscription, setEventStream, setMessages, upsertMessage, patchMessage, setSessionLoading, setSessionError, setSessionTitle, setContextUsage, setPromptSuggestion, setBackgroundTasks, setCompletionBlockedByBackgroundTasks, applyServerSessionMetadata, addMessage, addPendingQuestion, removePendingQuestion, addPendingPlanApproval, removePendingPlanApproval, setPlanMode, getSessionKeyBySdkSessionId]
  );
  startSharedEventSubscriptionRef.current = startSharedEventSubscription;

  const handleSend = useCallback(
    async (text: string, attachments: ClaudeAttachment[], effort: import("@/lib/claude-client").ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean, requestId?: string) => {
      if (!client || !session) return "rejected" as const;

      const commandName = text.trim().split(/\s+/)[0]?.toLowerCase();
      const recognizedSlashCommand =
        typeof commandName === "string"
        && commandName.length > 0
        && (
          DEFAULT_CLAUDE_SLASH_COMMAND_NAMES.has(commandName)
          || discoveredSlashCommands.some(
            (command) => command.split(" - ")[0]!.trim().toLowerCase() === commandName,
          )
        );
      if (handoff.pendingHistory && recognizedSlashCommand) {
        throw new Error(
          `Send a normal message to import the transferred history before running ${commandName}.`,
        );
      }

      const selectedModel = getSelectedModel(sessionKey);
      const promptText = prependAgentHandoffHistory(handoff.pendingHistory, text);

      const userMessage = {
        id: createUuid(),
        role: "user" as const,
        // Keep the optimistic row byte-for-byte aligned with the provider
        // payload. The handoff display layer strips the known carrier while it
        // is pending, and an authoritative transcript can then replace the row
        // without briefly exposing the serialized history.
        content: promptText,
        parts: [{ type: "text" as const, content: promptText }],
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

      let success: Awaited<ReturnType<typeof sendPrompt>>;
      try {
        success = await sendPrompt(client, session.sessionId, promptText, {
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
          requestId,
        });
      } catch (error) {
        // A thrown request never produced an accepted dispatch. Remove the
        // optimistic carrier so useAgentHandoff exposes the pending history to
        // the retry instead of treating this client-only row as a transcript.
        removeMessage(sessionKey, userMessage.id);
        setSessionLoading(sessionKey, false);
        throw error;
      }

      const accepted = shouldReconcileClaudePrompt(success);
      if (!accepted) {
        console.error("[ClaudeChatTab] Failed to send prompt");
        removeMessage(sessionKey, userMessage.id);
        setSessionLoading(sessionKey, false);
        return "rejected" as const;
      }
      if (
        typeof success === "object"
        && success.ok
        && success.turnStartedAt !== undefined
      ) {
        setSessionLoading(sessionKey, true, success.turnStartedAt);
      }
      // A lost response deliberately keeps the session locked while status is
      // reconciled, but it does not prove the bridge accepted a queued prompt.
      // Preserve the durable queue claim until that ambiguity is resolved.
      return (
        typeof success === "object"
        && success !== null
        && "outcome" in success
        && success.outcome === "unknown"
      )
        ? "unknown" as const
        : "accepted" as const;
    },
    [
      client,
      session,
      sessionKey,
      environmentId,
      getSelectedModel,
      addMessage,
      removeMessage,
      setSessionLoading,
      handoff.pendingHistory,
      discoveredSlashCommands,
    ]
  );

  handleSendRef.current = handleSend;

  // Handle adding a message to the queue when Claude is busy
  const handleQueue = useCallback(
    async (text: string, attachments: ClaudeAttachment[], effort: import("@/lib/claude-client").ClaudeEffortLevel, planModeEnabled: boolean, fastModeEnabled: boolean) => {
      const store = useClaudeStore.getState();
      const model = getSelectedModel(sessionKey);
      // The backend dispatches this prompt and cannot read the renderer's
      // selections, so capture them now. Fast mode is resolved against the model
      // chosen for *this* entry, since the direct send path refuses it for a
      // model that does not advertise support.
      const modelSupportsFastMode = store
        .getModels(environmentId)
        .find((candidate) => candidate.id === model)?.supportsFastMode !== false;
      await enqueueAgentPrompt<QueuedMessage>("claude", sessionKey, {
        id: createUuid(),
        text,
        attachments,
        effort,
        planModeEnabled,
        fastModeEnabled: fastModeEnabled && modelSupportsFastMode,
        model,
        agent: store.getSelectedAgent(sessionKey),
        includeLocalSettings: store.includesLocalSettings(sessionKey),
        promptSuggestions: store.promptSuggestionOptIn.get(sessionKey) === true,
      });
    },
    [sessionKey, environmentId, getSelectedModel]
  );

  const promoteNextQueuedPromptToDraft = useCallback(async () => {
    const store = useClaudeStore.getState();
    const hasCurrentDraft =
      store.getDraftText(sessionKey).trim().length > 0 ||
      store.getAttachments(sessionKey).length > 0;
    if (hasCurrentDraft) return;

    const head = store.getQueuedMessages(sessionKey)[0];
    if (!head) return;
    const nextMessage = await transferAgentPromptToComposeDraft<QueuedMessage>(
      "claude",
      sessionKey,
      head.id,
    );
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

    // Issue the abort first: promoting the queue is durable I/O and may stall,
    // while the active turn must be interrupted immediately.
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
      await promoteNextQueuedPromptToDraft().catch((error) => {
        console.error("[ClaudeChatTab] Failed to promote queued prompt:", error);
      });
    } else {
      console.error("[ClaudeChatTab] Failed to abort session");
    }
  }, [client, session, sessionKey, promoteNextQueuedPromptToDraft, addMessage]);

  const handleStopBackgroundTask = useCallback(
    async (taskId: string) => {
      if (!client || !session?.sessionId) return false;
      return stopClaudeBackgroundTask(client, session.sessionId, taskId);
    },
    [client, session?.sessionId],
  );

  const handlePlanModeChange = useCallback((enabled: boolean) => {
    if (!client || !session) return;
    const sdkSessionId = session.sessionId;
    desiredPlanPreferenceRef.current.set(sessionKey, enabled);
    const next = planPreferenceWriteRef.current
      .catch(() => undefined)
      .then(() => updateSessionPreferences(
        client,
        sdkSessionId,
        { planMode: enabled },
      ));
    planPreferenceWriteRef.current = next;
    void next.catch((error) => {
      console.warn("[ClaudeChatTab] Failed to persist plan mode:", error);
      // A newer toggle owns the UI now; its queued write will reconcile in
      // turn, so this older failure must not roll it back.
      if (desiredPlanPreferenceRef.current.get(sessionKey) !== enabled) return;
      desiredPlanPreferenceRef.current.delete(sessionKey);
      void getSession(client, sdkSessionId)
        .then((serverSession) => {
          const currentSession = useClaudeStore.getState().sessions.get(sessionKey);
          if (currentSession?.sessionId !== sdkSessionId) return;
          if (serverSession) {
            applyServerSessionMetadata(sessionKey, serverSession);
          } else {
            // If the authoritative state cannot be read, keep permission mode
            // conservative rather than leaving a failed Build-mode request in
            // bypassPermissions.
            setPlanMode(sessionKey, true);
          }
        })
        .catch(() => {
          const currentSession = useClaudeStore.getState().sessions.get(sessionKey);
          if (currentSession?.sessionId === sdkSessionId) {
            setPlanMode(sessionKey, true);
          }
        });
    });
  }, [
    applyServerSessionMetadata,
    client,
    session,
    sessionKey,
    setPlanMode,
  ]);

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
      handleSendRef.current?.(
        launchPrompt,
        [],
        effortValue,
        planModeEnabledValue,
        fastModeEnabledValue,
        `initial-prompt:${environmentId}:${tabId}`,
      );
    }
  }, [connectionState, client, session, handoff.ready, launchPrompt, setupPending, tabId, effortValue, planModeEnabledValue, fastModeEnabledValue, clearTabInitialPrompt, environmentId]);

  const handleRetry = useCallback(() => {
    automaticInitRetryCountRef.current = 0;
    automaticInitRetryWindowStartedAtRef.current = Date.now();
    setupPendingObservedForInitRetryRef.current = false;
    setConnectionState("connecting");
    setErrorMessage(null);
    tabSessionIdRef.current = null;
    updateTabNativeSessionId(tabId, undefined, environmentId);
    isInitializedRef.current = false;
    clearPersistedVirtuosoState(sessionKey);
    setClient(environmentId, null);
    setSession(sessionKey, null);
    setContextUsage(sessionKey, null);
    setRateLimits(sessionKey, null);
    setCompletionBlockedByBackgroundTasks(sessionKey, false);
    setServerStatus(environmentId, { running: false, hostPort: null });
    setInitAttempt((value) => value + 1);
  }, [sessionKey, environmentId, tabId, setClient, setSession, setContextUsage, setRateLimits, setCompletionBlockedByBackgroundTasks, setServerStatus, updateTabNativeSessionId]);

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
        const invalidMetadataFields = new Set(
          serverSession.invalidMetadataFields ?? [],
        );
        // The tab key survives a manual resume, but an optimistic preference
        // belongs to the bridge session that was just replaced. Let the
        // resumed session's snapshot establish its own permission mode.
        desiredPlanPreferenceRef.current.delete(sessionKey);

        // Publish the new identity, transcript, and all session-scoped metadata
        // in one store update. No render can pair the resumed session with the
        // previous session's usage, suggestion, or task controls.
        useClaudeStore.setState((state) => {
          const sessions = new Map(state.sessions);
          sessions.set(sessionKey, {
            sessionId,
            messages,
            isLoading: serverSession.status === "running",
            loadingStartedAt:
              serverSession.status === "running"
                ? serverSession.turnStartedAt
                : undefined,
            lastCompletedElapsedSeconds:
              serverSession.status === "running" ? null : undefined,
            error:
              serverSession.status === "error"
                ? serverSession.error?.trim() || "Claude session failed"
                : undefined,
            title: serverSession.title,
          });

          const contextUsageBySession = new Map(state.contextUsage);
          if (contextUsage) contextUsageBySession.set(sessionKey, contextUsage);
          else contextUsageBySession.delete(sessionKey);

          const rateLimits = new Map(state.rateLimits);
          if (serverSession.rateLimits !== undefined) {
            rateLimits.set(sessionKey, serverSession.rateLimits);
          } else {
            // Resume replaces the provider session underneath the same tab;
            // limits owned by the previous session must never cross over.
            rateLimits.delete(sessionKey);
          }

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
          const backgroundTaskRevisions = new Map(
            state.backgroundTaskRevisions,
          );
          const completionHoldRevisions = new Map(
            state.completionHoldRevisions,
          );
          // This transaction replaces the provider identity. Revisions from
          // the previous session must not become the new session's baseline.
          backgroundTaskRevisions.delete(sessionKey);
          completionHoldRevisions.delete(sessionKey);

          const completionHolds = new Map(
            state.completionBlockedByBackgroundTasks,
          );
          if (
            !invalidMetadataFields.has("completionBlockedByBackgroundTasks")
            && serverSession.completionBlockedByBackgroundTasks === true
          ) {
            completionHolds.set(sessionKey, true);
          } else {
            completionHolds.delete(sessionKey);
          }

          const planMode = new Map(state.planMode);
          planMode.set(
            sessionKey,
            invalidMetadataFields.has("planMode")
              ? true
              : serverSession.planMode === true,
          );

          return {
            sessions,
            contextUsage: contextUsageBySession,
            rateLimits,
            promptSuggestions,
            dismissedPromptSuggestions,
            backgroundTasks: tasksBySession,
            completionBlockedByBackgroundTasks: completionHolds,
            backgroundTaskRevisions,
            completionHoldRevisions,
            planMode,
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

        /*
         * A resumed session can be parked on a question or plan approval raised
         * long before this tab opened it — nothing replays that over SSE, so the
         * bridge's pending lists are the only way the card can appear.
         */
        await syncPendingPrompts(client, sessionId, {
          shouldApply: () => resumeSequence === resumeSequenceRef.current,
        });
      } catch (error) {
        console.error("[ClaudeChatTab] Failed to resume session:", error);
      }
    },
    [
      clearTabAgentHandoff,
      client,
      environmentId,
      sessionKey,
      syncPendingPrompts,
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
      // Bind the fork to the backend's durable record before the tab exists.
      // Without this the backend has no session for the fork's logical key, so
      // draining a prompt queued in that tab creates a *different* provider
      // session and the prompt lands somewhere the user cannot see.
      await adoptNativeAgentSession({
        environmentId,
        agent: "claude",
        logicalSessionKey: createSessionKey(environmentId, forkTabId),
        providerSessionId: fork.sessionId,
      });
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
      agentExpansionScope={environmentId}
      agentLabel="Claude"
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
              if (client && session?.sessionId) {
                void dismissPromptSuggestion(client, session.sessionId).catch((error) => {
                  console.warn("[ClaudeChatTab] Failed to dismiss prompt suggestion:", error);
                });
              }
            }}
            className="max-w-[min(70vw,34rem)] truncate rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            title={promptSuggestion}
          >
            Suggested: {promptSuggestion}
          </button>
        ) : null
      }
      pinnedAccessory={
        session
        && completionBlockedByBackgroundTasks
        && liveBackgroundTasks.length > 0 ? (
          <ClaudeBackgroundTaskHoldCard
            tasks={liveBackgroundTasks}
            onStopTask={handleStopBackgroundTask}
          />
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
          onSend={async (...args) => {
            const outcome = await handleSend(...args);
            if (outcome === "rejected") {
              // Direct compose submissions must reject their promise so the
              // shared submit controller retains the draft and attachments for
              // a retry. Internal callers use handleSendRef directly and keep
              // the raw dispatch outcome.
              throw new Error("Claude rejected the prompt. Please try again.");
            }
          }}
          disabled={!handoff.ready || !client || !session}
          isLoading={session?.isLoading ?? false}
          queueLength={queueLength}
          onStop={handleStop}
          onQueue={handleQueue}
          onPlanModeChange={handlePlanModeChange}
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
