import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown, X } from "lucide-react";
import {
  resolveReasoningId,
  type NativeAgentBackgroundTaskSummary,
} from "@orkestrator/protocol/native-agent";
import {
  isProviderSlashCommand,
  resolveSessionActionCommand,
} from "@orkestrator/protocol/agent-slash-commands";
import { Button } from "@/components/ui/button";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeAttachmentMenu } from "@/components/chat/NativeAttachmentMenu";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import {
  NativeResumeSessionDialog,
  type ResumableSession,
} from "@/components/chat/NativeResumeSessionDialog";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { useMessageForkAction } from "@/components/chat/MessageForkAction";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import { useFileMentions } from "@/hooks/useFileMentions";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useComposerFileSearchFeedback } from "@/hooks/useComposerFileSearchFeedback";
import { useComposerMountFocus } from "@/hooks/useComposerMountFocus";
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import { useNativeAgentSession } from "@/hooks/useNativeAgentSession";
import { useAgentHandoff } from "@/hooks/useAgentHandoff";
import { useEscapeToStop } from "@/hooks/useEscapeToStop";
import { useManualSessionRefresh } from "@/hooks/useManualSessionRefresh";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import { useVirtuosoScrollState, clearPersistedVirtuosoState } from "@/hooks/useVirtuosoScrollState";
import {
  adoptNativeAgentSession,
  renameEnvironmentFromPrompt,
  updateGlobalConfig,
} from "@/lib/backend";
import { buildInitialPromptWithAttachmentReferences } from "@/lib/initial-prompt-attachments";
import { prependAgentHandoffHistory } from "@/lib/agent-handoff";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import {
  applyClaudeBackgroundTaskStates,
  collectRenderedBackgroundTaskIds,
  normalizeNativeMessages,
} from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  createOptimisticNativeMessage,
  isClientOnlyNativeMessage,
  TURN_STOPPED_BY_USER,
} from "@/lib/chat/client-only-messages";
import {
  pinActiveNativeAgentParts,
} from "@/lib/chat/native-agent-pinning";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { persistAgentModelDefault } from "@/lib/chat/agent-model-preferences";
import { persistCodexGlobalPreferences } from "@/components/codex/codex-preferences";
import {
  buildMessageForkPlan,
  forkAttachmentNotice,
  type MessageForkKind,
} from "@/components/chat/message-fork";
import {
  resolveNativeAgentPromptBoundary,
  resolveNativeAgentResponseBoundary,
} from "./native-agent-fork";
import { composeDraftKey, discardComposeDraft } from "@/lib/compose-draft-persistence";
import { composerOccupiedError } from "@/lib/prompt-queue-errors";
import {
  resolveWorkspaceAttachment,
} from "@/lib/chat/workspace-attachments";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  nativeComposeDraft,
  nativeComposePersistenceStore,
  useNativeComposeStore,
} from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import type { FileCandidate } from "@/types";
import { toast } from "sonner";
import {
  getNativeAgentAdapter,
  type AgentNativeTabProps,
} from "./adapter";
import {
  extractNativePlanContent,
  useNativeAgentActivityAnnouncement,
} from "./AgentNativeTab.helpers";
import { NativeAgentInteractionCard } from "./NativeAgentInteractionCard";
import { CodexPlanModeCard } from "@/components/codex/CodexPlanModeCard";
import { BackgroundTaskCard } from "@/components/chat/NativeMessage.agent-parts";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import {
  findLatestBackendTurnElapsedSeconds,
  findLatestBackendUserTurnStartedAt,
} from "@/lib/session-timer";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import { isSetupBlocked } from "@/lib/setup-commands";

/** Stable identity so the transcript decoration memo cannot churn. */
const EMPTY_BACKGROUND_TASKS: Record<string, never> = {};

/**
 * The same background-task card the transcript renders, for a live task the
 * transcript itself cannot show. It owns its disclosure locally because it has
 * no message part to key persisted expansion against.
 */
