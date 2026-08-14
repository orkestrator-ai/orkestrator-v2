import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, History, X } from "lucide-react";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { Button } from "@/components/ui/button";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { FileMentionMenu } from "@/components/chat/FileMentionMenu";
import { SlashCommandMenu } from "@/components/chat/SlashCommandMenu";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { NativeAttachmentMenu } from "@/components/chat/NativeAttachmentMenu";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import { NativeComposeDock } from "@/components/chat/NativeComposeDock";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import { QueuedPromptsDialog } from "@/components/chat/QueuedPromptsDialog";
import { useMessageForkAction } from "@/components/chat/MessageForkAction";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useNativeComposeBarPaste } from "@/hooks/useNativeComposeBarPaste";
import { useNativeComposeDraftPersistence } from "@/hooks/useNativeComposeDraftPersistence";
import { useNativeAgentSession } from "@/hooks/useNativeAgentSession";
import { useAgentHandoff } from "@/hooks/useAgentHandoff";
import { useEscapeToStop } from "@/hooks/useEscapeToStop";
import { useManualSessionRefresh } from "@/hooks/useManualSessionRefresh";
import { useSlashCommandMenu } from "@/hooks/useSlashCommandMenu";
import {
  clearPersistedVirtuosoState,
  useVirtuosoScrollState,
} from "@/hooks/useVirtuosoScrollState";
import {
  adoptNativeAgentSession,
  getNativeAgentModelCatalog,
  renameEnvironmentFromPrompt,
  updateGlobalConfig,
} from "@/lib/backend";
import { isDefaultTimestampEnvironmentName } from "@/lib/environment-name";
import { buildInitialPromptWithAttachmentReferences } from "@/lib/initial-prompt-attachments";
import { prependAgentHandoffHistory } from "@/lib/agent-handoff";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { normalizeNativeMessages } from "@/lib/chat/native-message-adapters";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import {
  createOptimisticNativeMessage,
  TURN_STOPPED_BY_USER,
} from "@/lib/chat/client-only-messages";
import { pinActiveNativeAgentParts } from "@/lib/chat/native-agent-pinning";
import { resolveCatalogModelLabel } from "@/lib/chat/model-label";
import { persistAgentModelDefault } from "@/lib/chat/agent-model-preferences";
import { persistCodexGlobalPreferences } from "@/components/codex/codex-preferences";
import {
  buildMessageForkPlan,
  findNextForkMessage,
  findPreviousForkMessage,
  forkAttachmentNotice,
  type MessageForkKind,
} from "@/components/chat/message-fork";
import { createPersistedPaneLayoutInput, flushPaneLayoutNow } from "@/lib/pane-layout-persistence";
import { composeDraftKey, discardComposeDraft } from "@/lib/compose-draft-persistence";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  nativeComposeDraft,
  nativeComposePersistenceStore,
  unassignedNativeComposePersistenceStore,
  useNativeComposeStore,
} from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import type { FileCandidate, FileMention } from "@/types";
import { toast } from "sonner";
import {
  findNativeAgentAdapter,
  getNativeAgentAdapter,
  nativeAgentAdapters,
  type AgentNativeTabProps,
} from "./adapter";
import { NativeAgentInteractionCard } from "./NativeAgentInteractionCard";
import { NativeAgentResumeDialog } from "./NativeAgentResumeDialog";
import { CodexPlanModeCard } from "@/components/codex/CodexPlanModeCard";
import { ClaudeBackgroundTaskHoldCard } from "@/components/claude/ClaudeBackgroundTaskHoldCard";
import { useElapsedTimer } from "@/hooks/useElapsedTimer";
import { SetupPendingOverlay } from "@/components/setup/SetupPendingOverlay";
import { isSetupBlocked } from "@/lib/setup-commands";

function PlatformIcon({ platform }: { platform: AgentPlatform }) {
  return <AgentPlatformIcon platform={platform} className="size-5" />;
}

function extractNativePlanContent(messages: readonly NativeMessage[]): string | undefined {
  const looksLikePlan = (path: string) => {
    const normalized = path.toLowerCase();
    const filename = normalized.split("/").at(-1) ?? "";
    return /(^|[-_])plan\.md$/.test(filename)
      || /plan[-_].*\.md$/.test(filename)
      || [".claude/", "docs/plans/", "plans/"].some(
        (directory) => normalized.includes(directory) && normalized.endsWith(".md"),
      );
  };
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool-invocation" || part.toolName?.toLowerCase() !== "write") continue;
      const path = part.toolArgs?.file_path;
      const content = part.toolArgs?.content;
      if (typeof path === "string" && looksLikePlan(path) && typeof content === "string") {
        return content;
      }
    }
  }
  return undefined;
}

