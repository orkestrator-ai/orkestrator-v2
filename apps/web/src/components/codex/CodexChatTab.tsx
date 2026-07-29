import { createSessionKey } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import {
  clearPersistedVirtuosoState,
  useElapsedTimer,
  useVirtuosoScrollState,
} from "@/hooks";
import { useEscapeToStop } from "@/hooks/useEscapeToStop";
import { useManualSessionRefresh } from "@/hooks/useManualSessionRefresh";
import { useNativeMessageQueue } from "@/hooks/useNativeMessageQueue";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import {
  codexInteractionDraftKey,
  usePromptDraftStore,
} from "@/stores/promptDraftStore";
import { useStalledTurnWatchdog } from "@/hooks/useStalledTurnWatchdog";
import { useAgentHandoff } from "@/hooks/useAgentHandoff";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useCodexStore, useConfigStore } from "@/stores";
import {
  OPTIMISTIC_MESSAGE_PREFIX,
  TURN_STOPPED_BY_USER,
  createOptimisticNativeMessage,
} from "@/lib/chat/client-only-messages";
import { createUuid } from "@/lib/uuid";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import {
  type CodexConversationMode,
  type CodexMessage,
  type CodexPromptAcceptedResponse,
  type CodexPromptAttachment,
  type CodexPromptSendOutcome,
  type CodexReasoningEffort,
  type CodexSessionConfigUpdateOutcome,
  CodexForkError,
  DEFAULT_CODEX_MODEL,
  abortSession,
  checkHealth,
  createClient,
  createSession,
  fetchPendingApprovals,
  fetchPendingInteractions,
  forkCodexSession,
  getModels,
  getSlashCommands,
  getSessionMessages,
  getSessionStatus,
  isCodexSessionPhase,
  lookupSessionStatus,
  parseApproval,
  parseContextUsage,
  parseInteraction,
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
import {
  ERROR_MESSAGE_PREFIX,
  SYSTEM_MESSAGE_PREFIX,
} from "@/lib/opencode-client";
import { useMessageForkAction } from "@/components/chat/MessageForkAction";
import {
  buildMessageForkPlan,
  findPreviousForkMessage,
  forkAttachmentNotice,
  type MessageForkKind,
} from "@/components/chat/message-fork";
import { normalizeCodexNativeMessage } from "@/lib/chat/native-message-adapters";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import { CodexComposeBar } from "./CodexComposeBar";
import { CodexApprovalCard } from "./CodexApprovalCard";
import { CodexInteractionCard } from "./CodexInteractionCard";
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
import { requireCodexForkPlanEntry } from "./codex-message-fork";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { isSetupPending } from "@/lib/setup-commands";
import {
  acknowledgeAgentPromptClaim,
  claimAgentPromptQueueHead,
  enqueueAgentPrompt,
  rejectAgentPromptClaim,
  transferAgentPromptToComposeDraft,
} from "@/lib/prompt-queue-sources";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import type { CodexNativeData } from "@/types/paneLayout";
import type { CodexAttachment, CodexQueuedMessage } from "@/stores/codexStore";
import {
  RetryableNewEnvironmentConnectionError,
  classifyNewEnvironmentConnectionStartupError,
  getNewEnvironmentConnectionRetryDecision,
  isRetryableNewEnvironmentConnectionError,
} from "@/lib/new-environment-connection-retry";

interface CodexChatTabProps {
  tabId: string;
  data: CodexNativeData;
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

const DEFAULT_CODEX_MODE: CodexConversationMode = "build";
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "medium";
type CodexSendHandler = (
  text: string,
  attachments: CodexAttachment[],
  requestId?: string,
) => Promise<CodexDispatchResult>;
type CodexDispatchResult = "accepted" | "rejected" | "unknown";
interface ReconcileSessionOptions {
  forceRefreshMessages?: boolean;
  throwOnError?: boolean;
  /**
   * The user asked for this refresh.
   *
   * Manual requests are tracked on their own sequence so only a *newer manual*
   * refresh can supersede one. Sharing the background sequence made an overlapping
   * watchdog tick or SSE frame turn the user's refresh into a silent no-op.
   */
  manual?: boolean;
}
type ReconcileSessionResult = "applied" | "missing" | "unavailable" | "stale";

/**
 * Bun component tests historically stubbed these clients with their old
 * boolean/nullable return values. Normalize those shapes at the UI boundary so
 * the production client can expose the ambiguity without making unrelated
 * caller tests lie about success.
 */
function normalizePromptSendOutcome(value: unknown): CodexPromptSendOutcome {
  if (value && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    if (
      entry.outcome === "accepted"
      || entry.outcome === "rejected"
      || entry.outcome === "unknown"
    ) {
      return value as CodexPromptSendOutcome;
    }
    if (entry.status === "processing" || entry.status === "already-processed") {
      return {
        outcome: "accepted",
        ...(value as CodexPromptAcceptedResponse),
      };
    }
  }
  if (value === true) return { outcome: "accepted", status: "processing" };
  return { outcome: "rejected", httpStatus: 0 };
}

function normalizeConfigUpdateOutcome(value: unknown): CodexSessionConfigUpdateOutcome {
  if (value && typeof value === "object") {
    const outcome = (value as { outcome?: unknown }).outcome;
    if (outcome === "applied" || outcome === "rejected" || outcome === "unknown") {
      return value as CodexSessionConfigUpdateOutcome;
    }
  }
  return value === true
    ? { outcome: "applied", durable: true }
    : { outcome: "rejected", httpStatus: 0 };
}

export function CodexChatTab({
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
}: CodexChatTabProps) {
  const { containerId, environmentId, isLocal } = data;
  // Initialize as "connected" if we already have a client and session from a previous init.
  // This avoids even a single frame of spinner when switching back to an already-connected env.
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => {
    const hasClient = useCodexStore.getState().clients.has(environmentId);
    const hasSession = useCodexStore.getState().sessions.has(createSessionKey(environmentId, tabId));
    return hasClient && hasSession ? "connected" : "connecting";
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const automaticInitRetryCountRef = useRef(0);
  const automaticInitRetryWindowStartedAtRef = useRef<number | null>(null);
  const setupPendingObservedForInitRetryRef = useRef(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [initialPromptSent, setInitialPromptSent] = useState(false);
  const initialPromptRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialPromptRetryCountRef = useRef(0);
  const [dismissedPlanReviewMessageId, setDismissedPlanReviewMessageId] = useState<string | null>(null);
  const [isPlanTransitionPending, setIsPlanTransitionPending] = useState(false);
  const lastInitTimeRef = useRef(0);
  const isInitializedRef = useRef(false);
  /** Set when an interrupt is accepted; cleared when the turn actually ends. */
  const awaitingStopMarkerRef = useRef(false);
  /**
   * Set when the error came from the background health check rather than from a
   * failed connect, so retry keeps the live thread instead of starting a new one.
   */
  const transientDisconnectRef = useRef(false);
  const reconcileSequenceRef = useRef(0);
  const manualReconcileSequenceRef = useRef(0);
  /**
   * Number of prompt dispatches whose HTTP request has not settled.
   *
   * A turn we are about to start is not visible in any bridge status yet, so this
   * is the only signal that an "idle" phase describes the *previous* turn.
   */
  const dispatchInFlightRef = useRef(0);
  const approvalSnapshotSequenceRef = useRef(0);
  const approvalActivitySequenceRef = useRef(0);
  const interactionSnapshotSequenceRef = useRef(0);
  const interactionActivitySequenceRef = useRef(0);
  const forkInFlightRef = useRef(false);
  const [forkInFlight, setForkInFlight] = useState(false);

  useEffect(() => () => {
    if (initialPromptRetryTimerRef.current) {
      clearTimeout(initialPromptRetryTimerRef.current);
    }
  }, []);
  const reconcileSessionStateRef = useRef<
    (options?: ReconcileSessionOptions) => Promise<ReconcileSessionResult>
  >(async () => "unavailable");
  const retryablePromptRef = useRef<{
    fingerprint: string;
    requestId: string;
  } | null>(null);
  /**
   * An optimistic user message whose dispatch was never confirmed.
   *
   * The send path can only resolve a lost response when its own reconcile
   * returns an authoritative state. When it cannot — the reconcile was
   * superseded, or the bridge was unreachable and recovery happens later — the
   * message would otherwise sit in the transcript forever as something Codex
   * appears to have been told but never received. Whichever path next observes
   * an authoritative idle session settles it.
   */
  const refreshControllerRef = useRef(createCodexSessionRefreshController());
  /**
   * Last bridge event revision this tab processed.
   *
   * A ref, not state: it is written from inside the SSE loop on every frame and
   * must never trigger a render or be captured stale by the loop's closure.
   */
  const eventCursorRef = useRef<number | null>(null);
  const sessionKey = useMemo(
    () => createSessionKey(environmentId, tabId),
    [environmentId, tabId],
  );
  const initialPromptRequestId = `initial-prompt:${environmentId}:${tabId}`;
  useNativeComposeDraftPersistence("codex", environmentId, sessionKey, useCodexStore);
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
    const store = useCodexStore.getState();
    if (initialLaunchModel) {
      store.setSelectedModel(sessionKey, initialLaunchModel);
    }
    const supported: CodexReasoningEffort[] = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ];
    if (
      initialLaunchReasoningEffort
      && supported.includes(initialLaunchReasoningEffort as CodexReasoningEffort)
    ) {
      store.setSelectedReasoningEffort(
        sessionKey,
        initialLaunchReasoningEffort as CodexReasoningEffort,
      );
    }
  }, [
    initialLaunchModel,
    initialLaunchReasoningEffort,
    sessionKey,
  ]);
  const acknowledgeInitialLaunchOptions = useCallback(() => {
    if (!initialLaunchOptionsPendingRef.current) return;
    initialLaunchOptionsPendingRef.current = false;
    clearTabInitialAgentOptions(tabId, environmentId);
  }, [clearTabInitialAgentOptions, environmentId, tabId]);
  const config = useConfigStore((state) => state.config);
  const setConfig = useConfigStore((state) => state.setConfig);
  const persistedPreferencesRef = useRef(getPersistedCodexPreferences(config));

  const models = useCodexStore((state) => state.models);
  const resolveModelLabel = useCallback(
    (modelId: string) => resolveCatalogModelLabel(modelId, models),
    [models],
  );
  const setModels = useCodexStore((state) => state.setModels);
  const setSlashCommands = useCodexStore((state) => state.setSlashCommands);
  const setServerStatus = useCodexStore((state) => state.setServerStatus);
  const setClient = useCodexStore((state) => state.setClient);
  const setSession = useCodexStore((state) => state.setSession);
  const addMessage = useCodexStore((state) => state.addMessage);
  const removeMessage = useCodexStore((state) => state.removeMessage);
  const setMessages = useCodexStore((state) => state.setMessages);
  const upsertMessage = useCodexStore((state) => state.upsertMessage);
  const setSessionLoading = useCodexStore((state) => state.setSessionLoading);
  const setSessionError = useCodexStore((state) => state.setSessionError);
  const setSessionTitle = useCodexStore((state) => state.setSessionTitle);
  const setSessionPhase = useCodexStore((state) => state.setSessionPhase);
  const setContextUsage = useCodexStore((state) => state.setContextUsage);
  const setPendingApprovals = useCodexStore((state) => state.setPendingApprovals);
  const addPendingApproval = useCodexStore((state) => state.addPendingApproval);
  const removePendingApproval = useCodexStore((state) => state.removePendingApproval);
  const setPendingInteractions = useCodexStore((state) => state.setPendingInteractions);
  const addPendingInteraction = useCodexStore((state) => state.addPendingInteraction);
  const removePendingInteraction = useCodexStore((state) => state.removePendingInteraction);
  const setSelectedModel = useCodexStore((state) => state.setSelectedModel);
  const setSelectedMode = useCodexStore((state) => state.setSelectedMode);
  const setSelectedReasoningEffort = useCodexStore((state) => state.setSelectedReasoningEffort);
  const setFastMode = useCodexStore((state) => state.setFastMode);
  const claimPromptDispatch = useCodexStore((state) => state.claimPromptDispatch);
  const releasePromptDispatch = useCodexStore((state) => state.releasePromptDispatch);
  const client = useCodexStore(
    useCallback((state) => state.clients.get(environmentId), [environmentId]),
  );
  const session = useCodexStore(
    useCallback((state) => state.sessions.get(sessionKey), [sessionKey]),
  );
  const sessionPhase = useCodexStore(
    useCallback((state) => state.sessionPhase.get(sessionKey), [sessionKey]),
  );
  const initialPromptDispatchClaimed = useCodexStore(
    useCallback(
      (state) =>
        state.promptDispatchClaims.get(sessionKey)?.has(initialPromptRequestId)
        ?? false,
      [initialPromptRequestId, sessionKey],
    ),
  );
  const storedPendingApprovals = useCodexStore(
    useCallback((state) => state.pendingApprovals.get(sessionKey), [sessionKey]),
  );
  const pendingApprovals = storedPendingApprovals ?? [];
  const storedPendingInteractions = useCodexStore(
    useCallback((state) => state.pendingInteractions.get(sessionKey), [sessionKey]),
  );
  const pendingInteractions = storedPendingInteractions ?? [];
  const selectedModel = useCodexStore(
    useCallback(
      (state) => state.selectedModel.get(sessionKey) ?? DEFAULT_CODEX_MODEL,
      [sessionKey],
    ),
  );
  const selectedMode = useCodexStore(
    useCallback(
      (state) => state.selectedMode.get(sessionKey) ?? DEFAULT_CODEX_MODE,
      [sessionKey],
    ),
  );
  const selectedReasoningEffort = useCodexStore(
    useCallback(
      (state) =>
        state.selectedReasoningEffort.get(sessionKey) ?? DEFAULT_REASONING_EFFORT,
      [sessionKey],
    ),
  );
  const storedSlashCommands = useCodexStore(
    useCallback((state) => state.slashCommands.get(environmentId), [environmentId]),
  );
  const slashCommands = storedSlashCommands ?? [];

  const clearTabInitialPrompt = usePaneLayoutStore(
    (state) => state.clearTabInitialPrompt,
  );
  const clearTabAgentHandoff = usePaneLayoutStore(
    (state) => state.clearTabAgentHandoff,
  );
  const updateTabNativeSessionId = usePaneLayoutStore(
    (state) => state.updateTabNativeSessionId,
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

  /** `sessionPhase` is undefined until the bridge reports one for this session. */
  const showAddressAll = Boolean(
    isReviewTab &&
      session &&
      !session.isLoading &&
      session.messages.length > 0,
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
  const providerDisplayMessages = useMemo(
    () => pinActiveNativeAgentParts(
      sessionMessages.map(normalizeCodexNativeMessage),
    ),
    [sessionMessages],
  );
  const handoff = useAgentHandoff(
    agentHandoffId,
    "codex",
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
       * Codex forks at *turn* granularity, so branching before a prompt means
       * forking at the last message of the previous turn. A prompt that opens
       * the transcript instead starts an empty sibling session. Anything else —
       * history with no recorded turn boundaries, which the bridge answers with
       * `no-fork-point` — resolves to null so the button is never offered: it
       * could only ever raise a toast.
       */
      resolvePromptBoundary: (message, messages) => {
        const previousTurn = findPreviousForkMessage(
          messages,
          message.id,
          (candidate) => (
            Boolean(candidate.turnId)
            && candidate.turnId !== message.turnId
          ),
        );
        if (previousTurn) {
          return { type: "message", messageId: previousTurn.id };
        }
        return findPreviousForkMessage(messages, message.id)
          ? null
          : { type: "session-start" };
      },
      // A response is inclusive, so Codex must be able to attribute it to a
      // turn before it can be used as a boundary at all.
      resolveResponseBoundary: (message) => (
        message.turnId ? { type: "message", messageId: message.id } : null
      ),
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
  const queueLength = useCodexStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey)?.length ?? 0,
      [sessionKey],
    ),
  );
  const queueHeadId = useCodexStore(
    useCallback(
      (state) => state.messageQueue.get(sessionKey)?.[0]?.id,
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
    async (
      activeClient = client,
      sessionId = session?.sessionId,
      options: {
        throwOnError?: boolean;
        shouldApply?: () => boolean;
      } = {},
    ): Promise<boolean> => {
      if (!activeClient || !sessionId) return false;
      const sessionBeforeRequest = useCodexStore.getState().sessions.get(sessionKey);
      const requestId = refreshControllerRef.current.beginRequest();
      const messages = await getSessionMessages(activeClient, sessionId, options);
      if (
        !refreshControllerRef.current.shouldApplyRequest(requestId) ||
        (options.shouldApply && !options.shouldApply())
      ) {
        return false;
      }
      const sessionAfterRequest = useCodexStore.getState().sessions.get(sessionKey);
      if (
        sessionAfterRequest?.sessionId !== sessionId ||
        sessionAfterRequest !== sessionBeforeRequest
      ) {
        return false;
      }
      refreshControllerRef.current.markActivity();
      setMessages(sessionKey, messages);
      return true;
    },
    [client, session?.sessionId, sessionKey, setMessages],
  );

  useEffect(() => {
    reconcileSequenceRef.current += 1;
    manualReconcileSequenceRef.current += 1;
    refreshControllerRef.current = createCodexSessionRefreshController();
    refreshControllerRef.current.markActivity();
    approvalSnapshotSequenceRef.current += 1;
    approvalActivitySequenceRef.current += 1;
    interactionSnapshotSequenceRef.current += 1;
    interactionActivitySequenceRef.current += 1;
    retryablePromptRef.current = null;
    // The pending "stopped" marker belongs to the session that was interrupted.
    // If the identity changed before the interrupt settled, writing it now would
    // append TURN_STOPPED_BY_USER to a transcript the user never stopped.
    awaitingStopMarkerRef.current = false;
  }, [sessionKey, session?.sessionId]);

  /**
   * Settles an unconfirmed dispatch against an authoritative terminal session.
   *
   * Call only once the transcript has been refreshed from the bridge. A user
   * echo proves delivery; otherwise the optimistic prompt is withdrawn and its
   * idempotency key is retained for a safe retry.
   */
  const resolveUnconfirmedDispatch = useCallback(() => {
    const store = useCodexStore.getState();
    const pending = store.unconfirmedDispatches.get(sessionKey);
    if (!pending) return;
    const resolution = store.settleUnconfirmedDispatch(sessionKey);
    if (resolution === "confirmed") {
      // The bridge echoed the prompt, so the dispatch did land and its key is
      // spent.
      retryablePromptRef.current = null;
      if (pending.requestId === initialPromptRequestId) {
        // The earlier ambiguous outcome released this mount's claim. Restore the
        // spent request claim before clearing durable pane intent so a remount
        // holding stale launch props cannot dispatch the same prompt again.
        store.claimPromptDispatch(sessionKey, pending.requestId);
        clearTabInitialPrompt(tabId, environmentId);
      }
      return;
    }

    if (resolution !== "retryable") return;
    retryablePromptRef.current = {
      fingerprint: pending.fingerprint,
      requestId: pending.requestId,
    };
  }, [
    clearTabInitialPrompt,
    environmentId,
    initialPromptRequestId,
    sessionKey,
    tabId,
  ]);

  const handleSend = useCallback(
    async (
      text: string,
      attachments: CodexAttachment[],
      logicalRequestId?: string,
    ): Promise<CodexDispatchResult> => {
      if (!client || !session?.sessionId) return "rejected";

      const fingerprint = JSON.stringify({
        text,
        attachments: attachments.map(({ path, previewUrl, name }) => ({
          path,
          previewUrl,
          name,
        })),
      });
      const durableRetry = useCodexStore
        .getState()
        .unconfirmedDispatches.get(sessionKey);
      const requestId =
        logicalRequestId
        ?? (retryablePromptRef.current?.fingerprint === fingerprint
          ? retryablePromptRef.current.requestId
          : durableRetry?.retryable && durableRetry.fingerprint === fingerprint
            ? durableRetry.requestId
            : createUuid());
      const clearMatchingUnconfirmedDispatch = () => {
        const store = useCodexStore.getState();
        if (store.unconfirmedDispatches.get(sessionKey)?.requestId === requestId) {
          store.clearUnconfirmedDispatch(sessionKey);
        }
      };
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
      dispatchInFlightRef.current += 1;
      let rawSendOutcome: Awaited<ReturnType<typeof sendPrompt>>;
      try {
        rawSendOutcome = await sendPrompt(client, session.sessionId, text, {
          attachments: promptAttachments.length > 0 ? promptAttachments : undefined,
          requestId,
        });
      } catch (error) {
        retryablePromptRef.current = { fingerprint, requestId };
        removeMessage(sessionKey, userMessage.id);
        setSessionLoading(sessionKey, false);
        throw error;
      } finally {
        dispatchInFlightRef.current -= 1;
      }
      const sent = normalizePromptSendOutcome(rawSendOutcome);
      if (sent.outcome === "rejected") {
        // A concrete HTTP rejection proves no turn is starting, so it is safe to
        // unlock and let the user correct or retry the prompt.
        retryablePromptRef.current = { fingerprint, requestId };
        removeMessage(sessionKey, userMessage.id);
        setSessionLoading(sessionKey, false);
        setSessionError(
          sessionKey,
          sent.httpStatus > 0
            ? `Failed to send prompt (HTTP ${sent.httpStatus})`
            : "Failed to send prompt",
        );
        return "rejected";
      }

      if (sent.outcome === "unknown") {
        /**
         * Do not unlock on a lost response.
         *
         * The bridge may already be running this request. Dropping `isLoading`
         * here would tear down both SSE and the watchdog and let a second prompt
         * overlap it. Keep the idempotency key for an explicit retry, mark the
         * phase as recovering, and reconcile before deciding whether the composer
         * can safely be released.
         */
        retryablePromptRef.current = { fingerprint, requestId };
        // Claimed before reconciling: if this reconcile cannot conclude, a later
        // authoritative idle state has to finish the job rather than silently
        // unlocking and stranding the message.
        useCodexStore.getState().setUnconfirmedDispatch(sessionKey, {
          userMessageId: userMessage.id,
          fingerprint,
          requestId,
        });
        setSessionPhase(sessionKey, "recovering");
        const reconciliation = await reconcileSessionStateRef.current({
          forceRefreshMessages: true,
        });
        const reconciledSession = useCodexStore.getState().sessions.get(sessionKey);

        if (reconciliation === "missing") {
          useCodexStore.getState().clearUnconfirmedDispatch(sessionKey);
          removeMessage(sessionKey, userMessage.id);
          setSessionPhase(sessionKey, undefined);
          setSessionLoading(sessionKey, false);
          setSessionError(sessionKey, "The Codex session is no longer available");
          return "rejected";
        } else if (reconciliation === "unavailable") {
          // Keep the lock. The running turn remains authoritative until status or
          // an SSE terminal event proves otherwise.
          if (!reconciledSession?.error) {
            setSessionError(
              sessionKey,
              "Lost connection while sending the prompt. Reconnecting to Codex…",
            );
          }
          return "unknown";
        } else if (
          reconciliation === "applied"
          && reconciledSession?.isLoading !== true
        ) {
          if (
            retryablePromptRef.current?.fingerprint === fingerprint
            && retryablePromptRef.current.requestId === requestId
          ) {
            // The fresh transcript did not echo this prompt. Reconciliation
            // retained the same idempotency key in both the ref and durable
            // dispatch store, so expose a safe retry without clearing either.
            return "rejected";
          }
          setSessionPhase(sessionKey, undefined);
          // The transcript proves the request completed despite the lost
          // response; its idempotency key is now spent.
          retryablePromptRef.current = null;
          setSessionError(sessionKey, undefined);
          clearMatchingUnconfirmedDispatch();
          return "accepted";
        }
        if (reconciliation === "applied" && reconciledSession?.isLoading === true) {
          // The authoritative status proves this request is running even though
          // the HTTP response was lost.
          clearMatchingUnconfirmedDispatch();
          return "accepted";
        }
        return "unknown";
      }
      /**
       * Any accepted dispatch spends the stored key.
       *
       * It used to be cleared only when the *same* request id came back, so a key
       * from a failed send outlived arbitrarily many unrelated prompts — and the
       * bridge's dispatch journal remembers a terminal record for 24 hours. A user
       * re-sending short text ("yes") would then hit the `already-processed` branch
       * below forever instead of running a turn.
      */
      retryablePromptRef.current = null;
      useCodexStore.getState().clearUnconfirmedDispatch(sessionKey);

      if (sent.status === "processing" && sent.duplicate) {
        /**
         * This logical request is already running.
         *
         * A StrictMode effect or a remount may have created a second local
         * optimistic bubble before the bridge attached this retry to the first
         * turn. Only one user message will exist in the authoritative
         * transcript. Refresh before discarding the extra bubble so a transient
         * transcript failure cannot erase the user's visible history.
         */
        try {
          const refreshed = await refreshMessages(client, session.sessionId, {
            throwOnError: true,
          });
          if (refreshed) {
            removeMessage(sessionKey, userMessage.id);
          }
        } catch {
          // The bridge already accepted this request, so keep its key spent and
          // preserve local messages until SSE or a later refresh reconciles them.
        }
        return "accepted";
      }

      if (sent.status === "already-processed" && sent.duplicate) {
        /**
         * The bridge recognised this request id as one it already ran to
         * completion, so no turn is starting. Treating it as a success would leave
         * an optimistic message and a permanent spinner waiting for a turn that
         * will never report.
         */
        removeMessage(sessionKey, userMessage.id);
        setSessionLoading(sessionKey, false);
        // A toast rather than the session error, which the next idle reconcile
        // clears — the user needs to know their prompt did not start a turn.
        toast.error("Codex had already run this prompt", {
          description: "It was not sent again. The transcript below is up to date.",
        });
        await refreshMessages(client, session.sessionId);
        return "accepted";
      }
      await refreshMessages(client, session.sessionId);
      return "accepted";
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
    async (text: string, attachments: CodexAttachment[]) => {
      const requestId = createUuid();
      await enqueueAgentPrompt<CodexQueuedMessage>("codex", sessionKey, {
        id: requestId,
        requestId,
        text,
        attachments,
        model: selectedModel,
        mode: selectedMode,
        reasoningEffort: selectedReasoningEffort,
        fastMode: fastModeEnabled,
      });
    },
    [fastModeEnabled, selectedMode, selectedModel, selectedReasoningEffort, sessionKey],
  );

  useNativeMessageQueue({
    agentLabel: "Codex",
    sessionKey,
    claimHead: () => claimAgentPromptQueueHead<CodexQueuedMessage>("codex", sessionKey),
    acknowledgeClaim: (claimToken) =>
      acknowledgeAgentPromptClaim("codex", sessionKey, claimToken),
    rejectClaim: (claimToken) =>
      rejectAgentPromptClaim("codex", sessionKey, claimToken),
    store: useCodexStore,
    canDrain:
      handoff.ready
      && !setupPending
      && connectionState === "connected"
      && !!client,
    queueLength,
    queueHeadId,
    isLoading: session?.isLoading ?? false,
    blockedByDraft: isQueueBlockedByDraft,
    send: (entry) =>
      handleSendRef.current?.(
        entry.text,
        entry.attachments,
        entry.requestId ?? entry.id,
      ),
    onError: (error) => {
      const errorText = `Failed to send queued prompt: ${
        error instanceof Error ? error.message : "Unknown error"
      }`;
      setSessionLoading(sessionKey, false);
      setSessionError(sessionKey, errorText);
      // Also recorded in the transcript, as Claude and OpenCode do — the error
      // banner is transient, and which queued prompt failed is worth keeping.
      addMessage(sessionKey, {
        id: `${ERROR_MESSAGE_PREFIX}${createUuid()}`,
        role: "assistant",
        content: errorText,
        parts: [{ type: "text", content: errorText }],
        createdAt: new Date().toISOString(),
      });
    },
  });

  const promoteNextQueuedPromptToDraft = useCallback(async () => {
    const store = useCodexStore.getState();
    const hasCurrentDraft =
      store.getDraftText(sessionKey).trim().length > 0 ||
      store.getAttachments(sessionKey).length > 0;
    if (hasCurrentDraft) return;

    const head = store.getQueuedMessages(sessionKey)[0];
    if (!head) return;
    const nextMessage = await transferAgentPromptToComposeDraft<CodexQueuedMessage>(
      "codex",
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
    store.setSelectedModel(sessionKey, nextMessage.model);
    store.setSelectedMode(sessionKey, nextMessage.mode);
    store.setSelectedReasoningEffort(sessionKey, nextMessage.reasoningEffort);
    store.setFastMode(sessionKey, nextMessage.fastMode);
  }, [sessionKey]);

  const handleStop = useCallback(async () => {
    if (!client || !session?.sessionId) return;

    setSessionError(sessionKey, undefined);

    /**
     * Stay in a loading state and show "Stopping…".
     *
     * `turn/interrupt` is asynchronous on the app-server engine: the turn is not
     * over until a terminal interrupted event arrives. Clearing the loading flag
     * here would re-enable the composer, and the next prompt would be rejected
     * with a 409 because the bridge still has a turn in flight. The status poll
     * and SSE clear the phase once the turn actually ends.
     */
    setSessionPhase(sessionKey, "cancelling");

    const outcome = await abortSession(client, session.sessionId);
    if (outcome.status === "accepted") {
      // The marker is written when the turn actually ends, not here — the
      // interrupt is asynchronous and the turn may still produce output.
      awaitingStopMarkerRef.current = true;
      await promoteNextQueuedPromptToDraft().catch((error) => {
        console.error("[CodexChatTab] Failed to promote queued prompt:", error);
      });
      return;
    }

    console.error(
      outcome.status === "unknown"
        ? "[CodexChatTab] Abort outcome is unknown; reconciling session"
        : `[CodexChatTab] Abort request was rejected with HTTP ${outcome.httpStatus}`,
    );

    const reconciliation = await reconcileSessionStateRef.current({
      forceRefreshMessages: true,
    });

    if (reconciliation === "missing") {
      // Only an authoritative missing-session response proves there is no turn
      // left to stop. A rejected interrupt does not prove that the pre-existing
      // turn ended, and an unavailable lookup cannot safely release the lock.
      setSessionPhase(sessionKey, undefined);
      setSessionLoading(sessionKey, false);
    }
  }, [
    client,
    promoteNextQueuedPromptToDraft,
    session?.sessionId,
    sessionKey,
    setSessionError,
    setSessionLoading,
    setSessionPhase,
  ]);

  /**
   * Write the "stopped" marker once the interrupted turn has actually settled.
   *
   * Codex cannot emit it from `handleStop` the way Claude and OpenCode do:
   * `turn/interrupt` is asynchronous, so at request time the turn may still be
   * producing output and the marker would land mid-transcript.
   */
  useEffect(() => {
    if (!awaitingStopMarkerRef.current) return;
    if (session?.isLoading !== false) return;

    awaitingStopMarkerRef.current = false;
    addMessage(sessionKey, {
      id: `${SYSTEM_MESSAGE_PREFIX}${createUuid()}`,
      role: "system",
      content: TURN_STOPPED_BY_USER,
      parts: [{ type: "text", content: TURN_STOPPED_BY_USER }],
      createdAt: new Date().toISOString(),
    });
  }, [addMessage, session?.isLoading, sessionKey]);

  useEscapeToStop({
    isActive,
    isLoading: session?.isLoading ?? false,
    onStop: handleStop,
  });

  /**
   * Reset everything a failed connection may have left behind, then re-init.
   *
   * This used to only flip the local flags, so a retry reconnected on top of a
   * stale client and session — matching Claude and OpenCode means dropping the
   * cached client, session and server status too.
   *
   * The exception is a transient disconnect: the background health check flips a
   * healthy tab to "error" on a single failed ping, and discarding the session
   * there would strand a live thread behind the resume dialog and start the user
   * in an empty one. The client and server status are still dropped — those are
   * what went stale — but the session id is kept so init reattaches to the
   * existing thread, falling back to a new session only if that fails.
   */
  const handleRetry = useCallback(() => {
    automaticInitRetryCountRef.current = 0;
    automaticInitRetryWindowStartedAtRef.current = Date.now();
    setupPendingObservedForInitRetryRef.current = false;
    const preserveSession = transientDisconnectRef.current;
    transientDisconnectRef.current = false;
    isInitializedRef.current = false;
    lastInitTimeRef.current = 0;
    setConnectionState("connecting");
    setErrorMessage(null);
    if (!preserveSession) {
      updateTabNativeSessionId(tabId, undefined, environmentId);
      clearPersistedVirtuosoState(sessionKey);
      setSession(sessionKey, null);
    }
    setClient(environmentId, null);
    setServerStatus(environmentId, { running: false, hostPort: null });
    setInitAttempt((value) => value + 1);
  }, [
    environmentId,
    sessionKey,
    setClient,
    setServerStatus,
    setSession,
    tabId,
    updateTabNativeSessionId,
  ]);

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

      // Invalidate every request tied to the previous bridge session before
      // publishing the new identity. This includes manual reconciles, whose
      // completion deliberately ignores ordinary live-event invalidation.
      reconcileSequenceRef.current += 1;
      manualReconcileSequenceRef.current += 1;
      approvalSnapshotSequenceRef.current += 1;
      approvalActivitySequenceRef.current += 1;
      interactionSnapshotSequenceRef.current += 1;
      interactionActivitySequenceRef.current += 1;
      refreshControllerRef.current = createCodexSessionRefreshController();

      // The tab key is stable across resume, while approvals/interactions are
      // bridge-session scoped. Replace the session and clear both collections
      // atomically so no render can post an old request to the resumed session.
      const withdrawnInteractionDraftKeys = (
        useCodexStore.getState().pendingInteractions.get(sessionKey) ?? []
      ).map((interaction) =>
        codexInteractionDraftKey(interaction.interactionId)
      );
      useCodexStore.setState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, {
          sessionId: resumed.session.sessionId,
          messages: resumed.messages,
          isLoading: false,
          title: resumed.session.title,
        });
        const pendingApprovals = new Map(state.pendingApprovals);
        pendingApprovals.delete(sessionKey);
        const pendingInteractions = new Map(state.pendingInteractions);
        pendingInteractions.delete(sessionKey);
        const sessionPhase = new Map(state.sessionPhase);
        sessionPhase.delete(sessionKey);
        const contextUsage = new Map(state.contextUsage);
        contextUsage.delete(sessionKey);
        return {
          sessions,
          pendingApprovals,
          pendingInteractions,
          sessionPhase,
          contextUsage,
        };
      });
      usePromptDraftStore
        .getState()
        .clearDrafts(withdrawnInteractionDraftKeys);
      updateTabNativeSessionId(tabId, resumed.session.sessionId, environmentId);
      clearTabAgentHandoff(tabId, environmentId);
      setResumeDialogOpen(false);
    },
    [
      client,
      clearTabAgentHandoff,
      fastModeEnabled,
      selectedModel,
      selectedMode,
      selectedReasoningEffort,
      sessionKey,
      tabId,
      updateTabNativeSessionId,
      environmentId,
    ],
  );

  const handleForkFromMessage = useCallback(async (
    messageId: string,
    kind: MessageForkKind,
  ) => {
    if (!client || !session?.sessionId) return;
    // A fork POSTs then opens a tab with a freshly generated id, so the pane
    // store's existing-id dedupe cannot collapse a double click: it would
    // create two server-side forks and two tabs. The ref latches synchronously
    // (before React has re-rendered the disabled button) and the state drives
    // the disabled attribute.
    if (forkInFlightRef.current) return;
    forkInFlightRef.current = true;
    setForkInFlight(true);
    try {
      const planned = requireCodexForkPlanEntry(
        forkPlanRef.current,
        messageId,
        kind,
      );

      let fork: Awaited<ReturnType<typeof forkCodexSession>>;
      if (planned.boundary.type === "message") {
        fork = await forkCodexSession(
          client,
          session.sessionId,
          planned.boundary.messageId,
        );
      } else {
        fork = await createSession(client, {
          title: session.title ? `${session.title} (fork)` : "Forked session",
          model: selectedModel,
          modelReasoningEffort: selectedReasoningEffort,
          mode: selectedMode,
          fastMode: fastModeEnabled,
        });
      }

      const paneStore = usePaneLayoutStore.getState();
      const forkTabId = createUuid();
      if (planned.kind === "prompt") {
        useCodexStore.getState().setDraftText(
          createSessionKey(environmentId, forkTabId),
          planned.draftText,
        );
      }
      paneStore.addTab(
        paneStore.getActivePaneId(environmentId),
        {
          id: forkTabId,
          type: "codex-native",
          displayTitle: fork.title ?? "Codex fork",
          codexNativeData: { ...data, sessionId: fork.sessionId },
        },
        environmentId,
      );

      const attachmentNotice = forkAttachmentNotice(planned.droppedAttachmentCount);
      if (attachmentNotice) toast.warning(attachmentNotice);
    } catch (error) {
      /*
       * The bridge answers a fork refusal with a differentiated status and its
       * own message (404 missing, 409 the turn is still running, 422 not a
       * usable fork point, 503 engine unavailable). Surfacing that verbatim is
       * the only way the user learns which one happened; the single "cannot be
       * used as a fork boundary" line used to blame the message even when the
       * real answer was "wait for the turn to finish".
       */
      toast.error(
        error instanceof CodexForkError
          ? error.message
          : "Failed to fork Codex session",
      );
    } finally {
      forkInFlightRef.current = false;
      setForkInFlight(false);
    }
  }, [
    client,
    data,
    environmentId,
    fastModeEnabled,
    selectedMode,
    selectedModel,
    selectedReasoningEffort,
    session?.sessionId,
    session?.title,
  ]);

  // None of these change while an answer streams in — the transcript is read
  // through `forkPlanRef` precisely so it cannot drag the handler's identity
  // with it. That keeps the cached fork elements below referentially stable per
  // message id, which is what lets `memo(NativeMessage)` hold on every tick.
  const forkAction = useMessageForkAction({
    agentLabel: "Codex",
    disabled: forkInFlight,
    onFork: handleForkFromMessage,
  });

  useEffect(() => {
    persistedPreferencesRef.current = getPersistedCodexPreferences(config);
  }, [config]);

  useEffect(() => {
    if (handoffPending) return;
    if (!isActive && !launchPromptRef.current?.trim() && queueLength === 0) return;

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
          acknowledgeInitialLaunchOptions();
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
            transientDisconnectRef.current = true;
            setClient(environmentId, null);
            setConnectionState("error");
            setErrorMessage("Codex bridge server disconnected. Click retry to reconnect.");
          }).catch(() => {
            if (!mounted) return;
            transientDisconnectRef.current = true;
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
            const restoredStatus = await getSessionStatus(
              cachedClient,
              data.sessionId,
              { throwOnError: true },
            );
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
              acknowledgeInitialLaunchOptions();
              return;
            }
            updateTabNativeSessionId(tabId, undefined, environmentId);
          }

          const created = await createSession(cachedClient, {
            model: resolvedSelection.model,
            modelReasoningEffort: resolvedSelection.reasoningEffort,
            mode: resolvedMode,
            fastMode: warmFastMode,
            clientSessionKey: sessionKey,
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
          acknowledgeInitialLaunchOptions();
          return;
        }

        setConnectionState("connecting");
        setErrorMessage(null);

        let port: number | null = null;
        let authToken: string | undefined;
        if (isLocal) {
          let status;
          try {
            status = await getLocalCodexServerStatus(environmentId);
          } catch (error) {
            throw classifyNewEnvironmentConnectionStartupError(error);
          }
          if (!status.running || !status.authToken) {
            const result = await startLocalCodexServer(environmentId);
            status = {
              running: true,
              port: result.port,
              pid: result.pid,
              authToken: result.authToken,
            };
          }
          if (!mounted) return;
          port = status.port;
          authToken = status.authToken;
        } else {
          if (!containerId) {
            throw new Error("Container ID is required for containerized Codex");
          }
          let status;
          try {
            status = await getCodexServerStatus(containerId);
          } catch (error) {
            throw classifyNewEnvironmentConnectionStartupError(error);
          }
          if (!status.running || !status.authToken) {
            const result = await startCodexServer(containerId);
            status = {
              running: true,
              hostPort: result.hostPort,
              authToken: result.authToken,
            };
          }
          if (!mounted) return;
          port = status.hostPort;
          authToken = status.authToken;
        }

        if (!port) {
          throw new Error("Failed to resolve Codex bridge port");
        }
        if (!authToken) {
          throw new Error("Failed to resolve Codex bridge authentication");
        }

        setServerStatus(environmentId, { running: true, hostPort: port });
        const nextClient = createClient(`http://127.0.0.1:${port}`, authToken);
        setClient(environmentId, nextClient);

        let healthy: boolean;
        try {
          healthy = await checkHealth(nextClient);
        } catch (error) {
          throw classifyNewEnvironmentConnectionStartupError(error);
        }
        if (!healthy) {
          throw new RetryableNewEnvironmentConnectionError(
            "Codex bridge health check failed",
          );
        }

        const { models: availableModels, source: modelsSource } = await getModels(nextClient);
        const availableSlashCommands = await getSlashCommands(nextClient);
        const codexState = useCodexStore.getState();
        if (
          // `app-server` is authoritative (model/list on the live binary), so it
          // replaces a stored catalog just as a warm cache does.
          modelsSource === "app-server"
          || modelsSource === "cache"
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
          ? await getSessionStatus(nextClient, existingSessionId, { throwOnError: true })
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
            clientSessionKey: sessionKey,
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
        acknowledgeInitialLaunchOptions();
      } catch (error) {
        if (!mounted) return;
        isInitializedRef.current = false;
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Failed to initialize Codex";
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
            `[CodexChatTab] Retrying new environment connection in ${delayMs}ms:`,
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
    acknowledgeInitialLaunchOptions,
    containerId,
    environmentId,
    handoffPending,
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

      const rawOutcome = await updateCodexSessionConfig(client, session.sessionId, {
        model,
        modelReasoningEffort: nextReasoningEffort,
        mode,
        fastMode,
      });
      const outcome = normalizeConfigUpdateOutcome(rawOutcome);

      if (outcome.outcome === "applied") {
        if (!outcome.durable) {
          toast.warning("Codex settings were applied but not saved", {
            description: "They may revert if the Codex bridge restarts.",
          });
        }
        return true;
      }

      setSessionError(
        sessionKey,
        outcome.outcome === "unknown"
          ? "Could not confirm whether Codex session settings were updated"
          : outcome.httpStatus > 0
            ? `Failed to update Codex session settings (HTTP ${outcome.httpStatus})`
            : "Failed to update Codex session settings",
      );
      return false;
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

  /**
   * Approvals are shown regardless of `isLoading`.
   *
   * They are deliberately not gated on a running turn: the request *is* what is
   * holding the turn open, and gating on our own view of loading state would hide
   * the only control that can unblock it if those two ever disagree.
   */
  const showApprovals =
    pendingApprovals.length > 0 && !!client && !!session?.sessionId;
  const showInteractions =
    pendingInteractions.length > 0 && !!client && !!session?.sessionId;

  const reconcileSessionState = useCallback(async (
    options?: ReconcileSessionOptions,
  ): Promise<ReconcileSessionResult> => {
    if (
      connectionState !== "connected"
      || !client
      || !session?.sessionId
    ) {
      return "unavailable";
    }

    /**
     * A background reconcile is invalidated by anything newer — another
     * reconcile, or any live SSE frame for this session. A manual one is only
     * invalidated by a newer *manual* refresh: the user asked for this, and a
     * watchdog tick or a `message.updated` frame arriving mid-flight must not
     * turn their refresh into a silent no-op.
     */
    const reconcileSequence = ++reconcileSequenceRef.current;
    const manualSequence = options?.manual
      ? ++manualReconcileSequenceRef.current
      : manualReconcileSequenceRef.current;
    const isLatestManual = () =>
      manualSequence === manualReconcileSequenceRef.current;
    const isLatestLiveState = () =>
      reconcileSequence === reconcileSequenceRef.current;
    const shouldApply = options?.manual ? isLatestManual : isLatestLiveState;
    const lookup = await lookupSessionStatus(client, session.sessionId);
    if (!shouldApply()) return "stale";

    if (lookup.kind === "missing") {
      if (options?.throwOnError) {
        throw new Error("The Codex session is no longer available on the server");
      }
      return "missing";
    }
    if (lookup.kind === "unavailable") {
      if (options?.throwOnError) {
        throw lookup.error;
      }
      return "unavailable";
    }

    if (options?.manual && !isLatestLiveState()) {
      /**
       * A live SSE frame landed after the manual status request began, so its
       * status/title/phase is newer than this HTTP snapshot and must win.
       *
       * Still honour the user's refresh by fetching the transcript *after* that
       * event. This avoids the old silent no-op without letting a stale `running`
       * response re-lock a session that just emitted `session.idle` (or a stale
       * `idle` response unlock a newly running turn).
       */
      const messageRefreshSequence = reconcileSequenceRef.current;
      await refreshMessages(client, session.sessionId, {
        throwOnError: options.throwOnError,
        shouldApply: () =>
          isLatestManual()
          && messageRefreshSequence === reconcileSequenceRef.current,
      });
      return "applied";
    }

    const status = lookup.session;
    refreshControllerRef.current.markActivity();

    /**
     * Rehydrate approvals from the bridge on every reconcile.
     *
     * This is the authoritative path, not the SSE frame: a tab that was unmounted
     * (or an environment that was in the background) when Codex asked for approval
     * never saw the event, and the turn is blocked until someone answers.
     */
    const approvalSnapshotSequence = ++approvalSnapshotSequenceRef.current;
    const approvalActivitySequence = approvalActivitySequenceRef.current;
    void fetchPendingApprovals(client, session.sessionId)
      .then((approvals) => {
        /**
         * Deliberately not gated on the reconcile sequence.
         *
         * This snapshot is the *only* rehydration path for a tab that was
         * unmounted when the approval was raised — its resubscription has no
         * cursor, so the bridge replays nothing. Discarding it because an
         * unrelated `message.updated` frame arrived meanwhile would leave the
         * turn blocked on a card nobody can see. The two approval-specific
         * counters below are the correct invalidation: a newer snapshot, or a
         * live approval event that already moved the list.
         */
        if (
          approvalSnapshotSequence === approvalSnapshotSequenceRef.current
          && approvalActivitySequence === approvalActivitySequenceRef.current
        ) {
          setPendingApprovals(sessionKey, approvals);
        }
      })
      .catch((error: unknown) => {
        console.error("[CodexChatTab] Failed to rehydrate approvals:", error);
      });

    const interactionSnapshotSequence = ++interactionSnapshotSequenceRef.current;
    const interactionActivitySequence = interactionActivitySequenceRef.current;
    void fetchPendingInteractions(client, session.sessionId)
      .then((interactions) => {
        if (
          interactionSnapshotSequence === interactionSnapshotSequenceRef.current
          && interactionActivitySequence === interactionActivitySequenceRef.current
        ) {
          setPendingInteractions(sessionKey, interactions);
        }
      })
      .catch((error: unknown) => {
        console.error("[CodexChatTab] Failed to rehydrate interactions:", error);
      });

    if (typeof status.title === "string" && status.title.trim().length > 0) {
      setSessionTitle(sessionKey, status.title);
    }
    if (status.contextUsage) {
      setContextUsage(sessionKey, status.contextUsage);
    }

    /**
     * Track the engine's own phase.
     *
     * `cancelling` and `recovering` arrive as `status: "running"`, so this is the
     * only place the distinction is visible. Clearing it on a terminal status is
     * what lets the composer re-enable after a stop actually completes.
     */
    setSessionPhase(
      sessionKey,
      status.status === "running" ? status.phase : undefined,
    );

    if (status.status === "idle") {
      const hasUnconfirmedDispatch =
        useCodexStore.getState().unconfirmedDispatches.has(sessionKey);
      if (!hasUnconfirmedDispatch) {
        // Apply an ordinary terminal snapshot before awaiting transcript I/O.
        // A new dispatch can start while that read is in flight, and a delayed
        // completion must not clear the newer dispatch's error or loading state.
        setSessionLoading(sessionKey, false);
        setSessionError(sessionKey, undefined);
      }
      let refreshed: boolean;
      try {
        refreshed = await refreshMessages(client, session.sessionId, {
          throwOnError: hasUnconfirmedDispatch || options?.throwOnError,
          shouldApply,
        });
      } catch (error) {
        if (options?.throwOnError) throw error;
        console.error(
          "[CodexChatTab] Failed to refresh terminal transcript:",
          error,
        );
        return "unavailable";
      }
      if (!shouldApply()) return "stale";
      if (!refreshed) return "stale";
      if (hasUnconfirmedDispatch) {
        // Ambiguous dispatches need the fresh transcript before they can safely
        // unlock or expose a same-key retry.
        setSessionLoading(sessionKey, false);
        setSessionError(sessionKey, undefined);
      }
      // Authoritative idle plus a fresh transcript is exactly what an earlier
      // unresolved dispatch was waiting for. A superseded refresh is not proof:
      // resolving from whatever transcript happens to be in the store can
      // classify a landed prompt as missing while a newer refresh is applying
      // its authoritative echo.
      resolveUnconfirmedDispatch();
      return "applied";
    }

    if (status.status === "error") {
      const error = status.error?.trim() || "Codex session failed";
      setSessionError(sessionKey, error);
      setErrorMessage(error);
      const hasUnconfirmedDispatch =
        useCodexStore.getState().unconfirmedDispatches.has(sessionKey);
      let refreshed: boolean;
      try {
        refreshed = await refreshMessages(client, session.sessionId, {
          // An empty fallback transcript is not evidence that an ambiguous
          // dispatch missed the server. Preserve loading so the app-level poller
          // can retry when this authoritative read fails.
          throwOnError: hasUnconfirmedDispatch || options?.throwOnError,
          shouldApply,
        });
      } catch (refreshError) {
        if (options?.throwOnError) throw refreshError;
        console.error(
          "[CodexChatTab] Failed to refresh terminal transcript:",
          refreshError,
        );
        return "unavailable";
      }
      if (!shouldApply()) return "stale";
      if (refreshed) resolveUnconfirmedDispatch();
      if (!refreshed) return "stale";
      setSessionLoading(sessionKey, false);
      // Safe-retry settlement writes its own explanatory error. The actual
      // terminal engine error remains the primary failure shown to the user.
      setSessionError(sessionKey, error);
      return "applied";
    }

    setSessionLoading(sessionKey, true);
    if (options?.forceRefreshMessages) {
      await refreshMessages(client, session.sessionId, {
        throwOnError: options.throwOnError,
        shouldApply,
      });
    }
    return "applied";
  }, [
    client,
    connectionState,
    refreshMessages,
    resolveUnconfirmedDispatch,
    session?.sessionId,
    sessionKey,
    setPendingApprovals,
    setPendingInteractions,
    setContextUsage,
    setSessionError,
    setSessionLoading,
    setSessionPhase,
    setSessionTitle,
  ]);

  useEffect(() => {
    reconcileSessionStateRef.current = reconcileSessionState;
  }, [reconcileSessionState]);

  const refreshManually = useCallback(async () => {
    const result = await reconcileSessionState({
      forceRefreshMessages: true,
      throwOnError: true,
      manual: true,
    });
    if (result === "stale") {
      // Only a newer manual refresh can get here, and that request owns the
      // outcome. Logged rather than swallowed so a refresh that legitimately
      // did nothing is still traceable.
      console.debug("[CodexChatTab] Manual refresh superseded by a newer refresh");
    }
  }, [reconcileSessionState]);

  useManualSessionRefresh({
    refreshRequestId,
    isReady:
      connectionState === "connected" && !!client && !!session?.sessionId,
    agentLabel: "Codex",
    refresh: refreshManually,
  });

  useEffect(() => {
    if (
      connectionState !== "connected"
      || !client
      || !session?.sessionId
      || hasPendingInitialPrompt(launchPrompt, initialPromptSent)
    ) {
      return;
    }

    void reconcileSessionState();
  }, [
    client,
    connectionState,
    launchPrompt,
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
        /**
         * Reconnect from where we left off.
         *
         * The cursor is what turns a dropped stream from "refetch the whole
         * transcript" into "send me the four frames I missed". It is only null on
         * the very first attempt; after that the bridge replays, or tells us it
         * cannot and we fall back to a full reconcile.
         */
        const cursor = eventCursorRef.current;
        let receivedAnyFrame = false;

        try {
          for await (const event of subscribeToEvents(
            client,
            abortController.signal,
            cursor ?? undefined,
            session.sessionId,
          )) {
            if (!event || typeof event.type !== "string") {
              console.warn("[CodexChatTab] Received malformed event, skipping");
              continue;
            }

            receivedAnyFrame = true;

            // Advanced for *every* frame, including other sessions' and keepalives:
            // the cursor tracks the bridge-wide stream, so skipping any revision
            // would make the next reconnect ask for frames we already have.
            if (typeof event.revision === "number") {
              eventCursorRef.current = event.revision;
            }

            if (event.type === "session.reconcile-required") {
              /**
               * Our gap was longer than the bridge's ring, or the bridge restarted
               * and our cursor is from a revision sequence that no longer exists.
               * This is the one case that still needs the expensive full resync.
               *
               * The cursor update above is what stops this repeating: this frame
               * carries the bridge's current revision, so the next reconnect asks
               * from a position the bridge can actually serve.
               */
              console.warn("[CodexChatTab] Event replay unavailable; reconciling");
              await reconcileSessionState({ forceRefreshMessages: true });
              continue;
            }

            if (event.sessionId !== session.sessionId) {
              continue;
            }

            // Any current-session SSE event is newer than a status snapshot
            // that was already in flight. Invalidate every reconcile source
            // (initial hydration, watchdog, reconnect, stop, and manual refresh)
            // before applying the live event so a delayed snapshot cannot roll
            // idle/error/phase/title/approval state backwards.
            reconcileSequenceRef.current += 1;
            refreshControllerRef.current.markActivity();

            if (event.type === "session.approval-requested") {
              // Validated exactly like the `/approvals` snapshot: an SSE frame is
              // no more trustworthy than an HTTP body, and the two paths must not
              // disagree about what a renderable approval is.
              const approval = parseApproval(event.data?.approval);
              if (approval) {
                approvalActivitySequenceRef.current += 1;
                addPendingApproval(sessionKey, approval);
              }
              continue;
            }

            if (event.type === "session.approval-resolved") {
              const approvalId = event.data?.approvalId;
              if (typeof approvalId === "string") {
                approvalActivitySequenceRef.current += 1;
                removePendingApproval(sessionKey, approvalId);
              }
              continue;
            }

            if (event.type === "session.interaction-requested") {
              const interaction = parseInteraction(event.data?.interaction);
              if (interaction) {
                interactionActivitySequenceRef.current += 1;
                addPendingInteraction(sessionKey, interaction);
              }
              continue;
            }

            if (event.type === "session.interaction-resolved") {
              const interactionId = event.data?.interactionId;
              if (typeof interactionId === "string") {
                interactionActivitySequenceRef.current += 1;
                removePendingInteraction(sessionKey, interactionId);
              }
              continue;
            }

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
              // Validate exactly like the HTTP path does. A bare cast here let a
              // malformed frame reach `usage.percentUsed.toFixed(...)` in the
              // agent-info popover and throw inside render.
              const usageFromEvent = parseContextUsage(event.data?.contextUsage);
              if (usageFromEvent) {
                setContextUsage(sessionKey, usageFromEvent);
              }
              const phase = event.data?.phase;
              if (isCodexSessionPhase(phase)) {
                const terminal = phase === "idle" || phase === "failed";
                setSessionPhase(sessionKey, terminal ? undefined : phase);
                /**
                 * A terminal phase here can be recovery reporting that the
                 * *previous* turn is over while our own prompt POST is still in
                 * flight. Clearing the loading flag then tears down both this
                 * subscription and the watchdog, and neither re-arms, so the
                 * transcript freezes until the tab remounts. `session.idle` and
                 * `session.error` remain authoritative for unlocking.
                 */
                if (!terminal || dispatchInFlightRef.current === 0) {
                  setSessionLoading(sessionKey, !terminal);
                }
              } else {
                setSessionLoading(sessionKey, true);
              }
              continue;
            }

            if (event.type === "session.idle") {
              const hasUnconfirmedDispatch =
                useCodexStore.getState().unconfirmedDispatches.has(sessionKey);
              setSessionPhase(sessionKey, undefined);
              if (!hasUnconfirmedDispatch) {
                setSessionLoading(sessionKey, false);
                setSessionError(sessionKey, undefined);
              }
              const title = event.data?.title;
              if (typeof title === "string" && title.trim().length > 0) {
                setSessionTitle(sessionKey, title);
              }
              const refreshed = await refreshMessages(
                client,
                session.sessionId,
                { throwOnError: hasUnconfirmedDispatch },
              );
              if (hasUnconfirmedDispatch && refreshed) {
                setSessionLoading(sessionKey, false);
                setSessionError(sessionKey, undefined);
              }
              // The transcript is now authoritative for this idle turn, so an
              // earlier unconfirmed dispatch can finally be settled.
              if (refreshed) {
                resolveUnconfirmedDispatch();
              }
              if (!hasUnconfirmedDispatch && refreshed) {
                // This completed turn spends any ordinary local retry key.
                retryablePromptRef.current = null;
              }
              continue;
            }

            if (event.type === "session.title-updated") {
              const title = event.data?.title;
              if (typeof title === "string" && title.trim().length > 0) {
                setSessionTitle(sessionKey, title);
              }
              continue;
            }

            if (event.type === "session.warning") {
              const warning =
                typeof event.data?.error === "string"
                  ? event.data.error
                  : "Codex reported a non-terminal turn error";
              // Standalone app-server errors are advisory: Codex may retry or
              // continue the turn. Keep the overlap lock, SSE subscription and
              // watchdog alive until a real terminal event arrives.
              console.warn("[CodexChatTab] Codex turn warning:", warning);
              continue;
            }

            if (event.type === "session.error") {
              const error =
                typeof event.data?.error === "string"
                  ? event.data.error
                  : "Codex session failed";
              const hasUnconfirmedDispatch =
                useCodexStore.getState().unconfirmedDispatches.has(sessionKey);
              setSessionPhase(sessionKey, undefined);
              setSessionError(sessionKey, error);
              setErrorMessage(error);
              const refreshed = await refreshMessages(
                client,
                session.sessionId,
                { throwOnError: hasUnconfirmedDispatch },
              );
              if (refreshed) resolveUnconfirmedDispatch();
              if (refreshed) {
                setSessionLoading(sessionKey, false);
              }
              // Preserve the server's terminal error over the safe-retry copy
              // written when the authoritative transcript has no user echo.
              setSessionError(sessionKey, error);
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

        /**
         * Only resync when the replay could not have covered us.
         *
         * If we received at least one frame, the bridge either replayed our gap or
         * told us to reconcile — either way the state is current, and a blanket
         * `/messages` refetch on every blip is pure waste on a long session. If we
         * received nothing, the connection itself failed, and reconciling is how a
         * dead session or a stopped bridge gets detected instead of looping here
         * forever.
         */
        if (!receivedAnyFrame) {
          await reconcileSessionState();
        }

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
    addPendingApproval,
    client,
    connectionState,
    refreshMessages,
    reconcileSessionState,
    removePendingApproval,
    resolveUnconfirmedDispatch,
    session?.isLoading,
    session?.sessionId,
    sessionKey,
    setSessionError,
    setSessionLoading,
    setSessionPhase,
    setSessionTitle,
    upsertMessage,
  ]);

  // Watchdog poll for stalled turns. Mirrors the SSE gate above so it also
  // runs for hidden background mounts during a turn.
  useStalledTurnWatchdog({
    agentLabel: "Codex",
    isLoading: session?.isLoading ?? false,
    isReady:
      connectionState === "connected" && !!client && !!session?.sessionId,
    reconcile: () => reconcileSessionState({ forceRefreshMessages: true }),
    shouldReconcile: () => refreshControllerRef.current.shouldRefresh(),
  });

  useEffect(() => {
    if (
      connectionState !== "connected"
      || !session?.sessionId
      || !handoff.ready
      || !launchPrompt
      || initialPromptSent
      || initialPromptDispatchClaimed
      || setupPending
    ) {
      return;
    }

    if (!claimPromptDispatch(sessionKey, initialPromptRequestId)) {
      return;
    }
    let accepted = false;
    setInitialPromptSent(true);
    // Keep the durable launch intent until the bridge accepts the turn (or
    // authoritative reconciliation proves that it did). If the renderer
    // disappears during rename or dispatch, a remount retries with this same
    // idempotency key instead of losing the prompt or creating a second turn.
    void handleSend(
      launchPrompt,
      [],
      initialPromptRequestId,
    ).then((result) => {
      if (result === "accepted") {
        accepted = true;
        initialPromptRetryCountRef.current = 0;
        clearTabInitialPrompt(tabId, environmentId);
      } else if (
        result === "rejected"
        && initialPromptRetryCountRef.current < 1
      ) {
        initialPromptRetryCountRef.current += 1;
        initialPromptRetryTimerRef.current = setTimeout(() => {
          initialPromptRetryTimerRef.current = null;
          setInitialPromptSent(false);
        }, 1_000);
      }
    }).catch((error) => {
      console.error("[CodexChatTab] Failed to dispatch initial prompt:", error);
      setSessionError(
        sessionKey,
        error instanceof Error ? error.message : "Failed to send initial prompt",
      );
      if (initialPromptRetryCountRef.current < 1) {
        initialPromptRetryCountRef.current += 1;
        initialPromptRetryTimerRef.current = setTimeout(() => {
          initialPromptRetryTimerRef.current = null;
          setInitialPromptSent(false);
        }, 1_000);
      }
    }).finally(() => {
      /**
       * An accepted initial request is one-shot for the lifetime of this tab.
       * Keep its claim until session cleanup so another live mount cannot race
       * the pane-store update and recreate the optimistic bubble. A renderer
       * restart recreates the store, so durable crash recovery remains intact.
       */
      if (!accepted) {
        releasePromptDispatch(sessionKey, initialPromptRequestId);
      }
    });
  }, [
    claimPromptDispatch,
    clearTabInitialPrompt,
    connectionState,
    environmentId,
    handleSend,
    handoff.ready,
    initialPromptDispatchClaimed,
    initialPromptRequestId,
    launchPrompt,
    releasePromptDispatch,
    sessionKey,
    setSessionError,
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

  return (
    <NativeChatShell
      agentLabel="Codex"
      isActive={ownsGlobalShortcuts}
      containerId={containerId}
      connectionState={connectionState}
      errorMessage={errorMessage}
      serverLog={serverLog}
      onRetry={handleRetry}
      messages={displayMessages}
      resolveModelLabel={resolveModelLabel}
      isLoading={session?.isLoading ?? false}
      statusLabel={
        /*
         * Distinguish the transient app-server phases. Both are still
         * "loading" — the turn may be executing — but they mean something
         * different to the user than ordinary thinking.
         */
        sessionPhase === "cancelling" ? (
          <span role="status" className="text-xs">Stopping…</span>
        ) : sessionPhase === "recovering" ? (
          <span role="status" className="text-xs">Reconnecting to Codex…</span>
        ) : undefined
      }
      elapsedSeconds={elapsedSeconds}
      finalElapsedSeconds={finalElapsedSeconds}
      centerCompose={centerCompose}
      isAtBottom={isAtBottom}
      scrollToBottom={scrollToBottom}
      scrollProps={scrollProps}
      virtuosoRef={virtuosoRef}
      onResumeClick={client ? () => setResumeDialogOpen(true) : undefined}
      // h-32 ≈ compose bar; h-80 adds room for the plan card (~230px) above it
      bottomSpacerClassName={showPlanModeCard ? "h-80" : "h-32"}
      messageActions={(message) => {
        // Presence in the plan *is* the gate: a message Codex has no usable
        // turn boundary for never made it in, so it cannot render a button the
        // click handler would then have to refuse.
        const planned = forkPlan.get(message.id);
        return planned ? forkAction(message.id, planned.kind) : undefined;
      }}
      blockingCards={
        showApprovals || showInteractions ? (
          <>
            {showApprovals
              ? pendingApprovals.map((approval) => (
                  <CodexApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    client={client!}
                    sessionId={session!.sessionId!}
                    sessionKey={sessionKey}
                  />
                ))
              : null}
            {showInteractions
              ? pendingInteractions.map((interaction) => (
                  <CodexInteractionCard
                    key={interaction.interactionId}
                    interaction={interaction}
                    client={client!}
                    sessionId={session!.sessionId!}
                    sessionKey={sessionKey}
                  />
                ))
              : null}
          </>
        ) : null
      }
      pinnedAccessory={
        showPlanModeCard ? (
          <CodexPlanModeCard
            className="mx-0 my-0"
            isSubmitting={isPlanTransitionPending}
            onApproveAndBuild={handleApprovePlan}
            onSwitchToBuild={handleSwitchPlanToBuild}
            onDismiss={() =>
              setDismissedPlanReviewMessageId(latestAssistantMessage?.id ?? null)
            }
          />
        ) : null
      }
      composer={
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
          disabled={!handoff.ready || !session?.sessionId}
          isLoading={session?.isLoading ?? false}
          queueLength={queueLength}
          onSend={async (text, attachments) => {
            await handleSend(text, attachments);
          }}
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
      }
      resumeDialog={
        client ? (
          <CodexResumeSessionDialog
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