function PinnedBackgroundTaskCard({
  task,
  onStop,
}: {
  task: NativeAgentBackgroundTaskSummary;
  onStop: (taskId: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <BackgroundTaskCard
      task={task}
      open={open}
      onOpenChange={setOpen}
      onStop={onStop}
    />
  );
}

export function SharedNativeAgentController({
  tabId,
  data,
  isActive,
  initialPrompt,
  initialAgentModel,
  initialReasoningEffort,
  initialConversationMode,
  initialFastMode,
  initialResumeOpen,
  ownsGlobalShortcuts,
  isReviewTab,
  agentHandoffId,
  consumedAgentHandoffId,
  refreshRequestId = 0,
}: AgentNativeTabProps) {
  const platform = data.platform!;
  const adapter = getNativeAgentAdapter(platform);
  const label = adapter.label;
  const config = useConfigStore((state) => state.config);
  const configuredModel = platform === "claude"
    ? config.global.claudeModel
    : platform === "codex"
      ? config.global.codexModel
      : platform === "opencode"
        ? config.global.opencodeModel
        : undefined;
  const configuredReasoning = platform === "codex"
    ? config.global.codexReasoningEffort
    : undefined;
  const configuredFastMode = platform === "claude"
    ? config.global.claudeNativeFastModeDefault ?? false
    : platform === "codex"
      ? config.global.codexNativeFastModeDefault ?? false
      : undefined;
  const environment = useEnvironmentStore(
    (state) => state.getEnvironmentById(data.environmentId),
  );
  const setupPending = isSetupBlocked({ setupPhase: environment?.setupPhase });
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const initialPromptSentRef = useRef(false);
  // The projection rewrites `data.sessionId` to whatever session the tab ends
  // up connected to, so the id the tab was *asked* to resume has to be captured
  // before that can happen.
  const requestedResumeSessionIdRef = useRef(data.sessionId);
  const [optimisticPrompt, setOptimisticPrompt] = useState<{
    text: string;
    providerText: string;
    attachments: Array<{ path: string; previewUrl?: string; name: string }>;
    createdAt: string;
  } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(initialResumeOpen === true);
  const [forkInFlight, setForkInFlight] = useState(false);
  const [planTransitionPending, setPlanTransitionPending] = useState(false);
  const [suggestionDismissPending, setSuggestionDismissPending] = useState(false);
  const [namingEnvironment, setNamingEnvironment] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [dismissedPlanReviewId, setDismissedPlanReviewId] = useState<string | null>(null);
  const forkLatchRef = useRef(false);
  const submitInFlightRef = useRef(false);
  /** Last session action whose delivery the provider could not confirm. */
  const ambiguousActionRef = useRef<{
    kind: string;
    text: string;
    requestId: string;
  } | null>(null);
  const {
    sessionKey,
    runtimeProjection: projection,
    runtimeError,
    isRefreshing,
    hasCompletedRead,
    isDispatching,
    connect,
    refresh,
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
    discardRecoverableDispatch,
    listResumable,
    resume,
    fork,
    performAction,
    refreshModels,
    loadToolDetails,
    loadEarlierMessages,
  } = useNativeAgentSession<NativeMessage>({
    platform,
    environmentId: data.environmentId,
    tabId,
    initialAgentModel,
    initialReasoningEffort,
    defaultAgentModel: configuredModel,
    defaultReasoningEffort: configuredReasoning,
    initialProviderSessionId: data.sessionId,
    initialConversationMode,
    initialFastMode,
    defaultFastMode: configuredFastMode,
    isActive,
    enabled: !setupPending,
  });
  const draft = useNativeComposeStore(
    (state) => nativeComposeDraft(state, sessionKey),
  );
  const updateDraft = useNativeComposeStore((state) => state.updateDraft);
  const clearDraft = useNativeComposeStore((state) => state.clearDraft);
  useNativeComposeDraftPersistence(
    platform,
    data.environmentId,
    sessionKey,
    nativeComposePersistenceStore,
  );
  const clearTabInitialPrompt = usePaneLayoutStore(
    (state) => state.clearTabInitialPrompt,
  );
  const clearTabAgentHandoff = usePaneLayoutStore(
    (state) => state.clearTabAgentHandoff,
  );
  const fileSearch = useFileSearch(
    data.containerId,
    environment?.worktreePath,
    adapter.capabilities.attachments.files
      || adapter.capabilities.attachments.images,
  );
  const {
    isMenuOpen: fileMentionMenuOpen,
    selectedIndex: fileMentionSelectedIndex,
    filteredFiles,
    handleCursorChange: detectFileMention,
    handleKeyDown: handleFileMentionKeyDown,
    closeMenu: closeFileMentionMenu,
    serializeForLLM,
    createMention,
  } = useFileMentions({ searchFiles: fileSearch.searchFiles });
  const {
    isOpen: slashCommandMenuOpen,
    selectedIndex: slashCommandSelectedIndex,
    filteredCommands,
    selectCommand,
    closeMenu: closeSlashCommandMenu,
    handleKeyDown: handleSlashCommandKeyDown,
  } = useSlashCommandMenu({
    commands: projection?.slashCommands ?? [],
    text: draft.text,
    setText: (text) => updateDraft(sessionKey, { text }),
    focusInput: () => inputRef.current?.focus(),
  });
  const backendOwnsStartupPrompt = tabId === "startup-agent"
    && (environment?.pendingAgentLaunch === true
      || environment?.startupAgentSession !== undefined);
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } =
    useVirtuosoScrollState({
      isActive,
      persistKey: sessionKey,
      environmentId: data.environmentId,
      stickToBottomOnActivation: true,
    });

  /*
   * Claude reports subagents and background tasks as ordinary tool rows plus a
   * separate authoritative task snapshot. Joining them here is what lets both
   * render as the shared agent card, rather than as a provider-specific list
   * beside the transcript. Every other provider already states the lifecycle on
   * the part itself, so this pass is a no-op for them.
   */
  const claudeBackgroundTasksById = useMemo(() => {
    const tasks = platform === "claude" ? projection?.backgroundTasks ?? [] : [];
    if (tasks.length === 0) return EMPTY_BACKGROUND_TASKS;
    return Object.fromEntries(tasks.map((task) => [task.id, task]));
  }, [platform, projection?.backgroundTasks]);
  const decoratedMessages = useMemo(() => {
    const source = projection?.messages ?? [];
    return platform === "claude"
      ? applyClaudeBackgroundTaskStates(source, claudeBackgroundTasksById)
      : source;
  }, [claudeBackgroundTasksById, platform, projection?.messages]);
  const normalizedMessages = useMemo(
    () => normalizeNativeMessages(decoratedMessages),
    [decoratedMessages],
  );
  const handoff = useAgentHandoff(
    agentHandoffId,
    platform,
    data.environmentId,
    normalizedMessages,
    consumedAgentHandoffId,
  );
  const transcriptEchoedOptimistic = optimisticPrompt !== null
    && (
      normalizedMessages.some(
        (message) => message.role === "user"
          && message.content.trim() === optimisticPrompt.providerText.trim(),
      )
      || handoff.displayMessages.some(
        (message) => message.role === "user"
          && message.content.trim() === optimisticPrompt.text.trim(),
      )
    );
  useEffect(() => {
    if (transcriptEchoedOptimistic) setOptimisticPrompt(null);
  }, [transcriptEchoedOptimistic]);
  const turnStopMarker = useNativeAgentProjectionStore(
    (state) => state.turnStopMarkers.get(sessionKey),
  );
  const displayMessages = useMemo(() => {
    const base = turnStopMarker
      && turnStopMarker.sessionId === projection?.sessionId
      && !handoff.displayMessages.some(
        (message) => message.role === "system" && message.content === TURN_STOPPED_BY_USER,
      )
      ? [...handoff.displayMessages, {
          id: `native-stop:${turnStopMarker.sessionId}:${turnStopMarker.createdAt}`,
          role: "system" as const,
          content: TURN_STOPPED_BY_USER,
          parts: [{ type: "text" as const, content: TURN_STOPPED_BY_USER }],
          createdAt: turnStopMarker.createdAt,
        }]
      : handoff.displayMessages;
    const withOptimistic = !optimisticPrompt || transcriptEchoedOptimistic
      ? base
      : [...base, createOptimisticNativeMessage(
          `optimistic-native:${sessionKey}`,
          optimisticPrompt.text,
          optimisticPrompt.attachments,
          optimisticPrompt.createdAt,
        )];
    if (!namingEnvironment) return withOptimistic;
    // Renaming the environment also renames the branch, and it runs before the
    // first prompt is dispatched. Without this the tab looks stalled.
    return [...withOptimistic, {
      id: `native-naming:${sessionKey}`,
      role: "system" as const,
      content: "Naming environment...",
      parts: [{ type: "text" as const, content: "Naming environment..." }],
      createdAt: new Date().toISOString(),
    }];
  }, [
    handoff.displayMessages,
    namingEnvironment,
    optimisticPrompt,
    projection?.sessionId,
    sessionKey,
    transcriptEchoedOptimistic,
    turnStopMarker,
  ]);
  const agentActivityAnnouncement = useNativeAgentActivityAnnouncement(
    displayMessages,
    sessionKey,
  );
  const messages = useMemo(
    () => pinActiveNativeAgentParts(displayMessages),
    [displayMessages],
  );
  const latestAssistantMessage = [...normalizedMessages].reverse().find(
    (message) => message.role === "assistant",
  );
  const planContent = useMemo(
    () => extractNativePlanContent(normalizedMessages),
    [normalizedMessages],
  );

  const composer = projection?.composer;
  const selectedModel = composer?.models.find(
    (model) => model.id === composer.selectedModelId,
  ) ?? composer?.models[0];
  const selectedReasoningId = composer?.selectedReasoningId
    ?? selectedModel?.defaultReasoningId;
  const selectedReasoningLabel = selectedModel?.reasoning?.find(
    (option) => option.id === selectedReasoningId,
  )?.label;
  const resolveModelLabel = useCallback(
    (modelId: string) => resolveCatalogModelLabel(
      modelId,
      (composer?.models ?? []).map((model) => ({
        id: model.id,
        name: model.label,
      })),
    ),
    [composer?.models],
  );
  /** Neutral reasoning label, from whichever model advertised the option. */
  const reasoningLabel = useCallback((reasoningId: string) => {
    for (const model of composer?.models ?? []) {
      const option = model.reasoning?.find((candidate) => candidate.id === reasoningId);
      if (option) return option.label;
    }
    return reasoningId;
  }, [composer?.models]);
  const updateControlsSafely = useCallback(async (
    update: Parameters<typeof updateControls>[0],
  ) => {
    try {
      return await updateControls(update);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to update ${label} settings`);
      return null;
    }
  }, [label, updateControls]);
  const persistCodexDefaults = useCallback(async (
    modelId: string,
    reasoningId: string,
  ) => {
    try {
      const current = useConfigStore.getState().config;
      await persistCodexGlobalPreferences({
        config: current,
        setConfig: useConfigStore.getState().setConfig,
        persistGlobalConfig: updateGlobalConfig,
        model: modelId,
        effort: reasoningId as Parameters<typeof persistCodexGlobalPreferences>[0]["effort"],
      });
    } catch (error) {
      console.warn("[AgentNativeTab] Failed to persist Codex defaults:", error);
      toast.error("Failed to save Codex defaults");
    }
  }, []);
  const phase = projection?.turn.phase;
  const settingsLocked = isSubmitting || (phase !== "idle" && phase !== "error");
  const isRunning = phase === "running";
  const isTurnActive = phase === "running" || phase === "recovering" || phase === "cancelling";
  /*
   * "Stopping" and "reconnecting" are still loading, but they mean something
   * different to the user than ordinary thinking. Derived from the neutral
   * phase, so every provider that reports one gets the label.
   */
  const phaseStatusLabel = phase === "cancelling"
    ? <span role="status" className="text-xs">Stopping…</span>
    : phase === "recovering"
      ? <span role="status" className="text-xs">Reconnecting to {label}…</span>
      : undefined;
  const turnStartedAt = projection?.turn.startedAt
    ?? (isTurnActive
      ? findLatestBackendUserTurnStartedAt(
          normalizedMessages,
          (message) => !isClientOnlyNativeMessage(message),
        )
      : undefined);
  /*
   * `useElapsedTimer` no longer keeps a renderer-local start, so the completed
   * duration has to come from the transcript too. Deriving it from the backend
   * clocks — rather than from the moment this tab happened to observe the turn
   * end — is also what makes it survive a switch away and back.
   */
  const completedElapsedSeconds = useMemo(
    () => (isTurnActive
      ? null
      : findLatestBackendTurnElapsedSeconds(
          normalizedMessages,
          (message) => !isClientOnlyNativeMessage(message),
        ) ?? null),
    [isTurnActive, normalizedMessages],
  );
  const { elapsedSeconds, finalElapsedSeconds } = useElapsedTimer(
    isTurnActive,
    projection?.sessionId,
    turnStartedAt,
    completedElapsedSeconds,
  );
  const canQueue = isRunning && adapter.capabilities.queue;
  /*
   * A parked dispatch blocks the session, not just the prompt that created it:
   * the backend refuses any other request id until it is resolved, because the
   * parked one may be executing at the provider right now. Reflecting that in
   * the composer turns a failed send into a visible choice — the banner above
   * offers both ways out — instead of an error the user cannot act on.
   */
  const recoverableDispatch = projection?.recoverableDispatch;
  const sendLocked = !projection
    || !handoff.ready
    || (isRunning && !canQueue)
    || phase === "cancelling"
    || phase === "recovering"
    || phase === "blocked"
    || Boolean(recoverableDispatch)
    || isSubmitting;
  const queuedMessages = useMemo(
    () => (projection?.queue?.items ?? []).flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Record<string, unknown>;
      return typeof item.id === "string" && typeof item.text === "string"
        ? [{ ...item, id: item.id, text: item.text }]
        : [];
    }),
    [projection?.queue?.items],
  );
  const liveBackgroundTasks = useMemo(
    () => (projection?.backgroundTasks ?? []).filter((task) =>
      task.status === "running" || task.status === "pending" || task.status === "paused"
    ),
    [projection?.backgroundTasks],
  );
  const stopBackgroundTaskFromCard = useCallback(async (taskId: string) => {
    try {
      await stopBackgroundTask(taskId);
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to stop background task",
      );
      return false;
    }
  }, [stopBackgroundTask]);
  /*
   * A live task the transcript cannot show: its launch fell outside the loaded
   * window, or the tab resumed a session whose earlier turns were trimmed.
   * The snapshot still says it is running and still accepts a stop, so the
   * control has to exist somewhere — pinned, as the same card.
   */
  const unrenderedLiveBackgroundTasks = useMemo(() => {
    if (liveBackgroundTasks.length === 0) return [];
    const rendered = collectRenderedBackgroundTaskIds(messages);
    return liveBackgroundTasks.filter((task) => !rendered.has(task.id));
  }, [liveBackgroundTasks, messages]);
  const discardProvisionalDraft = useCallback(() => {
    void discardComposeDraft(
      composeDraftKey("agent-native", data.environmentId, sessionKey),
    ).catch((error) => {
      console.warn("[AgentNativeTab] Failed to discard provisional compose draft:", error);
    });
  }, [data.environmentId, sessionKey]);

  const submit = useCallback(async (
    text: string,
    requestId?: string,
    preparedPrompt = false,
  ) => {
    const restoreComposerFocus = Boolean(
      inputContainerRef.current?.contains(document.activeElement),
    );
    const submittedAttachments = [...draft.attachments];
    const userPrompt = preparedPrompt
      ? text.trim()
      : buildInitialPromptWithAttachmentReferences(
          serializeForLLM(text.trim(), draft.mentions),
          submittedAttachments.map(({ name, path }) => ({ name, path })),
        );
    if (!userPrompt) return false;
    if (submitInFlightRef.current) return false;
    if (
      handoff.pendingHistory
      && isProviderSlashCommand(
        userPrompt,
        projection?.slashCommands ?? [],
        projection?.capabilities,
      )
    ) {
      setSendError("Send a normal message first to complete the agent handoff; slash commands cannot carry transferred history.");
      return false;
    }
    /*
     * A command the runtime performs on the live turn (Codex `/steer`) is not a
     * prompt: queueing it would run it after the turn it was meant to redirect.
     * Capability-gated, so any provider that reports the action gets it.
     */
    const sessionAction = resolveSessionActionCommand(
      userPrompt,
      projection?.capabilities,
      isRunning,
    );
    if (sessionAction) {
      if (sessionAction.error) {
        setSendError(sessionAction.error);
        return false;
      }
      if (submittedAttachments.length > 0) {
        setSendError("/steer supports text only. Remove the attachments and retry.");
        return false;
      }
      setSendError(null);
      submitInFlightRef.current = true;
      setIsSubmitting(true);
      /*
       * An unconfirmed action may already have reached the provider. Resending
       * the same text reuses its request id so the provider deduplicates it,
       * rather than steering the turn twice.
       */
      const ambiguous = ambiguousActionRef.current;
      const actionRequestId = requestId
        ?? draft.requestId
        ?? (ambiguous?.kind === sessionAction.kind && ambiguous.text === sessionAction.text
          ? ambiguous.requestId
          : crypto.randomUUID());
      updateDraft(sessionKey, { requestId: actionRequestId });
      try {
        const outcome = await performAction({
          kind: sessionAction.kind,
          text: sessionAction.text,
          requestId: actionRequestId,
        });
        ambiguousActionRef.current = outcome.outcome === "unknown"
          ? { kind: sessionAction.kind, text: sessionAction.text, requestId: actionRequestId }
          : null;
        if (outcome.outcome === "applied") {
          clearDraft(sessionKey);
          discardProvisionalDraft();
          toast.success(`Sent to the active ${label} turn`);
          return true;
        }
        setSendError(outcome.outcome === "unknown"
          ? `Could not confirm whether ${label} received the steering text. Resending reuses the same request id.`
          : outcome.outcome === "mismatch"
            ? "The turn moved on before the steering text was delivered."
            : `${label} is no longer running a turn to steer.`);
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
      } finally {
        submitInFlightRef.current = false;
        setIsSubmitting(false);
      }
      updateDraft(sessionKey, {
        text,
        mentions: draft.mentions,
        requestId: actionRequestId,
      });
      return false;
    }
    const prompt = prependAgentHandoffHistory(handoff.pendingHistory, userPrompt);
    // `sendLocked` covers this too, but silently swallowing the keystroke would
    // leave the user pressing Enter at a composer that never responds.
    if (recoverableDispatch) {
      setSendError(
        "Resolve the unconfirmed message above — retry or discard it — before sending another.",
      );
      return false;
    }
    if (!prompt || sendLocked || isDispatching) return false;
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    const dispatchRequestId = canQueue
      ? undefined
      : requestId ?? draft.requestId ?? crypto.randomUUID();
    if (dispatchRequestId) updateDraft(sessionKey, { requestId: dispatchRequestId });
    setSendError(null);
    setOptimisticPrompt({
      text: userPrompt,
      providerText: prompt,
      attachments: submittedAttachments,
      createdAt: new Date().toISOString(),
    });
    if (
      (projection?.messages.length ?? 0) === 0
      && environment
      && isDefaultTimestampEnvironmentName(environment.name)
    ) {
      // Renaming also renames the branch, so it runs before dispatch and can
      // take a moment. Say what is happening instead of showing a stalled send.
      setNamingEnvironment(true);
      try {
        await renameEnvironmentFromPrompt(data.environmentId, userPrompt);
      } catch (error) {
        console.warn(
          "[AgentNativeTab] Failed to rename environment from first prompt:",
          error,
        );
      } finally {
        setNamingEnvironment(false);
      }
    }
    const options = {
      requestId: dispatchRequestId,
      model: composer?.selectedModelId,
      reasoningEffort: composer?.selectedReasoningId,
      mode: composer?.selectedModeId,
      fastMode: composer?.fastModeEnabled ?? undefined,
      subAgent: platform === "claude"
        ? composer?.selectedExecutionProfileId
        : undefined,
      executionAgent: platform === "opencode"
        ? composer?.selectedExecutionProfileId
        : undefined,
      includeLocalSettings: platform === "claude"
        ? composer?.includeLocalSettings
        : undefined,
      promptSuggestions: platform === "claude"
        ? composer?.promptSuggestionsEnabled
        : undefined,
      attachments: submittedAttachments.map((attachment) => ({
        type: attachment.type,
        path: attachment.path,
        filename: attachment.name,
      })),
    };
    try {
      if (canQueue) {
        await enqueue(prompt, options);
        setOptimisticPrompt(null);
        clearDraft(sessionKey);
        discardProvisionalDraft();
        if (agentHandoffId) clearTabAgentHandoff(tabId, data.environmentId);
        return true;
      }
      const outcome = await send(prompt, options);
      if (outcome.outcome === "accepted") {
        clearDraft(sessionKey);
        discardProvisionalDraft();
        if (agentHandoffId) clearTabAgentHandoff(tabId, data.environmentId);
        return true;
      }
      if (outcome.outcome === "rejected") setOptimisticPrompt(null);
      setSendError(
        outcome.outcome === "unknown"
          ? "The connection dropped before dispatch was confirmed. The session is being reconciled; retrying uses the same request id."
          : outcome.error,
      );
    } catch (error) {
      setOptimisticPrompt(null);
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
      if (restoreComposerFocus) {
        queueMicrotask(() => inputRef.current?.focus());
      }
    }
    updateDraft(sessionKey, {
      text,
      mentions: draft.mentions,
      attachments: submittedAttachments,
      ...(dispatchRequestId ? { requestId: dispatchRequestId } : {}),
    });
    return false;
  }, [
    clearDraft,
    composer?.fastModeEnabled,
    composer?.selectedModeId,
    composer?.selectedModelId,
    composer?.selectedReasoningId,
    composer?.selectedExecutionProfileId,
    composer?.includeLocalSettings,
    composer?.promptSuggestionsEnabled,
    canQueue,
    agentHandoffId,
    clearTabAgentHandoff,
    data.environmentId,
    discardProvisionalDraft,
    draft.attachments,
    draft.mentions,
    draft.requestId,
    environment,
    enqueue,
    handoff.pendingHistory,
    isDispatching,
    isSubmitting,
    isRunning,
    label,
    performAction,
    projection?.capabilities,
    projection?.messages.length,
    recoverableDispatch,
    send,
    sendLocked,
    serializeForLLM,
    sessionKey,
    tabId,
    updateDraft,
  ]);

  /**
   * Provider entries mapped to the shared picker's neutral row shape. Sorting
   * and current-session exclusion belong to the dialog and the backend, not to
   * each provider's own copy of a list.
   */
  const fetchResumableSessions = useCallback(
    async (): Promise<ResumableSession[]> => (await listResumable()).map((entry) => ({
      id: entry.sessionId,
      ...(entry.title ? { title: entry.title } : {}),
      activityAt: entry.updatedAt ?? entry.createdAt ?? null,
      ...(entry.status ? { status: entry.status } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    })),
    [listResumable],
  );

  /** What the send button would do with the draft as typed. */
  const draftSessionAction = useMemo(
    () => resolveSessionActionCommand(draft.text, projection?.capabilities, isRunning),
    [draft.text, isRunning, projection?.capabilities],
  );

  /**
   * Retire the suggestion locally and, where the provider tracks it, remotely.
   * `promptSuggestions` is the neutral capability, so this works for whichever
   * providers report suggestions rather than only for Claude.
   */
  const dismissSuggestion = useCallback(() => {
    if (adapter.capabilities.composer.promptSuggestions !== true) return;
    setSuggestionDismissPending(true);
    void dismissSuggestedPrompt()
      .catch((error) => toast.error(
        error instanceof Error ? error.message : "Failed to dismiss suggestion",
      ))
      .finally(() => setSuggestionDismissPending(false));
  }, [adapter.capabilities.composer.promptSuggestions, dismissSuggestedPrompt]);

  const cycleMode = useMemo(() => {
    const modes = composer?.modes ?? [];
    if (modes.length < 2 || settingsLocked) return undefined;
    return () => {
      const index = modes.findIndex(
        (mode) => mode.id === (composer?.selectedModeId ?? "build"),
      );
      const next = modes[(index + 1) % modes.length];
      if (next) void updateControlsSafely({ mode: next.id });
    };
  }, [composer?.modes, composer?.selectedModeId, settingsLocked, updateControlsSafely]);

  const stopSafely = useCallback(async () => {
    try {
      await stop();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to stop ${label}`);
    }
  }, [label, stop]);
  useEscapeToStop({
    isActive: ownsGlobalShortcuts ?? isActive,
    isLoading: isTurnActive,
    onStop: stopSafely,
  });
  useManualSessionRefresh({
    refreshRequestId,
    isReady: Boolean(projection),
    agentLabel: label,
    refresh: async (options) => { await refresh(options); },
  });

  const handleFileMentionSelect = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMention(mention);
  }, [closeFileMentionMenu, createMention]);
  const handleWorkspaceFileMention = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMentionAtCursor(mention);
  }, [closeFileMentionMenu, createMention]);
  const handleWorkspaceFileAttach = useCallback((file: FileCandidate) => {
    const current = useNativeComposeStore.getState().drafts.get(sessionKey);
    const resolved = resolveWorkspaceAttachment(file, {
      containerId: data.containerId,
      worktreePath: environment?.worktreePath,
      allowFiles: adapter.capabilities.attachments.files,
      allowImages: adapter.capabilities.attachments.images,
      modelSupportsImages: selectedModel?.supportsImageInput,
      modelLabel: selectedModel?.label,
      attachedCount: current?.attachments.length ?? 0,
    });
    if ("error" in resolved) {
      toast.error(resolved.error, { description: resolved.description });
      return;
    }
    updateDraft(sessionKey, {
      attachments: [...(current?.attachments ?? []), resolved.attachment],
    });
  }, [
    adapter.capabilities.attachments.files,
    adapter.capabilities.attachments.images,
    data.containerId,
    environment?.worktreePath,
    selectedModel?.label,
    selectedModel?.supportsImageInput,
    sessionKey,
    updateDraft,
  ]);
  const handlePastedImage = useCallback((attachment: {
    id: string;
    type: "image";
    path: string;
    previewUrl: string;
    name: string;
  }) => {
    const current = useNativeComposeStore.getState().drafts.get(sessionKey);
    updateDraft(sessionKey, {
      attachments: [...(current?.attachments ?? []), attachment],
    });
  }, [sessionKey, updateDraft]);
  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: data.containerId ?? null,
    worktreePath: environment?.worktreePath,
    onAttach: handlePastedImage,
    canAttachImage: () => adapter.capabilities.attachments.images
      && selectedModel?.supportsImageInput !== false,
    onImageRejected: () => toast.error("Images are not supported by this agent"),
    logLabel: "SharedNativeAgentController",
  });
  useComposerFileSearchFeedback({
    error: fileSearch.error,
    refresh: fileSearch.refresh,
    mentionMenuOpen: fileMentionMenuOpen,
  });
  useComposerMountFocus(inputRef, isActive);

  const forkPlan = useMemo(
    () => buildMessageForkPlan(handoff.displayMessages, {
      responseInProgress: isTurnActive,
      resolvePromptBoundary: (message, allMessages) =>
        resolveNativeAgentPromptBoundary(platform, message, allMessages),
      resolveResponseBoundary: (message, allMessages) =>
        resolveNativeAgentResponseBoundary(platform, message, allMessages),
    }),
    [handoff.displayMessages, isTurnActive, platform],
  );
  const forkPlanRef = useRef(forkPlan);
  forkPlanRef.current = forkPlan;

  const handleFork = useCallback(async (
    messageId: string,
    kind: MessageForkKind,
  ) => {
    if (forkLatchRef.current || !projection?.sessionId) return;
    forkLatchRef.current = true;
    setForkInFlight(true);
    try {
      const planned = forkPlanRef.current.get(messageId);
      if (!planned || planned.kind !== kind) {
        throw new Error("The selected message is no longer in this session");
      }
      const outcome = planned.boundary.type === "session-start"
        ? null
        : await fork(
            planned.boundary.type === "message"
              ? planned.boundary.messageId
              : undefined,
          );
      const forkTabId = crypto.randomUUID();
      const forkSessionKey = createSessionKey(data.environmentId, forkTabId);
      if (outcome) {
        await adoptNativeAgentSession({
          environmentId: data.environmentId,
          agent: platform,
          logicalSessionKey: forkSessionKey,
          providerSessionId: outcome.sessionId,
        });
      }
      if (planned.kind === "prompt") {
        updateDraft(forkSessionKey, {
          text: planned.draftText,
          mentions: [],
          attachments: [],
        });
      }
      const panes = usePaneLayoutStore.getState();
      panes.addTab(
        panes.getActivePaneId(data.environmentId),
        {
          id: forkTabId,
          type: "agent-native",
          displayTitle: outcome?.title ?? `${projection.title ?? label} (fork)`,
          nativeAgentData: {
            ...data,
            platform,
            ...(outcome ? { sessionId: outcome.sessionId } : { sessionId: undefined }),
          },
        },
        data.environmentId,
      );
      const attachmentNotice = forkAttachmentNotice(planned.droppedAttachmentCount);
      if (attachmentNotice) toast.warning(attachmentNotice);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Failed to fork ${label}`);
    } finally {
      forkLatchRef.current = false;
      setForkInFlight(false);
    }
  }, [data, fork, label, platform, projection?.sessionId, projection?.title, updateDraft]);
  const renderForkAction = useMessageForkAction({
    agentLabel: label,
    disabled: forkInFlight || phase === "running" || phase === "recovering",
    onFork: (messageId, kind) => { void handleFork(messageId, kind); },
  });
  const showPlanReview = platform === "codex"
    && composer?.selectedModeId === "plan"
    && phase === "idle"
    && latestAssistantMessage?.planReview === true
    && latestAssistantMessage.id !== dismissedPlanReviewId;
  const switchPlanToBuild = useCallback(async (implement: boolean) => {
    if (planTransitionPending) return;
    setPlanTransitionPending(true);
    try {
      await updateControls({ mode: "build" });
      setDismissedPlanReviewId(latestAssistantMessage?.id ?? null);
      if (implement) {
        const outcome = await send(
          "The plan is approved. Exit plan mode and implement it.",
          {
            model: composer?.selectedModelId,
            reasoningEffort: composer?.selectedReasoningId,
            mode: "build",
            fastMode: composer?.fastModeEnabled ?? undefined,
          },
        );
        if (outcome.outcome !== "accepted") {
          throw new Error(outcome.error ?? "Plan implementation dispatch was not confirmed");
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to leave plan mode");
    } finally {
      setPlanTransitionPending(false);
    }
  }, [
    composer?.fastModeEnabled,
    composer?.selectedModelId,
    composer?.selectedReasoningId,
    latestAssistantMessage?.id,
    planTransitionPending,
    send,
    updateControls,
  ]);

  useEffect(() => {
    if (backendOwnsStartupPrompt && initialPrompt) {
      clearTabInitialPrompt(tabId, data.environmentId);
      return;
    }
    if (
      !projection
      || initialPromptSentRef.current
      || !initialPrompt?.trim()
    ) return;
    // A tab that asked to resume a specific conversation carries a prompt that
    // only makes sense inside it — "address every finding" means nothing in an
    // empty session. Adoption falls back to creating a fresh session when the
    // provider has forgotten the rollout, so refuse to fire the startup prompt
    // at whatever session we actually landed in and say why instead.
    const requestedSessionId = requestedResumeSessionIdRef.current;
    if (
      requestedSessionId
      && projection.sessionId
      && projection.sessionId !== requestedSessionId
    ) {
      initialPromptSentRef.current = true;
      clearTabInitialPrompt(tabId, data.environmentId);
      setSendError(
        "The conversation this tab was opened to resume is no longer available, "
        + "so its opening message was not sent. Send it yourself to continue in "
        + "this new session.",
      );
      return;
    }
    initialPromptSentRef.current = true;
    void submit(
      initialPrompt,
      `initial-prompt:${data.environmentId}:${tabId}`,
      true,
    ).then((accepted) => {
      if (accepted) clearTabInitialPrompt(tabId, data.environmentId);
      else initialPromptSentRef.current = false;
    });
  }, [
    backendOwnsStartupPrompt,
    clearTabInitialPrompt,
    data.environmentId,
    initialPrompt,
    projection,
    setSendError,
    submit,
    tabId,
  ]);

  const errorMessage = sendError ?? runtimeError ?? projection?.turn.error ?? null;
  // An uninitialized inactive tab has neither a projection nor an in-flight
  // refresh. That is still a pending connection, not a failed one: newly added
  // tabs can render for one commit before pane selection marks them active,
  // and `isRefreshing` reads false for a tab that was never asked to connect.
  //
  // A settled read is the opposite case. The backend answered, and answered
  // with nothing, so the session really is gone — say so, because "error" is
  // the only state carrying the retry control and the failure text.
  //
  // Retry and a new identity both start work with `isRefreshing`. That has to
  // win over the previous completed-read/error, or the only recovery control
  // stays on screen while the reconnect is already running.
  const connectionState = projection?.connection
    ?? (isRefreshing
      ? "connecting" as const
      : runtimeError || hasCompletedRead ? "error" as const : "connecting" as const);
  const contextUsage = projection?.contextUsage;
  const maximumTokens = contextUsage?.maximumTokens;
  const composeContextUsage = contextUsage === undefined
    ? undefined
    : maximumTokens !== undefined
      && Number.isFinite(maximumTokens)
      && maximumTokens > 0
      ? {
          usedTokens: contextUsage.usedTokens,
          totalTokens: maximumTokens,
          percentUsed: contextUsage.percentage
            ?? Math.min(100, contextUsage.usedTokens / maximumTokens * 100),
        }
      : null;

  if (setupPending) {
    return (
      <SetupPendingOverlay
        environmentId={data.environmentId}
        setupPhase={environment?.setupPhase}
        subtext={`${label} will connect automatically once setup finishes`}
      />
    );
  }

  /**
   * The rendered list is also what decides whether anything is pinned at all, so
   * a card added here cannot be left out of the count. `NativeChatShell` measures
   * this with `Children.count`, where a non-empty fragment always counts as one —
   * an unconditional wrapper would permanently reserve pinned clearance for a tab
   * that has nothing pinned.
   */
  const pinnedCards: ReactNode[] = [
    showPlanReview ? (
      <CodexPlanModeCard
        key="plan-review"
        className="mx-0 my-0"
        isSubmitting={planTransitionPending}
        onApproveAndBuild={() => switchPlanToBuild(true)}
        onSwitchToBuild={() => switchPlanToBuild(false)}
        onDismiss={() => setDismissedPlanReviewId(
          latestAssistantMessage?.id ?? null,
        )}
      />
    ) : null,
    ...unrenderedLiveBackgroundTasks.map((task) => (
      <PinnedBackgroundTaskCard
        key={`background-task:${task.id}`}
        task={task}
        onStop={stopBackgroundTaskFromCard}
      />
    )),
    ...(projection?.notices ?? []).map((notice, index) => (
      <div
        key={`notice:${notice.kind}:${index}`}
        role="status"
        className={notice.kind === "error"
          ? "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          : "rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-100"}
      >
        {notice.message}
      </div>
    )),
    recoverableDispatch ? (
      <div
        key="recoverable-dispatch"
        role="alert"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-100"
      >
        <span>
          {label} did not confirm your last message, so it may or may not have
          been received. Retrying sends it under the same request id, so it
          cannot run twice. Until you choose, this session will not accept a new
          message.
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isDispatching}
            onClick={() => {
              void retryRecoverableDispatch().then((outcome) => {
                if (outcome.outcome === "accepted") {
                  setSendError(null);
                  setOptimisticPrompt(null);
                } else if (outcome.outcome === "rejected") {
                  setSendError(outcome.error);
                } else {
                  setSendError(outcome.error ?? "The dispatch is still being reconciled.");
                }
              });
            }}
          >
            Retry send
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isDispatching}
            onClick={() => {
              void discardRecoverableDispatch().then(() => {
                setSendError(null);
                setOptimisticPrompt(null);
              }).catch((error: unknown) => {
                setSendError(
                  error instanceof Error ? error.message : String(error),
                );
              });
            }}
          >
            Discard
          </Button>
        </div>
      </div>
    ) : null,
    sendError ? (
      <div
        key="send-error"
        className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        {sendError}
      </div>
    ) : null,
  ].filter(Boolean);

  return (
    <NativeChatShell
      agentExpansionScope={data.environmentId}
      agentLabel={label}
      platform={platform}
      isActive={isActive}
      ownsGlobalShortcuts={ownsGlobalShortcuts}
      // Without this, images the agent wrote inside the container render as
      // bare paths instead of pictures.
      containerId={data.containerId}
      connectionState={connectionState}
      errorMessage={errorMessage}
      onRetry={() => { void connect(); }}
      messages={messages}
      agentActivityAnnouncement={agentActivityAnnouncement}
      resolveModelLabel={resolveModelLabel}
      loadToolDetails={loadToolDetails}
      stopBackgroundTask={
        adapter.capabilities.backgroundTasks
          ? stopBackgroundTaskFromCard
          : undefined
      }
      isLoading={isTurnActive}
      statusLabel={phaseStatusLabel}
      elapsedSeconds={elapsedSeconds}
      finalElapsedSeconds={finalElapsedSeconds}
      centerCompose={messages.length === 0 && !isTurnActive}
      emptyStateMessage={`Ask ${label} to work on this repository.`}
      transcriptHeader={projection?.messageWindow?.truncated ? (
        <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-2 py-3 text-xs text-muted-foreground">
          <span>
            {projection.messageWindow.truncationReason === "bytes"
              ? "Earlier messages or tool activity were omitted to stay within the 16 MiB transcript limit."
              : "Earlier messages are not shown."}
          </span>
          {projection.messageWindow.truncationReason !== "bytes" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingEarlier}
              onClick={() => {
                setLoadingEarlier(true);
                void loadEarlierMessages()
                  .catch((error) => toast.error(
                    error instanceof Error ? error.message : "Failed to load earlier messages",
                  ))
                  .finally(() => setLoadingEarlier(false));
              }}
            >
              {loadingEarlier ? "Loading…" : "Load earlier messages"}
            </Button>
          ) : null}
        </div>
      ) : null}
      isAtBottom={isAtBottom}
      scrollToBottom={scrollToBottom}
      scrollProps={scrollProps}
      virtuosoRef={virtuosoRef}
      blockingCards={(projection?.interactions ?? []).map((interaction) => (
        <NativeAgentInteractionCard
          key={interaction.id}
          interaction={interaction}
          planContent={interaction.kind === "plan-approval" ? planContent : undefined}
          onResolve={(resolution) => resolveInteraction(interaction.id, resolution)}
        />
      ))}
      pinnedAccessory={pinnedCards.length > 0 ? <>{pinnedCards}</> : null}
      topAccessory={projection?.suggestedPrompt ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            title={projection.suggestedPrompt}
            onClick={() => {
              // Appended, never replaced: the draft is the composer's backing
              // store, so overwriting it destroys a half-written message.
              updateDraft(sessionKey, {
                text: draft.text.trim()
                  ? `${draft.text.replace(/\s+$/, "")}\n\n${projection.suggestedPrompt}`
                  : projection.suggestedPrompt,
              });
              // Accepting a suggestion consumes it. Providers that cannot be
              // told simply drop it on the next refresh.
              dismissSuggestion();
            }}
          >
            Suggested: {projection.suggestedPrompt}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={suggestionDismissPending}
            aria-label="Dismiss suggested prompt"
            onClick={dismissSuggestion}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
      messageActions={adapter.capabilities.fork
        ? (message) => {
            const planned = forkPlan.get(message.id);
            return planned
              ? renderForkAction(message.id, planned.kind)
              : null;
          }
        : undefined}
      onResumeClick={adapter.capabilities.resume
        ? () => setResumeDialogOpen(true)
        : undefined}
      resumeDialog={adapter.capabilities.resume ? (
        <NativeResumeSessionDialog
          open={resumeDialogOpen}
          onOpenChange={setResumeDialogOpen}
          agentLabel={label}
          currentSessionId={projection?.sessionId}
          fetchSessions={fetchResumableSessions}
          onResume={(providerSessionId) => {
            setResumeDialogOpen(false);
            void resume(providerSessionId, {
              modelId: composer?.selectedModelId,
              reasoningId: composer?.selectedReasoningId,
              fastMode: composer?.fastModeEnabled ?? undefined,
              mode: composer?.selectedModeId,
              executionProfileId: composer?.selectedExecutionProfileId,
              includeLocalSettings: composer?.includeLocalSettings,
              promptSuggestions: composer?.promptSuggestionsEnabled,
            }).then(() => {
              clearPersistedVirtuosoState(sessionKey);
              scrollToBottom();
            }).catch((error) => toast.error(
              error instanceof Error ? error.message : `Failed to resume ${label}`,
            ));
          }}
        />
      ) : null}
      composer={(
        <NativeComposeBar
          testId="shared-native-compose-bar"
          layout={messages.length === 0 && !isTurnActive ? "centered" : "bottom"}
          attachments={draft.attachments}
          onRemoveAttachment={(attachmentId) => updateDraft(sessionKey, {
            attachments: draft.attachments.filter((candidate) => candidate.id !== attachmentId),
          })}
          inputRef={inputRef}
          inputContainerRef={inputContainerRef}
          text={draft.text}
          mentions={draft.mentions}
          onTextAndMentionsChange={(text, mentions) => {
            updateDraft(sessionKey, { text, mentions });
          }}
          onCursorPositionChange={detectFileMention}
          onKeyDown={(event) => {
            if (fileMentionMenuOpen && handleFileMentionKeyDown(event, handleFileMentionSelect)) {
              return;
            }
            if (slashCommandMenuOpen && handleSlashCommandKeyDown(event)) return;
            // Shift+Tab cycles conversation mode for any provider that reports
            // one, rather than only where a provider tab implemented it.
            if (event.key === "Tab" && event.shiftKey && cycleMode) {
              event.preventDefault();
              cycleMode();
              return;
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit(draft.text);
          }}
          placeholder={`Message ${label}`}
          disabled={!projection || isSubmitting}
          isSending={isDispatching || isSubmitting}
          isLoading={isTurnActive}
          menus={fileMentionMenuOpen ? (
              <FileMentionMenu
                files={filteredFiles}
                selectedIndex={fileMentionSelectedIndex}
                onSelect={handleFileMentionSelect}
                onClose={closeFileMentionMenu}
              />
            ) : slashCommandMenuOpen ? (
              <SlashCommandMenu
                commands={filteredCommands}
                selectedIndex={slashCommandSelectedIndex}
                onSelect={selectCommand}
                onClose={closeSlashCommandMenu}
              />
            ) : null}
          primaryControls={composer ? (
            <>
              {adapter.capabilities.attachments.files
                || adapter.capabilities.attachments.images ? (
                <NativeAttachmentMenu
                  disabled={sendLocked && !canQueue}
                  fileSearch={fileSearch}
                  onSelectFile={handleWorkspaceFileAttach}
                  onMentionFile={handleWorkspaceFileMention}
                  onCloseAutoFocus={() => inputRef.current?.focus()}
                />
              ) : null}
              <AgentModelPicker
                models={composer.models}
                favorites={favorites}
                enabledPlatforms={[platform]}
                selectedPlatform={platform}
                platformSelectionLocked
                onToggleFavorite={toggleFavorite}
                onReorderFavorites={reorderFavorites}
                selectedModelId={selectedModel?.id}
                selectedModelLabel={selectedModel?.label ?? "No models available"}
                onRefreshModels={() => {
                  void refreshModels().catch((error) => toast.error(
                    error instanceof Error ? error.message : "Failed to refresh models",
                  ));
                }}
                onModelChange={(modelId) => {
                  const nextModel = composer.models.find((model) => model.id === modelId);
                  const supportedReasoning = nextModel?.reasoning ?? [];
                  const nextReasoningId = resolveReasoningId(
                    supportedReasoning,
                    selectedReasoningId,
                    nextModel?.defaultReasoningId,
                  ) ?? nextModel?.defaultReasoningId;
                  void updateControlsSafely({
                    modelId,
                    ...(nextReasoningId ? { reasoningId: nextReasoningId } : {}),
                  }).then((updated) => {
                    if (!updated) return;
                    if (platform === "codex" && nextReasoningId) {
                      void persistCodexDefaults(modelId, nextReasoningId);
                    } else if (platform === "claude" || platform === "opencode") {
                      void persistAgentModelDefault(
                        platform === "claude" ? "claudeModel" : "opencodeModel",
                        modelId,
                        label,
                      );
                    }
                    if (
                      nextModel?.supportsImageInput === false
                      && draft.attachments.some((attachment) => attachment.type === "image")
                    ) {
                      toast.error(`${nextModel.label} does not support image input`);
                    }
                  });
                }}
                reasoningOptions={selectedModel?.reasoning ?? []}
                selectedReasoningId={selectedReasoningId}
                selectedReasoningLabel={selectedReasoningLabel}
                onReasoningChange={(selectedModel?.reasoning?.length ?? 0) > 0
                  ? (reasoningId) => {
                      void updateControlsSafely({ reasoningId }).then((updated) => {
                        if (updated && platform === "codex" && selectedModel) {
                          void persistCodexDefaults(selectedModel.id, reasoningId);
                        }
                      });
                    }
                  : undefined}
                fastModeEnabled={composer.fastModeEnabled}
                fastModeAvailable={composer.fastModeAvailable}
                onFastModeChange={composer.fastModeAvailable
                  ? (fastMode) => { void updateControlsSafely({ fastMode }); }
                  : undefined}
                disabled={settingsLocked}
              />
              {composer.modes.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={settingsLocked}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      title="Choose mode"
                    >
                      <ChevronDown className="h-3 w-3" />
                      <span>{composer.selectedModeId === "plan" ? "Plan" : "Build"}</span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={composer.selectedModeId ?? "build"}
                      onValueChange={(mode) => {
                        void updateControlsSafely({ mode: mode as "build" | "plan" });
                      }}
                    >
                      {composer.modes.map((mode) => (
                        <DropdownMenuRadioItem key={mode.id} value={mode.id}>
                          {mode.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          ) : null}
          onStop={stopSafely}
          showAddressAll={Boolean(
            isReviewTab && projection && !isTurnActive && messages.length > 0,
          )}
          onAddressAll={async () => { await submit(ADDRESS_ALL_REVIEW_PROMPT); }}
          contextUsage={composeContextUsage}
          showContextUsage={contextUsage === undefined || composeContextUsage !== null}
          queue={projection?.queue ? {
            length: queuedMessages.length,
            error: projection.queue.blocked
              ? { message: projection.queue.blocked.error }
              : null,
            onOpen: () => setQueueDialogOpen(true),
          } : undefined}
          showSendButton={!sendLocked || canQueue || Boolean(draftSessionAction)}
          sendDisabled={(sendLocked && !draftSessionAction) || isDispatching
            || (!draft.text.trim() && draft.attachments.length === 0)}
          sendTitle={draftSessionAction
            ? draftSessionAction.error ?? `Send to the current ${label} turn`
            : canQueue ? "Add to queue" : "Send"}
          onSend={() => { void submit(draft.text); }}
          footer={projection?.queue ? (
            <QueuedPromptsDialog
              open={queueDialogOpen}
              onOpenChange={setQueueDialogOpen}
              messages={queuedMessages}
              onEdit={async (message) => {
                // Editing loads the prompt into the composer, so anything
                // already there would be destroyed. Refusing with a reason
                // beats the silent overwrite.
                if (draft.text.trim().length > 0 || draft.attachments.length > 0) {
                  throw composerOccupiedError();
                }
                await removeQueued(message.id);
                const queued = message as Record<string, unknown> & {
                  id: string;
                  text: string;
                };
                const attachments = Array.isArray(queued.attachments)
                  ? queued.attachments.flatMap((candidate) => {
                      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
                        return [];
                      }
                      const attachment = candidate as Record<string, unknown>;
                      if (
                        (attachment.type !== "file" && attachment.type !== "image")
                        || typeof attachment.path !== "string"
                        || !attachment.path
                      ) return [];
                      const type: "file" | "image" = attachment.type;
                      return [{
                        id: typeof attachment.id === "string"
                          ? attachment.id
                          : crypto.randomUUID(),
                        type,
                        path: attachment.path,
                        name: typeof attachment.filename === "string"
                          ? attachment.filename
                          : attachment.path.split("/").at(-1) ?? "attachment",
                        ...(typeof attachment.dataUrl === "string"
                          ? { previewUrl: attachment.dataUrl }
                          : {}),
                      }];
                    })
                  : [];
                updateDraft(sessionKey, {
                  text: message.text,
                  mentions: [],
                  attachments,
                });
                await updateControlsSafely({
                  ...(typeof queued.model === "string"
                    ? { modelId: queued.model }
                    : {}),
                  ...(typeof queued.reasoningEffort === "string"
                    ? { reasoningId: queued.reasoningEffort }
                    : {}),
                  ...(queued.mode === "build" || queued.mode === "plan"
                    ? { mode: queued.mode }
                    : {}),
                  ...(typeof queued.fastMode === "boolean"
                    ? { fastMode: queued.fastMode }
                    : {}),
                  ...(typeof queued.executionAgent === "string"
                    ? { executionProfileId: queued.executionAgent }
                    : typeof queued.agent === "string"
                      ? { executionProfileId: queued.agent }
                      : {}),
                  ...(typeof queued.includeLocalSettings === "boolean"
                    ? { includeLocalSettings: queued.includeLocalSettings }
                    : {}),
                  ...(typeof queued.promptSuggestions === "boolean"
                    ? { promptSuggestions: queued.promptSuggestions }
                    : {}),
                });
                inputRef.current?.focus();
              }}
              onMove={async (fromIndex, toIndex) => {
                const message = queuedMessages[fromIndex];
                if (!message || fromIndex === toIndex) return;
                // The durable queue moves one position at a time, so a drag
                // across several rows is applied as that many steps rather
                // than silently landing one slot from where it was dropped.
                const direction = toIndex < fromIndex ? "up" : "down";
                for (let step = 0; step < Math.abs(toIndex - fromIndex); step += 1) {
                  await moveQueued(message.id, direction);
                }
              }}
              onRemove={async (messageId) => { await removeQueued(messageId); }}
              renderMeta={(message) => {
                const queued = message as Record<string, unknown>;
                const attachments = Array.isArray(queued.attachments)
                  ? queued.attachments.length
                  : 0;
                return (
                  <>
                    {queued.mode === "plan" || queued.mode === "build" ? (
                      <span>{queued.mode === "plan" ? "Plan" : "Build"}</span>
                    ) : null}
                    {typeof queued.model === "string" ? (
                      <span>{resolveModelLabel(queued.model)}</span>
                    ) : null}
                    {typeof queued.reasoningEffort === "string" ? (
                      <span>{reasoningLabel(queued.reasoningEffort)}</span>
                    ) : null}
                    {queued.fastMode === true ? <span>Fast mode</span> : null}
                    {typeof queued.executionAgent === "string"
                      || typeof queued.agent === "string" ? (
                        <span>{String(queued.executionAgent ?? queued.agent)}</span>
                      ) : null}
                    {attachments > 0 ? (
                      <span>{attachments} attachment{attachments === 1 ? "" : "s"}</span>
                    ) : null}
                  </>
                );
              }}
              dispatchError={projection.queue.blocked
                ? { message: projection.queue.blocked.error }
                : undefined}
              onRetryDispatch={async () => { await retryQueue(); }}
            />
          ) : null}
        />
      )}
    />
  );
}

/**
 * The only pane-level native agent tab. Every provider renders through the
 * same backend-owned runtime and capability-aware component tree.
 */
