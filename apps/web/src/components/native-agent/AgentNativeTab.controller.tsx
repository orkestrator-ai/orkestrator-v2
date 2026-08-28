import { resolvedPlatformSettings } from "@/lib/agent-settings";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { resolveReasoningId } from "@orkestrator/protocol/native-agent";
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
import {
  useVirtuosoScrollState,
  clearPersistedVirtuosoState,
} from "@/hooks/useVirtuosoScrollState";
import { adoptNativeAgentSession, renameEnvironmentFromPrompt } from "@/lib/backend";
import { buildInitialPromptWithAttachmentReferences } from "@/lib/initial-prompt-attachments";
import { prependAgentHandoffHistory } from "@/lib/agent-handoff";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import {
  applyClaudeBackgroundTaskStates,
  normalizeNativeMessages,
  rowlessBackgroundTaskMessages,
} from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  createPeerMailNativeMessageFromCarrier,
  createOptimisticNativeMessage,
  isClientOnlyNativeMessage,
  TURN_STOPPED_BY_USER,
} from "@/lib/chat/client-only-messages";
import { pinNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
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
import { resolveWorkspaceAttachment } from "@/lib/chat/workspace-attachments";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  nativeComposeDraft,
  nativeComposePersistenceStore,
  useNativeComposeStore,
  type NativeComposeDraft,
} from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import type { FileCandidate } from "@/types";
import { toast } from "sonner";
import { getNativeAgentAdapter, type AgentNativeTabProps } from "./adapter";
import {
  DEFAULT_EXECUTION_PROFILE_ID,
  extractNativePlanContent,
  LAUNCH_EXECUTION_PROFILES,
  nativeComposeProfileLabel,
  useNativeAgentActivityAnnouncement,
} from "./AgentNativeTab.helpers";
import { NativeAgentInteractionCard } from "./NativeAgentInteractionCard";
import { NativeAgentQuestionCard } from "./NativeAgentQuestionCard";
import { CodexPlanModeCard } from "@/components/codex/CodexPlanModeCard";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import {
  findLatestBackendTurnElapsedSeconds,
  findLatestBackendUserTurnStartedAt,
} from "@/lib/session-timer";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import { isSetupBlocked } from "@/lib/setup-commands";

/** Stable identity so the transcript decoration memo cannot churn. */
const EMPTY_BACKGROUND_TASKS: Record<string, never> = {};

