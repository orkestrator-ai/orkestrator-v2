import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowDown, History, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AgentThinkingIndicator } from "@/components/chat/AgentThinkingIndicator";
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
  type CodexPromptAcceptedResponse,
  type CodexPromptAttachment,
  type CodexPromptSendOutcome,
  type CodexReasoningEffort,
  type CodexSessionConfigUpdateOutcome,
  DEFAULT_CODEX_MODEL,
  abortSession,
  checkHealth,
  createClient,
  createSession,
  fetchPendingApprovals,
  getModels,
  getSlashCommands,
  getSessionMessages,
  getSessionStatus,
  isCodexSessionPhase,
  lookupSessionStatus,
  parseApproval,
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
import { CodexComposeBar } from "./CodexComposeBar";
import { CodexApprovalCard } from "./CodexApprovalCard";
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
  initialAgentModel?: string;
  initialReasoningEffort?: string;
  refreshRequestId?: number;
}

type ConnectionState = "connecting" | "connected" | "error";

const DEFAULT_CODEX_MODE: CodexConversationMode = "build";
const DEFAULT_REASONING_EFFORT: CodexReasoningEffort = "medium";
type CodexSendHandler = (
  text: string,
  attachments: CodexAttachment[],
  requestId?: string,
) => Promise<void>;
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
  initialPrompt,
  isReviewTab = false,
  initialAgentModel,
  initialReasoningEffort,
  refreshRequestId = 0,
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
  const lastHandledRefreshRequestIdRef = useRef(0);
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
  const unconfirmedDispatchRef = useRef<{ userMessageId: string } | null>(null);
  const refreshControllerRef = useRef(createCodexSessionRefreshController());
  /**
   * Last bridge event revision this tab processed.
   *
   * A ref, not state: it is written from inside the SSE loop on every frame and
   * must never trigger a render or be captured stale by the loop's closure.
   */
  const eventCursorRef = useRef<number | null>(null);
  const sessionKey = useMemo(
    () => createCodexSessionKey(environmentId, tabId),
    [environmentId, tabId],
  );
  const initialLaunchOptionsRef = useRef({
    model: initialAgentModel,
    reasoningEffort: initialReasoningEffort,
  });
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
    if (initialLaunchModel || initialLaunchReasoningEffort) {
      clearTabInitialAgentOptions(tabId, environmentId);
    }
  }, [
    clearTabInitialAgentOptions,
    environmentId,
    initialLaunchModel,
    initialLaunchReasoningEffort,
    sessionKey,
    tabId,
  ]);
  const config = useConfigStore((state) => state.config);
  const setConfig = useConfigStore((state) => state.setConfig);
  const persistedPreferencesRef = useRef(getPersistedCodexPreferences(config));

  const models = useCodexStore((state) => state.models);
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
  const setPendingApprovals = useCodexStore((state) => state.setPendingApprovals);
  const addPendingApproval = useCodexStore((state) => state.addPendingApproval);
  const removePendingApproval = useCodexStore((state) => state.removePendingApproval);
  const setSelectedModel = useCodexStore((state) => state.setSelectedModel);
  const setSelectedMode = useCodexStore((state) => state.setSelectedMode);
  const setSelectedReasoningEffort = useCodexStore((state) => state.setSelectedReasoningEffort);
  const setFastMode = useCodexStore((state) => state.setFastMode);
  const addToQueue = useCodexStore((state) => state.addToQueue);
  const removeFromQueue = useCodexStore((state) => state.removeFromQueue);
  const client = useCodexStore(
    useCallback((state) => state.clients.get(environmentId), [environmentId]),
  );
  const session = useCodexStore(
    useCallback((state) => state.sessions.get(sessionKey), [sessionKey]),
  );
  const sessionPhase = useCodexStore(
    useCallback((state) => state.sessionPhase.get(sessionKey), [sessionKey]),
  );
  const storedPendingApprovals = useCodexStore(
    useCallback((state) => state.pendingApprovals.get(sessionKey), [sessionKey]),
  );
  const pendingApprovals = storedPendingApprovals ?? [];
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

  const { clearTabInitialPrompt, updateTabNativeSessionId } = usePaneLayoutStore();

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
  const displayMessages = useMemo(
    () => sessionMessages.map(normalizeCodexNativeMessage),
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
  /** Lets a finished drain start the next one without re-declaring the callback. */
  const processQueueRef = useRef<() => void>(() => {});
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
    retryablePromptRef.current = null;
    unconfirmedDispatchRef.current = null;
  }, [sessionKey, session?.sessionId]);

  /**
   * Settles an unconfirmed dispatch against an authoritative idle session.
   *
   * Call only once the transcript has been refreshed from the bridge: if the
   * optimistic message survived that refresh, the server never recorded the
   * prompt, so it must be withdrawn and offered for retry instead of sitting in
   * the transcript as if Codex had seen it.
   */
  const resolveUnconfirmedDispatch = useCallback(() => {
    const pending = unconfirmedDispatchRef.current;
    if (!pending) return;
    unconfirmedDispatchRef.current = null;

    const current = useCodexStore.getState().sessions.get(sessionKey);
    const stillPresent = current?.messages.some(
      (message) => message.id === pending.userMessageId,
    ) === true;
    if (!stillPresent) {
      // The bridge echoed the prompt, so the dispatch did land and its key is
      // spent.
      retryablePromptRef.current = null;
      return;
    }

    removeMessage(sessionKey, pending.userMessageId);
    setSessionError(
      sessionKey,
      "Could not confirm whether Codex received the prompt. You can send it again safely.",
    );
  }, [removeMessage, sessionKey, setSessionError]);

  const handleSend = useCallback(
    async (
      text: string,
      attachments: CodexAttachment[],
      logicalRequestId?: string,
    ) => {
      if (!client || !session?.sessionId) return;

      const fingerprint = JSON.stringify({
        text,
        attachments: attachments.map(({ path, previewUrl, name }) => ({
          path,
          previewUrl,
          name,
        })),
      });
      const requestId =
        logicalRequestId
        ?? (retryablePromptRef.current?.fingerprint === fingerprint
          ? retryablePromptRef.current.requestId
          : createUuid());
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
        return;
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
        unconfirmedDispatchRef.current = { userMessageId: userMessage.id };
        setSessionPhase(sessionKey, "recovering");
        const reconciliation = await reconcileSessionStateRef.current({
          forceRefreshMessages: true,
        });
        const reconciledSession = useCodexStore.getState().sessions.get(sessionKey);

        if (reconciliation === "missing") {
          unconfirmedDispatchRef.current = null;
          removeMessage(sessionKey, userMessage.id);
          setSessionPhase(sessionKey, undefined);
          setSessionLoading(sessionKey, false);
          setSessionError(sessionKey, "The Codex session is no longer available");
        } else if (reconciliation === "unavailable") {
          // Keep the lock. The running turn remains authoritative until status or
          // an SSE terminal event proves otherwise.
          setSessionError(
            sessionKey,
            "Lost connection while sending the prompt. Reconnecting to Codex…",
          );
        } else if (
          reconciliation === "applied"
          && reconciledSession?.isLoading !== true
        ) {
          const optimisticStillPresent = reconciledSession?.messages.some(
            (message) => message.id === userMessage.id,
          ) === true;
          unconfirmedDispatchRef.current = null;
          if (optimisticStillPresent) {
            // Authoritative idle state did not echo the prompt, so expose a
            // retryable failure rather than leaving a local-only user message.
            removeMessage(sessionKey, userMessage.id);
            setSessionError(
              sessionKey,
              "Could not confirm whether Codex received the prompt. You can send it again safely.",
            );
          } else {
            // The transcript proves the request completed despite the lost
            // response; its idempotency key is now spent.
            retryablePromptRef.current = null;
            setSessionError(sessionKey, undefined);
          }
          setSessionPhase(sessionKey, undefined);
        }
        return;
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
      const requestId = createUuid();
      addToQueue(sessionKey, {
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

    const sendPromise = handleSendRef.current?.(
      nextMessage.text,
      nextMessage.attachments,
      nextMessage.requestId ?? nextMessage.id,
    );

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
        /**
         * Normally the effect watching isLoading/queueLength drives the next
         * drain, so this does not recurse. But that effect can fire *while* this
         * send is still in flight — the re-entrancy guard above turns that into a
         * no-op — and if the turn settled in the same pass there is no later
         * dependency change to retry on, stranding the rest of the queue. Only
         * re-enter when the queue is genuinely idle with work left; each pass
         * dequeues one entry, so this cannot spin.
         */
        const settled = useCodexStore.getState();
        if (
          (settled.messageQueue.get(sessionKey)?.length ?? 0) > 0
          && settled.sessions.get(sessionKey)?.isLoading !== true
        ) {
          processQueueRef.current();
        }
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

  useEffect(() => {
    processQueueRef.current = processQueue;
  }, [processQueue]);

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

    if (typeof status.title === "string" && status.title.trim().length > 0) {
      setSessionTitle(sessionKey, status.title);
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
      setSessionLoading(sessionKey, false);
      setSessionError(sessionKey, undefined);
      await refreshMessages(client, session.sessionId, {
        throwOnError: options?.throwOnError,
        shouldApply,
      });
      // Authoritative idle plus a fresh transcript is exactly what an earlier
      // unresolved dispatch was waiting for.
      if (shouldApply()) resolveUnconfirmedDispatch();
      return "applied";
    }

    if (status.status === "error") {
      const error = status.error?.trim() || "Codex session failed";
      setSessionLoading(sessionKey, false);
      setSessionError(sessionKey, error);
      setErrorMessage(error);
      await refreshMessages(client, session.sessionId, {
        throwOnError: options?.throwOnError,
        shouldApply,
      });
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
    setSessionError,
    setSessionLoading,
    setSessionPhase,
    setSessionTitle,
  ]);

  useEffect(() => {
    reconcileSessionStateRef.current = reconcileSessionState;
  }, [reconcileSessionState]);

  useEffect(() => {
    if (
      refreshRequestId <= lastHandledRefreshRequestIdRef.current ||
      connectionState !== "connected" ||
      !client ||
      !session?.sessionId
    ) {
      return;
    }

    lastHandledRefreshRequestIdRef.current = refreshRequestId;
    void reconcileSessionState({
      forceRefreshMessages: true,
      throwOnError: true,
      manual: true,
    }).then((result) => {
      if (result === "stale") {
        // Only a newer manual refresh can get here, and that request owns the
        // outcome. Logged rather than swallowed so a refresh that legitimately
        // did nothing is still traceable.
        console.debug("[CodexChatTab] Manual refresh superseded by a newer refresh");
      }
    }).catch((error) => {
      console.error("[CodexChatTab] Manual refresh failed:", error);
      toast.error("Failed to refresh Codex tab", {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [
    client,
    connectionState,
    reconcileSessionState,
    refreshRequestId,
    session?.sessionId,
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
              // The turn this session was running has finished, so any idempotency
              // key held for an ambiguous earlier dispatch is spent: reusing it
              // would make the bridge answer `already-processed` for a genuinely
              // new prompt.
              retryablePromptRef.current = null;
              setSessionPhase(sessionKey, undefined);
              setSessionLoading(sessionKey, false);
              setSessionError(sessionKey, undefined);
              const title = event.data?.title;
              if (typeof title === "string" && title.trim().length > 0) {
                setSessionTitle(sessionKey, title);
              }
              await refreshMessages(client, session.sessionId);
              // The transcript is now authoritative for this idle turn, so an
              // earlier unconfirmed dispatch can finally be settled.
              resolveUnconfirmedDispatch();
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
              setSessionPhase(sessionKey, undefined);
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
                      {/*
                        Distinguish the transient app-server phases. Both are
                        still "loading" — the turn may be executing — but they mean
                        something different to the user than ordinary thinking.
                      */}
                      {sessionPhase === "cancelling" ? (
                        <span role="status" className="text-xs">Stopping…</span>
                      ) : sessionPhase === "recovering" ? (
                        <span role="status" className="text-xs">
                          Reconnecting to Codex…
                        </span>
                      ) : (
                        <AgentThinkingIndicator agentName="Codex" />
                      )}
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
          !isAtBottom || showPlanModeCard || showApprovals ? (
            <div className="flex w-full flex-col gap-2">
              {/*
                * Pinned directly above the composer rather than placed in the
                * message list: the turn is *blocked* on these, so they must be
                * visible without scrolling, and they must not move as new
                * messages stream in.
                */}
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