function NativeAgentResumePlatformDialog({
  open,
  onOpenChange,
  enabledPlatforms,
  disabled,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabledPlatforms: AgentPlatform[];
  disabled: boolean;
  onSelect: (platform: AgentPlatform) => void;
}) {
  const platforms = AGENT_PLATFORMS.filter((platform) => enabledPlatforms.includes(platform));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resume a session</DialogTitle>
          <DialogDescription>
            Choose which agent the session belongs to. You’ll choose the session next.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {platforms.map((platform) => {
            const adapter = nativeAgentAdapters[platform];
            const canResume = adapter.capabilities.resume;
            return (
              <button
                key={platform}
                type="button"
                disabled={disabled || !canResume}
                onClick={() => onSelect(platform)}
                className="flex items-center gap-3 rounded-lg border border-border/70 bg-zinc-900/60 px-3 py-3 text-left transition-colors hover:border-border hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/50">
                  <PlatformIcon platform={platform} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{adapter.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {canResume ? "Choose a previous session" : "Session resume is not available yet"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UnassignedNativeAgentComposer({
  tabId,
  environmentId,
  containerId,
  disabled,
  onSend,
  onResume,
}: {
  tabId: string;
  environmentId: string;
  containerId?: string;
  disabled: boolean;
  onSend: (
    platform: AgentPlatform,
    prompt: string,
    options: {
      modelId?: string;
      reasoningId?: string;
      fastMode: boolean;
      mode: "build" | "plan";
    },
  ) => void;
  onResume: (platform: AgentPlatform) => void;
}) {
  const sessionKey = createSessionKey(environmentId, tabId);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const draft = useNativeComposeStore((state) => nativeComposeDraft(state, sessionKey));
  const hasDraft = useNativeComposeStore((state) => state.drafts.has(sessionKey));
  const updateStoreDraft = useNativeComposeStore((state) => state.updateDraft);
  const defaultPlatform = useConfigStore((state) => state.config.global.defaultAgent ?? "claude");
  const globalConfig = useConfigStore((state) => state.config.global);
  const environment = useEnvironmentStore(
    (state) => state.getEnvironmentById(environmentId),
  );
  const worktreePath = environment?.worktreePath;
  const { favorites, enabledPlatforms, toggleFavorite } = useAgentModelFavorites();
  const [resumePlatformDialogOpen, setResumePlatformDialogOpen] = useState(false);
  const [models, setModels] = useState<AgentModel[]>([]);
  const platform = draft.platform ?? defaultPlatform;
  const selectedAdapter = findNativeAgentAdapter(platform);
  const platformFastModeDefault = platform === "claude"
    ? globalConfig.claudeNativeFastModeDefault ?? false
    : platform === "codex"
      ? globalConfig.codexNativeFastModeDefault ?? false
      : false;
  const effectiveFastMode = hasDraft ? draft.fastMode : platformFastModeDefault;
  const updateDraft = useCallback((
    key: string,
    update: Partial<typeof draft>,
  ) => {
    const current = useNativeComposeStore.getState().drafts.get(key);
    const nextPlatform = update.platform ?? current?.platform ?? platform;
    const defaultFastMode = nextPlatform === "claude"
      ? useConfigStore.getState().config.global.claudeNativeFastModeDefault ?? false
      : nextPlatform === "codex"
        ? useConfigStore.getState().config.global.codexNativeFastModeDefault ?? false
        : false;
    updateStoreDraft(key, {
      ...(current ? {} : { fastMode: defaultFastMode }),
      ...update,
    });
  }, [platform, updateStoreDraft]);
  useNativeComposeDraftPersistence(
    "agent-native",
    environmentId,
    sessionKey,
    unassignedNativeComposePersistenceStore,
  );
  // The catalogue is environment-scoped and already carries every platform, so
  // it must not be refetched when the platform draft changes: `platformModels`
  // filters it client-side. Re-running here would clear the list and re-issue a
  // command that probes both ACP bridges, flashing "No models available" on
  // every switch.
  useEffect(() => {
    let cancelled = false;
    setModels([]);
    void getNativeAgentModelCatalog(environmentId)
      .then((catalog) => {
        if (!cancelled) setModels(catalog);
      })
      .catch((error) => {
        console.warn("[AgentNativeTab] Failed to load native model catalogue:", error);
      });
    return () => { cancelled = true; };
  }, [environmentId]);
  const fileSearch = useFileSearch(containerId, worktreePath);
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
  const platformModels = models.filter((model) => model.platform === platform);
  const selectedModel = models.find((model) => model.id === draft.modelId && model.platform === platform)
    ?? platformModels[0];
  const canConfigureReasoning = selectedAdapter?.capabilities.composer.reasoning === true;
  const canConfigureMode = selectedAdapter?.capabilities.composer.mode === true;
  const selectedReasoningId = draft.reasoningId ?? selectedModel?.defaultReasoningId;
  const selectedReasoningLabel = selectedModel?.reasoning?.find(
    (option) => option.id === selectedReasoningId,
  )?.label ?? "Default";
  const handleTextAndMentionsChange = useCallback(
    (text: string, mentions: FileMention[]) => updateDraft(sessionKey, { text, mentions }),
    [sessionKey, updateDraft],
  );
  const handleFileMentionSelect = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMention(mention);
  }, [closeFileMentionMenu, createMention]);
  const handleWorkspaceFileSelect = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMentionAtCursor(mention);
  }, [closeFileMentionMenu, createMention]);
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
  const canAttachImage = useCallback(
    () => selectedAdapter?.capabilities.attachments.images === true
      && selectedModel?.supportsImageInput !== false,
    [selectedAdapter, selectedModel?.supportsImageInput],
  );
  const handleImageRejected = useCallback(
    () => toast.error("Images are not supported by this agent"),
    [],
  );

  useNativeComposeBarPaste({
    inputContainerRef,
    containerId: containerId ?? null,
    worktreePath,
    onAttach: handlePastedImage,
    canAttachImage,
    onImageRejected: handleImageRejected,
    logLabel: "UnassignedNativeAgentComposer",
  });

  const send = () => {
    const prompt = buildInitialPromptWithAttachmentReferences(
      serializeForLLM(draft.text, draft.mentions),
      draft.attachments.map(({ name, path }) => ({ name, path })),
    );
    if (!prompt || disabled) return;
    onSend(platform, prompt, {
      modelId: selectedModel?.id,
      reasoningId: selectedReasoningId,
      fastMode: effectiveFastMode,
      mode: draft.mode,
    });
  };

  return (
    <div className="@container relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <NativeComposeDock
        centered
        actions={(
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setResumePlatformDialogOpen(true)}
            disabled={disabled}
            className="rounded-full text-muted-foreground transition-colors hover:text-foreground"
          >
            <History className="mr-2 h-4 w-4" />
            Resume Session
          </Button>
        )}
      >
        <NativeComposeBar
          testId="unassigned-native-compose-bar"
          layout="centered"
          attachments={draft.attachments}
          onRemoveAttachment={(attachmentId) => updateDraft(sessionKey, {
            attachments: draft.attachments.filter((candidate) => candidate.id !== attachmentId),
          })}
          inputRef={inputRef}
          inputContainerRef={inputContainerRef}
          text={draft.text}
          mentions={draft.mentions}
          onTextAndMentionsChange={handleTextAndMentionsChange}
          onCursorPositionChange={detectFileMention}
          onKeyDown={(event) => {
            if (fileMentionMenuOpen && handleFileMentionKeyDown(event, handleFileMentionSelect)) {
              return;
            }
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
          }}
          placeholder="Ask an agent anything…"
          disabled={disabled}
          menus={fileMentionMenuOpen ? (
              <FileMentionMenu
                files={filteredFiles}
                selectedIndex={fileMentionSelectedIndex}
                onSelect={handleFileMentionSelect}
                onClose={closeFileMentionMenu}
              />
            ) : null}
          primaryControls={(
            <>
              {selectedAdapter?.capabilities.attachments.files ? (
                <NativeAttachmentMenu
                  disabled={disabled}
                  fileSearch={fileSearch}
                  onSelectFile={handleWorkspaceFileSelect}
                  onCloseAutoFocus={() => inputRef.current?.focus()}
                  fileActionLabel="Mention file from workspace"
                  filePickerTitle="Mention workspace file"
                  filePickerDescription="Search this environment and mention a file in the first prompt."
                />
              ) : null}
              <AgentModelPicker
                models={models}
                favorites={favorites}
                enabledPlatforms={enabledPlatforms}
                selectedPlatform={platform}
                onPlatformChange={(next) => {
                  const nextAdapter = findNativeAgentAdapter(next);
                  updateDraft(sessionKey, {
                    platform: next,
                    modelId: undefined,
                    reasoningId: undefined,
                    fastMode: next === "claude"
                      ? globalConfig.claudeNativeFastModeDefault ?? false
                      : next === "codex"
                        ? globalConfig.codexNativeFastModeDefault ?? false
                        : false,
                    ...(!nextAdapter?.capabilities.attachments.images
                      && !nextAdapter?.capabilities.attachments.files
                      ? { attachments: [] }
                      : {}),
                  });
                }}
                onToggleFavorite={toggleFavorite}
                selectedModelId={selectedModel?.id}
                selectedModelLabel={selectedModel?.label ?? "No models available"}
                onModelChange={(modelId) => {
                  // Platform selection is applied synchronously by the picker
                  // before model selection. Read it back from the neutral draft so
                  // identical provider-local model ids cannot route to the first
                  // matching catalog entry from another provider.
                  const selectedPlatform = useNativeComposeStore.getState().drafts
                    .get(sessionKey)?.platform ?? platform;
                  const model = models.find((candidate) =>
                    candidate.platform === selectedPlatform && candidate.id === modelId,
                  );
                  updateDraft(sessionKey, {
                    modelId,
                    platform: selectedPlatform,
                    reasoningId: model?.defaultReasoningId,
                  });
                }}
                reasoningOptions={selectedModel?.reasoning ?? []}
                selectedReasoningId={selectedReasoningId}
                selectedReasoningLabel={selectedReasoningLabel}
                onReasoningChange={canConfigureReasoning ? (reasoningId) => updateDraft(sessionKey, { reasoningId }) : undefined}
                fastModeEnabled={effectiveFastMode}
                fastModeAvailable={selectedModel?.supportsSpeed === true}
                onFastModeChange={(fastMode) => updateDraft(sessionKey, { fastMode })}
                disabled={disabled}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled || !canConfigureMode}
                    aria-label="Conversation mode"
                    className="h-8 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                  >
                    {draft.mode === "plan" ? "Plan" : "Build"}
                    <ChevronDown className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuRadioGroup
                    value={draft.mode}
                    onValueChange={(mode) => updateDraft(sessionKey, { mode: mode as "build" | "plan" })}
                  >
                    <DropdownMenuRadioItem value="build">Build</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="plan">Plan</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
          sendDisabled={disabled || (!draft.text.trim() && draft.attachments.length === 0)}
          sendTitle="Start agent"
          onSend={send}
        />
      </NativeComposeDock>
      <NativeAgentResumePlatformDialog
        open={resumePlatformDialogOpen}
        onOpenChange={setResumePlatformDialogOpen}
        enabledPlatforms={enabledPlatforms}
        disabled={disabled}
        onSelect={(selectedPlatform) => {
          setResumePlatformDialogOpen(false);
          onResume(selectedPlatform);
        }}
      />
    </div>
  );
}

function SharedNativeAgentController({
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
  const [dismissedPlanReviewId, setDismissedPlanReviewId] = useState<string | null>(null);
  const forkLatchRef = useRef(false);
  const {
    sessionKey,
    runtimeProjection: projection,
    runtimeError,
    isRefreshing,
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
    listResumable,
    resume,
    fork,
  } = useNativeAgentSession<NativeMessage>({
    platform,
    environmentId: data.environmentId,
    tabId,
    initialAgentModel: initialAgentModel ?? configuredModel,
    initialReasoningEffort: initialReasoningEffort ?? configuredReasoning,
    initialProviderSessionId: data.sessionId,
    initialConversationMode,
    initialFastMode: initialFastMode ?? configuredFastMode,
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
  const { favorites, toggleFavorite } = useAgentModelFavorites();
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } =
    useVirtuosoScrollState({
      isActive,
      persistKey: sessionKey,
      environmentId: data.environmentId,
      stickToBottomOnActivation: true,
    });

  const normalizedMessages = useMemo(
    () => normalizeNativeMessages(projection?.messages ?? []),
    [projection?.messages],
  );
  const handoff = useAgentHandoff(
    platform === "claude" || platform === "codex" || platform === "opencode"
      ? agentHandoffId
      : undefined,
    platform === "claude" || platform === "codex" || platform === "opencode"
      ? platform
      : "claude",
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
    if (!optimisticPrompt || transcriptEchoedOptimistic) return base;
    return [...base, createOptimisticNativeMessage(
      `optimistic-native:${sessionKey}`,
      optimisticPrompt.text,
      optimisticPrompt.attachments,
      optimisticPrompt.createdAt,
    )];
  }, [
    handoff.displayMessages,
    optimisticPrompt,
    projection?.sessionId,
    sessionKey,
    transcriptEchoedOptimistic,
    turnStopMarker,
  ]);
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
  const settingsLocked = phase !== "idle" && phase !== "error";
  const isRunning = phase === "running";
  const isTurnActive = phase === "running" || phase === "recovering" || phase === "cancelling";
  const { elapsedSeconds, finalElapsedSeconds } = useElapsedTimer(
    isTurnActive,
    projection?.sessionId,
    projection?.turn.startedAt,
  );
  const canQueue = isRunning && adapter.capabilities.queue;
  const sendLocked = !projection
    || !handoff.ready
    || (isRunning && !canQueue)
    || phase === "cancelling"
    || phase === "recovering"
    || phase === "blocked";
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
    if (handoff.pendingHistory && /^\s*\//.test(userPrompt)) {
      setSendError("Send a normal message first to complete the agent handoff; slash commands cannot carry transferred history.");
      return false;
    }
    const prompt = prependAgentHandoffHistory(handoff.pendingHistory, userPrompt);
    if (!prompt || sendLocked || isDispatching) return false;
    setSendError(null);
    setOptimisticPrompt({
      text: userPrompt,
      providerText: prompt,
      attachments: submittedAttachments,
      createdAt: new Date().toISOString(),
    });
    clearDraft(sessionKey);
    if (
      (projection?.messages.length ?? 0) === 0
      && environment
      && isDefaultTimestampEnvironmentName(environment.name)
    ) {
      try {
        await renameEnvironmentFromPrompt(data.environmentId, userPrompt);
      } catch (error) {
        console.warn(
          "[AgentNativeTab] Failed to rename environment from first prompt:",
          error,
        );
      }
    }
    const options = {
      requestId,
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
        discardProvisionalDraft();
        if (agentHandoffId) clearTabAgentHandoff(tabId, data.environmentId);
        return true;
      }
      const outcome = await send(prompt, options);
      if (outcome.outcome === "accepted") {
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
      if (restoreComposerFocus) {
        queueMicrotask(() => inputRef.current?.focus());
      }
    }
    updateDraft(sessionKey, {
      text,
      mentions: draft.mentions,
      attachments: submittedAttachments,
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
    environment,
    enqueue,
    handoff.pendingHistory,
    isDispatching,
    projection?.messages.length,
    send,
    sendLocked,
    serializeForLLM,
    sessionKey,
    tabId,
    updateDraft,
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
    refresh: async (options) => { await refresh(options); },
  });

  const handleFileMentionSelect = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMention(mention);
  }, [closeFileMentionMenu, createMention]);
  const handleWorkspaceFileSelect = useCallback((file: FileCandidate) => {
    const mention = createMention(file);
    closeFileMentionMenu({ suppressReopenFor: file.filename });
    inputRef.current?.insertMentionAtCursor(mention);
  }, [closeFileMentionMenu, createMention]);
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

  const forkPlan = useMemo(
    () => buildMessageForkPlan(handoff.displayMessages, {
      responseInProgress: isTurnActive,
      resolvePromptBoundary: (message, allMessages) => {
        if (platform === "opencode") {
          return { type: "message", messageId: message.id };
        }
        if (platform === "codex") {
          const previousTurn = findPreviousForkMessage(
            allMessages,
            message.id,
            (candidate) => Boolean(candidate.turnId)
              && candidate.turnId !== message.turnId,
          );
          if (previousTurn) {
            return { type: "message", messageId: previousTurn.id };
          }
          return findPreviousForkMessage(allMessages, message.id)
            ? null
            : { type: "session-start" };
        }
        const previous = findPreviousForkMessage(allMessages, message.id);
        if (!previous) return { type: "session-start" };
        return {
          type: "message",
          messageId: previous.parts.find((part) => part.sourceMessageId)?.sourceMessageId
            ?? previous.id.split(":text-block:")[0]!,
        };
      },
      resolveResponseBoundary: (message, allMessages) => {
        if (platform === "opencode") {
          const next = findNextForkMessage(allMessages, message.id);
          return next
            ? { type: "message", messageId: next.id }
            : { type: "whole-session" };
        }
        if (platform === "codex") {
          return message.turnId
            ? { type: "message", messageId: message.id }
            : null;
        }
        return {
          type: "message",
          messageId: message.parts.find((part) => part.sourceMessageId)?.sourceMessageId
            ?? message.id.split(":text-block:")[0]!,
        };
      },
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
    submit,
    tabId,
  ]);

  const errorMessage = sendError ?? runtimeError ?? projection?.turn.error ?? null;
  const connectionState = projection?.connection
    ?? (isRefreshing ? "connecting" as const : "error" as const);

  if (setupPending) {
    return (
      <SetupPendingOverlay
        environmentId={data.environmentId}
        setupPhase={environment?.setupPhase}
        subtext={`${label} will connect automatically once setup finishes`}
      />
    );
  }

  return (
    <NativeChatShell
      agentExpansionScope={data.environmentId}
      agentLabel={label}
      isActive={isActive}
      ownsGlobalShortcuts={ownsGlobalShortcuts}
      connectionState={connectionState}
      errorMessage={errorMessage}
      onRetry={() => { void connect(); }}
      messages={messages}
      resolveModelLabel={resolveModelLabel}
      isLoading={isTurnActive}
      elapsedSeconds={elapsedSeconds}
      finalElapsedSeconds={finalElapsedSeconds}
      centerCompose={messages.length === 0 && !isTurnActive}
      emptyStateMessage={`Ask ${label} to work on this repository.`}
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
      pinnedAccessory={(
        <>
          {showPlanReview ? (
            <CodexPlanModeCard
              className="mx-0 my-0"
              isSubmitting={planTransitionPending}
              onApproveAndBuild={() => switchPlanToBuild(true)}
              onSwitchToBuild={() => switchPlanToBuild(false)}
              onDismiss={() => setDismissedPlanReviewId(
                latestAssistantMessage?.id ?? null,
              )}
            />
          ) : null}
          {platform === "claude" && liveBackgroundTasks.length > 0 ? (
            <ClaudeBackgroundTaskHoldCard
              tasks={liveBackgroundTasks}
              responseInProgress={isTurnActive}
              responseFailed={phase === "error"}
              onStopTask={async (taskId) => {
                try {
                  await stopBackgroundTask(taskId);
                  return true;
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Failed to stop background task");
                  return false;
                }
              }}
            />
          ) : null}
          {(projection?.notices ?? []).map((notice, index) => (
            <div
              key={`${notice.kind}:${index}`}
              role="status"
              className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-100"
            >
              {notice.message}
            </div>
          ))}
          {sendError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {sendError}
            </div>
          ) : null}
        </>
      )}
      topAccessory={projection?.suggestedPrompt ? (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            title={projection.suggestedPrompt}
            onClick={() => updateDraft(sessionKey, {
              text: draft.text.trim()
                ? `${draft.text.replace(/\s+$/, "")}\n\n${projection.suggestedPrompt}`
                : projection.suggestedPrompt,
            })}
          >
            Suggested: {projection.suggestedPrompt}
          </Button>
          {platform === "claude" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={suggestionDismissPending}
              aria-label="Dismiss suggested prompt"
              onClick={() => {
                setSuggestionDismissPending(true);
                void dismissSuggestedPrompt()
                  .catch((error) => toast.error(
                    error instanceof Error ? error.message : "Failed to dismiss suggestion",
                  ))
                  .finally(() => setSuggestionDismissPending(false));
              }}
            >
              <X className="size-4" />
            </Button>
          ) : null}
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
        <NativeAgentResumeDialog
          open={resumeDialogOpen}
          onOpenChange={setResumeDialogOpen}
          currentSessionId={projection?.sessionId}
          loadSessions={listResumable}
          onResume={async (session) => {
            await resume(session.sessionId, {
              modelId: composer?.selectedModelId,
              reasoningId: composer?.selectedReasoningId,
              fastMode: composer?.fastModeEnabled ?? undefined,
              mode: composer?.selectedModeId,
            });
            clearPersistedVirtuosoState(sessionKey);
            scrollToBottom();
          }}
        />
      ) : null}
      composer={(
        <NativeComposeBar
          testId="shared-native-compose-bar"
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
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            void submit(draft.text);
          }}
          placeholder={`Message ${label}`}
          disabled={!projection}
          isSending={isDispatching}
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
              {adapter.capabilities.attachments.files ? (
                <NativeAttachmentMenu
                  disabled={sendLocked && !canQueue}
                  fileSearch={fileSearch}
                  onSelectFile={handleWorkspaceFileSelect}
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
                selectedModelId={selectedModel?.id}
                selectedModelLabel={selectedModel?.label ?? "No models available"}
                onModelChange={(modelId) => {
                  const nextModel = composer.models.find((model) => model.id === modelId);
                  const supportedReasoning = nextModel?.reasoning ?? [];
                  const nextReasoningId = supportedReasoning.some(
                    (option) => option.id === selectedReasoningId,
                  )
                    ? selectedReasoningId
                    : nextModel?.defaultReasoningId ?? supportedReasoning[0]?.id;
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
              {(composer.executionProfiles?.length ?? 0) > 0 ? (
                <select
                  aria-label="Execution profile"
                  className="h-8 max-w-44 rounded-md border border-input bg-background px-2 text-xs"
                  value={composer.selectedExecutionProfileId ?? ""}
                  disabled={settingsLocked}
                  onChange={(event) => {
                    void updateControlsSafely({ executionProfileId: event.target.value || null });
                  }}
                >
                  <option value="">Provider default</option>
                  {composer.executionProfiles!.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.label}</option>
                  ))}
                </select>
              ) : null}
              {typeof composer.includeLocalSettings === "boolean" ? (
                <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground" title="Include .claude/settings.local.json">
                  <input
                    type="checkbox"
                    checked={composer.includeLocalSettings}
                    disabled={settingsLocked}
                    onChange={(event) => { void updateControlsSafely({ includeLocalSettings: event.target.checked }); }}
                  />
                  Local settings
                </label>
              ) : null}
              {typeof composer.promptSuggestionsEnabled === "boolean" ? (
                <label className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={composer.promptSuggestionsEnabled}
                    disabled={settingsLocked}
                    onChange={(event) => { void updateControlsSafely({ promptSuggestions: event.target.checked }); }}
                  />
                  Suggestions
                </label>
              ) : null}
            </>
          ) : null}
          onStop={stopSafely}
          showAddressAll={Boolean(
            isReviewTab && projection && !isTurnActive && messages.length > 0,
          )}
          onAddressAll={async () => { await submit(ADDRESS_ALL_REVIEW_PROMPT); }}
          contextUsage={projection?.contextUsage ? {
            usedTokens: projection.contextUsage.usedTokens,
            totalTokens: projection.contextUsage.maximumTokens
              ?? projection.contextUsage.usedTokens,
            percentUsed: projection.contextUsage.percentage
              ?? (projection.contextUsage.maximumTokens
                ? Math.min(100, projection.contextUsage.usedTokens
                  / projection.contextUsage.maximumTokens * 100)
                : 0),
          } : null}
          queue={projection?.queue ? {
            length: queuedMessages.length,
            error: projection.queue.blocked
              ? { message: projection.queue.blocked.error }
              : null,
            onOpen: () => setQueueDialogOpen(true),
          } : undefined}
          showSendButton={!sendLocked || canQueue}
          sendDisabled={sendLocked || isDispatching
            || (!draft.text.trim() && draft.attachments.length === 0)}
          sendTitle={canQueue ? "Add to queue" : "Send"}
          onSend={() => { void submit(draft.text); }}
          footer={projection?.queue ? (
            <QueuedPromptsDialog
              open={queueDialogOpen}
              onOpenChange={setQueueDialogOpen}
              messages={queuedMessages}
              onEdit={async (message) => {
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
                await moveQueued(message.id, toIndex < fromIndex ? "up" : "down");
              }}
              onRemove={async (messageId) => { await removeQueued(messageId); }}
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
export const AgentNativeTab = memo(function AgentNativeTab(
  props: AgentNativeTabProps,
) {
  const [awaitingDurability, setAwaitingDurability] = useState(false);
  const [durabilityError, setDurabilityError] = useState<string | null>(null);
  const [pendingDurabilityOperation, setPendingDurabilityOperation] = useState<
    "send" | "resume" | null
  >(null);
  const [resumeRequestedPlatform, setResumeRequestedPlatform] = useState<AgentPlatform | null>(null);
  const adapter = useMemo(
    () => props.data.platform
      ? findNativeAgentAdapter(props.data.platform)
      : undefined,
    [props.data.platform],
  );
  const persistLockedPane = useCallback(async (operation: "send" | "resume") => {
    setAwaitingDurability(true);
    setDurabilityError(null);
    setPendingDurabilityOperation(operation);
    const environment = usePaneLayoutStore.getState().environments.get(props.data.environmentId);
    if (!environment) {
      setDurabilityError("The locked agent tab is no longer available to save.");
      setAwaitingDurability(false);
      return;
    }
    try {
      await flushPaneLayoutNow(
        props.data.environmentId,
        createPersistedPaneLayoutInput(environment),
      );
      if (operation === "send") {
        const sessionKey = createSessionKey(props.data.environmentId, props.tabId);
        const draft = useNativeComposeStore.getState().drafts.get(sessionKey);
        // Attachment metadata is not encoded in the persisted initial prompt.
        // Preserve it until the shared controller has handed the files to the
        // backend; text-only drafts can be cleared immediately.
        if ((draft?.attachments.length ?? 0) === 0) {
          useNativeComposeStore.getState().clearDraft(sessionKey);
        }
      }
      setPendingDurabilityOperation(null);
      setAwaitingDurability(false);
    } catch (error) {
      console.warn("[AgentNativeTab] Failed to persist provider lock:", error);
      setDurabilityError("The agent choice is locked, but could not be saved.");
      setAwaitingDurability(false);
    }
  }, [props.data.environmentId, props.tabId]);
  const lockAndSend = useCallback(async (
    platform: AgentPlatform,
    prompt: string,
    options: { modelId?: string; reasoningId?: string; fastMode: boolean; mode: "build" | "plan" },
  ) => {
    setAwaitingDurability(true);
    setDurabilityError(null);
    const paneStore = usePaneLayoutStore.getState();
    const lockedPlatform = paneStore.lockTabNativePlatform(
      props.tabId,
      platform,
      props.data.environmentId,
      {
        initialPrompt: prompt,
        initialAgentModel: options.modelId,
        initialReasoningEffort: options.reasoningId,
        initialConversationMode: options.mode,
        initialFastMode: options.fastMode,
      },
    );
    if (!lockedPlatform) {
      setDurabilityError("This tab could not be locked to an agent.");
      setPendingDurabilityOperation(null);
      setAwaitingDurability(false);
      return;
    }
    await persistLockedPane("send");
  }, [persistLockedPane, props.data.environmentId, props.tabId]);
  const lockAndResume = useCallback(async (platform: AgentPlatform) => {
    const selectedAdapter = findNativeAgentAdapter(platform);
    if (!selectedAdapter?.capabilities.resume) return;
    setAwaitingDurability(true);
    setDurabilityError(null);
    const paneStore = usePaneLayoutStore.getState();
    const lockedPlatform = paneStore.lockTabNativePlatform(
      props.tabId,
      platform,
      props.data.environmentId,
    );
    const lockedAdapter = lockedPlatform ? findNativeAgentAdapter(lockedPlatform) : undefined;
    if (!lockedPlatform || !lockedAdapter?.capabilities.resume) {
      setDurabilityError("This tab could not be opened for session resume.");
      setPendingDurabilityOperation(null);
      setAwaitingDurability(false);
      return;
    }
    setResumeRequestedPlatform(lockedPlatform);
    await persistLockedPane("resume");
  }, [persistLockedPane, props.data.environmentId, props.tabId]);

  // A tab whose platform has no adapter is a data problem, not a crash. Render
  // the mismatch instead of throwing out of the pane and taking its siblings
  // down with it.
  if (!props.data.platform) {
    return (
      <UnassignedNativeAgentComposer
        tabId={props.tabId}
        environmentId={props.data.environmentId}
        containerId={props.data.containerId}
        disabled={awaitingDurability}
        onSend={(platform, prompt, options) => { void lockAndSend(platform, prompt, options); }}
        onResume={(platform) => { void lockAndResume(platform); }}
      />
    );
  }
  if (awaitingDurability) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Saving agent choice…</div>;
  }
  if (durabilityError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-destructive">
        <p>{durabilityError}</p>
        {pendingDurabilityOperation ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => { void persistLockedPane(pendingDurabilityOperation); }}
          >
            Retry save
          </Button>
        ) : null}
      </div>
    );
  }
  if (!adapter) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        This tab refers to an unsupported agent, so it cannot be opened.
      </div>
    );
  }

  return <SharedNativeAgentController
    {...props}
    initialResumeOpen={resumeRequestedPlatform === props.data.platform}
  />;
});