export function SharedNativeAgentController({
  tabId,
  data,
  isActive,
  initialPrompt,
  initialAgentModel,
  initialReasoningEffort,
  initialConversationMode,
  initialFastMode,
  initialExecutionProfileId,
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
  const environment = useEnvironmentStore((state) => state.getEnvironmentById(data.environmentId));
  // The whole tier chain in one call, for this platform only. A model belongs
  // to its own platform's catalogue, so nothing here can hand one platform's id
  // to another.
  const configured = resolvedPlatformSettings(
    config,
    environment?.projectId,
    environment,
    platform,
  );
  const configuredModel = configured.model;
  const configuredReasoning = configured.reasoningEffort;
  // Speed is a per-session choice made in the model picker rather than a stored
  // default, so a new tab starts at normal.
  const configuredFastMode = undefined;
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
    attachments: Array<{ path: string; previewUrl?: string; name: string }>;
    createdAt: string;
    requestId?: string;
    confirmation?: NonNullable<NativeComposeDraft["pendingTranscriptConfirmation"]>;
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
  const transcriptConfirmedRequestIdRef = useRef<string | null>(null);
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
    requireExistingResumeSession: data.requireExistingResumeSession,
    // A *new* mode-capable tab starts in build. Left undefined it would adopt
    // whatever mode the provider happens to report. A resumed session is
    // excluded deliberately: that thread already has a mode, and forcing build
    // would silently move a conversation the user left in plan.
    initialConversationMode:
      initialConversationMode ??
      (adapter.capabilities.composer.mode && !data.sessionId ? "build" : undefined),
    initialFastMode,
    initialExecutionProfileId,
    defaultFastMode: configuredFastMode,
    isActive,
    enabled: !setupPending,
  });
  const draft = useNativeComposeStore((state) => nativeComposeDraft(state, sessionKey));
  const updateDraft = useNativeComposeStore((state) => state.updateDraft);
  const clearDraft = useNativeComposeStore((state) => state.clearDraft);
  useNativeComposeDraftPersistence(
    platform,
    data.environmentId,
    sessionKey,
    nativeComposePersistenceStore,
  );
  const clearTabInitialPrompt = usePaneLayoutStore((state) => state.clearTabInitialPrompt);
  const clearTabAgentHandoff = usePaneLayoutStore((state) => state.clearTabAgentHandoff);
  const fileSearch = useFileSearch(
    data.containerId,
    environment?.worktreePath,
    adapter.capabilities.attachments.files || adapter.capabilities.attachments.images,
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
  const backendOwnsStartupPrompt =
    tabId === "startup-agent" &&
    (environment?.pendingAgentLaunch === true || environment?.startupAgentSession !== undefined);
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
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
    const tasks = platform === "claude" ? (projection?.backgroundTasks ?? []) : [];
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
    () =>
      normalizeNativeMessages(decoratedMessages).flatMap((message) => {
        if (
          message.role !== "user" ||
          !message.content.trimStart().startsWith('<orkestrator-peer-message version="1">')
        ) {
          return [message];
        }
        const peerMail = createPeerMailNativeMessageFromCarrier(message);
        return peerMail ? [peerMail] : [];
      }),
    [decoratedMessages],
  );
  const handoff = useAgentHandoff(
    agentHandoffId,
    platform,
    data.environmentId,
    normalizedMessages,
    consumedAgentHandoffId,
  );
  /**
   * The authoritative rows the composer could see when a prompt was submitted.
   *
   * Memoized rather than rebuilt per render: this is read once per submit, and
   * a streaming turn re-renders on every projection frame, where an unmemoized
   * pass over the whole transcript is pure cost.
   */
  const visibleAuthoritativeMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of normalizedMessages) {
      if (!isClientOnlyNativeMessage(message)) ids.add(message.id);
    }
    return ids;
  }, [normalizedMessages]);
  /**
   * Has an authoritative transcript row appeared that can only be this prompt?
   *
   * Two conditions, and both are load-bearing:
   *
   * - The row was not visible when the prompt was submitted. Matching on text
   *   alone confirmed a *previous* identical prompt the instant the user
   *   pressed Enter, and providers reshape prompts (slash-command expansion,
   *   handoff history, attachment references) often enough that the text sent
   *   is not reliably the text echoed.
   * - The row sits after every prior authoritative row that is still visible.
   *   Novelty alone is not confirmation: widening the transcript window brings
   *   older history into view for the first time, and a retained window can
   *   begin on an assistant row. Anchoring to every role keeps those prepended
   *   user rows behind the old tail. A prompt's own echo is appended past what
   *   the composer could see, so position separates the two without depending
   *   on a clock or on the provider echoing the text verbatim.
   * - The row belongs to the same provider session. Resuming another session
   *   replaces the transcript and must not turn one of its user rows into an
   *   acknowledgement for the session the prompt was sent to.
   */
  const transcriptEchoedOptimistic = useMemo(() => {
    const confirmation = optimisticPrompt?.confirmation ?? draft.pendingTranscriptConfirmation;
    if (!confirmation || confirmation.sessionId !== projection?.sessionId) return false;
    const priorMessageIds = new Set(confirmation.priorMessageIds);
    let lastPriorMessageIndex = -1;
    for (let index = 0; index < normalizedMessages.length; index += 1) {
      if (priorMessageIds.has(normalizedMessages[index]!.id)) {
        lastPriorMessageIndex = index;
      }
    }
    return normalizedMessages.some(
      (message, index) =>
        index > lastPriorMessageIndex &&
        message.role === "user" &&
        !isClientOnlyNativeMessage(message) &&
        !priorMessageIds.has(message.id),
    );
  }, [
    draft.pendingTranscriptConfirmation,
    normalizedMessages,
    optimisticPrompt,
    projection?.sessionId,
  ]);
  const turnStopMarker = useNativeAgentProjectionStore((state) =>
    state.turnStopMarkers.get(sessionKey),
  );
  const displayMessages = useMemo(() => {
    const providerBase =
      turnStopMarker &&
      turnStopMarker.sessionId === projection?.sessionId &&
      !handoff.displayMessages.some(
        (message) => message.role === "system" && message.content === TURN_STOPPED_BY_USER,
      )
        ? [
            ...handoff.displayMessages,
            {
              id: `native-stop:${turnStopMarker.sessionId}:${turnStopMarker.createdAt}`,
              role: "system" as const,
              content: TURN_STOPPED_BY_USER,
              parts: [{ type: "text" as const, content: TURN_STOPPED_BY_USER }],
              createdAt: turnStopMarker.createdAt,
            },
          ]
        : handoff.displayMessages;
    const base = providerBase;
    const withOptimistic =
      !optimisticPrompt || transcriptEchoedOptimistic
        ? base
        : [
            ...base,
            createOptimisticNativeMessage(
              `optimistic-native:${sessionKey}`,
              optimisticPrompt.text,
              optimisticPrompt.attachments,
              optimisticPrompt.createdAt,
            ),
          ];
    if (!namingEnvironment) return withOptimistic;
    // Renaming the environment also renames the branch, and it runs before the
    // first prompt is dispatched. Without this the tab looks stalled.
    return [
      ...withOptimistic,
      {
        id: `native-naming:${sessionKey}`,
        role: "system" as const,
        content: "Naming environment...",
        parts: [{ type: "text" as const, content: "Naming environment..." }],
        createdAt: new Date().toISOString(),
      },
    ];
  }, [
    handoff.displayMessages,
    namingEnvironment,
    optimisticPrompt,
    projection?.sessionId,
    sessionKey,
    transcriptEchoedOptimistic,
    turnStopMarker,
  ]);
  /*
   * Tasks the transcript cannot show: the launch fell outside the loaded
   * window, or the tab resumed a session whose earlier turns were trimmed. The
   * snapshot still describes them and still accepts a stop, so they are given
   * the transcript row they are missing — which is what puts them at transcript
   * width, at the bottom while they run, and holding their position once they
   * settle, exactly like a child the transcript did capture.
   *
   * A settled task keeps a row when the backend's settle stamp lands inside the
   * loaded window — it stopped somewhere the reader can see. One that settled
   * before the window begins gets none, because rendering every terminal task in
   * the snapshot would drop a pile of finished cards into a transcript that
   * never mentioned them. Deliberately not "whatever this tab happened to watch
   * go live": that answer would differ between tabs and reset on reload.
   */
  const backgroundTaskRows = useMemo(
    () => rowlessBackgroundTaskMessages(projection?.backgroundTasks ?? [], displayMessages),
    [displayMessages, projection?.backgroundTasks],
  );
  /*
   * The transcript the reader sees, rowless tasks included. The announcement
   * reads it too: a live task is worth announcing whether or not the loaded
   * window happens to contain the row that launched it.
   */
  const transcriptMessages = useMemo(
    () =>
      backgroundTaskRows.length === 0
        ? displayMessages
        : [...displayMessages, ...backgroundTaskRows],
    [backgroundTaskRows, displayMessages],
  );
  const agentActivityAnnouncement = useNativeAgentActivityAnnouncement(
    transcriptMessages,
    sessionKey,
  );
  /*
   * Only the backend transcript supplies positions: a row this tab synthesised
   * for a rowless task is a card, not a place in the conversation.
   */
  const messages = useMemo(
    () => pinNativeAgentParts(transcriptMessages, displayMessages),
    [displayMessages, transcriptMessages],
  );
  const latestAssistantMessage = [...normalizedMessages]
    .reverse()
    .find((message) => message.role === "assistant");
  const planContent = useMemo(
    () => extractNativePlanContent(normalizedMessages),
    [normalizedMessages],
  );

  const composer = projection?.composer;
  const selectedModel =
    composer?.models.find((model) => model.id === composer.selectedModelId) ?? composer?.models[0];
  const selectedReasoningId = composer?.selectedReasoningId ?? selectedModel?.defaultReasoningId;
  const selectedReasoningLabel = selectedModel?.reasoning?.find(
    (option) => option.id === selectedReasoningId,
  )?.label;
  const resolveModelLabel = useCallback(
    (modelId: string) =>
      resolveCatalogModelLabel(
        modelId,
        (composer?.models ?? []).map((model) => ({
          id: model.id,
          name: model.label,
        })),
      ),
    [composer?.models],
  );
  /** Neutral reasoning label, from whichever model advertised the option. */
  const reasoningLabel = useCallback(
    (reasoningId: string) => {
      for (const model of composer?.models ?? []) {
        const option = model.reasoning?.find((candidate) => candidate.id === reasoningId);
        if (option) return option.label;
      }
      return reasoningId;
    },
    [composer?.models],
  );
  const updateControlsSafely = useCallback(
    async (update: Parameters<typeof updateControls>[0]) => {
      try {
        return await updateControls(update);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Failed to update ${label} settings`);
        return null;
      }
    },
    [label, updateControls],
  );
  const phase = projection?.turn.phase;
  const settingsLocked = isSubmitting || (phase !== "idle" && phase !== "error");
  const isRunning = phase === "running";
  const isTurnActive = phase === "running" || phase === "recovering" || phase === "cancelling";
  /*
   * "Stopping" and "reconnecting" are still loading, but they mean something
   * different to the user than ordinary thinking. Derived from the neutral
   * phase, so every provider that reports one gets the label.
   */
  const phaseStatusLabel =
    phase === "cancelling" ? (
      <span role="status" className="text-xs">
        Stopping…
      </span>
    ) : phase === "recovering" ? (
      <span role="status" className="text-xs">
        Reconnecting to {label}…
      </span>
    ) : undefined;
  const turnStartedAt =
    projection?.turn.startedAt ??
    (isTurnActive
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
    () =>
      isTurnActive
        ? null
        : (findLatestBackendTurnElapsedSeconds(
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
  const sendLocked =
    !projection ||
    !handoff.ready ||
    (isRunning && !canQueue) ||
    phase === "cancelling" ||
    phase === "recovering" ||
    phase === "blocked" ||
    Boolean(recoverableDispatch) ||
    isSubmitting;
  const queuedMessages = useMemo(
    () =>
      (projection?.queue?.items ?? []).flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const item = candidate as Record<string, unknown>;
        return typeof item.id === "string" && typeof item.text === "string"
          ? [{ ...item, id: item.id, text: item.text }]
          : [];
      }),
    [projection?.queue?.items],
  );
  const stopBackgroundTaskFromCard = useCallback(
    async (taskId: string) => {
      try {
        await stopBackgroundTask(taskId);
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to stop background task");
        return false;
      }
    },
    [stopBackgroundTask],
  );
  const discardProvisionalDraft = useCallback(() => {
    void discardComposeDraft(composeDraftKey("agent-native", data.environmentId, sessionKey)).catch(
      (error) => {
        console.warn("[AgentNativeTab] Failed to discard provisional compose draft:", error);
      },
    );
  }, [data.environmentId, sessionKey]);

  const clearConfirmedDraft = useCallback(
    (requestId: string | undefined): boolean => {
      if (!requestId) return false;
      const current = useNativeComposeStore.getState().drafts.get(sessionKey);
      // Editing any content clears requestId in nativeComposeStore. That makes
      // this comparison the ownership check which prevents a late transcript
      // echo from deleting the user's next prompt.
      if (current?.requestId !== requestId) return false;
      clearDraft(sessionKey);
      discardProvisionalDraft();
      return true;
    },
    [clearDraft, discardProvisionalDraft, sessionKey],
  );

  useEffect(() => {
    if (!transcriptEchoedOptimistic) return;
    const confirmation = optimisticPrompt?.confirmation ?? draft.pendingTranscriptConfirmation;
    if (!confirmation) return;
    // A dispatch response can be lost after the backend accepted the prompt.
    // The new authoritative transcript row is definitive confirmation, so the
    // matching submitted draft must not remain in the composer indefinitely.
    transcriptConfirmedRequestIdRef.current = confirmation.requestId;
    if (clearConfirmedDraft(confirmation.requestId)) setSendError(null);
    setOptimisticPrompt(null);
  }, [
    clearConfirmedDraft,
    draft.pendingTranscriptConfirmation,
    optimisticPrompt,
    transcriptEchoedOptimistic,
  ]);

  /**
   * OpenCode has no conversation-mode list; Plan/Build are primary agents.
   * Fall back to the built-in pair when the live agent listing has not arrived
   * yet so an existing session can still switch before `app.agents` returns.
   */
  const composeExecutionProfiles = useMemo(() => {
    if (adapter.capabilities.composer.mode) return [];
    if (adapter.capabilities.composer.executionProfile !== true) return [];
    const profiles = composer?.executionProfiles ?? [];
    return profiles.length > 0 ? profiles : [...LAUNCH_EXECUTION_PROFILES];
  }, [
    adapter.capabilities.composer.executionProfile,
    adapter.capabilities.composer.mode,
    composer?.executionProfiles,
  ]);
  /**
   * The profile the next prompt will actually run under.
   *
   * Display and dispatch must read this one value. A trigger that showed the
   * first listed agent while `executionAgent` went out `undefined` ran the turn
   * under OpenCode's own `build` default while naming a different agent — the
   * one thing an agent picker must never do. The projection leaves
   * `selectedExecutionProfileId` undefined whenever no id was ever stored, an
   * id was cleared to null from the agent-information panel, or a stored id is
   * absent from the arrived listing, and `app.agents` has no defined order, so
   * the first entry is an arbitrary primary agent.
   *
   * Preferring the listed `build` keeps the provider default honest; falling
   * back to the first entry covers an agent set with no `build`, where the
   * provider default names an agent that does not exist and the shown one is
   * the only valid thing to send.
   *
   * Synthesised only when this tab owns a compose-bar profile list. Claude's
   * subagent has no provider-side default, so leaving it undefined is correct
   * and inventing one would silently route the turn to a subagent.
   */
  const effectiveComposeProfileId =
    composer?.selectedExecutionProfileId ??
    (
      composeExecutionProfiles.find((profile) => profile.id === DEFAULT_EXECUTION_PROFILE_ID) ??
      composeExecutionProfiles[0]
    )?.id;
  const selectedComposeProfileId = effectiveComposeProfileId ?? DEFAULT_EXECUTION_PROFILE_ID;

  const submit = useCallback(
    async (text: string, requestId?: string, preparedPrompt = false) => {
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
        handoff.pendingHistory &&
        isProviderSlashCommand(
          userPrompt,
          projection?.slashCommands ?? [],
          projection?.capabilities,
        )
      ) {
        setSendError(
          "Send a normal message first to complete the agent handoff; slash commands cannot carry transferred history.",
        );
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
        const actionRequestId =
          requestId ??
          draft.requestId ??
          (ambiguous?.kind === sessionAction.kind && ambiguous.text === sessionAction.text
            ? ambiguous.requestId
            : crypto.randomUUID());
        updateDraft(sessionKey, { requestId: actionRequestId });
        try {
          const outcome = await performAction({
            kind: sessionAction.kind,
            text: sessionAction.text,
            requestId: actionRequestId,
          });
          ambiguousActionRef.current =
            outcome.outcome === "unknown"
              ? { kind: sessionAction.kind, text: sessionAction.text, requestId: actionRequestId }
              : null;
          if (outcome.outcome === "applied") {
            clearDraft(sessionKey);
            discardProvisionalDraft();
            toast.success(`Sent to the active ${label} turn`);
            return true;
          }
          setSendError(
            outcome.outcome === "unknown"
              ? `Could not confirm whether ${label} received the steering text. Resending reuses the same request id.`
              : outcome.outcome === "mismatch"
                ? "The turn moved on before the steering text was delivered."
                : `${label} is no longer running a turn to steer.`,
          );
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
        : (requestId ?? draft.requestId ?? crypto.randomUUID());
      if (dispatchRequestId) updateDraft(sessionKey, { requestId: dispatchRequestId });
      setSendError(null);
      transcriptConfirmedRequestIdRef.current = null;
      setOptimisticPrompt({
        text: userPrompt,
        attachments: submittedAttachments,
        createdAt: new Date().toISOString(),
        requestId: dispatchRequestId,
      });
      if (
        (projection?.messages.length ?? 0) === 0 &&
        environment &&
        isDefaultTimestampEnvironmentName(environment.name)
      ) {
        // Renaming also renames the branch, so it runs before dispatch and can
        // take a moment. Say what is happening instead of showing a stalled send.
        setNamingEnvironment(true);
        try {
          await renameEnvironmentFromPrompt(data.environmentId, userPrompt);
        } catch (error) {
          console.warn("[AgentNativeTab] Failed to rename environment from first prompt:", error);
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
        subAgent: platform === "claude" ? effectiveComposeProfileId : undefined,
        executionAgent: platform === "opencode" ? effectiveComposeProfileId : undefined,
        includeLocalSettings: platform === "claude" ? composer?.includeLocalSettings : undefined,
        promptSuggestions: platform === "claude" ? composer?.promptSuggestionsEnabled : undefined,
        attachments: submittedAttachments.map((attachment) => ({
          type: attachment.type,
          path: attachment.path,
          filename: attachment.name,
        })),
      };
      const transcriptConfirmation =
        dispatchRequestId && projection?.sessionId
          ? {
              requestId: dispatchRequestId,
              sessionId: projection.sessionId,
              priorMessageIds: Array.from(visibleAuthoritativeMessageIds),
            }
          : undefined;
      if (transcriptConfirmation) {
        updateDraft(sessionKey, {
          requestId: dispatchRequestId,
          pendingTranscriptConfirmation: transcriptConfirmation,
        });
        setOptimisticPrompt((current) =>
          current && current.requestId === dispatchRequestId
            ? { ...current, confirmation: transcriptConfirmation }
            : current,
        );
      }
      let keepTranscriptConfirmation = false;
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
        const transcriptConfirmed =
          dispatchRequestId !== undefined &&
          transcriptConfirmedRequestIdRef.current === dispatchRequestId;
        if (outcome.outcome === "accepted" || transcriptConfirmed) {
          transcriptConfirmedRequestIdRef.current = null;
          clearDraft(sessionKey);
          discardProvisionalDraft();
          if (agentHandoffId) clearTabAgentHandoff(tabId, data.environmentId);
          return true;
        }
        if (outcome.outcome === "rejected") setOptimisticPrompt(null);
        keepTranscriptConfirmation = outcome.outcome === "unknown";
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
        ...(keepTranscriptConfirmation && transcriptConfirmation
          ? { pendingTranscriptConfirmation: transcriptConfirmation }
          : { pendingTranscriptConfirmation: undefined }),
      });
      return false;
    },
    [
      clearDraft,
      composer?.fastModeEnabled,
      composer?.selectedModeId,
      composer?.selectedModelId,
      composer?.selectedReasoningId,
      effectiveComposeProfileId,
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
      isRunning,
      label,
      performAction,
      platform,
      projection?.capabilities,
      projection?.messages.length,
      projection?.sessionId,
      projection?.slashCommands,
      recoverableDispatch,
      send,
      sendLocked,
      serializeForLLM,
      sessionKey,
      tabId,
      updateDraft,
      visibleAuthoritativeMessageIds,
    ],
  );

  /**
   * Provider entries mapped to the shared picker's neutral row shape. Sorting
   * and current-session exclusion belong to the dialog and the backend, not to
   * each provider's own copy of a list.
   */
  const fetchResumableSessions = useCallback(
    async (): Promise<ResumableSession[]> =>
      (await listResumable()).map((entry) => ({
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
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : "Failed to dismiss suggestion"),
      )
      .finally(() => setSuggestionDismissPending(false));
  }, [adapter.capabilities.composer.promptSuggestions, dismissSuggestedPrompt]);

  const cycleMode = useMemo(() => {
    const modes = composer?.modes ?? [];
    if (modes.length >= 2 && !settingsLocked) {
      return () => {
        const index = modes.findIndex((mode) => mode.id === (composer?.selectedModeId ?? "build"));
        const next = modes[(index + 1) % modes.length];
        if (next) void updateControlsSafely({ mode: next.id });
      };
    }
    if (composeExecutionProfiles.length < 2 || settingsLocked) return undefined;
    return () => {
      const index = composeExecutionProfiles.findIndex(
        (profile) => profile.id === selectedComposeProfileId,
      );
      const next = composeExecutionProfiles[(index + 1) % composeExecutionProfiles.length];
      if (next) void updateControlsSafely({ executionProfileId: next.id });
    };
  }, [
    composeExecutionProfiles,
    composer?.modes,
    composer?.selectedModeId,
    selectedComposeProfileId,
    settingsLocked,
    updateControlsSafely,
  ]);

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
    refresh: async (options) => {
      await refresh(options);
    },
  });

  const handleFileMentionSelect = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMention(mention);
    },
    [closeFileMentionMenu, createMention],
  );
  const handleWorkspaceFileMention = useCallback(
    (file: FileCandidate) => {
      const mention = createMention(file);
      closeFileMentionMenu({ suppressReopenFor: file.filename });
      inputRef.current?.insertMentionAtCursor(mention);
    },
    [closeFileMentionMenu, createMention],
  );
  const handleWorkspaceFileAttach = useCallback(
    (file: FileCandidate) => {
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
    },
    [
      adapter.capabilities.attachments.files,
      adapter.capabilities.attachments.images,
      data.containerId,
      environment?.worktreePath,
      selectedModel?.label,
      selectedModel?.supportsImageInput,
      sessionKey,
      updateDraft,
    ],
  );
  const handlePastedImage = useCallback(
    (attachment: { id: string; type: "image"; path: string; previewUrl: string; name: string }) => {
      const current = useNativeComposeStore.getState().drafts.get(sessionKey);
      updateDraft(sessionKey, {
        attachments: [...(current?.attachments ?? []), attachment],
      });
    },
    [sessionKey, updateDraft],
  );
  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: data.containerId ?? null,
    worktreePath: environment?.worktreePath,
    onAttach: handlePastedImage,
    canAttachImage: () =>
      adapter.capabilities.attachments.images && selectedModel?.supportsImageInput !== false,
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
    () =>
      buildMessageForkPlan(handoff.displayMessages, {
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

  const handleFork = useCallback(
    async (messageId: string, kind: MessageForkKind) => {
      if (forkLatchRef.current || !projection?.sessionId) return;
      forkLatchRef.current = true;
      setForkInFlight(true);
      try {
        const planned = forkPlanRef.current.get(messageId);
        if (!planned || planned.kind !== kind) {
          throw new Error("The selected message is no longer in this session");
        }
        const outcome =
          planned.boundary.type === "session-start"
            ? null
            : await fork(
                planned.boundary.type === "message" ? planned.boundary.messageId : undefined,
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
    },
    [data, fork, label, platform, projection?.sessionId, projection?.title, updateDraft],
  );
  const renderForkAction = useMessageForkAction({
    agentLabel: label,
    disabled: forkInFlight || phase === "running" || phase === "recovering",
    onFork: (messageId, kind) => {
      void handleFork(messageId, kind);
    },
  });
  const showPlanReview =
    platform === "codex" &&
    composer?.selectedModeId === "plan" &&
    phase === "idle" &&
    latestAssistantMessage?.planReview === true &&
    latestAssistantMessage.id !== dismissedPlanReviewId;
  const switchPlanToBuild = useCallback(
    async (implement: boolean) => {
      if (planTransitionPending) return;
      setPlanTransitionPending(true);
      try {
        await updateControls({ mode: "build" });
        setDismissedPlanReviewId(latestAssistantMessage?.id ?? null);
        if (implement) {
          const outcome = await send("The plan is approved. Exit plan mode and implement it.", {
            model: composer?.selectedModelId,
            reasoningEffort: composer?.selectedReasoningId,
            mode: "build",
            fastMode: composer?.fastModeEnabled ?? undefined,
          });
          if (outcome.outcome !== "accepted") {
            throw new Error(outcome.error ?? "Plan implementation dispatch was not confirmed");
          }
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to leave plan mode");
      } finally {
        setPlanTransitionPending(false);
      }
    },
    [
      composer?.fastModeEnabled,
      composer?.selectedModelId,
      composer?.selectedReasoningId,
      latestAssistantMessage?.id,
      planTransitionPending,
      send,
      updateControls,
    ],
  );

  useEffect(() => {
    if (backendOwnsStartupPrompt && initialPrompt) {
      clearTabInitialPrompt(tabId, data.environmentId);
      return;
    }
    if (!projection || initialPromptSentRef.current || !initialPrompt?.trim()) return;
    // A tab that asked to resume a specific conversation carries a prompt that
    // only makes sense inside it — "address every finding" means nothing in an
    // empty session. Adoption falls back to creating a fresh session when the
    // provider has forgotten the rollout, so refuse to fire the startup prompt
    // at whatever session we actually landed in and say why instead.
    const requestedSessionId = requestedResumeSessionIdRef.current;
    if (requestedSessionId && projection.sessionId && projection.sessionId !== requestedSessionId) {
      initialPromptSentRef.current = true;
      clearTabInitialPrompt(tabId, data.environmentId);
      setSendError(
        "The conversation this tab was opened to resume is no longer available, " +
          "so its opening message was not sent. Send it yourself to continue in " +
          "this new session.",
      );
      return;
    }
    initialPromptSentRef.current = true;
    void submit(initialPrompt, `initial-prompt:${data.environmentId}:${tabId}`, true).then(
      (accepted) => {
        if (accepted) clearTabInitialPrompt(tabId, data.environmentId);
        else initialPromptSentRef.current = false;
      },
    );
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
  const connectionState =
    projection?.connection ??
    (isRefreshing
      ? ("connecting" as const)
      : runtimeError || hasCompletedRead
        ? ("error" as const)
        : ("connecting" as const));
  const contextUsage = projection?.contextUsage;
  const maximumTokens = contextUsage?.maximumTokens;
  const composeContextUsage =
    contextUsage === undefined
      ? undefined
      : maximumTokens !== undefined && Number.isFinite(maximumTokens) && maximumTokens > 0
        ? {
            usedTokens: contextUsage.usedTokens,
            totalTokens: maximumTokens,
            percentUsed:
              contextUsage.percentage ??
              Math.min(100, (contextUsage.usedTokens / maximumTokens) * 100),
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
   * Questions render in the transcript; everything else the turn is blocked on
   * stays pinned above the composer. An approval gates a command that is about
   * to run and must not scroll away, whereas a question is a turn in the
   * conversation and belongs where the conversation is.
   */
  const allInteractions = projection?.interactions ?? [];
  const questionInteractions = allInteractions.filter(
    (interaction) => interaction.kind === "question",
  );
  const pinnedInteractions = allInteractions.filter(
    (interaction) => interaction.kind !== "question",
  );
  const composerCentered =
    messages.length === 0 && !isTurnActive && questionInteractions.length === 0;

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
        onDismiss={() => setDismissedPlanReviewId(latestAssistantMessage?.id ?? null)}
      />
    ) : null,
    ...(projection?.notices ?? []).map((notice, index) => (
      <div
        key={`notice:${notice.kind}:${index}`}
        role="status"
        className={
          notice.kind === "error"
            ? "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            : "rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-100"
        }
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
          {label} did not confirm your last message, so it may or may not have been received.
          Retrying sends it under the same request id, so it cannot run twice. Until you choose,
          this session will not accept a new message.
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
                  clearConfirmedDraft(recoverableDispatch.requestId);
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
              void discardRecoverableDispatch()
                .then(() => {
                  setSendError(null);
                  setOptimisticPrompt(null);
                })
                .catch((error: unknown) => {
                  setSendError(error instanceof Error ? error.message : String(error));
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
      onRetry={() => {
        void connect();
      }}
      messages={messages}
      agentActivityAnnouncement={agentActivityAnnouncement}
      resolveModelLabel={resolveModelLabel}
      loadToolDetails={loadToolDetails}
      stopBackgroundTask={
        adapter.capabilities.backgroundTasks ? stopBackgroundTaskFromCard : undefined
      }
      isLoading={isTurnActive}
      statusLabel={phaseStatusLabel}
      elapsedSeconds={elapsedSeconds}
      finalElapsedSeconds={finalElapsedSeconds}
      centerCompose={composerCentered}
      emptyStateMessage={`Ask ${label} to work on this repository.`}
      transcriptHeader={
        projection?.messageWindow?.truncated ? (
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
                    .catch((error) =>
                      toast.error(
                        error instanceof Error ? error.message : "Failed to load earlier messages",
                      ),
                    )
                    .finally(() => setLoadingEarlier(false));
                }}
              >
                {loadingEarlier ? "Loading…" : "Load earlier messages"}
              </Button>
            ) : null}
          </div>
        ) : null
      }
      isAtBottom={isAtBottom}
      scrollToBottom={scrollToBottom}
      scrollProps={scrollProps}
      virtuosoRef={virtuosoRef}
      blockingCards={pinnedInteractions.map((interaction) => (
        <NativeAgentInteractionCard
          key={interaction.id}
          interaction={interaction}
          planContent={interaction.kind === "plan-approval" ? planContent : undefined}
          onResolve={(resolution) => resolveInteraction(interaction.id, resolution)}
        />
      ))}
      transcriptCards={questionInteractions.map((interaction) => (
        <NativeAgentQuestionCard
          key={interaction.id}
          interaction={interaction}
          onResolve={(resolution) => resolveInteraction(interaction.id, resolution)}
        />
      ))}
      pinnedAccessory={pinnedCards.length > 0 ? <>{pinnedCards}</> : null}
      topAccessory={
        projection?.suggestedPrompt ? (
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
        ) : null
      }
      messageActions={
        adapter.capabilities.fork
          ? (message) => {
              const planned = forkPlan.get(message.id);
              return planned ? renderForkAction(message.id, planned.kind) : null;
            }
          : undefined
      }
      onResumeClick={adapter.capabilities.resume ? () => setResumeDialogOpen(true) : undefined}
      resumeDialog={
        adapter.capabilities.resume ? (
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
                executionProfileId: effectiveComposeProfileId,
                includeLocalSettings: composer?.includeLocalSettings,
                promptSuggestions: composer?.promptSuggestionsEnabled,
              })
                .then(() => {
                  clearPersistedVirtuosoState(sessionKey);
                  scrollToBottom();
                })
                .catch((error) =>
                  toast.error(error instanceof Error ? error.message : `Failed to resume ${label}`),
                );
            }}
          />
        ) : null
      }
      composer={
        <NativeComposeBar
          testId="shared-native-compose-bar"
          layout={composerCentered ? "centered" : "bottom"}
          attachments={draft.attachments}
          onRemoveAttachment={(attachmentId) =>
            updateDraft(sessionKey, {
              attachments: draft.attachments.filter((candidate) => candidate.id !== attachmentId),
            })
          }
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
          menus={
            fileMentionMenuOpen ? (
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
            ) : null
          }
          primaryControls={
            composer ? (
              <>
                {adapter.capabilities.attachments.files ||
                adapter.capabilities.attachments.images ? (
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
                    void refreshModels().catch((error) =>
                      toast.error(
                        error instanceof Error ? error.message : "Failed to refresh models",
                      ),
                    );
                  }}
                  onModelChange={(modelId) => {
                    const nextModel = composer.models.find((model) => model.id === modelId);
                    const supportedReasoning = nextModel?.reasoning ?? [];
                    const nextReasoningId =
                      resolveReasoningId(
                        supportedReasoning,
                        selectedReasoningId,
                        nextModel?.defaultReasoningId,
                      ) ?? nextModel?.defaultReasoningId;
                    void updateControlsSafely({
                      modelId,
                      ...(nextReasoningId ? { reasoningId: nextReasoningId } : {}),
                    }).then((updated) => {
                      if (!updated) return;
                      if (
                        nextModel?.supportsImageInput === false &&
                        draft.attachments.some((attachment) => attachment.type === "image")
                      ) {
                        toast.error(`${nextModel.label} does not support image input`);
                      }
                    });
                  }}
                  reasoningOptions={selectedModel?.reasoning ?? []}
                  selectedReasoningId={selectedReasoningId}
                  selectedReasoningLabel={selectedReasoningLabel}
                  onReasoningChange={
                    (selectedModel?.reasoning?.length ?? 0) > 0
                      ? (reasoningId) => {
                          void updateControlsSafely({ reasoningId });
                        }
                      : undefined
                  }
                  fastModeEnabled={composer.fastModeEnabled}
                  fastModeAvailable={composer.fastModeAvailable}
                  speedCapable={adapter.capabilities.composer.speed}
                  onFastModeChange={
                    composer.fastModeAvailable
                      ? (fastMode) => {
                          void updateControlsSafely({ fastMode });
                        }
                      : undefined
                  }
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
                ) : composeExecutionProfiles.length > 0 ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        disabled={settingsLocked}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        title="Choose mode"
                      >
                        <ChevronDown className="h-3 w-3" />
                        <span>
                          {nativeComposeProfileLabel(
                            selectedComposeProfileId,
                            composeExecutionProfiles.find(
                              (profile) => profile.id === selectedComposeProfileId,
                            )?.label,
                          )}
                        </span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuRadioGroup
                        value={selectedComposeProfileId}
                        onValueChange={(executionProfileId) => {
                          void updateControlsSafely({ executionProfileId });
                        }}
                      >
                        {composeExecutionProfiles.map((profile) => (
                          <DropdownMenuRadioItem key={profile.id} value={profile.id}>
                            {nativeComposeProfileLabel(profile.id, profile.label)}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </>
            ) : null
          }
          onStop={stopSafely}
          showAddressAll={Boolean(
            isReviewTab && projection && !isTurnActive && messages.length > 0,
          )}
          onAddressAll={async () => {
            await submit(ADDRESS_ALL_REVIEW_PROMPT);
          }}
          contextUsage={composeContextUsage}
          showContextUsage={contextUsage === undefined || composeContextUsage !== null}
          queue={
            projection?.queue
              ? {
                  length: queuedMessages.length,
                  error: projection.queue.blocked
                    ? { message: projection.queue.blocked.error }
                    : null,
                  onOpen: () => setQueueDialogOpen(true),
                }
              : undefined
          }
          showSendButton={!sendLocked || canQueue || Boolean(draftSessionAction)}
          sendDisabled={
            (sendLocked && !draftSessionAction) ||
            isDispatching ||
            (!draft.text.trim() && draft.attachments.length === 0)
          }
          sendTitle={
            draftSessionAction
              ? (draftSessionAction.error ?? `Send to the current ${label} turn`)
              : canQueue
                ? "Add to queue"
                : "Send"
          }
          onSend={() => {
            void submit(draft.text);
          }}
          footer={
            projection?.queue ? (
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
                        if (
                          !candidate ||
                          typeof candidate !== "object" ||
                          Array.isArray(candidate)
                        ) {
                          return [];
                        }
                        const attachment = candidate as Record<string, unknown>;
                        if (
                          (attachment.type !== "file" && attachment.type !== "image") ||
                          typeof attachment.path !== "string" ||
                          !attachment.path
                        )
                          return [];
                        const type: "file" | "image" = attachment.type;
                        return [
                          {
                            id:
                              typeof attachment.id === "string"
                                ? attachment.id
                                : crypto.randomUUID(),
                            type,
                            path: attachment.path,
                            name:
                              typeof attachment.filename === "string"
                                ? attachment.filename
                                : (attachment.path.split("/").at(-1) ?? "attachment"),
                            ...(typeof attachment.dataUrl === "string"
                              ? { previewUrl: attachment.dataUrl }
                              : {}),
                          },
                        ];
                      })
                    : [];
                  updateDraft(sessionKey, {
                    text: message.text,
                    mentions: [],
                    attachments,
                  });
                  await updateControlsSafely({
                    ...(typeof queued.model === "string" ? { modelId: queued.model } : {}),
                    ...(typeof queued.reasoningEffort === "string"
                      ? { reasoningId: queued.reasoningEffort }
                      : {}),
                    ...(queued.mode === "build" || queued.mode === "plan"
                      ? { mode: queued.mode }
                      : {}),
                    ...(typeof queued.fastMode === "boolean" ? { fastMode: queued.fastMode } : {}),
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
                onRemove={async (messageId) => {
                  await removeQueued(messageId);
                }}
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
                      {typeof queued.executionAgent === "string" ||
                      typeof queued.agent === "string" ? (
                        <span>{String(queued.executionAgent ?? queued.agent)}</span>
                      ) : null}
                      {attachments > 0 ? (
                        <span>
                          {attachments} attachment{attachments === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </>
                  );
                }}
                dispatchError={
                  projection.queue.blocked ? { message: projection.queue.blocked.error } : undefined
                }
                onRetryDispatch={async () => {
                  await retryQueue();
                }}
              />
            ) : null
          }
        />
      }
    />
  );
}

/**
 * The only pane-level native agent tab. Every provider renders through the
 * same backend-owned runtime and capability-aware component tree.
 */
